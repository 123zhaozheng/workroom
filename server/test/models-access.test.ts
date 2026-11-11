// Who may use / see / manage which models:
//   * org visibility rules (department / user): a non-permitted member cannot see or pick a restricted model; admin can
//   * default model
//   * RBAC (`authz` service) permissions model.use / model.manage / model.provider.manage when present
//   * personal providers (M15 个人自带密钥): only the owner, only when the admin policy allows it, SSRF-guarded
//   * other orgs never see an org's providers
process.env.WORKROOM_RT_RETRY_MAX ??= "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { waitFor } from "../src/runtime/testing.ts";
import { OPENAI_KEY, startOpenAIMock } from "./models-mock-servers.ts";
import type { Gateway } from "../src/ops/gateway.ts";
import { setResolverForTests } from "../src/tools/netpolicy.ts";

const SECRET = "test-secret-key-for-model-access-0123456789";
const PERSONAL_KEY = "sk-personal-USER-KEY-0123456789abcdef";

async function org(t: TestApp) {
	const owner = await t.user("owner@a.example", { name: "Owner" });
	const dep = (await t.json("POST", "/api/admin/departments", { token: owner.token, json: { name: "研发" } })).department;
	const inv1 = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member", departmentId: dep.id } });
	const dev = await t.user("dev@a.example", { inviteCode: inv1.invite.code, name: "Dev" });
	const inv2 = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const other = await t.user("other@a.example", { inviteCode: inv2.invite.code, name: "Other" });
	return { owner, dev, other, dep };
}
const listIds = async (t: TestApp, token: string) => (await t.json("GET", "/api/models", { token })).models.map((m: any) => m.id) as string[];

test("model visibility: a member outside the allowed department cannot see or pick a restricted model; admin and department member can; default model; assistants flag it", { timeout: 60_000 }, async () => {
	const up = await startOpenAIMock();
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const { owner, dev, other, dep } = await org(t);
		const prov = (await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "公司网关", type: "openai-completions", baseUrl: `${up.url}/v1`, apiKey: OPENAI_KEY } })).provider;
		for (const id of ["open-model", "restricted-model", "user-only-model"]) await t.json("POST", `/api/admin/model-providers/${prov.id}/models`, { token: owner.token, json: { id, name: id } });
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}/models/restricted-model`, { token: owner.token, json: { visibility: { departmentIds: [dep.id] } } });
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}/models/user-only-model`, { token: owner.token, json: { visibility: { userIds: [other.me.userId] } } });
		const R = `${prov.id}/restricted-model`;
		const U = `${prov.id}/user-only-model`;
		const O = `${prov.id}/open-model`;

		assert.deepEqual((await listIds(t, owner.token)).filter((x) => x.startsWith(prov.id)).sort(), [O, R, U].sort(), "admin sees every enabled model");
		assert.deepEqual((await listIds(t, dev.token)).filter((x) => x.startsWith(prov.id)).sort(), [O, R].sort(), "department member");
		assert.deepEqual((await listIds(t, other.token)).filter((x) => x.startsWith(prov.id)).sort(), [O, U].sort(), "named user, not in the department");

		// Non-permitted user cannot pick it: create, and as an assistant default
		const denied = await t.json("POST", "/api/conversations", { token: other.token, json: { modelId: R }, expect: 400 });
		assert.equal(denied.error.code, "unknown_model");
		await t.json("POST", "/api/conversations", { token: other.token, json: { modelId: `${prov.id}/nope` }, expect: 400 });
		const { conversation } = await t.json("POST", "/api/conversations", { token: dev.token, json: { modelId: R } });
		assert.deepEqual(conversation.model ?? (await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: dev.token })).agent.model, { provider: prov.id, modelId: "restricted-model" });
		const bad = await t.json("POST", "/api/assistants", { token: other.token, json: { name: "越权助手", model: { provider: prov.id, modelId: "restricted-model" }, members: [] }, expect: 400 });
		assert.equal(bad.error.code, "model_not_allowed");
		// ... and a revoked model stops working for an existing conversation: dev loses the department → send refused
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}/models/restricted-model`, { token: owner.token, json: { visibility: { departmentIds: ["dep_nobody"] } } });
		const upBefore = up.requests.filter((r) => r.method === "POST").length;
		await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: dev.token, json: { text: "还能用吗", requestId: randomUUID() } });
		const after = await waitFor(async () => {
			const s = await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: dev.token });
			return !s.live.busy && s.entries.some((e: any) => e.kind === "assistant" && e.stopReason === "error") ? s : undefined;
		}, { timeoutMs: 30_000, what: "revoked model refused at request time" });
		assert.match(after.entries.filter((e: any) => e.kind === "assistant").at(-1).errorMessage, /model_not_allowed/);
		assert.equal(up.requests.filter((r) => r.method === "POST").length, upBefore, "the request never reached the upstream");

		// Management APIs are not for members
		for (const [m, p, body] of [["GET", "/api/admin/model-providers"], ["POST", "/api/admin/model-providers", { name: "x", type: "openai-completions", baseUrl: "http://x" }], ["PATCH", `/api/admin/model-providers/${prov.id}`, { name: "pwn" }], ["POST", `/api/admin/model-providers/${prov.id}/fetch-models`, {}], ["POST", `/api/admin/model-providers/${prov.id}/test`, {}], ["PUT", "/api/admin/model-settings", { personalProviders: true }]] as const) {
			await t.json(m, p, { token: dev.token, json: body, expect: 403 });
		}

		// Default model: org setting, validated against the admin's own list
		await t.json("PUT", "/api/admin/model-settings", { token: owner.token, json: { defaultModel: { provider: prov.id, modelId: "nope" } }, expect: 400 });
		await t.json("PUT", "/api/admin/model-settings", { token: owner.token, json: { defaultModel: { provider: prov.id, modelId: "open-model" } } });
		const l = await t.json("GET", "/api/models", { token: other.token });
		assert.equal(l.defaultModelId, O);
		assert.equal(l.models.find((m: any) => m.id === O).isDefault, true);
		const { conversation: dflt } = await t.json("POST", "/api/conversations", { token: other.token, json: {} });
		assert.deepEqual((await t.json("GET", `/api/conversations/${dflt.spaceId}/${dflt.conversationId}/state`, { token: other.token })).agent.model, { provider: prov.id, modelId: "open-model" });

		// Disabling a provider hides all its models at once
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}`, { token: owner.token, json: { status: "disabled" } });
		assert.equal((await listIds(t, other.token)).filter((x) => x.startsWith(prov.id)).length, 0);
	} finally {
		await t.dispose();
		await up.close();
	}
});

test("another org never sees, reads or changes this org's providers; keys stay unreadable", async () => {
	const up = await startOpenAIMock();
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const a = await t.user("a@a.example");
		const b = await t.user("b@b.example");
		const prov = (await t.json("POST", "/api/admin/model-providers", { token: a.token, json: { name: "A 的网关", type: "openai-completions", baseUrl: `${up.url}/v1`, apiKey: OPENAI_KEY, models: [{ id: "m1", name: "m1" }] } })).provider;
		assert.deepEqual((await listIds(t, b.token)).filter((x) => x.startsWith(prov.id)), []);
		assert.equal((await t.json("GET", "/api/admin/model-providers", { token: b.token })).providers.length, 0);
		for (const [m, p] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/test"], ["POST", "/fetch-models"], ["GET", "/models"], ["POST", "/models"], ["PATCH", "/models/m1"]] as const) {
			await t.json(m, `/api/admin/model-providers/${prov.id}${p}`, { token: b.token, json: m === "GET" ? undefined : { name: "pwn", id: "z" }, expect: 404 });
		}
		await t.json("POST", "/api/conversations", { token: b.token, json: { modelId: `${prov.id}/m1` }, expect: 400 });
	} finally {
		await t.dispose();
		await up.close();
	}
});

test("RBAC: with the authz service, model.use / model.manage / model.provider.manage decide who lists, enables and configures", { timeout: 60_000 }, async () => {
	const up = await startOpenAIMock();
	const t = await startTestApp({ config: { secretKey: SECRET } });
	try {
		const { owner, dev } = await org(t);
		const prov = (await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "网关", type: "openai-completions", baseUrl: `${up.url}/v1`, apiKey: OPENAI_KEY, models: [{ id: "m1", name: "m1" }] } })).provider;
		// Swap in a scripted authz (the RBAC group's real service is exercised by its own tests): dev holds only model.manage.
		const granted = new Set<string>(["model.use", "model.manage"]);
		const svc = t.app.ctx.services as any;
		const calls: string[] = [];
		const stub = { has: async (p: any, perm: string) => (calls.push(`${p.userId}:${perm}`), p.userId === owner.me.userId || (p.userId === dev.me.userId && granted.has(perm))), require: async () => {}, explain: async () => ({ allow: true, because: [] }) };
		const orig = svc.has.bind(svc);
		svc.has = (n: string) => n === "authz" || orig(n);
		const origGet = svc.get.bind(svc);
		svc.get = (n: string) => (n === "authz" ? stub : origGet(n));

		assert.ok((await listIds(t, dev.token)).includes(`${prov.id}/m1`), "model.use → listed");
		// model.manage (without provider.manage): may enable/disable/set visibility, may NOT touch providers or keys
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}/models/m1`, { token: dev.token, json: { enabled: false } });
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}`, { token: dev.token, json: { name: "改名" }, expect: 403 });
		await t.json("POST", `/api/admin/model-providers/${prov.id}/test`, { token: dev.token, expect: 403 });
		assert.equal((await t.json("GET", "/api/admin/model-providers", { token: dev.token })).providers.length, 1, "read access with either permission");
		granted.add("model.provider.manage");
		await t.json("PATCH", `/api/admin/model-providers/${prov.id}`, { token: dev.token, json: { name: "改名" } });
		granted.delete("model.use");
		assert.deepEqual(await listIds(t, dev.token), [], "without model.use nothing is offered");
		assert.ok(calls.some((c) => c.endsWith(":model.provider.manage")));
	} finally {
		await t.dispose();
		await up.close();
	}
});

test("personal providers (个人自带密钥): policy-gated, owner-only, SSRF-guarded, key never visible to anyone else", { timeout: 90_000 }, async () => {
	const up = await startOpenAIMock({ key: PERSONAL_KEY, reply: "来自个人密钥的回复" });
	const t = await startTestApp({ config: { secretKey: SECRET } });
	const seen: string[] = [];
	try {
		const { owner, dev, other } = await org(t);
		(t.app.ctx.services.get("models") as unknown as Gateway).resolver = async () => [{ address: "93.184.216.34", family: 4 }]; // "localhost" looks public to the guard
		process.env.WORKROOM_URL_ALLOWLIST = `localhost:${up.port},pinned.test:${up.port}`; // operator allowlist for the request-time pinned fetch
		const body = { name: "我的 Key", type: "openai-completions", baseUrl: `http://localhost:${up.port}/v1`, apiKey: PERSONAL_KEY, fetchModels: true, enableFetched: true };

		// 1. Off by default
		assert.equal((await t.json("GET", "/api/model-settings", { token: dev.token })).personalProviders, false);
		await t.json("POST", "/api/me/model-providers", { token: dev.token, json: body, expect: 403 });
		await t.json("PUT", "/api/admin/model-settings", { token: dev.token, json: { personalProviders: true }, expect: 403 });
		// 2. Admin allows it
		await t.json("PUT", "/api/admin/model-settings", { token: owner.token, json: { personalProviders: true } });
		const created = await t.json("POST", "/api/me/model-providers", { token: dev.token, json: body });
		seen.push(JSON.stringify(created));
		const mine = created.provider;
		assert.equal(mine.scope, "user");
		assert.equal(mine.ownerUserId, dev.me.userId);
		assert.equal(created.fetched.ok, true, JSON.stringify(created.fetched));
		assert.deepEqual(created.models.map((m: any) => m.modelId).sort(), ["mock-chat", "mock-vision", "text-embedding-mock"]);
		assert.equal(created.models.filter((m: any) => m.enabled).length, 2, "enableFetched skips embedding models");
		assert.equal(mine.credential.kind, "stored");
		// The owner can pick and chat with it
		const ids = await listIds(t, dev.token);
		assert.ok(ids.includes(`${mine.id}/mock-chat`));
		const listed = (await t.json("GET", "/api/models", { token: dev.token })).models.find((m: any) => m.id === `${mine.id}/mock-chat`);
		assert.equal(listed.personal, true);
		const { conversation } = await t.json("POST", "/api/conversations", { token: dev.token, json: { modelId: `${mine.id}/mock-chat` } });
		await t.json("POST", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/messages`, { token: dev.token, json: { text: "你好", requestId: randomUUID() } });
		const st = await waitFor(async () => {
			const s = await t.json("GET", `/api/conversations/${conversation.spaceId}/${conversation.conversationId}/state`, { token: dev.token });
			return !s.live.busy && s.entries.some((e: any) => e.kind === "assistant" && e.text) ? s : undefined;
		}, { timeoutMs: 30_000, what: "personal answer" });
		seen.push(JSON.stringify(st));
		assert.equal(st.entries.find((e: any) => e.kind === "assistant").text, "来自个人密钥的回复");
		assert.equal(up.requests.filter((r) => r.method === "POST").at(-1)!.headers.authorization, `Bearer ${PERSONAL_KEY}`);

		// 2b. A collaborator who continues the owner's personal-key conversation in a shared project cannot spend that key
		const { project } = await t.json("POST", "/api/projects", { token: dev.token, json: { kind: "space", name: "共享项目" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: dev.token, json: { email: "other@a.example", role: "editor" } });
		const { conversation: shared } = await t.json("POST", "/api/conversations", { token: dev.token, json: { projectId: project.id, modelId: `${mine.id}/mock-chat` } });
		const postsBefore = up.requests.filter((r) => r.method === "POST").length;
		await t.json("POST", `/api/conversations/${shared.spaceId}/${shared.conversationId}/messages`, { token: other.token, json: { text: "借用一下你的 key", requestId: randomUUID() } });
		const borrowed = await waitFor(async () => {
			const s = await t.json("GET", `/api/conversations/${shared.spaceId}/${shared.conversationId}/state`, { token: dev.token });
			return !s.live.busy && s.entries.some((e: any) => e.kind === "assistant" && e.stopReason === "error") ? s : undefined;
		}, { timeoutMs: 30_000, what: "borrowed personal key refused" });
		assert.match(borrowed.entries.filter((e: any) => e.kind === "assistant").at(-1).errorMessage, /model_not_allowed.*个人自带密钥/);
		assert.equal(up.requests.filter((r) => r.method === "POST").length, postsBefore, "the owner's key was not used for someone else's message");

		// 3. Isolation: nobody else — not another member, not the org owner/admin — sees or reaches it
		for (const who of [other, owner]) {
			assert.ok(!(await listIds(t, who.token)).some((x) => x.startsWith(mine.id)), "not in /api/models");
			assert.deepEqual((await t.json("GET", "/api/me/model-providers", { token: who.token })).providers, []);
			await t.json("POST", "/api/conversations", { token: who.token, json: { modelId: `${mine.id}/mock-chat` }, expect: 400 });
			for (const [m, p] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/test"], ["POST", "/fetch-models"], ["GET", "/models"]] as const) await t.json(m, `/api/me/model-providers/${mine.id}${p}`, { token: who.token, json: m === "GET" ? undefined : { name: "pwn" }, expect: 404 });
		}
		assert.ok(!(await t.json("GET", "/api/admin/model-providers", { token: owner.token })).providers.some((p: any) => p.id === mine.id), "admins do not see users' personal providers");
		await t.json("PATCH", `/api/admin/model-providers/${mine.id}`, { token: owner.token, json: { name: "pwn" }, expect: 404 });
		seen.push(JSON.stringify(await t.json("GET", "/api/me/model-providers", { token: dev.token })), JSON.stringify(await t.json("GET", "/api/admin/audit?limit=300", { token: owner.token })), await (await t.req("GET", "/api/admin/audit.csv", { token: owner.token })).text());
		assert.ok(seen.every((x) => !x.includes(PERSONAL_KEY) && !x.includes(PERSONAL_KEY.slice(10))), "the personal key is never returned or audited");

		// 4. Personal providers cannot reference server env vars or built-in singletons
		await t.json("POST", "/api/me/model-providers", { token: dev.token, json: { ...body, apiKeyEnv: "WORKROOM_SECRET_KEY", fetchModels: false }, expect: 400 });
		await t.json("POST", "/api/me/model-providers", { token: dev.token, json: { name: "b", type: "builtin", builtinId: "anthropic", apiKey: "k" }, expect: 403 });
		// 4b. DNS pinning: the request connects to the address validated at request time. A host that resolved to a public address when the
		// provider was saved but rebinds to loopback afterwards is refused; an allowlisted name connects to its pinned address (no real DNS needed).
		const gwx = t.app.ctx.services.get("models") as unknown as Gateway;
		const pinnedP = (await t.json("POST", "/api/me/model-providers", { token: dev.token, json: { name: "pinned", type: "openai-completions", baseUrl: `http://pinned.test:${up.port}/v1`, apiKey: PERSONAL_KEY, models: [{ id: "mock-chat", name: "pinned" }] } })).provider;
		setResolverForTests(async () => ["127.0.0.1"]);
		try {
			const tr = await t.json("POST", `/api/me/model-providers/${pinnedP.id}/test`, { token: dev.token, json: {} });
			assert.equal(tr.ok, true, JSON.stringify(tr)); // pinned.test has no DNS: the connection used the pinned, validated address
			const rebind = (await t.json("POST", "/api/me/model-providers", { token: dev.token, json: { name: "rebind", type: "openai-completions", baseUrl: `http://rebind.test:${up.port}/v1`, apiKey: PERSONAL_KEY, models: [{ id: "mock-chat", name: "rebind" }] } })).provider;
			const before = up.requests.length;
			const rt = await t.json("POST", `/api/me/model-providers/${rebind.id}/test`, { token: dev.token, json: {} });
			assert.equal(rt.ok, false);
			assert.match(JSON.stringify(rt), /url_blocked|内网|blocked|Connection error|connect/i);
			assert.equal(up.requests.length, before, "the rebound request never reached the loopback server");
			await t.json("DELETE", `/api/me/model-providers/${rebind.id}`, { token: dev.token });
		} finally {
			setResolverForTests(null);
		}
		await t.json("DELETE", `/api/me/model-providers/${pinnedP.id}`, { token: dev.token });
		void gwx;

		// 5. Policy revoked → personal models vanish and the routes close; re-allowed → back
		await t.json("PUT", "/api/admin/model-settings", { token: owner.token, json: { personalProviders: false } });
		assert.ok(!(await listIds(t, dev.token)).some((x) => x.startsWith(mine.id)));
		await t.json("GET", "/api/me/model-providers", { token: dev.token, expect: 403 });
		await t.json("PUT", "/api/admin/model-settings", { token: owner.token, json: { personalProviders: true } });
		assert.ok((await listIds(t, dev.token)).some((x) => x.startsWith(mine.id)));

		// 6. Owner can edit/rotate/delete; deleting removes the models
		await t.json("PATCH", `/api/me/model-providers/${mine.id}`, { token: dev.token, json: { name: "改名后", apiKey: "sk-rotated-000000000000" } });
		await t.json("DELETE", `/api/me/model-providers/${mine.id}`, { token: dev.token });
		assert.ok(!(await listIds(t, dev.token)).some((x) => x.startsWith(mine.id)));
		assert.equal(t.app.ctx.db.get<any>("SELECT COUNT(*) AS n FROM model_entries WHERE provider_id = ?", mine.id)!.n, 0);

		// 7. SSRF guard (no resolver stub): internal / metadata / loopback addresses are refused for personal providers
		(t.app.ctx.services.get("models") as unknown as Gateway).resolver = undefined;
		for (const url of ["http://127.0.0.1:9/v1", "http://169.254.169.254/latest", "http://10.0.0.5/v1", "http://[::1]/v1"]) {
			const r = await t.json("POST", "/api/me/model-providers", { token: dev.token, json: { name: "ssrf", type: "openai-completions", baseUrl: url, apiKey: "k" }, expect: 400 });
			assert.match(r.error.code, /blocked_address|invalid_url/);
		}
		// ... while an ADMIN may point at a local server (Ollama on the same host)
		await t.json("POST", "/api/admin/model-providers", { token: owner.token, json: { name: "本机", type: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1", keyless: true } });

	} finally {
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
		await up.close();
	}
});
