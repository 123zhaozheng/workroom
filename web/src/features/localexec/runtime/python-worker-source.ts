// Round 11 (R4): Worker source for Python via Pyodide, served from OUR origin (npm package `pyodide`, copied into the build, no CDN).
// The parent fetches the Pyodide files and hands them into the iframe, which hands them to this worker: the worker (whose CSP is
// connect-src 'none') never needs the network. A fetch shim answers the loader's few URLs from memory and is removed again before user code runs;
// every other fetch is the native one, which the CSP blocks. Only the Python standard library is available (npm ships no extra packages:
// numpy / pandas and friends are NOT here → ModuleNotFoundError → reported as "unsupported" → the run is retried in the cloud).
export const PY_WORKER_SOURCE = String.raw`
(function () {
"use strict";
const post = self.postMessage.bind(self);
const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
try { self.postMessage = undefined; } catch (e) {}
const nativeFetch = self.fetch ? self.fetch.bind(self) : undefined;
const enc = new TextEncoder();
const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\/work(?=\/|$)/, "").split("/").filter((s) => s && s !== ".").join("/");
const INDEX = "https://pyodide.invalid/";
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

self.onmessage = async (ev) => {
  const m = ev.data;
  if (!m || m.type !== "run") return;
  const { code, inputs, limits, assets } = m;
  const t0 = Date.now();
  const out = [];
  const err = [];
  let outLen = 0;
  let truncated = false;
  const sink = (arr) => (line) => { if (truncated) return; outLen += line.length + 1; if (outLen > limits.maxOutputChars) { truncated = true; arr.push("…（输出过长，已截断）\n"); return; } arr.push(line + "\n"); };
  const finish = (ok, extra) => post(Object.assign({ type: "done", token, ok, stdout: out.join(""), stderr: err.join(""), durationMs: Date.now() - t0, files: [] }, extra || {}), (extra && extra.files ? extra.files.map((f) => f.buffer) : []));
  let py;
  try {
    const blobUrl = (buf) => URL.createObjectURL(new Blob([buf], { type: "text/javascript" }));
    const mod = await import(blobUrl(assets.loader));
    const asm = await import(blobUrl(assets.asm));
    const table = new Map([
      [INDEX + "pyodide.asm.wasm", { buf: assets.wasm, type: "application/wasm" }],
      [INDEX + "python_stdlib.zip", { buf: assets.stdlib, type: "application/zip" }],
      [INDEX + "pyodide-lock.json", { buf: assets.lock, type: "application/json" }],
    ]);
    // Answer the loader's own URLs from memory; anything else goes to the native fetch (blocked by the CSP).
    self.fetch = (u, init) => {
      const key = typeof u === "string" ? u : u && u.url ? u.url : String(u);
      const hit = table.get(key);
      return hit ? Promise.resolve(new Response(hit.buf.slice(0), { headers: { "content-type": hit.type } })) : nativeFetch(u, init);
    };
    try {
      py = await mod.loadPyodide({ indexURL: INDEX, lockFileContents: new TextDecoder().decode(assets.lock), createPyodideModule: asm.default, stdout: sink(out), stderr: sink(err), packages: [] });
    } finally {
      if (nativeFetch) self.fetch = nativeFetch; // user code sees the native (CSP-blocked) fetch again
    }
  } catch (e) {
    return post({ type: "crash", token, kind: "unsupported", message: "Python runtime could not start: " + String(e && e.message ? e.message : e).slice(0, 300) });
  }
  post({ type: "started", token });
  const before = new Map();
  let ok = true;
  let error;
  try {
    py.FS.mkdirTree("/work");
    for (const i of inputs) {
      const k = clean(i.path);
      const dir = k.includes("/") ? "/work/" + k.slice(0, k.lastIndexOf("/")) : "/work";
      py.FS.mkdirTree(dir);
      const bytes = new Uint8Array(i.buffer);
      py.FS.writeFile("/work/" + k, bytes);
      before.set(k, bytes);
    }
    py.FS.chdir("/work");
    await py.runPythonAsync(code);
  } catch (e) {
    ok = false;
    const text = String(e && e.message ? e.message : e);
    let kind = "error";
    if (/ModuleNotFoundError|ImportError|No module named/.test(text)) kind = "unsupported";
    else if (/MemoryError|out of memory|Out of memory/i.test(text)) kind = "oom";
    else if (/ProxyError|NetworkError|Failed to fetch|OSError: Pyodide cannot|not supported in the Pyodide|WebAssembly/.test(text)) kind = "error";
    err.push(text.replace(/\n?$/, "\n"));
    error = { kind, message: text.split("\n").filter(Boolean).slice(-1)[0].slice(0, 500) };
  }
  const files = [];
  if (ok) {
    let bytes = 0;
    const walk = (dir, rel) => {
      for (const name of py.FS.readdir(dir)) {
        if (name === "." || name === ".." || name === "__pycache__") continue;
        const full = dir + "/" + name;
        const r = rel ? rel + "/" + name : name;
        const st = py.FS.stat(full);
        if (py.FS.isDir(st.mode)) walk(full, r);
        else if (py.FS.isFile(st.mode)) {
          const data = py.FS.readFile(full);
          const prev = before.get(r);
          if (prev && same(prev, data)) continue; // unchanged input
          bytes += data.length;
          if (files.length >= limits.maxOutputFiles || bytes > limits.maxOutputBytes) { ok = false; error = { kind: "error", message: "too many or too large output files" }; err.push("output files exceed the limits\n"); return; }
          files.push({ path: r, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
        }
      }
    };
    try { walk("/work", ""); } catch (e) { ok = false; error = { kind: "error", message: String(e && e.message ? e.message : e).slice(0, 300) }; }
  }
  finish(ok, { error, files: ok ? files : [] });
};
post({ type: "ready", token });
})();
`;
