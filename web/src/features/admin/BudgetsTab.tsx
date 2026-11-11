// 预算 tab.
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BudgetDTO } from "@shared/ops";
import { del, patch, post } from "@/lib/api";
import { type Project } from "@/lib/types";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct, Table, Row } from "@/features/admin/common";
import { useViewerPerms } from "@/features/admin/rbac-ui";

export function Budgets() {
	const perms = useViewerPerms();
	const res = useApi<{ budgets: BudgetDTO[] }>("/budgets");
	const projects = useApi<{ projects: Project[] }>("/projects");
	const { busy, run, note } = useAct(res.reload);
	const [scope, setScope] = useState("org");
	const [period, setPeriod] = useState<"day" | "month" | "total">("month");
	const [cost, setCost] = useState("");
	const [tokens, setTokens] = useState("");
	const [action, setAction] = useState<"block" | "warn">("block");
	return (
		<div>
			{perms.org.has("budget.manage") ? (
			<form
				className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-4"
				onSubmit={(e) => {
					e.preventDefault();
					const sc = scope === "org" ? { kind: "org", id: "" } : { kind: "project", id: scope.slice(8) };
					void run(
						() => post("/admin/budgets", { scope: sc, period, ...(cost ? { limitCost: Number(cost) } : {}), ...(tokens ? { limitTokens: Number(tokens) } : {}), action }),
						"预算已创建",
					);
				}}
			>
				<Select value={scope} onChange={(e) => setScope(e.target.value)} className="h-8 text-sm" aria-label="范围">
					<option value="org">整个组织</option>
					{(projects.data?.projects ?? []).map((p) => (
						<option key={p.id} value={`project:${p.id}`}>
							项目：{p.name}
						</option>
					))}
				</Select>
				<Select aria-label="周期" value={period} onChange={(e) => setPeriod(e.target.value as "day" | "month" | "total")} className="h-8 text-sm">
					<option value="day">每日</option>
					<option value="month">每月</option>
					<option value="total">累计</option>
				</Select>
				<Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="费用上限 USD" type="number" min={0} step="0.01" className="h-8 w-32 text-sm" />
				<Input value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="Token 上限" type="number" min={0} className="h-8 w-32 text-sm" />
				<Select aria-label="超限处理" value={action} onChange={(e) => setAction(e.target.value as "block" | "warn")} className="h-8 text-sm">
					<option value="block">超限阻止</option>
					<option value="warn">仅提醒</option>
				</Select>
				<Button size="sm" variant="primary" type="submit" disabled={busy || (!cost && !tokens)} data-testid="budget-create">
					<Plus />
					新建预算
				</Button>
			</form>
			) : (
				<p className="mb-3 text-xs text-fg-muted">你只有查看预算的权限，不能新建或修改。</p>
			)}
			{note}
			<Loadable state={res} what="预算">
				{(res.data?.budgets ?? []).length === 0 ? (
					<p className="text-sm text-fg-subtle">还没有预算</p>
				) : (
					<Table testId="admin-budgets">
						{res.data!.budgets.map((b) => (
							<div key={b.id}>
								<Row>
									<span className="min-w-0 flex-1">
										<span className="block font-medium">
											{b.scope.kind === "org" ? "整个组织" : `${b.scope.kind === "project" ? "项目" : b.scope.kind === "department" ? "部门" : "成员"}：${b.scope.name ?? b.scope.id}`} · {b.period === "day" ? "每日" : b.period === "month" ? "每月" : "累计"}
										</span>
										<span className="block text-xs text-fg-muted">
											已用 ${b.spent.cost.toFixed(4)}
											{b.limitCost != null ? ` / $${b.limitCost}` : ""} · {b.spent.tokens.toLocaleString()}
											{b.limitTokens != null ? ` / ${b.limitTokens.toLocaleString()}` : ""} tokens · {b.action === "block" ? "超限阻止" : "仅提醒"}
										</span>
									</span>
									<Badge tone={b.state === "ok" ? "success" : b.state === "warn" ? "warning" : "danger"}>{b.state === "ok" ? "正常" : b.state === "warn" ? "接近上限" : "已超限"}</Badge>
									<Switch aria-label="启用预算" data-testid="budget-enabled" checked={b.enabled} disabled={!perms.org.has("budget.manage")} busy={busy} onCheckedChange={(v) => run(() => patch(`/admin/budgets/${b.id}`, { enabled: v }))} />
									{perms.org.has("budget.manage") ? (
										<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => del(`/admin/budgets/${b.id}`), "预算已删除")}>
											<Trash2 />
										</Button>
									) : null}
								</Row>
							</div>
						))}
					</Table>
				)}
			</Loadable>
		</div>
	);
}
