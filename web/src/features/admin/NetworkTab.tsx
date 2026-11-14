// 网络访问（角色与权限 › 网络访问）：组织的网络访问策略。一个模式 + 三个名单 + 「测试网址」。
// 规则与格式校验来自 @shared/netpolicy（与服务端同一份）；协议、凭据 URL、DNS 固定、云元数据地址是不可关闭的安全底线，只在页面里说明。
import { Lock, Plus, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { DEFAULT_NET_POLICY, NET_LIST_LABEL, NET_LIST_MAX, parseNetEntry, type NetListKind, type NetMode, type NetPolicyAdminDTO, type NetPolicyDTO, type NetTestResult } from "@shared/netpolicy";
import { del, post, put } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Loadable, Spinner } from "@/components/ui/misc";
import { useAct } from "@/features/admin/common";
import { useConfirm } from "@/features/admin/confirm";

const MODES: { id: NetMode; title: string; hint: string }[] = [
	{ id: "open", title: "全部公网允许", hint: "默认。浏览器、网页抓取、连接器可以访问任何公网地址；内网与云元数据地址仍然拦截。" },
	{ id: "allowlist", title: "仅允许名单内域名", hint: "只有允许名单、内网例外里的主机可以访问，其余一律拦截。" },
];

const LISTS: { kind: NetListKind; hint: string; placeholder: string }[] = [
	{ kind: "allow", hint: "仅在「仅允许名单内域名」下生效。可写域名、*.example.com（所有子域名）、IP，或 域名:端口。", placeholder: "例如 *.example.com，回车添加" },
	{ kind: "block", hint: "任何模式下都拦截，优先于其它所有名单（包括内网例外和环境变量）。格式同上。", placeholder: "例如 *.ads.example.com，回车添加" },
	{ kind: "internal", hint: "服务器代为访问时，允许这些主机解析到内网地址（例如公司内部知识库）。云元数据地址不能放行。", placeholder: "例如 wiki.corp.local 或 10.0.0.5:8080" },
];

const SAMPLE = [
	{ k: "拦截", v: "非 http / https 协议、带账号密码的网址" },
	{ k: "拦截", v: "云元数据地址（169.254.169.254、metadata.google.internal 等），内网例外也不能放行" },
	{ k: "固定", v: "域名只解析一次，连接直接使用校验过的 IP（防 DNS 重绑定）；每一跳重定向都重新检查" },
];

/** Chips + an input: Enter / comma / paste adds (each entry validated with the same rules as the server), × or Backspace removes. */
function TagList({ kind, values, onChange, locked = [], placeholder, testId }: { kind: NetListKind; values: readonly string[]; onChange: (v: string[]) => void; locked?: readonly string[]; placeholder: string; testId: string }) {
	const [draft, setDraft] = useState("");
	const [err, setErr] = useState<string>();
	const id = useId();
	const add = (raw: string) => {
		const parts = raw.split(/[\s,，;；]+/).filter(Boolean);
		if (!parts.length) return;
		const next = [...values];
		for (const part of parts) {
			const r = parseNetEntry(part, kind);
			if (!r.ok) {
				setErr(`「${part}」${r.error}`);
				onChange(next);
				setDraft(parts.slice(parts.indexOf(part)).join(" "));
				return;
			}
			if (!next.includes(r.entry)) next.push(r.entry);
		}
		if (next.length > NET_LIST_MAX) return setErr(`最多 ${NET_LIST_MAX} 条`);
		setErr(undefined);
		setDraft("");
		onChange(next);
	};
	return (
		<div data-testid={testId}>
			<ul aria-label={`${NET_LIST_LABEL[kind]}已有条目`} className="mb-2 flex min-h-7 flex-wrap gap-1.5">
				{locked.map((t) => (
					<li key={`env-${t}`} data-testid={`${testId}-env`} title="来自服务器环境变量 WORKROOM_URL_ALLOWLIST，只能由运维修改" className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border bg-surface-2 px-2 text-xs text-fg-muted">
						<Lock aria-hidden className="size-3" />
						{t}
						<span className="text-fg-subtle">环境变量</span>
					</li>
				))}
				{values.map((t) => (
					<li key={t} data-testid={`${testId}-chip`} className="inline-flex h-7 items-center gap-0.5 rounded-md bg-surface-2 pl-2 pr-0.5 text-xs">
						<span className="font-mono">{t}</span>
						<button type="button" aria-label={`移除 ${t}`} onClick={() => onChange(values.filter((x) => x !== t))} className="inline-flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-3" />
						</button>
					</li>
				))}
				{values.length + locked.length === 0 ? <li className="self-center text-xs text-fg-subtle">还没有条目</li> : null}
			</ul>
			<div className="flex gap-1.5">
				<Input
					id={id}
					value={draft}
					placeholder={placeholder}
					aria-label={`添加到${NET_LIST_LABEL[kind]}`}
					aria-invalid={err ? true : undefined}
					data-testid={`${testId}-input`}
					className="h-8 max-w-md font-mono"
					onChange={(e) => (setDraft(e.target.value), err && setErr(undefined))}
					onPaste={(e) => {
						const text = e.clipboardData.getData("text");
						if (/[\s,，;；]/.test(text.trim())) (e.preventDefault(), add(text));
					}}
					onKeyDown={(e) => {
						if ((e.key === "Enter" || e.key === ",") && draft.trim()) (e.preventDefault(), add(draft));
						else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
					}}
				/>
				<Button type="button" size="icon" aria-label={`添加到${NET_LIST_LABEL[kind]}`} data-testid={`${testId}-add`} disabled={!draft.trim()} onClick={() => add(draft)}>
					<Plus />
				</Button>
			</div>
			{err ? (
				<p role="alert" data-testid={`${testId}-error`} className="mt-1.5 text-xs text-danger">
					{err}
				</p>
			) : null}
		</div>
	);
}

const same = (a: NetPolicyDTO, b: NetPolicyDTO) => a.mode === b.mode && (["allow", "block", "internal"] as const).every((k) => a[k].length === b[k].length && a[k].every((x, i) => x === b[k][i]));

export function NetworkAccess() {
	const res = useApi<NetPolicyAdminDTO>("/admin/network-policy");
	const [draft, setDraft] = useState<NetPolicyDTO>(DEFAULT_NET_POLICY);
	const { ask, dialog } = useConfirm();
	const saved = res.data?.policy;
	useEffect(() => {
		if (saved) setDraft(saved);
	}, [saved]);
	const { busy, run, note } = useAct(() => res.reload());
	const dirty = !!saved && !same(draft, saved);
	const env = res.data?.env.internal ?? [];
	return (
		<div data-testid="network-tab" className="space-y-6">
			<Loadable state={res} what="网络访问策略" need="管理网络访问策略（network.manage）">
				<p className="max-w-2xl text-sm text-fg-muted">
					决定服务器代用户访问外部网址时能去哪里：浏览器工具、网页抓取（保存/交付网址文件）、MCP 连接器、成员自带的模型地址都按这里执行。修改立即生效，并写入审计日志。
				</p>
				<section aria-label="外网访问模式" className="mt-5">
					<h3 className="mb-2 text-sm font-medium">外网访问</h3>
					<div role="radiogroup" aria-label="外网访问模式" className="grid gap-2 sm:grid-cols-2">
						{MODES.map((m) => (
							<label key={m.id} data-testid={`net-mode-${m.id}`} className={`flex cursor-pointer gap-2.5 rounded-xl border p-3 text-sm transition-colors ${draft.mode === m.id ? "border-info bg-info-soft" : "border-border bg-surface hover:bg-surface-2"}`}>
								<input type="radio" name="net-mode" className="mt-0.5 size-4 shrink-0 accent-[var(--info)]" checked={draft.mode === m.id} onChange={() => setDraft({ ...draft, mode: m.id })} />
								<span>
									<span className="block font-medium">{m.title}</span>
									<span className="mt-0.5 block text-xs text-fg-muted">{m.hint}</span>
								</span>
							</label>
						))}
					</div>
				</section>
				<div className="mt-6 space-y-5">
					{draft.mode === "allowlist" && draft.allow.length + draft.internal.length + env.length === 0 ? (
						<p role="note" data-testid="net-empty-warning" className="max-w-2xl rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
							允许名单是空的：保存后，服务器将拦截所有外部网址。
						</p>
					) : null}
					{LISTS.map((l) => (
						<section key={l.kind} aria-label={NET_LIST_LABEL[l.kind]} className={l.kind === "allow" && draft.mode !== "allowlist" ? "opacity-60" : undefined}>
							<h3 className="text-sm font-medium">
								{NET_LIST_LABEL[l.kind]}
								{l.kind === "allow" && draft.mode !== "allowlist" ? <span className="ml-2 text-xs font-normal text-fg-subtle">当前模式下不生效</span> : null}
							</h3>
							<p className="mb-2 mt-0.5 max-w-2xl text-xs text-fg-muted">{l.hint}</p>
							<TagList kind={l.kind} values={draft[l.kind]} onChange={(v) => setDraft({ ...draft, [l.kind]: v })} locked={l.kind === "internal" ? env : []} placeholder={l.placeholder} testId={`net-${l.kind}`} />
						</section>
					))}
				</div>
				<section aria-label="始终生效的安全规则" data-testid="net-floor" className="mt-6 rounded-xl border border-border bg-surface px-4 py-3">
					<h3 className="flex items-center gap-1.5 text-sm font-medium">
						<ShieldCheck aria-hidden className="size-4 text-success" />
						始终生效，不可关闭
					</h3>
					<ul className="mt-2 space-y-1 text-xs text-fg-muted">
						{SAMPLE.map((s) => (
							<li key={s.v} className="flex gap-2">
								<Badge tone="neutral" className="shrink-0">
									{s.k}
								</Badge>
								<span>{s.v}</span>
							</li>
						))}
					</ul>
				</section>
				{note}
				<div className="mt-5 flex flex-wrap items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						data-testid="net-save"
						disabled={busy || !dirty}
						onClick={() => void run(async () => setDraft((await put<NetPolicyAdminDTO>("/admin/network-policy", { ...draft })).policy))}
					>
						{busy ? <Spinner className="text-accent-fg" /> : null}保存
					</Button>
					<Button size="sm" data-testid="net-discard" disabled={busy || !dirty} onClick={() => saved && setDraft(saved)}>
						放弃修改
					</Button>
					<Button
						variant="ghost"
						size="sm"
						data-testid="net-reset"
						disabled={busy || !!res.data?.isDefault}
						onClick={() =>
							void (async () => {
								if (!(await ask({ title: "恢复默认网络策略？", consequence: "将清空三个名单并恢复为「全部公网允许」，立即生效。不影响环境变量里的条目。", confirmLabel: "恢复默认", danger: true }))) return;
								await run(async () => setDraft((await del<NetPolicyAdminDTO>("/admin/network-policy")).policy));
							})()
						}
					>
						<RotateCcw />
						恢复默认
					</Button>
					{dirty ? (
						<span data-testid="net-dirty" className="text-xs text-warning">
							有未保存的修改
						</span>
					) : res.data?.updatedAt ? (
						<span className="text-xs text-fg-subtle">已生效</span>
					) : (
						<span className="text-xs text-fg-subtle">使用默认策略</span>
					)}
				</div>
				<UrlTester policy={draft} dirty={dirty} />
				{dialog}
			</Loadable>
		</div>
	);
}

const RULE_TEXT: Record<string, string> = { ok: "允许", bad_url: "网址无效", protocol: "协议不允许", credentials: "含账号密码", blocklist: "阻止名单", not_in_allowlist: "不在允许名单", metadata: "云元数据地址", private: "内网地址", dns: "无法解析" };
const VIA_TEXT: Record<string, string> = { public: "公网地址", allowlist: "允许名单", internal: "内网例外", env: "环境变量" };

/** 「测试网址」: asks the server what it would decide (dry run) — with the form's current, possibly unsaved, lists. */
function UrlTester({ policy, dirty }: { policy: NetPolicyDTO; dirty: boolean }) {
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [out, setOut] = useState<{ url: string; r?: NetTestResult; error?: string }>();
	const test = async () => {
		const u = url.trim();
		if (!u) return;
		setBusy(true);
		try {
			setOut({ url: u, r: await post<NetTestResult>("/admin/network-policy/test", { url: u, policy }) });
		} catch (e) {
			setOut({ url: u, error: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(false);
		}
	};
	const r = out?.r;
	const meta = useMemo(() => (r ? [r.host && `${r.host}${r.port ? `:${r.port}` : ""}`, r.addresses?.length ? `解析到 ${r.addresses.join("、")}` : undefined].filter(Boolean).join(" · ") : ""), [r]);
	return (
		<section aria-label="测试网址" data-testid="net-test" className="mt-8 rounded-xl border border-border bg-surface p-4">
			<h3 className="text-sm font-medium">测试网址</h3>
			<p className="mb-3 mt-0.5 text-xs text-fg-muted">只做判断，不会真的访问该网址。{dirty ? "按页面上当前（未保存）的设置判断。" : "按当前生效的设置判断。"}</p>
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void test();
				}}
			>
				<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/page" aria-label="要测试的网址" data-testid="net-test-input" className="h-8 max-w-md flex-1 font-mono" />
				<Button type="submit" size="sm" variant="secondary" disabled={busy || !url.trim()} data-testid="net-test-run">
					{busy ? <Spinner /> : null}测试
				</Button>
			</form>
			{out ? (
				<div data-testid="net-test-result" data-allowed={r ? String(r.allowed) : "error"} role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${r?.allowed ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>
					{r ? (
						<>
							<div className="flex flex-wrap items-center gap-2 font-medium">
								<span data-testid="net-test-verdict">{r.allowed ? "允许" : "拦截"}</span>
								<Badge tone={r.allowed ? "success" : "danger"}>{r.allowed ? (VIA_TEXT[r.via ?? "public"] ?? "允许") : (RULE_TEXT[r.rule] ?? r.rule)}</Badge>
							</div>
							<p className="mt-1 text-xs opacity-90" data-testid="net-test-reason">
								{r.reason}
							</p>
							{meta ? <p className="mt-0.5 font-mono text-xs opacity-75">{meta}</p> : null}
						</>
					) : (
						<span role="alert">{out.error}</span>
					)}
				</div>
			) : null}
		</section>
	);
}
