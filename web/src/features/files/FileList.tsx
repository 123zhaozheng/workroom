// The file list shared by the wide two-column 文件库 and the phone list page: search, space and origin filters (as the server supports
// them), upload, rows with a preview button, and the empty states. `split` = rendered as the left column next to the detail panel.
import { Eye, FolderOpen, Search, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { FileListResponse, FileOrigin, FileUploadResponse } from "@shared/files";
import { errorText, post, qs } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import type { Project } from "@/lib/types";
import { cn, formatBytes, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/misc";
import { LoadState } from "@/features/work/states";
import { fileIcon } from "@/features/chat/Cards";
import { ORIGIN } from "./origin";

/** List state + upload for the library. Lives in the page so the list (and its filters) survives selecting another file. */
export function useFileLibrary() {
	const { personalSpaceId } = useSession();
	const [sp, setSp] = useSearchParams();
	const projectId = sp.get("projectId") ?? "";
	const [q, setQ] = useState("");
	const [origin, setOrigin] = useState<"" | FileOrigin>("");
	const files = useApi<FileListResponse>(`/files${qs({ q, origin, projectId })}`);
	const projects = useApi<{ projects: Project[] }>("/projects");
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
	const setProject = (id: string) => setSp((p) => {
		const n = new URLSearchParams(p);
		if (id) n.set("projectId", id);
		else n.delete("projectId");
		return n;
	});
	const clear = () => {
		setQ("");
		setOrigin("");
		setProject("");
	};
	return { files, projects, q, setQ, origin, setOrigin, projectId, setProject, input, upload, uploading, upErr, clear, filtered: !!(q || origin || projectId) };
}
export type FileLibrary = ReturnType<typeof useFileLibrary>;

/** Upload button + the hidden multi-file input it drives. */
export function UploadButton({ lib, variant = "primary" }: { lib: FileLibrary; variant?: "primary" | "secondary" }) {
	return (
		<Button variant={variant} onClick={() => lib.input.current?.click()} disabled={lib.uploading} data-testid="files-upload">
			<Upload />
			{lib.uploading ? "上传中…" : "上传文件"}
		</Button>
	);
}

export function FileFilters({ lib, split }: { lib: FileLibrary; split?: boolean }) {
	return (
		<div className={cn("flex flex-wrap items-center gap-2", split ? "px-3 pb-3" : "mb-4")}>
			<div className={cn("relative min-w-[200px] flex-1 basis-full", !split && "sm:basis-0")}>
				<Search aria-hidden className="absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
				<Input value={lib.q} onChange={(e) => lib.setQ(e.target.value)} placeholder="搜索文件名" aria-label="搜索文件名" className="pl-8" />
			</div>
			<Select value={lib.projectId} onChange={(e) => lib.setProject(e.target.value)} aria-label="空间" className={split ? "h-8 text-[13px]" : undefined}>
				<option value="">全部空间</option>
				{(lib.projects.data?.projects ?? []).map((p) => (
					<option key={p.id} value={p.id}>
						项目：{p.name}
					</option>
				))}
			</Select>
			<Select value={lib.origin} onChange={(e) => lib.setOrigin(e.target.value as FileOrigin | "")} aria-label="来源" className={split ? "h-8 text-[13px]" : undefined}>
				<option value="">全部来源</option>
				<option value="upload">上传</option>
				<option value="agent">助手生成</option>
				<option value="automation">自动化</option>
			</Select>
		</div>
	);
}

export interface FileRowsProps {
	lib: FileLibrary;
	selectedId?: string;
	split?: boolean;
	/** Phones: the eye opens the shared preview sheet. Wide: it opens the file in the detail column. */
	onPreview: (f: FileListResponse["files"][number]) => void;
}

export function FileRows({ lib, selectedId, split, onPreview }: FileRowsProps) {
	const keep = lib.projectId ? `?projectId=${encodeURIComponent(lib.projectId)}` : "";
	const list = lib.files.data?.files ?? [];
	return (
		<LoadState state={lib.files} what="文件库">
			{list.length === 0 ? (
				<div data-testid="files-empty" className={split ? "px-2" : "rounded-xl border border-border bg-surface"}>
					<EmptyState
						icon={<FolderOpen />}
						title={lib.filtered ? "没有匹配的文件" : "文件库还是空的"}
						action={
							lib.filtered ? (
								<Button onClick={lib.clear}>清除筛选</Button>
							) : (
								<Button variant="primary" onClick={() => lib.input.current?.click()} disabled={lib.uploading}>
									<Upload />
									上传文件
								</Button>
							)
						}
					/>
				</div>
			) : (
				<ul className={cn(split ? "px-2 pb-3" : "overflow-hidden rounded-xl border border-border bg-surface")}>
					{list.map((f, i) => {
						const Icon = fileIcon(f.name, f.mime);
						const o = ORIGIN[f.origin];
						const selected = f.id === selectedId;
						return (
							<li
								key={f.id}
								data-testid="file-row"
								data-selected={selected ? "true" : undefined}
								className={cn("group flex items-center gap-3 px-3 py-2.5", split ? "rounded-lg" : i > 0 && "border-t border-border", selected ? "bg-surface-3" : "hover:bg-surface-2/70")}
							>
								<Icon className="size-[18px] shrink-0 text-fg-muted" />
								<Link
									to={`/files/${f.id}${keep}`}
									aria-current={selected ? "page" : undefined}
									className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="block truncate text-sm font-medium">{f.name}</span>
									<span className="block truncate text-xs text-fg-muted">
										{o.label} · v{f.latestVersionNo} · {formatBytes(f.size)} · {relTime(f.updatedAt)}
										{f.spaceKind === "project" ? " · 项目" : ""}
									</span>
								</Link>
								<button
									type="button"
									onClick={() => onPreview(f)}
									className={cn(
										"inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										split && "opacity-0 group-hover:opacity-100",
									)}
									aria-label={`预览 ${f.name}`}
								>
									<Eye className="size-4" />
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</LoadState>
	);
}

export function UploadError({ lib }: { lib: FileLibrary }) {
	return lib.upErr ? (
		<p role="alert" className="mx-3 mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
			上传失败：{lib.upErr}
		</p>
	) : null;
}
