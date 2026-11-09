// Durable ingestion pipeline: kb_jobs rows drive queued → parsing → indexing → ready | failed.
// Jobs survive restarts: start() turns jobs left 'running' by a dead process back into 'pending' and resumes.
// One job at a time per process (SQLite single writer; parsing is CPU-bound anyway).
import type { AppContext } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { chunkBlocks } from "./chunker.ts";
import { parseDocument, ParseError } from "./parsers.ts";
import type { KnowledgeStore, VersionRow } from "./service.ts";

const envInt = (name: string, dflt: number) => {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
};

interface JobRow {
	id: string;
	doc_version_id: string;
	state: string;
	attempt: number;
	run_after: string;
}

export class IngestPipeline {
	readonly ctx: AppContext;
	readonly store: KnowledgeStore;
	/** Total attempts for retryable failures before the version is marked failed (manual retry still possible). */
	maxAttempts = envInt("WORKROOM_KB_MAX_ATTEMPTS", 3);
	retryBaseMs = envInt("WORKROOM_KB_RETRY_BASE_MS", 2000);
	#running = false;
	#stopped = true;
	#paused = false;
	#timer: NodeJS.Timeout | undefined;
	#current: Promise<void> | null = null;
	#idleWaiters: (() => void)[] = [];

	constructor(ctx: AppContext, store: KnowledgeStore) {
		this.ctx = ctx;
		this.store = store;
	}
	get db() {
		return this.ctx.db;
	}

	/** Recover jobs abandoned by a previous process, then start draining. */
	start(): void {
		const now = nowIso();
		this.db.tx(() => {
			// A job 'running' at startup belongs to a dead process (single owner): run it again from the start.
			this.db.run("UPDATE kb_jobs SET state = 'pending', owner_instance = NULL, updated_at = ? WHERE state = 'running'", now);
			this.db.run(
				"UPDATE kb_doc_versions SET status = 'queued', updated_at = ? WHERE status IN ('parsing','indexing') AND id IN (SELECT doc_version_id FROM kb_jobs WHERE state = 'pending')",
				now,
			);
			// Defensive: a queued version without a live job gets one.
			for (const v of this.db.all<{ id: string }>("SELECT v.id FROM kb_doc_versions v JOIN kb_docs d ON d.id = v.doc_id WHERE v.status IN ('queued','parsing','indexing') AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM kb_jobs j WHERE j.doc_version_id = v.id AND j.state IN ('pending','running'))"))
				this.db.run("INSERT INTO kb_jobs (id, doc_version_id, state, attempt, run_after, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)", newId("kbj"), v.id, now, now, now);
		});
		this.#stopped = false;
		this.kick();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		await this.#current?.catch(() => {});
	}

	/** Test/ops control: stop picking up new jobs (pending jobs stay durable). */
	pause(): void {
		this.#paused = true;
	}
	resume(): void {
		this.#paused = false;
		this.kick();
	}

	kick(): void {
		if (this.#stopped || this.#paused || this.#running) return;
		this.#running = true;
		setImmediate(() => void this.#drain());
	}

	/** Resolves when no job is runnable now (pending jobs scheduled for later are not waited for). */
	idle(): Promise<void> {
		if (!this.#running && !this.#runnable()) return Promise.resolve();
		return new Promise((r) => this.#idleWaiters.push(r));
	}

	#runnable(): JobRow | undefined {
		return this.db.get<JobRow>("SELECT * FROM kb_jobs WHERE state = 'pending' AND run_after <= ? ORDER BY created_at, id LIMIT 1", nowIso());
	}

	async #drain(): Promise<void> {
		if (this.#stopped) {
			this.#running = false;
			return;
		}
		try {
			while (!this.#stopped && !this.#paused) {
				const job = this.#runnable();
				if (!job) break;
				this.#current = this.#process(job);
				await this.#current;
				this.#current = null;
			}
		} finally {
			this.#running = false;
			this.#current = null;
			if (!this.#stopped) {
				const next = this.db.get<{ run_after: string }>("SELECT run_after FROM kb_jobs WHERE state = 'pending' ORDER BY run_after LIMIT 1");
				if (next && !this.#paused) {
					clearTimeout(this.#timer);
					this.#timer = setTimeout(() => this.kick(), Math.max(10, Date.parse(next.run_after) - Date.now()));
					this.#timer.unref?.();
				}
			}
			if (this.#stopped || this.#paused || !this.#runnable()) for (const w of this.#idleWaiters.splice(0)) w();
		}
	}

	#setStatus(versionId: string, status: VersionRow["status"], extra: Partial<Pick<VersionRow, "error" | "error_code" | "retryable">> = {}): void {
		this.db.run(
			"UPDATE kb_doc_versions SET status = ?, error = ?, error_code = ?, retryable = ?, updated_at = ? WHERE id = ?",
			status, extra.error ?? null, extra.error_code ?? null, extra.retryable === undefined ? null : extra.retryable, nowIso(), versionId,
		);
	}

	async #process(job: JobRow): Promise<void> {
		const v = this.store.versionRow(job.doc_version_id);
		const d = v ? this.store.docRow(v.doc_id) : undefined;
		const kb = d ? this.store.kbRow(d.kb_id) : undefined;
		if (!v || !d || !kb || d.deleted_at || kb.deleted_at) {
			this.db.run("UPDATE kb_jobs SET state = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), job.id);
			return;
		}
		const attempt = job.attempt + 1;
		this.db.tx(() => {
			this.db.run("UPDATE kb_jobs SET state = 'running', attempt = ?, owner_instance = ?, updated_at = ? WHERE id = ?", attempt, this.ctx.config.instanceId, nowIso(), job.id);
			this.db.run("UPDATE kb_doc_versions SET attempts = attempts + 1 WHERE id = ?", v.id);
			this.#setStatus(v.id, "parsing");
		});
		try {
			// Read the source as the user who added it, re-resolved now (revocation applies to background work too).
			const principal = await this.ctx.services.get("identity").principalFor(v.added_by, kb.org_id);
			if (!principal) throw new ParseError("adder_revoked", "添加该文档的用户已不在组织中，无法读取来源文件", false);
			let got;
			try {
				got = await this.store.files().getVersion(principal, v.version_id);
			} catch (e) {
				throw new ParseError("source_unavailable", `读取来源文件失败：${e instanceof HttpError ? e.message : (e as Error).message}`, true);
			}
			if (!got) throw new ParseError("source_unavailable", "来源文件版本不可读（可能已删除或无权限）", true);
			const parsed = await parseDocument(got.bytes, v.file_name, v.mime);
			if (this.#stopped) throw new ParseError("interrupted", "服务停止，稍后继续", true);
			this.#setStatus(v.id, "indexing");
			const chunks = chunkBlocks(parsed.blocks);
			await new Promise((r) => setImmediate(r)); // let "indexing" be observable; yields between phases
			this.#index(job, v, chunks, parsed.pageCount);
		} catch (e) {
			const pe = e instanceof ParseError ? e : new ParseError("internal", `处理失败：${(e as Error).message ?? String(e)}`, true);
			if (!(e instanceof ParseError)) console.error("[knowledge] ingest error", e);
			if (pe.code === "interrupted") {
				this.db.tx(() => {
					this.db.run("UPDATE kb_jobs SET state = 'pending', attempt = ?, updated_at = ? WHERE id = ?", job.attempt, nowIso(), job.id);
					this.#setStatus(v.id, "queued");
				});
				return;
			}
			const willRetry = pe.retryable && attempt < this.maxAttempts;
			const now = nowIso();
			this.db.tx(() => {
				if (willRetry) {
					const runAfter = new Date(Date.now() + this.retryBaseMs * 2 ** (attempt - 1)).toISOString();
					this.db.run("UPDATE kb_jobs SET state = 'pending', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?", pe.message, runAfter, now, job.id);
					this.#setStatus(v.id, "queued", { error: `${pe.message}（将自动重试）`, error_code: pe.code, retryable: 1 });
				} else {
					this.db.run("UPDATE kb_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?", pe.message, now, job.id);
					this.#setStatus(v.id, "failed", { error: pe.message, error_code: pe.code, retryable: pe.retryable ? 1 : 0 });
				}
			});
		}
	}

	#index(job: JobRow, v: VersionRow, chunks: ReturnType<typeof chunkBlocks>, pageCount: number | undefined): void {
		const now = nowIso();
		this.db.tx(() => {
			const d = this.store.docRow(v.doc_id)!;
			if (d.deleted_at) {
				this.db.run("UPDATE kb_jobs SET state = 'cancelled', updated_at = ? WHERE id = ?", now, job.id);
				return;
			}
			// Idempotent re-index of this version (e.g. after a crash between commits — cannot happen inside one tx, but cheap).
			this.db.run("DELETE FROM kb_fts WHERE rowid IN (SELECT seq FROM kb_chunks WHERE doc_version_id = ? AND tombstoned_at IS NULL)", v.id);
			this.db.run("DELETE FROM kb_chunks WHERE doc_version_id = ?", v.id);
			const serving = d.serving_version_id ? this.store.versionRow(d.serving_version_id) : undefined;
			const becomesServing = !serving || serving.version_no < v.version_no;
			const insChunk = this.db.raw.prepare(
				"INSERT INTO kb_chunks (id, kb_id, doc_id, doc_version_id, file_id, version_id, version_no, file_name, ordinal, page, section, paragraph, sheet, row_start, row_end, text, created_at, tombstoned_at, tombstone_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			const insFts = this.db.raw.prepare("INSERT INTO kb_fts (rowid, text) VALUES (?, ?)");
			for (const c of chunks) {
				const r = insChunk.run(
					newId("kbc"), v.kb_id, v.doc_id, v.id, v.file_id, v.version_id, v.version_no, v.file_name, c.ordinal,
					c.page ?? null, c.section ?? null, c.paragraph ?? null, c.sheet ?? null, c.rowStart ?? null, c.rowEnd ?? null, c.text, now,
					becomesServing ? null : now, becomesServing ? null : "superseded",
				);
				// Section path is indexed with the text so headings are searchable; snippets come from the text only.
				if (becomesServing) insFts.run(r.lastInsertRowid, c.section ? `${c.section}\n${c.text}` : c.text);
			}
			this.db.run("UPDATE kb_doc_versions SET status = 'ready', error = NULL, error_code = NULL, retryable = NULL, chunk_count = ?, page_count = ?, updated_at = ?, superseded_at = ? WHERE id = ?", chunks.length, pageCount ?? null, now, becomesServing ? null : now, v.id);
			if (becomesServing) {
				if (serving) {
					// Old version leaves the index now; its rows stay (tombstoned) so old citations can report "superseded".
					this.db.run("DELETE FROM kb_fts WHERE rowid IN (SELECT seq FROM kb_chunks WHERE doc_version_id = ? AND tombstoned_at IS NULL)", serving.id);
					this.db.run("UPDATE kb_chunks SET tombstoned_at = ?, tombstone_reason = 'superseded' WHERE doc_version_id = ? AND tombstoned_at IS NULL", now, serving.id);
					this.db.run("UPDATE kb_doc_versions SET superseded_at = ? WHERE id = ?", now, serving.id);
				}
				this.db.run("UPDATE kb_docs SET serving_version_id = ?, file_name = ?, updated_at = ? WHERE id = ?", v.id, v.file_name, now, d.id);
				// Governance replacement: docs replaced by this one are withdrawn once it is servable.
				this.db.run("UPDATE kb_docs SET gov_status = 'withdrawn', gov_updated_at = ? WHERE replaced_by_doc_id = ? AND gov_status != 'withdrawn' AND deleted_at IS NULL", now, d.id);
			}
			this.db.run("UPDATE kb_jobs SET state = 'done', updated_at = ? WHERE id = ?", now, job.id);
			this.store.bumpGeneration();
		});
	}
}

