// Runs every browser check in sequence (each starts its own server on its own port with a fresh data dir).
// Prerequisite: npm run -w web build.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ["core-loop.mjs", "states.mjs", "pages.mjs", "round2.mjs", "round3-runtime.mjs", "round3-knowledge.mjs", "round3-org.mjs", "integrator-m02c.mjs", "round4-chat.mjs", "round4-rbac.mjs", "round4-sandbox.mjs", "round4-stats.mjs", "round4-market.mjs", "round5-g1.mjs", "round5-g3.mjs", "round5-g2.mjs", "round5-g4.mjs", "round6-skills.mjs", "round7-sandbox.mjs", "round7b.mjs", "round8-chat.mjs", "round8-ui.mjs", "round9-onboarding.mjs", "round9-library.mjs", "round9-shell.mjs", "round10-chat-ux.mjs", "round10-daytona.mjs", "round10-stop.mjs"]) {
	console.log(`\n=== ${f}`);
	const r = spawnSync(process.execPath, [join(here, f)], { stdio: "inherit" });
	if (r.status !== 0) failed++;
}
process.exitCode = failed ? 1 : 0;
