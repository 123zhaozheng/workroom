// Skill package pipeline (pure functions, no DB): zip/folder → normalized file set → SKILL.md manifest → static scan →
// canonical zip. A package is an Agent Skills directory (https://agentskills.io/specification): SKILL.md with YAML frontmatter
// plus scripts/, references/, assets/. Structural violations (zip-slip, bombs, oversize, symlinks, missing/invalid manifest)
// throw PackageError and nothing is stored. Findings of the static scan are returned for the reviewer; `error` findings
// (credentials, native binaries) are rejected at upload as well, `warn` findings are shown on the review screen.
import { createHash } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import type { PackageCheckDTO, PackageFindingDTO, SkillKind, SkillManifestDTO, SkillPermission } from "../../../shared/files.ts";

export const LIMITS = {
	/** Uploaded zip (compressed) or sum of uploaded folder files. */
	uploadBytes: 12 * 1024 * 1024,
	/** Sum of all uncompressed files. */
	totalBytes: 25 * 1024 * 1024,
	fileBytes: 5 * 1024 * 1024,
	files: 300,
	pathLength: 200,
	pathDepth: 8,
	segmentLength: 100,
	skillMdChars: 100_000,
	descriptionChars: 1024,
	compatibilityChars: 500,
	/** Per-file expansion ratio above which a file larger than 1 MB is treated as a zip bomb. */
	bombRatio: 200,
} as const;

export class PackageError extends Error {
	readonly code: string;
	readonly findings?: PackageFindingDTO[];
	constructor(code: string, message: string, findings?: PackageFindingDTO[]) {
		super(message);
		this.code = code;
		this.findings = findings;
	}
}

export interface PackageFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
export { sha256 as sha256Hex };

// ---------------------------------------------------------------- paths
const JUNK = [/^__MACOSX(\/|$)/, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /^\.git(\/|$)/, /(^|\/)\.git(\/|$)/];

/** Normalise one archive path. Throws on anything that could escape the skill directory. */
export function safePath(raw: string): string {
	const s = String(raw ?? "");
	if (!s || s.includes("\0") || /[\u0001-\u001f\u007f]/.test(s)) throw new PackageError("path_unsafe", `路径含控制字符：${JSON.stringify(s)}`);
	const p = s.replace(/\\/g, "/");
	if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new PackageError("path_unsafe", `不允许绝对路径：${s}`);
	const segs: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new PackageError("path_unsafe", `路径含 “..”（zip-slip）：${s}`);
		if (seg.length > LIMITS.segmentLength) throw new PackageError("path_unsafe", `路径片段过长：${s}`);
		if (/[. ]$/.test(seg) && seg !== ".gitkeep") throw new PackageError("path_unsafe", `路径片段以点或空格结尾：${s}`);
		segs.push(seg.normalize("NFC"));
	}
	if (!segs.length) throw new PackageError("path_unsafe", `空路径：${s}`);
	if (segs.length > LIMITS.pathDepth) throw new PackageError("path_unsafe", `目录层级超过 ${LIMITS.pathDepth}：${s}`);
	const out = segs.join("/");
	if (out.length > LIMITS.pathLength) throw new PackageError("path_unsafe", `路径超过 ${LIMITS.pathLength} 字符：${s}`);
	return out;
}

// ---------------------------------------------------------------- zip reading (central directory first, inflate later)
interface ZipEntry {
	name: string;
	method: number;
	csize: number;
	usize: number;
	isDir: boolean;
}

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		if (utf8Flag) throw new PackageError("zip_invalid", "zip 文件名不是合法 UTF-8");
		try {
			return new TextDecoder("gbk").decode(raw); // zips made on Windows (zh-CN) without the UTF-8 flag
		} catch {
			return new TextDecoder("latin1").decode(raw);
		}
	}
}

/** Parse the central directory and validate every entry before anything is inflated. */
function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
		if (dv.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new PackageError("zip_invalid", "不是有效的 zip 文件（找不到目录结尾）");
	const total = dv.getUint16(eocd + 10, true);
	const cdSize = dv.getUint32(eocd + 12, true);
	const cdOff = dv.getUint32(eocd + 16, true);
	if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new PackageError("zip_invalid", "不支持 zip64 包");
	if (total > LIMITS.files * 2) throw new PackageError("too_many_files", `压缩包条目过多（${total}，上限 ${LIMITS.files}）`);
	if (cdOff + cdSize > buf.length) throw new PackageError("zip_invalid", "zip 目录越界");
	const entries: ZipEntry[] = [];
	let p = cdOff;
	let sumU = 0;
	for (let n = 0; n < total; n++) {
		if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new PackageError("zip_invalid", "zip 目录损坏");
		const madeBy = dv.getUint16(p + 4, true);
		const flags = dv.getUint16(p + 8, true);
		const method = dv.getUint16(p + 10, true);
		const csize = dv.getUint32(p + 20, true);
		const usize = dv.getUint32(p + 24, true);
		const nameLen = dv.getUint16(p + 28, true);
		const extraLen = dv.getUint16(p + 30, true);
		const commentLen = dv.getUint16(p + 32, true);
		const ext = dv.getUint32(p + 38, true);
		const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
		p += 46 + nameLen + extraLen + commentLen;
		if (flags & 1) throw new PackageError("zip_encrypted", `不支持加密的 zip 条目：${name}`);
		const isDir = name.endsWith("/");
		if (!isDir && method !== 0 && method !== 8) throw new PackageError("zip_invalid", `不支持的压缩方法 ${method}：${name}`);
		// Unix mode lives in the high 16 bits of the external attributes when "made by" is Unix (3).
		if (madeBy >> 8 === 3) {
			const mode = (ext >>> 16) & 0xf000;
			if (mode === 0xa000) throw new PackageError("zip_symlink", `不允许符号链接：${name}`);
			if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) throw new PackageError("zip_special_file", `不允许设备/管道等特殊文件：${name}`);
		}
		if (usize > LIMITS.fileBytes) throw new PackageError("file_too_large", `文件过大（${usize} 字节，单文件上限 ${LIMITS.fileBytes}）：${name}`);
		if (usize > 1024 * 1024 && csize > 0 && usize / csize > LIMITS.bombRatio) throw new PackageError("zip_bomb", `压缩比异常（疑似 zip 炸弹）：${name}`);
		sumU += usize;
		if (sumU > LIMITS.totalBytes) throw new PackageError("package_too_large", `解压后总大小超过 ${Math.round(LIMITS.totalBytes / 1048576)} MB`);
		entries.push({ name, method, csize, usize, isDir });
	}
	return entries;
}

/** Zip bytes → raw (not yet normalised) file list. */
export function unzipPackage(buf: Uint8Array): { path: string; bytes: Uint8Array }[] {
	if (buf.byteLength > LIMITS.uploadBytes) throw new PackageError("upload_too_large", `压缩包超过 ${Math.round(LIMITS.uploadBytes / 1048576)} MB`);
	const entries = readCentralDirectory(buf);
	const wanted = new Map<string, ZipEntry>();
	for (const e of entries) if (!e.isDir) wanted.set(e.name, e);
	if (wanted.size > LIMITS.files + 50) throw new PackageError("too_many_files", `文件过多（上限 ${LIMITS.files}）`);
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(buf, { filter: (f) => wanted.has(f.name) && f.originalSize <= LIMITS.fileBytes });
	} catch (e: any) {
		throw new PackageError("zip_invalid", `zip 解压失败：${String(e?.message ?? e).slice(0, 120)}`);
	}
	const files: { path: string; bytes: Uint8Array }[] = [];
	for (const [name, e] of wanted) {
		const bytes = out[name];
		if (!bytes) throw new PackageError("zip_invalid", `zip 条目无法读取：${name}`);
		if (bytes.byteLength !== e.usize) throw new PackageError("zip_bomb", `条目声明大小与实际不符：${name}`);
		files.push({ path: name, bytes });
	}
	return files;
}

/** Raw file list (from a zip or a folder upload) → validated, normalised, sorted package files. */
export function normalizeFiles(raw: readonly { path: string; bytes: Uint8Array }[]): { files: PackageFile[]; stripped: string[]; prefix: string } {
	const stripped: string[] = [];
	let items: { path: string; bytes: Uint8Array }[] = [];
	let total = 0;
	for (const r of raw) {
		const p = safePath(r.path);
		if (JUNK.some((re) => re.test(p))) {
			stripped.push(p);
			continue;
		}
		items.push({ path: p, bytes: r.bytes });
	}
	// A zip of the folder itself ("my-skill/SKILL.md"): strip the single top-level directory.
	let prefix = "";
	const tops = new Set(items.map((i) => i.path.split("/")[0]!));
	if (items.length && tops.size === 1 && items.every((i) => i.path.includes("/"))) {
		prefix = `${[...tops][0]}/`;
		items = items.map((i) => ({ path: i.path.slice(prefix.length), bytes: i.bytes }));
	}
	const seen = new Map<string, string>();
	for (const i of items) {
		const k = i.path.toLowerCase();
		if (seen.has(k)) throw new PackageError("duplicate_path", `重复的路径（忽略大小写）：${i.path} 与 ${seen.get(k)}`);
		seen.set(k, i.path);
		if (i.bytes.byteLength > LIMITS.fileBytes) throw new PackageError("file_too_large", `文件过大：${i.path}（上限 ${LIMITS.fileBytes} 字节）`);
		total += i.bytes.byteLength;
	}
	if (items.length > LIMITS.files) throw new PackageError("too_many_files", `文件过多（${items.length}，上限 ${LIMITS.files}）`);
	if (total > LIMITS.totalBytes) throw new PackageError("package_too_large", `总大小超过 ${Math.round(LIMITS.totalBytes / 1048576)} MB`);
	items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { files: items, stripped, prefix };
}

/** Deterministic zip: same files → same bytes → same sha256 (the version identity), whatever the uploader's tool. */
export function buildCanonicalZip(files: readonly PackageFile[]): Uint8Array {
	const mtime = new Date(1980, 0, 1, 0, 0, 0); // local fields → DOS 1980-01-01 on every machine
	const data: Record<string, [Uint8Array, { level: 6; mtime: Date }]> = {};
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) data[f.path] = [f.bytes, { level: 6, mtime }];
	return zipSync(data);
}

// ---------------------------------------------------------------- SKILL.md frontmatter (YAML subset)
function unquote(v: string): string {
	const t = v.trim();
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	return t.replace(/\s+#.*$/, "");
}
function splitInline(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q = "";
	for (const ch of s) {
		if (q) {
			cur += ch;
			if (ch === q) q = "";
		} else if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
		} else if (ch === ",") {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out.map((x) => unquote(x)).filter((x) => x !== "");
}
function scalar(v: string): string | string[] {
	const t = v.trim();
	if (t.startsWith("[") && t.endsWith("]")) return splitInline(t.slice(1, -1));
	return unquote(t);
}

export type FrontValue = string | string[] | Record<string, string>;
export function parseFrontmatter(text: string): { data: Record<string, FrontValue>; body: string } {
	const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!src.startsWith("---\n")) throw new PackageError("manifest_invalid", "SKILL.md 必须以 YAML frontmatter（---）开头");
	const end = src.indexOf("\n---", 3);
	if (end < 0) throw new PackageError("manifest_invalid", "SKILL.md 的 frontmatter 没有结束的 ---");
	const fm = src.slice(4, end).split("\n");
	const afterFence = src.indexOf("\n", end + 1);
	const body = afterFence < 0 ? "" : src.slice(afterFence + 1);
	const data: Record<string, FrontValue> = {};
	for (let i = 0; i < fm.length; ) {
		const line = fm[i]!;
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}
		const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
		if (!m || /^\s/.test(line)) throw new PackageError("manifest_invalid", `frontmatter 第 ${i + 1} 行无法解析：${line.slice(0, 60)}`);
		const key = m[1]!;
		const rest = m[2]!.trim();
		i++;
		if (/^[|>][+-]?$/.test(rest)) {
			const block: string[] = [];
			while (i < fm.length && (fm[i]!.startsWith(" ") || !fm[i]!.trim())) block.push(fm[i++]!.replace(/^ {1,8}/, ""));
			while (block.length && !block[block.length - 1]!.trim()) block.pop();
			data[key] = rest.startsWith("|") ? block.join("\n") : block.join(" ").replace(/\s+/g, " ").trim();
		} else if (rest === "") {
			const block: string[] = [];
			while (i < fm.length && (/^\s/.test(fm[i]!) || !fm[i]!.trim())) block.push(fm[i++]!);
			const nonEmpty = block.filter((b) => b.trim());
			if (!nonEmpty.length) data[key] = "";
			else if (nonEmpty[0]!.trim().startsWith("- ")) data[key] = nonEmpty.map((b) => unquote(b.trim().replace(/^-\s*/, "")));
			else {
				const map: Record<string, string> = {};
				for (const b of nonEmpty) {
					const mm = /^\s+([^\s:][^:]*?)\s*:\s*(.*)$/.exec(b);
					if (!mm) throw new PackageError("manifest_invalid", `frontmatter 中 ${key} 下的缩进行无法解析：${b.trim().slice(0, 60)}`);
					map[mm[1]!] = unquote(mm[2]!);
				}
				data[key] = map;
			}
		} else data[key] = scalar(rest);
	}
	return { data, body };
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export const PERM_RE = /^(sandbox\.exec|network|file\.write|tool:[A-Za-z0-9_-]{1,64})$/;
const ENTRY_RE = /\.(py|sh|mjs|js)$/;

export function isSemver(v: string): boolean {
	return SEMVER_RE.test(v);
}
/** <0 if a<b, 0 equal, >0 if a>b (build metadata ignored; prerelease sorts before release). */
export function compareSemver(a: string, b: string): number {
	const pa = a.split("+")[0]!.split("-");
	const pb = b.split("+")[0]!.split("-");
	const na = pa[0]!.split(".").map(Number);
	const nb = pb[0]!.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (na[i]! !== nb[i]!) return na[i]! - nb[i]!;
	if (!pa[1] && pb[1]) return 1;
	if (pa[1] && !pb[1]) return -1;
	return (pa[1] ?? "") < (pb[1] ?? "") ? -1 : (pa[1] ?? "") > (pb[1] ?? "") ? 1 : 0;
}

const asList = (v: FrontValue | undefined): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[,\s]+/).filter(Boolean) : []);
const asStr = (v: FrontValue | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export interface ParsedSkill {
	manifest: SkillManifestDTO;
	body: string;
	frontmatterKeys: string[];
}

/** Validate SKILL.md against the Agent Skills spec plus our optional fields. Throws PackageError. */
export function parseSkillMd(files: readonly PackageFile[]): ParsedSkill {
	const md = files.find((f) => f.path === "SKILL.md");
	if (!md) {
		const alt = files.find((f) => f.path.toLowerCase() === "skill.md");
		throw new PackageError("manifest_missing", alt ? `必须是大写的 SKILL.md（找到 ${alt.path}）` : "包的根目录缺少 SKILL.md");
	}
	const text = new TextDecoder("utf-8").decode(md.bytes);
	if (text.length > LIMITS.skillMdChars) throw new PackageError("manifest_invalid", `SKILL.md 超过 ${LIMITS.skillMdChars} 字符`);
	const { data, body } = parseFrontmatter(text);
	const meta = typeof data.metadata === "object" && !Array.isArray(data.metadata) ? (data.metadata as Record<string, string>) : {};
	const pick = (k: string): FrontValue | undefined => data[k] ?? meta[k] ?? meta[`workroom.${k}`];
	const name = asStr(data.name);
	if (!name) throw new PackageError("manifest_invalid", "frontmatter 缺少 name");
	if (name.length > 64 || !NAME_RE.test(name)) throw new PackageError("manifest_invalid", `name「${name}」不合法：只能用小写字母、数字、连字符，不得首尾或连续连字符，≤64 字符`);
	const description = asStr(data.description);
	if (!description) throw new PackageError("manifest_invalid", "frontmatter 缺少 description（说明做什么以及何时使用）");
	if (description.length > LIMITS.descriptionChars) throw new PackageError("manifest_invalid", `description 超过 ${LIMITS.descriptionChars} 字符`);
	const compatibility = asStr(data.compatibility);
	if (compatibility && compatibility.length > LIMITS.compatibilityChars) throw new PackageError("manifest_invalid", `compatibility 超过 ${LIMITS.compatibilityChars} 字符`);
	const version = asStr(pick("version")) ?? "0.1.0";
	if (!SEMVER_RE.test(version)) throw new PackageError("manifest_invalid", `version「${version}」不是语义化版本（如 1.2.0）`);
	const requiredPermissions = asList(pick("permissions"));
	for (const p of requiredPermissions) if (!PERM_RE.test(p)) throw new PackageError("manifest_invalid", `未知权限「${p}」（可用：sandbox.exec、network、file.write、tool:<工具名>）`);
	const requiredTools = asList(pick("tools"));
	for (const t of requiredTools) if (!/^[A-Za-z0-9_-]{1,64}$/.test(t)) throw new PackageError("manifest_invalid", `工具名「${t}」不合法`);
	const entry = asStr(pick("entry"));
	if (entry) {
		const e = safePath(entry);
		if (!ENTRY_RE.test(e)) throw new PackageError("manifest_invalid", "entry 必须是 .py、.sh、.mjs 或 .js 脚本");
		if (!files.some((f) => f.path === e)) throw new PackageError("manifest_invalid", `entry「${e}」不在包内`);
	}
	const explicitKind = asStr(pick("kind")) as SkillKind | undefined;
	if (explicitKind && !["prompt", "context", "executable"].includes(explicitKind)) throw new PackageError("manifest_invalid", "kind 必须是 prompt、context 或 executable");
	const kind: SkillKind = entry ? "executable" : explicitKind === "prompt" ? "prompt" : "context";
	if (explicitKind === "executable" && !entry) throw new PackageError("manifest_invalid", "可执行技能必须声明 entry");
	const perms = [...new Set(requiredPermissions)];
	if (kind === "executable" && !perms.includes("sandbox.exec")) perms.unshift("sandbox.exec");
	const manifest: SkillManifestDTO = {
		name,
		title: asStr(pick("title")),
		description,
		version,
		license: asStr(data.license),
		compatibility,
		category: asStr(pick("category")),
		tags: asList(pick("tags")).slice(0, 12).map((t) => t.slice(0, 24)),
		entry: entry ? safePath(entry) : undefined,
		kind,
		requiredTools: [...new Set(requiredTools)],
		requiredPermissions: perms as SkillPermission[],
		allowedTools: asStr(data["allowed-tools"]),
		metadata: Object.fromEntries(Object.entries(meta).slice(0, 20)),
	};
	return { manifest, body, frontmatterKeys: Object.keys(data) };
}

// ---------------------------------------------------------------- static scan
const TEXT_EXT = /\.(md|txt|py|sh|bash|mjs|js|cjs|ts|json|ya?ml|toml|cfg|ini|csv|html|css|sql|rb|go|rs|lua|r|ps1|bat)$/i;
const BLOCKED_EXT = /\.(exe|dll|so|dylib|msi|apk|jar|class|pyc|pyo|o|a|node|scr|com|bin)$/i;
const SCRIPT_EXT = /\.(py|sh|bash|mjs|js|cjs|ts|rb|ps1|bat)$/i;

function isBinaryExecutable(b: Uint8Array): string | null {
	if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "ELF";
	if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return "PE/EXE";
	if (b.length >= 4 && ((b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe))) return "Mach-O/Java class";
	return null;
}

const SECRET_RULES: { re: RegExp; what: string }[] = [
	{ re: /AKIA[0-9A-Z]{16}/, what: "AWS access key" },
	{ re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, what: "私钥" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: "GitHub token" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: "Slack token" },
	{ re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, what: "API key（sk-…）" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "Google API key" },
];
const NET_RE = /\b(requests\.(get|post|put|delete|request|Session)|urllib\.request|urlopen|http\.client|httpx|aiohttp|socket\.socket|curl\s|wget\s|fetch\(|XMLHttpRequest|axios|node:https?|require\(['"]https?['"]\)|nc\s+-|ssh\s)/;
const EXEC_RE = /\b(os\.system|os\.popen|subprocess\.|child_process|execSync|spawnSync|eval\(|exec\(|Function\(|pty\.spawn|ctypes\.)/;
const PATH_RE = /(\/etc\/(passwd|shadow|sudoers)|~\/\.ssh|\/\.ssh\/|\/proc\/\d*\/?(environ|mem|self)|\/var\/run\/docker\.sock|\.aws\/credentials|\/root\/|\.npmrc|\.netrc)/;
const OBFUSCATION_RE = /(eval\(\s*(atob|base64)|exec\(\s*(base64|codecs\.decode|zlib\.decompress)|fromCharCode\([^)]{80,}\)|\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){30,}|[A-Za-z0-9+/=]{1500,})/;
const INJECTION_RE = /(ignore (all )?(the )?(previous|prior|above) (instructions|prompts)|disregard (the )?(system|previous) (prompt|instructions)|do not (tell|inform|reveal to) the user|不要(告诉|让)用户|忽略(之前|以上|上面)(所有)?(的)?(指令|提示)|无视(系统|之前)(提示|指令)|exfiltrate|send (the )?(conversation|chat history|files?) to)/i;
const HIDDEN_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

function lineOf(text: string, idx: number): number {
	let n = 1;
	for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** Generic part of the static scan (any set of files): credentials, native binaries, hidden characters, risky calls. */
export function scanFiles(files: readonly PackageFile[]): { findings: PackageFindingDTO[]; usesNetwork: boolean } {
	const out: PackageFindingDTO[] = [];
	const add = (severity: PackageFindingDTO["severity"], code: string, message: string, path?: string, line?: number) => out.push({ severity, code, message, path, line });
	let usesNetwork = false;
	for (const f of files) {
		if (BLOCKED_EXT.test(f.path)) add("error", "native_binary", `不允许的可执行/编译产物：${f.path}`, f.path);
		else {
			const bin = isBinaryExecutable(f.bytes);
			if (bin) add("error", "native_binary", `${f.path} 是原生可执行文件（${bin}），包不接受二进制可执行文件`, f.path);
		}
		if (!TEXT_EXT.test(f.path)) continue;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
		} catch {
			continue;
		}
		for (const r of SECRET_RULES) {
			const mm = r.re.exec(text);
			if (mm) add("error", "secret_in_package", `${f.path} 含疑似${r.what}（已拒绝；请改为运行时通过授权获取）`, f.path, lineOf(text, mm.index));
		}
		if (HIDDEN_RE.test(text)) add("warn", "hidden_chars", `${f.path} 含不可见/双向控制字符，可能用于隐藏指令`, f.path, lineOf(text, text.search(HIDDEN_RE)));
		if (/\.md$/i.test(f.path)) {
			const mm = INJECTION_RE.exec(text);
			if (mm) add("warn", "prompt_injection", `${f.path} 含疑似提示词注入措辞：“${mm[0].slice(0, 40)}”`, f.path, lineOf(text, mm.index));
		}
		if (SCRIPT_EXT.test(f.path)) {
			let mm = NET_RE.exec(text);
			if (mm) {
				usesNetwork = true;
				add("warn", "network_use", `${f.path} 看起来会联网（${mm[0].trim().slice(0, 30)}）；能否联网取决于所用的执行环境`, f.path, lineOf(text, mm.index));
			}
			mm = EXEC_RE.exec(text);
			if (mm) add("warn", "exec_call", `${f.path} 调用了进程/动态执行（${mm[0].slice(0, 30)}）`, f.path, lineOf(text, mm.index));
			mm = PATH_RE.exec(text);
			if (mm) add("warn", "sensitive_path", `${f.path} 访问敏感路径（${mm[0].slice(0, 40)}）`, f.path, lineOf(text, mm.index));
			mm = OBFUSCATION_RE.exec(text);
			if (mm) add("warn", "obfuscated", `${f.path} 含疑似混淆/内嵌载荷，需要人工审查`, f.path, lineOf(text, mm.index));
		}
	}
	return { findings: out, usesNetwork };
}

export function scanPackage(files: readonly PackageFile[], parsed: ParsedSkill): PackageFindingDTO[] {
	const { findings: out, usesNetwork } = scanFiles(files);
	const add = (severity: PackageFindingDTO["severity"], code: string, message: string) => out.push({ severity, code, message });
	const m = parsed.manifest;
	const hasScripts = files.some((f) => SCRIPT_EXT.test(f.path));
	if (usesNetwork && !m.requiredPermissions.includes("network")) add("warn", "network_undeclared", "脚本使用网络但 manifest 没有声明 network 权限");
	if (m.requiredPermissions.includes("network")) add("warn", "network_declared", "声明了 network 权限：使用前需要你授权；能否联网取决于所用的执行环境");
	if (hasScripts && !m.entry) add("info", "scripts_without_entry", "包含脚本但没有声明 entry：脚本只能由模型在沙箱中手动运行，无法通过 skill_run 一键运行");
	if (m.description.length < 20) add("warn", "description_short", "description 过短：请同时写明做什么以及何时使用");
	const mdLines = new TextDecoder().decode(files.find((f) => f.path === "SKILL.md")!.bytes).split("\n").length;
	if (mdLines > 500) add("warn", "skill_md_long", `SKILL.md 有 ${mdLines} 行，规范建议少于 500 行（把细节拆到 references/）`);
	const extras = parsed.frontmatterKeys.filter((k) => !["name", "description", "license", "compatibility", "metadata", "allowed-tools", "version", "title", "category", "tags", "entry", "permissions", "tools", "kind"].includes(k));
	if (extras.length) add("info", "frontmatter_extra_keys", `frontmatter 中有未识别字段：${extras.join("、")}（已忽略）`);
	return out;
}

export interface BuiltPackage {
	files: PackageFile[];
	zip: Uint8Array;
	packageSha256: string;
	parsed: ParsedSkill;
	check: PackageCheckDTO;
	stripped: string[];
	topDirMismatch?: string;
}

/** Full pipeline for an upload. `error` findings reject the upload (PackageError carries the findings). */
export function buildPackage(raw: readonly { path: string; bytes: Uint8Array }[], nowIso: string): BuiltPackage {
	const { files, stripped, prefix } = normalizeFiles(raw);
	if (!files.length) throw new PackageError("empty_package", "包里没有文件");
	const parsed = parseSkillMd(files);
	const findings = scanPackage(files, parsed);
	const topDirMismatch = prefix && prefix.slice(0, -1) !== parsed.manifest.name ? prefix.slice(0, -1) : undefined;
	if (topDirMismatch) findings.push({ severity: "info", code: "top_dir_mismatch", message: `压缩包顶层目录「${topDirMismatch}」与 name「${parsed.manifest.name}」不同（规范要求目录名与 name 一致，已按 name 处理）` });
	if (stripped.length) findings.push({ severity: "info", code: "stripped_junk", message: `已忽略 ${stripped.length} 个系统垃圾文件（如 __MACOSX、.DS_Store、.git）` });
	const errors = findings.filter((f) => f.severity === "error");
	if (errors.length) throw new PackageError("scan_failed", `静态检查发现 ${errors.length} 个必须修复的问题：${errors.map((e) => e.message).join("；")}`, findings);
	const zip = buildCanonicalZip(files);
	const totalBytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);
	const check: PackageCheckDTO = {
		ok: true,
		at: nowIso,
		findings,
		stats: { fileCount: files.length, totalBytes, packageBytes: zip.byteLength, scriptCount: files.filter((f) => SCRIPT_EXT.test(f.path)).length },
	};
	return { files, zip, packageSha256: sha256(zip), parsed, check, stripped, topDirMismatch };
}

// ---------------------------------------------------------------- diff between two versions
export type DiffLine = { t: " " | "+" | "-"; s: string };
export interface FileDiff {
	path: string;
	status: "added" | "removed" | "modified" | "unchanged";
	binary?: boolean;
	tooLarge?: boolean;
	added?: number;
	removed?: number;
	hunks?: { oldStart: number; newStart: number; lines: DiffLine[] }[];
}

function lcsDiff(a: string[], b: string[]): DiffLine[] | null {
	if (a.length * b.length > 4_000_000) return null;
	const n = a.length;
	const m = b.length;
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ t: " ", s: a[i]! });
			i++;
			j++;
		}
		else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: "-", s: a[i++]! });
		else out.push({ t: "+", s: b[j++]! });
	}
	while (i < n) out.push({ t: "-", s: a[i++]! });
	while (j < m) out.push({ t: "+", s: b[j++]! });
	return out;
}

function toHunks(all: DiffLine[], ctx = 3): { oldStart: number; newStart: number; lines: DiffLine[] }[] {
	const hunks: { oldStart: number; newStart: number; lines: DiffLine[] }[] = [];
	const changed = all.map((l, i) => (l.t === " " ? -1 : i)).filter((i) => i >= 0);
	if (!changed.length) return hunks;
	let start = Math.max(0, changed[0]! - ctx);
	let end = Math.min(all.length, changed[0]! + ctx + 1);
	const flush = () => {
		let o = 1;
		let nn = 1;
		for (let i = 0; i < start; i++) {
			if (all[i]!.t !== "+") o++;
			if (all[i]!.t !== "-") nn++;
		}
		hunks.push({ oldStart: o, newStart: nn, lines: all.slice(start, end) });
	};
	for (const c of changed.slice(1)) {
		if (c - ctx <= end) end = Math.min(all.length, c + ctx + 1);
		else {
			flush();
			start = Math.max(0, c - ctx);
			end = Math.min(all.length, c + ctx + 1);
		}
	}
	flush();
	return hunks;
}

const decodeText = (b: Uint8Array): string | null => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(b);
	} catch {
		return null;
	}
};

/** Per-file diff of two packages (null previous → everything added). Text files get unified hunks. */
export function diffPackages(prev: readonly PackageFile[] | null, next: readonly PackageFile[]): FileDiff[] {
	const a = new Map((prev ?? []).map((f) => [f.path, f]));
	const b = new Map(next.map((f) => [f.path, f]));
	const out: FileDiff[] = [];
	for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		const x = a.get(path);
		const y = b.get(path);
		if (!x) out.push({ path, status: "added", added: decodeText(y!.bytes)?.split("\n").length });
		else if (!y) out.push({ path, status: "removed", removed: decodeText(x.bytes)?.split("\n").length });
		else if (sha256(x.bytes) === sha256(y.bytes)) out.push({ path, status: "unchanged" });
		else {
			const tx = decodeText(x.bytes);
			const ty = decodeText(y.bytes);
			if (tx === null || ty === null) {
				out.push({ path, status: "modified", binary: true });
				continue;
			}
			const lines = lcsDiff(tx.split("\n"), ty.split("\n"));
			if (!lines) out.push({ path, status: "modified", tooLarge: true });
			else out.push({ path, status: "modified", added: lines.filter((l) => l.t === "+").length, removed: lines.filter((l) => l.t === "-").length, hunks: toHunks(lines).slice(0, 40) });
		}
	}
	return out;
}
