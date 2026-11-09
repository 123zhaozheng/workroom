// Durable ingestion pipeline: kb_jobs rows drive queued → parsing → indexing → ready | failed.
// Jobs survive restarts: start() turns jobs left 'running' by a dead process back into 'pending' and resumes.
// One job at a time per process (SQLite single writer; parsing is CPU-bound anyway).
import type { AppContext } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { chunkBlocks } from "./chunker.ts";
import { parseDocument, ParseError } from "./parsers.ts";
import type { OcrEngine } from "./ocr.ts";
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
	/** Offline OCR engine (null when OCR is disabled or its packages are missing). */
	ocr: OcrEngine | null = null;
	/** Jobs processed at once (different documents only; one document's versions run strictly in order). */
	concurrency = Math.max(1, envInt("WORKROOM_KB_CONCURRENCY", 2));
	/** Observability/test hook: job start/end events. */
	onJobEvent: ((e: { phase: "start" | "end"; jobId: string; docId: string; versionNo: number; active: number }) => void) | null = null;
	/** Highest number of jobs observed running at once (ops/tests). */
	maxActiveSeen = 0;
	#stopped = true;
	#paused = false;
	#scheduled = false;
	#timer: NodeJS.Timeout | undefined;
	readonly #active = new Map<string, Promise<void>>();
	readonly #activeDocs = new Set<string>();
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
		await Promise.all([...this.#active.values()].map((p) => p.catch(() => {})));
		await this.ocr?.close();
	}

	/** Test/ops control: stop picking up new jobs (pending jobs stay durable; running ones finish). */
	pause(): void {
		this.#paused = true;
	}
	resume(): void {
		this.#paused = false;
		this.kick();
	}

	kick(): void {
		if (this.#stopped || this.#paused || this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			this.#fill();
		});
	}

	/** Resolves when nothing runs and no job is runnable now (jobs scheduled for later are not waited for). */
	idle(): Promise<void> {
		if (!this.#active.size && !this.#runnable()) return Promise.resolve();
		return new Promise((r) => this.#idleWaiters.push(r));
	}

	/**
	 * Next runnable job: pending, due, its document not already being processed, and no older live job for the same
	 * document (so v1 is always indexed before v2 of one document — supersede order stays correct under concurrency).
	 */
	#runnable(): (JobRow & { doc_id: string; version_no: number }) | undefined {
		return this.db.get(
			`SELECT j.*, v.doc_id, v.version_no FROM kb_jobs j JOIN kb_doc_versions v ON v.id = j.doc_version_id
			 WHERE j.state = 'pending' AND j.run_after <= ? AND v.doc_id NOT IN (SELECT value FROM json_each(?))
			   AND NOT EXISTS (SELECT 1 FROM kb_jobs j2 JOIN kb_doc_versions v2 ON v2.id = j2.doc_version_id
			                   WHERE v2.doc_id = v.doc_id AND j2.state IN ('pending','running') AND j2.id != j.id
			                     AND (v2.version_no < v.version_no OR (v2.version_no = v.version_no AND j2.created_at < j.created_at)))
			 ORDER BY j.created_at, j.id LIMIT 1`,
			nowIso(), JSON.stringify([...this.#activeDocs]),
		);
	}

	#fill(): void {
		if (this.#stopped) return;
		while (!this.#paused && this.#active.size < this.concurrency) {
			const job = this.#runnable();
			if (!job) break;
			this.#activeDocs.add(job.doc_id);
			this.maxActiveSeen = Math.max(this.maxActiveSeen, this.#active.size + 1);
			this.onJobEvent?.({ phase: "start", jobId: job.id, docId: job.doc_id, versionNo: job.version_no, active: this.#active.size + 1 });
			// #process marks the job 'running' synchronously before its first await, so the next pick cannot take it.
			const run = this.#process(job)
				.catch((e) => console.error("[knowledge] job crashed", e))
				.finally(() => {
					this.#active.delete(job.id);
					this.#activeDocs.delete(job.doc_id);
					this.onJobEvent?.({ phase: "end", jobId: job.id, docId: job.doc_id, versionNo: job.version_no, active: this.#active.size });
					if (!this.#stopped) this.#fill();
				});
			this.#active.set(job.id, run);
		}
		if (this.#stopped) return;
		// Wake up for the next job scheduled in the future (retry backoff).
		clearTimeout(this.#timer);
		const next = this.db.get<{ run_after: string }>("SELECT run_after FROM kb_jobs WHERE state = 'pending' AND run_after > ? ORDER BY run_after LIMIT 1", nowIso());
		if (next && !this.#paused) {
			this.#timer = setTimeout(() => this.kick(), Math.max(10, Date.parse(next.run_after) - Date.now()));
			this.#timer.unref?.();
		}
		if (!this.#active.size && (this.#paused || !this.#runnable())) for (const w of this.#idleWaiters.splice(0)) w();
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
			const parsed = await parseDocument(got.bytes, v.file_name, v.mime, { ocr: this.ocr });
			if (this.#stopped) throw new ParseError("interrupted", "服务停止，稍后继续", true);
			this.#setStatus(v.id, "indexing");
			const chunks = chunkBlocks(parsed.blocks);
			await new Promise((r) => setImmediate(r)); // let "indexing" be observable; yields between phases
			this.#index(job, v, chunks, parsed.pageCount, parsed.ocrPages);
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

	#index(job: JobRow, v: VersionRow, chunks: ReturnType<typeof chunkBlocks>, pageCount: number | undefined, ocrPages: number | undefined): void {
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
				"INSERT INTO kb_chunks (id, kb_id, doc_id, doc_version_id, file_id, version_id, version_no, file_name, ordinal, page, section, paragraph, sheet, row_start, row_end, text, created_at, tombstoned_at, tombstone_reason, ocr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			const insFts = this.db.raw.prepare("INSERT INTO kb_fts (rowid, text) VALUES (?, ?)");
			for (const c of chunks) {
				const r = insChunk.run(
					newId("kbc"), v.kb_id, v.doc_id, v.id, v.file_id, v.version_id, v.version_no, v.file_name, c.ordinal,
					c.page ?? null, c.section ?? null, c.paragraph ?? null, c.sheet ?? null, c.rowStart ?? null, c.rowEnd ?? null, c.text, now,
					becomesServing ? null : now, becomesServing ? null : "superseded", c.ocr ? 1 : 0,
				);
				// Section path is indexed with the text so headings are searchable; snippets come from the text only.
				if (becomesServing) insFts.run(r.lastInsertRowid, c.section ? `${c.section}\n${c.text}` : c.text);
			}
			this.db.run("UPDATE kb_doc_versions SET status = 'ready', error = NULL, error_code = NULL, retryable = NULL, chunk_count = ?, page_count = ?, ocr_pages = ?, updated_at = ?, superseded_at = ? WHERE id = ?", chunks.length, pageCount ?? null, ocrPages ?? null, now, becomesServing ? null : now, v.id);
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

