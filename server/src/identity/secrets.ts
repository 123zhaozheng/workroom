// At-rest encryption for credentials (model API keys, OIDC client secrets, TOTP seeds, webhook secrets).
// AES-256-GCM with a key derived from WORKROOM_SECRET_KEY (config.secretKey). Format: "v1:<iv b64>:<tag b64>:<ct b64>".
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { HttpError } from "../core/http.ts";

const keyCache = new Map<string, Buffer>();
function deriveKey(secret: string): Buffer {
	let k = keyCache.get(secret);
	if (!k) {
		// Fixed, versioned salt: the secret itself must carry the entropy (documented in docs/operations.md).
		k = scryptSync(secret, "workroom-secrets-v1", 32);
		keyCache.set(secret, k);
	}
	return k;
}

export class SecretBox {
	readonly #secret: string | undefined;
	constructor(secret: string | undefined) {
		this.#secret = secret && secret.length > 0 ? secret : undefined;
	}
	get available(): boolean {
		return this.#secret !== undefined;
	}
	/** Throws 409 secret_key_missing when no WORKROOM_SECRET_KEY is configured: we never store credentials in plaintext. */
	seal(plaintext: string): string {
		if (!this.#secret) throw new HttpError(409, "secret_key_missing", "服务器未配置 WORKROOM_SECRET_KEY，拒绝存储凭据（可改用环境变量凭据）");
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", deriveKey(this.#secret), iv);
		const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
		return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
	}
	open(sealed: string): string {
		if (!this.#secret) throw new HttpError(409, "secret_key_missing", "服务器未配置 WORKROOM_SECRET_KEY，无法解密已存储凭据");
		const [v, iv, tag, ct] = sealed.split(":");
		if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("bad sealed secret");
		const d = createDecipheriv("aes-256-gcm", deriveKey(this.#secret), Buffer.from(iv, "base64"));
		d.setAuthTag(Buffer.from(tag, "base64"));
		return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
	}
}

/** Non-reversible display hint for a secret: last 4 chars. */
export const secretHint = (s: string): string => (s.length <= 8 ? "****" : `****${s.slice(-4)}`);
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
