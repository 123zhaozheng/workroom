// 审计 tab.
import { Download, Shield } from "lucide-react";
import { useState } from "react";
import type { AuditEntryDTO } from "@shared/ops";
import { api, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Table, Row } from "@/features/admin/common";

const CATS = ["", "auth", "admin", "grant", "share", "external_write", "model", "budget", "automation", "security"] as const;
const CAT_LABEL: Record<string, string> = { "": "全部", auth: "登录", admin: "管理", grant: "授权", share: "分享", external_write: "外部写", model: "模型", budget: "预算", automation: "自动化", security: "安全" };

export function Audit() {
	const [cat, setCat] = useState("");
	const [action, setAction] = useState("");
	const q = qs({ category: cat, action: action || undefined, limit: 100 });
	const res = useApi<{ items: AuditEntryDTO[]; next?: string }>(`/admin/audit${q}`);
	const [more, setMore] = useState<AuditEntryDTO[]>([]);
	const items = [...(res.data?.items ?? []), ...more];
	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Select value={cat} onChange={(e) => (setCat(e.target.value), setMore([]))} className="h-8 text-[13px]" aria-label="类别">
					{CATS.map((c) => (
						<option key={c} value={c}>
							{CAT_LABEL[c]}
						</option>
					))}
				</Select>
				<Input value={action} onChange={(e) => (setAction(e.target.value), setMore([]))} placeholder="动作（支持前缀*，如 member.*）" className="h-8 w-60 text-[13px]" />
				<span className="flex-1" />
				<Button size="sm" asChild>
					<a href={`/api/admin/audit.csv${qs({ category: cat, action: action || undefined })}`} data-testid="audit-export">
						<Download />
						导出审计 CSV
					</a>
				</Button>
				<Button size="sm" asChild>
					<a href="/api/usage/export.csv?scope=org">
						<Download />
						导出用量 CSV
					</a>
				</Button>
			</div>
			<Loadable state={res} what="审计" need="E 组：GET /api/admin/audit">
				{items.length === 0 ? (
					<EmptyState icon={<Shield />} title="没有符合条件的审计记录" />
				) : (
					<Table testId="admin-audit">
						{items.map((a) => (
							<div key={a.id}>
								<Row>
									<span className="w-36 shrink-0 text-xs text-fg-subtle">{fullTime(a.at)}</span>
									<Badge>{CAT_LABEL[a.category] ?? a.category}</Badge>
									<span className="font-mono text-xs">{a.action}</span>
									<span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={a.detail ? JSON.stringify(a.detail) : undefined}>
										{a.actorName ?? a.actorUserId ?? "系统"}
										{a.target ? ` → ${a.target}` : ""}
										{a.requestId ? ` · ${a.requestId}` : ""}
									</span>
								</Row>
							</div>
						))}
					</Table>
				)}
				{res.data?.next && !more.length ? (
					<Button
						size="sm"
						variant="ghost"
						className="mt-2"
						onClick={async () => {
							const r = await api<{ items: AuditEntryDTO[] }>(`/admin/audit${qs({ category: cat, action: action || undefined, before: res.data!.next, limit: 100 })}`);
							setMore(r.items);
						}}
					>
						加载更早的记录
					</Button>
				) : null}
			</Loadable>
		</div>
	);
}
