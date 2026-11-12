# Harness 检视（Harness inspector）

管理员的调试功能：对任意一条助手回复，查看 agent 循环**每一轮**发给大模型的真实请求。默认关闭，按组织开关。

## 开关与权限

- 开关：`ops_settings` 键 `harness_inspect`（值 `on`；缺省即关闭）。后台入口：组织管理 → 审计 → **Harness 检视**（`data-testid="admin-harness-inspect-switch"`）。
- 修改开关：`org.security.manage`（高危）。变更写入审计（`settings.harness_inspect`，类别 security）。**关闭会立即删除该组织已保存的全部记录。**
- 查看记录：新增权限 `harness.inspect`（审计组，高危，仅组织范围；所有者/管理员默认拥有，自定义角色可授予）**并且**对该对话有读取权限。
- 关闭状态：不采集；`GET .../harness/rounds` 返回 `{enabled:false, rounds:[], builds:[]}`；单轮详情 404；聊天界面不渲染 Bug 按钮。

## 采集点

`server/src/ops/gateway.ts` 的 `#runAttempts`：每个模型请求（含工具轮次、子 Agent、压缩摘要）经网关路由前，把**最终 transcript**交给 `HarnessInspect.begin()`（`server/src/ops/harness-inspect.ts`）。此处已是 pi-durable 钩子处理后、provider 收到的内容，因此：

- 系统提示词 = `getCurrentSystemPrompt(messages)`（基础提示 + 各扩展提示片段 + 助手指令）；片段名与字数单独列出；
- 工具 = `getCurrentTools(messages)`（名称、描述、JSON Schema）；
- 消息 = 首条系统消息之后的完整有序列表（用户 / 助手含思考与工具调用 / 工具结果；中途系统消息原样标出；图片只留 mime 与大小）；
- 请求选项为白名单（`reasoning`、`temperature`、`maxTokens`、`toolChoice`、`thinkingBudgets` 等及非 `wr*` 的 metadata）。读取的是 context 对象，**从不读取** `apiKey` / `headers` / `env` / `fetch`；文本再经 `redactText`（标准脱敏）掩码疑似密钥。
- 完成后补记：停止原因、用量、耗时、实际应答的模型（发生回退时）、错误。

采集在 `setImmediate` 中进行并整体 try/catch，不阻塞、不影响运行。回退模型的内部调用（`wrNoRecord`）不重复记录。

**轮次与运行**：每个模型请求是一个独立的 generation task，因此“同一次运行”按 transcript 判定——最新消息是用户消息则开始新运行（第 1 轮），以工具结果结尾则延续该会话上一次运行（轮次 +1）。`runId` 相同的轮次属于同一次运行。助手消息本身没有稳定 ID：每轮记录 `messageTimestamp`（= 该助手消息条目的 `timestamp`），界面按“用户消息发送时间 ~ 本回复最后一条助手消息时间”匹配。子 Agent 的请求记在它自己的（子）会话 id 下。

## Harness 构建摘要

每次运行的第一轮请求时，`HarnessInspect` 通过 `Runtime.describeHarness`（`server/src/runtime/service.ts`，由 runtime 模块注入）读取该会话已解析的 agent，保存到 `ops_harness_builds`：模型与思考强度、`maxTurns`、`cwd`、助手指令与助手、提示片段（key → 来源扩展）、扩展及其工具（内置 / MCP（`mcp__*`）/ 技能 / 内核 / 测试）、按需加载工具、执行环境（沙箱 `promptInfo` 的结果）。只记录代码里真实存在的信息。

## 存储与保留

迁移 `ops` v4：`ops_harness_rounds`（元数据列 + `payload` JSON）、`ops_harness_builds`。

- 每个会话最多 200 轮（`WORKROOM_HARNESS_INSPECT_MAX_ROUNDS`），超出删除最旧；
- 每条记录序列化后 ≤ 1.5 MB（`WORKROOM_HARNESS_INSPECT_MAX_BYTES`）：先按字符串截断（100k → 20k → 4k → 800 字符，标记 `…[已截断：原长 N 字符]`），仍超出则保留首 4 条与末 8 条消息、中间以“省略 N 条”占位，记录 `truncated=1`；
- 超过 14 天（`WORKROOM_HARNESS_INSPECT_RETENTION_DAYS`）的记录定期清理（每 50 次写入一次）。

## API

均在 `/api` 下，DTO 见 `shared/harness-inspect.ts`。

- `GET /harness-inspect/status` → `{enabled, canInspect, canManage, retentionDays, maxRoundsPerConversation}`（任意成员；前端据此决定是否显示入口）。
- `PUT /admin/settings/harness-inspect {enabled:boolean}` → 同上状态；需 `org.security.manage`。
- `GET /conversations/:spaceId/:id/harness/rounds?from=&to=&limit=` → `{enabled, rounds: HarnessRoundSummaryDTO[], builds: HarnessBuildDTO[]}`；`from`/`to` 为毫秒时间窗（按请求开始时间）。
- `GET /conversations/:spaceId/:id/harness/rounds/:roundId` → `{round: HarnessRoundDetailDTO}`。

校验顺序：`harness.inspect`（403）→ 开关 → 当前用户对该会话的读权限（`Runtime.access`，同时保证组织隔离）；查询条件始终带 `org_id`。

## 前端

- 回复操作栏的 Bug 按钮：`data-testid="action-inspect"`，`aria-label="Harness 检视"`（`web/src/features/inspect/InspectButton.tsx`）。仅当开关开启且有权限时渲染；出错而无答复的回复也会显示。
- 抽屉：`data-testid="harness-inspect-drawer"`；左侧轮次列表（`inspect-round`）与“Harness 构建”（`inspect-build-tab`）；右侧可折叠的 系统提示词 / 工具 / 消息 / 请求参数与用量；`inspect-copy-json` 复制该轮完整 JSON。
