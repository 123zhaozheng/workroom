// Secrets at rest: AES-256-GCM with a key derived from config.secretKey (WORKROOM_SECRET_KEY).
// Without a configured key, secrets are refused (never stored in plaintext). Ciphertexts are bound to their row (AAD).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { HttpError } from "../core/http.ts";

export class SecretBox {
	readonly #key: Buffer | null;
	constructor(secretKey: string | undefined) {
		this.#key = secretKey ? Buffer.from(hkdfSync("sha256", Buffer.from(secretKey, "utf8"), Buffer.from("workroom-secrets-v1"), Buffer.from("aes-256-gcm"), 32)) : null;
	}
	get available(): boolean {
		return this.#key !== null;
	}
	#need(): Buffer {
		if (!this.#key) throw new HttpError(400, "secret_storage_unavailable", "服务器未配置 WORKROOM_SECRET_KEY，无法安全保存密钥/令牌；请管理员配置后再添加带凭据的连接");
		return this.#key;
	}
	seal(plain: string, aad: string): string {
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", this.#need(), iv);
		c.setAAD(Buffer.from(aad));
		const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
		return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
	}
	/** Throws when the key is missing or changed (caller maps that to needs_reconnect). */
	open(sealed: string, aad: string): string {
		if (!sealed.startsWith("v1:")) throw new Error("unknown secret format");
		const raw = Buffer.from(sealed.slice(3), "base64");
		const d = createDecipheriv("aes-256-gcm", this.#need(), raw.subarray(0, 12));
		d.setAAD(Buffer.from(aad));
		d.setAuthTag(raw.subarray(12, 28));
		return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
	}
}
