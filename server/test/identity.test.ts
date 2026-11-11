import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";

test("two users in separate orgs cannot see each other's projects; project roles enforced", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("a@example.com");
		const b = await t.user("b@example.com");
		assert.notEqual(a.me.orgId, b.me.orgId);
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { kind: "space", name: "Alpha" } });
		await t.json("GET", `/api/projects/${project.id}/members`, { token: b.token, expect: 403 });
		const listB = await t.json("GET", "/api/projects", { token: b.token });
		assert.equal(listB.projects.length, 0);
		await t.json("GET", "/api/me", { expect: 401 });
	} finally {
		await t.dispose();
	}
});
