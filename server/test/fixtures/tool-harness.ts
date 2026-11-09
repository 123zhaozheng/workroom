// Standalone pi-durable harness for testing D's tools through the real tool task machinery (faux model plays the
// model and emits tool calls). The acting principal is re-resolved from current identity/ACL on every call, as the
// runtime does. Used until/alongside A's runtime e2e tests.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AppContext, ToolActor } from "../../src/core/contracts.ts";
import { HttpError } from "../../src/core/http.ts";

export const context = BACKGROUND_CONTEXT;

/** Actor resolver bound to one user and space; re-checks current ACL (write on the space) like runtime.actorForTool. */
export function fixedActor(ctx: AppContext, userId: string, orgId: string, spaceId: string) {
	return async (api: ToolExecutionApi<any>): Promise<ToolActor> => {
		const principal = await ctx.services.get("identity").principalFor(userId, orgId);
		if (!principal) throw new HttpError(403, "forbidden", "revoked");
		const space = ctx.services.get("identity").space(spaceId)!;
		const d = await ctx.services.get("acl").check(principal, "read", { kind: "space", id: spaceId });
		if (!d.allow) throw new HttpError(403, "forbidden", `工具调用被拒绝（${d.reason}）`);
		return { principal, space, conversationId: Number(api.conversationId), taskId: Number(api.taskId), callId: api.callId };
	};
}

export const call = (name: string, args: Record<string, unknown>, id: string): AssistantMessage => fauxAssistantMessage([fauxToolCall(name, args as any, { id })], { stopReason: "toolUse" });
export const answer = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)]);

export async function toolHarness(extensions: Extension[], responses: AssistantMessage[]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const registry = createRegistry();
	for (const e of extensions) registry.install(e);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return {
		harness,
		root,
		async run(text: string) {
			const s = await root.submit({ type: "input", content: text }, context);
			return s.wait(context);
		},
		/** Tool results of the conversation, oldest first. */
		async results(): Promise<{ name: string; isError: boolean; text: string; details: any }[]> {
			const page = await root.entries({}, 200, undefined, context);
			return [...page.items]
				.reverse()
				.filter((e) => ToolResultEntry.is(e))
				.map((e: any) => {
					const m = e.model[0] as ToolResultMessage;
					return { name: m.toolName, isError: !!m.isError, text: m.content.map((c: any) => (c.type === "text" ? c.text : "")).join(""), details: (m as any).details ?? e.data?.details };
				});
		},
		close: () => harness.close(context),
	};
}

/** A minimal ToolExecutionApi stand-in for invoking `execute()` directly (replay tests). */
export function fakeApi(ids: { conversationId: number; taskId: number; callId: string }): ToolExecutionApi<any> {
	return {
		...ids,
		output() {},
		diagnostic() {},
		async details() {},
		env: undefined,
	} as unknown as ToolExecutionApi<any>;
}
