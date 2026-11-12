// Human wording for tool calls: one line per step ("检索知识库「报销」"), a present-tense form for the running state,
// and the one-line outcome. Raw arguments / results are never produced here; the UI keeps them behind 「技术详情」.
import type { SubagentDTO, ToolCallDTO, ToolResultEntryDTO } from "@shared/chat";
import { browseOf, cardsOf, citationsOf } from "./model";
import { cleanErrorText, cleanTestText } from "./testText";

export type ToolKind = "kb" | "file" | "code" | "web" | "agent" | "connector" | "job" | "skill" | "memory" | "wait" | "approval" | "other";

export interface ToolView {
	kind: ToolKind;
	/** "检索知识库「报销」" */
	title: string;
	/** "正在检索知识库" (the UI appends the ellipsis) */
	running: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const clip = (s: string, n = 28): string => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const quote = (s: string): string => (s ? `「${clip(s)}」` : "");
/** "/work/out/a.md" → "a.md": the file name reads better than the whole virtual path in a one-line title. */
const base = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

export function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return clip(url, 40);
	}
}

const LANGUAGE: Record<string, string> = { shell: "命令行", bash: "命令行", sh: "命令行", python: "Python", py: "Python", node: "JavaScript", javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", ts: "TypeScript" };
const BROWSER_ACT: Record<string, string> = { navigate: "访问", click: "点击", type: "输入", press: "按键", scroll: "滚动", back: "后退", forward: "前进", reload: "刷新" };

/** Connector tools are named mcp__<connector>__<tool>. */
export function parseMcpName(name: string): { connector: string; tool: string } | null {
	if (!name.startsWith("mcp__")) return null;
	const [, connector = "", ...rest] = name.split("__");
	return { connector, tool: rest.join("__").replace(/[_-]+/g, " ").trim() };
}

export function describeTool(call: Pick<ToolCallDTO, "name" | "arguments">, extra: { result?: ToolResultEntryDTO; subagent?: SubagentDTO } = {}): ToolView {
	const a = obj(call.arguments);
	const name = call.name;
	const mcp = parseMcpName(name);
	if (mcp) return { kind: "connector", title: `${mcp.connector}：${mcp.tool}`, running: `正在调用连接「${mcp.connector}」` };
	switch (name) {
		case "kb_search":
			return { kind: "kb", title: `检索知识库${quote(str(a.query))}`, running: "正在检索知识库" };
		// ---- round 14 unified tools
		case "ls":
			return { kind: "file", title: `查看目录 ${str(a.path) || "/work"}`, running: "正在查看目录" };
		case "read":
			return { kind: "file", title: `读取${quote(base(str(a.path)))}`, running: "正在读取文件" };
		case "write":
			return { kind: "file", title: `写入${quote(base(str(a.path)))}`, running: "正在写入文件" };
		case "edit":
			return { kind: "file", title: `修改${quote(base(str(a.path)))}`, running: "正在修改文件" };
		case "search":
			return { kind: "file", title: `搜索${quote(str(a.query))}`, running: "正在搜索" };
		case "remove":
			return { kind: "file", title: `删除${quote(base(str(a.path)))}`, running: "正在删除" };
		case "exec":
			return { kind: "code", title: "运行命令", running: "正在运行命令" };
		case "present_file": {
			const item = extra.result ? cardsOf(name, extra.result.details)[0] : undefined;
			return { kind: "file", title: `交付文件${quote(item?.name ?? (str(a.name) || base(str(a.source))))}`, running: "正在交付文件" };
		}
		case "copy_to_work":
			return { kind: "file", title: `复制${quote(base(str(a.source)))}到工作区`, running: "正在复制到工作区" };
		case "file_create":
			return { kind: "file", title: `生成文件${quote(str(a.name) || str(a.title))}`, running: "正在生成文件" };
		case "file_revise": {
			const art = extra.result ? cardsOf(name, extra.result.details)[0] : undefined;
			return { kind: "file", title: `修改文件${quote(art?.name ?? str(a.name))}`, running: "正在修改文件" };
		}
		case "file_read":
			return { kind: "file", title: "读取文件", running: "正在读取文件" };
		case "file_list":
			return { kind: "file", title: `查看文件列表${quote(str(a.q))}`, running: "正在查看文件列表" };
		case "sandbox_exec": {
			const lang = LANGUAGE[str(a.language).toLowerCase()] ?? str(a.language);
			return { kind: "code", title: `运行代码${lang ? `（${lang}）` : ""}`, running: "正在运行代码" };
		}
		case "code_run": {
			const lang = LANGUAGE[str(a.language).toLowerCase()] ?? str(a.language);
			return { kind: "code", title: `运行代码${lang ? `（${lang}）` : ""}`, running: "正在运行代码" };
		}
		case "sandbox_write_file":
			return { kind: "code", title: `写入工作区文件${quote(str(a.path))}`, running: "正在写入工作区文件" };
		case "sandbox_read_file":
			return { kind: "code", title: `读取工作区文件${quote(str(a.path))}`, running: "正在读取工作区文件" };
		case "sandbox_import":
			return { kind: "code", title: "把文件导入工作区", running: "正在导入文件" };
		case "sandbox_list":
			return { kind: "code", title: "查看工作区文件", running: "正在查看工作区文件" };
		case "sandbox_publish":
			return { kind: "file", title: `发布成果${quote(str(a.name) || str(a.path))}`, running: "正在发布成果" };
		case "browse":
		case "browser_open": {
			const host = hostOf(str(a.url));
			return { kind: "web", title: `打开网页${host ? ` ${host}` : ""}`, running: "正在打开网页" };
		}
		case "browser_act": {
			const act = BROWSER_ACT[str(a.type)] ?? "操作";
			return { kind: "web", title: `操作网页：${act}`, running: "正在操作网页" };
		}
		case "browser_close":
			return { kind: "web", title: "关闭网页", running: "正在关闭网页" };
		case "delegate": {
			const who = extra.subagent?.memberName || str(a.member);
			return { kind: "agent", title: `交给${who ? `「${clip(who, 16)}」` : "成员"}处理`, running: `正在等待${who ? `「${clip(who, 16)}」` : "成员"}` };
		}
		case "tool_search":
			return { kind: "connector", title: `查找可用工具${quote(str(a.query))}`, running: "正在查找可用工具" };
		case "memory_save":
			return { kind: "memory", title: "保存到记忆", running: "正在保存记忆" };
		case "skill": {
			const act = str(a.action);
			const nm = str(a.name);
			if (act === "search") return { kind: "skill", title: `查找技能${quote(str(a.q) || str(a.query))}`, running: "正在查找技能" };
			if (act === "load") return { kind: "skill", title: `加载技能${quote(nm)}`, running: "正在加载技能" };
			if (act === "read") return { kind: "skill", title: `读取技能文件${str(a.path) ? ` ${clip(str(a.path), 40)}` : ""}`, running: "正在读取技能文件" };
			if (act === "run") return { kind: "skill", title: `运行技能${quote(nm)}`, running: "正在运行技能" };
			return { kind: "skill", title: "查看可用技能", running: "正在查看可用技能" };
		}
		case "skill_manage": {
			const act = str(a.action);
			if (act === "submit_draft") return { kind: "skill", title: `提交技能草稿${quote(str(a.dir))}`, running: "正在提交技能草稿" };
			if (act === "get_draft") return { kind: "skill", title: "查看技能草稿", running: "正在查看技能草稿" };
			if (act === "checkout") return { kind: "skill", title: `取出技能文件${quote(str(a.name) || str(a.skillId))}`, running: "正在取出技能文件" };
			return { kind: "skill", title: "管理技能草稿", running: "正在处理技能草稿" };
		}
		case "skill_load":
			return { kind: "skill", title: `加载技能${quote(str(a.name))}`, running: "正在加载技能" };
		case "skill_run":
			return { kind: "skill", title: `运行技能${quote(str(a.name))}`, running: "正在运行技能" };
		case "skill_read":
			return { kind: "skill", title: `读取技能资料${quote(str(a.name))}`, running: "正在读取技能资料" };
		case "skill_list":
			return { kind: "skill", title: "查看可用技能", running: "正在查看可用技能" };
		case "credential_request": {
			const svc = str(a.service);
			return { kind: "other", title: `请求凭据${quote(svc)}`, running: "正在等待你提供凭据" };
		}
		case "credential_http": {
			const host = hostOf(str(a.url));
			return { kind: "web", title: `用凭据访问${host ? ` ${host}` : "外部服务"}`, running: "正在用凭据访问外部服务" };
		}
		case "credential_list":
			return { kind: "other", title: "查看可用凭据", running: "正在查看可用凭据" };
		case "job_start":
			return { kind: "job", title: "启动后台任务", running: "正在启动后台任务" };
		case "job_status":
			return { kind: "job", title: "查看后台任务进度", running: "正在查看后台任务" };
		case "job_cancel":
			return { kind: "job", title: "取消后台任务", running: "正在取消后台任务" };
		case "wr_fixture_wait": {
			const ms = Number(a.ms);
			return { kind: "wait", title: `等待${Number.isFinite(ms) && ms > 0 ? ` ${ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`}` : ""}`, running: "正在等待" };
		}
		case "wr_fixture_approval":
			return { kind: "approval", title: `请求确认${quote(str(a.title))}`, running: "正在请求确认" };
		case "wr_fixture_effect":
			return { kind: "other", title: `写入外部系统${quote(str(a.key))}`, running: "正在写入外部系统" };
		case "wr_fixture_echo":
			return { kind: "other", title: "回显内容", running: "正在回显" };
		default:
			return { kind: "other", title: `使用工具${quote(name)}`, running: `正在使用工具${quote(name)}` };
	}
}

/** The first line of a tool's text output, without directive noise, for an error line. */
export function firstLine(text: string, max = 140): string {
	// tool errors arrive wrapped as "<harness>\n[error] …\n</harness>": the sentence inside is the line worth showing
	const line = cleanErrorText(cleanTestText(text))
		.split("\n")
		.map((l) => l.trim().replace(/^\[error\]\s*/, ""))
		.find((l) => l && !/^<\/?harness>$/.test(l));
	if (!line) return "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One human line about the outcome of a finished tool call; "" when there is nothing worth adding to the title. */
export function resultLine(call: Pick<ToolCallDTO, "name">, result: ToolResultEntryDTO | undefined, subagent?: SubagentDTO): string {
	if (!result) return "";
	if (result.isError && (result.details as { status?: string } | undefined)?.status === "needs_reconciliation") return "外部操作的结果不确定，系统没有重做；请在下方核对。";
	if (result.isError) return firstLine(result.text) || "这一步没有成功";
	const cites = citationsOf(result.details).length;
	const files = cardsOf(call.name, result.details);
	switch (call.name) {
		case "kb_search":
			return cites ? `找到 ${cites} 处相关资料` : "没有找到相关资料";
		case "present_file":
			return files[0] ? `已交付「${files[0].name}」` : "";
		case "file_create":
		case "file_revise":
		case "sandbox_publish":
			return files[0] ? `${call.name === "file_revise" ? "已更新" : "已生成"}「${files[0].name}」` : "";
		case "browse":
		case "browser_open": {
			const b = browseOf(result.details);
			return b?.title ? `已打开「${clip(b.title, 40)}」` : "";
		}
		case "delegate":
			return subagent?.resultSummary ? clip(subagent.resultSummary, 120) : subagent?.failure ? clip(subagent.failure, 120) : "";
		default:
			return "";
	}
}
