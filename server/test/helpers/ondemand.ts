// Round 16: a new conversation does not offer the on-demand tools (credential_*, job_*, browser_*, skill_manage, codemode) until tool_search loads
// them. Tests of those tools' own behaviour start from a conversation that offers everything, like a conversation created before round 16.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure } from "@earendil-works/pi-durable";
import type { TestApp } from "./app.ts";

export async function offerAllTools(t: TestApp, c: { spaceId: string; conversationId: number }): Promise<void> {
	const rt = t.app.ctx.services.get("runtime") as any;
	const h = await rt.harness(c.spaceId, BACKGROUND_CONTEXT);
	await h.commit((tx: any) => configure(tx, c.conversationId as any, { modelTools: null }), BACKGROUND_CONTEXT);
}
