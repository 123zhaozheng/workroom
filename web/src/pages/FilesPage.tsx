// 文件库 = the delivered outputs (present_file), shown as conversation cards on a day timeline (features/files/Library.tsx).
// `/files` is the overview (`?g=` opens one conversation, `?view=list` is the row view). `/files/:fileId` keeps the file detail:
// wide screens show it next to the file list (preview, download, share, add to knowledge, delete), phones as its own page.
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import type { LibItemDTO } from "@shared/files";
import { usePanel } from "@/components/shell/panel";
import { TopBar, useShell } from "@/components/shell/AppShell";
import { FileRows, FileSearch, RemoveOutputDialog, useFileLibrary, type FileLibrary } from "@/features/files/FileList";
import { LibraryOverview } from "@/features/files/Library";
import { SplitLayout } from "@/features/files/SplitLayout";
import { FileDetailView } from "./FileDetailPage";

export default function FilesPage() {
	const { fileId } = useParams();
	const { wide } = useShell();
	const lib = useFileLibrary();
	const { openPreview } = usePanel();
	const navigate = useNavigate();
	const dialog = <RemoveOutputDialog lib={lib} onRemoved={(i) => i.fileId === fileId && navigate("/files")} />;
	const preview = (f: LibItemDTO) => (wide ? navigate(`/files/${f.fileId}`) : openPreview({ fileId: f.fileId, name: f.name, mime: f.mime, size: f.size, etag: f.etag }));

	if (!wide && fileId) return <FileDetailView key={fileId} fileId={fileId} />;
	if (!fileId) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<TopBar />
				<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
					<LibraryOverview lib={lib} onPreview={preview} />
				</div>
				{dialog}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<SplitLayout
				label="文件列表"
				list={<ListColumn lib={lib} selectedId={fileId} onOpen={(id) => navigate(`/files/${id}`)} />}
				detail={<FileDetailView key={fileId} fileId={fileId} embedded onClose={() => navigate("/files")} onChanged={lib.items.reload} />}
			/>
			{dialog}
		</div>
	);
}

function ListColumn({ lib, selectedId, onOpen }: { lib: FileLibrary; selectedId?: string; onOpen: (id: string) => void }): ReactNode {
	return (
		<>
			<div className="flex h-12 shrink-0 items-center gap-2 px-4">
				<h2 className="flex-1 text-base font-semibold tracking-tight">文件库</h2>
			</div>
			<FileSearch lib={lib} split />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<FileRows lib={lib} selectedId={selectedId} split onPreview={(f) => onOpen(f.fileId)} />
			</div>
		</>
	);
}
