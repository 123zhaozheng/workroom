// 文件库. Wide screens: app sidebar · file list · detail panel (preview, versions, share, add to knowledge) — `/files/:fileId` is the
// same screen with that file open, so deep links keep working. Phones and tablets: the list is a page, a file is its own page.
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { usePanel } from "@/components/shell/panel";
import { TopBar, useShell } from "@/components/shell/AppShell";
import { Page, PageHeader } from "@/components/ui/misc";
import { Notice } from "@/features/work/states";
import { FileFilters, FileRows, UploadButton, UploadError, useFileLibrary, type FileLibrary } from "@/features/files/FileList";
import { SplitLayout } from "@/features/files/SplitLayout";
import { FileDetailView } from "./FileDetailPage";

export { ORIGIN } from "@/features/files/origin";

export default function FilesPage() {
	const { fileId } = useParams();
	const { wide } = useShell();
	const lib = useFileLibrary();
	const { openPreview } = usePanel();
	const navigate = useNavigate();
	const hidden = <input ref={lib.input} type="file" multiple hidden onChange={(e) => void lib.upload(e.target.files)} data-testid="files-input" />;
	const keep = lib.projectId ? `?projectId=${encodeURIComponent(lib.projectId)}` : "";

	if (!wide) {
		if (fileId) return <FileDetailView key={fileId} fileId={fileId} />;
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<TopBar />
				<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
					<Page wide>
						<PageHeader
							title="文件库"
							actions={
								<>
									{hidden}
									<UploadButton lib={lib} />
								</>
							}
						/>
						<FileFilters lib={lib} />
						<UploadError lib={lib} />
						<FileRows lib={lib} onPreview={(f) => openPreview({ fileId: f.id, versionId: f.latestVersionId, name: f.name, mime: f.mime })} />
					</Page>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<TopBar />
			<SplitLayout
				label="文件列表"
				list={<ListColumn lib={lib} selectedId={fileId} hidden={hidden} onOpen={(id) => navigate(`/files/${id}${keep}`)} />}
				detail={fileId ? <FileDetailView key={fileId} fileId={fileId} embedded onClose={() => navigate(`/files${keep}`)} onChanged={lib.files.reload} /> : (lib.files.data?.files.length ? <Notice icon={<FileText />} title="选择一个文件查看预览" testid="files-no-selection" /> : null)}
			/>
		</div>
	);
}

function ListColumn({ lib, selectedId, hidden, onOpen }: { lib: FileLibrary; selectedId?: string; hidden: ReactNode; onOpen: (id: string) => void }) {
	return (
		<>
			<div className="flex h-12 shrink-0 items-center gap-2 px-4">
				<h2 className="flex-1 text-base font-semibold tracking-tight">文件库</h2>
				{hidden}
				<UploadButton lib={lib} />
			</div>
			<FileFilters lib={lib} split />
			<UploadError lib={lib} />
			<div className="wr-scroll min-h-0 flex-1 overflow-y-auto">
				<FileRows lib={lib} selectedId={selectedId} split onPreview={(f) => onOpen(f.id)} />
			</div>
		</>
	);
}
