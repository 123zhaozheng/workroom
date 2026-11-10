// Round 4 — SANDBOX: the work panel's terminal log and 文件 tab (workspace tree, preview, download, upload, folder, delete, publish),
// viewer read-only, non-member refusal, and the honest "沙箱不可用 + how to enable" state. Real server, real sandbox runs through the
// fixture model's [[call …]] directives (no model credentials involved).
// Run: npm run build:web && node web/e2e/round4-sandbox.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, chromium, register, ROOT, sendMessage, shot, sleep, summary } from "./lib.mjs";

const PORT = 8862;
const dataDir = join(ROOT, "data/dev-sandbox", `e2e-${PORT}`);
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
	cwd: ROOT,
	env: { ...process.env, WORKROOM_DATA_DIR: dataDir, PORT: String(PORT), WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_SANDBOX_DRIVER: process.env.WORKROOM_SANDBOX_DRIVER ?? "auto" },
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
	try {
		if ((await fetch(`${base}/api/health`)).ok) break;
	} catch {
		/* not yet */
	}
	if (child.exitCode !== null) throw new Error(`server exited:\n${log}`);
	await sleep(150);
}
const stop = async () => {
	writeFileSync(join(ROOT, "data/dev-sandbox", `server-${PORT}.log`), log);
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
};

const browser = await chromium.launch();
let page0;
const idle = (page, t = 60000) => page.waitForSelector('[data-testid="stop"]', { state: "detached", timeout: t });
const newUser = async (admin, name, role = "member") => {
	const code = (await (await admin.request.post(`${base}/api/admin/invites`, { data: { role, ttlHours: 24 } })).json()).invite.code;
	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
	const p = await c.newPage();
	const email = `${name}-${Date.now()}@example.com`.replace(/[^\x00-\x7f]/g, "u");
	await p.goto(`${base}/register?invite=${code}`);
	await p.fill("#name", name);
	await p.fill("#email", email);
	await p.fill("#password", "password123");
	await p.click('button[type="submit"]');
	await p.waitForSelector('[data-testid="home-greeting"]');
	return { c, p, email };
};
const directive = (tool, args) => `[[call ${tool} ${JSON.stringify(args)}]]`;
const pyWrite = [
	"import struct, zlib, os",
	"os.makedirs('out', exist_ok=True)",
	"open('out/report.csv','w').write('月份,收入\\n1月,120\\n2月,150\\n')",
	"open('notes.md','w').write('# 分析笔记\\n- 收入同比增长 25%\\n')",
	"def png(w,h):",
	"    raw=b''.join(b'\\x00'+bytes([40,120,220])*w for _ in range(h))",
	"    def chunk(t,d):",
	"        c=struct.pack('>I',len(d))+t+d",
	"        return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)",
	"    return b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')",
	"open('out/chart.png','wb').write(png(120,60))",
	"open('blob.bin','wb').write(bytes(range(256)))",
	"print('已写入 4 个文件')",
	"print(sorted(os.listdir('.')))",
].join("\n");
const pyFail = "import sys\nprint('处理到一半')\nsys.stderr.write('Traceback: boom\\n')\nsys.exit(3)";

try {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const a = await ctx.newPage();
	page0 = a;
	await register(a, base, { email: `sb-${Date.now()}@example.com`, name: "沙箱用户" });
	const viewer = await newUser(a, "只读成员");
	const outsider = await newUser(a, "外部成员");

	// A project conversation (so a viewer can look at it): the agent writes files and runs a failing script.
	const proj = (await (await a.request.post(`${base}/api/projects`, { data: { name: "数据分析" } })).json()).project;
	await a.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: viewer.email, role: "viewer" } });
	await a.goto(`${base}/projects/${proj.id}`);
	await sendMessage(a, `整理数据 ${directive("sandbox_exec", { language: "python", code: pyWrite })} ${directive("sandbox_exec", { language: "python", code: pyFail })}`);
	await a.waitForURL(/\/c\//);
	await a.waitForSelector('[data-testid="assistant-message"]', { timeout: 60000 });
	await idle(a);
	const chatUrl = a.url();
	const [spaceId, convId] = new URL(chatUrl).pathname.split("/").slice(2, 4);

	// ---------------------------------------------------------------- terminal: commands, stdout/stderr, exit codes
	await a.click('[data-testid="open-work-panel"]');
	await a.click('[data-testid="work-tab-terminal"]');
	await a.waitForSelector('[data-testid="sandbox-run"]', { timeout: 20000 });
	await a.waitForFunction(() => document.querySelectorAll('[data-testid="sandbox-run"]').length >= 2, null, { timeout: 20000 });
	const runs = a.locator('[data-testid="sandbox-run"]');
	const first = await runs.nth(0).innerText();
	const second = await runs.nth(1).innerText();
	check("terminal: runs are listed oldest first with the command, stdout and an exit line", first.includes("python3 main.py") && first.includes("已写入 4 个文件") && /退出码 0/.test(first), first.replace(/\s+/g, " ").slice(0, 160));
	check("terminal: a failing run shows stdout, stderr and a non-zero exit code", second.includes("处理到一半") && second.includes("Traceback: boom") && /退出码 3/.test(second) && (await runs.nth(1).getAttribute("data-status")) === "error", second.replace(/\s+/g, " ").slice(0, 160));
	const termStyle = await a.locator('[data-testid="terminal-log"]').evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, maxH: getComputedStyle(el).maxHeight }));
	const monoOk = await a.locator('[data-testid="run-stdout"]').first().evaluate((el) => /mono|courier|consolas/i.test(getComputedStyle(el).fontFamily));
	check("terminal: the log scrolls (bounded height, overflow auto) and is monospace", termStyle.overflowY === "auto" && termStyle.maxH !== "none" && monoOk, JSON.stringify(termStyle));
	await a.click('[data-testid="sandbox-limits"]');
	const driverLine = await a.locator('[data-testid="sandbox-driver"]').innerText();
	check("terminal: the run limits are shown in plain words (time, memory, network, workspace only) without driver names", driverLine.includes("网络关闭") && driverLine.includes("只能写入工作区") && !/命名空间|namespace|Docker|driver/i.test(driverLine), driverLine.replace(/\s+/g, " ").slice(0, 160));
	await a.keyboard.press("Escape");
	await sleep(300);
	await shot(a, "1440-sandbox-terminal");

	// ---------------------------------------------------------------- 文件 tab: tree, preview, download
	await a.click('[data-testid="work-tab-files"]');
	await a.waitForSelector('[data-testid="ws-tree"]', { timeout: 20000 });
	const entry = (p) => a.locator(`[data-testid="ws-entry"][data-path="${p}"]`);
	await entry("notes.md").waitFor({ timeout: 10000 });
	const top = await a.locator('[data-testid="ws-entry"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
	check("files: the workspace tree shows what the agent wrote (folders first, children hidden until expanded)", top.includes("out") && top.includes("notes.md") && top.includes("blob.bin") && !top.includes("out/report.csv"), top.join(","));
	await entry("out").click();
	await entry("out/report.csv").waitFor({ timeout: 5000 });
	check("files: expanding a folder reveals its files", (await entry("out/chart.png").count()) === 1);
	const usage = await a.locator('[data-testid="ws-usage"]').innerText();
	await a.click('[data-testid="ws-rules"]');
	const rule = await a.locator('[data-testid="ws-lifecycle"]').innerText();
	await a.keyboard.press("Escape");
	check("files: one usage line shows file count and used/quota; the retention rule is behind the ? button", /\d+ 个文件 · 已用/.test(usage) && usage.split("\n").length <= 2 && rule.includes("72 小时") && rule.includes("发布到文件库"), `${usage.replace(/\s+/g, " ")} | ${rule}`);
	await entry("notes.md").click();
	await a.waitForSelector('[data-testid="ws-preview-text"]');
	const pv = await a.locator('[data-testid="ws-preview-text"]').innerText();
	check("files: text preview", pv.includes("分析笔记") && pv.includes("同比增长 25%"));
	const meta = await a.locator('[data-testid="ws-preview"]').innerText();
	check("files: preview shows size, modified time and when the file is cleaned up", meta.includes("自动清理") && meta.includes("修改于"), meta.replace(/\s+/g, " ").slice(0, 120));
	await shot(a, "1440-sandbox-files-text-preview");
	await entry("out/chart.png").click();
	await a.waitForSelector('[data-testid="ws-preview-image"]');
	await a.waitForFunction(() => { const i = document.querySelector('[data-testid="ws-preview-image"]'); return i && i.complete && i.naturalWidth === 120; }, null, { timeout: 10000 });
	check("files: image preview renders inline (120×60 PNG written by the sandbox)", true);
	await shot(a, "1440-sandbox-files-image-preview");
	await entry("blob.bin").click();
	await a.waitForSelector('[data-testid="ws-preview-binary"]');
	check("files: a binary file says it cannot be previewed and offers download", (await a.locator('[data-testid="ws-preview-binary"]').innerText()).includes("无法在这里预览"));
	await entry("out/report.csv").click();
	await a.waitForSelector('[data-testid="ws-preview-text"]');
	await a.click('[data-testid="ws-menu"][data-path="out/report.csv"]');
	const href = await a.locator('[data-testid="ws-download"]').getAttribute("href");
	await a.keyboard.press("Escape");
	const dl = await a.request.get(`${base}${href}`);
	check("files: download returns the exact bytes as an attachment", dl.status() === 200 && (await dl.text()) === "月份,收入\n1月,120\n2月,150\n" && /attachment/.test(dl.headers()["content-disposition"] ?? ""), `${dl.status()} ${dl.headers()["content-disposition"]}`);

	// ---------------------------------------------------------------- upload, new folder, delete, publish
		await entry("out").click(); // select the folder → upload goes into it (collapse state irrelevant)
	await a.setInputFiles('[data-testid="ws-upload-input"]', { name: '上传的数据.csv', mimeType: 'text/csv', buffer: Buffer.from('id,name\n1,甲\n2,乙\n') });
		await a.waitForSelector('[data-testid="ws-note"]:has-text("已上传 1 个文件")', { timeout: 5000 });
	await entry("out/上传的数据.csv").waitFor({ timeout: 10000 });
	const upl = await a.request.get(`${base}/api/sandbox/${spaceId}/file?path=${encodeURIComponent("out/上传的数据.csv")}&conversationId=${convId}`);
	check("files: upload (user) lands in the selected folder with the exact content", (await upl.text()) === "id,name\n1,甲\n2,乙\n");
	await a.click('[data-testid="ws-mkdir"]');
	await a.fill('[data-testid="ws-mkdir-name"]', "图表");
	await a.click('[data-testid="ws-mkdir-ok"]');
	await entry("out/图表").waitFor({ timeout: 10000 });
	check("files: new folder is created in the selected folder", true);
	await a.click('[data-testid="ws-menu"][data-path="out/上传的数据.csv"]');
	await a.click('[data-testid="ws-publish"]');
	await a.waitForSelector('[data-testid="ws-published"]', { timeout: 15000 });
	const pub = await a.locator('[data-testid="ws-published"]').innerText();
	const lib = await (await a.request.get(`${base}/api/files?projectId=${proj.id}`)).json();
	check("files: publish to the library creates a file version (shown as a file card) that outlives the workspace", pub.includes("上传的数据.csv") && lib.files.some((f) => f.name === "上传的数据.csv"), pub.replace(/\s+/g, " ").slice(0, 100));
	await shot(a, "1440-sandbox-files-published");
	await a.click('[data-testid="ws-menu"][data-path="out/上传的数据.csv"]');
	await a.click('[data-testid="ws-delete"]');
	await a.waitForSelector('[data-testid="ws-delete-confirm"]');
	check("files: delete asks for confirmation first (nothing is deleted yet)", (await a.locator('[data-testid="ws-delete-confirm"]').count()) === 1 && (await entry("out/上传的数据.csv").count()) === 1);
	await a.click('[data-testid="ws-delete-confirm"]');
	await a.waitForFunction((p) => !document.querySelector(`[data-testid="ws-entry"][data-path="${p}"]`), "out/上传的数据.csv", { timeout: 10000 });
	const gone = await a.request.get(`${base}/api/sandbox/${spaceId}/file?path=${encodeURIComponent("out/上传的数据.csv")}&conversationId=${convId}`);
	check("files: delete removes the file from the workspace (the published library copy stays)", gone.status() === 404 && (await (await a.request.get(`${base}/api/files?projectId=${proj.id}`)).json()).files.some((f) => f.name === "上传的数据.csv"));
	const trav = await a.request.put(`${base}/api/sandbox/${spaceId}/file?path=${encodeURIComponent("../../escape.txt")}&conversationId=${convId}`, { data: "x" });
	const trav2 = await a.request.get(`${base}/api/sandbox/${spaceId}/file?path=${encodeURIComponent("..\\..\\app.sqlite")}&conversationId=${convId}`);
	check("files: path traversal (../ and ..\\) is refused by the server", trav.status() === 400 && trav2.status() === 400, `${trav.status()} ${trav2.status()}`);

	// ---------------------------------------------------------------- viewer: read-only; non-member: refused
	const v = viewer.p;
	await v.goto(chatUrl);
	await v.click('[data-testid="open-work-panel"]');
	await v.click('[data-testid="work-tab-files"]');
	await v.waitForSelector('[data-testid="ws-tree"]', { timeout: 20000 });
	await v.locator('[data-testid="ws-entry"][data-path="notes.md"]').click();
	await v.waitForSelector('[data-testid="ws-preview-text"]');
	await v.click('[data-testid="ws-menu"][data-path="notes.md"]');
	const disabled = await v.evaluate(() => ["ws-upload", "ws-mkdir"].every((id) => document.querySelector(`[data-testid="${id}"]`)?.disabled === true));
	check("viewer: sees the same tree and previews, upload/new-folder are disabled and the panel says 只读", disabled && (await v.locator('[data-testid="ws-readonly"]').count()) === 1);
	check("viewer: delete and publish are disabled, download stays available", (await v.locator('[data-testid="ws-delete"]').getAttribute("data-disabled")) !== null && (await v.locator('[data-testid="ws-publish"]').getAttribute("data-disabled")) !== null && (await v.locator('[data-testid="ws-download"]').count()) === 1);
	await v.keyboard.press("Escape");
	await shot(v, "1440-sandbox-files-viewer-readonly");
	const q = `path=notes.md&conversationId=${convId}`;
	const vput = await v.request.put(`${base}/api/sandbox/${spaceId}/file?path=hack.txt&conversationId=${convId}`, { data: "x" });
	const vdel = await v.request.delete(`${base}/api/sandbox/${spaceId}/file?${q}`);
	const vget = await v.request.get(`${base}/api/sandbox/${spaceId}/file?${q}`);
	check("viewer: the server enforces it — write 403, delete 403, read 200", vput.status() === 403 && vdel.status() === 403 && vget.status() === 200, `${vput.status()} ${vdel.status()} ${vget.status()}`);
	const o = await outsider.p.request.get(`${base}/api/sandbox/${spaceId}/files?conversationId=${convId}`);
	const op = await outsider.p.request.put(`${base}/api/sandbox/${spaceId}/file?path=x.txt&conversationId=${convId}`, { data: "x" });
	check("non-member: 403 for listing and writing", o.status() === 403 && op.status() === 403, `${o.status()} ${op.status()}`);

	// ---------------------------------------------------------------- sandbox unavailable: honest state with how to enable; files still browsable
	const off = await a.request.put(`${base}/api/sandbox/driver`, { data: { driver: "none" } });
	check("admin: the driver setting can be changed (PUT /api/sandbox/driver)", off.ok() && (await off.json()).effective === "none");
	await a.click('[data-testid="work-tab-terminal"]');
	await a.waitForSelector('[data-testid="sandbox-unavailable"]', { timeout: 15000 });
	const un = await a.locator('[data-testid="sandbox-unavailable"]').innerText();
	const unAdmin = await a.locator('[data-testid="sandbox-admin-hint"]').textContent();
	check("unavailable: one plain sentence (no driver jargon) plus an administrator hint; how-to-enable (Docker Desktop / namespaces) only inside 技术详情", un.includes("代码运行暂时不可用") && !/Docker|命名空间|namespace|driver/i.test(un.replace("技术详情", "")) && un.includes("技术详情") && /启用方法/.test(unAdmin) && /Docker/.test(unAdmin), un.replace(/\s+/g, " ").slice(0, 200));
	await shot(a, "1440-sandbox-unavailable");
	await a.click('[data-testid="work-tab-files"]');
	await a.waitForSelector('[data-testid="ws-entry"][data-path="notes.md"]', { timeout: 15000 });
	check("unavailable: the workspace files stay browsable and downloadable", true);
	const back = await a.request.put(`${base}/api/sandbox/driver`, { data: { driver: "auto" } });
	check("admin: switching back to auto re-enables the sandbox", back.ok() && (await back.json()).effective !== "none");

	// ---------------------------------------------------------------- narrow screen (drawer)
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "zh-CN" });
	const pp = await phone.newPage();
	await pp.goto(`${base}/login`);
	await pp.fill("#email", viewer.email);
	await pp.fill("#password", "password123");
	await pp.click('button[type="submit"]');
	await pp.waitForSelector('[data-testid="home-greeting"]');
	await pp.goto(chatUrl);
	await pp.click('[data-testid="open-work-panel"]');
	await pp.click('[data-testid="work-tab-files"]');
	await pp.waitForSelector('[data-testid="ws-tree"]', { timeout: 20000 });
	const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	check("narrow screen: the files tab fits without horizontal page scroll", !overflow);
	await shot(pp, "390-sandbox-files");
	await phone.close();
} catch (e) {
	check(`unexpected error: ${String(e?.message ?? e).split("\n")[0]}`, false);
	console.error(e);
	await shot(page0, "sandbox-failure-debug").catch(() => {});
} finally {
	await browser.close();
	await stop();
}
process.exitCode = summary(join(ROOT, "artifacts/screenshots/round4-sandbox.json")) ? 0 : 1;
