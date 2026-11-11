// What the sidebar tree passes down to its rows.
import type { ConversationSummary } from "@shared/chat";
import type { ConvMeta, UiProject } from "@/features/projects/model";

export interface TreeCtx {
	meId?: string;
	projects: readonly UiProject[];
	projectById: ReadonlyMap<string, UiProject>;
	/** Own container projects (targets of 移至项目). */
	moveTargets: readonly UiProject[];
	metaOf: (c: ConversationSummary) => ConvMeta;
	onNavigate?: () => void;
	/** Run a real API call; a failure is shown in the sidebar and the lists are refreshed either way. */
	run: (fn: () => Promise<unknown>, opts?: { optimistic?: () => void; revert?: () => void }) => Promise<boolean>;
	/** Optimistic local patches (the real answer replaces them on the next refresh). */
	patchConv: (key: string, patch: Partial<ConversationSummary>) => void;
	patchMeta: (key: string, patch: Partial<ConvMeta>) => void;
	openProject: (id: string) => void;
	reload: () => void;
}
