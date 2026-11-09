#!/usr/bin/env node
// Cross-platform source backup (Windows, macOS, Linux): git bundle (full history) + zip of the tracked working tree into artifacts/backups/,
// keeping the last 5 of each. Same output as scripts/backup.sh. The data volume is backed up separately (docs/operations.md): it holds user data.
//   node scripts/backup.mjs [--keep N] [--out DIR]
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const keep = Math.max(1, Number(opt("--keep", 5)) || 5);
const out = resolve(root, opt("--out", join("artifacts", "backups")));

function git(...a) {
	const r = spawnSync("git", a, { cwd: root, encoding: "utf8", windowsHide: true });
	if (r.error) {
		console.error(`cannot run git: ${r.error.message}. Install Git (https://git-scm.com/downloads) and make sure it is on PATH.`);
		process.exit(1);
	}
	if (r.status !== 0) {
		console.error(`git ${a.join(" ")} failed:\n${r.stderr || r.stdout}`);
		process.exit(r.status ?? 1);
	}
	return r.stdout.trim();
}

const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261109T025135Z
mkdirSync(out, { recursive: true });
const bundle = join(out, `workroom-${ts}.bundle`);
git("bundle", "create", bundle, "--all");
git("archive", "--format=zip", "-o", join(out, `workroom-src-${ts}.zip`), "HEAD");
const head = git("rev-parse", "HEAD");
writeFileSync(join(out, `workroom-${ts}.HEAD`), `${head}\n`);

// Keep the newest N of each kind (names sort chronologically).
for (const re of [/^workroom-\d{8}T\d{6}Z\.bundle$/, /^workroom-src-\d{8}T\d{6}Z\.zip$/, /^workroom-\d{8}T\d{6}Z\.HEAD$/]) {
	const files = readdirSync(out).filter((f) => re.test(f)).sort().reverse();
	for (const f of files.slice(keep)) rmSync(join(out, f), { force: true });
}
console.log(`backup: ${bundle} (${git("rev-parse", "--short", "HEAD")}, ${(statSync(bundle).size / 1048576).toFixed(1)} MB)`);
