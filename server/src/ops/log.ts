// Structured JSON logs with correlation ids + configurable redaction (M18-B).
// WORKROOM_REDACT = "standard" (default: secrets/tokens/keys masked) | "strict" (also emails, URLs' query strings,
// and free-text content fields dropped) | "off" (dev only).
// WORKROOM_LOG = "info" (default) | "debug" | "silent".

export type RedactMode = "off" | "standard" | "strict";

export function redactMode(): RedactMode {
	const v = process.env.WORKROOM_REDACT;
	return v === "off" || v === "strict" ? v : "standard";
}

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b(sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g, "$1-***"],
	[/\bsk-ant-[A-Za-z0-9_\-]{8,}/g, "sk-ant-***"],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{8,}/gi, "$1 ***"],
	[/\b(api[_-]?key|x-api-key|authorization|password|passwd|secret|token|access_token|refresh_token|client_secret)(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1$2***"],
	[/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, "<jwt>"],
	[/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "<aws-key>"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<github-token>"],
];
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const URL_QUERY = /(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g;

export function redactText(s: string, mode: RedactMode = redactMode()): string {
	if (mode === "off") return s;
	let out = s;
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	if (mode === "strict") out = out.replace(EMAIL, "<email>").replace(URL_QUERY, "$1?<redacted>");
	return out;
}

/** Fields whose values are user content; dropped entirely in strict mode, truncated otherwise. */
const CONTENT_KEYS = new Set(["prompt", "text", "content", "body", "message", "messages", "input", "output", "arguments"]);
const SECRET_KEYS = /^(api[_-]?key|apikey|password|secret|token|authorization|client_secret|key)$/i;

export function redactValue(v: unknown, mode: RedactMode = redactMode(), depth = 0): unknown {
	if (mode === "off") return v;
	if (typeof v === "string") return redactText(v.length > 2000 ? `${v.slice(0, 2000)}…` : v, mode);
	if (depth > 6 || v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, mode, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) {
		if (SECRET_KEYS.test(k)) out[k] = "***";
		else if (mode === "strict" && CONTENT_KEYS.has(k)) out[k] = typeof x === "string" ? `<${x.length} chars>` : "<redacted>";
		else out[k] = redactValue(x, mode, depth + 1);
	}
	return out;
}

export interface LogFields {
	requestId?: string;
	spaceId?: string;
	conversationId?: number;
	taskId?: number;
	routeAttemptId?: string;
	requestKey?: string;
	automationId?: string;
	runId?: string;
	notificationId?: string;
	[k: string]: unknown;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
const sink: { lines: string[] | null } = { lines: null };

/** Tests can capture log lines. */
export function captureLogs(on: boolean): string[] {
	sink.lines = on ? [] : null;
	return sink.lines ?? [];
}

export function logEvent(level: Level, event: string, fields: LogFields = {}): void {
	const cfg = process.env.WORKROOM_LOG ?? "info";
	const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(redactValue(fields) as object) });
	if (sink.lines) sink.lines.push(line);
	if (cfg === "silent" || (cfg !== "debug" && LEVELS[level] < LEVELS.info)) return;
	if (process.env.NODE_TEST_CONTEXT && level !== "error") return; // keep test output readable
	(level === "error" || level === "warn" ? console.error : console.log)(line);
}
