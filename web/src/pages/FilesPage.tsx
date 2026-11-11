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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, Page, PageHeader } from "@/components/ui/misc";
import { LoadState } from "@/features/work/states";
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
						<div className="relative min-w-[200px] flex-1 basis-full sm:basis-0">
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
					{upErr ? <p role="alert" className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">上传失败：{upErr}</p> : null}
					<LoadState state={files} what="文件库">
						{(files.data?.files ?? []).length === 0 ? (
							<EmptyState icon={<FolderOpen />} title={q ? "没有匹配的文件" : "文件库还是空的"} />
						) : (
							<div className="overflow-hidden rounded-xl border border-border bg-surface">
								{files.data!.files.map((f, i) => {
									const Icon = fileIcon(f.name, f.mime);
									const o = ORIGIN[f.origin];
									return (
										<div key={f.id} data-testid="file-row" className={cn("flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2/60", i > 0 && "border-t border-border")}>
											<Icon className="size-[18px] shrink-0 text-fg-muted" />
											<Link to={`/files/${f.id}`} className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
												<span className="block truncate text-sm font-medium">{f.name}</span>
												<span className="block truncate text-xs text-fg-muted">
													{o.label} · v{f.latestVersionNo} · {formatBytes(f.size)} · {relTime(f.updatedAt)}
													{f.spaceKind === "project" ? " · 项目" : ""}
												</span>
											</Link>
											<button
												onClick={() => openPreview({ fileId: f.id, versionId: f.latestVersionId, name: f.name, mime: f.mime })}
												className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												aria-label={`预览 ${f.name}`}
											>
												<Eye className="size-4" />
											</button>
										</div>
									);
								})}
							</div>
						)}
					</LoadState>
				</Page>
			</div>
		</div>
	);
}
