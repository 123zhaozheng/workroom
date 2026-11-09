// In-memory EffectsApi implementing the contract semantics (for D's tests of tools that consume effects).
// The real, durable implementation is group A's (wr.approvals / wr.effects documents).
import type { ApprovalDecision, ApprovalRequest, EffectOutcome, EffectsApi } from "../../src/core/contracts.ts";

export class MemoryEffects implements EffectsApi {
	approvals: ApprovalRequest[] = [];
	decide: (r: ApprovalRequest) => "approved" | "rejected" = () => "approved";
	readonly effects = new Map<string, { state: "dispatching" | "done"; receipt?: any }>();
	performed = 0;
	/** Simulate a crash after dispatch for these keys (perform runs, receipt is not recorded). */
	crashAfterDispatch = new Set<string>();

	async requestApproval(_api: any, request: ApprovalRequest): Promise<ApprovalDecision> {
		this.approvals.push(request);
		return { decision: this.decide(request), by: "test", at: new Date().toISOString() };
	}
	async externalEffect<T>(_api: any, spec: { key: string; idempotencyKey?: string }, perform: (k: string) => Promise<T>): Promise<EffectOutcome<T>> {
		const e = this.effects.get(spec.key);
		if (e?.state === "done") return { status: "done", receipt: e.receipt, replayed: true };
		if (e?.state === "dispatching") return { status: "needs_reconciliation", detail: "dispatched without receipt", effectId: spec.key };
		this.effects.set(spec.key, { state: "dispatching" });
		this.performed++;
		const receipt = await perform(spec.idempotencyKey ?? spec.key);
		if (this.crashAfterDispatch.has(spec.key)) throw new Error("simulated crash after dispatch");
		this.effects.set(spec.key, { state: "done", receipt });
		return { status: "done", receipt, replayed: false };
	}
}
