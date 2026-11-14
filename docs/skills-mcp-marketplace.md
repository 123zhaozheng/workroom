# 技能与 MCP 市场：存放、上传、审核、发布与安装（第 4 轮，MARKETPLACE 组）

实现：`server/src/tools/{skills-package,market,market-routes,mcp-market}.ts`，扩展 `skills.ts`、`mcp.ts`；DTO：`shared/files.ts`（「技能与 MCP 市场」一节）；
页面：`web/src/pages/CapabilitiesPage.tsx` + `web/src/features/market/**`；测试：`server/test/tools-market*.test.ts`、`web/e2e/round4-market.mjs`；
调研：`research-notes/market.md`（每个项目的出处、许可证与对比表）。

## 0. 先回答三个问题

**① 有了沙箱，技能放在哪个目录？**
技能有三个「家」，各管一件事，互不混用：

| 位置 | 内容 | 谁能写 |
|---|---|---|
| 数据库 `app.sqlite` | 元数据、**不可变**版本行（semver、manifest、包 sha256、静态检查结果）、审核记录、安装关系 | 服务端（版本行有触发器禁止 UPDATE） |
| `<数据卷>/blobs/<aa>/<sha256>` | 内容寻址的字节：每个版本的**规范 zip**（版本身份）+ 包内每个文件各一份 | 只增不改 |
| `<数据卷>/sandbox-mounts/skills/<slug>-<sha16>/` → 沙箱内 **`/skills/<slug>/`** | 只读「物化目录」：运行时看到的技能文件 | **没有人**（内核 `ro` 挂载；宿主上也去掉写权限位） |
| 会话工作区 → 沙箱内 **`/work`** | 技能运行产生的文件、`skill_run` 的输入文件 | 沙箱里的进程（唯一可写的持久位置） |

技能**从不**写自己的目录：脚本想存东西只能写 `/work`。安装 ≠ 复制可变副本（LambChat 的做法）；同一字节只物化一次，升级 = 新目录，旧版本目录保留以便回滚。

**② 个人技能能上传、上传要审批、审批意味着技能市场——怎么设计？**
技能有四个**范围**：个人 / 项目 / 部门 / 组织。个人技能默认**免审核**即可自用（管理员可在「市场策略」里改成「个人也需审核」或「禁止个人技能」）；要让别人用，必须**提交**到项目/部门/组织范围，经过「自动检查 → 持有 `market.review`（按范围授权）的审查员 → 批准/驳回/要求修改 → 发布」。
发布后进入**技能市场**（浏览、搜索、分类、详情、安装数、评分），可安装到「我 / 项目 / 部门 / 整个组织」。更新版本要**重新审核**；管理员可**下架**或**强制发布**（理由必填、留审计）。详见 §5–§7。

**③ MCP 同理吗？**
同理，且复用同一套提交/审核/事件表。目录以官方 MCP Registry 的 `server.json` 为导入格式；远程 HTTP 直接连，**stdio 只能在沙箱的服务模式里运行，绝不在宿主上起进程**；个人添加连接器可由组织策略要求审批（批准前不会连接）；凭据按用户加密保存；工具可逐个禁用/强制确认。详见 §8。

## 1. 调研结论（采纳了什么）

| 来源 | 采纳 |
|---|---|
| Anthropic Agent Skills 规范 | `SKILL.md` + frontmatter（`name`/`description`/`license`/`compatibility`/`metadata`/`allowed-tools`）、`scripts/ references/ assets/`、**渐进披露**（先加载 name+description，再读 SKILL.md，再按需读文件） |
| Claude Code skills / 插件市场 | 作用域优先级；云端会话把技能**下载到只读的 `synced/`**、只下不传；`archive` 来源用 **sha256 固定**；版本由内容计算，变了才更新 |
| MCP Registry | `server.json`（`name` 反向 DNS、`version` 不可变且不能是范围、`packages[]`/`remotes[]`、`isSecret`）；它把审核下放给「下游 subregistry」→ 我们自己做组织内审核 |
| LobeHub | skill = 元数据 + **zip 内容寻址哈希** + 资源路径表；搜索按 `installCount/stars/updatedAt` 排序；模型发起的安装需人工确认 |
| Dify | manifest 里**逐项声明权限**；打包/解压**总大小上限**；签名（我们没做，见 §11） |
| LibreChat | MCP 的**每用户凭据**（`customUserVars` / `apiKey.source: user`）、每用户连接、审批摘要 |
| Cherry Studio | 来自链接/导入的 MCP **默认不信任、不启用**；工具级禁用与免确认分离 |
| Open WebUI | 反面：工具在宿主进程内执行 → 我们所有脚本与 stdio MCP 只进沙箱 |
| LambChat | 反面：发布即上架、安装即复制可变副本 → 我们要审核与不可变版本；借用其 zip 清理（`__MACOSX`、`.git/`、单顶层目录） |

## 2. 数据卷上的确切布局

```
<WORKROOM_DATA_DIR>/
├─ app.sqlite
│   skill_skills            技能（scope/scope_ref/slug/listed/published_version_no/category/tags）
│   skill_versions          不可变版本（semver、package_sha256、manifest、checks、resources[path,sha256,size]）
│   skill_version_publish   「哪些版本被批准分发」（审核通过 / 管理员直发 才有行）
│   market_submissions      提交（kind: skill | mcp_catalog | mcp_connector；state；target_scope/ref；forced）
│   market_events           每次状态变化一行（谁、何时、从哪到哪、评语）
│   skill_installs          我的安装（可固定版本、可停用 = 对组织安装的「退出」）
│   skill_scope_installs    项目/部门/组织级安装
│   skill_ratings · market_policy
│   mcp_catalog · mcp_catalog_versions(不可变) · mcp_catalog_publish
│   mcp_servers(+approval_state, exec_mode, credential_mode, package_json) · mcp_user_settings(+secrets_enc, tool_overrides)
├─ blobs/<aa>/<sha256>                    内容寻址（与文件库共用，天然去重）：版本 zip + 每个文件
├─ sandbox-mounts/                        沙箱组规定的只读挂载根（Sandbox.mountsRoot()）
│   ├─ skills/<slug>-<sha16>/             一个版本一个目录；文件 0444、scripts/ 与脚本 0555、目录 0555
│   │   ├─ SKILL.md
│   │   ├─ scripts/ references/ assets/
│   └─ mcp/<slug>-<sha16>/                离线 MCP 包（bundle 类型）的只读目录
└─ orgs/<org>/spaces/<space>/sandbox/c<会话>/      = 沙箱里的 /work（可写）
    └─ .skill-run/<callId>/input.txt      skill_run 的输入
```

沙箱里看到的（沙箱组的挂载契约，`readOnly: true` 由内核强制）：

```
/skills/<slug>/   ← sandbox-mounts/skills/<slug>-<sha16>   （我当前生效的每个带脚本/资源的技能，最多 32 个）
/mcp/<slug>/      ← sandbox-mounts/mcp/<slug>-<sha16>      （沙箱 stdio MCP 的离线代码包）
/work             ← 会话工作区（唯一可写）
```

- `slug` = SKILL.md 的 `name`（小写、数字、连字符）。同名冲突（例如组织技能与我的个人技能同 slug）按 **组织 > 部门 > 项目 > 个人** 取一个，被遮蔽的不挂载。
- 物化是**懒的、内容寻址的、写一次**：`<slug>-<包 sha256 前 16 位>`；先写临时目录、去写权限位、再原子 `rename`；并发写同一内容没有副作用。
- 挂载点由 `Sandbox.addMountProvider("skills", …)` 注册，每次 `sandbox_exec` / `skill_run` / 服务启动自动带上；`skill_run` 若目标不在 provider 结果里（草稿验证、已停用）才显式补一个挂载，避免重复挂载点报错。
- 沙箱不支持挂载时（极端降级）回退为复制到 `/work/.skills/…`（可写），运行结果里标注 `readOnly: false`；当前命名空间与 Docker 驱动都支持挂载。

## 3. 包格式

一个技能包 = 一个 zip（或一个文件夹，浏览器逐个读成 JSON 上传），根目录必须有 `SKILL.md`：

```
my-skill/                 （zip 里带不带这一层顶层目录都行；服务端会剥掉，并提示与 name 不一致）
├─ SKILL.md               必需
├─ scripts/               可选：可执行脚本（.py .sh .mjs .js）
├─ references/            可选：按需阅读的资料
└─ assets/                可选：模板、图片、数据
```

`SKILL.md` frontmatter（兼容 Agent Skills 规范；扩展字段可写在顶层或 `metadata:` 下）：

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | 是 | ≤64，小写字母/数字/连字符，不得首尾或连续连字符；= `/skills/<name>/` |
| `description` | 是 | ≤1024，写明「做什么 + 何时用」（过短会有警告） |
| `version` | 否 | 语义化版本，默认 `0.1.0`；**同一技能内唯一**，发布时必须大于已发布版本 |
| `title` `category` `tags` | 否 | 市场展示 |
| `entry` | 否 | 入口脚本；有 `entry` ⇒ 可执行技能（自动加 `sandbox.exec`），否则为说明型 |
| `permissions` | 否 | `sandbox.exec`、`network`、`file.write`、`tool:<名>`；**加载不授予，运行需用户逐版本授权** |
| `tools` | 否 | 依赖的工具名（提交时检查是否存在） |
| `license` `compatibility` `metadata` `allowed-tools` | 否 | 按规范（`compatibility` ≤500） |

**限制**（`skills-package.ts` 的 `LIMITS`）：上传 ≤12 MB；解压总量 ≤25 MB；单文件 ≤5 MB；≤300 个文件；路径 ≤200 字符、深度 ≤8；SKILL.md ≤100k 字符；单文件压缩比 >200 且 >1 MB 视为 zip 炸弹。

**校验与静态扫描**（任何一步失败 → 400，**什么都不落盘**）：

| 阶段 | 规则 |
|---|---|
| 压缩包结构 | 先读中央目录再解压：拒绝 `..`、绝对路径、盘符、反斜杠穿越、NUL/控制字符（zip-slip）；拒绝符号链接与设备文件、加密条目、zip64；忽略重名（大小写不敏感）；声明大小与实际不符 ⇒ 炸弹；剥掉 `__MACOSX`、`.DS_Store`、`.git/` |
| 清单 | 必须有大写 `SKILL.md` + 合法 frontmatter；`entry` 必须在包内且是支持的脚本类型；权限在白名单内 |
| 静态扫描 `error`（拒绝上传） | 疑似凭据（AWS key、私钥、GitHub/Slack token、`sk-…`、Google key）；原生可执行文件（ELF/PE/Mach-O、`.exe .so .jar .pyc` 等） |
| 静态扫描 `warn`（保留，给审查员看） | 联网（`requests`/`curl`/`fetch`…）且未声明 `network`；`subprocess`/`eval`/`os.system`；敏感路径（`/etc/passwd`、`~/.ssh`、docker.sock…）；混淆/内嵌载荷；SKILL.md 里的提示词注入措辞；不可见/双向控制字符；描述过短；SKILL.md 过长 |
| 提交时再检查 | slug 被其他已上架技能占用（error）；版本号不大于已发布版本（error）；声明 `network`（沙箱默认无网络，warn）；依赖的工具不存在（warn） |

**版本身份** = 规范 zip 的 sha256：文件按路径排序、固定时间戳、固定压缩级别重新打包，所以「文件夹上传」「zip 上传」「带顶层目录的 zip」内容相同则**摘要相同**（测试覆盖）；内容完全相同的重复上传返回 409。

## 4. 作用域、可见性与安装范围

| 范围 | 谁能看到/使用 | 怎么得到 | 需要审核 |
|---|---|---|---|
| 个人 | 仅作者 | 上传（`skill.upload`） | 默认否；策略 `personalSkill = review` 时是；`disabled` 时禁止 |
| 项目 | 项目成员 | 提交到该项目（需项目写权限） | 是（项目所有者或组织级 `market.review`） |
| 部门 | 该部门成员 | 提交到部门（`skill.publish`@部门） | 是（`market.review`@该部门，或组织级） |
| 组织（市场） | 全员 | 提交到组织（`skill.publish`@组织） | 是（组织级 `market.review`） |

**安装范围**（`POST /market/skills/:id/install {target}`）：

| target | 权限 | 效果 |
|---|---|---|
| `me` | 能「使用」该技能 | 我的所有会话；可固定版本 / 跟随最新 / 回滚 |
| `project` | 项目写权限 | 该项目空间的所有会话 |
| `department` | `skill.publish`@该部门 | 该部门成员 |
| `org` | `market.manage` | 全员（成员可在「我的技能」里停用 = 个人退出） |

硬规则：**未审核/未发布的技能不能安装到项目、部门、组织**（409）；只能固定到**已批准**的版本；跟随最新 = 最新**已批准**版本（作者自己的个人技能除外）。`GET` 市场列表只返回「已上架且你可见」的技能，未批准的版本对普通成员不可见（文件/包/差异接口 403）。

## 5. 审核流程

```
                         ┌── 静态检查有 error ──▶ checks_failed（终态；改好后传新版本再提交）
上传(personal) ─提交─▶ 自动检查
                         └── 通过 ──▶ pending_review ──┬─ approve ─▶ approved ─▶ published ─(管理员)─▶ unpublished ⇄ published
                                                       ├─ reject ──▶ rejected（终态）
                                                       ├─ request_changes ─▶ changes_requested ─(新版本重新提交)─▶ superseded
                                                       └─ 提交人撤回 ─▶ withdrawn
```

- 状态变化只允许 `TRANSITIONS` 表中的几种，其余 409（测试逐条验证）。每次变化写一行 `market_events`（谁/何时/从哪到哪/评语），并镜像到身份审计 `id_audit`（`skill.upload|submit|approve|reject|request_changes|publish|unpublish|force_publish|install`、`mcp.*`）。
- **谁能审**（权限目录 `shared/permissions.ts`，由 RBAC 评估，**带范围**）：组织级提交 ⇒ `market.review`@组织；部门级 ⇒ `market.review`@该部门（含子部门）或组织级；项目级 ⇒ 组织级 `market.review` 或该项目所有者；个人技能（策略要求审核）⇒ 组织级，或提交人所在部门的部门审查员。技能、连接器（MCP）、专家共用同一个权限（审查员不区分对象类型，见 `docs/rbac.md`「审查员统一」）。
- **职责分离**：提交人**永远不能**批准自己的提交（含组织所有者）→ 403 `self_review`；唯一出口是「强制通过」：需 `market.manage`并**必须写理由**，记 `forced`。
- 驳回/要求修改必须写评语。批准时可选择「同时发布」（默认）或之后再发布。
- **更新必须重审**：新版本是新的不可变版本，走同一流程；通过前，跟随者仍用旧的已批准版本；审核页显示相对上一个已批准版本的**文件差异**与**新增权限**；授权按版本，升级后需重新授权。
- 管理员（`market.manage`）：**下架**（理由必填；所有人不可用/不可装，版本与 blob 保留；可重新上架）、**强制发布**（理由必填，记 forced）。旧的管理员直发 JSON 接口（`POST /skills` scope=org）等价于一次强制发布并留同样的记录。
- 策略（`market_policy`，需要 `market.manage`）：`personalSkill: free|review|disabled`、`personalMcp: free|approval|disabled`。

## 6. 市场体验（能力页 · 5 个页签）

| 页签 | 内容 |
|---|---|
| 技能市场 | 搜索 / 分类 / 范围 / 排序（热门·最新·评分·名称）；卡片显示版本、权限、安装数、评分；详情抽屉：说明（SKILL.md）、权限清单、文件树与文件预览、更新日志（已发布版本及说明）、评分与评论；按钮「安装给我 / 项目 / 部门 / 整个组织」；管理员的下架 / 强制发布 |
| 我的技能 | 我安装的与我上传的：拖拽 zip / 选择文件夹上传，上传结果即刻显示检查发现；提交到项目/部门/组织；版本固定/升级/回滚/授权/运行记录（沿用原有卡片）；从成功任务整理的草稿 |
| 待审核 | 仅有审核权限者可见：队列 + 历史；审核屏 = 清单 + 权限（新增高亮）+ 文件树/文件预览 + 与上一版本的差异 + 自动检查结果 + 事件时间线 + 批准/驳回/要求修改 |
| MCP 市场 | 目录条目（server.json）：导入（粘贴 JSON 或离线包 zip）、提交审核、安装向导（选择远程/软件包、填变量与凭据、共享/每用户凭据）；被阻止的选项写明原因 |
| 我的连接 | 原有连接卡片（状态/重连/按用户开关）+ 审批状态、沙箱运行标记、我的凭据（只显示名称）、逐工具 允许/确认/禁用 |

## 7. 市场 API（`/api` 下；权限在服务端判定，页面只做提示）

| 路由 | 说明 |
|---|---|
| `GET /market/me` · `GET/PUT /market/policy` | 我能做什么（上传/审核/管理）、沙箱能力、策略 |
| `GET /market/skills?q&category&scope&sort&installed` · `GET /market/categories` | 浏览（仅已上架且可见） |
| `GET /market/skills/:id[?version]` | 详情；`/versions/:no/file?path=` 读文件；`/versions/:no/package` 下载规范 zip |
| `POST /market/skills/upload`（multipart `file`=zip，或 JSON `{files:[{path,content,encoding}]}`；`skillId` 表示新版本） | 校验→入库；返回检查结果 |
| `POST /market/skills/:id/versions/:no/submit {targetScope,targetRef,note}` | 提交审核 |
| `GET /market/submissions?view=queue|history|mine&kind=skill|mcp` · `GET /:id` | 队列 / 审核详情（清单、文件、差异、检查、事件） |
| `POST /market/submissions/:id/decision {decision,comment,publish?,force?}` · `/publish` · `/withdraw` | 决定 / 发布已批准的 / 撤回 |
| `POST /market/skills/:id/install {target,scopeRef,pinVersionNo}` · `DELETE …?target&scopeRef` | 安装 / 卸载 |
| `POST /market/skills/:id/{rate,unpublish,republish,force-publish}` | 评分 / 管理员操作 |
| `GET /market/mcp` · `POST /market/mcp/import`（JSON server.json 或 zip 离线包） · `GET /market/mcp/:id` · `…/versions/:no/{submit,file}` · `…/force-publish` · `…/unpublish` · `POST …/install` | MCP 目录 |
| `PUT/DELETE /connectors/:id/my-secrets` · `PUT /connectors/:id/my-tools` | 我的凭据（只回名称）/ 我的工具开关 |

## 8. MCP：同一套，外加三条硬规则

**目录（`server.json`）**：`name`（反向 DNS + 一个 `/`）、`description`、`version`（不可变；`^ ~ >=` 范围直接拒绝）必填；`packages[]` / `remotes[]` 至少一个；环境变量名不得是 `PATH`、`LD_PRELOAD`、`NODE_OPTIONS` 等；`_meta` 限 8 KB。导入也接受 Registry API 的 `{server:{…}}` 包装。新条目是**个人草稿**，提交到组织/部门/项目后经 `market.review` 审核发布。条目版本不可变（触发器）。

| server.json 形态 | 在本平台 | 说明 |
|---|---|---|
| `remotes[]` streamable-http | HTTP 连接器 | URL 模板变量、`isSecret` 头加密保存；个人连接受 SSRF 策略（固定 DNS）约束 |
| `packages[]` `npm` / `pypi` | **沙箱服务**里 `npx -y` / `uvx` | 需要沙箱联网（管理员开启 + Docker 驱动）；否则选项显示 `blocked` 及原因 |
| `packages[]` `bundle`（本平台扩展）+ zip | **沙箱服务**里 `node/python/sh` 运行随包代码 | 离线可用：代码只读挂载到 `/mcp/<slug>/`，审查员可逐文件阅读；与技能包同样的静态扫描 |
| `oci` `nuget` `cargo` `mcpb`、`sse` | 暂不支持 | 条目可展示，安装选项 `blocked` |

1. **stdio 绝不在宿主运行**：沙箱连接器（`exec_mode = sandbox`）通过 `Sandbox.acquireService("mcp:<连接>:<用户>")` 起常驻进程，用沙箱组提供的 `serviceTransport` 接 MCP SDK；每个用户一个进程、在其个人空间；环境变量只对该进程可见；无网络（除非管理员允许且包声明）；空闲 15 分钟回收。旧的「系统连接 + 运维白名单」宿主 stdio 仍保留（仅管理员，未改变）；个人裸 stdio 仍 403。测试用真实沙箱验证：进程看不到仓库/数据目录、不继承宿主的 `WORKROOM_SECRET_KEY`、包目录只读。
2. **个人添加可要求审批**：`personalMcp = approval` 时，个人连接器创建为 `pending`，**不会连接、不探测 URL**；审查员看到地址/命令与**密钥名称（不含值）**；批准后才连接，驳回则永久不可用。`disabled` 禁止个人连接器。
3. **凭据按用户加密**：AES-256-GCM（AAD = 连接 id，每用户再加用户 id）；共享凭据（管理员维护）或**每用户凭据**（`credentialMode = per_user`，每人在「我的连接」填自己的）；API/审计/调用记录/提交详情都只出现名称，测试对全部响应与表做了「值不出现」断言；删除连接同时清除所有人的已存凭据。

**工具级控制**：管理员 `toolPolicies` 三态 `read`（直接调用）/`write`（每次确认并走 effects 回执）/`disabled`（注册表里没有，模型看不到，调用也拒绝）；用户只能更严：`ask`（读工具也要确认）/`disabled`（对我关闭）。`tool_search` 不返回已禁用工具。

## 9. 与 pi-durable 工具的对应

| 工具 | 作用 | replay | 说明 |
|---|---|---|---|
| `skill_list` | 我生效的技能（slug、版本、权限） | safe | 渐进披露第 1 层（name+description） |
| `skill_load` | 加载 SKILL.md（第 2 层） | safe | 返回 `dir="/skills/<slug>"`；**不授权**；记录实际版本 |
| `skill_read`（新） | 按需读包内文本文件（第 3 层） | safe | 路径只在该版本的文件表内（`../` 无效）；分页 |
| `skill_run` | 在沙箱运行 entry（或包内另一个脚本 `script`） | unsafe | 逐版本授权；`/skills/<slug>` 只读；输入在 `/work/.skill-run/…` |
| `tool_search` | 在**当前用户可用**的 deferred 工具（MCP）与技能中检索 | safe | MCP 工具仍 `deferred: true`、`callers: ["model"]`；另附「匹配的技能」提示（用 `skill_load` 加载，不是工具） |
| `mcp__<handle>__<tool>` | MCP 工具 | safe（写操作经 effects） | 调用时重新校验：审批状态、停用、用户开关、每用户凭据、工具禁用/确认 |

模型发起的安装不存在：技能/连接器的安装、授权、审批都是人通过 UI/API 完成（LobeHub 同款原则）。组织的工具组开关（`skills`、`connectors`）对 `skill_*`、`mcp__*` 与 `tool_search` 仍然生效。

## 10. 与其他组的契约

- **沙箱组**（`docs/requests/sandbox.md`，已落地）：`mountsRoot()`、`addMountProvider`、`run({mounts})`、`acquireService`、`serviceTransport`、`capabilities()`。我们只在 `<mountsRoot>/skills|mcp/` 下写，从不改 `sandbox/**`。
- **RBAC 组**：权限 id 取自 `shared/permissions.ts`：`skill.use/upload/publish`、`market.review/manage`、`mcp.connector.add_personal/add_org`；评估一律走 `AuthzService.has(principal, id, scope)`（无该服务时退化为 owner/admin）。内置角色「审查员」「部门管理员」直接可用。

## 11. 诚实的缺口（没有做 / 未验证）

- **没有离线签名**（Dify 的 RSA 签名）：版本身份靠 zip sha256，信任靠组织内审核；跨组织分发技能包时没有作者签名可验。
- 没有在线检索官方 MCP Registry（本环境对外网络受限）：只支持粘贴/上传 `server.json`。命名空间所有权验证（域名/GitHub）也未做——组织内审核代替。
- npm / pypi 的沙箱 stdio 路径在**代码与阻塞逻辑**上完成，但真实运行需要「沙箱联网 + Docker 驱动」，本环境（命名空间驱动、无网络）**未做端到端验证**；离线 bundle 路径做了真实沙箱端到端验证。`oci / nuget / cargo / mcpb` 与 SSE 传输不支持。
- 静态扫描是正则启发式，**挡不住有意的混淆**；它的作用是给审查员标注风险，并非沙箱的替代。运行时仍靠沙箱隔离 + 逐版本授权。
- 部门可见性按**直接成员**判断，没有向上继承父部门的技能（RBAC 的权限范围包含子部门，但技能可见性我们保守处理）。
- 市场里的评分没有「必须用过才能评」的限制；没有举报/申诉流程；没有邮件/站内通知（待审核只在页面队列里）。
- 审查员读的是我们保存的包，不是作者仓库：没有自动拉取外部仓库（git/archive source）的来源。

## 12. 专家（第 17 轮）

专家是第三类市场对象（`kind = expert`），与技能、MCP 共用提交 / 审查 / 发布 / 事件表和统一的审查员权限；详见 `docs/r17-experts.md`。
