// One right-hand panel at a time: either a deliverable preview or the shared work panel
// (outputs / subtasks / browser). Wide screens show it as a column; narrow screens use a drawer.
import type { ConversationWorkDTO } from "@shared/files";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface PreviewTarget {
	fileId: string;
	/**
	 * Only for files that really are pinned to a revision (chat uploads, knowledge citations). Delivered outputs have no version:
	 * they are previewed by fileId and always show the current content.
	 */
	versionId?: string;
	name?: string;
	mime?: string;
	size?: number;
	/** Content hash of the current file: the preview URL is cache-busted with it, so an overwrite never shows stale content. */
	etag?: string;
}
export type PanelState =
	| { kind: "preview"; target: PreviewTarget }
	| { kind: "work"; spaceId: string; conversationId: number }
	| null;

interface PanelCtx {
	panel: PanelState;
	openPreview: (t: PreviewTarget) => void;
	openWork: (spaceId: string, conversationId: number) => void;
	close: () => void;
	/** The open conversation's live work snapshot (outputs, jobs, browser sessions), published by the chat page from its SSE state. */
	work: ConversationWorkDTO | undefined;
	publishWork: (w: ConversationWorkDTO | undefined) => void;
}
const Ctx = createContext<PanelCtx | null>(null);

export function PanelProvider({ children }: { children: ReactNode }) {
	const [panel, setPanel] = useState<PanelState>(null);
	const openPreview = useCallback((target: PreviewTarget) => setPanel({ kind: "preview", target }), []);
	const openWork = useCallback((spaceId: string, conversationId: number) => setPanel({ kind: "work", spaceId, conversationId }), []);
	const close = useCallback(() => setPanel(null), []);
	const [work, publishWork] = useState<ConversationWorkDTO>();
	const v = useMemo(() => ({ panel, openPreview, openWork, close, work, publishWork }), [panel, openPreview, openWork, close, work]);
	return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function usePanel(): PanelCtx {
	const c = useContext(Ctx);
	if (!c) throw new Error("PanelProvider missing");
	return c;
}
