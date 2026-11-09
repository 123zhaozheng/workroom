// Local fixture MCP server (stdio, or streamable HTTP via startHttpFixture) used to verify the connector contract.
// Not a real third-party integration: it only echoes, reports its injected token, and appends notes to a local file.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
	{ name: "echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
	{ name: "whoami", description: "Report which API token the server was configured with.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	{ name: "add_note", description: "Append a note to the notebook (external write).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: false } },
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

export function fixtureServer(env: { token?: string; notes?: string }): Server {
	const server = new Server({ name: "workroom-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const args = (req.params.arguments ?? {}) as Record<string, string>;
		switch (req.params.name) {
			case "echo":
				return { content: [{ type: "text", text: `echo: ${args.text}` }] };
			case "whoami":
				return { content: [{ type: "text", text: `token=${env.token ?? "(none)"}` }] };
			case "add_note": {
				if (!env.notes) return { content: [{ type: "text", text: "no notebook configured" }], isError: true };
				appendFileSync(env.notes, `${args.text}\n`);
				const n = readFileSync(env.notes, "utf8").split("\n").filter(Boolean).length;
				return { content: [{ type: "text", text: `saved note #${n}` }] };
			}
			case "fail":
				return { content: [{ type: "text", text: "fixture failure" }], isError: true };
			default:
				return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
		}
	});
	return server;
}

/** Streamable HTTP fixture (stateless). Requests without `Authorization: Bearer <token>` get 401. */
export async function startHttpFixture(token: string, host = "127.0.0.1", port = 0): Promise<{ url: string; close: () => Promise<void>; server: HttpServer }> {
	const http = createServer(async (req, res) => {
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
		const server = fixtureServer({ token });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	});
	await new Promise<void>((r, j) => http.once("error", j).listen(port, host, () => r()));
	const bound = (http.address() as { port: number }).port;
	return { url: `http://${host}:${bound}/mcp`, server: http, close: () => new Promise((r) => http.close(() => r())) };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const server = fixtureServer({ token: process.env.FIXTURE_TOKEN, notes: process.env.FIXTURE_NOTES });
	await server.connect(new StdioServerTransport());
	void existsSync;
}
