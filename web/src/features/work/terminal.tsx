// "终端" tab: what the agent ran in the sandbox — the code/commands, stdout and stderr, exit code and duration — in a
// monospace terminal-style log that scrolls (oldest first, newest at the bottom), plus the active driver and its limits.
import { ChevronDown, ChevronRight, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SandboxRunDTO, SandboxRunsResponse } from "@shared/files";
import type { SandboxInfoDTO } from "@shared/sandbox";
import { useApi } from "@/lib/useApi";
import { cn, durationText, formatBytes, relTime } from "@/lib/utils";
import { Badge, Loadable } from "@/components/ui/misc";

const STATUS: Record<SandboxRunDTO["status"], { label: string; tone: "success" | "info" | "danger" | "warning" }> = {
	ok: { label: "成功", tone: "success" },
	running: { label: "运行中", tone: "info" },
	error: { label: "出错", tone: "danger" },
	timeout: { label: "超时", tone: "warning" },
	killed: { label: "已终止", tone: "danger" },
};
const PROMPT: Record<string, string> = { python: "python3 main.py", node: "node main.mjs", shell: "sh main.sh", js: "node main.mjs" };

export function TerminalTab({ spaceId, conversationId }: { spaceId: string; conversationId: number }) {
	const infoRes = useApi<{ info: SandboxInfoDTO }>(`/sandbox/${spaceId}`);
	const info = { ...infoRes, data: infoRes.data?.info };
	const runs = useApi<SandboxRunsResponse>(`/sandbox/${spaceId}/runs?conversationId=${conversationId}`, { pollMs: 2500 });
	const list = [...(runs.data?.runs ?? [])].reverse();
	const end = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const box = useRef<HTMLDivElement>(null);
	const last = list[list.length - 1];
	useEffect(() => {
		if (stick.current) end.current?.scrollIntoView({ block: "end" });
	}, [list.length, last?.status, last?.stdout.length, last?.stderr.length]);
	return (
		<div data-testid="terminal-tab" className="space-y-3">
			<Loadable state={info} what="执行环境" need="D 组：GET /sandbox/:spaceId">
				{info.data ? <DriverLine info={info.data} /> : null}
			</Loadable>
			<Loadable state={runs} what="执行记录" need="D 组：GET /sandbox/:spaceId/runs">
				{list.length === 0 ? (
					<p className="text-[13px] text-fg-subtle">这个对话还没有执行过代码。助手在沙箱里运行的命令与输出会按时间顺序显示在这里。</p>
				) : (
					<div
						ref={box}
						data-testid="terminal-log"
						className="max-h-[32rem] space-y-2 overflow-auto rounded-lg bg-[#16171a] p-2"
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
				)}
			</Loadable>
		</div>
	);
}

function DriverLine({ info }: { info: SandboxInfoDTO }) {
	const d = info.driver;
	if (info.isolation === "unavailable")
		return (
			<div data-testid="sandbox-unavailable" className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
				<div className="font-medium">沙箱不可用</div>
				<p className="mt-0.5 whitespace-pre-wrap text-fg-muted">{info.isolationDetail}</p>
				{d.howToEnable ? <p className="mt-1 whitespace-pre-wrap text-fg-muted">启用方法：{d.howToEnable}</p> : null}
			</div>
		);
	return (
		<div data-testid="sandbox-driver" className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-fg-muted">
			<span className="font-medium text-fg">{d.label}</span> · 超时 {Math.round(info.limits.timeoutMs / 1000)} 秒 · 内存 {formatBytes(info.limits.memoryBytes)} · 网络{info.limits.network ? "开启" : "关闭"} · 只有 /work 可写
			<details className="mt-1">
				<summary className="cursor-pointer text-fg-subtle">隔离范围与限制</summary>
				<p className="mt-1 whitespace-pre-wrap">{info.isolationDetail}</p>
			</details>
		</div>
	);
}

function RunBlock({ r }: { r: SandboxRunDTO & { driver?: string } }) {
	const st = STATUS[r.status];
	const lines = r.code.split("\n").length;
	const [open, setOpen] = useState(lines <= 8);
	const exitTone = r.status === "ok" ? "text-[#6ee7a8]" : r.status === "running" ? "text-[#8ab4ff]" : "text-[#ff8a8a]";
	return (
		<div data-testid="sandbox-run" data-status={r.status} className="overflow-hidden rounded-md border border-white/10 font-mono text-[12px] leading-5 text-[#d7d9dc]">
			<button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-white/5 px-2.5 py-1 text-left">
				{open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
				<SquareTerminal className="size-3.5 shrink-0 text-[#9aa0a6]" />
				<span className="text-[#9aa0a6]">$</span>
				<span className="min-w-0 flex-1 truncate">{PROMPT[r.language] ?? r.language}</span>
				<Badge tone={st.tone}>{st.label}</Badge>
				<span className="shrink-0 text-[11px] text-[#9aa0a6]">{relTime(r.startedAt)}</span>
			</button>
			{open ? <pre data-testid="run-code" className="max-h-48 overflow-auto whitespace-pre px-3 py-1.5 text-[#aab1b8]">{r.code}</pre> : null}
			{r.stdout ? (
				<pre data-testid="run-stdout" className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-3 py-1.5">{r.stdout}</pre>
			) : null}
			{r.stderr ? (
				<pre data-testid="run-stderr" className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-3 py-1.5 text-[#ff9b9b]">{r.stderr}</pre>
			) : null}
			<div data-testid="run-exit" className={cn("border-t border-white/10 px-3 py-1 text-[11.5px]", exitTone)}>
				{r.status === "running" ? "运行中…" : `[exit ${r.exitCode ?? "—"}${r.durationMs !== undefined ? ` · ${durationText(r.durationMs)}` : ""}${r.driver ? ` · ${r.driver}` : ""}]`}
			</div>
		</div>
	);
}
