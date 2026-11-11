// HTTP + SSE routes for conversations and runs (docs/api.md "会话与运行"). Every route checks ACL on
// (spaceId, conversation): read for GET/SSE, write for mutations. SSE re-checks ACL periodically.
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { AppEnv, Principal } from "../core/contracts.ts";
import { HttpError, jsonBody, principalOf } from "../core/http.ts";
import type { AssistantDTO, ConversationState, SendMessageRequest } from "../../../shared/chat.ts";
import { ApprovalsDoc, EffectsDoc, TeamDoc } from "./docs.ts";
import type { Effects } from "./effects.ts";
import type { Runtime } from "./service.ts";
import type { AssistantStore } from "./assistants.ts";
import { Handoff } from "./handoff.ts";

export interface SseOptions {
	throttleMs: number;
	pingMs: number;
	aclRecheckMs: number;
}

const ctx0 = BACKGROUND_CONTEXT;

function convId(raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "invalid_id", "会话 id 无效");
	return n;
}

export function mountRuntimeRoutes(api: Hono<AppEnv>, rt: Runtime, effects: Effects, assistants: AssistantStore, sse: SseOptions): void {
	const handoff = new Handoff(rt);
	// ------------------------------------------------------------ conversations
	api.get("/conversations", async (c) => {
		const p = principalOf(c);
		const conversations = await rt.list(p, { spaceId: c.req.query("spaceId"), projectId: c.req.query("projectId"), q: c.req.query("q"), limit: Number(c.req.query("limit")) || undefined, archived: c.req.query("archived") === "1" }, ctx0);
		return c.json({ conversations });
	});

	api.post("/conversations", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ spaceId?: string; projectId?: string; title?: string; modelId?: string; thinkingLevel?: string; assistantId?: string }>(c);
		const identity = rt.ctx.services.get("identity");
		let spaceId = b.spaceId;
		if (b.projectId) {
			const s = identity.projectSpace(b.projectId);
			if (s) {
				if (spaceId && spaceId !== s.id) throw new HttpError(400, "space_mismatch", "spaceId 与 projectId 不一致");
				spaceId = s.id;
			} else {
				// Round 9: a container project has no space — the conversation is created in the caller's personal space and attached.
				const cp = identity.containerProject(b.projectId);
				if (!cp || cp.orgId !== p.orgId) throw new HttpError(404, "project_not_found", "项目不存在");
				if (cp.ownerId !== p.userId) throw new HttpError(403, "forbidden", "只能把对话放进自己的项目", { reason: "not_project_owner" });
				const own = identity.personalSpace(p.userId, p.orgId).id;
				if (spaceId && spaceId !== own) throw new HttpError(400, "space_mismatch", "spaceId 与 projectId 不一致");
				spaceId = own;
			}
		}
		spaceId ??= identity.personalSpace(p.userId, p.orgId).id;
		const model = await rt.resolveModel(p, b.modelId, b.thinkingLevel);
		const { conversationId, notice } = await rt.createConversation(p, spaceId, { title: b.title, projectId: b.projectId, model, assistantId: b.assistantId }, ctx0);
		const detail = await rt.detail(p, spaceId, conversationId, ctx0);
		return c.json({ conversation: detail.conversation, agent: detail.agent, ...(notice ? { notice } : {}) });
	});

	api.get("/conversations/:spaceId/:id", async (c) => {
		const p = principalOf(c);
		return c.json(await rt.detail(p, c.req.param("spaceId"), convId(c.req.param("id")), ctx0));
	});

	api.patch("/conversations/:spaceId/:id", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ title?: string; archived?: boolean; modelId?: string; thinkingLevel?: string }>(c);
		const spaceId = c.req.param("spaceId");
		const id = convId(c.req.param("id"));
		const conversation = await rt.patch(p, spaceId, id, b, ctx0);
		// A model switch answers with the resulting agent too (the composer re-reads it to confirm what is really in use).
		return c.json({ conversation, ...(b.modelId !== undefined ? { agent: (await rt.detail(p, spaceId, id, ctx0)).agent } : {}) });
	});

	/** Round 9: move a conversation into one of my container projects / out of it (projectId null). Relation only; the conversation never leaves its space. */
	api.put("/conversations/:spaceId/:id/project", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ projectId?: string | null }>(c);
		if (b.projectId === undefined) throw new HttpError(400, "invalid", "需要 projectId（项目 id 或 null）");
		const r = await rt.moveToProject(p, c.req.param("spaceId"), convId(c.req.param("id")), b.projectId, ctx0);
		return c.json(r);
	});

	api.get("/conversations/:spaceId/:id/entries", async (c) => {
		const p = principalOf(c);
		return c.json(await rt.entries(p, c.req.param("spaceId"), convId(c.req.param("id")), { before: Number(c.req.query("before")) || undefined, limit: Number(c.req.query("limit")) || undefined }, ctx0));
	});

	/** One-shot ConversationState (same shape as the SSE snapshot) for clients that cannot keep a stream. */
	api.get("/conversations/:spaceId/:id/state", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const id = convId(c.req.param("id"));
		const { harness, conv } = await rt.access(p, "read", spaceId, id, ctx0);
		const watch = await conv.watch(ctx0, { min: Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100) });
		try {
			return c.json(await rt.state(spaceId, harness, conv, watch.value as any, 0, ctx0, p.userId));
		} finally {
			await watch.stop();
		}
	});

	// ------------------------------------------------------------ SSE
	api.get("/conversations/:spaceId/:id/events", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const id = convId(c.req.param("id"));
		// ACL + existence before any byte is streamed, so a forbidden client gets a plain 403.
		const { harness, conv } = await rt.access(p, "read", spaceId, id, ctx0);
		c.header("x-accel-buffering", "no");
		c.header("cache-control", "no-cache");
		return streamSSE(c, async (stream) => {
			const { context, cancel } = withCancel(ctx0);
			let revision = 0;
			let view: ConversationView | undefined;
			let dirty = false;
			let sending = false;
			let timer: NodeJS.Timeout | undefined;
			let closed = false;
			let finish!: () => void;
			const done = new Promise<void>((r) => (finish = r));
			const stopAll: (() => unknown)[] = [];
			// Resources acquired after the client already left are released at once.
			const onStop = (fn: () => unknown) => (closed ? void Promise.resolve(fn()).catch(() => {}) : void stopAll.push(fn));
			const close = () => {
				if (closed) return;
				closed = true;
				if (timer) clearTimeout(timer);
				cancel();
				for (const s of stopAll) Promise.resolve(s()).catch(() => {});
				finish();
			};
			stream.onAbort(close); // client disconnect only stops the watch; the run continues server-side
			onStop(rt.manager.hold(spaceId)); // a watched space is never evicted while idle

			const ping = setInterval(() => {
				if (!closed) stream.writeSSE({ event: "ping", data: JSON.stringify({ at: new Date().toISOString() }) }).catch(close);
			}, sse.pingMs);
			const recheck = setInterval(async () => {
				if (closed) return;
				// A conversation deleted while its stream is open: end the stream (access() already 404s new requests).
				if ((rt.row(spaceId, id) as { deleted_at?: string | null } | undefined)?.deleted_at) {
					await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "not_found", message: "会话已被删除" }) }).catch(() => {});
					close();
					return;
				}
				const d = await rt.acl.check(p, "read", { kind: "conversation", id: String(id), spaceId }).catch(() => ({ allow: false, reason: "error" }));
				if (!d.allow) {
					await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "forbidden", message: `访问权限已变更（${d.reason}）`, reason: d.reason }) }).catch(() => {});
					close();
				} else if (view?.docs?.["pi.live"]?.run) schedule(); // keep nested subagent state fresh while busy
				else if (JSON.stringify(rt.workOf(spaceId, id).work ?? null) !== workPrint) schedule(); // e.g. browser take-over
			}, sse.aclRecheckMs);
			stopAll.push(() => clearInterval(ping), () => clearInterval(recheck));


			const send = async (event: "snapshot" | "state") => {
				if (closed || !view) return;
				sending = true;
				dirty = false;
				try {
					void attachJobs();
					const state: ConversationState = await rt.state(spaceId, harness, conv, view as any, ++revision, context, p.userId);
					workPrint = JSON.stringify(state.work ?? null);
					if (!closed) await stream.writeSSE({ event, data: JSON.stringify(state), id: String(revision) });
				} catch (err: any) {
					if (!closed) console.error("[runtime] sse state", err?.message ?? err);
				} finally {
					sending = false;
				}
				if (dirty) schedule();
			};
			// Group D's `wr.jobs` conversation doc mirrors job transitions; it exists only after the first job, so the
			// watch is attached lazily (retried on every send). Browser sessions have no pi doc: their fingerprint is
			// compared on the periodic tick instead.
			let jobsWatched = false;
			let jobsAttaching = false;
			let workPrint = "";
			const attachJobs = async () => {
				if (jobsWatched || jobsAttaching || closed) return;
				jobsAttaching = true;
				try {
					const token = (await import("../tools/jobs.ts").catch(() => undefined))?.JobsDoc;
					if (!token) return void (jobsWatched = true);
					const w = await harness.watchDoc(token, conv.id, context).catch(() => undefined);
					if (w) {
						jobsWatched = true;
						onStop(() => w.stop());
						w.start(async () => schedule());
					}
				} finally {
					jobsAttaching = false;
				}
			};
			const schedule = () => {
				dirty = true;
				if (closed || sending || timer) return;
				timer = setTimeout(() => {
					timer = undefined;
					void send("state");
				}, sse.throttleMs);
			};

			try {
				const watch = await conv.watch(context, { min: 50, max: 100 });
				onStop(() => watch.stop());
				view = watch.value;
				watch.start(async (call) => {
					if (call.kind !== "value") return;
					view = call.value;
					schedule();
				});
				watch.closed.then((end) => {
					if (!closed && end.kind !== "stopped" && end.kind !== "aborted") {
						void stream.writeSSE({ event: "error", data: JSON.stringify({ code: "runtime_closed", message: "运行时已关闭，请重新连接" }) }).finally(close);
					}
				});
				for (const token of [ApprovalsDoc, EffectsDoc, TeamDoc]) {
					const w = await harness.watchDoc(token as typeof ApprovalsDoc, conv.id, context);
					if (!w) continue;
					onStop(() => w.stop());
					w.start(async () => schedule());
				}
				await send("snapshot");
			} catch (err: any) {
				await stream.writeSSE({ event: "error", data: JSON.stringify({ code: "watch_failed", message: String(err?.message ?? err) }) }).catch(() => {});
				close();
			}

			await done;
		});
	});

	// ------------------------------------------------------------ submissions & control
	api.post("/conversations/:spaceId/:id/messages", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<SendMessageRequest>(c);
		const mode = b.mode ?? "auto";
		if (!["auto", "steer", "followUp"].includes(mode)) throw new HttpError(400, "invalid_mode", "mode 无效");
		const sub = await rt.submit(p, c.req.param("spaceId"), convId(c.req.param("id")), { text: b.text, requestId: b.requestId, attachments: b.attachments, knowledgeRefs: b.knowledgeRefs, userId: p.userId, orgId: p.orgId, whenBusy: mode === "followUp" ? "followUp" : "steer" }, ctx0);
		return c.json({ submissionId: sub.submissionId, status: sub.status, submission: sub });
	});

	api.get("/conversations/:spaceId/:id/submissions/:submissionId", async (c) => {
		const p = principalOf(c);
		const spaceId = c.req.param("spaceId");
		const id = convId(c.req.param("id"));
		const { harness } = await rt.access(p, "read", spaceId, id, ctx0);
		const sid = Number(c.req.param("submissionId"));
		if (!Number.isInteger(sid) || sid <= 0) throw new HttpError(400, "invalid_id", "提交 id 无效");
		const s = await rt.submissionStatus(harness, id, sid, ctx0);
		return c.json({ ...s, submission: s });
	});

	api.post("/conversations/:spaceId/:id/submissions/:submissionId/withdraw", async (c) => {
		const p = principalOf(c);
		const b = (await c.req.json().catch(() => ({}))) as { restore?: boolean };
		return c.json(await rt.withdraw(p, c.req.param("spaceId"), convId(c.req.param("id")), Number(c.req.param("submissionId")), ctx0, { restore: b?.restore === true }));
	});

	// 立即发送: withdraw the queued follow-up and resubmit it as a steer (idempotent `${requestId}::now`). See Runtime.promote.
	api.post("/conversations/:spaceId/:id/submissions/:submissionId/promote", async (c) => {
		const p = principalOf(c);
		return c.json(await rt.promote(p, c.req.param("spaceId"), convId(c.req.param("id")), Number(c.req.param("submissionId")), ctx0));
	});

	api.post("/conversations/:spaceId/:id/fork", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ entryId: number; title?: string }>(c);
		return c.json({ conversation: await rt.fork(p, c.req.param("spaceId"), convId(c.req.param("id")), b, ctx0) });
	});
	api.post("/conversations/:spaceId/:id/edit", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ entryId: number; text: string; requestId: string }>(c);
		return c.json(await rt.edit(p, c.req.param("spaceId"), convId(c.req.param("id")), b, ctx0));
	});
	api.post("/conversations/:spaceId/:id/regenerate", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ entryId: number }>(c);
		return c.json(await rt.regenerate(p, c.req.param("spaceId"), convId(c.req.param("id")), b, ctx0));
	});
	api.post("/conversations/:spaceId/:id/abort", async (c) => {
		const p = principalOf(c);
		const b = (await c.req.json().catch(() => ({}))) as { background?: boolean };
		await rt.abort(p, c.req.param("spaceId"), convId(c.req.param("id")), b, ctx0);
		return c.json({ ok: true });
	});
	api.post("/conversations/:spaceId/:id/continue", async (c) => {
		const p = principalOf(c);
		const b = (await c.req.json().catch(() => ({}))) as { requestId?: string };
		const s = await rt.continue(p, c.req.param("spaceId"), convId(c.req.param("id")), b, ctx0);
		return c.json({ submissionId: s.submissionId, status: s.status, submission: s });
	});

	// ------------------------------------------------------------ approvals, effects, tasks
	api.post("/conversations/:spaceId/:id/approvals/:approvalId", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ decision: "approved" | "rejected"; note?: string }>(c);
		return c.json({ approval: await effects.respond(p, c.req.param("spaceId"), convId(c.req.param("id")), c.req.param("approvalId"), b, ctx0, c.get("requestId")) });
	});
	api.post("/conversations/:spaceId/:id/effects/:effectId/reconcile", async (c) => {
		const p = principalOf(c);
		const b = await jsonBody<{ outcome: "done" | "failed"; receipt?: unknown; note?: string }>(c);
		return c.json({ effect: await effects.reconcile(p, c.req.param("spaceId"), convId(c.req.param("id")), c.req.param("effectId"), b, ctx0, c.get("requestId")) });
	});
	api.get("/conversations/:spaceId/:id/tasks", async (c) => {
		const p = principalOf(c);
		return c.json(await rt.tasks(p, c.req.param("spaceId"), convId(c.req.param("id")), ctx0));
	});

	// ------------------------------------------------------------ handoff (M09-B)
	api.get("/conversations/:spaceId/:id/handoff", async (c) => c.json(await handoff.conversation(principalOf(c), c.req.param("spaceId"), convId(c.req.param("id")), ctx0)));
	api.get("/projects/:projectId/handoff", async (c) => c.json(await handoff.project(principalOf(c), c.req.param("projectId"), ctx0)));

	// ------------------------------------------------------------ assistants (M03-A)
	const withAvailability = async (p: Principal, a: AssistantDTO): Promise<AssistantDTO> => {
		if (!a.model) return a;
		const chk = await rt.checkModel(p, a.model);
		return { ...a, modelAvailability: chk.ok ? { status: "ok" } : { status: chk.code === "model_blocked" ? "blocked" : "not_allowed", reason: chk.reason } };
	};
	api.get("/assistants", async (c) => {
		const p = principalOf(c);
		return c.json({ assistants: await Promise.all(assistants.list(p).map((a) => withAvailability(p, a))) });
	});
	api.post("/assistants", async (c) => {
		const p = principalOf(c);
		return c.json({ assistant: await withAvailability(p, await assistants.create(p, await jsonBody(c))) });
	});
	api.get("/assistants/:id", async (c) => {
		const p = principalOf(c);
		const a = assistants.get(p, c.req.param("id"));
		if (!a) throw new HttpError(404, "assistant_not_found", "助手不存在");
		return c.json({ assistant: await withAvailability(p, a) });
	});
	api.patch("/assistants/:id", async (c) => {
		const p = principalOf(c);
		return c.json({ assistant: await withAvailability(p, await assistants.update(p, c.req.param("id"), await jsonBody(c))) });
	});
	api.delete("/assistants/:id", async (c) => {
		await assistants.archive(principalOf(c), c.req.param("id"));
		return c.json({ ok: true });
	});

	// ------------------------------------------------------------ runtime status (ops)
	api.get("/runtime/status", async (c) => {
		const p = principalOf(c);
		await rt.ctx.services.get("authz").require(p, "trace.view");
		return c.json({ instanceId: rt.manager.instanceId, openSpaces: rt.manager.openSpaces().length, fixtureCalls: rt.manager.fixture.calls() });
	});
}
