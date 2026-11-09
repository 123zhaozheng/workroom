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
}

export interface HarnessManagerOptions {
	readonly leaseTtlMs: number;
	readonly heartbeatMs: number;
	readonly settings: () => HarnessSettings;
	readonly onReport?: (spaceId: string, report: Report) => void;
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
		if (e && !e.closing) return e.harness;
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
		const entry: Entry = { spaceId, harness: undefined as unknown as Harness, leaseExpiresAt, closing: false };
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
		if (this.#stopping) return;
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
		if (wake.at !== undefined) {
			const delay = Math.max(0, Math.min(wake.at - Date.now(), 2_147_000_000));
			entry.sleepTimer = setTimeout(() => {
				if (!entry.closing && this.#open.get(entry.spaceId) === entry) entry.harness.resume();
			}, delay);
			entry.sleepTimer.unref?.();
		}
	}

	#ensureHeartbeat(): void {
		if (this.#heartbeat) return;
		this.#heartbeat = setInterval(() => this.#beat(), this.#opts.heartbeatMs);
		this.#heartbeat.unref();
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
				this.pendingWakeTimers.add(r.space_id);
				const t = setTimeout(() => {
					this.pendingWakeTimers.delete(r.space_id);
					this.#wakeTimers.delete(t);
					this.get(r.space_id).catch((err) => console.error(`[runtime] wake of ${r.space_id} failed`, err?.message ?? err));
				}, Math.min(r.wake_at - now, 2_147_000_000));
				t.unref();
				this.#wakeTimers.add(t);
				armed.push(r.space_id);
			}
		}
		return { resumed, armed, skipped };
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
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
