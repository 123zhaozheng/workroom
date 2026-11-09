// Content-addressed local blob store (sha256). Blobs are immutable; file versions reference them.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BlobStore {
	put(bytes: Uint8Array): { sha256: string; size: number };
	get(sha256: string): Uint8Array | null;
	has(sha256: string): boolean;
	path(sha256: string): string;
}

export class LocalBlobStore implements BlobStore {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
	}
	path(sha256: string): string {
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("bad blob id");
		return join(this.root, sha256.slice(0, 2), sha256);
	}
	put(bytes: Uint8Array): { sha256: string; size: number } {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const p = this.path(sha256);
		if (!existsSync(p)) {
			mkdirSync(join(this.root, sha256.slice(0, 2)), { recursive: true });
			const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(tmp, bytes);
			renameSync(tmp, p);
		}
		return { sha256, size: bytes.byteLength };
	}
	get(sha256: string): Uint8Array | null {
		const p = this.path(sha256);
		return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
	}
	has(sha256: string): boolean {
		const p = this.path(sha256);
		return existsSync(p) && statSync(p).isFile();
	}
}
