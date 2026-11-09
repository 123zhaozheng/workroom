// Permission catalog + built-in roles (RBAC group, round 4). Single source of truth for permission ids, Chinese
// labels/descriptions, and what each built-in role grants. Imported by the server (server/src/identity/authz.ts) and the
// web admin UI (via @shared/permissions). Keep this file dependency-free (type-stripping friendly: no enums).

export type PermissionScopeKind = "org" | "department" | "project";
export type PermissionRisk = "normal" | "sensitive" | "critical";

export interface PermissionGroup {
	readonly id: string;
	readonly label: string;
	readonly description: string;
}

export interface PermissionDef {
	/** Stable id, `<area>.<action>`; callers pass it to AuthzService.has/require/explain. */
	readonly id: string;
	readonly group: string;
	readonly label: string;
	readonly description: string;
	/** Scopes at which an assignment/grant of this permission is meaningful. "org" is always allowed. */
	readonly scopes: readonly PermissionScopeKind[];
	readonly risk: PermissionRisk;
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
	{ id: "org", label: "组织设置", description: "组织名称、单点登录、安全策略与通知渠道等组织级配置" },
	{ id: "member", label: "成员与邀请", description: "成员名录、邀请、停用与移出、登录会话" },
	{ id: "department", label: "部门", description: "部门树的维护，以及部门成员与负责人" },
	{ id: "role", label: "角色与授权", description: "自定义角色、角色分配、用户直接授权/禁止与用户组" },
	{ id: "model", label: "模型与渠道", description: "平台模型、上游渠道与凭据，以及成员使用模型" },
	{ id: "budget", label: "预算与账单", description: "用量预算、成本与账单查看和导出" },
	{ id: "audit", label: "审计与排查", description: "审计日志、导出与请求链路排查" },
	{ id: "stats", label: "统计", description: "个人、项目、部门、组织范围的用量与效果统计" },
	{ id: "knowledge", label: "知识库", description: "创建个人/部门/企业知识库、发布与治理" },
	{ id: "file", label: "文件导出", description: "把文件带出工作区" },
	{ id: "share", label: "外部分享", description: "创建公开只读链接与治理他人创建的链接" },
	{ id: "skill", label: "技能", description: "使用、上传、发布、审核技能与管理市场" },
	{ id: "mcp", label: "MCP 与连接器", description: "添加个人/组织连接器，审核连接器" },
	{ id: "sandbox", label: "沙箱", description: "沙箱执行、联网与浏览器" },
	{ id: "automation", label: "自动化", description: "创建自动化，以及以他人身份运行" },
	{ id: "project", label: "项目", description: "创建项目与管理项目" },
	{ id: "assistant", label: "助手", description: "发布组织级助手" },
];

const O: readonly PermissionScopeKind[] = ["org"];
const OD: readonly PermissionScopeKind[] = ["org", "department"];
const OP: readonly PermissionScopeKind[] = ["org", "project"];
const ODP: readonly PermissionScopeKind[] = ["org", "department", "project"];

function p(id: string, group: string, label: string, description: string, scopes: readonly PermissionScopeKind[] = O, risk: PermissionRisk = "normal"): PermissionDef {
	return { id, group, label, description, scopes, risk };
}

export const PERMISSIONS: readonly PermissionDef[] = [
	// ---- 组织设置
	p("org.settings.manage", "org", "修改组织设置", "修改组织名称、数据维护操作（用量重建等）和其他基础设置"),
	p("org.security.manage", "org", "管理安全设置", "配置单点登录（OIDC）、外发 Webhook 白名单等安全相关设置", O, "critical"),
	p("org.notify.manage", "org", "管理共享通知渠道", "创建和删除组织共享的通知渠道，查看全部投递记录"),
	p("org.owner.manage", "org", "变更组织所有者", "授予、撤销或转让组织所有者；只有所有者默认拥有", O, "critical"),
	// ---- 成员与邀请
	p("member.view", "member", "查看成员", "查看成员名录、状态、所属部门与角色（部门范围内只看到本部门子树）", OD),
	p("member.invite", "member", "邀请成员", "生成与撤销邀请码；部门范围内只能邀请到本部门子树", OD),
	p("member.disable", "member", "停用/恢复成员", "停用成员并撤销其全部会话，或恢复；不能操作权限高于自己的成员", OD, "sensitive"),
	p("member.remove", "member", "移出组织", "把成员移出组织并清理其项目、部门、会话与分享链接", O, "critical"),
	p("member.session.manage", "member", "管理登录会话", "查看并撤销组织内成员的登录会话", O, "sensitive"),
	// ---- 部门
	p("dept.view", "department", "查看部门", "查看部门树与部门成员数", OD),
	p("dept.manage", "department", "维护部门结构", "新建、重命名、移动、删除部门；部门管理员只能操作自己的子树", OD),
	p("dept.member.manage", "department", "管理部门成员", "把成员加入/移出部门，设置部门负责人", OD),
	// ---- 角色与授权
	p("role.view", "role", "查看角色与授权", "查看角色、权限矩阵与角色分配", ODP),
	p("role.manage", "role", "管理自定义角色", "创建、编辑、克隆、删除自定义角色；不能写入自己没有的权限", O, "critical"),
	p("role.assign", "role", "分配角色", "给用户、部门或用户组分配角色（带范围）；不能分配自己没有的权限", ODP, "sensitive"),
	p("grant.manage", "role", "直接授权与禁止", "对单个用户直接授予或禁止某项权限（禁止优先于允许）", O, "critical"),
	p("group.manage", "role", "管理用户组", "创建用户组并维护其成员", O),
	// ---- 模型与渠道
	p("model.use", "model", "使用模型", "在对话、自动化中选择并调用平台模型"),
	p("model.manage", "model", "管理平台模型", "上架/下架平台模型，维护路由与可见范围"),
	p("model.provider.manage", "model", "管理渠道与凭据", "新增上游渠道、保存和轮换密钥、测试连通", O, "critical"),
	// ---- 预算与账单
	p("budget.view", "budget", "查看预算", "查看预算与已用额度", ODP),
	p("budget.manage", "budget", "管理预算", "创建、修改、删除预算，配置节省工时基准", ODP, "sensitive"),
	p("billing.view", "budget", "查看成本与账单", "查看费用明细、用量台账与核对"),
	p("billing.export", "budget", "导出账单", "导出用量与费用 CSV", O, "sensitive"),
	// ---- 审计与排查
	p("audit.view", "audit", "查看审计日志", "查询组织的审计记录"),
	p("audit.export", "audit", "导出审计日志", "导出审计 CSV（导出本身会被审计）", O, "sensitive"),
	p("trace.view", "audit", "请求链路排查", "按请求/运行/自动化 ID 查询模型路由、工具调用、检索等链路", O, "sensitive"),
	// ---- 统计
	p("stats.personal.view", "stats", "查看个人统计", "查看自己的用量与效果统计"),
	p("stats.project.view", "stats", "查看项目统计", "查看项目维度的统计（项目所有者默认可看自己的项目）", OP),
	p("stats.department.view", "stats", "查看部门统计", "查看部门维度的统计（部门负责人默认可看本部门）", OD),
	p("stats.org.view", "stats", "查看组织统计", "查看组织总体统计"),
	p("stats.export", "stats", "导出统计", "导出用量统计与台账", O, "sensitive"),
	// ---- 知识库
	p("kb.create.personal", "knowledge", "创建个人知识库", "创建仅自己使用的知识库"),
	p("kb.create.department", "knowledge", "创建部门知识库", "为所在部门创建知识库", OD),
	p("kb.create.org", "knowledge", "创建企业知识库", "创建全组织可见的知识库"),
	p("kb.publish", "knowledge", "发布知识库", "把知识库发布给部门或组织使用", OD, "sensitive"),
	p("kb.govern", "knowledge", "治理知识库", "管理他人创建的知识库：改权限、下线、删除", OD, "sensitive"),
	// ---- 文件导出
	p("file.export", "file", "导出文件", "下载与导出文件到工作区之外"),
	// ---- 外部分享
	p("share.external.create", "share", "创建外部分享链接", "为会话、文件、项目创建公开只读链接", O, "sensitive"),
	p("share.external.manage", "share", "治理外部分享", "查看并撤销他人创建的外部分享链接", O, "sensitive"),
	// ---- 技能
	p("skill.use", "skill", "使用技能", "在对话中使用已启用的技能"),
	p("skill.upload", "skill", "上传个人技能", "上传仅自己使用的技能"),
	p("skill.publish", "skill", "发布技能", "把技能发布给部门或组织（需经审核时进入待审）", OD, "sensitive"),
	p("skill.review", "skill", "审核技能", "审批或驳回提交的技能", OD, "sensitive"),
	p("skill.marketplace.manage", "skill", "管理技能市场", "上下架市场条目，设置来源与可见范围", O, "sensitive"),
	// ---- MCP 与连接器
	p("mcp.connector.add_personal", "mcp", "添加个人连接器", "添加仅自己使用的 MCP 连接器"),
	p("mcp.connector.add_org", "mcp", "添加组织连接器", "添加供组织或部门使用的连接器（含系统连接）", OD, "sensitive"),
	p("mcp.connector.review", "mcp", "审核连接器", "审批或驳回连接器与工具策略变更", OD, "sensitive"),
	// ---- 沙箱
	p("sandbox.use", "sandbox", "使用沙箱", "在云端沙箱执行代码与命令"),
	p("sandbox.network", "sandbox", "沙箱联网", "允许沙箱访问外部网络", O, "sensitive"),
	p("sandbox.browser", "sandbox", "浏览器工具", "使用云端浏览器工具访问网页"),
	p("sandbox.policy.manage", "sandbox", "管理沙箱与工具策略", "修改组织的沙箱、网络与工具策略", O, "sensitive"),
	// ---- 自动化
	p("automation.create", "automation", "创建自动化", "创建定时/事件触发的自动化"),
	p("automation.run_as_others", "automation", "以他人身份运行自动化", "管理他人的自动化，并让自动化以其负责人以外的身份运行", O, "critical"),
	// ---- 项目
	p("project.create", "project", "创建项目", "创建新的项目空间"),
	p("project.manage", "project", "管理项目", "管理项目设置与成员（不含查看项目内容）；项目所有者默认拥有", OP, "sensitive"),
	// ---- 助手
	p("assistant.publish.org", "assistant", "发布组织助手", "创建、修改和删除组织级助手", O, "sensitive"),
];

export const PERMISSION_IDS: readonly string[] = PERMISSIONS.map((x) => x.id);
const BY_ID = new Map(PERMISSIONS.map((x) => [x.id, x]));
export function permissionDef(id: string): PermissionDef | undefined {
	return BY_ID.get(id);
}
export function isPermissionId(id: string): boolean {
	return BY_ID.has(id);
}

// ------------------------------------------------------------------ built-in roles
export interface BuiltinRoleDef {
	/** `builtin:<key>` — stable across versions; never stored with a permission list (always derived from this file). */
	readonly id: string;
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly permissions: readonly string[];
	/** Scopes at which this role may be assigned. */
	readonly scopes: readonly PermissionScopeKind[];
}

const ALL = PERMISSIONS.map((x) => x.id);
const NOT_OWNER_ONLY = ALL.filter((x) => x !== "org.owner.manage");

const MEMBER_PERMS = [
	"dept.view",
	"model.use",
	"stats.personal.view",
	"kb.create.personal",
	"file.export",
	"share.external.create",
	"skill.use",
	"skill.upload",
	"mcp.connector.add_personal",
	"sandbox.use",
	"sandbox.browser",
	"automation.create",
	"project.create",
];

export const BUILTIN_ROLES: readonly BuiltinRoleDef[] = [
	{ id: "builtin:owner", key: "owner", name: "组织所有者", description: "拥有全部权限，不受「禁止」影响；组织至少保留一位有效所有者，不可被锁定。", permissions: ALL, scopes: ["org"] },
	{ id: "builtin:admin", key: "admin", name: "组织管理员", description: "管理成员、部门、角色、模型、预算、审计与各类策略；除「变更组织所有者」外拥有全部权限。", permissions: NOT_OWNER_ONLY, scopes: ["org"] },
	{
		id: "builtin:auditor",
		key: "auditor",
		name: "安全审计员",
		description: "只读：查看与导出审计日志、请求链路和各范围统计，不能修改任何配置。",
		permissions: ["audit.view", "audit.export", "trace.view", "member.view", "dept.view", "role.view", "stats.project.view", "stats.department.view", "stats.org.view", "stats.export"],
		scopes: ["org"],
	},
	{
		id: "builtin:billing",
		key: "billing",
		name: "计费管理员",
		description: "管理预算，查看与导出成本、用量和统计。",
		permissions: ["budget.view", "budget.manage", "billing.view", "billing.export", "stats.project.view", "stats.department.view", "stats.org.view", "stats.export", "dept.view"],
		scopes: ["org"],
	},
	{
		id: "builtin:dept_admin",
		key: "dept_admin",
		name: "部门管理员",
		description: "只管理被授权部门及其子部门：成员、邀请、子部门、部门知识库/技能/连接器与部门统计。不能授予自己没有的权限。",
		permissions: [
			"member.view",
			"member.invite",
			"member.disable",
			"dept.view",
			"dept.manage",
			"dept.member.manage",
			"role.view",
			"role.assign",
			"budget.view",
			"stats.department.view",
			"kb.create.department",
			"kb.publish",
			"kb.govern",
			"skill.publish",
			"skill.review",
			"mcp.connector.add_org",
		],
		scopes: ["department"],
	},
	{
		id: "builtin:skill_reviewer",
		key: "skill_reviewer",
		name: "技能审核员",
		description: "审核技能与 MCP 连接器的发布申请，管理技能市场。",
		permissions: ["skill.review", "skill.marketplace.manage", "mcp.connector.review", "skill.use", "dept.view"],
		scopes: ["org", "department"],
	},
	{ id: "builtin:member", key: "member", name: "普通成员", description: "日常使用：对话、模型、个人知识库/技能/连接器、沙箱、自动化、创建项目与外部分享。", permissions: MEMBER_PERMS, scopes: ["org"] },
	{
		id: "builtin:guest",
		key: "guest",
		name: "访客",
		description: "只读体验：可对话使用模型与技能，不可用沙箱、不可导出文件、不可对外分享、不可建项目或自动化。",
		permissions: ["dept.view", "model.use", "stats.personal.view", "skill.use"],
		scopes: ["org"],
	},
];

const ROLE_BY_ID = new Map(BUILTIN_ROLES.map((r) => [r.id, r]));
export function builtinRole(id: string): BuiltinRoleDef | undefined {
	return ROLE_BY_ID.get(id);
}
/** Legacy Principal.orgRole → built-in role id. */
export const LEGACY_ROLE_TO_BUILTIN: Readonly<Record<string, string>> = { owner: "builtin:owner", admin: "builtin:admin", member: "builtin:member" };
/** Built-in roles that act as the "base" role of a member at org scope (exactly one is held). */
export const BASE_ROLE_IDS: readonly string[] = ["builtin:owner", "builtin:admin", "builtin:member", "builtin:guest"];

/** Permissions that let a viewer into the admin console at all (used for tab gating in the UI). */
export const ADMIN_CONSOLE_PERMISSIONS: readonly string[] = ["org.settings.manage", "member.view", "member.invite", "dept.manage", "dept.member.manage", "role.view", "role.manage", "role.assign", "grant.manage", "model.manage", "model.provider.manage", "budget.view", "budget.manage", "billing.view", "audit.view", "trace.view", "member.session.manage"];

// ------------------------------------------------------------------ DTOs shared by server and web
export interface ScopeRef {
	readonly kind: PermissionScopeKind;
	/** Absent / empty for kind "org". */
	readonly id?: string;
}
export interface RoleDTO {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly builtin: boolean;
	readonly permissions: readonly string[];
	/** Scopes at which the role can be assigned. */
	readonly scopes: readonly PermissionScopeKind[];
	readonly assignmentCount: number;
	readonly createdAt?: string;
	readonly updatedAt?: string;
}
export interface RoleAssignmentDTO {
	readonly id: string;
	readonly subject: { readonly kind: "user" | "department" | "group"; readonly id: string; readonly name?: string };
	readonly roleId: string;
	readonly roleName?: string;
	readonly scope: ScopeRef & { readonly name?: string };
	readonly createdAt: string;
	readonly createdBy?: string;
}
export interface UserGrantDTO {
	readonly id: string;
	readonly userId: string;
	readonly permission: string;
	readonly effect: "allow" | "deny";
	readonly scope: ScopeRef & { readonly name?: string };
	readonly reason?: string;
	readonly createdAt: string;
	readonly createdBy?: string;
}
export interface EffectivePermissionDTO {
	readonly permission: string;
	readonly allow: boolean;
	readonly because: readonly { readonly source: "role" | "user_grant" | "user_deny" | "owner" | "default"; readonly detail: string; readonly effect: "allow" | "deny" }[];
}
export interface MemberAccessDTO {
	readonly userId: string;
	readonly name: string;
	readonly email: string;
	readonly legacyRole: string;
	readonly status: "active" | "disabled";
	readonly departments: readonly { id: string; name: string; role: "member" | "manager"; path: string }[];
	readonly assignments: readonly (RoleAssignmentDTO & { readonly via: "direct" | "department" | "group"; readonly viaName?: string })[];
	readonly grants: readonly UserGrantDTO[];
	/** Effective permissions at org scope (every catalog id). */
	readonly effective: readonly EffectivePermissionDTO[];
	/** Permissions granted only inside a department/project scope (so they do not show as org-level). */
	readonly scoped: readonly { readonly scope: ScopeRef & { readonly name?: string }; readonly permissions: readonly string[] }[];
	/** Whether the viewer may change this member's roles / grants / status. */
	readonly can: { readonly assign: boolean; readonly grant: boolean; readonly disable: boolean; readonly remove: boolean };
}
