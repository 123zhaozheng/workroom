import { useNavigate } from "react-router";
import type { ConversationSummary, SendMessageResponse } from "@shared/chat";
import { post, uuid } from "@/lib/api";
import type { ComposerSubmit } from "./Composer";

/** Create a conversation in a space/project, send the first message (idempotent requestId), open it. */
export function useStartConversation() {
	const navigate = useNavigate();
	return async (v: ComposerSubmit, opts: { spaceId?: string; projectId?: string; modelId?: string }) => {
		const { conversation } = await post<{ conversation: ConversationSummary }>("/conversations", {
			...(opts.spaceId && !opts.projectId ? { spaceId: opts.spaceId } : {}),
			...(opts.projectId ? { projectId: opts.projectId } : {}),
			...(opts.modelId ? { modelId: opts.modelId } : {}),
			title: v.text.slice(0, 40) || v.attachments[0]?.name || "新对话",
		});
		const requestId = uuid();
		await post<SendMessageResponse>(`/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, {
			text: v.text,
			requestId,
			...(v.attachments.length ? { attachments: v.attachments } : {}),
			...(v.knowledgeRefs.length ? { knowledgeRefs: v.knowledgeRefs } : {}),
			mode: "auto",
		});
		navigate(`/c/${conversation.spaceId}/${conversation.conversationId}`);
		return true;
	};
}
