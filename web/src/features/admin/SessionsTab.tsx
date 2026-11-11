// 会话 tab.
import type { SessionDTO } from "@shared/ops";
import { del } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime, relTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Loadable } from "@/components/ui/misc";
import { useAct, Table, Row } from "@/features/admin/common";

const AUTH: Record<string, string> = { password: "密码登录", oidc: "企业登录", invite: "邀请加入" };

export function Sessions() {
	const res = useApi<{ sessions: SessionDTO[] }>("/admin/sessions");
	const { busy, run, note } = useAct(res.reload);
	return (
		<Loadable state={res} what="登录会话">
			{note}
			<Table testId="admin-sessions">
				{(res.data?.sessions ?? []).map((s) => (
					<div key={s.id}>
						<Row>
							<span className="min-w-0 flex-1">
								<span className="block font-medium">
									{s.userName ?? s.userId} {s.current ? <Badge tone="info">当前会话</Badge> : null}
								</span>
								<span className="block truncate text-xs text-fg-muted">
									{AUTH[s.authMethod] ?? s.authMethod} · 创建 {fullTime(s.createdAt)}
									{s.lastSeenAt ? ` · 最近 ${relTime(s.lastSeenAt)}` : ""} · {s.userAgent ?? ""}
								</span>
							</span>
							{s.revokedAt ? (
								<Badge>已退出</Badge>
							) : !s.current ? (
								<Button size="sm" disabled={busy} onClick={() => run(() => del(`/admin/sessions/${s.id}`))}>
									退出
								</Button>
							) : null}
						</Row>
					</div>
				))}
			</Table>
		</Loadable>
	);
}
