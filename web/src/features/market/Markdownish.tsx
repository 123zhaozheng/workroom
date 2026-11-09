// Minimal, safe rendering of SKILL.md text: headings, lists, code fences and paragraphs as React nodes (no HTML injection).
import type { ReactNode } from "react";

export function Markdownish({ text }: { text: string }) {
	const out: ReactNode[] = [];
	const lines = text.replace(/\r/g, "").split("\n");
	let i = 0;
	let key = 0;
	while (i < lines.length) {
		const l = lines[i]!;
		if (l.startsWith("```")) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
			i++;
			out.push(
				<pre key={key++} className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12.5px]">
					{code.join("\n")}
				</pre>,
			);
		} else if (/^#{1,6}\s/.test(l)) {
			const level = l.match(/^#+/)![0].length;
			out.push(
				<div key={key++} className={level <= 1 ? "mt-1 text-base font-semibold" : "mt-3 text-[14px] font-semibold"}>
					{l.replace(/^#+\s*/, "")}
				</div>,
			);
			i++;
		} else if (/^\s*[-*]\s/.test(l)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*]\s/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s/, ""));
			out.push(
				<ul key={key++} className="list-disc space-y-0.5 pl-5">
					{items.map((x, j) => (
						<li key={j}>{x}</li>
					))}
				</ul>,
			);
		} else if (!l.trim()) i++;
		else {
			const para: string[] = [];
			while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*[-*]\s)/.test(lines[i]!)) para.push(lines[i++]!);
			out.push(<p key={key++}>{para.join(" ")}</p>);
		}
	}
	return (
		<div className="space-y-2 text-[13.5px] leading-relaxed" data-testid="readme">
			{out}
		</div>
	);
}
