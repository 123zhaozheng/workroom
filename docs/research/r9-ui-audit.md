# R9 UI 交互调研：DEEIX-Chat 对照 Workroom

调研日期 2026-11-11，只读。参考仓库 DEEIX-Chat（commit a395739，**Apache-2.0**）。本文只提炼交互模式，不复制代码、素材、品牌与文案；若将来移植实质代码需保留版权声明并在 NOTICE 说明改动。DEEIX 路径省略前缀 `apps/web/features/`，Workroom 省略 `web/src/`。

## 1. DEEIX 交互模型

| 功能 | 交互与参数 | 依赖 |
|---|---|---|
| 侧栏会话行 `shell/components/navigation/sidebar-conversation-item.tsx` | 行高 h-8；"…"按钮默认 opacity-0，行 hover、按钮 focus-visible、菜单打开时变 opacity-100，过渡 150ms（:237）。hover/打开/运行中时链接右内边距由 pr-2 增至 pr-9，给按钮让位（:207）。运行指示（旋转 1.6s linear）hover 时淡出，让位给"…"（:96-103）。菜单 `modal={false}`，菜单项 `onSelect` 先 preventDefault 再执行（:227-259）。菜单项：星标、重命名、标签、移到项目、分享/导出、归档、删除（:249-311）。重命名就地输入：Enter 提交、Esc 取消、blur 提交（:152-162）。 | motion（仅转移态）、radix dropdown |
| 列表 FLIP `shell/hooks/use-shell-sidebar-list-flip.ts` | useLayoutEffect 里按 `data-sidebar-conversation-id` 取所有行 rect，与上次 rect（Map）求 deltaY，\|Δ\|<0.5px 忽略（:47），用 **WAAPI** `node.animate([translateY(Δ)→0], {280ms, cubic-bezier(.16,1,.3,1)})`（:55-58）。`signature` 变化才重算，`excludeKey` 排除正在操作的行。 | 无，纯 WAAPI |
| 跨区转移 `shell/model/sidebar-motion.ts` | 星标/最近之间移动用 motion `layout="position"`+`layoutId`，0.34s `[.16,1,.3,1]`（sidebar-conversation-item.tsx:326-335）；溢出行 0.24s。 | motion layoutId |
| 项目树 `nav-projects.tsx` | 展开用 height/opacity/y 6px + 遮罩渐变，0.26s `[.22,1,.36,1]`（:100,:861-870）；项目行动作 hover/focus/菜单开时显示，**移动端常显**（:760）；dnd-kit 拖拽排序，含 KeyboardSensor（:471-475）与失败 toast（:566-597）。 | @dnd-kit、motion |
| 搜索 `navigation-search.tsx` | Cmd/Ctrl+K 全局 keydown，跳过 IME 组合（shell/hooks/use-shell-navigation-search.ts:264-282）。cmdk 对话框，`shouldFilter:false`（服务端过滤）、`loop:true`、输入 maxLength 200、防抖 250ms（:22）。结果按日期分组；每行标题+项目徽标+归档图标+时间，hover/选中时时间让位给箭头（:92-99）。右侧预览窗格：仅桌面且有 hover 输入时可用，聚焦/pointermove 切换预览，预览再防抖 240ms 拉取消息，可折叠且持久化到 localStorage，宽度 200ms 过渡（:274-279,:340）。底部显示 ↑↓/Enter 提示。状态：加载、失败+重试、空、加载更多失败+重试；IntersectionObserver 哨兵(rootMargin 120px)分页。 | cmdk、streamdown 渲染预览 |
| 位置轨 `chat/components/sections/chat-message-position-rail.tsx` | 每个"用户提问+其后回复"为一轮，一轮一根短线（h-0.5，宽 0.6rem）（:165-212）。当前轮=可见消息所属轮，线宽×2、不透明度 100%，相邻轮×1.5（:71-80,:339-349）；hover 时以悬停轮为中心。悬停预览：portal 到 body，fixed 定位，贴轨右侧 8px，按边界 clamp，150ms 淡入（:96-107）；预览含提问一行+回复三行截断。点击 `scrollToMessage(smooth, 边距16)`（:364）。轮数≤1 不渲染；仅 lg 以上显示；ResizeObserver 判溢出并把当前线居中（:284-301）。`React.memo` 比较：非流式消息忽略内容变化（:389-411）。轨道按钮 `tabIndex=-1`、`aria-label`=提问，键盘用户不可达（:366）。 | @shadcn/react message-scroller（可见集合来自该包，仓库内无实现）、motion |
| 文件库 `files/` | 左列表右预览；搜索防抖、每页 100（hooks/use-file-page.ts:38）；处理中文件每 2s 轮询状态（:414-417）；失效事件触发后台静默刷新。 | 无特别依赖 |
| 知识库 `knowledge-bases/` | 并发上传后加入库；处理中文件轮询状态；预览对话框（hooks/use-knowledge-base-page.ts:695-773）。 | 无特别依赖 |
| 首登引导 `auth/components/initial-security-guard.tsx` | 居中 820×430 两栏对话框（md 起），背景 `bg-background/20 + backdrop-blur-[2px]`，入场 200ms fade+zoom-in-95，步骤切换 200ms fade+slide-in-from-right-2（:262,:279）。左栏轮播（每 4.2s，进度条 scaleX linear 4.2s，文案 220ms 淡入）（:123-155,:210-214）；右栏圆点步骤指示（:275）。6 步：欢迎+语言 → 账号(用户名/显示名/改密) → 2FA(可跳过) → 主题预设 → 时区+明暗 → 完成(恢复码)。完成调 `POST /api/v1/me/onboarding/complete`，由服务端 `initialSecurityRequired` 决定是否弹出，跨设备不重复（hooks/use-auth-initial-security.ts:75-84,324）。 | motion、自带 Onboarding 组件 |

## 2. Workroom 现状与缺口

| 领域 | 现有 | 缺口 |
|---|---|---|
| 侧栏 `components/shell/Sidebar.tsx` | NavLink 行 h-8，仅标题+RunDot（:117-127）；列表 8s 轮询（:23）；项目只读列表（:100） | 无"…"菜单、无重命名/归档/删除/星标/导出入口，无 FLIP |
| 搜索 `pages/SearchPage.tsx` | 独立页，250ms 防抖，并行查 `/conversations?q=`、`/files?q=`、`/kb/search`，分三栏（:18-35） | 无 Cmd+K，无键盘导航，无预览，无分组/分页 |
| 对话 `pages/ChatPage.tsx` `features/chat/Messages.tsx` | 滚动容器 :359；用户消息带 `data-entry-id`（Messages.tsx:55）；无虚拟化，有"加载更早" | 无位置轨 |
| 文件/知识库 | FilesPage 带 q/origin/project 过滤；KnowledgePage 对文档 2s 轮询（:190）；FileDetailPage | 无 hover 预览与后台失效事件 |
| 设置 `pages/SettingsPage.tsx` | 主题、减少动画、点阵（:79-87），均为 localStorage（lib/prefs.tsx:1,14-15） | **没有 2FA 设置界面**（web 全局无 `/me/2fa` 调用，仅登录输入 totp） |
| 认证 `pages/AuthPage.tsx` | 登录/注册/OIDC/邀请码 | 无首登引导 |
| 动画基础 | motion 14.10.1 已在用，`LazyMotion domAnimation`（App.tsx:3）；styles.css 已有 reduced-motion 全局归零（:175-186） | — |

## 3. 后端能力（server/src）

| 能力 | 现状 | 依据 |
|---|---|---|
| 对话搜索 | 仅 **title LIKE**，无消息正文检索、无 FTS | runtime/service.ts:276-296 |
| 文件搜索 | 仅文件名 LIKE | files/service.ts:324 |
| 知识检索 | FTS5 trigram+BM25，POST /kb/search | knowledge/module.ts:69 |
| 对话改名/归档 | `PATCH /conversations/:s/:id` 接受 title、archived | runtime/routes.ts:62-69 |
| 星标/标签/删除/导出 | **均不存在**（rt_conversations 无相应列；无 DELETE、无 export 路由） | runtime/module.ts:18-28 |
| 分享 | `POST /shares` 支持 kind=conversation | identity/routes.ts:677 |
| 2FA | setup/enable/disable 完备；`/me` 返回 `totpEnabled` | identity/routes.ts:225-262,30 |
| 用户档案 | id_users 无语言、时区、头像、引导完成字段；主题等仅客户端 | identity/module.ts:19,42-46 |

## 4. 可用 CSS/WAAPI 替代的部分（不增依赖）

- FLIP：照搬 WAAPI 方案即可（约 40 行 hook），不需要 motion layoutId。
- "…"hover/focus 显隐：Tailwind `group-hover`、`focus-visible`、`data-[state=open]`，触屏（`@media (hover:none)`）常显。
- 位置轨：纯 CSS 过渡 + 一个 IntersectionObserver 观察用户消息；预览用 fixed 定位；轮数少，无需虚拟化；轨道应可键盘聚焦（DEEIX 缺这点）。
- 搜索对话框：Radix Dialog（已有）+ 手写 listbox（`role=listbox`/`aria-activedescendant`），不引入 cmdk；分页哨兵用 IntersectionObserver。
- 引导步骤切换：`wr-fade-in`、`wr-slide-in-right` 已在 styles.css:205-235。
- 不建议加：@dnd-kit（项目排序后端无 order 字段）、cmdk。

## 5. 建议的 Workroom 首登引导（仅用真实能力）

| # | 步骤 | 内容 | 持久化 |
|---|---|---|---|
| 1 | 欢迎 | 品牌、简短说明、显示姓名（只读，取 `me.name`） | — |
| 2 | 外观 | 主题三选、减少动画、点阵背景（即时预览） | 客户端 prefs |
| 3 | 两步验证（可跳过） | 调 `/me/2fa/setup`+`enable`；需先补 Settings 的 2FA 界面，二者共用组件。注意 enable 会撤销其他会话（identity/routes.ts:240） | 服务端已有 |
| 4 | 默认模型（可选） | 复用 ModelPicker；现状无用户级默认，可先省略 | 暂无 |
| 5 | 完成 | 指向"新对话"、Ctrl+K、文件库 | 写完成标记 |

不做：语言（仅中文）、时区、头像、用户名、改密（本系统无对应字段/流程）。

**完成标记**：新增 identity 迁移 v5 `ALTER TABLE id_users ADD COLUMN onboarded_at TEXT`；新增 `POST /me/onboarding/complete`，并在 `publicPrincipal` 返回 `onboarded: boolean`（identity/routes.ts:30）。前端在 `RequireAuth` 内读 `me.onboarded===false` 时弹出，跨设备不重复。受邀成员/OIDC 用户同样适用；存量用户迁移时应批量置位，避免全员被打断。离线时不弹，不用 localStorage 兜底。

## 6. 落地优先级

1. 侧栏"…"菜单 + 重命名/归档（后端已有）+ FLIP：低成本。星标/标签/删除/导出需先加后端，建议单独立项。
2. Cmd+K 搜索对话框（复用现有三个接口）；消息正文搜索需后端 FTS，预览窗格暂缓，或仅显示该对话最近消息（现有 entries 接口）。
3. 位置轨：纯前端，数据来自现有 turns。
4. 首登引导：先补 2FA 设置界面与 `onboarded_at`。
