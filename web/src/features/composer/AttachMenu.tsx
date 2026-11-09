// The "+" button at the left of the composer: 上传文件 · 从文件库选择 · 引用知识库 · 使用技能 (only when skills exist).
// Dropdown on desktop, bottom sheet on phones.
import { BookOpen, Folders, Paperclip, Plus, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useMedia } from "@/lib/prefs";
import { BottomSheet, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "@/components/ui/overlay";

export interface AttachActions {
	upload: () => void;
	library: () => void;
	kb: () => void;
	skill?: () => void;
}

export function AttachMenu({ actions, disabled }: { actions: AttachActions; disabled?: boolean }) {
	const phone = useMedia("(max-width: 639px)");
	const [open, setOpen] = useState(false);
	const rows: { id: string; icon: ReactNode; label: string; hint: string; run: () => void }[] = [
		{ id: "upload", icon: <Paperclip />, label: "上传文件", hint: "从这台设备选择，也可以直接拖进来或粘贴图片", run: actions.upload },
		{ id: "library", icon: <Folders />, label: "从文件库选择", hint: "附加已有文件的最新版本", run: actions.library },
		{ id: "kb", icon: <BookOpen />, label: "引用知识库", hint: "把知识库作为本条消息的资料", run: actions.kb },
		...(actions.skill ? [{ id: "skill", icon: <Sparkles />, label: "使用技能", hint: "让助手按已启用的技能完成任务", run: actions.skill }] : []),
	];
	const trigger = (
		<button
			type="button"
			aria-label="添加"
			data-testid="attach-menu"
			disabled={disabled}
			onClick={phone ? () => setOpen(true) : undefined}
			className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
		>
			<Plus className="size-[19px]" />
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
							className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-surface-2 [&_svg]:size-5 [&_svg]:text-fg-muted"
						>
							{r.icon}
							<span>
								<span className="block text-[15px]">{r.label}</span>
								<span className="block text-xs text-fg-subtle">{r.hint}</span>
							</span>
						</button>
					))}
				</BottomSheet>
			</>
		);
	return (
		<Menu open={open} onOpenChange={setOpen}>
			<Tip label="添加文件或知识">
				<MenuTrigger asChild>{trigger}</MenuTrigger>
			</Tip>
			<MenuContent side="top" align="start" className="w-64">
				<MenuLabel>添加到本条消息</MenuLabel>
				{rows.map((r) => (
					<MenuItem key={r.id} data-testid={`attach-${r.id}`} onSelect={r.run}>
						{r.icon}
						{r.label}
					</MenuItem>
				))}
			</MenuContent>
		</Menu>
	);
}
