# 组织、模型网关、用量与自动化（工作组 E）

代码：`server/src/identity/**`（身份/组织/ACL/分享/审计/2FA/OIDC）、`server/src/ops/**`（模型网关、用量投影、预算、自动化、通知、统计、可观测性、备份）。
DTO：`shared/ops.ts`。测试：`server/test/identity*.test.ts`、`server/test/ops*.test.ts`。

运行全部 E 测试：

```bash
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/identity*.test.ts server/test/ops*.test.ts
```

---

## 1. 身份、组织与权限（M16、M09）

### 1.1 角色

| 层级 | 角色 | 能力 |
|---|---|---|
| 组织 | owner | 一切；唯一能授予/撤销 owner、变更 owner 的角色；组织至少保留 1 名有效 owner（`last_owner` 409） |
| 组织 | admin | 管理成员（member↔admin）、部门、邀请、会话、审计、模型/渠道/路由、预算、OIDC；不能动 owner |
| 组织 | member | 普通使用；`/api/org/members` 目录（只含有效成员的姓名/邮箱/角色） |
| 项目 | owner | 读/写/分享/管理成员/改名/归档；项目至少保留 1 名 owner |
| 项目 | editor | 读/写/分享（会话、文件、知识、工具、自动化在项目空间内） |
| 项目 | viewer | 只读：`write`/`share`/`admin` 一律拒绝（`role_viewer`） |

`AccessControl.check()` 每次都按**当前**状态重新解析主体（用户停用、组织成员移除/停用、会话撤销、项目成员移除），不跨请求缓存。
其他资源类型通过 `Identity.registerResolver(kind, resolver)` 接入（API 保持稳定）；空间内资源可复用 `identity.spaceDecision(principal, action, space)`。
E 自己注册了 `model`（可见性 + 组织管理）和 `automation`（负责人或空间读者可读；负责人且仍可写空间、或组织管理员可写）两个解析器。

### 1.2 成员生命周期

- **停用**（`POST /admin/members/:userId/disable`）：组织内停用（`id_org_members.disabled_at`），立即撤销该用户在本组织的全部会话；之后任何持有旧令牌的请求 → 401；登录 → 403 `no_org`；后台工作（自动化）通过 `principalFor` 重新解析为 `null` → 拒绝执行。**租户安全**：只影响本组织，不影响用户在其他组织的身份。`enable` 恢复，但旧会话保持撤销。
- **移除**（`DELETE /admin/members/:userId`）：移除组织成员关系 + 该组织内全部项目成员关系 + 部门成员关系 + 会话 + 该用户创建的分享链接。
- **邀请**：`POST /admin/invites {email?, role, departmentId?, ttlHours}`；注册时原子消费（同一邀请码只能使用一次，可限定邮箱，可撤销）；已有账号用 `POST /auth/accept-invite` 加入第二个组织，`POST /auth/switch-org` 切换（旧会话撤销）。
- **会话**：`GET /me/sessions`、`DELETE /me/sessions/:sid`、`POST /me/sessions/revoke-others`；管理员 `GET /admin/sessions?userId=`、`DELETE /admin/sessions/:sid`。改密码、启用 2FA 会撤销其他会话。会话记录 `auth_method`（password/oidc/invite）与 `last_seen_at`。
- **部门**：`/admin/departments` CRUD（防环）、`PUT /admin/departments/:id/members {userId, role: member|manager|null}`；部门 manager 可看本部门统计。

### 1.3 外部只读分享（M09-C）

与内部成员关系是**两套权限模型**：

- 分享令牌（32 字节随机，库中只存 sha256）只授予**一个资源的 read**，可设过期（1–720 小时），可撤销；**不是身份**——作为 Bearer 用于任何 API 都是 401。
- 公开入口只有 `GET /api/shared/:token`（无任何非 GET 路由）；返回元数据 + 资源所属模块注册的只读渲染（`identity.registerShareRenderer(kind, fn)`；E 内置 `project`、`automation` 摘要）。其他模块的公开预览端点用 `identity.shareGrant(token, {kind,id})` 判定。
- **每次使用都重新校验创建者**：创建者被停用/移出/失去该资源读权限（例如项目归档、项目成员移除）→ 链接永久自动撤销（`creator_lost_access`，记审计 `share.auto_revoke`）；移除成员/项目成员时还会**立即**撤销其创建的链接。
- 创建需要对资源的 `share` 权限（项目 owner/editor、个人空间所有者）。

### 1.4 审计（M16-C）

`id_audit`：`category`（auth/admin/grant/share/external_write/model/budget/automation/security）、`action`、`actor`、`target`、`detail`、`request_id`（取自核心中间件的 `x-request-id`）。
查询：`GET /admin/audit?category=&action=(支持前缀*)&actorUserId=&target=&requestId=&since=&until=&before=&limit=`；导出 `GET /admin/audit.csv`（导出本身也记审计）。
其他模块记录外部写回执等：`ctx.services.get("audit").record({orgId, actorUserId, action: "effect.receipt", ...})`（action 以 `effect.`/`external.` 开头自动归入 `external_write`）。密钥永不写入审计详情。

### 1.5 两步验证（TOTP）与企业登录（OIDC）

- TOTP：RFC 6238（SHA1/30s/6 位，±1 步时钟偏差，**同一步不可重放**）。`/me/2fa/setup|enable|disable`；登录体加 `totp`。有 `WORKROOM_SECRET_KEY` 时种子加密存储，否则明文存储（见 operations.md）。
- OIDC 依赖方（授权码 + PKCE S256 + nonce + state 一次性）：管理员 `POST /admin/oidc {name, issuer, clientId, clientSecret?, allowedDomains[], autoJoinRole}`（client secret 需 `WORKROOM_SECRET_KEY`）；登录 `GET /auth/oidc/:providerId/start?returnTo=/path` → IdP → `GET /auth/oidc/callback`。ID Token 用发现文档的 JWKS 验签（RS256/ES256，kid 轮换时刷新），校验 iss/aud/azp/exp/iat/nonce/email_verified；`(provider, sub)` 绑定用户；邮箱域白名单控制自动加入；停用成员被拒。**仅针对测试内自建 IdP 验证**（`identity-oidc.test.ts`），未接入任何真实 IdP。SAML 未实现。

---

## 2. 模型网关（M15、M14-A）

### 2.1 概念与数据

- **平台模型**（`ops_platform_models`）：用户看到/选择的模型（名称、说明、能力 text/image/tools/reasoning、思考档位、上下文窗口、可见性（部门/项目）、是否默认）。组织管理员可建本组织模型；内置模型（`org_id NULL`）由部署环境变量管理。
- **上游渠道**（`ops_channels`）：provider（`anthropic`｜`openai`｜`openai-compatible`｜`faux`(测试)｜`fixture`）、base URL、凭据、`rpmLimit`、`concurrencyLimit`、`timeoutMs`、价格覆盖（USD/百万 Token）。
- **路由**（`ops_model_routes`）：平台模型 → 渠道 + 上游模型 ID，`priority`（小者先试）、`weight`（同优先级加权随机）、可覆盖的能力声明。

### 2.2 路由在 pi-ai 内部

网关向 pi-ai `Models` 注册两个 provider：`workroom`（全部平台模型）与 `fixture`（测试模型，保持 `ref = {provider:"fixture", modelId:"workroom-fixture"}` 以兼容运行内核的 fixture 判断）。pi-durable 的每次模型请求都进入网关的 `stream` 函数：

1. 根据会话转录判断需求：含图片 → 需要 `image`；声明了工具或历史中有工具调用 → 需要 `tools`。不满足的路由跳过（记录 `capability_mismatch`）。全部不满足 → 明确报错“no available route … needs image … capability_mismatch”（M14-A：指出不可用环节）。
2. 跳过：渠道停用、无凭据（`no_credentials`）、熔断打开（连续 3 次服务端/网络/超时/过载/鉴权失败 → 30 s）、本地 RPM 超限（`local_rate_limit`）、并发满（`concurrency`）。跳过也写入尝试记录。
3. 按优先级、同级加权随机依次尝试。**只在尚未向下游输出任何内容时**、且错误可重试（429/529/5xx/超时/网络/鉴权）才切换下一路由；上下文溢出、400 类错误、已开始输出后的错误一律原样返回（溢出错误文本保持不变，pi 才能触发压缩）。
4. 多模态/工具契约：转录原样交给上游；对“同一上游产生的”历史助手消息还原上游身份（保留思考签名等原生数据），其他来源的消息按 pi-ai 的跨 provider 规则转换。
5. 最终消息：`provider/model` = 平台模型（用户看到的），`responseModel` = 实际上游 `provider/upstreamModel`（M15-A 对应关系），`usage` = **本次请求所有实际调用之和**（失败尝试上报的用量也计入，M15-C“以实际调用为准”），`timestamp/durationMs` = 整个路由请求。

每次尝试写入 `ops_route_attempts`：请求键、序号、平台模型、渠道、上游模型、状态（ok/error/aborted/skipped）、错误类别、是否可重试、是否为故障切换、延迟与首 Token 时间、Token 与费用、费用来源（`channel_price`/`catalog`/`provider`/`fixture`）、`session_id`/`space_id`/`org_id`/`conversation_id`/`task_id`。
关联方式：E 的 pi 扩展 `wr.ops` 在 `GenerationTask.beforeRequest` 钩子中读取会话的 `pi.provider` sessionId 与运行内核的 `wr.space` 文档，登记 sessionId → {space, conversation, task}；用量导入时再按 sessionId 回填。

查看：`GET /admin/route-attempts?spaceId=&conversationId=&requestKey=&status=&channelId=`；会话参与者 `GET /conversations/:spaceId/:conversationId/routes`。

### 2.3 凭据

- 存储密钥必须配置 `WORKROOM_SECRET_KEY`，否则拒绝（409 `secret_key_missing`）；AES-256-GCM 加密，只回显 `****末4位`，审计不含密钥。
- 也可引用环境变量凭据，但名称**必须以 `WORKROOM_` 开头**（防止管理员借此读取进程中的其他密钥，例如本开发环境的 `ANTHROPIC_*`）。
- 网关的 pi-ai `Models` 使用空的 auth 上下文：**从不读取环境中的 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` 等环境凭据**；无凭据的真实模型状态为 `blocked`，`statusDetail` 写明缺少什么。
- 内置渠道/模型：`claude`（`WORKROOM_ANTHROPIC_API_KEY`，可选 `WORKROOM_ANTHROPIC_BASE_URL`、`WORKROOM_ANTHROPIC_MODEL`，默认 `claude-sonnet-5-5`）、`gpt`（`WORKROOM_OPENAI_API_KEY`/`_BASE_URL`/`_MODEL`，默认 `gpt-6-sol`）、可选 `compat`（`WORKROOM_OPENAI_COMPAT_BASE_URL`/`_API_KEY`/`_MODEL`/`_LABEL`）、`workroom-fixture`（`WORKROOM_FIXTURE_MODEL` 未设为 0 时启用；状态 `fixture`，名称带“测试模型，非真实 AI”，费用恒为 0）。

### 2.4 API

`GET /models`（用户可选列表 + `defaultModelId`）；管理：`GET|POST /admin/models`、`PATCH /admin/models/:id`、`POST /admin/models/:id/routes`、`PATCH|DELETE /admin/routes/:id`、`GET|POST /admin/channels`、`PATCH /admin/channels/:id`（`apiKey: null` 清除、`apiKey` 轮换）、`POST /admin/channels/:id/test`（发一条极小的真实请求）。

---

## 3. 用量、预算与统计（M17）

### 3.1 用量投影 `usage_ledger`

pi-durable 是唯一权威（每会话 `pi.usage`，含失败与中止的尝试）。`usage_ledger` 只是**可重建的投影**：

| kind | 来源 | 主键 |
|---|---|---|
| `model_request` | 每个 `pi.assistant` 条目（每次被记录的模型请求，含失败/中止） | `(space, kind, entryId)` |
| `tool_call` | 每个 `pi.tool-result` 条目 | 同上 |
| `task` | 每个用户输入条目（`wr.input`/`pi.user`） | 同上 |
| `run` | 从输入到终态回答/失败的一次运行（以第一个助手条目为键；未产生任何助手条目就结束的运行以其输入条目为键） | 同上 |
| `adjustment` | `pi.usage` 有而条目没有的花费（例如上下文压缩请求），使投影总量 == `pi.usage` | `(space, adjustment, conversationId, "bucket:key")` |

导入是幂等 upsert：同一会话导入两次结果完全相同（测试“import twice = same totals”）。触发：网关每次请求结束标记会话为 dirty（`usage_import_state.dirty`，重启后保留），后台每 `WORKROOM_USAGE_IMPORT_MS`（默认 30 s）导入；读统计/预算检查/追踪前先导入本组织 dirty 会话。重建：`POST /admin/usage/rebuild {spaceId}`（删除该空间投影后从 pi 重新导入）；核对：`GET /admin/usage/reconcile?spaceId=`（`harness.usage()` vs 投影，及每会话核对结果）。分叉会话只计自己的条目（继承的条目属于父会话）。

### 3.2 终态口径（M17-A）

| 终态 | model_request | run / task |
|---|---|---|
| success | stopReason ∈ stop/length/toolUse | 以 stop/length 回答结束 |
| failed | stopReason = error（非超时类） | 最后一次请求失败且之后没有重试；或 pi `runFailure` 为其他原因 |
| cancelled | stopReason = aborted | 被中止（助手条目 aborted，或 `runFailure=aborted`） |
| timeout | error 且错误类别为 timeout | 末次错误为超时，或 `runFailure=turn_limit`（步数预算耗尽） |
| awaiting_approval | — | 运行中且会话 `wr.approvals` 有待审批项 |
| in_progress | — | 运行中（`pi.live.run` 存在）或输入仍在排队 |

计数分开报告：任务数、run 数、模型请求数、工具调用数（`/api/usage`、`/api/stats`）；另有路由尝试数（总数、故障切换、跳过、按错误类别）。

### 3.3 Token、路由、费用

每行带 input/output/cacheRead/cacheWrite/total Token、费用（USD，来自上游上报或目录价或渠道价格覆盖 × 实际 Token；**fixture 一律 0 并标记 `fixture`**）、平台模型、实际路由（`responseModel`）、错误类别、自动化 ID。没有任何估算的 Token 或费用。

### 3.4 统计（M17-C）

`GET /stats?scope=personal|org|project:<id>|department:<id>&from&to&largeContextTokens=`：
- 延迟分布：模型请求 `durationMs` 的 p50/p90/p99/max 与直方图（≤250ms…≤60s、>60s）。
- 大上下文：输入+缓存 Token ≥ 阈值（默认 32k）的请求数、失败数、失败率、按错误类别、**按平台模型、按实际路由、按任务阶段**（`first_turn` / `after_tools` / `automation`）。
- 错误类别分布、按日序列、按模型、按路由。
- **节省工时**：只有两种来源——用户确认的记录（`POST /usage/time-savings {minutes}` → `confirmed`），以及管理员显式配置估算基准（`PUT /admin/settings/savings {minutesPerSuccessfulTask}`）后标注为 `label:"estimate"` 的估算；默认两者都是 `null`，不编造。

权限：personal 任何成员；project 需项目 owner 或组织管理员；department 需部门 manager 或组织管理员；org 需组织管理员。`GET /usage/ledger`、`GET /usage/export.csv` 同权限，导出记审计。

### 3.5 预算（`budget` 服务 = `BudgetGate`）

`usage_budgets`：范围 org/department/project/user，周期 day/month/total（**UTC** 自然日/月），上限为费用（USD）和/或 Token，动作 `block` 或 `warn`。`checkSubmit(principal, spaceId, projectId?)` 先导入本组织 dirty 用量，再检查适用的 `block` 预算（org、本人、当前项目、本人所在部门）；超限返回原因，运行内核以 402 `budget_exceeded` 拒绝提交，自动化以 `refused: budget` 记录。fixture 用量不计入预算。管理：`/admin/budgets`；成员 `GET /budgets` 只看到适用于自己的预算；`GET /budgets/check?spaceId=` 供界面提示。

### 3.6 支付

**blocked**：没有支付渠道凭据，未实现订单/回调/入账。未建模，避免出现未验证的“支付”代码路径。

---

## 4. 自动化与通知（M12）

### 4.1 定义

`POST /automations {name, prompt, spaceId?|projectId?, trigger, timezone, condition?, destination?, maxConcurrent?, missedPolicy?, maxDurationMs?, modelId?, assistantId?}`

- `trigger`：`{kind:"cron", expr}`（croner，5/6 段）｜`{kind:"once", at}`｜`{kind:"manual"}`｜`{kind:"webhook"}`（返回一次性显示的 `webhookToken`，可轮换）。
- `timezone`：IANA 名称；下次运行与预览按该时区计算。夏令时：不存在的本地时间（春季跳变，如纽约 02:30）在当日下一个有效时刻执行一次（03:00 EDT）；重复的本地时间（秋季回拨，如 01:30）只执行一次（第一次出现）。
- `condition`：`always` 或 `previous_status`（上一次已结束运行的状态在列表中才执行，否则 `skipped`）。
- `destination`：`conversation: new|reuse`、`inApp`、`channelIds`（通知渠道）。
- 预览：`POST /automations/preview {trigger, timezone, from?, count}`、`GET /automations/:id/preview`；`nextRunAt` + 本地时间串。

### 4.2 执行与可靠性

- **授权范围**：每次触发时用 `identity.principalFor(owner, org)` 重新解析负责人，并检查对目标空间的 `write`；停用/移除 → `refused: owner_inactive`，失去项目写权限 → `refused: no_access`，均记审计 `automation.run_refused`。输入以负责人身份提交，`via = {kind:"automation", automationId, runId}`。
- **防重入**：认领一次计划运行 = 在**同一事务**中插入 `auto_runs`（`UNIQUE(automation_id, scheduled_for)`）并推进 `next_run_at`；pi 提交使用 `requestId = auto:<id>:<scheduledFor>`。因此并发 tick、重启都不会重复触发；若进程在认领后、记录提交前崩溃，重启后的恢复会用同一 requestId 重新提交，pi 去重返回同一 submission（测试覆盖）。
- **错过的运行**（停机期间）：合并为最近一次；`missedPolicy: "skip"`（默认）记一条 `skipped`（原因写明错过次数），`"run_once"` 以 `catchup` 触发执行一次。超过 5 分钟宽限的单次延迟同样视为错过。
- **并发**：`maxConcurrent`（默认 1）满时新运行 `skipped: concurrency`（策略 skip）。
- **取消** `POST /automation-runs/:runId/cancel`（撤回排队的提交或中止会话）、**超时** `maxDurationMs`（中止会话，状态 `timeout`）、**失败记录**（原因/错误）、**再次运行** `POST /automation-runs/:runId/rerun`（新运行，`rerunOf` 关联）、手动 `POST /automations/:id/run`。
- **事件触发**：`POST /api/hooks/automations/:token`，`Idempotency-Key` 相同的重复投递只触发一次。
- 调度：每 `WORKROOM_AUTOMATION_TICK_MS`（默认 15 s；0 = 关闭，测试用假时钟调用 `tick(now)`）；恢复在第一次 tick 时进行（运行内核在自己的 start 中安装扩展，之前不得打开 harness）。
- 状态：pending → running → succeeded/failed/cancelled/timeout；或 skipped/refused。

### 4.3 通知（M12-C）

- 站内：`ops_notifications`，携带任务链接（`/c/<spaceId>/<conversationId>`）、状态、引用（运行、会话、该次运行在会话中产生的文件版本）。`GET /notifications?unread=1`、`POST /notifications/:id/read`、`/read-all`。
- Webhook：真实 HTTP POST，`x-workroom-signature: sha256=HMAC(secret, "<timestamp>.<body>")`、`x-workroom-timestamp`、`idempotency-key`；失败重试（默认 1 s、5 s 后两次；4xx（除 408/429）不重试），每次尝试更新 `ops_notify_deliveries`；手动重试 `POST /notifications/deliveries/:id/retry`。出站策略（`server/src/ops/egress.ts`）：每次尝试都重新解析域名，**所有**解析结果必须被允许，然后把连接**固定到已校验的 IP**（TLS 仍按原域名校验证书），因此 DNS 重绑定无法把请求引到内网；内网/回环/链路本地/CGNAT/保留/组播地址默认拒绝，云元数据地址（169.254.169.254 等、metadata.google.internal）始终拒绝（仅实例级允许列表精确列出时例外）；不跟随重定向（3xx 记为投递失败）；策略拒绝不重试。允许列表：实例级 `WORKROOM_WEBHOOK_ALLOWLIST`（IP/CIDR/主机名，逗号分隔），组织级 `GET|PUT /admin/settings/webhook-allowlist {entries}`（管理员，记审计 `security`，只作用于本组织）。创建渠道时也做同样校验。
- 邮件：**blocked**（无 SMTP 凭据），投递记录为 `blocked` 并写明原因。
- **投递失败与任务失败分开记录**：运行状态只取决于任务本身；投递结果在 `deliveries` 中（测试：webhook 500 → 投递 failed，运行仍 succeeded）。

---

## 5. 可观测性（M18-B）

- 关联 ID：HTTP `x-request-id`（审计 `request_id`）→ 自动化运行（`request_id = auto:…`、`conversation_id`）→ 路由尝试（`request_key`、`conversation_id`、`task_id`）→ 用量行（`conversation_id`、`entry_id`、`task_id`、`automation_id`）→ 通知/投递（`run_id`）。
- `GET /admin/trace?q=<requestId|runId|automationId|requestKey|spaceId:conversationId>`：一次返回相关审计、路由尝试、用量行、自动化运行、通知（仅本组织）。
- 结构化日志（JSON 行）：`model.route_attempt`、`model.route_failed`、`automation.*`、`notify.*`、`usage.*`，字段含上述 ID。`WORKROOM_LOG=info|debug|silent`。
- 脱敏 `WORKROOM_REDACT`：`standard`（默认：API Key、Bearer、JWT、密码/密钥字段、云凭据）、`strict`（另外遮蔽邮箱、URL 查询串，丢弃 prompt/text/content 等内容字段）、`off`（仅开发）。路由错误信息、用量错误信息、投递错误在入库前同样脱敏。

---

## 6. 助手身份（M03-A）

助手身份由 A 实现（`rt_assistants`，`/api/assistants`，会话绑定在 pi 文档 `wr.assistant`）。E 提供模型清单/模型 ACL（`models.listFor`、`model` 解析器）与自动化中的 `assistantId`。见 `docs/requests/E.md` 对 A 的建议（助手默认模型按 `listFor` 校验）。

## 7. 备份与运维

见 `docs/operations.md`（在线备份/校验/恢复 CLI：`server/src/ops/backup-cli.ts`）。

## 8. 被阻塞 / 未完成

| 项 | 状态 | 缺什么 |
|---|---|---|
| 真实模型调用（Anthropic/OpenAI/兼容端点） | blocked | 产品凭据（`WORKROOM_*_API_KEY`）；本会话的开发凭据按规定不使用。路由逻辑已用 faux 渠道验证 |
| 支付（订单/回调/对账） | blocked | 支付渠道凭据；未建模 |
| 邮件通知 | blocked | SMTP 凭据 |
| 真实企业 IdP（OIDC） | partial | 仅对测试内自建 IdP 验证；SAML 未实现 |
| 多进程限流/熔断 | 未实现 | 计数在进程内（单 owner 部署） |
