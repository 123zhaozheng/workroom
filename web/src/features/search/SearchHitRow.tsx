// One search result: title (match marked), project, tags, snippet (match marked) and where it matched. Used by the Ctrl/Cmd+K modal and /search.
import { FolderClosed, Star, Users } from "lucide-react";
import type { HTMLAttributes } from "react";
import type { SearchHitDTO } from "@shared/round9";
import { cn, relTime } from "@/lib/utils";
import { Highlight } from "./Highlight";

export const MATCH_LABEL: Record<SearchHitDTO["matchedIn"][number], string> = { title: "标题", message: "消息", tag: "标签", project: "项目" };

export function SearchHitBody({ hit, query }: { hit: Pick<SearchHitDTO, "title" | "projectName" | "tags" | "starred" | "matchedIn" | "snippet" | "updatedAt" | "access">; query: string }) {
	return (
		<>
			<div className="flex items-center gap-2">
				<span className="min-w-0 truncate text-sm font-medium">
					<Highlight text={hit.title || "未命名对话"} query={query} />
				</span>
				{hit.starred ? <Star aria-label="已星标" className="size-3.5 shrink-0 fill-current text-fg-muted" /> : null}
				{hit.projectName ? (
					<span className="inline-flex min-w-0 max-w-[40%] shrink items-center gap-1 rounded-md bg-surface-3 px-1.5 text-xs text-fg-muted">
						<FolderClosed aria-hidden className="size-3 shrink-0" />
						<span className="truncate">
							<Highlight text={hit.projectName} query={query} />
						</span>
					</span>
				) : null}
				{hit.access === "shared" ? (
					<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-info-soft px-1.5 text-xs text-info">
						<Users aria-hidden className="size-3" />
						共享
					</span>
				) : null}
				<span className="ml-auto shrink-0 text-xs text-fg-subtle">{relTime(hit.updatedAt)}</span>
			</div>
			{hit.snippet ? (
				<p className="mt-0.5 line-clamp-2 break-words text-[13px] text-fg-muted">
					<Highlight text={hit.snippet} query={query} />
				</p>
			) : null}
			{hit.matchedIn.length || hit.tags.length ? (
				<div className="mt-1 flex flex-wrap items-center gap-1">
					{hit.matchedIn.map((m) => (
						<span key={m} data-testid="match-badge" data-match={m} className="rounded bg-surface-2 px-1.5 text-xs text-fg-muted ring-1 ring-inset ring-border">
							{MATCH_LABEL[m]}
						</span>
					))}
					{hit.tags.slice(0, 4).map((t) => (
						<span key={t} className="text-xs text-fg-subtle">
							#<Highlight text={t} query={query} />
						</span>
					))}
				</div>
			) : null}
		</>
	);
}

export function SearchHitOption({ hit, query, active, id, onOpen, onActivate, ...rest }: { hit: SearchHitDTO; query: string; active: boolean; id: string; onOpen: () => void; onActivate: () => void } & Omit<HTMLAttributes<HTMLDivElement>, "onClick">) {
	return (
		<div
			{...rest}
			id={id}
			role="option"
			aria-selected={active}
			data-testid="search-result"
			data-active={active || undefined}
			data-conv={`${hit.spaceId}/${hit.conversationId}`}
			onMouseMove={onActivate}
			onClick={onOpen}
			className={cn("cursor-pointer rounded-lg px-3 py-2", active ? "bg-surface-3" : "hover:bg-surface-2")}
		>
			<SearchHitBody hit={hit} query={query} />
		</div>
	);
}
