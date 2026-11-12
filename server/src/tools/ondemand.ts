// On-demand tools: built-in tools that are registered and fully executable but not offered to the model at the start of a new
// conversation. The system prompt lists them in one short catalog; `tool_search` loads them (pi-durable control.addTools writes the
// conversation's modelTools, so they stay offered in later rounds and runs). This file is the single list: the runtime, the catalog
// and the tool_search ranking all read it. Tool descriptions/schemas stay with their registrations — nothing here repeats them.

export interface OndemandGroup {
	readonly id: string;
	readonly label: string;
	readonly tools: readonly string[];
	/** One line: what it is for. Not an interface description. */
	readonly summary: string;
	/** Extra search terms (Chinese and English) so a natural-language need finds the group. */
	readonly keywords: string;
}

export const ONDEMAND_GROUPS: readonly OndemandGroup[] = [
	{ id: "credential", label: "凭据与外部 API", tools: ["credential_request", "credential_http", "credential_list"], summary: "向用户申请 API 密钥/令牌，并由服务端代发 HTTPS 请求（你看不到密钥值）", keywords: "凭据 密钥 令牌 token api key secret 授权 外部服务 http 请求 调用接口" },
	{ id: "jobs", label: "后台长任务", tools: ["job_start", "job_status", "job_cancel"], summary: "耗时任务放到后台运行，并查看进度、取消", keywords: "后台 长任务 异步 进度 任务状态 取消 background long running async" },
	{ id: "browser", label: "实时浏览器", tools: ["browser_open", "browser_act", "browser_close"], summary: "打开可交互的浏览器会话（点击、输入、滚动，用户可接管）", keywords: "浏览器 网页 点击 输入 登录 打开页面 交互 截图 browser click" },
	{ id: "skill_manage", label: "技能创建与更新", tools: ["skill_manage"], summary: "把工作区文件创建/更新为技能并走草稿流程", keywords: "技能 创建技能 更新技能 发布技能 草稿 skill draft publish" },
	{ id: "codemode", label: "脚本编排", tools: ["codemode"], summary: "写一段 JavaScript 批量/并行/循环调用多个工具", keywords: "脚本 批量 并行 循环 编排 javascript code mode script batch" },
];

export const ONDEMAND_TOOLS: readonly string[] = ONDEMAND_GROUPS.flatMap((g) => g.tools);

export function ondemandGroupOf(tool: string): OndemandGroup | undefined {
	return ONDEMAND_GROUPS.find((g) => g.tools.includes(tool));
}

// ----- ranking (ASCII words + Chinese character bigrams) -----
const CJK = /[一-鿿]/;
function terms(s: string): string[] {
	const out: string[] = [];
	for (const m of s.toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]+/g)) {
		const w = m[0];
		if (!CJK.test(w)) out.push(w);
		else if (w.length <= 2) out.push(w);
		else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
	}
	return out;
}

export function rankScore(query: string, text: string): number {
	const q = terms(query);
	const t = terms(text);
	if (!q.length) return 0;
	let s = 0;
	for (const w of q) {
		const exact = t.filter((x) => x === w).length;
		const partial = CJK.test(w) ? 0 : t.filter((x) => x !== w && (x.includes(w) || w.includes(x))).length;
		s += exact * 2 + partial * 0.5;
	}
	for (const run of query.match(/[一-鿿]{2,}/g) ?? []) if (text.includes(run)) s += 1;
	return s;
}
