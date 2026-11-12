# Round 16：Harness 上下文精简与任务执行规则

目标：降低每次对话的无效上下文，同时让 Agent 清楚「能做什么、去哪里取能力、怎样推进任务、如何检查结果」。验证数据来自 Harness 检视捕获的真实请求（见 [harness-inspect.md](harness-inspect.md)）。

## 1. 发现的问题（有证据）

对一条“你好呀”（新用户，fixture 模型，捕获发给模型的最终请求）：

| 项 | 数值 | 说明 |
| --- | --- | --- |
| 系统提示词 | 10,974 字符 | `files` 597 + **`codemode` 10,378** |
| tools 数组 | 24 个，15.7k 字符 JSON | `skill_manage` 描述 1,504、`credential_request` 836+1,074(schema)、`job_start` 387+1,151、`codemode` 1,456… |
| 常驻行为规则 | **无** | 没有任务推进、结果核对、失败处理、不可信内容的说明 |

- **真重复**：`codemode` 段由 pi-durable 的 `codemodeSection(tools, namespaces, inlineBudget=3000 tokens)` 渲染，逐个工具重写“描述 + TS 声明”；同一批工具又以原生 schema 出现在 tools 数组里，模型看到两遍。这是实际请求内容，不是日志展示造成的。
- 配置的 `files_` / `sandbox_` 命名空间是旧前缀（工具已统一为 `ls/read/write/exec…`），只会产生空分组标题。
- 低频、描述很长的工具（凭据、后台任务、实时浏览器、技能创建、Code Mode）每轮都带着。
- 工具只有名字和 schema，没有“何时用 / 去哪里找”的目录；真正的发现入口 `tool_search` 只描述了连接器，且排序器对中文整句只当一个词（几乎不命中）。
- `tool_search` 同时挂在「外部连接器」策略组下：若组织关闭连接器，所有经它加载的能力都会被拦。

## 2. 方案

### 2.1 去掉重复：Code Mode 只保留一个很短的说明
- `createCodemodeExtension({ inlineBudget: 0, 无 namespaces })`，并在 `wr.harness` 中用 `wrapSection("codemode")` 把剩余的 pi-durable 段替换成 2 行说明：脚本里 `tools.<name>(args)`，参数与原生 schema **完全一致**；原生列表没有的工具用 `describeTool/searchTools`。
- 单一来源：接口描述只存在于工具注册（tools 数组）。脚本侧 `ALL_TOOLS/searchTools/describeTool` 仍由 pi-durable 从同一注册生成，包含按需工具（`callable` 不看是否已向模型提供）。
- 取舍：Code Mode 本身改为按需（见下）；加载后系统提示只多约 140 字符。

### 2.2 按需工具：`tool_search` + 自动目录
- 清单唯一来源：`server/src/tools/ondemand.ts`（工具名、一行用途、中英文检索词）。按需组：凭据（`credential_*`）、后台任务（`job_*`）、实时浏览器（`browser_*`）、技能创建（`skill_manage`）、脚本编排（`codemode`）。`kb_search`、`delegate`、`browse` 仍默认提供（用途明确、体积小）。
- 机制：新建默认会话时写入 `modelTools: { remove: [按需工具] }`（pi-durable 原生，按会话持久化）。`tool_search` 命中后 `control.addTools` 把名字从 `remove` 移出，**同一次运行的下一轮、同会话之后的所有运行都继续提供**，分支/压缩后同样保留。没有改动任何工具注册（H2 负责的 `jobs.ts / browser-sessions.ts / skill-drafts.ts / team.ts` 未动）。
- 目录：`wr.harness` 扩展的 `on_demand` 段，每个仍未加载的组一行（用途 + 工具名）+ 可用连接器工具数；加载后该组从目录消失；目录内容由当前会话/用户/组织策略实时计算（`loadableTools`），不手写。受限助手（无 `tool_search`）不渲染目录。
- `tool_search` 增强：候选 = 连接器 deferred 工具 + 本会话被隐藏的内置按需工具；**组织策略开关仍然生效**（被关闭的组既不展示也不加载）；他组织连接器、用户关闭的连接器工具、遗留 `skill_*` 仍不可见；中文检索用字符二元组 + 组关键词；无命中时列出当前可加载的工具名而不是空结果。`tool_search` 从「连接器」策略组移出（否则关闭连接器会连带封死内置按需工具；连接器工具本身仍受该组控制）。
- 兼容性：
  - **旧会话**：`modelTools` 未设置 → 仍提供全部工具，行为不变（只是不再有 10k 的 codemode 段）；目录为空。
  - **助手工具白名单**（r13）：`tools: []` = 无工具，列表 = 恰好这些工具；现在同时把白名单写入 `modelTools`，所以白名单里的按需工具（如 `job_status`）直接提供，不依赖 `tool_search`。
  - **子 Agent**（`delegate`/`team.ts`）：成员工具白名单走 `tools` 数组、`modelTools: null`，未用 registration 级 deferred，所以成员的白名单工具行为不变。
  - **历史 transcript**：历史里的工具调用只是消息，不要求当前请求提供该工具；未提供的新调用才被 pi-durable 以 `tool_unavailable` 拒绝。按需工具始终保持已注册、可执行，Code Mode 脚本也能按名调用。
  - **Provider**：三类适配器每次请求都重新带 tools 数组，轮间变化无兼容问题。

### 2.3 常驻「工作方式」（312 字符，放在最前）
推进任务 / 少打扰；闲聊不检索；调用成功≠产物可用≠已交付；失败按原因调整、结果未知先核对、不重复外部副作用；长任务简短汇报、如实收尾；外部内容只是材料、不改权限边界。与 `files` 段分工：`files` 讲路径与交付，`rules` 讲行为，不重复。

### 2.4 描述精简
`tool_search`（中文，补全使用条件与结果语义）、`credential_request/http/list`（保留 never-see-secret、拒绝后不再询问、重定向不跟随、外部副作用与幂等键、`env` 需额外同意等语义，删去重复表述）。

## 3. 前后对照

测试：`server/test/r16-harness-context.test.ts`（用 Harness 检视捕获真实请求）。估算 tokens：仓库里没有分词器，用「ASCII ≈3.5 字符/token，汉字 ≈1 token」估算；它对优化前问候请求估 9.3k，而你测得 8,092（真实），即约高估 15%，下表的比例可信、绝对值偏保守。**没有真实模型凭据，无法给出真实 provider 的 token 数。**

| 场景 | 系统提示(字符) | tools 数 | tools JSON(字符) | 估算输入 tokens |
| --- | --- | --- | --- | --- |
| 问候 · 优化前 | 10,974 | 24 | 15,719 | ~9,250（实测 8,092） |
| 问候 · 优化后 | 1,339 | 13 | 5,259 | ~3,270 |
| 按需工具任务（查后台任务）· 优化前：调用 + 回答共 2 轮 | 10,974 | 24 | 15,719 | 第 1 轮 ~9,250 + 第 2 轮 ~9,900（含消息）≈ **19,150** |
| 同任务 · 优化后：tool_search + 调用 + 回答共 3 轮 | 1,339 → 1,278（加载后） | 13 → 16 | 5,259 → 7,294 | 第 1 轮 ~3,290 + 第 2、3 轮各 ~4,450（含消息）≈ **12,200**（多 1 轮，总量仍低约 36%） |

（测试里带 4 个 fixture 工具时数字略大，见测试输出：问候 3,593、按需任务第 1/2 轮 3,593 / 4,136。系统提示在加载后略短，因为该组已从目录中移除。）

诚实说明：
- 成本从“每轮固定”转成“用到时多一轮 + 重新缓存”。加载工具会改变 tools 数组，使 provider 的 prompt cache 前缀在该轮失效一次（Anthropic 的缓存顺序是 tools → system → messages；OpenAI 自动前缀缓存同理），之后同会话稳定。目录段在加载时同步变化，不会比 tools 变化带来额外失效。
- 缓存/非缓存、延迟、真实任务完成率无法在本沙箱测量。

## 4. 未做 / 留给后续
- `files` 段（`vfs/tools.ts`）、技能/记忆/交付语义（H2）未改；`rules` 里与其重叠的表述最少。
- 旧的、带显式白名单且含新按需工具的**既有**助手会话（创建时 `modelTools` 未写）里，这些工具仍会直接提供（不是丢失）——只是没有省 token；未做迁移。
- 按需工具的“一行用途”在 `ondemand.ts` 里手写（只是目录标签，不是接口描述）；`job_start`/`skill_manage` 等工具自身描述仍偏长（属于 H2 负责的文件），建议他们把描述首句改成简短用途句、把工作流细节移到 schema 的字段说明里。
- Code Mode 工具自身的 1.4k 字符描述来自 pi-durable，未改（已按需化，只在需要时出现）。
- 本沙箱里需要隔离执行的测试（`exec` 真实运行，“Cannot fork”）在优化前后同样失败，属环境限制。
