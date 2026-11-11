// 设置: ChatGPT-style layout — grouped left navigation, one content column (≤720px) with label-left / control-right rows.
// 常规 · 助手 · 模型 · 凭据与变量 · 权限 · 安全 · 登录设备. URLs stay `/settings?tab=<id>`.
import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
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
import { Switch } from "@/components/ui/switch";
import { SettingsContent, SettingsGroup, SettingsNav, SettingsRow } from "@/components/ui/settings";
import { listOf } from "@/features/chat/pickers";
import { AssistantsSection } from "@/features/assistants/Assistants";
import type { ModelOption } from "@/features/chat/ModelPicker";
import { MyPermissionsSection } from "@/features/admin/MyPermissions";
import { Section } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";
import { CredentialsSection } from "@/features/settings/Credentials";
import { EnvVarsEditor } from "@/features/settings/EnvVars";
import { TwoFactorSettings } from "@/features/settings/TwoFactor";

// models group's component; lazy so the admin model code is not part of the settings chunk until needed
const PersonalProviders = lazy(() => import("@/features/admin/models/ModelsAdmin").then((m) => ({ default: m.PersonalProviders })));

const ROLE_NAME: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };
const TABS = [
	{ value: "general", label: "常规" },
	{ value: "assistants", label: "助手" },
	{ value: "models", label: "模型" },
	{ value: "credentials", label: "凭据与变量" },
	{ value: "permissions", label: "权限" },
	{ value: "security", label: "安全" },
	{ value: "devices", label: "登录设备" },
] as const;

export default function SettingsPage() {
	const [sp] = useSearchParams();
	const requested = sp.get("tab");
	const tab = TABS.some((t) => t.value === requested) ? requested! : "general";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader title="设置" />
					<div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-10">
						<SettingsNav label="设置" current={tab} items={TABS.map((t) => ({ value: t.value, label: t.label, to: `?tab=${t.value}`, testId: `settings-tab-${t.value}` }))} />
						<SettingsContent className="min-w-0 flex-1">
							{tab === "general" ? <General /> : null}
							{tab === "assistants" ? <AssistantsSection /> : null}
							{tab === "models" ? <ModelsTab /> : null}
							{tab === "credentials" ? <CredentialsTab /> : null}
							{tab === "permissions" ? <MyPermissionsSection /> : null}
							{tab === "security" ? <TwoFactorSettings /> : null}
							{tab === "devices" ? <SessionsGroup /> : null}
						</SettingsContent>
					</div>
				</Page>
			</div>
		</div>
	);
}

function General() {
	const prefs = usePrefs();
	const { me } = useSession();
	return (
		<>
			<SettingsGroup title="账号">
				<SettingsRow label="姓名">{me?.name}</SettingsRow>
				<SettingsRow label="邮箱">{me?.email}</SettingsRow>
				<SettingsRow label="组织">
					{me?.orgName} <Badge>{ROLE_NAME[me?.orgRole ?? "member"] ?? "成员"}</Badge>
				</SettingsRow>
			</SettingsGroup>
			<SettingsGroup title="外观">
				<SettingsRow label="主题">
					<Seg<ThemePref> label="主题" value={prefs.theme} onChange={(v) => prefs.set("theme", v)} options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]} />
				</SettingsRow>
				<SettingsRow label="减少动画">
					<Switch data-testid="reduce-motion-toggle" aria-label="减少动画" checked={prefs.reduceMotion} onCheckedChange={(v) => prefs.set("reduceMotion", v)} />
				</SettingsRow>
				<SettingsRow label="动态点阵背景">
					<Switch data-testid="dot-matrix-toggle" aria-label="动态点阵背景" checked={prefs.dotMatrix} onCheckedChange={(v) => prefs.set("dotMatrix", v)} />
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

function ModelsTab() {
	const models = useApi<unknown>("/models");
	const list = listOf<ModelOption & { capabilities?: string[] }>(models.data, "models");
	// 我的模型密钥 only when the admin policy opens it (GET /models carries the flag)
	const personalKeys = !!(models.data as { personalProviders?: boolean } | undefined)?.personalProviders;
	return (
		<>
			{personalKeys ? (
				<Section title="我的模型密钥" testId="personal-keys-section">
					<Suspense fallback={<p className="text-sm text-fg-muted">正在加载…</p>}>
						<PersonalProviders />
					</Suspense>
				</Section>
			) : null}
			<SettingsGroup title="可用模型">
				<Loadable state={models} what="模型列表">
					{list.length === 0 ? (
						<p className="py-3.5 text-sm text-fg-muted">还没有可用的模型，请联系管理员。</p>
					) : (
						list.map((m) => (
							<SettingsRow key={m.id} label={m.label}>
								{m.status === "ready" ? <Badge tone="success">可用</Badge> : m.status === "fixture" ? <Badge tone="warning">{FIXTURE_LABEL}</Badge> : <Badge tone="danger" title={m.statusDetail}>不可用：{m.statusDetail ?? "未配置密钥"}</Badge>}
							</SettingsRow>
						))
					)}
				</Loadable>
			</SettingsGroup>
		</>
	);
}

function CredentialsTab() {
	const { me } = useSession();
	return (
		<>
			<CredentialsSection />
			<Section title="环境变量" testId="my-env-vars">
				{me ? <EnvVarsEditor scope="user" scopeRef={me.userId} editable testId="env-vars-user" /> : null}
			</Section>
		</>
	);
}

function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
	return (
		<div className="inline-flex rounded-full bg-surface-2 p-0.5" role="group" aria-label={label}>
			{options.map(([v, l]) => (
				<button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)} className={cn("h-8 rounded-full px-3 text-sm", v === value ? "bg-surface font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
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
