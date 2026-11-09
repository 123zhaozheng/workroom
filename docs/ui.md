# Workroom Web（B 组）— 界面规范与实现说明

前端位于 `web/`：React 19 + TypeScript + Vite 8 + Tailwind CSS v4（`@tailwindcss/vite`）+ 本地 shadcn 风格组件（Radix 原语，`radix-ui` 统一包）+ lucide-react + react-router 8。生产构建 `npm run -w web build` → `web/dist`，由 `server/src/main.ts` 托管；开发 `npm run -w web dev`（5173，`/api` 代理到 `WORKROOM_API`，默认 `http://127.0.0.1:8787`）。

DTO 一律从 `shared/*.ts` 引用（`@shared/chat`、`@shared/files`、`@shared/knowledge`、`@shared/ops`），前端不自造领域类型。身份/项目的少量形状在 `web/src/lib/types.ts`，与 `server/src/identity/module.ts` 一致。

## 1. 设计原则（用户指定）

- 首页 = 品牌 + 一句问候 + **一个输入框** + 4 个起步建议。不是仪表盘。
- 单列对话、留白充足、中性色、少量颜色只表达状态（info/success/warning/danger）。
- 18 个能力模块是后端能力，不是 18 个菜单：主侧栏只有 新对话 / 搜索 / 个人知识库 / 文件库（文字标签），其下“项目”“最近对话”按需展开；能力、自动化、记忆、统计、组织管理（仅管理员可见）、设置进入左下角用户菜单，各自是独立页面。
- 只有状态才有动效：助手头像在运行中有一个脉冲环、等待确认为静态黄色环、失败为红色环；无常驻动画背景。系统“减少动态效果”与应用内开关（设置 → 减少动画）都生效。
- 不可用就说不可用：服务端未提供的接口显示“未连接”（`<Unavailable>`，并写明需要哪个组的哪个接口）；模型 blocked 显示原因且不可选；测试模型处处标注“测试模型（非真实 AI）”，用量显示“费用 0”。没有任何假数据或摆设按钮。

## 2. Tokens（`web/src/styles.css`）

| Token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#fafaf9` | `#161719` | 页面底色 |
| `--surface` / `-2` / `-3` | `#fff` / `#f3f3f1` / `#ebebe8` | `#1d1e21` / `#25262a` / `#2e3034` | 卡片 / 侧栏、代码底 / 选中与用户气泡 |
| `--border` / `-strong` | `#e5e5e2` / `#d4d4cf` | `#2f3135` / `#3d4045` | 分隔 / 悬停与焦点 |
| `--fg` / `-muted` / `-subtle` | `#1c1d1f` / `#5d6066` / `#8a8d93` | `#ececeb` / `#a5a8ad` / `#7c8086` | 正文 / 次要 / 辅助 |
| `--accent` | `#1f2125` | `#ececeb` | 主按钮（中性黑/白，非品牌色） |
| `--info` `--success` `--warning` `--danger`（+ `-soft`） | 蓝/绿/橙/红 | 提亮版 | 仅用于状态 |
| `--radius` | 10px | | 卡片 12px（`rounded-xl`），控件 8px |
| `--sidebar-w` | 264px | | 侧栏宽 |
| `--content-w` | 760px | | 对话单列最大宽（预览打开时 720px） |

主题：`html[data-theme]`（跟随系统 / 浅色 / 深色，设置页切换）。Tailwind 通过 `@theme inline` 把上述变量映射为 `bg-surface`、`text-fg-muted` 等工具类；Streamdown 需要的 shadcn 别名（`--color-muted-foreground` 等）同样映射。

字体：`"Inter Variable"`（`@fontsource-variable/inter`，**随包打进 `/assets`**，只含 woff2）→ `PingFang SC`、`Hiragino Sans GB`、`Microsoft YaHei`、`Noto Sans CJK SC`、`Noto Sans SC`、`Source Han Sans SC`、`WenQuanYi Micro Hei`、`system-ui`。中文完全走本地系统字体；全程没有 Google Fonts / CDN。关闭 Inter 的 `calt`（否则 `5x6` 会显示成 `5×6`，ID 会被误读）。KaTeX 字体同样随包、只在出现公式时加载。

## 3. 布局规则

- **≥1024px**：侧栏内联（可收起，收起后左上角出现展开按钮，偏好存 localStorage）；右侧面板为一列 `clamp(380px, 40vw, 680px)`。
- **<1024px**：侧栏变左侧抽屉；右侧面板变全宽抽屉（`Sheet`），绝不出现三列。390px 宽无横向滚动（e2e 断言）。
- **右侧只有一个面板**（`PanelProvider`）：要么“成果预览”，要么“工作面板”（子任务 / 终端 / 浏览器三个标签切换）。打开另一个即替换；关闭恢复单列；切换路由自动关闭。
- 页面顶栏 `TopBar`：左侧在侧栏隐藏时显示展开/导航按钮；右侧放页面级操作（分支菜单、工作面板按钮）。

## 4. 对话界面要点（`web/src/pages/ChatPage.tsx`、`web/src/features/chat/*`）

- **实时状态**：`GET /conversations/:spaceId/:id/events`（SSE）。`snapshot`/`state` 都是完整 `ConversationState`，直接替换；断线由 EventSource 自动重连，服务端发出的 `error`（如 `runtime_closed`）按退避重连，`forbidden/not_found` 为终止。关闭页面只停止订阅，任务在服务端继续。
- **消息模型**（`model.ts`）：entries + `live.partial` → 用户轮 / 助手轮 / 上下文分隔。助手轮内：思考、过程说明（中间文字）、工具调用（与 `tool_result` 按 callId 配对、与审批按 callId 关联）构成**步骤链**，默认折叠为“已完成 N 个步骤 · 用时 x”，运行中/待确认自动展开；每一步可再展开看参数、结果、诊断，并可“在工作面板中查看”（沙箱→终端、browse→浏览器、delegate→子任务）。
- **成果文件卡片**：工具结果 `details.artifact`（`FileVersionRefDTO`）→ `FileCard`；点击打开右侧预览，带版本切换、下载、跳转文件库。
- **引用**：工具结果 `details.citations`（`CitationDTO`）→ 回答下方“引用来源”，显示文件、版本、定位（页码/章节/段落）与片段，点击打开对应版本预览。
- **待确认卡片**：`state.approvals` 中 `pending` → `ApprovalCard`（标题、逐字的“将要发生什么”、风险、详细内容、批准/拒绝 + 可选说明）。`effects` 中 `needs_reconciliation` → `ReconcileCard`（已生效/未生效，系统不盲目重做）。
- **运行状态**（`RunBar` + 顶栏）：运行中（第 N 轮、自动重试原因）/ 等待你确认 / 失败（原因 + 继续）/ 已取消 / 已超时 / 已中断 / 已完成，各自独立。
- **插话**：运行中输入框的发送键变为“插话”，可切换“稍后处理”（followUp）；每条插话在输入框上方显示反馈 已接收 → 已应用 → 已回复，或“未应用：原因”/“已撤回”（轮询 `GET .../submissions/:id`）。停止键 = `POST .../abort`。
- **分支**：消息悬停操作——复制、编辑（→ `POST .../edit`，新分支）、重新生成（→ `.../regenerate`，新分支）、从这里分叉（→ `.../fork`）、导出 Markdown。分歧点上方显示 `‹ i / n ›` 切换器；顶栏“分支 n”菜单列出原对话与所有分支；分支顶栏显示“分支”标记与“来自：原对话”链接。原对话永不被修改。
- **输入框**：一个输入框完成纯聊天 / 带附件 / 带知识引用。附件与知识库以小标签出现在输入框内；来源：“+”菜单（上传、从文件库选择、引用知识库）或输入 `/` 的斜杠菜单（键盘可选）。中文输入法组合期间回车不发送。
- 子 Agent 会话（`kind: subagent`）只读；项目**查看者**打开项目对话时也是只读（无输入框、无编辑/再生成/分叉、不能确认），服务端同样拒绝其写请求。
- **每条消息的结果**：`UserEntryDTO.submission` 未回复/撤回时直接标在那条消息下（“这条消息没有得到回复：未应用（已被取消）”），刷新、换设备后不变。
- **用量诚实**：测试模型（`usage.fixture`/`usage.simulated`）只显示“测试模型 · 模拟用量，不计费”，不显示任何 Token 数；统计页在只有测试模型请求时 Token 显示“—”。
- **引用失效提示**：打开对话时取 `GET /kb/conversations/:spaceId/:id/citation-status`；旧回答保留原引用快照，来源更新/删除/下架/过期时在引用上方标出服务端给的说明（更新时可直接打开当前版本），无权访问时隐藏片段与链接；对话顶部有汇总提示。
- **待核对**：`effects` 中 `needs_reconciliation` → 核对卡片（已生效 / 未生效），系统不自动重做。
- **后台任务**（M14-C）：`job_start` 的结果在消息中显示为一行状态（进行中/已完成/失败/超预算/已取消 + 取消），详情（预算、进度、产出文件）在工作面板“子任务”页；聊天始终可用。
- **“更多”菜单**（对话顶栏 ⋯）：交接摘要（M09-B）、分享只读链接（M09-C）、模型与路由记录（M15-A：所选平台模型 ↔ 每次实际请求的渠道/上游模型/状态/故障切换）、整理为技能。不新增常驻面板。
- **助手**（M03-A）：设置页管理（头像、说明、指令、默认模型、工具、知识库、团队成员），首页输入框旁选择；对话顶栏显示所用助手。助手与对话分开存储。
- **分享**：项目页/文件页/对话都可生成只读外部链接（有效期、撤销、使用次数）；公开页 `/s/:token` 无需登录、只读，不提供只读渲染的资源类型如实说明只显示分享信息。
- **登录与会话**（M16-A）：设置页“登录设备”可退出单个或其他全部设备；登录页支持两步验证码与企业登录按钮（服务端配置了才出现）。
- **组织管理 → 排查**（M18-B）：输入请求 ID / 运行 ID / spaceId:对话ID，一次看到审计、模型路由、用量、自动化运行、通知与其他模块事件；内容由服务端按脱敏配置处理。

## 5. 组件清单

| 位置 | 组件 |
|---|---|
| `components/ui/button.tsx` | `Button`（primary/secondary/ghost/danger/link；sm/md/lg/icon） |
| `components/ui/input.tsx` | `Input` `Textarea` `Label` `Select` |
| `components/ui/overlay.tsx` | `Dialog` `Sheet`（抽屉）`Menu*`（下拉）`Popover*` `Tip`（tooltip） |
| `components/ui/tabs.tsx` | `Tabs` `TabsList` `TabsTrigger` |
| `components/ui/misc.tsx` | `Spinner` `Badge` `EmptyState` `Unavailable` `ErrorState` `Blocked` `Loadable` `PageHeader` `Page` |
| `components/ui/ErrorBoundary.tsx` | 页面与面板各自的错误边界（一个面板出错不会让整个应用白屏） |
| `components/shell/*` | `AppShell` `TopBar` `Sidebar` `BrandMark` `AssistantAvatar` `PanelProvider/usePanel` |
| `features/chat/*` | `Composer` `pickers`（文件/知识库选择）`ModelPicker` `Messages`（用户/助手消息、分支切换器）`Steps`（步骤链）`Cards`（文件卡、审批卡、核对卡、引用）`status`（状态文案与图标）`model`（视图模型）`useConversation`（SSE、详情、更早消息、提交跟踪） |
| `features/markdown/Markdown.tsx` | 流式与历史共用的 Markdown 渲染 |
| `features/preview/*` | `PreviewPanel` + `viewers/{FrameViewer,TextViewer,ImageViewer}` |
| `features/work/WorkPanel.tsx` | 子任务（后台任务 + 子 Agent）/ 终端（隔离说明、执行记录、目录）/ 浏览器（实时会话 + 抓取记录） |
| `features/work/live.tsx` | `JobCard` `JobChip`（消息内状态 + 取消）`BrowserSessionView`（观看 / 接管 / 点击截图操作 / 输入 / 导航 / 交还；接管权限 = 服务端 `canControl`，与预览一致） |
| `features/handoff/Handoff.tsx` | 对话交接摘要对话框、项目页“对话与待处理”汇总 |
| `components/shell/Notifications.tsx` | 侧栏铃铛：站内通知（状态、打开任务、成果文件、已读） |
| `features/stats/StatsCharts.tsx` | Recharts（仅统计页） |
| `pages/*` | 登录/注册、首页、对话、搜索、个人知识库（列表/详情/失败重试/检索调试与评估）、文件库、文件详情（版本与来源）、项目（成员/角色/交接汇总）、设置、能力（技能安装/启用/固定/升级/回滚/授权/运行记录；从任务整理→验证→发布；连接启用/重新连接）、自动化（编辑器：触发/时区/下次运行预览/条件/输出/补跑/时长；立即运行/取消/再次运行/运行历史与通知投递）、记忆、统计、组织管理（成员/邀请/部门/会话/模型与渠道/预算/审计与导出） |

## 6. Markdown 渲染选型：Streamdown

选 `streamdown@2.7.1`：专为流式 LLM 输出设计（未闭合的代码块/表格/强调在流式中稳定渲染），内建 GFM、表格复制/下载、代码复制；同一组件 `mode="streaming"`/`"static"` 渲染流式与历史，满足 M01-C“流式与历史渲染一致”。代码高亮（`@streamdown/code`→shiki）与公式（`@streamdown/math`→KaTeX + CSS）是插件：`Markdown.tsx` 只在文本出现 ``` 或 `$…$` / `\(` / `$$` 时才 `import()`，所以普通回答不加载 shiki/KaTeX。react-markdown 方案需要自己处理未闭合块与流式闪烁，故未采用。

## 7. 按需加载地图（构建产物实测，gzip 前）

| 何时加载 | Chunk | 体积 |
|---|---|---|
| 首屏（登录/首页） | `index` + radix/motion 共享块 | ~308KB（含 React、Router、Radix、motion `LazyMotion` 精简特性） |
| 进入对话 | `ChatPage` + Streamdown 核心 `chunk-7TTQLYRW` | 36KB + ~470KB |
| 回答含代码块 | `@streamdown/code` + shiki 语言/主题按需块 | 每种语言独立块 |
| 回答含公式 | `@streamdown/math` + `katex-*.css` + KaTeX 字体 | — |
| 打开预览 | `PreviewPanel` → 再按类型 `FrameViewer`（PDF/Office/CSV/HTML，服务端渲染后 iframe 沙箱）/ `TextViewer`（md/文本/代码）/ `ImageViewer` | 8KB + 4KB |
| 打开工作面板 | `WorkPanel` | 12KB |
| 统计页 | `StatsCharts`（Recharts） | ~364KB |
| 其余页面 | 每页一个 chunk（`KnowledgePage`、`FilesPage`、`FileDetailPage` …） | 4–12KB |

e2e 断言：首页加载完成时没有请求任何 Streamdown/shiki/KaTeX/Recharts/预览/工作面板块，也没有任何外部主机请求。

## 8. 浏览器验证（e2e）

Playwright 已预装（脚本通过 `createRequire` 加载，**不要** `playwright install`）。每个脚本自己启动集成服务（`server/src/main.ts`，`WORKROOM_FIXTURE_TOOLS=1` 以启用测试审批工具），数据目录 `data/dev-B/e2e-<port>`（每次清空），端口 core-loop 8802、states 8812；设 `E2E_BASE=http://…` 可改为使用已运行的服务。

```bash
npm run -w web build
npm run -w web e2e           # 依次跑 core-loop / states / pages / round2 / round3-runtime / round3-knowledge / round3-org
node web/e2e/round2.mjs      # 或单独跑某一个
```

- `web/e2e/core-loop.mjs`：注册 → 首页（无重型块、无外部请求、一个输入框）→ 发消息（`[[call file_create …]]`）→ 步骤链 + 文件卡 → 右侧预览打开/关闭 → 审批卡（`wr_fixture_approval`）批准 → 运行中插话反馈（已接收→已应用/已回复）→ `file_revise` 生成 v2 卡片 → 编辑产生分支 + 切换器回到原对话 → 文件库 v1/v2 与来源 → 知识库上传后“处理中→可检索”+ 检索测试 → 1366×768（预览、侧栏收起、无横向溢出）→ 390×844（导航抽屉、预览抽屉、无横向滚动）→ reduced-motion（系统与应用内开关）→ 全程无外部请求、字体仅来自 `/assets`。结果写入 `artifacts/screenshots/core-loop.results.json`。
- `web/e2e/pages.mjs`（端口 8822）：自动化（预览、无效 cron、立即运行、再次运行、编辑、失败记录、取消、站内通知含成果与任务链接）、组织管理（邀请→加入、成员看不到管理入口且服务端 403、停用即撤销会话、部门、会话、渠道、预算、审计与 CSV）、能力（技能固定/升级/回滚/停用、从任务整理→验证→发布、连接重新检查与个人启用）。结果 `pages.results.json`。
- `web/e2e/round2.mjs`（端口 8832 + 本地测试网页 8834，`WORKROOM_URL_ALLOWLIST` 只放行它）：M01-A 同一输入框三类请求、引用失效提示、单条消息结果、待核对卡片、终端真实执行、网页抓取、实时浏览器接管与点击、后台任务取消、知识库失败重试、检索调试与评估、编辑者交接摘要 / 查看者只读且服务端拒绝。结果 `round2.results.json`。
- `web/e2e/round3-runtime.mjs`（8842）：设置页新建助手并在首页选择（M03-A）、子 Agent 卡片与轮数上限（M03-B / M02-C）、模型与路由记录（M15-A）、运行中关闭浏览器→另一设备重新登录看到终态与成果（M02-A）、SIGKILL 服务进程→重启后运行恢复完成、发送中断的外部写显示待核对（M02-B）。
- `web/e2e/round3-knowledge.mjs`（8852）：知识库范围（个人/项目/部门/企业）与成员可见性（M07-A）、治理字段与下架/替换（M07-B）、无证据/索引未就绪/无权限/模型错误四种文案（M07-C）、PDF 第 2 页与章节/段落定位（M06-B）、删除/下架/无权访问的失效提示（M06-C）、文件页存储状态与知识状态分开且需显式加入（M08-C）、记忆来源/范围/编辑/删除与纠正前后（M10-A/C）。
- `web/e2e/round3-org.mjs`（8862，另起本地网页 8864 与 HTTP MCP 测试服务 8865）：连接“需要重新连接/凭据被拒绝/无权限”与重连（M04-A）、三类技能与依赖/授权（M05-A）、查看者只能观看浏览器且服务端拒绝接管（M11-B）、外部只读分享创建/未登录打开/撤销（M09-C）、按对话 ID 排查且参数中的密钥被脱敏（M18-B）、会话撤销/停用/移除后界面回到登录（M16-A）。
- 设 `E2E_BASE` 使用外部服务时，需要杀进程/重启的检查会直接报错失败，而不会空跑通过。
- `web/e2e/states.mjs`：附件标签 + 斜杠菜单引用知识库（同一输入框）→ 失败（原因 + 继续）→ 运行中 → 取消 → 委派子 Agent 后工作面板（子任务/终端/浏览器）→ 项目页成员角色 → 搜索/能力/自动化/统计/记忆/管理页不出错 → 深色主题。结果写入 `artifacts/screenshots/states.results.json`。

截图（deviceScaleFactor 2）在 `artifacts/screenshots/`，文件名前缀为视口宽度（`1440-*`、`1366-*`、`390-*`）。

## 9. e2e 判定规则

只有断言本身或紧挨着的 `waitForSelector/waitForFunction`（失败即抛出）能证明的检查才写成通过；功能缺失（接口 404、显示“未连接”）一律判为失败，不设“未连接也算通过”的分支。
