// Round 11 (R4): which backend runs a code_run call. Pure functions (no I/O) so every rule is unit-tested.
// Browser only when ALL of: the organisation allows local execution, the conversation does not prefer the cloud, the language runs in the browser,
// a static scan finds no network / subprocess / package-install / Node-only use, the inputs are small, the timeout is short, and a tab of the
// same user is connected. Anything else runs in the cloud sandbox. The scan is a ROUTING hint (code that wants the network gets one); the
// browser runtime itself is network-isolated by CSP whatever the code does (see web/src/features/localexec/runtime).
import { LOCAL_EXEC_LIMITS, type LocalExecLanguage, type LocalExecPreference } from "../../../../shared/localexec.ts";

export type Backend = "browser" | "cloud";
export type RouteReason = "ok" | "disabled" | "pref_cloud" | "forced_cloud" | "language" | "needs_network" | "needs_node" | "needs_install" | "needs_process" | "inputs_too_large" | "timeout_too_long" | "no_tab";

export interface RouteInput {
	enabled: boolean;
	preference: LocalExecPreference;
	/** The model asked for the cloud explicitly (`backend: "cloud"`). */
	forceCloud?: boolean;
	language: LocalExecLanguage;
	code: string;
	inputBytes: number;
	timeoutSec: number;
	/** A tab of the run's user is connected to this conversation. */
	tabConnected: boolean;
	/** Languages the browser runtime supports in this build. */
	browserLanguages: readonly LocalExecLanguage[];
}
export interface RouteDecision {
	backend: Backend;
	reason: RouteReason;
	/** Plain Chinese text for the tool result / environment panel. */
	why: string;
	/** What the scan matched, when it decided (e.g. "fetch("). */
	match?: string;
}

const WHY: Record<RouteReason, string> = {
	ok: "轻量任务，在浏览器内运行",
	disabled: "管理员未启用本地执行",
	pref_cloud: "该对话设置为只用云端沙箱",
	forced_cloud: "调用方要求使用云端沙箱",
	language: "浏览器内暂不支持该语言",
	needs_network: "代码需要联网",
	needs_node: "代码依赖 Node/系统环境",
	needs_install: "代码需要安装依赖包",
	needs_process: "代码需要启动子进程",
	inputs_too_large: "输入文件较大",
	timeout_too_long: "预计运行时间较长",
	no_tab: "没有可用的浏览器标签页",
};

interface Rule {
	re: RegExp;
	reason: RouteReason;
}
// Network, subprocess, package installs, Node-only APIs. Deliberately conservative: a false positive only costs a cloud run.
const JS_RULES: Rule[] = [
	{ re: /\bfetch\s*\(/, reason: "needs_network" },
	{ re: /\bXMLHttpRequest\b/, reason: "needs_network" },
	{ re: /\bWebSocket\b/, reason: "needs_network" },
	{ re: /\bEventSource\b/, reason: "needs_network" },
	{ re: /\bsendBeacon\b/, reason: "needs_network" },
	{ re: /\bimportScripts\s*\(/, reason: "needs_network" },
	{ re: /\bimport\s*\(/, reason: "needs_network" }, // dynamic import: remote module or node:http/net/tls
	{ re: /\bfrom\s+["'](?:https?:|node:|http|https|net|tls|dgram|dns)/, reason: "needs_network" },
	{ re: /\bchild_process\b/, reason: "needs_process" },
	{ re: /\b(?:execSync|spawnSync|execFile|spawn)\s*\(/, reason: "needs_process" },
	{ re: /\b(?:npm|pnpm|yarn|npx|bun)\s+(?:i|install|add|run|exec|x)\b/, reason: "needs_install" },
	{ re: /\brequire\s*\(/, reason: "needs_node" },
	{ re: /\bprocess\s*\.\s*(?:env|argv|cwd|exit|stdout|stdin|platform|versions|binding)\b/, reason: "needs_node" },
	{ re: /\b(?:__dirname|__filename)\b/, reason: "needs_node" },
	{ re: /\bBuffer\s*\./, reason: "needs_node" },
];
const PY_RULES: Rule[] = [
	{ re: /\b(?:import|from)\s+(?:requests|urllib|urllib3|http|httpx|aiohttp|socket|ssl|ftplib|smtplib|telnetlib|websockets?|websocket|paramiko|grpc)\b/, reason: "needs_network" },
	{ re: /\burlopen\s*\(/, reason: "needs_network" },
	{ re: /\b(?:import|from)\s+(?:subprocess|pexpect|multiprocessing|pty)\b/, reason: "needs_process" },
	{ re: /\bos\s*\.\s*(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?|fork)\b/, reason: "needs_process" },
	{ re: /\basyncio\s*\.\s*create_subprocess/, reason: "needs_process" },
	{ re: /\b(?:pip3?|pipx|conda|uv|apt(?:-get)?|brew)\s+install\b/, reason: "needs_install" },
	{ re: /\bensurepip\b|\bpip\s*\.\s*main\b|\bmicropip\b/, reason: "needs_install" },
	{ re: /(?:^|\n)\s*!\s*(?:pip|apt|curl|wget)\b/, reason: "needs_install" },
];

/** First network / subprocess / install / Node-only use found in the code, or undefined when the code looks like pure computation. */
export function scanCode(language: LocalExecLanguage, code: string): { reason: RouteReason; match: string } | undefined {
	for (const r of language === "javascript" ? JS_RULES : PY_RULES) {
		const m = r.re.exec(code);
		if (m) return { reason: r.reason, match: m[0].trim().slice(0, 40) };
	}
	return undefined;
}

export function decideBackend(i: RouteInput): RouteDecision {
	const cloud = (reason: RouteReason, match?: string): RouteDecision => ({ backend: "cloud", reason, why: WHY[reason], ...(match ? { match } : {}) });
	if (i.forceCloud) return cloud("forced_cloud");
	if (!i.enabled) return cloud("disabled");
	if (i.preference === "cloud") return cloud("pref_cloud");
	if (!i.browserLanguages.includes(i.language)) return cloud("language");
	const hit = scanCode(i.language, i.code);
	if (hit) return cloud(hit.reason, hit.match);
	if (i.inputBytes > LOCAL_EXEC_LIMITS.maxInputBytes) return cloud("inputs_too_large");
	if (i.timeoutSec > LOCAL_EXEC_LIMITS.maxTimeoutSec) return cloud("timeout_too_long");
	if (!i.tabConnected) return cloud("no_tab");
	return { backend: "browser", reason: "ok", why: WHY.ok };
}

/** Browser run failures that are capacity problems (retried once in the cloud); anything else is the code's own error. */
export const CAPACITY_FAILURES = new Set(["timeout", "oom", "unsupported", "tab_lost", "unclaimed"]);
export const FAIL_TEXT: Record<string, string> = {
	timeout: "超时",
	oom: "内存不足",
	unsupported: "浏览器内不支持所需的模块或接口",
	tab_lost: "浏览器标签页已断开",
	unclaimed: "没有标签页接手",
};
