# 权限模型（RBAC，round 4）

实现：`shared/permissions.ts`（目录与内置角色）、`server/src/identity/authz.ts`（服务 `authz`）、`server/src/identity/rbac-routes.ts`（角色/授权 API）、`server/src/identity/policy.ts`（admin 路由权限表）。前端：`web/src/features/admin/**`（组织架构 / 角色与权限 / 授权 / 成员详情）与设置页「我的权限」。
调用方指南与对他组的改动请求：`docs/requests/rbac.md`。

## 调用

```ts
const authz = ctx.services.get("authz");           // AuthzService（契约见 server/src/core/contracts.ts）
await authz.require(principal, "skill.review");      // 不满足 → HttpError 403 {code:"forbidden", detail:{permission, because}}
await authz.has(principal, "stats.department.view", { kind: "department", id });  // 部门范围含子部门
const why = await authz.explain(principal, "member.disable");  // { allow, because:[{source,detail,effect}] }
```

- 永远按**当前**数据库状态求值（成员状态、会话、部门树、角色、授权），没有缓存；Principal 失效（停用/移除/会话撤销）→ `has` 为 false，`require` 抛 401。
- `Principal.orgRole` 保留兼容：owner/admin/member（访客与其他内置角色读作 `member`）。**新代码不要再按 orgRole 分支。**

## 模型

- **权限目录**：约 60 个 id，分组、中文名、说明、适用范围（组织/部门/项目）、风险级别。
- **内置角色**（只读，定义在代码里，随版本更新）：组织所有者、组织管理员、安全审计员、计费管理员、部门管理员（只能分配在部门范围）、技能审核员、普通成员、访客。
- **自定义角色**：组织自定义权限集合（`id_roles`）；可克隆内置角色。不能包含 `org.owner.manage`；创建/修改者只能写入自己拥有的权限。
- **角色分配**（`id_role_assignments`）：主体 = 用户 / 部门（含子部门成员）/ 用户组；范围 = 整个组织 / 部门（含子部门）/ 项目。基础角色（所有者/管理员/普通成员/访客）每人且仅一个，在组织范围，只能分给个人。
- **用户直接授权/禁止**（`id_user_grants`）：按权限 + 范围；**禁止优先于允许**；组织所有者不受影响（API 直接拒绝，写入表也无效）。
- **求值顺序**：成员须有效 → 所有者规则 → 命中范围的禁止 → 角色分配 / 直接允许 / 默认（项目所有者对本项目、部门负责人对本部门的统计与成员查看）→ 否则拒绝。范围包含关系：组织 ⊇ 部门（含子部门）；项目只含自身。
- **部门管理员**：被分配「部门管理员」在部门 D 后，只对 D 及其子树生效：看到/管理子树内成员（成员的**所有**部门都须在其权限内才可停用）、在子树内建/改名部门、邀请进子树；移动部门需同时管理旧父级与新父级；删除部门需管理其父级。目标成员的权限若高于操作者则不可操作（owner 需 `org.owner.manage`）。
- **不得越权**：分配/撤销角色、写自定义角色、直接授权、邀请，操作者必须自己拥有相应权限（在该范围内）；把成员加入「已被授予角色」的部门/用户组同样要求。
- **最后一位所有者**不可被移除、停用、降级、删除其基础角色分配。
- **迁移**（identity migration v4）：每个有效成员得到一条组织范围的基础角色分配（owner→组织所有者，admin→组织管理员，member→普通成员）；`id_org_members.role` 列保留，并由触发器与基础角色分配保持同步（旧代码/测试直接 UPDATE 该列也有效）。成员被移出组织时其全部角色分配与直接授权被清除，重新加入只得基础角色。
- **审计**：所有变更写 `id_audit`，类别 `grant`（`role.create/update/clone/delete`、`grant.role_assign/role_revoke/org_role/user_allow/user_deny/user_grant_remove`、`group.*`、`department.*`、`member.*`、`grant.invite_*`），带操作者、目标、前后内容与 requestId。

## HTTP API（均在 `/api` 下）

| 路由 | 需要权限 | 说明 |
|---|---|---|
| GET `/permissions/catalog` | 任意成员 | 分组、权限、内置角色 |
| GET `/me/permissions` | 任意成员 | 自己的角色（含来源）、直接授权、各权限有效性与原因 |
| GET `/admin/roles` · POST · PATCH/DELETE `/:id` · POST `/:id/clone` | `role.view`(任一范围) · `role.manage` | 内置角色只读（403 `builtin_role`） |
| GET/POST `/admin/role-assignments` · DELETE `/:id` | `role.view` · `role.assign`@范围 | 基础角色会替换原基础角色；删除基础角色分配 400 |
| GET `/admin/members/:id/access` · `/explain?permission&scopeKind&scopeId` | `member.view`（组织或其部门） | 成员详情与「为什么」 |
| PUT `/admin/members/:id/grants` · DELETE `/:grantId` | `grant.manage` | 直接允许/禁止（带范围、理由） |
| GET/POST `/admin/groups` · PATCH/DELETE `/:id` · GET/PUT `/:id/members` | `role.view` · `group.manage` | 用户组（可选） |
| GET `/admin/departments/overview` | 任意成员 | 部门树 + 负责人 + 部门管理员 + 当前用户可做的操作 |
| 成员/邀请/部门/会话/审计 | `member.*` `dept.*` `member.session.manage` `audit.view/export` | 见 `identity/routes.ts` |
| 其他模块的 `/admin/*` | 见 `identity/policy.ts` 路由权限表 | 表内路由由中间件统一校验；表外由各模块处理 |

## 权限目录（自动生成自 `shared/permissions.ts`）

| 权限 id | 名称 | 范围 | 风险 | 组织所有者 | 组织管理员 | 安全审计员 | 计费管理员 | 部门管理员 | 技能审核员 | 普通成员 | 访客 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **组织设置** | | | |||||||||
| `org.settings.manage` | 修改组织设置 | 组织 |  | ● | ● |  |  |  |  |  |  |
| `org.security.manage` | 管理安全设置 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| `org.notify.manage` | 管理共享通知渠道 | 组织 |  | ● | ● |  |  |  |  |  |  |
| `org.owner.manage` | 变更组织所有者 | 组织 | 高危 | ● |  |  |  |  |  |  |  |
| **成员与邀请** | | | |||||||||
| `member.view` | 查看成员 | 组织/部门 |  | ● | ● | ● |  | ● |  |  |  |
| `member.invite` | 邀请成员 | 组织/部门 |  | ● | ● |  |  | ● |  |  |  |
| `member.disable` | 停用/恢复成员 | 组织/部门 | 敏感 | ● | ● |  |  | ● |  |  |  |
| `member.remove` | 移出组织 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| `member.session.manage` | 管理登录会话 | 组织 | 敏感 | ● | ● |  |  |  |  |  |  |
| **部门** | | | |||||||||
| `dept.view` | 查看部门 | 组织/部门 |  | ● | ● | ● | ● | ● | ● | ● | ● |
| `dept.manage` | 维护部门结构 | 组织/部门 |  | ● | ● |  |  | ● |  |  |  |
| `dept.member.manage` | 管理部门成员 | 组织/部门 |  | ● | ● |  |  | ● |  |  |  |
| **角色与授权** | | | |||||||||
| `role.view` | 查看角色与授权 | 组织/部门/项目 |  | ● | ● | ● |  | ● |  |  |  |
| `role.manage` | 管理自定义角色 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| `role.assign` | 分配角色 | 组织/部门/项目 | 敏感 | ● | ● |  |  | ● |  |  |  |
| `grant.manage` | 直接授权与禁止 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| `group.manage` | 管理用户组 | 组织 |  | ● | ● |  |  |  |  |  |  |
| **模型与渠道** | | | |||||||||
| `model.use` | 使用模型 | 组织 |  | ● | ● |  |  |  |  | ● | ● |
| `model.manage` | 管理平台模型 | 组织 |  | ● | ● |  |  |  |  |  |  |
| `model.provider.manage` | 管理渠道与凭据 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| **预算与账单** | | | |||||||||
| `budget.view` | 查看预算 | 组织/部门/项目 |  | ● | ● |  | ● | ● |  |  |  |
| `budget.manage` | 管理预算 | 组织/部门/项目 | 敏感 | ● | ● |  | ● |  |  |  |  |
| `billing.view` | 查看成本与账单 | 组织 |  | ● | ● |  | ● |  |  |  |  |
| `billing.export` | 导出账单 | 组织 | 敏感 | ● | ● |  | ● |  |  |  |  |
| **审计与排查** | | | |||||||||
| `audit.view` | 查看审计日志 | 组织 |  | ● | ● | ● |  |  |  |  |  |
| `audit.export` | 导出审计日志 | 组织 | 敏感 | ● | ● | ● |  |  |  |  |  |
| `trace.view` | 请求链路排查 | 组织 | 敏感 | ● | ● | ● |  |  |  |  |  |
| **统计** | | | |||||||||
| `stats.personal.view` | 查看个人统计 | 组织 |  | ● | ● |  |  |  |  | ● | ● |
| `stats.project.view` | 查看项目统计 | 组织/项目 |  | ● | ● | ● | ● |  |  |  |  |
| `stats.department.view` | 查看部门统计 | 组织/部门 |  | ● | ● | ● | ● | ● |  |  |  |
| `stats.org.view` | 查看组织统计 | 组织 |  | ● | ● | ● | ● |  |  |  |  |
| `stats.export` | 导出统计 | 组织 | 敏感 | ● | ● | ● | ● |  |  |  |  |
| **知识库** | | | |||||||||
| `kb.create.personal` | 创建个人知识库 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `kb.create.department` | 创建部门知识库 | 组织/部门 |  | ● | ● |  |  | ● |  |  |  |
| `kb.create.org` | 创建企业知识库 | 组织 |  | ● | ● |  |  |  |  |  |  |
| `kb.publish` | 发布知识库 | 组织/部门 | 敏感 | ● | ● |  |  | ● |  |  |  |
| `kb.govern` | 治理知识库 | 组织/部门 | 敏感 | ● | ● |  |  | ● |  |  |  |
| **文件导出** | | | |||||||||
| `file.export` | 导出文件 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| **外部分享** | | | |||||||||
| `share.external.create` | 创建外部分享链接 | 组织 | 敏感 | ● | ● |  |  |  |  | ● |  |
| `share.external.manage` | 治理外部分享 | 组织 | 敏感 | ● | ● |  |  |  |  |  |  |
| **技能** | | | |||||||||
| `skill.use` | 使用技能 | 组织 |  | ● | ● |  |  |  | ● | ● | ● |
| `skill.upload` | 上传个人技能 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `skill.publish` | 发布技能 | 组织/部门 | 敏感 | ● | ● |  |  | ● |  |  |  |
| `skill.review` | 审核技能 | 组织/部门 | 敏感 | ● | ● |  |  | ● | ● |  |  |
| `skill.marketplace.manage` | 管理技能市场 | 组织 | 敏感 | ● | ● |  |  |  | ● |  |  |
| **MCP 与连接器** | | | |||||||||
| `mcp.connector.add_personal` | 添加个人连接器 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `mcp.connector.add_org` | 添加组织连接器 | 组织/部门 | 敏感 | ● | ● |  |  | ● |  |  |  |
| `mcp.connector.review` | 审核连接器 | 组织/部门 | 敏感 | ● | ● |  |  |  | ● |  |  |
| **沙箱** | | | |||||||||
| `sandbox.use` | 使用沙箱 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `sandbox.network` | 沙箱联网 | 组织 | 敏感 | ● | ● |  |  |  |  |  |  |
| `sandbox.browser` | 浏览器工具 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `sandbox.policy.manage` | 管理沙箱与工具策略 | 组织 | 敏感 | ● | ● |  |  |  |  |  |  |
| **自动化** | | | |||||||||
| `automation.create` | 创建自动化 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `automation.run_as_others` | 以他人身份运行自动化 | 组织 | 高危 | ● | ● |  |  |  |  |  |  |
| **项目** | | | |||||||||
| `project.create` | 创建项目 | 组织 |  | ● | ● |  |  |  |  | ● |  |
| `project.manage` | 管理项目 | 组织/项目 | 敏感 | ● | ● |  |  |  |  |  |  |
| **助手** | | | |||||||||
| `assistant.publish.org` | 发布组织助手 | 组织 | 敏感 | ● | ● |  |  |  |  |  |  |


## 已知缺口

见交付报告：访客的「只读」目前由权限（无沙箱/导出/外部分享/建项目）体现，个人空间的写入仍由原 ACL 决定；各他组调用点的迁移见 `docs/requests/rbac.md`。
