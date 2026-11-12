// Small building blocks of the Harness 检视 drawer: collapsible sections, clamped text, and role-labelled messages.
import { ChevronRight, Image as ImageIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { InspectContentBlock, InspectMessageDTO, InspectToolDTO } from "@shared/harness-inspect";
import { Badge } from "@/components/ui/misc";
import { cn, formatBytes } from "@/lib/utils";

/** Section with a chevron header. Children mount only while open, so big transcripts cost nothing until looked at. */
export function Collapsible({ title, count, hint, defaultOpen, testId, children, level = 1 }: { title: ReactNode; count?: number; hint?: ReactNode; defaultOpen?: boolean; testId?: string; children: ReactNode; level?: 1 | 2 }) {
	const [open, setOpen] = useState(!!defaultOpen);
	const id = useId();
	return (
		<section data-testid={testId} className={cn(level === 1 ? "rounded-xl border border-border" : "rounded-lg border border-border bg-surface")}>
			<h3 className="m-0">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen((o) => !o)}
					className={cn("flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", level === 1 ? "rounded-xl px-4 py-3 text-sm font-medium" : "rounded-lg px-3 py-2 text-sm")}
				>
					<ChevronRight aria-hidden className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />
					<span className="min-w-0 truncate">{title}</span>
					{count !== undefined ? <span className="text-xs font-normal text-fg-subtle">{count}</span> : null}
					{hint ? <span className="ml-auto min-w-0 truncate text-xs font-normal text-fg-subtle">{hint}</span> : null}
				</button>
			</h3>
			{open ? (
				<div id={id} className={cn("border-t border-border", level === 1 ? "px-4 py-3" : "px-3 py-2")}>
					{children}
				</div>
			) : null}
		</section>
	);
}

const CLAMP_CHARS = 700;
const CLAMP_LINES = 14;

/** Preformatted text (whitespace kept). Long text is folded to a few lines with an expand button. */
export function Pre({ text, mono = true, className, tone }: { text: string; mono?: boolean; className?: string; tone?: "muted" }) {
	const long = text.length > CLAMP_CHARS || text.split("\n").length > CLAMP_LINES;
	const [open, setOpen] = useState(false);
	return (
		<div>
			<pre
				className={cn(
					"m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed",
					mono ? "font-mono" : "font-sans",
					tone === "muted" ? "text-fg-muted" : "text-fg",
					long && !open && "max-h-52 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
					className,
				)}
			>
				{text || "（空）"}
			</pre>
			{long ? (
				<button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 rounded text-xs text-info hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
					{open ? "收起" : `展开全部（${text.length.toLocaleString()} 字符）`}
				</button>
			) : null}
		</div>
	);
}

const pretty = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "");

export function ToolItem({ tool }: { tool: InspectToolDTO }) {
	const first = tool.description.split("\n")[0] ?? "";
	return (
		<Collapsible level={2} title={<span className="font-mono text-[13px]">{tool.name}</span>} hint={first.slice(0, 80)} testId="inspect-tool">
			<div className="space-y-3">
				<div>
					<div className="mb-1 text-xs font-medium text-fg-subtle">描述</div>
					<Pre text={tool.description} mono={false} />
				</div>
				<div>
					<div className="mb-1 text-xs font-medium text-fg-subtle">参数 Schema</div>
					<Pre text={pretty(tool.parameters)} />
				</div>
			</div>
		</Collapsible>
	);
}

const ROLE: Record<InspectMessageDTO["role"], { label: string; bar: string; badge: "warning" | "info" | "success" | "neutral" }> = {
	system: { label: "系统", bar: "border-l-warning", badge: "warning" },
	user: { label: "用户", bar: "border-l-info", badge: "info" },
	assistant: { label: "助手", bar: "border-l-success", badge: "success" },
	tool: { label: "工具结果", bar: "border-l-fg-subtle", badge: "neutral" },
};

function Block({ b }: { b: InspectContentBlock }) {
	if (b.type === "text") return <Pre text={b.text} mono={false} />;
	if (b.type === "thinking")
		return (
			<div className="rounded-lg bg-surface-2 px-3 py-2" data-testid="inspect-thinking">
				<div className="mb-1 text-xs font-medium text-fg-subtle">思考{b.redacted ? "（已被服务商隐去）" : ""}</div>
				<Pre text={b.text} mono={false} tone="muted" />
			</div>
		);
	if (b.type === "toolCall")
		return (
			<div className="rounded-lg border border-border px-3 py-2" data-testid="inspect-toolcall">
				<div className="mb-1 flex items-center gap-2 text-xs text-fg-subtle">
					调用工具 <span className="font-mono text-[13px] text-fg">{b.name}</span>
					<span className="truncate font-mono">{b.id}</span>
				</div>
				<Pre text={pretty(b.arguments)} />
			</div>
		);
	return (
		<Badge>
			<ImageIcon aria-hidden /> 图片 {b.mimeType} · {formatBytes(b.bytes)}（未保存内容）
		</Badge>
	);
}

export function MessageItem({ m, index }: { m: InspectMessageDTO; index: number }) {
	const r = ROLE[m.role];
	const empty = m.content.length === 0 && !m.sections && !m.toolsAdded?.length && !m.toolsRemoved?.length;
	return (
		<li data-testid="inspect-message" data-role={m.role} className={cn("rounded-lg border border-border border-l-[3px] bg-surface px-3 py-2.5", r.bar)}>
			<div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
				<span className="tabular-nums">#{index + 1}</span>
				<Badge tone={r.badge}>{r.label}</Badge>
				{m.role === "tool" && m.toolName ? <span className="font-mono text-[13px] text-fg">{m.toolName}</span> : null}
				{m.role === "tool" && m.isError ? <Badge tone="danger">出错</Badge> : null}
				{m.role === "assistant" && m.model ? <span className="truncate font-mono">{m.model}</span> : null}
				{m.role === "assistant" && m.stopReason ? <span>{m.stopReason}</span> : null}
				{m.role === "tool" && m.toolCallId ? <span className="truncate font-mono">{m.toolCallId}</span> : null}
			</div>
			<div className="space-y-2">
				{m.content.map((b, i) => (
					<Block key={i} b={b} />
				))}
				{m.sections
					? Object.entries(m.sections).map(([k, v]) => (
							<div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
								<div className="mb-1 text-xs font-medium text-fg-subtle">提示词片段 {k}{v === null ? "（移除）" : ""}</div>
								{v ? <Pre text={v} /> : null}
							</div>
						))
					: null}
				{m.toolsAdded?.length ? <div className="text-xs text-fg-muted">新增工具：{m.toolsAdded.join("、")}</div> : null}
				{m.toolsRemoved?.length ? <div className="text-xs text-fg-muted">移除工具：{m.toolsRemoved.join("、")}</div> : null}
				{empty ? <span className="text-xs text-fg-subtle">（无内容）</span> : null}
			</div>
		</li>
	);
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
	return (
		<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
			{rows
				.filter(([, v]) => v !== undefined && v !== null && v !== "")
				.map(([k, v]) => (
					<div key={k} className="contents">
						<dt className="text-fg-subtle">{k}</dt>
						<dd className="m-0 min-w-0 break-words text-fg">{v}</dd>
					</div>
				))}
		</dl>
	);
}
