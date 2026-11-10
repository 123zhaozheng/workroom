# react-pi 事件映射对比（第 5 轮，UI 组 2）

被评估对象：`@assistant-ui/react-pi` 0.0.33（assistant-ui 仓库 `packages/react-pi`，MIT，2026-11-09 仍在提交）。
我们的内核：`@earendil-works/pi-durable` 1.5.0 + `shared/chat.ts`（`ConversationState` 经 SSE 全量推送）。
结论先行：**两者都叫 “pi”，但不是同一个运行时。react-pi 驱动的是 pi 的 `AgentSession`（`@earendil-works/pi-coding-agent`，单进程内存会话 + .jsonl 文件）；我们用的是 pi-durable（持久化会话 / 提交 / 任务 / 类型化文档）。适配器技术上可写，但会丢掉我们 UI 需要的大部分信息，本轮不采用，不引入依赖，不替换现有适配。**

## 1. 契约形态

| | react-pi | Workroom |
|---|---|---|
| 传输 | `PiClient`（`getThread` 快照 + `subscribe` 事件流，HTTP/SSE 或进程内） | `GET …/events`（SSE）：`snapshot` / `state` 每次都是**完整** `ConversationState`（节流 100 ms） |
| 增量 | 细粒度事件 `message_update`（含 `assistantMessageEvent` 的 text/thinking/toolcall delta）、`tool_execution_*`、`queue_update`… | 无增量；`live.partial` 是当前流式回复的整体快照，`live.tools[]` 是工具当前状态 |
| 排序/去重 | 事件带 `{threadId, seq}`，快照带 `seq` | `revision` 单调递增，快照整体替换，重连即得全量，无需补事件 |
| id | 字符串（thread、entry、queue item） | 数字（conversation / entry / task / submission），会话以 `(spaceId, conversationId)` 定位 |
| 运行时依赖 | `@assistant-ui/react ^0.15`、`@assistant-ui/core/store`、`assistant-stream`、`assistant-cloud`；node 入口另需 `pi-coding-agent` | 自有 `useConversationStream`（≈100 行），无新增依赖 |

## 2. 概念逐项映射

| 概念 | react-pi（AgentSession） | Workroom（pi-durable） | 可映射性 |
|---|---|---|---|
| 消息/条目 | `PiAgentMessage[]`（user / assistant / toolResult / bashExecution / custom / branchSummary / compactionSummary） | `EntryDTO`：`user`（`wr.input`，含 principal、附件、知识引用、`submission`）/ `assistant` / `tool_result` / 标记（start、reset、compaction、notice）/ other | 角色可 1:1 映射；我们多出 principal、`displayText`、`submission`，react-pi 没有对应位置 |
| 流式回复 | `message_start/update/end` + delta（`partial` 为当前消息） | `live.partial {text, thinking, toolCalls}` | 只能把 `live.partial` 的前后差分**合成** delta；颗粒度由 100 ms 节流决定 |
| 思考 | `thinking` 内容块（可 redacted） | `thinking` 字符串 | 可映射（丢 redacted 标记，我们本就不返回） |
| 工具调用 | `toolCall` 块 + `tool_execution_start/update/end`（`partialResult`） | `toolCalls[]` + `tool_result` 条目 + `live.tools[] {status pending/running/done, output, details, taskId, childConversationId}` | 可映射；`details`（文件版本引用、引用来源、浏览结果）两边都是自由结构 |
| 审批 | **pi 无内建审批**；唯一入口是扩展的 `ExtensionUIContext.confirm/select/input/editor`：请求只有 `title` + `message`（+ 可选 `toolCallId`，仅在“同时只有一个工具在执行”时才由 supervisor 补上），回答只有 `confirmed:boolean`（取消=拒绝） | `wr.approvals` 类型化文档：`approvalId`、`toolName`、`title`、`summary`（将发生什么）、`detail`、`risk low/medium/high`、`requestedFor`、`approverUserIds`、状态/决定人/时间/`note`；`POST …/approvals/:id {decision, note}`；子 Agent 的审批可在父会话处理；有审计 | **单向有损**：我们 → react-pi 只剩 title+message+布尔；风险、审批人、备注、子 Agent 审批全部丢失。react-pi → 我们不可能凭空得到风险等级，也就无法满足“高风险需二次确认” |
| 外部写/待核对 | 无 | `wr.effects`：intent → dispatching → done / failed / `needs_reconciliation`，`POST …/reconcile` | **无对应** |
| 插话/排队 | `sendMessage({streamingBehavior: steer｜followUp})`、`queue_update {steering[], followUp[]}`、`clearQueue()`（只能整体清空） | `POST …/messages {mode: auto｜steer｜followUp}`，`SubmissionDTO` 状态 received / queued / applied / done / unanswered(+reason) / withdrawn；`queue[]` 带 submissionId；可单条 `withdraw` | react-pi 没有逐条状态与逐条撤回；我们的“反馈芯片”无法从它的事件还原 |
| 运行状态 | `PiThreadStatus: idle｜running｜failed` + `compactionActive`、`retryActive/retryAttempt` | `RunStatus`：idle / running / waiting_approval / done / aborted / timeout / failed / interrupted + `failure.reason/detail` + `retry` | 我们更细；react-pi 的 failed 无法区分取消 / 超时 / 轮数上限 / 中断 |
| 失败恢复 | `agent_end.willRetry`、`auto_retry_start/end` | pi 持久退避重试 + `POST …/continue`，崩溃后由租约与唤醒定时器恢复，浏览器不参与 | 概念相近；`continue` 在 react-pi 中无对应 |
| 分支 | 会话文件谱系 `parentSessionPath`；`branchSummary` 消息；**react-pi 本身不暴露“编辑/重新生成产生的兄弟分支”**，assistant-ui 的 `BranchPicker` 依赖 `ExportedMessageRepository` 的 parentId 树，react-pi 只投影线性转录 | 每个分支是独立会话（kind `branch`），`ConversationRecord.parent {conversationId, entryId}`；`fork` / `edit` / `regenerate` 路由；UI 在分叉点显示 ‹ i/n › 并**切换会话** | **不兼容**：我们的“分支 = 另一个会话”，assistant-ui 的 BranchPicker 期望同一线程内的消息树 |
| 子 Agent | 无 | `delegate` 工具 + pi 任务图（`owner`）+ `wr.team` 委派记录（成员、负责人、用量、失败原因）；`GET …/tasks` | **无对应** |
| 模型/思考档位 | `setModel / setThinkingLevel`、`getAvailableModels`、`PiRuntimeReadiness` | `PATCH {modelId, thinkingLevel}` + 网关目录/可用性、测试模型标注 | 形态不同，且我们的目录来自模型网关 |
| 用量 | `PiUsage`（含成本）、`context_usage` | `UsageDTO`（`simulated` 标注，测试模型不展示真实 token） | 需要自行处理 simulated，react-pi 无此概念 |
| 持久性 | 进程内 supervisor 单例，`.jsonl` 会话文件 | 每 space 一个 `durable.sqlite`，租约、检查点、崩溃后恢复 | 不同的耐久模型 |
| 多用户/权限 | 无（单用户本地） | space/项目 ACL、principal 逐次重查、审批人限制 | 无对应 |

## 3. 适配器是否可行

可以写一个 **`PiClient` 门面**：`getThread` = `GET /state` 转成 `PiThreadSnapshot`，`subscribe` = 订阅我们的 SSE 并对前后两个 `ConversationState` 做差分，合成 `message_update` / `tool_execution_*` / `queue_update`；`respondToHostUiRequest` 把布尔映射到 `approvals/:id`。但：

1. **审批信息被压成 title+message+布尔**，违背“风险等级、范围、请求人、高风险二次确认、备注”的需求；待核对（effects）、子 Agent、提交状态、`withdraw`、`continue`、分支会话切换都没有承载位置，仍要旁路传递，等于另起一套状态。
2. **差分合成事件是有损且易错的**（节流后的整体快照无法还原真实 delta；断线重连时要伪造 `seq`）。
3. **依赖面大**：`@assistant-ui/react`、`core`、`store`、`assistant-stream`、`assistant-cloud`，以及它们的 UI 原语，会与现有 Tailwind v4 + 自有组件（`design-guidelines.md`）并行存在；react-pi 版本 0.0.x，包的 peer 依赖指向另一个 pi 包。
4. 收益有限：我们已有同等功能的流式、工具、插话、分支 UI，且与产品语义（提交状态、审批、核对）一致。

**结论：不可行到值得采用的程度。** 现有 `ConversationState` → `buildTurns` 的适配保持不变；react-pi 只作为模式参考（见 `research-notes/round5-g2.md`）。若将来 pi-durable 暴露官方的 AgentSession 兼容事件流，或 react-pi 增加可插拔的“审批/任务/分支”扩展点，再重新评估。

## 4. 从 react-pi 学到、已在本轮采用的模式
- 工具调用与其审批**按 `toolCallId` 关联**，在该工具行上投影 `approval`（我们用 `ApprovalDTO.callId`，步骤行显示“待确认 / 已允许 / 已拒绝”）。
- 工具运行中的 `partialResult` 标记为“进行中”（我们的 `live.tools[].output` 仍放在“技术详情”里）。
- 把一轮里“助手消息 + 工具结果”合并成一个带步骤的助手消息（我们的 `buildTurns` 早已如此）。
