// Runs every browser check in sequence (each starts its own server on its own port with a fresh data dir).
// Prerequisite: npm run -w web build.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ["core-loop.mjs", "states.mjs"]) {
	console.log(`\n=== ${f}`);
	const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
	if (r.status !== 0) failed++;
}
process.exitCode = failed ? 1 : 0;
