// Round 11 (R2b): execution-intent scorer — behaviour of single features and the labelled data set (server/test/fixtures/sandbox-intent.json).
//   node --disable-warning=ExperimentalWarning --test server/test/sandbox-intent.test.ts
// The data set is author-labelled (zh + en, half of it "no sandbox needed"), NOT real traffic. "train" was used to set the weights, "heldout" was
// not; the floors below are deliberately below what was measured so a harmless tweak does not break the build, while a broken rule does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTACHMENT_DAMPING, DEFAULT_PREWARM_THRESHOLD, INTENT_BIAS, INTENT_FEATURES, scoreExecIntent, type IntentAttachment } from "../src/tools/sandbox/intent.ts";

interface Labelled {
	id: number;
	split: "train" | "heldout";
	needs: boolean;
	text: string;
	attachments?: IntentAttachment[];
	usedSandbox?: boolean;
}
const SET: Labelled[] = JSON.parse(readFileSync(new URL("./fixtures/sandbox-intent.json", import.meta.url), "utf8"));
const score = (r: Labelled) => scoreExecIntent({ text: r.text, attachments: r.attachments, usedSandbox: r.usedSandbox });

function metrics(rows: Labelled[], threshold: number) {
	let tp = 0, fp = 0, fn = 0, tn = 0;
	for (const r of rows) {
		const fire = score(r).p >= threshold;
		if (fire && r.needs) tp++;
		else if (fire) fp++;
		else if (r.needs) fn++;
		else tn++;
	}
	return { tp, fp, fn, tn, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) };
}

test("data set: at least 80 messages, half need a sandbox, zh and en, with a held-out part", () => {
	assert.ok(SET.length >= 80, `${SET.length} messages`);
	const pos = SET.filter((r) => r.needs).length;
	assert.equal(pos, SET.length - pos, "balanced");
	assert.ok(SET.filter((r) => /[一-鿿]/.test(r.text)).length >= 40, "enough Chinese");
	assert.ok(SET.filter((r) => !/[一-鿿]/.test(r.text)).length >= 30, "enough English");
	const held = SET.filter((r) => r.split === "heldout");
	assert.ok(held.length >= 40, "held-out part");
	assert.ok(held.some((r) => r.needs) && held.some((r) => !r.needs));
	assert.equal(new Set(SET.map((r) => r.text + JSON.stringify(r.attachments ?? []))).size, SET.length, "no duplicates");
});

test("scorer: p in (0,1), signals are known feature ids, deterministic, never throws on odd input", () => {
	const known = new Set(INTENT_FEATURES.map((f) => f.id));
	for (const r of SET) {
		const a = score(r);
		assert.ok(a.p > 0 && a.p < 1);
		for (const s of a.signals) assert.ok(known.has(s), s);
		assert.deepEqual(a, score(r));
	}
	for (const bad of [{ text: "" }, { text: undefined as any }, { text: "x", attachments: [null as any, { name: 3 as any }] }, { text: "x".repeat(200_000) }, undefined as any]) {
		const s = scoreExecIntent(bad);
		assert.ok(s.p >= 0 && s.p <= 1);
	}
	assert.ok(Math.abs(scoreExecIntent({ text: "" }).p - 1 / (1 + Math.exp(-INTENT_BIAS))) < 1e-9, "empty message = the intercept");
	assert.equal(DEFAULT_PREWARM_THRESHOLD, 0.3);
});

test("scorer: pure chat / writing / translation / explanation stays far below the default threshold", () => {
	for (const text of ["你好", "hello there", "帮我写一封请假邮件", "翻译成英文：今天天气很好", "Explain how photosynthesis works", "什么是区块链？", "recommend a good book about leadership"]) {
		const s = scoreExecIntent({ text });
		assert.ok(s.p < 0.3, `${text} → ${s.p.toFixed(2)} [${s.signals}]`);
	}
});

test("scorer: single strong signals fire at 0.3 in Chinese and English", () => {
	const fire = (text: string, o: Partial<Parameters<typeof scoreExecIntent>[0]> = {}) => {
		const s = scoreExecIntent({ text, ...o });
		assert.ok(s.p >= 0.3, `${text} → ${s.p.toFixed(2)} [${s.signals}]`);
		return s;
	};
	assert.ok(fire("请运行这个脚本并告诉我结果").signals.includes("run_code"));
	assert.ok(fire("run the script and show the output").signals.includes("run_code"));
	assert.ok(fire("```bash\nls -la\n```").signals.includes("fenced_code"));
	assert.ok(fire("$ pip install requests").signals.includes("shell_command"));
	assert.ok(fire("在沙箱里试一下").signals.includes("sandbox_word"));
	assert.ok(fire("画一个销量折线图", {}).signals.includes("chart"));
	assert.ok(fire("analyze this dataset and plot the trend").signals.includes("data_analysis"));
	assert.ok(fire("帮我把这些文件批量转成 pdf").signals.includes("file_task"));
	assert.ok(fire("npm run build 能不能通过").signals.includes("install_build_deploy"));
	assert.ok(fire("continue", { usedSandbox: true }).signals.includes("used_sandbox"), "a conversation that already ran code is a strong prior");
	// an assistant that lists sandbox tools is a weaker hint on its own, but tips a borderline message over the line
	const base = scoreExecIntent({ text: "整理一下这个", attachments: [{ name: "x.png" }] }).p;
	const hinted = scoreExecIntent({ text: "整理一下这个", attachments: [{ name: "x.png" }], assistantTools: ["file_create", "sandbox_exec"] });
	assert.ok(hinted.p > base && hinted.signals.includes("assistant_sandbox_tools"));
	assert.ok(scoreExecIntent({ text: "继续", assistantTools: ["file_create"] }).signals.length === 0);
});

test("scorer: attachments — data / archive / code files push up, documents and plain text do not, prose requests are damped", () => {
	const p = (text: string, ...names: string[]) => scoreExecIntent({ text, attachments: names.map((name) => ({ name })) }).p;
	assert.ok(p("看看这个", "a.csv") >= 0.3, "csv");
	assert.ok(p("看看这个", "b.xlsx") >= 0.3, "xlsx");
	assert.ok(p("看看这个", "c.zip") >= 0.3, "zip");
	assert.ok(p("look at this", "main.py") >= 0.3, "source file");
	assert.ok(p("look at this", "x.PARQUET") >= 0.3, "extension is case-insensitive");
	assert.ok(p("总结一下", "paper.pdf") < 0.3, "summarising a pdf is a file-tool job");
	assert.ok(p("润色一下", "weekly.docx") < 0.3);
	assert.ok(p("这是什么", "note.txt") < 0.3);
	// mime fallback when the extension says nothing
	assert.ok(scoreExecIntent({ text: "看看这个", attachments: [{ name: "export", mime: "text/csv" }] }).p >= 0.3);
	// damping: "summarise" with a data file is weaker than the same file alone, but still not zeroed
	const alone = p("看看这个", "a.csv");
	const damped = p("总结一下", "a.csv");
	assert.ok(damped < alone);
	assert.ok(ATTACHMENT_DAMPING > 0 && ATTACHMENT_DAMPING < 1);
});

test("scorer: explaining code is not running code; a keyword inside prose is weak", () => {
	assert.ok(scoreExecIntent({ text: "解释一下这段代码\n```python\nprint(1)\n```" }).p < 0.3);
	assert.ok(scoreExecIntent({ text: "What is a Docker container?" }).p < 0.3);
	assert.ok(scoreExecIntent({ text: "用 Excel 怎么做数据透视表？" }).p < 0.5, "how-to question about a tool");
});

test("scorer speed: well under 1 ms per message (long messages included)", () => {
	const long = `${"请帮我看看这个问题，".repeat(400)}\n\`\`\`python\n${"x = 1\n".repeat(200)}\`\`\``;
	const msgs = [...SET.map((r) => r.text), long];
	for (let i = 0; i < 50; i++) for (const t of msgs) scoreExecIntent({ text: t }); // warm up
	const t0 = process.hrtime.bigint();
	const rounds = 200;
	for (let i = 0; i < rounds; i++) for (const t of msgs) scoreExecIntent({ text: t });
	const per = Number(process.hrtime.bigint() - t0) / 1e6 / (rounds * msgs.length);
	assert.ok(per < 1, `${per.toFixed(4)} ms per message`);
	console.log(`# scoreExecIntent: ${per.toFixed(4)} ms per message`);
});

test("data set metrics at the default threshold 0.3 (floors) and a threshold sweep", () => {
	const train = SET.filter((r) => r.split === "train");
	const held = SET.filter((r) => r.split === "heldout");
	const lines: string[] = [];
	for (const [name, rows] of [["train", train], ["heldout", held], ["all", SET]] as const) {
		for (const th of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
			const m = metrics(rows, th);
			lines.push(`${name.padEnd(8)} th=${th.toFixed(1)}  precision=${m.precision.toFixed(2)} recall=${m.recall.toFixed(2)}  tp=${m.tp} fp=${m.fp} fn=${m.fn} tn=${m.tn}`);
		}
	}
	console.log(`# intent metrics\n${lines.map((l) => `# ${l}`).join("\n")}`);
	const t = metrics(train, 0.3);
	const h = metrics(held, 0.3);
	const a = metrics(SET, 0.3);
	assert.ok(t.precision >= 0.9 && t.recall >= 0.9, `train P=${t.precision.toFixed(2)} R=${t.recall.toFixed(2)}`);
	assert.ok(h.precision >= 0.85 && h.recall >= 0.7, `heldout P=${h.precision.toFixed(2)} R=${h.recall.toFixed(2)}`);
	assert.ok(a.precision >= 0.88 && a.recall >= 0.78, `all P=${a.precision.toFixed(2)} R=${a.recall.toFixed(2)}`);
	// the sweep behaves: raising the threshold never raises recall nor lowers precision-by-much on the whole set
	let prevRecall = 2;
	for (const th of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
		const m = metrics(SET, th);
		assert.ok(m.recall <= prevRecall + 1e-9, `recall monotone at ${th}`);
		prevRecall = m.recall;
	}
	assert.ok(metrics(SET, 0.1).recall > metrics(SET, 0.7).recall + 0.2, "the threshold really trades recall for precision");
});
