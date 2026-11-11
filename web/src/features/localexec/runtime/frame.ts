// Round 11 (R4): the browser execution runtime. User code runs ONLY inside a sandboxed iframe whose document is built here:
//   <iframe sandbox="allow-scripts">  — NO allow-same-origin → opaque origin: no cookies, no storage, no access to the Workroom page or its API
//   CSP  default-src 'none'  → connect-src 'none' (fetch / XHR / WebSocket / EventSource / beacons all blocked), no images, frames or styles;
//        script-src 'unsafe-inline' 'unsafe-eval' (the iframe's own bootstrap + the user code's `new Function`), worker-src blob:
//   The code runs in a Worker created by the iframe (inherits the CSP); the parent kills the iframe on timeout (hard stop).
// The parent talks to the iframe by postMessage only, checking `source` and the opaque origin ("null") and a per-run nonce.
import type { LocalExecLanguage } from "@shared/localexec";
import { PY_WORKER_SOURCE } from "./python-worker-source";
import { WORKER_SOURCE } from "./worker-source";

export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:";
/** Python frame: additionally `blob:` scripts (the worker imports the Pyodide modules it was handed as blobs). Still connect-src 'none' (default-src 'none'). */
export const PY_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:";

const FRAME_SCRIPT = String.raw`
(function () {
  var parentWin = window.parent;
  var worker = null;
  var nonce = "";
  var token = "";
  function send(msg, transfer) { msg.nonce = nonce; parentWin.postMessage(msg, "*", transfer || []); }
  window.addEventListener("message", function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "run" && !worker) {
      nonce = String(m.nonce);
      var url = URL.createObjectURL(new Blob([m.workerSource], { type: "text/javascript" }));
      try { worker = new Worker(url); } catch (e) { send({ type: "crash", kind: "unsupported", message: "Worker is not available: " + String(e && e.message || e) }); return; }
      worker.onmessage = function (e) {
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "ready" && !token) {
          token = String(d.token);
          var transfer = m.inputs.map(function (i) { return i.buffer; });
          if (m.assets) for (var k in m.assets) transfer.push(m.assets[k]);
          worker.postMessage({ type: "run", code: m.code, inputs: m.inputs, limits: m.limits, assets: m.assets }, transfer);
          return;
        }
        if (d.token !== token) return;
        if (d.type === "started") { send({ type: "started" }); return; }
        if (d.type === "crash") { send({ type: "crash", kind: d.kind, message: d.message }); return; }
        if (d.type === "done") { delete d.token; send(d, (d.files || []).map(function (f) { return f.buffer; })); }
      };
      worker.onerror = function (e) { if (e.preventDefault) e.preventDefault(); send({ type: "crash", kind: "oom", message: String((e && e.message) || "worker crashed") }); };
    } else if (m.type === "kill" && worker) { worker.terminate(); worker = null; }
  });
  parentWin.postMessage({ type: "frame-ready" }, "*");
})();
`;

export const frameHtml = (csp: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${FRAME_SCRIPT}</script></body></html>`;
export const FRAME_HTML = frameHtml(FRAME_CSP);

export interface RunRequest {
	language: LocalExecLanguage;
	code: string;
	timeoutSec: number;
	inputs: { path: string; data: ArrayBuffer }[];
	limits: { maxOutputChars: number; maxOutputFiles: number; maxOutputBytes: number };
}
export interface RunOutcome {
	ok: boolean;
	stdout: string;
	stderr: string;
	returnValue?: string;
	durationMs: number;
	error?: { kind: "timeout" | "oom" | "unsupported" | "error"; message: string };
	files: { path: string; data: Uint8Array }[];
}
export interface RunHandle {
	promise: Promise<RunOutcome>;
	/** Stops the run (kills the iframe); the promise then resolves with an `error` outcome of kind "error" / "cancelled". */
	cancel: () => void;
}

/** Whether this browser can host the runtime (iframe sandbox + Worker + Blob URLs). */
export function runtimeSupported(): boolean {
	try {
		return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function" && "sandbox" in document.createElement("iframe") && typeof crypto?.getRandomValues === "function";
	} catch {
		return false;
	}
}

const STARTUP_MS = 5000;
/** Pyodide boots a ~10 MB wasm module: its own, longer start allowance (the run's timeout only starts once the code starts). */
const PY_BOOT_MS = 45000;
const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

export function startRun(req: RunRequest): RunHandle {
	let cancelFn: () => void = () => {};
	const python = req.language === "python";
	const promise = new Promise<RunOutcome>((resolve) => {
		const t0 = Date.now();
		const nonce = rnd();
		const iframe = document.createElement("iframe");
		iframe.setAttribute("sandbox", "allow-scripts"); // deliberately NOT allow-same-origin
		iframe.setAttribute("aria-hidden", "true");
		iframe.setAttribute("data-testid", "localexec-frame");
		iframe.setAttribute("data-language", req.language);
		iframe.tabIndex = -1;
		iframe.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px";
		let done = false;
		let started = false;
		let sent = false;
		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		let hardTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (o: RunOutcome) => {
			if (done) return;
			done = true;
			clearTimeout(startupTimer);
			clearTimeout(hardTimer);
			window.removeEventListener("message", onMessage);
			try {
				iframe.contentWindow?.postMessage({ type: "kill" }, "*");
			} catch {
				/* gone already */
			}
			iframe.remove(); // removing the frame ends the worker whatever it is doing
			resolve(o);
		};
		const fail = (kind: NonNullable<RunOutcome["error"]>["kind"], message: string) => finish({ ok: false, stdout: "", stderr: "", durationMs: Date.now() - t0, error: { kind, message }, files: [] });
		cancelFn = () => fail("error", "cancelled");
		const sendRun = async () => {
			let assets: Record<string, ArrayBuffer> | undefined;
			if (python) {
				try {
					assets = await (await import("./python-assets")).loadPythonAssets();
				} catch (e) {
					return fail("unsupported", `Python 运行环境不可用：${String((e as Error)?.message ?? e).slice(0, 200)}`);
				}
			}
			if (done) return;
			const transfer: Transferable[] = req.inputs.map((i) => i.data);
			if (assets) transfer.push(...Object.values(assets));
			iframe.contentWindow!.postMessage({ type: "run", nonce, workerSource: python ? PY_WORKER_SOURCE : WORKER_SOURCE, code: req.code, inputs: req.inputs.map((i) => ({ path: i.path, buffer: i.data })), limits: req.limits, ...(assets ? { assets } : {}) }, "*", transfer);
		};
		const onMessage = (ev: MessageEvent) => {
			// Only the iframe we created, with an opaque origin, and (after the handshake) our nonce.
			if (ev.source !== iframe.contentWindow || ev.origin !== "null") return;
			const d = ev.data as Record<string, any> | null;
			if (!d || typeof d !== "object") return;
			if (d.type === "frame-ready" && !sent) {
				sent = true;
				clearTimeout(startupTimer);
				startupTimer = setTimeout(() => fail("unsupported", "浏览器隔离环境没有启动"), python ? PY_BOOT_MS : STARTUP_MS);
				void sendRun();
				return;
			}
			if (d.nonce !== nonce) return;
			if (d.type === "started" && !started) {
				// The run's own clock starts when the user's code starts (after the Python runtime has booted), never later.
				started = true;
				clearTimeout(startupTimer);
				hardTimer = setTimeout(() => fail("timeout", `运行超过 ${req.timeoutSec} 秒`), req.timeoutSec * 1000);
				return;
			}
			if (d.type === "crash") return fail(d.kind === "unsupported" ? "unsupported" : "oom", String(d.message ?? "").slice(0, 300));
			if (d.type === "done") {
				const files = Array.isArray(d.files) ? d.files.filter((f: any) => typeof f?.path === "string" && f.buffer instanceof ArrayBuffer).map((f: any) => ({ path: String(f.path), data: new Uint8Array(f.buffer) })) : [];
				const e = d.error && typeof d.error === "object" ? { kind: (["oom", "unsupported", "error"].includes(d.error.kind) ? d.error.kind : "error") as "oom" | "unsupported" | "error", message: String(d.error.message ?? "").slice(0, 500) } : undefined;
				finish({ ok: d.ok === true, stdout: String(d.stdout ?? ""), stderr: String(d.stderr ?? ""), ...(typeof d.returnValue === "string" ? { returnValue: d.returnValue } : {}), durationMs: Number(d.durationMs) || Date.now() - t0, ...(e ? { error: e } : {}), files });
			}
		};
		window.addEventListener("message", onMessage);
		startupTimer = setTimeout(() => fail("unsupported", "浏览器隔离环境没有启动"), STARTUP_MS);
		iframe.srcdoc = frameHtml(python ? PY_FRAME_CSP : FRAME_CSP);
		document.body.appendChild(iframe);
	});
	return { promise, cancel: () => cancelFn() };
}
