// Preview rendering. Every HTML preview is served with a CSP `sandbox` (no allow-scripts, no allow-same-origin):
// the document gets an opaque origin, cannot run scripts, cannot read app cookies or call the API with them.
import mammoth from "mammoth";
import { decodeText, escapeHtml, markdownToHtml, parseCsv, readPptx, readXlsx, tableHtml } from "./extract.ts";
import { previewKindOf } from "./mime.ts";
import type { PreviewKind } from "../../../shared/files.ts";

export const PREVIEW_CSP = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'";
/** For raw HTML deliverables: same sandbox, also allows remote images/styles the document references (still no scripts). */
export const HTML_DOC_CSP = "sandbox; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; media-src data: https:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'";

export interface PreviewResponse {
	readonly kind: PreviewKind;
	readonly contentType: string;
	readonly body: Uint8Array | string;
	readonly csp: string | null;
}

const STYLE = `body{font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#1f2328;margin:0;padding:24px;max-width:960px}
table{border-collapse:collapse;margin:8px 0 16px;font-size:13px}td,th{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;white-space:pre-wrap}th{background:#f6f8fa}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;padding:12px;border-radius:6px}
img{max-width:100%}h1,h2,h3{line-height:1.3}.note{color:#656d76;font-size:12px}.slide{border:1px solid #d0d7de;border-radius:8px;padding:16px 20px;margin:0 0 16px}
.slide h2{margin:0 0 8px;font-size:18px}.slide .n{color:#656d76;font-size:12px}.sheet-tabs{color:#656d76;font-size:12px}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}td,th{border-color:#30363d}th,pre{background:#161b22}}`;

export function page(title: string, body: string): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

const PASSTHROUGH_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

export async function renderPreview(mime: string, name: string, bytes: Uint8Array): Promise<PreviewResponse> {
	const kind = previewKindOf(mime, name);
	const html = (body: string): PreviewResponse => ({ kind, contentType: "text/html; charset=utf-8", body: page(name, body), csp: PREVIEW_CSP });
	switch (kind) {
		case "image":
			if (PASSTHROUGH_IMAGES.has(mime)) return { kind, contentType: mime, body: bytes, csp: PREVIEW_CSP };
			// SVG and other image types can carry scripts: serve under the sandbox CSP (scripts never run).
			return { kind, contentType: mime === "image/svg+xml" ? "image/svg+xml" : "application/octet-stream", body: bytes, csp: PREVIEW_CSP };
		case "pdf":
			// Browsers render PDFs in their own isolated viewer; a CSP sandbox breaks Chromium's viewer, so none is set.
			return { kind, contentType: "application/pdf", body: bytes, csp: null };
		case "html":
			return { kind, contentType: "text/html; charset=utf-8", body: bytes, csp: HTML_DOC_CSP };
		case "markdown":
			return html(markdownToHtml(decodeText(bytes)));
		case "csv":
			return html(tableHtml(parseCsv(decodeText(bytes))));
		case "text": {
			const t = decodeText(bytes);
			return html(`<pre>${escapeHtml(t.length > 500_000 ? `${t.slice(0, 500_000)}\n…（已截断）` : t)}</pre>`);
		}
		case "docx": {
			const r = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
			return html(r.value || `<p class="note">（空文档）</p>`);
		}
		case "xlsx": {
			const sheets = await readXlsx(bytes);
			const tabs = `<p class="sheet-tabs">工作表：${sheets.map((s) => escapeHtml(s.name)).join(" · ")}</p>`;
			return html(tabs + sheets.map((s) => `<h3>${escapeHtml(s.name)}</h3>${s.rows.length ? tableHtml(s.rows) : '<p class="note">（空）</p>'}`).join("\n"));
		}
		case "pptx": {
			const slides = await readPptx(bytes);
			const body = slides
				.map((s) => {
					const [title, ...rest] = s.paragraphs;
					const notes = s.notes.length ? `<p class="note">备注：${escapeHtml(s.notes.join(" "))}</p>` : "";
					return `<section class="slide"><div class="n">第 ${s.index} 页</div><h2>${escapeHtml(title ?? "")}</h2><ul>${rest.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>${notes}</section>`;
				})
				.join("\n");
			return html(`<p class="note">演示稿大纲预览（文字与备注；版式请下载查看）</p>${body}`);
		}
		default:
			return html(`<p class="note">该格式（${escapeHtml(mime)}）暂不支持在线预览，请下载查看。</p>`);
	}
}
