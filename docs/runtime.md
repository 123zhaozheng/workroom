# 运行内核（A 组）

代码：`server/src/runtime/**`；DTO：`shared/chat.ts`；测试：`server/test/runtime*.test.ts`、`server/test/proof.test.ts`。
内核 = `@earendil-works/pi-durable` 1.5.0 的公开 API。本模块不实现自己的 agent loop、run 状态机、调度器或检查点表。

## 1. 事实归属

| 事实 | 存放 | 说明 |
|---|---|---|
| 会话、条目、分支来源、子 Agent 所有权、提交、run、插话/排队、取消、任务、检查点、用量 | 每个 space 的 `<space.dir>/durable.sqlite`（pi-durable） | 分支来源只读 `ConversationRecord.parent`，所有权只读 `.owner` |
| 审批 `wr.approvals`、外部写 `wr.effects`、委派记录 `wr.team` | pi typed documents（会话级，`fork: "initial"`） | 分支不继承未决审批、不能“复活”已执行副作用 |
| 助手绑定与成员声明快照 `wr.assistant` | pi 文档（rewindable，`fork: "asOf"`） | 分支保留分叉点时的声明 |
| 存储所属 space `wr.space` | pi 会话级 session 文档 | 工具从 `api.snapshot(SpaceDoc)` 得到 spaceId |
| 用户输入 | `wr.input` 条目（`InputEntryData`），模型仍看到普通 user message | principal 的唯一来源 |
| `rt_conversations` | app.sqlite | 只含 space_id、conversation_id、created_by、title、project_id、kind、archived、created_at、updated_at（有测试锁定列集合） |
| `rt_space_leases`、`rt_space_runtime` | app.sqlite | 租约与唤醒状态（运维元数据，不是会话事实） |
| `rt_assistants` | app.sqlite | 助手身份（M03-A），与会话/run 分离 |

每个会话创建时写入一条仅展示用的 `wr.start` 条目（不进入模型上下文），这样“编辑第一条消息”也能在它之前 fork，分支来源仍由 pi 记录。

## 2. 租约与所有权

- `HarnessManager`（`harness-manager.ts`）为每个 space 惰性打开一个 Harness：`openNodeSqliteStorage(<space.dir>/durable.sqlite)`。没有全局共享 root。
- 打开前在 app.sqlite 中 `BEGIN IMMEDIATE` 获取 `rt_space_leases`（space_id, owner=`config.instanceId`, heartbeat_at, expires_at）。行属于别的实例且未过期 → 拒绝打开（HTTP 503 `space_busy`）。同一 instanceId 重启可立即收回自己的租约。
- 心跳：每 `ttl/3` 续期（`WORKROOM_LEASE_TTL_MS`，默认 30 s）。续期失败（行被别的实例接管）→ 立即关闭该 Harness，且在对方持有期间不再打开。
- 写前校验：Storage 通过其公开接口包一层 Proxy，每次 `commit`/`mintId` 先检查内存中的租约到期时间；过期则抛 `LeaseLost` → 按 pi 规则该 Harness 失败，不会写入。之后 `harness.closed`（failed）触发重开：重新获取租约成功才打开。
- 正常停止：`stop()` 关闭所有 Harness（工作保持 pending），然后释放租约。
- 已知限制：租约不是严格 fencing token。若进程挂起超过 TTL 后恢复，在下一次心跳/写前检查之前可能有极短重叠窗口；TTL（30 s）远大于提交间隔以降低风险。首期部署 = 单 owner 进程；多 worker 按 spaceId 路由到租约持有者尚未实现。

## 3. 恢复流程

1. `HarnessOptions.onWake` → `rt_space_runtime(space_id, wake_active, wake_at)`。由于提供了 `onWake`，pi 不再自己为 sleep 设定时器，由本模块为 `wake.at` 设定时器并 `resume()`。
2. 模块 `start()`：先把所有模块的 `extensions(ctx)`（含本模块的 `wr-team`）装入共享 registry，再打开所有 `wake_active=1` 或 `wake_at` 已到期的 space 并 `resume()`；未来的 `wake_at` 设定时器。浏览器、SSE 都不参与。
3. pi 恢复语义：进程死于模型请求中 → 该次请求计为失败尝试并按 `settings.retry` 重试（`WORKROOM_RT_RETRY_*`）；关闭（close）不是崩溃，请求会重发；工具调用只有 `replay: "safe"` 的会重跑，否则模型得到 `interrupted` 错误结果。
4. 同一 `requestId` 重提交返回同一 submission，不新增条目（pi 按会话去重）。

## 4. API 与 DTO（给 B）

全部在 `/api` 下，DTO 见 `shared/chat.ts`。每个路由对 (spaceId, conversation) 做 ACL：GET/SSE 用 read，修改用 write；先 ACL 后存在性，无权用户只得到 403。

| 路由 | 说明 |
|---|---|
| `GET /conversations?spaceId=&projectId=&q=&limit=&archived=1` | `{conversations: ConversationSummary[]}`，默认跨所有可读 space |
| `POST /conversations {spaceId?, projectId?, title?, modelId?, assistantId?}` | `{conversation, agent}`；默认个人 space；默认模型来自 E 的 gateway，否则 fixture |
| `GET /conversations/:spaceId/:id` | `ConversationDetailResponse`（parent、branches、agent） |
| `PATCH /conversations/:spaceId/:id {title?, archived?}` | |
| `GET .../entries?before=&limit=` | `EntriesPage`（升序；`next` 传回 `before`）。`pi.system` 不返回 |
| `GET .../events` (SSE) | `snapshot` → `state`（节流，默认 100 ms，完整 `ConversationState`）、`ping`（15 s）、`error`（`forbidden` / `runtime_closed`，随后关闭）。断开只停止 watch。每 5 s 重查 ACL |
| `GET .../state` | 与 SSE snapshot 同形的一次性状态 |
| `POST .../messages {text, requestId, attachments?, knowledgeRefs?, mode?}` | `{submissionId, status, submission}`；mode `auto`（=忙时插话）/`steer`/`followUp` |
| `GET .../submissions/:sid` | `SubmissionDTO`：`received`(插话已接收待应用) / `queued`(排队等本轮结束) / `applied` / `done` / `unanswered`(+reason) / `withdrawn` |
| `POST .../submissions/:sid/withdraw` | 撤回尚未应用的提交 |
| `POST .../fork {entryId, title?}` | 新分支（kind `branch`），原会话不变 |
| `POST .../edit {entryId, text, requestId}` | 在被编辑的用户消息之前 fork，再提交新文本 → `{conversation, submissionId}` |
| `POST .../regenerate {entryId}` | 在该轮用户输入处 fork 再 `continue` → `{conversation, submissionId}` |
| `POST .../abort {background?}` | 停止；`background: true` 也停后台子任务 |
| `POST .../continue {requestId?}` | 失败/中断后无新消息继续 |
| `POST .../approvals/:approvalId {decision, note?}` | 409 已处理；`approverUserIds` 限定审批人；子 Agent 的审批也可在父会话上处理 |
| `POST .../effects/:effectId/reconcile {outcome: done\|failed, receipt?, note?}` | 人工核对 `needs_reconciliation` |
| `GET .../tasks` | `TasksResponse`：该会话子树的 pi 任务图 + 委派（SubagentDTO） |
| `GET/POST /assistants`，`GET/PATCH/DELETE /assistants/:id` | 助手身份（M03-A）；`scope: org` 需组织管理员 |

`RunStatus`（独立终态，M02-C）：`idle`、`running`、`waiting_approval`（等待用户）、`done`（成功）、`aborted`（取消）、`timeout`（`turn_limit` 或模型超时）、`failed`、`interrupted`（崩溃重试耗尽）。来源：`pi.live.run` / `runFailure` + 未决审批。

Fixture 模型（`provider: "fixture"`, `modelId: "workroom-fixture"`）：`AgentDTO.fixture`、`AssistantEntryDTO.fixture`、`UsageDTO.fixture` 为 true，回答以“【测试模型·非真实AI】”开头。UI 必须标注“测试模型，非真实 AI”。

## 5. 工具身份与副作用契约（给 C / D / E）

- `runtime.actorForTool(api, spaceId | "", ctx)`：spaceId 传 `""` 时从 `wr.space` 文档解析。principal 来源：当前 run 的第一个已放置输入（`pi.live.run.inputs` → submission → `wr.input` 数据）；否则最新 `wr.input`；子 Agent 会话沿 `owner` 链向上。然后 `identity.principalFor` + **当前** ACL（write on conversation）重查：撤权在 run 中途立即生效，分支不会复活权限。失败抛 `HttpError(403)` → 工具得到错误结果。
- 额外（被 C/D 鸭子类型调用）：`actorForToolCall(api, ctx)` → `ToolActor & { input?: InputEntryData }`（含 run 输入的附件/知识引用）；`inputForTool(api, ctx)`；`spaceIdForTool(api, ctx)`；`promptScope(input, ctx)` → `{space, principal|null}`（null = 已撤权/无权，节不应渲染与用户相关的内容）；`reinstallExtension(ext)`。
- 子 Agent 的成员声明快照在子会话 `wr.assistant.member`（含 `knowledgeScope.kbIds`），C 的检索可据此收窄范围。
- `effects.requestApproval(api, request, ctx)`：approvalId = hash(conversationId, callId)，存 `wr.approvals`；replay-safe 工具重跑会重新挂到同一审批；等待用文档 watch；进程重启后仍在。
- `effects.externalEffect(api, {key, target, summary, idempotencyKey?}, perform, ctx)`：effectId = hash(conversationId, callId, key)。`perform` 之前提交 `dispatching`，之后提交回执。重放：有回执 → `{status:"done", replayed:true}`，不调用 perform；`dispatching` 无回执 → `needs_reconciliation`，不调用 perform。`perform` 抛 `EffectRejected`（从 `runtime/effects.ts` 导出）表示目标明确拒绝 → 记录 `failed` 并重抛；其他异常 = 结果未知 → `needs_reconciliation`。工具必须声明 `replay: "safe"`。

## 6. 子 Agent / 小队（M03）

`delegate` 工具（扩展 `wr-team`），成员来自会话的 `wr.assistant.members`，无助手时用内置成员（researcher、writer）。

- 成员类型（M03-C，不混为同一种聊天角色）：`builtin_subagent` = pi 任务拥有的子会话；`external_tool` = 通过连接器调用的工具服务，`delegate` 拒绝把它当对话角色；`third_party_agent` = 需连接器 `use` 权限 + 显式高风险审批才可能发送，本部署无第三方连接器 → `blocked`。
- 子会话用 `configure` 设置：model / thinkingLevel / **显式 tools 白名单**（`[]` = 无工具；永远去掉 `delegate`）/ instructions / maxTurns。子会话不会继承父会话的工具。预算（maxTokens / maxCostUsd）通过观察子会话 `pi.usage` 执行，超出则中止并报告。
- foreground：工具调用的任务拥有子会话；等待并返回答案；失败时返回原因（如 `turn_limit`）和已完成部分。
- background：后台 anchor 任务（`background: true`）拥有子会话；后台 reporter 任务投递任务并把结果作为 follow-up（`wr.input`，`via.kind = subagent_report`）回报父会话。父会话 abort、浏览器关闭都不影响；`abort {background:true}` 才会停止。
- 委派记录 `wr.team.delegations`：来源（父会话、callId、taskId）、负责人（ownerUserId）、状态、结果摘要、失败原因、用量（M03-B）。

## 7. 哪些工具可安全重放（replay: "safe"）及理由

| 工具 | 理由 |
|---|---|
| `delegate`（foreground） | 子会话通过所有权索引 `scanConversations({ownerTaskId})` 找回；子输入 requestId = `delegate:<taskId>` → 同一 submission；委派记录在创建子会话的同一原子 commit 中写入。重跑不会产生第二个子会话或第二次输入。 |
| `delegate`（background） | anchor、子会话、reporter、委派记录在同一个 commit 中创建，且 commit 先检查 `delegationId = hash(conversationId, callId)` 是否已存在：要么全部存在，要么全部不存在。reporter 的投递/回报分别使用 requestId `delegate:<reporterId>`、`delegate-report:<reporterId>`，阶段之间有检查点。 |
| `wr_fixture_echo`（仅测试） | 只读：重查 ACL 并回显参数，无外部状态。 |
| `wr_fixture_wait`（仅测试） | 只等待，无副作用。 |
| `wr_fixture_effect`（仅测试） | 全部副作用经过 `externalEffect`：回执存在 → 返回 replayed；dispatching → needs_reconciliation；不会盲目重做。 |
| `wr_fixture_approval`（仅测试） | 审批 id 由 (conversationId, callId) 决定，重跑挂回同一审批，不会重复询问。 |

其他组的工具（D 的 `file_*`、MCP、sandbox；C 的 `kb_search`、`memory_save`）由各组声明并论证其 replay 策略（见各自文档）；它们的外部写必须走 `effects`。测试工具只有在 `WORKROOM_FIXTURE_TOOLS=1` 时安装。

## 8. 分支不会回滚什么

Fork / 编辑 / 再生成只是在 pi 中新建一个从某条目开始的会话视图。它**不会**撤销或复制：

- 已生成的文件及其版本（D 的文件库、blobs）；
- 已发出的邮件、MCP 外部写、任何业务系统写入（`wr.effects` 在分支中为空，分支也无法“重放”原会话的副作用）；
- 记忆、知识库修改、自动化定义；
- 原会话中已决的审批（分支从空审批开始）、原会话启动的后台子任务（它们继续属于原会话）；
- 用量与费用（已发生的调用照常计费）；
- ACL：分支按**当前**权限执行，被移除的成员在分支中同样无权。

## 9. 已知限制

- 无凭据时真实模型为 blocked；fixture 只验证契约，不代表模型质量。
- Harness 打开后常驻，未做空闲回收（每个活跃 space 一个 SQLite 连接）。
- SSE 每次发送完整状态（窗口最多 100 条），未做增量 ops；大会话用 `/entries` 分页。
- `GET /conversations` 的 `status`/`parent` 仅在该 space 已打开时填充（不为列表打开所有 space）。
- 插话在工具等待审批期间保持 `received`，直到该工具轮结束才会应用（pi 的边界语义）；不像参考产品那样打断挂起的审批。
- 第三方 Agent 连接器未接入（blocked）；外部工具服务只能作为工具调用。
- 子 Agent 的预算在子会话运行时轮询检查（300 ms），可能略微超出上限一个请求。
- 多 worker 路由未实现；租约非严格 fencing（见 §2）。

## 10. 测试

```
node --disable-warning=ExperimentalWarning --test server/test/runtime.test.ts        # 11
node --disable-warning=ExperimentalWarning --test server/test/runtime-lease.test.ts  # 5
node --disable-warning=ExperimentalWarning --test server/test/runtime-team.test.ts   # 4
node --disable-warning=ExperimentalWarning --test server/test/proof.test.ts          # 3（含子进程 SIGKILL）
```

测试用环境变量：`WORKROOM_FIXTURE_TOOLS=1`、`WORKROOM_RT_RETRY_BASE_MS`、`WORKROOM_RT_RETRY_MAX`、`WORKROOM_SSE_THROTTLE_MS`、`WORKROOM_SSE_ACL_RECHECK_MS`、`WORKROOM_LEASE_TTL_MS`。测试辅助（SSE 读取器、waitFor）在 `server/src/runtime/testing.ts`，其他组可直接引用。

Fixture 指令协议（最新用户消息中）：`[[call <tool> <json>]]`（可多个，同一轮发出）、`[[slow <ms>]]`、`[[fail]]`、`[[reply <text>]]`。工具结果返回后，fixture 回答一段逐条引用工具输出的确定性总结。无指令时：提到“知识/资料”且有 `kb_search` → 调用它；提到“生成/报告/文档”且有文件创建工具 → 调用它；否则回显。E 的模型网关通过 `createFixtureModel()`（`server/src/runtime/fixture-model.ts`）注册同一 provider。
