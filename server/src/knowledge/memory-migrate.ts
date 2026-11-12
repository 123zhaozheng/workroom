// Round 14 one-time migration: database memories (mem_items) → Markdown files per scope and owner.
//   1. back up mem_items + mem_revisions as JSON (<dataDir>/backups/r14/memory-<ts>.json) BEFORE anything is written;
//   2. preference → preferences.md, fact/constraint → facts.md, background → profile.md, plus a MEMORY.md index; only ACTIVE items are imported
//      (deleted and superseded ones are history: they must not come back);
//   3. exact duplicates are merged, same-key items with different values are kept side by side and marked;
//   4. memory-report.json lists counts per scope, duplicates, conflicts and the non-Markdown files found in the old `memories/` store folders;
//   5. a marker row in kb_meta makes the run happen once. Rows are never deleted and are never read again; files that already exist are not touched.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../core/contracts.ts";
import { nowIso } from "../core/http.ts";
import { hostWalk, hostWriteAtomic } from "../vfs/hostdir.ts";
import { INDEX_FILE, isMarkdownName, type MarkdownMemory, type MemScope } from "./memory-md.ts";

export const MIGRATION_MARKER = "r14_memory_markdown";

interface Row {
	id: string;
	org_id: string;
	scope: "private" | "project" | "org";
	owner_user_id: string | null;
	project_id: string | null;
	kind: "preference" | "fact" | "constraint" | "background";
	content: string;
	status: "active" | "superseded" | "deleted";
	created_at: string;
}

const FILE_OF: Record<Row["kind"], { file: string; title: string }> = {
	preference: { file: "preferences.md", title: "偏好" },
	fact: { file: "facts.md", title: "事实与约束" },
	constraint: { file: "facts.md", title: "事实与约束" },
	background: { file: "profile.md", title: "背景" },
};

const norm = (t: string): string => t.replace(/\s+/g, " ").trim();
/** "汇报对象：张经理" → key "汇报对象"; items without such a prefix have no key (never reported as conflicts). */
const keyOf = (t: string): string | null => {
	const m = /^(.{2,20}?)[：:]/.exec(norm(t));
	return m ? m[1]! : null;
};
const bullet = (t: string): string => `- ${t.trim().replace(/\n+/g, "\n  ")}`;

interface GroupReport {
	scope: string;
	orgId: string;
	ownerUserId?: string;
	projectId?: string;
	imported: number;
	files: { path: string; items: number; written: boolean }[];
	duplicates: { text: string; mergedIds: string[] }[];
	conflicts: { key: string; ids: string[]; file: string }[];
	skippedExistingFiles: string[];
}

export function migrateMemoryToMarkdown(ctx: AppContext, mem: MarkdownMemory): { ran: boolean; reportPath?: string } {
	const db = ctx.db;
	let hasTable = true;
	try {
		if (db.get("SELECT value FROM kb_meta WHERE key = ?", MIGRATION_MARKER)) return { ran: false };
		db.get("SELECT 1 FROM mem_items LIMIT 1");
	} catch {
		hasTable = false;
	}
	if (!hasTable) return { ran: false };

	const ts = nowIso().replace(/[:.]/g, "-");
	const dir = join(ctx.config.dataDir, "backups", "r14");
	mkdirSync(dir, { recursive: true });
	const all = db.all<Row>("SELECT * FROM mem_items ORDER BY created_at, id");
	const revisions = db.all("SELECT * FROM mem_revisions ORDER BY seq");
	const backupPath = join(dir, `memory-${ts}.json`);
	writeFileSync(backupPath, JSON.stringify({ at: nowIso(), memItems: all, memRevisions: revisions }, null, 1));

	const active = all.filter((r) => r.status === "active");
	const groups = new Map<string, { scope: MemScope; orgId: string; userId: string; rows: Row[]; rep: GroupReport }>();
	for (const r of active) {
		const key = r.scope === "private" ? `p|${r.org_id}|${r.owner_user_id}` : r.scope === "project" ? `j|${r.org_id}|${r.project_id}` : `o|${r.org_id}`;
		if (r.scope === "private" && !r.owner_user_id) continue;
		if (r.scope === "project" && !r.project_id) continue;
		let g = groups.get(key);
		if (!g) {
			const scope: MemScope = r.scope === "private" ? { kind: "personal" } : r.scope === "project" ? { kind: "project", projectId: r.project_id! } : { kind: "org" };
			g = {
				scope,
				orgId: r.org_id,
				userId: r.owner_user_id ?? "",
				rows: [],
				rep: { scope: r.scope, orgId: r.org_id, ...(r.owner_user_id && r.scope === "private" ? { ownerUserId: r.owner_user_id } : {}), ...(r.project_id && r.scope === "project" ? { projectId: r.project_id } : {}), imported: 0, files: [], duplicates: [], conflicts: [], skippedExistingFiles: [] },
			};
			groups.set(key, g);
		}
		g.rows.push(r);
	}

	for (const g of groups.values()) {
		const root = mem.dirOf(g.orgId, g.scope, g.userId);
		const byFile = new Map<string, { title: string; items: { row: Row; text: string }[] }>();
		const seen = new Map<string, string>(); // normalized text (per target file) → first id
		for (const r of g.rows) {
			const f = FILE_OF[r.kind];
			const slot = byFile.get(f.file) ?? { title: f.title, items: [] };
			byFile.set(f.file, slot);
			const dupKey = `${f.file}|${norm(r.content)}`;
			const first = seen.get(dupKey);
			if (first) {
				const d = g.rep.duplicates.find((x) => x.mergedIds[0] === first);
				if (d) d.mergedIds.push(r.id);
				else g.rep.duplicates.push({ text: norm(r.content).slice(0, 200), mergedIds: [first, r.id] });
				continue;
			}
			seen.set(dupKey, r.id);
			slot.items.push({ row: r, text: r.content.trim() });
		}
		const written: { file: string; title: string; n: number }[] = [];
		for (const [file, slot] of byFile) {
			// conflicts: same key, different value → kept, marked
			const byKey = new Map<string, typeof slot.items>();
			for (const it of slot.items) {
				const k = keyOf(it.text);
				if (k) byKey.set(k, [...(byKey.get(k) ?? []), it]);
			}
			const marked = new Set<string>();
			for (const [k, its] of byKey) {
				if (its.length > 1) {
					g.rep.conflicts.push({ key: k, ids: its.map((i) => i.row.id), file });
					for (const i of its) marked.add(i.row.id);
				}
			}
			const body = slot.items.map((it) => bullet(marked.has(it.row.id) ? `${it.text}（待确认：与另一条同名记忆内容不一致）` : it.text)).join("\n");
			const text = `# ${slot.title}\n\n${body}\n`;
			let wrote = false;
			if (existsSync(join(root, file))) g.rep.skippedExistingFiles.push(file);
			else {
				hostWriteAtomic(root, file, "/memory", new TextEncoder().encode(text));
				wrote = true;
			}
			g.rep.files.push({ path: file, items: slot.items.length, written: wrote });
			g.rep.imported += slot.items.length;
			written.push({ file, title: slot.title, n: slot.items.length });
		}
		if (written.length) {
			if (existsSync(join(root, INDEX_FILE))) g.rep.skippedExistingFiles.push(INDEX_FILE);
			else {
				const index = `# 长期记忆\n\n> 由数据库记忆迁移生成（第 14 轮）。\n\n## 主题\n${written.map((w) => `- [${w.title}](${w.file})（${w.n} 条）`).join("\n")}\n`;
				hostWriteAtomic(root, INDEX_FILE, "/memory", new TextEncoder().encode(index));
				g.rep.files.push({ path: INDEX_FILE, items: 0, written: true });
			}
		}
	}

	// non-Markdown files in the old per-user `memories/` store folders stay where they are; list them
	const nonMarkdown: { orgDir: string; userDir: string; path: string }[] = [];
	const orgsDir = join(ctx.config.dataDir, "orgs");
	try {
		for (const org of readdirSync(orgsDir)) {
			const memRoot = join(orgsDir, org, "stores", "memories");
			let users: string[] = [];
			try {
				users = readdirSync(memRoot);
			} catch {
				continue;
			}
			for (const u of users) {
				try {
					for (const f of hostWalk(join(memRoot, u), "")) if (!isMarkdownName(f.rel)) nonMarkdown.push({ orgDir: org, userDir: u, path: f.rel });
				} catch {
					/* unreadable entry: skipped */
				}
			}
		}
	} catch {
		/* no orgs dir yet */
	}

	const counts = { private: 0, project: 0, org: 0 };
	for (const g of groups.values()) counts[g.rep.scope as keyof typeof counts] += g.rep.imported;
	const reports = [...groups.values()].map((g) => g.rep);
	const report = {
		at: nowIso(),
		backup: `backups/r14/memory-${ts}.json`,
		source: { total: all.length, active: active.length, superseded: all.filter((r) => r.status === "superseded").length, deleted: all.filter((r) => r.status === "deleted").length, note: "只导入 active 条目；superseded/deleted 不会复活；数据库行保留但不再读取" },
		importedByScope: counts,
		groups: reports.length,
		duplicatesMerged: reports.reduce((n, r) => n + r.duplicates.reduce((m, d) => m + d.mergedIds.length - 1, 0), 0),
		conflictsKept: reports.reduce((n, r) => n + r.conflicts.length, 0),
		nonMarkdownFiles: nonMarkdown,
		details: reports,
	};
	const reportPath = join(dir, "memory-report.json");
	writeFileSync(reportPath, JSON.stringify(report, null, 1));
	db.run("INSERT OR IGNORE INTO kb_meta (key, value) VALUES (?, 1)", MIGRATION_MARKER);
	return { ran: true, reportPath };
}
