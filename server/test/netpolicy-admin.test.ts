// 网络访问策略（组织级，admin › 角色与权限 › 网络访问）：默认等价于引入前的行为；仅名单模式；通配；阻止名单优先；内网例外；
// 元数据地址始终拦截；环境变量合并；权限；dry-run；审计；缓存失效；按组织隔离；调用方（browse/fetch/MCP/个人模型）按组织取策略。
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { createServer } from "node:http";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { createBrowserExtension } from "../src/tools/browser.ts";
import { fetchBytes } from "../src/vfs/fetch.ts";
import { checkUrl, pinnedRequest, setResolverForTests, testUrl } from "../src/tools/netpolicy.ts";
import { DEFAULT_NET_POLICY, matchNetEntry, normalizeNetPolicy, parseNetEntry } from "../../shared/netpolicy.ts";
import { PERMISSIONS, builtinRole } from "../../shared/permissions.ts";

const PUBLIC = "93.184.216.34";
/** A tiny fake DNS: name → addresses. Unknown names fail like NXDOMAIN. */
function dns(map: Record<string, string[]>) {
	setResolverForTests(async (h) => {
		const a = map[h] ?? (h === "localhost" ? ["127.0.0.1", "::1"] : undefined);
		if (!a) throw new Error("NXDOMAIN");
		return a;
	});
}
const blocked = (p: Promise<unknown>, re: RegExp = /./) => assert.rejects(p, (e: any) => e.code === "url_blocked" && re.test(e.message));
const put = (t: TestApp, token: string, policy: unknown, expect = 200) => t.json("PUT", "/api/admin/network-policy", { token, json: policy, expect });
const get = (t: TestApp, token: string, expect = 200) => t.json("GET", "/api/admin/network-policy", { token, expect });

async function setup() {
	const t = await startTestApp();
	const owner = await t.user("owner@np.example", { name: "所有者" });
	const inv = await t.json("POST", "/api/admin/invites", { token: owner.token, json: { role: "member" } });
	const member = await t.user("member@np.example", { inviteCode: inv.invite.code, name: "成员" });
	const orgId = owner.me.orgId as string;
	return { t, owner, member, orgId };
}
const cleanup = () => {
	setResolverForTests(null);
	delete process.env.WORKROOM_URL_ALLOWLIST;
};

test("shared: entry syntax, normalisation, wildcard matching and policy validation", () => {
	// accepted forms
	for (const ok of ["example.com", "*.example.com", "api.example.com:8443", "10.0.0.5", "10.0.0.5:8080", "[::1]:8080", "::1", "xn--fiq228c.com"]) assert.equal(parseNetEntry(ok, "allow").ok, true, ok);
	// pasting a URL keeps host[:port]; case is folded
	assert.deepEqual(parseNetEntry("https://Docs.Example.com:8443/a/b?x=1", "allow"), { ok: true, entry: "docs.example.com:8443" });
	assert.deepEqual(parseNetEntry("HTTP://Example.COM/", "block"), { ok: true, entry: "example.com" });
	// rejected forms (each with a human reason)
	for (const bad of ["", "exa mple.com", "example.com/path", "*example.com", "*.", "a.*.com", "ftp://example.com", "example.com:0", "example.com:70000", "example.com:abc", "bad_host!.com", "user@example.com", "*.*.com"]) {
		const r = parseNetEntry(bad, "allow");
		assert.equal(r.ok, false, bad);
		assert.match((r as any).error, /[一-鿿]/);
	}
	// wildcard: subdomains only, never the bare domain, never a suffix lookalike
	assert.equal(matchNetEntry("*.example.com", "a.example.com"), true);
	assert.equal(matchNetEntry("*.example.com", "a.b.example.com"), true);
	assert.equal(matchNetEntry("*.example.com", "example.com"), false);
	assert.equal(matchNetEntry("*.example.com", "badexample.com"), false);
	assert.equal(matchNetEntry("*.example.com", "example.com.evil.net"), false);
	// ports: no port = any port; a port must match
	assert.equal(matchNetEntry("example.com", "example.com", "8080"), true);
	assert.equal(matchNetEntry("example.com:443", "example.com", "443"), true);
	assert.equal(matchNetEntry("example.com:443", "example.com", "8443"), false);
	// IPv6 forms compare canonically
	assert.equal(matchNetEntry("[::1]:80", "::1", "80"), true);
	assert.equal(matchNetEntry("0:0:0:0:0:0:0:1", "::1", "80"), true);
	// metadata can never be an 内网例外 entry, but a block entry for it is fine
	assert.equal(parseNetEntry("169.254.169.254", "internal").ok, false);
	assert.equal(parseNetEntry("169.254.1.1", "internal").ok, false);
	assert.equal(parseNetEntry("metadata.google.internal", "internal").ok, false);
	assert.equal(parseNetEntry("metadata.google.internal", "block").ok, true);
	// whole-policy validation: dedupe + normalise, bad mode / bad entry named by list
	const n = normalizeNetPolicy({ mode: "allowlist", allow: ["A.com", "a.com", "https://b.com/x"], block: [], internal: ["10.0.0.5:80"] });
	assert.deepEqual(n.ok && n.policy, { mode: "allowlist", allow: ["a.com", "b.com"], block: [], internal: ["10.0.0.5:80"] });
	assert.equal(normalizeNetPolicy({ mode: "nope" }).ok, false);
	const bad = normalizeNetPolicy({ mode: "open", block: ["ok.com", "bad host"] });
	assert.equal(bad.ok, false);
	assert.match((bad as any).error, /阻止名单/);
	assert.equal(normalizeNetPolicy({ mode: "open", allow: new Array(201).fill("a.com").map((x, i) => `a${i}.com`) }).ok, false);
});

test("default policy = previous behaviour: public allowed, private/loopback/metadata/localhost refused, scheme and credentials refused, env list still opens private hosts", async () => {
	const { t, orgId } = await setup();
	try {
		// A brand-new database: no row, default policy, isDefault
		const { owner } = { owner: (await t.json("POST", "/api/auth/login", { json: { email: "owner@np.example", password: "password123" } })) };
		const cur = await get(t, owner.token);
		assert.deepEqual(cur.policy, DEFAULT_NET_POLICY);
		assert.equal(cur.isDefault, true);
		assert.deepEqual(cur.env.internal, []);

		dns({ "pub.test": [PUBLIC], "priv.test": ["10.1.2.3"], "meta.test": ["169.254.169.254"], "both.test": [PUBLIC, "127.0.0.1"] });
		await checkUrl("https://pub.test/x", { orgId });
		await checkUrl(`http://${PUBLIC}:8080/`, { orgId });
		await blocked(checkUrl("http://priv.test/", { orgId }), /内网/);
		await blocked(checkUrl("http://both.test/", { orgId }), /内网/); // ANY private answer refuses the name
		await blocked(checkUrl("http://127.0.0.1/", { orgId }), /内网/);
		await blocked(checkUrl("http://localhost:3000/", { orgId }), /内网/);
		await blocked(checkUrl("http://169.254.169.254/latest/meta-data", { orgId }), /元数据|内网/);
		await blocked(checkUrl("http://meta.test/", { orgId }), /元数据|内网/);
		await blocked(checkUrl("http://metadata.google.internal/", { orgId }), /元数据/);
		await blocked(checkUrl("ftp://pub.test/", { orgId }), /协议/);
		await blocked(checkUrl("file:///etc/passwd", { orgId }), /协议/);
		await blocked(checkUrl("https://u:p@pub.test/", { orgId }), /用户名/);
		// callers without an organisation get the default policy as well
		await checkUrl("https://pub.test/");
		await blocked(checkUrl("http://priv.test/"), /内网/);
		// Operator env list (unchanged semantics): host, host:port or exact IP opens a private target; and it still reaches the metadata IP like before
		process.env.WORKROOM_URL_ALLOWLIST = "priv.test:8080, 127.0.0.1";
		await checkUrl("http://priv.test:8080/", { orgId });
		await blocked(checkUrl("http://priv.test:9090/", { orgId }), /内网/);
		await checkUrl("http://127.0.0.1:1234/", { orgId });
		process.env.WORKROOM_URL_ALLOWLIST = "169.254.169.254";
		await checkUrl("http://169.254.169.254/", { orgId });
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("allowlist mode: only listed names (and 内网例外 / env entries); wildcard; ports; unlisted names are never resolved", async () => {
	const { t, owner, orgId } = await setup();
	try {
		let lookups = 0;
		setResolverForTests(async (h) => {
			lookups++;
			return h.endsWith("example.com") || h === "other.org" ? [PUBLIC] : ["10.0.0.9"];
		});
		await put(t, owner.token, { mode: "allowlist", allow: ["*.example.com", "docs.other.org", "api.third.net:8443"], block: [], internal: [] });
		await checkUrl("https://a.example.com/", { orgId });
		await checkUrl("https://x.y.example.com/", { orgId });
		await blocked(checkUrl("https://example.com/", { orgId }), /允许名单/); // wildcard excludes the bare domain
		await blocked(checkUrl("https://other.org/", { orgId }), /允许名单/);
		const before = lookups;
		await blocked(checkUrl("https://evil.net/", { orgId }), /允许名单/);
		assert.equal(lookups, before, "a name outside the allowlist is rejected before DNS");
		await blocked(checkUrl(`http://${PUBLIC}/`, { orgId }), /允许名单/); // IP literal not listed
		// host:port entries only match that port
		setResolverForTests(async () => [PUBLIC]);
		await checkUrl("https://api.third.net:8443/", { orgId });
		await blocked(checkUrl("https://api.third.net/", { orgId }), /允许名单/);
		// An allowlist entry does NOT open private addresses: the network floor still applies
		await put(t, owner.token, { mode: "allowlist", allow: ["intranet.test"], block: [], internal: [] });
		setResolverForTests(async () => ["10.0.0.9"]);
		await blocked(checkUrl("https://intranet.test/", { orgId }), /内网/);
		// 内网例外 entries count as allowed in this mode and open their private target
		await put(t, owner.token, { mode: "allowlist", allow: [], block: [], internal: ["intranet.test"] });
		const ok = await checkUrl("https://intranet.test/", { orgId });
		assert.equal(ok.allowlisted, true);
		// env entries are allowed in this mode too
		process.env.WORKROOM_URL_ALLOWLIST = "ops.test";
		await checkUrl("https://ops.test/", { orgId });
		// switching back to open applies at once (cache invalidated on write)
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: [] });
		setResolverForTests(async () => [PUBLIC]);
		await checkUrl("https://evil.net/", { orgId });
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("block list wins over every other rule (allow list, 内网例外, env list), in both modes", async () => {
	const { t, owner, orgId } = await setup();
	try {
		dns({ "a.bad.com": [PUBLIC], "b.bad.com": [PUBLIC], "bad.com": [PUBLIC], "ok.com": [PUBLIC], "inner.test": ["10.0.0.9"], "ops.test": ["10.0.0.8"] });
		await put(t, owner.token, { mode: "open", allow: [], block: ["*.bad.com", "ok.com:8080"], internal: [] });
		await blocked(checkUrl("https://a.bad.com/", { orgId }), /阻止名单/);
		await checkUrl("https://bad.com/", { orgId }); // wildcard excludes the bare domain
		await checkUrl("https://ok.com/", { orgId });
		await blocked(checkUrl("http://ok.com:8080/", { orgId }), /阻止名单/);
		// listed in allow AND block → blocked
		await put(t, owner.token, { mode: "allowlist", allow: ["*.bad.com", "ok.com"], block: ["a.bad.com"], internal: [] });
		await blocked(checkUrl("https://a.bad.com/", { orgId }), /阻止名单/);
		await checkUrl("https://b.bad.com/", { orgId }); // allowed by the wildcard, not blocked
		// internal exception + block → blocked; env + block → blocked
		process.env.WORKROOM_URL_ALLOWLIST = "ops.test";
		await put(t, owner.token, { mode: "open", allow: [], block: ["inner.test", "ops.test"], internal: ["inner.test"] });
		await blocked(checkUrl("https://inner.test/", { orgId }), /阻止名单/);
		await blocked(checkUrl("https://ops.test/", { orgId }), /阻止名单/);
		// IPs can be blocked too
		await put(t, owner.token, { mode: "open", allow: [], block: [PUBLIC], internal: [] });
		await blocked(checkUrl(`https://${PUBLIC}/`, { orgId }), /阻止名单/);
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("内网例外 opens only what it names; the metadata service stays blocked whatever the list says; env keeps its original power", async () => {
	const { t, owner, orgId } = await setup();
	try {
		dns({ "wiki.corp": ["10.0.0.7"], "other.corp": ["10.0.0.8"], "tricky.corp": ["169.254.169.254"], "mixed.corp": ["10.0.0.7", "169.254.169.254"], "meta.google.internal": ["169.254.169.254"] });
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["wiki.corp", "10.0.0.8:8080", "*.lab.corp", "localhost:3000"] });
		await checkUrl("http://wiki.corp/", { orgId });
		await blocked(checkUrl("http://other.corp/", { orgId }), /内网/); // not listed
		await checkUrl("http://10.0.0.8:8080/", { orgId }); // exact IP:port
		await blocked(checkUrl("http://10.0.0.8:9090/", { orgId }), /内网/);
		await blocked(checkUrl("http://10.0.0.9:8080/", { orgId }), /内网/);
		dns({ "svc.lab.corp": ["192.168.1.5"] });
		await checkUrl("http://svc.lab.corp/", { orgId }); // wildcard
		await checkUrl("http://localhost:3000/", { orgId }); // loopback name, explicitly excepted
		await blocked(checkUrl("http://localhost:3001/", { orgId }), /内网/);
		// metadata: even a name that IS in 内网例外 cannot reach it
		dns({ "tricky.corp": ["169.254.169.254"], "mixed.corp": ["10.0.0.7", "169.254.169.254"], "wiki.corp": ["10.0.0.7"] });
		await blocked(checkUrl("http://tricky.corp/", { orgId }), /元数据/); // not listed
		// the API refuses to even store a metadata entry
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["169.254.169.254"] }, 400);
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["metadata.google.internal"] }, 400);
		// ...and a stored wildcard / name that happens to resolve to metadata is still refused at connect time
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["tricky.corp", "mixed.corp", "metadata.google.internal"] }, 400);
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["tricky.corp", "mixed.corp"] });
		await blocked(checkUrl("http://tricky.corp/", { orgId }), /元数据/);
		await blocked(checkUrl("http://mixed.corp/", { orgId }), /元数据/);
		for (const u of ["http://169.254.169.254/", "http://169.254.169.254:80/latest", "http://[::ffff:a9fe:a9fe]/", "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/"]) await blocked(checkUrl(u, { orgId }), /元数据|内网/);
		// operator env list: unchanged behaviour (may name any host, as before)
		process.env.WORKROOM_URL_ALLOWLIST = "tricky.corp";
		await checkUrl("http://tricky.corp/", { orgId });
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("env list merges with the database 内网例外 (shown read-only in the API, never overwritten by a save)", async () => {
	const { t, owner, orgId } = await setup();
	try {
		dns({ "env.corp": ["10.0.0.1"], "db.corp": ["10.0.0.2"] });
		process.env.WORKROOM_URL_ALLOWLIST = "env.corp, 127.0.0.2:9000";
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: ["db.corp"] });
		await checkUrl("http://env.corp/", { orgId });
		await checkUrl("http://db.corp/", { orgId });
		const cur = await get(t, owner.token);
		assert.deepEqual(cur.env.internal, ["env.corp", "127.0.0.2:9000"]);
		assert.deepEqual(cur.policy.internal, ["db.corp"], "env entries are not copied into the stored policy");
		// removing the DB entry leaves the env entry in force; removing the env var removes only that
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: [] });
		await checkUrl("http://env.corp/", { orgId });
		await blocked(checkUrl("http://db.corp/", { orgId }), /内网/);
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await blocked(checkUrl("http://env.corp/", { orgId }), /内网/);
		assert.deepEqual((await get(t, owner.token)).env.internal, []);
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("permission network.manage: owner/admin hold it; members, auditors, reviewers do not; read, write, reset and test are all gated; audit trail", async () => {
	const { t, owner, member, orgId } = await setup();
	try {
		const p = PERMISSIONS.find((x) => x.id === "network.manage")!;
		assert.ok(p && p.group === "network" && p.risk === "sensitive" && p.scopes.length === 1 && p.scopes[0] === "org");
		assert.ok(builtinRole("builtin:admin")!.permissions.includes("network.manage"));
		assert.ok(builtinRole("builtin:owner")!.permissions.includes("network.manage"));
		for (const r of ["auditor", "billing", "dept_admin", "reviewer", "member", "guest"]) assert.ok(!builtinRole(`builtin:${r}`)!.permissions.includes("network.manage"), r);
		// member: everything is 403
		await get(t, member.token, 403);
		await put(t, member.token, { mode: "open" }, 403);
		await t.json("DELETE", "/api/admin/network-policy", { token: member.token, expect: 403 });
		await t.json("POST", "/api/admin/network-policy/test", { token: member.token, json: { url: "https://example.com" }, expect: 403 });
		await t.req("GET", "/api/admin/network-policy").then((r) => assert.equal(r.status, 401));
		// a custom role with only network.manage can use the API (and nothing else); a deny grant takes it away again
		const role = await t.json("POST", "/api/admin/roles", { token: owner.token, json: { name: "网络管理", permissions: ["network.manage"] } });
		await t.json("POST", "/api/admin/role-assignments", { token: owner.token, json: { subject: { kind: "user", id: member.me.userId }, roleId: role.role.id, scope: { kind: "org" } } });
		await get(t, member.token);
		await put(t, member.token, { mode: "allowlist", allow: ["a.example.com"], block: [], internal: [] });
		const deny = await t.json("PUT", `/api/admin/members/${member.me.userId}/grants`, { token: owner.token, json: { permission: "network.manage", effect: "deny", reason: "测试" } });
		await get(t, member.token, 403);
		await t.json("DELETE", `/api/admin/members/${member.me.userId}/grants/${deny.grant.id}`, { token: owner.token });
		await get(t, member.token);
		// audit: update + reset are recorded with actor, before and after (category security)
		await t.json("DELETE", "/api/admin/network-policy", { token: owner.token });
		const rows = t.app.ctx.db.all<any>("SELECT action, actor_user_id, category, detail FROM id_audit WHERE org_id = ? AND action LIKE 'network.policy.%' ORDER BY at", orgId);
		assert.deepEqual(rows.map((r) => r.action), ["network.policy.update", "network.policy.reset"]);
		assert.equal(rows[0].actor_user_id, member.me.userId);
		assert.equal(rows[0].category, "security");
		assert.deepEqual(JSON.parse(rows[0].detail).after.allow, ["a.example.com"]);
		assert.deepEqual(JSON.parse(rows[0].detail).before.mode, "open");
		assert.equal(rows[1].actor_user_id, owner.me.userId);
		const log = await t.json("GET", "/api/admin/audit?action=network.*", { token: owner.token });
		assert.equal(log.items.length, 2);
		// invalid bodies are rejected without touching the stored policy, with a Chinese message naming the list
		const bad = await t.json("PUT", "/api/admin/network-policy", { token: owner.token, json: { mode: "allowlist", allow: ["ok.com", "not a host"] }, expect: 400 });
		assert.match(bad.error?.message ?? JSON.stringify(bad), /允许名单/);
		await t.json("PUT", "/api/admin/network-policy", { token: owner.token, json: { mode: "weird" }, expect: 400 });
		assert.equal((await get(t, owner.token)).isDefault, true);
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("dry run: allowed / blocked with a reason for every rule, nothing is connected, unsaved edits can be tested", async () => {
	const { t, owner } = await setup();
	try {
		dns({ "pub.test": [PUBLIC], "inner.corp": ["10.0.0.7"], "meta.test": ["169.254.169.254"], "www.bad.com": [PUBLIC] });
		const test_ = (url: string, policy?: unknown) => t.json("POST", "/api/admin/network-policy/test", { token: owner.token, json: { url, ...(policy ? { policy } : {}) } });
		let r = await test_("https://pub.test/a");
		assert.deepEqual([r.allowed, r.rule, r.via, r.host, r.port, r.addresses], [true, "ok", "public", "pub.test", "443", [PUBLIC]]);
		r = await test_("pub.test"); // bare host: https assumed
		assert.equal(r.allowed, true);
		r = await test_("http://inner.corp:8080/");
		assert.deepEqual([r.allowed, r.rule], [false, "private"]);
		assert.match(r.reason, /内网例外/); // tells the admin what would open it
		r = await test_("http://meta.test/");
		assert.deepEqual([r.allowed, r.rule], [false, "metadata"]);
		r = await test_("http://169.254.169.254/");
		assert.deepEqual([r.allowed, r.rule], [false, "metadata"]);
		r = await test_("ftp://pub.test/");
		assert.deepEqual([r.allowed, r.rule], [false, "protocol"]);
		r = await test_("https://a:b@pub.test/");
		assert.deepEqual([r.allowed, r.rule], [false, "credentials"]);
		r = await test_("https://nowhere.test/");
		assert.deepEqual([r.allowed, r.rule], [false, "dns"]);
		r = await test_("http://");
		assert.deepEqual([r.allowed, r.rule], [false, "bad_url"]);
		// unsaved policy from the form: not stored, and the stored one is unchanged
		const draft = { mode: "allowlist", allow: ["*.example.com"], block: ["www.bad.com"], internal: ["inner.corp"] };
		r = await test_("https://pub.test/", draft);
		assert.deepEqual([r.allowed, r.rule], [false, "not_in_allowlist"]);
		r = await test_("https://www.bad.com/", draft);
		assert.deepEqual([r.allowed, r.rule], [false, "blocklist"]);
		r = await test_("http://inner.corp/", draft);
		assert.deepEqual([r.allowed, r.rule, r.via], [true, "ok", "internal"]);
		assert.equal((await get(t, owner.token)).isDefault, true);
		// env entries show up as the reason for an allow
		process.env.WORKROOM_URL_ALLOWLIST = "inner.corp";
		r = await test_("http://inner.corp/");
		assert.deepEqual([r.allowed, r.via], [true, "env"]);
		// the dry run is exactly what the real check decides
		assert.equal((await testUrl("http://inner.corp/", { orgId: owner.me.orgId })).allowed, true);
		await t.json("POST", "/api/admin/network-policy/test", { token: owner.token, json: {}, expect: 400 });
		await t.json("POST", "/api/admin/network-policy/test", { token: owner.token, json: { url: "x.com", policy: { mode: "bad" } }, expect: 400 });
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("policies are per organisation; a missing organisation falls back to the default; pinnedRequest honours the policy; a damaged row reads as default", async () => {
	const { t, owner, orgId } = await setup();
	try {
		const other = await t.user("other@np.example", { name: "别的组织" });
		assert.notEqual(other.me.orgId, orgId);
		dns({ "pub.test": [PUBLIC] });
		await put(t, owner.token, { mode: "allowlist", allow: ["nothing.example"], block: [], internal: [] });
		await blocked(checkUrl("https://pub.test/", { orgId }), /允许名单/);
		await checkUrl("https://pub.test/", { orgId: other.me.orgId });
		await checkUrl("https://pub.test/");
		await blocked(pinnedRequest("https://pub.test/", { orgId }), /允许名单/);
		assert.equal((await get(t, other.token)).isDefault, true);
		// cache invalidation on reset; a corrupt row never breaks outbound traffic
		await t.json("DELETE", "/api/admin/network-policy", { token: owner.token });
		await checkUrl("https://pub.test/", { orgId });
		t.app.ctx.db.run("INSERT INTO tool_net_policy (org_id, mode, allow, block, internal, updated_by, updated_at) VALUES (?, 'allowlist', 'not json', '[]', '[]', 'x', 'x')", orgId);
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: [] }); // write replaces the row and drops the cache
		await checkUrl("https://pub.test/", { orgId });
	} finally {
		cleanup();
		await t.dispose();
	}
});

test("callers use the organisation's policy: browse and URL fetch follow 内网例外 and 阻止名单 set in the admin API (no env var)", async () => {
	const { t, owner, orgId } = await setup();
	const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>内部页面</title><body><p>来自内网的内容</p></body>`));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const host = `127.0.0.1:${(server.address() as any).port}`;
	try {
		const ctx = t.app.ctx;
		const space = ctx.services.get("identity").personalSpace(owner.me.userId, orgId);
		const browse = createBrowserExtension(ctx, { resolveActor: fixedActor(ctx, owner.me.userId, orgId, space.id) }).tools![0]!;
		const run = (n: number) => browse.execute({ url: `http://${host}/` } as any, fakeApi({ conversationId: 1, taskId: n, callId: `np${n}` }), context);
		// default policy: the private address is refused (browse and fetch)
		await assert.rejects(run(1), /内网/);
		await assert.rejects(fetchBytes(`http://${host}/`, { orgId }), /内网/);
		// admin adds 内网例外 → both work at once, without a restart
		await put(t, owner.token, { mode: "open", allow: [], block: [], internal: [host] });
		assert.match(((await run(2)).output as any)[0].text, /来自内网的内容/);
		assert.match(new TextDecoder().decode((await fetchBytes(`http://${host}/`, { orgId })).bytes), /来自内网的内容/);
		// another organisation is unaffected
		const other = await t.user("other2@np.example", { name: "他组织" });
		await assert.rejects(fetchBytes(`http://${host}/`, { orgId: other.me.orgId }), /内网/);
		// 阻止名单 wins over the exception
		await put(t, owner.token, { mode: "open", allow: [], block: [host], internal: [host] });
		await assert.rejects(run(3), /阻止名单/);
		await assert.rejects(fetchBytes(`http://${host}/`, { orgId }), /阻止名单/);
	} finally {
		cleanup();
		await new Promise((r) => server.close(r));
		await t.dispose();
	}
});
