// Round 11 (R2b): execution-intent scorer. Decides, from ONE user message (plus its attachments and a little conversation context), how likely it is
// that answering it will need a code-execution sandbox. Used only to decide whether to START a remote sandbox in the background (prewarm);
// a wrong guess costs one idle sandbox (reclaimed by the idle policy), a miss costs a cold start on the first exec call (tier c still works).
//
// Design: rule-based weighted features combined by a logistic function. No model call, no I/O, no state; scoring a message is well under 1 ms.
//   p = sigmoid(BIAS + sum(weight_i * fired_i))
// Every feature is listed in INTENT_FEATURES (id, weight, description) so the weights can be read, tested and tuned in one place; `signals` of a
// result names the features that fired (for the prewarm log). Weights were tuned against the "train" part of server/test/fixtures/sandbox-intent.json;
// the "heldout" part was never used for tuning (docs/r11-prewarm.md).
//
// Not here: there is no "development template" / project-kind concept in Workroom (assistants have no kind, projects are only "container" | "space"),
// and skills are loaded by the model during a turn, not chosen at message time. The only configuration-level hint that exists is an assistant whose
// default tool list names sandbox tools; that is an input (`assistantTools`).

export interface IntentAttachment {
	readonly name: string;
	readonly mime?: string;
	readonly size?: number;
}

export interface IntentInput {
	/** The user's message text. */
	readonly text: string;
	readonly attachments?: readonly IntentAttachment[];
	/** This conversation already ran code in a sandbox (strong prior: the next message very likely continues that work). */
	readonly usedSandbox?: boolean;
	/** Default tool names of the assistant bound to the conversation, when it declares any. */
	readonly assistantTools?: readonly string[];
}

export interface IntentScore {
	/** Probability (0..1) that this message needs a code-execution sandbox. */
	readonly p: number;
	/** Ids of the features that fired (see INTENT_FEATURES), in table order. */
	readonly signals: string[];
}

export interface IntentFeature {
	readonly id: string;
	readonly weight: number;
	readonly description: string;
}

/** Intercept: with no signal at all the probability is sigmoid(-2.4) = 8%. */
export const INTENT_BIAS = -2.4;
/** Default prewarm threshold (the user's requirement: 30 %). */
export const DEFAULT_PREWARM_THRESHOLD = 0.3;
/** Only this much of a message is scanned (a pasted 100 kB log says nothing more after its first screens). */
const MAX_SCAN_CHARS = 6000;

// ---------------------------------------------------------------- attachment classes

const DATA_EXT = new Set(["csv", "tsv", "xlsx", "xls", "xlsm", "ods", "json", "jsonl", "ndjson", "parquet", "feather", "sqlite", "sqlite3", "db", "sav", "dta", "npy", "npz", "pkl", "h5", "xml"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "whl"]);
const CODE_EXT = new Set(["py", "ipynb", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "go", "rs", "java", "c", "cc", "cpp", "h", "hpp", "cs", "rb", "php", "r", "sql", "swift", "kt", "lua", "pl", "dockerfile", "makefile"]);
const MEDIA_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "m4a", "ogg", "bin"]);
const DOC_EXT = new Set(["pdf", "docx", "doc", "pptx", "ppt", "odt", "rtf", "epub"]);

type AttachClass = "data" | "archive" | "code" | "media" | "doc" | "text";

function extOf(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const i = base.lastIndexOf(".");
	return i < 0 ? base.toLowerCase() : base.slice(i + 1).toLowerCase();
}

function classify(a: IntentAttachment): AttachClass {
	const ext = extOf(a.name);
	if (ARCHIVE_EXT.has(ext)) return "archive";
	if (DATA_EXT.has(ext)) return "data";
	if (CODE_EXT.has(ext)) return "code";
	if (MEDIA_EXT.has(ext)) return "media";
	if (DOC_EXT.has(ext)) return "doc";
	const m = (a.mime ?? "").toLowerCase();
	if (/zip|tar|gzip|compressed|7z|rar/.test(m)) return "archive";
	if (/csv|spreadsheet|excel|json|parquet|sqlite|x-ipynb/.test(m)) return "data";
	if (/^image\/|^video\/|^audio\//.test(m)) return "media";
	if (/pdf|word|presentation|msword/.test(m)) return "doc";
	return "text";
}

// ---------------------------------------------------------------- text patterns (Chinese + English; compiled once)

const RUN_CODE = /(运行|执行|跑(?:一下|一遍|个|下|通)?)[^。！？\n]{0,10}(代码|脚本|程序|命令|python|node|bash|shell|sql|pytest|测试|用例|notebook|这段|这个|它|一遍)|(代码|脚本|程序|函数|测试)[^。！？\n]{0,6}(跑|运行|执行)|\b(run|execute|exec)\b[^.!?\n]{0,24}\b(code|script|program|command|python|node|bash|shell|sql|tests?|pytest|notebook|this|it|that|`)|(?<!`)`(?:npm|pip|python3?|node|pytest|make|cargo|go|docker)\b[^`\n]*`(?!`)/i;
const SANDBOX_WORD = /沙箱|沙盒|sandbox|云端(?:环境|运行|执行)|终端|terminal|jupyter|\brepl\b/i;
const BUILD_PROGRAM = /(写|编写|实现|开发|做|搭|生成|create|write|build|make|develop)[^。！？\n]{0,12}(脚本|爬虫|程序|\bscripts?\b|scraper|crawler|\bbot\b|\bcli\b|命令行工具|web ?app|flask|django|fastapi|express|小游戏|网站)/i;
const CODE_LANG = /\b(python3?|pandas|numpy|scipy|matplotlib|seaborn|sklearn|node\.?js|bash|powershell|golang|rust|jupyter|pytest|regex|正则)\b|python|脚本/i;
const DATA_ANALYSIS = /数据分析|统计分析|分析[^。！？\n]{0,6}(数据|表格|日志|csv|excel|数据集)|回归|聚类|相关(性|系数)|透视表?|描述性统计|均值|中位数|标准差|词频|频率最高|出现(次数|频率)|统计[^。！？\n]{0,15}(次数|数量|个数|总数|频率|占比|多少|平均)|按[^。！？\n]{0,6}(汇总|统计|分组)|(分组|汇总)统计|dataframe|data ?analysis|analy[sz]e[^.!?\n]{0,16}\b(data|dataset|csv|spreadsheet|logs?|numbers)\b|regression|clustering|correlation|\bpivot|summary statistics|aggregate|group(ed)? by|count[^.!?\n]{0,16}\bby\b/i;
const CHART = /画[^。！？\n]{0,24}(图|曲线|图表)|绘(制|图)|(折线|柱状|柱形|饼|散点|热力|直方|箱线|条形)图|可视化|图表|\bplot(s|ting)?\b|\bchart\b|\bgraph\b|histogram|heatmap|visuali[sz]e|matplotlib|seaborn|曲线图/i;
const FILE_VERB = /转(?:换|成|为|码)|格式转换|合并|拆分|切分|截出|截取|压缩|解压|批量|重命名|裁剪|缩放|去重|清洗|ocr|识别[^。！？\n]{0,8}(文字|文本)|convert|\bmerge|\bsplit\b|compress|unzip|\bextract|\bbatch\b|rename|resize|\bcrop|dedupe|\bclean\b|transcode|ffmpeg|pandoc|导出(?:所有|全部|成|为)?[^。！？\n]{0,6}(图片|文件)|打包/i;
const FILE_NOUN = /\b(csv|xlsx?|pdfs?|zip|tar|gz|json|png|jpe?g|gif|mp4|mp3|wav|docx?|pptx?|sqlite|markdown)\b|excel|图片|照片|视频|音频|文件夹|压缩包|表格|数据集|日志文件|\bfiles?\b|images?|photos?|videos?|spreadsheets?|文件/i;
const INSTALL_BUILD = /pip3? install|\bnpm (?:i|install|run|ci|test)\b|\byarn (?:add|install|build)\b|\bpnpm\b|apt(?:-get)? install|brew install|安装[^。！？\n]{0,6}(依赖|包|库|环境|软件|ffmpeg|numpy|pandas)|编译|构建|打包|部署|\bdocker ?(?:build|run|compose|file)?\b|dockerfile|git clone|\bcmake\b|\bcargo\b|go build|\bmvn\b|gradle|\bcompile|build (?:the |this |my )?(?:project|app|image)|\bdeploy|install (?:the )?(?:package|dependenc|librar|ffmpeg|numpy|pandas|requests)|\binstall \w+|virtualenv|\bvenv\b|搭建[^。！？\n]{0,4}环境|配置环境|启动服务|\bdev server/i;
const SHELL_LINE = /^[ \t]*(?:\$[ \t]*)?(?:ls|cd|grep|curl|wget|git|python3?|node|npm|npx|pip3?|docker|chmod|mkdir|tar|unzip|sudo|apt(?:-get)?|brew|ffmpeg|pytest)[ \t]+\S/im;
const NETWORK_TASK = /爬取|爬虫|抓取|采集|\bscrap(?:e|ing)\b|\bcrawl|download (?:the |this |all )?(?:file|data|dataset|video|page|repo)|下载(?:文件|数据|视频|网页|页面)|\bcurl\b|调用[^。！？\n]{0,6}api|call (?:the |this )?api|fetch (?:the )?(?:url|page|data)|returns? 200|接口(?:是否|能否|返回)/i;
const COMPUTE = /蒙特卡洛|monte carlo|模拟[^。！？\n]{0,12}(次|万)|simulate|benchmark|跑分|压测|斐波那契|fibonacci|阶乘|factorial|素数|质数|\b(?:md5|sha-?\d+|base64|hash)\b|哈希|计算[^。！？\n]{0,12}(?:前\d+|\d{4,})|random (?:integers|numbers)|随机(?:数|生成)|生成[^。！？\n]{0,8}\d{3,}[^。！？\n]{0,4}(行|条)|qr ?code|二维码/i;
const CODE_LIKE = /^[ \t]*(?:def \w+\(|class \w+[:(]|import [\w.]+|from [\w.]+ import|const \w+ ?=|let \w+ ?=|function \w+\(|console\.log|print\(|select .+ from |#include|public static void|fn main|package main|create table)/im;
const FENCE = /```/;
const FENCE_LANG = /```[ \t]*(?:python|py|js|javascript|ts|typescript|bash|sh|shell|sql|r|go|rust|rs|java|c|cpp|cs|ruby|php)\b/i;
const DATA_VERB = /分析|统计|处理|清洗|转换|计算|汇总|整理|合并|拆分|提取|对比|检查|校验|解析|\banaly[sz]e|\bprocess|\bparse|\bclean|\bcompute|\bcalculate|\baggregate|\bcheck\b|\bconvert|\bextract|\bcount|\bmerge|\bcompress|\bresize/i;

const WRITING = /(写|撰写|起草|拟|润色|改写|重写|扩写|缩写|续写|编|起)[^。！？\n]{0,10}(邮件|文章|文案|报告|周报|日报|简历|通知|公告|演讲|稿|诗|故事|小说|作文|标题|名字|评论|回复|信|方案|计划|简介|口号|读后感|大纲|需求文档|消息)|润色|改得|proofread|rewrite|polish|\bdraft (?:a|an|the|my)\b|\bwrite (?:a|an|the|my|some)?\s?(?:short )?(?:email|essay|article|poem|story|letter|post|summary|bio|cover letter|speech|blog)|improve (?:my|this) (?:writing|text|email)|\bslogan\b|catchy|写一(?:篇|封|份|首|段)/i;
const TRANSLATE = /翻译|译成|译为|英译中|中译英|translate|用(?:英文|中文|日语|法语)[^。！？\n]{0,4}(?:说|表达|怎么)/i;
const EXPLAIN = /总结|概括|归纳|摘要|summari[sz]e|tl;?dr|解释|讲解|讲讲|说明一下|什么是|是什么意思|什么意思|为什么|区别|有什么不同|如何理解|原理|介绍(?:一下)?|\bexplain|\bwhat(?:'s| is| are| does)\b|\bwhy (?:is|does|do|was)\b|difference between|how does .{0,30} work|meaning of|\bdescribe\b|原因是什么|有什么需要改进|审一下/i;
const CHITCHAT = /^\s*(?:你好|您好|嗨|哈喽|hi\b|hello\b|hey\b|thanks?\b|thank you|谢谢|好的|在吗|早上好|晚安)/i;
const ADVICE = /推荐|建议|有哪些|怎么看|如何看待|前景|职业|学习(?:路线|计划)|入门|\bshould i\b|recommend|any tips|pros and cons|优缺点|对比|比较|\bcompare\b|better to|笑话|\bjoke\b|旅行|行程|食谱|\brecipe\b|技巧|怎样写好|如何向|politely|\bbest way\b/i;

// ---------------------------------------------------------------- feature table

interface Ctx {
	readonly text: string;
	readonly attachments: readonly AttachClass[];
	readonly usedSandbox: boolean;
	readonly assistantTools: readonly string[];
}
interface Feature extends IntentFeature {
	readonly test: (c: Ctx) => boolean;
	/** Negative "no file, just prose" features are weakened when the message brings data / code / archives (the user plainly wants them worked on). */
	readonly dampedByAttachments?: boolean;
}

const hasClass = (c: Ctx, k: AttachClass) => c.attachments.includes(k);
const hasWorkFile = (c: Ctx) => c.attachments.some((a) => a === "data" || a === "archive" || a === "code");

const FEATURES: readonly Feature[] = [
	// ---- context
	{ id: "used_sandbox", weight: 2.2, description: "this conversation already ran code in a sandbox (the next message usually continues that work)", test: (c) => c.usedSandbox },
	{ id: "assistant_sandbox_tools", weight: 1.0, description: "the bound assistant's default tools name sandbox tools", test: (c) => c.assistantTools.some((t) => t.startsWith("sandbox_") || t === "codemode") },
	// ---- explicit / strong textual signals
	{ id: "sandbox_word", weight: 2.6, description: "mentions a sandbox / terminal / Jupyter / REPL", test: (c) => SANDBOX_WORD.test(c.text) },
	{ id: "run_code", weight: 2.0, description: "asks to run / execute code, a script, a command or tests", test: (c) => RUN_CODE.test(c.text) },
	{ id: "shell_command", weight: 1.5, description: "a line that looks like a shell command (ls, cd, git, pip, npm, python …)", test: (c) => SHELL_LINE.test(c.text) },
	{ id: "install_build_deploy", weight: 1.4, description: "install / build / compile / package / deploy / docker", test: (c) => INSTALL_BUILD.test(c.text) },
	{ id: "fenced_code", weight: 1.0, description: "a fenced code block", test: (c) => FENCE.test(c.text) },
	{ id: "fenced_code_lang", weight: 0.5, description: "the fence names a runnable language", test: (c) => FENCE_LANG.test(c.text) },
	{ id: "code_like_lines", weight: 0.8, description: "unfenced lines that look like source code: def / import / SELECT … FROM (a fenced block is counted once, by fenced_code)", test: (c) => !FENCE.test(c.text) && CODE_LIKE.test(c.text) },
	{ id: "build_program", weight: 1.4, description: "asks for a script / scraper / small app to be written", test: (c) => BUILD_PROGRAM.test(c.text) },
	{ id: "code_language", weight: 0.6, description: "names Python / pandas / numpy / bash / regex …", test: (c) => CODE_LANG.test(c.text.replace(/```[ \t]*\w*/g, "```")) },
	{ id: "data_analysis", weight: 1.8, description: "data analysis / statistics / regression / pivot / counting by group", test: (c) => DATA_ANALYSIS.test(c.text) },
	{ id: "chart", weight: 1.7, description: "draw / plot a chart or graph", test: (c) => CHART.test(c.text) },
	{ id: "file_task", weight: 1.6, description: "a conversion / merge / split / compress / batch verb together with a file noun", test: (c) => FILE_VERB.test(c.text) && FILE_NOUN.test(c.text) },
	{ id: "network_task", weight: 1.6, description: "scrape / crawl / download / call an API / curl", test: (c) => NETWORK_TASK.test(c.text) },
	{ id: "compute_task", weight: 1.6, description: "simulation / benchmark / hash / large or exact computation / generate many rows", test: (c) => COMPUTE.test(c.text) },
	// ---- attachments (strongest class counts once; the data-verb interplay is separate)
	{ id: "attach_data", weight: 2.0, description: "a data file (csv / xlsx / json / parquet / sqlite …) is attached", test: (c) => hasClass(c, "data") },
	{ id: "attach_archive", weight: 2.0, description: "an archive (zip / tar / gz / 7z …) is attached", test: (c) => hasClass(c, "archive") },
	{ id: "attach_code", weight: 1.8, description: "a source file or notebook is attached", test: (c) => hasClass(c, "code") },
	{ id: "attach_media", weight: 0.8, description: "an image / audio / video file is attached", test: (c) => hasClass(c, "media") },
	{ id: "attach_work_verb", weight: 0.8, description: "a data / code / archive / media attachment together with a work verb (analyse, convert, count, …)", test: (c) => (hasWorkFile(c) || hasClass(c, "media")) && DATA_VERB.test(c.text) },
	// ---- negatives: prose-only requests
	{ id: "writing_request", weight: -1.4, description: "write / polish / rewrite an email, article, report, poem …", dampedByAttachments: true, test: (c) => WRITING.test(c.text) },
	{ id: "translation", weight: -1.4, description: "translate", dampedByAttachments: true, test: (c) => TRANSLATE.test(c.text) },
	{ id: "explain_summarize", weight: -0.9, description: "explain / summarise / describe / what is … / why …", dampedByAttachments: true, test: (c) => EXPLAIN.test(c.text) },
	{ id: "advice_opinion", weight: -0.8, description: "recommendation / opinion / comparison / career / planning questions", dampedByAttachments: true, test: (c) => ADVICE.test(c.text) },
	{ id: "chitchat", weight: -1.5, description: "a short greeting / thanks (not inside a conversation that is already running code)", test: (c) => !c.usedSandbox && c.text.length <= 24 && CHITCHAT.test(c.text) },
];

/** Public, read-only view of the weights (docs, tests, tuning tools). */
export const INTENT_FEATURES: readonly IntentFeature[] = FEATURES.map(({ id, weight, description }) => ({ id, weight, description }));
/** Factor applied to the "prose-only" negatives when a data / code / archive file comes with the message. */
export const ATTACHMENT_DAMPING = 0.5;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Score one message. Pure and synchronous; never throws (a malformed input scores like an empty message).
 * p ≥ threshold (default 0.3) means "start the sandbox in the background".
 */
export function scoreExecIntent(input: IntentInput): IntentScore {
	const text = typeof input?.text === "string" ? input.text.slice(0, MAX_SCAN_CHARS) : "";
	const atts = Array.isArray(input?.attachments) ? input.attachments.filter((a) => a && typeof a.name === "string").map(classify) : [];
	const ctx: Ctx = { text, attachments: atts, usedSandbox: input?.usedSandbox === true, assistantTools: Array.isArray(input?.assistantTools) ? input.assistantTools : [] };
	const damp = hasWorkFile(ctx) ? ATTACHMENT_DAMPING : 1;
	let z = INTENT_BIAS;
	const signals: string[] = [];
	for (const f of FEATURES) {
		if (!f.test(ctx)) continue;
		signals.push(f.id);
		z += f.dampedByAttachments && f.weight < 0 ? f.weight * damp : f.weight;
	}
	return { p: sigmoid(z), signals };
}
