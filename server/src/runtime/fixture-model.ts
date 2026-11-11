// Deterministic fixture model ("测试模型，非真实 AI") built on pi-ai's faux provider with a FauxResponseFactory.
// It reads the transcript it is given and answers deterministically. Used for credential-free tests and demos only;
// every answer is prefixed with the label so it can never be mistaken for a real model.
//
// Directive protocol (in the newest user message):
//   [[call <toolName> <json-args>]]   (one or more) → one assistant turn with those tool calls (stopReason toolUse)
//   [[slow <ms>]]                     → wait <ms> (abortable) before the first answer to that input, then stream
//   [[fail]]                          → non-retryable model error (stopReason "error") → run ends model_error
//   [[fail transient]]                → retryable provider error (503); pi retries after a durable backoff (settings.retry)
//   [[fail timeout]]                  → non-retryable upstream timeout (as a provider stream timeout reports it) → run status "timeout"
//   [[reply <text>]]                  → answer exactly "<label> <text>"
// After tool results arrive it answers with a deterministic summary that quotes every tool output of that round.
// Without directives: heuristic demo mode (知识/资料 → kb_search, 生成/报告/文档 → a file tool) when those tools are
// offered, else a plain labelled echo reply.
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";

export const FIXTURE_PROVIDER = "fixture";
export const FIXTURE_MODEL_ID = "workroom-fixture";
export const FIXTURE_LABEL = "【测试模型·非真实AI】";

export interface Directive {
	readonly calls: { name: string; args: Record<string, unknown> }[];
	readonly slowMs?: number;
	readonly fail: boolean;
	/** [[fail transient]]: a retryable provider error (pi retries it after a durable backoff). */
	readonly failTransient?: boolean;
	/** [[fail timeout]]: a non-retryable upstream timeout error. */
	readonly failTimeout?: boolean;
	readonly reply?: string;
}

/** Parse directives from a user text. Robust to JSON containing brackets (balanced-brace scan, string aware). */
export function parseDirectives(text: string): Directive {
	const calls: Directive["calls"] = [];
	let slowMs: number | undefined;
	let fail = false;
	let failTransient = false;
	let failTimeout = false;
	let reply: string | undefined;
	let i = 0;
	while ((i = text.indexOf("[[", i)) !== -1) {
		const rest = text.slice(i + 2);
		const m = /^(call|slow|fail|reply)\b\s*/.exec(rest);
		if (!m) {
			i += 2;
			continue;
		}
		let p = i + 2 + m[0].length;
		const word = m[1];
		if (word === "call") {
			const nm = /^([A-Za-z0-9_.:\-]+)\s*/.exec(text.slice(p));
			if (!nm) {
				i = p;
				continue;
			}
			p += nm[0].length;
			let args: Record<string, unknown> = {};
			if (text[p] === "{") {
				const end = scanJsonObject(text, p);
				if (end > 0) {
					try {
						args = JSON.parse(text.slice(p, end));
					} catch {
						args = {};
					}
					p = end;
				}
			}
			const close = text.indexOf("]]", p);
			if (close === -1) break;
			calls.push({ name: nm[1]!, args });
			i = close + 2;
		} else {
			const close = text.indexOf("]]", p);
			if (close === -1) break;
			const arg = text.slice(p, close).trim();
			if (word === "slow") slowMs = Math.max(0, Math.min(600_000, Number(arg) || 0));
			else if (word === "fail") {
				fail = true;
				if (arg === "transient") failTransient = true;
				if (arg === "timeout") failTimeout = true;
			}
			else reply = arg;
			i = close + 2;
		}
	}
	return { calls, slowMs, fail, failTransient, failTimeout, reply };
}

/** Remove every [[call …]] / [[slow …]] / [[fail]] / [[reply …]] directive (JSON-aware), leaving the human text. */
export function stripDirectives(text: string): string {
	let out = "";
	let i = 0;
	for (;;) {
		const j = text.indexOf("[[", i);
		if (j === -1) return out + text.slice(i);
		const m = /^(call|slow|fail|reply)\b\s*/.exec(text.slice(j + 2));
		if (!m) {
			out += text.slice(i, j + 2);
			i = j + 2;
			continue;
		}
		out += text.slice(i, j);
		let p = j + 2 + m[0].length;
		if (m[1] === "call") {
			const nm = /^[A-Za-z0-9_.:\-]+\s*/.exec(text.slice(p));
			if (nm) p += nm[0].length;
			if (text[p] === "{") {
				const end = scanJsonObject(text, p);
				if (end > 0) p = end;
			}
		}
		const close = text.indexOf("]]", p);
		if (close === -1) return out;
		i = close + 2;
	}
}

function scanJsonObject(text: string, start: number): number {
	let depth = 0;
	let inStr = false;
	for (let j = start; j < text.length; j++) {
		const ch = text[j];
		if (inStr) {
			if (ch === "\\") j++;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	return -1;
}

export function textOfContent(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("");
}

/** Tools currently offered (name → JSON Schema of parameters), reconstructed from system messages (toolsAdded / toolsRemoved). */
export function offeredToolSchemas(messages: readonly Message[]): Map<string, any> {
	const tools = new Map<string, any>();
	for (const m of messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of m.toolsAdded ?? []) tools.set(t.name, t.parameters);
	}
	return tools;
}
export function offeredTools(messages: readonly Message[]): Set<string> {
	return new Set(offeredToolSchemas(messages).keys());
}

/** Fill a tool's required parameters from its JSON Schema with deterministic demo values (demo mode only). */
export function demoArgs(schema: any, hints: { title: string; content: string; query: string }): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const props: Record<string, any> = schema?.properties ?? {};
	const required: string[] = schema?.required ?? Object.keys(props);
	// Required keys, plus well-known optional text fields so a generated document is not empty.
	const keys = [...new Set([...required, ...Object.keys(props).filter((k) => /^(title|content|text|body|markdown)$/i.test(k) && props[k]?.type === "string")])];
	for (const key of keys) {
		const p = props[key] ?? {};
		const enumv: unknown[] | undefined = p.enum ?? (p.const !== undefined ? [p.const] : undefined) ?? p.anyOf?.flatMap((x: any) => (x.const !== undefined ? [x.const] : x.enum ?? []));
		if (enumv?.length) out[key] = enumv.includes("md") ? "md" : enumv.includes("markdown") ? "markdown" : enumv[0];
		else if (p.type === "number" || p.type === "integer") out[key] = p.minimum ?? 1;
		else if (p.type === "boolean") out[key] = false;
		else if (p.type === "array") out[key] = [];
		else if (p.type === "object") out[key] = demoArgs(p, hints);
		else if (/name|title|file/i.test(key)) out[key] = hints.title;
		else if (/query|question|q$|keyword/i.test(key)) out[key] = hints.query;
		else out[key] = hints.content;
	}
	return out;
}

const FILE_TOOL_PREFERENCE = ["files_create", "file_create", "create_file", "artifact_create", "generate_document", "files_generate", "document_create"];

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

let callSeq = 0;
function callId(name: string): string {
	callSeq = (callSeq + 1) % 1_000_000;
	return `fx_${Date.now().toString(36)}_${callSeq}_${name.replace(/[^A-Za-z0-9_]/g, "")}`.slice(0, 64);
}

/** Pure answer function (exported for unit tests): what the fixture answers for a transcript. */
export function fixtureAnswer(messages: readonly Message[]): { message: AssistantMessage; slowMs?: number } {
	const visible = messages.filter((m) => m.role !== "system");
	const last = visible.at(-1);
	const schemas = offeredToolSchemas(messages);
	const tools = new Set(schemas.keys());
	if (!last) return { message: fauxAssistantMessage(`${FIXTURE_LABEL} 没有可回答的内容。`) };

	if (last.role === "toolResult") {
		// Summarize the latest tool round: every result after the last assistant message.
		const results: ToolResultMessage[] = [];
		for (let k = visible.length - 1; k >= 0; k--) {
			const m = visible[k]!;
			if (m.role !== "toolResult") break;
			results.unshift(m as ToolResultMessage);
		}
		const lines = results.map((r) => `- ${r.toolName}${r.isError ? "（失败）" : ""}: ${textOfContent(r.content as TextContent[]).trim().slice(0, 2000)}`);
		return { message: fauxAssistantMessage(`${FIXTURE_LABEL} 工具执行完成，结果如下：\n${lines.join("\n")}`) };
	}

	if (last.role === "user") {
		const text = textOfContent(last.content as TextContent[]);
		const d = parseDirectives(text);
		if (d.fail)
			return {
				message: fauxAssistantMessage([], { stopReason: "error", errorMessage: d.failTransient ? "fixture: simulated 503 service unavailable ([[fail transient]], retryable)" : d.failTimeout ? "fixture: upstream request timed out ([[fail timeout]])" : "fixture: simulated model failure ([[fail]])" }),
				slowMs: d.slowMs,
			};
		if (d.calls.length > 0) {
			const blocks: ToolCall[] = d.calls.map((c) => fauxToolCall(c.name, c.args as ToolCall["arguments"], { id: callId(c.name) }));
			return { message: fauxAssistantMessage(blocks, { stopReason: "toolUse" }), slowMs: d.slowMs };
		}
		if (d.reply !== undefined) return { message: fauxAssistantMessage(`${FIXTURE_LABEL} ${d.reply}`), slowMs: d.slowMs };
		const plain = text.replace(/\[\[[^\]]*\]\]/g, "").trim();
		// Heuristic demo mode, only with tools actually offered.
		if (/知识|资料/.test(plain) && tools.has("kb_search")) {
			const args = { ...demoArgs(schemas.get("kb_search"), { title: plain.slice(0, 40), query: plain.slice(0, 200), content: plain.slice(0, 200) }), query: plain.slice(0, 200) };
			return { message: fauxAssistantMessage([fauxToolCall("kb_search", args as ToolCall["arguments"], { id: callId("kb_search") })], { stopReason: "toolUse" }), slowMs: d.slowMs };
		}
		// 运行/执行/代码/终端/命令 → sandbox_exec (fills the terminal panel with a real run); the command is a fixed,
		// harmless demo script, never text taken from the message.
		if (/运行|执行|代码|终端|命令/.test(plain) && tools.has("sandbox_exec")) {
			const args = { language: "shell", code: "echo '【测试模型·演示】sandbox ok'; uname -s; date -u +%Y-%m-%dT%H:%M:%SZ" };
			return { message: fauxAssistantMessage([fauxToolCall("sandbox_exec", args, { id: callId("sandbox_exec") })], { stopReason: "toolUse" }), slowMs: d.slowMs };
		}
		// 网页/浏览/打开 + an explicit http(s) URL in the message → browse (fills the browser panel).
		const url = /https?:\/\/[^\s"'<>，。]+/.exec(plain)?.[0];
		if (url && /网页|浏览|打开|访问/.test(plain) && tools.has("browse")) {
			return { message: fauxAssistantMessage([fauxToolCall("browse", { url, screenshot: true }, { id: callId("browse") })], { stopReason: "toolUse" }), slowMs: d.slowMs };
		}
		if (/生成|报告|文档/.test(plain)) {
			const fileTool = FILE_TOOL_PREFERENCE.find((n) => tools.has(n)) ?? [...tools].find((n) => /(create|generate).*(file|doc)|(file|doc).*(create|generate)/i.test(n));
			if (fileTool) {
				const title = plain.slice(0, 40) || "报告";
				const args = demoArgs(schemas.get(fileTool), { title, query: plain.slice(0, 200), content: `# ${title}\n\n${FIXTURE_LABEL} 生成的示例内容（演示，非真实 AI 撰写）。` });
				return { message: fauxAssistantMessage([fauxToolCall(fileTool, args as ToolCall["arguments"], { id: callId(fileTool) })], { stopReason: "toolUse" }), slowMs: d.slowMs };
			}
		}
		const echo = plain.length > 200 ? `${plain.slice(0, 200)}…` : plain;
		return { message: fauxAssistantMessage(`${FIXTURE_LABEL} 收到：「${echo}」。这是确定性测试回复，不代表真实 AI 能力。`), slowMs: d.slowMs };
	}
	// Last visible message is an assistant answer (continue after an answer): nothing new to say.
	return { message: fauxAssistantMessage(`${FIXTURE_LABEL} 已经回答过了。`) };
}

/** One model request as the fixture saw it (system messages left out): what the next request really contains. Test-only introspection. */
export interface FixtureRequestMessage {
	readonly role: string;
	readonly text: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	readonly toolCalls?: readonly string[];
}
const requestLog: FixtureRequestMessage[][] = [];
/** The last (up to 40) requests every fixture model in this process served, oldest first. Used by tests to prove what the model is given. */
export const fixtureRequests = (): readonly (readonly FixtureRequestMessage[])[] => requestLog;
export const clearFixtureRequests = (): void => void (requestLog.length = 0);
function recordRequest(messages: readonly Message[]): void {
	requestLog.push(
		messages
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role,
				text: textOfContent((m as { content: string | readonly { type: string; text?: string }[] }).content ?? ""),
				...(m.role === "toolResult" ? { toolName: (m as ToolResultMessage).toolName, isError: !!(m as ToolResultMessage).isError } : {}),
				...(m.role === "assistant" ? { toolCalls: (m as AssistantMessage).content.flatMap((c) => (c.type === "toolCall" ? [c.name] : [])) } : {}),
			})),
	);
	if (requestLog.length > 40) requestLog.shift();
}

export interface FixtureModel {
	readonly provider: Provider;
	readonly providerName: "fixture";
	readonly modelId: "workroom-fixture";
	/** Number of model requests served (for tests). */
	readonly calls: () => number;
}

/** Create the fixture provider. Register with `models.setProvider(fixture.provider)`. */
export function createFixtureModel(options: { tokensPerSecond?: number } = {}): FixtureModel {
	let calls = 0;
	const faux = fauxProvider({
		api: "fixture",
		provider: FIXTURE_PROVIDER,
		models: [{ id: FIXTURE_MODEL_ID, name: "Workroom 测试模型（非真实 AI）", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
		tokensPerSecond: options.tokensPerSecond,
	});
	const factory: FauxResponseFactory = async (context, streamOptions) => {
		calls++;
		recordRequest(context.messages);
		// Keep the faux queue topped up: every request consumes one step and adds one.
		faux.appendResponses([factory]);
		const { message, slowMs } = fixtureAnswer(context.messages);
		// [[slow]] delays every answer whose newest message is that user input (also a retry after a crash).
		if (slowMs) await sleep(slowMs, streamOptions?.signal);
		return message;
	};
	faux.setResponses(Array.from({ length: 16 }, () => factory));
	return { provider: faux.provider, providerName: "fixture", modelId: "workroom-fixture", calls: () => calls };
}

/** True for refs that point at the fixture model. */
export const isFixtureModel = (ref: { provider?: string } | undefined): boolean => ref?.provider === FIXTURE_PROVIDER;

export { fauxText };
