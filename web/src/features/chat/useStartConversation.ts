import { useNavigate } from "react-router";
import type { ConversationSummary, SendMessageResponse } from "@shared/chat";
import { post, uuid } from "@/lib/api";
import type { ComposerSubmit } from "./Composer";

/** Create a conversation in a space/project, send the first message (idempotent requestId), open it. */
export function useStartConversation() {
	const navigate = useNavigate();
	return async (v: ComposerSubmit, opts: { spaceId?: string; projectId?: string; modelId?: string; assistantId?: string }) => {
		const { conversation } = await post<{ conversation: ConversationSummary }>("/conversations", {
			...(opts.spaceId && !opts.projectId ? { spaceId: opts.spaceId } : {}),
			...(opts.projectId ? { projectId: opts.projectId } : {}),
			// model: explicit option, else what the composer's switcher chose; an assistant brings its own default model
			...(!opts.assistantId && (opts.modelId ?? v.modelId) ? { modelId: opts.modelId ?? v.modelId } : {}),
			...(!opts.assistantId && v.thinkingLevel ? { thinkingLevel: v.thinkingLevel } : {}),
			...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
			// Round 17: an @-mentioned expert on the home composer becomes the conversation's expert (model rule: the server decides; see docs/r17-experts.md)
			...(v.expertId && !opts.assistantId ? { expertId: v.expertId } : {}),
			// no client title: the server derives it from the first message (directives stripped)
		});
		const requestId = v.requestId || uuid();
		await post<SendMessageResponse>(`/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, {
			text: v.text,
			requestId,
			...(v.attachments.length ? { attachments: v.attachments } : {}),
			...(v.knowledgeRefs.length ? { knowledgeRefs: v.knowledgeRefs } : {}),
			...(v.expertId ? { expertId: v.expertId } : {}), // the first message shows who answers (the chip)
			mode: "auto",
		});
		navigate(`/c/${conversation.spaceId}/${conversation.conversationId}`);
		return true;
	};
}
