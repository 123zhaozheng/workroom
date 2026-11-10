# Round 5 · UI 组 2（Agent 进度 / 工具调用 / 审批 / 插话 / 失败恢复 / 分支）调研

只研究行为与模式，没有复制代码或资源；没有运行任何远程脚本；仓库浅克隆到 `/home/user/research/{assistant-ui,tool-ui,ai-elements}`（只读）。GitHub API 在本会话不可用，维护情况以克隆的提交日期与包版本为准。

| 项目 | 适用性 | 许可 | 维护 | 依赖 | 采用 / 拒绝 |
|---|---|---|---|---|---|
| **assistant-ui `react-pi`**（0.0.33） | 驱动 pi 的 `AgentSession`（`pi-coding-agent`），不是 pi-durable；契约是 `PiClient` + 细粒度事件 | MIT | 主仓库 2026-11-09 仍有提交；包 0.0.x，变更频繁 | `@assistant-ui/react/core/store`、`assistant-stream`、`assistant-cloud`，peer `pi-coding-agent` | **拒绝引入**；详见 `docs/research/assistant-ui-react-pi-mapping.md`（事件映射与结论）。采用其“审批按 toolCallId 关联到工具行”“进行中输出标记为预览”的思路 |
| **assistant-ui**（BranchPicker、Message、工具审批） | BranchPicker 依赖同线程消息树（`parentId`）；我们的分支是独立会话 | MIT | 活跃 | React + 自有 store | **拒绝组件**。采用交互：‹ i / n › 紧凑切换、按钮有 `aria-label`、两端循环；保持我们“切换会话”的语义 |
| **tool-ui**（approval-card 等） | 复制粘贴式组件，Zod schema + “回执（receipt）”模式；审批卡有 `variant: destructive`、元数据 `dl` | MIT | 仅 1 次浅克隆提交，最近 2026-08-31（约 10 周前），维护较慢 | shadcn/Radix、Zod | **拒绝代码**（依赖 shadcn/Zod，样式体系不同）。采用：审批卡的“标题 + 说明 + 元数据行 + 取消在左/确认在右 + Esc 取消”结构；破坏性操作用警示色；决定后留“回执”（我们由步骤行的“已允许/已拒绝”承担） |
| **vercel/ai-elements**（Tool、Confirmation、Task、Plan、Reasoning、Queue） | 依赖 AI SDK 的 `ToolUIPart` 状态机，纯模式参考 | Apache-2.0 | 活跃（2026-10 发布版本） | AI SDK、shadcn、Radix | **拒绝代码**。采用：工具状态词表（待确认 / 进行中 / 完成 / 拒绝 / 错误）、Tool 的“折叠头 + 参数 + 结果”分区（我们把参数/结果收进“技术详情”）、Reasoning 的“思考中 → 思考”折叠 |
| **Agentic UX patterns**（aidesign.guide，39 个模式，2026-10-11 更新） | 设计参考 | — | — | — | 采用：“可折叠的工具调用行”“带中断提示的进行状态”“插话或排队”“Needs input / Working / Completed”“交接给人并说明下一步”。**拒绝**：“Yes, and don’t ask again”（范围型长期授权）——后端只支持单次 `approved/rejected`，不做假选项 |

## 本轮落地的决定
1. **用户消息不展示测试指令**：服务端 `UserEntryDTO.displayText`（复用标题用的 `stripDirectives`）+ `hasTestDirectives`，`text` 不变；UI 显示 `displayText`，带“测试”小徽标，空文本显示“（测试指令）”。交接摘要、插话芯片、排队行用前端同构的 `cleanTestText`。
2. **工具调用一行摘要**：“已完成 3 步 · 生成 1 个文件”“正在检索知识库…”“等待你确认：标题”；展开后每步一句人话（`toolDescribe.ts`：kb_search、file_*、sandbox_*、browse、delegate、连接器、技能、后台任务…），原始参数/结果只在“技术详情”。
3. **审批卡**：做什么（后端 `summary`）、对象（从 `detail` 里识别收件人/目标/路径等）、风险（颜色 + 图标 + 一句话）、请求人；只有 拒绝 / 允许 + 可选说明（后端 `note` 真实支持）；打开时不聚焦任何按钮，“去处理”只把焦点给卡片；高风险点“允许…”后进入二次确认，焦点落在“返回”。待核对卡只有 已生效 / 未生效。
4. **保持原逻辑**：插话反馈（新增后端已有的“撤回”）、失败原因 + 重试（`continue`）/ 继续（取消后）、分支切换 ‹ i/n ›、停止、结果卡片 → 预览面板。
5. **不做的**：“始终允许”、按工具的信任范围、审批里编辑参数（后端都不支持）。
