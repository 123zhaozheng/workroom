// Resolve who a running tool call acts for (runtime owns the run → principal mapping; we re-check ACL per call).
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AppContext, ToolActor } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";

export type ActorResolver = (api: ToolExecutionApi<any>, context: Context) => Promise<ToolActor>;

/** `…/orgs/<org>/spaces/<spaceId>/…` → spaceId (fallback when the runtime cannot tell us directly). */
export function spaceIdFromPath(p: string | undefined): string | undefined {
	return p ? /\/spaces\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(p)?.[1] : undefined;
}

/**
 * Default resolver: runtime.actorForToolCall(api) when available; else runtime.actorForTool(api, spaceId) where the space
 * comes from runtime.spaceIdForTool(api), the environment cwd, or "" (A's runtime then reads its per-storage space doc).
 */
export function runtimeActorResolver(ctx: AppContext): ActorResolver {
	return async (api, context) => {
		if (!ctx.services.has("runtime")) throw new HttpError(503, "runtime_unavailable", "运行内核未就绪，无法确定工具调用的用户");
		const rt = ctx.services.get("runtime") as any;
		if (typeof rt.actorForToolCall === "function") return rt.actorForToolCall(api, context);
		let spaceId: string | undefined;
		if (typeof rt.spaceIdForTool === "function") spaceId = await rt.spaceIdForTool(api, context);
		spaceId ??= spaceIdFromPath(api.env?.cwd);
		return rt.actorForTool(api, spaceId ?? "", context);
	};
}

/** Idempotency key of an agent write: stable across replays of the same tool call. */
export function toolCallKey(actor: ToolActor, purpose = "write"): string {
	return `tool:${actor.conversationId}:${actor.taskId}:${actor.callId}:${purpose}`;
}
