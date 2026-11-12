// On-demand skills (round 6): the skill index in the system prompt (cap + explicit "N more" line), the unified `skill` tool with strict
// per-action validation, legacy skill_* tools kept (deferred), sandbox mounts only for skills the conversation loaded (re-checked at every
// run, hard cap with an explicit message), safe/concurrent materialisation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { createSkillsExtension, renderSkillIndex, validateSkillArgs, SKILL_PROMPT_MAX_LINES, type Skills, type VersionRow } from "../src/tools/skills.ts";
import { MAX_SKILL_MOUNTS, type Market } from "../src/tools/market.ts";
import { probeIsolation, type Sandbox } from "../src/tools/sandbox.ts";

const noIsolation = probeIsolation().ok ? false : probeIsolation().detail;
const execFileP = promisify(execFile);

const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${name}\n\n步骤说明。\n`;
async function mkSkills(t: TestApp, token: string, n: number, prefix = "sk", description = (i: number) => `第 ${i} 号技能的说明`): Promise<{ id: string; slug: string }[]> {
	const out: { id: string; slug: string }[] = [];
	for (let i = 1; i <= n; i++) {
		const slug = `${prefix}-${String(i).padStart(2, "0")}`;
		const r = await t.json("POST", "/api/market/skills/upload", { token, json: { files: [{ path: "SKILL.md", content: md(slug, description(i)) }, { path: "references/note.txt", content: `note of ${slug}` }] } });
		out.push({ id: r.skill.id, slug });
	}
	return out;
}
async function env(t: TestApp, user: { me: any }) {
	const ctx = t.app.ctx;
	const identity = ctx.services.get("identity");
	const principal = (await identity.principalFor(user.me.userId, user.me.orgId))!;
	const space = identity.personalSpace(user.me.userId, user.me.orgId);
	const ext = createSkillsExtension(ctx, { resolveActor: fixedActor(ctx, user.me.userId, user.me.orgId, space.id) });
	const tool = (name: string) => ext.tools!.find((x) => x.name === name)!;
	let n = 0;
	const call = (name: string, args: Record<string, unknown>, conv = 7) => tool(name).execute(args as any, fakeApi({ conversationId: conv, taskId: ++n, callId: `c${conv}-${n}` }), context) as Promise<{ output: { text: string }[]; isError?: boolean }>;
	const text = async (args: Record<string, unknown>, conv = 7) => (await call("skill", args, conv)).output[0]!.text;
	const market = ctx.services.get("market") as Market;
	return { ctx, principal, space, ext, call, text, market, conv: (c: number) => market.loadedMountPlan(principal, space, c) };
}

test("prompt section: only usable skills, one line each, max 50 + explicit 'N more' line; revoked actor gets nothing", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-prompt@example.com");
		const e = await env(t, a);
		const rt = e.ctx.services.get("runtime") as any;
		const orig = rt.promptScope;
		let principal: any = e.principal;
		rt.promptScope = async () => ({ space: e.space, principal });
		try {
			const render = async () => e.ext.sections!.find((s) => s.key === "skills")!.render({} as any, context);
			assert.equal(await render(), undefined, "no skills → no section");

			for (let i = 1; i <= 5; i++) await t.json("POST", "/api/skills", { token: a.token, json: { name: `five0${i}`, kind: "context", description: `技能 ${i}\n\t第二行（换行要被压成一行）`, instructions: "# x" } });
			let text = (await render())!;
			const lines = text.split("\n");
			assert.equal(lines.length, 1 + 5, text);
			assert.match(lines[1]!, /^- five01 \(\/skills\/five01-[a-z0-9]{6}\) — 技能 1 第二行/);
			assert.ok(!/另有/.test(text), "nothing hidden with 5 skills");
			assert.match(lines[0]!, /\/skills\/<slug>\/SKILL\.md/);
			assert.ok(!/skill 工具|skill_/.test(text), "no mention of the removed skill tool");

			const long = "长".repeat(300);
			await mkSkills(t, a.token, 55, "many", () => long);
			text = (await render())!;
			const bullet = text.split("\n").filter((l) => l.startsWith("- "));
			assert.equal(bullet.length, SKILL_PROMPT_MAX_LINES);
			assert.equal(text.split("\n").at(-1), "另有 10 个技能未列出，用 ls /skills 或 search 查找", "60 skills: 50 shown, 10 reported");
			assert.ok(bullet.every((l) => l.length <= 2 + 60 + 3 + 80 + 3 + 120 + 10), "descriptions are cut");
			const desc = bullet.find((l) => l.includes("长"))!.split(" — ")[1]!;
			assert.equal(desc.length, 120);

			// Re-evaluated every time: uninstalling skills changes the section (pi-durable diffs it).
			for (const s of await (e.ctx.services.get("skills") as Skills).visible(e.principal)) if (s.name.startsWith("many")) (e.ctx.services.get("skills") as Skills).uninstall(e.principal, s.id);
			assert.equal((await render())!.split("\n").length, 1 + 5);

			// Not allowed to use skills / actor revoked → nothing.
			principal = null;
			assert.equal(await render(), undefined);
			principal = e.principal;
			rt.promptScope = async () => null;
			assert.equal(await render(), undefined);
		} finally {
			rt.promptScope = orig;
		}
		assert.equal(renderSkillIndex([]), undefined);
	} finally {
		await t.dispose();
	}
});

test("skill tool: strict per-action validation; list/search/load/read/run authorise like the legacy tools", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-valid@example.com");
		const e = await env(t, a);
		await mkSkills(t, a.token, 3, "val", (i) => (i === 2 ? "整理会议纪要的技能" : "其他技能"));
		await t.json("POST", "/api/skills", { token: a.token, json: { name: "greeter", kind: "executable", description: "打招呼", instructions: "# greeter", resources: [{ path: "main.py", content: "import sys\nprint('hi ' + sys.argv[1])\n" }], entry: "main.py" } });

		// pure validation
		const bad = (args: Record<string, unknown>, re: RegExp) => assert.throws(() => validateSkillArgs(args), (x: any) => x.status === 400 && x.code === "invalid_args" && re.test(x.message));
		bad({ action: "nope" }, /action 必须是/);
		bad({ action: "list", name: "x" }, /不接受参数：name/);
		bad({ action: "search" }, /缺少必填参数：query/);
		bad({ action: "search", query: "  " }, /缺少必填参数：query/);
		bad({ action: "search", query: "x", name: "y" }, /不接受参数：name/);
		bad({ action: "load" }, /缺少必填参数：name/);
		bad({ action: "load", name: "x", path: "a" }, /不接受参数：path/);
		bad({ action: "read", name: "x" }, /缺少必填参数：path/);
		bad({ action: "read", name: "x", path: "a", input: "i" }, /不接受参数：input/);
		bad({ action: "read", name: "x", path: "a", offset: -1 }, /offset/);
		bad({ action: "run" }, /缺少必填参数：name/);
		bad({ action: "run", name: "x", query: "q" }, /不接受参数：query/);
		bad({ action: "run", name: "x", input: 5 }, /input 必须是字符串/);
		assert.deepEqual(validateSkillArgs({ action: "read", name: "x", path: "a", offset: 3 }), { action: "read", name: "x", path: "a", offset: 3, query: undefined, input: undefined, script: undefined });

		// through the tool (errors surface as thrown 400s and are written to the tool-call log)
		await assert.rejects(e.call("skill", { action: "list", query: "x" }), /不接受参数/);
		await assert.rejects(e.call("skill", { action: "load" }), /缺少必填参数/);

		const list = await e.text({ action: "list" });
		assert.match(list, /val-01/);
		assert.match(list, /greeter/);
		const found = await e.text({ action: "search", query: "会议纪要" });
		assert.match(found, /val-02/);
		assert.ok(!/val-01/.test(found));
		assert.match(await e.text({ action: "search", query: "不存在的东西xyz" }), /没有找到/);

		const loaded = await e.text({ action: "load", name: "val-02" });
		assert.match(loaded, /<skill name="val-02"/);
		assert.match(await e.text({ action: "read", name: "val-02", path: "references/note.txt" }), /note of val-02/);
		await assert.rejects(e.call("skill", { action: "read", name: "val-02", path: "../../etc/passwd" }), /没有文件/);
		await assert.rejects(e.call("skill", { action: "load", name: "no-such-skill" }), /没有可用的技能/);
		// run: not executable → denied; executable without grant → denied (loading is not permission)
		await assert.rejects(e.call("skill", { action: "run", name: "val-02" }), /不是可执行技能/);
		await assert.rejects(e.call("skill", { action: "run", name: "greeter", input: "x" }), /需要用户授权/);

		// the unified tool is the model-facing one; the legacy four are deferred
		const reg = e.ext.tools!.map((x: any) => [x.name, !!x.deferred, x.replay]);
		assert.deepEqual(reg.filter((r) => r[0] === "skill"), [["skill", false, "unsafe"]], "run is unsafe → the whole tool is replay-unsafe");
		for (const n of ["skill_list", "skill_load", "skill_read", "skill_run"]) assert.equal(reg.find((r) => r[0] === n)![1], true, `${n} deferred`);

		// every call is in the audit log under tool "skill", including the rejected ones
		const rows = e.ctx.db.all<{ tool: string; status: string }>("SELECT tool, status FROM tool_calls WHERE tool = 'skill'");
		assert.ok(rows.length >= 8 && rows.some((r) => r.status !== "ok"), JSON.stringify(rows));
	} catch (err) {
		throw err;
	} finally {
		await t.dispose();
	}
});

test("legacy skill_list / skill_load / skill_read / skill_run still work and record the loaded skill", { skip: noIsolation }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-legacy@example.com");
		const e = await env(t, a);
		const g = await t.json("POST", "/api/skills", { token: a.token, json: { name: "greeter", kind: "executable", description: "打招呼", instructions: "# greeter", resources: [{ path: "main.py", content: "import sys\nprint('hi ' + sys.argv[1])\n" }], entry: "main.py" } });
		assert.match(((await e.call("skill_list", {})).output[0]!.text), /greeter/);
		assert.equal((await e.conv(3)).mounts.length, 0);
		assert.match(((await e.call("skill_load", { name: "greeter" }, 3)).output[0]!.text), /<skill name="greeter"/);
		assert.deepEqual((await e.conv(3)).mounts.map((m) => m.mount.target.replace(/-[0-9a-f]{6}$/, "")), ["/skills/greeter"]);
		assert.match(((await e.call("skill_read", { name: "greeter", path: "main.py" }, 4)).output[0]!.text), /print/);
		assert.equal((await e.conv(4)).mounts.length, 1, "skill_read also counts as loading");
		await t.json("POST", `/api/skills/${g.skill.id}/grants`, { token: a.token, json: { versionNo: 1, permissions: ["sandbox.exec"] } });
		const run = await e.call("skill_run", { name: "greeter", input: "legacy" }, 5);
		assert.equal(run.isError, false, run.output[0]!.text);
		assert.match(run.output[0]!.text, /hi legacy/);
		assert.equal((await e.conv(5)).mounts.length, 1);
		// the new tool runs the same code path
		const run2 = await e.call("skill", { action: "run", name: "greeter", input: "unified" }, 6);
		assert.equal(run2.isError, false);
		assert.match(run2.output[0]!.text, /hi unified/);
		// legacy tools are not discoverable through tool_search
	} finally {
		await t.dispose();
	}
});

test("mount plan: a fresh conversation mounts nothing, even with 40 skills installed; loading mounts exactly that skill", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-mounts@example.com");
		const e = await env(t, a);
		const made = await mkSkills(t, a.token, 40, "mnt");
		assert.equal((await (e.ctx.services.get("skills") as Skills).active(e.principal, e.space)).length, 40);
		const plan = await e.conv(11);
		assert.deepEqual([plan.mounts.length, plan.skipped.length], [0, 0]);
		assert.equal((await e.market.mountPlan(e.principal, e.space)).length, 32, "the old 'everything active' plan is no longer what the sandbox uses");

		await e.text({ action: "load", name: "mnt-07" }, 11);
		assert.deepEqual((await e.conv(11)).mounts.map((m) => m.mount.target), ["/skills/mnt-07"]);
		assert.equal((await e.conv(12)).mounts.length, 0, "other conversations are unaffected");
		// loaded state is per conversation and per skill: reloading is idempotent
		await e.text({ action: "load", name: "mnt-07" }, 11);
		assert.equal(e.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_conv_loaded WHERE conversation_id = 11")!.n, 1);
		assert.ok(made.length === 40);
	} finally {
		await t.dispose();
	}
});

test("40 installed + 35 loaded: 32 most recent mounted, the 3 oldest reported explicitly (load result and sandbox run), nothing silent", { skip: noIsolation }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-cap@example.com");
		const e = await env(t, a);
		const made = await mkSkills(t, a.token, 40, "cap");
		let last = "";
		for (let i = 0; i < 35; i++) last = await e.text({ action: "load", name: made[i]!.slug }, 21);
		assert.equal(MAX_SKILL_MOUNTS, 32);
		const plan = await e.conv(21);
		assert.equal(plan.mounts.length, 32);
		assert.deepEqual(plan.skipped.map((s) => e.market.slugOf(s)).sort(), ["cap-01", "cap-02", "cap-03"]);
		assert.match(last, /超过沙箱挂载上限 32/);
		assert.match(last, /cap-01, cap-02, cap-03/);
		assert.ok(!(await e.text({ action: "load", name: "cap-36" }, 22)).includes("超过沙箱挂载上限"), "no warning below the cap");

		const sb = e.ctx.services.get("sandbox") as Sandbox;
		const run = await sb.run({ principal: e.principal, space: e.space, conversationId: 21, language: "shell", code: "ls /skills | wc -l; ls /skills | head -1" });
		assert.equal(run.status, "ok", run.stderr);
		assert.match(run.stdout, /^32\ncap-04/);
		assert.match(run.stderr, /\[技能挂载\].*上限 32.*cap-01, cap-02, cap-03.*重新加载/, run.stderr);
		// A fresh conversation sees none of them.
		const fresh = await sb.run({ principal: e.principal, space: e.space, conversationId: 23, language: "shell", code: "ls /skills 2>&1 | wc -l" });
		assert.match(fresh.stdout, /^[01]\n/);
		assert.ok(!fresh.stderr.includes("[技能挂载]"));
		// skill run always mounts its own skill, even beyond the cap (it becomes the most recent).
		await t.json("POST", "/api/skills", { token: a.token, json: { name: "runner", kind: "executable", description: "r", instructions: "# r", resources: [{ path: "main.py", content: "import os\nprint(os.listdir('/skills').__len__(), os.path.exists(os.environ['SKILL_DIR']+'/main.py'))\n" }], entry: "main.py" } });
		const rs = (e.ctx.services.get("skills") as Skills).skill(e.ctx.db.get<{ id: string }>("SELECT id FROM skill_skills WHERE name = 'runner'")!.id)!;
		await t.json("POST", `/api/skills/${rs.id}/grants`, { token: a.token, json: { versionNo: 1, permissions: ["sandbox.exec"] } });
		const out = await e.call("skill", { action: "run", name: "runner" }, 21);
		assert.equal(out.isError, false, out.output[0]!.text);
		assert.match(out.output[0]!.text, /32 True/);
		assert.match(out.output[0]!.text, /cap-0[1-4]/, "the run says which loaded skills were pushed out");
	} finally {
		await t.dispose();
	}
});

test("revocation: uninstall, disable, unpublish and re-pin take effect on the next run (department removal: skills-scopes.test.ts)", async () => {
	const t = await startTestApp();
	try {
		const admin = await t.user("od-rev-admin@example.com");
		const member = await orgMember(t, admin, "od-rev-member@example.com");
		const e = await env(t, member);
		// personal: uninstall / disable
		const [p1, p2] = await mkSkills(t, member.token, 2, "pers");
		await e.text({ action: "load", name: "pers-01" }, 31);
		await e.text({ action: "load", name: "pers-02" }, 31);
		assert.equal((await e.conv(31)).mounts.length, 2);
		await t.json("DELETE", `/api/skills/${p1!.id}/install`, { token: member.token });
		assert.deepEqual((await e.conv(31)).mounts.map((m) => m.mount.target), ["/skills/pers-02"]);
		await t.json("PATCH", `/api/skills/${p2!.id}/install`, { token: member.token, json: { enabled: false } });
		assert.equal((await e.conv(31)).mounts.length, 0);
		await t.json("PATCH", `/api/skills/${p2!.id}/install`, { token: member.token, json: { enabled: true } });
		assert.equal((await e.conv(31)).mounts.length, 1, "re-enabling brings it back (still loaded in this conversation)");

		// org skill installed for everyone → unpublish removes the mount
		const org = await t.json("POST", "/api/skills", { token: admin.token, json: { name: "orgkit", kind: "context", scope: "org", description: "组织技能", instructions: "# org", resources: [{ path: "refs/a.txt", content: "a" }] } });
		await t.json("POST", `/api/market/skills/${org.skill.id}/install`, { token: admin.token, json: { target: "org" } });
		await e.text({ action: "load", name: "orgkit" }, 32);
		assert.equal((await e.conv(32)).mounts.length, 1);
		await t.json("POST", `/api/market/skills/${org.skill.id}/unpublish`, { token: admin.token, json: { reason: "撤回" } });
		assert.equal((await e.conv(32)).mounts.length, 0);
		await assert.rejects(e.text({ action: "load", name: "orgkit" }, 32), /没有可用的技能|已下架/);
		await t.json("POST", `/api/market/skills/${org.skill.id}/republish`, { token: admin.token });
		assert.equal((await e.conv(32)).mounts.length, 1);

		// pin change → the mounted directory follows the version that is active now
		const g = await t.json("POST", "/api/skills", { token: member.token, json: { name: "pinned", kind: "context", description: "d", instructions: "# v1", resources: [{ path: "refs/a.txt", content: "v1" }] } });
		await t.json("POST", `/api/skills/${g.skill.id}/versions`, { token: member.token, json: { instructions: "# v2", resources: [{ path: "refs/a.txt", content: "v2" }] } });
		await t.json("PATCH", `/api/skills/${g.skill.id}/install`, { token: member.token, json: { pinnedVersionNo: 1 } });
		await e.text({ action: "load", name: "pinned" }, 33);
		const dir1 = (await e.conv(33)).mounts[0]!.mount.hostPath;
		assert.equal(readFileSync(join(dir1, "refs/a.txt"), "utf8"), "v1");
		await t.json("PATCH", `/api/skills/${g.skill.id}/install`, { token: member.token, json: { pinnedVersionNo: 2 } });
		const dir2 = (await e.conv(33)).mounts[0]!.mount.hostPath;
		assert.notEqual(dir2, dir1);
		assert.equal(readFileSync(join(dir2, "refs/a.txt"), "utf8"), "v2");
	} finally {
		await t.dispose();
	}
});

test("revocation of the actor: the loaded-skills table never lets another user's conversation mount a skill", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-own-a@example.com");
		const b = await orgMember(t, a, "od-own-b@example.com");
		const ea = await env(t, a);
		const eb = await env(t, b);
		await mkSkills(t, a.token, 1, "mine");
		await ea.text({ action: "load", name: "mine-01" }, 41);
		// b acts in the same (space, conversation) coordinates: the skill is not active for b → not mounted.
		const plan = await eb.market.loadedMountPlan(eb.principal, ea.space, 41);
		assert.equal(plan.mounts.length, 0);
		await assert.rejects(eb.text({ action: "load", name: "mine-01" }, 41), /没有可用的技能/);
	} finally {
		await t.dispose();
	}
});

test("materialisation: concurrent writers of identical content (separate processes) leave one complete read-only directory and no temp dirs", async () => {
	const t = await startTestApp();
	try {
		const base = join(t.dataDir, "mat-race");
		mkdirSync(base, { recursive: true });
		const dir = join(base, "race-0123456789abcdef");
		const child = join(import.meta.dirname, "fixtures", "materialize-child.ts");
		const runs = await Promise.all(Array.from({ length: 8 }, () => execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", child, dir, "40"], { timeout: 60_000 })));
		assert.ok(runs.every((r) => r.stdout === "ok"));
		assert.deepEqual(readdirSync(base), ["race-0123456789abcdef"], "no .tmp- leftovers");
		assert.equal(readdirSync(join(dir, "references")).length, 40);
		assert.equal(statSync(join(dir, "references/f3.txt")).mode & 0o222, 0);
		assert.equal(statSync(dir).mode & 0o222, 0);
	} finally {
		await t.dispose();
	}
});

test("materialisation never writes outside <dataDir>/sandbox-mounts: hostile slugs and stored paths are refused", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("od-evil@example.com");
		const e = await env(t, a);
		const ctx = e.ctx;
		const root = join(t.dataDir, "sandbox-mounts");
		const g = await t.json("POST", "/api/skills", { token: a.token, json: { name: "plain", kind: "context", description: "d", instructions: "# x", resources: [{ path: "refs/a.txt", content: "a" }] } });
		const skill = (ctx.services.get("skills") as Skills).skill(g.skill.id)!;
		const good = (ctx.services.get("skills") as Skills).version(skill.id, 1)!;
		const blob = ctx.blobs.put(new TextEncoder().encode("PWNED")).sha256;
		const withPaths = (paths: string[]): VersionRow => ({ ...good, id: "skv_evil", package_sha256: null, resources: JSON.stringify(paths.map((path) => ({ path, sha256: blob, size: 5 }))) });
		const before = (d: string) => (existsSync(d) ? readdirSync(d).length : 0);
		const outside = join(t.dataDir, "sandbox-mounts-evil");
		for (const evil of ["../x.txt", "../../escape.txt", "/abs/escape.txt", "a/../../escape.txt", "a/./b.txt", "a\\..\\b.txt", "ok/../../../escape", "", "x\0y", "dir//f.txt", "./f.txt"]) {
			assert.throws(() => e.market.materialize(skill, withPaths(["SKILL.md", evil])), (x: any) => x.code === "bad_skill_path", JSON.stringify(evil));
		}
		// file/dir clash ("a" is both) cannot be written either, and cleans up its temp dir
		assert.throws(() => e.market.materialize(skill, withPaths(["a", "a/b"])));
		// hostile slugs
		for (const slug of ["../evil", "a/b", "/abs", "..", "a..b", "", "x y", ".hidden", "a\\b", "x".repeat(150)]) {
			assert.throws(() => e.market.materialize(skill, good, slug), (x: any) => x.code === "bad_skill_slug", JSON.stringify(slug));
		}
		assert.equal(existsSync(outside), false);
		assert.equal(existsSync(join(t.dataDir, "escape.txt")), false);
		assert.equal(existsSync(join(root, "escape.txt")), false);
		assert.ok(!existsSync(join(root, "skills")) || readdirSync(join(root, "skills")).every((n) => !n.includes(".tmp-")), "no temp leftovers");
		assert.ok(before(join(root, "skills")) >= 0);
		// and the legacy write path refuses such names up front
		await t.json("POST", "/api/skills", { token: a.token, json: { name: "bad", kind: "context", instructions: "x", resources: [{ path: "../x", content: "x" }] }, expect: 400 });
		await t.json("POST", "/api/market/skills/upload", { token: a.token, json: { files: [{ path: "SKILL.md", content: md("evil-pkg", "d") }, { path: "../../escape.txt", content: "x" }] }, expect: 400 });
	} finally {
		await t.dispose();
	}
});
