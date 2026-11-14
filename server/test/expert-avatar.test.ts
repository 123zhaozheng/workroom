// Expert bot avatars: the JSON configuration (validation, normalisation), stable defaults, legacy data, the API (create / edit / mention /
// conversation header / message) and the vendored renderer's resting-blink contract.
//   node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/expert-avatar.test.ts
process.env.WORKROOM_RT_RETRY_BASE_MS ??= "20";
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
process.env.WORKROOM_SSE_THROTTLE_MS ??= "20";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AVATAR_COLORS, AVATAR_PRESETS, BRAND_AVATAR, colorsFor, defaultAvatarConfig, resolveAvatar, validateAvatarConfig } from "../../shared/bot-avatar/config.ts";
import { calmBlink, nextCalmBlink, hashString } from "../../shared/bot-avatar/motion.ts";
import { renderAvatarSvg } from "../../shared/bot-avatar/render.ts";
import { validateAvatar } from "../../shared/bot-avatar/validate.ts";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { isSettled, waitFor } from "../src/runtime/testing.ts";
import type { Experts } from "../src/tools/experts.ts";

test("every preset is a valid open-bot-avatar definition and renders", () => {
	assert.ok(AVATAR_PRESETS.length >= 20);
	assert.equal(new Set(AVATAR_PRESETS.map((p) => p.id)).size, AVATAR_PRESETS.length);
	for (const p of AVATAR_PRESETS) {
		assert.ok(validateAvatar(p.def).ok, `${p.id} is valid`);
		const svg = renderAvatarSvg(p.def, { color: "#1f7cf2", size: 32, motion: "calm", reducedMotion: true });
		assert.match(svg, /^<svg /);
		assert.ok(p.label && p.label !== p.def.name, `${p.id} has a Chinese label`);
	}
	assert.ok(validateAvatarConfig(BRAND_AVATAR).ok);
});

test("validateAvatarConfig: accepts preset + color (normalising #rgb), rejects unknown fields, shapes, colors and bad eyes", () => {
	const ok = validateAvatarConfig({ shape: "cat", color: "#F8A" });
	assert.deepEqual(ok, { ok: true, value: { shape: "cat", color: "#ff88aa" } });
	assert.ok(validateAvatarConfig({ shape: "cat", color: "#f8a01c", eyeColor: "#151515", eyes: { x: 50, y: 43, spacing: 17, scale: 1.1 } }).ok);
	const bad = (v: unknown) => {
		const r = validateAvatarConfig(v);
		assert.equal(r.ok, false, JSON.stringify(v));
		return (r as { errors: string[] }).errors.join("|");
	};
	assert.match(bad({ shape: "dragon", color: "#fff" }), /未知造型/);
	assert.match(bad({ shape: "cat", color: "red" }), /color/);
	assert.match(bad({ shape: "cat", color: "#fff", eyeColor: "blue" }), /eyeColor/);
	assert.match(bad({ shape: "cat", color: "#fff", size: 3 }), /不支持的字段/);
	assert.match(bad({ shape: "cat", color: "#fff", eyes: { x: 5, y: 5, spacing: 17, scale: 1 } }), /eyes/); // eyes outside the body
	assert.match(bad({ shape: "cat", color: "#fff", eyes: { x: 50 } }), /eyes/);
	assert.match(bad({ shape: "cat", color: "#fff", custom: {} }), /custom/);
	assert.match(bad("cat"), /JSON 对象/);
	assert.match(bad(null), /JSON 对象/);
});

test("custom shapes: a valid open-bot-avatar definition is accepted, broken or script-bearing paths are not", () => {
	const def = { version: 1, id: "box", name: "Box", body: { path: "M20 20 H80 V80 H20 Z" }, eyes: { x: 50, y: 46, spacing: 15, scale: 1 } };
	const ok = validateAvatarConfig({ shape: "custom", color: "#1fbf68", custom: def });
	assert.ok(ok.ok);
	assert.equal(resolveAvatar({ shape: "custom", color: "#1fbf68", custom: def }, "x").def.id, "box");
	assert.equal(validateAvatarConfig({ shape: "custom", color: "#1fbf68", custom: { ...def, body: { path: "M0 0 <script>" } } }).ok, false);
	assert.equal(validateAvatarConfig({ shape: "custom", color: "#1fbf68" }).ok, false);
	assert.equal(validateAvatarConfig({ shape: "custom", color: "#1fbf68", custom: { ...def, x: 1 } }).ok, false);
});

test("defaults are stable per id, spread over shapes and colors, and old / broken data falls back to them", () => {
	assert.deepEqual(defaultAvatarConfig("exp_abc"), defaultAvatarConfig("exp_abc"));
	const shapes = new Set<string>(), colors = new Set<string>();
	for (let i = 0; i < 200; i++) {
		const d = defaultAvatarConfig(`exp_${i}_${hashString(String(i))}`);
		assert.ok(validateAvatarConfig(d).ok);
		shapes.add(d.shape);
		colors.add(d.color);
		assert.ok(AVATAR_COLORS.slice(0, 8).some((c) => c.value === d.color), "defaults use bright colors only");
	}
	assert.ok(shapes.size >= 15, `${shapes.size} shapes used`);
	assert.equal(colors.size, 8);
	const look = resolveAvatar(undefined, "exp_old");
	assert.equal(look.def.id, defaultAvatarConfig("exp_old").shape);
	assert.equal(resolveAvatar({ shape: "nope", color: "zzz" }, "exp_old").key, look.key, "a broken config falls back to the default");
	// a near-black body flips to a light one on dark pages (unless eyes were chosen on purpose)
	const brand = resolveAvatar(BRAND_AVATAR, "workroom");
	assert.equal(colorsFor(brand, false).color, "#23252a");
	assert.notEqual(colorsFor(brand, true).color, "#23252a");
	assert.equal(colorsFor(resolveAvatar({ shape: "cat", color: "#f8a01c" }, "a"), true).color, "#f8a01c");
});

test("renderer contract: the calm mood only blinks (body still), blinks are brief and seeded, reduced motion never blinks", () => {
	const def = AVATAR_PRESETS[0]!.def;
	const render = (time: number, reducedMotion = false) => renderAvatarSvg(def, { color: "#ff6a1a", motion: "calm", time, reducedMotion });
	const seed = hashString(def.id);
	let open = 0, closed = 0, bodyChanged = false;
	const bodyOf = (svg: string) => svg.replace(/<rect[^>]*>/g, "");
	const base = bodyOf(render(0));
	for (let t = 0; t < 12; t += 0.05) {
		const c = calmBlink(seed, t);
		if (c > 0) closed++;
		else open++;
		if (bodyOf(render(t)) !== base) bodyChanged = true;
	}
	assert.equal(bodyChanged, false, "no body motion while calm");
	assert.ok(closed > 0 && closed < open / 4, `blinks are short: ${closed} closed vs ${open} open samples`);
	const wait = nextCalmBlink(seed, 0.5);
	assert.ok(wait >= 0 && wait <= 9);
	assert.ok(calmBlink(seed, 0.5 + wait + 0.06) > 0, "a blink starts where nextCalmBlink says");
	assert.equal(render(3.3, true), render(0, true), "reduced motion: a single frozen frame at any time");
	// the thinking mood does move the body
	assert.notEqual(renderAvatarSvg(def, { motion: "thinking", time: 0 }), renderAvatarSvg(def, { motion: "thinking", time: 2 }));
});

async function setup() {
	const t = await startTestApp({ config: { secretKey: "avatar-test-key" } });
	const admin = await t.user("av-admin@example.com");
	const member = await orgMember(t, admin, "av-member@example.com");
	return { t, admin, member, experts: t.app.ctx.services.get("experts") as Experts };
}

test("API: new experts get a stable default look, a chosen look is validated and stored, edits and legacy rows work", async () => {
	const { t, admin, member, experts } = await setup();
	try {
		const mk = (token: string, extra: Record<string, unknown> = {}, expect?: number) =>
			t.json("POST", "/api/experts", { token, json: { name: "头像专家", tagline: "测试头像", instructions: "你是头像专家。", ...extra }, expect });
		// default: shape + color picked from the id, valid, identical on re-read
		const a = (await mk(member.token)).expert;
		assert.deepEqual(a.avatarConfig, defaultAvatarConfig(a.id));
		assert.deepEqual((await t.json("GET", `/api/experts/${a.id}`, { token: member.token })).expert.avatarConfig, a.avatarConfig);
		// chosen
		const b = (await mk(member.token, { name: "选了猫", avatarConfig: { shape: "cat", color: "#F8A01C", eyeColor: "#151515" } })).expert;
		assert.deepEqual(b.avatarConfig, { shape: "cat", color: "#f8a01c", eyeColor: "#151515" });
		// invalid: rejected with a readable error, nothing stored
		const bad = await t.req("POST", "/api/experts", { token: member.token, json: { name: "坏头像", tagline: "x", instructions: "y", avatarConfig: { shape: "dragon", color: "blue" } } });
		assert.equal(bad.status, 400);
		assert.equal((await bad.json()).error.code, "invalid_avatar");
		await t.json("PATCH", `/api/experts/${b.id}`, { token: member.token, json: { avatarConfig: { shape: "cat", color: "red" } }, expect: 400 });
		// edit
		const e = (await t.json("PATCH", `/api/experts/${b.id}`, { token: member.token, json: { avatarConfig: { shape: "rocket", color: "#1f7cf2" } } })).expert;
		assert.deepEqual(e.avatarConfig, { shape: "rocket", color: "#1f7cf2" });
		// clearing falls back to the default for the id
		const cleared = (await t.json("PATCH", `/api/experts/${b.id}`, { token: member.token, json: { avatarConfig: null } })).expert;
		assert.deepEqual(cleared.avatarConfig, defaultAvatarConfig(b.id));
		// old row without avatar_config (created before this feature) and a legacy text avatar
		const row = experts.row(a.id)!;
		(t.app.ctx.db as any).run("UPDATE ex_experts SET avatar_config = NULL, avatar = '📝' WHERE id = ?", row.id);
		const legacy = (await t.json("GET", `/api/experts/${a.id}`, { token: member.token })).expert;
		assert.deepEqual(legacy.avatarConfig, defaultAvatarConfig(a.id), "legacy rows keep a stable default");
		assert.equal(legacy.avatar, "📝", "the old text avatar is still returned");
		(t.app.ctx.db as any).run("UPDATE ex_experts SET avatar_config = ? WHERE id = ?", "{not json", row.id);
		assert.deepEqual((await t.json("GET", `/api/experts/${a.id}`, { token: member.token })).expert.avatarConfig, defaultAvatarConfig(a.id), "a corrupt stored value falls back too");
		// old assistants migrated to experts get a stable default as well
		const { assistant } = await t.json("POST", "/api/assistants", { token: member.token, json: { name: "旧助手", avatar: "🧭", instructions: "旧", members: [] } });
		const migrated = (await t.json("GET", `/api/experts/${assistant.id}`, { token: member.token })).expert;
		assert.equal(migrated.source, "assistant");
		assert.deepEqual(migrated.avatarConfig, defaultAvatarConfig(assistant.id));
		// the @ list and the list/detail carry it
		const men = (await t.json("GET", "/api/experts/mentionable", { token: member.token })).experts;
		assert.deepEqual(men.find((x: any) => x.id === b.id).avatarConfig, defaultAvatarConfig(b.id));
		const list = (await t.json("GET", "/api/experts?mine=1", { token: member.token })).experts;
		assert.ok(list.every((x: any) => x.avatarConfig && validateAvatarConfig(x.avatarConfig).ok));
		void admin;
	} finally {
		await t.dispose();
	}
});

test("a published expert shows its published look to others (immutable snapshot) and an old snapshot without a look still resolves", async () => {
	const { t, admin, member } = await setup();
	try {
		const e = (await t.json("POST", "/api/experts", { token: admin.token, json: { name: "发布的专家", tagline: "x", instructions: "你是专家", avatarConfig: { shape: "star", color: "#8b5cf6" } } })).expert;
		await t.json("POST", `/api/experts/${e.id}/force-publish`, { token: admin.token, json: { reason: "测试" } });
		await t.json("PATCH", `/api/experts/${e.id}`, { token: admin.token, json: { avatarConfig: { shape: "ghost", color: "#1fbf68" } } });
		const seen = (await t.json("GET", `/api/experts/${e.id}`, { token: member.token })).expert;
		assert.deepEqual(seen.avatarConfig, { shape: "star", color: "#8b5cf6" }, "others keep the published look until the update is published");
		assert.deepEqual((await t.json("GET", `/api/experts/${e.id}`, { token: admin.token })).expert.avatarConfig, { shape: "ghost", color: "#1fbf68" }, "the author sees the draft");
		// a snapshot written before this feature has no avatarConfig
		const db = t.app.ctx.db as any;
		const ver = db.get("SELECT id, config FROM ex_versions WHERE expert_id = ? AND version_no = 1", e.id);
		db.run("DROP TRIGGER ex_versions_no_update");
		db.run("UPDATE ex_versions SET config = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(ver.config), avatarConfig: undefined }), ver.id);
		assert.deepEqual((await t.json("GET", `/api/experts/${e.id}`, { token: member.token })).expert.avatarConfig, defaultAvatarConfig(e.id));
	} finally {
		await t.dispose();
	}
});

test("@expert: the conversation header and the message carry the expert's look", async () => {
	const { t, member } = await setup();
	try {
		const e = (await t.json("POST", "/api/experts", { token: member.token, json: { name: "猫猫专家", tagline: "x", instructions: "你是猫猫", avatarConfig: { shape: "cat", color: "#14b3a5" } } })).expert;
		const c = (await t.json("POST", "/api/conversations", { token: member.token, json: { assistantId: e.id } })).conversation;
		const base = `/api/conversations/${c.spaceId}/${c.conversationId}`;
		const r = await t.json("POST", `${base}/messages`, { token: member.token, json: { text: "你好", requestId: randomUUID(), expertId: e.id } });
		await waitFor(async () => {
			const s = await t.json("GET", `${base}/submissions/${r.submissionId}`, { token: member.token });
			return isSettled(s) ? s : undefined;
		}, { timeoutMs: 15_000, what: "settles" });
		const detail = await t.json("GET", base, { token: member.token });
		assert.deepEqual(detail.agent.expert.boundAvatarConfig, { shape: "cat", color: "#14b3a5" });
		const entries = (await t.json("GET", `${base}/entries`, { token: member.token })).items;
		const msg = entries.find((x: any) => x.expert);
		assert.deepEqual(msg?.expert?.avatarConfig, { shape: "cat", color: "#14b3a5" });
	} finally {
		await t.dispose();
	}
});
