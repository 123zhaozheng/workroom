// SecretStore: where credential plaintext is sealed. The database only ever holds the sealed form.
//
//   local          AES-256-GCM (SecretBox) with the master key from WORKROOM_SECRET_KEY or WORKROOM_SECRET_KEY_FILE.
//   vault-transit  HashiCorp Vault / OpenBao Transit engine (encrypt/decrypt over HTTPS). Implemented against the documented HTTP API;
//                  NOT verified against a real Vault in this repository (see docs/credentials.md).
//
// There is no default key and no fallback: when the selected store is not configured, `available` is false, `reason` says why, and every
// operation that needs it refuses. Nothing is ever stored unsealed, and a failed store is never silently replaced by another one.
import { lstatSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { HttpError } from "../../core/http.ts";
import { SecretBox } from "../secrets.ts";

export interface SecretStore {
	/** Stable id stored with every sealed value (credentials.store_id): a value is only opened by the store that sealed it. */
	readonly id: "local" | "vault-transit";
	readonly available: boolean;
	/** Why the store is unavailable (Chinese, shown to operators/users). Empty when available. */
	readonly reason: string;
	/** Seal `plain`, bound to `aad` (row identity + version): moving a ciphertext to another row makes `open` fail. */
	seal(plain: string, aad: string): Promise<string>;
	open(sealed: string, aad: string): Promise<string>;
}

export const UNCONFIGURED = "未配置：服务器没有配置凭据主密钥（WORKROOM_SECRET_KEY / WORKROOM_SECRET_KEY_FILE）或 Vault Transit，无法安全保存凭据";
const MIN_KEY_CHARS = 16;

const unavailable = (id: SecretStore["id"], reason: string): SecretStore => ({
	id,
	available: false,
	reason,
	seal: async () => {
		throw new HttpError(503, "secret_storage_unavailable", reason);
	},
	open: async () => {
		throw new HttpError(503, "secret_storage_unavailable", reason);
	},
});

// ---------------------------------------------------------------------------------------------- local AEAD
/** Read the master key from a file: must be a regular file (not a symlink) readable by the owner only (mode 600/400) on POSIX. */
export function readKeyFile(path: string): { key?: string; error?: string } {
	try {
		const l = lstatSync(path);
		if (l.isSymbolicLink()) return { error: `密钥文件 ${path} 是符号链接，已拒绝` };
		const st = statSync(path);
		if (!st.isFile()) return { error: `密钥文件 ${path} 不是普通文件` };
		if (platform() !== "win32" && (st.mode & 0o077) !== 0) return { error: `密钥文件 ${path} 权限过宽（${(st.mode & 0o777).toString(8)}），必须是 600 或 400` };
		const key = readFileSync(path, "utf8").replace(/\r?\n$/, "");
		return { key };
	} catch (e) {
		return { error: `无法读取密钥文件 ${path}：${(e as NodeJS.ErrnoException).code ?? "error"}` };
	}
}

export class LocalAeadSecretStore implements SecretStore {
	readonly id = "local" as const;
	readonly #box: SecretBox | null;
	readonly reason: string;
	/** `keyFile` wins over `inlineKey`. The key is read once here (at start); a later change needs a restart. */
	constructor(opts: { inlineKey?: string | undefined; keyFile?: string | undefined }) {
		let key: string | undefined;
		let reason = "";
		if (opts.keyFile) {
			const r = readKeyFile(opts.keyFile);
			if (r.error) reason = `未配置：${r.error}`;
			else key = r.key;
		} else key = opts.inlineKey;
		if (!reason && key !== undefined && key.length < MIN_KEY_CHARS) reason = `未配置：主密钥太短（至少 ${MIN_KEY_CHARS} 个字符，建议 32 字节随机值）`;
		if (!reason && !key) reason = UNCONFIGURED;
		this.reason = reason;
		this.#box = reason ? null : new SecretBox(key);
	}
	get available(): boolean {
		return this.#box !== null;
	}
	async seal(plain: string, aad: string): Promise<string> {
		if (!this.#box) throw new HttpError(503, "secret_storage_unavailable", this.reason);
		return this.#box.seal(plain, aad);
	}
	async open(sealed: string, aad: string): Promise<string> {
		if (!this.#box) throw new HttpError(503, "secret_storage_unavailable", this.reason);
		return this.#box.open(sealed, aad);
	}
}

// ---------------------------------------------------------------------------------------------- Vault / OpenBao transit
export interface VaultTransitOptions {
	addr: string;
	token: string;
	/** Transit key name (an `aes256-gcm96` key; rotation of the Vault key keeps old ciphertexts decryptable). */
	key: string;
	mount?: string;
	namespace?: string;
	/** Injectable for tests (never used to bypass TLS verification). */
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Vault Transit: POST {addr}/v1/{mount}/encrypt/{key} {plaintext: base64} → data.ciphertext ("vault:v1:…"),
 *                POST {addr}/v1/{mount}/decrypt/{key} {ciphertext}       → data.plaintext (base64).
 * AAD binding: the plaintext sent to Vault is the JSON {a: aad, p: plain}; `open` refuses a value whose `a` differs. (Vault's own `context`
 * needs a derived key, which operators cannot be assumed to have configured.) Vault only ever sees base64 of that JSON over TLS.
 * UNVERIFIED against a real Vault/OpenBao instance here: the request/response shapes follow the public API documentation.
 */
export class VaultTransitSecretStore implements SecretStore {
	readonly id = "vault-transit" as const;
	readonly available = true;
	readonly reason = "";
	readonly #o: Required<Pick<VaultTransitOptions, "addr" | "token" | "key" | "mount" | "timeoutMs">> & { namespace?: string; fetch: typeof fetch };
	constructor(o: VaultTransitOptions) {
		this.#o = { addr: o.addr.replace(/\/+$/, ""), token: o.token, key: o.key, mount: (o.mount ?? "transit").replace(/^\/+|\/+$/g, ""), timeoutMs: o.timeoutMs ?? 10_000, ...(o.namespace ? { namespace: o.namespace } : {}), fetch: o.fetch ?? fetch };
	}
	async #call(op: "encrypt" | "decrypt", body: Record<string, string>): Promise<Record<string, any>> {
		const headers: Record<string, string> = { "x-vault-token": this.#o.token, "content-type": "application/json" };
		if (this.#o.namespace) headers["x-vault-namespace"] = this.#o.namespace;
		let res: Response;
		try {
			res = await this.#o.fetch(`${this.#o.addr}/v1/${this.#o.mount}/${op}/${encodeURIComponent(this.#o.key)}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.#o.timeoutMs) });
		} catch (e) {
			throw new HttpError(503, "vault_unreachable", `无法连接 Vault Transit：${(e as Error).name}`);
		}
		if (!res.ok) throw new HttpError(res.status === 403 || res.status === 401 ? 503 : 502, "vault_error", `Vault Transit ${op} 失败（HTTP ${res.status}）`);
		const json = (await res.json().catch(() => null)) as { data?: Record<string, any> } | null;
		if (!json?.data) throw new HttpError(502, "vault_error", "Vault Transit 返回了无法识别的响应");
		return json.data;
	}
	async seal(plain: string, aad: string): Promise<string> {
		const pt = Buffer.from(JSON.stringify({ a: aad, p: plain }), "utf8").toString("base64");
		const d = await this.#call("encrypt", { plaintext: pt });
		if (typeof d.ciphertext !== "string" || !d.ciphertext.startsWith("vault:")) throw new HttpError(502, "vault_error", "Vault Transit 未返回密文");
		return `vt1:${d.ciphertext}`;
	}
	async open(sealed: string, aad: string): Promise<string> {
		if (!sealed.startsWith("vt1:")) throw new Error("unknown secret format");
		const d = await this.#call("decrypt", { ciphertext: sealed.slice(4) });
		if (typeof d.plaintext !== "string") throw new HttpError(502, "vault_error", "Vault Transit 未返回明文");
		const o = JSON.parse(Buffer.from(d.plaintext, "base64").toString("utf8")) as { a?: string; p?: string };
		if (o.a !== aad || typeof o.p !== "string") throw new Error("secret binding mismatch");
		return o.p;
	}
}

// ---------------------------------------------------------------------------------------------- selection
function readSecretFileOrEnv(env: NodeJS.ProcessEnv, name: string): { value?: string; error?: string } {
	const file = env[`${name}_FILE`];
	if (file) {
		const r = readKeyFile(file);
		return r.error ? { error: r.error } : { value: r.key ?? "" };
	}
	return env[name] ? { value: env[name]! } : {};
}

/**
 * Pick the store from the environment (WORKROOM_SECRET_STORE=local|vault-transit, default local). An unknown value or missing
 * configuration yields an UNAVAILABLE store (refusing everything), never a different store.
 *   local:          WORKROOM_SECRET_KEY_FILE (preferred, chmod 600) or WORKROOM_SECRET_KEY (config.secretKey)
 *   vault-transit:  WORKROOM_VAULT_ADDR (https), WORKROOM_VAULT_TOKEN | WORKROOM_VAULT_TOKEN_FILE, WORKROOM_VAULT_TRANSIT_KEY,
 *                   optional WORKROOM_VAULT_TRANSIT_MOUNT (default "transit"), WORKROOM_VAULT_NAMESPACE.
 *                   Plain http is accepted ONLY for a loopback address AND WORKROOM_VAULT_DEV_HTTP=1 (dev server).
 */
export function createSecretStore(opts: { env?: NodeJS.ProcessEnv; inlineKey?: string | undefined; fetch?: typeof fetch } = {}): SecretStore {
	const env = opts.env ?? process.env;
	const kind = (env.WORKROOM_SECRET_STORE ?? "local").trim() || "local";
	if (kind === "local") return new LocalAeadSecretStore({ inlineKey: opts.inlineKey ?? env.WORKROOM_SECRET_KEY, keyFile: env.WORKROOM_SECRET_KEY_FILE });
	if (kind !== "vault-transit") return unavailable("local", `未配置：WORKROOM_SECRET_STORE=${kind.slice(0, 40)} 不是受支持的值（local | vault-transit）`);
	const addr = env.WORKROOM_VAULT_ADDR?.trim();
	const key = env.WORKROOM_VAULT_TRANSIT_KEY?.trim();
	const token = readSecretFileOrEnv(env, "WORKROOM_VAULT_TOKEN");
	if (!addr || !key) return unavailable("vault-transit", "未配置：Vault Transit 需要 WORKROOM_VAULT_ADDR 与 WORKROOM_VAULT_TRANSIT_KEY");
	if (token.error) return unavailable("vault-transit", `未配置：${token.error}`);
	if (!token.value) return unavailable("vault-transit", "未配置：缺少 WORKROOM_VAULT_TOKEN / WORKROOM_VAULT_TOKEN_FILE");
	let u: URL;
	try {
		u = new URL(addr);
	} catch {
		return unavailable("vault-transit", "未配置：WORKROOM_VAULT_ADDR 不是有效地址");
	}
	const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback && env.WORKROOM_VAULT_DEV_HTTP === "1")) return unavailable("vault-transit", "未配置：Vault 地址必须是 https（仅开发用的回环地址可在 WORKROOM_VAULT_DEV_HTTP=1 时使用 http）");
	if (u.username || u.password) return unavailable("vault-transit", "未配置：Vault 地址不得包含用户名/密码");
	return new VaultTransitSecretStore({ addr: u.origin + u.pathname, token: token.value, key, mount: env.WORKROOM_VAULT_TRANSIT_MOUNT, namespace: env.WORKROOM_VAULT_NAMESPACE, fetch: opts.fetch });
}
