// Driver selection: admin setting (persisted in app.sqlite, default from WORKROOM_SANDBOX_DRIVER or "auto") + auto-detection.
// `auto` prefers the lightweight namespace driver where the kernel allows it (Linux), then Docker (Windows, macOS, Linux without
// user namespaces), then `none`. An explicit choice is honoured honestly: choosing `docker` on a host without Docker yields `none`
// with Docker's own explanation — never a silent downgrade to a weaker driver.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { AppContext, Principal } from "../../core/contracts.ts";
import { HttpError, nowIso } from "../../core/http.ts";
import type { DriverId, DriverStatus, SandboxDriver } from "./driver.ts";
import { DEFAULT_DOCKER_SETTINGS, DockerDriver, type DockerSettings } from "./docker.ts";
import { namespaceDriver } from "./namespaces.ts";
import { enableHint, noneDriver } from "./none.ts";
import type { SandboxDriverSetting, SandboxDriverUpdate } from "../../../../shared/sandbox.ts";

export interface SandboxSettings {
	driver: SandboxDriverSetting;
	network: "none" | "allowed";
	docker: DockerSettings;
	maxConcurrent: number;
}

export interface Resolution {
	driver: SandboxDriver;
	effective: DriverId;
	reason: string;
	statuses: Record<"namespaces" | "docker", DriverStatus>;
	at: number;
}

const DRIVER_SETTINGS: SandboxDriverSetting[] = ["auto", "namespaces", "docker", "none"];

export class SandboxDrivers {
	readonly #ctx: AppContext;
	readonly docker: DockerDriver;
	#settings: SandboxSettings;
	#fromEnv = true;
	#last: Resolution | undefined;
	#resolving: Promise<Resolution> | undefined;

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.#settings = this.#load();
		let key = ctx.config.dataDir;
		try {
			key = realpathSync(key);
		} catch {
			/* not created yet */
		}
		this.docker = new DockerDriver(() => this.#settings.docker, createHash("sha256").update(key).digest("hex").slice(0, 16));
	}

	#envDefaults(): SandboxSettings {
		const e = process.env;
		const drv = (DRIVER_SETTINGS as string[]).includes(e.WORKROOM_SANDBOX_DRIVER ?? "") ? (e.WORKROOM_SANDBOX_DRIVER as SandboxDriverSetting) : "auto";
		const cpus = Number(e.WORKROOM_SANDBOX_CPUS ?? DEFAULT_DOCKER_SETTINGS.cpus);
		return {
			driver: drv,
			network: e.WORKROOM_SANDBOX_NETWORK === "allowed" ? "allowed" : "none",
			maxConcurrent: Math.max(1, Math.min(64, Number(e.WORKROOM_SANDBOX_MAX_CONCURRENT ?? 8) || 8)),
			docker: {
				bin: e.WORKROOM_DOCKER_BIN || undefined,
				host: e.WORKROOM_DOCKER_HOST || undefined,
				image: e.WORKROOM_SANDBOX_IMAGE || DEFAULT_DOCKER_SETTINGS.image,
				pythonImage: e.WORKROOM_SANDBOX_PYTHON_IMAGE || DEFAULT_DOCKER_SETTINGS.pythonImage,
				nodeImage: e.WORKROOM_SANDBOX_NODE_IMAGE || DEFAULT_DOCKER_SETTINGS.nodeImage,
				cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 1,
				autoPull: e.WORKROOM_SANDBOX_AUTOPULL !== "0",
			},
		};
	}
	#load(): SandboxSettings {
		const base = this.#envDefaults();
		const row = this.#ctx.db.get<{ value: string }>("SELECT value FROM tool_sandbox_settings WHERE key = 'driver'");
		if (!row) return base;
		this.#fromEnv = false;
		try {
			const saved = JSON.parse(row.value) as Partial<SandboxSettings>;
			return { ...base, ...saved, docker: { ...base.docker, ...(saved.docker ?? {}) } };
		} catch {
			return base;
		}
	}

	settings(): SandboxSettings {
		return this.#settings;
	}
	fromEnvironment(): boolean {
		return this.#fromEnv;
	}

	update(p: Principal, patch: SandboxDriverUpdate): SandboxSettings {
		const s = structuredClone(this.#settings);
		if (patch.driver !== undefined) {
			if (!DRIVER_SETTINGS.includes(patch.driver)) throw new HttpError(400, "invalid", "driver 必须是 auto、namespaces、docker 或 none");
			s.driver = patch.driver;
		}
		if (patch.network !== undefined) {
			if (patch.network !== "none" && patch.network !== "allowed") throw new HttpError(400, "invalid", "network 必须是 none 或 allowed");
			s.network = patch.network;
		}
		if (patch.maxConcurrent !== undefined) {
			if (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1 || patch.maxConcurrent > 64) throw new HttpError(400, "invalid", "maxConcurrent 必须是 1–64 的整数");
			s.maxConcurrent = patch.maxConcurrent;
		}
		const d = patch.docker;
		if (d) {
			const str = (v: unknown, name: string, max = 300) => {
				if (typeof v !== "string" || v.length > max || /[\r\n\0]/.test(v)) throw new HttpError(400, "invalid", `${name} 无效`);
				return v.trim();
			};
			if (d.image !== undefined) s.docker.image = str(d.image, "image") || DEFAULT_DOCKER_SETTINGS.image;
			if (d.pythonImage !== undefined) s.docker.pythonImage = str(d.pythonImage, "pythonImage") || DEFAULT_DOCKER_SETTINGS.pythonImage;
			if (d.nodeImage !== undefined) s.docker.nodeImage = str(d.nodeImage, "nodeImage") || DEFAULT_DOCKER_SETTINGS.nodeImage;
			for (const k of ["image", "pythonImage", "nodeImage"] as const) if (!/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(s.docker[k])) throw new HttpError(400, "invalid", `${k} 不是合法的镜像名`);
			if (d.cpus !== undefined) {
				if (typeof d.cpus !== "number" || !(d.cpus >= 0.1 && d.cpus <= 32)) throw new HttpError(400, "invalid", "cpus 必须在 0.1–32 之间");
				s.docker.cpus = d.cpus;
			}
			if (d.autoPull !== undefined) s.docker.autoPull = !!d.autoPull;
			if (d.bin !== undefined) s.docker.bin = str(d.bin, "bin") || undefined;
			if (d.host !== undefined) {
				const h = str(d.host, "host");
				if (h && !/^(unix|npipe|tcp|ssh):\/\//.test(h)) throw new HttpError(400, "invalid", "host 必须以 unix:// npipe:// tcp:// ssh:// 开头");
				s.docker.host = h || undefined;
			}
		}
		this.#ctx.db.run("INSERT INTO tool_sandbox_settings (key, value, updated_by, updated_at) VALUES ('driver', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at", JSON.stringify(s), p.userId, nowIso());
		try {
			this.#ctx.db.run("INSERT INTO id_audit (id, org_id, actor_user_id, action, target, detail, at) VALUES (?, ?, ?, 'sandbox.driver.set', 'sandbox', ?, ?)", `aud_${Math.random().toString(36).slice(2, 12)}`, p.orgId, p.userId, JSON.stringify(patch), nowIso());
		} catch {
			/* audit table owned by another group */
		}
		this.#settings = s;
		this.#fromEnv = false;
		this.docker.invalidate();
		this.#last = undefined;
		return s;
	}

	/** The driver to use now. Cheap: underlying probes are cached (namespaces: process lifetime, docker: 30 s). */
	resolve(force = false): Promise<Resolution> {
		if (!force && this.#last && Date.now() - this.#last.at < 5_000) return Promise.resolve(this.#last);
		this.#resolving ??= this.#resolve(force).finally(() => (this.#resolving = undefined));
		return this.#resolving;
	}
	/** Last resolution without probing (undefined until the first resolve()). */
	current(): Resolution | undefined {
		return this.#last;
	}

	async #resolve(force: boolean): Promise<Resolution> {
		const [ns, dk] = await Promise.all([namespaceDriver.detect(force), this.docker.detect(force)]);
		const statuses = { namespaces: ns, docker: dk };
		const { driver: want } = this.#settings;
		const pick = (d: SandboxDriver, reason: string): Resolution => (this.#last = { driver: d, effective: d.id, reason, statuses, at: Date.now() });
		const none = (reason: string) => pick(noneDriver(() => reason), reason);
		if (want === "none") return none("管理员已关闭沙箱（driver=none）。");
		if (want === "namespaces") return ns.state === "ready" ? pick(namespaceDriver, "管理员选择了命名空间驱动") : none(`已选择命名空间驱动，但不可用：${ns.summary}（${ns.details.join("；")}）`);
		if (want === "docker") return dk.state === "ready" ? pick(this.docker, "管理员选择了 Docker 驱动") : none(`已选择 Docker 驱动，但${dk.state === "needs_setup" ? "镜像未准备" : "不可用"}：${dk.summary}。${dk.howToEnable ?? ""}`);
		// auto
		if (ns.state === "ready") return pick(namespaceDriver, "自动：此主机支持 Linux 命名空间");
		if (dk.state === "ready") return pick(this.docker, "自动：命名空间不可用，改用 Docker");
		if (dk.state === "needs_setup" && this.#settings.docker.autoPull) {
			// The first run pulls the public images itself (DockerDriver.#imageFor); route there rather than refusing.
			return pick(this.docker, "自动：Docker 可用，首次运行时将自动拉取公共镜像");
		}
		const why = dk.state === "needs_setup" ? `${dk.summary}。${dk.howToEnable ?? ""}` : `命名空间：${ns.summary}；Docker：${dk.summary}。${enableHint()}`;
		return none(`没有可用的沙箱驱动。${why}`);
	}
}
