// Online backup of a Workroom data volume using SQLite's online backup API (node:sqlite `backup`), safe while the
// server runs (WAL readers do not block writers). Order matters for cross-file consistency:
//   1. app.sqlite first (catalog, identity, file-version rows, automation defs, usage projection)
//   2. every space's durable.sqlite (pi-durable storage) — a later snapshot, so every catalogued conversation exists
//   3. blobs/ (immutable, content-addressed) — copied after app.sqlite so every referenced blob is present
// Each SQLite file is individually consistent; cross-file the backup is "catalog ⊆ durable", and usage_* tables are a
// rebuildable projection. A manifest with sha256 per file allows verification before restore.
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface BackupManifest {
	format: "workroom-backup/1";
	createdAt: string;
	source: string;
	files: { path: string; kind: "app" | "durable" | "blob" | "other"; size: number; sha256: string }[];
	migrations: { module: string; version: number }[];
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walk(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

async function backupSqlite(src: string, dest: string): Promise<void> {
	mkdirSync(dirname(dest), { recursive: true });
	const db = new DatabaseSync(src);
	try {
		await sqliteBackup(db, dest);
	} finally {
		db.close();
	}
	// The copy is a standalone database: switch it out of WAL so it is a single self-contained file.
	const out = new DatabaseSync(dest);
	try {
		out.exec("PRAGMA journal_mode = DELETE;");
	} finally {
		out.close();
	}
}

export async function backupDataDir(dataDir: string, destDir: string, opts: { includeSandbox?: boolean } = {}): Promise<BackupManifest> {
	if (existsSync(destDir) && readdirSync(destDir).length > 0) throw new Error(`backup target ${destDir} is not empty`);
	mkdirSync(destDir, { recursive: true });
	const files: BackupManifest["files"] = [];
	const add = (abs: string, kind: BackupManifest["files"][number]["kind"]) => files.push({ path: relative(destDir, abs), kind, size: statSync(abs).size, sha256: sha(abs) });

	const app = join(dataDir, "app.sqlite");
	if (!existsSync(app)) throw new Error(`no app.sqlite in ${dataDir}`);
	await backupSqlite(app, join(destDir, "app.sqlite"));
	// A backup is never a live owner: drop single-owner leases so a restored volume can be opened immediately.
	const copy = new DatabaseSync(join(destDir, "app.sqlite"));
	try {
		if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rt_space_leases'").get()) copy.exec("DELETE FROM rt_space_leases");
	} finally {
		copy.close();
	}
	add(join(destDir, "app.sqlite"), "app");

	for (const f of walk(join(dataDir, "orgs"))) {
		const rel = relative(dataDir, f);
		if (f.endsWith("durable.sqlite")) {
			await backupSqlite(f, join(destDir, rel));
			add(join(destDir, rel), "durable");
		} else if (/durable\.sqlite-(wal|shm)$/.test(f)) continue;
		else if (opts.includeSandbox || !rel.split("/").includes("sandbox")) {
			mkdirSync(dirname(join(destDir, rel)), { recursive: true });
			copyFileSync(f, join(destDir, rel));
			add(join(destDir, rel), "other");
		}
	}
	for (const f of walk(join(dataDir, "blobs"))) {
		if (f.endsWith(".tmp")) continue;
		const rel = relative(dataDir, f);
		mkdirSync(dirname(join(destDir, rel)), { recursive: true });
		copyFileSync(f, join(destDir, rel));
		add(join(destDir, rel), "blob");
	}
	const db = new DatabaseSync(join(destDir, "app.sqlite"), { readOnly: true });
	const migrations = db.prepare("SELECT module, MAX(version) AS version FROM _migrations GROUP BY module").all() as { module: string; version: number }[];
	db.close();
	const manifest: BackupManifest = { format: "workroom-backup/1", createdAt: new Date().toISOString(), source: dataDir, files, migrations };
	writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2));
	return manifest;
}

/** Verify a backup (or a data dir with a manifest): checksums, SQLite integrity, blob addresses. */
export function verifyBackup(dir: string): { ok: boolean; problems: string[]; checked: number } {
	const problems: string[] = [];
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
	for (const f of manifest.files) {
		const abs = join(dir, f.path);
		if (!existsSync(abs)) {
			problems.push(`missing ${f.path}`);
			continue;
		}
		if (sha(abs) !== f.sha256) problems.push(`checksum mismatch ${f.path}`);
		if (f.kind === "app" || f.kind === "durable") {
			const db = new DatabaseSync(abs, { readOnly: true });
			const r = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
			db.close();
			if (r.integrity_check !== "ok") problems.push(`integrity ${f.path}: ${r.integrity_check}`);
		}
		if (f.kind === "blob" && !f.path.endsWith(f.sha256)) problems.push(`blob address mismatch ${f.path}`);
	}
	return { ok: problems.length === 0, problems, checked: manifest.files.length };
}

/** Restore = copy a verified backup into an EMPTY data dir (never over live data). */
export function restoreBackup(backupDir: string, dataDir: string): void {
	const v = verifyBackup(backupDir);
	if (!v.ok) throw new Error(`backup failed verification: ${v.problems.join("; ")}`);
	if (existsSync(dataDir) && readdirSync(dataDir).length > 0) throw new Error(`restore target ${dataDir} is not empty`);
	for (const f of walk(backupDir)) {
		const rel = relative(backupDir, f);
		mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
		copyFileSync(f, join(dataDir, rel));
	}
}
