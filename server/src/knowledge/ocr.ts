// Offline OCR: tesseract.js (WASM, runs in a worker thread) with language data shipped as npm packages
// (@tesseract.js-data/chi_sim + eng, "best_int" models), copied into <dataDir>/ocr/lang on first use. Nothing is fetched
// from the network: langPath is local and the WASM core resolves from node_modules.
// Scanned PDF pages are rasterized with unpdf.renderPageAsImage + @napi-rs/canvas before OCR.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface OcrEngine {
	readonly id: string;
	recognize(image: Uint8Array): Promise<string>;
	close(): Promise<void>;
}

const LANGS = ["chi_sim", "eng"] as const;
const IDLE_MS = 60_000;
const require = createRequire(import.meta.url);

/** Tesseract inserts spaces between CJK characters; remove them (keep spaces next to Latin/digits). */
export function normalizeOcrText(s: string): string {
	return s
		.replace(/(?<=[\p{Script=Han}，。、；：？！（）《》“”])[ \t]+(?=[\p{Script=Han}，。、；：？！（）《》“”])/gu, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

export function ocrSupport(): { ok: true } | { ok: false; missing: string } {
	for (const m of ["tesseract.js/package.json", "@tesseract.js-data/chi_sim/package.json", "@tesseract.js-data/eng/package.json"]) {
		try {
			require.resolve(m);
		} catch {
			return { ok: false, missing: m.replace("/package.json", "") };
		}
	}
	return { ok: true };
}

export class TesseractOcr implements OcrEngine {
	readonly id = `tesseract.js(${LANGS.join("+")})`;
	readonly #dir: string;
	#worker: Promise<any> | null = null;
	#idle: NodeJS.Timeout | undefined;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		this.#dir = join(dataDir, "ocr");
	}

	#langDir(): string {
		const dir = join(this.#dir, "lang");
		mkdirSync(dir, { recursive: true });
		for (const l of LANGS) {
			const dst = join(dir, `${l}.traineddata.gz`);
			if (!existsSync(dst)) copyFileSync(join(dirname(require.resolve(`@tesseract.js-data/${l}/package.json`)), "4.0.0_best_int", `${l}.traineddata.gz`), dst);
		}
		return dir;
	}

	async #get(): Promise<any> {
		if (!this.#worker) {
			this.#worker = (async () => {
				const { createWorker } = await import("tesseract.js");
				return createWorker(LANGS.join("+"), 1, { langPath: this.#langDir(), cachePath: join(this.#dir, "cache"), cacheMethod: "none", gzip: true, logger: () => {}, errorHandler: () => {} });
			})();
			this.#worker.catch(() => (this.#worker = null));
		}
		return this.#worker;
	}

	recognize(image: Uint8Array): Promise<string> {
		// One recognition at a time on the single worker; terminate after idling to free WASM memory.
		const run = this.#chain.then(async () => {
			clearTimeout(this.#idle);
			const w = await this.#get();
			try {
				const r = await w.recognize(Buffer.from(image));
				return normalizeOcrText(String(r.data.text ?? ""));
			} finally {
				this.#idle = setTimeout(() => void this.close(), IDLE_MS);
				this.#idle.unref?.();
			}
		});
		this.#chain = run.catch(() => {});
		return run;
	}

	async close(): Promise<void> {
		clearTimeout(this.#idle);
		const w = this.#worker;
		this.#worker = null;
		if (w) await (await w.catch(() => null))?.terminate().catch(() => {});
	}
}
