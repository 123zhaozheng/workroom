import { FIXTURE_LABEL } from "@shared/chat";
import { usePrefs, type ThemePref } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";
import { AssistantsSection } from "@/features/assistants/Assistants";
import type { SessionDTO } from "@shared/ops";
import { del, errorText, post } from "@/lib/api";
import { fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { lazy, Suspense, useState } from "react";
import type { ModelOption } from "@/features/chat/ModelPicker";
import { MyPermissionsSection } from "@/features/admin/MyPermissions";

// models group's component; lazy so the admin model code is not part of the settings chunk until needed
const PersonalProviders = lazy(() => import("@/features/admin/models/ModelsAdmin").then((m) => ({ default: m.PersonalProviders })));

export default function SettingsPage() {
	const prefs = usePrefs();
	const { me, brand } = useSession();
	const models = useApi<unknown>("/models");
	const list = listOf<ModelOption & { capabilities?: string[] }>(models.data, "models");
	// 我的模型密钥 only when the admin policy opens it (GET /models carries the flag)
	const personalKeys = !!(models.data as { personalProviders?: boolean } | undefined)?.personalProviders;
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
						<Row label="动态点阵背景" hint="首页与对话页背后的低对比点阵（缓慢起伏、轻微跟随指针）。标签页隐藏或滚出视野时完全暂停；开启“减少动画”后只显示静态点阵。">
							<label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
								<input data-testid="dot-matrix-toggle" type="checkbox" checked={prefs.dotMatrix} onChange={(e) => prefs.set("dotMatrix", e.target.checked)} className="size-4 accent-[var(--accent)]" />
								{!prefs.dotMatrix ? "已关闭" : prefs.motionReduced ? "静态" : "动态"}
							</label>
						</Row>
					</Group>
					<AssistantsSection />
					{personalKeys ? (
						<section className="mb-8" data-testid="personal-keys-section">
							<h2 className="mb-2 text-[13px] font-medium text-fg-muted">我的模型密钥</h2>
							<Suspense fallback={<p className="text-[13px] text-fg-subtle">正在加载…</p>}>
								<PersonalProviders />
							</Suspense>
						</section>
					) : null}
					<Group title="账号">
						<Row label="姓名">{me?.name}</Row>
						<Row label="邮箱">{me?.email}</Row>
						<Row label="组织">
							{me?.orgName} <Badge className="ml-1">{me?.orgRole === "owner" ? "所有者" : me?.orgRole === "admin" ? "管理员" : "成员"}</Badge>
						</Row>
						<Row label="产品">{brand.name}</Row>
					</Group>
					<MyPermissionsSection />
					<SessionsGroup />
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

/** 登录设备 (M16-A): every active session of this account; revoke one or all others. Revoked tokens stop working at once. */
function SessionsGroup() {
	const res = useApi<{ sessions: SessionDTO[] }>("/me/sessions");
	const [err, setErr] = useState<string>();
	const act = async (fn: () => Promise<unknown>) => {
		setErr(undefined);
		try {
			await fn();
			res.reload();
		} catch (e) {
			setErr(errorText(e));
		}
	};
	const others = (res.data?.sessions ?? []).filter((x) => !x.current && !x.revokedAt).length;
	return (
		<section className="mb-8" data-testid="my-sessions">
			<div className="mb-2 flex items-center">
				<h2 className="flex-1 text-[13px] font-medium text-fg-muted">登录设备</h2>
				{others ? (
					<Button size="sm" onClick={() => act(() => post("/me/sessions/revoke-others"))} data-testid="revoke-others">
						退出其他设备（{others}）
					</Button>
				) : null}
			</div>
			<Loadable state={res} what="登录设备" need="E 组：GET /api/me/sessions">
				{err ? <p className="mb-2 text-[13px] text-danger">{err}</p> : null}
				<div className="divide-y divide-border rounded-xl border border-border bg-surface px-4">
					{(res.data?.sessions ?? []).filter((x) => !x.revokedAt).map((x) => (
						<div key={x.id} data-testid="my-session" className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
							<span className="min-w-0 flex-1">
								<span className="block truncate">{x.userAgent ?? "未知设备"}</span>
								<span className="block text-xs text-fg-subtle">
									{x.authMethod === "password" ? "密码登录" : x.authMethod === "oidc" ? "企业登录" : "邀请加入"} · {fullTime(x.createdAt)}
									{x.lastSeenAt ? ` · 最近活跃 ${relTime(x.lastSeenAt)}` : ""}
								</span>
							</span>
							{x.current ? (
								<Badge tone="info">当前设备</Badge>
							) : (
								<Button size="sm" variant="ghost" onClick={() => act(() => del(`/me/sessions/${x.id}`))}>
									退出该设备
								</Button>
							)}
						</div>
					))}
				</div>
			</Loadable>
		</section>
	);
}
