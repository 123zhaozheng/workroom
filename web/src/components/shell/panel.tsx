// One right-hand panel at a time: either a deliverable preview or the shared work panel
// (terminal / browser / subagents). Wide screens show it as a column; narrow screens use a drawer.
import type { WorkTabId } from "@shared/sandbox";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface PreviewTarget {
	fileId: string;
	versionId?: string;
	name?: string;
	mime?: string;
}
/** "tasks" | "terminal" | "files" | "browser" (shared/sandbox.ts is the single definition). */
export type WorkTab = WorkTabId;
export type PanelState =
	| { kind: "preview"; target: PreviewTarget }
	| { kind: "work"; tab: WorkTab; spaceId: string; conversationId: number }
	| null;

interface PanelCtx {
	panel: PanelState;
	openPreview: (t: PreviewTarget) => void;
	openWork: (tab: WorkTab, spaceId: string, conversationId: number) => void;
	close: () => void;
}
const Ctx = createContext<PanelCtx | null>(null);

export function PanelProvider({ children }: { children: ReactNode }) {
	const [panel, setPanel] = useState<PanelState>(null);
	const openPreview = useCallback((target: PreviewTarget) => setPanel({ kind: "preview", target }), []);
	const openWork = useCallback((tab: WorkTab, spaceId: string, conversationId: number) => setPanel({ kind: "work", tab, spaceId, conversationId }), []);
	const close = useCallback(() => setPanel(null), []);
	const v = useMemo(() => ({ panel, openPreview, openWork, close }), [panel, openPreview, openWork, close]);
	return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function usePanel(): PanelCtx {
	const c = useContext(Ctx);
	if (!c) throw new Error("PanelProvider missing");
	return c;
}
