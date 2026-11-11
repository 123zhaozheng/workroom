# R9 项目（Project）重构调研：轻量容器 + 目录式归属 + 服务端分享

结论先行：**会话不能在 space 之间搬家**；推荐"会话留在创建它的 space（默认个人空间），项目 = 目录关系 + 分享授权表"，旧项目空间原样保留为 legacy。

## 1. 现状数据模型

- 表：`id_projects`、`id_project_members(owner|editor|viewer)`、`id_spaces(kind,project_id UNIQUE)`（identity/module.ts:23-25）。`POST /projects` 同时建项目、owner 成员和一个 project space（identity/routes.ts:610-623）。项目 = 1 个 space = 1 份独立 `durable.sqlite`（`orgs/<org>/spaces/<space>/`，module.ts:219-222）。
- 路由：`/projects`（GET/POST）、`/projects/:id`（GET/PATCH/DELETE，DELETE 实为 `archived_at` 软归档）、`/projects/:id/members`（PUT）、`/shares`（外链）（routes.ts:604-729）。
- 会话：`rt_conversations(space_id, conversation_id) PK, project_id`（runtime/module.ts:19-32）。`project_id` 目前恒等于所在 space 的 projectId（service.ts:121，分支沿用 :569）。`POST /conversations` 传 projectId 即强制落到项目 space（routes.ts:44-48）。
- ACL：`spaceDecision`（module.ts:283）：personal 仅 owner；project 看成员角色；`conversation` 资源直接退化为其 space 的判断（:318）；`readableSpaces` 只含个人 + 成员项目（:341）。org 管理员**不能**读项目内容。
- 引用项目/项目 space 的模块：文件 `file_files.project_id`、列表按 readableSpaces（files/service.ts:130,312）；KB/记忆 scope=project 用 `id_project_members`（knowledge/acl.ts:40）；沙箱提供方覆盖 `tool_sandbox_project_provider`（默认关 `allow_project_override=0`，provider-config.ts:48,459）；项目环境变量层仅在 `space.kind==='project'` 时参与（env-vars.ts:109）；项目凭据（credentials/store.ts:278,396）；技能/MCP 项目级安装（market.ts:1016）；用量 `usage_ledger.project_id` 取自 space.projectId（usage.ts:137）及预算；自动化 `auto_automations.project_id`；handoff、stats。**项目级环境变量与沙箱覆盖均为可选，没有强制。**

## 2. 关键问题：会话能否跨 space 移动？——不能（不推荐自研）

pi-durable 1.5.0 只有同一 Storage 内的 `conv.fork()`，没有跨 storage 导入/导出（README、d.ts 均无）。会话的 entry/task/doc id 都是本 storage 内单调 id，tool result 绑定 task id，`wr.space` 会话文档写死 spaceId。仅能用 `tx.appendEntry` 重放，会丢 task/usage/approval/effects 状态与 fork 谱系，且必须会话空闲、双 space 租约。会断的引用：

| 引用 | 位置 | 问题 |
|---|---|---|
| 文件版本溯源 | `file_versions(space_id,conversation_id)` + 不可变触发器 | UPDATE 被触发器禁止，无法改写 |
| 凭据绑定 | `credentials.bind_space/bind_conv`、`credential_requests` | once/env 凭据失效 |
| 工作区 | `workspace_state/versions`（space+`c<id>`）、磁盘目录、`tool_sandbox_instances` | 目录与远程沙箱按 space 键控 |
| 技能/环境 | `skill_conv_loaded`、会话级 env `space:conv` | 丢失 |
| 用量/路由 | `usage_ledger UNIQUE(space,kind,entry_id)`、`usage_import_state`、`ops_route_attempts`、`tool_calls`、`tool_jobs` | entry id 变化，重复计费/丢账 |
| 外链/运行 | `id_share_links.space_id`、`auto_runs`、`rt_promote_intents`、URL `/c/:spaceId/:id` | 链接/书签失效 |

## 3. 方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）目录关系 + 分享表** | 会话留原 space；`rt_conversations.project_id` 复用为目录关系；`id_projects` 加 `kind('space'/'light')`，light 项目无 space；新表 `id_project_shares` | 移入/移出=改一列，零数据迁移；文件/沙箱/凭据/用量全不动；可回滚 | 授权需扩展会话访问路径；文件/工作区只读需按溯源放行 |
| B 复用 `id_project_members` 当分享表 | 免新表 | 成员语义=整个 space 权限，且 KB/记忆会顺带对 light 项目生效，语义混杂；多处 `JOIN id_spaces` 会漏 |
| C 物理搬迁（导出/重放） | 见第 2 节 | 项目内一切同空间 | 不可行/高风险 |

### 方案 A 的精确规则

- **新表**（additive）：`id_project_shares(project_id, org_id, user_id, permission 'read'|'write', granted_by, created_at, revoked_at, PK(project_id,user_id))`；加索引 `rt_conversations(project_id)`。light 项目 owner = `id_projects.created_by`。
- **谁能分享**：仅项目 owner（及显式持有 project 作用域 `project.manage` 者，仅管授权不读内容）；被授权者不能再授权、不能创建外部链接。选人来自 `/org/members`（本组织），写入时校验 org_id 三方一致；跨组织不可能。
- **授权后能做什么**：
  - read：看项目内全部会话（含之后新加入的）、历史/状态、SSE、handoff；经溯源读这些会话产出的文件；只读查看该会话工作区（必须带 conversationId，不开放 `shared`）。不含 legacy 项目文件/KB。
  - write（二期）：在会话中继续对话、审批、分支，并可把自己的会话移入项目。
  - 任何人不得改标题/归档/移出他人会话：仅会话所属 space 的 owner；项目 owner 可把会话"移出项目"（只改关系）。项目 owner 对已入项目的会话默认有读写权，这是"放进项目即共享"的明示契约，UI 需在移入时提示"将对 N 人可见"。
- **访问路径**：`identity.check` 的 `conversation` 分支在 spaceDecision 拒绝后，经 runtime 注册的 provider 取该会话（子任务会话沿 owner 链回溯根）的 `project_id`，再查 shares；动作映射 read→read；write→write；admin/share/delete 拒绝。列表 `rt.list` 并入"被分享的会话"。
- **撤销**：SSE 每 5 秒重查 ACL（runtime/routes.ts:128,135），撤销后最迟 5 秒收到 `forbidden` 并断流；下一次请求即 403；工具调用每次重查 conversation write（service.ts:145），已启动的 run 在下一次工具调用时失败。组织移除成员时同步 revoke（routes.ts:394）。
- **删除项目**：light 项目 = 事务内 `UPDATE rt_conversations SET project_id=NULL`（所有贡献者的行）、shares 置 `revoked_at`、项目置 `archived_at`，会话/文件一律不删，写 audit；可恢复。legacy 项目现有 DELETE 会让整个 space 从 readableSpaces 消失（等同隐藏全部会话），UI 应改称"归档"，并补"取消归档"。
- **移入/移出**：`PATCH /conversations/:spaceId/:id {projectId|null}`，要求会话 space owner 且对目标项目有写权。legacy 项目会话与 legacy 目标不可移（跨 space），UI 灰显并说明（可在 legacy 项目中新建会话，但不是移动）。
- **默认约束**：light 项目不建 space、不绑沙箱、无项目 env/凭据；页面不再显示环境变量与沙箱选择；用户/组织级 env 与凭据照旧。
- **旧项目/旧会话**：legacy 项目在侧栏同树展示（标"旧版空间"），成员/角色体系不变，rename/归档/成员管理仍走原 API。
- **迁移**：只加表/列/索引（identity 迁移 +kind 列默认 'space'，+shares 表；runtime 迁移 +索引），不改写任何旧行。回滚：忽略新表，`UPDATE rt_conversations SET project_id=NULL WHERE space_id IN (个人 space)`，`DELETE FROM id_projects WHERE kind='light'`；旧二进制下 light 项目因 `JOIN id_spaces` 不会出现在列表中（安全）。

## 4. 现有 UI 与后端能力

- 侧栏（Sidebar.tsx:84-128）："项目"是扁平链接列表，"最近对话"是 `/conversations?limit=40` 的扁平列表，对话行无菜单。项目页 ProjectPage.tsx 含：发起对话、外部只读分享（Share.tsx，仅外链）、沙箱选择、项目环境变量、成员管理、文件链接。会话菜单仅在 ChatPage.tsx:285-310：交接摘要、分享只读链接、路由记录、整理为技能；分支在消息级（fork/edit/regenerate）。
- 后端会话操作：`PATCH {title,archived,modelId,thinkingLevel}`、fork/edit/regenerate、abort、approvals、handoff、外链 `/shares`（conversation/file/project/kb/automation，只读 token，创建者失去权限即自动失效，module.ts:446-460）。**没有**：删除会话、星标/置顶/标签、导出、按项目分组接口、用户级分享。
- 需新增：`PATCH` 增加 projectId；`/projects/:id/shares`（GET/PUT/DELETE）；`GET /conversations?projectId=`（light 项目）；项目 `PATCH/DELETE` 增加 light 分支；`/projects` 返回 kind 与 permission。

## 5. 风险

1. 读授权必须同步扩展文件 `decide`、工作区路由（sandbox-routes.ts:125）、jobs（tools/module.ts）等 space 级检查，否则"能看会话看不到产物"或越权。
2. write 授权需改 `sandbox-tools.ts:27`、`files.putVersion`（service.ts:176）等调用点，使工具以"会话级授权"执行；否则协作者续聊时工具调用被拒（先只做 read）。
3. 会话级 env、transcript 中的工具输出对被授权者可见；移入项目前需提示。
4. 子任务会话与分支需沿 owner/parent 链继承；分支继承 project_id。
5. 用量 `project_id` 取自 space，light 项目用量与预算不会累计（需在导入时改取目录关系）。
6. 并发：移入/删除项目与 SSE、重名、撤销竞态；删除项目要覆盖所有贡献者的行。
7. 外链与分享表并存，UI 文案要区分"成员可见"与"外部只读链接"。

## 6. 测试计划

- 单元/集成（沿用 `startTestApp`、`identity-crosstenant` 模式）：light 项目 CRUD；移入/移出幂等与权限矩阵（owner/reader/writer/无关人）；读授权覆盖 detail/entries/state/SSE/handoff/文件/工作区；撤销后 SSE 在 ≤5s 收到 forbidden 且 `/events` 返回 403；跨组织授权被拒，并加入 cross-tenant 全路由扫描；删除项目后会话与文件仍在且回到"无项目"；组织移除成员联动撤销；legacy 项目回归（成员、space 隔离、文件、预算）；迁移与回滚测试（空库/旧库）。
- 前端：侧栏展开/折叠、移入移出、重命名、分享选人与撤销、legacy 灰显；移动端抽屉。
- 现有基线：`node --disable-warning=ExperimentalWarning --test server/test/identity*.test.ts server/test/runtime*.test.ts`。
