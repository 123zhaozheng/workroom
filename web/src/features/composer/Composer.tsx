// The one input box, shared by the home page, project page and the chat page.
//  - auto-growing textarea; Enter sends, Shift+Enter = newline, IME composition never sends; "/" opens the slash menu;
//  - "+" at the left: 上传文件 · 从文件库选择 · 引用知识库 · 使用技能; files can also be dragged anywhere on the page
//    (clear drop overlay) or pasted (images); multi-file upload with per-file progress, retry and remove;
//  - model switcher at the right (grouped, capability badges, blocked = disabled with reason) + send / stop;
//  - while a run is working, send becomes 插话 (steer) with a 稍后处理 option, and a stop button appears.
import { ArrowUp, BookOpen, Folders, Loader2, Sparkles, Square, Upload, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef, KnowledgeRef, SendMode } from "@shared/chat";
import type { ThinkingLevel } from "@shared/ops";
import { errorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/overlay";
import { FileTile, RefTile } from "@/components/file/FileTile";
import { FilePickerDialog, KbPickerDialog, SkillPickerDialog, useUsableSkills } from "@/features/chat/pickers";
import { AttachMenu } from "./AttachMenu";
import { ModelChipNote, ModelSwitcher } from "./ModelSwitcher";
import { readDefaultChoice, resolveChoice, supportsThinking, useModels, writeDefaultChoice, type ModelChoice, type ModelInfo } from "./models";
import { MAX_FILES, useAttachments } from "./useAttachments";
import { MAX_UPLOAD_BYTES } from "./upload";

export interface ComposerSubmit {
	text: string;
	attachments: AttachmentRef[];
	knowledgeRefs: KnowledgeRef[];
	mode: SendMode;
	/** Platform model chosen in the switcher (new conversations); absent when the model switcher is hidden or locked. */
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Binds the switcher to an existing conversation's actual model instead of the per-user default. */
export interface ModelBinding {
	actual?: { provider: string; modelId: string };
	label?: string;
	fixture?: boolean;
	thinking?: string;
	onSelect: (m: ModelInfo, thinking?: ThinkingLevel) => void | Promise<void>;
}

interface Props {
	onSubmit: (v: ComposerSubmit) => Promise<boolean>;
	/** Run is working: send = steer, show stop. */
	busy?: boolean;
	onStop?: () => void;
	stopping?: boolean;
	spaceId?: string;
	projectId?: string;
	conversationId?: number;
	placeholder?: string;
	autoFocus?: boolean;
	variant?: "home" | "chat";
	/** Extra controls after the "+" button (e.g. the assistant picker). */
	tools?: ReactNode;
	disabled?: boolean;
	disabledReason?: string;
	/** Text pushed in from outside (starter suggestions). */
	seed?: { text: string; n: number };
	/** Element (position: relative) that accepts dropped files; defaults to the composer itself. */
	dropScope?: RefObject<HTMLElement | null>;
	model?: ModelBinding;
	/** Model fixed by something else (e.g. an assistant's default model): the switcher is shown disabled with this text. */
	modelLocked?: string;
	hideModel?: boolean;
}

type KbChip = { ref: KnowledgeRef };

const SLASH_ITEMS = [
	{ id: "kb", label: "引用知识库", icon: BookOpen },
	{ id: "file", label: "从文件库选择", icon: Folders },
	{ id: "upload", label: "上传文件", icon: Upload },
	{ id: "skill", label: "使用技能", icon: Sparkles },
] as const;
type SlashId = (typeof SLASH_ITEMS)[number]["id"];

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function Composer({ onSubmit, busy, onStop, stopping, spaceId, projectId, conversationId, placeholder, autoFocus, variant = "chat", tools, disabled, disabledReason, seed, dropScope, model, modelLocked, hideModel }: Props) {
	const [text, setText] = useState("");
	const [kbs, setKbs] = useState<KbChip[]>([]);
	const att = useAttachments({ spaceId, projectId, conversationId });
	const [sending, setSending] = useState(false);
	const [err, setErr] = useState<string>();
	const [steerMode, setSteerMode] = useState<"steer" | "followUp">("steer");
	const [picker, setPicker] = useState<"kb" | "file" | "skill" | null>(null);
	const closePicker = (o: boolean) => {
		if (o) return;
		setPicker(null);
		// the menu item that opened the picker is gone: keyboard users land back in the message box
		setTimeout(() => {
			if (!document.activeElement || document.activeElement === document.body) ta.current?.focus();
		}, 0);
	};
	const [slash, setSlash] = useState<{ open: boolean; index: number }>({ open: false, index: 0 });
	const [dragging, setDragging] = useState(false);
	const [dropEl, setDropEl] = useState<HTMLElement | null>(null);
	const ta = useRef<HTMLTextAreaElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const row = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const skills = useUsableSkills();

	// ---- model state
	const { models, groups, defaultModelId, loading: modelsLoading, unavailable: modelsUnavailable, error: modelsError } = useModels();
	const [choice, setChoice] = useState<ModelChoice>(readDefaultChoice);
	const bound = model?.actual ? models.find((m) => m.ref && m.ref.provider === model.actual!.provider && m.ref.modelId === model.actual!.modelId) : undefined;
	const resolved = resolveChoice(models, choice, defaultModelId);
	const current = model ? bound : resolved.model;
	const thinking = model ? (model.thinking as ThinkingLevel | undefined) : resolved.thinking;
	const pickModel = (m: ModelInfo) => {
		const th = supportsThinking(m) ? (m.thinkingLevels.includes(thinking as ThinkingLevel) ? (thinking as ThinkingLevel) : m.defaultThinking) : undefined;
		const next = { id: m.id, thinking: th };
		setChoice(next);
		writeDefaultChoice(next);
		void model?.onSelect(m, th);
	};
	const pickThinking = (l: ThinkingLevel) => {
		if (!current) return;
		const next = { id: current.id, thinking: l };
		setChoice(next);
		writeDefaultChoice(next);
		void model?.onSelect(current, l);
	};

	useEffect(() => {
		if (seed && seed.n > 0) {
			setText(seed.text);
			ta.current?.focus();
		}
	}, [seed]);

	// autosize (identical on home and chat)
	useEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
	}, [text]);

	// ---- drag & drop: the whole page (dropScope) accepts files; a clear overlay shows while dragging
	const addFiles = att.add;
	useEffect(() => {
		const el = dropScope?.current ?? root.current;
		setDropEl(el ?? null);
		if (!el || disabled) return;
		let depth = 0;
		const enter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth++;
			setDragging(true);
		};
		const over = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		};
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const drop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth = 0;
			setDragging(false);
			const list = Array.from(e.dataTransfer?.files ?? []);
			if (list.length) addFiles(list);
			ta.current?.focus();
		};
		el.addEventListener("dragenter", enter);
		el.addEventListener("dragover", over);
		el.addEventListener("dragleave", leave);
		el.addEventListener("drop", drop);
		// a file dropped outside the zone must not navigate the tab to that file
		const guard = (e: DragEvent) => {
			if (hasFiles(e) && !el.contains(e.target as Node)) e.preventDefault();
		};
		window.addEventListener("dragover", guard);
		window.addEventListener("drop", guard);
		const end = () => {
			depth = 0;
			setDragging(false);
		};
		window.addEventListener("dragend", end);
		return () => {
			el.removeEventListener("dragenter", enter);
			el.removeEventListener("dragover", over);
			el.removeEventListener("dragleave", leave);
			el.removeEventListener("drop", drop);
			window.removeEventListener("dragover", guard);
			window.removeEventListener("drop", guard);
			window.removeEventListener("dragend", end);
			setDragging(false);
		};
	}, [dropScope, disabled, addFiles]);

	const hasContent = text.trim().length > 0 || att.items.length > 0 || kbs.length > 0;
	const canSend = !disabled && !sending && !att.uploading && !att.failed && hasContent;

	const send = async () => {
		if (!canSend) return;
		setSending(true);
		setErr(undefined);
		const v: ComposerSubmit = {
			text: text.trim(),
			attachments: att.items.flatMap((a) => (a.status === "ready" && a.ref ? [a.ref] : [])),
			knowledgeRefs: kbs.map((k) => k.ref),
			mode: busy ? steerMode : "auto",
			...(!model && !modelLocked && !hideModel && resolved.model ? { modelId: resolved.model.id, ...(resolved.thinking ? { thinkingLevel: resolved.thinking } : {}) } : {}),
		};
		try {
			const ok = await onSubmit(v);
			if (ok) {
				setText("");
				setKbs([]);
				att.clear();
			}
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setSending(false);
			ta.current?.focus();
		}
	};

	const runSlash = (id: SlashId) => {
		setSlash({ open: false, index: 0 });
		setText((t) => t.replace(/(^|\s)\/[^\s]*$/, "$1"));
		if (id === "upload") fileInput.current?.click();
		else setPicker(id);
	};
	const slashItems = SLASH_ITEMS.filter((s) => s.id !== "skill" || skills.length > 0);

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (slash.open) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const d = e.key === "ArrowDown" ? 1 : -1;
				setSlash((s) => ({ ...s, index: (s.index + d + slashItems.length) % slashItems.length }));
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
				e.preventDefault();
				runSlash(slashItems[slash.index]!.id);
				return;
			}
			if (e.key === "Escape") {
				setSlash({ open: false, index: 0 });
				return;
			}
		}
		// IME safe: Enter that confirms a composition (incl. Safari's keyCode 229 right after compositionend) never sends.
		if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
			e.preventDefault();
			void send();
		}
		if (e.key === "Backspace" && text === "") {
			if (kbs.length) setKbs((c) => c.slice(0, -1));
			else if (att.items.length) att.remove(att.items[att.items.length - 1]!.key);
		}
	};

	const onChange = (v: string) => {
		setText(v);
		const m = /(^|\s)\/([^\s]*)$/.exec(v);
		setSlash((s) => ({ open: !!m && (m[2] ?? "").length < 8, index: m ? Math.min(s.index, slashItems.length - 1) : 0 }));
	};

	// Pasted images (screenshots, copied pictures) become attachments. Text on the clipboard always wins (copying cells from a
	// spreadsheet puts both text and an image there).
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const cd = e.clipboardData;
		if (!cd || cd.getData("text/plain")) return;
		const files = Array.from(cd.files);
		if (!files.length) return;
		e.preventDefault();
		const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
		addFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `粘贴的图片-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }))));
	};

	const addKb = (r: KnowledgeRef) => setKbs((cs) => (cs.some((x) => x.ref.kbId === r.kbId && x.ref.docId === r.docId) ? cs : [...cs, { ref: r }]));
	const insertSkill = useCallback((name: string) => {
		setText((t) => (t.startsWith("使用技能「") ? t : `使用技能「${name}」：${t}`));
		setTimeout(() => ta.current?.focus(), 0);
	}, []);
	const showRow = att.items.length > 0 || kbs.length > 0;
	// the newest card (and any failure on it) stays in view when the list scrolls
	useEffect(() => {
		if (row.current) row.current.scrollTop = row.current.scrollHeight;
	}, [att.items.length, att.items.map((i) => i.status).join(), kbs.length]);

	const modelDisabled = !!modelLocked || disabled;
	const menuSide = variant === "home" ? "bottom" : "top";
	const switcher =
		hideModel ? null : modelLocked ? (
			<span data-testid="model-locked" className="inline-flex h-9 max-w-[200px] items-center truncate px-2.5 text-sm text-fg-muted sm:h-8 sm:max-w-[240px]" title={modelLocked}>
				{modelLocked}
			</span>
		) : !models.length && !model?.label ? (
			modelsLoading ? (
				<span aria-label="正在加载模型" className="h-8 w-24 rounded-lg bg-surface-2 wr-pulse" />
			) : modelsError || modelsUnavailable ? (
				<ModelChipNote>模型列表加载失败</ModelChipNote>
			) : (
				<ModelChipNote>暂无可用模型</ModelChipNote>
			)
		) : (
			<ModelSwitcher
				groups={groups}
				value={current}
				fallback={model?.label ? { label: model.label, fixture: !!model.fixture } : undefined}
				thinking={thinking}
				onSelect={pickModel}
				onThinking={pickThinking}
				disabled={modelDisabled}
				side={menuSide}
			/>
		);

	const stopShown = !!(busy && onStop);
	// while a run works: no text → stop is the primary button; with text → send (steer) is primary and stop turns secondary
	const stopPrimary = stopShown && !hasContent;
	const sendTip = att.failed ? "有文件上传失败：请重试或移除" : att.uploading ? "文件上传完成后才能发送" : busy ? (steerMode === "steer" ? "插话" : "加入队列") : hasContent ? "发送" : "输入内容后发送";
	const slashId = "composer-slash";

	return (
		<div ref={root} className="relative">
			{slash.open ? (
				<div
					role="listbox"
					id={slashId}
					aria-label="插入引用"
					data-testid="slash-menu"
					className={cn("absolute left-0 z-20 w-64 max-w-full rounded-xl border border-border bg-surface p-1 text-fg shadow-pop wr-fade-in", variant === "home" ? "top-full mt-2" : "bottom-full mb-2")}
				>
					<div className="px-2.5 pb-1 pt-1.5 text-xs text-fg-subtle">插入引用</div>
					{slashItems.map((it, i) => (
						<button
							key={it.id}
							id={`${slashId}-${it.id}`}
							type="button"
							tabIndex={-1}
							role="option"
							aria-selected={i === slash.index}
							onMouseDown={(e) => {
								e.preventDefault();
								runSlash(it.id);
							}}
							className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm", i === slash.index ? "bg-surface-2" : "hover:bg-surface-2")}
						>
							<it.icon aria-hidden className="size-4 text-fg-muted" />
							{it.label}
						</button>
					))}
				</div>
			) : null}
			<div
				ref={box}
				data-testid="composer"
				data-variant={variant}
				data-disabled={disabled ? "true" : undefined}
				data-dragging={dragging ? "true" : undefined}
				className={cn(
					"rounded-2xl border px-3 pb-2.5 pt-3 shadow-composer transition-colors focus-within:border-border-strong",
					disabled ? "bg-surface-2" : "bg-surface",
					dragging ? "border-border-strong" : "border-border",
				)}
			>
				{showRow ? (
					<div ref={row} data-testid="attachments" aria-label="已添加" role="group" className="wr-scroll mb-2.5 flex max-h-[184px] flex-wrap gap-2 overflow-y-auto overflow-x-hidden">
						{att.items.map((a) => (
							<FileTile
								key={a.key}
								testId="chip-file"
								name={a.name}
								size={a.size}
								mime={a.mime}
								thumbUrl={a.thumb}
								state={a.status}
								progress={a.progress}
								error={a.error}
								note={a.source === "library" ? "来自文件库" : undefined}
								onRemove={() => att.remove(a.key)}
								onRetry={a.status === "failed" && !(a.size && a.size > MAX_UPLOAD_BYTES) ? () => att.retry(a.key) : undefined}
								className="max-sm:w-full"
							/>
						))}
						{kbs.map((k) => (
							<RefTile key={k.ref.kbId + (k.ref.docId ?? "")} testId="chip-kb" icon={<BookOpen />} label="知识库" name={k.ref.name} onRemove={() => setKbs((cs) => cs.filter((x) => x !== k))} className="max-sm:w-full" />
						))}
					</div>
				) : null}
				<textarea
					ref={ta}
					data-testid="composer-input"
					aria-label="输入消息"
					aria-controls={slash.open ? slashId : undefined}
					aria-activedescendant={slash.open && slashItems[slash.index] ? `${slashId}-${slashItems[slash.index]!.id}` : undefined}
					autoFocus={autoFocus}
					rows={2}
					value={text}
					disabled={disabled}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKey}
					onPaste={onPaste}
					onCompositionStart={() => (composing.current = true)}
					onCompositionEnd={() => (composing.current = false)}
					onBlur={() => setTimeout(() => setSlash({ open: false, index: 0 }), 120)}
					placeholder={disabled ? disabledReason : (placeholder ?? (busy ? "补充说明或调整方向，回车发送" : "说说要完成的事"))}
					className="block max-h-[240px] min-h-[48px] w-full resize-none bg-transparent px-1 text-base leading-6 text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed"
				/>
				<div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-2">
					<input
						ref={fileInput}
						type="file"
						multiple
						hidden
						data-testid="file-input"
						onChange={(e) => {
							if (e.target.files?.length) att.add(Array.from(e.target.files));
							e.target.value = "";
						}}
					/>
					<AttachMenu
						disabled={disabled}
						side={menuSide}
						actions={{ upload: () => fileInput.current?.click(), library: () => setPicker("file"), kb: () => setPicker("kb"), skill: skills.length ? () => setPicker("skill") : undefined }}
					/>
					{tools}
					{busy ? (
						<div className="ml-1 flex items-center rounded-lg bg-surface-2 p-0.5 text-sm max-sm:order-last max-sm:basis-full" role="radiogroup" aria-label="运行中发送方式">
							{(["steer", "followUp"] as const).map((m) => (
								<button
									key={m}
									type="button"
									role="radio"
									aria-checked={steerMode === m}
									onClick={() => setSteerMode(m)}
									className={cn("h-7 rounded-md px-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:flex-1", steerMode === m ? "bg-surface text-fg shadow-sm" : "text-fg-muted")}
									title={m === "steer" ? "在当前任务的下一个步骤间隙加入" : "等当前任务结束后再处理"}
								>
									{m === "steer" ? "插话" : "稍后处理"}
								</button>
							))}
						</div>
					) : null}
					<div className="ml-auto flex min-w-0 items-center gap-1">
						<div className="flex min-w-0 items-center justify-end">{switcher}</div>
						{stopShown ? (
							<Tip label={stopping ? "正在停止" : "停止"}>
								<button
									type="button"
									data-testid="stop"
									aria-label="停止"
									onClick={onStop}
									disabled={stopping}
									className={cn(
										"flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9",
										stopPrimary ? "bg-accent text-accent-fg hover:opacity-90" : "border border-border-strong text-fg hover:bg-surface-2",
									)}
								>
									{stopping ? <Loader2 className="size-4 wr-spin" /> : <Square className="size-3.5 fill-current" />}
								</button>
							</Tip>
						) : null}
						<Tip label={sendTip}>
							<span className="inline-flex">
								<button
									type="button"
									data-testid="send"
									aria-label={busy ? "插话" : "发送"}
									onClick={() => void send()}
									disabled={!canSend}
									className={cn(
										"flex size-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9",
										canSend ? "bg-accent text-accent-fg hover:opacity-90" : "bg-surface-3 text-fg-muted",
									)}
								>
									{sending ? <Loader2 className="size-4 wr-spin" /> : <ArrowUp className="size-[18px]" />}
								</button>
							</span>
						</Tip>
					</div>
				</div>
			</div>
			{err || att.notice || att.failed ? (
				<p role="alert" data-testid="composer-error" className="mt-2 px-1 text-sm text-danger">
					{err ?? att.notice ?? "有文件上传失败：请重试或移除后再发送。"}
				</p>
			) : null}
			<FilePickerDialog open={picker === "file"} onOpenChange={closePicker} spaceId={spaceId} projectId={projectId} onPick={(ref, meta) => att.addRef(ref, meta)} />
			<KbPickerDialog open={picker === "kb"} onOpenChange={closePicker} onPick={addKb} />
			<SkillPickerDialog open={picker === "skill"} onOpenChange={closePicker} skills={skills} onPick={(s) => insertSkill(s.name)} />
			{dragging && dropEl && dropEl.isConnected
				? createPortal(
						<div data-testid="drop-overlay" aria-hidden className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-border-strong bg-bg/90 wr-fade-in">
							<div className="flex flex-col items-center gap-2 text-center">
								<span className="flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-fg-muted">
									<UploadCloud className="size-6" />
								</span>
								<div className="text-base font-medium">松开鼠标，添加文件</div>
								<div className="text-sm text-fg-muted">
									最多 {MAX_FILES} 个，每个不超过 {MAX_UPLOAD_BYTES / 1048576} MB
								</div>
							</div>
						</div>,
						dropEl,
					)
				: null}
		</div>
	);
}
