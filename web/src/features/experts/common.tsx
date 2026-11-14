// Shared pieces of the 专家 UI: avatar, status badge, category list, skill state vocabulary.
import { AlertTriangle } from "lucide-react";
import type { ExpertDTO, ExpertSkillDTO, ExpertStatus } from "@shared/experts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { BotAvatar } from "@/components/BotAvatar";

export const EXPERT_CATEGORIES = ["办公效率", "研发", "数据分析", "写作", "设计", "运营", "法务财务", "通用"] as const;

/** Avatar: the expert's bot (shape / colors from avatarConfig; legacy experts get a stable default picked from the id). `working` plays the full animation. */
export function ExpertAvatar({ e, size = 36, working = false }: { e?: { id?: string; avatarConfig?: unknown; name?: string }; size?: number; working?: boolean }) {
	return <BotAvatar config={e?.avatarConfig} seed={e?.id ?? e?.name ?? "expert"} size={size} working={working} />;
}

export const STATUS: Record<ExpertStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
	draft: { label: "草稿", tone: "neutral" },
	pending: { label: "待审核", tone: "warning" },
	published: { label: "已发布", tone: "success" },
	unpublished: { label: "已下架", tone: "danger" },
};
export function StatusBadge({ e }: { e: Pick<ExpertDTO, "status" | "updatePending" | "dirty"> }) {
	const s = STATUS[e.status];
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			<Badge tone={s.tone} data-testid="expert-status" data-status={e.status}>
				{s.label}
			</Badge>
			{e.updatePending ? <Badge tone="warning">更新待审核</Badge> : e.dirty ? <Badge tone="info">有未发布的修改</Badge> : null}
		</span>
	);
}
export const SCOPE_LABEL = { personal: "仅自己", department: "部门", org: "全组织" } as const;

/** One mounted skill with its CURRENT state for the viewer (never a snapshot): name · v<current> or why it is skipped. */
export function SkillChip({ s }: { s: ExpertSkillDTO }) {
	const bad = s.state !== "ok";
	return (
		<span data-testid="expert-skill" data-state={s.state} title={s.message} className={cn("inline-flex h-6 max-w-full items-center gap-1 rounded-md px-2 text-xs", bad ? "bg-warning-soft text-warning" : "bg-surface-2 text-fg-muted")}>
			{bad ? <AlertTriangle className="size-3 shrink-0" /> : null}
			<span className="truncate">{s.name}</span>
			{s.versionNo ? <span className="text-fg-subtle">v{s.semver ?? s.versionNo}</span> : null}
		</span>
	);
}
