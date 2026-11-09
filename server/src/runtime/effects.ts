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
import { LiveDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { ApprovalDecision, ApprovalRequest, EffectOutcome, EffectsApi, Principal, ToolApiLike } from "../core/contracts.ts";
import { HttpError, nowIso } from "../core/http.ts";
import type { ApprovalDTO, EffectDTO } from "../../../shared/chat.ts";
import { ApprovalsDoc, EffectsDoc, TeamDoc } from "./docs.ts";
import type { Runtime } from "./service.ts";

/** Throw from `perform` when the target definitively refused (nothing happened) — recorded as `failed`, not reconciliation. */
export class EffectRejected extends Error {
	readonly code = "effect_rejected";
}

export function stableId(prefix: string, ...parts: (string | number)[]): string {
	return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;
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

	constructor(rt: Runtime) {
		this.#rt = rt;
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
		const existing = await api.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, conversationId);
			const cur = d.items[approvalId];
			if (cur) return plain(cur) as ApprovalDTO;
			const item: ApprovalDTO = {
				approvalId,
				conversationId: conversationId as number,
				callId: api.callId,
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
			return undefined;
		}, context);
		if (existing && existing.status !== "pending") return decisionOf(existing);

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
		const decided = await harness.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, target);
			const it = d.items[approvalId]!;
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
