// Round 7b · credentials, sandbox environment variables, workspace save status (frontend).
// ALL runs use the FIXTURE model (测试模型): the agent's tool calls come from `[[call <tool> {json}]]` directives, no real AI, no real service.
// Every secret below is a FAKE random string made up by this script.
//
//  A. Credential request card, real server (WORKROOM_SECRET_KEY set): card content, submit once, decline, cancel, stale nonce, replay,
//     env-usage consent, [intercepted] store-unavailable card; then the fake secret is searched in DOM / network / storage / cookies / SSE / API.
//  B. Credentials list (settings): metadata only, rotate, revoke, delete.
//  C. Environment variables: user / org (locked) / project (read-only for a non-manager) / conversation + effective view.
//  D. Workspace save status: save after a command, manual save, versions, restore refused when dirty, keep-both restore.
//     Sandbox expiry is NOT simulated: there is no API that removes a working copy (only the host disk could), so that case is skipped on purpose.
//  E. A second server WITHOUT WORKROOM_SECRET_KEY: the card says so and offers nothing to fill in.
// Run: npm run build:web && node web/e2e/round7b.mjs        (ports 8908 / 8918)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { check, chromium, register, sendMessage, shot as _shot, sleep, startServer, summary, SHOTS, ROOT } from "./lib.mjs";

const DIR = join(SHOTS, "round7b");
mkdirSync(DIR, { recursive: true });
const PORT = 8908;
const rnd = () => randomBytes(6).toString("hex");
const FAKE = `fake-sk-test-${rnd()}`;
const FAKE2 = `fake-sk-test-${rnd()}`;
const FAKE_ROT = `fake-sk-rotated-${rnd()}`;
const FAKE_ENV = `fake-sk-env-${rnd()}`;
const ALL_FAKES = [FAKE, FAKE2, FAKE_ROT, FAKE_ENV];
const MASTER = `e2e-master-key-${rnd()}-NOT-REAL-0123456789`;

const server = await startServer({ port: PORT, env: { WORKROOM_SECRET_KEY: MASTER } });
const base = server.base;
const browser = await chromium.launch();
let skipped = 0;
const skip = (name, why) => {
	skipped++;
	console.log(`SKIP  ${name}  — ${why}`);
};
const shotTo = async (page, name) => {
	await page.screenshot({ path: join(DIR, `${name}.png`), fullPage: false });
};
const newCtx = (w = 1440, h = 900, extra = {}) => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1, locale: "zh-CN", ...extra });
const directive = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const reqArgs = (service, over = {}) => ({ service, purpose: `读取 ${service} 的项目列表`, targetHosts: ["api.example.com"], methods: ["GET", "POST"], ttlSec: 3600, ...over });

async function newMember(admin, name) {
	const code = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role: "member", ttlHours: 24 } })).json()).invite.code;
	const ctx = await newCtx();
	const page = await ctx.newPage();
	const email = `member-${rnd()}@example.com`;
	await page.goto(`${base}/register?invite=${code}`);
	await page.fill("#name", name);
	await page.fill("#email", email);
	await page.fill("#password", "password123");
	await page.click('button[type="submit"]');
	await page.waitForSelector('[data-testid="home-greeting"]');
	return { ctx, page, email };
}
async function startConv(page, text, projectId) {
	const r = await page.request.post(`${base}/api/conversations`, { data: projectId ? { projectId } : {} });
	const { conversation } = await r.json();
	const sp = conversation.spaceId;
	const cid = conversation.conversationId;
	await page.goto(`${base}/c/${sp}/${cid}`);
	await page.waitForSelector('[data-testid="composer-input"]');
	await sendMessage(page, text);
	return { sp, cid };
}
const card = (page) => page.locator('[data-testid="credential-card"]');
async function waitStatus(page, status, timeout) {
	try {
		await page.waitForSelector(`[data-testid="credential-card"][data-status="${status}"]`, { timeout });
	} catch (e) {
		throw new Error(`card never reached ${status}; card text: ${(await card(page).allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ")}`);
	}
}
async function cardFill(page, secret) {
	await page.locator('[data-testid="credential-secret"]').fill(secret);
}

// ---- everything the browser received / sent, for the leak search
function recorder(page) {
	const rec = { responses: [], requests: [] };
	page.on("response", async (r) => {
		try {
			const ct = r.headers()["content-type"] ?? "";
			if (ct.includes("event-stream")) return;
			if (/json|text|javascript|html|css|xml/.test(ct)) rec.responses.push({ url: r.url(), text: await r.text() });
		} catch {
			/* body gone (redirect / aborted) */
		}
	});
	page.on("request", (r) => rec.requests.push({ url: r.url(), method: r.method(), post: r.postData() ?? "" }));
	return rec;
}
async function browserStores(page) {
	return page.evaluate(async () => {
		const out = [];
		try {
			out.push(JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }));
		} catch (e) {
			out.push(`storage-error:${e}`);
		}
		try {
			const dbs = indexedDB.databases ? await indexedDB.databases() : [];
			for (const d of dbs) {
				out.push(`db:${d.name}`);
				await new Promise((res) => {
					const rq = indexedDB.open(d.name);
					rq.onerror = () => res();
					rq.onsuccess = async () => {
						const db = rq.result;
						for (const sn of [...db.objectStoreNames]) {
							out.push(`store:${sn}`);
							await new Promise((r2) => {
								const g = db.transaction(sn).objectStore(sn).getAll();
								g.onsuccess = () => {
									try {
										out.push(JSON.stringify(g.result));
									} catch {
										/* not serialisable */
									}
									r2();
								};
								g.onerror = () => r2();
							});
						}
						db.close();
						res();
					};
				});
			}
		} catch (e) {
			out.push(`idb-error:${e}`);
		}
		return out.join("\n");
	});
}
async function sseText(page, sp, cid, ms = 1800) {
	return page.evaluate(async ({ sp, cid, ms }) => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), ms);
		let text = "";
		try {
			const r = await fetch(`/api/conversations/${sp}/${cid}/events`, { signal: ac.signal, credentials: "same-origin" });
			const rd = r.body.getReader();
			const dec = new TextDecoder();
			for (;;) {
				const { done, value } = await rd.read();
				if (done) break;
				text += dec.decode(value, { stream: true });
			}
		} catch {
			/* aborted on purpose */
		}
		return text;
	}, { sp, cid, ms });
}
const has = (hay, needles) => needles.filter((n) => hay.includes(n));

// =========================================================================================================================
const adminCtx = await newCtx();
const admin = await adminCtx.newPage();
await register(admin, base, { email: `owner-${rnd()}@example.com`, name: "管理员" });
const alice = await newMember(admin, "小李");
const page = alice.page;
const rec = recorder(page);

// ------------------------------------------------------------------ A1. the card (pending) in a real conversation
const A = await startConv(page, `需要 GitHub 的密钥 ${directive("credential_request", reqArgs("GitHub", { purpose: "读取你的项目列表，用来汇总进度" }))}`);
await card(page).first().waitFor({ timeout: 30000 });
check("A [fixture model] credential_request → the card appears in the conversation while the agent waits", (await card(page).count()) === 1 && (await card(page).getAttribute("data-status")) === "pending");
const hostsText = await page.locator('[data-testid="credential-hosts"]').innerText();
const methodsText = await page.locator('[data-testid="credential-methods"]').innerText();
check("A card shows the service, the purpose, the target hosts (prominent) and the methods", (await card(page).innerText()).includes("GitHub") && (await page.locator('[data-testid="credential-purpose"]').innerText()).includes("项目列表") && hostsText.includes("api.example.com") && /GET/.test(methodsText) && /POST/.test(methodsText));
const hostFont = await page.locator('[data-testid="credential-hosts"] span').first().evaluate((el) => ({ fs: parseFloat(getComputedStyle(el).fontSize), fw: Number(getComputedStyle(el).fontWeight) }));
check("A hosts are visually prominent (>= 14px, medium weight, own chip)", hostFont.fs >= 14 && hostFont.fw >= 500, JSON.stringify(hostFont));
const usageText = await page.locator('[data-testid="credential-usage"]').innerText();
check("A proxy usage wording: 经服务器代为调用，密钥不会进入对话", usageText.includes("经服务器代为调用，密钥不会进入对话"));
check("A validity line and the plain warning line 不要在聊天里粘贴密钥；请只在此处填写", (await page.locator('[data-testid="credential-validity"]').innerText()).includes("有效") && (await page.locator('[data-testid="credential-paste-warning"]').innerText()).includes("不要在聊天里粘贴密钥；请只在此处填写"));
const inp = page.locator('[data-testid="credential-secret"]');
check("A the field is a password input, autocomplete=new-password, empty, not remembered", (await inp.getAttribute("type")) === "password" && (await inp.getAttribute("autocomplete")) === "new-password" && (await inp.inputValue()) === "");
check("A choices: 仅本次使用 (default) / 保存供以后使用; scope select only when saving, default 仅自己; 提交 and 拒绝 both present", (await page.locator('[data-testid="credential-persist-once"]').isChecked()) && (await page.locator('[data-testid="credential-scope"]').count()) === 0 && (await page.locator('[data-testid="credential-submit"]').count()) === 1 && (await page.locator('[data-testid="credential-decline"]').innerText()) === "拒绝");
await page.locator('[data-testid="credential-persist-save"]').check();
check("A choosing 保存供以后使用 reveals the scope select with 仅自己 selected; a member is offered no project/org scope", (await page.locator('[data-testid="credential-scope"]').inputValue()) === "user" && (await page.locator('[data-testid="credential-scope"] option').count()) === 1);
await page.locator('[data-testid="credential-persist-once"]').check();
const tech = await page.locator('[data-testid="credential-tech"]').textContent();
check("A request id / header name stay inside 技术详情 (collapsed)", !(await page.locator('[data-testid="credential-tech"]').evaluate((el) => el.open)) && /请求头/.test(tech));
const sum = await page.locator('[data-testid="run-summary"]').innerText();
check("A the run line says it is waiting for the person, in plain words", /等待你提供凭据|正在处理/.test(sum), sum);
await page.evaluate(() => document.querySelector(".wr-scroll")?.scrollTo(0, 99999));
await shotTo(page, "1440-credential-pending");

// responsive + dark screenshots of the same pending card (each load issues a fresh nonce; the main page reloads before submitting)
{
	const state = await alice.ctx.storageState();
	const m = await newCtx(390, 844, { storageState: state });
	const mp = await m.newPage();
	await mp.goto(`${base}/c/${A.sp}/${A.cid}`);
	await mp.locator('[data-testid="credential-card"]').waitFor({ timeout: 20000 });
	await mp.locator('[data-testid="credential-card"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
	await sleep(300);
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	check("A 390px: the card fits (no horizontal page scroll)", overflow <= 0, `overflow ${overflow}`);
	await shotTo(mp, "390-credential-pending");
	await m.close();
	const d = await newCtx(1440, 900, { storageState: state, colorScheme: "dark" });
	const dp = await d.newPage();
	await dp.goto(`${base}/c/${A.sp}/${A.cid}`);
	await dp.locator('[data-testid="credential-card"]').waitFor({ timeout: 20000 });
	await dp.locator('[data-testid="credential-card"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
	await sleep(300);
	await shotTo(dp, "1440-credential-pending-dark");
	await d.close();
}

// ------------------------------------------------------------------ A2. submit once → status, then the leak search
await page.reload();
await card(page).waitFor({ timeout: 20000 });
await cardFill(page, FAKE);
await page.locator('[data-testid="credential-submit"]').click();
await waitStatus(page, "fulfilled", 20000);
check("A submit 仅本次使用 → the card shows 已提供 and the form is gone", (await page.locator('[data-testid="credential-status"]').innerText()) === "已提供" && (await page.locator('[data-testid="credential-secret"]').count()) === 0);
await idle(page);
await page.waitForSelector('[data-testid="credential-outcome"][data-status="fulfilled"]', { timeout: 20000 });
check("A when the agent continues, the turn keeps a one-line outcome 已提供 (and the form card is replaced by it)", (await page.locator('[data-testid="credential-outcome"]').innerText()).includes("已提供") && (await card(page).count()) === 0);
await page.evaluate(() => document.querySelector(".wr-scroll")?.scrollTo(0, 99999));
await shotTo(page, "1440-credential-done");
{
	const m = await newCtx(390, 844, { storageState: await alice.ctx.storageState() });
	const mp = await m.newPage();
	await mp.goto(`${base}/c/${A.sp}/${A.cid}`);
	await mp.locator('[data-testid="credential-outcome"]').waitFor({ timeout: 20000 });
	await shotTo(mp, "390-credential-done");
	await m.close();
}
{
	const html = await page.content();
	const inputs = await page.evaluate(() => [...document.querySelectorAll("input,textarea")].map((e) => e.value).join("\n"));
	const stores = await browserStores(page);
	const cookies = JSON.stringify(await alice.ctx.cookies()) + (await page.evaluate(() => document.cookie));
	const sse = await sseText(page, A.sp, A.cid);
	const entries = await (await page.request.get(`${base}/api/conversations/${A.sp}/${A.cid}/entries?limit=500`)).text();
	const stateJson = await (await page.request.get(`${base}/api/conversations/${A.sp}/${A.cid}/state`)).text();
	const net = rec.responses.map((r) => r.text).join("\n");
	check("A leak search: the fake secret is not in the page HTML / DOM text", !html.includes(FAKE) && !(await page.evaluate(() => document.body.innerText)).includes(FAKE));
	check("A leak search: not in any input value", !inputs.includes(FAKE));
	check(`A leak search: not in any of the ${rec.responses.length} responses the browser received (json/text/html/js/css)`, !net.includes(FAKE), has(net, [FAKE]).join(","));
	check("A leak search: not in localStorage / sessionStorage / IndexedDB", !stores.includes(FAKE), stores.slice(0, 80));
	check("A leak search: not in cookies / document.cookie", !cookies.includes(FAKE));
	check(`A leak search: not in the SSE stream text (${sse.length} bytes read, snapshot included)`, sse.length > 100 && !sse.includes(FAKE));
	check("A leak search: not in the conversation entries API or the state API", entries.length > 100 && !entries.includes(FAKE) && !stateJson.includes(FAKE));
	check("A leak search: not in any URL the page requested or navigated to", !rec.requests.some((r) => r.url.includes(FAKE)) && !page.url().includes(FAKE));
	const carrying = rec.requests.filter((r) => r.post.includes(FAKE));
	check("A the secret travelled in exactly one request: the POST to …/fulfill", carrying.length === 1 && carrying[0].method === "POST" && /\/credential-requests\/[^/]+\/fulfill$/.test(carrying[0].url), carrying.map((c) => c.url).join(","));
	const toolResult = JSON.parse(entries).items?.filter((e) => e.kind === "tool_result" && e.toolName === "credential_request").at(-1);
	check("A the tool result the model got is status only (fulfilled, a credentialId, no value)", !!toolResult && /"status":"fulfilled"/.test(toolResult.text) && !toolResult.text.includes(FAKE));
}

// ------------------------------------------------------------------ A3. decline
const D = await startConv(page, `请提供 Stripe 密钥 ${directive("credential_request", reqArgs("Stripe"))}`);
await card(page).waitFor({ timeout: 30000 });
await page.locator('[data-testid="credential-decline"]').click();
await waitStatus(page, "declined", 15000);
check("A decline (拒绝) → 已拒绝, no form left", (await page.locator('[data-testid="credential-status"]').innerText()) === "已拒绝" && (await page.locator('[data-testid="credential-submit"]').count()) === 0);
await idle(page);
await page.waitForSelector('[data-testid="credential-outcome"][data-status="declined"]', { timeout: 20000 });
const dEntries = await (await page.request.get(`${base}/api/conversations/${D.sp}/${D.cid}/entries?limit=100`)).json();
check("A decline: the agent was told declined, with no credential", dEntries.items.some((e) => e.kind === "tool_result" && /"status":"declined"/.test(e.text) && !/credentialId/.test(e.text)));

// ------------------------------------------------------------------ A4. cancel (the requester withdraws) via the API; the UI must show 已取消
const C = await startConv(page, `再试一次 ${directive("credential_request", reqArgs("Notion"))}`);
await card(page).waitFor({ timeout: 30000 });
const cancelId = (await page.evaluate(async () => (await (await fetch("/api/credential-requests?status=pending")).json()).requests[0]?.id));
const cancelRes = await page.evaluate(async (id) => (await fetch(`/api/credential-requests/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, cancelId);
check("A cancel API → 200", cancelRes === 200);
await idle(page);
await page.waitForSelector('[data-testid="credential-outcome"][data-status="cancelled"]', { timeout: 20000 });
check("A cancel → the turn shows 已取消 and no form remains", (await page.locator('[data-testid="credential-outcome"]').innerText()).includes("已取消") && (await card(page).count()) === 0);

// ------------------------------------------------------------------ A5. stale nonce (another form load replaced it) → plain error + refetch → second submit works; replay of the used nonce
const R = await startConv(page, `存一个长期密钥 ${directive("credential_request", reqArgs("Replay Svc", { targetHosts: ["api.replay.example.com"], ttlSec: 600 }))}`);
await card(page).waitFor({ timeout: 30000 });
const rid = await page.evaluate(async () => (await (await fetch("/api/credential-requests?status=pending")).json()).requests[0].id);
await page.evaluate(async (id) => void (await fetch(`/api/credential-requests/${id}`)), rid); // a second form load: the nonce on screen is now stale
await page.locator('[data-testid="credential-persist-save"]').check();
await cardFill(page, FAKE2);
await page.locator('[data-testid="credential-submit"]').click();
await page.waitForSelector('[data-testid="credential-error"]', { timeout: 10000 });
const staleMsg = await page.locator('[data-testid="credential-error"]').innerText();
check("A stale nonce → a plain 表单已失效 message (no code), the secret field was cleared, the card stays pending", staleMsg.includes("表单已失效") && (await page.locator('[data-testid="credential-secret"]').inputValue()) === "" && (await card(page).getAttribute("data-status")) === "pending", staleMsg);
await sleep(600); // refetch of the nonce
await cardFill(page, FAKE2);
await page.locator('[data-testid="credential-submit"]').click();
await waitStatus(page, "fulfilled", 15000);
check("A after the automatic refetch the second submit succeeds (已提供)", (await page.locator('[data-testid="credential-status"]').innerText()) === "已提供");
const fulfilReq = rec.requests.filter((r) => /\/credential-requests\/[^/]+\/fulfill$/.test(r.url) && r.post.includes(FAKE2)).at(-1);
const usedNonce = JSON.parse(fulfilReq.post).nonce;
const replay = await page.evaluate(async ({ rid, nonce, secret }) => {
	const call = async (body) => {
		const r = await fetch(`/api/credential-requests/${rid}/fulfill`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, json: await r.json().catch(() => ({})) };
	};
	return { same: await call({ secret, persist: "save", nonce }), other: await call({ secret, persist: "save", nonce: "forged-nonce-value" }), list: await (await fetch("/api/credentials")).json() };
}, { rid, nonce: usedNonce, secret: FAKE2 });
check("A replaying the used nonce is answered as the same result (idempotent) and creates nothing new", replay.same.status === 200 && replay.same.json.idempotent === true, JSON.stringify(replay.same.json).slice(0, 120));
check("A a forged / unknown nonce after fulfilment is refused (409), no second credential", replay.other.status === 409 && replay.list.credentials.filter((c) => c.name === "Replay Svc").length === 1, `${replay.other.status} creds=${replay.list.credentials.length}`);
await idle(page);
{
	const html = await page.content();
	const net = rec.responses.map((r) => r.text).join("\n");
	const sse = await sseText(page, R.sp, R.cid);
	const entries = await (await page.request.get(`${base}/api/conversations/${R.sp}/${R.cid}/entries?limit=500`)).text();
	const credsJson = JSON.stringify(replay.list);
	check("A leak search #2 (saved credential): the fake secret is nowhere in DOM, responses, SSE, entries, credentials API, storage", ![html, net, sse, entries, credsJson, await browserStores(page)].some((t) => t.includes(FAKE2)));
}

// ------------------------------------------------------------------ A6. env usage: warning + separate consent; submit stays disabled until ticked
const E = await startConv(page, `需要环境变量方式 ${directive("credential_request", reqArgs("CLI Tool", { usage: "env", envName: "CLI_TOKEN", targetHosts: [], methods: ["GET"] }))}`);
await card(page).waitFor({ timeout: 30000 });
const envUsage = await page.locator('[data-testid="credential-usage"]').innerText();
check("A usage env shows the server\'s honest warning (the command and ALL its child processes can read it, print it, send it over the network) with the variable name", /注入到进程环境/.test(envUsage) && /CLI_TOKEN/.test(envUsage) && /子进程/.test(envUsage) && /读取/.test(envUsage) && /网络发出去/.test(envUsage), envUsage.replace(/\s+/g, " "));
await cardFill(page, FAKE_ENV);
check("A usage env: 提交 is disabled until the separate consent box is ticked", (await page.locator('[data-testid="credential-submit"]').isDisabled()) && (await page.locator('[data-testid="credential-env-consent"]').count()) === 1);
await page.locator('[data-testid="credential-env-consent"]').check();
check("A usage env: ticking consent enables 提交", !(await page.locator('[data-testid="credential-submit"]').isDisabled()));
await shotTo(page, "1440-credential-env-consent");
await page.locator('[data-testid="credential-decline"]').click(); // nothing is stored
await waitStatus(page, "declined", 15000);
await idle(page);
check("A the typed value was cleared when the form was left (field gone, nothing in DOM)", !(await page.evaluate(() => [...document.querySelectorAll("input")].map((e) => e.value).join("")).then((t) => t.includes(FAKE_ENV))));

// ------------------------------------------------------------------ A7. [intercepted] store unavailable on a pending request: only 拒绝
const N = await startConv(page, `需要密钥 ${directive("credential_request", reqArgs("Intercept Svc"))}`);
await card(page).waitFor({ timeout: 30000 });
await page.unroute("**/api/credential-requests/*").catch(() => {});
await page.route(/\/api\/credential-requests\/[^/?]+$/, async (route) => {
	const res = await route.fetch();
	const j = await res.json();
	await route.fulfill({ response: res, json: { ...j, nonce: undefined, store: { id: "none", available: false, reason: "未配置：凭据保险箱不可用" } } });
});
await page.reload();
await page.waitForSelector('[data-testid="credential-no-store"]', { timeout: 20000 });
check("A [intercepted store flag] store unavailable → 服务器未配置密钥存储，暂不能提供凭据 and only 拒绝 (no field, no 提交)", (await page.locator('[data-testid="credential-no-store"]').innerText()).includes("服务器未配置密钥存储，暂不能提供凭据") && (await page.locator('[data-testid="credential-secret"]').count()) === 0 && (await page.locator('[data-testid="credential-submit"]').count()) === 0 && (await page.locator('[data-testid="credential-decline"]').count()) === 1);
await shotTo(page, "1440-credential-no-store-intercepted");
await page.unroute(/\/api\/credential-requests\/[^/?]+$/);
await page.locator('[data-testid="credential-decline"]').click();
await waitStatus(page, "declined", 15000);
await idle(page);

// =========================================================================================================================
// B. credentials list (settings)
await page.goto(`${base}/settings`);
await page.waitForSelector('[data-testid="credentials-section"]');
await page.waitForSelector('[data-testid="credential-row"]', { timeout: 15000 });
const rows = page.locator('[data-testid="credential-row"]');
check("B settings → 我的凭据 lists the saved credential: name, hosts, scope, usage, created/expiry/last used, status", await rows.first().evaluate((el) => /Replay Svc/.test(el.textContent) && /api\.replay\.example\.com/.test(el.textContent) && /仅自己/.test(el.textContent) && /经服务器代为调用/.test(el.textContent) && /创建于/.test(el.textContent) && /长期有效/.test(el.textContent) && /还没有被使用/.test(el.textContent) && /可用/.test(el.textContent)));
check("B the one-time credential (仅本次使用) is not listed", (await rows.count()) === 1);
const sectionText = await page.locator('[data-testid="credentials-section"]').innerText();
const btnTexts = (await page.locator('[data-testid="credentials-section"] button').allInnerTexts()).join("|");
check("B no way to show a secret anywhere: buttons are only 更换密钥 / 撤销 / 删除 (no show / copy), no text input, no value on the page", !/显示|查看|复制|reveal|show|copy/i.test(btnTexts) && (await page.locator('[data-testid="credentials-section"] input').count()) === 0 && !sectionText.includes(FAKE2), btnTexts);
await shotTo(page, "1440-credentials-list");
{
	const m = await newCtx(390, 844, { storageState: await alice.ctx.storageState() });
	const mp = await m.newPage();
	await mp.goto(`${base}/settings`);
	await mp.waitForSelector('[data-testid="credential-row"]');
	await mp.locator('[data-testid="credentials-section"]').scrollIntoViewIfNeeded();
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	check("B 390px: credentials list fits without horizontal page scroll", overflow <= 0, `overflow ${overflow}`);
	await shotTo(mp, "390-credentials-list");
	await m.close();
}
await page.locator('[data-testid="credential-rotate"]').click();
const rot = page.locator('[data-testid="credential-rotate-secret"]');
check("B rotate form: an EMPTY write-only password field", (await rot.getAttribute("type")) === "password" && (await rot.inputValue()) === "" && (await rot.getAttribute("autocomplete")) === "new-password");
await rot.fill(FAKE_ROT);
await page.locator('[data-testid="credential-rotate-submit"]').click();
await page.waitForSelector('[data-testid="credential-rotate-form"]', { state: "detached", timeout: 10000 });
check("B rotate → form closes, nothing of the new value is on the page or in any response", !(await page.content()).includes(FAKE_ROT) && !rec.responses.some((r) => r.text.includes(FAKE_ROT)) && !(await browserStores(page)).includes(FAKE_ROT));
await page.locator('[data-testid="credential-revoke"]').click();
await page.locator('[data-testid="confirm-dialog"] button', { hasText: "撤销" }).last().click();
await page.waitForSelector('[data-testid="credential-row"][data-status="已撤销"]', { timeout: 10000 });
check("B revoke (confirmed) → the row shows 已撤销 and 更换密钥 / 撤销 are disabled", (await page.locator('[data-testid="credential-rotate"]').isDisabled()) && (await page.locator('[data-testid="credential-revoke"]').isDisabled()));
await page.locator('[data-testid="credential-delete"]').click();
await page.locator('[data-testid="confirm-dialog"] button', { hasText: "删除" }).last().click();
await page.waitForSelector('[data-testid="credential-row"]', { state: "detached", timeout: 10000 });
check("B delete (confirmed) → the credential disappears; the empty state explains where credentials come from", (await page.locator('[data-testid="credentials-section"]').innerText()).includes("还没有保存的凭据"));

// =========================================================================================================================
// C. environment variables
const envOf = (testId) => page.locator(`[data-testid="${testId}"]`);
async function addVar(root, name, value, { lock = false } = {}) {
	await root.locator('[data-testid="env-name"]').fill(name);
	await root.locator('[data-testid="env-value"]').fill(value);
	if (lock) await root.locator('[data-testid="env-lock"]').check();
	await root.locator('[data-testid="env-save"]').click();
}
await page.goto(`${base}/settings`);
const uenv = envOf("env-vars-user");
await uenv.waitFor();
await addVar(uenv, "TEAM_REGION", "cn-east");
await uenv.locator('[data-testid="env-row"][data-name="TEAM_REGION"]').waitFor({ timeout: 8000 });
check("C member sets a personal variable → it appears in the table with who/when", (await uenv.locator('[data-testid="env-row"][data-name="TEAM_REGION"]').innerText()).includes("cn-east") && (await uenv.locator('[data-testid="env-row"][data-name="TEAM_REGION"]').innerText()).includes("你"));
check("C the timing note is shown: 修改只对之后启动的命令生效，正在运行的进程不受影响", (await uenv.innerText()).includes("修改只对之后启动的命令生效，正在运行的进程不受影响"));
for (const bad of ["LD_PRELOAD", "PATH", "HTTPS_PROXY"]) {
	await addVar(uenv, bad, "x");
	await uenv.locator('[data-testid="env-error"]').waitFor({ timeout: 8000 });
	const msg = await uenv.locator('[data-testid="env-error"]').innerText();
	check(`C denied name ${bad}: the server's reason is shown plainly (no row created)`, msg.length > 4 && (await uenv.locator(`[data-testid="env-row"][data-name="${bad}"]`).count()) === 0, msg);
	await uenv.locator('[data-testid="env-name"]').fill("");
}
const secretLooking = `sk-${rnd()}${rnd()}${rnd()}`;
await addVar(uenv, "MY_NOTE", secretLooking);
await uenv.locator('[data-testid="env-error"]').waitFor({ timeout: 8000 });
const secMsg = await uenv.locator('[data-testid="env-error"]').innerText();
check("C a secret-looking value is refused, and the message points to 凭据", /凭据/.test(secMsg) && (await uenv.locator('[data-testid="env-row"][data-name="MY_NOTE"]').count()) === 0, secMsg);
await uenv.locator('[data-testid="env-name"]').fill("");
await uenv.locator('[data-testid="env-value"]').fill("");
await shotTo(page, "1440-env-vars-user");
{
	const m = await newCtx(390, 844, { storageState: await alice.ctx.storageState() });
	const mp = await m.newPage();
	await mp.goto(`${base}/settings`);
	await mp.locator('[data-testid="env-vars-user"]').scrollIntoViewIfNeeded();
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	check("C 390px: env table + form fit without horizontal page scroll", overflow <= 0, `overflow ${overflow}`);
	await mp.evaluate(() => document.querySelector('[data-testid="env-vars-user"]').scrollIntoView({ block: "start" }));
	await shotTo(mp, "390-env-vars-user");
	await m.close();
}
// user variable also named like an org-locked one + one the org leaves open
await addVar(uenv, "BUILD_MODE", "user-mode");
await uenv.locator('[data-testid="env-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 8000 });
await addVar(uenv, "ORG_LOCKED", "user-tries-to-override");
await uenv.locator('[data-testid="env-row"][data-name="ORG_LOCKED"]').waitFor({ timeout: 8000 });

// org scope (admin console)
await admin.goto(`${base}/admin?tab=env`);
const oenv = admin.locator('[data-testid="env-vars-org"]');
await oenv.waitFor({ timeout: 15000 });
await oenv.locator('[data-testid="env-name"]').fill("ORG_LOCKED");
await oenv.locator('[data-testid="env-value"]').fill("org-wins");
await oenv.locator('[data-testid="env-lock"]').check();
await oenv.locator('[data-testid="env-save"]').click();
await oenv.locator('[data-testid="env-row"][data-name="ORG_LOCKED"]').waitFor({ timeout: 8000 });
await oenv.locator('[data-testid="env-name"]').fill("BUILD_MODE");
await oenv.locator('[data-testid="env-value"]').fill("org-mode");
await oenv.locator('[data-testid="env-save"]').click();
await oenv.locator('[data-testid="env-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 8000 });
check("C admin console: an org variable can be locked (已锁定 badge); the unlocked one has none", (await oenv.locator('[data-testid="env-row"][data-name="ORG_LOCKED"] [data-testid="env-locked"]').count()) === 1 && (await oenv.locator('[data-testid="env-row"][data-name="BUILD_MODE"] [data-testid="env-locked"]').count()) === 0);
await shotTo(admin, "1440-env-vars-org");
const memberOrgGet = await page.evaluate(async () => (await fetch("/api/sandbox-env/org/anything")).status);
check("C a plain member cannot read/write the org scope (server refuses)", memberOrgGet === 403 || memberOrgGet === 404, String(memberOrgGet));

// project scope: owner edits, a member only reads
const proj = (await (await admin.request.post(`${base}/api/projects`, { data: { name: "环境变量项目" } })).json()).project;
await admin.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: alice.email, role: "editor" } });
await admin.goto(`${base}/projects/${proj.id}`);
const penvAdmin = admin.locator('[data-testid="env-vars-project"]');
await penvAdmin.waitFor({ timeout: 15000 });
await penvAdmin.locator('[data-testid="env-name"]').fill("BUILD_MODE");
await penvAdmin.locator('[data-testid="env-value"]').fill("project-mode");
await penvAdmin.locator('[data-testid="env-save"]').click();
await penvAdmin.locator('[data-testid="env-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 8000 });
check("C project owner (manager) can add a project variable", true);
await page.goto(`${base}/projects/${proj.id}`);
const penvMember = envOf("env-vars-project");
await penvMember.locator('[data-testid="env-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 15000 });
check("C project member (editor, not manager) sees the variable READ-ONLY: no form, no edit/delete, a plain explanation", (await penvMember.locator('[data-testid="env-form"]').count()) === 0 && (await penvMember.locator('[data-testid="env-edit"]').count()) === 0 && (await penvMember.locator('[data-testid="env-delete"]').count()) === 0 && (await penvMember.locator('[data-testid="env-readonly"]').count()) === 1);
const memberPut = await page.evaluate(async (pid) => (await fetch(`/api/sandbox-env/project/${pid}/HACK`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "1" }) })).status, proj.id);
check("C … and the server refuses a project write by that member (403)", memberPut === 403, String(memberPut));
await shotTo(page, "1440-env-vars-project-readonly");

// conversation scope + effective view (which scope won) in the work panel
const W = await startConv(page, `写一个文件 ${directive("sandbox_exec", { language: "shell", code: "echo hello > notes.txt && echo done" })}`, proj.id);
await idle(page, 90000);
await page.click('[data-testid="open-work-panel"]');
await page.click('[data-testid="work-tab-files"]');
await page.waitForSelector('[data-testid="ws-env"]', { timeout: 20000 });
await page.locator('[data-testid="ws-env"] summary').click();
const cenv = envOf("env-vars-conversation");
await cenv.waitFor();
await addVar(cenv, "BUILD_MODE", "conversation-mode");
await cenv.locator('[data-testid="env-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 8000 });
const eff = page.locator('[data-testid="env-effective"]');
await eff.locator('[data-testid="env-effective-row"][data-name="BUILD_MODE"]').waitFor({ timeout: 15000 });
await page.waitForFunction(() => document.querySelector('[data-testid="env-effective-row"][data-name="BUILD_MODE"]')?.getAttribute("data-from") === "conversation", null, { timeout: 15000 });
const bm = await eff.locator('[data-testid="env-effective-row"][data-name="BUILD_MODE"]').innerText();
check("C effective view: the conversation value wins over user, project and org, and says what it overrode", /conversation-mode/.test(bm) && /来自本对话/.test(bm) && /覆盖了/.test(bm) && /个人/.test(bm) && /项目/.test(bm) && /组织/.test(bm), bm.replace(/\s+/g, " "));
const lockedRow = eff.locator('[data-testid="env-effective-row"][data-name="ORG_LOCKED"]');
const lockedText = await lockedRow.innerText();
check("C effective view: an org-LOCKED variable keeps the org value, a lower value cannot override it (and the ignored one is reported)", /org-wins/.test(lockedText) && /来自组织/.test(lockedText) && !/user-tries-to-override/.test(lockedText) && (await eff.locator('[data-testid="env-denied-row"][data-name="ORG_LOCKED"], [data-testid="env-denied-row"]').count()) >= 1, lockedText.replace(/\s+/g, " "));
const userRow = (await eff.locator('[data-testid="env-effective-row"][data-name="TEAM_REGION"]').innerText().catch(() => ""));
check("C effective view: a personal-only variable shows 来自个人", /来自个人/.test(userRow), userRow.replace(/\s+/g, " "));
await page.locator('[data-testid="ws-env"]').scrollIntoViewIfNeeded();
await shotTo(page, "1440-env-effective");

// =========================================================================================================================
// D. workspace save status (same conversation W: the command already wrote notes.txt)
const wsKey = `c${W.cid}`;
const wsApi = `${base}/api/workspaces/${W.sp}/${wsKey}`;
await page.locator('[data-testid="ws-save"]').waitFor({ timeout: 20000 });
await page.waitForFunction(() => ["saved", "dirty"].includes(document.querySelector('[data-testid="ws-save"]')?.getAttribute("data-state") ?? ""), null, { timeout: 15000 });
const st0 = (await (await page.request.get(`${wsApi}/status`)).json()).status;
check("D after a command that wrote a file the workspace is 已保存 with a version (saved at the end of the command)", st0.state === "saved" && st0.headVersion >= 1 && (await page.locator('[data-testid="ws-save-badge"]').innerText()) === "已保存", JSON.stringify({ state: st0.state, head: st0.headVersion }));
const rule = await page.locator('[data-testid="ws-save-rule"]').innerText();
check("D the plain rule sentence is shown (沙箱可能随时到期；…每次命令结束、发布成果和每轮结束时保存。) with the driver's loss-window sentence", rule.includes("沙箱可能随时到期；工作文件在每次命令结束、发布成果和每轮结束时保存。") && (await page.locator('[data-testid="ws-loss-window"]').innerText()).length > 20);
check("D last-saved time is shown", (await page.locator('[data-testid="ws-save-time"]').innerText()).includes("上次保存"));
check("D the versions list shows time, reason in words, file count, size and the current marker", await page.locator('[data-testid="ws-version"]').first().evaluate((el) => /版本 \d+/.test(el.textContent) && /命令结束时自动保存/.test(el.textContent) && /\d+ 个文件/.test(el.textContent) && /当前/.test(el.textContent)));
check("D no wording that mixes the layers (no 'pi', 'durable', 'checkpoint', 'sha256', 'manifest')", !/pi-durable|durable|checkpoint|sha256|manifest/i.test(await page.locator('[data-testid="ws-save"]').innerText()));
await page.locator('[data-testid="ws-save"]').scrollIntoViewIfNeeded();
await shotTo(page, "1440-ws-save-saved");
{
	const m = await newCtx(390, 844, { storageState: await alice.ctx.storageState() });
	const mp = await m.newPage();
	await mp.goto(`${base}/c/${W.sp}/${W.cid}`);
	await mp.click('[data-testid="open-work-panel"]');
	await mp.click('[data-testid="work-tab-files"]');
	await mp.locator('[data-testid="ws-save"]').waitFor({ timeout: 20000 });
	await mp.locator('[data-testid="ws-save"]').scrollIntoViewIfNeeded();
	const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	check("D 390px: the save status fits without horizontal page scroll", overflow <= 0, `overflow ${overflow}`);
	await shotTo(mp, "390-ws-save");
	await m.close();
}
// a change that no command made (upload) → dirty, unsynced count + paths collapsed
const upload = (name, body) => page.request.put(`${base}/api/sandbox/${W.sp}/file?path=${encodeURIComponent(name)}&conversationId=${W.cid}`, { data: Buffer.from(body), headers: { "content-type": "application/octet-stream" } });
check("D (setup) upload extra.txt through the workspace API", (await upload("extra.txt", "extra")).ok());
await page.waitForFunction(() => document.querySelector('[data-testid="ws-save"]')?.getAttribute("data-state") === "dirty", null, { timeout: 15000 });
check("D a file changed outside a command → 有未保存的更改, with a count", (await page.locator('[data-testid="ws-save-badge"]').innerText()) === "有未保存的更改" && /1 个文件的更改尚未保存/.test(await page.locator('[data-testid="ws-unsynced"]').innerText()));
check("D the unsynced paths are collapsed until asked, then listed", (await page.locator('[data-testid="ws-unsynced"] ul').count()) === 0 && (await page.locator('[data-testid="ws-unsynced"] button').click(), (await page.locator('[data-testid="ws-unsynced"] ul').innerText()).includes("extra.txt")));
await page.locator('[data-testid="ws-save-now"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="ws-save"]')?.getAttribute("data-state") === "saved", null, { timeout: 15000 });
check("D 立即保存 → a new version and 已保存", /已保存为版本/.test(await page.locator('[data-testid="ws-save-note"]').innerText()) && (await page.locator('[data-testid="ws-version"]').count()) >= 2);
check("D the manual save is described as 手动保存 in the versions list", (await page.locator('[data-testid="ws-versions"]').innerText()).includes("手动保存"));
// restore refused when dirty
check("D (setup) upload dirty.txt", (await upload("dirty.txt", "unsaved")).ok());
await page.waitForFunction(() => document.querySelector('[data-testid="ws-save"]')?.getAttribute("data-state") === "dirty", null, { timeout: 15000 });
const oldest = page.locator('[data-testid="ws-version"]').last();
const oldestNo = await oldest.getAttribute("data-version");
await oldest.locator('[data-testid="ws-restore"]').click();
await page.locator('[data-testid="confirm-dialog"] button', { hasText: "恢复" }).last().click();
await page.waitForSelector('[data-testid="ws-restore-dirty"]', { timeout: 10000 });
const dirtyText = await page.locator('[data-testid="ws-restore-dirty"]').innerText();
check("D restore while dirty is refused, explained in plain words, and offers 先保存当前内容再恢复", /没有恢复/.test(dirtyText) && /覆盖/.test(dirtyText) && (await page.locator('[data-testid="ws-restore-keep-both"]').innerText()) === "先保存当前内容再恢复" && ["dirty", "conflict"].includes((await (await page.request.get(`${wsApi}/status`)).json()).status.state), dirtyText.replace(/\s+/g, " ").slice(0, 120));
await page.waitForSelector('[data-testid="ws-save-failure"]', { timeout: 10000 });
check("D the sticky state after a refused restore is worded as a refusal (nothing touched), not as a failed verification", /上次恢复没有进行/.test(await page.locator('[data-testid="ws-save-failure"]').innerText()) && (await page.locator('[data-testid="ws-restore-result"]').count()) === 0);
await shotTo(page, "1440-ws-restore-dirty");
await page.locator('[data-testid="ws-restore-keep-both"]').click();
await page.waitForSelector('[data-testid="ws-save-note"]', { timeout: 15000 });
const restoreNote = await page.locator('[data-testid="ws-save-note"]').innerText();
check("D keep-both restore → restored and verified, the previous content kept as its own version", /已恢复到版本/.test(restoreNote) && /核对无误/.test(restoreNote) && /另存为版本/.test(restoreNote), restoreNote);
await page.waitForFunction(() => ["restored", "dirty", "saved"].includes(document.querySelector('[data-testid="ws-save"]')?.getAttribute("data-state") ?? ""), null, { timeout: 10000 });
const restoredStatus = (await (await page.request.get(`${wsApi}/status`)).json()).status;
check("D status after restore: state 已恢复 with a verified restore record (no conflicts)", restoredStatus.state === "restored" && restoredStatus.restore?.verified === true && restoredStatus.restore.conflicts.length === 0 && (await page.locator('[data-testid="ws-restore-result"]').innerText()).includes("已核对无误"), JSON.stringify({ s: restoredStatus.state, r: restoredStatus.restore }));
const filesAfter = (await (await page.request.get(`${base}/api/sandbox/${W.sp}/files?conversationId=${W.cid}`)).json()).entries.map((e) => e.path);
check(`D the working files really are those of version ${oldestNo}: notes.txt present, later uploads gone`, filesAfter.includes("notes.txt") && !filesAfter.includes("dirty.txt"), filesAfter.join(","));
await shotTo(page, "1440-ws-restored");
skip("D simulated sandbox expiry / missing working copy", "no API removes a working copy (only deleting the host directory would), so it is not faked here; the backend's restore-when-absent path is covered by server/test");

// =========================================================================================================================
// E. second server without WORKROOM_SECRET_KEY
const server2 = await startServer({ port: 8918, env: { WORKROOM_SECRET_KEY: undefined, WORKROOM_SECRET_KEY_FILE: undefined, WORKROOM_SECRET_STORE: undefined } });
try {
	const ctx2 = await newCtx();
	const p2 = await ctx2.newPage();
	await register(p2, server2.base, { email: `nokey-${rnd()}@example.com`, name: "无密钥" });
	const r = await p2.request.post(`${server2.base}/api/conversations`, { data: {} });
	const { conversation } = await r.json();
	await p2.goto(`${server2.base}/c/${conversation.spaceId}/${conversation.conversationId}`);
	await p2.waitForSelector('[data-testid="composer-input"]');
	await sendMessage(p2, `需要密钥 ${directive("credential_request", reqArgs("NoStore"))}`);
	await p2.waitForSelector('[data-testid="credential-outcome"]', { timeout: 45000 });
	const t = await p2.locator('[data-testid="credential-outcome"]').innerText();
	check("E server without a secret key: the card says 服务器未配置密钥存储，暂不能提供凭据 (nothing to fill in)", t.includes("服务器未配置密钥存储，暂不能提供凭据") && (await p2.locator('[data-testid="credential-secret"]').count()) === 0 && (await p2.locator('[data-testid="credential-submit"]').count()) === 0, t.replace(/\s+/g, " "));
	await shotTo(p2, "1440-credential-no-store");
	await p2.goto(`${server2.base}/settings`);
	await p2.waitForSelector('[data-testid="credentials-no-store"]', { timeout: 15000 });
	check("E settings → 我的凭据 also says the store is not configured", (await p2.locator('[data-testid="credentials-no-store"]').innerText()).includes("服务器未配置密钥存储"));
	await ctx2.close();
} finally {
	await server2.stop();
}

// final sweep: none of the fake secrets reached any response body the first browser saw
const allNet = rec.responses.map((x) => x.text).join("\n");
check("final: none of the fake secrets appears in any response body this browser received during the whole run", ALL_FAKES.every((f) => !allNet.includes(f)), `${rec.responses.length} responses`);

await browser.close();
await Promise.race([server.stop(), sleep(8000)]);
const ok = summary(join(ROOT, "artifacts/round7b-e2e.json"));
console.log(`(${skipped} skipped with a stated reason; all runs use the fixture model "测试模型")`);
process.exit(ok ? 0 : 1);
