// 文件库 / 知识库 layout on wide screens: the app sidebar (shell) · a resource list · a detail / preview panel.
// Each column scrolls on its own; on narrow screens the pages do not use this (list page → detail page).
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SplitLayout({ label, list, detail, className }: { label: string; list: ReactNode; detail: ReactNode; className?: string }) {
	return (
		<div data-testid="split-layout" className={cn("flex min-h-0 flex-1 border-t border-border", className)}>
			<section aria-label={label} data-testid="split-list" className="flex w-[clamp(300px,32%,380px)] shrink-0 flex-col border-r border-border">
				{list}
			</section>
			<section data-testid="split-detail" className="wr-scroll min-w-0 flex-1 overflow-y-auto bg-bg">
				{detail}
			</section>
		</div>
	);
}
