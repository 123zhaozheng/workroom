// Usage:
//   node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts backup  <dataDir> <destDir> [--include-sandbox]
//   node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts verify  <backupDir>
//   node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts restore <backupDir> <emptyDataDir>
import { resolve } from "node:path";
import { backupDataDir, restoreBackup, verifyBackup } from "./backup.ts";

const [cmd, a, b] = process.argv.slice(2);
try {
	if (cmd === "backup" && a && b) {
		const m = await backupDataDir(resolve(a), resolve(b), { includeSandbox: process.argv.includes("--include-sandbox") });
		console.log(`backup ok: ${m.files.length} files → ${resolve(b)} (${m.files.filter((f) => f.kind === "durable").length} space storages)`);
	} else if (cmd === "verify" && a) {
		const v = verifyBackup(resolve(a));
		console.log(v.ok ? `verify ok: ${v.checked} files` : `verify FAILED:\n${v.problems.join("\n")}`);
		process.exitCode = v.ok ? 0 : 1;
	} else if (cmd === "restore" && a && b) {
		restoreBackup(resolve(a), resolve(b));
		console.log(`restored into ${resolve(b)} — start the server with WORKROOM_DATA_DIR=${resolve(b)}`);
	} else {
		console.error("usage: backup <dataDir> <destDir> [--include-sandbox] | verify <backupDir> | restore <backupDir> <emptyDataDir>");
		process.exitCode = 2;
	}
} catch (e) {
	console.error(`error: ${(e as Error).message}`);
	process.exitCode = 1;
}
