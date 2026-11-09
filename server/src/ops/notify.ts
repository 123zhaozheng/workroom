// Notifications (M12-C): in-app notifications carry a task link, status and deliverable refs. External channels:
// webhook (real HTTP POST, HMAC-signed, retried, every attempt recorded) and email (blocked: no SMTP credentials).
// Delivery failures are recorded in ops_notify_deliveries, separately from the task/run outcome.
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { AppContext, Principal } from "../core/contracts.ts";
import { HttpError, newId, nowIso } from "../core/http.ts";
import { SecretBox } from "../identity/secrets.ts";
import { logEvent, redactText } from "./log.ts";

export interface NotificationRef {
	kind: "conversation" | "file" | "run";
	id: string;
	label?: string;
	spaceId?: string;
}

function isPrivateHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h === "metadata.google.internal") return true;
	if (isIP(h) === 4) {
		const [a, b] = h.split(".").map(Number) as [number, number];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h === "::";
	return false;
}

export function validateWebhookUrl(url: string): void {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new HttpError(400, "invalid_url", "Webhook 地址无效");
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "invalid_url", "Webhook 仅支持 http(s)");
	if (isPrivateHost(u.hostname) && process.env.WORKROOM_WEBHOOK_ALLOW_PRIVATE !== "1") throw new HttpError(400, "private_address", "不允许向内网/本机地址发送 Webhook（可设置 WORKROOM_WEBHOOK_ALLOW_PRIVATE=1）");
}

export class NotifyService {
	readonly #ctx: AppContext;
	readonly secrets: SecretBox;
	/** Delay before attempt n (index 0 = first retry). Tests shorten it. */
	retryDelaysMs = [1000, 5000];
	timeoutMs = 10_000;
	readonly #pending = new Set<Promise<unknown>>();

	constructor(ctx: AppContext) {
		this.#ctx = ctx;
		this.secrets = new SecretBox(ctx.config.secretKey);
	}
	get db() {
		return this.#ctx.db;
	}

	/** Wait for in-flight deliveries (tests, shutdown). */
	async idle(): Promise<void> {
		while (this.#pending.size) await Promise.allSettled([...this.#pending]);
	}

	createInApp(input: { orgId: string; userId: string; kind: "automation_run" | "budget" | "system"; title: string; body: string; link?: string; status?: string; refs?: NotificationRef[]; runId?: string }): string {
		const id = newId("ntf");
		this.db.run("INSERT INTO ops_notifications (id, org_id, user_id, kind, title, body, link, status, refs, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, input.orgId, input.userId, input.kind, input.title, input.body, input.link ?? null, input.status ?? null, JSON.stringify(input.refs ?? []), input.runId ?? null, nowIso());
		return id;
	}

	channelStatus(ch: any): { status: "ready" | "blocked"; detail?: string } {
		if (ch.kind === "email") return process.env.WORKROOM_SMTP_URL ? { status: "blocked", detail: "SMTP 发送尚未实现（已配置 WORKROOM_SMTP_URL，但未接入发送器）" } : { status: "blocked", detail: "未配置 SMTP 凭据（WORKROOM_SMTP_URL）" };
		return { status: "ready" };
	}

	/** Fan out one notification to external channels. Returns delivery ids. Never throws for delivery errors. */
	deliver(notificationId: string, channelIds: readonly string[], payload: Record<string, unknown>, ownerOrgId: string, runId?: string): string[] {
		const ids: string[] = [];
		for (const chId of channelIds) {
			const ch = this.db.get<any>("SELECT * FROM ops_notify_channels WHERE id = ? AND org_id = ? AND deleted_at IS NULL", chId, ownerOrgId);
			const id = newId("dlv");
			ids.push(id);
			if (!ch || !ch.enabled) {
				this.db.run("INSERT INTO ops_notify_deliveries (id, notification_id, channel_id, run_id, org_id, status, attempt, error, created_at) VALUES (?, ?, ?, ?, ?, 'failed', 0, ?, ?)", id, notificationId, chId, runId ?? null, ownerOrgId, ch ? "channel disabled" : "channel not found", nowIso());
				continue;
			}
			const st = this.channelStatus(ch);
			if (st.status === "blocked") {
				this.db.run("INSERT INTO ops_notify_deliveries (id, notification_id, channel_id, run_id, org_id, status, attempt, error, created_at) VALUES (?, ?, ?, ?, ?, 'blocked', 0, ?, ?)", id, notificationId, chId, runId ?? null, ownerOrgId, st.detail ?? "blocked", nowIso());
				continue;
			}
			this.db.run("INSERT INTO ops_notify_deliveries (id, notification_id, channel_id, run_id, org_id, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)", id, notificationId, chId, runId ?? null, ownerOrgId, nowIso());
			const p = this.#sendWebhook(id, ch, payload).finally(() => this.#pending.delete(p));
			this.#pending.add(p);
		}
		return ids;
	}

	async #sendWebhook(deliveryId: string, ch: any, payload: Record<string, unknown>): Promise<void> {
		const body = JSON.stringify({ ...payload, deliveryId });
		const secret = ch.secret_enc ? this.secrets.open(ch.secret_enc) : null;
		const maxAttempts = 1 + this.retryDelaysMs.length;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let status: number | null = null;
			let error: string | null = null;
			try {
				validateWebhookUrl(ch.target);
				const ts = Math.floor(Date.now() / 1000).toString();
				const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Workroom-Webhook/1", "x-workroom-delivery": deliveryId, "x-workroom-timestamp": ts, "idempotency-key": deliveryId };
				if (secret) headers["x-workroom-signature"] = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
				const res = await fetch(ch.target, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
				status = res.status;
				await res.arrayBuffer().catch(() => undefined);
				if (res.status >= 200 && res.status < 300) {
					this.db.run("UPDATE ops_notify_deliveries SET status = 'sent', attempt = ?, http_status = ?, error = NULL, delivered_at = ? WHERE id = ?", attempt, status, nowIso(), deliveryId);
					logEvent("info", "notify.webhook_sent", { deliveryId, channelId: ch.id, status });
					return;
				}
				error = `HTTP ${res.status}`;
			} catch (e) {
				error = (e as Error).message;
			}
			const final = attempt === maxAttempts || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429);
			this.db.run("UPDATE ops_notify_deliveries SET status = ?, attempt = ?, http_status = ?, error = ? WHERE id = ?", final ? "failed" : "pending", attempt, status, redactText(error ?? "").slice(0, 500), deliveryId);
			logEvent("warn", "notify.webhook_failed", { deliveryId, channelId: ch.id, status, attempt, final, error });
			if (final) return;
			await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt - 1]));
		}
	}

	/** Manual retry of a failed delivery (new attempt series on the same delivery row). */
	retry(p: Principal, deliveryId: string): void {
		const d = this.db.get<any>("SELECT d.*, n.user_id, n.title, n.body, n.link, n.status AS n_status, n.refs, n.run_id AS n_run FROM ops_notify_deliveries d JOIN ops_notifications n ON n.id = d.notification_id WHERE d.id = ? AND d.org_id = ?", deliveryId, p.orgId);
		if (!d) throw new HttpError(404, "not_found", "投递记录不存在");
		const ch = this.db.get<any>("SELECT * FROM ops_notify_channels WHERE id = ? AND org_id = ? AND deleted_at IS NULL", d.channel_id, p.orgId);
		if (!ch) throw new HttpError(404, "not_found", "通知渠道不存在");
		if (ch.owner_user_id !== p.userId && p.orgRole === "member") throw new HttpError(403, "forbidden", "无权重试该投递");
		if (this.channelStatus(ch).status === "blocked") throw new HttpError(409, "channel_blocked", this.channelStatus(ch).detail ?? "渠道不可用");
		this.db.run("UPDATE ops_notify_deliveries SET status = 'pending' WHERE id = ?", deliveryId);
		const payload = { event: "notification.retry", notification: { id: d.notification_id, title: d.title, body: d.body, link: d.link, status: d.n_status, refs: JSON.parse(d.refs) } };
		const pr = this.#sendWebhook(deliveryId, ch, payload).finally(() => this.#pending.delete(pr));
		this.#pending.add(pr);
	}
}

export function notificationDto(r: any) {
	return { id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link ?? undefined, status: r.status ?? undefined, refs: JSON.parse(r.refs ?? "[]"), runId: r.run_id ?? undefined, createdAt: r.created_at, readAt: r.read_at ?? undefined };
}
export function deliveryDto(r: any) {
	return { id: r.id, notificationId: r.notification_id, channelId: r.channel_id, status: r.status, attempt: r.attempt, httpStatus: r.http_status ?? undefined, error: r.error ?? undefined, createdAt: r.created_at, deliveredAt: r.delivered_at ?? undefined };
}
export function channelDto(svc: NotifyService, r: any) {
	const st = svc.channelStatus(r);
	return { id: r.id, kind: r.kind, name: r.name, target: r.kind === "webhook" ? r.target.replace(/\?.*$/, "?…") : r.target, enabled: !!r.enabled, status: st.status, statusDetail: st.detail, hasSecret: !!r.secret_enc, createdAt: r.created_at };
}
