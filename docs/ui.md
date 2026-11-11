# Workroom Web（B 组）— 界面规范与实现说明

前端位于 `web/`：React 19 + TypeScript + Vite 8 + Tailwind CSS v4（`@tailwindcss/vite`）+ 本地 shadcn 风格组件（Radix 原语，`radix-ui` 统一包）+ lucide-react + react-router 8。生产构建 `npm run -w web build` → `web/dist`，由 `server/src/main.ts` 托管；开发 `npm run -w web dev`（5173，`/api` 代理到 `WORKROOM_API`，默认 `http://127.0.0.1:8787`）。

DTO 一律从 `shared/*.ts` 引用（`@shared/chat`、`@shared/files`、`@shared/knowledge`、`@shared/ops`），前端不自造领域类型。身份/项目的少量形状在 `web/src/lib/types.ts`，与 `server/src/identity/module.ts` 一致。

## 1. 设计原则（用户指定）

- 首页 = 品牌 + 一句问候 + **一个输入框** + 4 个起步建议。不是仪表盘。
- 单列对话、留白充足、中性色、少量颜色只表达状态（info/success/warning/danger）。
- 18 个能力模块是后端能力，不是 18 个菜单：主侧栏只有 新对话 / 搜索 / 个人知识库 / 文件库（文字标签），其下“项目”“最近对话”按需展开；能力、自动化、记忆、统计、组织管理（仅管理员可见）、设置进入左下角用户菜单，各自是独立页面。
- 动效：助手头像在运行中有一个脉冲环、等待确认为静态黄色环、失败为红色环。**唯一的常驻动画是用户明确要求的首页/对话页点阵背景**（§4a），带全套性能与无障碍保护，可在 设置 → 动态点阵背景 关闭。系统“减少动态效果”与应用内开关（设置 → 减少动画）都生效。
- 不可用就说不可用：服务端未提供的接口显示“{功能}暂不可用”（`<Unavailable>`；缺失的接口只写在“技术详情”折叠里，普通用户默认看不到）；模型 blocked 显示原因且不可选；测试模型处处标注“测试模型（非真实 AI）”，用量显示“费用 0”。没有任何假数据或摆设按钮。

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
- **运行状态**（`RunBar` + 顶栏）：运行中（第 N 轮、自动重试原因）/ 等待你确认 / 失败（原因 + 重试）/ 已停止（已完成 N 步 + 继续）/ 已超时 / 已中断 / 已完成，各自独立。
- **插话**：运行中输入框的发送键变为“插话”，可切换“稍后处理”（followUp）；每条插话在输入框上方显示反馈 已接收 → 已应用 → 已回复，或“未应用：原因”/“已撤回”（轮询 `GET .../submissions/:id`）。停止键 = `POST .../abort`。
- **分支**：消息悬停操作——复制、编辑（→ `POST .../edit`，新分支）、重新生成（→ `.../regenerate`，新分支）、从这里分叉（→ `.../fork`）、导出 Markdown。分歧点上方显示 `‹ i / n ›` 切换器；顶栏“分支 n”菜单列出原对话与所有分支；分支顶栏显示“分支”标记与“来自：原对话”链接。原对话永不被修改。
- **输入框**：见 §4b。首页、项目页、对话页是同一个组件。
- 子 Agent 会话（`kind: subagent`）只读；项目**查看者**打开项目对话时也是只读（无输入框、无编辑/再生成/分叉、不能确认），服务端同样拒绝其写请求。
- **每条消息的结果**：`UserEntryDTO.submission` 直接标在那条消息下，刷新、换设备后不变。三种互不混淆：已进入对话后被停止 →「已停止（已完成 N 步）」（灰色，消息与步骤都保留）；已进入对话但运行失败 →「这一轮没有完成：原因」；从未进入对话 →「未送达模型」+「放回输入框」。详见 `docs/r10-stop-continue.md`。
- **用量诚实**：测试模型（`usage.fixture`/`usage.simulated`）只显示“测试模型 · 模拟用量，不计费”，不显示任何 Token 数；统计页在只有测试模型请求时 Token 显示“—”。
- **引用失效提示**：打开对话时取 `GET /kb/conversations/:spaceId/:id/citation-status`；旧回答保留原引用快照，来源更新/删除/下架/过期时在引用上方标出服务端给的说明（更新时可直接打开当前版本），无权访问时隐藏片段与链接；对话顶部有汇总提示。
- **待核对**：`effects` 中 `needs_reconciliation` → 核对卡片（已生效 / 未生效），系统不自动重做。
- **后台任务**（M14-C）：`job_start` 的结果在消息中显示为一行状态（进行中/已完成/失败/超预算/已取消 + 取消），详情（预算、进度、产出文件）在工作面板“子任务”页；聊天始终可用。
- **“更多”菜单**（对话顶栏 ⋯）：交接摘要（M09-B）、分享只读链接（M09-C）、模型与路由记录（M15-A：所选平台模型 ↔ 每次实际请求的渠道/上游模型/状态/故障切换）、整理为技能。不新增常驻面板。
- **助手**（M03-A）：设置页管理（头像、说明、指令、默认模型、工具、知识库、团队成员），首页输入框旁选择；对话顶栏显示所用助手。助手与对话分开存储。
- **分享**：项目页/文件页/对话都可生成只读外部链接（有效期、撤销、使用次数）；公开页 `/s/:token` 无需登录、只读，不提供只读渲染的资源类型如实说明只显示分享信息。
- **登录与会话**（M16-A）：设置页“登录设备”可退出单个或其他全部设备；登录页支持两步验证码与企业登录按钮（服务端配置了才出现）。
- **组织管理 → 排查**（M18-B）：输入请求 ID / 运行 ID / spaceId:对话ID，一次看到审计、模型路由、用量、自动化运行、通知与其他模块事件；内容由服务端按脱敏配置处理。

## 4a. 点阵背景（`components/DotMatrix.tsx`）

首页与对话页背后的 canvas 点阵（24px 间距，圆点半径 1.1px），缓慢的双波起伏 + 指针附近的点轻微放大提亮。保护措施：

- 低对比、不盖字：颜色取 token `--dot-rgb` / `--dot-alpha`（浅/深色各一套，切换主题即时重绘）；宽屏（可用宽度 − 消息列 > 240px）用**左右两块 canvas，完全不覆盖消息列**，离列越远越清晰（0→1 渐变）；窄屏用一块全幅 canvas 并整体压低（地板 0.5）。画布在 `-z-10`，`pointer-events: none`，`aria-hidden`。
- devicePixelRatio（上限 2）；ResizeObserver / `resize` 重排。
- ~30fps：rAF 回调先于 33ms 的被跳过；单帧 0.3–0.8ms（1950 点 @2x）。
- 标签页隐藏（`visibilitychange`）或画布离开视口（IntersectionObserver）→ 取消 rAF，不再调度，**0 次回调**；恢复后继续。
- 系统 `prefers-reduced-motion` 或应用内“减少动画”→ 只画一帧静态点阵，没有 rAF 循环、不监听指针。
- 设置 → “动态点阵背景”关闭 → 不渲染 canvas（`Prefs.dotMatrix`，localStorage，默认开）。
- 无外部资源；`window.__wrDots`（mode / draws / rafCalls / avgDrawMs / dpr / regions / pixels）供浏览器检查读取。

## 4b. 输入框（`features/composer/*`，`features/chat/Composer.tsx` 为兼容再导出）

- 自动增高 textarea（两行起，最高 240px）；Enter 发送，Shift+Enter 换行；输入法组合期间（`compositionstart`、`isComposing`、Safari 的 keyCode 229）Enter 不发送；`/` 斜杠菜单保留（引用知识库 / 文件库 / 上传 / 使用技能）。
- 左侧“+”：上传文件、从文件库选择、引用知识库、使用技能（仅当有已启用技能；选择后把“使用技能「名称」：”写进消息开头，助手通过 `skill_load` 加载）。手机（<640px）为底部抽屉（`BottomSheet`）。
- 文件：拖放到页面任意位置（首页/对话页的 `dropScope`，带虚线覆盖层；页面外拖放被拦截以免浏览器打开文件）、从剪贴板粘贴图片（剪贴板里同时有文字时按文字粘贴）、多文件并行上传（最多 3 路，每条消息最多 10 个）。上传用 XHR → `POST /api/files`（带 `spaceId` / `projectId` / `conversationId`，`Idempotency-Key` = 附件 key），逐文件进度；失败显示原因与“重试”，发送被禁用直到重试成功或移除；单文件上限与服务端一致（100MB）。
- 附件卡片（`components/file/FileTile.tsx`）：按类型着色的图标（pdf / 文档 / 表格 / 演示 / 图片 / 代码 / 压缩包 / 文本，颜色 token `--kind-*`）、图片缩略图（本地 blob → 发送后用服务端下载地址）、中间省略的文件名（始终保留扩展名）、类型 · 大小、状态（上传中 N% / 就绪 / 失败 + 重试）、移除。发送后用户气泡显示同样的卡片（大小/类型由 `GET /files/:id` 懒加载并缓存），点击在右侧打开预览；助手成果卡片（`FileCard`）同一视觉语言，加版本徽标与下载。
- 右侧模型切换（`ModelSwitcher`）：按供应商分组；能力徽标（图片 / 工具 / 推理，上下文长度）；有 ≥2 个思考档位的模型显示“思考强度”分段控件；blocked 模型禁用并写出原因；测试模型只显示一次“测试模型（非真实 AI）”。`GET /api/models` 新旧形状都接受（`provider` 字符串或 `{id,name}`、`providerName`、`capabilities` 数组或对象、`contextWindow`）。选择即保存为用户默认（localStorage `wr.model.default.v1`）；新对话创建时随 `POST /conversations {modelId, thinkingLevel}` 持久化为该对话的模型。**已有对话中途换模型**：向 `PATCH /conversations/:s/:id {modelId, thinkingLevel}` 请求，再读取对话详情，以服务端实际结果为准；服务端不支持时，切换器保持在实际使用的模型并显示说明（该选择仍成为新对话默认）。见 `docs/requests/chatui.md`。
- 首页手机布局：问候居中，输入框贴底（含安全区）。

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
| `components/DotMatrix.tsx` | 点阵背景 |
| `components/file/*` | `FileTile` `RefTile` `FileThumb` `MiddleEllipsis` `kinds`（文件类型与着色） |
| `features/composer/*` | `Composer` `AttachMenu` `ModelSwitcher` `models`（模型列表归一化与默认）`useAttachments` `upload`（XHR 进度）`fileMeta` |
| `features/chat/*` | `pickers`（文件/知识库/技能选择）`Attachments`（气泡附件卡）`Messages`（用户/助手消息、分支切换器）`Steps`（步骤链）`Cards`（文件卡、审批卡、核对卡、引用）`status`（状态文案与图标）`model`（视图模型）`useConversation`（SSE、详情、更早消息、提交跟踪） |
| `features/markdown/Markdown.tsx` | 流式与历史共用的 Markdown 渲染 |
| `features/preview/*` | `PreviewPanel` + `viewers/{FrameViewer,TextViewer,ImageViewer}` |
| `features/work/WorkPanel.tsx` | 子任务（后台任务 + 子 Agent）/ 终端（隔离说明、执行记录、目录）/ 浏览器（实时会话 + 抓取记录） |
| `features/work/live.tsx` | `JobCard` `JobChip`（消息内状态 + 取消）`BrowserSessionView`（观看 / 接管 / 点击截图操作 / 输入 / 导航 / 交还；接管权限 = 服务端 `canControl`，与预览一致） |
| `features/handoff/Handoff.tsx` | 对话交接摘要对话框、项目页“对话与待处理”汇总 |
| `components/shell/Notifications.tsx` | 侧栏铃铛：站内通知（状态、打开任务、成果文件、已读） |
| `features/stats/*` | 统计页（见 §10）：`FilterBar` `Kpis` `Heat`（日历热力图/点阵/华夫图，自绘 SVG）`RechartsPanels`（面积/环形/直方图，惰性块）`Panels`（工具排行/知识/大上下文/下钻表）`parts`（卡片、提示层、色板）`format`（zh-CN 格式化） |
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
| 统计页 | `StatsPage` 页面块（自绘图表，~44KB）+ `RechartsPanels`（Recharts，~417KB，与数据请求并行下载） | 仅 /stats 请求；首页与对话不含 |
| 其余页面 | 每页一个 chunk（`KnowledgePage`、`FilesPage`、`FileDetailPage` …） | 4–12KB |

e2e 断言：首页加载完成时没有请求任何 Streamdown/shiki/KaTeX/Recharts/预览/工作面板块，也没有任何外部主机请求。

## 8. 浏览器验证（e2e）

Playwright 已预装（脚本通过 `createRequire` 加载，**不要** `playwright install`）。每个脚本自己启动集成服务（`server/src/main.ts`，`WORKROOM_FIXTURE_TOOLS=1` 以启用测试审批工具），数据目录 `data/dev-B/e2e-<port>`（每次清空），端口 core-loop 8802、states 8812；设 `E2E_BASE=http://…` 可改为使用已运行的服务。

```bash
npm run -w web build
npm run -w web e2e           # 依次跑 core-loop / states / pages / round2 / round3-runtime / round3-knowledge / round3-org / integrator-m02c / round4-chat
node web/e2e/round2.mjs      # 或单独跑某一个
```

- `web/e2e/core-loop.mjs`：注册 → 首页（无重型块、无外部请求、一个输入框）→ 发消息（`[[call file_create …]]`）→ 步骤链 + 文件卡 → 右侧预览打开/关闭 → 审批卡（`wr_fixture_approval`）批准 → 运行中插话反馈（已接收→已应用/已回复）→ `file_revise` 生成 v2 卡片 → 编辑产生分支 + 切换器回到原对话 → 文件库 v1/v2 与来源 → 知识库上传后“处理中→可检索”+ 检索测试 → 1366×768（预览、侧栏收起、无横向溢出）→ 390×844（导航抽屉、预览抽屉、无横向滚动）→ reduced-motion（系统与应用内开关）→ 全程无外部请求、字体仅来自 `/assets`。结果写入 `artifacts/screenshots/core-loop.results.json`。
- `web/e2e/pages.mjs`（端口 8822）：自动化（预览、无效 cron、立即运行、再次运行、编辑、失败记录、取消、站内通知含成果与任务链接）、组织管理（邀请→加入、成员看不到管理入口且服务端 403、停用即撤销会话、部门、会话、渠道、预算、审计与 CSV）、能力（技能固定/升级/回滚/停用、从任务整理→验证→发布、连接重新检查与个人启用）。结果 `pages.results.json`。
- `web/e2e/round2.mjs`（端口 8832 + 本地测试网页 8834，`WORKROOM_URL_ALLOWLIST` 只放行它）：M01-A 同一输入框三类请求、引用失效提示、单条消息结果、待核对卡片、终端真实执行、网页抓取、实时浏览器接管与点击、后台任务取消、知识库失败重试、检索调试与评估、编辑者交接摘要 / 查看者只读且服务端拒绝。结果 `round2.results.json`。
- `web/e2e/round3-runtime.mjs`（8842）：设置页新建助手并在首页选择（M03-A）、子 Agent 卡片与轮数上限（M03-B / M02-C）、模型与路由记录（M15-A）、运行中关闭浏览器→另一设备重新登录看到终态与成果（M02-A）、SIGKILL 服务进程→重启后运行恢复完成、发送中断的外部写显示待核对（M02-B）。
- `web/e2e/round3-knowledge.mjs`（8852）：知识库范围（个人/项目/部门/企业）与成员可见性（M07-A）、治理字段与下架/替换（M07-B）、无证据/索引未就绪/无权限/模型错误四种文案（M07-C）、PDF 第 2 页与章节/段落定位（M06-B）、删除/下架/无权访问的失效提示（M06-C）、文件页存储状态与知识状态分开且需显式加入（M08-C）、记忆来源/范围/编辑/删除与纠正前后（M10-A/C）。
- `web/e2e/round3-org.mjs`（8862，另起本地网页 8864 与 HTTP MCP 测试服务 8865）：连接“需要重新连接/凭据被拒绝/无权限”与重连（M04-A）、三类技能与依赖/授权（M05-A）、查看者只能观看浏览器且服务端拒绝接管（M11-B）、外部只读分享创建/未登录打开/撤销（M09-C）、按对话 ID 排查且参数中的密钥被脱敏（M18-B）、会话撤销/停用/移除后界面回到登录（M16-A）。
- `web/e2e/round4-chat.mjs`（8863，`WORKROOM_RT_RETRY_MAX=0`）：点阵（30fps 节流、单帧耗时、主线程占比、DPR、不覆盖消息列、指针反应、隐藏标签页/离屏 0 次 rAF、系统与应用内减少动画为静态且无 rAF、设置开关、深浅主题）、输入框（+ 菜单与技能、拖放覆盖层与多文件、粘贴图片、进度、失败重试、移除、Enter/Shift+Enter/IME）、模型切换（分组/徽标/blocked/测试模型标注/思考档位/用户默认/新对话持久化/对话内切换如实反映服务端/新 API 形状）、气泡卡片与预览、成果卡片、390/1366/1440 布局与截图（`round4-*.png`）、全程无外部请求。结果 `round4-chat.results.json`。
- 设 `E2E_BASE` 使用外部服务时，需要杀进程/重启的检查会直接报错失败，而不会空跑通过。
- `web/e2e/states.mjs`：附件标签 + 斜杠菜单引用知识库（同一输入框）→ 失败（原因 + 继续）→ 运行中 → 取消 → 委派子 Agent 后工作面板（子任务/终端/浏览器）→ 项目页成员角色 → 搜索/能力/自动化/统计/记忆/管理页不出错 → 深色主题。结果写入 `artifacts/screenshots/states.results.json`。

截图（deviceScaleFactor 2）在 `artifacts/screenshots/`，文件名前缀为视口宽度（`1440-*`、`1366-*`、`390-*`）。

## 9. e2e 判定规则

只有断言本身或紧挨着的 `waitForSelector/waitForFunction`（失败即抛出）能证明的检查才写成通过；功能缺失（接口 404、显示“暂不可用”）一律判为失败，不设“未连接也算通过”的分支。

## 10. 统计页（`web/src/pages/StatsPage.tsx`、`web/src/features/stats/*`，round 4）

页面结构：筛选栏（范围 / 时间预设 / 自定义日期 / 粒度，状态在 URL 查询串里，可分享、刷新不丢）→ 14 个 KPI 卡（数值 + 较上期变化 + 迷你趋势）→ 日历热力图 → 活跃时段点阵 + 结果占比华夫图 → 模型/供应商/路由堆叠面积 + 份额环形图 → 工具排行 + 延迟直方图 → 知识命中 / 大上下文失败 / 自动化与文件 → 明细下钻表（对话 / 成员 / 项目 / 最近失败）。每个图表卡右上角有“CSV”下载（服务端按权限校验并记审计）。数据口径见 `docs/stats.md`。

**图表方案与理由**

| 选项 | 结论 |
|---|---|
| Apache ECharts（日历、热力图、散点内置） | 不采用：全量约 1MB，按需引入后仍需 400KB+，且自带一套主题系统，深色/无障碍要再适配；对话与首页包体积要求严格 |
| Recharts（仓库已有依赖，已是统计页惰性块） | 用于**需要坐标轴/插值/堆叠的三类图**：堆叠面积、环形图、延迟直方图（含 P50/P95 参考线）。独立惰性块 `RechartsPanels`，只在统计页加载 |
| 自绘 SVG/HTML | 用于**Recharts 没有的图**：GitHub 式日历热力图（365 格）、星期×小时点阵（圆点大小 + 颜色同时编码数值）、华夫图（100 点）、迷你趋势线、工具横向条。零依赖、可直接用设计令牌、每个标记都带 `data-*` 便于 e2e，键盘与读屏文字由 `role="img"` + `aria-label` 提供 |

结果：新增依赖 0；首页、对话包体不变（`index-*.js` 不含 Recharts，e2e 断言 `/` 与对话页的资源请求里没有 `StatsPage` / `RechartsPanels`，进入 /stats 后才出现）。`Dashboard.tsx` 在模块加载时就并行触发 Recharts 块下载，所以不会等数据回来再开始下载。

**色板（已用 dataviz 校验脚本验证）**：分类色取参考色板 8 个槽位，固定顺序、按实体而非排名分配；`validate_palette.js --mode light/dark` 均 ALL PASS（相邻 CVD ΔE ≥ 9.1 / 8.4，正常视觉 ΔE ≥ 19.3，深色全部 ≥ 3:1）。浅色下 3 个槽位对比度 < 3:1，按规范必须有“救济”：每个系列都有文字图例（名称 + 数值 + 占比）、悬停提示与 CSV。结果状态用固定状态色（成功绿、失败红、超时橙、待审批黄、进行中蓝、已取消灰），圆点图旁始终有带数字的文字图例；热力/点阵用单色相蓝色 5 级序列（分位分级，图例标阈值）。深色是单独选择的阶（`stats.css` 在 `:root[data-theme="dark"]` 下重定义），不是自动反转。

**交互与无障碍**：每个标记都有悬停提示（日期/时段/结果/模型/工具），提示层随指针并避开边缘；图例常驻；区块用 `section[aria-label]`；趋势线、热力图、点阵、面积、环形、直方图都有 `role="img"` 与汇总性 `aria-label`；颜色之外的冗余编码：点阵大小、华夫图分块位置 + 文字、模拟系列的虚线与“模拟”标签。`prefers-reduced-motion` 下无动画（图表本就关闭动画）。

**诚实标注**：测试模型（fixture）请求的 Token / 耗时标“模拟”徽标，不计入真实数字；费用在只有测试模型时显示“模拟”而不是 $0；演示组织（`ops_demo_orgs`）整页顶部有“演示数据”横幅。空状态说明原因（“此范围内没有记录；该范围之外有 N 条记录（日期）”，各图卡也有自己的空状态）；加载时显示骨架；无权限的范围在下拉里不出现，直接访问 URL 得到 403 错误态。

**响应式**：≥1280 为 7 列 KPI；1024–1279 为 4 列；<1024 双列/单列，图表卡单列堆叠；日历与点阵图在卡片内部横向滚动（390px 页面本身无横向滚动，e2e 断言）。数字用 `Intl.NumberFormat("zh-CN")`：万/亿缩写、千分位、百分比、毫秒/秒/分钟、USD。

**e2e**：`web/e2e/round4-stats.mjs`（端口 8864、数据目录 `data/dev-stats/e2e`，自行构建到 `data/dev-stats/web-dist`）：用 `scripts/seed-demo.mjs` 生成演示组织，检查 14 个 KPI 与 API 相等、日历 365 格、点阵 168 点、华夫图 100 点、面积/环形/直方图元素、工具条、各类提示、CSV 下载（内容与 API 一致）、筛选（预设/自定义/粒度/范围）、骨架、真实组织的“模拟”标注与下钻链接、成员 403 与空状态、懒加载块、1366/1440/390 与深色截图（`artifacts/screenshots/round4-stats-*.png`）。

## 第 5 轮补充（详见 design-guidelines.md）
- 首页只有问候、输入框和 3 个起步建议（只填入输入框，不自动发送）；不再显示品牌副标题（`brand.tagline` 仍由 `/api/health` 返回）。
- 浮层：Menu/Popover 顶部留 64px 避让、超出可视高度时自身滚动、动画结束后不透明；Dialog/Sheet/BottomSheet 关闭后把焦点还给打开它的控件（控件已不在时回到输入框）；菜单内单选用 `MenuRadioGroup/MenuRadioItem`（方向键可达）。
- `variant="danger"` 在两种主题下都 ≥4.5:1，调用处不再自行覆盖颜色。
