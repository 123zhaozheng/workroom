// Interactive browser sessions (M11-B): agent drives, members take over through the API (click/type/press/navigate/scroll),
// screenshot refreshed after every action, viewers watch only, same URL policy, sessions listed and cleaned up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startTestApp } from "./helpers/app.ts";
import { orgMember } from "./fixtures/util.ts";
import { context, fakeApi, fixedActor } from "./fixtures/tool-harness.ts";
import { createBrowserSessionExtension, type BrowserSessions } from "../src/tools/browser-sessions.ts";

const PAGE = `<!doctype html><html><head><title>首页</title><style>body{margin:0}#go{position:absolute;left:100px;top:100px;width:200px;height:100px}#q{position:absolute;left:100px;top:300px;width:300px;height:40px}</style></head>
<body><a id="go" href="/clicked">去下一页</a><form action="/search"><input id="q" name="q"></form><div style="height:3000px"></div></body></html>`;

test("browser session: agent opens, member takes over and clicks/types/navigates, viewer watches only, policy enforced, cleanup", async () => {
	const server = createServer((req, res) => {
		const u = new URL(req.url!, "http://x");
		if (u.pathname === "/clicked") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>已点击</title><body>clicked page</body>");
		if (u.pathname === "/search") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>搜索 ${u.searchParams.get("q")}</title><body>results for ${u.searchParams.get("q")}</body>`);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as any).port}`;
	process.env.WORKROOM_URL_ALLOWLIST = new URL(base).host;
	const t = await startTestApp();
	try {
		const owner = await t.user("bs-owner@example.com");
		const editor = await orgMember(t, owner, "bs-editor@example.com");
		const viewer = await orgMember(t, owner, "bs-viewer@example.com");
		const outsider = await t.user("bs-out@example.com");
		const { project } = await t.json("POST", "/api/projects", { token: owner.token, json: { kind: "space", name: "Browse" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "bs-editor@example.com", role: "editor" } });
		await t.json("PUT", `/api/projects/${project.id}/members`, { token: owner.token, json: { email: "bs-viewer@example.com", role: "viewer" } });
		const ctx = t.app.ctx;
		const ext = createBrowserSessionExtension(ctx, { resolveActor: fixedActor(ctx, owner.me.userId, owner.me.orgId, project.spaceId) });
		const [open, act] = ext.tools!;
		const conv = 7;
		const api = (n: number) => fakeApi({ conversationId: conv, taskId: n, callId: `b${n}` });

		const r1 = await open!.execute({ url: `${base}/` } as any, api(1), context);
		const s0 = (r1.details as any).browserSession;
		assert.equal(s0.controller.kind, "agent");
		assert.equal(s0.title, "首页");
		assert.equal(s0.version, 1);
		const sid = s0.id;
		const shot = async (token: string) => new Uint8Array(await (await t.req("GET", `/api/browser-sessions/${sid}/screenshot`, { token })).arrayBuffer());
		const shot1 = await shot(viewer.token);
		assert.deepEqual([...shot1.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

		// Listing + work view; viewer may watch but not act; outsiders see nothing.
		const listed = await t.json("GET", `/api/browser-sessions?spaceId=${project.spaceId}&conversationId=${conv}`, { token: viewer.token });
		assert.equal(listed.sessions.length, 1);
		assert.equal(listed.sessions[0].canControl, false);
		assert.equal((await t.json("GET", `/api/work/${project.spaceId}/${conv}`, { token: viewer.token })).work.browserSessions.length, 1);
		await t.json("POST", `/api/browser-sessions/${sid}/takeover`, { token: viewer.token, expect: 403 });
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: viewer.token, json: { type: "scroll", deltaY: 200 }, expect: 403 });
		await t.json("GET", `/api/browser-sessions/${sid}`, { token: outsider.token, expect: 403 });
		assert.equal((await t.req("GET", `/api/browser-sessions/${sid}/screenshot`, { token: outsider.token })).status, 403);

		// The editor must take over before acting; then the agent is refused until control is released.
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "click", x: 200, y: 150 }, expect: 409 });
		const tk = await t.json("POST", `/api/browser-sessions/${sid}/takeover`, { token: editor.token });
		assert.equal(tk.session.controller.kind, "user");
		assert.equal(tk.session.controller.userId, editor.me.userId);
		await assert.rejects(act!.execute({ type: "scroll", deltaY: 100 } as any, api(2), context), /接管/);
		const clicked = await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "click", x: 200, y: 150 } });
		assert.equal(clicked.session.url, `${base}/clicked`);
		assert.equal(clicked.session.title, "已点击");
		assert.equal(clicked.session.version, 2);
		assert.notDeepEqual(await shot(editor.token), shot1, "screenshot refreshed after the action");
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "back" } });
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "click", x: 250, y: 320 } });
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "type", text: "季度报告" } });
		const searched = await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "press", key: "Enter" } });
		assert.match(decodeURIComponent(searched.session.url), /\/search\?q=季度报告/);
		assert.equal(searched.session.title, "搜索 季度报告");
		// Same URL policy as browse.
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "navigate", url: "http://169.254.169.254/latest/meta-data" }, expect: 400 });
		await t.json("POST", `/api/browser-sessions/${sid}/actions`, { token: editor.token, json: { type: "navigate", url: "file:///etc/passwd" }, expect: 400 });

		// Release: the agent drives again.
		await t.json("POST", `/api/browser-sessions/${sid}/release`, { token: editor.token });
		const back = await act!.execute({ type: "navigate", url: `${base}/clicked` } as any, api(3), context);
		assert.match((back.output as any)[0].text, /clicked page/);
		assert.equal((back.details as any).browserSession.controller.kind, "agent");

		// Cleanup: idle sessions are reaped; explicit close removes it from the listing.
		const sessions = ctx.services.get("browserSessions") as BrowserSessions;
		assert.equal(await sessions.reap(Date.now() + 60 * 60_000), 1);
		assert.equal((await t.json("GET", `/api/browser-sessions?spaceId=${project.spaceId}`, { token: owner.token })).sessions.length, 0);
		const s2 = await t.json("POST", "/api/browser-sessions", { token: owner.token, json: { spaceId: project.spaceId, conversationId: conv, url: `${base}/` } });
		assert.equal(s2.session.controller.kind, "user");
		await t.json("DELETE", `/api/browser-sessions/${s2.session.id}`, { token: viewer.token, expect: 403 });
		await t.json("DELETE", `/api/browser-sessions/${s2.session.id}`, { token: owner.token });
		assert.equal((await t.json("GET", `/api/browser-sessions?spaceId=${project.spaceId}`, { token: owner.token })).sessions.length, 0);
	} finally {
		delete process.env.WORKROOM_URL_ALLOWLIST;
		await t.dispose();
		server.close();
	}
});
