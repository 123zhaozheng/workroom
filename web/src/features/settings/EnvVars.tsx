// 环境变量: plain (non-secret) variables a NEW command in the workspace receives. One small table per scope; the server's reasons
// (denied names, secret-looking values) are shown as they come. Secrets belong to 凭据, not here. The work panel also shows the
// effective result of all scopes for the conversation (which scope won).
import { Loader2, Lock, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { EffectiveEnvDTO, EnvScope, EnvVarDTO } from "@shared/workspace-safety";
import { ApiError, del, errorText, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { relTime } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Loadable } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/features/admin/confirm";

export const ENV_SCOPE_LABEL: Record<EnvScope, string> = { org: "组织", project: "项目", user: "个人", conversation: "本对话" };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function EnvVarsEditor({ scope, scopeRef, editable, testId = "env-vars", compact, onChanged }: { scope: EnvScope; scopeRef: string; editable: boolean; testId?: string; compact?: boolean; onChanged?: () => void }) {
	const { me } = useSession();
	const path = `/sandbox-env/${scope}/${encodeURIComponent(scopeRef)}`;
	const res = useApi<{ vars: EnvVarDTO[] }>(path);
	const { ask, dialog } = useConfirm();
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [locked, setLocked] = useState(false);
	const [editing, setEditing] = useState<string>();
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const vars = [...(res.data?.vars ?? [])].sort((a, b) => a.name.localeCompare(b.name));

	const reset = () => {
		setName("");
		setValue("");
		setLocked(false);
		setEditing(undefined);
	};
	const save = async () => {
		const n = name.trim();
		if (!NAME_RE.test(n)) return setErr("变量名只能含字母、数字和下划线，不能以数字开头");
		setBusy(true);
		setErr(undefined);
		try {
			await put(`${path}/${encodeURIComponent(n)}`, { value, ...(scope === "org" ? { locked } : {}) });
			reset();
			res.reload();
			onChanged?.();
		} catch (e) {
			const hint = e instanceof ApiError && e.code === "looks_like_secret" ? "密钥请不要放在环境变量里：助手需要时会在对话中请你通过「凭据」提供。" : "";
			setErr([errorText(e), hint].filter(Boolean).join(" "));
		} finally {
			setBusy(false);
		}
	};
	const remove = async (v: EnvVarDTO) => {
		if (!(await ask({ title: `删除变量 ${v.name}？`, consequence: "删除后，之后启动的命令不再有这个变量。", confirmLabel: "删除", danger: true }))) return;
		setErr(undefined);
		try {
			await del(`${path}/${encodeURIComponent(v.name)}`);
			if (editing === v.name) reset();
			res.reload();
			onChanged?.();
		} catch (e) {
			setErr(errorText(e));
		}
	};

	return (
		<div data-testid={testId} data-scope={scope} className="space-y-3">
			<Loadable state={res} what="环境变量">
				{vars.length === 0 ? (
					<p data-testid="env-empty" className="rounded-xl border border-dashed border-border-strong px-4 py-4 text-center text-sm text-fg-muted">
						还没有环境变量
					</p>
				) : (
					<div className="overflow-x-auto rounded-xl border border-border bg-surface">
						<table className="w-full min-w-[420px] text-left text-sm">
							<thead className="bg-surface-2 text-xs text-fg-muted">
								<tr>
									<th scope="col" className="px-3 py-2 font-medium">变量名</th>
									<th scope="col" className="px-3 py-2 font-medium">值</th>
									<th scope="col" className="px-3 py-2 font-medium">最近修改</th>
									{editable ? (
										<th scope="col" className="w-20 px-3 py-2">
											<span className="sr-only">操作</span>
										</th>
									) : null}
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								{vars.map((v) => (
									<tr key={v.id} data-testid="env-row" data-name={v.name}>
										<td className="px-3 py-2 align-top font-mono text-[13px]">
											{v.name}
											{v.locked ? (
												<Badge tone="warning" className="ml-1.5 align-middle" data-testid="env-locked">
													<Lock aria-hidden />
													已锁定
												</Badge>
											) : null}
										</td>
										<td className="max-w-[220px] break-all px-3 py-2 align-top font-mono text-[13px] text-fg-muted">{v.value}</td>
										<td className="px-3 py-2 align-top text-xs text-fg-muted">
											{v.updatedBy === me?.userId ? "你" : "其他成员"} · {relTime(v.updatedAt)}
										</td>
										{editable ? (
											<td className="px-2 py-1.5 align-top">
												<div className="flex">
													<Button
														size="icon-sm"
														variant="ghost"
														aria-label={`编辑 ${v.name}`}
														data-testid="env-edit"
														onClick={() => {
															setEditing(v.name);
															setName(v.name);
															setValue(v.value);
															setLocked(v.locked);
															setErr(undefined);
														}}
													>
														<Pencil />
													</Button>
													<Button size="icon-sm" variant="ghost" aria-label={`删除 ${v.name}`} data-testid="env-delete" onClick={() => void remove(v)}>
														<Trash2 />
													</Button>
												</div>
											</td>
										) : null}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Loadable>
			{editable ? (
				<form
					data-testid="env-form"
					className="flex flex-wrap items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<div className={compact ? "w-full" : "w-44"}>
						<label htmlFor={`${testId}-name`} className="mb-1 block text-xs text-fg-muted">
							变量名
						</label>
						<Input id={`${testId}-name`} data-testid="env-name" value={name} readOnly={!!editing} onChange={(e) => setName(e.target.value)} placeholder="例如 LANG" className="font-mono" autoComplete="off" spellCheck={false} />
					</div>
					<div className={compact ? "w-full" : "min-w-[160px] flex-1"}>
						<label htmlFor={`${testId}-value`} className="mb-1 block text-xs text-fg-muted">
							值
						</label>
						<Input id={`${testId}-value`} data-testid="env-value" value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} />
					</div>
					{scope === "org" ? (
						<div className="flex h-9 items-center gap-2 text-sm">
							<Switch data-testid="env-lock" aria-label="锁定" checked={locked} onCheckedChange={setLocked} />
							<span>锁定（下级不能覆盖）</span>
						</div>
					) : null}
					<Button type="submit" variant="primary" disabled={busy || !name.trim()} data-testid="env-save">
						{busy ? <Loader2 className="wr-spin" /> : null}
						{editing ? "保存修改" : "添加"}
					</Button>
					{editing ? (
						<Button onClick={reset} variant="ghost">
							取消
						</Button>
					) : null}
				</form>
			) : (
				<p data-testid="env-readonly" className="text-xs text-fg-muted">
					只读
				</p>
			)}
			{err ? (
				<p role="alert" data-testid="env-error" className="rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">
					{err}
				</p>
			) : null}
			<p className="text-xs text-fg-muted" data-testid="env-note">
				不要在这里放密钥。
			</p>
			{dialog}
		</div>
	);
}

/** What a NEW command in this conversation gets: every scope merged, with the one that won. */
export function EffectiveEnv({ spaceId, conversationId, reloadKey }: { spaceId: string; conversationId: number; reloadKey?: number }) {
	const q = `?spaceId=${encodeURIComponent(spaceId)}&conversationId=${conversationId}`;
	const res = useApi<{ effective: EffectiveEnvDTO }>(`/sandbox-env/effective${q}${reloadKey ? `&_=${reloadKey}` : ""}`, { pollMs: 5000 });
	const eff = res.data?.effective;
	return (
		<div data-testid="env-effective" className="space-y-2">
			<h4 className="text-sm font-medium">实际生效的变量</h4>
			<Loadable state={res} what="生效的环境变量">
				{!eff || (eff.vars.length === 0 && eff.denied.length === 0) ? (
					<p className="text-sm text-fg-muted">没有额外的环境变量。</p>
				) : (
					<ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
						{eff.vars.map((v) => (
							<li key={v.name} data-testid="env-effective-row" data-name={v.name} data-from={v.from} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2">
								<span className="font-mono text-[13px]">{v.name}</span>
								<span className="min-w-0 flex-1 break-all font-mono text-[13px] text-fg-muted">= {v.value}</span>
								<Badge tone={v.from === "org" ? "warning" : "info"}>来自{ENV_SCOPE_LABEL[v.from]}</Badge>
								{v.overridden.length ? <span className="basis-full text-xs text-fg-muted">覆盖了：{v.overridden.map((s) => ENV_SCOPE_LABEL[s]).join("、")}</span> : null}
							</li>
						))}
						{eff.denied.map((d) => (
							<li key={`d-${d.name}`} data-testid="env-denied-row" className="flex flex-wrap items-center gap-2 px-3 py-2">
								<span className="font-mono text-[13px]">{d.name}</span>
								<Badge tone="danger">未生效</Badge>
								<span className="basis-full text-xs text-fg-muted">{d.reason}</span>
							</li>
						))}
					</ul>
				)}
			</Loadable>
		</div>
	);
}

/** Work panel: this conversation's own variables + the effective view. */
export function ConversationEnv({ spaceId, conversationId, canWrite }: { spaceId: string; conversationId: number; canWrite: boolean }) {
	const [tick, setTick] = useState(0);
	return (
		<div className="space-y-4">
			<EnvVarsEditor scope="conversation" scopeRef={`${spaceId}:${conversationId}`} editable={canWrite} testId="env-vars-conversation" compact onChanged={() => setTick((t) => t + 1)} />
			<EffectiveEnv spaceId={spaceId} conversationId={conversationId} reloadKey={tick} />
		</div>
	);
}
