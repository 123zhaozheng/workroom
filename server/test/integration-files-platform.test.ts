// Windows/macOS patches of the files group + ops backup: path regex, CJK PDF font selection (.ttc via fontkit), renderer
// availability, manifest path separators. Pure unit tests with injected platform/fs (no Windows or macOS needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { spaceIdFromPath } from "../src/files/actor.ts";
import { pdfFontCandidates, pickPdfFont, ttcToTtf } from "../src/files/generate.ts";
import { slideRendererAvailable } from "../src/files/slides.ts";
import { hasPathSegment, toPosix } from "../src/ops/backup.ts";

test("spaceIdFromPath: POSIX and Windows storage paths", () => {
	assert.equal(spaceIdFromPath("/data/orgs/org_1/spaces/spc_ab-12_x/sandbox/conv"), "spc_ab-12_x");
	assert.equal(spaceIdFromPath("/data/orgs/org_1/spaces/spc_ab"), "spc_ab");
	assert.equal(spaceIdFromPath("C:\\workroom\\data\\orgs\\org_1\\spaces\\spc_win9\\sandbox\\7"), "spc_win9");
	assert.equal(spaceIdFromPath("C:\\workroom\\data\\orgs\\org_1\\spaces\\spc_win9"), "spc_win9");
	assert.equal(spaceIdFromPath("C:/workroom/data/orgs/org_1/spaces/spc_mixed\\x"), "spc_mixed");
	assert.equal(spaceIdFromPath("\\\\server\\share\\orgs\\o\\spaces\\spc_unc\\"), "spc_unc");
	assert.equal(spaceIdFromPath("/data/orgs/org_1/myspaces/spc_no/x"), undefined, "the segment must be exactly `spaces`");
	assert.equal(spaceIdFromPath("/data/orgs/org_1/spaces//x"), undefined);
	assert.equal(spaceIdFromPath(undefined), undefined);
	assert.equal(spaceIdFromPath(""), undefined);
});

test("pdfFontCandidates: platform specific CJK fonts, override first", () => {
	const win = pdfFontCandidates("win32", { WINDIR: "D:\\Win" });
	assert.deepEqual(win.slice(0, 3), ["D:\\Win\\Fonts\\msyh.ttc", "D:\\Win\\Fonts\\simhei.ttf", "D:\\Win\\Fonts\\simsun.ttc"]);
	assert.ok(win.every((p) => p.startsWith("D:\\Win\\Fonts\\")), "no Linux paths on Windows");
	assert.equal(pdfFontCandidates("win32", {})[0], "C:\\Windows\\Fonts\\msyh.ttc");
	const mac = pdfFontCandidates("darwin", {});
	assert.equal(mac[0], "/System/Library/Fonts/PingFang.ttc");
	assert.ok(mac.includes("/Library/Fonts/Arial Unicode.ttf"));
	const linux = pdfFontCandidates("linux", { WORKROOM_PDF_FONT: "/my/font.ttf" });
	assert.equal(linux[0], "/my/font.ttf");
	assert.ok(linux.includes("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"));
	assert.equal(linux.at(-1), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "the Latin-only fallback comes last");
});

test("pickPdfFont: first existing, loadable candidate wins; unreadable ones are skipped", () => {
	const fake = Buffer.from("not-a-collection-just-bytes");
	const have = new Set(["C:\\Windows\\Fonts\\simhei.ttf", "C:\\Windows\\Fonts\\simsun.ttc"]);
	const seen: string[] = [];
	const read = (p: string) => (seen.push(p), fake);
	const picked = pickPdfFont(pdfFontCandidates("win32", {}), (p) => have.has(p), read);
	assert.equal(picked?.path, "C:\\Windows\\Fonts\\simhei.ttf", "msyh is missing, so simhei is next");
	assert.deepEqual(seen, ["C:\\Windows\\Fonts\\simhei.ttf"]);
	// a candidate that throws on read is skipped
	const second = pickPdfFont(["/a.ttf", "/b.ttf"], () => true, (p) => {
		if (p === "/a.ttf") throw new Error("EACCES");
		return fake;
	});
	assert.equal(second?.path, "/b.ttf");
	assert.equal(pickPdfFont(pdfFontCandidates("darwin", {}), () => false), null);
	assert.equal(pickPdfFont(["", "/x.ttf"], (p) => p === ""), null, "empty candidates are ignored");
});

/** Wrap a single TTF into a one-font TrueType Collection (what msyh.ttc / PingFang.ttc look like on the outside). */
function wrapAsTtc(ttf: Buffer): Buffer {
	const shift = 16;
	const out = Buffer.concat([Buffer.alloc(shift), ttf]);
	out.write("ttcf", 0, "ascii");
	out.writeUInt32BE(0x00010000, 4);
	out.writeUInt32BE(1, 8);
	out.writeUInt32BE(shift, 12);
	const numTables = ttf.readUInt16BE(4);
	for (let i = 0; i < numTables; i++) {
		const rec = shift + 12 + 16 * i;
		out.writeUInt32BE(out.readUInt32BE(rec + 8) + shift, rec + 8); // table offsets are file-absolute
	}
	return out;
}

const DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
test("a .ttc is usable: ttcToTtf extracts the font and fontkit/pdf-lib embed it", { skip: existsSync(DEJAVU) ? false : "no DejaVuSans.ttf on this machine" }, async () => {
	const ttf = readFileSync(DEJAVU);
	const ttc = wrapAsTtc(ttf);
	assert.equal(ttc.toString("ascii", 0, 4), "ttcf");
	// raw fontkit on a collection does not give a single font (this is why ttcToTtf exists) ...
	const raw: any = fontkit.create(ttc);
	assert.ok(Array.isArray(raw.fonts) || raw.fonts !== undefined, "fontkit returns a TrueTypeCollection for a .ttc");
	// ... after extraction it is a normal font with the same glyphs
	const extracted = ttcToTtf(ttc);
	const f: any = fontkit.create(extracted);
	const orig: any = fontkit.create(ttf);
	assert.equal(f.familyName, orig.familyName);
	assert.equal(f.numGlyphs, orig.numGlyphs);
	assert.equal(f.glyphForCodePoint(0x41).id, orig.glyphForCodePoint(0x41).id);
	// plain TTFs pass through untouched
	assert.equal(ttcToTtf(ttf), ttf);
	// pdf-lib embeds the extracted font and can measure text with it
	const pdf = await PDFDocument.create();
	pdf.registerFontkit(fontkit);
	const embedded = await pdf.embedFont(extracted, { subset: true });
	assert.ok(embedded.widthOfTextAtSize("Workroom", 12) > 20);
	// and picking through the mocked filesystem yields the same bytes as a direct extraction
	const picked = pickPdfFont(["/Library/Fonts/Arial Unicode.ttf"], () => true, () => ttc);
	assert.deepEqual(picked?.bytes, extracted);
});

test("slideRendererAvailable: only Linux with soffice + pdftoppm; Windows/macOS keep the honest outline fallback", () => {
	const ok = { findSoffice: () => "/usr/bin/soffice", findPdftoppm: () => "/usr/bin/pdftoppm" };
	assert.equal(slideRendererAvailable({ platform: "linux", ...ok }).ok, true);
	assert.match(slideRendererAvailable({ platform: "linux", ...ok, findSoffice: () => undefined }).reason, /LibreOffice/);
	assert.match(slideRendererAvailable({ platform: "linux", ...ok, findPdftoppm: () => undefined }).reason, /pdftoppm/);
	for (const platform of ["win32", "darwin"] as const) {
		const r = slideRendererAvailable({ platform, ...ok });
		assert.equal(r.ok, false, `${platform}: LibreOffice found on the host is still not run on untrusted pptx`);
		assert.match(r.reason, /文本大纲/);
	}
});

test("backup manifest paths are portable and the sandbox directory is excluded on either separator", () => {
	assert.equal(toPosix("orgs\\org_1\\spaces\\spc_a\\durable.sqlite", "\\"), "orgs/org_1/spaces/spc_a/durable.sqlite");
	assert.equal(toPosix("orgs/org_1/x", "/"), "orgs/org_1/x");
	assert.equal(hasPathSegment("orgs/org_1/spaces/spc_a/sandbox/7/f.txt", "sandbox"), true);
	assert.equal(hasPathSegment("orgs\\org_1\\spaces\\spc_a\\sandbox\\7\\f.txt", "sandbox"), true);
	assert.equal(hasPathSegment("orgs/org_1/spaces/spc_a/files/sandbox.txt", "sandbox"), false, "only whole path segments");
});

// ---- shared types: one source of truth (compile-time; tsc fails if the old and new shapes drift apart) ----
import type { SandboxFilesResponse as OldFiles, SandboxInfoDTO as FilesInfo, SandboxRunDTO } from "../../shared/files.ts";
import type { SandboxInfoDTO as SandboxInfo, WorkspaceFilesResponse, SandboxDriverId, WorkTabId } from "../../shared/sandbox.ts";
import { workTabForTool, WORKSPACE_FILE_TOOLS } from "../../shared/sandbox.ts";
const _info1 = (a: FilesInfo): SandboxInfo => a;
const _info2 = (a: SandboxInfo): FilesInfo => a;
const _files1 = (a: OldFiles): WorkspaceFilesResponse => a;
const _driver = (r: SandboxRunDTO): SandboxDriverId | undefined => r.driver;
void [_info1, _info2, _files1, _driver];

test("work panel: which tab a tool call opens (文件 for workspace file tools; 在工作区中打开)", () => {
	for (const t of WORKSPACE_FILE_TOOLS) assert.equal(workTabForTool(t), "files", t);
	assert.equal(workTabForTool("sandbox_exec"), "terminal");
	assert.equal(workTabForTool("sandbox_service_start"), "terminal");
	assert.equal(workTabForTool("browse"), "browser");
	assert.equal(workTabForTool("browser_open"), "browser");
	assert.equal(workTabForTool("delegate"), "tasks");
	assert.equal(workTabForTool("file_create"), null);
	const all: WorkTabId[] = ["tasks", "terminal", "files", "browser"];
	assert.ok(all.includes(workTabForTool("sandbox_list")!));
});
