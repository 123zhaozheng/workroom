// 凭据请求: the agent asked for a secret (API key / token). The person types it HERE, in a password field that is not React state,
// and it goes straight to the server (POST …/fulfill). The value is never kept in state, storage or the URL, is cleared after every
// submit and on unmount, and no response ever returns it. The conversation only learns the status (已提供 / 已拒绝 / …).
//
// Where it lives: pending requests are not part of the conversation SSE state (server gap), so while a credential_request tool call is
// still running the chat page polls GET /api/credential-requests?status=pending and shows the form for this conversation's requests.
// A finished call is shown as a one-line outcome card inside its own turn (status comes from the tool result, which has status only).
import { Ban, CheckCircle2, Clock, KeyRound, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CredentialRequestDTO, CredentialScope } from "@shared/workspace-safety";
import { ApiError, errorText, get, post } from "@/lib/api";
import { cn, fullTime } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/misc";
import type { AssistantTurn, Step } from "./model";
import { DetailsPanel, DetailsToggle } from "./Disclosure";

type ToolStep = Extract<Step, { kind: "tool" }>;
type Status = CredentialRequestDTO["status"];
interface FormResp {
	request: CredentialRequestDTO;
	nonce?: string;
	store: { id: string; available: boolean; reason?: string };
}

const STATUS: Record<Status, { label: string; tone: "success" | "neutral" | "warning" | "danger" | "info"; Icon: typeof Ban }> = {
	pending: { label: "等待你填写", tone: "warning", Icon: Clock },
	fulfilled: { label: "已提供", tone: "success", Icon: CheckCircle2 },
	declined: { label: "已拒绝", tone: "neutral", Icon: XCircle },
	cancelled: { label: "已取消", tone: "neutral", Icon: Ban },
	expired: { label: "已过期", tone: "warning", Icon: Clock },
	revoked: { label: "已撤销", tone: "danger", Icon: Ban },
};

export const NO_STORE_TEXT = "服务器未配置密钥存储，暂不能提供凭据";
export const PASTE_WARNING = "不要在聊天里粘贴密钥；请只在此处填写";
const PERSIST_NOTE = { once: "用完即弃，不会出现在「我的凭据」里。", save: "加密保存在服务器，可随时在「设置 → 我的凭据」撤销。" } as const;

function ttlText(sec: number): string {
	if (sec % 86400 === 0) return `${sec / 86400} 天`;
	if (sec % 3600 === 0) return `${sec / 3600} 小时`;
	return `${Math.max(1, Math.round(sec / 60))} 分钟`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** credential_request tool steps of a turn (finished or running). */
export function credentialSteps(turn: AssistantTurn): ToolStep[] {
	return turn.steps.filter((s): s is ToolStep => s.kind === "tool" && s.call.name === "credential_request");
}

/** What the tool returned to the model: status only. Never contains a secret. */
function outcomeOf(step: ToolStep): { requestId?: string; status?: Status; error?: string } {
	const r = step.result;
	if (!r) return {};
	if (r.isError) return { error: r.text };
	try {
		const j = JSON.parse(r.text) as unknown;
		if (isObj(j) && typeof j.status === "string") return { requestId: typeof j.requestId === "string" ? j.requestId : undefined, status: j.status as Status };
	} catch {
		/* not JSON */
	}
	return {};
}

/** The service / hosts the agent named, for the finished-card (the DTO is gone once the request is closed). */
function argsOf(step: ToolStep): { service: string; hosts: string[] } {
	const a = isObj(step.call.arguments) ? step.call.arguments : {};
	return { service: typeof a.service === "string" ? a.service : "", hosts: Array.isArray(a.targetHosts) ? a.targetHosts.filter((h): h is string => typeof h === "string") : [] };
}

// ------------------------------------------------------------------------------------------------ finished (inside the turn)
/** One-line outcome for a finished credential_request step. */
export function CredentialOutcome({ step }: { step: ToolStep }) {
	const o = outcomeOf(step);
	const { service, hosts } = argsOf(step);
	if (!step.result) return null;
	if (!o.status) {
		const noStore = /未配置|secret_storage/.test(o.error ?? "");
		return (
			<div data-testid="credential-outcome" data-status={noStore ? "unavailable" : "error"} role="status" className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[13px]">
				<ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
				<div className="min-w-0">
					<div className="font-medium">凭据请求{service ? `：${service}` : ""}</div>
					<p className="text-fg-muted">{noStore ? `${NO_STORE_TEXT}。助手没有得到任何凭据。` : "这个请求没有成功，助手没有得到任何凭据。"}</p>
				</div>
			</div>
		);
	}
	const st = STATUS[o.status] ?? STATUS.declined;
	return (
		<div data-testid="credential-outcome" data-status={o.status} role="status" className="mb-3 flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[13px]">
			<st.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", st.tone === "success" ? "text-success" : "text-fg-subtle")} />
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="font-medium">凭据请求{service ? `：${service}` : ""}</span>
					<Badge tone={st.tone}>{st.label}</Badge>
				</div>
				{hosts.length ? <p className="mt-0.5 break-all text-xs text-fg-muted">只能发往 {hosts.join("、")}</p> : null}
			</div>
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ pending (below the turns)
/**
 * Forms for this conversation's pending requests. `waiting` = a credential_request call is running (no result yet): only then do we poll.
 * A request stays on screen after it is answered until the tool result (with the same requestId) shows up as its in-turn outcome.
 */
export function PendingCredentialRequests({ spaceId, conversationId, turns, readOnly }: { spaceId: string; conversationId: number; turns: AssistantTurn[]; readOnly?: boolean }) {
	const steps = turns.flatMap(credentialSteps);
	const waiting = steps.some((s) => !s.result);
	const settled = new Set(steps.map((s) => outcomeOf(s).requestId).filter((x): x is string => !!x));
	const [ids, setIds] = useState<string[]>([]);
	useEffect(() => {
		if (!waiting) return;
		let stop = false;
		const tick = async () => {
			try {
				const r = await get<{ requests: CredentialRequestDTO[] }>("/credential-requests?status=pending");
				if (stop) return;
				const mine = r.requests.filter((q) => q.conversationId === conversationId && q.spaceId === spaceId).map((q) => q.id);
				setIds((cur) => (mine.every((m) => cur.includes(m)) ? cur : [...cur, ...mine.filter((m) => !cur.includes(m))]));
			} catch {
				/* transient: next tick */
			}
		};
		void tick();
		const t = setInterval(tick, 1500);
		return () => {
			stop = true;
			clearInterval(t);
		};
	}, [waiting, spaceId, conversationId]);
	const shown = ids.filter((id) => !settled.has(id));
	if (!shown.length) return null;
	return (
		<>
			{shown.map((id) => (
				<CredentialForm key={id} id={id} readOnly={readOnly} />
			))}
		</>
	);
}

// ------------------------------------------------------------------------------------------------ the form
/** Write-only password field. Uncontrolled on purpose: the value lives only in the DOM node until submit, never in React state. */
export function SecretInput({ inputRef, id, label = "密钥", disabled, testId = "credential-secret" }: { inputRef: React.RefObject<HTMLInputElement | null>; id: string; label?: string; disabled?: boolean; testId?: string }) {
	useEffect(() => {
		const el = inputRef.current;
		return () => {
			if (el) el.value = "";
		};
	}, [inputRef]);
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-[13px] font-medium">
				{label}
			</label>
			<input
				ref={inputRef}
				id={id}
				data-testid={testId}
				type="password"
				name="wr-secret-value"
				autoComplete="new-password"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				disabled={disabled}
				data-1p-ignore
				data-lpignore="true"
				className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-fg outline-none transition-colors focus:border-border-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
			/>
		</div>
	);
}

export function CredentialForm({ id, readOnly }: { id: string; readOnly?: boolean }) {
	const { me } = useSession();
	const uid = useId();
	const secretRef = useRef<HTMLInputElement>(null);
	const [data, setData] = useState<FormResp>();
	const [loadErr, setLoadErr] = useState<string>();
	const [persist, setPersist] = useState<"once" | "save">("once");
	const [scope, setScope] = useState<CredentialScope>("user");
	const [consent, setConsent] = useState(false);
	const [busy, setBusy] = useState<"submit" | "decline" | null>(null);
	const [err, setErr] = useState<string>();
	const [status, setStatus] = useState<Status>();
	const [open, setOpen] = useState(false);

	const load = useCallback(async () => {
		try {
			const r = await get<FormResp>(`/credential-requests/${encodeURIComponent(id)}`);
			setData(r);
			setLoadErr(undefined);
			if (r.request.status !== "pending") setStatus(r.request.status);
		} catch (e) {
			setLoadErr(errorText(e));
		}
	}, [id]);
	// A fresh single-use nonce is fetched right before the form is shown.
	useEffect(() => {
		void load();
	}, [load]);

	const req = data?.request;
	const env = req?.usage === "env";
	const perms = new Set(me?.permissionsAnywhere ?? []);
	const scopes: [CredentialScope, string][] = [["user", "仅自己"]];
	if (perms.has("credential.manage.project")) scopes.push(["project", "项目内共用"]);
	if (perms.has("credential.manage.org")) scopes.push(["org", "整个组织"]);

	const submit = async () => {
		const secret = secretRef.current?.value ?? "";
		if (!secret) return setErr("请先填写密钥。");
		if (!data?.nonce) return setErr("表单还没有准备好，请稍候或刷新。");
		setBusy("submit");
		setErr(undefined);
		let keep = false;
		try {
			const r = await post<{ request: CredentialRequestDTO }>(`/credential-requests/${encodeURIComponent(id)}/fulfill`, {
				secret,
				persist,
				...(persist === "save" && scope !== "user" ? { scope } : {}),
				...(env ? { envConsent: consent } : {}),
				nonce: data.nonce,
			});
			setStatus(r.request.status);
		} catch (e) {
			if (e instanceof ApiError && e.code === "invalid_nonce") {
				setErr("表单已失效，已为你刷新，请再点一次提交。");
				void load();
			} else if (e instanceof ApiError && e.code === "request_not_pending") {
				setErr(e.message);
				void load();
			} else {
				setErr(errorText(e));
				keep = e instanceof ApiError && e.status === 400; // a value the server did not accept can be corrected
			}
		} finally {
			if (!keep && secretRef.current) secretRef.current.value = "";
			setBusy(null);
		}
	};
	const decline = async () => {
		setBusy("decline");
		setErr(undefined);
		try {
			const r = await post<{ request: CredentialRequestDTO }>(`/credential-requests/${encodeURIComponent(id)}/decline`, {});
			if (secretRef.current) secretRef.current.value = "";
			setStatus(r.request.status);
		} catch (e) {
			setErr(errorText(e));
			void load();
		} finally {
			setBusy(null);
		}
	};

	if (loadErr)
		return (
			<div data-testid="credential-card" data-status="error" role="alert" className="max-w-[560px] rounded-xl border border-border bg-surface p-4 text-sm text-danger">
				凭据请求加载失败：{loadErr}
			</div>
		);
	if (!req) return <div data-testid="credential-card" data-status="loading" className="max-w-[560px] rounded-xl border border-border bg-surface p-4 text-sm text-fg-muted">正在准备表单…</div>;

	const done = status && status !== "pending";
	const st = STATUS[done ? status : "pending"];
	const noStore = !data!.store.available;
	const canSubmit = !readOnly && !noStore && !!data!.nonce && !busy && (!env || consent);

	const detailsId = `${uid}-d`;
	const toggle = <DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} controls={detailsId} testId="credential-details-toggle" />;
	return (
		<section data-testid="credential-card" data-status={done ? status : "pending"} aria-label={`凭据请求：${req.service}`} className="wr-fade-in w-full max-w-[560px] rounded-xl border border-border bg-surface p-3 shadow-[0_1px_2px_rgb(0_0_0/0.03)] sm:px-3.5">
			<header className="flex items-start gap-2.5">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
					<KeyRound aria-hidden className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-medium leading-5">助手想使用「{req.service}」的密钥</h3>
					<p data-testid="credential-purpose" className="text-[13px] leading-5 text-fg-muted">
						用途：{req.purpose}
					</p>
				</div>
				<Badge tone={st.tone} data-testid="credential-status">
					{st.label}
				</Badge>
			</header>

			<div className="mt-2.5 text-[13px]">
				<div className="mb-1 text-xs text-fg-muted">只会发往这些网站</div>
				<div data-testid="credential-hosts" className="flex flex-wrap gap-1.5">
					{req.targetHosts.length ? (
						req.targetHosts.map((h) => (
							<span key={h} className="rounded-md border border-border-strong bg-surface-2 px-2 py-0.5 font-mono text-sm font-medium text-fg">
								{h}
							</span>
						))
					) : (
						<span className="text-fg-muted">（未限定网站）</span>
					)}
				</div>
				{env ? (
					<div data-testid="credential-usage" className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-2 text-warning">
						<ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
						<span>
							注入到进程环境{req.envName ? `（变量 ${req.envName}）` : ""}。{req.envConsentText ?? "运行的进程及其子进程都能读到它，也可能把它泄露出去。"}
						</span>
					</div>
				) : null}
			</div>

			{done ? (
				<div data-testid="credential-done" role="status" className="mt-2.5 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
					<st.Icon aria-hidden className={cn("size-4", st.tone === "success" ? "text-success" : "text-fg-muted")} />
					<span className="font-medium">{st.label}</span>
				</div>
			) : noStore ? (
				<div className="mt-2.5 space-y-2.5">
					<p data-testid="credential-no-store" role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
						{NO_STORE_TEXT}。请联系管理员，或拒绝这次请求。
					</p>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<Button size="sm" data-testid="credential-decline" disabled={!!busy || readOnly} onClick={decline}>
							{busy === "decline" ? <Loader2 className="wr-spin" /> : null}
							拒绝
						</Button>
						{toggle}
					</div>
				</div>
			) : (
				<form
					className="mt-2.5 space-y-2.5"
					autoComplete="off"
					onSubmit={(e) => {
						e.preventDefault();
						if (canSubmit) void submit();
					}}
				>
					<p data-testid="credential-paste-warning" className="text-xs font-medium text-fg">
						{PASTE_WARNING}。
					</p>
					<SecretInput inputRef={secretRef} id={`${uid}-secret`} disabled={readOnly || !!busy} />
					<fieldset>
						<legend className="mb-1 text-[13px] font-medium">保存方式</legend>
						<div className="flex flex-wrap gap-x-4 gap-y-1">
							<label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
								<input type="radio" name={`${uid}-persist`} data-testid="credential-persist-once" checked={persist === "once"} onChange={() => setPersist("once")} className="size-4 accent-[var(--accent)]" />
								仅本次使用
							</label>
							<label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
								<input type="radio" name={`${uid}-persist`} data-testid="credential-persist-save" checked={persist === "save"} onChange={() => setPersist("save")} className="size-4 accent-[var(--accent)]" />
								保存供以后使用
							</label>
						</div>
						<p data-testid="credential-persist-note" className="mt-1 text-xs text-fg-muted">
							{persist === "once" ? PERSIST_NOTE.once : PERSIST_NOTE.save}
						</p>
						{persist === "save" ? (
							<div className="mt-1.5 flex items-center gap-2">
								<label htmlFor={`${uid}-scope`} className="text-[13px] text-fg-muted">
									谁可以使用
								</label>
								<Select id={`${uid}-scope`} data-testid="credential-scope" value={scope} onChange={(e) => setScope(e.target.value as CredentialScope)} className="h-8">
									{scopes.map(([v, l]) => (
										<option key={v} value={v}>
											{l}
										</option>
									))}
								</Select>
							</div>
						) : null}
					</fieldset>
					{env ? (
						<label className="flex cursor-pointer items-start gap-2 text-[13px]">
							<input type="checkbox" data-testid="credential-env-consent" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
							<span>我了解：运行的进程及其子进程都能读到这个密钥，也可能把它泄露出去，我同意这样使用。</span>
						</label>
					) : null}
					{err ? (
						<p data-testid="credential-error" role="alert" className="rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger">
							{err}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<Button type="submit" size="sm" variant="primary" data-testid="credential-submit" disabled={!canSubmit}>
							{busy === "submit" ? <Loader2 className="wr-spin" /> : null}
							提交
						</Button>
						<Button size="sm" data-testid="credential-decline" disabled={!!busy || readOnly} onClick={decline}>
							拒绝
						</Button>
						{toggle}
						{readOnly ? <span className="text-xs text-fg-muted">只有发起这个请求的人可以填写。</span> : null}
					</div>
				</form>
			)}
			{err && (done || noStore) ? (
				<p role="alert" className="mt-2 text-sm text-danger">
					{err}
				</p>
			) : null}
			{done ? <div className="mt-1.5 flex">{toggle}</div> : null}
			<DetailsPanel id={detailsId} open={open}>
				<dl className="space-y-2 text-[13px]">
					<div>
						<dt className="mb-1 text-xs text-fg-muted">允许的操作</dt>
						<dd data-testid="credential-methods" className="flex flex-wrap gap-1.5">
							{req.methods.map((m) => (
								<Badge key={m}>{m}</Badge>
							))}
						</dd>
					</div>
					{env ? null : (
						<div>
							<dt className="mb-1 text-xs text-fg-muted">使用方式</dt>
							<dd data-testid="credential-usage" className="text-fg">
								经服务器代为调用，密钥不会进入对话。
							</dd>
						</div>
					)}
					<div>
						<dt className="mb-1 text-xs text-fg-muted">保存方式说明</dt>
						<dd className="space-y-0.5 text-fg-muted">
							<p>仅本次使用：{PERSIST_NOTE.once}</p>
							<p>保存供以后使用：{PERSIST_NOTE.save}</p>
						</dd>
					</div>
					<div>
						<dt className="mb-1 text-xs text-fg-muted">有效期</dt>
						<dd data-testid="credential-validity" className="text-fg-muted">
							请在 {fullTime(req.expiresAt)} 前回复；「仅本次使用」的凭据提供后 {ttlText(req.ttlSec)}内有效。
						</dd>
					</div>
				</dl>
				<details className="text-xs text-fg-subtle" data-testid="credential-tech">
					<summary className="cursor-pointer select-none hover:text-fg-muted">技术详情</summary>
					<p className="mt-1 break-all">
						附加方式：请求头 {req.inject.header}（{req.inject.template.replace("{secret}", "‹密钥›")}）；请求编号 {req.id}
						{noStore && data!.store.reason ? `；${data!.store.reason}` : ""}
					</p>
				</details>
			</DetailsPanel>
		</section>
	);
}
