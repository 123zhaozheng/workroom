import { AlertCircle, Ban, CheckCircle2, Clock, Hand, Loader2, PauseCircle, Timer } from "lucide-react";
import type { RunStatus, SubmissionStatus } from "@shared/chat";
import { cn } from "@/lib/utils";

export const RUN_LABEL: Record<RunStatus, string> = {
	idle: "空闲",
	running: "运行中",
	waiting_approval: "等待你确认",
	done: "已完成",
	aborted: "已停止",
	timeout: "已超时",
	failed: "失败",
	interrupted: "已中断",
};

const RUN_TONE: Record<RunStatus, string> = {
	idle: "text-fg-subtle",
	running: "text-info",
	waiting_approval: "text-warning",
	done: "text-success",
	aborted: "text-fg-muted",
	timeout: "text-warning",
	failed: "text-danger",
	interrupted: "text-danger",
};

export function RunIcon({ status, className }: { status: RunStatus; className?: string }) {
	const cls = cn("size-3.5 shrink-0", RUN_TONE[status], className);
	switch (status) {
		case "running":
			return <Loader2 className={cn(cls, "wr-spin")} />;
		case "waiting_approval":
			return <Hand className={cls} />;
		case "done":
			return <CheckCircle2 className={cls} />;
		case "aborted":
			return <Ban className={cls} />;
		case "timeout":
			return <Timer className={cls} />;
		case "failed":
			return <AlertCircle className={cls} />;
		case "interrupted":
			return <PauseCircle className={cls} />;
		default:
			return <Clock className={cls} />;
	}
}

/** Tiny status dot for lists (only shown for states worth noticing). */
export function RunDot({ status }: { status: RunStatus }) {
	if (status === "idle" || status === "done") return null;
	return (
		<span title={RUN_LABEL[status]} className="inline-flex">
			<RunIcon status={status} className="size-3" />
		</span>
	);
}

export const SUBMISSION_LABEL: Record<SubmissionStatus, string> = {
	received: "已接收",
	queued: "排队中",
	applied: "已应用",
	done: "已回复",
	unanswered: "未完成",
	withdrawn: "已撤回",
};

export const REASON_LABEL: Record<string, string> = {
	aborted: "已停止",
	model_error: "模型出错",
	turn_limit: "达到轮数上限",
	reset: "上下文已重置",
	run_failed: "运行失败",
	timeout: "超时",
	interrupted: "进程中断",
};
export const reasonText = (r?: string) => (r ? (REASON_LABEL[r] ?? r) : "");

/** Feedback chip for a message sent while the assistant was working (插话 / 稍后处理): wording and whether it can still be withdrawn. */
export function steerChip(mode: string, status: SubmissionStatus): { label: string; tone: "info" | "success" | "danger" | "muted"; withdrawable: boolean } {
	const later = mode === "followUp";
	switch (status) {
		case "received":
			return { label: later ? "排队中，本轮结束后处理" : "已收到，下一步生效", tone: "info", withdrawable: true };
		case "queued":
			return { label: "排队中，本轮结束后处理", tone: "info", withdrawable: true };
		case "applied":
			return { label: later ? "正在处理" : "已采纳", tone: "success", withdrawable: false };
		case "done":
			return { label: "已回复", tone: "success", withdrawable: false };
		case "withdrawn":
			return { label: "已撤回", tone: "muted", withdrawable: false };
		default:
			return { label: "未采纳", tone: "danger", withdrawable: false };
	}
}
