// Marks the query's words inside a text (case-insensitive). Plain text in, <mark> out — never HTML.
import { Fragment, useMemo } from "react";

export function queryTerms(q: string): string[] {
	return [...new Set(q.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length).slice(0, 8);
}

export function Highlight({ text, query, className }: { text: string; query: string; className?: string }) {
	const parts = useMemo(() => {
		const terms = queryTerms(query);
		if (!terms.length || !text) return [text];
		const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
		return text.split(re);
	}, [text, query]);
	const terms = useMemo(() => queryTerms(query).map((t) => t.toLowerCase()), [query]);
	return (
		<>
			{parts.map((p, i) =>
				i % 2 === 1 && terms.includes(p.toLowerCase()) ? (
					<mark key={i} className={className ?? "rounded-sm bg-warning-soft px-px text-fg underline decoration-warning decoration-2 underline-offset-2"}>
						{p}
					</mark>
				) : (
					<Fragment key={i}>{p}</Fragment>
				),
			)}
		</>
	);
}
