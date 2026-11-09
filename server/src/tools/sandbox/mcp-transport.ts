// MCP client transport over a sandboxed service's stdin/stdout (newline-delimited JSON-RPC, same framing as the SDK's stdio transport),
// so MCP stdio servers run inside the sandbox instead of on the host.
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { SandboxService } from "./services.ts";

export function serviceTransport(svc: SandboxService, opts: { keepAlive?: boolean } = {}): Transport {
	const buffer = new ReadBuffer();
	let started = false;
	const t: Transport = {
		async start() {
			if (started) throw new Error("transport already started");
			started = true;
			svc.stdout.on("data", (chunk: Buffer) => {
				buffer.append(chunk);
				for (;;) {
					let msg: JSONRPCMessage | null;
					try {
						msg = buffer.readMessage();
					} catch (e) {
						t.onerror?.(e as Error);
						return;
					}
					if (!msg) return;
					t.onmessage?.(msg);
				}
			});
			svc.stdout.on("error", (e) => t.onerror?.(e));
			void svc.exited.then(() => t.onclose?.());
		},
		send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
			return new Promise((resolve, reject) => {
				if (!svc.running) return reject(new Error("sandbox service is not running"));
				const ok = svc.stdin.write(serializeMessage(message), (err) => (err ? reject(err) : undefined));
				if (ok) resolve();
				else svc.stdin.once("drain", resolve);
			});
		},
		async close() {
			buffer.clear();
			if (!opts.keepAlive) await svc.stop();
		},
	};
	return t;
}
