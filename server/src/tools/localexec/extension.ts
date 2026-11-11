// Round 11 (R4): the code_run tool (pi-durable extension "wr.localexec"). One entry point; the backend is chosen by LocalExec.run().
// Replay "unsafe" like sandbox_exec: a crash mid-run gives the model an `interrupted` result instead of running the code again.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { AppContext } from "../../core/contracts.ts";
import { runtimeActorResolver, type ActorResolver } from "../../files/actor.ts";
import type { ToolCallLog } from "../calls.ts";
import { MAX_TIMEOUT_MS } from "../sandbox.ts";
import { requirePermission } from "../sandbox/perm.ts";
import { LocalExec } from "./service.ts";

export const CODE_RUN_DESCRIPTION =
	"Run a short JavaScript or Python snippet; the platform picks where: quick pure computation runs in the user's browser, anything needing network, packages, a shell or a long runtime runs in the cloud sandbox (automatic; the result says which one ran and why). " +
	"Prefer code_run for quick calculations, data transforms and small file conversions; use sandbox_exec for shell commands, package installs, network access, services or long jobs. " +
	"JavaScript is the body of an async function: use `files.read(path)` / `files.write(path, text|bytes)` / `files.list()` for workspace files (read only the paths you list in `inputs` when it runs in the browser), console.log for output, `return` a JSON-able value. " +
	"Python is a normal script reading and writing files in the working directory. Files written land in the sandbox working directory. Pass backend \"cloud\" to force the cloud sandbox.";

export function createLocalExecExtension(ctx: AppContext, opts: { resolveActor?: ActorResolver } = {}) {
	const resolve = opts.resolveActor ?? runtimeActorResolver(ctx);
	const svc = () => ctx.services.get("localExec") as LocalExec;
	const log = () => ctx.services.get("toolCalls") as ToolCallLog;
	const codeRun = defineTool({
		name: "code_run",
		description: CODE_RUN_DESCRIPTION,
		parameters: obj({
			language: oneOf(["javascript", "python"]),
			code: str({ minLength: 1 }),
			inputs: opt(arr(str(), { maxItems: 20 })),
			timeoutSec: opt(int({ minimum: 1, maximum: MAX_TIMEOUT_MS / 1000 })),
			backend: opt(oneOf(["auto", "cloud"])),
		}),
		replay: "unsafe",
		executionMode: "sequential",
		async execute(args, api, context: Context) {
			const actor = await resolve(api, context);
			const summary = { language: args.language, code: args.code.length > 400 ? `${args.code.slice(0, 400)}…` : args.code, inputs: args.inputs, timeoutSec: args.timeoutSec, backend: args.backend };
			const report = await log().around(
				{ tool: "code_run", actor, args: summary },
				async () => {
					await requirePermission(ctx, actor.principal, "sandbox.use");
					await ctx.services.get("acl").require(actor.principal, "write", { kind: "space", id: actor.space.id });
					return svc().run({ actor, args: args as never, signal: context.abortSignal });
				},
				(r) => `${r.backend} ${r.status} ${r.reason}${r.upgraded ? " upgraded" : ""}`, // parsed by sandbox/lifecycle-stats.ts (R6): backend first, " upgraded" last
			);
			return {
				output: [{ type: "text", text: LocalExec.text(report) }],
				isError: report.status !== "ok",
				details: { localExec: { backend: report.backend, reason: report.reason, upgraded: !!report.upgraded, ...(report.cloudRunId ? { runId: report.cloudRunId } : {}) } },
			};
		},
	});
	return defineExtension({ name: "wr.localexec", tools: [codeRun] });
}
