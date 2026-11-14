// 上传技能: a small dialog opened from the 我的技能 toolbar. Pick a .zip (click or drop) or a folder → file name / size and the
// checks the browser can do (.zip only, size and file-count limits) → 上传 → on success the dialog closes and the list reloads.
// The request is unchanged: POST /market/skills/upload (multipart `file`, or JSON `{ files }` for a folder, `skillId` = new version).
import { CircleX, FileArchive, FolderUp, Folder, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import type { PackageCheckDTO, SubmissionDTO } from "@shared/files";
import { ApiError, errorText, post } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { FindingList, useMarketMe } from "./common";

export type UploadResult = { name: string; versionNo: number; skillId: string; checks: PackageCheckDTO; submission?: SubmissionDTO };
type Picked = { kind: "zip"; name: string; bytes: number; file: File } | { kind: "folder"; name: string; bytes: number; count: number; files: File[] };

async function readFolder(files: File[]): Promise<{ path: string; content: string; encoding: "base64" }[]> {
	const out: { path: string; content: string; encoding: "base64" }[] = [];
	for (const f of files) {
		const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
		const bytes = new Uint8Array(await f.arrayBuffer());
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		out.push({ path: rel, content: btoa(bin), encoding: "base64" });
	}
	return out;
}

export function UploadDialog({ open, onOpenChange, onUploaded, skillId }: { open: boolean; onOpenChange: (o: boolean) => void; onUploaded: (r: UploadResult) => void; skillId?: string }) {
	const [picked, setPicked] = useState<Picked>();
	const [problem, setProblem] = useState<string>();
	const [drag, setDrag] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<{ text: string; findings?: PackageCheckDTO["findings"] }>();
	const zipRef = useRef<HTMLInputElement>(null);
	const dirRef = useRef<HTMLInputElement>(null);
	const me = useMarketMe();
	const lim = me.data?.me.limits;
	const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

	const reset = () => (setPicked(undefined), setProblem(undefined), setErr(undefined), setDrag(false));
	// A running upload cannot be dismissed: its result (or error) is what the dialog is waiting to show.
	const change = (o: boolean) => {
		if (busy) return;
		if (o) reset();
		onOpenChange(o);
	};

	const pickZip = (f: File) => {
		setErr(undefined);
		setPicked(undefined);
		if (!/\.zip$/i.test(f.name)) return setProblem("只支持 .zip 技能包，也可以选择整个文件夹。");
		if (!f.size) return setProblem("文件是空的。");
		if (lim && f.size > lim.uploadBytes) return setProblem(`文件 ${formatBytes(f.size)}，超过上限 ${mb(lim.uploadBytes)}。`);
		setProblem(undefined);
		setPicked({ kind: "zip", name: f.name, bytes: f.size, file: f });
	};
	const pickFolder = (files: FileList) => {
		setErr(undefined);
		setPicked(undefined);
		// A copy: the input is reset right after picking, which empties its live FileList.
		const list = Array.from(files);
		const bytes = list.reduce((n, f) => n + f.size, 0);
		const name = ((list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || list[0].name).split("/")[0];
		if (lim && list.length > lim.files) return setProblem(`文件夹里有 ${list.length} 个文件，超过上限 ${lim.files} 个。`);
		if (lim && bytes > lim.uploadBytes) return setProblem(`文件夹共 ${formatBytes(bytes)}，超过上限 ${mb(lim.uploadBytes)}。`);
		setProblem(undefined);
		setPicked({ kind: "folder", name, bytes, count: list.length, files: list });
	};

	const submit = async () => {
		if (!picked || busy) return;
		setBusy(true);
		setErr(undefined);
		try {
			let body: FormData | Record<string, unknown>;
			if (picked.kind === "zip") {
				const fd = new FormData();
				fd.set("file", picked.file);
				if (skillId) fd.set("skillId", skillId);
				body = fd;
			} else body = { files: await readFolder(picked.files), ...(skillId ? { skillId } : {}) };
			const r = await post<{ skill: { id: string; name: string }; versionNo: number; checks: PackageCheckDTO; submission?: SubmissionDTO }>("/market/skills/upload", body as Record<string, unknown>);
			setBusy(false);
			onUploaded({ name: r.skill.name, versionNo: r.versionNo, skillId: r.skill.id, checks: r.checks, submission: r.submission });
			onOpenChange(false);
		} catch (e) {
			const detail = e instanceof ApiError ? (e.detail as { findings?: PackageCheckDTO["findings"] } | undefined) : undefined;
			setErr({ text: errorText(e), findings: detail?.findings });
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogContent title="上传技能" description={lim ? `.zip 技能包或整个文件夹 · 上限 ${mb(lim.uploadBytes)} · ${lim.files} 个文件` : ".zip 技能包或整个文件夹"} data-testid="upload-dialog">
				<div className="space-y-3 text-sm">
					<div
						onDragOver={(e) => (e.preventDefault(), setDrag(true))}
						onDragLeave={() => setDrag(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDrag(false);
							const f = e.dataTransfer.files[0];
							if (f && !busy) pickZip(f);
						}}
						data-testid="dropzone"
						data-drag={drag}
						className={cn("flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-3 py-4 text-center transition-colors", drag ? "border-accent bg-surface-2" : "border-border-strong bg-surface-2/40")}
					>
						<Upload className="size-5 text-fg-muted" />
						<div className="text-[13px] text-fg-muted">把 .zip 拖到这里，或</div>
						<div className="flex flex-wrap justify-center gap-2">
							<Button size="sm" disabled={busy} onClick={() => zipRef.current?.click()} data-testid="upload-zip">
								<FileArchive />
								选择 .zip
							</Button>
							<Button size="sm" disabled={busy} onClick={() => dirRef.current?.click()} data-testid="upload-folder">
								<FolderUp />
								选择文件夹
							</Button>
						</div>
					</div>
					<input ref={zipRef} type="file" accept=".zip,application/zip" hidden data-testid="upload-zip-input" onChange={(e) => (e.target.files?.[0] && pickZip(e.target.files[0]), (e.target.value = ""))} />
					<input
						ref={dirRef}
						type="file"
						hidden
						multiple
						// @ts-expect-error non-standard but universally supported directory picker
						webkitdirectory=""
						data-testid="upload-folder-input"
						onChange={(e) => {
							const fl = e.target.files;
							if (fl?.length) pickFolder(fl);
							e.target.value = "";
						}}
					/>
					{problem ? (
						<p className="flex items-start gap-1.5 text-danger" role="alert" data-testid="upload-problem">
							<CircleX className="mt-0.5 size-4 shrink-0" />
							<span className="min-w-0 break-words">{problem}</span>
						</p>
					) : null}
					{picked ? (
						<div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2" data-testid="upload-picked">
							{picked.kind === "zip" ? <FileArchive className="size-4 shrink-0 text-fg-muted" /> : <Folder className="size-4 shrink-0 text-fg-muted" />}
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium" title={picked.name}>
									{picked.name}
								</span>
								<span className="block text-xs text-fg-muted">
									{picked.kind === "folder" ? `${picked.count} 个文件 · ` : ""}
									{formatBytes(picked.bytes)}
								</span>
							</span>
							<button disabled={busy} onClick={reset} aria-label="移除所选文件" data-testid="upload-clear" className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
								<X className="size-4" />
							</button>
						</div>
					) : null}
					{err ? (
						<div className="rounded-lg border border-danger/40 bg-danger-soft/40 p-3" role="alert" data-testid="upload-error">
							<div className="mb-1.5 flex items-start gap-1.5 font-medium text-danger">
								<CircleX className="mt-0.5 size-4 shrink-0" />
								<span className="min-w-0 break-words">上传被拒绝：{err.text}</span>
							</div>
							{err.findings?.length ? <FindingList findings={err.findings} /> : null}
						</div>
					) : null}
					<div className="flex items-center justify-end gap-2 pt-1">
						{busy ? <span className="mr-auto text-xs text-fg-muted" data-testid="upload-busy">正在上传并检查…</span> : null}
						<Button disabled={busy} onClick={() => change(false)} data-testid="upload-cancel">
							取消
						</Button>
						<Button variant="primary" disabled={!picked || busy} onClick={() => void submit()} data-testid="upload-submit">
							上传
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** One-line outcome of the last upload, shown under the toolbar until dismissed; the automated findings stay readable. */
export function UploadOutcome({ result, onDismiss }: { result: UploadResult; onDismiss: () => void }) {
	return (
		<div className="mb-3 rounded-xl border border-border bg-surface p-3.5 text-sm" data-testid="upload-result">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">已上传「{result.name}」v{result.versionNo}</span>
				<span className="text-xs text-fg-subtle">
					{result.checks.stats.fileCount} 个文件 · {(result.checks.stats.packageBytes / 1024).toFixed(1)} KB
				</span>
				<button onClick={onDismiss} aria-label="关闭提示" className="ml-auto flex size-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					<X className="size-4" />
				</button>
			</div>
			<div className="mt-2">
				<FindingList findings={result.checks.findings} empty="自动检查没有发现问题。" />
			</div>
		</div>
	);
}
