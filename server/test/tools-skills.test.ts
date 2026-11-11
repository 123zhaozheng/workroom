// Skills: kinds, versions (install/pin/upgrade/disable/rollback), exact version recorded per run, load ≠ permission,
// create-from-task draft → preview → validate (sample run) → publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { answer, call, context, fakeApi, fixedActor, toolHarness } from "./fixtures/tool-harness.ts";
import { createSkillsExtension } from "../src/tools/skills.ts";
import { createSandboxExtension } from "../src/tools/sandbox-tools.ts";
import { createFilesExtension } from "../src/files/extension.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

const noIsolation = probeIsolation().ok ? false : probeIsolation().detail;
const script = (tag: string) => `import sys\nprint("${tag} hello " + sys.argv[1])\n`;

test("skill kinds are distinct; versions pin/upgrade/disable/rollback; runs record the exact version; loading text never grants execution", { skip: noIsolation }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("sk@example.com");
		const m = await orgMember(t, a, "skm@example.com");
		const ctx = t.app.ctx;
		const preset = await t.json("POST", "/api/skills", { token: a.token, json: { name: "周报模板", kind: "prompt", description: "写周报", instructions: "按「本周完成 / 下周计划 / 风险」三段写周报：{{input}}" } });
		const ctxSkill = await t.json("POST", "/api/skills", { token: a.token, json: { name: "审稿要点", kind: "context", description: "审稿", instructions: "# 审稿要点\n- 检查数据来源\n- 检查结论是否有证据" } });
		const exe = await t.json("POST", "/api/skills", { token: a.token, json: { name: "greeter", kind: "executable", description: "打招呼脚本", instructions: "# greeter\n运行 main.py，输入一个名字。", resources: [{ path: "main.py", content: script("v1") }], entry: "main.py", requiredTools: ["sandbox_exec"] } });
		assert.equal(preset.skill.kind, "prompt");
		assert.equal(ctxSkill.skill.kind, "context");
		assert.equal(exe.skill.kind, "executable");
		assert.deepEqual(exe.skill.versions[0].requiredPermissions, ["sandbox.exec"]);
		assert.deepEqual(exe.skill.versions[0].resources.map((r: any) => r.path), ["main.py"]);
		assert.deepEqual(preset.skill.versions[0].requiredPermissions, []);
		const listed = await t.json("GET", "/api/skills", { token: a.token });
		assert.deepEqual(listed.skills.map((s: any) => s.kind).sort(), ["context", "executable", "prompt"]);
		// Personal skills are private; members cannot publish org skills; invalid executable declarations are refused.
		assert.equal((await t.json("GET", "/api/skills", { token: m.token })).skills.length, 0);
		await t.json("GET", `/api/skills/${exe.skill.id}`, { token: m.token, expect: 403 });
		await t.json("POST", "/api/skills", { token: m.token, json: { name: "x", kind: "context", scope: "org", instructions: "x" }, expect: 403 });
		await t.json("POST", "/api/skills", { token: a.token, json: { name: "bad", kind: "executable", instructions: "x", resources: [{ path: "a.py", content: "" }], entry: "missing.py" }, expect: 400 });
		await t.json("POST", "/api/skills", { token: a.token, json: { name: "bad2", kind: "context", instructions: "x", requiredPermissions: ["root"] }, expect: 400 });

		// v2 of the executable skill
		const v2 = await t.json("POST", `/api/skills/${exe.skill.id}/versions`, { token: a.token, json: { instructions: "# greeter v2", resources: [{ path: "main.py", content: script("v2") }], entry: "main.py", changeNote: "改问候语" } });
		assert.equal(v2.skill.latestVersionNo, 2);
		assert.throws(() => ctx.db.run("UPDATE skill_versions SET instructions = 'x'"), /immutable/);

		const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const ext = createSkillsExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, space.id) });
		const [, load, run] = ext.tools!;
		let n = 0;
		const api = () => fakeApi({ conversationId: 11, taskId: ++n, callId: `c${n}` });
		const loadText = async (name: string) => ((await load!.execute({ name } as any, api(), context)).output as any)[0].text as string;

		// Pin v1 → load records v1; upgrade → v2; rollback → v1; disable → denied; follow latest → v2.
		await t.json("PATCH", `/api/skills/${exe.skill.id}/install`, { token: a.token, json: { pinnedVersionNo: 1 } });
		assert.match(await loadText("greeter"), /version="1"/);
		let s = (await t.json("POST", `/api/skills/${exe.skill.id}/install/upgrade`, { token: a.token })).skill;
		assert.equal(s.install.effectiveVersionNo, 2);
		assert.match(await loadText("greeter"), /version="2"[\s\S]*greeter v2/);
		s = (await t.json("POST", `/api/skills/${exe.skill.id}/install/rollback`, { token: a.token })).skill;
		assert.equal(s.install.effectiveVersionNo, 1);
		assert.match(await loadText("greeter"), /version="1"/);
		await t.json("PATCH", `/api/skills/${exe.skill.id}/install`, { token: a.token, json: { enabled: false } });
		await assert.rejects(load!.execute({ name: "greeter" } as any, api(), context), /已停用/);
		await t.json("PATCH", `/api/skills/${exe.skill.id}/install`, { token: a.token, json: { enabled: true } });

		// Loading text (v1) does not grant execution.
		assert.match(await loadText("greeter"), /不授予执行脚本/);
		await assert.rejects(run!.execute({ name: "greeter", input: "world" } as any, api(), context), /需要用户授权：sandbox\.exec/);
		await t.json("POST", `/api/skills/${exe.skill.id}/grants`, { token: a.token, json: { versionNo: 1, permissions: ["sandbox.exec"] } });
		await t.json("POST", `/api/skills/${exe.skill.id}/grants`, { token: a.token, json: { versionNo: 1, permissions: ["network"] }, expect: 400 });
		const ok = await run!.execute({ name: "greeter", input: "world" } as any, api(), context);
		assert.equal(ok.isError, false, (ok.output as any)[0].text);
		assert.match((ok.output as any)[0].text, /v1 hello world/);
		// Grants are per version: after upgrading, v2 needs its own grant.
		await t.json("POST", `/api/skills/${exe.skill.id}/install/upgrade`, { token: a.token });
		await assert.rejects(run!.execute({ name: "greeter", input: "x" } as any, api(), context), /v2 需要用户授权/);
		await t.json("POST", `/api/skills/${exe.skill.id}/grants`, { token: a.token, json: { versionNo: 2, permissions: ["sandbox.exec"] } });
		assert.match(((await run!.execute({ name: "greeter", input: "x" } as any, api(), context)).output as any)[0].text, /v2 hello x/);
		// Context skills cannot be "run".
		await assert.rejects(run!.execute({ name: "审稿要点" } as any, api(), context), /不是可执行技能/);

		const runs = (await t.json("GET", `/api/skills/${exe.skill.id}/runs`, { token: a.token })).runs.reverse();
		assert.deepEqual(runs.map((r: any) => `${r.mode}:v${r.versionNo}:${r.status}`), ["load:v1:ok", "load:v2:ok", "load:v1:ok", "load:v1:ok", "run:v1:denied", "run:v1:ok", "run:v2:denied", "run:v2:ok"]);
		assert.ok(runs.every((r: any) => r.conversationId === 11 && typeof r.taskId === "number"));
	} finally {
		await t.dispose();
	}
});

test("create a skill from a successful task: draft preview, validation with a sample run, publish only when validated", { skip: noIsolation }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("draft@example.com");
		const other = await t.user("draft-other@example.com");
		const ctx = t.app.ctx;
		const space = ctx.services.get("identity").personalSpace(a.me.userId, a.me.orgId);
		const actor = fixedActor(ctx, a.me.userId, a.me.orgId, space.id);
		const h = await toolHarness([createSandboxExtension(ctx, { resolveActor: actor }), createFilesExtension(ctx, { resolveActor: actor })], [
			call("sandbox_exec", { language: "python", code: "import sys\nrows=[1,2]\nprint('total=' + str(len(rows) + 1))" }, "t1"),
			call("file_create", { name: "汇总", format: "md", content: "total=3" }, "t2"),
			answer("done"),
		]);
		await h.run("统计行数并写一份汇总");
		await h.close();
		const conversationId = Number(h.root.id);

		await t.json("POST", "/api/skills/drafts", { token: other.token, json: { spaceId: space.id, conversationId }, expect: 403 });
		const { draft } = await t.json("POST", "/api/skills/drafts", { token: a.token, json: { spaceId: space.id, conversationId, name: "行数汇总" } });
		assert.equal(draft.kind, "executable");
		assert.equal(draft.entry, "main.py");
		assert.deepEqual([...draft.requiredTools].sort(), ["file_create", "sandbox_exec"]);
		assert.deepEqual([...draft.requiredPermissions].sort(), ["file.write", "sandbox.exec"]);
		assert.match(draft.instructions, /## 步骤[\s\S]*sandbox_exec[\s\S]*file_create/);
		assert.match(draft.instructions, /汇总\.md/);
		assert.equal(draft.sample.expectContains, "total=3");
		assert.equal(draft.validation, undefined);

		await t.json("POST", `/api/skills/drafts/${draft.id}/publish`, { token: a.token, expect: 409 });
		const v = (await t.json("POST", `/api/skills/drafts/${draft.id}/validate`, { token: a.token })).draft;
		assert.equal(v.validation.ok, true, JSON.stringify(v.validation.checks));
		assert.ok(v.validation.checks.some((c: any) => c.name === "样例输出符合预期" && c.ok));
		// Editing invalidates the validation; a failing sample blocks publishing.
		const edited = (await t.json("PATCH", `/api/skills/drafts/${draft.id}`, { token: a.token, json: { sample: { input: "", expectContains: "total=4" } } })).draft;
		assert.equal(edited.validation, undefined);
		const bad = (await t.json("POST", `/api/skills/drafts/${draft.id}/validate`, { token: a.token })).draft;
		assert.equal(bad.validation.ok, false);
		await t.json("POST", `/api/skills/drafts/${draft.id}/publish`, { token: a.token, expect: 409 });
		await t.json("PATCH", `/api/skills/drafts/${draft.id}`, { token: a.token, json: { sample: { input: "", expectContains: "total=3" } } });
		await t.json("POST", `/api/skills/drafts/${draft.id}/validate`, { token: a.token });
		const pub = (await t.json("POST", `/api/skills/drafts/${draft.id}/publish`, { token: a.token })).skill;
		assert.equal(pub.name, "行数汇总");
		assert.equal(pub.versions[0].source, "from_task");
		assert.equal(pub.versions[0].validation.ok, true);
		assert.equal(pub.install.effectiveVersionNo, 1);
		assert.deepEqual(pub.install.grantedPermissions, []); // publishing does not grant execution either

		// A conversation without sandbox runs becomes a context skill, validated on the fixture model.
		// (Separate space: each test harness numbers its conversations from scratch, as each space's storage does.)
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "纪要" } });
		const h2 = await toolHarness([createFilesExtension(ctx, { resolveActor: fixedActor(ctx, a.me.userId, a.me.orgId, project.spaceId) })], [call("file_create", { name: "纪要", format: "docx", content: "会议纪要" }, "u1"), answer("ok")]);
		await h2.run("写会议纪要");
		await h2.close();
		const d2 = (await t.json("POST", "/api/skills/drafts", { token: a.token, json: { spaceId: project.spaceId, conversationId: Number(h2.root.id) } })).draft;
		assert.equal(d2.kind, "context");
		const v2 = (await t.json("POST", `/api/skills/drafts/${d2.id}/validate`, { token: a.token })).draft;
		assert.equal(v2.validation.ok, true, JSON.stringify(v2.validation.checks));
		assert.ok(v2.validation.checks.some((c: any) => /测试模型/.test(c.name) && c.ok));
	} finally {
		await t.dispose();
	}
});
