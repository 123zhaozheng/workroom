// Round 9: first-login onboarding flag. Per user and server-side: completing it on one device is visible everywhere,
// repeating it changes nothing, and other users are never affected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers/app.ts";
import { onboardingDisabled } from "../src/identity/onboarding.ts";

test("a new user is not onboarded; GET /me, login and register all say so", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("ob-a@example.com");
		assert.equal(a.me.onboarded, false, "register response carries onboarded");
		const me = await t.json("GET", "/api/me", { token: a.token });
		assert.equal(me.me.onboarded, false);
		assert.equal(me.me.email, "ob-a@example.com", "the rest of /me is untouched");
		assert.ok(me.personalSpaceId && me.brand, "personalSpaceId and brand survive the wrapper");
		const login = await t.json("POST", "/api/auth/login", { json: { email: "ob-a@example.com", password: "password123" } });
		assert.equal(login.me.onboarded, false, "login response carries onboarded");
	} finally {
		await t.dispose();
	}
});

test("complete is per user, idempotent and visible to every session of that user", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("ob-one@example.com");
		const b = await t.user("ob-two@example.com");
		// a second device of the same user
		const a2 = await t.json("POST", "/api/auth/login", { json: { email: "ob-one@example.com", password: "password123" } });
		assert.notEqual(a2.token, a.token);

		const r1 = await t.json("POST", "/api/me/onboarding/complete", { token: a.token, json: { skipped: ["security"] } });
		assert.deepEqual(r1, { onboarded: true });
		assert.equal((await t.json("GET", "/api/me", { token: a.token })).me.onboarded, true);
		assert.equal((await t.json("GET", "/api/me", { token: a2.token })).me.onboarded, true, "the other device sees it too");
		assert.equal((await t.json("POST", "/api/auth/login", { json: { email: "ob-one@example.com", password: "password123" } })).me.onboarded, true, "a fresh login sees it too");
		assert.equal((await t.json("GET", "/api/me", { token: b.token })).me.onboarded, false, "another user is unaffected");

		const first = t.app.ctx.db.get<{ onboarded_at: string }>("SELECT onboarded_at FROM id_users WHERE email = ?", "ob-one@example.com")!.onboarded_at;
		assert.ok(first);
		await new Promise((r) => setTimeout(r, 15));
		assert.deepEqual(await t.json("POST", "/api/me/onboarding/complete", { token: a2.token, json: {} }), { onboarded: true }, "second call succeeds");
		assert.equal(t.app.ctx.db.get<{ onboarded_at: string }>("SELECT onboarded_at FROM id_users WHERE email = ?", "ob-one@example.com")!.onboarded_at, first, "the first completion time is kept");
		const audits = t.app.ctx.db.all<{ detail: string }>("SELECT detail FROM id_audit WHERE action = 'user.onboarding_complete'");
		assert.equal(audits.length, 1, "audited once");
		assert.deepEqual(JSON.parse(audits[0]!.detail), { skipped: ["security"] });
	} finally {
		await t.dispose();
	}
});

test("complete needs a session and validates its body", async () => {
	const t = await startTestApp();
	try {
		await t.json("POST", "/api/me/onboarding/complete", { json: {}, expect: 401 });
		const a = await t.user("ob-val@example.com");
		await t.json("POST", "/api/me/onboarding/complete", { token: a.token, json: { skipped: "security" }, expect: 400 });
		await t.json("POST", "/api/me/onboarding/complete", { token: a.token, json: { skipped: [1, 2] }, expect: 400 });
		assert.equal((await t.json("GET", "/api/me", { token: a.token })).me.onboarded, false, "a rejected call does not complete anything");
		// unknown step ids are dropped, not stored; an empty body is fine
		await t.json("POST", "/api/me/onboarding/complete", { token: a.token, json: { skipped: ["security", "<script>"] } });
		const d = t.app.ctx.db.get<{ detail: string }>("SELECT detail FROM id_audit WHERE action = 'user.onboarding_complete'")!;
		assert.deepEqual(JSON.parse(d.detail), { skipped: ["security"] });
	} finally {
		await t.dispose();
	}
});

test("users created before the flag existed (null onboarded_at) read as not onboarded and can complete once", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("ob-old@example.com");
		t.app.ctx.db.run("UPDATE id_users SET onboarded_at = NULL WHERE email = ?", "ob-old@example.com");
		assert.equal((await t.json("GET", "/api/me", { token: a.token })).me.onboarded, false);
		await t.json("POST", "/api/me/onboarding/complete", { token: a.token, json: {} });
		assert.equal((await t.json("GET", "/api/me", { token: a.token })).me.onboarded, true);
	} finally {
		await t.dispose();
	}
});

test("WORKROOM_ONBOARDING=off reads every user as onboarded", async () => {
	assert.equal(onboardingDisabled({ WORKROOM_ONBOARDING: "off" } as NodeJS.ProcessEnv), true);
	assert.equal(onboardingDisabled({ WORKROOM_ONBOARDING: "0" } as NodeJS.ProcessEnv), true);
	assert.equal(onboardingDisabled({} as NodeJS.ProcessEnv), false);
	assert.equal(onboardingDisabled({ WORKROOM_ONBOARDING: "on" } as NodeJS.ProcessEnv), false);
	const prev = process.env.WORKROOM_ONBOARDING;
	process.env.WORKROOM_ONBOARDING = "off";
	const t = await startTestApp();
	try {
		const a = await t.user("ob-off@example.com");
		assert.equal(a.me.onboarded, true);
		assert.equal((await t.json("GET", "/api/me", { token: a.token })).me.onboarded, true);
	} finally {
		if (prev === undefined) delete process.env.WORKROOM_ONBOARDING;
		else process.env.WORKROOM_ONBOARDING = prev;
		await t.dispose();
	}
});
