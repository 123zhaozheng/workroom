// Round 11 · R4 — local (in-browser) execution unified with the cloud sandbox. REAL browser, REAL server, fixture model only (no real AI).
//  A. code_run JavaScript runs in the person's browser (sandboxed iframe + worker): the result reaches the answer, an input file is read, an output
//     file lands in the HOST workspace; the iframe has sandbox="allow-scripts" only
//  B. isolation: code that tries fetch / XMLHttpRequest / WebSocket / localStorage inside the runtime cannot reach the Workroom API or any other
//     address (positive control: the page itself reaches the same address)
//  C. routing: static check (fetch in the code) → cloud; second tab → exactly one claim wins; preference 云端 and the admin switch → cloud
//  D. no connected tab → cloud; timeout in the browser → automatic upgrade to the cloud with a note; stop button kills the run
//  E. python runs in the browser too (Pyodide served from our own origin, no CDN) with the same isolation; packages it does not ship → upgrade to the cloud
//  Cloud checks need a sandbox driver on this machine (the local namespaces driver or Docker); without one they are skipped with a message, never faked.
// Run: npm run build:web && node web/e2e/round11-local-exec.mjs        (port 8974)
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { check, chromium, register, sendMessage, shot, sleep, startServer, summary, SHOTS } from "./lib.mjs";

mkdirSync(join(SHOTS, "round11"), { recursive: true });
const PORT = 8974;
const COUNTER_PORT = 8975;

// A listener the sandbox must never reach (positive control: the page itself can).
let hits = 0;
const counter = createServer((req, res) => {
	hits++;
	res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
	res.end("counter");
});
await new Promise((r) => counter.listen(COUNTER_PORT, "127.0.0.1", r));

const server = await startServer({ port: PORT });
const base = server.base;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
await ctx.addInitScript(() => {
	// Records every iframe the app attaches (and detaches), with its sandbox attribute.
	window.__frames = [];
	const mo = new MutationObserver((ms) => {
		for (const m of ms) {
			for (const n of m.addedNodes) if (n.nodeType === 1 && n.tagName === "IFRAME" && n.dataset.testid === "localexec-frame") window.__frames.push({ sandbox: n.getAttribute("sandbox"), alive: true, el: n });
			for (const n of m.removedNodes) if (n.nodeType === 1 && n.tagName === "IFRAME") for (const f of window.__frames) if (f.el === n) f.alive = false;
		}
	});
	document.addEventListener("DOMContentLoaded", () => mo.observe(document.documentElement, { childList: true, subtree: true }));
});
const page = await ctx.newPage();
await register(page, base, { email: "r11local@example.com", name: "本地执行" });

const T = (id) => `[data-testid="${id}"]`;
const api = (path, init) => page.request.fetch(`${base}/api${path}`, init);
const json = async (path, init) => (await api(path, init)).json();

// A conversation created through the API so a file can be put in its workspace before the page opens it.
// Round 12: a conversation prefers the cloud unless it explicitly chose local (the 本地环境 option is greyed out in the UI); this script
// exercises the browser path, so every conversation it makes chooses local explicitly — except the first, whose default is checked.
async function newConversation({ local = true } = {}) {
	const c = await json("/conversations", { method: "POST", data: {} });
	const conv = { spaceId: c.conversation.spaceId, id: c.conversation.conversationId };
	if (local) await api(`/conversations/${conv.spaceId}/${conv.id}/local-exec`, { method: "PUT", data: { preference: "local" } });
	return conv;
}
const putFile = (conv, path, text) => api(`/sandbox/${conv.spaceId}/file?conversationId=${conv.id}&path=${encodeURIComponent(path)}`, { method: "PUT", data: text });
const getFile = async (conv, path) => {
	const r = await api(`/sandbox/${conv.spaceId}/file?conversationId=${conv.id}&path=${encodeURIComponent(path)}`);
	return r.ok() ? r.text() : null;
};
const directive = (args) => `[[call code_run ${JSON.stringify(args)}]]`;
const lastAnswer = async (p = page) => ((await p.locator(T("assistant-message")).last().innerText()) || "").replace(/\s+/g, " ");
const answers = (p) => p.locator(T("assistant-message")).count();
const answered = (p, n) =>
	p.waitForFunction((n) => {
		const els = [...document.querySelectorAll('[data-testid="assistant-message"]')];
		return els.length >= n && !document.querySelector('[data-testid="stop"]') && /工具执行完成|已经回答/.test(els.at(-1)?.textContent ?? "");
	}, n, { timeout: 60000 });
const status = (conv) => json(`/conversations/${conv.spaceId}/${conv.id}/local-exec`);
const connected = async (conv) => {
	for (let i = 0; i < 60; i++) {
		if ((await status(conv)).connected) return true;
		await sleep(250);
	}
	return false;
};
async function open(conv, p = page) {
	await p.goto(`${base}/c/${conv.spaceId}/${conv.id}`);
	await p.waitForSelector(T("composer-input"));
}
async function run(conv, args, p = page) {
	const before = await answers(p);
	await sendMessage(p, directive(args));
	await answered(p, before + 1);
	return lastAnswer(p);
}
const cloudDriver = (await json("/sandbox/driver")).effective;
const haveCloud = cloudDriver !== "none";
console.log(`cloud driver on this machine: ${cloudDriver}`);

try {
	// ================================================================ A. browser run
	const a = await newConversation({ local: false });
	await putFile(a, "in.txt", "hello from the workspace");
	await open(a);
	check("A the tab connects to the conversation (presence)", await connected(a));
	check("A status: enabled by default, preference cloud (round 12: 本地环境 is greyed out until the desktop app ships)", JSON.stringify(await status(a)) === JSON.stringify({ enabled: true, connected: true, preference: "cloud" }));
	await api(`/conversations/${a.spaceId}/${a.id}/local-exec`, { method: "PUT", data: { preference: "local" } });
	const codeA = "const t = await files.read('in.txt'); await files.write('out/up.txt', t.toUpperCase()); console.log('hello from', typeof window === 'undefined' ? 'a worker' : 'a window'); return { sum: [1, 2, 3].reduce((x, y) => x + y, 0), len: t.length };";
	const ansA = await run(a, { language: "javascript", code: codeA, inputs: ["in.txt"] });
	check("A answer says it ran in the browser", /backend: browser/.test(ansA), ansA.slice(0, 240));
	check("A stdout and the return value are in the answer", /hello from a worker/.test(ansA) && /"sum":6/.test(ansA) && /"len":24/.test(ansA), ansA.slice(0, 400));
	check("A the output file was written to the HOST workspace", (await getFile(a, "out/up.txt")) === "HELLO FROM THE WORKSPACE");
	check("A answer lists the file", /files written: out\/up\.txt/.test(ansA));
	const frames = await page.evaluate(() => window.__frames.map((f) => ({ sandbox: f.sandbox, alive: f.alive })));
	check("A the runtime iframe had sandbox=allow-scripts exactly (no allow-same-origin) and was removed after the run", frames.length === 1 && frames[0].sandbox === "allow-scripts" && frames[0].alive === false, JSON.stringify(frames));
	await shot(page, "round11/local-exec-browser-run");

	// ================================================================ B. isolation
	const probe = `const out = {}; const net = async (name, f) => { try { const r = await f(); out[name] = 'REACHED ' + (r && r.status); } catch (e) { out[name] = 'blocked ' + e.name; } };
const G = globalThis; const fe = G['fet' + 'ch']; const X = G['XMLHttp' + 'Request']; const W = G['Web' + 'Socket'];
await net('fetch-api', () => fe('${base}/api/auth/me', { credentials: 'include' }));
await net('fetch-health', () => fe('${base}/api/health'));
await net('fetch-counter', () => fe('http://127.0.0.1:${COUNTER_PORT}/x', { mode: 'no-cors' }));
await net('xhr-counter', () => new Promise((ok, no) => { const x = new X(); x.open('GET', 'http://127.0.0.1:${COUNTER_PORT}/y'); x.onload = () => ok({ status: x.status }); x.onerror = () => no(new Error('xhr blocked')); x.send(); }));
await net('websocket', () => new Promise((ok, no) => { const w = new W('ws://127.0.0.1:${COUNTER_PORT}/z'); w.onopen = () => ok({ status: 101 }); w.onerror = () => no(new Error('ws blocked')); setTimeout(() => no(new Error('ws timeout')), 1500); }));
await net('beacon', async () => { if (!G.navigator || !G.navigator['send' + 'Beacon']) throw new Error('no beacon'); if (!G.navigator['send' + 'Beacon']('http://127.0.0.1:${COUNTER_PORT}/b', 'x')) throw new Error('beacon refused'); return { status: 'queued' }; });
await net('import-script', async () => G['import' + 'Scripts']('http://127.0.0.1:${COUNTER_PORT}/s.js'));
out.localStorage = typeof G.localStorage; out.document = typeof G.document; out.cookie = typeof G.document; out.rtc = typeof G.RTCPeerConnection; out.origin = String(G.origin); out.href = String(G.location && G.location.protocol);
return out;`;
	const b = await newConversation();
	await open(b);
	await connected(b);
	const hitsBefore = hits;
	const ansB = await run(b, { language: "javascript", code: probe });
	check("B the probe ran in the browser runtime (static scan does not see the obfuscated calls)", /backend: browser/.test(ansB), ansB.slice(0, 900));
	const ret = JSON.parse(/return: (\{.*\})/.exec(ansB)?.[1] ?? "{}");
	for (const k of ["fetch-api", "fetch-health", "fetch-counter", "xhr-counter", "websocket", "import-script"]) check(`B ${k} is blocked inside the runtime`, /^blocked/.test(ret[k] ?? ""), `${k}: ${ret[k]}`);
	check("B sendBeacon cannot deliver either", !/REACHED|queued/.test(ret.beacon ?? "queued"), String(ret.beacon));
	check("B no storage, no document, no WebRTC, opaque origin", ret.localStorage === "undefined" && ret.document === "undefined" && ret.rtc === "undefined" && ret.origin === "null", JSON.stringify({ ls: ret.localStorage, doc: ret.document, rtc: ret.rtc, origin: ret.origin }));
	await sleep(500);
	check("B the listener outside saw ZERO requests from the sandbox", hits === hitsBefore, `hits ${hits - hitsBefore}`);
	const control = await page.evaluate(async (u) => {
		try {
			await fetch(u, { mode: "no-cors" });
			return "reached";
		} catch (e) {
			return `failed ${e.name}`;
		}
	}, `http://127.0.0.1:${COUNTER_PORT}/control`);
	await sleep(300);
	check("B positive control: the Workroom page itself DOES reach the same listener (so the block above is the sandbox, not the network)", control === "reached" && hits === hitsBefore + 1, `${control} hits ${hits - hitsBefore}`);

	// ================================================================ C. routing
	const c = await newConversation();
	await open(c);
	await connected(c);
	const ansC1 = await run(c, { language: "javascript", code: "const r = await fetch('http://127.0.0.1:1/'); return r.status" });
	check("C code that needs the network is sent to the cloud (static check), although a tab is connected", /backend: cloud/.test(ansC1) && /代码需要联网/.test(ansC1), ansC1.slice(0, 260));
	// second tab: exactly one claim wins
	const page2 = await ctx.newPage();
	await open(c, page2);
	await page2.waitForTimeout(800);
	const claims = [];
	for (const p of [page, page2]) p.on("response", (r) => /\/local-exec\/jobs\/[^/]+\/claim$/.test(r.url()) && claims.push(r.status()));
	await sendMessage(page, directive({ language: "javascript", code: "return 'two tabs'" }));
	await answered(page, 2);
	await sleep(500);
	check("C two tabs of the same person: exactly one claim won (200), the other got 409", claims.filter((s) => s === 200).length === 1 && claims.filter((s) => s === 409).length === 1, JSON.stringify(claims));
	check("C the job ran once, in the browser", /backend: browser/.test(await lastAnswer()) && /return: "two tabs"/.test(await lastAnswer()));
	await page2.close();

	// preference 云端 → cloud even with a tab
	await api(`/conversations/${c.spaceId}/${c.id}/local-exec`, { method: "PUT", data: { preference: "cloud" } });
	if (haveCloud) {
		await sendMessage(page, directive({ language: "javascript", code: "return 'pref'" }));
		await answered(page, 3);
		const t = await lastAnswer();
		check("C preference 云端 → cloud (reason shown), the code really ran there", /backend: cloud/.test(t) && /只用云端沙箱/.test(t) && /return: "pref"/.test(t), t.slice(0, 260));
	} else console.log("SKIP  C preference cloud run: no sandbox driver on this machine");
	await api(`/conversations/${c.spaceId}/${c.id}/local-exec`, { method: "PUT", data: { preference: "local" } });

	// admin switch (the real UI)
	await page.goto(`${base}/admin?tab=sandbox`);
	await page.waitForSelector(T("local-exec-switch"));
	check("C admin 沙箱 tab shows the 本地执行 switch, on by default", (await page.locator(T("local-exec-switch")).getAttribute("aria-checked")) === "true");
	await page.locator(T("local-exec-switch")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="local-exec-switch"]')?.getAttribute("aria-checked") === "false");
	check("C switching it off is saved on the server", (await json("/sandbox/local-exec")).enabled === false);
	await shot(page, "round11/admin-local-exec-off");
	if (haveCloud) {
		await open(c);
		await connected(c);
		const before = await page.locator(T("assistant-message")).count();
		await sendMessage(page, directive({ language: "javascript", code: "return 'off'" }));
		await answered(page, before + 1);
		const t = await lastAnswer();
		check("C with the switch off the same snippet runs in the cloud (管理员未启用本地执行)", /backend: cloud/.test(t) && /管理员未启用本地执行/.test(t), t.slice(0, 260));
	}
	await page.goto(`${base}/admin?tab=sandbox`);
	await page.waitForSelector(T("local-exec-switch"));
	await page.locator(T("local-exec-switch")).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="local-exec-switch"]')?.getAttribute("aria-checked") === "true");
	check("C switched back on", (await json("/sandbox/local-exec")).enabled === true);

	// ================================================================ D. cloud paths and upgrade
	if (haveCloud) {
		// no connected tab: the conversation is driven through the API only
		const n = await newConversation();
		const rid = `r11-${Date.now()}`;
		await api(`/conversations/${n.spaceId}/${n.id}/messages`, { method: "POST", data: { text: directive({ language: "javascript", code: "return 6 * 7" }), requestId: rid } });
		let text = "";
		for (let i = 0; i < 120 && !/工具执行完成/.test(text); i++) {
			await sleep(500);
			text = JSON.stringify(await json(`/conversations/${n.spaceId}/${n.id}/entries?limit=20`));
		}
		check("D no tab connected → cloud (没有可用的浏览器标签页), and the code ran there (return 42)", /backend: cloud/.test(text) && /没有可用的浏览器标签页/.test(text) && /return: 42/.test(text), text.slice(0, 300));

		// upgrade on timeout: loops forever in the browser (no `process`), finishes in node
		const u = await newConversation();
		await open(u);
		await connected(u);
		const t0 = Date.now();
		const ansU = await run(u, { language: "javascript", timeoutSec: 2, code: "if (typeof process === 'undefined') { while (true) {} } return 'finished in ' + typeof process;" });
		check("D a browser run that times out is retried in the cloud once, with a note", /backend: cloud/.test(ansU) && /note: 浏览器内运行失败（超时），已自动改在云端沙箱重新运行一次/.test(ansU) && /return: "finished in object"/.test(ansU), ansU.slice(0, 360));
		check("D the hard timeout fired near timeoutSec (not after the server's own grace)", Date.now() - t0 < 25000, `${Date.now() - t0} ms`);
		const framesU = await page.evaluate(() => window.__frames.filter((f) => f.alive).length);
		check("D the runtime iframe of the timed-out run is gone", framesU === 0, String(framesU));
		await shot(page, "round11/local-exec-upgrade");

		// Node-only code that slipped past the scan (computed name) → 'unsupported' → upgrade
		const ansN = await run(u, { language: "javascript", code: "const os = eval('req' + 'uire')('node:os'); return typeof os.platform();" });
		check("D code that needs Node but looked light fails in the browser as 'unsupported' and is upgraded", /backend: cloud/.test(ansN) && /note: 浏览器内运行失败（浏览器内不支持所需的模块或接口）/.test(ansN) && /return: "string"/.test(ansN), ansN.slice(0, 360));
	} else console.log("SKIP  D cloud path / upgrade checks: no sandbox driver on this machine");

	// stop button kills a running browser job
	const s = await newConversation();
	await open(s);
	await connected(s);
	await sendMessage(page, directive({ language: "javascript", timeoutSec: 30, code: "await new Promise((r) => setTimeout(r, 25000)); return 'late'" }));
	await page.waitForFunction(() => window.__frames.some((f) => f.alive), null, { timeout: 15000 });
	await page.waitForSelector(T("stop"));
	await page.click(T("stop"));
	await page.waitForFunction(() => !window.__frames.some((f) => f.alive), null, { timeout: 15000 });
	check("D stop → the running browser job is cancelled and its runtime iframe removed", true);
	await page.waitForFunction(() => !document.querySelector('[data-testid="stop"]'), null, { timeout: 15000 });
	check("D after stop nothing from the cancelled run arrives (no 'late')", !(await page.locator("body").innerText()).includes("late"));

	// ================================================================ E. python (Pyodide served from our own origin)
	const py = await newConversation();
	await putFile(py, "data/in.txt", "py input");
	await open(py);
	await connected(py);
	const reqs = [];
	page.on("request", (r) => reqs.push(r.url()));
	const ansP = await run(py, { language: "python", timeoutSec: 20, inputs: ["data/in.txt"], code: "import sys, os\ntext = open('data/in.txt').read()\nos.makedirs('out', exist_ok=True)\nopen('out/py.txt', 'w').write(text.upper())\nprint(sum(range(5)), sys.platform)" });
	check("E python runs IN THE BROWSER (Pyodide), reads the input and writes an output file", /backend: browser/.test(ansP) && /stdout:\s*10 emscripten/.test(ansP) && /files written: out\/py\.txt/.test(ansP), ansP.slice(0, 380));
	check("E the python output file landed in the host workspace", (await getFile(py, "out/py.txt")) === "PY INPUT");
	const pyFiles = reqs.filter((u) => /pyodide|python_stdlib/.test(u));
	check("E the Pyodide files came from the Workroom origin (no CDN request at all)", pyFiles.length >= 4 && pyFiles.every((u) => u.startsWith(base)) && !reqs.some((u) => /jsdelivr|unpkg|cdnjs|pyodide\.org|cloudflare/.test(u)), pyFiles.map((u) => u.replace(base, "")).join(" "));
	const pyHitsBefore = hits;
	const pyProbe = `import json, importlib
res = {}
async def probe(name, make):
    try:
        r = await make()
        res[name] = "REACHED " + str(getattr(r, "status", r))
    except BaseException as e:
        res[name] = "blocked " + type(e).__name__
import js
U = "http://127.0.0.1:${COUNTER_PORT}/"
async def t_socket():
    s = importlib.import_module("soc" + "ket")
    c = s.create_connection(("127.0.0.1", ${COUNTER_PORT}), timeout=2)
    c.sendall(b"GET /socket HTTP/1.0\\r\\n\\r\\n")
    c.settimeout(1)
    return "data:" + repr(c.recv(10))
async def t_urllib():
    u = importlib.import_module("urllib.re" + "quest")
    return getattr(u, "url" + "open")(U + "u", timeout=2)
async def t_jsfetch():
    return await getattr(js, "fet" + "ch")(U + "f")
async def t_pyfetch():
    h = importlib.import_module("pyodide." + "http")
    return await h.pyfetch(U + "p")
async def t_xhr():
    x = getattr(js, "XMLHttp" + "Request").new()
    x.open("GET", U + "x", False)
    x.send()
    return x.status
async def t_api():
    return await getattr(js, "fet" + "ch")("${base}/api/auth/me", {"credentials": "include"})
async def t_jseval():
    return await js.eval("globalThis['fet'+'ch']('" + U + "e')")
async def t_import():
    return getattr(js, "import" + "Scripts")(U + "s.js")
for n, f in [("socket", t_socket), ("urllib", t_urllib), ("js.fetch", t_jsfetch), ("pyfetch", t_pyfetch), ("xhr", t_xhr), ("workroom-api", t_api), ("js.eval-fetch", t_jseval), ("importScripts", t_import)]:
    await probe(n, f)
res["localStorage"] = str(js.eval("typeof localStorage"))
res["document"] = str(js.eval("typeof document"))
res["origin"] = str(js.eval("String(self.origin)"))
print(json.dumps(res))`;
	const ansPP = await run(py, { language: "python", timeoutSec: 30, code: pyProbe });
	check("E the python probe ran in the browser runtime", /backend: browser/.test(ansPP), ansPP.slice(0, 700));
	const pr = JSON.parse(/stdout:\s*(\{.*\})/.exec(ansPP)?.[1] ?? "{}");
	for (const k of ["urllib", "js.fetch", "pyfetch", "xhr", "workroom-api", "js.eval-fetch", "importScripts"]) check(`E python ${k} is blocked inside the runtime`, /^blocked/.test(pr[k] ?? ""), `${k}: ${pr[k]}`);
	check("E python sockets (Emscripten emulation) deliver nothing and receive nothing", !/data:b'[^']/.test(pr.socket ?? "data:b'x'"), String(pr.socket));
	check("E python sees no storage, no document, opaque origin", pr.localStorage === "undefined" && pr.document === "undefined" && pr.origin === "null", JSON.stringify(pr));
	await sleep(500);
	check("E the listener outside saw ZERO requests from the python sandbox", hits === pyHitsBefore, `hits ${hits - pyHitsBefore}`);
	check("E python code that wants the network (requests) is routed to the cloud by the static check", await (async () => {
		if (!haveCloud) return true;
		const t = await run(py, { language: "python", code: "import requests\nprint('x')" });
		return /backend: cloud/.test(t) && /代码需要联网/.test(t);
	})());
	if (haveCloud) {
		const ansM = await run(py, { language: "python", code: "import numpy\nprint('numpy ok')" });
		check("E a package Pyodide does not ship (numpy) fails in the browser as 'unsupported' and is upgraded to the cloud", /backend: cloud/.test(ansM) && /note: 浏览器内运行失败（浏览器内不支持所需的模块或接口）/.test(ansM), ansM.slice(0, 380));
		const t1 = Date.now();
		const ansT = await run(py, { language: "python", timeoutSec: 3, code: "import sys\nif sys.platform == 'emscripten':\n    while True:\n        pass\nprint('finished on', sys.platform)" });
		check("E a python run that times out in the browser is retried in the cloud once", /backend: cloud/.test(ansT) && /note: 浏览器内运行失败（超时）/.test(ansT) && /finished on linux/.test(ansT), ansT.slice(0, 380));
		check("E the python hard timeout counts from the code start, not from the runtime boot", Date.now() - t1 < 40000, `${Date.now() - t1} ms`);
	} else console.log("SKIP  E python upgrade checks: no sandbox driver on this machine");
	await shot(page, "round11/local-exec-python");
} catch (e) {
	check("script ran to the end", false, String(e?.stack ?? e).slice(0, 600));
	await shot(page, "round11/local-exec-failure").catch(() => {});
} finally {
	const ok = summary(join(SHOTS, "../round11-local-exec-results.json"));
	await browser.close();
	await server.stop();
	counter.close();
	process.exitCode = ok ? 0 : 1;
}
