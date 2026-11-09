import type { AttachmentRef } from "@shared/chat";
import { FileTile } from "@/components/file/FileTile";
import { fileKind } from "@/components/file/kinds";
import { usePanel } from "@/components/shell/panel";
import { useFileMeta } from "@/features/composer/fileMeta";

/** An attachment on a sent user message: the same card as in the composer; click opens the right-side preview. */
export function MessageAttachment({ a }: { a: AttachmentRef }) {
	const meta = useFileMeta(a.fileId, a.versionId);
	const { openPreview } = usePanel();
	const isImage = fileKind(a.name, meta?.mime) === "image";
	return (
		<FileTile
			testId="message-attachment"
			name={a.name}
			size={meta?.size}
			mime={meta?.mime}
			thumbUrl={isImage && !meta?.unavailable ? `/api/files/${a.fileId}/versions/${a.versionId}/download` : undefined}
			note={meta?.unavailable ? "文件已不可用" : undefined}
			onOpen={() => openPreview({ fileId: a.fileId, versionId: a.versionId, name: a.name, mime: meta?.mime })}
		/>
	);
}
