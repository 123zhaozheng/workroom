// "终端" tab: what the agent ran — the code, stdout and stderr, exit status and duration — as readable monospace blocks
// that scroll (oldest first, newest at the bottom). Plain Chinese: no driver or isolation jargon; administrators get the
// technical detail behind a fold when code running is unavailable.
import { Check, ChevronDown, ChevronRight, SquareTerminal, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SandboxRunDTO, SandboxRunsResponse } from "@shared/files";
import type { SandboxInfoDTO } from "@shared/sandbox";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cn, durationText, formatBytes, relTime } from "@/lib/utils";
import { Badge } from "@/components/ui/misc";
import { InfoPop } from "@/components/shell/InfoPop";
import { LoadState, Notice } from "./states";

const STATUS: Record<SandboxRunDTO["status"], { label: string; tone: "success" | "info" | "danger" | "warning" }> = {
	ok: { label: "成功", tone: "success" },
	running: { label: "运行中", tone: "info" },
	error: { label: "出错", tone: "danger" },
	timeout: { label: "超时", tone: "warning" },
	killed: { label: "已终止", tone: "danger" },
	unknown: { label: "结果未知（服务重启时仍在运行，未自动重跑）", tone: "warning" },
};
const PROMPT: Record<string, string> = { python: "python3 main.py", node: "node main.mjs", shell: "sh main.sh", js: "node main.mjs" };

export function TerminalTab({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const infoRes = useApi<{ info: SandboxInfoDTO }>(`/sandbox/${spaceId}`);
	const info = infoRes.data?.info;
	const runs = useApi<SandboxRunsResponse>(`/sandbox/${spaceId}/runs?conversationId=${conversationId}`, { pollMs: 2500 });
	const list = [...(runs.data?.runs ?? [])].reverse();
	const end = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const last = list[list.length - 1];
	useEffect(() => {
		if (stick.current) end.current?.scrollIntoView({ block: "end" });
	}, [list.length, last?.status, last?.stdout.length, last?.stderr.length]);
	const unavailable = info?.isolation === "unavailable";
	return (
		<div data-testid="terminal-tab" className="space-y-3">
			{unavailable ? <Unavailable info={info!} /> : null}
			<LoadState state={runs} what="运行记录">
				{list.length === 0 ? (
					unavailable ? null : (
						<Notice icon={<TerminalSquare />} title="还没有运行过代码" testid="terminal-empty">
							助手运行的命令和输出会显示在这里。
						</Notice>
					)
				) : (
					<>
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">运行记录 · {list.length} 次</h3>
							{info && !unavailable ? (
								<InfoPop label="运行限制" testid="sandbox-limits">
									<span data-testid="sandbox-driver">
										代码在独立环境中运行：限时 {Math.round(info.limits.timeoutMs / 1000)} 秒，内存 {formatBytes(info.limits.memoryBytes)}，网络{info.limits.network ? "开启" : "关闭"}，只能写入工作区。
									</span>
								</InfoPop>
							) : null}
						</div>
						<div
							data-testid="terminal-log"
							className="wr-scroll max-h-[32rem] space-y-2 overflow-auto"
							onScroll={(e) => {
								const el = e.currentTarget;
								stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
							}}
						>
							{list.map((r) => (
								<RunBlock key={r.id} r={r} />
							))}
							<div ref={end} />
						</div>
					</>
				)}
			</LoadState>
		</div>
	);
}

function Unavailable({ info }: { info: SandboxInfoDTO }) {
	const { isOrgAdmin } = useSession();
	return (
		<div data-testid="sandbox-unavailable" role="status" className="rounded-xl border border-border bg-surface-2 p-3 text-[13px]">
			<p className="font-medium text-fg">代码运行暂时不可用</p>
			<p className="mt-0.5 text-fg-muted">助手现在无法执行代码。{isOrgAdmin ? "请在服务器上启用代码运行环境。" : "请联系管理员开启。"}</p>
			{isOrgAdmin ? (
				<details className="mt-2" data-testid="sandbox-admin-hint">
					<summary className="cursor-pointer text-fg-muted">技术详情</summary>
					<p className="mt-1 whitespace-pre-wrap text-fg-muted">{info.isolationDetail}</p>
					{info.driver.howToEnable ? <p className="mt-1 whitespace-pre-wrap text-fg-muted">启用方法：{info.driver.howToEnable}</p> : null}
				</details>
			) : null}
		</div>
	);
}

function RunBlock({ r }: { r: SandboxRunDTO }) {
	const st = STATUS[r.status];
	const lines = r.code.split("\n").length;
	const [open, setOpen] = useState(lines <= 8);
	const tone = r.status === "ok" ? "text-success" : r.status === "running" ? "text-info" : "text-danger";
	const Mark = r.status === "ok" ? Check : r.status === "running" ? null : X;
	return (
		<div data-testid="sandbox-run" data-status={r.status} className="overflow-hidden rounded-xl border border-border bg-surface font-mono text-[12.5px] leading-5">
			<button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-10 w-full items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
				{open ? <ChevronDown className="size-3.5 shrink-0 text-fg-muted" /> : <ChevronRight className="size-3.5 shrink-0 text-fg-muted" />}
				<SquareTerminal className="size-3.5 shrink-0 text-fg-muted" />
				<span className="min-w-0 flex-1 truncate text-fg">{PROMPT[r.language] ?? r.language}</span>
				<Badge tone={st.tone} className="font-sans">
					{st.label}
				</Badge>
				<span className="hidden shrink-0 font-sans text-xs text-fg-muted min-[420px]:inline">{relTime(r.startedAt)}</span>
			</button>
			{open ? (
				<pre data-testid="run-code" className="wr-scroll max-h-48 overflow-auto whitespace-pre border-t border-border px-3 py-2 text-fg-muted">
					{r.code}
				</pre>
			) : null}
			{r.stdout ? (
				<pre data-testid="run-stdout" className="wr-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-fg">
					{r.stdout}
				</pre>
			) : null}
			{r.stderr ? (
				<pre data-testid="run-stderr" className="wr-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-danger-soft px-3 py-2 text-danger">
					{r.stderr}
				</pre>
			) : null}
			<div data-testid="run-exit" className={cn("flex items-center gap-1.5 border-t border-border px-3 py-1.5 font-sans text-xs font-medium", tone)}>
				{Mark ? <Mark className="size-3.5" aria-hidden /> : null}
				{r.status === "running" ? "运行中…" : `退出码 ${r.exitCode ?? "—"}${r.durationMs !== undefined ? ` · 用时 ${durationText(r.durationMs)}` : ""}`}
			</div>
		</div>
	);
}
