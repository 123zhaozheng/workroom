// Offline OCR: tesseract.js (WASM, runs in a worker thread) with language data shipped as npm packages
// (@tesseract.js-data/chi_sim + eng, "best_int" models), copied into <dataDir>/ocr/lang on first use. Nothing is fetched
// from the network: langPath is local and the WASM core resolves from node_modules.
// Scanned PDF pages are rasterized with unpdf.renderPageAsImage + @napi-rs/canvas before OCR.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export interface PdfRasterSession {
	render(page: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

export interface OcrEngine {
	readonly id: string;
	recognize(image: Uint8Array): Promise<string>;
	/** Rasterize PDF pages off the main thread (optional; parsers fall back to in-process rendering). */
	rasterize?(pdf: Uint8Array): Promise<PdfRasterSession>;
	close(): Promise<void>;
}

/** One worker thread (render-worker.ts) shared by all jobs; requests are matched by id; terminated when idle. */
export class PdfRasterizer {
	#worker: Worker | null = null;
	#pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	#seq = 0;
	#sessions = 0;
	#idle: NodeJS.Timeout | undefined;

	#get(): Worker {
		clearTimeout(this.#idle);
		if (!this.#worker) {
			const w = new Worker(new URL("./render-worker.ts", import.meta.url));
			w.unref();
			w.on("message", (m: { rid: number; ok: boolean; error?: string }) => {
				const p = this.#pending.get(m.rid);
				this.#pending.delete(m.rid);
				if (m.ok) p?.resolve(m);
				else p?.reject(new Error(m.error ?? "render failed"));
			});
			const fail = (e: Error) => {
				for (const p of this.#pending.values()) p.reject(e);
				this.#pending.clear();
				this.#worker = null;
			};
			w.on("error", fail);
			w.on("exit", (code) => code !== 0 && fail(new Error(`render worker exited with ${code}`)));
			this.#worker = w;
		}
		return this.#worker;
	}
	#call(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<any> {
		const rid = ++this.#seq;
		const w = this.#get();
		return new Promise((resolve, reject) => {
			this.#pending.set(rid, { resolve, reject });
			w.postMessage({ ...msg, rid }, transfer);
		});
	}
	async open(pdf: Uint8Array): Promise<PdfRasterSession> {
		const sid = ++this.#seq;
		const copy = new Uint8Array(pdf); // transferred to the worker
		await this.#call({ op: "open", sid, bytes: copy }, [copy.buffer as ArrayBuffer]);
		this.#sessions++;
		let closed = false;
		return {
			render: async (page: number) => new Uint8Array((await this.#call({ op: "render", sid, page, scale: 2 })).png),
			close: async () => {
				if (closed) return;
				closed = true;
				await this.#call({ op: "close", sid }).catch(() => {});
				if (--this.#sessions === 0) {
					this.#idle = setTimeout(() => void this.close(), IDLE_MS);
					this.#idle.unref?.();
				}
			},
		};
	}
	/** True when a render worker thread is currently alive (tests/ops). */
	get running(): boolean {
		return !!this.#worker;
	}
	async close(): Promise<void> {
		clearTimeout(this.#idle);
		const w = this.#worker;
		this.#worker = null;
		await w?.terminate();
	}
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
	readonly rasterizer = new PdfRasterizer();
	rasterize(pdf: Uint8Array): Promise<PdfRasterSession> {
		return this.rasterizer.open(pdf);
	}
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
		await this.rasterizer.close();
	}
}
