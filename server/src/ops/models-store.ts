// pi-ai storage adapters backed by the app DB:
//  - DbCredentialStore  (CredentialStore): provider API keys live ENCRYPTED in model_providers.api_key_enc (AES-256-GCM,
//    WORKROOM_SECRET_KEY). pi-ai asks for them through Models.getAuth(); they never leave the server process.
//  - DbModelsStore      (ModelsStore): dynamic model catalogs fetched with fetchModels() (GET /models) persist in
//    model_catalog so they survive restarts without a network call.
import type { Credential, CredentialInfo, CredentialStore, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { AppDb } from "../core/db.ts";
import type { SecretBox } from "../identity/secrets.ts";
import { json, type ProviderRow } from "./models-types.ts";

/** Resolve a provider's API key: stored (encrypted) first, then the WORKROOM_-prefixed env var it names. */
export function providerKey(row: ProviderRow, secrets: SecretBox): { key?: string; source: "stored" | "env" | "none"; detail?: string } {
	if (row.api_key_enc) {
		try {
			return { key: secrets.open(row.api_key_enc), source: "stored" };
		} catch (e) {
			return { source: "none", detail: `无法解密已存储的密钥：${(e as Error).message}` };
		}
	}
	if (row.api_key_env) {
		const v = process.env[row.api_key_env];
		return v ? { key: v, source: "env" } : { source: "none", detail: `环境变量 ${row.api_key_env} 未设置` };
	}
	return { source: "none" };
}

export function providerEnv(row: ProviderRow, secrets: SecretBox): Record<string, string> | undefined {
	if (!row.env_enc) return undefined;
	try {
		return JSON.parse(secrets.open(row.env_enc)) as Record<string, string>;
	} catch {
		return undefined;
	}
}

export function providerHeaders(row: ProviderRow, secrets: SecretBox): Record<string, string> {
	if (!row.headers_enc) return {};
	try {
		return JSON.parse(secrets.open(row.headers_enc)) as Record<string, string>;
	} catch {
		return {};
	}
}

export class DbCredentialStore implements CredentialStore {
	readonly #db: AppDb;
	readonly #secrets: SecretBox;
	constructor(db: AppDb, secrets: SecretBox) {
		this.#db = db;
		this.#secrets = secrets;
	}
	async read(providerId: string): Promise<Credential | undefined> {
		const row = this.#db.get<ProviderRow>("SELECT * FROM model_providers WHERE id = ?", providerId);
		if (!row) return undefined;
		const k = providerKey(row, this.#secrets);
		const env = providerEnv(row, this.#secrets);
		if (!k.key && !env) return undefined;
		return { type: "api_key", ...(k.key ? { key: k.key } : {}), ...(env ? { env } : {}) };
	}
	async list(): Promise<readonly CredentialInfo[]> {
		return this.#db
			.all<ProviderRow>("SELECT * FROM model_providers WHERE api_key_enc IS NOT NULL OR api_key_env IS NOT NULL")
			.map((r) => ({ providerId: r.id, type: "api_key" as const }));
	}
	/** Serialized by SQLite (single writer); used only by pi login flows, which Workroom does not offer (admins enter keys in the UI). */
	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		const next = await fn(await this.read(providerId));
		if (!next) return this.read(providerId);
		if (next.type !== "api_key") throw new Error("Workroom stores API-key credentials only");
		const row = this.#db.get<ProviderRow>("SELECT id FROM model_providers WHERE id = ?", providerId);
		if (!row) throw new Error(`unknown provider ${providerId}`);
		if (next.key) this.#db.run("UPDATE model_providers SET api_key_enc = ?, key_hint = ?, updated_at = ? WHERE id = ?", this.#secrets.seal(next.key), next.key.length <= 8 ? "****" : `****${next.key.slice(-4)}`, new Date().toISOString(), providerId);
		return next;
	}
	async delete(providerId: string): Promise<void> {
		this.#db.run("UPDATE model_providers SET api_key_enc = NULL, key_hint = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), providerId);
	}
}

export class DbModelsStore implements ModelsStore {
	readonly #db: AppDb;
	constructor(db: AppDb) {
		this.#db = db;
	}
	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const r = this.#db.get<{ entry: string }>("SELECT entry FROM model_catalog WHERE provider_id = ?", providerId);
		return r ? json<ModelsStoreEntry | undefined>(r.entry, undefined) : undefined;
	}
	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.#db.run("INSERT INTO model_catalog (provider_id, entry, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET entry = excluded.entry, updated_at = excluded.updated_at", providerId, JSON.stringify(entry), new Date().toISOString());
	}
	async delete(providerId: string): Promise<void> {
		this.#db.run("DELETE FROM model_catalog WHERE provider_id = ?", providerId);
	}
}
