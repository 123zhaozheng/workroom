// An "old" conversation: created the way conversations of rounds ≤ 13 were, i.e. WITHOUT the round 14 removal of the legacy
// extensions/tools (wr.files, wr.sandbox, memory_save, skill …). Used by tests that cover how older conversations keep working.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TestApp } from "./app.ts";

export async function oldConversation(t: TestApp, userId: string, orgId: string, title: string): Promise<{ spaceId: string; conversationId: number }> {
	const rt = t.app.ctx.services.get("runtime") as any;
	const space = t.app.ctx.services.get("identity").personalSpace(userId, orgId);
	const principal = { userId, orgId } as any;
	const model = await rt.defaultModel(principal);
	const harness = await rt.manager.get(space.id);
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.modelId } } }, BACKGROUND_CONTEXT);
	const now = new Date().toISOString();
	t.app.ctx.db.run("INSERT INTO rt_conversations (space_id, conversation_id, created_by, title, project_id, kind, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'chat', 0, ?, ?)", space.id, conv.id as number, userId, title, space.projectId ?? null, now, now);
	return { spaceId: space.id, conversationId: conv.id as number };
}
