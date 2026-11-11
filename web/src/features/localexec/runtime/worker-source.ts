// Round 11 (R4): source text of the Worker that runs user code inside the sandboxed iframe (see frame.ts). A plain string on purpose:
// it is handed to `new Blob([...])` in the iframe and must not depend on any bundler helper.
// Contract (same as the cloud wrapper in server/src/tools/localexec/service.ts): the JavaScript is the body of an async function with
// `files` (read / write / list) and `console`; `return` reports a JSON-able value; a thrown error is the code's own failure.
export const WORKER_SOURCE = String.raw`
(function () {
"use strict";
const post = self.postMessage.bind(self);
// Messages to the iframe carry this token; user code runs in the same global but cannot see this closure.
const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
try { self.postMessage = undefined; } catch (e) {}
// Defence in depth on top of the CSP (connect-src 'none'): APIs that CSP does not govern (WebRTC) are removed before any user code runs.
for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "RTCSessionDescription"]) { try { delete self[k]; } catch (e) {} try { self[k] = undefined; } catch (e) {} }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const enc = new TextEncoder();
const dec = new TextDecoder();
const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\/work(?=\/|$)/, "").split("/").filter((s) => s && s !== ".").join("/");
let stderrExtra = "";
self.addEventListener("unhandledrejection", (e) => { stderrExtra += "Unhandled rejection: " + String(e.reason && e.reason.stack ? e.reason.stack : e.reason) + "\n"; });

self.onmessage = async (ev) => {
  const m = ev.data;
  if (!m || m.type !== "run") return;
  const { code, inputs, limits } = m;
  const t0 = Date.now();
  const inMap = new Map(inputs.map((i) => [clean(i.path), new Uint8Array(i.buffer)]));
  const outMap = new Map();
  let outBytes = 0;
  const out = [];
  const err = [];
  let outLen = 0;
  let truncated = false;
  const add = (arr, a) => {
    if (truncated) return;
    const s = a.map((x) => { if (typeof x === "string") return x; try { return typeof x === "object" && x !== null ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } }).join(" ") + "\n";
    outLen += s.length;
    if (outLen > limits.maxOutputChars) { truncated = true; arr.push("…（输出过长，已截断）\n"); return; }
    arr.push(s);
  };
  const con = { log: (...a) => add(out, a), info: (...a) => add(out, a), debug: (...a) => add(out, a), warn: (...a) => add(err, a), error: (...a) => add(err, a), trace: (...a) => add(err, a) };
  const files = {
    async read(p, encoding) {
      const k = clean(p);
      const b = outMap.get(k) || inMap.get(k);
      if (!b) throw new Error("file not available in the browser runtime: " + p + " (list it in inputs)");
      return encoding === "bytes" ? new Uint8Array(b) : dec.decode(b);
    },
    async write(p, data) {
      const k = clean(p);
      if (!k) throw new Error("empty path");
      const b = typeof data === "string" ? enc.encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : null;
      if (!b) throw new Error("files.write expects a string, Uint8Array or ArrayBuffer");
      const prev = outMap.get(k);
      if (!prev && outMap.size >= limits.maxOutputFiles) throw new Error("too many output files (max " + limits.maxOutputFiles + ")");
      if (outBytes - (prev ? prev.length : 0) + b.length > limits.maxOutputBytes) throw new Error("output files too large (max " + Math.round(limits.maxOutputBytes / 1048576) + " MB)");
      outBytes += b.length - (prev ? prev.length : 0);
      outMap.set(k, b);
    },
    async list() { return [...new Set([...inMap.keys(), ...outMap.keys()])]; },
  };
  post({ type: "started", token });
  let ok = true;
  let value;
  let error;
  try {
    value = await new AsyncFunction("files", "console", code)(files, con);
  } catch (e) {
    ok = false;
    const msg = e && e.stack ? String(e.stack) : String(e);
    const name = e && e.name;
    const text = String(e && e.message ? e.message : e);
    let kind = "error";
    if (name === "ReferenceError" && /\b(require|process|Buffer|__dirname|__filename|module|exports|global)\b is not defined/.test(text)) kind = "unsupported";
    else if (/Cannot find module|Failed to resolve module|Failed to fetch dynamically imported|Importing a module script failed/.test(text)) kind = "unsupported";
    else if (name === "RangeError" && /(allocation failed|Invalid (typed )?array length|out of memory|Invalid string length)/i.test(text)) kind = "oom";
    else if (/out of memory/i.test(text)) kind = "oom";
    err.push(msg + "\n");
    error = { kind, message: text.slice(0, 500) };
  }
  let returnValue;
  if (ok && value !== undefined) { try { returnValue = JSON.stringify(value); } catch (e) { returnValue = String(value); } if (returnValue === undefined) returnValue = String(value); }
  await new Promise((r) => setTimeout(r, 0)); // let pending unhandledrejection events fire
  const outFiles = ok ? [...outMap.entries()].map(([path, b]) => ({ path, buffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })) : [];
  post({ type: "done", token, ok, stdout: out.join(""), stderr: err.join("") + stderrExtra, returnValue, error, durationMs: Date.now() - t0, files: outFiles }, outFiles.map((f) => f.buffer));
};
post({ type: "ready", token });
})();
`;
