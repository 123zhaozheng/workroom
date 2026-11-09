// Module registration order (owner: integrator). Groups add their module export here via the integrator,
// or append one line in their own marked slot below. Order matters only for init (service provision).
import type { WorkroomModule } from "./core/contracts.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { identityModule } from "./identity/module.ts";

export async function loadModules(): Promise<WorkroomModule[]> {
	const mods: WorkroomModule[] = [identityModule];
	// Optional modules are loaded if present so groups can land independently.
	const optional = [
		"./ops/module.ts", // E: models, usage, budgets, automation, admin, stats
		"./files/module.ts", // D: files, versions, previews
		"./tools/module.ts", // D: MCP, skills, sandbox, browser
		"./knowledge/module.ts", // C: knowledge, retrieval, memory
		"./runtime/module.ts", // A: pi-durable harness owner, conversations, branches, subagents (installs every module's extensions)
	];
	for (const path of optional) {
		// Skip only when the module file itself is absent; any error inside a present module is fatal (never silently disable a module).
		if (!existsSync(fileURLToPath(new URL(path, import.meta.url)))) continue;
		const m = await import(path);
		for (const v of Object.values(m)) if (v && typeof v === "object" && "name" in v && ("init" in v || "routes" in v || "migrations" in v)) mods.push(v as WorkroomModule);
	}
	return mods;
}
