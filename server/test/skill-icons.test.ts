// Skill card icons: SKILL.md `icon:` is validated and carried through upload → market summary / my-skills DTO; a new version keeps an icon picked in
// the UI unless it declares one; PUT /market/skills/:id/icon is author-only and shape-checked; the legacy JSON create path accepts an icon too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { startTestApp } from "./helpers/app.ts";
import { orgMember, upload } from "./fixtures/util.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const md = (o: { name?: string; version?: string; icon?: string; meta?: string }) =>
	`---\nname: ${o.name ?? "icon-skill"}\ndescription: 测试图标透传。\nversion: ${o.version ?? "1.0.0"}\n${o.icon ? `icon: ${o.icon}\n` : ""}${o.meta ?? ""}---\n\n# 正文\n`;
const zip = (skillMd: string) => zipSync({ "SKILL.md": enc(skillMd) });

async function setup() {
	const t = await startTestApp();
	const admin = await t.user("ic-admin@example.com");
	const author = await orgMember(t, admin, "ic-author@example.com");
	const other = await orgMember(t, admin, "ic-other@example.com");
	const up = async (token: string, text: string, fields: Record<string, string> = {}) => {
		const r = await upload(t, token, "/market/skills/upload", "pkg.zip", zip(text), fields, "application/zip");
		const body = await r.text();
		return { status: r.status, body: body ? JSON.parse(body) : {} };
	};
	return { t, admin, author, other, up };
}

test("icon in SKILL.md frontmatter / metadata is validated and exposed on the skill (detail, manifest, my skills)", async () => {
	const { t, author, up } = await setup();
	try {
		const ok = await up(author.token, md({ icon: "file-spreadsheet" }));
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.equal(ok.body.skill.icon, "file-spreadsheet");
		assert.equal(ok.body.skill.manifest.icon, "file-spreadsheet");
		const mine = await t.json("GET", "/api/skills", { token: author.token });
		assert.equal(mine.skills.find((s: any) => s.id === ok.body.skill.id).icon, "file-spreadsheet");

		// metadata.icon works like the other optional fields
		const viaMeta = await up(author.token, md({ name: "meta-icon", meta: "metadata:\n  icon: scale\n" }));
		assert.equal(viaMeta.status, 200, JSON.stringify(viaMeta.body));
		assert.equal(viaMeta.body.skill.icon, "scale");

		// no icon declared → absent (the web picks one automatically)
		const none = await up(author.token, md({ name: "no-icon" }));
		assert.equal(none.status, 200);
		assert.equal(none.body.skill.icon, undefined);

		// a malformed id is a manifest error, nothing is stored
		for (const bad of ["Bad_Icon", "../x", "a".repeat(40)]) {
			const r = await up(author.token, md({ name: "bad-icon", icon: bad }));
			assert.equal(r.status, 400, bad);
			assert.equal(r.body.error?.code ?? r.body.code, "manifest_invalid", JSON.stringify(r.body));
		}
	} finally {
		await t.dispose();
	}
});

test("a new version keeps an icon chosen in the UI unless its SKILL.md declares one; setting the icon is author-only", async () => {
	const { t, author, other, up } = await setup();
	try {
		const v1 = await up(author.token, md({ name: "keep-icon" }));
		const id = v1.body.skill.id as string;
		assert.equal(v1.body.skill.icon, undefined);

		// the author picks one
		const set = await t.json("PUT", `/api/market/skills/${id}/icon`, { token: author.token, json: { icon: "scale" } });
		assert.equal(set.icon, "scale");
		assert.equal((await t.json("GET", `/api/market/skills/${id}`, { token: author.token })).skill.icon, "scale");

		// somebody else cannot, and a malformed id is refused
		const denied = await t.req("PUT", `/api/market/skills/${id}/icon`, { token: other.token, json: { icon: "mail" } });
		assert.equal(denied.status, 403);
		const bad = await t.req("PUT", `/api/market/skills/${id}/icon`, { token: author.token, json: { icon: "Not Valid!" } });
		assert.equal(bad.status, 400);

		// version 2 without an icon keeps it; version 3 declaring one replaces it
		const v2 = await up(author.token, md({ name: "keep-icon", version: "1.1.0" }), { skillId: id });
		assert.equal(v2.status, 200, JSON.stringify(v2.body));
		assert.equal(v2.body.skill.icon, "scale");
		const v3 = await up(author.token, md({ name: "keep-icon", version: "1.2.0", icon: "mail" }), { skillId: id });
		assert.equal(v3.body.skill.icon, "mail");

		// null clears it back to automatic
		const cleared = await t.json("PUT", `/api/market/skills/${id}/icon`, { token: author.token, json: { icon: null } });
		assert.equal(cleared.icon, undefined);
		assert.equal((await t.json("GET", `/api/market/skills/${id}`, { token: author.token })).skill.icon, undefined);
	} finally {
		await t.dispose();
	}
});

test("legacy JSON create accepts an icon and validates it", async () => {
	const { t, author } = await setup();
	try {
		const made = await t.json("POST", "/api/skills", { token: author.token, json: { name: "周报模板", kind: "prompt", description: "写周报", instructions: "写周报", icon: "file-text" } });
		assert.equal(made.skill.icon, "file-text");
		const bad = await t.req("POST", "/api/skills", { token: author.token, json: { name: "坏图标", kind: "prompt", instructions: "x", icon: "X Y" } });
		assert.equal(bad.status, 400);
	} finally {
		await t.dispose();
	}
});
