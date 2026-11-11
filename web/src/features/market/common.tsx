// Shared pieces of the marketplace UI: permission/state vocabulary, finding list, file tree + viewer, diff view, stars, action hook.
import { AlertTriangle, CheckCircle2, ChevronRight, CircleX, FileText, Folder, Info, Star } from "lucide-react";
import { useMemo, useState } from "react";
import type { MarketMeDTO, MarketScope, PackageFileDTO, PackageFindingDTO, SubmissionDetailDTO, SubmissionState } from "@shared/files";
import { errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { cn, formatBytes } from "@/lib/utils";
import { Badge, Spinner } from "@/components/ui/misc";

export const PERM: Record<string, string> = { "sandbox.exec": "运行代码", network: "联网", "file.write": "写入文件" };
export const PERM_EXPLAIN: Record<string, string> = { "sandbox.exec": "运行代码：在工作区里执行技能自带的脚本", network: "联网：访问互联网（能否联网取决于所用的执行环境）", "file.write": "写入文件：把结果保存到文件库" };
export const permText = (p: string): string => PERM[p] ?? (p.startsWith("tool:") ? `工具「${p.slice(5)}」` : p);
/** Name plus what it means, for places that have room (review screen, skill detail). */
export const permExplain = (p: string): string => PERM_EXPLAIN[p] ?? permText(p);
export const permShort = (p: string): string => (p === "sandbox.exec" ? "运行代码" : p === "network" ? "联网" : p === "file.write" ? "写入文件" : p.startsWith("tool:") ? `工具 ${p.slice(5)}` : p);

export const SCOPE: Record<MarketScope, string> = { personal: "个人", project: "项目", department: "部门", org: "组织" };
export const STATE: Record<SubmissionState, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
	checks_failed: { label: "检查未通过", tone: "danger" },
	pending_review: { label: "待审核", tone: "warning" },
	changes_requested: { label: "需修改", tone: "warning" },
	rejected: { label: "已驳回", tone: "danger" },
	approved: { label: "已批准", tone: "info" },
	published: { label: "已发布", tone: "success" },
	unpublished: { label: "已下架", tone: "neutral" },
	withdrawn: { label: "已撤回", tone: "neutral" },
	superseded: { label: "已被取代", tone: "neutral" },
};
export const StateBadge = ({ state }: { state: SubmissionState }) => <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>;

export function useMarketMe() {
	return useApi<{ me: MarketMeDTO }>("/market/me");
}

/** Run an async action with busy/error state, then call `after`. */
export function useAct(after?: () => void) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string>();
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr(undefined);
		try {
			await fn();
			after?.();
		} catch (e) {
			setErr(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return { busy, err, setErr, run };
}

export function Stars({ value, count, size = 13 }: { value?: number; count: number; size?: number }) {
	if (!count) return <span className="text-xs text-fg-subtle">暂无评分</span>;
	return (
		<span className="inline-flex items-center gap-1 text-xs text-fg-muted" title={`${value} 分，${count} 人评价`}>
			<Star style={{ width: size, height: size }} className="fill-warning text-warning" />
			{value?.toFixed(1)}
			<span className="text-fg-subtle">({count})</span>
		</span>
	);
}

export function StarInput({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
	return (
		<span className="inline-flex gap-0.5" role="radiogroup" aria-label="评分">
			{[1, 2, 3, 4, 5].map((n) => (
				<button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} 分`} disabled={disabled} onClick={() => onChange(n)} className="rounded p-0.5 hover:bg-surface-2">
					<Star className={cn("size-[18px]", n <= value ? "fill-warning text-warning" : "text-fg-subtle")} />
				</button>
			))}
		</span>
	);
}

export function PermChips({ perms, added }: { perms: readonly string[]; added?: readonly string[] }) {
	if (!perms.length) return <span className="text-xs text-fg-muted">无需额外权限</span>;
	return (
		<span className="inline-flex flex-wrap gap-1">
			{perms.map((p) => (
				<Badge key={p} tone={p === "network" ? "warning" : added?.includes(p) ? "danger" : "neutral"} title={permText(p)}>
					{permShort(p)}
					{added?.includes(p) ? "（新增）" : ""}
				</Badge>
			))}
		</span>
	);
}

const SEV = {
	error: { icon: CircleX, cls: "text-danger", label: "必须修复" },
	warn: { icon: AlertTriangle, cls: "text-warning", label: "需关注" },
	info: { icon: Info, cls: "text-fg-muted", label: "提示" },
} as const;

export function FindingList({ findings, empty = "没有发现问题。" }: { findings: readonly PackageFindingDTO[]; empty?: string }) {
	if (!findings.length)
		return (
			<p className="flex items-center gap-1.5 text-sm text-success">
				<CheckCircle2 className="size-4" />
				{empty}
			</p>
		);
	const order = { error: 0, warn: 1, info: 2 } as const;
	return (
		<ul className="space-y-1" data-testid="findings">
			{[...findings].sort((a, b) => order[a.severity] - order[b.severity]).map((f, i) => {
				const S = SEV[f.severity];
				return (
					<li key={i} className="flex items-start gap-2 text-sm" data-severity={f.severity}>
						<S.icon className={cn("mt-0.5 size-4 shrink-0", S.cls)} aria-label={S.label} />
						<span className="min-w-0">
							<span className="break-words">{f.message}</span>
							{f.path ? (
								<span className="ml-1.5 font-mono text-xs text-fg-subtle">
									{f.path}
									{f.line ? `:${f.line}` : ""}
								</span>
							) : null}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

// ---------------------------------------------------------------- file tree + viewer
interface Node {
	name: string;
	path: string;
	file?: PackageFileDTO;
	children: Node[];
}
function buildTree(files: readonly PackageFileDTO[]): Node {
	const root: Node = { name: "", path: "", children: [] };
	for (const f of files) {
		let cur = root;
		const parts = f.path.split("/");
		parts.forEach((part, i) => {
			let n = cur.children.find((c) => c.name === part);
			if (!n) {
				n = { name: part, path: parts.slice(0, i + 1).join("/"), children: [] };
				cur.children.push(n);
			}
			if (i === parts.length - 1) n.file = f;
			cur = n;
		});
	}
	const sort = (n: Node) => {
		n.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
		n.children.forEach(sort);
	};
	sort(root);
	return root;
}

export function FileTree({ files, selected, onSelect, marks }: { files: readonly PackageFileDTO[]; selected?: string; onSelect: (path: string) => void; marks?: Record<string, "added" | "removed" | "modified" | undefined> }) {
	const tree = useMemo(() => buildTree(files), [files]);
	return (
		<ul className="text-sm" data-testid="file-tree" role="tree">
			{tree.children.map((n) => (
				<TreeNode key={n.path} n={n} depth={0} selected={selected} onSelect={onSelect} marks={marks} />
			))}
		</ul>
	);
}
function TreeNode({ n, depth, selected, onSelect, marks }: { n: Node; depth: number; selected?: string; onSelect: (p: string) => void; marks?: Record<string, "added" | "removed" | "modified" | undefined> }) {
	const [open, setOpen] = useState(true);
	const pad = { paddingLeft: 6 + depth * 14 };
	if (n.file)
		return (
			<li role="treeitem" aria-selected={selected === n.path}>
				<button type="button" onClick={() => onSelect(n.path)} style={pad} className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-surface-2", selected === n.path && "bg-surface-2 font-medium")} data-path={n.path}>
					<FileText className="size-3.5 shrink-0 text-fg-subtle" />
					<span className="min-w-0 flex-1 truncate">{n.name}</span>
					{marks?.[n.path] ? <span className={cn("text-xs", marks[n.path] === "added" ? "text-success" : marks[n.path] === "removed" ? "text-danger" : "text-warning")}>{marks[n.path] === "added" ? "新增" : marks[n.path] === "removed" ? "删除" : "修改"}</span> : <span className="text-xs text-fg-subtle">{formatBytes(n.file.size)}</span>}
				</button>
			</li>
		);
	return (
		<li role="treeitem" aria-expanded={open}>
			<button type="button" onClick={() => setOpen((o) => !o)} style={pad} className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-fg-muted hover:bg-surface-2">
				<ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<Folder className="size-3.5 shrink-0" />
				{n.name}
			</button>
			{open ? (
				<ul role="group">
					{n.children.map((c) => (
						<TreeNode key={c.path} n={c} depth={depth + 1} selected={selected} onSelect={onSelect} marks={marks} />
					))}
				</ul>
			) : null}
		</li>
	);
}

/** Text viewer for one file of a version (reads the file through the API, so access rules apply). */
export function FileViewer({ url }: { url: string | null }) {
	const f = useApi<{ file: { path: string; size: number; text: string | null; binary: boolean; truncated: boolean } }>(url);
	if (!url) return <p className="p-4 text-sm text-fg-subtle">选择左侧文件查看内容。</p>;
	if (f.loading)
		return (
			<div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
				<Spinner /> 读取中…
			</div>
		);
	if (f.error) return <p className="p-4 text-sm text-danger">{errorText(f.error)}</p>;
	const file = f.data?.file;
	if (!file) return null;
	if (file.binary) return <p className="p-4 text-sm text-fg-muted">二进制文件（{formatBytes(file.size)}），不预览。</p>;
	return (
		<div data-testid="file-viewer">
			<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">{file.text}</pre>
			{file.truncated ? <p className="border-t border-border px-3 py-1.5 text-xs text-fg-subtle">内容较长，仅显示前 200 KB。</p> : null}
		</div>
	);
}

// ---------------------------------------------------------------- diff
type Diff = SubmissionDetailDTO["diff"][number];
export function DiffView({ diff, previousVersionNo }: { diff: readonly Diff[]; previousVersionNo?: number }) {
	const changed = diff.filter((d) => d.status !== "unchanged");
	if (!changed.length) return <p className="text-sm text-fg-muted">与{previousVersionNo ? ` v${previousVersionNo} ` : "上一版本"}完全相同。</p>;
	return (
		<div className="space-y-3" data-testid="diff">
			<p className="text-xs text-fg-muted">{previousVersionNo ? `相对已批准/上一版本 v${previousVersionNo}：` : "首个版本，全部为新增："} {changed.length} 个文件有变化，{diff.length - changed.length} 个未变。</p>
			{changed.map((d) => (
				<FileDiffBlock key={d.path} d={d} />
			))}
		</div>
	);
}
function FileDiffBlock({ d }: { d: Diff }) {
	const [open, setOpen] = useState(d.status === "modified" || d.path === "SKILL.md" || d.path === "server.json");
	const label = d.status === "added" ? "新增" : d.status === "removed" ? "删除" : "修改";
	return (
		<div className="overflow-hidden rounded-lg border border-border" data-path={d.path} data-status={d.status}>
			<button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 bg-surface-2 px-3 py-1.5 text-left text-sm" aria-expanded={open}>
				<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs">{d.path}</span>
				<Badge tone={d.status === "added" ? "success" : d.status === "removed" ? "danger" : "warning"}>{label}</Badge>
				{d.added !== undefined || d.removed !== undefined ? (
					<span className="text-xs text-fg-subtle">
						{d.added ? <span className="text-success">+{d.added}</span> : null} {d.removed ? <span className="text-danger">−{d.removed}</span> : null}
					</span>
				) : null}
			</button>
			{open ? (
				d.hunks?.length ? (
					<div className="overflow-x-auto font-mono text-[12px] leading-[1.5]">
						{d.hunks.map((h, i) => (
							<div key={i} className="border-t border-border first:border-t-0">
								<div className="bg-surface-2/60 px-3 py-0.5 text-xs text-fg-subtle">
									@@ -{h.oldStart} +{h.newStart} @@
								</div>
								{h.lines.map((l, j) => (
									<div key={j} className={cn("flex whitespace-pre px-3", l.t === "+" && "bg-success-soft text-success", l.t === "-" && "bg-danger-soft text-danger")}>
										<span className="w-4 shrink-0 select-none opacity-70">{l.t === " " ? "" : l.t}</span>
										<span>{l.s}</span>
									</div>
								))}
							</div>
						))}
					</div>
				) : (
					<p className="px-3 py-2 text-xs text-fg-muted">{d.binary ? "二进制文件已变化，无文本差异。" : d.tooLarge ? "文件过大，未计算差异。" : d.status === "added" ? "新文件（在「文件」页签中查看内容）。" : d.status === "removed" ? "该文件已删除。" : "无文本差异。"}</p>
				)
			) : null}
		</div>
	);
}

export const Section = ({ title, children, right, testId }: { title: string; children: React.ReactNode; right?: React.ReactNode; testId?: string }) => (
	<section className="rounded-xl border border-border bg-surface" data-testid={testId}>
		<div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
			<h3 className="text-sm font-medium">{title}</h3>
			{right}
		</div>
		<div className="p-4">{children}</div>
	</section>
);

/** One-sentence verdict of the automated checks (what a reviewer reads first). */
export function checkVerdict(checks: { ok: boolean; findings: readonly { severity: string }[] } | undefined): { tone: "success" | "warning" | "danger" | "neutral"; text: string } {
	if (!checks) return { tone: "neutral", text: "没有自动检查结果" };
	const err = checks.findings.filter((f) => f.severity === "error").length;
	const warn = checks.findings.filter((f) => f.severity === "warn").length;
	if (err) return { tone: "danger", text: `自动检查未通过：有 ${err} 项必须修复${warn ? `、${warn} 项需关注` : ""}` };
	if (warn) return { tone: "warning", text: `自动检查通过，但有 ${warn} 项需要关注` };
	return { tone: "success", text: "自动检查通过，没有发现问题" };
}
