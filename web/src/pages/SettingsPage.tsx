// 设置: every section has the same shape (small title, one card). 账号 → 外观 → 助手 → 我的模型密钥 → 模型 → 我的权限 → 登录设备.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { FIXTURE_LABEL } from "@shared/chat";
import type { SessionDTO } from "@shared/ops";
import { usePrefs, type ThemePref } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { del, errorText, post } from "@/lib/api";
import { cn, fullTime, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { Badge, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { listOf } from "@/features/chat/pickers";
import { AssistantsSection } from "@/features/assistants/Assistants";
import type { ModelOption } from "@/features/chat/ModelPicker";
import { MyPermissionsSection } from "@/features/admin/MyPermissions";
import { Section } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { CredentialsSection } from "@/features/settings/Credentials";
import { EnvVarsEditor } from "@/features/settings/EnvVars";

// models group's component; lazy so the admin model code is not part of the settings chunk until needed
const PersonalProviders = lazy(() => import("@/features/admin/models/ModelsAdmin").then((m) => ({ default: m.PersonalProviders })));

const ROLE_NAME: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };

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
					<Group title="账号">
						<Row label="姓名">{me?.name}</Row>
						<Row label="邮箱">{me?.email}</Row>
						<Row label="组织">
							{me?.orgName} <Badge className="ml-1">{ROLE_NAME[me?.orgRole ?? "member"] ?? "成员"}</Badge>
						</Row>
						<Row label="产品">{brand.name}</Row>
					</Group>
					<Group title="外观">
						<Row label="主题">
							<Seg<ThemePref> label="主题" value={prefs.theme} onChange={(v) => prefs.set("theme", v)} options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]} />
						</Row>
						<Row label="减少动画" hint="关闭过渡和状态动画。系统开启「减少动态效果」时始终生效。">
							<Toggle testId="reduce-motion-toggle" checked={prefs.reduceMotion} onChange={(v) => prefs.set("reduceMotion", v)} label={prefs.motionReduced ? "已减少" : "正常"} />
						</Row>
						<Row label="动态点阵背景" hint="首页和对话页背后的淡淡点阵。">
							<Toggle testId="dot-matrix-toggle" checked={prefs.dotMatrix} onChange={(v) => prefs.set("dotMatrix", v)} label={!prefs.dotMatrix ? "已关闭" : prefs.motionReduced ? "静态" : "动态"} />
						</Row>
					</Group>
					<AssistantsSection />
					{personalKeys ? (
						<Section title="我的模型密钥" testId="personal-keys-section">
							<Suspense fallback={<p className="text-sm text-fg-muted">正在加载…</p>}>
								<PersonalProviders />
							</Suspense>
						</Section>
					) : null}
					<Group title="可用模型">
						<Loadable state={models} what="模型列表">
							{list.length === 0 ? (
								<p className="py-3 text-sm text-fg-muted">还没有可用的模型，请联系管理员。</p>
							) : (
								<ul className="divide-y divide-border">
									{list.map((m) => (
										<li key={m.id} className="flex items-center gap-2 py-3 text-sm">
											<span className="min-w-0 flex-1 truncate">{m.label}</span>
											{m.status === "ready" ? <Badge tone="success">可用</Badge> : m.status === "fixture" ? <Badge tone="warning">{FIXTURE_LABEL}</Badge> : <Badge tone="danger" title={m.statusDetail}>不可用：{m.statusDetail ?? "未配置密钥"}</Badge>}
										</li>
									))}
								</ul>
							)}
						</Loadable>
					</Group>
					<CredentialsSection />
					<Section title="环境变量" testId="my-env-vars">
						<p className="mb-2 text-xs text-fg-muted">只对你自己的工作区命令生效；项目和组织也可以设置同名变量。</p>
						{me ? <EnvVarsEditor scope="user" scopeRef={me.userId} editable testId="env-vars-user" /> : null}
					</Section>
					<MyPermissionsSection />
					<SessionsGroup />
				</Page>
			</div>
		</div>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Section title={title}>
			<div className="divide-y divide-border rounded-xl border border-border bg-surface px-4">{children}</div>
		</Section>
	);
}
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-3 py-3">
			<div className="min-w-[120px] flex-1">
				<div className="text-sm">{label}</div>
				{hint ? <div className="text-xs text-fg-muted">{hint}</div> : null}
			</div>
			<div className="text-sm text-fg-muted">{children}</div>
		</div>
	);
}
function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
	return (
		<label className="inline-flex cursor-pointer items-center gap-2 text-sm">
			<input data-testid={testId} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--accent)]" />
			{label}
		</label>
	);
}
function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
	return (
		<div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label={label}>
			{options.map(([v, l]) => (
				<button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)} className={cn("h-8 rounded-md px-3 text-sm", v === value ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
					{l}
				</button>
			))}
		</div>
	);
}

const AUTH_LABEL: Record<string, string> = { password: "密码登录", oidc: "企业登录", invite: "邀请加入" };

/** 登录设备: every active session of this account; sign out one or all others (asks first for "all others"). */
function SessionsGroup() {
	const res = useApi<{ sessions: SessionDTO[] }>("/me/sessions");
	const [err, setErr] = useState<string>();
	const { ask, dialog } = useConfirm();
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
		<Section
			title="登录设备"
			testId="my-sessions"
			action={
				others ? (
					<Button
						size="sm"
						onClick={async () => (await ask({ title: `退出其他 ${others} 台设备？`, consequence: "其他设备上的登录会立即失效，需要重新登录。当前设备不受影响。", confirmLabel: "退出其他设备", danger: true })) && act(() => post("/me/sessions/revoke-others"))}
						data-testid="revoke-others"
					>
						退出其他设备（{others}）
					</Button>
				) : null
			}
		>
			<Loadable state={res} what="登录设备">
				{err ? (
					<p className="mb-2 text-sm text-danger" role="alert">
						{err}
					</p>
				) : null}
				<div className="divide-y divide-border rounded-xl border border-border bg-surface px-4">
					{(res.data?.sessions ?? []).filter((x) => !x.revokedAt).map((x) => (
						<div key={x.id} data-testid="my-session" className="flex flex-wrap items-center gap-2 py-3 text-sm">
							<span className="min-w-0 flex-1">
								<span className="block truncate">{x.userAgent ?? "未知设备"}</span>
								<span className="block text-xs text-fg-muted">
									{AUTH_LABEL[x.authMethod] ?? x.authMethod} · {fullTime(x.createdAt)}
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
			{dialog}
		</Section>
	);
}
