// Multipart upload to POST /api/files with real per-file progress (fetch cannot report upload progress, XHR can).
import type { FileUploadResponse } from "@shared/files";
import { ApiError } from "@/lib/api";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export function uploadFile(
	file: File,
	opts: { spaceId?: string; projectId?: string; conversationId?: number; onProgress?: (pct: number) => void; signal?: AbortSignal; idempotencyKey?: string },
): Promise<FileUploadResponse> {
	return new Promise((resolve, reject) => {
		const fd = new FormData();
		fd.set("file", file);
		if (opts.projectId) fd.set("projectId", opts.projectId);
		else if (opts.spaceId) fd.set("spaceId", opts.spaceId);
		if (opts.conversationId !== undefined) fd.set("conversationId", String(opts.conversationId));
		const xhr = new XMLHttpRequest();
		xhr.open("POST", "/api/files");
		xhr.withCredentials = true;
		if (opts.idempotencyKey) xhr.setRequestHeader("idempotency-key", opts.idempotencyKey);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) opts.onProgress?.(Math.min(99, (e.loaded / e.total) * 100));
		};
		xhr.onload = () => {
			let body: unknown;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				body = undefined;
			}
			if (xhr.status >= 200 && xhr.status < 300 && body) {
				opts.onProgress?.(100);
				resolve(body as FileUploadResponse);
				return;
			}
			const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
			reject(new ApiError(xhr.status, err?.code ?? `http_${xhr.status}`, err?.message ?? (xhr.status === 413 ? "文件太大" : xhr.statusText || "上传失败"), undefined, xhr.status === 404 || xhr.status === 502 || xhr.status === 503));
		};
		xhr.onerror = () => reject(new ApiError(0, "network", "网络中断，无法上传", undefined, true));
		xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
		opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(fd);
	});
}
