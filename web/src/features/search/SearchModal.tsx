// Ctrl/Cmd+K search: Radix Dialog (focus trap, Esc, focus returns to where it was) + a hand-written combobox/listbox.
// Query → GET /search (debounced 200 ms); the right pane previews the active hit via GET /search/preview (desktop ≥ 1024 px).
// Enter / click opens the conversation and scrolls to the matched message (?entry=).
import { MessageSquare, Search, TriangleAlert } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { SearchHitDTO } from "@shared/round9";
import type { ConversationSummary } from "@shared/chat";
import { ApiError, get } from "@/lib/api";
import { useMedia } from "@/lib/prefs";
import { useApi } from "@/lib/useApi";
import { cn, fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { convKey, convPath, normalizeProject } from "@/features/projects/model";
import { Highlight } from "./Highlight";
import { SearchHitOption } from "./SearchHitRow";
import { classifyError, useSearch, type SearchErrorKind } from "./useSearch";

interface PreviewTurn {
	role: "user" | "assistant";
	text: string;
	entryId: number;
}
interface PreviewDTO {
	title: string;
	turns: PreviewTurn[];
}

export function SearchModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const navigate = useNavigate();
	const wide = useMedia("(min-width: 1024px)");
	const [q, setQ] = useState("");
	const [active, setActive] = useState(0);
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const trimmed = q.trim();

	useEffect(() => {
		if (open) {
			setQ("");
			setActive(0);
		}
	}, [open]);

	const search = useSearch(q, { enabled: open });

	// Empty query: the most recent conversations (and project names for them).
	const recent = useApi<{ conversations: ConversationSummary[] }>(open && !trimmed ? "/conversations?limit=8" : null);
	const projects = useApi<{ projects: unknown[] }>(open && !trimmed ? "/projects" : null);
	const recentHits = useMemo<SearchHitDTO[]>(() => {
		const names = new Map((projects.data?.projects ?? []).map(normalizeProject).map((p) => [p.id, p.name]));
		return (recent.data?.conversations ?? [])
			.filter((c) => c.kind !== "subagent" && !c.archived)
			.map((c) => ({
				spaceId: c.spaceId,
				conversationId: c.conversationId,
				title: c.title,
				projectId: c.projectId,
				projectName: c.projectId ? names.get(c.projectId) : undefined,
				tags: [],
				starred: false,
				matchedIn: [],
				snippet: "",
				updatedAt: c.updatedAt,
				access: "own" as const,
			}));
	}, [recent.data, projects.data]);

	const showingRecent = !trimmed;
	const hits = showingRecent ? recentHits : search.hits;
	// A new result list starts at the top.
	const sig = hits.map((h) => `${convKey(h)}:${h.entryId ?? ""}`).join(",");
	useEffect(() => setActive(0), [sig]);
	const current = hits[Math.min(active, hits.length - 1)];

	const openHit = useCallback(
		(h: SearchHitDTO) => {
			onOpenChange(false);
			navigate(convPath(h, h.entryId));
		},
		[navigate, onOpenChange],
	);

	// keep the active option in view
	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [active, sig]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (!hits.length) return;
			const d = e.key === "ArrowDown" ? 1 : -1;
			setActive((a) => (a + d + hits.length) % hits.length);
		} else if (e.key === "Enter") {
			if (current) {
				e.preventDefault();
				openHit(current);
			}
		}
	};

	const optionId = (h: SearchHitDTO, i: number) => `${listId}-o${i}`;
	const loading = showingRecent ? recent.loading && !recent.data : search.status === "loading";
	const err = showingRecent ? undefined : search.status === "error" ? search.error : undefined;

	return (
		<D.Root open={open} onOpenChange={onOpenChange}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-50 bg-[var(--overlay)] wr-fade-in" />
				<D.Content
					data-testid="search-modal"
					aria-describedby={undefined}
					onOpenAutoFocus={(e) => {
						const a = document.activeElement;
						opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
						e.preventDefault();
						inputRef.current?.focus();
					}}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						const el = opener.current;
						opener.current = null;
						if (el?.isConnected) el.focus({ preventScroll: true });
					}}
					className={cn(
						"fixed left-1/2 top-[6dvh] z-50 flex h-[min(640px,86dvh)] w-[calc(100vw-24px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-pop wr-fade-in focus:outline-none",
						wide ? "max-w-[980px]" : "max-w-[640px]",
					)}
				>
					<D.Title className="sr-only">搜索对话</D.Title>
					<div className="flex shrink-0 items-center gap-2 border-b border-border px-4">
						<Search aria-hidden className="size-[18px] shrink-0 text-fg-subtle" />
						<input
							ref={inputRef}
							value={q}
							maxLength={200}
							onChange={(e) => setQ(e.target.value)}
							onKeyDown={onKeyDown}
							role="combobox"
							aria-expanded={hits.length > 0}
							aria-controls={listId}
							aria-autocomplete="list"
							aria-activedescendant={current ? optionId(current, Math.min(active, hits.length - 1)) : undefined}
							aria-label="搜索对话"
							placeholder="搜索对话标题、内容、标签和项目"
							data-testid="search-modal-input"
							className="h-14 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
						/>
						{loading && trimmed ? <Spinner /> : null}
						<kbd className="hidden rounded border border-border px-1.5 text-xs text-fg-subtle sm:inline">Esc</kbd>
						<D.Close className="rounded-md px-2 py-1 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:hidden">取消</D.Close>
					</div>

					<div className="flex min-h-0 flex-1">
						<div className={cn("wr-scroll min-h-0 min-w-0 flex-1 overflow-y-auto p-2", wide && "w-1/2 flex-none basis-[46%] border-r border-border")}>
							<div role="status" aria-live="polite" className="sr-only">
								{!showingRecent && search.status === "ok" ? `找到 ${hits.length} 个结果` : ""}
							</div>
							{err ? (
								<ErrorBlock kind={err.kind} message={err.message} onRetry={search.retry} />
							) : loading && hits.length === 0 ? (
								<p className="flex items-center justify-center gap-2 py-16 text-sm text-fg-subtle">
									<Spinner /> 正在搜索…
								</p>
							) : hits.length === 0 ? (
								<div data-testid="search-empty" className="flex flex-col items-center px-6 py-16 text-center">
									<span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
										<MessageSquare className="size-5" />
									</span>
									<p className="text-sm font-medium">{showingRecent ? "还没有对话" : `没有找到“${trimmed}”`}</p>
									<p className="mt-1 text-sm text-fg-muted">{showingRecent ? "开始一个新对话后，可以在这里快速找回。" : "换个关键词试试，或者少输入几个字。"}</p>
								</div>
							) : (
								<>
									{showingRecent ? <p className="px-3 pb-1 pt-1 text-xs font-medium text-fg-muted">最近对话</p> : null}
									<div ref={listRef} id={listId} role="listbox" aria-label={showingRecent ? "最近对话" : "搜索结果"} data-testid="search-results" className="flex flex-col gap-0.5">
										{hits.map((h, i) => (
											<SearchHitOption key={`${convKey(h)}:${h.entryId ?? ""}`} hit={h} query={trimmed} active={i === active} id={optionId(h, i)} onOpen={() => openHit(h)} onActivate={() => i !== active && setActive(i)} />
										))}
									</div>
								</>
							)}
						</div>
						{wide ? <PreviewPane hit={current} query={trimmed} /> : null}
					</div>

					<div className="hidden shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-xs text-fg-muted [@media(hover:hover)]:flex">
						<span>
							<kbd className="rounded border border-border px-1">↑</kbd> <kbd className="rounded border border-border px-1">↓</kbd> 选择
						</span>
						<span>
							<kbd className="rounded border border-border px-1">Enter</kbd> 打开
						</span>
						<span>
							<kbd className="rounded border border-border px-1">Esc</kbd> 关闭
						</span>
						{search.indexedThrough && !showingRecent ? <span className="ml-auto hidden sm:inline">搜索范围更新到 {fullTime(search.indexedThrough)}</span> : null}
					</div>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}

function ErrorBlock({ kind, message, onRetry }: { kind: SearchErrorKind; message: string; onRetry: () => void }) {
	return (
		<div role="alert" data-testid="search-error" data-kind={kind} className="flex flex-col items-center px-6 py-14 text-center">
			<span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
				<TriangleAlert className="size-5" />
			</span>
			<p className="text-sm font-medium">{kind === "forbidden" ? "无权限" : kind === "unavailable" ? "搜索暂不可用" : "搜索出错了"}</p>
			<p className="mt-1 max-w-sm text-sm text-fg-muted">{message}</p>
			{kind !== "forbidden" ? (
				<Button size="sm" className="mt-3" onClick={onRetry}>
					重试
				</Button>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------- preview pane
const previewCache = new Map<string, PreviewDTO>();

function PreviewPane({ hit, query }: { hit?: SearchHitDTO; query: string }) {
	const key = hit ? `${convKey(hit)}:${hit.entryId ?? ""}` : "";
	const [state, setState] = useState<{ key: string; data?: PreviewDTO; error?: { kind: SearchErrorKind; message: string } }>({ key: "" });
	useEffect(() => {
		if (!hit) return;
		const cached = previewCache.get(key);
		if (cached) {
			setState({ key, data: cached });
			return;
		}
		setState({ key });
		const ac = new AbortController();
		const t = setTimeout(() => {
			get<PreviewDTO>(`/search/preview/${hit.spaceId}/${hit.conversationId}${hit.entryId ? `?entryId=${hit.entryId}` : ""}`, ac.signal)
				.then((d) => {
					previewCache.set(key, d);
					if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value!);
					setState({ key, data: d });
				})
				.catch((e) => {
					if ((e as Error)?.name !== "AbortError") setState({ key, error: e instanceof ApiError && e.status === 403 ? { kind: "forbidden", message: "无权限查看这个对话。" } : classifyError(e) });
				});
		}, 220);
		return () => {
			clearTimeout(t);
			ac.abort();
		};
	}, [key, hit]);

	const ready = state.key === key;
	return (
		<aside data-testid="search-preview" aria-label="对话预览" className="wr-scroll hidden min-w-0 flex-1 overflow-y-auto bg-surface-2/40 p-4 lg:block">
			{!hit ? (
				<p className="py-16 text-center text-sm text-fg-subtle">选中一个结果，在这里预览。</p>
			) : (
				<>
					<h3 className="mb-3 truncate text-sm font-medium">
						<Highlight text={(ready && state.data?.title) || hit.title || "未命名对话"} query={query} />
					</h3>
					{!ready || (!state.data && !state.error) ? (
						<p className="flex items-center gap-2 text-sm text-fg-subtle">
							<Spinner /> 正在载入预览…
						</p>
					) : state.error ? (
						<p role="alert" data-testid="search-preview-error" className="text-sm text-fg-muted">
							{state.error.message}
						</p>
					) : (
						<ol className="space-y-3" data-testid="search-preview-turns">
							{state.data!.turns.length === 0 ? <li className="text-sm text-fg-subtle">这个对话还没有消息。</li> : null}
							{state.data!.turns.map((t) => (
								<li
									key={t.entryId}
									data-testid="preview-turn"
									data-role={t.role}
									data-hit={t.entryId === hit.entryId || undefined}
									className={cn("rounded-lg px-3 py-2 text-[13px] leading-relaxed", t.role === "user" ? "ml-6 bg-surface-3" : "mr-6 bg-surface", t.entryId === hit.entryId && "ring-2 ring-info")}
								>
									<span className="mb-0.5 block text-xs text-fg-subtle">{t.role === "user" ? "你" : "助手"}</span>
									<span className="line-clamp-6 whitespace-pre-wrap break-words">
										<Highlight text={t.text} query={query} />
									</span>
								</li>
							))}
						</ol>
					)}
				</>
			)}
		</aside>
	);
}
