# Skills 按需加载：调研与设计（round 6）

范围：只记录行为，未复制任何代码，未运行远程脚本。GitHub API / 仓库元数据（commit 日期、LICENSE）在本会话内无法访问（`gh api` 403，未授权该仓库），因此下表的“版本/日期”与“许可”为“未能核实”，采用前须人工确认；页面正文通过 WebFetch 读取。

## 一、来源对比

| 来源 | 内容（行为） | 版本/日期 | 许可 | 结论 |
|---|---|---|---|---|
| langchain-ai/deepagents `middleware/skills.py` | 系统提示里列出每个 skill 的 name、description、path（含 license/compatibility）；提示要求模型在任务匹配时用 `read_file`（limit=1000）读取 SKILL.md；另有 `pinned_skills` 状态，下次模型调用前把去掉 frontmatter 的正文作为 `<skill>` 消息注入。限制：SKILL.md ≤10MB，name ≤64，description ≤1024（超出截断并警告），compatibility ≤500，警告 ≤20 条；缺 name/description 则跳过；多个来源同名“后者覆盖前者”；每线程加载一次并缓存。 | 未能核实（页面未给出） | 可见部分无许可头；仓库 LICENSE 未核实 | 采纳思路：元数据入提示、正文按需读、长度上限与“跳过坏 skill 不中断”。拒绝：pinned 自动注入（Workroom 要显式 load 以便审计）；同名后者覆盖（Workroom 有 org/部门/个人作用域优先级，不用来源顺序）。 |
| vercel/ai cookbook `06-agent-skills.mdx` | 渐进披露三层：发现（仅 name+description）→激活（`loadSkill` 工具读 SKILL.md，去 frontmatter，返回正文+skill 目录）→执行（通用 readFile 读资源、bash 跑脚本，路径相对 skill 目录）。同名先到先得；缺目录/坏 skill 跳过；脚本执行由 Sandbox 抽象的 `exec` 决定可达范围，exec 可选。 | 未能核实 | 未能核实 | 采纳：三层模型、loadSkill 返回目录路径、脚本只经沙箱 exec。拒绝：宿主机直接 `child_process` 执行（不隔离）。 |
| cloudflare/agents `docs/agents/harnesses/pi.md` | 工具与 prompt section 是 Pi 扩展（`name/tools/sections`），section 每次请求前渲染；工具可标 replay-safe，默认不安全则被中断后模型收到 "interrupted"；`skills(sources)` 提供 `activate_skill` 与 `read_skill_resource` 两个工具，来源可为 workspace、R2 或代码清单；pi-durable 为实验性，每个 Harness 订阅 registry，registry 须按对象创建而非模块级。 | 文档写 pi-durable 实验性、`agents` 一次只支持一个 Pi 次版本；日期未能核实 | 未能核实（仓库为 Cloudflare 开源项目，须自行确认） | 采纳：两工具分工（activate + read_resource）与“元数据在 section、正文在工具”的拆法，与 pi-durable 原生机制一致。不引入 `agents` 包本身（依赖 Workers 绑定）。 |

## 二、pi-durable 1.5.0（本地 `dist/harness/types.d.ts`，MIT）原生提供什么

核对结果：**没有任何 skill 概念**（dist 内除 env-conformance 测试外无 "skill" 出现）。可复用的通用原语：

- `PromptSection { key; render(input, ctx) => string|undefined|Promise; tag? }`：每次请求前按序渲染，可异步读取（`input.env`、`input.read`、`input.shown` 为已生效 section 文本），默认包 `<key>…</key>`。
- `ToolRegistration.deferred: true`：除非 `modelTools` 数组/`add` 点名，否则不提供给模型；其它工具仍可调用。`control.addTools`（如 `tool_search`）可在运行中加载。
- `modelTools`：`string[]`（精确列表，含 deferred）或 `{ add, remove }`。
- `callers: ["model"|"tools"]` 限定调用方；`outputLimits` 限制输出；`Extension.sections/tools/wraps`。

所以 skills 全部是 Workroom 自己的工具（`server/src/tools/skills.ts`）与市场（`market.ts`），pi-durable 只提供 section / deferred 工具承载点。

## 三、Workroom 推荐设计

1. **紧凑元数据进 prompt section**：一个 `skills` section，只列 `slug — description(截断≤200 字)`，每 skill 一行，总量封顶（如 40 条 / 4KB，超出提示“用 skill_search 查找”）；顺序稳定（按 slug），使提示前缀可缓存。
2. **SKILL.md 与文件按需经工具读取**：`skill_load(slug)` 返回去 frontmatter 的正文、版本、目录清单与大小；`skill_read(slug, path)` 读取资源（路径校验、按字节/行截断、记审计）。工具标记 replay-safe（纯读）。
3. **脚本只在现有沙箱执行**：只读挂载 `/skills/<slug>`，**且只挂载本会话已 load 的 skill**（现状是把用户全部已安装 skill 挂载，上限 32 静默截断），其余不挂载；无需执行脚本的 run 零挂载。
4. **内容哈希缓存**：沿用 `<slug>-<digest>` 内容寻址目录（已有）；元数据渲染结果与 `active()` 结果以 (用户, 安装集版本/哈希) 为键缓存，安装/升级/撤销时失效；已 load 集合记在会话状态里，使 section 与挂载在重放时一致。
5. 限制沿用 deepagents 的做法：name/description 长度、坏 skill 跳过并告警（不中断）、正文大小上限。

## 四、基线实测（commit 9519453，`artifacts/bench/skills-baseline-9519453.json`）

驱动 namespaces（Docker 守护进程未运行），4 CPU，Node 22.23.4，空闲。每次沙箱运行 `echo ok`：

| 已装 skill | 传给驱动的挂载 | 冷启动 ms | 热 中位 ms | 热 p95 ms |
|---|---|---|---|---|
| 0 | 0 | 92 | 94 | 102 |
| 5 | 5 | 311 | 114 | 128 |
| 32 | 32 | 245 | 241 | 265 |
| 40 | **32**（静默截断，8 个 skill 不可见） | 245 | 242 | 350 |

结论：每个挂载约增加 4–5 ms 的每次运行延迟，32 个时 run 延迟约为 0 个时的 2.6 倍；`mountPlan` 本身热态仅 3 ms，冷态（首次落盘）约 180–400 ms。按需只挂载已 load 的 skill 可把常见情形的挂载数降到 0–2。
