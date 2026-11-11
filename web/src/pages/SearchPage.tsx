import { BookOpen, FileText, MessageSquare, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { FileListResponse } from "@shared/files";
import type { KbSearchResponse } from "@shared/knowledge";
import { ApiError, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { TopBar } from "@/components/shell/AppShell";
import { usePanel } from "@/components/shell/panel";
import { Input } from "@/components/ui/input";
import { Loadable, Page, Unavailable } from "@/components/ui/misc";
import { SearchHitBody } from "@/features/search/SearchHitRow";
import { useSearch } from "@/features/search/useSearch";
import { convPath } from "@/features/projects/model";

export default function SearchPage() {
	const [q, setQ] = useState("");
	const [dq, setDq] = useState("");
	useEffect(() => {
		const t = setTimeout(() => setDq(q.trim()), 250);
		return () => clearTimeout(t);
	}, [q]);
	// conversations: title, messages, tags and project names (the same search as Ctrl/Cmd+K)
	const convs = useSearch(dq, { debounceMs: 0, limit: 20 });
	const files = useApi<FileListResponse>(dq ? `/files${qs({ q: dq })}` : null);
	const [kb, setKb] = useState<{ res?: KbSearchResponse; err?: unknown }>({});
	const { openPreview } = usePanel();
	useEffect(() => {
		if (!dq) return setKb({});
		let alive = true;
		post<KbSearchResponse>("/kb/search", { query: dq, limit: 6 })
			.then((res) => alive && setKb({ res }))
			.catch((err) => alive && setKb({ err }));
		return () => {
			alive = false;
		};
	}, [dq]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<Page>
					<div className="relative mb-8">
						<Search className="absolute left-3 top-3 size-[18px] text-fg-subtle" />
						<Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索对话、文件和知识" className="h-11 rounded-xl pl-10 text-[15px]" data-testid="search-input" />
					</div>
					{!dq ? null : (
						<div className="space-y-8">
							<Section icon={<MessageSquare />} title="对话">
								{convs.status === "error" ? (
									<p role="alert" data-kind={convs.error?.kind} className="px-2 text-[13px] text-danger">
										{convs.error?.message}
									</p>
								) : convs.status === "loading" && convs.hits.length === 0 ? (
									<p className="px-2 text-[13px] text-fg-subtle">正在搜索…</p>
								) : convs.hits.length === 0 ? (
									<Empty />
								) : (
									convs.hits.map((h) => (
										<Link key={`${h.spaceId}/${h.conversationId}/${h.entryId ?? ""}`} to={convPath(h, h.entryId)} data-testid="search-page-result" className="block rounded-lg px-2 py-2 hover:bg-surface-2">
											<SearchHitBody hit={h} query={dq} />
										</Link>
									))
								)}
							</Section>
							<Section icon={<FileText />} title="文件">
								<Loadable state={files} what="文件搜索" need="D 组：GET /files?q=">
									{(files.data?.files ?? []).length === 0 ? (
										<Empty />
									) : (
										files.data!.files.map((f) => (
											<Link key={f.id} to={`/files/${f.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-2">
												<span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
												<span className="text-xs text-fg-subtle">v{f.latestVersionNo}</span>
											</Link>
										))
									)}
								</Loadable>
							</Section>
							<Section icon={<BookOpen />} title="知识">
								{kb.err instanceof ApiError && kb.err.unavailable ? (
									<Unavailable what="知识检索" need="C 组：POST /kb/search" compact />
								) : kb.err ? (
									<p className="text-[13px] text-danger">{errorText(kb.err)}</p>
								) : !kb.res ? null : kb.res.citations.length === 0 ? (
									<p className="px-2 text-[13px] text-fg-subtle">{kb.res.diagnostics.reason === "index_not_ready" ? "资料仍在处理中，暂不可检索" : "没有找到相关内容"}</p>
								) : (
									kb.res.citations.map((c) => (
										<button key={c.chunkId} onClick={() => openPreview({ fileId: c.fileId, versionId: c.versionId, name: c.fileName })} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-surface-2">
											<span className="block text-sm">
												{c.fileName} <span className="text-xs text-fg-subtle">· {c.kbName} · v{c.versionNo} · {c.locator}</span>
											</span>
											<span className="block truncate text-[13px] text-fg-muted">{c.snippet}</span>
										</button>
									))
								)}
							</Section>
						</div>
					)}
				</Page>
			</div>
		</div>
	);
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
	return (
		<section>
			<h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-muted [&_svg]:size-4">
				{icon}
				{title}
			</h2>
			{children}
		</section>
	);
}
const Empty = () => <p className="px-2 text-[13px] text-fg-subtle">没有结果</p>;
