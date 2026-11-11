// Round 11 (R4): the Pyodide files, served from OUR origin (the `pyodide` npm package; Vite copies them into the build as hashed assets).
// Loaded lazily (only when Python runs in the browser) and kept in memory; each run gets its own copies (they are transferred into the iframe).
import loaderUrl from "pyodide/pyodide.mjs?url";
import asmUrl from "pyodide/pyodide.asm.mjs?url";
import wasmUrl from "pyodide/pyodide.asm.wasm?url";
import stdlibUrl from "pyodide/python_stdlib.zip?url";
import lockUrl from "pyodide/pyodide-lock.json?url";

let cache: Promise<Record<"loader" | "asm" | "wasm" | "stdlib" | "lock", ArrayBuffer>> | undefined;

async function get(url: string): Promise<ArrayBuffer> {
	// Same-origin, from the app's own build. Never a CDN.
	const res = await fetch(url, { credentials: "same-origin" });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.arrayBuffer();
}

/** Fresh copies of the Pyodide files for one run (the iframe takes ownership of the buffers). */
export async function loadPythonAssets(): Promise<Record<string, ArrayBuffer>> {
	cache ??= Promise.all([get(loaderUrl), get(asmUrl), get(wasmUrl), get(stdlibUrl), get(lockUrl)]).then(([loader, asm, wasm, stdlib, lock]) => ({ loader, asm, wasm, stdlib, lock }));
	try {
		const a = await cache;
		return { loader: a.loader.slice(0), asm: a.asm.slice(0), wasm: a.wasm.slice(0), stdlib: a.stdlib.slice(0), lock: a.lock.slice(0) };
	} catch (e) {
		cache = undefined;
		throw e;
	}
}
