// One renderer for streaming AND history (M01-C: identical output). Streamdown core is light;
// syntax highlighting (shiki) and math (katex) are separate chunks loaded only when the text needs them.
import { memo, useEffect, useState } from "react";
import { Streamdown, type PluginConfig, type StreamdownTranslations } from "streamdown";
import { cn } from "@/lib/utils";

const ZH: Partial<StreamdownTranslations> = {
	copyCode: "复制代码",
	copied: "已复制",
	downloadFile: "下载",
	copyTable: "复制表格",
	copyTableAsCsv: "复制为 CSV",
	copyTableAsMarkdown: "复制为 Markdown",
	copyTableAsTsv: "复制为 TSV",
	downloadTable: "下载表格",
	downloadTableAsCsv: "下载 CSV",
	downloadTableAsMarkdown: "下载 Markdown",
	viewFullscreen: "全屏查看",
	exitFullscreen: "退出全屏",
	close: "关闭",
};

const needsCode = (t: string) => t.includes("```");
const needsMath = (t: string) => /\$\$|\\\(|\\\[|\$[^\s$][^$\n]*\$/.test(t);

let codeP: Promise<PluginConfig["code"]> | null = null;
let mathP: Promise<PluginConfig["math"]> | null = null;
const loadCode = () => (codeP ??= import("@streamdown/code").then((m) => m.createCodePlugin({ themes: ["github-light", "github-dark"] })));
const loadMath = () =>
	(mathP ??= Promise.all([import("@streamdown/math"), import("katex/dist/katex.min.css")]).then(([m]) => m.createMathPlugin({ singleDollarTextMath: true })));

function usePlugins(text: string): PluginConfig | undefined {
	const wantCode = needsCode(text);
	const wantMath = needsMath(text);
	const [plugins, setPlugins] = useState<PluginConfig>();
	useEffect(() => {
		let alive = true;
		if (!wantCode && !wantMath) return;
		Promise.all([wantCode ? loadCode() : undefined, wantMath ? loadMath() : undefined]).then(([code, math]) => {
			if (alive) setPlugins({ ...(code ? { code } : {}), ...(math ? { math } : {}) });
		});
		return () => {
			alive = false;
		};
	}, [wantCode, wantMath]);
	return plugins;
}

export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
	const plugins = usePlugins(text);
	return (
		<Streamdown
			className={cn("wr-prose", className)}
			mode={streaming ? "streaming" : "static"}
			isAnimating={!!streaming}
			plugins={plugins}
			controls={{ code: true, table: true }}
			linkSafety={{ enabled: false }}
			lineNumbers={false}
			translations={ZH}
		>
			{text}
		</Streamdown>
	);
});
