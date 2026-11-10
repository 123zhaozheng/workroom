// Attachment state for one composer: local uploads (with progress / retry / remove) and files picked from the library.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRef } from "@shared/chat";
import { errorText, uuid } from "@/lib/api";
import { fileKind } from "@/components/file/kinds";
import { MAX_UPLOAD_BYTES, uploadFile } from "./upload";
import { rememberFile } from "./fileMeta";

export interface Attachment {
	key: string;
	name: string;
	size?: number;
	mime?: string;
	/** local object URL (images) while the file is on this device */
	thumb?: string;
	status: "uploading" | "ready" | "failed";
	progress: number;
	error?: string;
	ref?: AttachmentRef;
	source: "upload" | "library";
}

export const MAX_FILES = 10;
const CONCURRENCY = 3;

export function useAttachments(scope: { spaceId?: string; projectId?: string; conversationId?: number }) {
	const [items, setItems] = useState<Attachment[]>([]);
	const [notice, setNotice] = useState<string>();
	const files = useRef(new Map<string, File>());
	const aborts = useRef(new Map<string, AbortController>());
	const queue = useRef<string[]>([]);
	const running = useRef(0);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const thumbs = useRef(new Set<string>());

	const patch = useCallback((key: string, p: Partial<Attachment>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x))), []);

	const pump = useCallback(() => {
		while (running.current < CONCURRENCY && queue.current.length) {
			const key = queue.current.shift()!;
			const file = files.current.get(key);
			if (!file) continue;
			running.current++;
			const ac = new AbortController();
			aborts.current.set(key, ac);
			patch(key, { status: "uploading", progress: 0, error: undefined });
			uploadFile(file, { ...scopeRef.current, signal: ac.signal, idempotencyKey: key, onProgress: (pct) => patch(key, { progress: pct }) })
				.then((r) => {
					rememberFile(r.file.id, r.version.versionId, { size: r.version.size, mime: r.version.mime, versionNo: r.version.versionNo });
					patch(key, { status: "ready", progress: 100, size: r.version.size, mime: r.version.mime, ref: { fileId: r.file.id, versionId: r.version.versionId, name: r.file.name } });
					files.current.delete(key);
				})
				.catch((e) => {
					if ((e as Error)?.name === "AbortError") return;
					patch(key, { status: "failed", error: errorText(e) });
				})
				.finally(() => {
					aborts.current.delete(key);
					running.current--;
					pump();
				});
		}
	}, [patch]);

	const add = useCallback(
		(list: File[]) => {
			setNotice(undefined);
			const room = MAX_FILES - itemsRef.current.length;
			const take = list.slice(0, Math.max(0, room));
			if (list.length > take.length) setNotice(`一条消息最多附加 ${MAX_FILES} 个文件，已忽略多出的 ${list.length - take.length} 个`);
			const next: Attachment[] = take.map((f) => {
				const key = uuid();
				files.current.set(key, f);
				const tooBig = f.size > MAX_UPLOAD_BYTES;
				let thumb: string | undefined;
				if (fileKind(f.name, f.type) === "image") {
					thumb = URL.createObjectURL(f);
					thumbs.current.add(thumb);
				}
				if (!tooBig) queue.current.push(key);
				return { key, name: f.name, size: f.size, mime: f.type || undefined, thumb, status: tooBig ? "failed" : "uploading", progress: 0, error: tooBig ? `超过 ${MAX_UPLOAD_BYTES / 1048576} MB 上限` : undefined, source: "upload" as const };
			});
			if (!next.length) return;
			setItems((xs) => [...xs, ...next]);
			pump();
		},
		[pump],
	);

	const addRef = useCallback((ref: AttachmentRef, meta?: { size?: number; mime?: string }) => {
		setItems((xs) => (xs.some((x) => x.ref?.versionId === ref.versionId) ? xs : [...xs, { key: uuid(), name: ref.name, size: meta?.size, mime: meta?.mime, status: "ready", progress: 100, ref, source: "library" }]));
		if (meta) rememberFile(ref.fileId, ref.versionId, meta);
	}, []);

	const revoke = (x: Attachment | undefined) => {
		if (x?.thumb && thumbs.current.delete(x.thumb)) URL.revokeObjectURL(x.thumb);
	};

	const remove = useCallback((key: string) => {
		aborts.current.get(key)?.abort();
		queue.current = queue.current.filter((k) => k !== key);
		files.current.delete(key);
		setItems((xs) => {
			revoke(xs.find((x) => x.key === key));
			return xs.filter((x) => x.key !== key);
		});
	}, []);

	const retry = useCallback(
		(key: string) => {
			if (!files.current.has(key)) return;
			patch(key, { status: "uploading", progress: 0, error: undefined });
			queue.current.push(key);
			pump();
		},
		[patch, pump],
	);

	const clear = useCallback(() => {
		for (const ac of aborts.current.values()) ac.abort();
		queue.current = [];
		files.current.clear();
		setItems((xs) => {
			xs.forEach(revoke);
			return [];
		});
		setNotice(undefined);
	}, []);

	useEffect(
		() => () => {
			for (const ac of aborts.current.values()) ac.abort();
			for (const u of thumbs.current) URL.revokeObjectURL(u);
		},
		[],
	);

	return { items, notice, add, addRef, remove, retry, clear, uploading: items.some((x) => x.status === "uploading"), failed: items.some((x) => x.status === "failed") };
}
