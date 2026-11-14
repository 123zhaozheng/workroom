# 专家（Experts，第 17 轮）：调研结论与设计

目标：左侧栏新增「专家」页，形态参考腾讯 WorkBuddy。专家就是原来的「助手」，所以**不再内置助手**；专家与技能、连接器（MCP）走同一套「上传 → 自动检查 → 审查员审核 → 发布 → 安装」生命周期与权限管控；专家**解耦挂载**技能（技能更新对专家无感）；专家可指定默认模型，会话中可临时改；会话中可以直接 `@专家`。审查角色已统一为「审查员」，见 `docs/rbac.md`「审查员统一」。

## 1. 调研结论

只记录真实抓取到的内容；抓不到的标「未验证」。

| 产品 | 专家/智能体形态 | 挂载与更新 | 模型 | 调用 | 权限与审核 |
|---|---|---|---|---|---|
| **腾讯 WorkBuddy**（[官方文档](https://cloud.tencent.com/document/product/1831/134393)） | 专家 = 人设 + 方法论 + 工具链的角色切换；另有「专家团」，团长拆解任务并行执行。卡片：能力介绍、擅长领域、任务示例；按行业分类浏览。创建：头像与显示名称、人设身份、擅长领域（含不做什么）、提示词；**名称创建后不可改** | 专家本身不主动取得系统权限，配了 Skill / MCP 才会在授权下访问外部服务；依赖的连接器未连接时用到才弹连接引导，授权后任务自动继续 | 官方未说明（未验证） | 专家中心点「召唤」进入对话；对话里从最近使用列表搜索或置顶；专家团会话换专家需新开对话；`@` 调用专家未找到依据 | 创建的专家供自己或团队用，上架市场需另行打包提交 |
| WorkBuddy 市场专家包（第三方转述 [AI Stack Nav](https://aistacknav.com)，引 open.workbuddy.cn，**官方页未直接抓到**） | plugin.json：`expertType`(agent/team)、`displayName`、`profession`、`displayDescription`、`avatar`、`categoryId`、`defaultInitPrompt`、`tags`、`quickPrompts`（固定三条） | 开发者不能给 Agent 随意加系统工具，需要外部能力时声明 MCP / Connector 依赖 | — | — | — |
| **腾讯 CodeBuddy 子代理**（[文档](https://www.codebuddy.ai/docs/zh/cli/sub-agents)、[设置](https://www.codebuddy.cn/docs/cli/settings)） | name、description、tools（省略=继承全部）、model（可填 inherit）、permissionMode、skills、mcpServers、disallowedTools、effort、maxTurns… | skills / mcpServers 按名引用 | 解析链：环境变量 > 调用入参 > 项目设置 > 用户设置 > 内置声明 > 主模型 | — | 项目级优先于用户级 |
| **CodeBuddy 企业版 Manifest v2.0**（[文档](https://cloud.tencent.com/document/product/1831/139534)） | metadata 里有 welcome_message、suggested_questions | skills / experts 用 `type(builtin/custom/authorized) + id + version` 引用，**version 缺省为 latest（自动用最新版）**；mcp_servers 不允许明文凭据 | — | — | — |
| **Coze 智能体**（[创建 API](https://docs.coze.cn/developer_guides_create_bot)、[开场白](https://docs.coze.cn/guides_opening_dialog)） | 名称 1–20 字、描述、头像；人设与回复逻辑（≤20000 字）；开场白（Markdown，支持 `{{user_name}}`）与预置问题（默认随机显示 3 条）；回复后问题建议 | 插件 / 工作流 / 知识库在编排页添加，模型按人设自动判断何时调用；**插件和工作流可保存发布版本，智能体可指定版本，避免更新影响线上** | 有模型选择与温度等参数 | 新版 Agent 输入框 `+` 或 `@` 选插件能力（[文档](https://docs.coze.cn/plugin)）；`@` 另一个 Bot 未找到依据 | 渠道：商店 / 社交应用 / API；部分渠道首次发布需人工审核 1–7 个工作日（[FAQ](https://docs.coze.cn/guides_publish_faq)）；有发布历史可还原 |
| **ChatGPT GPTs**（[官方](https://help.openai.com/en/articles/8554397-creating-and-editing-gpts)） | Name / Description / Instructions / Conversation starters / Knowledge（≤20 文件）/ Capabilities / Actions；**推荐模型只是建议，用户可切换** | Actions 用 OpenAPI + 鉴权；自动存草稿，点 Update 生效，有版本历史 | 推荐模型 | 输入 `@` 选择 GPT，保留当前上下文（网页端；[FAQ](https://help.openai.com/en/articles/8554407-gpts-in-chatgpt)） | 分享：特定人 / 工作区 / 链接 / GPT Store；OpenAI 已计划淘汰自定义 GPT（标准下线日 2026-12-11，个人账号不能新建） |
| **Claude Projects / Skills**（[Skills 概述](https://claude.com/docs/skills/overview)） | Projects：名称、描述、项目指令、知识库；Team/Enterprise 可选私有或全组织可见 | **Skills 与 Projects 解耦**：Skill 是独立 SKILL.md 目录，账号级开关，按 description 自动加载或 `/` 手选；没有「挂到某个项目」的机制 | 项目级模型：未验证 | `/` 选技能 | Can view / Can edit |
| **Dify / Cherry Studio** | Dify：Model、Tools（插件/自定义 API/工作流/MCP）分开配；集成按类别设更新策略（关闭 / 仅补丁 / 始终最新）。Cherry：助手有基础（默认模型）、模型参数、提示词、知识库、MCP 五个标签页 | Dify 有更新策略；Cherry 的技能/MCP 更新是否自动生效未找到依据 | Cherry：对话页可临时切换模型，未设置则用全局默认 | — | — |

### 采纳与取舍

1. **分层**：专家管「角色」，技能管「方法」，连接器（MCP）管「工具」，知识库管「资料」。与 WorkBuddy 官方区分一致。
2. **挂载 = 引用，不是快照**：参考 CodeBuddy Manifest（version 缺省 latest）、Dify 的「始终最新」、Claude Skills 与 Projects 解耦。专家只存技能 id；运行时才解析「该技能当前已发布版本」。不采用 Coze 的「专家固定技能版本」作为默认（用户明确要求「技能更新对专家无感」）；固定版本留作将来可选项（`pin`，本轮不做）。
3. **卡片字段**：一句话简介（能力介绍）+ 分类标签 + 示例问题（WorkBuddy 的 quickPrompts / Coze 预置问题 / GPT conversation starters）+ 开场白（Coze / Manifest welcome_message）。
4. **模型**：专家的默认模型是**默认值，不是强制**（GPTs「推荐模型」、Cherry「对话页临时切换」、CodeBuddy 解析链「入参 > 设置 > 声明」）；用户在会话里显式选的模型优先。
5. **调用入口**三种：专家页「开始对话」（WorkBuddy 召唤）、新建会话时选专家、会话输入框 `@专家`（GPTs）。`@` 只影响**这一条消息**（GPTs 语义：保留上下文）。
6. **名称发布后不可改**（WorkBuddy）：本轮不强制，改名走重新审查；标题变化会让存量 `@` 提及仍按 id 解析，不受影响。
7. **审核**：个人专家自己用免审；分享到部门/组织必须审查员通过（Coze 商店/WorkBuddy 市场同理）。更新要重新审查，审查前别人仍用旧的已发布版本。

## 2. 数据模型（`ex_*` 表，tools 模块迁移，不动旧表）

`ex_experts`（一行 = 一个专家；字段即**草稿**，作者自己运行用草稿）

| 字段 | 说明 |
|---|---|
| `id` | `exp_…`；旧助手迁移时沿用原 `ast_…` id（旧会话绑定的 `assistantId` 仍有效） |
| `org_id` `owner_user_id` | 租户与作者 |
| `name` `avatar` `tagline` `description` | 名称（≤40）、头像（emoji 或 lucide 图标名或图片 URL）、一句话简介（≤80）、详细说明（≤4000） |
| `category` `tags` | 分类（预置：办公效率/研发/数据分析/写作/设计/运营/法务财务/通用，也可自定义）与标签（≤8） |
| `instructions` | 系统指令（角色设定，≤8000） |
| `opening` `starters` | 开场白（≤500）与示例问题（≤6 条，每条 ≤80） |
| `default_model` | `{provider, modelId}` 或 NULL（NULL = 跟随会话） |
| `skills` | `[{ skillId }]`，**只存 id，不存版本、不存内容** |
| `connectors` | `[{ connectorId }]` 可选，MCP 连接器引用（同样只存 id） |
| `knowledge` | `{ kbIds: [] }` |
| `tools` | NULL = 默认工具集；数组 = 只启用这些工具（沿用助手的白名单语义） |
| `scope` `scope_ref` | `personal` / `department` / `org`（可见范围；部门带 `scope_ref`） |
| `published_version_no` `latest_version_no` | 已发布版本号（给别人用）；已提交过的最新版本号 |
| `listed` `unpublished_reason` | 是否上架；下架原因 |
| `source` `legacy_updated_at` | `user` / `assistant`（由旧助手同步而来，与 `rt_assistants` 保持一致） |
| `created_at` `updated_at` `archived_at` | |

`ex_versions`：不可变（触发器禁止 UPDATE）。提交审查时把上面的**配置字段**拍一份快照（含技能 **id 引用**，仍不含技能内容），版本号自增。审查员看到的是这份快照及与上一已发布版本的字段差异。

`ex_installs(expert_id, user_id, enabled, installed_at)`：「添加到我的专家」。决定 `@` 弹层与「我的专家」里出现什么；**可见即可用**——任何能看到已发布专家的人都能在新会话里选它，安装只影响列表。

提交 / 审查 / 事件复用 `market_submissions`、`market_events`（`kind = 'expert'`），不另建审查表。

### 状态

| 展示状态 | 条件 |
|---|---|
| 草稿 | 从未发布，没有未处理的提交 |
| 待审查 | 有 `pending_review` 提交（已发布的专家再次提交更新时同时显示「已发布 · 有更新待审」，别人仍用旧版） |
| 已发布 | `published_version_no` 有值且 `listed = 1` |
| 已下架 | `listed = 0`（市场管理员下架，理由必填；版本保留） |

`scope = personal` 且组织策略允许时，专家**不需要审查即可自用**（与个人技能默认免审一致）；提交到部门/组织走审查。

## 3. 生命周期与权限（与技能 / MCP 同一套）

```
创建/编辑(草稿) ─提交(target=personal|department|org)─▶ 自动检查 ──error──▶ checks_failed（改好后重新提交）
                                                        └─ 通过 ─▶ pending_review ─┬ 审查员批准 ─▶ approved ─▶ published(上架)
                                                                                   ├ 驳回 / 要求修改 ─▶ rejected / changes_requested
                                                                                   └ 提交人撤回 ─▶ withdrawn
市场管理员（market.manage）：下架（理由必填）/ 重新上架 / 强制发布（理由必填，留审计，审查员统一）
```

- **自动检查**（`PackageCheckDTO`）：error——名称空、简介空、既没有指令也没有挂载技能、挂载的技能不存在或已删除、默认模型引用格式错误；warn——挂载的技能不在目标范围内可见（运行时会被跳过并提示）、技能当前未上架或没有已批准版本、默认模型当前不可用、指令里出现疑似提示词注入措辞、工具白名单含未知工具、引用了目标范围外的连接器。
- **权限**：新增 `expert.create`（创建/编辑个人专家，普通成员默认有）、`expert.publish`（提交到部门/组织，范围同技能：组织/部门，组织管理员与部门管理员默认有）；**审查沿用统一的 `market.review`**，管理沿用 `market.manage`。提交人不能批准自己的提交（`self_review`），唯一出口是 `market.manage` 附理由强制通过。
- **可见范围**：`personal` 仅作者；`department` 该部门成员（含子部门）；`org` 全员。列表只返回「已上架且你可见」的；作者永远看得到自己的。
- 审查队列、审计（`expert.submit|approve|reject|request_changes|publish|unpublish|force_publish`）、事件时间线全部复用 `Market`；新类型通过 `Market.registerKind("expert", handler)` 接入，审查员**不需要任何新权限**。

## 4. 挂载语义（技能更新对专家无感）

1. 专家只保存 `skillId` 引用。**没有任何地方复制技能版本号或内容。**
2. 每次运行（每条消息的一次 run）解析一次：对每个引用取技能当前行，版本 = `Market.latestUsable(skill)`（= 已发布的最新已批准版本；作者自己的免审个人技能 = 最新版）。所以技能发了 v2，**专家下一次运行**就是 v2，专家本身不需要重新审查、重新发布。
3. 运行时检查（每次，不缓存）：技能存在且未删除；调用者有 `skill.use` 与该技能的 ACL `use`（私有技能别人用不了）；`usable()` 通过（上架、版本已批准、策略允许）。任一不满足 → **跳过该技能并在提示词里明确写出**「挂载技能「x」暂不可用（已下架 / 无权限 / 尚无审核通过的版本），本次已跳过」，不报错、不静默。
4. 被挂载的技能对该专家的会话视为「已安装」：`Skills.active()` 增加会话级的额外来源，所以用户不需要另外安装，且 `/skills/<slug>/`、`skill` 工具、沙箱按需挂载都能用（加载、读取、运行的授权规则不变：技能文件不授予额外权限，运行脚本仍需用户逐版本授权）。
5. 专家挂载的技能**不会**改变用户自己的「我的技能」，也不会因为专家被下架而被卸载。
6. 专家本身的配置（指令、技能引用、模型…）也不进会话快照：会话只记「绑定了专家 id」，提示词段在每次运行时取专家**对该用户生效的配置**（作者 = 草稿，其他人 = 已发布版本快照）。专家发布了新版本，别人的存量会话下一条消息就按新版运行。（旧助手绑定的会话保持原行为：指令在创建时写入，不动态更新。）

## 5. 运行时

- **绑定专家**：新建会话传 `expertId`（兼容旧参数 `assistantId`）。会话记录绑定的专家 id；没有专家 = 默认通用 agent（**不再有内置的「Workroom 助手」**；旧会话里的 `builtin:workroom` 绑定仍可读取）。
- **单条消息 `@专家`**：消息请求带 `expertId`（输入框 `@` 选择后随消息提交）。该专家只对**这一条消息引发的运行**生效（提示词段取该运行的输入里的 `expertId`；没有则取会话绑定的专家；都没有则不注入）。下一条没有 `@` 的消息回到会话绑定的专家（或默认 agent）。聊天里以芯片显示，数据在 `wr.input` 条目的 `expertId` / `expertName`。服务端按 `@名称` 文本解析的备用入口：`parseMentions(text, candidates)` 只匹配「我能用的专家」的名称，最长名称优先，不匹配则当普通文本。
- **注入内容**（提示词段 `expert`，每次运行重算）：`## 专家：名称` + 系统指令 + 挂载技能清单（含 `/skills/<slug>` 路径与一句话描述）+ 被跳过技能及原因。知识库范围、工具白名单按绑定专家在**会话创建时**落到 `wr.assistant`（沿用助手机制；`@` 单条消息只注入指令与技能，不改工具集，避免中途改变权限边界）。
- **模型规则**（从高到低）：① 用户在本会话里**显式选择**过模型（新建时选的或会话里切换的）→ 始终以用户为准，专家的默认模型只是提示；② 否则，专家有默认模型且当前对该用户可用 → 使用专家默认模型（会话创建时直接用；`@` 时在这一条消息前切换并写一条「由专家 X 指定」的通知，下一条没有 `@` 的消息前恢复原模型）；③ 专家默认模型不可用（被限制、已不在列表）→ 回退到用户当前模型，并写一条可见通知（沿用助手的行为，不静默）；④ 都没有 → 用户当前/默认模型。会话顶部可随时临时改模型（等同于「显式选择」）。

## 6. HTTP API（`/api` 下）

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /experts?q&category&scope&mine&installed` | 登录 | 专家广场（已上架且可见）；`mine=1` 我创建的（含草稿/待审） |
| `GET /experts/mentionable` | 登录 | `@` 弹层：我创建的 + 我安装的 + 我可用的组织专家，已排序，含默认模型可用性 |
| `GET /experts/categories` | 登录 | 分类与计数 |
| `POST /experts` | `expert.create` | 创建草稿（个人范围） |
| `GET /experts/:id` | 可见 | 详情（含挂载技能的**当前**状态：名称、当前版本、是否可用及原因） |
| `PATCH /experts/:id` | 作者 | 改草稿；已发布专家的改动在重新审查通过前不影响别人 |
| `DELETE /experts/:id` | 作者或 `market.manage` | 归档 |
| `POST /experts/:id/submit {targetScope,targetRef,note}` | 作者 + `expert.publish`（个人免） | 自动检查 → 待审 |
| `POST /experts/:id/install` · `DELETE …/install` | 可见 | 添加 / 移出「我的专家」 |
| `POST /experts/:id/unpublish {reason}` · `/republish` · `/force-publish {reason}` | `market.manage` | 管理 |
| 审查 | `market.review` | 复用 `GET /market/submissions?kind=expert`、`POST /market/submissions/:id/decision` |
| `POST /conversations` `{expertId}` | 可见 | 新建会话绑定专家（`assistantId` 兼容） |
| `POST /conversations/:spaceId/:id/messages` `{expertId}` | 可见 | 单条消息 `@专家` |
| `/assistants*` | 沿用 | 旧接口保留（团队成员声明仍存放于此）；改动会同步到对应专家，且不再返回内置「Workroom 助手」 |

## 7. 与旧「助手」的迁移

- 旧 `rt_assistants` 表保留（团队成员 `members`、旧会话快照仍用它）。每个未归档助手在首次访问专家 API 时**惰性同步**成一条 `ex_experts`（同 id，`source = 'assistant'`；个人助手 → `personal`，组织助手 → `org` 并直接 `published`/上架，视为已审；`default_model`、`instructions`、`tools`、`knowledge` 原样带过来）。之后旧接口的修改/归档通过 `updated_at` 对比再同步，不会出现两份不一致的数据。
- 「Workroom 助手」（`builtin:workroom`）不再出现在任何列表；已经绑定它的旧会话照常打开、继续运行（按 id 仍可解析）。**没有选专家 = 默认通用 agent**，行为与以前选「Workroom 助手」等价（它本来没有指令、模型与工具限制）。
- 前端：首页助手选择器改为专家选择，「助手」页并入「专家」页（见 `feat/experts-ui`）。

## 8. 未做 / 取舍

- 挂载技能的**固定版本**（`pin`）、专家团（多专家协作）、专家使用统计与评分、名称发布后锁定、连接器的运行时挂载（本轮只存引用并在检查/展示里校验，运行时仍按用户已有的连接器可用性）——留待后续。
- 真实模型下 `@` 切换模型的延迟与缓存影响未测（测试模型下验证了配置切换）。

## 9. 实现对照（`feat/experts-backend`）

| 设计 | 代码 |
|---|---|
| 数据模型 / 迁移 | `server/src/tools/experts.ts`（`ex_experts` `ex_versions` `ex_installs`，tools 迁移 +1600） |
| 参数与 DTO | `shared/experts.ts` |
| API | `server/src/tools/experts-routes.ts`（`/api/experts*`），审查复用 `/api/market/submissions` |
| 生命周期 | `Experts.submit/unpublish/republish/forcePublish` → `Market.openSubmission / directApproveOther / moveSubmissions`；`Market.registerKind("expert", Experts.handler())` |
| 技能解耦挂载 | `Experts.resolveSkills`（每次按当前可用版本解析）；`Skills.active/resolveForUse` 增加会话专家来源（`expertSkillIds`，`pinned = null`） |
| 提示词注入 | `createExpertsExtension`（`expert` 段，每次运行重算）；`Runtime.expertForRun` |
| `@` 解析 | `parseMention`（最长名称、边界）；`Runtime.#resolveMention`（显式 `expertId` 优先，其次文本 `@名称`） |
| 模型规则 | `Runtime.createConversation`、`#applyExpertModel`、`switchModel`；会话状态 `ExpertDoc`（`modelExplicit` / `restoreModel`） |
| 旧助手迁移 | `Experts.syncAssistants`（惰性、幂等）；`AssistantStore.list` 不再返回内置助手 |
| 测试 | `server/test/r17-experts.test.ts`（7 项）、`r17-reviewer-unify.test.ts` |

**与第 5 节的两处具体取舍**：`@` 只改指令、技能与（未显式选择时的）模型，不改工具白名单与知识范围（这两者在会话创建时随绑定专家落到 `wr.assistant`）；专家绑定的会话里，旧助手来源的专家不重复注入指令（旧会话的 agent 已经带着）。

## 10. 界面（`feat/experts-ui`）

| 位置 | 实现 |
|---|---|
| 左侧栏「专家」（在「文件库」下面，lucide `UserRoundCog`） | `web/src/components/shell/Sidebar.tsx`，路由 `/experts` |
| 专家广场：搜索、分类筛选、卡片网格（头像 / 名称 / 分类 · 范围 · 作者 / 简介 / 挂载技能） | `web/src/features/experts/ExpertsPage.tsx` |
| 我的专家：状态（草稿 / 待审查 / 已发布 / 已下架 / 更新待审）、编辑、提交审查、删除 | 同上 + `ExpertEditor.tsx`（全部参数；技能多选、模型选择） |
| 专家详情抽屉：开场白、示例问题（点击即开始并预填）、挂载技能的**当前版本**、模型、开始对话、添加到我的专家 | `ExpertDetail` |
| 审查队列里审专家（类型筛选「专家」，配置 + 字段差异 + 技能引用） | `web/src/features/market/ReviewQueue.tsx` |
| 输入框 `@` 弹层 → 芯片 → 随消息提交 `expertId` | `web/src/features/composer/Composer.tsx` |
| 消息上的专家芯片；会话顶部「专家 · 模型」可切换模型 | `Messages.tsx`、`ExpertHeader.tsx`、`ChatPage.tsx` |
| 首页不再有助手选择器（`@` 取代）；设置里的「助手」页保留，用于团队成员等旧字段 | `HomePage.tsx` |

截图与检查脚本：`web/e2e/r17-experts.mjs`（17 项）。

## 专家头像（bot avatar）

所有专家头像都是 [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar)（MIT）风格：一个柔和的物体剪影 + 两只眼睛，带轻微立体感。渲染器 vendor 在 `shared/bot-avatar/`（含原 `LICENSE`，改动与来源见该目录 `NOTICE.md`），画布挂载在 `web/src/lib/bot-avatar/`。[bloub](https://github.com/jeremy-prt/bloub)（MIT）只作配色/造型参考，没有拷贝代码。

**配置字段** `avatarConfig`（专家配置的一部分，随版本快照保存；`PATCH /experts/:id` 传 `null` 恢复默认）：

```json
{ "shape": "cat", "color": "#f8a01c" }
{ "shape": "cat", "color": "#f8a01c", "eyeColor": "#151515", "eyes": { "x": 50, "y": 43, "spacing": 17, "scale": 1.1 } }
{ "shape": "custom", "color": "#1f7cf2", "custom": { "version": 1, "id": "box", "name": "Box", "body": { "path": "M20 20 H80 V80 H20 Z" }, "eyes": { "x": 50, "y": 46, "spacing": 15, "scale": 1 } } }
```

- `shape`：22 个预设造型（见 `AVATAR_PRESETS`）或 `custom`（自带 open-bot-avatar v1 定义，同样校验）；`color` / `eyeColor`：`#rrggbb`（`#rgb` 会规范化）；`eyes` 微调眼睛，必须落在造型内。未知字段、未知造型、坏颜色一律 400 `invalid_avatar`。
- **默认与兼容**：新专家不传时按专家 id 稳定哈希挑造型和颜色（亮色系），旧数据（没有该字段的行、旧版本快照、从旧助手迁移来的专家、存了坏 JSON 的行）读取时用同一个函数按 id 给默认值，所以同一个专家在任何地方长得一样。旧的文字头像字段 `avatar` 仍保留在数据里，只是不再绘制。
- **动效与性能**：默认 `calm`——身体不动，只眨眼；两次眨眼之间没有任何定时器或帧。专家工作（会话在运行）时切到完整的 `thinking` 动画（30 fps）。屏幕外（IntersectionObserver）和标签页隐藏时暂停；系统或应用内“减少动效”时只画一帧。
- **深色模式**：近黑色的身体在深色页面自动换成浅色身体，眼睛不变。
- **产品 logo / 无专家时的助手头像**：同一套造型里的 `chat`（对话气泡）；侧栏、登录页、首页是 `BrandMark`，favicon 是 `web/public/favicon.svg`，`web/public/logo.svg` 是无底板版本。
