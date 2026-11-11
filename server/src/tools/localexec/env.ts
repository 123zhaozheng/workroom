// Round 11 (R4): adds the optional `local` block (organisation switch, tab connected, conversation preference) to a ConversationEnvironmentDTO.
import type { AppContext, Principal } from "../../core/contracts.ts";
import type { ConversationEnvironmentDTO } from "../../../../shared/sandbox.ts";
import type { LocalExec } from "./service.ts";

export function withLocal(ctx: AppContext, p: Principal, spaceId: string, conversationId: number, dto: ConversationEnvironmentDTO): ConversationEnvironmentDTO {
	if (!ctx.services.has("localExec")) return dto;
	return { ...dto, local: (ctx.services.get("localExec") as LocalExec).status(p, spaceId, conversationId) };
}
