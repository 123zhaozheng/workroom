// Re-encrypt every stored secret from an old WORKROOM_SECRET_KEY to a new one, in ONE exclusive SQLite transaction,
// verified before commit (every new ciphertext is decrypted with the new key and compared to the plaintext).
// Idempotent: a value that already opens with the new key is left alone (a re-run after success changes nothing).
// Covered columns (two codecs, each module's own format):
//   E identity SecretBox ("v1:iv:tag:ct", scrypt-derived key): ops_channels.api_key_enc, ops_notify_channels.secret_enc,
//     id_oidc_providers.client_secret_enc, id_users.totp_secret / totp_pending (when sealed)
//   D tools SecretBox ("v1:<b64>", HKDF key, AAD = row id): mcp_servers.secrets_enc
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SecretBox as IdentityBox } from "../identity/secrets.ts";

interface Codec {
	open(key: string, value: string, row: Record<string, unknown>): string;
	seal(key: string, plain: string, row: Record<string, unknown>): string;
	isSealed(value: string): boolean;
}

const identityCodec: Codec = {
	open: (key, v) => new IdentityBox(key).open(v),
	seal: (key, p) => new IdentityBox(key).seal(p),
	isSealed: (v) => /^v1:[^:]+:[^:]+:/.test(v),
};

async function toolsCodec(): Promise<Codec | null> {
	try {
		const { SecretBox } = await import("../tools/secrets.ts");
		return {
			open: (key, v, row) => new SecretBox(key).open(v, String(row.id)),
			seal: (key, p, row) => new SecretBox(key).seal(p, String(row.id)),
			isSealed: (v) => v.startsWith("v1:") && !v.slice(3).includes(":"),
		};
	} catch {
		return null; // tools module not installed
	}
}

export interface SecretColumn {
	table: string;
	idCol: string;
	col: string;
	codec: "identity" | "tools";
	/** Only rows matching this SQL predicate. */
	where?: string;
}

export const SECRET_COLUMNS: readonly SecretColumn[] = [
	{ table: "ops_channels", idCol: "id", col: "api_key_enc", codec: "identity" },
	// model providers (pi-ai native, round 4): API key, custom headers and provider-scoped env, all sealed with the identity SecretBox
	{ table: "model_providers", idCol: "id", col: "api_key_enc", codec: "identity" },
	{ table: "model_providers", idCol: "id", col: "headers_enc", codec: "identity" },
	{ table: "model_providers", idCol: "id", col: "env_enc", codec: "identity" },
	{ table: "ops_notify_channels", idCol: "id", col: "secret_enc", codec: "identity" },
	{ table: "id_oidc_providers", idCol: "id", col: "client_secret_enc", codec: "identity" },
	{ table: "id_users", idCol: "id", col: "totp_secret", codec: "identity", where: "totp_secret LIKE 'v1:%'" },
	{ table: "id_users", idCol: "id", col: "totp_pending", codec: "identity", where: "totp_pending LIKE 'v1:%'" },
	{ table: "mcp_servers", idCol: "id", col: "secrets_enc", codec: "tools" },
];

export interface RotationReport {
	dryRun: boolean;
	columns: { table: string; col: string; rotated: number; alreadyNew: number; skipped?: string }[];
	sealedPlaintextTotp: number;
	total: number;
}

export class RotationError extends Error {}

export async function rotateSecrets(dataDir: string, oldKey: string, newKey: string, opts: { dryRun?: boolean; sealPlaintextTotp?: boolean; force?: boolean; now?: number } = {}): Promise<RotationReport> {
	if (!oldKey || !newKey) throw new RotationError("both the old and the new secret key are required");
	if (oldKey === newKey) throw new RotationError("the new key must differ from the old key");
	if (newKey.length < 16) throw new RotationError("the new key is too short (min 16 characters; use e.g. openssl rand -base64 48)");
	const codecs: Record<string, Codec | null> = { identity: identityCodec, tools: await toolsCodec() };
	const db = new DatabaseSync(join(dataDir, "app.sqlite"));
	db.exec("PRAGMA busy_timeout = 5000;");
	const report: RotationReport = { dryRun: !!opts.dryRun, columns: [], sealedPlaintextTotp: 0, total: 0 };
	try {
		const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
		if (!opts.force && hasTable("rt_space_leases")) {
			const live = db.prepare("SELECT COUNT(*) AS n FROM rt_space_leases WHERE expires_at > ?").get(opts.now ?? Date.now()) as { n: number };
			if (live.n > 0) throw new RotationError(`a server still holds ${live.n} live space lease(s): stop the server first (or --force)`);
		}
		db.exec("BEGIN EXCLUSIVE");
		const verify: { table: string; idCol: string; col: string; id: unknown; plain: string; codec: Codec; row: Record<string, unknown> }[] = [];
		try {
			for (const c of SECRET_COLUMNS) {
				const codec = codecs[c.codec];
				if (!hasTable(c.table)) {
					report.columns.push({ table: c.table, col: c.col, rotated: 0, alreadyNew: 0, skipped: "table not present" });
					continue;
				}
				if (!codec) {
					report.columns.push({ table: c.table, col: c.col, rotated: 0, alreadyNew: 0, skipped: "codec module not installed" });
					continue;
				}
				const rows = db.prepare(`SELECT * FROM ${c.table} WHERE ${c.col} IS NOT NULL ${c.where ? `AND ${c.where}` : ""}`).all() as Record<string, unknown>[];
				const out = { table: c.table, col: c.col, rotated: 0, alreadyNew: 0 };
				for (const row of rows) {
					const v = String(row[c.col]);
					let plain: string;
					try {
						plain = codec.open(oldKey, v, row);
					} catch {
						try {
							codec.open(newKey, v, row);
							out.alreadyNew++;
							continue;
						} catch {
							throw new RotationError(`${c.table}.${c.col} row ${String(row[c.idCol])}: opens with neither the old nor the new key — wrong old key? nothing was changed`);
						}
					}
					const sealed = codec.seal(newKey, plain, row);
					db.prepare(`UPDATE ${c.table} SET ${c.col} = ? WHERE ${c.idCol} = ?`).run(sealed, row[c.idCol] as string);
					verify.push({ table: c.table, idCol: c.idCol, col: c.col, id: row[c.idCol], plain, codec, row });
					out.rotated++;
				}
				report.columns.push(out);
				report.total += out.rotated;
			}
			if (opts.sealPlaintextTotp && hasTable("id_users")) {
				for (const col of ["totp_secret", "totp_pending"]) {
					for (const row of db.prepare(`SELECT id, ${col} AS v FROM id_users WHERE ${col} IS NOT NULL AND ${col} NOT LIKE 'v1:%'`).all() as { id: string; v: string }[]) {
						const sealed = identityCodec.seal(newKey, row.v, row);
						db.prepare(`UPDATE id_users SET ${col} = ? WHERE id = ?`).run(sealed, row.id);
						verify.push({ table: "id_users", idCol: "id", col, id: row.id, plain: row.v, codec: identityCodec, row });
						report.sealedPlaintextTotp++;
					}
				}
			}
			// Verify inside the transaction: every rewritten value must open with the new key to the same plaintext.
			for (const x of verify) {
				const now = db.prepare(`SELECT ${x.col} AS v FROM ${x.table} WHERE ${x.idCol} = ?`).get(x.id as string) as { v: string };
				if (x.codec.open(newKey, now.v, x.row) !== x.plain) throw new RotationError(`verification failed for ${x.table}.${x.col} row ${String(x.id)}`);
				let oldStillOpens = false;
				try {
					x.codec.open(oldKey, now.v, x.row);
					oldStillOpens = true;
				} catch {
					/* expected */
				}
				if (oldStillOpens) throw new RotationError(`verification failed: ${x.table}.${x.col} still opens with the old key`);
			}
			db.exec(opts.dryRun ? "ROLLBACK" : "COMMIT");
		} catch (e) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw e;
		}
		return report;
	} finally {
		db.close();
	}
}
