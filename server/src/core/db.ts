// App database (identity, ACL, catalog, files, knowledge index, automations, usage projection).
// Not a store for conversation/run/branch facts — those live only in each space's pi-durable storage.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
	/** Monotonic per module, starting at 1. */
	readonly version: number;
	readonly name: string;
	readonly sql: string;
}

export class AppDb {
	readonly raw: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.raw = new DatabaseSync(path);
		this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (module, version))`);
	}

	migrate(module: string, migrations: readonly Migration[]): void {
		const applied = new Set(this.all<{ version: number }>("SELECT version FROM _migrations WHERE module = ?", module).map((r) => r.version));
		for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
			if (applied.has(m.version)) continue;
			this.tx(() => {
				this.raw.exec(m.sql);
				this.run("INSERT INTO _migrations (module, version, name, applied_at) VALUES (?, ?, ?, ?)", module, m.version, m.name, new Date().toISOString());
			});
		}
	}

	get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.raw.prepare(sql).get(...params) as T | undefined;
	}
	all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.raw.prepare(sql).all(...params) as T[];
	}
	run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
		const r = this.raw.prepare(sql).run(...params);
		return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
	}

	#depth = 0;
	/** Synchronous transaction (nested calls use savepoints). Do not await inside. */
	tx<T>(fn: () => T): T {
		const sp = `sp${this.#depth}`;
		this.raw.exec(this.#depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
		this.#depth++;
		try {
			const out = fn();
			if (out instanceof Promise) throw new Error("AppDb.tx callback must be synchronous");
			this.#depth--;
			this.raw.exec(this.#depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
			return out;
		} catch (e) {
			this.#depth--;
			this.raw.exec(this.#depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
			throw e;
		}
	}

	close(): void {
		this.raw.close();
	}
}
