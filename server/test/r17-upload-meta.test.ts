// Round 17: what the model is told about an attachment (docs/r17-upload-metadata.md).
// Real runtime + fixture model. Field report: the agent guessed /uploads/<name>, got not_found, then had to ls its way to /uploads/m<id>/<name>.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { sheetNames, humanSize } from "../src/runtime/attachment-meta.ts";
import { uploadAliasPath } from "../src/vfs/backends/uploads.ts";

type Conv = { spaceId: string; conversationId: number };
const base = (c: Conv) => `/api/conversations/${c.spaceId}/${c.conversationId}`;
const call = (tool: string, args: unknown) => `[[call ${tool} ${JSON.stringify(args)}]]`;

async function say(t: TestApp, token: string, c: Conv, text: string, extra: object = {}) {
	const r = await t.json("POST", `${base(c)}/messages`, { token, json: { text, requestId: randomUUID(), ...extra } });
	const deadline = Date.now() + 60_000;
	for (;;) {
		const s = await t.json("GET", `${base(c)}/submissions/${r.submissionId}`, { token });
		if (["done", "unanswered", "withdrawn"].includes(s.status)) return s;
		if (Date.now() > deadline) throw new Error("submission did not settle");
		await new Promise((x) => setTimeout(x, 50));
	}
}
async function entries(t: TestApp, c: Conv) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	return (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
}
async function results(t: TestApp, c: Conv, name: string) {
	return (await entries(t, c)).filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError }));
}
/** The text of the input as the model received it (the fixture model echoes it; the stored model message is the ground truth). */
async function modelInputs(t: TestApp, c: Conv): Promise<string[]> {
	return (await entries(t, c)).filter((e) => e.kind === "wr.input").map((e) => JSON.stringify(e.model ?? ""));
}
async function upload(t: TestApp, token: string, c: Conv, name: string, content: BodyInit | Uint8Array, type = "text/csv") {
	const fd = new FormData();
	fd.set("file", new File([content as BlobPart], name, { type }));
	fd.set("spaceId", c.spaceId);
	fd.set("conversationId", String(c.conversationId));
	const res = await t.req("POST", "/api/files", { token, body: fd });
	assert.equal(res.status, 200, await res.clone().text());
	const j = (await res.json()) as any;
	return { fileId: j.file.id as string, versionId: j.version.versionId as string, name };
}
const newConv = async (t: TestApp, token: string, title = "上传测试"): Promise<Conv> => (await t.json("POST", "/api/conversations", { token, json: { title } })).conversation;

test("composeContent tells the model each attachment's readable path, size (human + bytes) and type; xlsx also lists its sheets", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("meta-a@example.com");
		const c = await newConv(t, a.token);
		const wb = new ExcelJS.Workbook();
		wb.addWorksheet("贷款明细").addRow(["客户", "余额"]);
		wb.addWorksheet("征信 & 风险").addRow(["x"]);
		const xbytes = new Uint8Array(await wb.xlsx.writeBuffer());
		const xlsx = await upload(t, a.token, c, "对公客户贷款及征信信息表.xlsx", xbytes, "application/octet-stream");
		const csv = await upload(t, a.token, c, "销售.csv", "品类,金额\n拿铁,30\n");
		const rt = t.app.ctx.services.get("runtime") as unknown as { composeContent(i: object, p: unknown): Promise<string> };
		const principal = (await t.app.ctx.services.get("identity").principalFor(a.me.userId ?? a.me.user?.id ?? a.me.id, a.me.orgId ?? a.me.org?.id ?? a.me.user?.orgId))!;
		assert.ok(principal, "principal resolved");
		const text = await rt.composeContent({ text: "分析一下", attachments: [xlsx, csv] }, principal);
		assert.match(text, /^分析一下\n\n\[附件\] 2 个/);
		assert.ok(text.includes(uploadAliasPath(xlsx.versionId, xlsx.name)), text);
		assert.ok(text.includes(`${uploadAliasPath(xlsx.versionId, xlsx.name)} · `), "path, then size");
		assert.ok(text.includes(`${humanSize(xbytes.length)}（${xbytes.length} 字节）`), text);
		assert.match(text, /spreadsheetml\.sheet/, "mime guessed from the extension for an octet-stream upload");
		assert.match(text, /工作表：贷款明细、征信 & 风险/);
		assert.match(text, /8 B（\d+ 字节）|\d+ B（\d+ 字节）/);
		assert.ok(text.includes(uploadAliasPath(csv.versionId, csv.name)) && text.includes("text/csv"), text);
		assert.ok(text.includes(`fileId=${csv.fileId}, versionId=${csv.versionId}`), "ids stay for tools that take them");

		// a file the sender cannot read gets no metadata (and no sheet names) — only what the client already sent
		const b = await t.user("meta-b@example.com");
		const pb = (await t.app.ctx.services.get("identity").principalFor(b.me.userId ?? b.me.user?.id ?? b.me.id, b.me.orgId ?? b.me.org?.id ?? b.me.user?.orgId))!;
		const denied = await rt.composeContent({ text: "x", attachments: [xlsx] }, pb);
		assert.ok(!denied.includes("/uploads/") && !denied.includes("工作表") && denied.includes(`versionId=${xlsx.versionId}`), denied);
		// a forged name/fileId pair is not described either
		const forged = await rt.composeContent({ text: "x", attachments: [{ ...csv, fileId: xlsx.fileId }] }, principal);
		assert.ok(!forged.includes("/uploads/"), forged);
	} finally {
		await t.dispose();
	}
});

test("the path given to the model works: read / ls / copy source resolve it, per-message paths and same-name attachments stay consistent", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("meta-path@example.com");
		const c = await newConv(t, a.token);
		const up = await upload(t, a.token, c, "销售.csv", "品类,金额\n拿铁,30\n美式,20\n");
		const dup = await upload(t, a.token, c, "销售.csv", "品类,金额\n茶,5\n"); // same name, other version, same message
		await say(t, a.token, c, "看附件", { attachments: [up, dup] });
		const model = (await modelInputs(t, c)).join("\n");
		assert.ok(model.includes(uploadAliasPath(up.versionId, "销售.csv")) && model.includes(uploadAliasPath(dup.versionId, "销售.csv")), "both attachments listed with distinct paths");

		// the injected paths, exactly as written in the message
		await say(t, a.token, c, call("read", { path: uploadAliasPath(up.versionId, "销售.csv") }));
		await say(t, a.token, c, call("read", { path: uploadAliasPath(dup.versionId, "销售.csv") }));
		const reads = await results(t, c, "read");
		assert.ok(!reads[0]!.isError && /拿铁,30/.test(reads[0]!.text), reads[0]!.text);
		assert.ok(!reads[1]!.isError && /茶,5/.test(reads[1]!.text) && !/拿铁/.test(reads[1]!.text), "the second same-name file is its own version");
		assert.match(reads[0]!.text, new RegExp(`^/uploads/${up.versionId}/销售\\.csv · `), "node path echoes the alias that was asked for");

		// the legacy per-message layout is unchanged (old conversations / the names ls prints)
		await say(t, a.token, c, call("ls", { path: "/uploads" }));
		const ls = (await results(t, c, "ls")).at(-1)!.text;
		const msgDir = /\[目录\] (m\d+)\/.*销售\.csv/.exec(ls)?.[1];
		assert.ok(msgDir, `ls lists the attachment names in the message directory: ${ls}`);
		await say(t, a.token, c, call("ls", { path: `/uploads/${msgDir}` }));
		assert.match((await results(t, c, "ls")).at(-1)!.text, /销售\.csv[\s\S]*销售\.csv/);
		await say(t, a.token, c, call("read", { path: `/uploads/${msgDir}/${up.fileId}-销售.csv` }));
		await say(t, a.token, c, call("read", { path: `/uploads/${msgDir}/销售.csv` }));
		const r2 = await results(t, c, "read");
		assert.ok(/茶,5|拿铁,30/.test(r2[3]!.text), r2[3]!.text);
		await say(t, a.token, c, call("copy_to_work", { source: uploadAliasPath(up.versionId, "销售.csv"), destination: "/work/in/销售.csv" }));
		const cp = (await results(t, c, "copy_to_work"))[0]!;
		assert.ok(!cp.isError, cp.text);

		// still read-only
		await say(t, a.token, c, call("write", { path: uploadAliasPath(up.versionId, "销售.csv"), content: "x" }));
		assert.match((await results(t, c, "write"))[0]!.text, /read_only|只读/);

		// the failure from the field report: a guessed path now says where the file really is
		await say(t, a.token, c, call("read", { path: "/uploads/销售.csv" }));
		const nf = (await results(t, c, "read")).at(-1)!;
		assert.ok(nf.isError && /not_found/.test(nf.text), nf.text);
		assert.ok(nf.text.includes("可能的正确路径") && nf.text.includes(`/uploads/${msgDir}/销售.csv`), nf.text);
		await say(t, a.token, c, call("copy_to_work", { source: "/uploads/销售.csv" }));
		const nf2 = (await results(t, c, "copy_to_work")).at(-1)!;
		assert.ok(nf2.isError && nf2.text.includes(`/uploads/${msgDir}/销售.csv`), nf2.text);
		// a name that was never attached lists what is attached
		await say(t, a.token, c, call("read", { path: "/uploads/不存在.xlsx" }));
		assert.match((await results(t, c, "read")).at(-1)!.text, /本会话的附件：销售\.csv/);
		// the hint is limited to /uploads
		await say(t, a.token, c, call("read", { path: "/work/销售.csv" }));
		assert.doesNotMatch((await results(t, c, "read")).at(-1)!.text, /可能的正确路径/);
	} finally {
		await t.dispose();
	}
});

test("a follow-up sent while the run is busy (steer path) is described the same way", async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("meta-steer@example.com");
		const c = await newConv(t, a.token);
		const up = await upload(t, a.token, c, "notes.md", "# 要点\n", "text/markdown");
		await say(t, a.token, c, "先聊聊");
		await t.json("POST", `${base(c)}/messages`, { token: a.token, json: { text: "再看这个附件", requestId: randomUUID(), attachments: [up] } });
		await new Promise((x) => setTimeout(x, 800));
		assert.ok((await modelInputs(t, c)).join("\n").includes(uploadAliasPath(up.versionId, "notes.md")));
	} finally {
		await t.dispose();
	}
});

test("sheetNames reads only workbook.xml and never throws on garbage", async () => {
	const wb = new ExcelJS.Workbook();
	wb.addWorksheet("A&B");
	wb.addWorksheet("第二页");
	assert.deepEqual(await sheetNames(new Uint8Array(await wb.xlsx.writeBuffer())), ["A&B", "第二页"]);
	assert.deepEqual(await sheetNames(new Uint8Array([1, 2, 3])), []);
	assert.deepEqual(await sheetNames(null), []);
	assert.equal(humanSize(512), "512 B");
	assert.equal(humanSize(2048), "2.0 KB");
	assert.equal(humanSize(3 * 1048576), "3.0 MB");
});
