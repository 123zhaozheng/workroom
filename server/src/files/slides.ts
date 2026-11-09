// PPTX slide rendering for previews: LibreOffice (headless) → PDF → pdftoppm PNGs, executed inside the namespace sandbox
// (untrusted documents never run unconfined, no network). Results are cached per source sha256 as blobs. When the renderer
// or the sandbox is unavailable, callers fall back to the text outline and say why.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../core/contracts.ts";
import type { Migration } from "../core/db.ts";
import { nowIso } from "../core/http.ts";

export const SLIDE_MIGRATIONS: Migration[] = [
	{
		version: 2,
		name: "preview render cache",
		sql: `CREATE TABLE file_preview_cache (sha256 TEXT NOT NULL, kind TEXT NOT NULL, pages TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, PRIMARY KEY (sha256, kind));`,
	},
];

const MAX_SLIDES = 60;
const inflight = new Map<string, Promise<SlideRender>>();

export type SlideRender = { ok: true; pages: string[] } | { ok: false; reason: string };

export function slideRendererAvailable(): { ok: boolean; reason: string } {
	if (!existsSync("/usr/bin/soffice") && !existsSync("/usr/lib/libreoffice/program/soffice")) return { ok: false, reason: "服务器未安装 LibreOffice（soffice）" };
	if (!existsSync("/usr/bin/pdftoppm")) return { ok: false, reason: "服务器未安装 pdftoppm（poppler-utils）" };
	return { ok: true, reason: "LibreOffice + pdftoppm（沙箱内运行）" };
}

/** PNG blobs (sha256 list) for the slides of a pptx, rendered once per content hash. */
export async function renderSlides(ctx: AppContext, sha256: string, bytes: Uint8Array): Promise<SlideRender> {
	const cached = ctx.db.get<{ pages: string; error: string | null }>("SELECT pages, error FROM file_preview_cache WHERE sha256 = ? AND kind = 'pptx-png'", sha256);
	if (cached && !cached.error) return { ok: true, pages: JSON.parse(cached.pages) };
	const avail = slideRendererAvailable();
	if (!avail.ok) return { ok: false, reason: avail.reason };
	if (!ctx.services.has("sandbox")) return { ok: false, reason: "沙箱服务未加载" };
	let p = inflight.get(sha256);
	if (!p) {
		p = (async (): Promise<SlideRender> => {
			const wd = join(ctx.config.dataDir, "preview-render", sha256.slice(0, 32));
			rmSync(wd, { recursive: true, force: true });
			mkdirSync(wd, { recursive: true });
			try {
				writeFileSync(join(wd, "in.pptx"), bytes);
				const sb = ctx.services.get("sandbox") as { execIsolated(wd: string, lang: "shell", code: string, limits: object): Promise<{ status: string; stderr: string }> };
				const r = await sb.execIsolated(wd, "shell", `soffice --headless --norestore --nolockcheck -env:UserInstallation=file:///tmp/lo --convert-to pdf --outdir /work/out /work/in.pptx >/dev/null 2>&1; pdftoppm -png -r 60 -l ${MAX_SLIDES} /work/out/in.pdf /work/out/slide`, { timeoutMs: 120_000, memoryBytes: 2 * 1024 ** 3 });
				const out = join(wd, "out");
				const files = existsSync(out) ? readdirSync(out).filter((f) => /^slide-\d+\.png$/.test(f)).sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1])) : [];
				if (r.status !== "ok" || !files.length) return { ok: false, reason: `渲染失败（${r.status}）${r.stderr.slice(-200)}` };
				const pages = files.map((f) => ctx.blobs.put(new Uint8Array(readFileSync(join(out, f)))).sha256);
				ctx.db.run("INSERT OR REPLACE INTO file_preview_cache (sha256, kind, pages, error, created_at) VALUES (?, 'pptx-png', ?, NULL, ?)", sha256, JSON.stringify(pages), nowIso());
				return { ok: true, pages };
			} catch (e: any) {
				return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
			} finally {
				rmSync(wd, { recursive: true, force: true });
			}
		})().finally(() => inflight.delete(sha256));
		inflight.set(sha256, p);
	}
	return p;
}
