// Share a container project with people in the same organisation (read only). Owner only; the server enforces it and the revoke is
// effective immediately (including streams that are already open).
import { Check, Search, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryUserDTO, ProjectShareDTO } from "@shared/round9";
import { ApiError, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/misc";
import { addShare, listShares, revokeShare, searchDirectory } from "./actions";

export const SHARE_PERMISSION_TEXT = "只读：可以查看此项目中的对话和成果，不能发送消息或确认操作";

export function ShareProjectDialog({ open, onOpenChange, projectId, projectName, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; projectName: string; onChanged?: () => void }) {
	const [shares, setShares] = useState<ProjectShareDTO[]>();
	const [listErr, setListErr] = useState<string>();
	const [err, setErr] = useState<string>();
	const [q, setQ] = useState("");
	const [users, setUsers] = useState<DirectoryUserDTO[]>();
	const [searching, setSearching] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [added, setAdded] = useState<string>();
	const inputRef = useRef<HTMLInputElement>(null);
	const { me } = useSession();

	const reload = useCallback(async () => {
		try {
			setShares(await listShares(projectId));
			setListErr(undefined);
		} catch (e) {
			setListErr(errorText(e));
		}
	}, [projectId]);
	useEffect(() => {
		if (!open) return;
		setShares(undefined);
		setErr(undefined);
		setQ("");
		setAdded(undefined);
		void reload();
	}, [open, reload]);

	// Directory search: debounced, stale answers dropped.
	useEffect(() => {
		if (!open) return;
		const ac = new AbortController();
		setSearching(true);
		const t = setTimeout(
			() => {
				searchDirectory(q.trim(), ac.signal)
					.then((u) => {
						setUsers(u);
						setErr(undefined);
					})
					.catch((e) => {
						if ((e as Error)?.name !== "AbortError") {
							setUsers([]);
							setErr(e instanceof ApiError && e.status === 403 ? "没有权限查看通讯录" : errorText(e));
						}
					})
					.finally(() => !ac.signal.aborted && setSearching(false));
			},
			q ? 200 : 0,
		);
		return () => {
			clearTimeout(t);
			ac.abort();
		};
	}, [q, open]);

	const sharedIds = useMemo(() => new Set((shares ?? []).map((s) => s.userId)), [shares]);
	const candidates = (users ?? []).filter((u) => !sharedIds.has(u.userId) && u.userId !== me?.userId);

	const run = async (key: string, fn: () => Promise<unknown>) => {
		setBusy(key);
		setErr(undefined);
		try {
			await fn();
			await reload();
			onChanged?.();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="分享项目" description={`「${projectName}」只能分享给同一组织的成员。`} className="max-w-lg" data-testid="share-project-dialog" onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}>
				<div className="space-y-4 text-sm">
					<p className="rounded-lg bg-surface-2 px-3 py-2 text-fg-muted" data-testid="share-permission-note">
						{SHARE_PERMISSION_TEXT}。
					</p>

					<section aria-label="添加成员">
						<div className="relative">
							<Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" />
							<Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索同事的姓名或邮箱" aria-label="搜索同事" className="pl-8" data-testid="share-search" />
						</div>
						<ul aria-label="可分享的同事" data-testid="share-candidates" className="mt-2 max-h-44 divide-y divide-border overflow-y-auto rounded-lg border border-border">
							{searching && !users ? (
								<li className="flex items-center gap-2 px-3 py-2 text-fg-subtle">
									<Spinner /> 正在查找…
								</li>
							) : candidates.length === 0 ? (
								<li className="px-3 py-2 text-fg-subtle">{q ? "没有匹配的同事" : users && users.length > 0 ? "同事都已在分享名单中" : "没有可分享的同事"}</li>
							) : (
								candidates.map((u) => (
									<li key={u.userId} data-testid="share-candidate" data-user-id={u.userId} className="flex items-center gap-2 px-3 py-1.5">
										<Person name={u.name} email={u.email} />
										<Button size="sm" disabled={!!busy} aria-label={`分享给 ${u.name}`} onClick={() => run(`add:${u.userId}`, async () => {
											await addShare(projectId, u.userId);
											setAdded(u.name);
										})}>
											{busy === `add:${u.userId}` ? <Spinner /> : <UserPlus />}
											分享
										</Button>
									</li>
								))
							)}
						</ul>
						{added ? (
							<p role="status" className="mt-1.5 flex items-center gap-1 text-xs text-success">
								<Check className="size-3.5" />已分享给 {added}
							</p>
						) : null}
					</section>

					{err ? (
						<p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-danger">
							{err}
						</p>
					) : null}

					<section aria-label="已分享的人">
						<h3 className="mb-1.5 text-sm font-medium">已分享 {shares ? `(${shares.length})` : ""}</h3>
						{listErr ? (
							<p role="alert" className="text-danger">
								{listErr}
							</p>
						) : !shares ? (
							<p className="flex items-center gap-2 text-fg-subtle">
								<Spinner /> 加载中…
							</p>
						) : shares.length === 0 ? (
							<p className="text-fg-subtle">还没有分享给任何人。</p>
						) : (
							<ul data-testid="share-members" className="divide-y divide-border rounded-lg border border-border">
								{shares.map((s) => (
									<li key={s.userId} data-testid="share-member" data-user-id={s.userId} className="flex items-center gap-2 px-3 py-1.5">
										<Person name={s.name} email={s.email} note={`只读 · ${fullTime(s.grantedAt)}`} />
										<Button size="sm" variant="ghost" disabled={!!busy} aria-label={`撤销 ${s.name} 的访问`} data-testid="share-revoke-user" onClick={() => run(`rm:${s.userId}`, () => revokeShare(projectId, s.userId))}>
											{busy === `rm:${s.userId}` ? <Spinner /> : <X />}
											撤销
										</Button>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Person({ name, email, note }: { name: string; email: string; note?: string }) {
	return (
		<>
			<span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-medium">
				{name.slice(0, 1).toUpperCase()}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate">{name}</span>
				<span className="block truncate text-xs text-fg-muted">{note ?? email}</span>
			</span>
		</>
	);
}
