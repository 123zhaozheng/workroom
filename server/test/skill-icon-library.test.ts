// Skill icon library (shared/skill-icons.ts): ids are unique and well-formed, the author's choice wins, keywords match Chinese and English names
// by category, word boundaries hold ("docker" is not "doc"), and the fallback is a stable default (same name → same tone and glyph).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ICON_TONES, SKILL_ICONS, SKILL_ICON_IDS, resolveSkillIcon, stableHash } from "../../shared/skill-icons.ts";
import { SKILL_ICON_RE } from "../../shared/files.ts";

test("library: 24–40 icons, unique well-formed ids that the server's shape check accepts, every tone used", () => {
	assert.ok(SKILL_ICONS.length >= 24 && SKILL_ICONS.length <= 40, String(SKILL_ICONS.length));
	assert.equal(new Set(SKILL_ICON_IDS).size, SKILL_ICON_IDS.length);
	for (const d of SKILL_ICONS) {
		assert.match(d.id, SKILL_ICON_RE);
		assert.ok(ICON_TONES.includes(d.tone), d.id);
	}
	assert.equal(new Set(SKILL_ICONS.map((d) => d.tone)).size, ICON_TONES.length);
	// the brief's categories are all there
	for (const id of ["file-text", "spreadsheet", "presentation", "chart", "data-analysis", "writing", "translate", "code", "search", "mail", "calendar", "finance", "legal", "compliance", "risk", "customer", "image", "video", "audio", "pdf", "web", "automation", "database", "knowledge", "approval", "report"]) assert.ok(SKILL_ICON_IDS.includes(id), id);
});

test("an explicit, known icon wins over any keyword; an unknown id is ignored", () => {
	const r = resolveSkillIcon({ icon: "legal", name: "翻译助手" });
	assert.deepEqual([r.id, r.source], ["legal", "explicit"]);
	assert.equal(resolveSkillIcon({ icon: "no-such-icon", name: "翻译助手" }).id, "translate");
});

test("keyword matching by name / category / tags / description, Chinese and English", () => {
	const id = (o: Parameters<typeof resolveSkillIcon>[0]) => resolveSkillIcon(o).id;
	assert.equal(id({ name: "周报整理" }), "writing");
	assert.equal(id({ name: "合同审查助手" }), "legal");
	assert.equal(id({ name: "Excel 报表汇总", slug: "excel-summary" }), "spreadsheet");
	assert.equal(id({ name: "pdf-extract" }), "pdf");
	assert.equal(id({ name: "my-skill", category: "财务" }), "finance");
	assert.equal(id({ name: "helper", tags: ["translation"] }), "translate");
	assert.equal(id({ name: "helper", description: "把录音转写成文字" }), "audio");
	assert.equal(id({ name: "sql tuning" }), "database");
	assert.equal(id({ name: "doc 模板" }), "file-text");
	assert.equal(resolveSkillIcon({ name: "合同审查助手" }).source, "keyword");
	// the display name beats the technical slug ("周报整理" is writing even though the slug says report)
	assert.equal(id({ name: "周报整理", slug: "weekly-report" }), "writing");
	// name beats description: the name stage is consulted first
	assert.equal(id({ name: "邮件助手", description: "整理日程" }), "mail");
	// ASCII keywords need a word start: "docker" is not "doc"
	assert.notEqual(id({ name: "docker-helper" }), "file-text");
});

test("fallback: stable hash → generic glyph with a stable tone; different names spread over tones", () => {
	const a = resolveSkillIcon({ name: "zzqx", slug: "zzqx" });
	assert.deepEqual([a.id, a.source], ["general", "default"]);
	assert.deepEqual(resolveSkillIcon({ name: "zzqx", slug: "zzqx" }), a);
	assert.equal(stableHash("abc"), stableHash("abc"));
	const tones = new Set(Array.from({ length: 40 }, (_, i) => resolveSkillIcon({ name: `qq${i}x`, slug: `qq${i}x` }).tone));
	assert.ok(tones.size >= 4, [...tones].join());
});
