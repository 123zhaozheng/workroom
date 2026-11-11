// Assistant identities (M03-A): name, avatar, description, instructions, default model, tools, knowledge and team
// members — stored apart from any conversation (A: /api/assistants). A conversation only references one.
import { Check, ChevronDown, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { AssistantDTO, MemberDeclaration } from "@shared/chat";
import type { KbSummary } from "@shared/knowledge";
import type { PlatformModelDTO } from "@shared/ops";
import { del, errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { Badge, Loadable } from "@/components/ui/misc";
import { listOf } from "@/features/chat/pickers";
import { useViewerPerms } from "@/features/admin/rbac-ui";

type Assistant = AssistantDTO & { modelAvailability?: { status: "ok" | "not_allowed" | "blocked"; reason?: string } };

export function AssistantAvatarMark({ a, size = 28 }: { a?: Pick<AssistantDTO, "avatar" | "name">; size?: number }) {
	const ch = a?.avatar && [...a.avatar].length <= 2 ? a.avatar : (a?.name ?? "助").slice(0, 1);
	return (
		<span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-[13px]" style={{ width: size, height: size }}>
			{ch}
		</span>
	);
}

const MODEL_STATE = { ok: null, not_allowed: "默认模型不在你可用的列表中，将改用平台默认模型", blocked: "默认模型当前不可用（未配置凭据），将改用平台默认模型" } as const;

/** Settings → 助手: list, create, edit, delete. */
export function AssistantsSection() {
	const res = useApi<{ assistants: Assistant[] }>("/assistants");
	const modelList = useApi<{ models: PlatformModelDTO[] }>("/models");
	const modelName = (m: { provider: string; modelId: string }) => modelList.data?.models.find((x) => x.ref.provider === m.provider && x.ref.modelId === m.modelId)?.label ?? m.modelId;
	const perms = useViewerPerms();
	const [editing, setEditing] = useState<Assistant | "new" | null>(null);
	const [err, setErr] = useState<string>();
	return (
		<section className="mb-8" data-testid="assistants">
			<div className="mb-2 flex items-center">
				<h2 className="flex-1 text-sm font-medium text-fg-muted">助手</h2>
				<Button size="sm" onClick={() => setEditing("new")} disabled={res.unavailable} data-testid="assistant-new">
					<Plus />
					新建助手
				</Button>
			</div>
			<Loadable state={res} what="助手" need="A 组：GET /api/assistants">
				{err ? <p className="mb-2 text-[13px] text-danger">{err}</p> : null}
				<div className="divide-y divide-border rounded-xl border border-border bg-surface">
					{(res.data?.assistants ?? []).map((a) => (
						<div key={a.id} data-testid="assistant" className="flex flex-wrap items-start gap-3 px-4 py-3">
							<AssistantAvatarMark a={a} size={32} />
							<div className="min-w-0 flex-1 text-[13px]">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{a.name}</span>
									{a.builtin ? <Badge>内置</Badge> : <Badge>{a.scope === "org" ? "企业" : "个人"}</Badge>}
									{a.modelAvailability && a.modelAvailability.status !== "ok" ? <Badge tone="warning" title={a.modelAvailability.reason}>{MODEL_STATE[a.modelAvailability.status]}</Badge> : null}
								</div>
								{a.description ? <p className="mt-0.5 text-fg-muted">{a.description}</p> : null}
								<p className="mt-0.5 text-xs text-fg-subtle">
									模型：{a.model ? modelName(a.model) : "平台默认"} · 工具：<span title={a.tools?.join("、")}>{a.tools?.length ? `${a.tools.length} 个` : "默认"}</span> · 知识库：{a.knowledge?.kbIds.length ?? 0} 个 · 团队成员：
									{a.members.length ? a.members.map((m) => m.name).join("、") : "无"}
								</p>
							</div>
							{!a.builtin && (a.scope !== "org" || perms.org.has("assistant.publish.org")) ? (
								<div className="flex gap-1">
									<Button size="icon" variant="ghost" aria-label="编辑" onClick={() => setEditing(a)}>
										<Pencil />
									</Button>
									<Button
										size="icon"
										variant="ghost"
										aria-label="删除"
										onClick={async () => {
											if (!confirm(`删除助手「${a.name}」？已有对话不受影响。`)) return;
											try {
												await del(`/assistants/${a.id}`);
												res.reload();
											} catch (e) {
												setErr(errorText(e));
											}
										}}
									>
										<Trash2 />
									</Button>
								</div>
							) : null}
						</div>
					))}
				</div>
			</Loadable>
			{editing ? (
				<AssistantEditor
					initial={editing === "new" ? undefined : editing}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null);
						res.reload();
					}}
				/>
			) : null}
		</section>
	);
}

const TOOL_GROUPS = ["file_create", "file_revise", "file_read", "kb_search", "sandbox_exec", "browse", "job_start", "delegate", "memory_save"];

function AssistantEditor({ initial, onClose, onSaved }: { initial?: Assistant; onClose: () => void; onSaved: () => void }) {
	const models = useApi<{ models: PlatformModelDTO[] }>("/models");
	const kbs = useApi<unknown>("/kb");
	const kbList = listOf<KbSummary>(kbs.data, "kbs");
	const [name, setName] = useState(initial?.name ?? "");
	const [avatar, setAvatar] = useState(initial?.avatar ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [instructions, setInstructions] = useState(initial?.instructions ?? "");
	const [model, setModel] = useState(initial?.model ? `${initial.model.provider}/${initial.model.modelId}` : "");
	const [tools, setTools] = useState<string[] | null>(initial?.tools ? [...initial.tools] : null);
	const [kbIds, setKbIds] = useState<string[]>(initial?.knowledge?.kbIds ? [...initial.knowledge.kbIds] : []);
	const [members, setMembers] = useState<MemberDeclaration[]>(initial?.members ? [...initial.members] : []);
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const save = async () => {
		setBusy(true);
		setErr(undefined);
		const m = (models.data?.models ?? []).find((x) => `${x.ref.provider}/${x.ref.modelId}` === model);
		const body = {
			name,
			avatar: avatar || null,
			description,
			instructions: instructions || null,
			model: m ? { provider: m.ref.provider, modelId: m.ref.modelId } : null,
			tools,
			knowledge: { kbIds },
			members,
		};
		try {
			if (initial) await patch(`/assistants/${initial.id}`, body);
			else await post("/assistants", body);
			onSaved();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title={initial ? "编辑助手" : "新建助手"} description="助手的身份与配置独立于对话；对话只引用它。" className="max-w-xl">
				<div className="wr-scroll -mx-1 max-h-[70vh] space-y-3 overflow-y-auto px-1 text-[13px]" data-testid="assistant-editor">
					<div className="grid grid-cols-[72px_1fr] gap-3">
						<div>
							<Label htmlFor="aav">头像</Label>
							<Input id="aav" value={avatar} maxLength={2} onChange={(e) => setAvatar(e.target.value)} placeholder="字" className="text-center" />
						</div>
						<div>
							<Label htmlFor="anm">名称</Label>
							<Input id="anm" value={name} onChange={(e) => setName(e.target.value)} />
						</div>
					</div>
					<div>
						<Label htmlFor="ads">说明</Label>
						<Input id="ads" value={description} onChange={(e) => setDescription(e.target.value)} />
					</div>
					<div>
						<Label htmlFor="ains">指令</Label>
						<Textarea id="ains" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
					</div>
					<div>
						<Label htmlFor="amd">默认模型</Label>
						<Select id="amd" value={model} onChange={(e) => setModel(e.target.value)} className="w-full">
							<option value="">平台默认</option>
							{(models.data?.models ?? []).map((m) => (
								<option key={m.id} value={`${m.ref.provider}/${m.ref.modelId}`} disabled={m.status === "blocked"}>
									{m.fixture ? "测试模型（非真实 AI）" : m.label}
									{m.status === "blocked" ? `（不可用：${m.statusDetail ?? "未配置凭据"}）` : ""}
								</option>
							))}
						</Select>
					</div>
					<div>
						<Label>可用工具</Label>
						<label className="mb-1 flex items-center gap-1.5">
							<input type="checkbox" checked={tools === null} onChange={(e) => setTools(e.target.checked ? null : [])} />
							使用默认工具集
						</label>
						{tools !== null ? (
							<div className="flex flex-wrap gap-x-3 gap-y-1">
								{TOOL_GROUPS.map((t) => (
									<label key={t} className="flex items-center gap-1 font-mono text-xs">
										<input type="checkbox" checked={tools.includes(t)} onChange={(e) => setTools((x) => (e.target.checked ? [...(x ?? []), t] : (x ?? []).filter((y) => y !== t)))} />
										{t}
									</label>
								))}
							</div>
						) : null}
					</div>
					<div>
						<Label>知识库</Label>
						<div className="flex flex-wrap gap-x-3 gap-y-1">
							{kbList.length === 0 ? <span className="text-fg-subtle">没有可选的知识库</span> : null}
							{kbList.map((k) => (
								<label key={k.id} className="flex items-center gap-1">
									<input type="checkbox" checked={kbIds.includes(k.id)} onChange={(e) => setKbIds((x) => (e.target.checked ? [...x, k.id] : x.filter((y) => y !== k.id)))} />
									{k.name}
								</label>
							))}
						</div>
					</div>
					<div>
						<Label>团队成员（子 Agent，工具需显式列出，不继承）</Label>
						{members.map((m, i) => (
							<div key={i} className="mb-1 flex flex-wrap items-center gap-2">
								<Input value={m.name} onChange={(e) => setMembers((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} className="h-8 w-32 text-[13px]" aria-label="成员名称" />
								<Input value={m.tools.join(",")} onChange={(e) => setMembers((x) => x.map((y, j) => (j === i ? { ...y, tools: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : y)))} className="h-8 flex-1 font-mono text-xs" placeholder="工具，逗号分隔" aria-label="成员工具" />
								<Input type="number" min={1} max={50} value={m.maxTurns} onChange={(e) => setMembers((x) => x.map((y, j) => (j === i ? { ...y, maxTurns: Math.max(1, Number(e.target.value) || 1) } : y)))} className="h-8 w-20 text-[13px]" aria-label="最多轮数" />
								<Button size="icon-sm" variant="ghost" aria-label="移除成员" onClick={() => setMembers((x) => x.filter((_, j) => j !== i))}>
									<Trash2 />
								</Button>
							</div>
						))}
						<Button size="sm" variant="ghost" onClick={() => setMembers((x) => [...x, { id: `m${x.length + 1}`, name: `成员 ${x.length + 1}`, type: "builtin_subagent", tools: [], maxTurns: 4 }])}>
							<Plus />
							添加成员
						</Button>
					</div>
					{err ? <p className="text-danger">{err}</p> : null}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" onClick={save} disabled={busy || !name.trim()} data-testid="assistant-save">
						保存
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Home composer: choose which assistant a new conversation starts with. */
export function AssistantPicker({ value, onChange }: { value?: string; onChange: (id: string | undefined) => void }) {
	const res = useApi<{ assistants: Assistant[] }>("/assistants");
	const list = res.data?.assistants ?? [];
	useEffect(() => {
		if (value && list.length && !list.some((a) => a.id === value)) onChange(undefined);
	}, [value, list, onChange]);
	if (res.unavailable || res.error || list.length < 2) return null;
	const cur = list.find((a) => a.id === value) ?? list.find((a) => a.builtin) ?? list[0]!;
	return (
		<Menu>
			<MenuTrigger asChild>
				<button data-testid="assistant-picker" className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg">
					<UserRound className="size-3" />
					{cur.name}
					<ChevronDown className="size-3" />
				</button>
			</MenuTrigger>
			<MenuContent side="top" align="start" className="w-64">
				<MenuLabel>助手</MenuLabel>
				{list.map((a) => (
					<MenuItem key={a.id} onSelect={() => onChange(a.builtin ? undefined : a.id)} className="items-start">
						<Check className={cn("mt-0.5", a.id === cur.id ? "opacity-100" : "opacity-0")} />
						<span className="min-w-0 flex-1">
							<span className="block truncate">{a.name}</span>
							{a.description ? <span className="block truncate text-xs text-fg-subtle">{a.description}</span> : null}
						</span>
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}
