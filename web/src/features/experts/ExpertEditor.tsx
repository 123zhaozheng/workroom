// 专家 create / edit form: name, avatar, one-line intro, details, category + tags, system instructions, opening line + starters,
// default model (empty = follow the conversation), mounted skills (references by id: always their current published version),
// optional knowledge bases and tool allowlist. Saving never publishes: sharing goes through 提交审查.
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { defaultAvatarConfig, type AvatarConfig } from "@shared/bot-avatar/config";
import type { ExpertDTO } from "@shared/experts";
import type { KbSummary } from "@shared/knowledge";
import type { SkillListResponse } from "@shared/files";
import { errorText, patch, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { listOf } from "@/features/chat/pickers";
import { modelName, useModels } from "@/features/composer/models";
import { EXPERT_CATEGORIES } from "./common";
import { AvatarPicker } from "./AvatarPicker";

const TOOL_GROUPS = ["file_create", "file_revise", "file_read", "kb_search", "sandbox_exec", "browse", "job_start", "memory_save"];

export function ExpertEditor({ initial, onClose, onSaved }: { initial?: ExpertDTO; onClose: () => void; onSaved: (e: ExpertDTO) => void }) {
	const { models } = useModels();
	const skills = useApi<SkillListResponse>("/skills");
	const kbs = useApi<unknown>("/kb");
	const kbList = listOf<KbSummary>(kbs.data, "kbs");
	const [name, setName] = useState(initial?.name ?? "");
	// an existing expert edits its own look; a new one starts from a stable default of a draft id (the server picks the same way from the real id when none is sent)
	const [seed] = useState(() => initial?.id ?? `draft-${Math.random().toString(36).slice(2, 10)}`);
	const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(() => initial?.avatarConfig ?? defaultAvatarConfig(seed));
	const [tagline, setTagline] = useState(initial?.tagline ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [category, setCategory] = useState(initial?.category ?? "通用");
	const [tags, setTags] = useState(initial?.tags.join("、") ?? "");
	const [instructions, setInstructions] = useState(initial?.instructions ?? "");
	const [opening, setOpening] = useState(initial?.opening ?? "");
	const [starters, setStarters] = useState<string[]>(initial?.starters.length ? [...initial.starters] : [""]);
	const [model, setModel] = useState(initial?.defaultModel ? `${initial.defaultModel.provider}/${initial.defaultModel.modelId}` : "");
	const [skillIds, setSkillIds] = useState<string[]>(initial?.skills.map((s) => s.skillId) ?? []);
	const [kbIds, setKbIds] = useState<string[]>(initial?.knowledge?.kbIds ? [...initial.knowledge.kbIds] : []);
	const [tools, setTools] = useState<string[] | null>(initial?.tools ? [...initial.tools] : null);
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const mySkills = skills.data?.skills ?? [];
	// a mounted skill the list no longer offers (removed, no longer usable) stays visible so it can be removed deliberately
	const known = new Map(mySkills.map((s) => [s.id, s.name]));
	const legacy = !!initial && initial.source === "assistant";

	const save = async () => {
		setBusy(true);
		setErr(undefined);
		const m = models.find((x) => x.ref && `${x.ref.provider}/${x.ref.modelId}` === model);
		const body = {
			name,
			avatarConfig,
			tagline,
			description,
			category,
			tags: tags.split(/[、,，\s]+/).filter(Boolean),
			instructions,
			opening,
			starters: starters.map((s) => s.trim()).filter(Boolean),
			defaultModel: m?.ref ? { provider: m.ref.provider, modelId: m.ref.modelId } : null,
			skills: skillIds.map((skillId) => ({ skillId })),
			knowledge: { kbIds },
			tools,
		};
		try {
			const r = initial ? await patch<{ expert: ExpertDTO }>(`/experts/${initial.id}`, body) : await post<{ expert: ExpertDTO }>("/experts", body);
			onSaved(r.expert);
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent title={initial ? "编辑专家" : "创建专家"} className="max-w-2xl">
				<div className="wr-scroll -mx-1 max-h-[72vh] space-y-4 overflow-y-auto px-1 text-sm" data-testid="expert-editor">
					{legacy ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">这是由旧助手迁移来的专家，请在「设置 → 助手」里修改。</p> : null}
					<div>
						<Label htmlFor="exnm">名称</Label>
						<Input id="exnm" data-testid="expert-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="例如：周报专家" />
					</div>
					<div>
						<Label>头像</Label>
						<AvatarPicker value={avatarConfig} onChange={setAvatarConfig} seed={seed} />
					</div>
					<div>
						<Label htmlFor="extg">一句话简介</Label>
						<Input id="extg" data-testid="expert-tagline" value={tagline} maxLength={80} onChange={(e) => setTagline(e.target.value)} placeholder="显示在专家卡片上" />
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="excat">分类</Label>
							<Select id="excat" className="w-full" value={category} onChange={(e) => setCategory(e.target.value)}>
								{[...new Set([...EXPERT_CATEGORIES, category])].map((c) => (
									<option key={c}>{c}</option>
								))}
							</Select>
						</div>
						<div>
							<Label htmlFor="extags">标签</Label>
							<Input id="extags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="用顿号分隔，最多 8 个" />
						</div>
					</div>
					<div>
						<Label htmlFor="exds">详细说明</Label>
						<Textarea id="exds" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="擅长什么、不做什么" />
					</div>
					<div>
						<Label htmlFor="exins">系统指令</Label>
						<Textarea id="exins" data-testid="expert-instructions" rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="角色设定、工作方式、输出格式" />
					</div>
					<div>
						<Label htmlFor="exop">开场白</Label>
						<Input id="exop" value={opening} maxLength={500} onChange={(e) => setOpening(e.target.value)} placeholder="选择专家后显示的第一句话" />
					</div>
					<div>
						<Label>示例问题</Label>
						<div className="space-y-1.5">
							{starters.map((s, i) => (
								<div key={i} className="flex items-center gap-1.5">
									<Input value={s} maxLength={80} onChange={(e) => setStarters((x) => x.map((y, j) => (j === i ? e.target.value : y)))} aria-label={`示例问题 ${i + 1}`} />
									<Button size="icon-sm" variant="ghost" aria-label="移除示例问题" onClick={() => setStarters((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [""]))}>
										<X />
									</Button>
								</div>
							))}
							{starters.length < 6 ? (
								<Button size="sm" variant="ghost" onClick={() => setStarters((x) => [...x, ""])}>
									<Plus />
									添加
								</Button>
							) : null}
						</div>
					</div>
					<div>
						<Label htmlFor="exmd">默认模型</Label>
						<Select id="exmd" data-testid="expert-model" className="w-full" value={model} onChange={(e) => setModel(e.target.value)}>
							<option value="">跟随会话</option>
							{models.map((m) => (
								<option key={m.id} value={m.ref ? `${m.ref.provider}/${m.ref.modelId}` : m.id} disabled={m.status === "blocked"}>
									{modelName(m)}
									{m.status === "blocked" ? `（不可用）` : ""}
								</option>
							))}
						</Select>
						<p className="mt-1 text-xs text-fg-subtle">会话里自己选过模型时，以你的选择为准。</p>
					</div>
					<div>
						<Label>挂载的技能</Label>
						<div className="flex flex-wrap gap-1.5" data-testid="expert-skill-picker">
							{skillIds.map((id) => (
								<span key={id} className="inline-flex h-7 items-center gap-1 rounded-lg bg-surface-2 pl-2.5 pr-1 text-[13px]">
									{known.get(id) ?? initial?.skills.find((s) => s.skillId === id)?.name ?? "技能"}
									<button type="button" aria-label="移除技能" onClick={() => setSkillIds((x) => x.filter((y) => y !== id))} className="rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg">
										<X className="size-3.5" />
									</button>
								</span>
							))}
							<Select
								aria-label="添加技能"
								data-testid="expert-skill-add"
								className="h-7 w-auto text-[13px]"
								value=""
								onChange={(e) => e.target.value && setSkillIds((x) => (x.includes(e.target.value) ? x : [...x, e.target.value]))}
							>
								<option value="">＋ 添加技能</option>
								{mySkills.filter((s) => !skillIds.includes(s.id)).map((s) => (
									<option key={s.id} value={s.id}>
										{s.name}
									</option>
								))}
							</Select>
						</div>
						<p className="mt-1 text-xs text-fg-subtle">只保存引用：技能更新后，专家下一次对话自动用最新已发布的版本。</p>
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
					{err ? <p className="text-danger" role="alert">{err}</p> : null}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" onClick={save} disabled={busy || !name.trim() || legacy} data-testid="expert-save">
						保存
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
