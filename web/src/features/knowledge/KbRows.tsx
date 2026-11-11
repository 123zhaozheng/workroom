// Knowledge base rows for the wide two-column 知识库 (the left column): name first, scope + document state under it.
import { BookOpen, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { KbScope, KbSummary } from "@shared/knowledge";
import { cn } from "@/lib/utils";
import { Badge, EmptyState } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const SCOPE_LABEL: Record<KbScope, string> = { personal: "个人", project: "项目", department: "部门", org: "企业" };

/** Ready / processing / failed counts as badges (same wording as the cards on phones). */
export function KbStats({ k }: { k: KbSummary }) {
	return (
		<span className="flex flex-wrap gap-1.5">
			<Badge tone="success">{k.stats.ready} 可检索</Badge>
			{k.stats.processing ? <Badge tone="info">{k.stats.processing} 处理中</Badge> : null}
			{k.stats.failed ? <Badge tone="danger">{k.stats.failed} 失败</Badge> : null}
		</span>
	);
}

export function KbListColumn({ list, selectedId, q, onQ, onCreate, createDisabled, children }: { list: KbSummary[]; selectedId?: string; q: string; onQ: (q: string) => void; onCreate: () => void; createDisabled?: boolean; children?: ReactNode }) {
	const shown = q.trim() ? list.filter((k) => `${k.name} ${k.description}`.toLowerCase().includes(q.trim().toLowerCase())) : list;
	return (
		<>
			<div className="flex h-12 shrink-0 items-center gap-2 px-4">
				<h2 className="flex-1 text-base font-semibold tracking-tight">知识库</h2>
				<Button variant="primary" onClick={onCreate} disabled={createDisabled}>
					<Plus />
					新建知识库
				</Button>
			</div>
			{list.length > 0 ? (
				<div className="relative px-3 pb-3">
					<Search aria-hidden className="absolute left-5.5 top-2.5 size-4 text-fg-subtle" />
					<Input value={q} onChange={(e) => onQ(e.target.value)} placeholder="搜索知识库" aria-label="搜索知识库" className="pl-8" />
				</div>
			) : null}
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				{children ??
					(list.length === 0 ? (
						<div data-testid="kb-empty">
							<EmptyState
								icon={<BookOpen />}
								title="还没有知识库"
								action={
									<Button variant="primary" onClick={onCreate} disabled={createDisabled}>
										<Plus />
										新建知识库
									</Button>
								}
							/>
						</div>
					) : shown.length === 0 ? (
						<p className="px-4 py-8 text-center text-sm text-fg-muted">没有匹配的知识库</p>
					) : (
						<ul className="px-2 pb-3">
							{shown.map((k) => {
								const selected = k.id === selectedId;
								return (
									<li key={k.id}>
										<Link
											to={`/knowledge/${k.id}`}
											data-testid="kb-card"
											aria-current={selected ? "page" : undefined}
											className={cn("block rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring", selected ? "bg-surface-3" : "hover:bg-surface-2/70")}
										>
											<span className="flex items-center gap-2">
												<BookOpen aria-hidden className="size-4 shrink-0 text-fg-muted" />
												<span className="min-w-0 flex-1 truncate text-sm font-medium">{k.name}</span>
												<Badge>{SCOPE_LABEL[k.scope]}</Badge>
											</span>
											<span className="mt-1.5 block pl-6">
												<KbStats k={k} />
											</span>
										</Link>
									</li>
								);
							})}
						</ul>
					))}
			</div>
		</>
	);
}
