import { FIXTURE_LABEL } from "@shared/chat";
import { usePrefs, type ThemePref } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";
import type { ModelOption } from "@/features/chat/ModelPicker";

export default function SettingsPage() {
	const prefs = usePrefs();
	const { me, brand } = useSession();
	const models = useApi<unknown>("/models");
	const list = listOf<ModelOption & { capabilities?: string[] }>(models.data, "models");
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<PageHeader title="设置" />
					<Group title="外观">
						<Row label="主题">
							<Seg<ThemePref> value={prefs.theme} onChange={(v) => prefs.set("theme", v)} options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]} />
						</Row>
						<Row label="减少动画" hint="关闭过渡与状态动画（系统“减少动态效果”设置始终生效）">
							<label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
								<input data-testid="reduce-motion-toggle" type="checkbox" checked={prefs.reduceMotion} onChange={(e) => prefs.set("reduceMotion", e.target.checked)} className="size-4 accent-[var(--accent)]" />
								{prefs.motionReduced ? "已减少" : "正常"}
							</label>
						</Row>
					</Group>
					<Group title="账号">
						<Row label="姓名">{me?.name}</Row>
						<Row label="邮箱">{me?.email}</Row>
						<Row label="组织">
							{me?.orgName} <Badge className="ml-1">{me?.orgRole === "owner" ? "所有者" : me?.orgRole === "admin" ? "管理员" : "成员"}</Badge>
						</Row>
						<Row label="产品">{brand.name}</Row>
					</Group>
					<Group title="模型">
						<Loadable state={models} what="模型列表" need="E 组：GET /api/models">
							{list.length === 0 ? (
								<p className="text-[13px] text-fg-subtle">没有可用模型。</p>
							) : (
								<ul className="space-y-1.5">
									{list.map((m) => (
										<li key={m.id} className="flex items-center gap-2 text-[13px]">
											<span className="min-w-0 flex-1 truncate">{m.label}</span>
											{m.status === "ready" ? <Badge tone="success">可用</Badge> : m.status === "fixture" ? <Badge tone="warning">{FIXTURE_LABEL}</Badge> : <Badge tone="danger" title={m.statusDetail}>不可用：{m.statusDetail ?? "未配置凭据"}</Badge>}
										</li>
									))}
								</ul>
							)}
						</Loadable>
					</Group>
				</Page>
			</div>
		</div>
	);
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mb-8">
			<h2 className="mb-2 text-[13px] font-medium text-fg-muted">{title}</h2>
			<div className="divide-y divide-border rounded-xl border border-border bg-surface px-4">{children}</div>
		</section>
	);
}
function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-3 py-3">
			<div className="min-w-[120px] flex-1">
				<div className="text-sm">{label}</div>
				{hint ? <div className="text-xs text-fg-subtle">{hint}</div> : null}
			</div>
			<div className="text-[13px] text-fg-muted">{children}</div>
		</div>
	);
}
function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
	return (
		<div className="inline-flex rounded-lg bg-surface-2 p-0.5">
			{options.map(([v, l]) => (
				<button key={v} onClick={() => onChange(v)} className={cn("h-7 rounded-md px-2.5 text-[13px]", v === value ? "bg-surface text-fg shadow-sm" : "text-fg-muted")}>
					{l}
				</button>
			))}
		</div>
	);
}
