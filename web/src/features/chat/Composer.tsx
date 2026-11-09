// The single input box. Files and knowledge are referenced as small chips (attach menu or "/" slash menu).
// While a run is working the send button becomes 插话 (steer) and a stop button appears.
import { ArrowUp, BookOpen, FileText, Folders, Loader2, Paperclip, Plus, Square, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AttachmentRef, KnowledgeRef, SendMode } from "@shared/chat";
import type { FileUploadResponse } from "@shared/files";
import { errorText, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip } from "@/components/ui/overlay";
import { FilePickerDialog, KbPickerDialog } from "./pickers";

export interface ComposerSubmit {
	text: string;
	attachments: AttachmentRef[];
	knowledgeRefs: KnowledgeRef[];
	mode: SendMode;
}

interface Props {
	onSubmit: (v: ComposerSubmit) => Promise<boolean>;
	/** Run is working: send = steer, show stop. */
	busy?: boolean;
	onStop?: () => void;
	stopping?: boolean;
	spaceId?: string;
	projectId?: string;
	placeholder?: string;
	autoFocus?: boolean;
	variant?: "home" | "chat";
	footer?: ReactNode;
	disabled?: boolean;
	disabledReason?: string;
	/** Text pushed in from outside (starter suggestions). */
	seed?: { text: string; n: number };
}

type Chip = { kind: "file"; ref: AttachmentRef; uploading?: boolean; error?: string } | { kind: "kb"; ref: KnowledgeRef };

const SLASH_ITEMS = [
	{ id: "kb", label: "引用知识库", hint: "把知识库作为本条消息的资料", icon: BookOpen },
	{ id: "file", label: "引用文件库中的文件", hint: "附加已有文件的某个版本", icon: Folders },
	{ id: "upload", label: "上传文件", hint: "上传后作为附件", icon: Upload },
] as const;

export function Composer({ onSubmit, busy, onStop, stopping, spaceId, projectId, placeholder, autoFocus, variant = "chat", footer, disabled, disabledReason, seed }: Props) {
	const [text, setText] = useState("");
	const [chips, setChips] = useState<Chip[]>([]);
	const [sending, setSending] = useState(false);
	const [err, setErr] = useState<string>();
	const [steerMode, setSteerMode] = useState<"steer" | "followUp">("steer");
	const [picker, setPicker] = useState<"kb" | "file" | null>(null);
	const [slash, setSlash] = useState<{ open: boolean; index: number }>({ open: false, index: 0 });
	const ta = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const composing = useRef(false);

	useEffect(() => {
		if (seed && seed.n > 0) {
			setText(seed.text);
			ta.current?.focus();
		}
	}, [seed]);

	// autosize
	useEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, variant === "home" ? 260 : 220)}px`;
	}, [text, variant]);

	const uploading = chips.some((c) => c.kind === "file" && c.uploading);
	const canSend = !disabled && !sending && !uploading && (text.trim().length > 0 || chips.length > 0);

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setErr(undefined);
		const v: ComposerSubmit = {
			text: text.trim(),
			attachments: chips.flatMap((c) => (c.kind === "file" && !c.error ? [c.ref] : [])),
			knowledgeRefs: chips.flatMap((c) => (c.kind === "kb" ? [c.ref] : [])),
			mode: busy ? steerMode : "auto",
		};
		try {
			const ok = await onSubmit(v);
			if (ok) {
				setText("");
				setChips([]);
			}
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setSending(false);
			ta.current?.focus();
		}
	};

	const upload = async (files: FileList | null) => {
		if (!files?.length) return;
		for (const f of Array.from(files)) {
			const tmpId = `tmp-${Math.random()}`;
			setChips((c) => [...c, { kind: "file", ref: { fileId: tmpId, versionId: "", name: f.name }, uploading: true }]);
			const fd = new FormData();
			fd.set("file", f);
			if (projectId) fd.set("projectId", projectId);
			else if (spaceId) fd.set("spaceId", spaceId);
			try {
				const r = await post<FileUploadResponse>("/files", fd);
				setChips((c) => c.map((x) => (x.kind === "file" && x.ref.fileId === tmpId ? { kind: "file", ref: { fileId: r.file.id, versionId: r.version.versionId, name: r.file.name } } : x)));
			} catch (e) {
				setChips((c) => c.map((x) => (x.kind === "file" && x.ref.fileId === tmpId ? { ...x, uploading: false, error: errorText(e) } : x)));
			}
		}
		if (fileInput.current) fileInput.current.value = "";
	};

	const runSlash = (id: (typeof SLASH_ITEMS)[number]["id"]) => {
		setSlash({ open: false, index: 0 });
		setText((t) => t.replace(/(^|\s)\/[^\s]*$/, "$1"));
		if (id === "upload") fileInput.current?.click();
		else setPicker(id);
	};

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (slash.open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const d = e.key === "ArrowDown" ? 1 : -1;
				setSlash((s) => ({ ...s, index: (s.index + d + SLASH_ITEMS.length) % SLASH_ITEMS.length }));
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				runSlash(SLASH_ITEMS[slash.index]!.id);
				return;
			}
			if (e.key === "Escape") {
				setSlash({ open: false, index: 0 });
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void send();
		}
		if (e.key === "Backspace" && text === "" && chips.length) setChips((c) => c.slice(0, -1));
	};

	const onChange = (v: string) => {
		setText(v);
		const m = /(^|\s)\/([^\s]*)$/.exec(v);
		setSlash((s) => ({ open: !!m && (m[2] ?? "").length < 8, index: m ? s.index : 0 }));
	};

	const addChip = (c: Chip) =>
		setChips((cs) => (cs.some((x) => x.kind === c.kind && (x.kind === "kb" ? x.ref.kbId === (c.ref as KnowledgeRef).kbId && x.ref.docId === (c.ref as KnowledgeRef).docId : x.ref.versionId === (c.ref as AttachmentRef).versionId)) ? cs : [...cs, c]));

	return (
		<div className="relative">
			{slash.open ? (
				<div role="listbox" aria-label="斜杠菜单" data-testid="slash-menu" className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-border bg-surface p-1 shadow-pop wr-fade-in">
					<div className="px-2.5 pb-1 pt-1.5 text-xs text-fg-subtle">插入引用</div>
					{SLASH_ITEMS.map((it, i) => (
						<button
							key={it.id}
							role="option"
							aria-selected={i === slash.index}
							onMouseDown={(e) => {
								e.preventDefault();
								runSlash(it.id);
							}}
							className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left", i === slash.index ? "bg-surface-2" : "hover:bg-surface-2")}
						>
							<it.icon className="mt-0.5 size-4 text-fg-muted" />
							<span>
								<span className="block text-sm">{it.label}</span>
								<span className="block text-xs text-fg-subtle">{it.hint}</span>
							</span>
						</button>
					))}
				</div>
			) : null}
			<div
				data-testid="composer"
				className={cn(
					"rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors focus-within:border-border-strong",
					variant === "home" ? "px-3 pb-2.5 pt-3" : "px-3 pb-2 pt-2.5",
				)}
			>
				{chips.length ? (
					<div className="mb-2 flex flex-wrap gap-1.5" aria-label="已引用">
						{chips.map((c, i) => (
							<span
								key={i}
								data-testid={c.kind === "kb" ? "chip-kb" : "chip-file"}
								title={c.kind === "file" && c.error ? c.error : undefined}
								className={cn(
									"inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-lg border px-2 text-[12.5px]",
									c.kind === "file" && c.error ? "border-danger/40 bg-danger-soft text-danger" : "border-border bg-surface-2 text-fg",
								)}
							>
								{c.kind === "kb" ? <BookOpen className="size-3.5 shrink-0 text-fg-muted" /> : c.kind === "file" && c.uploading ? <Loader2 className="size-3.5 shrink-0 wr-spin" /> : <FileText className="size-3.5 shrink-0 text-fg-muted" />}
								<span className="truncate">{c.ref.name}</span>
								{c.kind === "file" && c.error ? <span className="shrink-0">上传失败</span> : null}
								<button aria-label={`移除 ${c.ref.name}`} onClick={() => setChips((cs) => cs.filter((_, j) => j !== i))} className="-mr-1 rounded p-0.5 text-fg-subtle hover:text-fg">
									<X className="size-3" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					ref={ta}
					data-testid="composer-input"
					aria-label="输入消息"
					autoFocus={autoFocus}
					rows={variant === "home" ? 2 : 1}
					value={text}
					disabled={disabled}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKey}
					onCompositionStart={() => (composing.current = true)}
					onCompositionEnd={() => (composing.current = false)}
					onBlur={() => setTimeout(() => setSlash({ open: false, index: 0 }), 120)}
					placeholder={disabled ? disabledReason : (placeholder ?? (busy ? "补充说明或调整方向（插话），回车发送" : "说说要完成的事，输入 / 引用资料"))}
					className="block max-h-[260px] w-full resize-none bg-transparent px-1 text-[15px] leading-6 text-fg outline-none placeholder:text-fg-subtle"
				/>
				<div className="mt-2 flex items-center gap-1">
					<input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} data-testid="file-input" />
					<Menu>
						<Tip label="添加文件或知识">
							<MenuTrigger asChild>
								<button aria-label="添加" data-testid="attach-menu" className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-2 hover:text-fg" disabled={disabled}>
									<Plus className="size-[18px]" />
								</button>
							</MenuTrigger>
						</Tip>
						<MenuContent side="top" align="start">
							<MenuLabel>添加到本条消息</MenuLabel>
							<MenuItem onSelect={() => fileInput.current?.click()}>
								<Paperclip />
								上传文件
							</MenuItem>
							<MenuItem onSelect={() => setPicker("file")}>
								<Folders />
								从文件库选择
							</MenuItem>
							<MenuItem onSelect={() => setPicker("kb")}>
								<BookOpen />
								引用知识库
							</MenuItem>
						</MenuContent>
					</Menu>
					{busy ? (
						<div className="ml-1 flex items-center rounded-lg bg-surface-2 p-0.5 text-[12px]" role="radiogroup" aria-label="运行中发送方式">
							{(["steer", "followUp"] as const).map((m) => (
								<button
									key={m}
									role="radio"
									aria-checked={steerMode === m}
									onClick={() => setSteerMode(m)}
									className={cn("h-6 rounded-md px-2", steerMode === m ? "bg-surface text-fg shadow-sm" : "text-fg-muted")}
									title={m === "steer" ? "在当前任务的下一个步骤间隙加入" : "等当前任务结束后再处理"}
								>
									{m === "steer" ? "插话" : "稍后处理"}
								</button>
							))}
						</div>
					) : null}
					<div className="min-w-0 flex-1 truncate px-1 text-xs text-fg-subtle">{footer}</div>
					{busy && onStop ? (
						<Tip label="停止">
							<button data-testid="stop" aria-label="停止" onClick={onStop} disabled={stopping} className="flex size-8 items-center justify-center rounded-lg border border-border text-fg hover:bg-surface-2">
								{stopping ? <Loader2 className="size-4 wr-spin" /> : <Square className="size-3.5 fill-current" />}
							</button>
						</Tip>
					) : null}
					<Tip label={busy ? (steerMode === "steer" ? "插话" : "加入队列") : "发送"}>
						<button
							data-testid="send"
							aria-label={busy ? "插话" : "发送"}
							onClick={() => void send()}
							disabled={!canSend}
							className={cn("flex size-8 items-center justify-center rounded-lg transition-colors", canSend ? "bg-accent text-accent-fg hover:opacity-90" : "bg-surface-3 text-fg-subtle")}
						>
							{sending ? <Loader2 className="size-4 wr-spin" /> : <ArrowUp className="size-[18px]" />}
						</button>
					</Tip>
				</div>
			</div>
			{err ? (
				<p role="alert" className="mt-1.5 px-1 text-[13px] text-danger">
					{err}
				</p>
			) : null}
			<FilePickerDialog open={picker === "file"} onOpenChange={(o) => !o && setPicker(null)} spaceId={spaceId} projectId={projectId} onPick={(ref) => addChip({ kind: "file", ref })} />
			<KbPickerDialog open={picker === "kb"} onOpenChange={(o) => !o && setPicker(null)} onPick={(ref) => addChip({ kind: "kb", ref })} />
		</div>
	);
}
