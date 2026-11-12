// Approvals and external effects (EffectsApi), stored as pi-durable typed documents of the tool's conversation.
//
// requestApproval: the approval id is derived from (conversationId, callId), so a replay-safe tool that reruns after a
// restart reattaches to the same approval instead of asking twice. Waiting is a watch on the `wr.approvals` doc.
//
// externalEffect: `intent → dispatching` is committed BEFORE perform() runs and the receipt is committed right after.
// A rerun (replay-safe tool after a crash) finds either the receipt (→ returned, replayed: true, perform not called) or
// a dispatching record without receipt (→ needs_reconciliation; perform is NOT called again, because the target may or
// may not have executed it). Both docs use fork: "initial": a branch neither inherits pending approvals nor can it
// re-run an effect the original already dispatched.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/pi-ai";
import { DEFAULT_RESTART_LIMIT, LiveDoc, defineExtension, defineTask, type ConversationId, type Extension, type Harness } from "@earendil-works/pi-durable";
import type { ApprovalDecision, ApprovalRequest, EffectOutcome, EffectsApi, Principal, ToolApiLike } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { ApprovalDTO, EffectDTO } from "../../../shared/chat.ts";
import { ApprovalsDoc, EffectsDoc, InputEntry, TeamDoc } from "./docs.ts";
import { closeDeadWork, taskLive } from "./lifecycle.ts";
import type { Runtime } from "./service.ts";

/** Throw from `perform` when the target definitively refused (nothing happened) — recorded as `failed`, not reconciliation. */
export class EffectRejected extends Error {
	readonly code = "effect_rejected";
}

export function stableId(prefix: string, ...parts: (string | number)[]): string {
	return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
}

/**
 * pi-durable 1.5.0 counts every crash that finds a tool call `running` against `settings.restartLimit` and a tool call
 * cannot park (no checkpoint of its own), so an in-process approval wait would eventually be ended by `restart_limit`.
 * After this many crashes the call stops waiting in-process (see `ApprovalParked`) while it still has attempts to spare.
 */
export const PARK_AFTER_RESTARTS = Math.max(1, DEFAULT_RESTART_LIMIT - 2);
/** How often the durable watcher re-reads a parked approval (a sleeping task holds no invocation in between). */
export const APPROVAL_POLL_MS = 2000;

/**
 * Thrown by `requestApproval` when the wait was handed to a durable watcher task (the call must end now, without
 * executing anything). The tool result tells the model what happens next; the watcher posts the decision as a follow-up
 * input, and the re-issued call consumes the recorded decision instead of asking again.
 */
export class ApprovalParked extends Error {
	readonly code = "approval_parked";
	readonly approvalId: string;
	constructor(approvalId: string, title: string) {
		super(`「${title}」正在等待用户审批（${approvalId}），本次调用没有执行任何操作。审批结果会以新消息通知你；收到批准后，请用完全相同的参数重新调用该工具（已批准的审批不会再次询问）。现在请先告诉用户需要审批，不要重试。`);
		this.approvalId = approvalId;
	}
}

const plain = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function toolNameOf(api: ToolApiLike, context: Context): Promise<string | undefined> {
	try {
		const live = await api.snapshot(LiveDoc, api.conversationId, context);
		return live?.tools?.find((t) => t.callId === api.callId)?.name ?? live?.nestedTools?.find((t) => t.callId === api.callId)?.name;
	} catch {
		return undefined;
	}
}

export class Effects implements EffectsApi {
	readonly #rt: Runtime;
	/** Hook for tests / ops: called right before perform() (after dispatching is durable). */
	onDispatch?: (effectId: string) => void;
	/** The durable watcher task of parked approvals; set when the approvals extension is created. */
	watchTask?: ReturnType<typeof createApprovalWatch>;

	constructor(rt: Runtime) {
		this.#rt = rt;
	}

	/**
	 * Hand a pending approval's wait to a durable watcher task (its own checkpoints; it sleeps between polls, so it is
	 * never a running tool call). Created in the same commit that marks the approval parked.
	 */
	async #park(api: ToolApiLike, approvalId: string, title: string, requestedFor: string | undefined, context: Context): Promise<void> {
		const actor = await this.#rt.actorForTool(api, "", context);
		const watch = this.watchTask;
		if (!watch) throw new Error("approval watcher task is not registered");
		await api.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, api.conversationId);
			const it = d.items[approvalId];
			if (!it || it.status !== "pending" || (it.deferred && it.watchTaskId !== undefined)) return;
			const watcher = await tx.createTask(watch, { approvalId, userId: requestedFor ?? actor.principal.userId, orgId: actor.principal.orgId, title, ...(it.toolName ? { toolName: it.toolName } : {}) }, { ownership: { kind: "conversation" }, background: true });
			it.deferred = true;
			it.watchTaskId = watcher as number;
			it.parkedAt = nowIso();
		}, context);
	}

	/** Best effort audit (group E's `audit` service); never breaks the tool or the route. */
	#audit(input: { orgId: string | null; actorUserId: string | null; action: string; target?: string; detail: Record<string, unknown>; requestId?: string }): void {
		const s = this.#rt.ctx.services;
		if (!s.has("audit")) return;
		try {
			(s.get("audit") as { record(i: typeof input): string }).record(input);
		} catch (err) {
			console.error("[runtime] audit record failed", (err as Error)?.message ?? err);
		}
	}

	/** Who/what a tool-originated effect belongs to: principal, space, and the run input's request id (correlation). */
	async #who(api: ToolApiLike, context: Context): Promise<{ orgId: string; userId: string; spaceId: string; requestId?: string }> {
		const actor = await this.#rt.actorForToolCall(api as any, context);
		return { orgId: actor.principal.orgId, userId: actor.principal.userId, spaceId: actor.space.id, ...((actor.input as any)?.requestId ? { requestId: (actor.input as any).requestId } : {}) };
	}

	async requestApproval(api: ToolApiLike, request: ApprovalRequest, context: Context): Promise<ApprovalDecision> {
		const conversationId = api.conversationId;
		const approvalId = stableId("ap", conversationId as number, api.callId);
		const toolName = await toolNameOf(api, context);
		let requestedFor: string | undefined;
		try {
			const actor = await this.#rt.actorForTool(api, "", context);
			requestedFor = actor.principal.userId;
		} catch (err) {
			// The principal lost access: refuse to even ask.
			throw err;
		}
		const fingerprint = stableId("fp", conversationId as number, toolName ?? "", request.title, request.summary, JSON.stringify(request.detail ?? null), request.risk);
		const found = await api.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, conversationId);
			const cur = d.items[approvalId];
			if (cur) return { kind: "own" as const, item: plain(cur) as ApprovalDTO & Record<string, any> };
			// A parked approval for this very request: a decided one is consumed once by the re-issued call; a still pending one is awaited, not asked twice.
			const same = Object.values(d.items).filter((x) => x.deferred && x.fingerprint === fingerprint);
			const grant = same.find((x) => (x.status === "approved" || x.status === "rejected") && !x.consumedAt);
			if (grant) {
				grant.consumedAt = nowIso();
				grant.consumedByCallId = api.callId;
				return { kind: "grant" as const, item: plain(grant) as ApprovalDTO & Record<string, any> };
			}
			const waiting = same.find((x) => x.status === "pending");
			if (waiting) return { kind: "parked" as const, item: plain(waiting) as ApprovalDTO & Record<string, any> };
			const item: ApprovalDTO & Record<string, any> = {
				approvalId,
				conversationId: conversationId as number,
				callId: api.callId,
				taskId: api.taskId as number,
				fingerprint,
				...(toolName ? { toolName } : {}),
				title: request.title,
				summary: request.summary,
				...(request.detail !== undefined ? { detail: request.detail } : {}),
				risk: request.risk,
				status: "pending",
				requestedAt: nowIso(),
				...(requestedFor ? { requestedFor } : {}),
				...(request.approverUserIds?.length ? { approverUserIds: [...request.approverUserIds] } : {}),
			};
			d.items[approvalId] = item as any;
			return { kind: "created" as const, item: undefined };
		}, context);
		if (found.kind === "grant") return decisionOf(found.item);
		if (found.kind === "parked") throw new ApprovalParked(found.item.approvalId, found.item.title);
		const existing = found.item;
		if (existing && existing.status === "cancelled") throw new Error(`审批已取消（${existing.note ?? "调用已结束"}）`);
		if (existing && existing.status !== "pending") return decisionOf(existing);
		// Cut off often enough that the kernel would soon end this call: hand the wait to a durable task instead.
		const self = await api.getTask(api.taskId, context);
		if ((self?.restarts ?? 0) >= PARK_AFTER_RESTARTS) {
			await this.#park(api, approvalId, request.title, requestedFor, context);
			throw new ApprovalParked(approvalId, request.title);
		}

		const watch = await api.watchDoc(ApprovalsDoc, conversationId, context);
		if (!watch) throw new Error("approvals document missing");
		const now = watch.value.items[approvalId];
		if (now && now.status !== "pending") {
			await watch.stop();
			return decisionOf(now as ApprovalDTO);
		}
		return await new Promise<ApprovalDecision>((resolve, reject) => {
			let settled = false;
			watch.start(async (call) => {
				if (call.kind !== "value" || settled) return;
				const it = call.value.items[approvalId];
				if (it && it.status !== "pending") {
					settled = true;
					resolve(decisionOf(plain(it) as ApprovalDTO));
					void watch.stop();
				}
			});
			watch.closed.then((end) => {
				if (!settled) {
					settled = true;
					reject(new Error(`approval wait ended (${end.kind})`));
				}
			});
		});
	}

	async externalEffect<T extends JsonValue>(api: ToolApiLike, spec: { key: string; target: string; summary: string; idempotencyKey?: string }, perform: (idempotencyKey: string) => Promise<T>, context: Context): Promise<EffectOutcome<T>> {
		const conversationId = api.conversationId;
		const effectId = stableId("ef", conversationId as number, api.callId, spec.key);
		const idempotencyKey = spec.idempotencyKey ?? effectId;
		// Resolve the acting principal (current ACL) BEFORE anything is recorded as dispatching.
		const resolved = await this.#who(api, context).then((w) => ({ w }), (e: unknown) => ({ e }));
		type Decision = { kind: "replay"; receipt: T } | { kind: "reconcile"; detail: string } | { kind: "failed"; error: string } | { kind: "perform" } | { kind: "denied" };
		const decision: Decision = await api.commit(async (tx) => {
			const d = await tx.doc(EffectsDoc, conversationId);
			const cur = d.items[effectId];
			if (cur?.status === "done") return { kind: "replay", receipt: plain(cur.receipt) as T };
			if (cur?.status === "failed") return { kind: "failed", error: String(cur.error ?? "failed") };
			if (cur?.status === "dispatching" || cur?.status === "needs_reconciliation" || cur?.status === "intent") {
				// Unknown outcome: the previous attempt may or may not have reached the target. Never redo blindly.
				const detail = `外部写入结果未知（上次执行在 ${cur.status} 状态中断），需要人工核对：${spec.target} · ${spec.summary}`;
				cur.status = "needs_reconciliation";
				cur.error = detail;
				cur.updatedAt = nowIso();
				return { kind: "reconcile", detail };
			}
			if ("e" in resolved) return { kind: "denied" };
			const rec: EffectDTO = { effectId, conversationId: conversationId as number, callId: api.callId, key: spec.key, target: spec.target, summary: spec.summary, idempotencyKey, status: "dispatching", updatedAt: nowIso() };
			d.items[effectId] = { ...rec, intentAt: nowIso(), history: ["intent", "dispatching"] } as any;
			return { kind: "perform" };
		}, context);
		const corr = { effectId, key: spec.key, idempotencyKey, conversationId: conversationId as number, callId: api.callId, taskId: api.taskId as number };
		if (decision.kind === "replay") return { status: "done", receipt: decision.receipt, replayed: true };
		if (decision.kind === "failed") throw new EffectRejected(decision.error);
		if (decision.kind === "denied") throw (resolved as { e: unknown }).e;
		if (decision.kind === "reconcile") {
			const who = "w" in resolved ? resolved.w : undefined;
			this.#audit({ orgId: who?.orgId ?? null, actorUserId: who?.userId ?? null, action: "effect.needs_reconciliation", target: spec.target, detail: { ...corr, spaceId: who?.spaceId, cause: "replayed_while_dispatching" }, requestId: who?.requestId });
			return { status: "needs_reconciliation", detail: decision.detail, effectId };
		}
		// The write happens on behalf of the run's principal: resolving it re-checks current ACL before anything leaves.
		const who = (resolved as { w: { orgId: string; userId: string; spaceId: string; requestId?: string } }).w;
		this.#audit({ orgId: who.orgId, actorUserId: who.userId, action: "effect.dispatching", target: spec.target, detail: { ...corr, spaceId: who.spaceId }, requestId: who.requestId });

		this.onDispatch?.(effectId);
		let receipt: T;
		try {
			receipt = await perform(idempotencyKey);
		} catch (err: any) {
			const definitive = err instanceof EffectRejected;
			await api.commit(async (tx) => {
				const d = await tx.doc(EffectsDoc, conversationId);
				const cur = d.items[effectId]!;
				cur.status = definitive ? "failed" : "needs_reconciliation";
				cur.error = String(err?.message ?? err).slice(0, 1000);
				cur.updatedAt = nowIso();
			}, context);
			this.#audit({ orgId: who.orgId, actorUserId: who.userId, action: definitive ? "effect.failed" : "effect.needs_reconciliation", target: spec.target, detail: { ...corr, spaceId: who.spaceId, error: String(err?.message ?? err).slice(0, 300) }, requestId: who.requestId });
			if (definitive) throw err;
			return { status: "needs_reconciliation", detail: `外部写入结果未知：${String(err?.message ?? err)}`, effectId };
		}
		await api.commit(async (tx) => {
			const d = await tx.doc(EffectsDoc, conversationId);
			const cur = d.items[effectId]!;
			cur.status = "done";
			cur.receipt = plain(receipt) as any;
			cur.updatedAt = nowIso();
			(cur as any).history = [...((cur as any).history ?? []), "receipt"];
		}, context);
		this.#audit({ orgId: who.orgId, actorUserId: who.userId, action: "effect.receipt", target: spec.target, detail: { ...corr, spaceId: who.spaceId }, requestId: who.requestId });
		return { status: "done", receipt, replayed: false };
	}

	// ------------------------------------------------------------------ host side (routes)

	/** Find the conversation holding an approval: this one, or a running subagent child of it. */
	async #locate(harness: Harness, conversationId: number, approvalId: string, context: Context): Promise<ConversationId | undefined> {
		const own = await harness.snapshot(ApprovalsDoc, conversationId as ConversationId, context);
		if (own?.items[approvalId]) return conversationId as ConversationId;
		const team = await harness.snapshot(TeamDoc, conversationId as ConversationId, context);
		for (const d of Object.values(team?.delegations ?? {})) {
			if (d.childConversationId === undefined) continue;
			const ap = await harness.snapshot(ApprovalsDoc, d.childConversationId as ConversationId, context);
			if (ap?.items[approvalId]) return d.childConversationId as ConversationId;
		}
		return undefined;
	}

	async respond(p: Principal, spaceId: string, conversationId: number, approvalId: string, body: { decision: "approved" | "rejected"; note?: string }, context: Context, requestId?: string): Promise<ApprovalDTO> {
		if (body.decision !== "approved" && body.decision !== "rejected") throw new HttpError(400, "invalid_decision", "decision 必须是 approved 或 rejected");
		const { harness } = await this.#rt.access(p, "write", spaceId, conversationId, context);
		const target = await this.#locate(harness, conversationId, approvalId, context);
		if (target === undefined) throw new HttpError(404, "approval_not_found", "审批不存在");
		// The call this approval belongs to must still exist: never approve a call that was stopped, cut off or has ended.
		const snap = (await harness.snapshot(ApprovalsDoc, target, context))?.items[approvalId];
		if (snap?.status === "pending") {
			const carrier = snap.deferred ? snap.watchTaskId : snap.taskId;
			if (carrier !== undefined && !(await taskLive(harness, carrier, context))) {
				await closeDeadWork(harness, conversationId, { stopped: false }, context);
				throw new HttpError(409, "approval_task_ended", "该审批对应的调用已结束（已停止或已中断），不能再批准或拒绝；这一步没有执行", { status: "cancelled" });
			}
		}
		const decided = await harness.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, target);
			const it = d.items[approvalId]!;
			if (it.status === "cancelled") throw new HttpError(409, "approval_cancelled", "该审批已取消（对应的调用已结束），这一步没有执行", { status: it.status });
			if (it.status !== "pending") throw new HttpError(409, "already_decided", "该审批已处理", { status: it.status });
			if (it.approverUserIds?.length && !it.approverUserIds.includes(p.userId)) throw new HttpError(403, "not_approver", "你不是该审批的指定审批人");
			it.status = body.decision;
			it.decidedBy = p.userId;
			it.decidedAt = nowIso();
			if (body.note) it.note = String(body.note).slice(0, 2000);
			return plain(it) as ApprovalDTO;
		}, context);
		this.#audit({ orgId: p.orgId, actorUserId: p.userId, action: "grant.approval_decided", target: approvalId, detail: { approvalId, decision: decided.status, spaceId, conversationId: decided.conversationId, parentConversationId: conversationId, callId: decided.callId, toolName: decided.toolName, title: decided.title, requestedFor: decided.requestedFor, ...(decided.note ? { note: decided.note.slice(0, 300) } : {}) }, requestId });
		return decided;
	}

	async reconcile(p: Principal, spaceId: string, conversationId: number, effectId: string, body: { outcome: "done" | "failed"; receipt?: unknown; note?: string }, context: Context, requestId?: string): Promise<EffectDTO> {
		if (body.outcome !== "done" && body.outcome !== "failed") throw new HttpError(400, "invalid_outcome", "outcome 必须是 done 或 failed");
		const { harness } = await this.#rt.access(p, "write", spaceId, conversationId, context);
		const done = await harness.commit(async (tx) => {
			const d = await tx.doc(EffectsDoc, conversationId as ConversationId);
			const it = d.items[effectId];
			if (!it) throw new HttpError(404, "effect_not_found", "外部写记录不存在");
			if (it.status !== "needs_reconciliation") throw new HttpError(409, "not_reconcilable", "该记录不需要核对", { status: it.status });
			it.status = body.outcome;
			if (body.outcome === "done") it.receipt = (body.receipt ?? { reconciled: true }) as any;
			else it.error = body.note ?? "人工核对：未执行";
			it.reconciledBy = p.userId;
			it.updatedAt = nowIso();
			return plain(it) as EffectDTO;
		}, context);
		this.#audit({ orgId: p.orgId, actorUserId: p.userId, action: "effect.reconciled", target: done.target, detail: { effectId, key: done.key, idempotencyKey: done.idempotencyKey, outcome: body.outcome, spaceId, conversationId, callId: done.callId, ...(body.note ? { note: String(body.note).slice(0, 300) } : {}) }, requestId });
		return done;
	}
}

function decisionOf(a: ApprovalDTO): ApprovalDecision {
	return { decision: a.status === "approved" ? "approved" : "rejected", by: a.decidedBy ?? "", at: a.decidedAt ?? "", ...(a.note ? { note: a.note } : {}) };
}

// ------------------------------------------------------------------ durable watcher of parked approvals

type WatchInput = { approvalId: string; userId: string; orgId: string; title: string; toolName?: string };
type WatchState = { phase: "watch" } | { phase: "notify"; status: "approved" | "rejected" };

/**
 * One durable task per parked approval: poll the approval document with a checkpoint and a sleep (no invocation is held
 * in between, and each sleep is progress, so crashes never add up to the restart limit), then post the decision to the
 * conversation as a follow-up input (request id derived from the task: restart-safe). A cancelled approval (stop,
 * ended call) just ends the task.
 */
function createApprovalWatch(rt: Runtime) {
	return defineTask<WatchInput, WatchState, null>({
		name: "wr.approval-watch",
		version: 1,
		initial: () => ({ phase: "watch" }),
		phases: {
			watch: async (task, runtime, ctx) => {
				const it = (await runtime.snapshot(ApprovalsDoc, runtime.conversationId, ctx))?.items[task.input.approvalId];
				if (!it || it.status === "cancelled") return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
				if (it.status === "pending") return runtime.sleepUntil(runtime.now() + APPROVAL_POLL_MS, { phase: "watch" }, ctx);
				const status = it.status === "approved" ? "approved" : "rejected";
				return runtime.commit(() => ({ status: "running", checkpoint: { phase: "notify", status } }), ctx);
			},
			notify: async (task, runtime, ctx) => {
				const { approvalId, title, toolName, userId, orgId } = task.input;
				const it = (await runtime.snapshot(ApprovalsDoc, runtime.conversationId, ctx))?.items[approvalId];
				const principal = await rt.ctx.services.get("identity").principalFor(userId, orgId);
				if (it && principal) {
					const note = it.note ? `（${String(it.note).slice(0, 300)}）` : "";
					const text =
						task.state.checkpoint.status === "approved"
							? `[审批结果] 用户已批准「${title}」（${approvalId}）${note}。请用与之前完全相同的参数重新调用${toolName ? `工具 ${toolName}` : "该工具"}来完成这一步；该审批已记录，不会再次询问。`
							: `[审批结果] 用户拒绝了「${title}」（${approvalId}）${note}。这一步不会执行，请据此调整方案或告知用户。`;
					const requestId = `approval-resume:${task.id}`;
					const conv = (await runtime.conversation(runtime.conversationId, ctx))!;
					await conv.submit({ type: "input", content: text, whenBusy: "followUp", requestId, entry: { kind: InputEntry.kind, data: { text, userId, orgId, requestId, via: { kind: "approval_resume", id: approvalId } } as any } }, ctx);
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
			},
		},
		abort: (_t, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
}

export function createApprovalExtension(rt: Runtime, effects: Effects): Extension {
	const Watch = createApprovalWatch(rt);
	effects.watchTask = Watch;
	return defineExtension({ name: "wr-approvals", tasks: [Watch] });
}
