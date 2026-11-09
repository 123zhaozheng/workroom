// Add / edit a 模型服务商: type picker with presets and examples, Base URL (with the final request address spelled out),
// API key (stored encrypted, or the NAME of an environment variable), custom headers, auth style. Keys are write-only.
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreateModelProviderRequest, ModelAuthStyle, ModelProviderDTO, ModelProviderPreset, ModelProviderType, ModelProvidersResponse, UpdateModelProviderRequest } from "@shared/ops";
import { errorText, patch, post } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { endpointExample, TYPE_LABEL } from "./shared";

interface HeaderRow {
	name: string;
	value: string;
}

const TYPES: ModelProviderType[] = ["openai-completions", "anthropic-messages", "openai-responses", "builtin"];
const AUTH_LABEL: Record<ModelAuthStyle, string> = { default: "默认（OpenAI: Authorization: Bearer；Claude: x-api-key）", bearer: "Authorization: Bearer（部分 Claude 中转要求）", "x-api-key": "x-api-key 头", "api-key": "api-key 头（Azure 风格网关）" };

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
	catalog?: Pick<ModelProvidersResponse, "presets" | "builtins">;
	onSaved: () => void;
}) {
	const editing = !!existing;
	const presets = catalog?.presets ?? [];
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
	const [headers, setHeaders] = useState<HeaderRow[]>((existing?.headerNames ?? []).map((n) => ({ name: n, value: "****" })));
	const [extraEnv, setExtraEnv] = useState<HeaderRow[]>((existing?.envKeys ?? []).map((n) => ({ name: n, value: "****" })));
	const [fetchAfter, setFetchAfter] = useState(true);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const hint = presets.find((p) => p.key === preset)?.hint;
	const ex = endpointExample(type, baseUrl);
	const builtin = catalog?.builtins?.find((b) => b.id === builtinId);

	const applyPreset = (p: ModelProviderPreset | undefined) => {
		setPreset(p?.key ?? "");
		if (!p) return;
		setType(p.type);
		setBaseUrl(p.baseUrl ?? "");
		setKeyless(!!p.keyless);
		setAuthStyle(p.authStyle ?? "default");
		if (p.builtinId) setBuiltinId(p.builtinId);
		if (!name.trim()) setName(p.label.replace(/（.*?）/g, "").replace(/\s*\(.*?\)/g, "").trim());
	};

	const submit = async () => {
		setBusy(true);
		setErr(undefined);
		try {
			const hdr = Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
			const env = Object.fromEntries(extraEnv.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
			if (editing) {
				const body: UpdateModelProviderRequest = { name, keyless, authStyle, timeoutMs: timeout ? Number(timeout) : null, headers: hdr, ...(type === "builtin" ? { env } : { baseUrl }) };
				if (clearKey) body.apiKey = null;
				else if (keyMode === "inline" && apiKey) body.apiKey = apiKey;
				if (!personal && keyMode === "env") body.apiKeyEnv = apiKeyEnv || undefined;
				await patch(`${base}/${existing!.id}`, body as never);
			} else {
				const body: CreateModelProviderRequest = { name, type, preset: preset || undefined, keyless, authStyle, ...(timeout ? { timeoutMs: Number(timeout) } : {}), ...(Object.keys(hdr).length ? { headers: hdr } : {}), ...(type === "builtin" ? { builtinId, ...(Object.keys(env).length ? { env } : {}) } : { baseUrl }), ...(keyMode === "inline" && apiKey ? { apiKey } : {}), ...(!personal && keyMode === "env" && apiKeyEnv ? { apiKeyEnv } : {}), ...(fetchAfter ? { fetchModels: true, enableFetched: !!personal } : {}) };
				await post(base, body as never);
			}
			onOpenChange(false);
			onSaved();
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
					<Input value={r.name} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={nameLabel} className="h-8 w-40 text-[13px]" />
					<Input value={r.value} type="password" onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={ph} className="h-8 flex-1 text-[13px]" autoComplete="off" />
					<Button size="icon-sm" variant="ghost" aria-label="删除" onClick={() => set(rows.filter((_, j) => j !== i))}>
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

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={editing ? `编辑服务商：${existing!.name}` : personal ? "添加我的服务商（个人自带密钥）" : "添加模型服务商"} description="每个服务商就是一个 pi-ai provider；密钥只写入、加密保存在服务端，不会再显示。" className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="provider-dialog">
				<div className="space-y-4 text-[13px]">
					{!editing ? (
						<div>
							<Label>快速选择（可选）</Label>
							<Select value={preset} onChange={(e) => applyPreset(presets.find((p) => p.key === e.target.value))} className="w-full" data-testid="provider-preset">
								<option value="">自定义…</option>
								{presets.map((p) => (
									<option key={p.key} value={p.key}>
										{p.label}
									</option>
								))}
							</Select>
							{hint ? <p className="mt-1 text-xs text-fg-subtle">{hint}</p> : null}
						</div>
					) : null}

					<div>
						<Label>名称</Label>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：DeepSeek 官方" data-testid="provider-name" />
					</div>

					<div>
						<Label>类型（决定请求协议）</Label>
						<div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="类型">
							{TYPES.filter((t) => !personal || t !== "builtin").map((t) => (
								<label key={t} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 ${type === t ? "border-accent bg-accent-soft" : "border-border"} ${editing ? "opacity-60" : ""}`}>
									<input type="radio" name="ptype" checked={type === t} disabled={editing} onChange={() => setType(t)} className="mt-0.5" />
									<span>
										<span className="block font-medium">{TYPE_LABEL[t]}</span>
										<span className="block text-xs text-fg-subtle">{t === "openai-completions" ? "DeepSeek、通义千问、Kimi、智谱、OpenRouter、硅基流动、Ollama/vLLM/LM Studio…" : t === "anthropic-messages" ? "Anthropic 官方，及 Claude 兼容中转站" : t === "openai-responses" ? "OpenAI 官方 Responses API" : "Azure OpenAI、Bedrock、Google、Mistral… 每个部署只能配一个"}</span>
									</span>
								</label>
							))}
						</div>
					</div>

					{type === "builtin" ? (
						<>
							<div>
								<Label>pi-ai 内置 provider</Label>
								<Select value={builtinId} disabled={editing} onChange={(e) => setBuiltinId(e.target.value)} className="w-full" data-testid="provider-builtin">
									<option value="">选择…</option>
									{(catalog?.builtins ?? []).map((b) => (
										<option key={b.id} value={b.id} disabled={b.configured && !editing}>
											{b.name}（{b.id}，{b.models} 个内置模型{b.configured ? "，已配置" : ""}）
										</option>
									))}
								</Select>
								{builtin ? <p className="mt-1 text-xs text-fg-subtle">pi-ai 自带模型目录与鉴权方式；密钥写在下面，区域/资源等写在“额外配置”（例如 Azure：AZURE_OPENAI_BASE_URL 或 AZURE_OPENAI_RESOURCE_NAME）。</p> : null}
							</div>
							<div>
								<Label>额外配置（provider 专属的环境项，值加密保存）</Label>
								{rowEditor(extraEnv, setExtraEnv, "AZURE_OPENAI_BASE_URL", "值")}
							</div>
						</>
					) : (
						<div>
							<Label>Base URL</Label>
							<Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={type === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.deepseek.com 或 http://localhost:11434/v1"} data-testid="provider-baseurl" />
							<div className="mt-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-fg-muted" data-testid="endpoint-example">
								<div>
									对话请求：<code className="break-all">{ex.chat}</code>
								</div>
								<div>
									获取模型列表：<code className="break-all">GET {ex.list}</code>
								</div>
								{ex.note ? <div className="mt-0.5 text-fg-subtle">{ex.note}</div> : null}
							</div>
							{personal ? <p className="mt-1 text-xs text-fg-subtle">个人服务商不允许指向内网/本机地址。</p> : null}
						</div>
					)}

					<div>
						<Label>API Key</Label>
						{!personal ? (
							<div className="mb-1.5 flex gap-3 text-xs">
								<label className="flex items-center gap-1">
									<input type="radio" checked={keyMode === "inline"} onChange={() => setKeyMode("inline")} />
									直接填写（加密保存，需 WORKROOM_SECRET_KEY）
								</label>
								<label className="flex items-center gap-1">
									<input type="radio" checked={keyMode === "env"} onChange={() => setKeyMode("env")} />
									引用环境变量名（WORKROOM_ 开头）
								</label>
							</div>
						) : null}
						{keyMode === "inline" || personal ? (
							<>
								<Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" placeholder={editing && existing!.credential.kind === "stored" ? `已保存 ${existing!.credential.hint ?? ""}，留空表示不修改` : "sk-…"} disabled={clearKey || keyless} data-testid="provider-key" />
								{editing && existing!.credential.kind === "stored" ? (
									<label className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
										<input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
										清除已保存的密钥
									</label>
								) : null}
							</>
						) : (
							<Input value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} placeholder="WORKROOM_DEEPSEEK_API_KEY" />
						)}
						<label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
							<input type="checkbox" checked={keyless} onChange={(e) => setKeyless(e.target.checked)} />
							无需密钥（本地 Ollama / vLLM / LM Studio）
						</label>
					</div>

					<details className="rounded-lg border border-border px-3 py-2">
						<summary className="cursor-pointer text-[13px] font-medium text-fg-muted">高级：鉴权方式、自定义请求头、超时</summary>
						<div className="mt-3 space-y-3">
							{type !== "builtin" ? (
								<div>
									<Label>鉴权方式</Label>
									<Select value={authStyle} onChange={(e) => setAuthStyle(e.target.value as ModelAuthStyle)} className="w-full">
										{(Object.keys(AUTH_LABEL) as ModelAuthStyle[]).map((k) => (
											<option key={k} value={k}>
												{AUTH_LABEL[k]}
											</option>
										))}
									</Select>
								</div>
							) : null}
							<div>
								<Label>自定义请求头（值加密保存；编辑时显示 **** 表示保持不变）</Label>
								{rowEditor(headers, setHeaders, "Header 名", "值")}
							</div>
							<div>
								<Label>请求超时（毫秒，可选）</Label>
								<Input value={timeout} onChange={(e) => setTimeoutMs(e.target.value.replace(/\D/g, ""))} placeholder="默认由 SDK 决定" className="w-40" />
							</div>
						</div>
					</details>

					{!editing ? (
						<label className="flex items-center gap-1.5 text-xs text-fg-muted">
							<input type="checkbox" checked={fetchAfter} onChange={(e) => setFetchAfter(e.target.checked)} />
							创建后立即获取模型列表{personal ? "，并启用其中的对话模型" : ""}
						</label>
					) : null}

					{err ? (
						<p className="rounded-lg bg-danger-soft px-3 py-1.5 text-danger" role="alert">
							{err}
						</p>
					) : null}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							取消
						</Button>
						<Button variant="primary" disabled={busy || !name.trim() || (type === "builtin" ? !builtinId : !baseUrl.trim())} onClick={() => void submit()} data-testid="provider-save">
							{busy ? "保存中…" : "保存"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
