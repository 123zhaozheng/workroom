// External read-only share links (M09-C): a separate permission model from project membership. A link is read-only,
// expires, can be revoked, and stops working when its creator loses access. The public page needs no login.
import { Copy, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import type { ShareLinkDTO, ShareResourceKind, SharedViewDTO } from "@shared/ops";
import { del, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { copyText, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent } from "@/components/ui/overlay";
import { Badge, Loadable } from "@/components/ui/misc";
import { BrandMark } from "@/components/shell/BrandMark";
import { useSession } from "@/lib/session";

const STATUS: Record<ShareLinkDTO["status"], { label: string; tone: "success" | "neutral" | "danger" | "warning" }> = {
	active: { label: "有效", tone: "success" },
	expired: { label: "已过期", tone: "neutral" },
	revoked: { label: "已撤销", tone: "danger" },
	creator_lost_access: { label: "创建者已无权限，链接失效", tone: "warning" },
};
const KIND: Record<ShareResourceKind, string> = { conversation: "对话", file: "文件", project: "项目", kb: "知识库", automation: "自动化" };

export function ShareDialog({ open, onOpenChange, kind, id, spaceId, title }: { open: boolean; onOpenChange: (o: boolean) => void; kind: ShareResourceKind; id: string; spaceId?: string; title: string }) {
	const res = useApi<{ shares: ShareLinkDTO[] }>(open ? `/shares${qs({ kind, id, spaceId })}` : null);
	const [hours, setHours] = useState(168);
	const [created, setCreated] = useState<string>();
	const [copied, setCopied] = useState(false);
	const [err, setErr] = useState<string>();
	const [busy, setBusy] = useState(false);
	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			res.reload();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title={`分享${KIND[kind]}的只读链接`} description={`「${title}」`} className="max-w-lg">
				<div data-testid="share-dialog" className="space-y-3 text-[13px]">
					<div className="flex items-center gap-2">
						<Select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="h-8 text-[13px]" aria-label="有效期">
							<option value={24}>1 天后过期</option>
							<option value={168}>7 天后过期</option>
							<option value={720}>30 天后过期</option>
						</Select>
						<Button
							size="sm"
							variant="primary"
							disabled={busy}
							data-testid="share-create"
							onClick={() =>
								act(async () => {
									const r = await post<{ share: ShareLinkDTO }>("/shares", { kind, id, ...(spaceId ? { spaceId } : {}), expiresInHours: hours });
									setCreated(`${location.origin}${r.share.url}`);
								})
							}
						>
							<Link2 />
							生成链接
						</Button>
					</div>
					{created ? (
						<div className="rounded-lg bg-info-soft px-3 py-2 text-info" data-testid="share-url">
							<div className="mb-1">链接只显示这一次：</div>
							<div className="flex items-center gap-2">
								<code className="min-w-0 flex-1 break-all">{created}</code>
								<button
									aria-label="复制链接"
									onClick={async () => {
										setCopied(await copyText(created));
										setTimeout(() => setCopied(false), 1200);
									}}
								>
									<Copy className="size-4" />
								</button>
							</div>
							{copied ? <div className="text-xs">已复制</div> : null}
						</div>
					) : null}
					{err ? <p className="text-danger">{err}</p> : null}
					<Loadable state={res} what="分享链接" need="E 组：GET /api/shares">
						{(res.data?.shares ?? []).length === 0 ? (
							<p className="text-fg-subtle">还没有分享链接</p>
						) : (
							<ul className="divide-y divide-border rounded-lg border border-border" data-testid="share-list">
								{res.data!.shares.map((s) => (
									<li key={s.id} data-testid="share" data-status={s.status} className="flex flex-wrap items-center gap-2 px-3 py-2">
										<Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
										<span className="min-w-0 flex-1 text-xs text-fg-muted">
											{fullTime(s.createdAt)} 创建 · {fullTime(s.expiresAt)} 到期 · 打开 {s.useCount} 次
										</span>
										{s.status === "active" ? (
											<Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => del(`/shares/${s.id}`))} data-testid="share-revoke">
												<Trash2 />
												撤销
											</Button>
										) : null}
									</li>
								))}
							</ul>
						)}
					</Loadable>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** Public read-only view: /s/:token (no login required). */
export function SharedPage() {
	const { token } = useParams();
	const { brand } = useSession();
	const res = useApi<SharedViewDTO>(`/shared/${encodeURIComponent(token ?? "")}`);
	const c = res.data?.content as { name?: string; description?: string; createdAt?: string } | null | undefined;
	return (
		<div className="min-h-dvh bg-bg px-4 py-10">
			<div className="mx-auto max-w-2xl">
				<div className="mb-6 flex items-center gap-2">
					<BrandMark />
					<span className="font-semibold">{brand.name}</span>
					<Badge className="ml-2">只读分享</Badge>
				</div>
				<div data-testid="shared-view">
					{res.error ? (
						<div className="rounded-xl border border-border bg-surface p-6 text-center" data-testid="shared-invalid">
							<div className="text-[15px] font-medium">链接无效、已过期或已撤销</div>
						</div>
					) : res.loading || !res.data ? (
						<p className="text-[13px] text-fg-subtle">正在加载…</p>
					) : (
						<div className="rounded-xl border border-border bg-surface p-6">
							<div className="text-xs text-fg-subtle">
								{KIND[res.data.resource.kind]} · {res.data.sharedBy} 分享 · {fullTime(res.data.expiresAt)} 到期 · 只能查看
							</div>
							{c ? (
								<>
									<h1 className="mt-2 text-xl font-semibold">{c.name}</h1>
									{c.description ? <p className="mt-2 text-[14px] text-fg-muted">{c.description}</p> : null}
								</>
							) : (
								<p className="mt-3 text-[13px] text-fg-muted">暂不支持显示内容</p>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
