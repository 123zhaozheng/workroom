// Skills created in conversation (round 6, B2): skill_manage submit_draft → frozen snapshot → durable approval → personal skill.
//   node --disable-warning=ExperimentalWarning --test server/test/skills-drafts.test.ts
// The extension is installed into the running runtime with reinstallExtension (until module.ts wires it, see docs/requests/round6-b2.md),
// so these tests drive the REAL agent loop (fixture model directives), real approvals, real restarts.
process.env.WORKROOM_FIXTURE_TOOLS = "1";
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { createSkillManageExtension, SKILL_DRAFT_MIGRATIONS, registerSkillDraftRoutes, skillDraftsFor, snapshotDir } from "../src/tools/skill-drafts.ts";
import { LIMITS, sha256Hex } from "../src/tools/skills-package.ts";
import type { Market } from "../src/tools/market.ts";
import type { Sandbox } from "../src/tools/sandbox.ts";
import type { Skills } from "../src/tools/skills.ts";
import type { AppEnv, ToolActor } from "../src/core/contracts.ts";
import type { SkillDraftApprovalDetail } from "../../shared/skill-drafts.ts";

const skillMd = (o: { name?: string; version?: string; body?: string; description?: string; extra?: string } = {}) =>
	`---\nname: ${o.name ?? "weekly-report"}\ndescription: ${o.description ?? "把本周的工作整理成周报。当用户要求写周报、汇总本周进展时使用。"}\nversion: ${o.version ?? "1.0.0"}\n${o.extra ?? ""}---\n\n${o.body ?? "# 周报\n\n按「本周完成 / 下周计划 / 风险」三段写。"}\n`;

/** Install the skill_manage extension into the running runtime (the integrator does this in module.ts). */
function wire(t: TestApp): void {
	// Same as module.ts will do (module "tools", offset 800); a no-op once the module itself applies it.
	t.app.ctx.db.migrate("tools", SKILL_DRAFT_MIGRATIONS.map((m) => ({ ...m, version: m.version + 800 })));
	(t.app.ctx.services.get("runtime") as any).reinstallExtension(createSkillManageExtension(t.app.ctx));
}

const state = (t: TestApp, token: string, sp: string, id: number) => t.json("GET", `/api/conversations/${sp}/${id}/state`, { token });
const send = (t: TestApp, token: string, sp: string, id: number, text: string) => t.json("POST", `/api/conversations/${sp}/${id}/messages`, { token, json: { text, requestId: randomUUID() } });
const idle = (t: TestApp, token: string, sp: string, id: number, what: string) =>
	waitFor(async () => {
		const s = await state(t, token, sp, id);
		return !s.live.busy && s.queue.length === 0 ? s : undefined;
	}, { timeoutMs: 30_000, what });
const results = (s: any, name: string) => s.entries.filter((e: any) => e.kind === "tool_result" && e.toolName === name);
const pendingApproval = (t: TestApp, token: string, sp: string, id: number) => waitFor(async () => (await state(t, token, sp, id)).approvals.find((a: any) => a.status === "pending"), { what: "pending approval" });
const decide = (t: TestApp, token: string, sp: string, id: number, approvalId: string, decision: "approved" | "rejected") =>
	t.json("POST", `/api/conversations/${sp}/${id}/approvals/${encodeURIComponent(approvalId)}`, { token, json: { decision } });

async function newConv(t: TestApp, token: string) {
	const { conversation } = await t.json("POST", "/api/conversations", { token, json: {} });
	return { sp: conversation.spaceId as string, cid: conversation.conversationId as number };
}
const workdirOf = (t: TestApp, sp: string, cid: number) => (t.app.ctx.services.get("sandbox") as Sandbox).workdir(t.app.ctx.services.get("identity").space(sp)!, cid);
function writeSkill(t: TestApp, sp: string, cid: number, dir: string, files: Record<string, string | Uint8Array>) {
	const root = join(workdirOf(t, sp, cid), dir);
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(join(root, p, ".."), { recursive: true });
		writeFileSync(join(root, p), c);
	}
	return root;
}
const submit = (t: TestApp, token: string, sp: string, cid: number, dir: string) => send(t, token, sp, cid, `[[call skill_manage {"action":"submit_draft","dir":${JSON.stringify(dir)}}]]`);
const count = (t: TestApp, table: string, where = "1=1", ...p: any[]) => t.app.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...p)!.n;
const audits = (t: TestApp, action: string) => t.app.ctx.db.all<any>("SELECT * FROM id_audit WHERE action = ?", action);

async function setup() {
	const t = await startTestApp();
	wire(t);
	const alice = await t.user("alice-sd@example.com");
	return { t, alice };
}

async function actorFor(t: TestApp, u: { me: any }, sp: string, cid: number, callId: string): Promise<ToolActor> {
	const principal = (await t.app.ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
	return { principal, space: t.app.ctx.services.get("identity").space(sp)!, conversationId: cid, taskId: 1, callId };
}

test("happy path: agent writes the skill with write (/work) → approval with the frozen detail → approve → personal skill, installed, usable; later workspace edits change nothing", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		await send(t, alice.token, sp, cid, `[[call write ${JSON.stringify({ path: "/work/weekly/SKILL.md", content: skillMd() })}]]`);
		await idle(t, alice.token, sp, cid, "write SKILL.md");
		await send(t, alice.token, sp, cid, `[[call write ${JSON.stringify({ path: "/work/weekly/references/format.md", content: "# 格式\n三段式。\n" })}]]`);
		await idle(t, alice.token, sp, cid, "write reference");

		await submit(t, alice.token, sp, cid, "/work/weekly");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		assert.equal(ap.toolName, "skill_manage");
		assert.equal(ap.risk, "low", "prompt-only skill is low risk");
		assert.equal(ap.title, "保存为个人技能：weekly-report");
		assert.match(ap.summary, /保存为仅你可用的个人技能 v1\.0\.0；不会自动执行，也不会发布到商城/);
		const detail = ap.detail as SkillDraftApprovalDetail;
		assert.equal(detail.kind, "skill_draft");
		assert.equal(detail.name, "weekly-report");
		assert.equal(detail.version, "1.0.0");
		assert.equal(detail.sourceDir, "weekly");
		assert.deepEqual(detail.files.map((f) => f.path).sort(), ["SKILL.md", "references/format.md"]);
		assert.equal(detail.packageSha256.length, 64);
		assert.equal(count(t, "skill_skills"), 0, "nothing is saved before approval");
		await decide(t, alice.token, sp, cid, ap.approvalId, "rejected");
	} finally {
		await t.dispose();
	}
});

test("approve saves exactly the snapshot, whatever happens to the workspace afterwards", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const root = writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd(), "references/format.md": "# 格式\n三段式。\n" });
		await submit(t, alice.token, sp, cid, "weekly");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		const detail = ap.detail as SkillDraftApprovalDetail;
		const svc = skillDraftsFor(t.app.ctx);
		assert.equal(svc.dto(svc.row(detail.draftId)!).state, "pending");

		// The workspace changes AFTER submit: new body, new version, a new file. None of it may reach the saved skill.
		writeFileSync(join(root, "SKILL.md"), skillMd({ version: "9.9.9", body: "# 被篡改的内容\n" }));
		writeFileSync(join(root, "extra.md"), "after submit");

		await decide(t, alice.token, sp, cid, ap.approvalId, "approved");
		const s = await idle(t, alice.token, sp, cid, "approved run");
		const res = results(s, "skill_manage")[0];
		assert.ok(!res.isError, res.text);
		assert.match(res.text, /已保存为用户的个人技能/);
		assert.match(res.text, /没有被发布到商城/);

		const row = svc.dto(svc.row(detail.draftId)!);
		assert.equal(row.state, "saved");
		assert.ok(row.skillId && row.versionNo === 1);
		const skills = t.app.ctx.services.get("skills") as Skills;
		const skill = skills.skill(row.skillId!)!;
		assert.equal(skill.scope, "personal");
		assert.equal(skill.owner_user_id, alice.me.userId);
		const ver = skills.version(skill.id, 1)!;
		assert.equal(ver.package_sha256, detail.packageSha256, "version identity = the approved snapshot hash");
		assert.equal(ver.semver, "1.0.0");
		assert.ok(!ver.instructions.includes("被篡改"));
		assert.deepEqual((JSON.parse(ver.resources) as { path: string }[]).map((r) => r.path).sort(), ["SKILL.md", "references/format.md"]);
		// installed and usable for the user
		const active = await skills.active((await t.app.ctx.services.get("identity").principalFor(alice.me.userId, alice.me.orgId))!, t.app.ctx.services.get("identity").space(sp)!);
		assert.ok(active.some((a) => a.skill.id === skill.id), "installed and usable");
		const principal = (await t.app.ctx.services.get("identity").principalFor(alice.me.userId, alice.me.orgId))!;
		const used = await skills.resolveForUse(principal, "weekly-report", t.app.ctx.services.get("identity").space(sp)!);
		assert.equal(used.version.package_sha256, detail.packageSha256, "resolves for use at the approved version");
		assert.match(used.version.instructions, /三段写/);
		// not published, no submission
		assert.equal(count(t, "market_submissions", "subject_id = ?", skill.id), 0);
		assert.equal(skill.listed, 0);
		// audited
		assert.equal(audits(t, "skill.draft.submit").length, 1);
		assert.equal(audits(t, "skill.draft.saved").length, 1);
	} finally {
		await t.dispose();
	}
});

test("reject: nothing is saved, draft is rejected, agent is told", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		await submit(t, alice.token, sp, cid, "weekly");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		await decide(t, alice.token, sp, cid, ap.approvalId, "rejected");
		const s = await idle(t, alice.token, sp, cid, "rejected run");
		assert.match(results(s, "skill_manage")[0].text, /用户拒绝/);
		const svc = skillDraftsFor(t.app.ctx);
		assert.equal(svc.row((ap.detail as SkillDraftApprovalDetail).draftId)!.state, "rejected");
		assert.equal(count(t, "skill_skills"), 0);
		assert.equal(count(t, "skill_versions"), 0);
		assert.equal(audits(t, "skill.draft.rejected").length, 1);
		assert.equal(audits(t, "skill.draft.saved").length, 0);
	} finally {
		await t.dispose();
	}
});

test("error findings (secret in a file): draft fails, NO approval is opened, the agent gets the findings; invalid manifest likewise", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "leaky", { "SKILL.md": skillMd({ name: "leaky" }), "scripts/run.py": "KEY = 'AKIAABCDEFGHIJKLMNOP'\nprint(KEY)\n" });
		await submit(t, alice.token, sp, cid, "leaky");
		let s = await idle(t, alice.token, sp, cid, "failed run");
		assert.equal(s.approvals.length, 0, "no approval for a package with error findings");
		const r = results(s, "skill_manage")[0];
		assert.ok(r.isError);
		assert.match(r.text, /AWS access key/);
		assert.match(r.text, /重新调用 skill_manage/);
		const rows = t.app.ctx.db.all<any>("SELECT * FROM skill_ws_drafts");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "failed");
		assert.ok((JSON.parse(rows[0].detail) as SkillDraftApprovalDetail).findings.some((f) => f.code === "secret_in_package"));
		assert.equal(count(t, "skill_skills"), 0);
		assert.equal(audits(t, "skill.draft.failed").length, 1);

		// Fix and resubmit (new call → new draft) → now it goes to approval.
		writeSkill(t, sp, cid, "leaky", { "scripts/run.py": "print('ok')\n" });
		await submit(t, alice.token, sp, cid, "leaky");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		assert.equal(ap.risk, "medium", "scripts → medium");
		assert.ok((ap.detail as SkillDraftApprovalDetail).files.find((f) => f.path === "scripts/run.py")?.executable);

		// manifest missing → failed, not an approval
		writeSkill(t, sp, cid, "nomd", { "readme.txt": "x" });
		await decide(t, alice.token, sp, cid, ap.approvalId, "rejected");
		await idle(t, alice.token, sp, cid, "rejected");
		await submit(t, alice.token, sp, cid, "nomd");
		s = await idle(t, alice.token, sp, cid, "nomd run");
		assert.match(results(s, "skill_manage").at(-1).text, /SKILL\.md/);
	} finally {
		await t.dispose();
	}
});

test("high risk: network use in a script is flagged high in the approval", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "net", { "SKILL.md": skillMd({ name: "net-skill" }), "scripts/get.py": "import requests\nrequests.get('http://example.com')\n" });
		await submit(t, alice.token, sp, cid, "net");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		assert.equal(ap.risk, "high");
		assert.ok((ap.detail as SkillDraftApprovalDetail).findings.some((f) => f.code === "network_use"));
	} finally {
		await t.dispose();
	}
});

test("snapshotDir refuses ../, absolute, drive letters, NUL, symlinked file / dir / parent, fifo, oversize file, too many files", () => {
	const root = mkdtempSync(join(tmpdir(), "wr-sd-"));
	const wd = join(root, "work");
	const outside = join(root, "outside");
	mkdirSync(wd);
	mkdirSync(outside);
	writeFileSync(join(outside, "SKILL.md"), "secret outside");
	try {
		mkdirSync(join(wd, "ok"));
		writeFileSync(join(wd, "ok", "SKILL.md"), "hi");
		assert.deepEqual(snapshotDir(wd, "ok").files.map((f) => f.path), ["SKILL.md"]);
		assert.equal(snapshotDir(wd, "/work/ok").rel, "ok", "the /work mount prefix is accepted");

		const code = (dir: unknown) => {
			try {
				snapshotDir(wd, dir);
			} catch (e: any) {
				return e.code as string;
			}
			return "NO_ERROR";
		};
		for (const d of ["../outside", "ok/../../outside", "/etc", "/etc/passwd", "C:/Windows", "c:\\x", "ok\\..\\..", "a\0b", "", ".", "/work", "/workX/ok", 42, undefined]) assert.equal(code(d), "bad_dir", `dir ${JSON.stringify(d)}`);
		assert.equal(code("missing"), "dir_not_found");

		// symlinked dir (pointing outside, and pointing inside), symlinked parent
		symlinkSync(outside, join(wd, "linkdir"));
		assert.equal(code("linkdir"), "symlink_refused");
		symlinkSync(join(wd, "ok"), join(wd, "inside-link"));
		assert.equal(code("inside-link"), "symlink_refused", "even a link that stays inside the workspace is refused");
		mkdirSync(join(wd, "p"));
		symlinkSync(outside, join(wd, "p", "sub"));
		assert.equal(code("p/sub"), "symlink_refused");
		symlinkSync(wd, join(wd, "up"));
		assert.equal(code("up/ok"), "symlink_refused", "symlinked parent");

		// symlinked file inside the package, dangling symlink, symlinked subdir
		mkdirSync(join(wd, "sl"));
		writeFileSync(join(wd, "sl", "SKILL.md"), "hi");
		symlinkSync(join(outside, "SKILL.md"), join(wd, "sl", "notes.md"));
		assert.equal(code("sl"), "symlink_refused");
		rmSync(join(wd, "sl", "notes.md"));
		symlinkSync(join(wd, "nope"), join(wd, "sl", "dangling.md"));
		assert.equal(code("sl"), "symlink_refused");
		rmSync(join(wd, "sl", "dangling.md"));
		symlinkSync(outside, join(wd, "sl", "refs"));
		assert.equal(code("sl"), "symlink_refused");
		rmSync(join(wd, "sl", "refs"));
		assert.equal(code("sl"), "NO_ERROR");

		// fifo
		mkdirSync(join(wd, "ff"));
		writeFileSync(join(wd, "ff", "SKILL.md"), "hi");
		execFileSync("mkfifo", [join(wd, "ff", "pipe")]);
		assert.equal(code("ff"), "special_file");

		// limits
		mkdirSync(join(wd, "big"));
		writeFileSync(join(wd, "big", "SKILL.md"), Buffer.alloc(LIMITS.fileBytes + 1, 97));
		assert.equal(code("big"), "file_too_large");
		mkdirSync(join(wd, "many"));
		for (let i = 0; i <= LIMITS.files; i++) writeFileSync(join(wd, "many", `f${i}.md`), "x");
		assert.equal(code("many"), "too_many_files");
		mkdirSync(join(wd, "total"));
		for (let i = 0; i < 6; i++) writeFileSync(join(wd, "total", `f${i}.bin`), Buffer.alloc(LIMITS.fileBytes, 97));
		assert.equal(code("total"), "package_too_large");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("through the agent: a symlinked file and ../ become failed drafts with no approval and no skill", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const root = writeSkill(t, sp, cid, "sneaky", { "SKILL.md": skillMd({ name: "sneaky" }) });
		writeFileSync(join(t.dataDir, "host-secret.txt"), "TOP SECRET");
		symlinkSync(join(t.dataDir, "host-secret.txt"), join(root, "leak.md"));
		await submit(t, alice.token, sp, cid, "sneaky");
		let s = await idle(t, alice.token, sp, cid, "symlink run");
		assert.match(results(s, "skill_manage")[0].text, /符号链接/);
		await submit(t, alice.token, sp, cid, "../c999/x");
		s = await idle(t, alice.token, sp, cid, "dotdot run");
		assert.match(results(s, "skill_manage").at(-1).text, /\.\./);
		assert.equal(s.approvals.length, 0);
		assert.equal(count(t, "skill_skills"), 0);
		for (const r of t.app.ctx.db.all<any>("SELECT detail, files FROM skill_ws_drafts")) assert.ok(!r.detail.includes("TOP SECRET") && r.files === "[]");
	} finally {
		await t.dispose();
	}
});

test("another user's / conversation's workspace is unreachable; drafts are owner-only", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-sd@example.com");
		const a = await newConv(t, alice.token);
		const a2 = await newConv(t, alice.token);
		const b = await newConv(t, bob.token);
		writeSkill(t, a.sp, a.cid, "weekly", { "SKILL.md": skillMd() });
		// bob names alice's directory / paths that climb into her space: not found in HIS workspace
		await submit(t, bob.token, b.sp, b.cid, "weekly");
		let s = await idle(t, bob.token, b.sp, b.cid, "bob run");
		assert.match(results(s, "skill_manage")[0].text, /目录不存在/);
		await submit(t, bob.token, b.sp, b.cid, `../../../${a.sp}/sandbox/c${a.cid}/weekly`);
		s = await idle(t, bob.token, b.sp, b.cid, "bob run 2");
		assert.ok(results(s, "skill_manage").at(-1).isError);
		assert.equal(s.approvals.length, 0);
		// alice's other conversation does not see it either
		await submit(t, alice.token, a2.sp, a2.cid, "weekly");
		s = await idle(t, alice.token, a2.sp, a2.cid, "other conv run");
		assert.match(results(s, "skill_manage")[0].text, /目录不存在/);

		// owner-only drafts
		await submit(t, alice.token, a.sp, a.cid, "weekly");
		const ap = await pendingApproval(t, alice.token, a.sp, a.cid);
		const id = (ap.detail as SkillDraftApprovalDetail).draftId;
		const svc = skillDraftsFor(t.app.ctx);
		assert.equal(svc.forOwner((await t.app.ctx.services.get("identity").principalFor(alice.me.userId, alice.me.orgId))!, id).id, id);
		assert.throws(() => svc.forOwner({ orgId: alice.me.orgId, userId: bob.me.userId } as any, id), /不存在/);
		assert.throws(() => svc.forOwner({ orgId: "other-org", userId: alice.me.userId } as any, id), /不存在/);
	} finally {
		await t.dispose();
	}
});

test("idempotency: same callId twice → one draft, frozen snapshot reused (workspace not re-read), one skill; save twice and save after a lost row update → one skill", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		const root = writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		const svc = skillDraftsFor(t.app.ctx);
		const actor = await actorFor(t, alice, sp, cid, "call-1");
		const first = await svc.snapshot(actor, "weekly");
		assert.ok(first.created);
		writeFileSync(join(root, "SKILL.md"), skillMd({ body: "changed" }));
		rmSync(root, { recursive: true });
		const again = await svc.snapshot(actor, "weekly"); // dir is gone: a rerun must not touch the workspace
		assert.equal(again.created, false);
		assert.equal(again.row.id, first.row.id);
		assert.equal(again.row.package_sha256, first.row.package_sha256);
		assert.equal(count(t, "skill_ws_drafts"), 1);
		assert.equal(audits(t, "skill.draft.submit").length, 1);
		const approval = svc.approvalRequest(again.row, alice.me.orgId);
		assert.equal(approval.risk, "low");

		const p = actor.principal;
		const s1 = await svc.save(p, first.row.id);
		const s2 = await svc.save(p, first.row.id);
		assert.equal(s1.state, "saved");
		assert.equal(s2.skill_id, s1.skill_id);
		assert.equal(count(t, "skill_skills"), 1);
		assert.equal(count(t, "skill_versions"), 1);
		assert.equal(audits(t, "skill.draft.saved").length, 1);

		// Crash between Market.upload and the row update: the version exists but the draft is still pending → adopted, not duplicated.
		const a2 = await actorFor(t, alice, sp, cid, "call-2");
		writeSkill(t, sp, cid, "other", { "SKILL.md": skillMd({ name: "other-skill" }) });
		const d2 = (await svc.snapshot(a2, "other")).row;
		const market = t.app.ctx.services.get("market") as Market;
		const files = JSON.parse(d2.files).map((f: any) => ({ path: f.path, content: Buffer.from(t.app.ctx.blobs.get(f.sha256)!).toString("base64"), encoding: "base64" as const }));
		const up = await market.upload(p, { files });
		const healed = await svc.save(p, d2.id);
		assert.equal(healed.state, "saved");
		assert.equal(healed.skill_id, up.skill.id);
		assert.equal(count(t, "skill_skills", "slug = 'other-skill'"), 1);
		assert.equal(count(t, "skill_versions", "skill_id = ?", up.skill.id), 1);

		// A new version of an owned skill goes to the same skill (updatesSkill) and bumps the version number.
		const a3 = await actorFor(t, alice, sp, cid, "call-3");
		writeSkill(t, sp, cid, "weekly2", { "SKILL.md": skillMd({ version: "1.1.0", body: "# v2\n三段式，加一段「亮点」。" }) });
		const d3 = (await svc.snapshot(a3, "weekly2")).row;
		const det3 = JSON.parse(d3.detail) as SkillDraftApprovalDetail;
		assert.equal(det3.updatesSkill?.id, s1.skill_id);
		assert.equal(det3.updatesSkill?.fromVersion, "1.0.0");
		assert.match(svc.approvalRequest(d3, alice.me.orgId).summary, /新增版本 v1\.1\.0/);
		const s3 = await svc.save(p, d3.id);
		assert.equal(s3.skill_id, s1.skill_id);
		assert.equal(s3.version_no, 2);

		// Same semver again → clean failure (the agent must bump the version), nothing duplicated.
		const a4 = await actorFor(t, alice, sp, cid, "call-4");
		writeSkill(t, sp, cid, "weekly3", { "SKILL.md": skillMd({ version: "1.1.0", body: "# 另一个内容" }) });
		const s4 = await svc.save(p, (await svc.snapshot(a4, "weekly3")).row.id);
		assert.equal(s4.state, "failed");
		assert.match(s4.error!, /version_exists/);
		assert.equal(count(t, "skill_versions", "skill_id = ?", s1.skill_id!), 2);
		void sha256Hex;
	} finally {
		await t.dispose();
	}
});

test("restart while the approval is pending: still pending after restart, approve once → exactly one draft, one approval, one skill", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "wr-sd-restart-"));
	let t = await startTestApp({ dataDir });
	try {
		wire(t);
		const alice = await t.user("alice-restart@example.com");
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		await submit(t, alice.token, sp, cid, "weekly");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		await t.stop();

		t = await startTestApp({ dataDir });
		wire(t);
		const login = await t.json("POST", "/api/auth/login", { json: { email: "alice-restart@example.com", password: "password123" } });
		const ap2 = await pendingApproval(t, login.token, sp, cid);
		assert.equal(ap2.approvalId, ap.approvalId, "same durable approval");
		assert.equal((ap2.detail as SkillDraftApprovalDetail).packageSha256, (ap.detail as SkillDraftApprovalDetail).packageSha256);
		assert.equal(count(t, "skill_skills"), 0);
		await decide(t, login.token, sp, cid, ap2.approvalId, "approved");
		const s = await idle(t, login.token, sp, cid, "approved after restart");
		assert.equal(s.approvals.length, 1, "one approval");
		assert.equal(count(t, "skill_ws_drafts"), 1);
		assert.equal(count(t, "skill_skills"), 1);
		assert.equal(count(t, "skill_versions"), 1);
		assert.equal(count(t, "skill_ws_drafts", "state = 'saved'"), 1);
		assert.match(results(s, "skill_manage").at(-1).text, /已保存/);
		assert.equal(audits(t, "skill.draft.saved").length, 1);
	} finally {
		await t.stop();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("org policy: review → saved but pending review (not usable); disabled → refused before any draft or approval", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-pol@example.com");
		const market = t.app.ctx.services.get("market") as Market;
		await t.json("PUT", "/api/market/policy", { token: alice.token, json: { personalSkill: "review" } });
		const { sp, cid } = await newConv(t, bob.token);
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		await submit(t, bob.token, sp, cid, "weekly");
		const ap = await pendingApproval(t, bob.token, sp, cid);
		assert.match(ap.summary, /组织策略要求审核/);
		await decide(t, bob.token, sp, cid, ap.approvalId, "approved");
		const s = await idle(t, bob.token, sp, cid, "review run");
		assert.match(results(s, "skill_manage")[0].text, /通过审核之前它还不能使用/);
		const skillId = skillDraftsFor(t.app.ctx).row((ap.detail as SkillDraftApprovalDetail).draftId)!.skill_id!;
		assert.ok(skillId);
		assert.equal(t.app.ctx.db.get<any>("SELECT state FROM market_submissions WHERE subject_id = ?", skillId)?.state, "pending_review");
		const skills = t.app.ctx.services.get("skills") as Skills;
		const active = await skills.active((await t.app.ctx.services.get("identity").principalFor(bob.me.userId, bob.me.orgId))!, t.app.ctx.services.get("identity").space(sp)!);
		assert.ok(!active.some((a) => a.skill.id === skillId), "pending-review skill is not usable");

		await t.json("PUT", "/api/market/policy", { token: alice.token, json: { personalSkill: "disabled" } });
		assert.equal(market.policy(alice.me.orgId).personalSkill, "disabled");
		const before = count(t, "skill_ws_drafts");
		writeSkill(t, sp, cid, "second", { "SKILL.md": skillMd({ name: "second-skill" }) });
		await submit(t, bob.token, sp, cid, "second");
		const s2 = await idle(t, bob.token, sp, cid, "disabled run");
		const r = results(s2, "skill_manage").at(-1);
		assert.ok(r.isError);
		assert.match(r.text, /不允许个人技能/);
		assert.equal(count(t, "skill_ws_drafts"), before, "no draft row");
		assert.equal(s2.approvals.filter((a: any) => a.status === "pending").length, 0);
	} finally {
		await t.dispose();
	}
});

test("get_draft via the agent, and GET /skill-drafts/:id (owner only) returns the contract DTO", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-get@example.com");
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		await submit(t, alice.token, sp, cid, "weekly");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		const id = (ap.detail as SkillDraftApprovalDetail).draftId;
		await decide(t, alice.token, sp, cid, ap.approvalId, "rejected");
		await idle(t, alice.token, sp, cid, "rejected");
		await send(t, alice.token, sp, cid, `[[call skill_manage {"action":"get_draft","draftId":"${id}"}]]`);
		const s = await idle(t, alice.token, sp, cid, "get_draft run");
		assert.match(results(s, "skill_manage").at(-1).text, /用户拒绝/);
		// another user asks for the same id through the agent: not found
		const b = await newConv(t, bob.token);
		await send(t, bob.token, b.sp, b.cid, `[[call skill_manage {"action":"get_draft","draftId":"${id}"}]]`);
		const sb = await idle(t, bob.token, b.sp, b.cid, "bob get_draft");
		assert.ok(results(sb, "skill_manage")[0].isError);

		// HTTP route, mounted on a stand-alone Hono app with the principal middleware (module.ts mounts it under /api).
		const identity = t.app.ctx.services.get("identity");
		const get = async (u: { me: any }, rid: string) => {
			const h = new Hono<AppEnv>();
			const principal = (await identity.principalFor(u.me.userId, u.me.orgId))!;
			h.use("*", async (c, next) => {
				c.set("principal", principal);
				await next();
			});
			h.onError((e: any, c) => c.json({ error: { code: e.code } }, e.status ?? 500));
			registerSkillDraftRoutes(h, t.app.ctx);
			return h.request(`/skill-drafts/${rid}`);
		};
		const ok = await get(alice, id);
		assert.equal(ok.status, 200);
		const { draft } = (await ok.json()) as any;
		assert.deepEqual(Object.keys(draft).sort(), ["conversationId", "createdAt", "decidedAt", "detail", "id", "spaceId", "state"]);
		assert.equal(draft.state, "rejected");
		assert.equal(draft.detail.kind, "skill_draft");
		assert.equal((await get(bob, id)).status, 404, "other user, same org");
		assert.equal((await get(alice, "skd_nope")).status, 404);
	} finally {
		await t.dispose();
	}
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Updating an existing skill from a conversation (the market/org "weekly-report" bug): the target is resolved BEFORE the approval.
const principalOf = async (t: TestApp, u: { me: any }) => (await t.app.ctx.services.get("identity").principalFor(u.me.userId, u.me.orgId))!;
const filesOf = (md: string, extra: Record<string, string> = {}) => [{ path: "SKILL.md", content: md }, ...Object.entries(extra).map(([path, content]) => ({ path, content }))];
/** The org owner uploads a skill and publishes it org-wide (force publish, audited) → a market/org skill that owner authored. */
async function publishOrgSkill(t: TestApp, owner: { me: any }, files: { path: string; content: string }[]) {
	const market = t.app.ctx.services.get("market") as Market;
	const p = await principalOf(t, owner);
	const up = await market.upload(p, { files });
	await market.forcePublish(p, up.skill.id, 1, "test");
	return up.skill.id;
}
const ownedBy = (t: TestApp, skillId: string) => (t.app.ctx.services.get("skills") as Skills).skill(skillId)!;
const noApprovals = (s: any) => assert.equal(s.approvals.length, 0, "no approval card was created");

test("update a market/org skill the user may write: approval says update + vX → vY + review, approve → NEW VERSION of the same skill, submitted for review (old version stays live)", async () => {
	const { t, alice } = await setup();
	try {
		const skillId = await publishOrgSkill(t, alice, filesOf(skillMd()));
		assert.equal(ownedBy(t, skillId).scope, "org");
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "weekly-report", { "SKILL.md": skillMd({ version: "1.1.0", body: "# 周报 v2\n加一段「亮点」。" }) });
		await submit(t, alice.token, sp, cid, "weekly-report");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		const d = ap.detail as SkillDraftApprovalDetail;
		assert.deepEqual({ mode: d.target?.mode, scope: d.target?.scope, marketScope: d.target?.marketScope, from: d.target?.fromVersion, to: d.target?.toVersion, review: d.target?.reviewRequired, id: d.target?.skillId }, { mode: "update", scope: "market", marketScope: "org", from: "1.0.0", to: "1.1.0", review: true, id: skillId });
		assert.match(d.target!.text, /更新市场技能「weekly-report」：v1\.0\.0 → v1\.1\.0.*提交审核/);
		assert.equal(ap.title, "更新市场技能：weekly-report");
		assert.match(ap.summary, /为市场技能「weekly-report」新增版本 v1\.1\.0/);
		assert.match(ap.summary, /通过前使用者仍用旧版本/);
		assert.equal(count(t, "skill_versions", "skill_id = ?", skillId), 1, "nothing saved before approval");

		await decide(t, alice.token, sp, cid, ap.approvalId, "approved");
		const s = await idle(t, alice.token, sp, cid, "approved update");
		const res = results(s, "skill_manage")[0];
		assert.ok(!res.isError, res.text);
		assert.match(res.text, /已为市场技能「weekly-report」保存新版本 1\.1\.0/);
		assert.match(res.text, /已提交审核/);
		assert.match(res.text, /仍在用旧版本/);
		assert.equal(count(t, "skill_skills", "slug = 'weekly-report'"), 1, "no second skill");
		const skills = t.app.ctx.services.get("skills") as Skills;
		const v2 = skills.version(skillId, 2)!;
		assert.equal(v2.semver, "1.1.0");
		assert.equal(v2.package_sha256, d.packageSha256);
		const sub = t.app.ctx.db.get<any>("SELECT * FROM market_submissions WHERE subject_id = ? AND version_no = 2", skillId);
		assert.equal(sub.state, "pending_review");
		assert.equal(sub.target_scope, "org");
		const mk = t.app.ctx.services.get("market") as Market;
		assert.equal(mk.latestUsable(ownedBy(t, skillId)), 1, "the approved v1 stays what users run until v2 is approved");
		assert.equal(mk.versionApproved(v2.id), false);
		assert.equal(skillDraftsFor(t.app.ctx).dto(skillDraftsFor(t.app.ctx).row(d.draftId)!).versionNo, 2);
	} finally {
		await t.dispose();
	}
});

test("a market skill the user may NOT write: refused at submit time, no approval, no skill; the agent is told how to go on (<name>-custom / ask the author); a renamed copy then works", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-nw@example.com");
		const skillId = await publishOrgSkill(t, alice, filesOf(skillMd()));
		const { sp, cid } = await newConv(t, bob.token);
		writeSkill(t, sp, cid, "weekly-report", { "SKILL.md": skillMd({ version: "1.1.0", body: "# bob 的改法" }) });
		await submit(t, bob.token, sp, cid, "weekly-report");
		let s = await idle(t, bob.token, sp, cid, "refused");
		noApprovals(s);
		const r = results(s, "skill_manage")[0];
		assert.ok(r.isError);
		assert.match(r.text, /属于市场中的技能/);
		assert.match(r.text, /没有更新它的权限/);
		assert.match(r.text, /weekly-report-custom/, "suggests a free personal-copy name");
		assert.match(r.text, /作者或市场管理员/);
		assert.match(r.text, /没有创建审批/);
		assert.doesNotMatch(r.text, /slug_taken/, "never the late slug_taken");
		const row = t.app.ctx.db.get<any>("SELECT * FROM skill_ws_drafts");
		assert.equal(row.state, "failed");
		assert.ok((JSON.parse(row.detail) as SkillDraftApprovalDetail).findings.some((f) => f.code === "name_taken_not_writable"));
		assert.equal(count(t, "skill_versions", "skill_id = ?", skillId), 1);
		assert.equal(count(t, "skill_skills", "slug = 'weekly-report'"), 1);

		// The suggested way out: another name → ordinary new personal skill (and a taken suggestion is skipped).
		writeSkill(t, sp, cid, "weekly-report", { "SKILL.md": skillMd({ name: "weekly-report-custom", version: "1.0.0", body: "# bob 的个人副本" }) });
		await submit(t, bob.token, sp, cid, "weekly-report");
		const ap = await pendingApproval(t, bob.token, sp, cid);
		assert.equal((ap.detail as SkillDraftApprovalDetail).target?.mode, "new");
		assert.equal(ap.title, "保存为个人技能：weekly-report-custom");
		await decide(t, bob.token, sp, cid, ap.approvalId, "approved");
		s = await idle(t, bob.token, sp, cid, "copy saved");
		assert.match(results(s, "skill_manage").at(-1).text, /已保存为用户的个人技能/);
		assert.equal(count(t, "skill_skills", "slug = 'weekly-report-custom' AND owner_user_id = ?", bob.me.userId), 1);

		// Now `-custom` is taken: the next suggestion moves on.
		const { sp: sp2, cid: cid2 } = await newConv(t, bob.token);
		writeSkill(t, sp2, cid2, "w", { "SKILL.md": skillMd({ version: "9.0.0" }) });
		await submit(t, bob.token, sp2, cid2, "w");
		const s2 = await idle(t, bob.token, sp2, cid2, "refused again");
		assert.match(results(s2, "skill_manage")[0].text, /weekly-report-custom-2/);
	} finally {
		await t.dispose();
	}
});

test("update the user's own personal skill from a conversation: new version of the same skill, approval target, review policy respected", async () => {
	const { t, alice } = await setup();
	try {
		const { sp, cid } = await newConv(t, alice.token);
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd() });
		await submit(t, alice.token, sp, cid, "weekly");
		let ap = await pendingApproval(t, alice.token, sp, cid);
		assert.equal((ap.detail as SkillDraftApprovalDetail).target?.mode, "new");
		assert.match((ap.detail as SkillDraftApprovalDetail).target!.text, /新建个人技能 v1\.0\.0/);
		await decide(t, alice.token, sp, cid, ap.approvalId, "approved");
		await idle(t, alice.token, sp, cid, "v1 saved");
		const skillId = t.app.ctx.db.get<any>("SELECT id FROM skill_skills WHERE slug = 'weekly-report'").id as string;

		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd({ version: "1.0.1", body: "# 周报\n改进后的做法。" }) });
		await submit(t, alice.token, sp, cid, "weekly");
		ap = await waitFor(async () => (await state(t, alice.token, sp, cid)).approvals.find((a: any) => a.status === "pending"), { what: "second approval" });
		const d = ap.detail as SkillDraftApprovalDetail;
		assert.equal(d.target?.mode, "update");
		assert.equal(d.target?.scope, "personal");
		assert.equal(d.target?.reviewRequired, false);
		assert.equal(d.target?.text, "更新你的个人技能「weekly-report」：v1.0.0 → v1.0.1");
		assert.equal(ap.title, "更新个人技能：weekly-report");
		await decide(t, alice.token, sp, cid, ap.approvalId, "approved");
		const s = await idle(t, alice.token, sp, cid, "v2 saved");
		const res = results(s, "skill_manage").at(-1);
		assert.ok(!res.isError, res.text);
		assert.match(res.text, /已在用户的个人技能上新增版本 1\.0\.1（原最高版本 1\.0\.0）/);
		assert.equal(count(t, "skill_skills", "slug = 'weekly-report'"), 1);
		assert.equal((t.app.ctx.services.get("skills") as Skills).skill(skillId)!.latest_version_no, 2);

		// Review policy: the next version is saved but not usable until reviewed; the card says so up front.
		await t.json("PUT", "/api/market/policy", { token: alice.token, json: { personalSkill: "review" } });
		writeSkill(t, sp, cid, "weekly", { "SKILL.md": skillMd({ version: "1.0.2", body: "# 周报\n再改一版。" }) });
		await submit(t, alice.token, sp, cid, "weekly");
		const ap3 = await waitFor(async () => (await state(t, alice.token, sp, cid)).approvals.find((a: any) => a.status === "pending"), { what: "third approval" });
		const d3 = ap3.detail as SkillDraftApprovalDetail;
		assert.equal(d3.target?.reviewRequired, true);
		assert.match(d3.target!.text, /组织策略要求审核/);
		await decide(t, alice.token, sp, cid, ap3.approvalId, "approved");
		const s3 = await idle(t, alice.token, sp, cid, "v3 saved");
		assert.match(results(s3, "skill_manage").at(-1).text, /通过审核之前它还不能使用/);
		assert.equal(t.app.ctx.db.get<any>("SELECT state FROM market_submissions WHERE subject_id = ? AND version_no = 3", skillId)?.state, "pending_review");
	} finally {
		await t.dispose();
	}
});

test("version not raised / identical content / lower version: failed at submit time with a clear fix, no approval, nothing saved (personal and market targets)", async () => {
	const { t, alice } = await setup();
	try {
		const orgSkillId = await publishOrgSkill(t, alice, filesOf(skillMd({ version: "2.0.0" })));
		const { sp, cid } = await newConv(t, alice.token);
		const attempt = async (md: string, extra: Record<string, string> = {}) => {
			writeSkill(t, sp, cid, "weekly-report", { "SKILL.md": md, ...extra });
			await submit(t, alice.token, sp, cid, "weekly-report");
			const s = await idle(t, alice.token, sp, cid, "attempt");
			noApprovals(s);
			const r = results(s, "skill_manage").at(-1);
			assert.ok(r.isError, r.text);
			return r.text as string;
		};
		// identical content
		assert.match(await attempt(skillMd({ version: "2.0.0" })), /完全相同，没有任何改动.*duplicate_content/s);
		// same version, different content
		const same = await attempt(skillMd({ version: "2.0.0", body: "# 变了" }));
		assert.match(same, /版本号 2\.0\.0 已存在/);
		assert.match(same, /version_exists/);
		assert.match(same, /例如 2\.0\.1/);
		// lower version
		const lower = await attempt(skillMd({ version: "1.5.0", body: "# 更低" }));
		assert.match(lower, /不大于技能「weekly-report」现有的最高版本 2\.0\.0/);
		assert.match(lower, /version_not_increasing/);
		assert.equal(count(t, "skill_versions", "skill_id = ?", orgSkillId), 1);
		assert.equal(count(t, "skill_ws_drafts", "state = 'failed'"), 3);
		assert.equal(count(t, "skill_ws_drafts", "state = 'pending'"), 0);
		assert.equal(audits(t, "skill.draft.saved").length, 0);
	} finally {
		await t.dispose();
	}
});

test("checkout: writes the current approved files into /work/<dir> without sandbox_exec; idempotent; refuses to overwrite edits or foreign content; unreadable skills and bad dirs refused", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-co@example.com");
		const skillId = await publishOrgSkill(t, alice, filesOf(skillMd(), { "references/format.md": "# 格式\n三段式。\n", "scripts/run.py": "print('hi')\n" }));
		const { sp, cid } = await newConv(t, bob.token);
		const checkout = async (args: Record<string, unknown>) => {
			const before = (await state(t, bob.token, sp, cid)).entries.filter((e: any) => e.kind === "tool_result" && e.toolName === "skill_manage").length;
			await send(t, bob.token, sp, cid, `[[call skill_manage ${JSON.stringify({ action: "checkout", ...args })}]]`);
			const s = await waitFor(async () => {
				const st = await idle(t, bob.token, sp, cid, "checkout");
				return results(st, "skill_manage").length > before ? st : undefined;
			}, { what: "checkout result" });
			return results(s, "skill_manage").at(-1);
		};
		const wd = workdirOf(t, sp, cid);
		const r1 = await checkout({ name: "weekly-report" });
		assert.ok(!r1.isError, r1.text);
		assert.match(r1.text, /3 个文件写入 \/work\/weekly-report/);
		assert.match(r1.text, /SKILL\.md/);
		assert.match(r1.text, /没有更新这个市场技能（组织）的权限/, "bob may only read it: told to make a personal copy");
		assert.match(r1.text, /weekly-report-custom/);
		const { readFileSync, existsSync } = await import("node:fs");
		assert.equal(readFileSync(join(wd, "weekly-report", "SKILL.md"), "utf8"), skillMd());
		assert.equal(readFileSync(join(wd, "weekly-report", "references/format.md"), "utf8"), "# 格式\n三段式。\n");
		assert.equal(readFileSync(join(wd, "weekly-report", "scripts/run.py"), "utf8"), "print('hi')\n");
		assert.equal(count(t, "tool_sandbox_runs"), 0, "no sandbox execution involved");

		// idempotent: the same call again leaves identical files; by skillId and a custom dir works too
		const r2 = await checkout({ skillId, dir: "weekly-report" });
		assert.ok(!r2.isError, r2.text);
		assert.equal(readFileSync(join(wd, "weekly-report", "SKILL.md"), "utf8"), skillMd());
		const r3 = await checkout({ name: "weekly-report", dir: "/work/copy-2" });
		assert.ok(!r3.isError, r3.text);
		assert.ok(existsSync(join(wd, "copy-2", "SKILL.md")));

		// edits are never overwritten
		writeFileSync(join(wd, "weekly-report", "SKILL.md"), skillMd({ body: "# 我改过" }));
		const r4 = await checkout({ name: "weekly-report" });
		assert.ok(r4.isError);
		assert.match(r4.text, /dir_not_empty|已有内容/);
		assert.match(r4.text, /SKILL\.md/);
		assert.match(readFileSync(join(wd, "weekly-report", "SKILL.md"), "utf8"), /我改过/);
		// a foreign non-empty dir is refused too
		writeSkill(t, sp, cid, "mine", { "notes.txt": "x" });
		const r5 = await checkout({ name: "weekly-report", dir: "mine" });
		assert.ok(r5.isError);
		assert.match(r5.text, /不是这个技能的检出目录/);
		// an extra file also counts as a change
		writeFileSync(join(wd, "copy-2", "extra.md"), "added");
		assert.ok((await checkout({ name: "weekly-report", dir: "copy-2" })).isError);

		// unknown / not readable skill, bad dir, symlink dir
		const r6 = await checkout({ name: "no-such-skill" });
		assert.ok(r6.isError);
		assert.match(r6.text, /没有你可以读取的技能/);
		assert.ok((await checkout({ name: "weekly-report", dir: "../up" })).isError);
		symlinkSync(tmpdir(), join(wd, "linked"));
		assert.ok((await checkout({ name: "weekly-report", dir: "linked" })).isError);
		assert.ok((await checkout({})).isError, "name or skillId is required");
		// a personal skill of ANOTHER user is not even visible
		const { sp: asp, cid: acid } = await newConv(t, alice.token);
		const mp = await principalOf(t, alice);
		await (t.app.ctx.services.get("market") as Market).upload(mp, { files: filesOf(skillMd({ name: "alice-private" })) });
		await send(t, bob.token, sp, cid, `[[call skill_manage {"action":"checkout","name":"alice-private"}]]`);
		const sPriv = await idle(t, bob.token, sp, cid, "private");
		assert.ok(results(sPriv, "skill_manage").at(-1).isError);
		void asp;
		void acid;
	} finally {
		await t.dispose();
	}
});

test("end to end (the user's bug): checkout the org skill → edit → bump version → submit_draft → confirm → new version; no slug_taken after approval", async () => {
	const { t, alice } = await setup();
	try {
		const skillId = await publishOrgSkill(t, alice, filesOf(skillMd(), { "references/format.md": "# 格式\n三段式。\n" }));
		const { sp, cid } = await newConv(t, alice.token);
		await send(t, alice.token, sp, cid, `[[call skill_manage {"action":"checkout","name":"weekly-report","dir":"weekly-report"}]]`);
		const s0 = await idle(t, alice.token, sp, cid, "checkout");
		const co = results(s0, "skill_manage")[0];
		assert.ok(!co.isError, co.text);
		assert.match(co.text, /下一步.*提高到大于 1\.0\.0（例如 1\.0\.1）.*submit_draft/s);
		assert.match(co.text, /保存为该技能的新版本并提交审核/);
		// edit through the normal workspace tool, bump the version
		const edited = skillMd({ version: "1.0.1", body: "# 周报\n按「本周完成 / 下周计划 / 风险」三段写，并附上数据来源。" });
		await send(t, alice.token, sp, cid, `[[call write ${JSON.stringify({ path: "/work/weekly-report/SKILL.md", content: edited })}]]`);
		await idle(t, alice.token, sp, cid, "edit");
		await submit(t, alice.token, sp, cid, "weekly-report");
		const ap = await pendingApproval(t, alice.token, sp, cid);
		const d = ap.detail as SkillDraftApprovalDetail;
		assert.equal(d.target?.mode, "update");
		assert.deepEqual(d.files.map((f) => f.path).sort(), ["SKILL.md", "references/format.md"], "the checked-out reference file travels with the new version");
		await decide(t, alice.token, sp, cid, ap.approvalId, "approved");
		const s = await idle(t, alice.token, sp, cid, "saved");
		const res = results(s, "skill_manage").at(-1);
		assert.ok(!res.isError, res.text);
		assert.doesNotMatch(res.text, /slug_taken|已被占用/);
		const v2 = (t.app.ctx.services.get("skills") as Skills).version(skillId, 2)!;
		assert.equal(v2.semver, "1.0.1");
		assert.match(v2.instructions, /数据来源/);
	} finally {
		await t.dispose();
	}
});

test("checkout over an UNMODIFIED earlier checkout picks up the newer approved version and drops files that no longer exist; an author without publish rights is refused before any approval", async () => {
	const { t, alice } = await setup();
	try {
		const bob = await orgMember(t, alice, "bob-au@example.com");
		const market = t.app.ctx.services.get("market") as Market;
		const ap_ = await principalOf(t, alice);
		const bp = await principalOf(t, bob);
		const skillId = await publishOrgSkill(t, alice, filesOf(skillMd(), { "old.md": "to be removed\n" }));
		const { sp, cid } = await newConv(t, alice.token);
		const run = async (args: Record<string, unknown>, tok = alice.token, s_ = sp, c_ = cid) => {
			const before = results(await state(t, tok, s_, c_), "skill_manage").length;
			await send(t, tok, s_, c_, `[[call skill_manage ${JSON.stringify(args)}]]`);
			const st = await waitFor(async () => {
				const x = await idle(t, tok, s_, c_, "run");
				return results(x, "skill_manage").length > before ? x : undefined;
			}, { what: "result" });
			return results(st, "skill_manage").at(-1);
		};
		const { existsSync, readFileSync } = await import("node:fs");
		const wd = workdirOf(t, sp, cid);
		const r1 = await run({ action: "checkout", name: "weekly-report" });
		assert.ok(!r1.isError, r1.text);
		assert.ok(existsSync(join(wd, "weekly-report", "old.md")));
		// v2 (approved + published) without old.md
		const v2 = await market.upload(ap_, { skillId, files: filesOf(skillMd({ version: "1.2.0", body: "# 新版" })) });
		await market.forcePublish(ap_, skillId, v2.version.version_no, "test v2");
		const r2 = await run({ action: "checkout", name: "weekly-report" });
		assert.ok(!r2.isError, r2.text);
		assert.match(readFileSync(join(wd, "weekly-report", "SKILL.md"), "utf8"), /新版/);
		assert.ok(!existsSync(join(wd, "weekly-report", "old.md")), "stale file of the old checkout removed");
		assert.match(r2.text, /已移除旧检出里不再存在的文件：old\.md/);
		assert.match(r2.text, /1\.2\.0/);

		// bob authors a skill that gets published org-wide by the owner; bob can edit it but cannot submit versions to the org scope.
		const up = await market.upload(bp, { files: filesOf(skillMd({ name: "bobs-skill" })) });
		await market.forcePublish(ap_, up.skill.id, 1, "publish bob's");
		assert.equal(ownedBy(t, up.skill.id).scope, "org");
		const b = await newConv(t, bob.token);
		writeSkill(t, b.sp, b.cid, "bobs-skill", { "SKILL.md": skillMd({ name: "bobs-skill", version: "1.0.1", body: "# 更新" }) });
		await submit(t, bob.token, b.sp, b.cid, "bobs-skill");
		const sb = await idle(t, bob.token, b.sp, b.cid, "no publish right");
		noApprovals(sb);
		const rr = results(sb, "skill_manage")[0];
		assert.ok(rr.isError);
		assert.match(rr.text, /没有向它所在范围提交新版本审核的权限（skill\.publish）/);
		assert.match(rr.text, /bobs-skill-custom/);
		assert.equal(count(t, "skill_versions", "skill_id = ?", up.skill.id), 1);
	} finally {
		await t.dispose();
	}
});
