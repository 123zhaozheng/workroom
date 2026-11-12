// Round 13: close approvals and delegations whose carrier task is no longer live.
//
// An approval is bound to the task that is waiting for it (`taskId`: the tool call; after parking, `watchTaskId`: the
// durable watcher). A delegation is carried by its tool call (foreground) or its reporter task (background). When the
// kernel ends such a task (stop, restart limit, abort cascade) the app-level records must follow:
//   - a pending approval whose carrier is gone is cancelled (nobody may approve a call that no longer exists);
//   - a running delegation whose carrier is gone is marked aborted (the foreground tool never reaches its final commit).
// The same function serves the stop path (right after `conversation.abort()` returned, with `stopped: true` for the
// conversation that was stopped) and recovery (state reads / startup: `stopped: false`, only liveness decides).
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskId } from "@earendil-works/pi-durable";
import { nowIso } from "../core/http.ts";
import { ApprovalsDoc, TeamDoc } from "./docs.ts";

const cid = (n: number) => n as ConversationId;

/** A task is live while it can still run: not terminal/completing and not marked for abort. */
export async function taskLive(harness: Harness, taskId: number | undefined, context: Context): Promise<boolean> {
	if (taskId === undefined) return false;
	const rec = await harness.getTask(taskId as TaskId, context).catch(() => undefined);
	if (!rec) return false;
	if (rec.state.status === "terminal" || rec.state.status === "completing") return false;
	return !rec.abortRequested;
}

export interface ClosedWork {
	cancelledApprovals: number;
	endedDelegations: number;
}

export const STOP_NOTE = "已随「停止」取消：这一步没有执行";
export const ENDED_NOTE = "对应的调用已结束，审批已取消：这一步没有执行";

/** Is the carrier of a delegation (the task whose end ends the delegation) still live? */
async function delegationLive(harness: Harness, d: { mode: string; source: { taskId: number }; reporterTaskId?: number; anchorTaskId?: number }, context: Context): Promise<boolean> {
	if (d.mode === "background") return taskLive(harness, d.reporterTaskId ?? d.anchorTaskId, context);
	return taskLive(harness, d.source.taskId, context);
}

/**
 * Walk `rootId` and the children of its delegations (recursively). `stopped`: the root was just stopped, so its own
 * parked approvals (whose call already ended) are cancelled too and legacy approvals without a task binding follow.
 */
export async function closeDeadWork(harness: Harness, rootId: number, opts: { stopped: boolean; note?: string }, context: Context, seen = new Set<number>()): Promise<ClosedWork> {
	const total: ClosedWork = { cancelledApprovals: 0, endedDelegations: 0 };
	if (seen.has(rootId)) return total;
	seen.add(rootId);
	const id = cid(rootId);
	const note = opts.note ?? (opts.stopped ? STOP_NOTE : ENDED_NOTE);

	// 1. delegations of this conversation: recurse into children, then end the ones whose carrier is gone
	const team = await harness.snapshot(TeamDoc, id, context);
	const ending: string[] = [];
	for (const d of Object.values(team?.delegations ?? {})) {
		const live = d.status === "running" ? await delegationLive(harness, d as any, context) : true;
		if (d.status === "running" && !live) ending.push(d.delegationId);
		if (d.childConversationId !== undefined) {
			// A child is "stopped" when the stop reached it: its carrier ended while we are closing after a stop.
			const sub = await closeDeadWork(harness, d.childConversationId, { stopped: opts.stopped && !live, ...(opts.note ? { note: opts.note } : {}) }, context, seen);
			total.cancelledApprovals += sub.cancelledApprovals;
			total.endedDelegations += sub.endedDelegations;
		}
	}
	if (ending.length) {
		await harness.commit(async (tx) => {
			const t = await tx.doc(TeamDoc, id);
			for (const key of ending) {
				const d = t.delegations[key];
				if (d && d.status === "running") Object.assign(d, { status: "aborted", failure: "aborted", endedAt: nowIso() });
			}
		}, context);
		total.endedDelegations += ending.length;
	}

	// 2. approvals of this conversation
	const ap = await harness.snapshot(ApprovalsDoc, id, context);
	const dead: string[] = [];
	const watchers: number[] = [];
	for (const a of Object.values(ap?.items ?? {})) {
		if (a.status !== "pending") continue;
		const carrier = a.deferred ? a.watchTaskId : a.taskId;
		let gone: boolean;
		if (carrier === undefined) gone = opts.stopped; // legacy record without a binding: only a stop settles it
		else if (a.deferred && opts.stopped) gone = true; // the call already ended; a stop cancels what it was waiting to resume
		else gone = !(await taskLive(harness, carrier, context));
		if (!gone) continue;
		dead.push(a.approvalId);
		if (a.deferred && a.watchTaskId !== undefined) watchers.push(a.watchTaskId);
	}
	if (dead.length) {
		total.cancelledApprovals += await harness.commit(async (tx) => {
			const d = await tx.doc(ApprovalsDoc, id);
			let n = 0;
			for (const key of dead) {
				const it = d.items[key];
				if (!it || it.status !== "pending") continue;
				it.status = "cancelled";
				it.decidedAt = nowIso();
				it.note = note;
				n++;
			}
			return n;
		}, context);
		for (const w of watchers) await harness.abortTask(w as TaskId, context).catch(() => undefined);
	}
	return total;
}
