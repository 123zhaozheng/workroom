// Startup population of model providers:
//   * migration of pre-round-4 channels / platform models / routes (same ciphertext, fallbacks, visibility, default, legacy ids still run)
//   * legacy WORKROOM_ANTHROPIC_* env vars
//   * workroom.models.json (keys by env var NAME only, never inline; instance-level; authoritative)
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startTestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { directHarness } from "../src/ops/testing.ts";
import { SecretBox } from "../src/identity/secrets.ts";
import { ANTHROPIC_KEY, OPENAI_KEY, startAnthropicMock, startOpenAIMock } from "./models-mock-servers.ts";

const SECRET = "test-secret-key-for-model-bootstrap-0123456789";
const LEGACY_OPENAI_KEY = "sk-legacy-OPENAI-KEY-0123456789abcdef";
const LEGACY_ANTHROPIC_KEY = "sk-ant-legacy-KEY-0123456789abcdef";

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? filesUnder(p) : [p];
	});
}
const lastAssistant = (s: any) => s.entries.filter((e: any) => e.kind === "assistant" && e.text).at(-1);

test("legacy channels / platform models / routes migrate to providers, entries, fallbacks and aliases; old refs keep running", { timeout: 120_000 }, async () => {
	const oai = await startOpenAIMock({ key: LEGACY_OPENAI_KEY, reply: "旧渠道一的回复" });
	const ant = await startAnthropicMock({ key: LEGACY_ANTHROPIC_KEY, reply: "旧渠道二的回复" });
	process.env.WORKROOM_ANTHROPIC_API_KEY = "sk-ant-env-0000000000000000";
	process.env.WORKROOM_ANTHROPIC_BASE_URL = ant.url;
	const dataDir = mkdtempSync(join(tmpdir(), "wr-models-mig-"));
	try {
		// 1. A "pre-round-4" database: first boot creates the org, then we write the legacy rows by hand and re-arm the migration.
		let t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		const owner = await t.user("owner@a.example");
		const dep = (await t.json("POST", "/api/admin/departments", { token: owner.token, json: { name: "研发" } })).department;
		const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member", departmentId: dep.id } });
		const dev = await t.user("dev@a.example", { inviteCode: inv.invite.code });
		const inv2 = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
		const outsider = await t.user("out@a.example", { inviteCode: inv2.invite.code });
		const orgId = owner.me.orgId as string;
		const spaceId = (await t.json("GET", "/api/me", { token: owner.token })).personalSpaceId as string;
		await t.stop();

		const box = new SecretBox(SECRET);
		const db = new DatabaseSync(join(dataDir, "app.sqlite"));
		const now = new Date().toISOString();
		const encA = box.seal(LEGACY_OPENAI_KEY);
		const encB = box.seal(LEGACY_ANTHROPIC_KEY);
		db.prepare("INSERT INTO ops_channels (id, org_id, name, provider, base_url, api_key_enc, key_hint, status, timeout_ms, price, builtin, created_at, updated_at) VALUES (?, ?, ?, 'openai-compatible', ?, ?, '****cdef', 'enabled', 45000, ?, 0, ?, ?)").run("ch_old_a", orgId, "旧渠道一", `${oai.url}/v1`, encA, JSON.stringify({ input: 1, output: 4, cacheRead: 0, cacheWrite: 0 }), now, now);
		db.prepare("INSERT INTO ops_channels (id, org_id, name, provider, base_url, api_key_enc, key_hint, status, builtin, created_at, updated_at) VALUES (?, ?, ?, 'anthropic', ?, ?, '****cdef', 'enabled', 0, ?, ?)").run("ch_old_b", orgId, "旧渠道二", ant.url, encB, now, now);
		db.prepare("INSERT INTO ops_platform_models (id, org_id, label, description, kind, pi_provider, capabilities, thinking_levels, default_thinking, context_window, max_tokens, visibility, is_default, enabled, sort, builtin, created_at, updated_at) VALUES ('old-team', ?, '旧团队模型', '迁移前的平台模型', 'real', 'workroom', ?, ?, 'low', 64000, 4096, ?, 1, 1, 5, 0, ?, ?)").run(orgId, JSON.stringify(["text", "tools", "image", "reasoning"]), JSON.stringify(["off", "low", "high"]), JSON.stringify({ departmentIds: [dep.id] }), now, now);
		db.prepare("INSERT INTO ops_model_routes (id, platform_model_id, channel_id, upstream_model_id, priority, weight, enabled, created_at) VALUES ('rt_a', 'old-team', 'ch_old_a', 'legacy-chat', 0, 1, 1, ?)").run(now);
		db.prepare("INSERT INTO ops_model_routes (id, platform_model_id, channel_id, upstream_model_id, priority, weight, enabled, created_at) VALUES ('rt_b', 'old-team', 'ch_old_b', 'claude-legacy', 1, 1, 1, ?)").run(now);
		// the old env-seeded builtin platform model "claude" → alias to the env provider
		db.prepare("INSERT INTO ops_platform_models (id, org_id, label, kind, pi_provider, capabilities, thinking_levels, enabled, sort, builtin, created_at, updated_at) VALUES ('claude', NULL, 'Claude', 'real', 'workroom', '[\"text\"]', '[\"off\"]', 1, 10, 1, ?, ?)").run(now, now);
		db.prepare("DELETE FROM model_meta WHERE key = 'legacy_migrated'").run();
		db.close();

		// 2. Boot: the migration runs inside init, no network, no manual step.
		t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		const gw = t.app.ctx.services.get("models") as any;
		const rows = t.app.ctx.db.all<any>("SELECT * FROM model_providers WHERE source = 'migration' ORDER BY id");
		assert.deepEqual(rows.map((r) => [r.name, r.type, r.scope, r.org_id === orgId]), [["旧渠道一", "openai-completions", "org", true], ["旧渠道二", "anthropic-messages", "org", true]]);
		assert.equal(rows[0].api_key_enc, encA, "ciphertext carried over unchanged (same WORKROOM_SECRET_KEY)");
		assert.equal(rows[0].timeout_ms, 45000);
		const ea = t.app.ctx.db.get<any>("SELECT * FROM model_entries WHERE provider_id = ? AND model_id = 'legacy-chat'", rows[0].id)!;
		const spec = JSON.parse(ea.spec);
		assert.deepEqual([ea.manual, ea.enabled, ea.default_thinking, spec.name, spec.contextWindow, spec.maxTokens, spec.reasoning, spec.input, spec.cost], [1, 1, "low", "旧团队模型", 64000, 4096, true, ["text", "image"], { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 }]);
		assert.deepEqual(JSON.parse(ea.fallbacks), [{ provider: rows[1].id, modelId: "claude-legacy" }], "second route → fallback");
		assert.deepEqual(JSON.parse(ea.visibility), { departmentIds: [dep.id] });
		assert.deepEqual(JSON.parse(t.app.ctx.db.get<any>("SELECT value FROM ops_settings WHERE org_id = ? AND key = 'default_model'", orgId)!.value), { provider: rows[0].id, modelId: "legacy-chat" });
		assert.equal(t.app.ctx.db.get<any>("SELECT enabled FROM model_entries WHERE provider_id = ? AND model_id = 'claude-legacy'", rows[1].id)!.enabled, 0, "fallback-only model is not directly selectable");
		const aliases = t.app.ctx.db.all<any>("SELECT alias_id, provider_id FROM model_aliases ORDER BY alias_id");
		assert.deepEqual(aliases.map((a) => a.alias_id), ["claude", "old-team"]);
		assert.equal(aliases.find((a) => a.alias_id === "claude").provider_id, "env-anthropic");

		// 3. What users see: native refs; visibility carried over; legacy ids hidden from pickers
		const devList = await t.json("GET", "/api/models", { token: dev.token });
		const mig = devList.models.find((m: any) => m.ref.modelId === "legacy-chat");
		assert.equal(mig.label, "旧团队模型");
		assert.equal(mig.providerName, "旧渠道一");
		assert.equal(mig.isDefault, true);
		assert.equal(devList.defaultModelId, mig.id);
		assert.equal(devList.models.some((m: any) => m.ref.provider === "workroom"), false, "legacy aliases are not offered in pickers");
		assert.equal((await t.json("GET", "/api/models?include=legacy", { token: dev.token })).models.some((m: any) => m.ref.provider === "workroom" && m.ref.modelId === "old-team"), true);
		assert.equal((await t.json("GET", "/api/models", { token: outsider.token })).models.some((m: any) => m.ref.modelId === "legacy-chat"), false, "department restriction migrated");
		// env bootstrap: provider exists, key only as a variable NAME
		const env = t.app.ctx.db.get<any>("SELECT * FROM model_providers WHERE id = 'env-anthropic'")!;
		assert.deepEqual([env.scope, env.source, env.api_key_enc, env.api_key_env], ["instance", "env", null, "WORKROOM_ANTHROPIC_API_KEY"]);
		const envModel = (await t.json("GET", "/api/models", { token: outsider.token })).models.find((m: any) => m.ref.provider === "env-anthropic");
		assert.equal(envModel.status, "ready", "env provider is instance-wide");
		assert.ok(envModel.contextWindow >= 100_000, "context window taken from pi-ai's Anthropic catalog");

		// 4. An OLD conversation (pi ref { provider: "workroom", modelId: "old-team" }) runs through the alias, on the migrated provider's key; failover follows the migrated chain
		const { harness, close } = await directHarness(t, spaceId);
		try {
			const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "workroom", modelId: "old-team" } } }, ctx);
			const ask = async (text: string) => (await (await conv.submit({ type: "input", content: text, requestId: randomUUID() }, ctx)).wait(ctx)).status;
			assert.equal(await ask("你好"), "done");
			const msg = async () => (await conv.entries({ order: "descending" }, 20, undefined, ctx)).items.find((e: any) => e.kind === "pi.assistant")!.model![0] as any;
			let m = await msg();
			assert.equal(m.content[0].text, "旧渠道一的回复");
			assert.deepEqual([m.provider, m.model], ["workroom", "old-team"], "message keeps the legacy identity");
			assert.equal(oai.requests.filter((r) => r.method === "POST").at(-1)!.headers.authorization, `Bearer ${LEGACY_OPENAI_KEY}`);
			oai.failNext(503);
			assert.equal(await ask("再来"), "done");
			m = await msg();
			assert.equal(m.content[0].text, "旧渠道二的回复", "fallback chain migrated from the second route");
		} finally {
			await close();
		}
		const attempts = t.app.ctx.db.all<any>("SELECT channel_id, status, failover FROM ops_route_attempts ORDER BY started_at, attempt_no");
		assert.deepEqual(attempts.map((a) => [a.channel_id, a.status, a.failover]), [[rows[0].id, "ok", 0], [rows[0].id, "error", 0], [rows[1].id, "ok", 1]]);
		assert.ok(gw.rowOf("env-anthropic"));
		await t.stop();

		// 5. Idempotent: another boot changes nothing
		const count = () => {
			const d = new DatabaseSync(join(dataDir, "app.sqlite"), { readOnly: true });
			const r = JSON.stringify([d.prepare("SELECT COUNT(*) AS n FROM model_providers").get(), d.prepare("SELECT COUNT(*) AS n FROM model_entries").get(), d.prepare("SELECT COUNT(*) AS n FROM model_aliases").get()]);
			d.close();
			return r;
		};
		const before = count();
		t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		await t.stop();
		assert.equal(count(), before);
	} finally {
		delete process.env.WORKROOM_ANTHROPIC_API_KEY;
		delete process.env.WORKROOM_ANTHROPIC_BASE_URL;
		rmSync(dataDir, { recursive: true, force: true });
		await oai.close();
		await ant.close();
	}
});

test("workroom.models.json: providers + models from a file, keys by env var NAME only, instance-level, authoritative; inline keys and bad compat are rejected", { timeout: 120_000 }, async () => {
	const oai = await startOpenAIMock({ reply: "配置文件模型的回复" });
	const ant = await startAnthropicMock();
	const CFG_KEY = "sk-cfg-OPENAI-ENVKEY-0123456789abcdef";
	const CFG_HEADER = "team-header-VALUE-0123456789";
	process.env.WORKROOM_TEST_CFG_OPENAI_KEY = OPENAI_KEY;
	process.env.WORKROOM_TEST_CFG_ANTHROPIC_KEY = ANTHROPIC_KEY;
	process.env.WORKROOM_TEST_CFG_HEADER = CFG_HEADER;
	const dataDir = mkdtempSync(join(tmpdir(), "wr-models-cfg-"));
	const cfgPath = join(dataDir, "workroom.models.json");
	const write = (providers: Record<string, unknown>, extra: Record<string, unknown> = {}) => writeFileSync(cfgPath, JSON.stringify({ providers, ...extra }, null, 2));
	const oaiProvider = { name: "配置文件 OpenAI 兼容", type: "openai-completions", baseUrl: `${oai.url}/v1`, apiKeyEnv: "WORKROOM_TEST_CFG_OPENAI_KEY", headers: { "X-Team": { env: "WORKROOM_TEST_CFG_HEADER" } }, models: [{ id: "cfg-chat", name: "配置模型", contextWindow: 64000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] };
	const claudeProvider = { name: "配置文件 Claude 兼容", api: "anthropic-messages", baseUrl: `${ant.url}/v1`, apiKeyEnv: "WORKROOM_TEST_CFG_ANTHROPIC_KEY", models: [{ id: "claude-cfg", name: "Claude 配置" }] };
	write({ "cfg-oai": oaiProvider, "cfg-claude": claudeProvider, "bad-inline": { type: "openai-completions", baseUrl: "http://x/v1", apiKey: CFG_KEY }, "bad-compat": { type: "openai-completions", baseUrl: "http://x/v1", apiKeyEnv: "WORKROOM_TEST_CFG_OPENAI_KEY", models: [{ id: "m", compat: { nope: 1 } }] }, "bad-env-header": { type: "openai-completions", baseUrl: "http://x/v1", headers: { A: { env: "WORKROOM_TEST_UNSET_VAR" } } } }, { defaultModel: "cfg-oai/cfg-chat" });
	try {
		let t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		const a = await t.user("a@a.example");
		const b = await t.user("b@b.example"); // another org
		const list = await t.json("GET", "/api/admin/model-providers", { token: a.token });
		assert.deepEqual(list.providers.map((p: any) => p.id).sort(), ["cfg-claude", "cfg-oai"]);
		const cfg = list.providers.find((p: any) => p.id === "cfg-oai");
		assert.deepEqual([cfg.scope, cfg.source, cfg.readOnly, cfg.health, cfg.credential, cfg.headerNames], ["instance", "config", true, "ready", { kind: "env", envVar: "WORKROOM_TEST_CFG_OPENAI_KEY" }, ["X-Team"]]);
		assert.equal(list.providers.find((p: any) => p.id === "cfg-claude").baseUrl, ant.url, "/v1 stripped for Anthropic");
		const errs: string[] = list.settings.config.errors;
		assert.equal(list.settings.config.path, cfgPath);
		assert.ok(errs.some((e) => /bad-inline.*不允许在文件中写入密钥/.test(e)), errs.join("\n"));
		assert.ok(errs.some((e) => /bad-compat.*nope/.test(e)), errs.join("\n"));
		assert.ok(errs.some((e) => /bad-env-header.*WORKROOM_TEST_UNSET_VAR/.test(e)), errs.join("\n"));
		assert.ok(!JSON.stringify(list).includes(CFG_KEY));

		// instance-level: every org sees the models; one default for orgs that have not chosen
		for (const who of [a, b]) {
			const l = await t.json("GET", "/api/models", { token: who.token });
			const m = l.models.find((x: any) => x.id === "cfg-oai/cfg-chat");
			assert.ok(m && m.status === "ready");
			assert.equal(l.defaultModelId, "cfg-oai/cfg-chat");
			assert.equal(m.contextWindow, 64000);
			assert.ok(l.models.some((x: any) => x.id === "cfg-claude/claude-cfg"));
		}
		// read-only for org admins
		await t.json("PATCH", "/api/admin/model-providers/cfg-oai", { token: a.token, json: { name: "x" }, expect: 403 });
		await t.json("DELETE", "/api/admin/model-providers/cfg-oai", { token: a.token, expect: 403 });
		await t.json("POST", "/api/admin/model-providers/cfg-oai/models", { token: a.token, json: { id: "z", name: "z" }, expect: 403 });

		// chat through the file-declared provider: key from the env var, header resolved from env, compat honoured
		const { conversation } = await t.json("POST", "/api/conversations", { token: b.token, json: { modelId: "cfg-oai/cfg-chat" } });
		await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: b.token, json: { text: "你好", requestId: randomUUID() } });
		const st = await waitFor(async () => {
			const s = await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: b.token });
			return !s.live.busy && lastAssistant(s) ? s : undefined;
		}, { timeoutMs: 30_000, what: "answer from file provider" });
		assert.equal(lastAssistant(st).text, "配置文件模型的回复");
		const req = oai.requests.filter((r) => r.method === "POST").at(-1)!;
		assert.equal(req.headers.authorization, `Bearer ${OPENAI_KEY}`);
		assert.equal(req.headers["x-team"], CFG_HEADER);
		// test connection + fetch on a file provider
		assert.equal((await t.json("POST", "/api/admin/model-providers/cfg-oai/test", { token: a.token, json: {} })).ok, true);
		await t.stop();

		// Keys: never in the database (only the variable NAME), headers sealed
		for (const f of filesUnder(dataDir)) {
			if (f === cfgPath) continue;
			const buf = readFileSync(f);
			for (const secret of [OPENAI_KEY, ANTHROPIC_KEY, CFG_HEADER, CFG_KEY]) assert.ok(!buf.includes(Buffer.from(secret)), `${f} must not contain ${secret.slice(0, 10)}…`);
		}
		assert.ok(!readFileSync(cfgPath, "utf8").includes(OPENAI_KEY), "the file itself carries no key");

		// Authoritative: removing a provider from the file removes it on the next start; a changed model replaces the old one
		write({ "cfg-oai": { ...oaiProvider, models: [{ id: "cfg-chat-2", name: "第二个配置模型" }] } });
		t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		const a2 = await t.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123" } });
		const ids = (await t.json("GET", "/api/models", { token: a2.token })).models.map((m: any) => m.id);
		assert.ok(ids.includes("cfg-oai/cfg-chat-2") && !ids.includes("cfg-oai/cfg-chat") && !ids.some((i: string) => i.startsWith("cfg-claude/")), ids.join(","));
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM model_providers WHERE id = 'cfg-claude'")!.n, 0);
		await t.stop();

		// WORKROOM_MODELS_CONFIG points elsewhere; a missing file is reported, not fatal
		process.env.WORKROOM_MODELS_CONFIG = join(dataDir, "nope.json");
		t = await startTestApp({ dataDir, config: { secretKey: SECRET } });
		const a3 = await t.json("POST", "/api/auth/login", { json: { email: "a@a.example", password: "password123" } });
		const l3 = await t.json("GET", "/api/admin/model-providers", { token: a3.token });
		assert.equal(l3.settings.config.path, join(dataDir, "nope.json"));
		assert.equal(l3.providers.length, 0, "file-sourced providers disappear with their file");
		await t.stop();
	} finally {
		delete process.env.WORKROOM_MODELS_CONFIG;
		for (const k of ["WORKROOM_TEST_CFG_OPENAI_KEY", "WORKROOM_TEST_CFG_ANTHROPIC_KEY", "WORKROOM_TEST_CFG_HEADER"]) delete process.env[k];
		rmSync(dataDir, { recursive: true, force: true });
		await oai.close();
		await ant.close();
	}
});
