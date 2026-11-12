// Round 14: the browser execution path (round 11 code_run) is gone. Tasks persisted by older conversations may still reference `code_run`;
// this tiny extension keeps the tool resolvable so such a task reaches a terminal (error) state instead of being orphaned. It executes nothing
// and is listed in LEGACY_EXTENSIONS, so NEW conversations never see it.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";

export const CODE_RUN_REMOVED = "浏览器执行已移除，这一步没有执行";

export function createLegacyCodeRunExtension() {
	const codeRun = defineTool({
		name: "code_run",
		description: "Removed legacy tool: always returns an error and executes nothing. Use exec.",
		// Lenient: arguments of a persisted call (round 11 shape) must still validate so the call reaches execute().
		parameters: obj({ language: opt(str()), code: opt(str()), inputs: opt(arr(str())), timeoutSec: opt(int()), backend: opt(str()) }),
		replay: "safe",
		executionMode: "sequential",
		async execute() {
			return { output: [{ type: "text", text: CODE_RUN_REMOVED }], isError: true, details: { legacy: "code_run_removed" } };
		},
	});
	return defineExtension({ name: "wr.localexec", tools: [codeRun] });
}
