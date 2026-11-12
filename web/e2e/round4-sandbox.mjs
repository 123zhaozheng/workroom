// Round 4 — SANDBOX (round 14: the terminal log and 文件 tab were removed from the work panel; what remains is the server routes):
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
	env: { ...process.env, WORKROOM_ONBOARDING: "off", WORKROOM_DATA_DIR: dataDir, PORT: String(PORT), WORKROOM_FIXTURE_TOOLS: "1", WORKROOM_SANDBOX_DRIVER: process.env.WORKROOM_SANDBOX_DRIVER ?? "auto" },
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
	const proj = (await (await a.request.post(`${base}/api/projects`, { data: { kind: "space", name: "数据分析" } })).json()).project;
	await a.request.put(`${base}/api/projects/${proj.id}/members`, { data: { email: viewer.email, role: "viewer" } });
	await a.goto(`${base}/projects/${proj.id}`);
	await sendMessage(a, `整理数据 ${directive("sandbox_exec", { language: "python", code: pyWrite })} ${directive("sandbox_exec", { language: "python", code: pyFail })}`);
	await a.waitForURL(/\/c\//);
	await a.waitForSelector('[data-testid="assistant-message"]', { timeout: 60000 });
	await idle(a);
	const chatUrl = a.url();
	const [spaceId, convId] = new URL(chatUrl).pathname.split("/").slice(2, 4);

	// Round 14: the work panel no longer has a 终端 or 文件 view (the right panel is 输出 / 子任务 / 浏览器; see round14-ui.mjs). The workspace
	// file API checks below keep running against the server routes, which are unchanged.
	const entry = (p) => a.locator(`[data-testid="ws-entry"][data-path="${p}"]`);
	void entry;
	await a.click('[data-testid="open-work-panel"]');
	await a.waitForSelector('[data-testid="work-panel"]');
	check("work panel: no terminal / files tab any more", (await a.locator('[data-testid^="work-tab-"]').count()) === 0 && (await a.locator('[data-testid="ws-tree"]').count()) === 0);
	await a.click('[data-testid="close-panel"]');

	// ---------------------------------------------------------------- viewer: read-only; non-member: refused
	const v = viewer.p;
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
	const back = await a.request.put(`${base}/api/sandbox/driver`, { data: { driver: "auto" } });
	check("admin: switching back to auto re-enables the sandbox", back.ok() && (await back.json()).effective !== "none");

} catch (e) {
	check(`unexpected error: ${String(e?.message ?? e).split("\n")[0]}`, false);
	console.error(e);
	await shot(page0, "sandbox-failure-debug").catch(() => {});
} finally {
	await browser.close();
	await stop();
}
process.exitCode = summary(join(ROOT, "artifacts/screenshots/round4-sandbox.json")) ? 0 : 1;
