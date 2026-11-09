// Worker thread: rasterizes PDF pages (unpdf + @napi-rs/canvas) for OCR, so page rendering never blocks the main event loop.
// Protocol: {op:"open", sid, bytes} → {sid, ok}; {op:"render", sid, page, scale} → {sid, ok, png}; {op:"close", sid}.
import { parentPort } from "node:worker_threads";

const docs = new Map<number, any>();
parentPort!.on("message", async (m: { op: string; sid: number; rid?: number; bytes?: Uint8Array; page?: number; scale?: number }) => {
	try {
		const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
		if (m.op === "open") {
			docs.set(m.sid, await getDocumentProxy(new Uint8Array(m.bytes!)));
			parentPort!.postMessage({ sid: m.sid, rid: m.rid, ok: true });
		} else if (m.op === "render") {
			const pdf = docs.get(m.sid);
			if (!pdf) throw new Error("document not open");
			const png = await renderPageAsImage(pdf, m.page!, { canvasImport: () => import("@napi-rs/canvas"), scale: m.scale ?? 2 });
			parentPort!.postMessage({ sid: m.sid, rid: m.rid, ok: true, png }, [png.buffer as ArrayBuffer]);
		} else if (m.op === "close") {
			await docs.get(m.sid)?.destroy?.().catch?.(() => {});
			docs.delete(m.sid);
			parentPort!.postMessage({ sid: m.sid, rid: m.rid, ok: true });
		}
	} catch (e) {
		parentPort!.postMessage({ sid: m.sid, rid: m.rid, ok: false, error: (e as Error).message ?? String(e) });
	}
});
