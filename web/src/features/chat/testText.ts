// Test-model directives ([[call …]], [[slow …]], [[fail]], [[reply …]]) are simulation commands, not what a person wrote.
// The server sends `displayText` for user entries (server/src/runtime/dto.ts); this client-side twin covers text the
// server does not clean (steer chips, queued input, handoff progress, error strings) and older servers.
import type { UserEntryDTO } from "@shared/chat";

const DIRECTIVE = /^(call|slow|fail|reply|think)\b\s*/;

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

/** Remove every test directive (JSON-aware) and tidy the gaps. Plain text is returned unchanged. */
export function cleanTestText(text: string | undefined): string {
	if (!text) return "";
	let out = "";
	let i = 0;
	let found = false;
	for (;;) {
		const j = text.indexOf("[[", i);
		if (j === -1) {
			out += text.slice(i);
			break;
		}
		const m = DIRECTIVE.exec(text.slice(j + 2));
		if (!m) {
			out += text.slice(i, j + 2);
			i = j + 2;
			continue;
		}
		out += text.slice(i, j);
		let p = j + 2 + m[0].length;
		if (m[1] === "call") {
			const nm = /^[A-Za-z0-9_.:-]+\s*/.exec(text.slice(p));
			if (nm) p += nm[0].length;
			if (text[p] === "{") {
				const end = scanJsonObject(text, p);
				if (end > 0) p = end;
			}
		}
		const close = text.indexOf("]]", p);
		found = true;
		if (close === -1) break;
		i = close + 2;
	}
	return found ? out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim() : text;
}

export const hasTestDirectives = (text: string | undefined): boolean => !!text && cleanTestText(text) !== text;

/** What to show for a user message: the server's `displayText`, else the same cleaning done here. */
export function userTextOf(e: Pick<UserEntryDTO, "text" | "displayText" | "hasTestDirectives">): { text: string; test: boolean } {
	if (e.displayText !== undefined) return { text: e.displayText, test: !!e.hasTestDirectives };
	const text = cleanTestText(e.text);
	return { text, test: text !== e.text };
}

/** Error strings from the fixture carry the directive that caused them ("… ([[fail]])"); show them without it. */
export const cleanErrorText = (s: string | undefined): string => (s ?? "").replace(/\s*\(\[\[[^\]]*\]\][^)]*\)/g, "").replace(/\[\[[^\]]*\]\]/g, "").trim();
