// The one input box, shared by the home page, project page and the chat page.
//  - auto-growing textarea; Enter sends, Shift+Enter = newline, IME composition never sends; "/" opens the slash menu;
//  - "+" at the left: 上传文件 · 从文件库选择 · 引用知识库 · 使用技能; files can also be dragged anywhere on the page
//    (clear drop overlay) or pasted (images); multi-file upload with per-file progress, retry and remove;
//  - model switcher at the right (grouped, capability badges, blocked = disabled with reason) + send / stop;
//  - while a run is working the person keeps typing and sends normally: the message is queued on the server (follow-up) and
//    shown in the queue above the box; a stop button appears. A failed send (offline…) keeps the text and offers 重试 with
//    the SAME requestId, so a retry can never send twice.
import { ArrowUp, BookOpen, Folders, Loader2, RotateCcw, Sparkles, Square, Upload, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef, KnowledgeRef, SendMode } from "@shared/chat";
import type { MentionableExpertDTO } from "@shared/experts";
import type { ThinkingLevel } from "@shared/ops";
import { ApiError, errorText, uuid } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/overlay";
import { FileTile, RefTile } from "@/components/file/FileTile";
import { FilePickerDialog, KbPickerDialog, SkillPickerDialog, useUsableSkills } from "@/features/chat/pickers";
import { AttachMenu } from "./AttachMenu";
import { ModelChipNote, ModelSwitcher } from "./ModelSwitcher";
import { readDefaultChoice, resolveChoice, supportsThinking, useModels, writeDefaultChoice, type ModelChoice, type ModelInfo } from "./models";
import { MAX_FILES, useAttachments } from "./useAttachments";
import { ExpertAvatar } from "@/features/experts/common";
import { useApi } from "@/lib/useApi";
import { MAX_UPLOAD_BYTES } from "./upload";

export interface ComposerSubmit {
	text: string;
	attachments: AttachmentRef[];
	knowledgeRefs: KnowledgeRef[];
	mode: SendMode;
	/** Stable across retries of the same content: the server dedupes on it. */
	requestId: string;
	/** Round 17: the expert @-mentioned in this message. */
	expertId?: string;
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
	/** Run is working: a sent message is queued behind it (follow-up); the stop button shows. */
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
	/** A withdrawn queue item handed back for editing: its text goes in front of what is typed, its files and references come back as chips. */
	restore?: { n: number; text: string; attachments?: readonly AttachmentRef[]; knowledgeRefs?: readonly KnowledgeRef[] };
	/** Element (position: relative) that accepts dropped files; defaults to the composer itself. */
	dropScope?: RefObject<HTMLElement | null>;
	model?: ModelBinding;
	/** Model fixed by something else (e.g. an assistant's default model): the switcher is shown disabled with this text. */
	modelLocked?: string;
	hideModel?: boolean;
	/** Round 17: typing "@" lists experts; the chosen one answers this message (home: it also becomes the conversation's expert). */
	mentions?: boolean;
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

export function Composer({ onSubmit, busy, onStop, stopping, spaceId, projectId, conversationId, placeholder, autoFocus, variant = "chat", tools, disabled, disabledReason, seed, restore, dropScope, model, modelLocked, hideModel, mentions = true }: Props) {
	const [text, setText] = useState("");
	const [kbs, setKbs] = useState<KbChip[]>([]);
	const att = useAttachments({ spaceId, projectId, conversationId });
	const [sending, setSending] = useState(false);
	const [err, setErr] = useState<string>();
	// the last attempt that failed to reach the server: same content → same requestId on retry
	const failedSend = useRef<{ sig: string; requestId: string } | undefined>(undefined);
	const [failedNet, setFailedNet] = useState(false);
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
	// ---- @expert: a popup of the experts the user may use; the pick becomes a chip, the message goes out with its id
	const [expert, setExpert] = useState<MentionableExpertDTO>();
	const [at, setAt] = useState<{ open: boolean; q: string; index: number }>({ open: false, q: "", index: 0 });
	const experts = useApi<{ experts: MentionableExpertDTO[] }>(mentions && at.open ? "/experts/mentionable" : null);
	const atItems = (experts.data?.experts ?? []).filter((x) => !at.q || `${x.name}${x.tagline}`.toLowerCase().includes(at.q.toLowerCase())).slice(0, 8);
	const pickExpert = (x: MentionableExpertDTO) => {
		setExpert(x);
		setAt({ open: false, q: "", index: 0 });
		setText((t) => t.replace(/(^|\s)@[^\s@]*$/, "$1"));
		setTimeout(() => ta.current?.focus(), 0);
	};

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

	// 撤销 from the queue: put the message back for editing
	const lastRestore = useRef(0);
	useEffect(() => {
		if (!restore || restore.n <= lastRestore.current) return;
		lastRestore.current = restore.n;
		setText((t) => (t.trim() ? `${restore.text}\n\n${t}` : restore.text));
		for (const a of restore.attachments ?? []) att.addRef(a, { source: "upload" });
		if (restore.knowledgeRefs?.length) setKbs((cs) => [...cs, ...restore.knowledgeRefs!.filter((r) => !cs.some((x) => x.ref.kbId === r.kbId && x.ref.docId === r.docId)).map((ref) => ({ ref }))]);
		setTimeout(() => ta.current?.focus(), 0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [restore]);

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
		setFailedNet(false);
		const attachments = att.items.flatMap((a) => (a.status === "ready" && a.ref ? [a.ref] : []));
		const knowledgeRefs = kbs.map((k) => k.ref);
		const sig = JSON.stringify([text.trim(), attachments.map((a) => a.versionId), knowledgeRefs.map((k) => `${k.kbId}/${k.docId ?? ""}`)]);
		const requestId = failedSend.current?.sig === sig ? failedSend.current.requestId : uuid();
		const lockedByExpertNow = !model && !!expert?.defaultModel;
		const v: ComposerSubmit = {
			...(expert ? { expertId: expert.id } : {}),
			text: text.trim(),
			attachments,
			knowledgeRefs,
			mode: busy ? "followUp" : "auto",
			requestId,
			...(!model && !modelLocked && !lockedByExpertNow && !hideModel && resolved.model ? { modelId: resolved.model.id, ...(resolved.thinking ? { thinkingLevel: resolved.thinking } : {}) } : {}),
		};
		try {
			const ok = await onSubmit(v);
			if (ok) {
				failedSend.current = undefined;
				setText("");
				setKbs([]);
				setExpert(undefined);
				att.clear();
			}
		} catch (e) {
			// the text, files and references stay in the box; a retry of the same content reuses the requestId (no double send)
			failedSend.current = { sig, requestId };
			const net = e instanceof ApiError ? e.status === 0 || e.code === "network" : e instanceof TypeError;
			setFailedNet(net);
			setErr(net ? "网络不可用，没有发出 · 内容还在输入框" : errorText(e));
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
		if (at.open && atItems.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const d = e.key === "ArrowDown" ? 1 : -1;
				setAt((s) => ({ ...s, index: (s.index + d + atItems.length) % atItems.length }));
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
				e.preventDefault();
				pickExpert(atItems[Math.min(at.index, atItems.length - 1)]!);
				return;
			}
		}
		if (at.open && e.key === "Escape") {
			setAt({ open: false, q: "", index: 0 });
			return;
		}
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
			if (expert) setExpert(undefined);
			else if (kbs.length) setKbs((c) => c.slice(0, -1));
			else if (att.items.length) att.remove(att.items[att.items.length - 1]!.key);
		}
	};

	const onChange = (v: string) => {
		setText(v);
		const m = /(^|\s)\/([^\s]*)$/.exec(v);
		setSlash((s) => ({ open: !!m && (m[2] ?? "").length < 8, index: m ? Math.min(s.index, slashItems.length - 1) : 0 }));
		const a = mentions ? /(^|\s)@([^\s@]*)$/.exec(v) : null;
		setAt((s) => ({ open: !!a && !expert, q: a?.[2] ?? "", index: a ? s.index : 0 }));
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
	const showRow = att.items.length > 0 || kbs.length > 0 || !!expert;
	// the newest card (and any failure on it) stays in view when the list scrolls
	useEffect(() => {
		if (row.current) row.current.scrollTop = row.current.scrollHeight;
	}, [att.items.length, att.items.map((i) => i.status).join(), kbs.length]);

	// An @-mentioned expert with its own default model decides the model of a NEW conversation (the user can still switch it in the chat).
	const lockedByExpert = !model && expert?.defaultModel ? "专家指定的模型" : undefined;
	const lockedText = modelLocked ?? lockedByExpert;
	const modelDisabled = !!lockedText || disabled;
	const menuSide = variant === "home" ? "bottom" : "top";
	const switcher =
		hideModel ? null : lockedText ? (
			<span data-testid="model-locked" className="inline-flex h-9 max-w-[200px] items-center truncate px-2.5 text-sm text-fg-muted sm:h-8 sm:max-w-[240px]" title={lockedText}>
				{lockedText}
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
	// while a run works: no text → stop is the primary button; with text → send (queue) is primary and stop turns secondary
	const stopPrimary = stopShown && !hasContent;
	const sendTip = att.failed ? "有文件上传失败：请重试或移除" : att.uploading ? "文件上传完成后才能发送" : busy && hasContent ? "加入队列，当前任务结束后发送" : hasContent ? "发送" : "输入内容后发送";
	const slashId = "composer-slash";

	return (
		<div ref={root} className="relative">
			{at.open ? (
				<div role="listbox" id="composer-at" aria-label="选择专家" data-testid="mention-menu" className={cn("absolute left-0 z-20 w-80 max-w-full rounded-xl border border-border bg-surface p-1 text-fg shadow-pop wr-fade-in", variant === "home" ? "top-full mt-2" : "bottom-full mb-2")}>
					<div className="px-2.5 pb-1 pt-1.5 text-xs text-fg-subtle">选择专家</div>
					{experts.loading ? <div className="px-2.5 py-2 text-sm text-fg-subtle">加载中…</div> : null}
					{!experts.loading && atItems.length === 0 ? <div className="px-2.5 py-2 text-sm text-fg-subtle">{at.q ? "没有匹配的专家" : "还没有可用的专家"}</div> : null}
					{atItems.map((x, i) => (
						<button
							key={x.id}
							type="button"
							tabIndex={-1}
							role="option"
							aria-selected={i === at.index}
							data-testid="mention-item"
							onMouseDown={(ev) => {
								ev.preventDefault();
								pickExpert(x);
							}}
							className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm", i === at.index ? "bg-surface-2" : "hover:bg-surface-2")}
						>
							<ExpertAvatar e={x} size={28} />
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium">{x.name}</span>
								{x.tagline ? <span className="block truncate text-xs text-fg-subtle">{x.tagline}</span> : null}
							</span>
							{x.mine ? <span className="shrink-0 text-xs text-fg-subtle">我的</span> : null}
						</button>
					))}
				</div>
			) : null}
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
						{expert ? (
							<span data-testid="chip-expert" className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-surface-2 pl-1.5 pr-1 text-sm max-sm:w-full">
								<ExpertAvatar e={expert} size={24} />
								<span className="font-medium">@{expert.name}</span>
								<button type="button" aria-label="取消 @专家" onClick={() => setExpert(undefined)} className="rounded p-1 text-fg-subtle hover:bg-surface-3 hover:text-fg">
									×
								</button>
							</span>
						) : null}
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
					onBlur={() => setTimeout(() => (setSlash({ open: false, index: 0 }), setAt((s) => ({ ...s, open: false }))), 120)}
					placeholder={disabled ? disabledReason : (placeholder ?? (busy ? "继续输入…" : "说说要完成的事"))}
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
									aria-label="发送"
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
				<p role="alert" data-testid="composer-error" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-danger">
					<span className="min-w-0 flex-1 basis-56">{err ?? att.notice ?? "有文件上传失败：请重试或移除后再发送。"}</span>
					{err && failedSend.current ? (
						<button type="button" data-testid="composer-retry" data-network={failedNet ? "true" : undefined} onClick={() => void send()} disabled={sending || !canSend} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-strong px-2 py-1 font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
							{sending ? <Loader2 aria-hidden className="size-3.5 wr-spin" /> : <RotateCcw aria-hidden className="size-3.5" />}
							重试
						</button>
					) : null}
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
