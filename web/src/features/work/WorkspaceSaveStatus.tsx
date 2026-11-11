// 保存状态 of the workspace files (work panel → 文件). This is about the files of the workspace only: it is separate from the
// conversation's own history and never restores running processes. Versions are verified copies of the working files.
import { History, Loader2, Save } from "lucide-react";
import { useState } from "react";
import type { WorkspaceSaveState, WorkspaceSaveStatusDTO, WorkspaceVersionDTO } from "@shared/workspace-safety";
import { ApiError, errorText, post } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes, fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { useConfirm } from "@/features/admin/confirm";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";
export const SAVE_STATE: Record<WorkspaceSaveState, { label: string; tone: Tone }> = {
	saved: { label: "已保存", tone: "success" },
	dirty: { label: "有未保存的更改", tone: "warning" },
	saving: { label: "正在保存", tone: "info" },
	failed: { label: "保存失败", tone: "danger" },
	conflict: { label: "有冲突", tone: "danger" },
	restoring: { label: "正在恢复", tone: "info" },
	restored: { label: "已恢复", tone: "success" },
};
const REASON: Record<string, string> = {
	run_end: "命令结束时自动保存",
	before_publish: "发布成果前自动保存",
	file_write: "写入文件后自动保存",
	turn_end: "一轮对话结束时自动保存",
	periodic: "定时保存",
	manual: "手动保存",
	restore: "恢复前保存的当前内容",
};

export function WorkspaceSaveStatus({ spaceId, conversationId, canWrite }: { spaceId: string; conversationId: number; canWrite: boolean }) {
	const key = `c${conversationId}`;
	const path = `/workspaces/${encodeURIComponent(spaceId)}/${key}`;
	const status = useApi<{ status: WorkspaceSaveStatusDTO }>(`${path}/status`, { pollMs: 3000 });
	const versions = useApi<{ versions: WorkspaceVersionDTO[] }>(`${path}/versions`, { pollMs: 6000 });
	const { ask, dialog } = useConfirm();
	const [busy, setBusy] = useState<"save" | "restore" | null>(null);
	const [note, setNote] = useState<{ tone: "err"; text: string }>();
	const [dirtyRestore, setDirtyRestore] = useState<{ version: number; paths: string[] }>();
	const [showPaths, setShowPaths] = useState(false);
	const s = status.data?.status;
	const list = versions.data?.versions ?? [];
	const reloadAll = () => {
		status.reload();
		versions.reload();
	};

	const save = async () => {
		setBusy("save");
		setNote(undefined);
		try {
			await post(`${path}/save`, {});
		} catch (e) {
			setNote({ tone: "err", text: `保存没有成功：${errorText(e)}` });
		} finally {
			setBusy(null);
			reloadAll();
		}
	};
	const restore = async (version: number, force: boolean) => {
		setBusy("restore");
		setNote(undefined);
		try {
			const r = await post<{ restored: { fromVersion: number; verified: boolean; keptAsVersion?: number }; status: WorkspaceSaveStatusDTO }>(`${path}/restore`, { version, ...(force ? { force: "keep-both" } : {}) });
			setDirtyRestore(undefined);
			const conflicts = r.status.restore?.conflicts ?? [];
			const problems = [r.restored.verified ? "" : "没有通过核对", conflicts.length ? `有 ${conflicts.length} 个冲突：${conflicts.slice(0, 5).join("、")}` : ""].filter(Boolean);
			if (problems.length) setNote({ tone: "err", text: `已恢复到版本 ${r.restored.fromVersion}，但${problems.join("；")}` });
		} catch (e) {
			if (e instanceof ApiError && e.code === "workspace_dirty") setDirtyRestore({ version, paths: s?.unsynced.paths.slice(0, 5) as string[] ?? [] });
			else setNote({ tone: "err", text: `恢复没有成功：${errorText(e)}` });
		} finally {
			setBusy(null);
			reloadAll();
		}
	};

	// A restore the server refused because the files were changed (state stays "dirty"; restore.verified false): nothing was touched.
	const refusedRestore = !!s && (s.state === "dirty" || s.state === "conflict") && !!s.restore && !s.restore.verified && s.restore.conflicts.length > 0;
	const st = s ? SAVE_STATE[s.state] : undefined;
	return (
		<section data-testid="ws-save" data-state={s?.state ?? "loading"} aria-label="保存状态" className="rounded-xl border border-border bg-surface p-3">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-sm font-medium">保存状态</h3>
				{st ? (
					<Badge tone={st.tone} data-testid="ws-save-badge">
						{s!.state === "saving" || s!.state === "restoring" ? <Loader2 className="wr-spin" /> : null}
						{st.label}
					</Badge>
				) : null}
				<span className="flex-1" />
				<Button size="sm" data-testid="ws-save-now" disabled={!canWrite || busy !== null || s?.state === "saving" || s?.state === "restoring"} title={canWrite ? undefined : "查看者不能保存"} onClick={() => void save()}>
					{busy === "save" ? <Loader2 className="wr-spin" /> : <Save />}
					立即保存
				</Button>
			</div>

			{status.error && !s ? (
				<p role="alert" className="mt-2 text-sm text-danger">
					暂时读不到保存状态：{errorText(status.error)}
				</p>
			) : null}
			{s ? (
				<div className="mt-2 space-y-1.5 text-[13px]">
					<p data-testid="ws-save-time" className="text-fg-muted">
						{s.lastSavedAt ? `上次保存：${fullTime(s.lastSavedAt)}（${relTime(s.lastSavedAt)}）${s.headVersion !== null ? ` · 版本 ${s.headVersion}` : ""}` : "还没有保存过"}
					</p>
					{refusedRestore ? (
						<p data-testid="ws-save-failure" role="alert" className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-warning">
							恢复没有进行：有尚未保存的更改。请先「立即保存」，再恢复。
						</p>
					) : s.failure && (s.state === "failed" || s.state === "conflict") ? (
						<p data-testid="ws-save-failure" role="alert" className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-danger">
							{s.state === "conflict" ? "有冲突，没有覆盖任何内容：" : "保存失败，工作文件仍保留在原处："}
							{s.failure}
						</p>
					) : null}
					{s.unsynced.count > 0 ? (
						<div data-testid="ws-unsynced">
							<button className="inline-flex items-center gap-1 text-warning hover:underline focus-visible:ring-2 focus-visible:ring-info" aria-expanded={showPaths} onClick={() => setShowPaths((v) => !v)}>
								{s.unsynced.count} 个文件的更改尚未保存
								<span className="text-xs text-fg-muted">{showPaths ? "收起" : "查看"}</span>
							</button>
							{showPaths ? (
								<ul className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg-muted">
									{s.unsynced.paths.map((p) => (
										<li key={p} className="break-all">
											{p}
										</li>
									))}
									{s.unsynced.count > s.unsynced.paths.length ? <li>…另有 {s.unsynced.count - s.unsynced.paths.length} 个</li> : null}
								</ul>
							) : null}
						</div>
					) : null}
					{s.restore && !refusedRestore ? (
						<p data-testid="ws-restore-result" className={cn(s.restore.verified && !s.restore.conflicts.length ? "text-fg-muted" : "text-danger")}>
							{fullTime(s.restore.at)} 从版本 {s.restore.fromVersion} 恢复：{s.restore.verified ? "已核对无误" : "没有通过核对"}
							{s.restore.conflicts.length ? `；冲突：${s.restore.conflicts.join("、")}` : ""}
						</p>
					) : null}
				</div>
			) : null}
			{note ? (
				<p data-testid="ws-save-note" role="alert" className="mt-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-sm text-danger">
					{note.text}
				</p>
			) : null}
			{dirtyRestore ? (
				<div data-testid="ws-restore-dirty" role="alert" className="mt-2 space-y-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
					<p>有尚未保存的更改，恢复会覆盖它们。{dirtyRestore.paths.length ? `例如：${dirtyRestore.paths.join("、")}` : ""}</p>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="primary" data-testid="ws-restore-keep-both" disabled={busy !== null} onClick={() => void restore(dirtyRestore.version, true)}>
							先保存当前内容再恢复
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setDirtyRestore(undefined)}>
							取消
						</Button>
					</div>
				</div>
			) : null}

			<details className="mt-3 group" data-testid="ws-versions" open={list.length > 0 && list.length <= 6}>
				<summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
					<History aria-hidden className="size-4" />
					历史版本（{list.length}）
				</summary>
				{list.length === 0 ? (
					<p data-testid="ws-versions-empty" className="mt-2 text-[13px] text-fg-muted">
						还没有历史版本
					</p>
				) : (
					<ul className="mt-2 divide-y divide-border rounded-lg border border-border">
						{list.map((v) => (
							<li key={v.version} data-testid="ws-version" data-version={v.version} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-[13px]">
								<span className="font-medium tabular-nums">版本 {v.version}</span>
								{s?.headVersion === v.version ? <Badge tone="success">当前</Badge> : null}
								<span className="min-w-0 flex-1 text-fg-muted">
									{fullTime(v.createdAt)} · {REASON[v.reason] ?? v.reason} · {v.fileCount} 个文件 · {formatBytes(v.totalBytes)}
								</span>
								<Button
									size="sm"
									variant="ghost"
									data-testid="ws-restore"
									disabled={!canWrite || busy !== null}
									title={canWrite ? undefined : "查看者不能恢复"}
									onClick={async () => {
										if (await ask({ title: `恢复到版本 ${v.version}？`, consequence: "工作区的文件会换成这个版本的内容；只恢复文件，不会恢复正在运行的程序。", confirmLabel: "恢复" })) void restore(v.version, false);
									}}
								>
									恢复
								</Button>
							</li>
						))}
					</ul>
				)}
			</details>
			{dialog}
		</section>
	);
}

