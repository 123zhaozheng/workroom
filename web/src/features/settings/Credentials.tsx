// 我的凭据: metadata only. There is no "show secret" anywhere: the server has no route that returns a value. A credential can be
// 撤销 (stops working, stays listed), 删除 (gone) or 更换 (the owner types the new value into a write-only field).
import { KeyRound, Loader2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { CredentialDTO, CredentialScope } from "@shared/workspace-safety";
import { ApiError, del, errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Section } from "@/features/admin/common";
import { Help } from "@/components/ui/help";
import { useConfirm } from "@/features/admin/confirm";
import { SecretInput } from "@/features/chat/CredentialRequestCard";

const SCOPE: Record<CredentialScope, string> = { user: "仅自己", project: "项目内共用", org: "整个组织" };

function statusOf(c: CredentialDTO): { label: string; tone: "success" | "danger" | "warning" } {
	if (c.revokedAt) return { label: "已撤销", tone: "danger" };
	if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return { label: "已过期", tone: "warning" };
	return { label: "可用", tone: "success" };
}

export function CredentialsSection() {
	const res = useApi<{ credentials: CredentialDTO[] }>("/credentials");
	const store = useApi<{ store: { available: boolean; reason?: string } }>("/credentials/status");
	const { ask, dialog } = useConfirm();
	const [err, setErr] = useState<string>();
	const [rotating, setRotating] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const list = res.data?.credentials ?? [];
	const act = async (id: string, fn: () => Promise<unknown>) => {
		setErr(undefined);
		setBusy(id);
		try {
			await fn();
			res.reload();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<Section title="我的凭据" testId="credentials-section" action={<Help label="凭据说明">助手请求并经你同意保存的密钥。这里只显示信息，永远不会显示密钥本身。</Help>}>
			{store.data && !store.data.store.available ? (
				<p data-testid="credentials-no-store" className="mb-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
					未配置密钥存储，暂不能保存凭据。
				</p>
			) : null}
			{err ? (
				<p role="alert" data-testid="credentials-error" className="mb-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">
					{err}
				</p>
			) : null}
			<Loadable state={res} what="凭据">
				{list.length === 0 ? (
					<div className="rounded-xl border border-border bg-surface">
						<EmptyState icon={<KeyRound />} title="还没有保存的凭据" />
					</div>
				) : (
					<ul data-testid="credentials-list" className="divide-y divide-border rounded-xl border border-border bg-surface">
						{list.map((c) => {
							const st = statusOf(c);
							const inactive = st.tone !== "success";
							return (
								<li key={c.id} data-testid="credential-row" data-status={st.label} className="px-4 py-3 text-sm">
									<div className="flex flex-wrap items-center gap-2">
										<span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
										<Badge tone={st.tone}>{st.label}</Badge>
										<Badge>{SCOPE[c.scope]}</Badge>
										{c.usage === "env" ? <Badge tone="warning">注入进程环境</Badge> : null}
									</div>
									<p className="mt-1 break-all text-[13px]">
										<span className="text-fg-muted">只能发往 </span>
										<span className="font-mono">{c.targetHosts.length ? c.targetHosts.join("、") : "（未限定）"}</span>
										<span className="text-fg-muted"> · {c.methods.join(" / ")} · {c.usage === "env" ? "注入到进程环境" : "经服务器代为调用"}</span>
									</p>
									<p className="mt-0.5 text-xs text-fg-muted">
										创建于 {fullTime(c.createdAt)}
										{c.expiresAt ? ` · 有效至 ${fullTime(c.expiresAt)}` : " · 长期有效"}
										{c.lastUsedAt ? ` · 最近使用 ${relTime(c.lastUsedAt)}` : " · 还没有被使用"}
										{c.hint ? ` · ${c.hint}` : ""}
									</p>
									<div className="mt-2 flex flex-wrap items-center gap-2">
										<Button size="sm" data-testid="credential-rotate" disabled={inactive || busy === c.id} onClick={() => setRotating(rotating === c.id ? undefined : c.id)}>
											更换密钥
										</Button>
										<Button
											size="sm"
											data-testid="credential-revoke"
											disabled={!!c.revokedAt || busy === c.id}
											onClick={async () => {
												if (await ask({ title: "撤销这个凭据？", consequence: "撤销后助手不能再用它访问外部服务，需要时只能重新提供。", confirmLabel: "撤销", danger: true })) void act(c.id, () => post(`/credentials/${encodeURIComponent(c.id)}/revoke`, {}));
											}}
										>
											撤销
										</Button>
										<Button
											size="sm"
											variant="ghost"
											data-testid="credential-delete"
											disabled={busy === c.id}
											onClick={async () => {
												if (await ask({ title: "删除这个凭据？", consequence: "删除后无法恢复。", confirmLabel: "删除", danger: true })) void act(c.id, () => del(`/credentials/${encodeURIComponent(c.id)}`));
											}}
										>
											删除
										</Button>
									</div>
									{rotating === c.id ? (
										<RotateForm
											id={c.id}
											onDone={() => {
												setRotating(undefined);
												res.reload();
											}}
											onCancel={() => setRotating(undefined)}
										/>
									) : null}
								</li>
							);
						})}
					</ul>
				)}
			</Loadable>
			{dialog}
		</Section>
	);
}

function RotateForm({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
	const uid = useId();
	const ref = useRef<HTMLInputElement>(null);
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const submit = async () => {
		const secret = ref.current?.value ?? "";
		if (!secret) return setErr("请先填写新的密钥。");
		setBusy(true);
		setErr(undefined);
		let keep = false;
		try {
			await post(`/credentials/${encodeURIComponent(id)}/rotate`, { secret });
			onDone();
		} catch (e) {
			setErr(errorText(e));
			keep = e instanceof ApiError && e.status === 400;
		} finally {
			if (!keep && ref.current) ref.current.value = "";
			setBusy(false);
		}
	};
	return (
		<form
			data-testid="credential-rotate-form"
			autoComplete="off"
			className="mt-3 max-w-md space-y-2 rounded-lg bg-surface-2 p-3"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<SecretInput inputRef={ref} id={`${uid}-rotate`} label="新的密钥" testId="credential-rotate-secret" disabled={busy} />
			<p className="text-xs text-fg-muted">旧的密钥会立即失效。不要在聊天里粘贴密钥。</p>
			{err ? (
				<p role="alert" className="text-sm text-danger">
					{err}
				</p>
			) : null}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" size="sm" disabled={busy} data-testid="credential-rotate-submit">
					{busy ? <Loader2 className="wr-spin" /> : null}
					提交
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					取消
				</Button>
			</div>
		</form>
	);
}
