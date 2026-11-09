#!/usr/bin/env node
// Demo data for the statistics page (docs/stats.md §6). Creates a SEPARATE org flagged `demo` (ops_demo_orgs) and fills it:
//   1. real activity today, driven through the real HTTP API with the fixture "test model" (conversations, replies, a failure,
//      a timeout), imported into the ledger by the normal usage import;
//   2. a deterministic 365-day backfill written straight into the DB, every ledger row marked usage_ledger.demo = 1 and
//      fixture = 1 (simulated: tokens are labelled 模拟, cost is 0), other rows tagged 'demo-backfill'.
// Real orgs are never touched: every row carries the demo org's id, and the stats API filters demo=1 rows out of real orgs.
//
//   node scripts/seed-demo.mjs [--base http://127.0.0.1:8864] [--data-dir data/dev-stats] [--days 365] [--seed 42]
//
// The server must be running (the API part) against --data-dir (the DB part). Re-running is safe: the backfill replaces the
// previous demo ledger / retrieval / automation rows. Backfilled file versions are append-only (DB triggers), so they are
// only created once; to start over completely delete the data dir.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { base: { type: "string", default: "http://127.0.0.1:8864" }, "data-dir": { type: "string", default: "data/dev-stats" }, days: { type: "string", default: "365" }, seed: { type: "string", default: "42" }, "skip-live": { type: "boolean", default: false } } });
const BASE = args.base.replace(/\/$/, "");
const DAYS = Math.max(7, Math.min(800, Number(args.days)));
const DEMO_EMAIL = "demo-admin@demo.workroom.example";
const DEMO_PASSWORD = "demo-password-2026";
const TZ_MIN = 480; // the demo's "office" runs on UTC+8; backfilled hours are generated in that local time
const DAY = 86_400_000;

// ------------------------------------------------------------------ http
async function api(method, path, { token, json, expect = [200] } = {}) {
	const res = await fetch(`${BASE}/api${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
	const text = await res.text();
	if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureUser({ email, name, inviteCode, orgName }) {
	const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name, password: DEMO_PASSWORD, inviteCode, orgName }) });
	if (reg.status === 200) return await reg.json();
	const login = await api("POST", "/auth/login", { json: { email, password: DEMO_PASSWORD } });
	return login;
}

// ------------------------------------------------------------------ deterministic random
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = rng(Number(args.seed));
const pick = (arr, weights) => {
	if (!weights) return arr[Math.floor(rand() * arr.length)];
	let r = rand() * weights.reduce((s, w) => s + w, 0);
	for (let i = 0; i < arr.length; i++) if ((r -= weights[i]) <= 0) return arr[i];
	return arr[arr.length - 1];
};
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const logNormal = (median, sigma) => Math.round(median * Math.exp(sigma * normal()));
const poisson = (lambda) => {
	if (lambda <= 0) return 0;
	if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal()));
	const L = Math.exp(-lambda);
	let k = 0;
	let p = 1;
	do {
		k++;
		p *= rand();
	} while (p > L);
	return k - 1;
};
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------ model catalogue of the demo (all simulated)
const MODELS = [
	{ id: "demo-standard", route: "demo-gateway-a/std-1", median: 1600, tokIn: [900, 2600], tokOut: [200, 700], weight: 5 },
	{ id: "demo-fast", route: "demo-gateway-b/fast-1", median: 700, tokIn: [500, 1800], tokOut: [100, 450], weight: 4 },
	{ id: "demo-reasoning", route: "demo-gateway-a/reason-1", median: 4200, tokIn: [1500, 5000], tokOut: [600, 2200], weight: 2 },
	{ id: "demo-vision", route: "demo-gateway-c/vision-1", median: 2400, tokIn: [1200, 4000], tokOut: [200, 800], weight: 1 },
];
const TOOLS = [
	{ name: "kb_search", err: 0.02, dur: 420, w: 5 },
	{ name: "web_search", err: 0.05, dur: 1100, w: 4 },
	{ name: "file_write", err: 0.03, dur: 260, w: 3 },
	{ name: "python_exec", err: 0.1, dur: 1900, w: 3 },
	{ name: "browse", err: 0.13, dur: 2600, w: 2 },
	{ name: "read_file", err: 0.02, dur: 120, w: 3 },
	{ name: "calc", err: 0.01, dur: 40, w: 1 },
	{ name: "delegate", err: 0.07, dur: 5200, w: 1 },
];
// local-hour weights of a working day (peaks late morning and mid afternoon, a small evening tail)
const HOUR_W = [0.2, 0.1, 0.05, 0.05, 0.05, 0.1, 0.4, 1.2, 3.2, 5.5, 6.2, 5.0, 2.6, 3.6, 5.6, 5.8, 4.8, 3.4, 1.8, 1.2, 1.0, 0.9, 0.6, 0.35];

async function main() {
	const dataDir = resolve(args["data-dir"]);
	const db = new DatabaseSync(join(dataDir, "app.sqlite"));
	db.exec("PRAGMA busy_timeout = 8000;");
	const q = (sql, ...p) => db.prepare(sql).all(...p);
	const run = (sql, ...p) => db.prepare(sql).run(...p);

	// ---------------------------------------------------------------- 1. org, people, departments, projects (real API)
	const admin = await ensureUser({ email: DEMO_EMAIL, name: "演示管理员", orgName: "演示组织（Demo）" });
	const orgId = admin.me.orgId;
	const existing = q("SELECT 1 FROM ops_demo_orgs WHERE org_id = ?", orgId);
	if (!existing.length) run("INSERT INTO ops_demo_orgs (org_id, label, created_at) VALUES (?, ?, ?)", orgId, "演示数据", iso(Date.now()));
	console.log(`demo org ${orgId} flagged (ops_demo_orgs)`);
	const people = [{ email: DEMO_EMAIL, name: "演示管理员", token: admin.token, userId: admin.me.userId, rate: 6.5 }];
	const names = [
		["lin", "林悦"],
		["chen", "陈放"],
		["zhao", "赵宁"],
		["wang", "王一诺"],
		["sun", "孙启明"],
		["zhou", "周若"],
	];
	for (const [k, name] of names) {
		const email = `demo-${k}@demo.workroom.example`;
		const code = (await api("POST", "/admin/invites", { token: admin.token, json: { ttlHours: 24 } })).invite.code;
		const u = await ensureUser({ email, name, inviteCode: code });
		people.push({ email, name, token: u.token, userId: u.me.userId, rate: 2 + rand() * 6 });
	}
	for (const p of people) p.spaceId = (await api("GET", "/me", { token: p.token })).personalSpaceId;
	const deptNames = ["研发部", "市场部", "运营部"];
	const depts = [];
	for (const [i, dn] of deptNames.entries()) {
		let d = q("SELECT id FROM id_departments WHERE org_id = ? AND name = ?", orgId, dn)[0];
		if (!d) d = (await api("POST", "/admin/departments", { token: admin.token, json: { name: dn } })).department;
		depts.push(d.id);
		const members = people.filter((_, j) => j % 3 === i);
		for (const [j, m] of members.entries()) await api("PUT", `/admin/departments/${d.id}/members`, { token: admin.token, json: { userId: m.userId, role: j === 0 ? "manager" : "member" }, expect: [200, 409] }).catch(() => {});
		for (const m of members) m.dept = d.id;
	}
	const projects = [];
	for (const [i, pn] of ["季度报告", "客户知识库整理", "产品调研"].entries()) {
		let pr = q("SELECT p.id, s.id AS space_id FROM id_projects p JOIN id_spaces s ON s.project_id = p.id WHERE p.org_id = ? AND p.name = ?", orgId, pn)[0];
		if (!pr) {
			const created = (await api("POST", "/projects", { token: admin.token, json: { name: pn } })).project;
			pr = { id: created.id, space_id: created.spaceId };
			for (const m of people.slice(1).filter((_, j) => j % 3 === i || j % 2 === 0)) await api("PUT", `/projects/${created.id}/members`, { token: admin.token, json: { email: m.email, role: "editor" } }).catch(() => {});
		}
		const members = q("SELECT user_id FROM id_project_members WHERE project_id = ? AND removed_at IS NULL", pr.id).map((r) => r.user_id);
		projects.push({ id: pr.id, spaceId: pr.space_id, members });
	}

	// ---------------------------------------------------------------- 2. real activity today through the API (test model)
	if (!args["skip-live"]) {
		const send = async (p, spaceId, cid, text) => {
			const r = await api("POST", `/conversations/${spaceId}/${cid}/messages`, { token: p.token, json: { text, requestId: `seed-${randomBytes(5).toString("hex")}` } });
			for (let i = 0; i < 80; i++) {
				const s = await api("GET", `/conversations/${spaceId}/${cid}/submissions/${r.submissionId}`, { token: p.token });
				if (["done", "unanswered", "withdrawn"].includes(s.status)) return s.status;
				await sleep(250);
			}
			return "pending";
		};
		const scripts = [
			["请用三句话总结本周的项目进展", "[[reply 本周完成了接口联调与文档评审。]]"],
			["整理一份客户反馈摘要", "继续：补充三条改进建议"],
			["[[fail]] 这条请求会得到一次模型错误"],
			["[[fail timeout]] 上游超时示例"],
			["帮我写一段发布说明"],
		];
		let n = 0;
		for (const p of people.slice(0, 4)) {
			const space = pick([p.spaceId, projects.find((pr) => pr.members.includes(p.userId))?.spaceId ?? p.spaceId]);
			const conv = (await api("POST", "/conversations", { token: p.token, json: { spaceId: space, title: `演示对话 · ${p.name}` } })).conversation;
			for (const text of scripts[n % scripts.length]) await send(p, space, conv.conversationId ?? conv.id, text);
			n++;
		}
		await api("POST", "/admin/usage/import", { token: admin.token });
		console.log(`live: ${n} conversations driven through the API with the fixture model`);
	}

	// ---------------------------------------------------------------- 3. 365-day backfill (demo = 1, fixture = 1)
	run("DELETE FROM usage_ledger WHERE org_id = ? AND demo = 1", orgId);
	run("DELETE FROM kb_retrieval_events WHERE org_id = ? AND request_id = 'demo-backfill'", orgId);
	run("DELETE FROM auto_runs WHERE org_id = ? AND request_id LIKE 'demo-backfill:%'", orgId);
	const ledgerSql = `INSERT OR REPLACE INTO usage_ledger (id, kind, space_id, org_id, project_id, user_id, department_ids, conversation_id, entry_id, sub_key, task_id, outcome, platform_model_id, pi_provider, route, tool_name, input_tokens, output_tokens, cache_read, cache_write, total_tokens, cost, cost_from_provider, fixture, duration_ms, error_class, error_message, automation_id, at, imported_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, 'workroom', ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, NULL, NULL, ?, ?, 1)`;
	const ins = db.prepare(ledgerSql);
	const kbIns = db.prepare("INSERT INTO kb_retrieval_events (id, org_id, user_id, source, request_id, space_id, conversation_id, query_hash, query_len, kb_ids, hit_count, reason, latency_ms, at) VALUES (?, ?, ?, 'tool', 'demo-backfill', ?, ?, ?, ?, '[]', ?, ?, ?, ?)");
	const sha = db.prepare("SELECT sha256, size FROM file_versions v JOIN file_files f ON f.id = v.file_id WHERE f.org_id = ? AND v.origin = 'upload' LIMIT 1").get(orgId);
	let fileSeed = sha;
	if (!fileSeed) {
		const fd = new FormData();
		fd.set("file", new Blob(["演示数据说明：这个文件由 scripts/seed-demo.mjs 上传，供回填的演示版本引用。\n"], { type: "text/plain" }), "演示说明.txt");
		const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: fd });
		if (res.ok) {
			const j = await res.json();
			fileSeed = db.prepare("SELECT sha256, size FROM file_versions WHERE id = ?").get(j.version.versionId);
		}
	}
	const haveDemoFiles = db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE change_note = 'demo-backfill' AND space_id IN (SELECT id FROM id_spaces WHERE org_id = ?)").get(orgId).n > 0;
	const fileFiles = db.prepare("INSERT INTO file_files (id, org_id, space_id, project_id, name, origin, created_by, created_at, updated_at, latest_version_id, latest_version_no) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)");
	const fileVers = db.prepare("INSERT INTO file_versions (id, file_id, version_no, space_id, name, mime, size, sha256, created_by, created_at, origin, change_note, conversation_id, provenance) VALUES (?, ?, 1, ?, ?, 'text/plain', ?, ?, ?, ?, ?, 'demo-backfill', ?, ?)");

	const now = Date.now();
	const todayLocal0 = Math.floor((now + TZ_MIN * 60_000) / DAY) * DAY - TZ_MIN * 60_000; // UTC instant of local midnight today
	let convSeq = 9_000_000;
	let entrySeq = 5_000_000_000; // entry ids unique per space and far above real pi entry ids
	let counts = { runs: 0, rows: 0, kb: 0, files: 0 };
	db.exec("BEGIN");
	for (let d = DAYS; d >= 1; d--) {
		const dayStart = todayLocal0 - d * DAY;
		const localDow = new Date(dayStart + TZ_MIN * 60_000).getUTCDay(); // 0 = Sunday
		const work = localDow >= 1 && localDow <= 5 ? 1 : localDow === 6 ? 0.14 : 0.08;
		const trend = 0.35 + 0.65 * ((DAYS - d) / DAYS) ** 0.8; // usage ramps up over the year
		const seasonal = 1 + 0.25 * Math.sin(((DAYS - d) / 30) * 1.3); // gentle month-to-month waves
		for (const p of people) {
			if (rand() < 0.06 + (work < 0.5 ? 0.3 : 0)) continue; // days off
			const nRuns = poisson(p.rate * work * trend * seasonal * (0.6 + rand() * 0.8));
			let r = 0;
			while (r < nRuns) {
				const convRuns = Math.min(nRuns - r, 1 + poisson(0.9));
				const proj = rand() < 0.4 ? projects.filter((x) => x.members.includes(p.userId))[0] : undefined;
				const spaceId = proj ? proj.spaceId : p.spaceId;
				const conv = ++convSeq;
				const hour = pick([...Array(24).keys()], HOUR_W);
				let t = dayStart + hour * 3_600_000 + Math.floor(rand() * 3_000_000);
				const deptIds = `,${p.dept ?? ""},`;
				for (let k = 0; k < convRuns; k++, r++) {
					counts.runs++;
					const row = (kind, at, o) => {
						const entry = ++entrySeq;
						ins.run(`demo:${conv}:${kind}:${entry}`, kind, spaceId, orgId, proj ? proj.id : null, p.userId, deptIds, conv, entry, o.outcome, o.model ?? null, o.route ?? null, o.tool ?? null, o.i ?? 0, o.o ?? 0, o.cr ?? 0, o.cw ?? 0, (o.i ?? 0) + (o.o ?? 0) + (o.cr ?? 0) + (o.cw ?? 0), o.dur ?? null, o.err ?? null, iso(at), iso(now));
						counts.rows++;
					};
					const model = pick(MODELS, MODELS.map((m) => m.weight));
					const nReq = 1 + (rand() < 0.45 ? 1 + Math.floor(rand() * 3) : 0);
					const bigCtx = rand() < 0.06;
					const fate = rand();
					const recent = d <= 1;
					const fail = fate < 0.065 + (bigCtx && model.id === "demo-fast" ? 0.3 : 0.0);
					const timeout = !fail && fate > 0.975 - 0.01;
					const cancelled = !fail && !timeout && fate > 0.94 && fate <= 0.965;
					const pending = recent && rand() < 0.03;
					const runOutcome = pending ? (rand() < 0.5 ? "awaiting_approval" : "in_progress") : fail ? "failed" : timeout ? "timeout" : cancelled ? "cancelled" : "success";
					row("task", t, { outcome: runOutcome === "success" ? "success" : runOutcome });
					let sumI = 0,
						sumO = 0,
						sumCr = 0,
						sumCw = 0;
					let firstAt = t + 1000;
					for (let q2 = 0; q2 < nReq; q2++) {
						t += 900 + Math.floor(rand() * 2500);
						const last = q2 === nReq - 1;
						let i = Math.round(model.tokIn[0] + rand() * (model.tokIn[1] - model.tokIn[0])) + (bigCtx ? 30_000 + Math.floor(rand() * 40_000) : 0);
						let o = Math.round(model.tokOut[0] + rand() * (model.tokOut[1] - model.tokOut[0]));
						const cr = rand() < 0.5 ? Math.round(i * 0.4) : 0;
						const cw = q2 === 0 && rand() < 0.3 ? Math.round(i * 0.1) : 0;
						let outcome = "success";
						let err;
						let dur = Math.max(80, logNormal(model.median * (1 + o / 2000), 0.55));
						if (last && fail) (outcome = "failed"), (err = bigCtx ? "context_overflow" : pick(["rate_limit", "upstream_5xx", "bad_request"], [5, 3, 1])), (o = 0);
						if (last && timeout) (outcome = "timeout"), (err = "timeout"), (o = 0), (dur = 60_000 + Math.floor(rand() * 20_000));
						if (last && cancelled) (outcome = "cancelled"), (o = Math.round(o * 0.2));
						row("model_request", t, { outcome, model: model.id, route: model.route, i, o, cr, cw, dur, err });
						if (q2 === 0) firstAt = t;
						sumI += i;
						sumO += o;
						sumCr += cr;
						sumCw += cw;
						if (!last) {
							const nTool = rand() < 0.7 ? 1 + Math.floor(rand() * 3) : 0;
							for (let x = 0; x < nTool; x++) {
								const tool = pick(TOOLS, TOOLS.map((z) => z.w));
								t += 300 + Math.floor(rand() * 900);
								row("tool_call", t, { outcome: rand() < tool.err ? "failed" : "success", tool: tool.name, dur: Math.max(10, logNormal(tool.dur, 0.6)) });
							}
						}
					}
					row("run", firstAt, { outcome: runOutcome, model: model.id, route: model.route, i: sumI, o: sumO, cr: sumCr, cw: sumCw });
					if (rand() < 0.3) {
						const hit = rand() < 0.78;
						kbIns.run(`demo-kb-${conv}-${k}`, orgId, p.userId, spaceId, conv, randomBytes(8).toString("hex"), 12 + Math.floor(rand() * 40), hit ? 1 + Math.floor(rand() * 4) : 0, hit ? null : pick(["no_evidence", "forbidden"], [8, 1]), Math.round(40 + rand() * 260), iso(firstAt + 500));
						counts.kb++;
					}
					if (!haveDemoFiles && fileSeed && rand() < 0.16) {
						const fid = `demo-f-${conv}-${k}`;
						const origin = rand() < 0.85 ? "agent" : "automation";
						const nm = `${pick(["周报", "调研纪要", "客户摘要", "会议要点", "方案草稿"])}-${conv % 1000}.txt`;
						const at = iso(t + 2000);
						fileFiles.run(fid, orgId, spaceId, proj ? proj.id : null, nm, origin, p.userId, at, at, `${fid}-v1`);
						fileVers.run(`${fid}-v1`, fid, spaceId, nm, fileSeed.size, fileSeed.sha256, p.userId, at, origin, conv, JSON.stringify({ origin, demo: true }));
						counts.files++;
					}
					t += (3 + Math.floor(rand() * 40)) * 60_000;
				}
			}
		}
	}
	// automations: a daily and a weekly job, disabled (the scheduler never fires them), with historic run records
	const autoIds = [];
	for (const [name, every] of [["每日晨报", 1], ["每周周报", 7]]) {
		let a = db.prepare("SELECT id FROM auto_automations WHERE org_id = ? AND name = ?").get(orgId, name);
		if (!a) {
			const id = `demo-auto-${every}`;
			db.prepare("INSERT OR IGNORE INTO auto_automations (id, org_id, owner_user_id, space_id, name, prompt, trigger, timezone, condition, destination, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '演示自动化（不会执行）', ?, 'Asia/Shanghai', '{\"kind\":\"always\"}', '{}', 0, ?, ?)").run(id, orgId, admin.me.userId, people[0].spaceId, name, JSON.stringify({ kind: "cron", cron: every === 1 ? "0 9 * * *" : "0 9 * * 1" }), iso(now - DAYS * DAY), iso(now - DAYS * DAY));
			a = { id };
		}
		autoIds.push({ id: a.id, every });
	}
	const arIns = db.prepare("INSERT OR IGNORE INTO auto_runs (id, automation_id, org_id, scheduled_for, trigger, status, reason, request_id, space_id, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, 'cron', ?, 'demo-backfill', ?, ?, ?, ?, ?)");
	let autoRuns = 0;
	for (const a of autoIds)
		for (let d = DAYS; d >= 1; d -= a.every) {
			const at = todayLocal0 - d * DAY + 9 * 3_600_000 - TZ_MIN * 60_000 + 60_000;
			const status = pick(["succeeded", "failed", "skipped", "timeout"], [90, 6, 3, 1]);
			arIns.run(`demo-ar-${a.id}-${d}`, a.id, orgId, iso(at), status, `demo-backfill:${a.id}:${d}`, people[0].spaceId, iso(at + 2000), iso(at + 60_000), iso(at));
			autoRuns++;
		}
	db.exec("COMMIT");
	console.log(`backfill: ${counts.runs} runs, ${counts.rows} ledger rows (demo=1, simulated), ${counts.kb} knowledge searches, ${counts.files} file versions, ${autoRuns} automation runs over ${DAYS} days`);
	console.log(`\nDemo org ready. Sign in at ${BASE} as ${DEMO_EMAIL} / ${DEMO_PASSWORD}, open 统计 -> 范围: 组织.`);
	db.close();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
