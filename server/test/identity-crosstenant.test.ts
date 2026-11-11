// M16-B: cross-tenant sweep over EVERY mounted /api route. Org A creates one resource of each kind (project,
// conversation, file, KB, memory, skill, automation + run, share, budget, department, model, channel, route, notify
// channel, invite, assistant). Org B's owner then calls every route with A's ids substituted into the path params.
// Writes must be refused (non-2xx); reads must be refused or must not leak any A data. A's resources must be intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { startTestApp } from "./helpers/app.ts";
import { fauxModel } from "../src/ops/testing.ts";
import type { AutomationService } from "../src/ops/automation.ts";
import { waitFor } from "../src/runtime/testing.ts";

process.env.WORKROOM_AUTOMATION_TICK_MS = "0";

test("cross-tenant sweep: org B cannot read or change org A's resources through any /api route", async (tt) => {
	const t = await startTestApp({ config: { secretKey: "test-secret-key-for-crosstenant-0123456789" } });
	try {
		if (!t.app.ctx.services.has("runtime")) return tt.skip("runtime module not loaded");
		const MARK = `ASECRET${Math.random().toString(36).slice(2, 8)}`;
		const A = await t.user("a@a.example", { name: `${MARK}-owner` });
		const B = await t.user("b@b.example");
		const ids: Record<string, string> = {};
		const tryJson = async (method: string, path: string, json?: unknown) => {
			const r = await t.req(method, path, { token: A.token, json });
			return r.ok ? r.json() : null;
		};
		const { project } = await t.json("POST", "/api/projects", { token: A.token, json: { kind: "space", name: `${MARK} project`, description: `${MARK} desc` } });
		ids.projectId = project.id;
		ids.spaceId = project.spaceId;
		const { conversation } = await t.json("POST", "/api/conversations", { token: A.token, json: { projectId: project.id, title: `${MARK} conv` } });
		ids.convId = String(conversation.conversationId);
		const sent = await t.json("POST", `/api/conversations/${project.spaceId}/${conversation.conversationId}/messages`, { token: A.token, json: { text: `[[reply ${MARK} answer]]`, requestId: "x1" } });
		ids.subId = String(sent.submissionId);
		await waitFor(async () => (await t.json("GET", `/api/conversations/${project.spaceId}/${conversation.conversationId}/submissions/${sent.submissionId}`, { token: A.token })).status === "done");
		const fd = new FormData();
		fd.set("file", new File([`${MARK} file body`], `${MARK}.txt`, { type: "text/plain" }));
		fd.set("projectId", project.id);
		const up = await (await t.req("POST", "/api/files", { token: A.token, body: fd })).json();
		ids.fileId = up.file?.id ?? up.file?.fileId;
		ids.versionId = up.version?.versionId;
		const kb = await tryJson("POST", "/api/kb", { name: `${MARK} kb`, scope: "personal" });
		ids.kbId = kb?.kb?.id ?? "x";
		const doc = ids.kbId !== "x" ? await tryJson("POST", `/api/kb/${ids.kbId}/docs`, { fileId: ids.fileId, versionId: ids.versionId }) : null;
		ids.docId = doc?.doc?.id ?? doc?.doc?.docId ?? "x";
		const mem = await tryJson("POST", "/api/memory", { content: `${MARK} memory`, scope: "private" });
		ids.memId = mem?.memory?.id ?? "x";
		const sk = await tryJson("POST", "/api/skills", { name: `${MARK}-skill`, kind: "prompt", instructions: `${MARK} desc` });
		ids.skillId = sk?.skill?.id ?? "x";
		const ast = await tryJson("POST", "/api/assistants", { name: `${MARK} assistant`, description: `${MARK} desc` });
		ids.assistantId = ast?.assistant?.id ?? "x";
		const { automation } = await t.json("POST", "/api/automations", { token: A.token, json: { name: `${MARK} auto`, prompt: `[[reply ${MARK} answer]]`, trigger: { kind: "manual" }, timezone: "UTC", spaceId: project.spaceId } });
		ids.autoId = automation.id;
		ids.runId = (await t.json("POST", `/api/automations/${automation.id}/run`, { token: A.token })).runId;
		await (t.app.ctx.services.get("automation") as AutomationService).idle();
		ids.notifId = (await t.json("GET", "/api/notifications", { token: A.token })).notifications[0].id;
		ids.shareId = (await t.json("POST", "/api/shares", { token: A.token, json: { kind: "project", id: project.id } })).share.id;
		ids.deptId = (await t.json("POST", "/api/admin/departments", { token: A.token, json: { name: `${MARK} dept` } })).department.id;
		ids.budgetId = (await t.json("POST", "/api/admin/budgets", { token: A.token, json: { scope: { kind: "project", id: project.id }, period: "month", limitCost: 100 } })).budget.id;
		const fm = await fauxModel(t, A.token, [{ name: `${MARK}ch`, responses: [fauxAssistantMessage("x")] }], { label: `${MARK} model` });
		ids.pmId = fm.pm.id;
		ids.chId = fm.channels[0].id;
		ids.nchId = (await t.json("POST", "/api/notify-channels", { token: A.token, json: { kind: "email", name: `${MARK} mail`, target: "a@a.example" } })).channel.id;
		ids.code = (await t.json("POST", "/api/admin/invites", { token: A.token, json: {} })).invite.code;
		ids.sid = (await t.json("GET", "/api/me/sessions", { token: A.token })).sessions[0].id;
		ids.userId = A.me.userId;

		const byPrefix: [RegExp, string][] = [
			[/^\/api\/projects\//, ids.projectId],
			[/^\/api\/files\//, ids.fileId],
			[/^\/api\/kb\//, ids.kbId],
			[/^\/api\/memory\//, ids.memId],
			[/^\/api\/skills\/drafts\//, "x"],
			[/^\/api\/skills\//, ids.skillId],
			[/^\/api\/connectors\//, "x"],
			[/^\/api\/automations\//, ids.autoId],
			[/^\/api\/conversations\//, ids.convId],
			[/^\/api\/admin\/departments\//, ids.deptId],
			[/^\/api\/admin\/model-providers\//, ids.chId],
			[/^\/api\/me\/model-providers\//, ids.chId],
			[/^\/api\/admin\/budgets\//, ids.budgetId],
			[/^\/api\/shares\//, ids.shareId],
			[/^\/api\/notifications\/deliveries\//, "x"],
			[/^\/api\/notifications\//, ids.notifId],
			[/^\/api\/notify-channels\//, ids.nchId],
			[/^\/api\/assistants\//, ids.assistantId],
		];
		const param = (path: string, name: string): string => {
			switch (name) {
				case "spaceId":
					return ids.spaceId!;
				case "conversationId":
					return ids.convId!;
				case "submissionId":
					return ids.subId!;
				case "userId":
					return ids.userId!;
				case "sid":
					return ids.sid!;
				case "code":
					return ids.code!;
				case "runId":
					return path.startsWith("/api/sandbox") ? "x" : ids.runId!;
				case "vid":
					return ids.versionId!;
				case "docId":
					return ids.docId!;
				case "fileId":
					return ids.fileId!;
				case "id":
					return byPrefix.find(([re]) => re.test(path))?.[1] ?? "x";
				default:
					return "x";
			}
		};
		const PUBLIC = [/^\/api\/shared\//, /^\/api\/hooks\//, /^\/api\/auth\//, /^\/api\/health$/];
		const SELF_DESTRUCTIVE = [/^\/api\/me\/(sessions\/revoke-others|password|2fa)/, /^\/api\/auth\//];
		const aIds = Object.entries(ids).filter(([k, v]) => v && v !== "x" && !["subId", "convId", "code"].includes(k)).map(([, v]) => v);
		const CONTENT = ["project", "conv", "file body", "kb", "memory", "answer", "auto", "dept", "model", "mail", "desc", "assistant"].map((x) => `${MARK} ${x}`).concat([`${MARK}-owner`, `${MARK}-skill`, `${MARK}.txt`]);
		const violations: string[] = [];
		const routes = [...new Map(t.app.hono.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/")).map((r) => [`${r.method} ${r.path}`, r])).values()];
		let checked = 0;
		for (const r of routes) {
			if (PUBLIC.some((re) => re.test(r.path)) || SELF_DESTRUCTIVE.some((re) => re.test(r.path))) continue;
			const hasParams = r.path.includes(":");
			if (!hasParams && r.method !== "GET" && r.method !== "POST") continue;
			const path = r.path.replace(/:(\w+)/g, (_, n) => encodeURIComponent(param(r.path, n)));
			const q = r.method === "GET" && !hasParams ? `?spaceId=${ids.spaceId}&projectId=${ids.projectId}&q=${MARK}&query=${MARK}` : "";
			const res = await t.req(r.method, path + q, { token: B.token, json: r.method === "GET" ? undefined : { query: MARK, text: MARK, name: "pwned", title: "pwned", spaceId: ids.spaceId, projectId: ids.projectId, role: "owner", email: "b@b.example" } });
			checked++;
			const ctype = res.headers.get("content-type") ?? "";
			if (ctype.includes("event-stream")) {
				await res.body?.cancel();
				if (res.ok) violations.push(`${r.method} ${path} streamed to org B`);
				continue;
			}
			const body = await res.text();
			if (res.ok && hasParams && r.method !== "GET") violations.push(`${r.method} ${path} → ${res.status} (write on A's resource)`);
			// A's content strings (the bare MARK is only ever sent as a search term, so an echo of the query is not a leak).
			const leaked = CONTENT.filter((x) => body.includes(x));
			if (leaked.length) violations.push(`${r.method} ${path} → ${res.status} leaked A's content: ${leaked.join(", ")}`);
			const sentIds = aIds.filter((id) => (path + q).includes(id));
			const leakedIds = aIds.filter((id) => !sentIds.includes(id) && body.includes(id));
			if (res.ok && leakedIds.length) violations.push(`${r.method} ${path} → ${res.status} leaked A's ids ${leakedIds.join(",")}`);
		}
		assert.ok(checked > 100, `checked ${checked} routes`);
		// Positive control: the same detector sees A's content when A asks (so an empty violation list is meaningful).
		const own = await (await t.req("GET", `/api/conversations/${project.spaceId}/${conversation.conversationId}/entries`, { token: A.token })).text();
		assert.ok(CONTENT.some((x) => own.includes(x)));
		const ownFiles = await (await t.req("GET", `/api/files?projectId=${project.id}`, { token: A.token })).text();
		assert.ok(ownFiles.includes(`${MARK}.txt`));
		assert.deepEqual(violations, []);
		// A's resources are intact and A is still signed in.
		assert.equal((await t.json("GET", `/api/projects/${project.id}`, { token: A.token })).project.name, `${MARK} project`);
		assert.equal((await t.json("GET", "/api/admin/members", { token: A.token })).members.length, 1);
		assert.equal((await t.json("GET", `/api/automations/${automation.id}`, { token: A.token })).automation.enabled, true);
		assert.ok((await t.req("GET", `/api/files/${ids.fileId}`, { token: A.token })).ok);
		const conv = await t.json("GET", `/api/conversations/${project.spaceId}/${conversation.conversationId}`, { token: A.token });
		assert.equal(conv.conversation.title, `${MARK} conv`);
	} finally {
		await t.dispose();
	}
});
