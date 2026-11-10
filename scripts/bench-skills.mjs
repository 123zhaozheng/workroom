#!/usr/bin/env node
// Skills-vs-sandbox latency bench. Runs the app in-process (temp data dir) and measures, per installed-skill count N:
//   cold sandbox run (mount cache emptied), warm median/p95, mount-plan cost, mounts actually passed to the driver.
// Usage: node --disable-warning=ExperimentalWarning scripts/bench-skills.mjs [--skills 0,5,32,40] [--runs 12] [--out file] [--root dir]
// Must be run with Node >= 22.18 (native TS stripping). Degrades gracefully: any metric whose API is missing is recorded as null + a note.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir, cpus, loadavg, platform, release } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const skillCounts = arg("skills", "0,5,32,40").split(",").map(Number);
const runs = Math.max(10, Number(arg("runs", "12")));
const root = resolve(arg("root", join(dirname(fileURLToPath(import.meta.url)), "..")));
const out = arg("out", join(root, "artifacts/bench/skills-bench.json"));
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const notes = [];
const pct = (a, p) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

const { startTestApp } = await imp("server/test/helpers/app.ts");

const skillFiles = (i) => [
	{ path: "SKILL.md", content: `---\nname: bench-skill-${i}\ndescription: Bench skill number ${i}; used only to measure sandbox mount cost.\nversion: 1.0.0\n---\n\n# Bench ${i}\n\nRun scripts/run.py.\n` },
	{ path: "scripts/run.py", content: `print("bench ${i}")\n` },
	{ path: "references/notes.md", content: `# notes ${i}\n${"lorem ipsum ".repeat(50)}\n` },
];

async function measureOne(N) {
	const t = await startTestApp();
	const res = { skills: N, ok: false, notes: [] };
	try {
		const email = `bench-${N}-${Date.now()}@example.com`;
		const u = await t.user(email);
		const ctx = t.app.ctx;
		for (let i = 0; i < N; i++) {
			const r = await t.req("POST", "/api/market/skills/upload", { token: u.token, json: { files: skillFiles(i) } });
			if (r.status !== 200) throw new Error(`upload ${i} -> ${r.status} ${await r.text()}`);
		}
		const identity = ctx.services.get("identity");
		const principal = await identity.principalFor(u.me.userId, u.me.orgId);
		const space = identity.personalSpace(u.me.userId, u.me.orgId);
		const sb = ctx.services.get("sandbox");
		const caps = await sb.capabilities();
		res.driver = { id: caps.driver, state: caps.state, label: caps.label, detail: caps.detail, mounts: caps.mounts };
		if (caps.state !== "ready") {
			res.notes.push(`sandbox driver not ready (${caps.driver}/${caps.state}); sandbox latencies not measured`);
		}

		// active skills + mount plan cost (cold = cache emptied, then warm)
		const mountsDir = join(t.dataDir, "sandbox-mounts", "skills");
		const market = ctx.services.has("market") ? ctx.services.get("market") : null;
		const skillsSvc = ctx.services.has("skills") ? ctx.services.get("skills") : null;
		if (skillsSvc?.active) {
			const t0 = performance.now();
			const act = await skillsSvc.active(principal, space);
			res.activeSkills = act.length;
			res.activeMs = r1(performance.now() - t0);
		} else res.notes.push("skills.active unavailable");
		if (market?.mountPlan) {
			rmSync(mountsDir, { recursive: true, force: true });
			let t0 = performance.now();
			const plan = await market.mountPlan(principal, space);
			res.mountPlanColdMs = r1(performance.now() - t0);
			res.mountPlanMounts = plan.length;
			const w = [];
			for (let i = 0; i < 10; i++) {
				t0 = performance.now();
				await market.mountPlan(principal, space);
				w.push(performance.now() - t0);
			}
			res.mountPlanWarmMedianMs = r1(pct(w, 50));
		} else res.notes.push("market.mountPlan unavailable (API changed?)");

		// mounts actually handed to the driver: wrap the driver's run
		let seenMounts = null;
		try {
			const drv = await sb.drivers.resolve();
			const d = drv.driver;
			const orig = d.run.bind(d);
			d.run = (spec) => {
				seenMounts = (spec.mounts ?? []).filter((m) => String(m.target).startsWith("/skills/")).length;
				return orig(spec);
			};
		} catch (e) {
			res.notes.push(`driver mount probe failed: ${e.message}`);
		}

		if (caps.state === "ready") {
			const runOnce = async () => {
				const t0 = performance.now();
				const r = await sb.run({ principal, space, conversationId: 1, language: "shell", code: "echo ok" });
				const ms = performance.now() - t0;
				if (r.status !== "ok" && r.status !== "success" && r.exitCode !== 0) throw new Error(`run failed: ${r.status} ${r.stderr}`);
				return ms;
			};
			rmSync(mountsDir, { recursive: true, force: true });
			res.coldMs = r1(await runOnce());
			res.mountsPassedToDriver = seenMounts;
			const warm = [];
			for (let i = 0; i < runs; i++) warm.push(await runOnce());
			res.warm = { runs, medianMs: r1(pct(warm, 50)), p95Ms: r1(pct(warm, 95)), minMs: r1(Math.min(...warm)), maxMs: r1(Math.max(...warm)) };
			res.mountsPassedToDriver = seenMounts;
			res.mountDirsOnDisk = existsSync(mountsDir) ? readdirSync(mountsDir).filter((n) => !n.includes(".tmp-")).length : 0;
		}
		res.ok = true;
	} catch (e) {
		res.error = String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ");
	} finally {
		await t.dispose().catch(() => {});
	}
	return res;
}

const results = [];
for (const N of skillCounts) {
	const r = await measureOne(N);
	results.push(r);
	console.error(`N=${N}: ${r.ok ? "ok" : "ERR " + r.error}`);
}

let commit = null;
try { commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(); } catch {}
let uptime = null;
try { uptime = execSync("uptime").toString().trim(); } catch {}
const doc = {
	kind: "skills-bench",
	date: new Date().toISOString(),
	commit,
	conditions: { node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model, platform: `${platform()} ${release()}`, loadavg: loadavg(), uptime, driver: results.find((r) => r.driver)?.driver ?? null, runsPerPoint: runs },
	note: "System-prompt/tool-list size not applicable to the baseline (skills are not in the prompt there); future code may add promptBytes.",
	results,
	notes,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");

const cell = (v) => String(v ?? "-").padStart(9);
console.log(["skills", "active", "mounts->drv", "mountPlan cold", "mountPlan warm", "run cold ms", "warm med", "warm p95"].map((h) => h.padStart(9)).join(" "));
for (const r of results) console.log([r.skills, r.activeSkills, r.mountsPassedToDriver, r.mountPlanColdMs, r.mountPlanWarmMedianMs, r.coldMs, r.warm?.medianMs, r.warm?.p95Ms].map(cell).join(" "), r.error ? "ERR " + r.error : "", ...(r.notes ?? []));
console.log("driver:", JSON.stringify(doc.conditions.driver), "| cpus", doc.conditions.cpus, "| node", process.version, "|", uptime);
console.log("wrote", out);
process.exit(0);
