// Round 14 (docs/r14-virtual-backend.md): the vertical chain through the REAL runtime and fixture model —
// upload → /uploads → copy_to_work → exec → present_file → library / card details; same-name re-delivery; uploads never become outputs.
process.env.WORKROOM_RT_RETRY_MAX ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startTestApp, type TestApp } from "./helpers/app.ts";
import { probeIsolation } from "../src/tools/sandbox.ts";

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
async function results(t: TestApp, c: Conv, name: string) {
	const h = await t.app.ctx.services.get("runtime").harness(c.spaceId, BACKGROUND_CONTEXT);
	const conv = (await h.conversation(c.conversationId as any, BACKGROUND_CONTEXT))!;
	const items = (await conv.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items as any[];
	return items.filter((e) => e.kind === "pi.tool-result" && e.model?.[0]?.toolName === name).map((e) => ({ text: e.model[0].content.map((x: any) => x.text ?? "").join(""), isError: !!e.model[0].isError, details: e.model[0].details }));
}
async function upload(t: TestApp, token: string, c: Conv, name: string, content: string) {
	const fd = new FormData();
	fd.set("file", new File([content], name, { type: "text/csv" }));
	fd.set("spaceId", c.spaceId);
	fd.set("conversationId", String(c.conversationId));
	const res = await t.req("POST", "/api/files", { token, body: fd });
	assert.equal(res.status, 200, await res.clone().text());
	const j = (await res.json()) as any;
	return { fileId: j.file.id, versionId: j.version.versionId, name };
}

test("V01/V08/V09/V10/V11/V12/V14/V22: new conversations get the unified tools; upload → copy_to_work → exec → present_file → library", { skip: probeIsolation().ok ? false : probeIsolation().detail, timeout: 180_000 }, async () => {
	const t = await startTestApp();
	try {
		const a = await t.user("vfs-chain@example.com");
		const c: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "咖啡店销售分析" } })).conversation;
		const offered: string[] = (await t.json("GET", base(c), { token: a.token })).agent.tools;
		for (const n of ["ls", "read", "write", "edit", "search", "remove", "exec", "present_file", "copy_to_work"]) assert.ok(offered.includes(n), `${n} offered: ${offered.join(",")}`);
		for (const n of ["sandbox_exec", "sandbox_publish", "file_create", "file_read", "code_run", "memory_save", "skill"]) assert.ok(!offered.includes(n), `legacy ${n} must not be offered to a new conversation`);

		// V01: ls / lists only virtual roots, no host paths
		await say(t, a.token, c, call("ls", { path: "/" }));
		const root = (await results(t, c, "ls"))[0]!;
		assert.ok(!root.isError, root.text);
		for (const r of ["work", "uploads", "library"]) assert.match(root.text, new RegExp(`\\[目录\\] ${r}/`));
		assert.doesNotMatch(root.text, /\/home\/|\/tmp\/|orgs\/|spaces\//, "no host path leaks");
		await say(t, a.token, c, call("ls", { path: "/etc" }));
		assert.match((await results(t, c, "ls"))[1]!.text, /unknown_root/);

		// V08: an upload is readable under /uploads and never becomes an output
		const up = await upload(t, a.token, c, "销售.csv", "品类,金额\n拿铁,30\n美式,20\n");
		await say(t, a.token, c, `看看附件 ${call("ls", { path: "/uploads" })}`, { attachments: [up] });
		const upLs = (await results(t, c, "ls"))[2]!;
		const msgDir = /\[目录\] (m\d+)\//.exec(upLs.text)?.[1];
		assert.ok(msgDir, upLs.text);
		await say(t, a.token, c, call("read", { path: `/uploads/${msgDir}/销售.csv` }));
		assert.match((await results(t, c, "read"))[0]!.text, /拿铁,30/);
		assert.equal((await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items.length, 0, "the upload is not in the library");
		await say(t, a.token, c, call("write", { path: `/uploads/${msgDir}/销售.csv`, content: "x" }));
		assert.match((await results(t, c, "write"))[0]!.text, /read_only|只读/);

		// V09 + V10: copy into /work (original kept), exec reads it and writes a new file, read sees the exec output
		await say(t, a.token, c, call("copy_to_work", { source: `/uploads/${msgDir}/销售.csv`, destination: "/work/inputs/销售.csv" }));
		assert.match((await results(t, c, "copy_to_work"))[0]!.text, /\/work\/inputs\/销售\.csv/);
		await say(t, a.token, c, call("exec", { command: "python3 -c \"import csv;rows=list(csv.reader(open('inputs/销售.csv')))[1:];open('out/total.txt','w').write(str(sum(int(r[1]) for r in rows)))\" 2>&1 || (mkdir -p out && python3 -c \"import csv;rows=list(csv.reader(open('inputs/销售.csv')))[1:];open('out/total.txt','w').write(str(sum(int(r[1]) for r in rows)))\")" }));
		const ex = (await results(t, c, "exec"))[0]!;
		assert.ok(!ex.isError, ex.text);
		await say(t, a.token, c, call("read", { path: "/work/out/total.txt" }));
		assert.match((await results(t, c, "read"))[1]!.text, /\n50$/);
		await say(t, a.token, c, call("write", { path: "/work/report.md", content: "# 报告\n合计 50\n" }));
		await say(t, a.token, c, call("exec", { command: "cat report.md && test -f /work/report.md && echo via-abs" }));
		assert.match((await results(t, c, "exec"))[1]!.text, /合计 50[\s\S]*via-abs/);

		// V11: intermediate files do not become outputs
		assert.equal((await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items.length, 0);

		// V12: present_file → library item, card details, current-file download
		await say(t, a.token, c, call("present_file", { source: "/work/report.md", name: "销售报告.md" }));
		const p1 = (await results(t, c, "present_file"))[0]!;
		assert.ok(!p1.isError, p1.text);
		assert.equal(p1.details.kind, "wr.presented");
		assert.equal(p1.details.status, "created");
		const item = p1.details.item;
		assert.match(item.path, /^\/library\/咖啡店销售分析--c\d+\/销售报告\.md$/);
		const lib = (await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items;
		assert.equal(lib.length, 1);
		assert.equal(lib[0].fileId, item.fileId);
		const dl = await t.req("GET", item.downloadUrl, { token: a.token });
		assert.equal(await dl.text(), "# 报告\n合计 50\n");
		await say(t, a.token, c, call("ls", { path: "/library" }));
		assert.match((await results(t, c, "ls")).at(-1)!.text, /咖啡店销售分析--c\d+\//);

		// V14: same name again → same fileId, updated content, no second row
		await say(t, a.token, c, call("write", { path: "/work/report.md", content: "# 报告\n合计 51\n" }));
		await say(t, a.token, c, call("present_file", { source: "/work/report.md", name: "销售报告.md" }));
		const p2 = (await results(t, c, "present_file"))[1]!;
		assert.equal(p2.details.status, "updated");
		assert.equal(p2.details.item.fileId, item.fileId);
		assert.notEqual(p2.details.item.etag, item.etag);
		const lib2 = (await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items;
		assert.equal(lib2.length, 1, "no second row for the same name");
		assert.equal(await (await t.req("GET", item.downloadUrl, { token: a.token })).text(), "# 报告\n合计 51\n", "the download link serves the current content");
		// another conversation's same name is independent
		const c2: Conv = (await t.json("POST", "/api/conversations", { token: a.token, json: { title: "另一个" } })).conversation;
		await say(t, a.token, c2, `${call("write", { path: "/work/report.md", content: "别的" })} ${call("present_file", { source: "/work/report.md", name: "销售报告.md" })}`);
		const other = (await results(t, c2, "present_file"))[0]!;
		assert.notEqual(other.details.item.fileId, item.fileId);
		assert.equal(await (await t.req("GET", item.downloadUrl, { token: a.token })).text(), "# 报告\n合计 51\n");

		// V22: the agent withdraws the delivery with remove on its /library path → gone from the library and /library, download refused;
		// the working copy in /work is untouched; the other conversation's same-name output is unaffected
		await say(t, a.token, c, call("remove", { path: item.path }));
		const rm = (await results(t, c, "remove")).at(-1)!;
		assert.ok(!rm.isError, rm.text);
		const lib3 = (await t.json("GET", `/api/library?spaceId=${c.spaceId}&conversationId=${c.conversationId}`, { token: a.token })).items;
		assert.equal(lib3.filter((x: any) => x.status !== "removed").length, 0, JSON.stringify(lib3));
		assert.equal((await t.req("GET", item.downloadUrl, { token: a.token })).status, 404, "a withdrawn output is no longer downloadable");
		await say(t, a.token, c, `${call("ls", { path: item.path.slice(0, item.path.lastIndexOf("/")) })} ${call("read", { path: "/work/report.md" })}`);
		assert.doesNotMatch((await results(t, c, "ls")).at(-1)!.text, /销售报告\.md/);
		assert.match((await results(t, c, "read")).at(-1)!.text, /合计 51/);
		assert.equal((await t.req("GET", other.details.item.downloadUrl, { token: a.token })).status, 200);
	} finally {
		await t.dispose();
	}
});
