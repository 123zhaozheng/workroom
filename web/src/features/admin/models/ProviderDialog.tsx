// Add / edit a 模型服务. Adding is three short steps: 1 type (with common presets) → 2 address + key → 3 connection check, fetched
// models and which ones to open to members. Editing shows address + key on one page. Rare settings (auth style, headers, limits,
// failure protection, timeout) live in the collapsed 高级设置. Keys are write-only; the server never returns them.
import { Check, CircleAlert, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AdminModelDTO, CreateModelProviderRequest, ModelAuthStyle, ModelProviderDTO, ModelProviderPreset, ModelProviderType, ModelProvidersResponse, ProviderTestResponse, UpdateModelProviderRequest } from "@shared/ops";
import { errorText, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { Fold } from "@/features/admin/common";
import { endpointExample, presetName } from "./shared";

interface HeaderRow {
	name: string;
	value: string;
}
type Family = "openai" | "claude" | "builtin";
const FAMILIES: { id: Family; title: string }[] = [
	{ id: "openai", title: "OpenAI 兼容" },
	{ id: "claude", title: "Claude 兼容" },
	{ id: "builtin", title: "内置服务" },
];
const familyOf = (t: ModelProviderType): Family => (t === "anthropic-messages" ? "claude" : t === "builtin" ? "builtin" : "openai");
const AUTH_LABEL: Record<ModelAuthStyle, string> = { default: "自动（推荐）", bearer: "Authorization: Bearer", "x-api-key": "x-api-key", "api-key": "api-key" };
type Stage = "type" | "conn" | "models";

export function ProviderDialog({
	open,
	onOpenChange,
	base,
	personal,
	existing,
	catalog,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	/** "/admin/model-providers" or "/me/model-providers" */
	base: string;
	personal?: boolean;
	existing?: ModelProviderDTO;
	catalog?: Pick<ModelProvidersResponse, "presets" | "builtins" | "settings">;
	onSaved: () => void;
}) {
	const editing = !!existing;
	const presets = catalog?.presets ?? [];
	const [stage, setStage] = useState<Stage>(editing ? "conn" : "type");
	const [preset, setPreset] = useState<string>(existing?.preset ?? "");
	const [name, setName] = useState(existing?.name ?? "");
	const [type, setType] = useState<ModelProviderType>(existing?.type ?? "openai-completions");
	const [builtinId, setBuiltinId] = useState(existing?.builtinId ?? "");
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
	const [keyMode, setKeyMode] = useState<"inline" | "env">(existing?.credential.kind === "env" ? "env" : "inline");
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const [apiKeyEnv, setApiKeyEnv] = useState(existing?.credential.envVar ?? "");
	const [keyless, setKeyless] = useState(existing?.keyless ?? false);
	const [authStyle, setAuthStyle] = useState<ModelAuthStyle>(existing?.authStyle ?? "default");
	const [timeout, setTimeoutMs] = useState(existing?.timeoutMs ? String(existing.timeoutMs) : "");
	const [rpm, setRpm] = useState(existing?.rpmLimit ? String(existing.rpmLimit) : "");
	const [conc, setConc] = useState(existing?.concurrencyLimit ? String(existing.concurrencyLimit) : "");
	const [brThreshold, setBrThreshold] = useState(existing?.breakerThreshold !== undefined ? String(existing.breakerThreshold) : "");
	const [brWindow, setBrWindow] = useState(existing?.breakerWindowMs ? String(existing.breakerWindowMs) : "");
	const [headers, setHeaders] = useState<HeaderRow[]>((existing?.headerNames ?? []).map((n) => ({ name: n, value: "****" })));
	const [extraEnv, setExtraEnv] = useState<HeaderRow[]>((existing?.envKeys ?? []).map((n) => ({ name: n, value: "****" })));
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const [created, setCreated] = useState<ModelProviderDTO>();
	const family = familyOf(type);
	const ex = endpointExample(type, baseUrl);
	const keyOk = catalog?.settings?.secretKeyConfigured !== false;
	const builtinChoices = catalog?.builtins ?? [];

	const pickFamily = (f: Family) => {
		if (editing) return;
		setType(f === "claude" ? "anthropic-messages" : f === "builtin" ? "builtin" : "openai-completions");
		setPreset("");
	};
	const applyPreset = (p: ModelProviderPreset | undefined) => {
		setPreset(p?.key ?? "");
		if (!p) return;
		setType(p.type);
		setBaseUrl(p.baseUrl ?? "");
		setKeyless(!!p.keyless);
		setAuthStyle(p.authStyle ?? "default");
		if (p.builtinId) setBuiltinId(p.builtinId);
		setName(p.key === "openai-compatible" || p.key === "claude-relay" ? "" : presetName(p.label));
	};

	const submit = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			const hdr = Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
			const env = Object.fromEntries(extraEnv.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
			if (editing) {
				const body: UpdateModelProviderRequest = { name, keyless, authStyle, timeoutMs: timeout ? Number(timeout) : null, rpmLimit: rpm ? Number(rpm) : null, concurrencyLimit: conc ? Number(conc) : null, breakerThreshold: brThreshold ? Number(brThreshold) : null, breakerWindowMs: brWindow ? Number(brWindow) : null, headers: hdr, ...(type === "builtin" ? { env } : { baseUrl }) };
				if (clearKey) body.apiKey = null;
				else if (keyMode === "inline" && apiKey) body.apiKey = apiKey;
				if (!personal && keyMode === "env") body.apiKeyEnv = apiKeyEnv || undefined;
				await patch(`${base}/${existing!.id}`, body as never);
				onOpenChange(false);
				onSaved();
			} else {
				const body: CreateModelProviderRequest = { name, type, preset: preset || undefined, keyless, authStyle, ...(timeout ? { timeoutMs: Number(timeout) } : {}), ...(rpm ? { rpmLimit: Number(rpm) } : {}), ...(conc ? { concurrencyLimit: Number(conc) } : {}), ...(brThreshold ? { breakerThreshold: Number(brThreshold) } : {}), ...(brWindow ? { breakerWindowMs: Number(brWindow) } : {}), ...(Object.keys(hdr).length ? { headers: hdr } : {}), ...(type === "builtin" ? { builtinId, ...(Object.keys(env).length ? { env } : {}) } : { baseUrl }), ...(keyMode === "inline" && apiKey ? { apiKey } : {}), ...(!personal && keyMode === "env" && apiKeyEnv ? { apiKeyEnv } : {}), fetchModels: true, enableFetched: !!personal };
				const r = await post<{ provider: ModelProviderDTO; fetched?: { ok: boolean; error?: string; count?: number } }>(base, body as never);
				setCreated(r.provider);
				onSaved();
				setStage("models");
			}
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const rowEditor = (rows: HeaderRow[], set: (r: HeaderRow[]) => void, nameLabel: string, ph: string) => (
		<div className="space-y-1.5">
			{rows.map((r, i) => (
				<div key={i} className="flex gap-1.5">
					<Input value={r.name} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={nameLabel} aria-label="名称" className="h-8 w-40 text-sm" />
					<Input value={r.value} type="password" onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={ph} aria-label="值" className="h-8 flex-1 text-sm" autoComplete="off" />
					<Button size="icon-sm" variant="ghost" aria-label="删除这一行" onClick={() => set(rows.filter((_, j) => j !== i))}>
						<Trash2 />
					</Button>
				</div>
			))}
			<Button size="sm" variant="ghost" onClick={() => set([...rows, { name: "", value: "" }])}>
				<Plus />
				添加
			</Button>
		</div>
	);

	const steps: [Stage, string][] = [
		["type", "类型"],
		["conn", "地址与密钥"],
		["models", "测试与模型"],
	];
	const title = editing ? `编辑「${existing!.name}」` : personal ? "添加我的模型服务" : "添加模型服务";
	const canNext = !!name.trim() && (type === "builtin" ? !!builtinId : !!baseUrl.trim());

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={title} className="max-h-[90vh] max-w-xl overflow-y-auto" data-testid="provider-dialog">
				{!editing ? (
					<ol className="mb-4 flex items-center gap-2 text-xs text-fg-muted" aria-label="步骤">
						{steps.map(([k, label], i) => (
							<li key={k} className={cn("flex items-center gap-1.5", stage === k && "font-medium text-fg")} aria-current={stage === k ? "step" : undefined}>
								<span className={cn("inline-flex size-5 items-center justify-center rounded-full border text-[12px]", stage === k ? "border-accent bg-accent text-accent-fg" : "border-border")}>{i + 1}</span>
								{label}
								{i < steps.length - 1 ? <span aria-hidden className="mx-1 h-px w-4 bg-border" /> : null}
							</li>
						))}
					</ol>
				) : null}

				{stage === "type" ? (
					<div className="space-y-4 text-sm" data-testid="provider-step-type">
						<div className="grid gap-2" role="radiogroup" aria-label="服务类型">
							{FAMILIES.filter((f) => !personal || f.id !== "builtin").map((f) => (
								<label key={f.id} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5", family === f.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2")}>
									<input type="radio" name="family" checked={family === f.id} onChange={() => pickFamily(f.id)} className="mt-1" />
									<span className="font-medium">{f.title}</span>
								</label>
							))}
						</div>
						{presets.some((p) => familyOf(p.type) === family) ? (
							<div>
								<Label>常用服务（可选）</Label>
								<div className="flex flex-wrap gap-1.5" data-testid="provider-preset">
									{presets
										.filter((p) => familyOf(p.type) === family && p.key !== "openai-compatible" && p.key !== "claude-relay")
										.map((p) => (
											<button key={p.key} type="button" aria-pressed={preset === p.key} onClick={() => applyPreset(preset === p.key ? undefined : p)} className={cn("h-8 rounded-lg border px-2.5 text-sm", preset === p.key ? "border-accent bg-accent-soft font-medium" : "border-border hover:bg-surface-2")}>
												{presetName(p.label)}
											</button>
										))}
								</div>
							</div>
						) : null}
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								取消
							</Button>
							<Button variant="primary" onClick={() => setStage("conn")} data-testid="provider-next">
								下一步
							</Button>
						</div>
					</div>
				) : null}

				{stage === "conn" ? (
					<div className="space-y-4 text-sm" data-testid="provider-step-conn">
						<div>
							<Label htmlFor="pv-name">名称</Label>
							<Input id="pv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：DeepSeek 官方" data-testid="provider-name" />
						</div>

						{type === "builtin" ? (
							<>
								<div>
									<Label htmlFor="pv-builtin">服务</Label>
									<Select id="pv-builtin" value={builtinId} disabled={editing} onChange={(e) => setBuiltinId(e.target.value)} className="w-full" data-testid="provider-builtin">
										<option value="">选择…</option>
										{builtinChoices.map((b) => (
											<option key={b.id} value={b.id} disabled={b.configured && !editing}>
												{b.name}
												{b.configured ? "（已配置）" : ""}
											</option>
										))}
									</Select>
								</div>
								<div>
									<Label>附加设置（如区域、资源名；值加密保存）</Label>
									{rowEditor(extraEnv, setExtraEnv, "AZURE_OPENAI_BASE_URL", "值")}
								</div>
							</>
						) : (
							<div>
								<Label htmlFor="pv-url">服务地址</Label>
								<Input id="pv-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={type === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.deepseek.com"} data-testid="provider-baseurl" />
								{personal ? <p className="mt-1 text-xs text-fg-muted">个人服务不能指向内网或本机地址。</p> : null}
							</div>
						)}

						<div>
							<Label htmlFor="pv-key">密钥</Label>
							{!keyOk && !keyless ? <p className="mb-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning">服务端未开启密钥加密，暂不能直接保存密钥。{!personal ? "可以改用「引用环境变量」。" : ""}</p> : null}
							{!personal ? (
								<div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
									<label className="flex items-center gap-1.5">
										<input type="radio" checked={keyMode === "inline"} onChange={() => setKeyMode("inline")} />
										直接填写（加密保存）
									</label>
									<label className="flex items-center gap-1.5">
										<input type="radio" checked={keyMode === "env"} onChange={() => setKeyMode("env")} />
										引用环境变量
									</label>
								</div>
							) : null}
							{keyMode === "inline" || personal ? (
								<>
									<Input id="pv-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" placeholder={editing && existing!.credential.kind === "stored" ? `已保存 ${existing!.credential.hint ?? ""}，留空表示不修改` : "sk-…"} disabled={clearKey || keyless} data-testid="provider-key" />
									{editing && existing!.credential.kind === "stored" ? (
										<label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
											<input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
											清除已保存的密钥
										</label>
									) : null}
								</>
							) : (
								<Input id="pv-key" value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="环境变量名，以 WORKROOM_ 开头" />
							)}
							<div className="mt-2 flex items-center gap-2 text-sm text-fg-muted">
								<Switch aria-label="不需要密钥" data-testid="provider-keyless" checked={keyless} onCheckedChange={setKeyless} />
								不需要密钥（本地部署的模型）
							</div>
						</div>

						<Fold title="高级设置" testId="provider-advanced">
							<div className="space-y-3">
								{type !== "builtin" ? (
									<div>
										<Label>鉴权方式</Label>
										<Select value={authStyle} onChange={(e) => setAuthStyle(e.target.value as ModelAuthStyle)} className="w-full" aria-label="鉴权方式">
											{(Object.keys(AUTH_LABEL) as ModelAuthStyle[]).map((k) => (
												<option key={k} value={k}>
													{AUTH_LABEL[k]}
												</option>
											))}
										</Select>
									</div>
								) : null}
								{family === "openai" && !editing ? (
									<div className="flex items-center gap-2 text-sm">
										<Switch aria-label="使用 OpenAI 新版对话接口" checked={type === "openai-responses"} onCheckedChange={(v) => setType(v ? "openai-responses" : "openai-completions")} />
										使用 OpenAI 新版对话接口
									</div>
								) : null}
								<div>
									<Label>自定义请求头（值加密保存；显示 **** 表示保持不变）</Label>
									{rowEditor(headers, setHeaders, "名称", "值")}
								</div>
								<div>
									<Label>限流与失败保护（可选）</Label>
									<div className="grid gap-2 sm:grid-cols-2">
										{([["每分钟请求上限", rpm, setRpm, "不限"], ["同时请求上限", conc, setConc, "不限"], ["连续失败多少次后暂停（0 = 不暂停）", brThreshold, setBrThreshold, "默认 3"], ["暂停多久（毫秒）", brWindow, setBrWindow, "默认 30000"]] as const).map(([label, v, set, ph]) => (
											<label key={label} className="text-xs text-fg-muted">
												{label}
												<Input value={v} onChange={(e) => set(e.target.value.replace(/\D/g, ""))} placeholder={ph} className="mt-0.5 h-8 text-sm" />
											</label>
										))}
									</div>
								</div>
								<div>
									<Label>请求超时（毫秒，可选）</Label>
									<Input value={timeout} onChange={(e) => setTimeoutMs(e.target.value.replace(/\D/g, ""))} placeholder="使用默认值" className="w-40" />
								</div>
							</div>
						</Fold>
						{type !== "builtin" ? (
							<Fold title="技术详情" testId="provider-tech">
								<div className="space-y-1 text-xs text-fg-muted" data-testid="endpoint-example">
									<div>
										对话请求：<code className="break-all">{ex.chat}</code>
									</div>
									<div>
										获取模型列表：<code className="break-all">GET {ex.list}</code>
									</div>
									{ex.note ? <div>{ex.note}</div> : null}
								</div>
							</Fold>
						) : null}

						{err ? (
							<p className="rounded-lg bg-danger-soft px-3 py-2 text-danger" role="alert">
								{err}
							</p>
						) : null}
						<div className="flex justify-end gap-2">
							{!editing ? (
								<Button variant="ghost" onClick={() => setStage("type")} className="mr-auto">
									上一步
								</Button>
							) : null}
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								取消
							</Button>
							<Button variant="primary" disabled={busy || !canNext} onClick={() => void submit()} data-testid="provider-save">
								{busy ? "保存中…" : editing ? "保存" : "创建并检查"}
							</Button>
						</div>
					</div>
				) : null}

				{stage === "models" && created ? <CheckStep key={created.id} provider={created} base={base} personal={personal} onDone={() => (onOpenChange(false), onSaved())} /> : null}
			</DialogContent>
		</Dialog>
	);
}

const NON_CHAT = /(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|rerank)/i;

/** Step 3: run the connection test, list the fetched models and let the admin choose which ones members may use. */
function CheckStep({ provider, base, personal, onDone }: { provider: ModelProviderDTO; base: string; personal?: boolean; onDone: () => void }) {
	const [test, setTest] = useState<ProviderTestResponse | { error: string } | "running">("running");
	const [models, setModels] = useState<AdminModelDTO[] | "loading" | { error: string }>("loading");
	const [on, setOn] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const runTest = async () => {
		setTest("running");
		try {
			setTest(await post<ProviderTestResponse>(`${base}/${provider.id}/test`, {}));
		} catch (e) {
			setTest({ error: errorText(e) });
		}
	};
	const loadModels = async () => {
		setModels("loading");
		try {
			const r = await get<{ models: AdminModelDTO[] }>(`${base}/${provider.id}/models`);
			setModels(r.models);
			setOn(new Set(r.models.filter((m) => m.enabled).map((m) => m.modelId)));
		} catch (e) {
			setModels({ error: errorText(e) });
		}
	};
	useEffect(() => {
		void runTest();
		void loadModels();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const list = Array.isArray(models) ? models : [];
	const chat = list.filter((m) => !m.nonChat && !NON_CHAT.test(m.modelId));
	const initial = new Set(list.filter((m) => m.enabled).map((m) => m.modelId));
	const finish = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			const toOn = [...on].filter((id) => !initial.has(id));
			const toOff = [...initial].filter((id) => !on.has(id));
			if (toOn.length) await patch(`${base}/${provider.id}/models`, { modelIds: toOn, enabled: true });
			if (toOff.length) await patch(`${base}/${provider.id}/models`, { modelIds: toOff, enabled: false });
			onDone();
		} catch (e) {
			setErr(errorText(e));
			setBusy(false);
		}
	};
	const toggle = (id: string) => setOn((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
	const ok = test !== "running" && !("error" in test) && test.ok;
	return (
		<div className="space-y-4 text-sm" data-testid="provider-step-models">
			<p className="flex items-center gap-1.5 font-medium">
				<Check aria-hidden className="size-4 text-success" />
				已创建「{provider.name}」
			</p>
			<section aria-label="连接测试" data-testid="provider-check">
				<h4 className="mb-1.5 text-sm font-medium">连接测试</h4>
				{test === "running" ? (
					<p className="flex items-center gap-2 text-fg-muted">
						<Spinner /> 正在测试…
					</p>
				) : "error" in test ? (
					<p className="flex items-start gap-1.5 text-danger" role="alert">
						<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
						测试没有通过：{test.error}
					</p>
				) : (
					<ul className="space-y-1" data-testid="provider-test-result">
						<li className={cn("flex items-start gap-1.5", test.list.ok ? "text-success" : "text-danger")}>
							{test.list.ok ? <Check aria-hidden className="mt-0.5 size-4 shrink-0" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
							{test.list.skipped ? "该服务不提供模型列表，已跳过" : test.list.ok ? `能获取模型列表（${test.list.count} 个）` : `获取模型列表失败：${test.list.detail ?? ""}`}
						</li>
						<li className={cn("flex items-start gap-1.5", test.completion.ok ? "text-success" : "text-danger")}>
							{test.completion.ok ? <Check aria-hidden className="mt-0.5 size-4 shrink-0" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
							{test.completion.ok ? `能正常对话（${test.completion.latencyMs} 毫秒）` : `试聊失败：${test.completion.detail ?? ""}`}
						</li>
					</ul>
				)}
				{test !== "running" && !ok ? (
					<Button size="sm" className="mt-2" onClick={() => void runTest()}>
						重新测试
					</Button>
				) : null}
			</section>
			<section aria-label="选择模型">
				<div className="mb-1.5 flex items-center gap-2">
					<h4 className="flex-1 text-sm font-medium">{personal ? "要使用的模型" : "对成员开放的模型"}</h4>
					{chat.length > 0 ? (
						<button type="button" className="text-xs text-info hover:underline" onClick={() => setOn(new Set(chat.map((m) => m.modelId)))}>
							全选对话模型
						</button>
					) : null}
				</div>
				{models === "loading" ? (
					<p className="flex items-center gap-2 text-fg-muted">
						<Spinner /> 正在读取…
					</p>
				) : !Array.isArray(models) ? (
					<p className="text-danger" role="alert">
						读取模型失败：{models.error}
					</p>
				) : list.length === 0 ? (
					<p className="rounded-lg border border-dashed border-border px-3 py-3 text-fg-muted">没有获取到模型</p>
				) : (
					<ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border" data-testid="provider-model-pick">
						{list.map((m) => (
							<li key={m.modelId}>
								<label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-2/60">
									<input type="checkbox" className="size-4 accent-[var(--accent)]" checked={on.has(m.modelId)} onChange={() => toggle(m.modelId)} />
									<span className="min-w-0 flex-1 truncate">{m.name}</span>
									{m.nonChat || NON_CHAT.test(m.modelId) ? <span className="text-xs text-fg-muted">可能不是对话模型</span> : null}
								</label>
							</li>
						))}
					</ul>
				)}
			</section>
			{err ? (
				<p className="rounded-lg bg-danger-soft px-3 py-2 text-danger" role="alert">
					{err}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button variant="primary" disabled={busy || models === "loading"} onClick={() => void finish()} data-testid="provider-done">
					{busy ? "保存中…" : on.size ? `完成（开放 ${on.size} 个）` : "完成"}
				</Button>
			</div>
		</div>
	);
}
