import { BookOpen, FileText, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import type { AttachmentRef, KnowledgeRef } from "@shared/chat";
import type { FileListResponse } from "@shared/files";
import type { KbSummary } from "@shared/knowledge";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { formatBytes, relTime } from "@/lib/utils";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { FileThumb } from "@/components/file/FileTile";

/** Tolerant list extraction: `{ kbs: [...] }`, `{ knowledgeBases: [...] }`, `{ items: [...] }` or a bare array. */
export function listOf<T>(data: unknown, ...keys: string[]): T[] {
	if (Array.isArray(data)) return data as T[];
	if (data && typeof data === "object") for (const k of [...keys, "items"]) if (Array.isArray((data as Record<string, unknown>)[k])) return (data as Record<string, T[]>)[k]!;
	return [];
}

export function FilePickerDialog({ open, onOpenChange, onPick, spaceId, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (r: AttachmentRef, meta?: { size?: number; mime?: string; versionNo?: number }) => void; spaceId?: string; projectId?: string }) {
	const [q, setQ] = useState("");
	const files = useApi<FileListResponse>(open ? `/files${qs({ q, projectId, spaceId: projectId ? undefined : spaceId })}` : null);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="从文件库选择" className="max-w-lg">
				<div className="relative mb-3">
					<Search aria-hidden className="absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
					<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名" aria-label="搜索文件名" className="pl-8" autoFocus />
				</div>
				<div className="wr-scroll max-h-[50vh] overflow-y-auto">
					<Loadable state={files} what="文件库" need="GET /api/files">
						{(files.data?.files ?? []).length === 0 ? (
							<EmptyState icon={<FileText />} title={q ? "没有匹配的文件" : "文件库里还没有文件"} />
						) : (
							files.data!.files.map((f) => (
								<button
									key={f.id}
									type="button"
									onClick={() => {
										onPick({ fileId: f.id, versionId: f.latestVersionId, name: f.name }, { size: f.size, mime: f.mime, versionNo: f.latestVersionNo });
										onOpenChange(false);
									}}
									className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<FileThumb name={f.name} mime={f.mime} size={36} />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{f.name}</span>
										<span className="block text-xs text-fg-subtle">
											{formatBytes(f.size)} · {relTime(f.updatedAt)}
										</span>
									</span>
								</button>
							))
						)}
					</Loadable>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function KbPickerDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (r: KnowledgeRef) => void }) {
	const kbs = useApi<unknown>(open ? "/kb" : null);
	const list = listOf<KbSummary>(kbs.data, "kbs", "knowledgeBases");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="引用知识库" className="max-w-lg">
				<div className="wr-scroll max-h-[50vh] overflow-y-auto">
					<Loadable state={kbs} what="知识库" need="GET /api/kb">
						{list.length === 0 ? (
							<EmptyState icon={<BookOpen />} title="还没有知识库" />
						) : (
							list.map((k) => (
								<button
									key={k.id}
									onClick={() => {
										onPick({ kbId: k.id, name: k.name });
										onOpenChange(false);
									}}
									className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<BookOpen className="size-4 shrink-0 text-fg-muted" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{k.name}</span>
										<span className="block text-xs text-fg-subtle">
											{k.stats.ready} 份可检索{k.stats.processing ? ` · ${k.stats.processing} 份处理中` : ""}
											{k.stats.failed ? ` · ${k.stats.failed} 份失败` : ""}
										</span>
									</span>
									{k.stats.ready === 0 ? <Badge tone="warning">暂无可检索资料</Badge> : null}
								</button>
							))
						)}
					</Loadable>
				</div>
			</DialogContent>
		</Dialog>
	);
}

export interface SkillOption {
	id: string;
	name: string;
	kind?: string;
}
/** Installed + enabled skills of the current user (GET /skills). */
export function useUsableSkills(): SkillOption[] {
	const res = useApi<{ skills?: { id: string; name: string; kind?: string; status?: string; install?: { enabled: boolean } }[] }>("/skills");
	return (res.data?.skills ?? []).filter((s) => s.status !== "archived" && s.install?.enabled).map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
}

export function SkillPickerDialog({ open, onOpenChange, skills, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; skills: SkillOption[]; onPick: (s: SkillOption) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="使用技能" className="max-w-md">
				<div className="wr-scroll max-h-[50vh] overflow-y-auto">
					{skills.length === 0 ? <EmptyState icon={<Sparkles />} title="没有可用的技能" /> : null}
					{skills.map((s) => (
						<button
							key={s.id}
							data-testid="skill-option"
							onClick={() => {
								onPick(s);
								onOpenChange(false);
							}}
							className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Sparkles className="size-4 shrink-0 text-fg-muted" />
							<span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
						</button>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
