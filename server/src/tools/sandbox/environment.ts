// Round 8 (Q2): the execution environment of one conversation, as the cloud button / "正在准备工作环境" line need it.
//
// Hard rules (tested in server/test/round8-environment.test.ts):
//  * `get()` never creates, connects to or probes a remote sandbox; it reads configuration + the instance table + in-process activity markers.
//    (Local driver detection is the existing cached probe, not a sandbox.)
//  * Sending a message never calls anything here. `prepare()` exists only for an explicit retry and goes through Sandbox.prepare → RemoteDriver.prepare,
//    i.e. the same acquire / restore / sync code a sandbox tool call uses (no second path), under the same lock.
//  * Round 10: one organisation-wide sandbox channel (admin: 管理后台 › 沙箱). The conversation only REPORTS it: no option list, no per-project switching.
//  * No silent fallback: a misconfigured environment is reported as `failed` with a plain message, never as the local driver.
import type { AppContext, Principal, Space } from "../../core/contracts.ts";
import { HttpError } from "../../core/http.ts";
import type { ConversationEnvironmentDTO } from "../../../../shared/sandbox.ts";
import { isolationText, type Sandbox } from "../sandbox.ts";
import { activityKey, remoteActivity } from "./remote-driver.ts";
import { providerConfigsFor } from "./provider-config.ts";
import type { ProviderId } from "./provider.ts";
import { workspaceKeyOf } from "./persist.ts";
import { requirePermission } from "./perm.ts";
import { NETWORK_TEXT_PROVIDER, networkText } from "./network.ts";
import { LOCAL_SKILLS_ROOT, LOCAL_WORKDIR, skillsRootFor } from "./workdir.ts";

type State = ConversationEnvironmentDTO["state"];

interface Row {
	id: string;
	state: "creating" | "ready" | "pausing" | "paused" | "resuming" | "archived" | "stopping" | "destroyed" | "lost" | "error";
	created_at: string;
	last_used_at: string;
	expires_at: string | null;
	last_error: string | null;
	state_at: string | null;
	resume_mode: "provider" | "recreate" | null;
}

/** A "preparing" marker older than this is treated as stuck (it is cleared by the driver in every path; this is a safety net). */
const STALE_PREPARING_MS = 15 * 60_000;

/** Adapters prefix their own name and RemoteDriver adds it again ("OpenSandbox 创建沙箱失败：OpenSandbox 创建沙箱失败："): say it once. */
const tidy = (m: string): string => m.replace(/(创建沙箱失败：)\S+ 创建沙箱失败：/, "$1");

const NO_DRIVER = "执行环境未配置：请联系管理员";

export class ConversationEnvironments {
	readonly #ctx: AppContext;
	constructor(ctx: AppContext) {
		this.#ctx = ctx;
	}
	get #sandbox(): Sandbox {
		return this.#ctx.services.get("sandbox") as Sandbox;
	}

	async #canWrite(p: Principal, space: Space): Promise<boolean> {
		try {
			await this.#ctx.services.get("acl").require(p, "write", { kind: "space", id: space.id });
			return true;
		} catch {
			return false;
		}
	}

	/** Local driver as resolved now (cached probe). */
	async #local(): Promise<{ id: string; label: string; usable: boolean; reason: string; isolation: string; network: boolean; networkText: string }> {
		const r = await this.#sandbox.drivers.resolve();
		if (r.effective === "none") return { id: "none", label: "平台内置沙箱（未启用）", usable: false, reason: r.reason, isolation: "没有可用的执行环境", network: false, networkText: "无网络（没有可用的沙箱驱动）" };
		return {
			id: r.effective,
			label: `平台内置沙箱（${r.driver.label}）`,
			usable: true,
			reason: "",
			isolation: isolationText(r.driver.notes),
			// Round 9: the driver's actual capability (docker: deployment network; namespaces: none, a technical limit), not a Workroom policy.
			network: r.driver.capabilities.network,
			networkText: networkText(r.driver),
		};
	}

	#rowFor(space: Space, workspaceKey: string, provider: ProviderId): Row | undefined {
		return this.#ctx.db.get<Row>(
			"SELECT id, state, created_at, last_used_at, expires_at, last_error, state_at, resume_mode FROM tool_sandbox_instances WHERE org_id = ? AND space_id = ? AND workspace_key = ? AND provider = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			space.orgId,
			space.id,
			workspaceKey,
			provider,
		);
	}

	/** State of the remote sandbox of one workspace from DB + in-process markers. Reads only. */
	#remoteState(space: Space, workspaceKey: string, provider: ProviderId, createTimeoutSec: number, now = Date.now()): { state: State; error?: string; updatedAt?: string; resumeMode?: "fast" | "archived" | "recreate" } {
		const key = activityKey(space.orgId, space.id, workspaceKey, provider);
		const since = remoteActivity.preparing.get(key);
		// A phase that brings a paused / archived sandbox back is "resuming"; a first-time create or a recreate after a loss stays "preparing".
		if (since !== undefined && now - since < STALE_PREPARING_MS) {
			const mode = remoteActivity.resuming.get(key);
			return mode ? { state: "resuming", resumeMode: mode, updatedAt: new Date(since).toISOString() } : { state: "preparing", updatedAt: new Date(since).toISOString() };
		}
		const fail = remoteActivity.failures.get(key);
		const row = this.#rowFor(space, workspaceKey, provider);
		if (fail && (!row || Date.parse(row.created_at) <= fail.at)) return { state: "failed", error: fail.error, updatedAt: new Date(fail.at).toISOString() };
		if (!row) return { state: "none" };
		switch (row.state) {
			case "creating":
				// A row that says "creating" with no live marker in this process: either a create that just started in another process, or one a restart interrupted.
				return now - Date.parse(row.created_at) < (createTimeoutSec + 30) * 1000 ? { state: "preparing", updatedAt: row.created_at } : { state: "failed", error: "上次创建执行环境时被中断，请重试", updatedAt: row.created_at };
			case "ready":
				if (row.expires_at && Date.parse(row.expires_at) <= now) return { state: "lost", updatedAt: row.expires_at };
				return { state: "ready", updatedAt: row.last_used_at };
			case "pausing": // the pause takes seconds and a run simply waits for it: still usable as far as the user is concerned
				return { state: "ready", updatedAt: row.last_used_at };
			case "paused":
			case "archived": {
				const mode = row.state === "archived" ? "archived" : row.resume_mode === "recreate" ? "recreate" : "fast";
				return { state: "paused", resumeMode: mode, updatedAt: row.state_at ?? row.last_used_at };
			}
			case "resuming": {
				// Another process is resuming it (this one has no marker), or a resume was interrupted by a restart: after the window it is simply paused.
				const at = row.state_at ?? row.last_used_at;
				return now - Date.parse(at) < (createTimeoutSec + 120) * 1000 ? { state: "resuming", resumeMode: "fast", updatedAt: at } : { state: "paused", resumeMode: "fast", updatedAt: at };
			}
			case "error":
				// A failed DESTROY leaves an error row too; that is a sandbox that is gone (or going), not a failed prepare.
				if (row.last_error?.startsWith("销毁失败")) return { state: "lost", updatedAt: row.last_used_at };
				return { state: "failed", error: row.last_error ?? "创建执行环境失败", updatedAt: row.created_at };
			default:
				return { state: "lost", updatedAt: row.last_used_at }; // lost | destroyed | stopping
		}
	}

	async get(p: Principal, space: Space, conversationId: number): Promise<ConversationEnvironmentDTO> {
		const cfgs = providerConfigsFor(this.#ctx);
		const eff = cfgs.effectiveFor(space);
		const writable = await this.#canWrite(p, space);
		const local = await this.#local();
		const wk = workspaceKeyOf(conversationId);

		// ---- local ----
		if (eff.kind === "local") {
			return {
				kind: local.usable ? "local" : "none",
				id: local.id,
				label: local.label,
				location: "this_server",
				isolation: local.isolation,
				network: local.network ? "allowed" : "none",
				networkText: local.networkText,
				state: local.usable ? "ready" : "failed",
				...(local.usable ? {} : { error: NO_DRIVER }),
				canPrepare: false,
				workDir: LOCAL_WORKDIR,
				skillsDir: LOCAL_SKILLS_ROOT,
			};
		}

		// ---- remote ----
		const provider = eff.provider;
		const d = cfgs.dto({ orgId: space.orgId }, provider);
		const why = cfgs.explain(space); // "" when usable
		const caps = this.#sandbox.remote.drivers().find((x) => x.id === provider && x.orgId === space.orgId)?.provider.capabilities ?? d.capabilities; // live provider's own answer when a driver exists, else the last connection test / placeholder
		const vendor = caps.location === "vendor_cloud" || (caps.location === "configurable" && !d.allowPrivateNetwork);
		const notes = this.#sandbox.remote.notesFor(provider);
		// Round 9: whether a sandbox can reach the network is the provider's own business (Workroom neither requests nor denies it).
		const network = caps.networkOn !== "unsupported" ? "allowed" : "none";
		let state: ConversationEnvironmentDTO["state"];
		let error: string | undefined;
		let updatedAt: string | undefined;
		let resumeMode: "fast" | "archived" | "recreate" | undefined;
		if (why) {
			// Misconfigured (disabled / unconfigured / no key): say so plainly; the long text stays for admins in the run error.
			state = "failed";
			error = `${NO_DRIVER}（${d.label} ${!d.enabled ? "已停用或未启用" : !d.apiKeySet ? "缺少密钥" : "尚未配置"}）`;
		} else {
			const r = this.#remoteState(space, wk, provider, d.createTimeoutSec);
			state = r.state;
			error = r.error ? tidy(r.error) : undefined;
			updatedAt = r.updatedAt;
			resumeMode = r.resumeMode;
		}
		return {
			kind: "remote",
			id: provider,
			label: d.label,
			location: vendor ? "vendor_cloud" : "self_hosted",
			isolation: isolationText(notes),
			network,
			networkText: NETWORK_TEXT_PROVIDER,
			state,
			...(error ? { error } : {}),
			...(updatedAt ? { updatedAt } : {}),
			...(resumeMode && (state === "paused" || state === "resuming") ? { resumeMode } : {}),
			canPrepare: writable && !why,
			workDir: cfgs.effectiveWorkDir(space.orgId, provider),
			skillsDir: skillsRootFor(cfgs.effectiveWorkDir(space.orgId, provider)),
		};
	}

	/**
	 * Explicit prepare / retry. Remote only; idempotent (an existing live sandbox is reconnected and re-verified, never duplicated; a concurrent run or
	 * prepare for the same workspace is serialised by the driver's lock). Failures do not throw: they become `state: "failed"` with a plain message.
	 */
	async prepare(p: Principal, space: Space, conversationId: number, signal?: AbortSignal, opts?: { trigger?: "explicit" | "prewarm" }): Promise<ConversationEnvironmentDTO> {
		const before = await this.get(p, space, conversationId);
		if (before.kind !== "remote") return before; // local drivers need no preparation (and a misconfiguration stays reported as is)
		if (!before.canPrepare) throw new HttpError(403, "forbidden", "没有权限：准备执行环境需要对该空间有写入权限，且执行环境已配置");
		await requirePermission(this.#ctx, p, "sandbox.use");
		const provider = before.id as ProviderId;
		const key = activityKey(space.orgId, space.id, workspaceKeyOf(conversationId), provider);
		try {
			await this.#sandbox.prepare({ principal: p, space, conversationId, signal, trigger: opts?.trigger ?? "explicit" });
		} catch (e: any) {
			// The driver already left a marker for failures while creating/syncing; failures before it (provider unusable, workspace restore) get one here.
			if (!signal?.aborted) remoteActivity.fail(key, tidy(e instanceof Error ? e.message : String(e)));
		}
		return this.get(p, space, conversationId);
	}
}

const cache = new WeakMap<AppContext, ConversationEnvironments>();
export function environmentsFor(ctx: AppContext): ConversationEnvironments {
	let s = cache.get(ctx);
	if (!s) cache.set(ctx, (s = new ConversationEnvironments(ctx)));
	return s;
}
