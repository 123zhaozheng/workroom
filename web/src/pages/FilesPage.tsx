// 文件库 = the delivered outputs (present_file), grouped by the conversation folder. Wide screens: app sidebar · output list · detail
// panel (preview, download, share, add to knowledge, delete) — `/files/:fileId` is the same screen with that file open, so deep links
// keep working. Phones and tablets: the list is a page, a file is its own page.
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { usePanel } from "@/components/shell/panel";
import { TopBar, useShell } from "@/components/shell/AppShell";
import { Page, PageHeader } from "@/components/ui/misc";
import { Notice } from "@/features/work/states";
import { FileRows, FileSearch, RemoveOutputDialog, useFileLibrary, type FileLibrary } from "@/features/files/FileList";
import { SplitLayout } from "@/features/files/SplitLayout";
import { FileDetailView } from "./FileDetailPage";

export default function FilesPage() {
	const { fileId } = useParams();
	const { wide } = useShell();
	const lib = useFileLibrary();
	const { openPreview } = usePanel();
	const navigate = useNavigate();
	const dialog = <RemoveOutputDialog lib={lib} onRemoved={(i) => i.fileId === fileId && navigate("/files")} />;

	if (!wide) {
		if (fileId) return <FileDetailView key={fileId} fileId={fileId} />;
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<TopBar />
				<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
					<Page wide>
						<PageHeader title="文件库" />
						<FileSearch lib={lib} />
						<FileRows lib={lib} onPreview={(f) => openPreview({ fileId: f.fileId, name: f.name, mime: f.mime, size: f.size, etag: f.etag })} />
					</Page>
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
				detail={fileId ? <FileDetailView key={fileId} fileId={fileId} embedded onClose={() => navigate("/files")} onChanged={lib.items.reload} /> : lib.count ? <Notice icon={<FileText />} title="选择一个文件查看预览" testid="files-no-selection" /> : null}
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
