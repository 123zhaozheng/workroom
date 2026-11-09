// One pi-durable Harness per space, opened lazily under a single-owner lease kept in app.sqlite.
//
// Lease (rt_space_leases): acquired with BEGIN IMMEDIATE; renewed by a heartbeat; a row whose owner is another
// instance and whose expiry is in the future refuses the open. Every Storage commit first checks the in-memory lease
// expiry (Storage is wrapped through its public interface), so a process that lost its lease fails its Harness instead
// of writing. Wake state (rt_space_runtime) mirrors HarnessOptions.onWake so start() can resume spaces with pending
// work and arm timers for future sleeps.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { Harness, type Extension, type Registry, type Report, type Storage, type Wake, type HarnessSettings, type ConversationRecord, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AppContext, Space } from "../core/contracts.ts";
import { HttpError } from "../core/http.ts";
import { ApprovalsDoc, EffectsDoc, SpaceDoc, TeamDoc } from "./docs.ts";
import { createFixtureModel, type FixtureModel } from "./fixture-model.ts";

export class LeaseHeld extends HttpError {
	constructor(spaceId: string, owner: string) {
		super(503, "space_busy", "该空间正由另一个服务实例运行，请稍后重试", { spaceId, owner });
	}
}
export class LeaseLost extends Error {
	constructor(spaceId: string) {
		super(`lease for space ${spaceId} lost; refusing to write`);
	}
}

interface Entry {
	readonly spaceId: string;
	harness: Harness;
	leaseExpiresAt: number;
	sleepTimer?: NodeJS.Timeout;
	closing: boolean;
	/** Last wake value onWake reported. */
	wake: Wake;
	/** Last time a caller asked for this harness (get()) or released a hold. */
	lastUsed: number;
	/** Active holds (e.g. SSE watchers); a held harness is never evicted. */
	holds: number;
}

export interface HarnessManagerOptions {
	readonly leaseTtlMs: number;
	readonly heartbeatMs: number;
	readonly settings: () => HarnessSettings;
	readonly onReport?: (spaceId: string, report: Report) => void;
	/** Close a harness idle for this long (no active work, no holds, no sleep due within it). 0 disables eviction. */
	readonly idleMs?: number;
	/** How often idle harnesses are looked for. */
	readonly idleSweepMs?: number;
}

export class HarnessManager {
	readonly #ctx: AppContext;
	readonly #registry: Registry;
	readonly #opts: HarnessManagerOptions;
	readonly #open = new Map<string, Entry>();
	readonly #opening = new Map<string, Promise<Entry>>();
	readonly #models: () => Models;
	readonly fixture: FixtureModel;
	#heartbeat?: NodeJS.Timeout;
	#sweep?: NodeJS.Timeout;
	readonly #wakeTimers = new Set<NodeJS.Timeout>();
	#stopping = false;

	constructor(ctx: AppContext, registry: Registry, opts: HarnessManagerOptions) {
		this.#ctx = ctx;
		this.#registry = registry;
		this.#opts = opts;
		this.fixture = createFixtureModel();
		// Resolved at every use: group E's gateway when present (it registers the fixture provider itself),
		// otherwise our own Models holding only the fixture provider.
		const own = createModels();
		own.setProvider(this.fixture.provider);
		this.#models = () => (ctx.services.has("models") ? ctx.services.get("models").piModels() : own);
	}

	get instanceId(): string {
		return this.#ctx.config.instanceId;
	}
	get registry(): Registry {
		return this.#registry;
	}
	models(): Models {
		return this.#models();
	}

	installExtension(ext: Extension): void {
		this.#registry.install(ext);
	}

	isOpen(spaceId: string): boolean {
		return this.#open.has(spaceId);
	}
	openHarness(spaceId: string): Harness | undefined {
		return this.#open.get(spaceId)?.harness;
	}
	openSpaces(): string[] {
		return [...this.#open.keys()];
	}

	space(spaceId: string): Space {
		const s = this.#ctx.services.get("identity").space(spaceId);
		if (!s) throw new HttpError(404, "space_not_found", "空间不存在");
		return s;
	}

	/** The harness for a space, opening it (lease + storage + resume) when needed. */
	async get(spaceId: string): Promise<Harness> {
		if (this.#stopping) throw new HttpError(503, "stopping", "服务正在停止");
		const e = this.#open.get(spaceId);
		if (e && !e.closing) {
			e.lastUsed = Date.now();
			return e.harness;
		}
		let p = this.#opening.get(spaceId);
		if (!p) {
			p = this.#doOpen(spaceId).finally(() => this.#opening.delete(spaceId));
			this.#opening.set(spaceId, p);
		}
		return (await p).harness;
	}

	// ------------------------------------------------------------------ lease

	/** Acquire (or renew) the lease for this instance. Throws LeaseHeld when another live owner holds it. */
	acquireLease(spaceId: string): number {
		const now = Date.now();
		const expires = now + this.#opts.leaseTtlMs;
		const db = this.#ctx.db;
		db.tx(() => {
			const row = db.get<{ owner: string; expires_at: number }>("SELECT owner, expires_at FROM rt_space_leases WHERE space_id = ?", spaceId);
			if (row && row.owner !== this.instanceId && row.expires_at > now) throw new LeaseHeld(spaceId, row.owner);
			db.run(
				"INSERT INTO rt_space_leases (space_id, owner, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET owner = excluded.owner, acquired_at = CASE WHEN rt_space_leases.owner = excluded.owner THEN rt_space_leases.acquired_at ELSE excluded.acquired_at END, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at",
				spaceId,
				this.instanceId,
				now,
				now,
				expires,
			);
		});
		return expires;
	}

	#releaseLease(spaceId: string): void {
		try {
			this.#ctx.db.run("DELETE FROM rt_space_leases WHERE space_id = ? AND owner = ?", spaceId, this.instanceId);
		} catch {
			/* db may be closing */
		}
	}

	#beat(): void {
		const now = Date.now();
		const expires = now + this.#opts.leaseTtlMs;
		for (const [spaceId, e] of this.#open) {
			if (e.closing) continue;
			let changes = 0;
			try {
				changes = this.#ctx.db.run("UPDATE rt_space_leases SET heartbeat_at = ?, expires_at = ? WHERE space_id = ? AND owner = ?", now, expires, spaceId, this.instanceId).changes;
			} catch (err) {
				console.error(`[runtime] heartbeat failed for ${spaceId}`, err);
			}
			if (changes === 1) e.leaseExpiresAt = expires;
			else {
				console.error(`[runtime] lease for space ${spaceId} lost; closing its harness`);
				e.leaseExpiresAt = 0;
				void this.#close(spaceId, "lease_lost");
			}
		}
	}

	// ------------------------------------------------------------------ open / close

	async #doOpen(spaceId: string): Promise<Entry> {
		const space = this.space(spaceId);
		const leaseExpiresAt = this.acquireLease(spaceId);
		const entry: Entry = { spaceId, harness: undefined as unknown as Harness, leaseExpiresAt, closing: false, wake: { active: true }, lastUsed: Date.now(), holds: 0 };
		try {
			mkdirSync(space.dir, { recursive: true });
			const raw = await openNodeSqliteStorage(join(space.dir, "durable.sqlite"));
			const storage = guardStorage(raw, () => {
				if (entry.leaseExpiresAt <= Date.now()) throw new LeaseLost(spaceId);
			});
			const harness = await Harness.open(
				storage,
				{
					models: () => this.#models(),
					registry: this.#registry,
					// wrSpaceId lets the model gateway (group E) attribute requests to this space; the gateway strips it upstream.
					settings: () => {
						const base = this.#opts.settings();
						return { ...base, stream: { ...base.stream, metadata: { ...base.stream?.metadata, wrSpaceId: spaceId } } };
					},
					identity: { attribution: { name: this.#ctx.config.brand.name } } as any,
					onWake: (wake) => this.#onWake(entry, wake),
					onReport: (report) => {
						if (report.kind === "task_error" || report.kind === "extension_error" || report.kind === "storage_failed" || report.kind === "task_faulted") console.error(`[runtime] ${spaceId} report ${report.kind}`, (report as any).error?.message ?? report);
						this.#opts.onReport?.(spaceId, report);
					},
					conversationCreated: async (tx: Tx, conversation: ConversationRecord) => {
						// Every conversation gets its runtime docs, so watches on them always find an address.
						await tx.doc(ApprovalsDoc, conversation.id);
						await tx.doc(EffectsDoc, conversation.id);
						await tx.doc(TeamDoc, conversation.id);
					},
				},
				BACKGROUND_CONTEXT,
			);
			entry.harness = harness;
			// Record which space this storage is (tools resolve their space through it).
			const sd = await harness.snapshot(SpaceDoc, BACKGROUND_CONTEXT);
			if (!sd || sd.spaceId !== spaceId) {
				await harness.commit(async (tx) => {
					const d = await tx.doc(SpaceDoc);
					d.spaceId = spaceId;
					d.orgId = space.orgId;
				}, BACKGROUND_CONTEXT);
			}
			this.#open.set(spaceId, entry);
			this.#ensureHeartbeat();
			harness.closed.then((end) => {
				if (this.#open.get(spaceId) === entry) this.#open.delete(spaceId);
				if (entry.sleepTimer) clearTimeout(entry.sleepTimer);
				if (end.kind === "failed" && !this.#stopping && !entry.closing) {
					console.error(`[runtime] harness for ${spaceId} failed; reopening`, (end.error as Error)?.message ?? end.error);
					setTimeout(() => {
						if (this.#stopping || this.#open.has(spaceId)) return;
						this.get(spaceId).catch((err) => console.error(`[runtime] reopen of ${spaceId} failed`, err?.message ?? err));
					}, 250).unref();
				}
			});
			this.#onWake(entry, harness.wake());
			harness.resume();
			return entry;
		} catch (err) {
			if (entry.harness) await entry.harness.close(BACKGROUND_CONTEXT).catch(() => {});
			this.#releaseLease(spaceId);
			throw err;
		}
	}

	#onWake(entry: Entry, wake: Wake): void {
		if (this.#stopping || entry.closing) return;
		entry.wake = wake;
		try {
			this.#ctx.db.run(
				"INSERT INTO rt_space_runtime (space_id, wake_active, wake_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET wake_active = excluded.wake_active, wake_at = excluded.wake_at, updated_at = excluded.updated_at",
				entry.spaceId,
				wake.active ? 1 : 0,
				wake.at ?? null,
				Date.now(),
			);
		} catch (err) {
			console.error("[runtime] onWake persist failed", err);
		}
		if (entry.sleepTimer) clearTimeout(entry.sleepTimer);
		entry.sleepTimer = undefined;
		if (wake.at !== undefined) this.#armSleep(entry, wake.at);
	}

	/**
	 * Arm the host wakeup for a sleep due at `at` (pi arms none itself because we pass onWake). Node starts a timer from
	 * the event loop's cached clock, which lags Date.now() after a long synchronous stretch (e.g. open + recovery), so
	 * the timer can fire a few ms BEFORE `at`. pi's `resume()` then finds nothing due and, since `wake()` did not change,
	 * never calls onWake again: the sleep would be stranded. So the callback rechecks the clock and re-arms when early,
	 * as pi's own timer does.
	 */
	#armSleep(entry: Entry, at: number): void {
		const delay = Math.max(1, Math.min(at - Date.now() + 1, 2_147_000_000));
		entry.sleepTimer = setTimeout(() => {
			entry.sleepTimer = undefined;
			if (entry.closing || this.#open.get(entry.spaceId) !== entry) return;
			const now = Date.now();
			if (now < at) {
				this.earlyWakeFires++;
				console.warn(`[runtime] sleep timer for ${entry.spaceId} fired ${at - now}ms before the sleep was due; re-armed`);
				this.#armSleep(entry, at);
				return;
			}
			entry.harness.resume();
		}, delay);
		entry.sleepTimer.unref?.();
	}

	/** Times a sleep timer fired before its due time and was re-armed (observability / tests). */
	earlyWakeFires = 0;

	#ensureHeartbeat(): void {
		if (!this.#heartbeat) {
			this.#heartbeat = setInterval(() => this.#beat(), this.#opts.heartbeatMs);
			this.#heartbeat.unref();
		}
		if (!this.#sweep && this.#opts.idleMs) {
			this.#sweep = setInterval(() => void this.evictIdle(), this.#opts.idleSweepMs ?? 60_000);
			this.#sweep.unref();
		}
	}

	/**
	 * Keep a space's harness open while a client watches it (SSE). Returns the release function; releasing counts as use.
	 */
	hold(spaceId: string): () => void {
		const e = this.#open.get(spaceId);
		if (!e) return () => {};
		e.holds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			e.holds = Math.max(0, e.holds - 1);
			e.lastUsed = Date.now();
		};
	}

	/**
	 * Close harnesses that are idle: no active work (wake.active false), no holds (watchers), unused for idleMs, and no
	 * sleep due within idleMs. rt_space_runtime keeps wake_at, and a timer reopens the space when its sleep is due;
	 * any request reopens it on demand.
	 */
	async evictIdle(): Promise<string[]> {
		const idle = this.#opts.idleMs;
		if (!idle || this.#stopping) return [];
		const now = Date.now();
		const evicted: string[] = [];
		for (const [spaceId, e] of this.#open) {
			if (e.closing || e.holds > 0 || e.wake.active) continue;
			if (now - e.lastUsed < idle) continue;
			if (e.wake.at !== undefined && e.wake.at - now <= idle) continue;
			// re-read pi's own view at the last moment
			const w = e.harness.wake();
			if (w.active || (w.at !== undefined && w.at - now <= idle)) continue;
			const at = w.at;
			await this.#close(spaceId, "idle");
			evicted.push(spaceId);
			if (at !== undefined) this.#armWake(spaceId, at);
		}
		return evicted;
	}

	#armWake(spaceId: string, at: number): void {
		this.pendingWakeTimers.add(spaceId);
		const t = setTimeout(() => {
			this.pendingWakeTimers.delete(spaceId);
			this.#wakeTimers.delete(t);
			// Same early-fire guard as #armSleep (an early reopen is harmless — onWake re-arms — but stay exact).
			if (Date.now() < at) return void this.#armWake(spaceId, at);
			this.get(spaceId).catch((err) => console.error(`[runtime] wake of ${spaceId} failed`, err?.message ?? err));
		}, Math.max(1, Math.min(at - Date.now() + 1, 2_147_000_000)));
		t.unref();
		this.#wakeTimers.add(t);
	}

	async #close(spaceId: string, why: string): Promise<void> {
		const e = this.#open.get(spaceId);
		if (!e || e.closing) return;
		e.closing = true;
		if (e.sleepTimer) clearTimeout(e.sleepTimer);
		try {
			await e.harness.close(BACKGROUND_CONTEXT);
		} catch (err) {
			console.error(`[runtime] close ${spaceId} (${why})`, err);
		}
		this.#open.delete(spaceId);
		if (why !== "lease_lost") this.#releaseLease(spaceId);
	}

	/** Spaces with pending work according to rt_space_runtime: wake_active, or a due sleep. Future sleeps get timers. */
	async resumePending(): Promise<{ resumed: string[]; armed: string[]; skipped: { spaceId: string; reason: string }[] }> {
		const now = Date.now();
		const rows = this.#ctx.db.all<{ space_id: string; wake_active: number; wake_at: number | null }>("SELECT space_id, wake_active, wake_at FROM rt_space_runtime WHERE wake_active = 1 OR wake_at IS NOT NULL");
		const resumed: string[] = [];
		const armed: string[] = [];
		const skipped: { spaceId: string; reason: string }[] = [];
		for (const r of rows) {
			if (r.wake_active === 1 || (r.wake_at !== null && r.wake_at <= now)) {
				try {
					await this.get(r.space_id);
					resumed.push(r.space_id);
				} catch (err: any) {
					skipped.push({ spaceId: r.space_id, reason: err?.code ?? err?.message ?? String(err) });
				}
			} else if (r.wake_at !== null) {
				this.#armWake(r.space_id, r.wake_at);
				armed.push(r.space_id);
			}
		}
		return { resumed, armed, skipped };
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		if (this.#sweep) clearInterval(this.#sweep);
		for (const t of this.#wakeTimers) clearTimeout(t);
		this.#wakeTimers.clear();
		await Promise.allSettled([...this.#opening.values()]);
		await Promise.all([...this.#open.keys()].map((id) => this.#close(id, "stop")));
	}

	/**
	 * Test/ops hook: forget the in-memory lease expiry of an open space without touching the row, as if this process
	 * had stalled past it. The next storage write is refused (LeaseLost) → the Harness fails → it is reopened under a
	 * freshly acquired lease (if no other owner holds it).
	 */
	expireLeaseInMemory(spaceId: string): void {
		const e = this.#open.get(spaceId);
		if (e) e.leaseExpiresAt = 0;
	}

	/** Test/ops hook: whether a timer is armed for a space's future sleep (rt_space_runtime.wake_at). */
	readonly pendingWakeTimers = new Set<string>();

	get context(): Context {
		return BACKGROUND_CONTEXT;
	}
}

/** Wrap a Storage through its public interface: run `check` before every write (commit / mintId). */
function guardStorage(storage: Storage, check: () => void): Storage {
	return new Proxy(storage, {
		get(target, prop) {
			const v = Reflect.get(target, prop, target);
			if (typeof v !== "function") return v;
			if (prop === "commit" || prop === "mintId") {
				return (...args: unknown[]) => {
					check();
					return (v as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return v.bind(target);
		},
	});
}
