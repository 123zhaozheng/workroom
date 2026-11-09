import { Bot, Eye, FolderOpen, Search, Upload, Workflow } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { FileListResponse, FileOrigin, FileUploadResponse } from "@shared/files";
import { errorText, post, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { TopBar } from "@/components/shell/AppShell";
import { usePanel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, EmptyState, Loadable, Page, PageHeader } from "@/components/ui/misc";
import { fileIcon } from "@/features/chat/Cards";

export const ORIGIN: Record<FileOrigin, { label: string; icon?: typeof Bot }> = {
	upload: { label: "上传" },
	agent: { label: "助手生成", icon: Bot },
	automation: { label: "自动化", icon: Workflow },
};

export default function FilesPage() {
	const { personalSpaceId } = useSession();
	const [sp, setSp] = useSearchParams();
	const projectId = sp.get("projectId") ?? "";
	const [q, setQ] = useState("");
	const [origin, setOrigin] = useState<"" | FileOrigin>("");
	const files = useApi<FileListResponse>(`/files${qs({ q, origin, projectId })}`);
	const projects = useApi<{ projects: Project[] }>("/projects");
	const { openPreview } = usePanel();
	const input = useRef<HTMLInputElement>(null);
	const [upErr, setUpErr] = useState<string>();
	const [uploading, setUploading] = useState(false);

	const upload = async (list: FileList | null) => {
		if (!list?.length) return;
		setUploading(true);
		setUpErr(undefined);
		try {
			for (const f of Array.from(list)) {
				const fd = new FormData();
				fd.set("file", f);
				if (projectId) fd.set("projectId", projectId);
				else if (personalSpaceId) fd.set("spaceId", personalSpaceId);
				await post<FileUploadResponse>("/files", fd);
			}
			files.reload();
		} catch (e) {
			setUpErr(errorText(e));
		} finally {
			setUploading(false);
			if (input.current) input.current.value = "";
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page wide>
					<PageHeader
						title="文件库"
						description="上传的资料和助手交付的成果都在这里。每次修改都会保留旧版本，可以追溯来源。"
						actions={
							<>
								<input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
								<Button variant="primary" onClick={() => input.current?.click()} disabled={uploading}>
									<Upload />
									{uploading ? "上传中…" : "上传文件"}
								</Button>
							</>
						}
					/>
					<div className="mb-4 flex flex-wrap items-center gap-2">
						<div className="relative min-w-[200px] flex-1">
							<Search className="absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
							<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索文件名" className="pl-8" />
						</div>
						<Select value={projectId} onChange={(e) => setSp(e.target.value ? { projectId: e.target.value } : {})} aria-label="空间">
							<option value="">全部空间</option>
							{(projects.data?.projects ?? []).map((p) => (
								<option key={p.id} value={p.id}>
									项目：{p.name}
								</option>
							))}
						</Select>
						<Select value={origin} onChange={(e) => setOrigin(e.target.value as FileOrigin | "")} aria-label="来源">
							<option value="">全部来源</option>
							<option value="upload">上传</option>
							<option value="agent">助手生成</option>
							<option value="automation">自动化</option>
						</Select>
					</div>
					{upErr ? <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{upErr}</p> : null}
					<Loadable state={files} what="文件库" need="D 组：GET /api/files">
						{(files.data?.files ?? []).length === 0 ? (
							<EmptyState icon={<FolderOpen />} title={q ? "没有匹配的文件" : "文件库还是空的"}>
								上传资料，或让助手生成文档、表格、演示稿，成果会自动出现在这里。
							</EmptyState>
						) : (
							<div className="overflow-hidden rounded-xl border border-border bg-surface">
								{files.data!.files.map((f, i) => {
									const Icon = fileIcon(f.name, f.mime);
									const o = ORIGIN[f.origin];
									return (
										<div key={f.id} data-testid="file-row" className={cn("group flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2/60", i > 0 && "border-t border-border")}>
											<Icon className="size-[18px] shrink-0 text-fg-muted" />
											<Link to={`/files/${f.id}`} className="min-w-0 flex-1">
												<span className="block truncate text-sm font-medium">{f.name}</span>
												<span className="block truncate text-xs text-fg-subtle">
													v{f.latestVersionNo} · {formatBytes(f.size)} · {relTime(f.updatedAt)} · {f.spaceKind === "project" ? "项目" : "个人"}
												</span>
											</Link>
											<Badge>
												{o.icon ? <o.icon /> : null}
												{o.label}
											</Badge>
											{f.latestVersionNo > 1 ? <Badge tone="info">{f.latestVersionNo} 个版本</Badge> : null}
											<button
												onClick={() => openPreview({ fileId: f.id, versionId: f.latestVersionId, name: f.name, mime: f.mime })}
												className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
												aria-label={`预览 ${f.name}`}
											>
												<Eye className="size-4" />
											</button>
										</div>
									);
								})}
							</div>
						)}
					</Loadable>
				</Page>
			</div>
		</div>
	);
}
