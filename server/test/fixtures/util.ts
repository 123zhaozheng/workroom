import type { TestApp } from "../helpers/app.ts";

export async function orgMember(t: TestApp, owner: { me: any }, email: string) {
	const code = `inv-${Math.random().toString(36).slice(2)}`;
	t.app.ctx.db.run("INSERT INTO id_invites (code, org_id, role, created_by, created_at, expires_at) VALUES (?, ?, 'member', ?, ?, ?)", code, owner.me.orgId, owner.me.userId, new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString());
	return t.user(email, { inviteCode: code });
}

export async function upload(t: TestApp, token: string, path: string, name: string, bytes: Uint8Array | string, fields: Record<string, string> = {}, type = "") {
	const fd = new FormData();
	fd.set("file", new File([bytes as string | Uint8Array<ArrayBuffer>], name, { type }));
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return t.req("POST", `/api${path}`, { token, body: fd });
}
