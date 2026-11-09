// Size/mime for attachments that only carry {fileId, versionId, name} (message bubbles after a reload).
// Looked up lazily from GET /files/:id and cached; a failed lookup just means the card shows no size.
import { useEffect, useState } from "react";
import type { FileDetailResponse } from "@shared/files";
import { get } from "@/lib/api";

export interface FileMeta {
	size?: number;
	mime?: string;
	versionNo?: number;
	unavailable?: boolean;
}
const cache = new Map<string, FileMeta>();
const inflight = new Map<string, Promise<FileMeta>>();

export const rememberFile = (fileId: string, versionId: string, m: FileMeta) => {
	cache.set(`${fileId}/${versionId}`, { ...cache.get(`${fileId}/${versionId}`), ...m });
};

export function useFileMeta(fileId: string, versionId: string): FileMeta | undefined {
	const key = `${fileId}/${versionId}`;
	const [meta, setMeta] = useState<FileMeta | undefined>(() => cache.get(key));
	useEffect(() => {
		const hit = cache.get(key);
		if (hit?.size !== undefined || hit?.unavailable) {
			setMeta(hit);
			return;
		}
		let live = true;
		let p = inflight.get(key);
		if (!p) {
			p = get<FileDetailResponse>(`/files/${encodeURIComponent(fileId)}`)
				.then((d) => {
					const v = d.versions.find((x) => x.versionId === versionId);
					const m: FileMeta = v ? { size: v.size, mime: v.mime, versionNo: v.versionNo } : { unavailable: true };
					cache.set(key, m);
					return m;
				})
				.catch(() => {
					const m: FileMeta = { unavailable: true };
					cache.set(key, m);
					return m;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, p);
		}
		void p.then((m) => live && setMeta(m));
		return () => {
			live = false;
		};
	}, [key, fileId, versionId]);
	return meta;
}
