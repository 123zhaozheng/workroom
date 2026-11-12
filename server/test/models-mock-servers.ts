// In-test mock upstreams for the model-provider tests (no credentials, no network):
//   - OpenAI-compatible Chat Completions server: GET /v1/models, POST /v1/chat/completions (SSE streaming, tool calls, usage chunk)
//   - Anthropic Messages server: GET /v1/models (paginated shape), POST /v1/messages (SSE streaming, tool_use)
// Both authenticate with a fixed key and record every request so tests can assert what was (and was not) sent where.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body?: any;
}
export interface MockServer {
	server: Server;
	port: number;
	/** Base URLs as an operator would enter them. */
	url: string;
	requests: Recorded[];
	/** Make the next N completion requests fail with this HTTP status (for failover tests). */
	failNext(status: number, times?: number): void;
	close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
const lastUserText = (messages: any[]): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("");
	}
	return "";
};
const sse = (res: ServerResponse, event: string | null, data: unknown) => res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

function listen(handler: (req: IncomingMessage, res: ServerResponse, rec: Recorded) => Promise<void> | void): Promise<MockServer> {
	const requests: Recorded[] = [];
	let failStatus = 0;
	let failTimes = 0;
	const server = createServer(async (req, res) => {
		const rec: Recorded = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers };
		if (req.method === "POST") rec.body = await readBody(req);
		requests.push(rec);
		if (failTimes > 0 && req.method === "POST") {
			failTimes--;
			res.writeHead(failStatus, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `mock upstream failure ${failStatus}`, type: "server_error" } }));
			return;
		}
		try {
			await handler(req, res, rec);
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: (e as Error).message } }));
		}
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				server,
				port,
				url: `http://127.0.0.1:${port}`,
				requests,
				failNext(status, times = 1) {
					failStatus = status;
					failTimes = times;
				},
				close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
			});
		}),
	);
}

export const OPENAI_KEY = "sk-mock-openai-KEY-0123456789abcdef";
export const ANTHROPIC_KEY = "sk-ant-mock-KEY-0123456789abcdef";

/** OpenAI-compatible: base URL = `${url}/v1`. Models: mock-chat (text), mock-vision, text-embedding-mock. */
export function startOpenAIMock(opts: { key?: string | null; models?: string[]; reply?: string } = {}): Promise<MockServer> {
	const key = opts.key === undefined ? OPENAI_KEY : opts.key; // null = no auth required (local Ollama / vLLM style)
	const reply = opts.reply ?? "你好，这是 OpenAI 兼容 mock 的回复。";
	return listen(async (req, res, rec) => {
		const unauthorized = () => {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
		};
		if (key !== null && req.headers.authorization !== `Bearer ${key}`) return unauthorized();
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: (opts.models ?? ["mock-chat", "mock-vision", "text-embedding-mock"]).map((id) => ({ id, object: "model", created: 1_700_000_000, owned_by: "mock" })) }));
			return;
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const b = rec.body;
			const msgs: any[] = b.messages ?? [];
			const toolMsg = [...msgs].reverse().find((m) => m.role === "tool");
			const lastIsTool = msgs[msgs.length - 1]?.role === "tool";
			const user = lastUserText(msgs);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1_700_000_000, model: b.model };
			const wantsTool = !lastIsTool && /\[\[tool\]\]/.test(user) && Array.isArray(b.tools) && b.tools.length > 0;
			if (wantsTool) {
				const tool = b.tools.find((t: any) => t.function?.name === "ls") ?? b.tools[0];
				sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: tool.function.name, arguments: "" } }] }, finish_reason: null }] });
				sse(res, null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }] });
				sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
				sse(res, null, { ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 } });
			} else {
				const text = lastIsTool ? `工具已返回：${typeof toolMsg?.content === "string" ? toolMsg.content.slice(0, 40) : "ok"}` : reply;
				sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
				for (const part of text.match(/.{1,6}/gs) ?? []) sse(res, null, { ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
				sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
				sse(res, null, { ...base, choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } });
			}
			sse(res, null, "[DONE]");
			res.end();
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
	});
}

/** Anthropic Messages: base URL = `url` (no /v1). */
export function startAnthropicMock(opts: { key?: string; reply?: string; models?: { id: string; display_name: string }[] } = {}): Promise<MockServer> {
	const key = opts.key ?? ANTHROPIC_KEY;
	const reply = opts.reply ?? "你好，这是 Claude 兼容 mock 的回复。";
	return listen(async (req, res, rec) => {
		const bearer = req.headers.authorization === `Bearer ${key}`;
		if (req.headers["x-api-key"] !== key && !bearer) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
			return;
		}
		if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
			if (!req.headers["anthropic-version"]) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "anthropic-version header is required" } }));
				return;
			}
			const data = (opts.models ?? [{ id: "claude-mock-1", display_name: "Claude Mock 1" }, { id: "claude-mock-vision", display_name: "Claude Mock Vision" }]).map((m) => ({ type: "model", created_at: "2026-01-01T00:00:00Z", ...m }));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data, has_more: false, first_id: data[0]!.id, last_id: data.at(-1)!.id }));
			return;
		}
		if (req.method === "POST" && req.url?.split("?")[0] === "/v1/messages") {
			const b = rec.body;
			const msgs: any[] = b.messages ?? [];
			const last = msgs[msgs.length - 1];
			const lastIsToolResult = last?.role === "user" && Array.isArray(last.content) && last.content.some((c: any) => c.type === "tool_result");
			const user = lastUserText(msgs);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			sse(res, "message_start", { type: "message_start", message: { id: "msg_mock", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } });
			const wantsTool = !lastIsToolResult && /\[\[tool\]\]/.test(user) && Array.isArray(b.tools) && b.tools.length > 0;
			if (wantsTool) {
				const tool = b.tools.find((t: any) => t.name === "ls") ?? b.tools[0];
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mock_1", name: tool.name, input: {} } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
				sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 11 } });
			} else {
				const toolText = lastIsToolResult ? last.content.find((c: any) => c.type === "tool_result") : undefined;
				const text = lastIsToolResult ? `工具已返回：${JSON.stringify(toolText?.content ?? "").slice(0, 40)}` : reply;
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				for (const part of text.match(/.{1,6}/gs) ?? []) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
				sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 14 } });
			}
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route ${req.method} ${req.url}` } }));
	});
}
