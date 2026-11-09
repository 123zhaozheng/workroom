# Workroom 架构（冻结版 v1，2026-11-09）

工作名 Workroom，品牌可配置（`WORKROOM_BRAND_NAME` / `WORKROOM_BRAND_TAGLINE`）。浏览器内使用的通用工作 Agent。
本文件是各工作组的共同约束；修改需经过集成者（主 Claude）。

## 1. 运行内核：@earendil-works/pi-durable 1.5.0（精确锁定）

| 包 | 版本 | 说明 |
|---|---|---|
| `@earendil-works/pi-durable` | 1.5.0 | 运行内核（Harness / Conversation / Entry / Submission / Task / Document / Extension） |
| `@earendil-works/chord` | 1.5.0 | Context、watch |
| `@earendil-works/pi-ai` | 1.5.0 | 模型访问（providers、faux 测试 provider） |
| `@earendil-works/pi-schema` | 1.5.0 | 工具参数 JSON Schema |
| `@earendil-works/pi-codemode` | 1.5.0 | QuickJS 沙箱（codemode） |

- 核对来源：npm `latest` = 1.5.0（2026-11-02 发布）；官方仓库 tag `v1.5.0` = `f9a26365568127461c47a07a37dcb42c140a3ac5`；README 与 `dist/*.d.ts` 已逐项核对。`fork(at: EntryId, options: ConversationCreateOptions, context)` 存在于 1.5.0 的 `Conversation` 接口。
- API 标注 Experimental。**迁移策略**：依赖用 `--save-exact` 锁定；所有 pi-durable 调用集中在 `server/src/runtime/`（以及各模块的 `extension.ts` 中 `defineTool/defineDoc/defineExtension` 调用）；升级流程 = 读 CHANGELOG Breaking Changes → 在分支升级 → 跑 `npm test`（含纵向证明与恢复测试）→ 用旧数据目录副本做 reopen 测试 → 再合入。不 fork 内核、不改其内部表、只用公开 Storage/commit 接口。
- 已知 main 分支 Unreleased 变更（`Tx.submission(id)`、per-conversation compaction 设置）**不使用**，直到正式发布并升级。

## 2. 进程与存储

```
浏览器 (React SPA)  ──HTTP/SSE──▶  Node 22 服务 (Hono, 单进程 owner)
                                     ├─ app.sqlite（身份/ACL/目录/文件版本/知识索引/自动化/用量投影）
                                     ├─ blobs/（sha256 内容寻址，不可变）
                                     └─ orgs/<orgId>/spaces/<spaceId>/
                                           ├─ durable.sqlite   ← 该 space 唯一的 pi-durable storage
                                           └─ sandbox/          ← 该 space 的执行目录
```

- **数据卷**：`WORKROOM_DATA_DIR`（默认 `./data`）。全部持久状态都在其下；备份 = 停服后复制目录，或 SQLite online backup（见 `docs/operations.md`）。
- **隔离单位 = space**：每个用户在每个组织有一个 personal space；每个项目是一个 project space。每个 space 一个独立 `durable.sqlite`，没有全局 root 被所有用户复用。会话、分支、子 Agent 都在其 space 的 storage 内。
- **单 owner**：一个进程通过 `rt_space_leases`（app.sqlite 内 `BEGIN IMMEDIATE` 获取，带心跳与过期）持有某 space 的 Harness；拿不到租约的进程拒绝打开该 storage。租约丢失时立即关闭 Harness。首期部署 = 单 owner 进程；多 worker 时按 spaceId 路由到租约持有者（未实现，标记为后续）。已知限制：租约不是严格 fencing token，进程长时间挂起后恢复可能短暂重叠 —— 通过“写前校验租约 + 心跳超时远大于提交间隔”降低风险，记录在 `docs/operations.md`。
- **恢复**：`rt_space_runtime` 记录每个 space 的 `wake_active / wake_at`（由 `HarnessOptions.onWake` 更新）。启动时打开所有 `wake_active=1` 或 `wake_at` 已到期的 space 并 `resume()`；定时器处理未来的 sleep。浏览器断开只停止 watch 订阅，不影响任务。
- 不使用 `MemoryStorage`（仅测试单元可用）或浏览器 localStorage 作为持久化。

## 3. 事实归属（防止两套状态漂移）

| 事实 | 唯一权威 | 应用库中允许的内容 |
|---|---|---|
| 会话、条目、分支来源（`ConversationRecord.parent`）、子 Agent 所有权（`owner`） | pi-durable | `rt_conversations`：目录/ACL 行（space、创建者、标题、项目、kind、archived），**不存 parent/owner/run 状态** |
| 提交、run、排队/插话、取消、任务状态、检查点、用量（`pi.usage`） | pi-durable | 用量投影 `usage_ledger`（按 pi entry/提交幂等键导入，可从 pi 重建） |
| 审批、外部写意图与回执、子任务成员声明 | pi-durable typed documents（`wr.*`） | 无 |
| 身份、组织、项目成员、部门、会话令牌 | app.sqlite | — |
| 文件与不可变版本、来源 | app.sqlite + blobs | 版本行引用 pi 的 conversation/task/callId |
| 知识库、文档处理状态、分片索引 | app.sqlite（FTS5 trigram） | — |
| 自动化定义与触发记录 | app.sqlite | 每次触发以 `requestId = auto:<id>:<scheduledFor>` 提交到 pi（pi 去重） |

## 4. pi-durable 用法约定

- 用户输入：`conversation.submit({ type: "input", content, requestId, whenBusy, entry: { kind: "wr.input", data: InputEntryData } })`。`requestId` 由客户端生成（UUID），重试同 id 不重复提交。
- 分支：`conversation.fork(entryId, { ownership: { kind: "ownerless" }, init }, ctx)`；编辑重试 = 从被编辑消息的前一条 entry fork 再提交新输入；再生成 = 从该轮用户输入 entry fork 后 `submit({type:"continue"})`。原会话不被修改。分支在目录中登记 kind=`branch`，来源从 pi 记录读取。
- 自定义文档：`defineDoc` 的 `fork` 选项按语义选：审批/外部写回执 `fork: "initial"`（分支不继承未决审批，也不能“复活”已执行副作用）；成员声明可 `"asOf"`。
- 子 Agent：任务拥有的 conversation（`ownership: { kind: "task", taskId }`），用 `configure` 收窄 model/thinking/tools/extensions；后台成员用 `{ background: true }` 锚点任务。
- 工具 ACL：每次工具调用通过 `runtime.actorForTool()` 从 run 的 `wr.input` 解析 principal，并按**当前** ACL 重新校验（撤权立即生效，分支不能复活权限）。
- 外部写：工具 `replay: "safe"` + 自己的 effect 文档：`intent → dispatching → receipt`；重放时若处于 `dispatching` 且无回执 → 进入 `needs_reconciliation`，不盲重做。

## 5. 目录结构与 owner

见 `docs/ownership.md`。前端 `web/`（React + TS + Vite + Tailwind v4 + 本地 shadcn 风格组件 + lucide），后端 `server/`（Node 22 原生 TS 类型擦除，无构建步骤；Hono；node:sqlite）。

## 6. 模型与凭据

- 真实 provider（Anthropic/OpenAI/兼容端点）通过 pi-ai，凭据只在服务端（环境变量或管理员配置，加密存储于 app.sqlite，密钥 `WORKROOM_SECRET_KEY`）。
- 无凭据时：真实模型显示 `blocked`。为可重复测试与演示提供 **Fixture 模型**（pi-ai faux provider + 确定性脚本），UI 与用量中明确标注“测试模型，非真实 AI”，费用记 0 且标记 `fixture`。
- 本云会话的 Anthropic 代理凭据属于开发环境，**不得**作为产品模型凭据使用。
