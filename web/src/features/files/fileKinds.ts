// 文件库 helpers: file kind (filter chips), conversation groups and the day buckets of the timeline. Pure functions, no React.
import type { LibItemDTO } from "@shared/files";

export type FileKind = "doc" | "sheet" | "image" | "slide" | "other";
export type KindFilter = "all" | Exclude<FileKind, "other">;
export type SortKey = "recent" | "oldest" | "name";

export const KIND_FILTERS: { id: KindFilter; label: string }[] = [
	{ id: "all", label: "全部" },
	{ id: "doc", label: "文档" },
	{ id: "sheet", label: "表格" },
	{ id: "image", label: "图片" },
	{ id: "slide", label: "演示文稿" },
];
export const SORTS: { id: SortKey; label: string }[] = [
	{ id: "recent", label: "最近更新" },
	{ id: "oldest", label: "最早更新" },
	{ id: "name", label: "名称" },
];

const DOC = new Set(["doc", "docx", "pdf", "md", "markdown", "txt", "rtf", "odt", "html", "htm"]);
const SHEET = new Set(["xls", "xlsx", "csv", "tsv", "ods"]);
const SLIDE = new Set(["ppt", "pptx", "key", "odp"]);

export const extOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

export function kindOf(name: string, mime = ""): FileKind {
	const ext = extOf(name);
	if (mime.startsWith("image/")) return "image";
	if (SHEET.has(ext)) return "sheet";
	if (SLIDE.has(ext)) return "slide";
	if (DOC.has(ext) || mime === "application/pdf" || mime === "text/plain" || mime === "text/markdown") return "doc";
	return "other";
}

export interface FileGroup {
	key: string;
	folder: string;
	spaceId: string;
	conversationId: number;
	items: LibItemDTO[];
	/** ms of the newest item: the group sits in the day of its newest item. */
	newest: number;
}

export const groupKey = (spaceId: string, conversationId: number) => `${spaceId}/${conversationId}`;
const ms = (i: LibItemDTO) => Date.parse(i.updatedAt) || 0;

/** One group per conversation folder; items and groups ordered by `sort`. */
export function buildGroups(items: LibItemDTO[], sort: SortKey): FileGroup[] {
	const m = new Map<string, FileGroup>();
	for (const i of items) {
		const key = groupKey(i.spaceId, i.conversationId);
		const g = m.get(key) ?? { key, folder: i.folder, spaceId: i.spaceId, conversationId: i.conversationId, items: [], newest: 0 };
		g.items.push(i);
		g.newest = Math.max(g.newest, ms(i));
		m.set(key, g);
	}
	const itemCmp = sort === "name" ? (a: LibItemDTO, b: LibItemDTO) => a.name.localeCompare(b.name, "zh-CN") : sort === "oldest" ? (a: LibItemDTO, b: LibItemDTO) => ms(a) - ms(b) : (a: LibItemDTO, b: LibItemDTO) => ms(b) - ms(a);
	const groupCmp = sort === "name" ? (a: FileGroup, b: FileGroup) => a.folder.localeCompare(b.folder, "zh-CN") : sort === "oldest" ? (a: FileGroup, b: FileGroup) => a.newest - b.newest : (a: FileGroup, b: FileGroup) => b.newest - a.newest;
	const out = [...m.values()];
	for (const g of out) g.items.sort(itemCmp);
	return out.sort(groupCmp);
}

export interface DayBucket {
	key: string;
	label: string;
	sub?: string;
	groups: FileGroup[];
}

const dayKey = (t: number) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;

/** Timeline buckets: 今天 / 昨天 / plain date (with the year when it is not this year), in the order of their first group. */
export function bucketByDay(groups: FileGroup[], sort: SortKey, now = new Date()): DayBucket[] {
	const today = dayKey(now.getTime());
	const yesterday = dayKey(now.getTime() - 86400_000);
	const m = new Map<string, DayBucket>();
	for (const g of groups) {
		const k = dayKey(g.newest);
		let b = m.get(k);
		if (!b) {
			const d = new Date(g.newest);
			const date = d.getFullYear() === now.getFullYear() ? md(d) : `${d.getFullYear()}年${md(d)}`;
			b = k === today ? { key: k, label: "今天", sub: date, groups: [] } : k === yesterday ? { key: k, label: "昨天", sub: date, groups: [] } : { key: k, label: date, groups: [] };
			m.set(k, b);
		}
		b.groups.push(g);
	}
	const out = [...m.values()];
	// by name the days still read newest first; the names only order the cards inside a day
	if (sort === "name") out.sort((a, b) => Math.max(...b.groups.map((g) => g.newest)) - Math.max(...a.groups.map((g) => g.newest)));
	return out;
}

export const timeOf = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** The folder is "<conversation title>--c<id>[-<space>]": people see the title only. */
export const folderTitle = (folder: string) => folder.replace(/--c\d+(-[0-9a-z]+)?$/i, "") || folder;
