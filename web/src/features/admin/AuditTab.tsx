// 审计 tab.
import { Download, Shield } from "lucide-react";
import { useState } from "react";
import type { AuditEntryDTO } from "@shared/ops";
import { api, qs } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fullTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge, EmptyState, Loadable } from "@/components/ui/misc";
import { Row, Table } from "@/features/admin/common";

const CATS = ["", "auth", "admin", "grant", "share", "external_write", "model", "budget", "automation", "security"] as const;
const CAT_LABEL: Record<string, string> = { "": "全部", auth: "登录", admin: "管理", grant: "授权", share: "分享", external_write: "外部写", model: "模型", budget: "预算", automation: "自动化", security: "安全" };

const ACTION_TEXT: Record<string, string> = {
	"auth.login": "登录", "auth.login_failed": "登录失败", "auth.invite_accepted": "通过邀请加入", "auth.password_changed": "修改密码", "auth.oidc_link_required": "企业登录需要绑定账号", "auth.oidc_rejected": "企业登录被拒绝",
	"department.create": "创建部门", "department.update": "修改部门", "department.move": "移动部门", "department.archive": "删除部门", "department.member.set": "调整部门成员", "department.member.remove": "移出部门成员",
	"grant.invite_create": "创建邀请", "grant.invite_revoke": "撤销邀请", "grant.role_assign": "授予角色", "grant.role_revoke": "撤销角色", "grant.org_role": "修改基础角色", "grant.user_allow": "单独授予权限", "grant.user_deny": "单独禁止权限", "grant.user_grant_remove": "移除单独授权",
	"group.create": "创建用户组", "group.update": "修改用户组", "group.delete": "删除用户组", "group.member.set": "调整用户组成员",
	"member.disable": "停用成员", "member.enable": "恢复成员", "member.remove": "移出成员", "org.rename": "修改组织名称",
	"role.create": "创建角色", "role.update": "修改角色", "role.clone": "克隆角色", "role.delete": "删除角色",
	"session.admin_revoke": "管理员退出登录设备", "session.revoke": "退出登录设备", "session.revoke_others": "退出其他设备",
	"share.create": "创建分享链接", "share.revoke": "撤销分享链接", "skill.submit": "提交技能审核", "skill.publish": "发布技能", "skill.unpublish": "下架技能", "skill.install": "安装技能", "skill.uninstall": "卸载技能", "skill.upload": "上传技能", "skill.force_publish": "强制发布技能",
	"totp.enable": "开启两步验证", "totp.disable": "关闭两步验证",
};
const actionText = (action: string, category: string): string => ACTION_TEXT[action] ?? `${CAT_LABEL[category] ?? category}变更`;

export function Audit() {
	const [cat, setCat] = useState("");
	const [action, setAction] = useState("");
	const q = qs({ category: cat, action: action || undefined, limit: 100 });
	const res = useApi<{ items: AuditEntryDTO[]; next?: string }>(`/admin/audit${q}`);
	const [tech, setTech] = useState(false);
	const [more, setMore] = useState<AuditEntryDTO[]>([]);
	const items = [...(res.data?.items ?? []), ...more];
	return (
		<div>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<Select value={cat} onChange={(e) => (setCat(e.target.value), setMore([]))} className="h-8 text-sm" aria-label="类别">
					{CATS.map((c) => (
						<option key={c} value={c}>
							{CAT_LABEL[c]}
						</option>
					))}
				</Select>
				{tech ? <Input value={action} onChange={(e) => (setAction(e.target.value), setMore([]))} placeholder="动作（支持前缀*，如 member.*）" aria-label="按动作筛选" className="h-8 w-60 text-sm" /> : null}
				<span className="inline-flex items-center gap-2 text-sm text-fg-muted">
					<Switch aria-label="显示技术详情" checked={tech} onCheckedChange={setTech} data-testid="audit-tech" />
					技术详情
				</span>
				<span className="flex-1" />
				<Button size="sm" asChild>
					<a href={`/api/admin/audit.csv${qs({ category: cat, action: action || undefined })}`} data-testid="audit-export">
						<Download />
						导出审计日志
					</a>
				</Button>
				<Button size="sm" asChild>
					<a href="/api/usage/export.csv?scope=org">
						<Download />
						导出用量
					</a>
				</Button>
			</div>
			<Loadable state={res} what="审计">
				{items.length === 0 ? (
					<EmptyState icon={<Shield />} title="没有符合条件的审计记录" />
				) : (
					<Table testId="admin-audit">
						{items.map((a) => (
							<div key={a.id}>
								<Row>
									<span className="w-36 shrink-0 text-xs text-fg-muted">{fullTime(a.at)}</span>
									<Badge>{CAT_LABEL[a.category] ?? a.category}</Badge>
									<span className="min-w-0 flex-1 basis-48">
										<span className="block text-sm">{actionText(a.action, a.category)}</span>
										<span className="block truncate text-xs text-fg-muted">
											{a.actorName ?? a.actorUserId ?? "系统"}
										</span>
										{tech ? (
											<span className="block break-all font-mono text-xs text-fg-muted" data-testid="audit-tech-line">
												{a.action}
												{a.target ? ` → ${a.target}` : ""}
												{a.requestId ? ` · ${a.requestId}` : ""}
												{a.detail ? ` · ${JSON.stringify(a.detail)}` : ""}
											</span>
										) : null}
									</span>
								</Row>
							</div>
						))}
					</Table>
				)}
				{res.data?.next && !more.length ? (
					<Button
						size="sm"
						variant="ghost"
						className="mt-2"
						onClick={async () => {
							const r = await api<{ items: AuditEntryDTO[] }>(`/admin/audit${qs({ category: cat, action: action || undefined, before: res.data!.next, limit: 100 })}`);
							setMore(r.items);
						}}
					>
						加载更早的记录
					</Button>
				) : null}
			</Loadable>
		</div>
	);
}
