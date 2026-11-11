// Round 9 · U2: first-login onboarding (dialog, steps, real 2FA enrol, per-user server flag) and 设置 → 安全 (enable / disable 2FA).
// Run: npm run build:web && node web/e2e/round9-onboarding.mjs        (port 8921)
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { check, chromium, register, ROOT, SHOTS, sleep, startServer, summary } from "./lib.mjs";

const PORT = 8921;
// the onboarding is switched off for every other script (lib.mjs); this one needs it on
const server = await startServer({ port: PORT, env: { WORKROOM_ONBOARDING: "on" } });
const base = server.base;
const browser = await chromium.launch();
const shotDir = join(SHOTS, "round9");
const snap = async (page, name) => page.screenshot({ path: join(shotDir, `u2-${name}.png`) });

// ---- RFC 6238 (HMAC-SHA1, 30 s, 6 digits), written here on purpose: the test must not borrow the server's implementation.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s) {
	let bits = 0, value = 0;
	const out = [];
	for (const ch of s.replace(/[\s=]/g, "").toUpperCase()) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}
function totp(secret, stepOffset = 0, at = Date.now()) {
	const counter = Math.floor(at / 1000 / 30) + stepOffset;
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const h = createHmac("sha1", b32decode(secret)).update(msg).digest();
	const o = h[h.length - 1] & 15;
	return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, "0");
}
// RFC 6238 appendix B vector (SHA-1, secret "12345678901234567890", T = 59 s → 94287082; 6 digits → 287082)
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
check("test helper: the RFC 6238 vector at T=59s gives 287082", totp(RFC_SECRET, 0, 59_000) === "287082");
check("test helper: and 081804 at T=1111111109s", totp(RFC_SECRET, 0, 1_111_111_109_000) === "081804");
const wrongCode = (secret) => {
	const valid = new Set([-1, 0, 1, 2].map((o) => totp(secret, o)));
	for (let n = 111111; ; n += 111) if (!valid.has(String(n))) return String(n);
};

const dialog = (p) => p.locator('[data-testid="onboarding-dialog"]');
const dots = (p) => p.locator('[data-testid="onboarding-dot"]');
const step = (p) => p.locator('[data-testid="onboarding-step"]');
const current = async (p) => (await step(p).getAttribute("data-step")) ?? "";
const me = async (page) => (await (await page.request.get(`${base}/api/me`)).json()).me;
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const noDialogAfterHome = async (p) => {
	await p.waitForSelector('[data-testid="home-greeting"]');
	await sleep(900);
	return (await dialog(p).count()) === 0;
};
/** Sign out the way a person does: the account menu at the bottom of the sidebar → 退出登录. */
async function uiLogout(page, name) {
	await page.getByRole("button", { name: new RegExp(name) }).first().click();
	await page.getByRole("menuitem", { name: "退出登录" }).click();
	await page.waitForURL(/\/login/);
}
async function uiLogin(page, email, code) {
	await page.goto(`${base}/login`);
	await page.fill("#email", email);
	await page.fill("#password", "password123");
	await page.click('button[type="submit"]');
	if (code) {
		await page.waitForSelector("#totp");
		await page.fill("#totp", code);
		await page.click('button[type="submit"]');
	}
	await page.waitForSelector('[data-testid="home-greeting"]');
}

let ok = false;
try {
	// ================================================================ A: the full tour, with a real 2FA enrol
	const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	await ctxA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
	const pa = await ctxA.newPage();
	const errorsA = [];
	pa.on("pageerror", (e) => errorsA.push(e.message));
	await register(pa, base, { email: "tour@r9.example", name: "林小满" });
	await dialog(pa).waitFor({ state: "visible", timeout: 8000 });
	check("A: a brand-new user is shown the onboarding dialog after the first sign-in", (await me(pa)).onboarded === false && (await dialog(pa).isVisible()));
	check("A: it is a modal dialog with an accessible name", (await dialog(pa).getAttribute("role")) === "dialog" && !!(await dialog(pa).getAttribute("aria-labelledby")));
	check("A: four progress dots, exactly one is the current step (aria-current=step)", (await dots(pa).count()) === 4 && (await pa.locator('[data-testid="onboarding-dot"][aria-current="step"]').count()) === 1 && (await dots(pa).first().getAttribute("aria-current")) === "step");
	check("A: the first step is 欢迎 with the product sentence and the person's name", (await current(pa)) === "welcome" && /林小满/.test(await step(pa).innerText()) && /在线工作助手/.test(await step(pa).innerText()));
	check("A: the left column shows a preview on desktop", await pa.locator('[data-testid="onboarding-preview"]').isVisible());
	check("A: the step heading has focus (screen readers announce the step; Tab continues from it)", await pa.evaluate(() => document.activeElement?.tagName === "H2" && !!document.activeElement.closest('[data-testid="onboarding-step"]')));
	check("A: 跳过引导 and 稍后 are both visible on the first step", (await pa.locator('[data-testid="onboarding-skip"]').isVisible()) && (await pa.locator('[data-testid="onboarding-later"]').isVisible()));
	check("A: no back button on the first step", (await pa.locator('[data-testid="onboarding-back"]').count()) === 0);
	await sleep(5200); // the welcome preview plays its sequence once through
	await snap(pa, "onboarding-1-welcome");

	// ---- step 2: 外观 (client prefs, immediate)
	await pa.click('[data-testid="onboarding-next"]');
	await pa.waitForSelector('[data-testid="onboarding-step"][data-step="appearance"]');
	check("A: next → 外观; the second dot is current, the first is marked done", (await dots(pa).nth(1).getAttribute("aria-current")) === "step" && (await dots(pa).first().getAttribute("data-state")) === "done");
	check("A: the preview changes with the step", (await pa.locator('[data-testid="onboarding-preview"]').getAttribute("data-scene")) === "appearance");
	const bgLight = await pa.evaluate(() => getComputedStyle(document.querySelector('[data-testid="onboarding-dialog"]')).backgroundColor);
	await pa.click('[data-testid="onboarding-theme-dark"]');
	await sleep(250);
	const bgDark = await pa.evaluate(() => getComputedStyle(document.querySelector('[data-testid="onboarding-dialog"]')).backgroundColor);
	check("A: choosing 深色 applies at once (html[data-theme=dark], the dialog re-themes)", (await pa.evaluate(() => document.documentElement.dataset.theme)) === "dark" && bgLight !== bgDark, `${bgLight} → ${bgDark}`);
	check("A: the chosen theme card is aria-checked", (await pa.locator('[data-testid="onboarding-theme-dark"]').getAttribute("aria-checked")) === "true" && (await pa.locator('[data-testid="onboarding-theme-light"]').getAttribute("aria-checked")) === "false");
	await snap(pa, "onboarding-2-appearance-dark");
	await pa.click('[data-testid="onboarding-theme-light"]');
	await sleep(150);
	check("A: and 浅色 switches back", (await pa.evaluate(() => document.documentElement.dataset.theme)) === "light");
	await pa.click('[data-testid="onboarding-dot-matrix"]');
	check("A: 动态点阵背景 switch turns the dots off (stored as the client preference)", (await pa.evaluate(() => JSON.parse(localStorage.getItem("wr.prefs.v1") || "{}").dotMatrix)) === false && (await pa.locator('[data-testid="onboarding-preview"] .ob-dots').count()) === 0);
	await pa.click('[data-testid="onboarding-dot-matrix"]');
	await pa.click('[data-testid="onboarding-reduce-motion"]');
	check("A: 减少动画 switch sets html[data-reduce-motion=true]", (await pa.evaluate(() => document.documentElement.dataset.reduceMotion)) === "true");
	await pa.click('[data-testid="onboarding-reduce-motion"]');
	check("A: and turns it back off", (await pa.evaluate(() => document.documentElement.dataset.reduceMotion)) === "false");

	// ---- back / forward
	await pa.click('[data-testid="onboarding-back"]');
	await pa.waitForSelector('[data-testid="onboarding-step"][data-step="welcome"]');
	check("A: 上一步 returns to 欢迎", (await dots(pa).first().getAttribute("aria-current")) === "step");
	await pa.click('[data-testid="onboarding-next"]');
	await pa.waitForSelector('[data-testid="onboarding-step"][data-step="appearance"]');
	check("A: the theme choice survived going back and forth", (await pa.locator('[data-testid="onboarding-theme-light"]').getAttribute("aria-checked")) === "true");

	// ---- step 3: 账号安全, real TOTP
	await pa.click('[data-testid="onboarding-next"]');
	await pa.waitForSelector('[data-testid="onboarding-step"][data-step="security"]');
	check("A: 账号安全 can be skipped: the primary action reads 暂时跳过 until 2FA is on", (await pa.locator('[data-testid="onboarding-next"]').innerText()).trim() === "暂时跳过");
	check("A: nothing is started by merely arriving (no secret yet)", (await pa.locator('[data-testid="totp-secret"]').count()) === 0 && (await me(pa)).totpEnabled === false);
	await snap(pa, "onboarding-3-security-intro");
	await pa.click('[data-testid="totp-start"]');
	await pa.waitForSelector('[data-testid="totp-secret"]');
	const secret = await pa.locator('[data-testid="totp-secret"]').getAttribute("data-secret");
	check("A: the real secret from POST /me/2fa/setup is shown (base32, grouped for reading)", /^[A-Z2-7]{32}$/.test(secret) && (await pa.locator('[data-testid="totp-secret"]').innerText()).replace(/\s/g, "") === secret);
	await pa.click('[data-testid="totp-copy-secret"]');
	await sleep(200);
	check("A: 复制密钥 puts the secret on the clipboard", (await pa.evaluate(() => navigator.clipboard.readText())) === secret);
	await pa.click('[data-testid="totp-copy-uri"]');
	await sleep(200);
	const uri = await pa.evaluate(() => navigator.clipboard.readText());
	check("A: 复制配置链接 copies the otpauth URI for this account", uri.startsWith("otpauth://totp/") && uri.includes(`secret=${secret}`) && uri.includes(encodeURIComponent("tour@r9.example")));
	check("A: the authenticator link is offered", (await pa.locator('[data-testid="totp-open-app"]').getAttribute("href")) === uri);
	check("A: no invented recovery codes: the page says there are none", /不提供恢复码/.test(await step(pa).innerText()) && !/恢复码：|recovery/i.test((await step(pa).innerText()).replace("不提供恢复码", "")));
	check("A: the verify button waits for six digits", await pa.locator('[data-testid="totp-enable"]').isDisabled());
	await pa.fill('[data-testid="totp-code"]', wrongCode(secret));
	await pa.click('[data-testid="totp-enable"]');
	await pa.waitForSelector('[data-testid="totp-error"]');
	check("A: a wrong code is refused with the server's reason and 2FA stays off", (await pa.locator('[data-testid="totp-error"]').innerText()).includes("验证码错误") && (await me(pa)).totpEnabled === false);
	await snap(pa, "onboarding-3-security-secret");
	await pa.fill('[data-testid="totp-code"]', totp(secret));
	await pa.keyboard.press("Enter");
	await pa.waitForSelector('[data-testid="onboarding-totp-on"]', { timeout: 8000 });
	check("A: a correct code (computed in the test with RFC 6238) enables 2FA; Enter submits", (await me(pa)).totpEnabled === true && /已启用/.test(await step(pa).innerText()));
	check("A: the primary action is 下一步 again and the dialog is still up (this session was not signed out)", (await pa.locator('[data-testid="onboarding-next"]').innerText()).trim() === "下一步" && (await dialog(pa).isVisible()));
	await snap(pa, "onboarding-3-security-on");

	// ---- step 4 + finish
	await pa.click('[data-testid="onboarding-next"]');
	await pa.waitForSelector('[data-testid="onboarding-step"][data-step="done"]');
	check("A: last step: 开始使用, no 跳过引导, no 上一步 clutter", (await pa.locator('[data-testid="onboarding-next"]').innerText()).trim() === "开始使用" && (await pa.locator('[data-testid="onboarding-skip"]').count()) === 0);
	check("A: the done step does not nag about 2FA (it is on)", !/还没有开启/.test(await step(pa).innerText()));
	await sleep(1300);
	await snap(pa, "onboarding-4-done");
	await pa.click('[data-testid="onboarding-next"]');
	await dialog(pa).waitFor({ state: "detached", timeout: 5000 });
	check("A: 开始使用 closes the dialog and the server now says onboarded:true", (await me(pa)).onboarded === true);
	check("A: focus is back in the page (not lost on <body> of a removed dialog)", await pa.evaluate(() => !document.querySelector('[data-testid="onboarding-dialog"]')));
	await pa.reload();
	check("A: reload → no dialog again", await noDialogAfterHome(pa));

	// ---- another device: password + TOTP, no dialog
	const ctxA2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pa2 = await ctxA2.newPage();
	await uiLogin(pa2, "tour@r9.example", totp(secret, 1));
	check("A: a second browser signed in with password + code does not see the dialog either (flag is per user, server-side)", await noDialogAfterHome(pa2));
	check("A: and its /me says onboarded:true", (await me(pa2)).onboarded === true);
	await ctxA2.close();
	check("A: no page errors during the tour", errorsA.length === 0, errorsA.join(" | "));

	// ================================================================ B: 跳过引导 completes for good; other users are unaffected
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pb = await ctxB.newPage();
	await register(pb, base, { email: "skip@r9.example", name: "跳过的人" });
	await dialog(pb).waitFor({ state: "visible" });
	await pb.click('[data-testid="onboarding-skip"]');
	await dialog(pb).waitFor({ state: "detached", timeout: 5000 });
	check("B: 跳过引导 on the first step finishes the onboarding (server flag set)", (await me(pb)).onboarded === true);
	await uiLogout(pb, "跳过的人");
	await uiLogin(pb, "skip@r9.example");
	check("B: signing out and in again → no dialog", await noDialogAfterHome(pb));
	check("B: skipping the onboarding left 2FA off", (await me(pb)).totpEnabled === false);
	const ctxB2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pb2 = await ctxB2.newPage();
	await register(pb2, base, { email: "other@r9.example", name: "另一个人" });
	await dialog(pb2).waitFor({ state: "visible", timeout: 8000 });
	check("B: another user who has not finished still gets the dialog (per user)", (await me(pb2)).onboarded === false);
	await ctxB2.close();
	await ctxB.close();

	// ================================================================ D: 稍后 (Escape) defers to the next login
	const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pd = await ctxD.newPage();
	await register(pd, base, { email: "later@r9.example", name: "稍后的人" });
	await dialog(pd).waitFor({ state: "visible" });
	await pd.keyboard.press("Escape");
	await dialog(pd).waitFor({ state: "detached", timeout: 5000 });
	check("D: Escape closes the dialog but does NOT finish the onboarding", (await me(pd)).onboarded === false);
	await pd.reload();
	check("D: a reload in the same session keeps it closed", await noDialogAfterHome(pd));
	await uiLogout(pd, "稍后的人");
	await uiLogin(pd, "later@r9.example");
	await dialog(pd).waitFor({ state: "visible", timeout: 8000 });
	check("D: the next login shows it again", true);
	await pd.click('[data-testid="onboarding-later"]');
	await dialog(pd).waitFor({ state: "detached" });
	check("D: the 稍后 button does the same as Escape", (await me(pd)).onboarded === false);
	const ctxD2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pd2 = await ctxD2.newPage();
	await uiLogin(pd2, "later@r9.example");
	await dialog(pd2).waitFor({ state: "visible", timeout: 8000 });
	check("D: another browser also shows it (nothing was finished)", true);
	await ctxD2.close();
	await ctxD.close();

	// ================================================================ E: keyboard only, focus trap, no mouse
	const ctxE = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pe = await ctxE.newPage();
	await register(pe, base, { email: "keys@r9.example", name: "键盘党" });
	await dialog(pe).waitFor({ state: "visible" });
	let trapped = true;
	for (let n = 0; n < 14; n++) {
		await pe.keyboard.press("Tab");
		trapped &&= await pe.evaluate(() => !!document.activeElement?.closest('[data-testid="onboarding-dialog"]'));
	}
	check("E: 14 Tab presses never leave the dialog (focus trap)", trapped);
	const tabTo = async (testid, max = 12) => {
		for (let n = 0; n < max; n++) {
			if (await pe.evaluate((t) => document.activeElement?.getAttribute("data-testid") === t, testid)) return true;
			await pe.keyboard.press("Tab");
		}
		return false;
	};
	check("E: Tab reaches 下一步", await tabTo("onboarding-next"));
	await pe.keyboard.press("Enter");
	await pe.waitForSelector('[data-testid="onboarding-step"][data-step="appearance"]');
	check("E: Enter on 下一步 advances; the new heading takes focus", await pe.evaluate(() => document.activeElement?.tagName === "H2" && document.activeElement.textContent.includes("外观")));
	await pe.keyboard.press("Tab");
	check("E: Tab from the heading lands on the checked theme (roving tabindex)", await pe.evaluate(() => document.activeElement?.getAttribute("role") === "radio" && document.activeElement.getAttribute("aria-checked") === "true"));
	await pe.keyboard.press("ArrowRight");
	await pe.keyboard.press("ArrowRight");
	check("E: arrow keys move through the themes and select (→ 深色)", (await pe.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await pe.locator('[data-testid="onboarding-theme-dark"]').getAttribute("aria-checked")) === "true");
	await pe.keyboard.press("Tab");
	await pe.keyboard.press("Space");
	check("E: Space toggles the 减少动画 switch", (await pe.evaluate(() => document.documentElement.dataset.reduceMotion)) === "true");
	await pe.keyboard.press("Escape");
	await dialog(pe).waitFor({ state: "detached", timeout: 5000 });
	check("E: Escape = 稍后 (closed, not finished)", (await me(pe)).onboarded === false);
	await ctxE.close();

	// ================================================================ F: reduced motion (system) — a finished picture, no movement
	const ctxF = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
	const pf = await ctxF.newPage();
	await register(pf, base, { email: "calm@r9.example", name: "安静" });
	await dialog(pf).waitFor({ state: "visible" });
	const anim = (sel) => pf.evaluate((s) => [...document.querySelectorAll(s)].map((e) => getComputedStyle(e).animationName), sel);
	check("F: prefers-reduced-motion: the welcome preview does not animate and every part is visible", (await anim('[data-testid="onboarding-preview"] [class*="ob-r"]')).every((a) => a === "none") && (await pf.evaluate(() => [...document.querySelectorAll('[data-testid="onboarding-preview"] [class*="ob-r"]')].every((e) => getComputedStyle(e).opacity === "1"))));
	await pf.click('[data-testid="onboarding-next"]');
	await pf.click('[data-testid="onboarding-next"]');
	await pf.waitForSelector('[data-testid="onboarding-step"][data-step="security"]');
	check("F: the security preview is still too (shield, code, timer)", (await anim('[data-testid="onboarding-preview"] *')).every((a) => a === "none"));
	check("F: only one of the two sample codes is shown when still", (await pf.locator('[data-testid="onboarding-preview"] .ob-s-digits:visible').count()) === 1);
	await ctxF.close();
	// the in-app toggle does the same without the system setting
	const ctxF2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const pf2 = await ctxF2.newPage();
	await register(pf2, base, { email: "calm2@r9.example", name: "安静二" });
	await dialog(pf2).waitFor({ state: "visible" });
	check("F: without the setting the welcome preview does animate", (await pf2.evaluate(() => [...document.querySelectorAll('[data-testid="onboarding-preview"] [class*="ob-r"]')].some((e) => getComputedStyle(e).animationName !== "none"))));
	await pf2.click('[data-testid="onboarding-next"]');
	await pf2.click('[data-testid="onboarding-reduce-motion"]');
	await pf2.click('[data-testid="onboarding-back"]');
	await sleep(100);
	check("F: the in-app 减少动画 toggle stops the preview too", (await pf2.evaluate(() => [...document.querySelectorAll('[data-testid="onboarding-preview"] *')].every((e) => getComputedStyle(e).animationName === "none"))));
	await ctxF2.close();

	// ================================================================ G: 390px
	const ctxG = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true });
	const pg = await ctxG.newPage();
	await register(pg, base, { email: "phone@r9.example", name: "手机用户" });
	await dialog(pg).waitFor({ state: "visible" });
	await sleep(300);
	const fits = async () => pg.evaluate(() => { const r = document.querySelector('[data-testid="onboarding-dialog"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
	check("G 390: single column — the preview is hidden", !(await pg.locator('[data-testid="onboarding-preview"]').isVisible()));
	check("G 390: the dialog fits the screen and the page has no horizontal scroll", (await fits()) && !(await overflowX(pg)));
	check("G 390: the footer buttons are on screen and big enough to tap", await pg.evaluate(() => ["onboarding-skip", "onboarding-next"].every((t) => { const r = document.querySelector(`[data-testid="${t}"]`).getBoundingClientRect(); return r.bottom <= innerHeight && r.height >= 32 && r.width > 0; })));
	await snap(pg, "onboarding-390-welcome");
	await pg.tap('[data-testid="onboarding-next"]');
	await pg.waitForSelector('[data-testid="onboarding-step"][data-step="appearance"]');
	await pg.tap('[data-testid="onboarding-theme-dark"]');
	check("G 390: appearance step works by touch and still fits", (await pg.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await fits()));
	await snap(pg, "onboarding-390-appearance-dark");
	await pg.tap('[data-testid="onboarding-next"]');
	await pg.waitForSelector('[data-testid="onboarding-step"][data-step="security"]');
	await pg.tap('[data-testid="totp-start"]');
	await pg.waitForSelector('[data-testid="totp-secret"]');
	check("G 390: the secret and the code field are reachable by scrolling inside the dialog; no horizontal scroll", (await fits()) && !(await overflowX(pg)) && (await pg.evaluate(() => { const s = document.querySelector('[data-testid="onboarding-step"]'); return s.scrollWidth <= s.clientWidth + 1; })));
	await snap(pg, "onboarding-390-security");
	await pg.tap('[data-testid="onboarding-next"]');
	await pg.waitForSelector('[data-testid="onboarding-step"][data-step="done"]');
	await sleep(1300);
	await snap(pg, "onboarding-390-done");
	await pg.tap('[data-testid="onboarding-next"]');
	await dialog(pg).waitFor({ state: "detached", timeout: 5000 });
	check("G 390: finishing by touch completes the onboarding", (await me(pg)).onboarded === true && !(await overflowX(pg)));
	await ctxG.close();

	// ================================================================ H: 设置 → 安全 (enable, wrong code, disable)
	const ctxH = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const ph = await ctxH.newPage();
	await register(ph, base, { email: "settings@r9.example", name: "设置党" });
	await dialog(ph).waitFor({ state: "visible" });
	await ph.click('[data-testid="onboarding-skip"]');
	await dialog(ph).waitFor({ state: "detached" });
	await ph.goto(`${base}/settings?tab=security`);
	await ph.waitForSelector('[data-testid="two-factor"]');
	check("H: 设置 has a 安全 tab (seven entries now)", (await ph.locator('[data-testid^="settings-tab-"]').count()) === 7 && (await ph.locator('[data-testid="settings-tab-security"]').getAttribute("aria-current")) === "page");
	check("H: 2FA shows 未启用 with an 启用 button", (await ph.locator('[data-testid="totp-status"]').getAttribute("data-enabled")) === "false" && (await ph.locator('[data-testid="totp-enable-open"]').isVisible()));
	await snap(ph, "settings-security-off");
	await ph.click('[data-testid="totp-enable-open"]');
	await ph.waitForSelector('[data-testid="totp-secret"]');
	const hSecret = await ph.locator('[data-testid="totp-secret"]').getAttribute("data-secret");
	check("H: enable starts the real enrol flow (secret from the server)", /^[A-Z2-7]{32}$/.test(hSecret));
	await snap(ph, "settings-security-enrol");
	await ph.fill('[data-testid="totp-code"]', wrongCode(hSecret));
	await ph.click('[data-testid="totp-enable"]');
	await ph.waitForSelector('[data-testid="totp-error"]');
	check("H: a wrong code is refused", (await ph.locator('[data-testid="totp-status"]').getAttribute("data-enabled")) === "false");
	await ph.fill('[data-testid="totp-code"]', totp(hSecret));
	await ph.click('[data-testid="totp-enable"]');
	await ph.waitForSelector('[data-testid="totp-status"][data-enabled="true"]');
	check("H: the right code enables it: status 已启用 (round 11: no success banner), the secret is gone from the page", (await ph.locator('[data-testid="totp-notice"]').count()) === 0 && (await ph.locator('[data-testid="totp-secret"]').count()) === 0 && (await me(ph)).totpEnabled === true);
	await snap(ph, "settings-security-on");
	await ph.reload();
	await ph.waitForSelector('[data-testid="totp-status"][data-enabled="true"]');
	check("H: after a reload it is still 已启用 (this session stays signed in)", (await ph.locator('[data-testid="totp-disable-open"]').isVisible()));
	await ph.click('[data-testid="totp-disable-open"]');
	await ph.waitForSelector('[data-testid="totp-disable-code"]');
	await ph.fill('[data-testid="totp-disable-code"]', wrongCode(hSecret));
	await ph.click('[data-testid="totp-disable-confirm"]');
	await ph.waitForSelector('[data-testid="totp-disable-error"]');
	check("H: disabling with a wrong code is refused and 2FA stays on", (await me(ph)).totpEnabled === true);
	// the enable code used step S; a disable needs a fresh one (the next step is accepted within the server's ±1 window)
	await ph.fill('[data-testid="totp-disable-code"]', totp(hSecret, 1));
	await ph.click('[data-testid="totp-disable-confirm"]');
	await ph.waitForSelector('[data-testid="totp-status"][data-enabled="false"]', { timeout: 8000 });
	check("H: a fresh valid code turns 2FA off (status 未启用, server agrees; no 已关闭 banner)", (await me(ph)).totpEnabled === false && (await ph.locator('[data-testid="totp-notice"]').count()) === 0);
	await ph.setViewportSize({ width: 390, height: 844 });
	await ph.goto(`${base}/settings?tab=security`);
	await ph.waitForSelector('[data-testid="two-factor"]');
	check("H 390: the 安全 tab has no horizontal scroll", !(await overflowX(ph)));
	await ph.click('[data-testid="totp-enable-open"]');
	await ph.waitForSelector('[data-testid="totp-secret"]');
	check("H 390: the enrol flow fits the phone too", !(await overflowX(ph)));
	await snap(ph, "settings-security-390");
	await ctxH.close();

	await ctxA.close();
	ok = true;
} catch (e) {
	check("round9-onboarding completed without an exception", false, String(e?.stack ?? e).slice(0, 800));
} finally {
	await browser.close();
	await server.stop();
}
const pass = summary(join(ROOT, "artifacts/round9-onboarding-results.json"));
process.exit(pass && ok ? 0 : 1);
