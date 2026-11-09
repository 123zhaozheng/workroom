// Test support for knowledge tests (any group may import it). Real HTTP against the in-process app.
import type { TestApp } from "../../test/helpers/app.ts";
import type { KbDocDTO } from "../../../shared/knowledge.ts";
import { newId, nowIso } from "../core/http.ts";
import type { Knowledge } from "./module.ts";

export const MIME = {
	md: "text/markdown",
	txt: "text/plain",
	html: "text/html",
	csv: "text/csv",
	json: "application/json",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export interface Uploaded {
	fileId: string;
	versionId: string;
	versionNo: number;
}

/** Upload through the files module (POST /api/files multipart). */
export async function uploadFile(t: TestApp, token: string, f: { name: string; mime: string; bytes: Uint8Array | string; spaceId?: string; projectId?: string }): Promise<Uploaded> {
	const fd = new FormData();
	const bytes = typeof f.bytes === "string" ? new TextEncoder().encode(f.bytes) : f.bytes;
	fd.set("file", new File([bytes as Uint8Array<ArrayBuffer>], f.name, { type: f.mime }));
	if (f.spaceId) fd.set("spaceId", f.spaceId);
	if (f.projectId) fd.set("projectId", f.projectId);
	const res = await t.req("POST", "/api/files", { token, body: fd });
	const text = await res.text();
	if (res.status !== 200) throw new Error(`upload ${f.name} → ${res.status}: ${text}`);
	const j = JSON.parse(text);
	return { fileId: j.file.id, versionId: j.version.versionId, versionNo: j.version.versionNo };
}

/** New version of an existing file (POST /api/files/:id/versions). */
export async function uploadVersion(t: TestApp, token: string, fileId: string, f: { name: string; mime: string; bytes: Uint8Array | string; changeNote?: string }): Promise<Uploaded> {
	const fd = new FormData();
	const bytes = typeof f.bytes === "string" ? new TextEncoder().encode(f.bytes) : f.bytes;
	fd.set("file", new File([bytes as Uint8Array<ArrayBuffer>], f.name, { type: f.mime }));
	if (f.changeNote) fd.set("changeNote", f.changeNote);
	const res = await t.req("POST", `/api/files/${fileId}/versions`, { token, body: fd });
	const text = await res.text();
	if (res.status !== 200) throw new Error(`upload version → ${res.status}: ${text}`);
	const j = JSON.parse(text);
	return { fileId: j.file.id, versionId: j.version.versionId, versionNo: j.version.versionNo };
}

export function knowledgeAdmin(t: TestApp): Knowledge {
	return t.app.ctx.services.get("knowledgeAdmin") as Knowledge;
}

/** Wait until the ingest queue is idle (no runnable job). */
export async function kbIdle(t: TestApp): Promise<void> {
	await knowledgeAdmin(t).pipeline.idle();
}

/** Poll a KB doc until `pred` holds (default: ready or failed for the latest version). */
export async function waitDoc(t: TestApp, token: string, kbId: string, docId: string, pred: (d: KbDocDTO) => boolean = (d) => ["ready", "failed"].includes(d.latest.status), timeoutMs = 15_000): Promise<KbDocDTO> {
	const deadline = Date.now() + timeoutMs;
	let last: KbDocDTO | undefined;
	while (Date.now() < deadline) {
		last = (await t.json("GET", `/api/kb/${kbId}/docs/${docId}`, { token })).doc as KbDocDTO;
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`doc ${docId} did not reach expected state; last=${JSON.stringify(last)}`);
}

/** Add a user to an existing org (invite row inserted directly, then the public register route). */
export async function joinOrg(t: TestApp, orgId: string, email: string, role: "member" | "admin" = "member"): Promise<{ token: string; me: any }> {
	const code = newId("inv");
	t.app.ctx.db.run("INSERT INTO id_invites (code, org_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, 'test', ?, ?)", code, orgId, role, nowIso(), new Date(Date.now() + 86400_000).toISOString());
	const u = await t.user(email, { inviteCode: code });
	if (role !== "member") t.app.ctx.db.run("UPDATE id_org_members SET role = ? WHERE org_id = ? AND user_id = ?", role, orgId, u.me.userId);
	return u;
}

/** Create a department with members (identity tables; no public route needed). */
export function addDepartment(t: TestApp, orgId: string, name: string, userIds: string[]): string {
	const id = newId("dep");
	t.app.ctx.db.run("INSERT INTO id_departments (id, org_id, name, created_at) VALUES (?, ?, ?, ?)", id, orgId, name, nowIso());
	for (const u of userIds) t.app.ctx.db.run("INSERT INTO id_department_members (department_id, user_id, created_at) VALUES (?, ?, ?)", id, u, nowIso());
	return id;
}

export function removeFromDepartment(t: TestApp, departmentId: string, userId: string): void {
	t.app.ctx.db.run("UPDATE id_department_members SET removed_at = ? WHERE department_id = ? AND user_id = ?", nowIso(), departmentId, userId);
}

/** Create KB + add one file + wait until ready. */
export async function kbWithDoc(t: TestApp, token: string, kb: { name: string; scope: string; projectId?: string; departmentId?: string }, file: { name: string; mime: string; bytes: Uint8Array | string; spaceId?: string; projectId?: string }) {
	const { kb: created } = await t.json("POST", "/api/kb", { token, json: kb });
	const up = await uploadFile(t, token, { ...file, projectId: file.projectId ?? kb.projectId });
	const { doc } = await t.json("POST", `/api/kb/${created.id}/docs`, { token, json: { fileId: up.fileId, versionId: up.versionId } });
	const ready = await waitDoc(t, token, created.id, doc.id);
	return { kb: created, file: up, doc: ready };
}
