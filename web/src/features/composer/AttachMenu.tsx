// The "+" button at the left of the composer: 上传文件 · 从文件库选择 · 引用知识库 · 使用技能 (only when skills exist).
// Dropdown on desktop, bottom sheet on phones.
import { BookOpen, Folders, Paperclip, Plus, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useMedia } from "@/lib/prefs";
import { BottomSheet, Menu, MenuContent, MenuItem, MenuTrigger, Tip } from "@/components/ui/overlay";

export interface AttachActions {
	upload: () => void;
	library: () => void;
	kb: () => void;
	skill?: () => void;
}

export function AttachMenu({ actions, disabled, side = "top" }: { actions: AttachActions; disabled?: boolean; side?: "top" | "bottom" }) {
	const phone = useMedia("(max-width: 639px)");
	const [open, setOpen] = useState(false);
	// one line each: the label says what it does
	const rows: { id: string; icon: ReactNode; label: string; run: () => void }[] = [
		{ id: "upload", icon: <Paperclip />, label: "上传文件", run: actions.upload },
		{ id: "library", icon: <Folders />, label: "从文件库选择", run: actions.library },
		{ id: "kb", icon: <BookOpen />, label: "引用知识库", run: actions.kb },
		...(actions.skill ? [{ id: "skill", icon: <Sparkles />, label: "使用技能", run: actions.skill }] : []),
	];
	const trigger = (
		<button
			type="button"
			aria-label="添加"
			data-testid="attach-menu"
			disabled={disabled}
			onClick={phone ? () => setOpen(true) : undefined}
			className="flex size-10 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:size-9"
		>
			<Plus aria-hidden className="size-5" />
		</button>
	);
	if (phone)
		return (
			<>
				{trigger}
				<BottomSheet open={open} onOpenChange={setOpen} title="添加到本条消息">
					{rows.map((r) => (
						<button
							key={r.id}
							type="button"
							data-testid={`attach-${r.id}`}
							onClick={() => {
								setOpen(false);
								// let the sheet unmount before a picker dialog / file chooser opens
								setTimeout(r.run, 60);
							}}
							className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left active:bg-surface-2 [&_svg]:size-5 [&_svg]:text-fg-muted"
						>
							{r.icon}
							<span>
								<span className="block text-base">{r.label}</span>
							</span>
						</button>
					))}
				</BottomSheet>
			</>
		);
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<Tip label="添加文件、知识库或技能">
				<MenuTrigger asChild>{trigger}</MenuTrigger>
			</Tip>
			<MenuContent side={side} align="start" className="w-64">
				{rows.map((r) => (
					<MenuItem key={r.id} data-testid={`attach-${r.id}`} onSelect={r.run} className="py-2">
						{r.icon}
						<span className="min-w-0">
							<span className="block">{r.label}</span>
						</span>
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}
