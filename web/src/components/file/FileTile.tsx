// The shared visual language for files: a tinted type icon (or image thumbnail), middle-ellipsis name, meta line.
// Used by composer attachments, message-bubble attachments and deliverable cards.
import { AlertCircle, Loader2, RotateCw, X } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { cn, formatBytes } from "@/lib/utils";
import { fileKind, KIND_META, splitName, type FileKind } from "./kinds";

/** Name that truncates in the middle and always keeps the extension visible. */
export function MiddleEllipsis({ name, className }: { name: string; className?: string }) {
	const { head, tail } = splitName(name);
	return (
		<span title={name} data-name={name} className={cn("flex min-w-0 max-w-full", className)}>
			<span className="truncate whitespace-pre">{head}</span>
			{tail ? <span className="shrink-0 whitespace-pre">{tail}</span> : null}
		</span>
	);
}

/** Tinted type icon, or a thumbnail for images (falls back to the icon when the image cannot be loaded). */
export function FileThumb({ name, mime, thumbUrl, size = 40, kind: kindProp }: { name: string; mime?: string; thumbUrl?: string; size?: 36 | 40 | 44; kind?: FileKind }) {
	const kind = kindProp ?? fileKind(name, mime);
	const meta = KIND_META[kind];
	const [broken, setBroken] = useState(false);
	const Icon = meta.icon;
	const dim = size === 44 ? "size-11" : size === 36 ? "size-9" : "size-10";
	if (thumbUrl && kind === "image" && !broken)
		return <img src={thumbUrl} alt="" onError={() => setBroken(true)} draggable={false} data-testid="file-thumb" className={cn(dim, "shrink-0 rounded-lg border border-border bg-surface-2 object-cover")} />;
	return (
		<span
			data-kind={kind}
			style={{ "--k": meta.color, background: "color-mix(in srgb, var(--k) 11%, var(--surface))", color: "var(--k)" } as CSSProperties}
			className={cn(dim, "flex shrink-0 items-center justify-center rounded-lg")}
		>
			<Icon className="size-5" strokeWidth={1.75} />
		</span>
	);
}

export interface TileProps {
	name: string;
	size?: number;
	mime?: string;
	thumbUrl?: string;
	state?: "ready" | "uploading" | "failed";
	/** 0..100 while uploading */
	progress?: number;
	error?: string;
	/** Extra meta text after the type label (e.g. "来自文件库"). */
	note?: ReactNode;
	onOpen?: () => void;
	onRemove?: () => void;
	onRetry?: () => void;
	testId?: string;
	className?: string;
}

/** Compact attachment card (composer + message bubble). */
export function FileTile({ name, size, mime, thumbUrl, state = "ready", progress = 0, error, note, onOpen, onRemove, onRetry, testId, className }: TileProps) {
	const kind = fileKind(name, mime);
	const label = KIND_META[kind].label;
	const pct = Math.max(0, Math.min(100, Math.round(progress)));
	const body = (
		<>
			<FileThumb name={name} mime={mime} thumbUrl={thumbUrl} />
			<span className="min-w-0 flex-1 text-left">
				<MiddleEllipsis name={name} className="text-[13px] font-medium leading-5 text-fg" />
				<span className="mt-px flex items-center gap-1 text-[11.5px] leading-4 text-fg-subtle">
					{state === "uploading" ? (
						<>
							<Loader2 className="size-3 wr-spin" />
							<span data-testid="tile-state">上传中 {pct}%</span>
						</>
					) : state === "failed" ? (
						<>
							<AlertCircle className="size-3 shrink-0 text-danger" />
							<span data-testid="tile-state" className="truncate text-danger" title={error}>
								上传失败{error ? `：${error}` : ""}
							</span>
						</>
					) : (
						<span data-testid="tile-state" className="truncate">
							{label}
							{size !== undefined ? ` · ${formatBytes(size)}` : ""}
							{note ? <> · {note}</> : null}
						</span>
					)}
				</span>
			</span>
		</>
	);
	return (
		<div
			data-testid={testId ?? "file-tile"}
			data-state={state}
			data-kind={kind}
			data-progress={state === "uploading" ? pct : undefined}
			className={cn(
				"group/tile relative flex w-[232px] max-w-full shrink-0 items-center gap-2.5 overflow-hidden rounded-xl border bg-surface p-1.5 pr-2.5 transition-colors",
				state === "failed" ? "border-danger/40" : "border-border hover:border-border-strong",
				className,
			)}
		>
			{onOpen && state === "ready" ? (
				<button type="button" onClick={onOpen} aria-label={`预览 ${name}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left">
					{body}
				</button>
			) : (
				<div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>
			)}
			{state === "failed" && onRetry ? (
				<button type="button" onClick={onRetry} aria-label={`重试上传 ${name}`} data-testid="tile-retry" className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-muted hover:bg-surface-2 hover:text-fg">
					<RotateCw className="size-3.5" />
					重试
				</button>
			) : null}
			{onRemove ? (
				<button
					type="button"
					onClick={onRemove}
					aria-label={`移除 ${name}`}
					data-testid="tile-remove"
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
				>
					<X className="size-3.5" />
				</button>
			) : null}
			{state === "uploading" ? (
				<span className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-3">
					<span className="block h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
				</span>
			) : null}
		</div>
	);
}

/** Same card shape for a non-file reference (knowledge base). */
export function RefTile({ icon, label, name, onRemove, testId, color = "var(--info)", className }: { icon: ReactNode; label: string; name: string; onRemove?: () => void; testId?: string; color?: string; className?: string }) {
	return (
		<div data-testid={testId ?? "ref-tile"} className={cn("relative flex w-[232px] max-w-full shrink-0 items-center gap-2.5 overflow-hidden rounded-xl border border-border bg-surface p-1.5 pr-2.5", className)}>
			<span style={{ "--k": color, background: "color-mix(in srgb, var(--k) 11%, var(--surface))", color: "var(--k)" } as CSSProperties} className="flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5">
				{icon}
			</span>
			<span className="min-w-0 flex-1 text-left">
				<MiddleEllipsis name={name} className="text-[13px] font-medium leading-5 text-fg" />
				<span className="mt-px block text-[11.5px] leading-4 text-fg-subtle">{label}</span>
			</span>
			{onRemove ? (
				<button type="button" onClick={onRemove} aria-label={`移除 ${name}`} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg">
					<X className="size-3.5" />
				</button>
			) : null}
		</div>
	);
}
