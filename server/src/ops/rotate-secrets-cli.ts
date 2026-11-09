// Rotate WORKROOM_SECRET_KEY for a STOPPED server. Keys are read from environment variables, never argv:
//   WORKROOM_OLD_SECRET_KEY=<current> WORKROOM_NEW_SECRET_KEY=<new> \
//     node --disable-warning=ExperimentalWarning server/src/ops/rotate-secrets-cli.ts <dataDir> [--dry-run] [--seal-plaintext-totp] [--force]
// Then start the server with WORKROOM_SECRET_KEY=<new>. Take a backup first (server/src/ops/backup-cli.ts).
import { resolve } from "node:path";
import { rotateSecrets } from "./rotate-secrets.ts";

const dir = process.argv[2];
const flags = new Set(process.argv.slice(3));
if (!dir || dir.startsWith("--")) {
	console.error("usage: WORKROOM_OLD_SECRET_KEY=… WORKROOM_NEW_SECRET_KEY=… rotate-secrets-cli.ts <dataDir> [--dry-run] [--seal-plaintext-totp] [--force]");
	process.exit(2);
}
try {
	const r = await rotateSecrets(resolve(dir), process.env.WORKROOM_OLD_SECRET_KEY ?? "", process.env.WORKROOM_NEW_SECRET_KEY ?? "", { dryRun: flags.has("--dry-run"), sealPlaintextTotp: flags.has("--seal-plaintext-totp"), force: flags.has("--force") });
	for (const c of r.columns) console.log(`${c.table}.${c.col}: rotated ${c.rotated}, already on new key ${c.alreadyNew}${c.skipped ? ` (skipped: ${c.skipped})` : ""}`);
	if (r.sealedPlaintextTotp) console.log(`sealed ${r.sealedPlaintextTotp} plaintext TOTP seed(s)`);
	console.log(r.dryRun ? `dry run: ${r.total} value(s) would be rotated; nothing written` : `ok: ${r.total} value(s) re-encrypted and verified; start the server with the new WORKROOM_SECRET_KEY`);
} catch (e) {
	console.error(`error: ${(e as Error).message}`);
	process.exitCode = 1;
}
