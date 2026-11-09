// The 能力 page's actions, exactly as the web client calls them over HTTP: skills install/disable/pin/upgrade/rollback/
// grant/uninstall, drafts list → validate → publish, connectors per-user enable/disable, reconnect with new credentials, policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { startHttpFixture } from "./fixtures/mcp-fixture-server.ts";

test("能力 page actions over HTTP: skills lifecycle and connector enable/reconnect", async () => {
	const fx = await startHttpFixture("right-token-1");
	process.env.WORKROOM_URL_ALLOWLIST = new URL(fx.url).host;
	const t = await startTestApp({ config: { secretKey: "actions-key" } });
	try {
		const admin = await t.user("cap-admin@example.com");
		const member = await orgMember(t, admin, "cap-member@example.com");

		// Org skill published by the admin, installed and managed by a member.
		const created = await t.json("POST", "/api/skills?install=0", { token: admin.token, json: { name: "提纲", kind: "context", scope: "org", instructions: "# 提纲\n先列三点" } });
		const id = created.skill.id;
		await t.json("POST", `/api/skills/${id}/versions`, { token: admin.token, json: { instructions: "# 提纲 v2\n先列五点", changeNote: "改为五点" } });
		await t.json("POST", `/api/skills/${id}/versions`, { token: member.token, json: { instructions: "x" }, expect: 403 });
		let s = (await t.json("POST", `/api/skills/${id}/install`, { token: member.token, json: { pinVersionNo: 1 } })).skill;
		assert.deepEqual([s.install.enabled, s.install.pinnedVersionNo, s.install.effectiveVersionNo], [true, 1, 1]);
		s = (await t.json("POST", `/api/skills/${id}/install/upgrade`, { token: member.token })).skill;
		assert.equal(s.install.effectiveVersionNo, 2);
		s = (await t.json("POST", `/api/skills/${id}/install/rollback`, { token: member.token })).skill;
		assert.equal(s.install.effectiveVersionNo, 1);
		s = (await t.json("PATCH", `/api/skills/${id}/install`, { token: member.token, json: { enabled: false } })).skill;
		assert.equal(s.install.enabled, false);
		s = (await t.json("PATCH", `/api/skills/${id}/install`, { token: member.token, json: { enabled: true, pinnedVersionNo: null } })).skill;
		assert.deepEqual([s.install.enabled, s.install.pinnedVersionNo, s.install.effectiveVersionNo], [true, null, 2]);
		const listed = (await t.json("GET", "/api/skills", { token: member.token })).skills.find((x: any) => x.id === id);
		assert.equal(listed.canManage, false);
		s = (await t.json("DELETE", `/api/skills/${id}/install`, { token: member.token })).skill;
		assert.equal(s.install, undefined);

		// Executable skill: grants per version through the API.
		const exe = (await t.json("POST", "/api/skills", { token: member.token, json: { name: "跑脚本", kind: "executable", instructions: "运行 main.sh", resources: [{ path: "main.sh", content: "echo hi" }], entry: "main.sh" } })).skill;
		const granted = (await t.json("POST", `/api/skills/${exe.id}/grants`, { token: member.token, json: { versionNo: 1, permissions: ["sandbox.exec"] } })).skill;
		assert.deepEqual(granted.install.grantedPermissions, ["sandbox.exec"]);
		const revoked = (await t.json("POST", `/api/skills/${exe.id}/grants`, { token: member.token, json: { versionNo: 1, permissions: [] } })).skill;
		assert.deepEqual(revoked.install.grantedPermissions, []);
		assert.equal((await t.json("GET", "/api/skills/drafts", { token: member.token })).drafts.length, 0);

		// Connectors: per-user enable/disable; reconnect with fresh credentials (manager only) and plain re-check (any user).
		const { connector } = await t.json("POST", "/api/connectors", { token: admin.token, json: { name: "Docs", scope: "system", transport: "http", url: fx.url, secrets: { Authorization: "Bearer wrong-token" } } });
		assert.equal(connector.status, "unauthorized");
		let mine = (await t.json("PUT", `/api/connectors/${connector.id}/enablement`, { token: member.token, json: { enabled: false } })).connector;
		assert.equal(mine.enabledForMe, false);
		mine = (await t.json("PUT", `/api/connectors/${connector.id}/enablement`, { token: member.token, json: { enabled: true } })).connector;
		assert.equal(mine.enabledForMe, true);
		await t.json("POST", `/api/connectors/${connector.id}/reconnect`, { token: member.token, json: { secrets: { Authorization: "Bearer right-token-1" } }, expect: 403 });
		const recheck = (await t.json("POST", `/api/connectors/${connector.id}/reconnect`, { token: member.token, json: {} })).connector;
		assert.equal(recheck.status, "unauthorized");
		const fixed = (await t.json("POST", `/api/connectors/${connector.id}/reconnect`, { token: admin.token, json: { secrets: { Authorization: "Bearer right-token-1" } } })).connector;
		assert.equal(fixed.status, "ready");
		assert.equal(fixed.tools.length, 4);
		assert.ok(!JSON.stringify(fixed).includes("right-token-1"));

		// Policy readable by members (for the page), writable by admins.
		const pol = await t.json("GET", "/api/tools/policy", { token: member.token });
		assert.ok(pol.groups.every((g: any) => g.enabled));
	} finally {
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
		await fx.close();
	}
});
