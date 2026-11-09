import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import type { Identity } from "../src/identity/module.ts";
import { base32Encode, hotp, totpAt, verifyTotp } from "../src/identity/totp.ts";

async function orgWithMembers(t: TestApp) {
	const owner = await t.user("owner@a.example", { name: "Owner" });
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const m1 = await t.user("m1@a.example", { inviteCode: inv.invite.code, name: "M1" });
	const inv2 = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "admin" } });
	const admin = await t.user("admin@a.example", { inviteCode: inv2.invite.code, name: "Admin" });
	return { owner, m1, admin };
}

test("disable member → existing sessions 401 everywhere, login refused; enable restores", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await orgWithMembers(t);
		assert.equal(m1.me.orgId, owner.me.orgId);
		assert.equal(m1.me.orgRole, "member");
		const { project } = await t.json("POST", "/api/projects", { token: m1.token, json: { name: "M1 project" } });
		await t.json("GET", "/api/me", { token: m1.token });
		const r = await t.json("POST", `/api/admin/members/${m1.me.userId}/disable`, { token: owner.token });
		assert.ok(r.revokedSessions >= 1);
		for (const path of ["/api/me", "/api/projects", "/api/org/members", `/api/projects/${project.id}`, "/api/me/sessions", "/api/departments"]) await t.json("GET", path, { token: m1.token, expect: 401 });
		await t.json("POST", "/api/auth/login", { json: { email: "m1@a.example", password: "password123" }, expect: 403 });
		const members = await t.json("GET", "/api/admin/members", { token: owner.token });
		assert.equal(members.members.find((m: any) => m.userId === m1.me.userId).status, "disabled");
		// Automations/background work re-resolve via principalFor → null while disabled.
		const id = t.app.ctx.services.get("identity") as Identity;
		assert.equal(await id.principalFor(m1.me.userId, m1.me.orgId), null);
		await t.json("POST", `/api/admin/members/${m1.me.userId}/enable`, { token: owner.token });
		const again = await t.json("POST", "/api/auth/login", { json: { email: "m1@a.example", password: "password123" } });
		await t.json("GET", `/api/projects/${project.id}`, { token: again.token });
		await t.json("GET", "/api/me", { token: m1.token, expect: 401 }); // old session stays revoked
		const audit = await t.json("GET", "/api/admin/audit?action=member.*", { token: owner.token });
		assert.deepEqual(audit.items.map((a: any) => a.action).sort(), ["member.disable", "member.enable"]);
	} finally {
		await t.dispose();
	}
});

test("remove org member → sessions revoked, project memberships and share links removed", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await orgWithMembers(t);
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { name: "Shared" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: "editor" } });
		const share = await t.json("POST", "/api/shares", { token: m1.token, json: { kind: "project", id: project.id } });
		await t.json("GET", `/api/shared/${share.share.token}`);
		const out = await t.json("DELETE", `/api/admin/members/${m1.me.userId}`, { token: owner.token });
		assert.equal(out.projects, 1);
		assert.equal(out.shares, 1);
		await t.json("GET", "/api/me", { token: m1.token, expect: 401 });
		await t.json("GET", `/api/shared/${share.share.token}`, { expect: 410 });
		const pm = await t.json("GET", `/api/projects/${project.id}/members`, { token: owner.token });
		assert.equal(pm.members.length, 1);
		// Org must keep an owner; owner cannot remove self.
		await t.json("DELETE", `/api/admin/members/${owner.me.userId}`, { token: owner.token, expect: 400 });
	} finally {
		await t.dispose();
	}
});

test("project roles: viewer read-only, removal → 403 on project resources, share re-checked", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, admin } = await orgWithMembers(t);
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { name: "Roles" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: "viewer" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "admin@a.example", role: "editor" } });
		await t.json("GET", `/api/projects/${project.id}`, { token: m1.token });
		// viewer: cannot manage members, cannot share, cannot rename
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: m1.token, json: { email: "admin@a.example", role: "viewer" }, expect: 403 });
		await t.json("POST", "/api/shares", { token: m1.token, json: { kind: "project", id: project.id }, expect: 403 });
		await t.json("PATCH", `/api/projects/${project.id}`, { token: m1.token, json: { name: "x" }, expect: 403 });
		// editor can share but not manage members
		const share = await t.json("POST", "/api/shares", { token: admin.token, json: { kind: "project", id: project.id } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: admin.token, json: { email: "m1@a.example", role: "editor" }, expect: 403 });
		const acl = t.app.ctx.services.get("acl");
		const id = t.app.ctx.services.get("identity") as Identity;
		const viewerP = (await id.principalFor(m1.me.userId, m1.me.orgId))!;
		assert.equal((await acl.check(viewerP, "write", { kind: "project", id: project.id })).reason, "role_viewer");
		assert.equal((await acl.check(viewerP, "read", { kind: "conversation", id: "1", spaceId: project.spaceId })).allow, true);
		assert.equal((await acl.check(viewerP, "write", { kind: "conversation", id: "1", spaceId: project.spaceId })).allow, false);
		// remove viewer → 403 everywhere in the project
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "m1@a.example", role: null } });
		await t.json("GET", `/api/projects/${project.id}`, { token: m1.token, expect: 403 });
		await t.json("GET", `/api/projects/${project.id}/members`, { token: m1.token, expect: 403 });
		assert.equal((await acl.check(viewerP, "read", { kind: "conversation", id: "1", spaceId: project.spaceId })).reason, "not_member");
		assert.equal((await t.json("GET", "/api/projects", { token: m1.token })).projects.length, 0);
		// remove the editor who created the share → link revoked eagerly
		await t.json("GET", `/api/shared/${share.share.token}`);
		const rm = await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "admin@a.example", role: null } });
		assert.equal(rm.revokedShares, 1);
		await t.json("GET", `/api/shared/${share.share.token}`, { expect: 410 });
		// last project owner protected
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "owner@a.example", role: "viewer" }, expect: 409 });
		const audit = await t.json("GET", "/api/admin/audit?category=grant", { token: owner.token });
		assert.ok(audit.items.filter((a: any) => a.action.startsWith("project.member")).length >= 4);
	} finally {
		await t.dispose();
	}
});

test("cross-tenant: org B admin cannot read or change anything of org A via any identity route", async () => {
	const t = await startTestApp();
	try {
		const { owner: a, m1 } = await orgWithMembers(t);
		const b = await t.user("b@b.example");
		assert.notEqual(a.me.orgId, b.me.orgId);
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "Secret A" } });
		const dep = await t.json("POST", "/api/admin/departments", { token: a.token, json: { name: "Sales A" } });
		const share = await t.json("POST", "/api/shares", { token: a.token, json: { kind: "project", id: project.id } });
		const aSessions = await t.json("GET", "/api/me/sessions", { token: a.token });
		const sid = aSessions.sessions[0].id;
		const denied: [string, string, unknown, number[]][] = [
			["GET", `/api/projects/${project.id}`, undefined, [403]],
			["GET", `/api/projects/${project.id}/members`, undefined, [403]],
			["PUT", `/api/projects/${project.id}/members`, { email: "b@b.example", role: "owner" }, [403]],
			["PATCH", `/api/projects/${project.id}`, { name: "pwned" }, [403]],
			["DELETE", `/api/projects/${project.id}`, undefined, [403]],
			["PATCH", `/api/admin/members/${m1.me.userId}`, { role: "admin" }, [404]],
			["POST", `/api/admin/members/${m1.me.userId}/disable`, undefined, [404]],
			["DELETE", `/api/admin/members/${m1.me.userId}`, undefined, [404]],
			["DELETE", `/api/admin/sessions/${sid}`, undefined, [404]],
			["PATCH", `/api/admin/departments/${dep.department.id}`, { name: "x" }, [404]],
			["GET", `/api/admin/departments/${dep.department.id}/members`, undefined, [404]],
			["PUT", `/api/admin/departments/${dep.department.id}/members`, { userId: m1.me.userId, role: "member" }, [404]],
			["DELETE", `/api/shares/${share.share.id}`, undefined, [404]],
			["GET", `/api/shares?kind=project&id=${project.id}`, undefined, [403]],
			["POST", "/api/shares", { kind: "project", id: project.id }, [403]],
			["DELETE", `/api/me/sessions/${sid}`, undefined, [404]],
		];
		for (const [method, path, json, codes] of denied) {
			const res = await t.req(method, path, { token: b.token, json });
			assert.ok(codes.includes(res.status), `${method} ${path} → ${res.status}`);
		}
		const lists = await Promise.all(["/api/admin/members", "/api/admin/sessions", "/api/admin/invites", "/api/departments", "/api/admin/audit", "/api/org/members", "/api/projects"].map((p) => t.json("GET", p, { token: b.token })));
		const blob = JSON.stringify(lists);
		for (const leak of [a.me.userId, m1.me.userId, project.id, dep.department.id, "Secret A", "Sales A", a.me.orgId]) assert.ok(!blob.includes(leak), `leaked ${leak}`);
		// A's resources untouched
		assert.equal((await t.json("GET", `/api/projects/${project.id}`, { token: a.token })).project.name, "Secret A");
		await t.json("GET", "/api/me", { token: a.token });
		// B cannot switch into A's org
		await t.json("POST", "/api/auth/switch-org", { token: b.token, json: { orgId: a.me.orgId }, expect: 403 });
		// ACL level: B's principal against A's spaces
		const id = t.app.ctx.services.get("identity") as Identity;
		const pb = (await id.principalFor(b.me.userId, b.me.orgId))!;
		const aPersonal = id.personalSpace(a.me.userId, a.me.orgId);
		for (const res of [{ kind: "space", id: aPersonal.id }, { kind: "conversation", id: "1", spaceId: aPersonal.id }, { kind: "project", id: project.id }, { kind: "org", id: a.me.orgId }] as const)
			for (const action of ["read", "write", "admin"] as const) assert.equal((await id.check(pb, action, res as any)).allow, false, `${action} ${res.kind}`);
	} finally {
		await t.dispose();
	}
});

test("org roles: member cannot administer; admin cannot touch owners; owner promotes", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1, admin } = await orgWithMembers(t);
		await t.json("GET", "/api/admin/members", { token: m1.token, expect: 403 });
		await t.json("POST", "/api/admin/invites", { token: m1.token, json: {}, expect: 403 });
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: admin.token, json: { role: "member" }, expect: 403 });
		await t.json("POST", `/api/admin/members/${owner.me.userId}/disable`, { token: admin.token, expect: 403 });
		await t.json("PATCH", `/api/admin/members/${m1.me.userId}`, { token: admin.token, json: { role: "owner" }, expect: 403 });
		await t.json("PATCH", `/api/admin/members/${m1.me.userId}`, { token: admin.token, json: { role: "admin" } });
		await t.json("GET", "/api/admin/members", { token: m1.token });
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: owner.token, json: { role: "admin" }, expect: 409 }); // last owner
		await t.json("PATCH", `/api/admin/members/${admin.me.userId}`, { token: owner.token, json: { role: "owner" } });
		await t.json("PATCH", `/api/admin/members/${owner.me.userId}`, { token: owner.token, json: { role: "admin" } });
		const me = await t.json("GET", "/api/me", { token: owner.token });
		assert.equal(me.me.orgRole, "admin"); // role re-read live per request
	} finally {
		await t.dispose();
	}
});

test("invites with role + department, multi-org membership, switch org", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("a@a.example");
		const dep = await t.json("POST", "/api/admin/departments", { token: a.token, json: { name: "Research" } });
		const inv = await t.json("POST", "/api/admin/invites", { token: a.token, json: { role: "admin", departmentId: dep.department.id, email: "new@a.example" } });
		await t.json("POST", "/api/auth/register", { json: { email: "other@x.example", name: "x", password: "password123", inviteCode: inv.invite.code }, expect: 400 });
		const n = await t.user("new@a.example", { inviteCode: inv.invite.code });
		assert.equal(n.me.orgRole, "admin");
		assert.deepEqual(n.me.departmentIds, [dep.department.id]);
		await t.json("POST", "/api/auth/register", { json: { email: "new2@a.example", name: "x", password: "password123", inviteCode: inv.invite.code }, expect: 400 });
		// A user of org B joins org A via invite and switches.
		const b = await t.user("b@b.example");
		const inv2 = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		await t.json("POST", "/api/auth/accept-invite", { token: b.token, json: { inviteCode: inv2.invite.code } });
		const orgs = await t.json("GET", "/api/me/orgs", { token: b.token });
		assert.equal(orgs.orgs.length, 2);
		const sw = await t.json("POST", "/api/auth/switch-org", { token: b.token, json: { orgId: a.me.orgId } });
		assert.equal(sw.me.orgId, a.me.orgId);
		await t.json("GET", "/api/me", { token: b.token, expect: 401 }); // old session revoked on switch
		const dl = await t.json("GET", "/api/admin/departments/" + dep.department.id + "/members", { token: a.token });
		assert.equal(dl.members.length, 1);
		const deps = await t.json("GET", "/api/departments", { token: sw.token });
		assert.equal(deps.departments[0].memberCount, 1);
		// revoke an invite
		const inv3 = await t.json("POST", "/api/admin/invites", { token: a.token, json: {} });
		await t.json("DELETE", `/api/admin/invites/${inv3.invite.code}`, { token: a.token });
		await t.json("POST", "/api/auth/register", { json: { email: "late@a.example", name: "x", password: "password123", inviteCode: inv3.invite.code }, expect: 400 });
	} finally {
		await t.dispose();
	}
});

test("session listing and revocation (self, others, admin)", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await orgWithMembers(t);
		const second = await t.json("POST", "/api/auth/login", { json: { email: "m1@a.example", password: "password123" } });
		const list = await t.json("GET", "/api/me/sessions", { token: second.token });
		assert.equal(list.sessions.length, 2);
		assert.equal(list.sessions.filter((s: any) => s.current).length, 1);
		const other = list.sessions.find((s: any) => !s.current);
		await t.json("DELETE", `/api/me/sessions/${other.id}`, { token: second.token });
		await t.json("GET", "/api/me", { token: m1.token, expect: 401 });
		const third = await t.json("POST", "/api/auth/login", { json: { email: "m1@a.example", password: "password123" } });
		const r = await t.json("POST", "/api/me/sessions/revoke-others", { token: third.token });
		assert.equal(r.revoked, 1);
		await t.json("GET", "/api/me", { token: second.token, expect: 401 });
		const adminView = await t.json("GET", `/api/admin/sessions?userId=${m1.me.userId}`, { token: owner.token });
		assert.equal(adminView.sessions.length, 1);
		await t.json("DELETE", `/api/admin/sessions/${adminView.sessions[0].id}`, { token: owner.token });
		await t.json("GET", "/api/me", { token: third.token, expect: 401 });
	} finally {
		await t.dispose();
	}
});

test("external share links: read-only, token not a session, revocable, expiring", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("a@a.example");
		const { project } = await t.json("POST", "/api/projects", { token: a.token, json: { name: "Public brief", description: "desc" } });
		const s = await t.json("POST", "/api/shares", { token: a.token, json: { kind: "project", id: project.id, expiresInHours: 2 } });
		assert.equal(s.share.permission, "read");
		assert.match(s.share.url, /^\/s\//);
		const view = await t.json("GET", `/api/shared/${s.share.token}`);
		assert.deepEqual(view.content, { name: "Public brief", description: "desc", createdAt: view.content.createdAt });
		assert.equal(view.permission, "read");
		// The share token is not an identity: it cannot authenticate any API call.
		await t.json("GET", "/api/me", { token: s.share.token, expect: 401 });
		await t.json("GET", `/api/projects/${project.id}`, { token: s.share.token, expect: 401 });
		for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await t.req(m, `/api/shared/${s.share.token}`, { json: {} })).status, 404);
		const listed = await t.json("GET", `/api/shares?kind=project&id=${project.id}`, { token: a.token });
		assert.equal(listed.shares[0].useCount, 1);
		assert.equal(listed.shares[0].token, undefined);
		// Expiry (clock moved past expiresAt)
		const id = t.app.ctx.services.get("identity") as Identity;
		const realNow = id.now;
		id.now = () => Date.now() + 3 * 3600_000;
		await t.json("GET", `/api/shared/${s.share.token}`, { expect: 410 });
		id.now = realNow;
		await t.json("GET", `/api/shared/${s.share.token}`);
		await t.json("DELETE", `/api/shares/${s.share.id}`, { token: a.token });
		await t.json("GET", `/api/shared/${s.share.token}`, { expect: 410 });
		await t.json("GET", "/api/shared/not-a-token", { expect: 404 });
		// Service-level grant for other modules' public endpoints
		const s2 = await t.json("POST", "/api/shares", { token: a.token, json: { kind: "project", id: project.id } });
		assert.equal((await id.shareGrant(s2.share.token, { kind: "project", id: project.id })).allow, true);
		assert.equal((await id.shareGrant(s2.share.token, { kind: "project", id: "prj_other" })).allow, false);
		// Archiving the project → creator lost read access → auto-revoked
		await t.json("DELETE", `/api/projects/${project.id}`, { token: a.token });
		await t.json("GET", `/api/shared/${s2.share.token}`, { expect: 410 });
		const audit = await t.json("GET", "/api/admin/audit?category=share", { token: a.token });
		assert.ok(audit.items.some((x: any) => x.action === "share.auto_revoke"));
	} finally {
		await t.dispose();
	}
});

test("audit log: admin changes carry request id and are exportable; members cannot read", async () => {
	const t = await startTestApp();
	try {
		const { owner, m1 } = await orgWithMembers(t);
		const res = await t.req("POST", "/api/admin/departments", { token: owner.token, json: { name: "Ops" }, headers: { "x-request-id": "req_test_123" } });
		assert.equal(res.status, 200);
		const q = await t.json("GET", "/api/admin/audit?requestId=req_test_123", { token: owner.token });
		assert.equal(q.items.length, 1);
		assert.equal(q.items[0].action, "department.create");
		assert.equal(q.items[0].category, "admin");
		assert.equal(q.items[0].actorName, "Owner");
		const csv = await t.req("GET", "/api/admin/audit.csv", { token: owner.token });
		assert.equal(csv.status, 200);
		assert.match(csv.headers.get("content-type")!, /text\/csv/);
		const text = await csv.text();
		assert.match(text, /^at,category,action/);
		assert.match(text, /department\.create/);
		await t.json("GET", "/api/admin/audit", { token: m1.token, expect: 403 });
		// audit service for other modules (external writes)
		const auditSvc = t.app.ctx.services.get("audit") as any;
		auditSvc.record({ orgId: owner.me.orgId, actorUserId: m1.me.userId, action: "effect.receipt", target: "mcp:crm", detail: { idempotencyKey: "k1" } });
		const ext = await t.json("GET", "/api/admin/audit?category=external_write", { token: owner.token });
		assert.equal(ext.items[0].action, "effect.receipt");
	} finally {
		await t.dispose();
	}
});

test("TOTP: RFC 6238 vectors; enable 2FA; login requires a fresh code", async () => {
	// RFC 6238 Appendix B (SHA1, secret "12345678901234567890"), 8 digits → compare last 6
	const secret = base32Encode(Buffer.from("12345678901234567890"));
	for (const [t, code8] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]] as const) assert.equal(totpAt(secret, t * 1000), code8.slice(-6));
	assert.equal(hotp(Buffer.from("12345678901234567890"), 0), "755224"); // RFC 4226
	assert.equal(verifyTotp(secret, "287082", 59_000, null), 1);
	assert.equal(verifyTotp(secret, "287082", 59_000, 1), null); // replay of step 1 refused

	const t = await startTestApp();
	try {
		const a = await t.user("a@a.example");
		const setup = await t.json("POST", "/api/me/2fa/setup", { token: a.token });
		assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
		await t.json("POST", "/api/me/2fa/enable", { token: a.token, json: { code: "000000" }, expect: 400 });
		const id = t.app.ctx.services.get("identity") as Identity;
		let clock = Date.now();
		id.now = () => clock;
		await t.json("POST", "/api/me/2fa/enable", { token: a.token, json: { code: totpAt(setup.secret, clock) } });
		await t.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123" }, expect: 401 });
		await t.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123", totp: totpAt(setup.secret, clock) }, expect: 401 }); // same step replay
		clock += 30_000;
		const ok = await t.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123", totp: totpAt(setup.secret, clock) } });
		assert.equal(ok.me.totpEnabled, true);
		const audit = await t.json("GET", "/api/admin/audit?category=security", { token: ok.token });
		assert.equal(audit.items[0].action, "totp.enable");
	} finally {
		await t.dispose();
	}
});
