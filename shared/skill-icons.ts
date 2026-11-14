// Skill icon library (pure data + matching; the web maps each id to a lucide glyph in features/market/SkillIcon.tsx).
// An icon id is chosen by the author (SKILL.md `icon:` or the picker). With none set, `resolveSkillIcon` guesses from the name /
// category / tags / description by keyword, and otherwise picks a stable default (hash of the name → tone, generic glyph).

export type IconTone = "blue" | "green" | "amber" | "red" | "purple" | "teal" | "gold";
export const ICON_TONES: readonly IconTone[] = ["blue", "green", "amber", "red", "purple", "teal", "gold"];

export interface SkillIconDef {
	readonly id: string;
	readonly label: string;
	readonly tone: IconTone;
	/** Lower-case keywords (Chinese and English) that make this icon the automatic choice. */
	readonly keywords: readonly string[];
}

export const SKILL_ICONS: readonly SkillIconDef[] = [
	{ id: "file-text", label: "文档", tone: "blue", keywords: ["文档", "docx", "word", "document", "doc", "纪要", "公文", "文案稿"] },
	{ id: "spreadsheet", label: "表格", tone: "green", keywords: ["表格", "excel", "xlsx", "csv", "spreadsheet", "电子表格", "报销"] },
	{ id: "presentation", label: "演示", tone: "amber", keywords: ["演示", "幻灯", "ppt", "pptx", "slides", "slide", "presentation", "路演"] },
	{ id: "chart", label: "图表", tone: "purple", keywords: ["图表", "可视化", "chart", "plot", "dashboard", "看板", "visualiz"] },
	{ id: "data-analysis", label: "数据分析", tone: "teal", keywords: ["数据分析", "分析", "统计", "analysis", "analytics", "analyz", "数据洞察", "指标"] },
	{ id: "writing", label: "写作", tone: "blue", keywords: ["写作", "文章", "润色", "改写", "周报", "日报", "月报", "writing", "writer", "copywrit", "文案", "博客"] },
	{ id: "translate", label: "翻译", tone: "purple", keywords: ["翻译", "translate", "translation", "多语言", "本地化", "i18n", "英译", "中译"] },
	{ id: "code", label: "代码", tone: "teal", keywords: ["代码", "编程", "开发", "code", "coding", "python", "javascript", "typescript", "script", "脚本", "debug", "程序"] },
	{ id: "search", label: "搜索", tone: "blue", keywords: ["搜索", "检索", "调研", "search", "research", "查找", "查询", "lookup"] },
	{ id: "mail", label: "邮件", tone: "amber", keywords: ["邮件", "邮箱", "email", "mail", "outlook", "gmail"] },
	{ id: "calendar", label: "日程", tone: "red", keywords: ["日程", "日历", "会议", "calendar", "schedule", "meeting", "排期", "预约"] },
	{ id: "finance", label: "财务", tone: "gold", keywords: ["财务", "财报", "会计", "发票", "预算", "finance", "accounting", "invoice", "budget", "报销单", "税"] },
	{ id: "legal", label: "法务", tone: "gold", keywords: ["法务", "法律", "合同", "条款", "legal", "contract", "law", "诉讼", "知识产权"] },
	{ id: "compliance", label: "合规", tone: "green", keywords: ["合规", "审计", "监管", "compliance", "audit", "政策", "制度", "内控"] },
	{ id: "risk", label: "风控", tone: "red", keywords: ["风控", "风险", "risk", "反欺诈", "预警", "安全评估", "威胁"] },
	{ id: "customer", label: "客户", tone: "amber", keywords: ["客户", "客服", "crm", "customer", "support", "售后", "销售", "商机", "sales"] },
	{ id: "image", label: "图片", tone: "purple", keywords: ["图片", "图像", "海报", "插画", "image", "photo", "picture", "设计", "design", "logo"] },
	{ id: "video", label: "视频", tone: "red", keywords: ["视频", "剪辑", "video", "movie", "短视频", "字幕"] },
	{ id: "audio", label: "音频", tone: "teal", keywords: ["音频", "语音", "录音", "转写", "audio", "voice", "speech", "podcast", "播客", "音乐"] },
	{ id: "pdf", label: "PDF", tone: "red", keywords: ["pdf"] },
	{ id: "web", label: "网页", tone: "blue", keywords: ["网页", "网站", "爬虫", "抓取", "浏览器", "web", "html", "browser", "scrape", "crawl", "url"] },
	{ id: "automation", label: "自动化", tone: "teal", keywords: ["自动化", "流程", "工作流", "automation", "workflow", "pipeline", "批处理", "定时", "rpa"] },
	{ id: "database", label: "数据库", tone: "green", keywords: ["数据库", "sql", "database", "mysql", "postgres", "mongodb", "数据仓库", "etl"] },
	{ id: "knowledge", label: "知识库", tone: "purple", keywords: ["知识库", "知识", "knowledge", "wiki", "faq", "手册", "百科", "资料"] },
	{ id: "approval", label: "审批", tone: "green", keywords: ["审批", "审核", "approval", "review", "签批", "核对"] },
	{ id: "report", label: "报告", tone: "amber", keywords: ["报告", "report", "总结", "汇报", "简报", "复盘"] },
	{ id: "education", label: "培训", tone: "gold", keywords: ["培训", "教学", "学习", "课程", "education", "training", "course", "learn", "考试"] },
	{ id: "marketing", label: "营销", tone: "red", keywords: ["营销", "推广", "运营", "广告", "marketing", "campaign", "seo", "增长", "社媒"] },
	{ id: "people", label: "人事", tone: "blue", keywords: ["人事", "招聘", "简历", "hr", "员工", "绩效", "面试", "入职", "recruit"] },
	{ id: "task", label: "任务", tone: "teal", keywords: ["任务", "待办", "清单", "todo", "task", "checklist", "项目管理", "跟进"] },
	{ id: "chat", label: "对话", tone: "green", keywords: ["对话", "聊天", "问答", "chat", "conversation", "提示词", "prompt", "角色扮演"] },
	{ id: "security", label: "安全", tone: "red", keywords: ["安全", "加密", "权限", "security", "encrypt", "漏洞", "脱敏", "隐私"] },
	{ id: "tool", label: "工具", tone: "gold", keywords: ["工具", "tool", "utility", "转换", "格式化", "convert", "插件"] },
	{ id: "general", label: "通用", tone: "purple", keywords: [] },
];

export const SKILL_ICON_IDS: readonly string[] = SKILL_ICONS.map((i) => i.id);
const BY_ID = new Map(SKILL_ICONS.map((i) => [i.id, i]));
export const iconDef = (id: string | undefined | null): SkillIconDef | undefined => (id ? BY_ID.get(id) : undefined);

/** Stable 32-bit FNV-1a, so the same name always lands on the same default colour. */
export function stableHash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export interface SkillIconInput {
	readonly icon?: string | null;
	readonly name?: string | null;
	readonly slug?: string | null;
	readonly category?: string | null;
	readonly tags?: readonly string[] | null;
	readonly description?: string | null;
}
export interface ResolvedSkillIcon {
	readonly id: string;
	readonly tone: IconTone;
	/** "explicit" = the author's choice, "keyword" = guessed from the text, "default" = hash fallback. */
	readonly source: "explicit" | "keyword" | "default";
}

const hit = (text: string, kws: readonly string[]): number => {
	let best = 0;
	for (const k of kws) {
		if (!text.includes(k)) continue;
		// ASCII keywords must not match inside a longer word: they need a word start, and the short ones (< 6 letters, "doc", "sql")
		// a word end too (optionally plural), so "docker" is not "doc". Longer ones act as stems ("translat", "visualiz").
		if (/^[a-z0-9]+$/.test(k)) {
			const end = k.length < 6 ? "(s|es)?($|[^a-z0-9])" : "";
			if (!new RegExp(`(^|[^a-z0-9])${k}${end}`).test(text)) continue;
		}
		best = Math.max(best, k.length);
	}
	return best;
};

/** Author's icon → keyword guess (name/category first, then tags, slug, description) → stable default. */
export function resolveSkillIcon(s: SkillIconInput): ResolvedSkillIcon {
	const explicit = iconDef(s.icon);
	if (explicit) return { id: explicit.id, tone: explicit.tone, source: "explicit" };
	// Display name + category first (people choose these words), then tags, then the technical slug, then the description.
	const stages = [[s.name, s.category], [...(s.tags ?? [])], [s.slug], [s.description]].map((p) => p.filter(Boolean).join(" ").toLowerCase());
	for (const text of stages) {
		if (!text) continue;
		let pick: SkillIconDef | undefined;
		let score = 0;
		for (const d of SKILL_ICONS) {
			const sc = hit(text, d.keywords);
			if (sc > score) {
				score = sc;
				pick = d;
			}
		}
		if (pick) return { id: pick.id, tone: pick.tone, source: "keyword" };
	}
	const key = `${s.slug ?? ""}|${s.name ?? ""}`;
	return { id: "general", tone: ICON_TONES[stableHash(key) % ICON_TONES.length]!, source: "default" };
}
