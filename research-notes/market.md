# 技能 / MCP / 插件市场：开源项目调研笔记（MARKETPLACE 组，第 4 轮）

调研方式：`git clone --depth 1` 到 `/home/user/research/<name>`（只读行为参考，不复制代码），外加直接读取官方文档
（agentskills.io 规范、code.claude.com 的 skills / plugin marketplace 文档、MCP Registry 仓库内的 `docs/`）。
所有结论均来自上述源码或文档中能指出具体文件的内容；没有读到的部分在「未核实」一栏注明。

## 1. 被调研对象与许可证

| 项目 | 来源 | 许可证（读自仓库 LICENSE） | 我们的用法 |
|---|---|---|---|
| Anthropic Agent Skills | `github.com/anthropics/skills`（commit 浅克隆）+ agentskills.io/specification | 每个 skill 目录各带 `LICENSE.txt`，frontmatter 写 `license: Complete terms in LICENSE.txt`；仓库 README 未声明统一许可 | 只借格式规范（SKILL.md frontmatter、目录约定、渐进披露），不复制其技能内容 |
| Claude Code skills / plugin marketplace | code.claude.com/docs/en/skills.md、plugin-marketplaces.md、plugins/host-marketplace.md | 文档 | 作用域优先级、`marketplace.json` 的 source/sha 固定、只读同步目录 |
| MCP Registry | `github.com/modelcontextprotocol/registry` | 过渡中：新贡献 Apache-2.0，文档 CC-BY-4.0，旧贡献仍 MIT | `server.json` 作为 MCP 目录的导入格式 |
| Open WebUI | `github.com/open-webui/open-webui` | 自定义 "Open WebUI License"（BSD-3 条款 + 品牌保留条款） | 只参考数据模型（access_grant、history 快照）；不复制 |
| LobeChat / LobeHub | `lobe-chat`、`lobe-chat-plugins` | LobeHub Community License（Apache-2.0 基础 + 附加商用条件） | 参考 skill 存储（zip 内容寻址 + 资源路径表）与 market 搜索排序字段 |
| Dify | `dify`、`dify-plugin-daemon` | Dify：修改版 Apache-2.0（禁止未授权多租户运营、不得去 LOGO）；plugin-daemon：Apache-2.0 | 只参考包格式、签名与权限声明思路；因多租户限制不复制代码 |
| LibreChat | `danny-avila/LibreChat` | MIT | 参考 MCP 的每用户密钥（`customUserVars`/`apiKey.source`）、资源级 ACL 位、工具审批 |
| Cherry Studio | `CherryHQ/cherry-studio` | AGPL-3.0 | 只参考 MCP 安装来源与信任状态字段（行为参考，不复制） |
| LambChat（本地） | `/home/user/research/LambChat` | MIT | 反面参考：市场发布无审核、安装 = 复制可变副本 |
| DEEIX-Chat（本地） | `/home/user/research/DEEIX-Chat` | Apache-2.0 | 参考管理员级 MCP 目录 + 工具级启停；技能仅为 markdown |

## 2. 逐项目发现（带出处）

### 2.1 Anthropic Agent Skills 规范（agentskills.io/specification.md）
- 一个技能 = 一个目录，必须有 `SKILL.md`，可选 `scripts/`、`references/`、`assets/`。
- frontmatter 必填 `name`（≤64，小写字母/数字/连字符，不得首尾连字符、不得连续连字符，**必须与父目录同名**）和
  `description`（≤1024，说明做什么**以及何时用**）；可选 `license`、`compatibility`（≤500）、`metadata`（字符串到字符串的映射）、
  `allowed-tools`（空格分隔，实验性）。
- **渐进披露**：启动时只加载 name+description（约 100 token），激活后加载整个 SKILL.md（建议 <5000 token / <500 行），其余文件按需读取；
  引用保持一层深。
- 官方 `skills-ref validate` 做 frontmatter 与命名校验 → 我们在服务端做同样的校验，并加上包级校验（大小、路径、扫描）。

### 2.2 Claude Code：技能放在哪里（code.claude.com/docs/en/skills.md，第 158–173、211、223–270 行）
- 四层位置：企业（受管设置目录）、个人 `~/.claude/skills/<name>/SKILL.md`、项目 `.claude/skills/<name>/SKILL.md`、
  嵌套子目录；同名冲突时**企业 > 个人 > 项目**。
- 云端 / Cowork 会话**不读本机 `~/.claude/skills/`**：个人技能要先「启用到账号」，会话开始时**下载到只读性质的 `~/.claude/skills/synced/`**，
  「只下载、从不上传」，本地改动会被下次同步覆盖。→ 这正是我们「内容寻址包 → 物化为只读目录」的先例。
- 保留名 `synced`；技能目录可带 `.claude-plugin/plugin.json` 变成插件（含 agents/hooks/mcp）。
- 管理员可一键关闭同步（`syncClaudeAiSkills`），被移除的技能进 `.trash/` 保留一段时间 → 我们的 `unpublish` 保留版本与 blob，不物理删除。

### 2.3 Claude Code 插件市场（plugin-marketplaces.md、host-marketplace.md）
- `.claude-plugin/marketplace.json`：`name`、`owner`、`plugins[]`；每个条目有 `name`、`description`、`source`（相对路径 / `github` /
  `git-subdir` / `url` / `archive` / `npm` / `command`），`strict`（是否要求插件自带 manifest）。
- `archive`（zip over HTTPS）**必须用 `sha256` 固定**，否则内容可被替换；git 类 source 可固定 `ref`/`sha`。
- 只有**计算出的版本号变化**才会把新副本推给用户（缓存 + 显式更新，而非「活」引用）。
- 条目名 = 安装 id（`<entry>@<marketplace>`），与 manifest 名必须一致。→ 我们用 `slug` 作唯一安装 id，版本以 package sha256 固定。
- `claude plugin validate`：JSON 语法、必填字段、命名、相对 source 含 `..` → 都是**提交前**的静态检查。

### 2.4 MCP Registry（`docs/reference/server-json/*`、`docs/modelcontextprotocol-io/*`）
- `server.json`：必填 `name`（反向 DNS，`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`，含且仅含一个 `/`）、`description`、`version`；
  可选 `title`、`websiteUrl`、`repository{url,source,subfolder}`、`icons`、`packages[]`、`remotes[]`、`_meta`。
- `packages[]`：`registryType`（npm / pypi / nuget / cargo / **oci** / **mcpb**）、`registryBaseUrl`、`identifier`、`version`、
  `fileSha256`（mcpb 必填）、`transport{type: stdio|streamable-http|sse}`、`runtimeArguments`、`packageArguments`、
  `environmentVariables[{name,description,isRequired,isSecret,default,choices}]`。
- `remotes[]`：`{type: streamable-http|sse, url, headers[{name,isSecret,...}], variables{}}`（URL 模板里的 `{tenant_id}`）。
- **命名空间所有权验证**：发布 `com.example/x` 需证明拥有 `example.com`（GitHub 或域名认证）；包所有权也要验证；
  只接受可信公共 registry（npm / pypi / docker.io / ghcr.io / …）。
- **版本不可变**：同一版本字符串只能发布一次；禁止版本范围（`^`、`~`、`>=`）。
- 审核极宽松（只删非法内容、恶意软件、垃圾、完全不可用的）；状态 `active|deprecated|deleted`，删除只是改状态；明确把严格审核**交给下游 subregistry**。
  → 我们就是「下游 subregistry」：必须自己做组织内审核。
- `_meta["io.modelcontextprotocol.registry/publisher-provided"]`：发布者元数据，限 4 KB。

### 2.5 Open WebUI（`backend/open_webui/models/{tools,skills,access_grants,tool_history,skill_history}.py`，`utils/plugin.py`）
- Tools/Functions 是**存在数据库里的 Python 源码**（`tool.content`），frontmatter 用文件头注释（`requirements:` 会被 pip 安装）；
  **在服务进程内执行**——没有沙箱，所以"导入工具"限定管理员（`load_tool_from_url` 用 `get_admin_user`）。
- Valves / UserValves：管理员级与用户级可配置参数，加密存储（`encrypt_valves`）→ 对应我们的「每用户密钥」。
- 共享模型：统一的 `access_grant(resource_type, resource_id, principal_type=user|group|anyone, permission=read|write)`；
  权限由 `user.permissions` 的 `workspace.tools`、`sharing.public_tools` 之类开关控制。
- `skill` 表已有 `content` + `data(files)` + `version_id`，并有 `skill_history` 快照表；无审核流。
- 社区库（openwebui.com）是外部站点；服务端只"从 URL 导入"。→ 反面教训：不要在宿主进程内执行市场代码。

### 2.6 LobeChat / LobeHub
- 旧插件索引 `lobe-chat-plugins`：一个仓库、一条 JSON（`identifier`、`manifest` URL、`meta{title,description,tags,avatar}`、`author`），
  **提交方式 = 提 PR，维护者人工审核**（README：「Not all plugins will be accepted, we will review」，不可用或不维护的会下架）。
- 新版 skills：`packages/database/src/schemas/agentSkill.ts`：`source: builtin|market|user`、`manifest`（版本、作者、仓库）、
  `resources`（虚拟路径 → 资源元数据）、**`zipFileHash`（原始分发包，内容寻址 CAS，引用 `globalFiles.hashId`）**、`workspaceId`（作用域）、
  软删除。→ 与我们的「元数据入库 + zip blob 内容寻址 + 路径表」一致。
- `builtin-tool-skill-store`：`searchSkill` 支持 `q/sort(installCount|stars|updatedAt|createdAt|name|relevance)/page`，
  `importFromMarket` 标注 `humanIntervention: 'required'`（**模型发起的安装必须人工确认**）。→ 我们的 Agent 工具不会静默安装技能。
- 文件系统技能（项目 `.agents/skills`、设备）优先于 DB / 内置，按 SKILL.md 所在目录解析相对引用。

### 2.7 Dify（`dify-plugin-daemon`）
- `.difypkg` = zip；**RSA-4096 签名写在 zip 注释里**（`signer/sign.go`），`FORCE_VERIFYING_SIGNATURE` 默认 true，可配第三方公钥；
  声称 langgenius 作者的插件强制验签（`unauthorized_langgenius.go`）。
- `manifest.yaml`：`type/author/name/version`、`resource{memory, storage, permission{tool,model,node,endpoint,app,storage}}`、
  `plugins{...}`、`meta{arch, runner{language,version,entrypoint}}`；**权限在 manifest 里逐项声明**，运行时由 `AllowInvokeXxx()` 检查。
- 打包与解压都有总大小上限（`maxSize`，超限直接报错并列出最大的 5 个文件）。
- 三种运行时：本地子进程（stdin/stdout）、调试（TCP 回连）、serverless（Lambda）。→ 我们用"沙箱服务模式"替代本地子进程。
- 多租户限制：Dify 许可证禁止未授权多租户运营 → 不复制代码，仅借鉴设计思想。

### 2.8 LibreChat
- 资源级 ACL（`packages/data-provider/src/accessPermissions.ts`）：`ResourceType` 含 `mcpServer`、`skill`、`agent`…；
  权限位 VIEW=1 / EDIT=2 / DELETE=4 / SHARE=8；角色 `*_viewer / *_editor / *_owner`；主体 `user/group/public/role`。
- MCP：`customUserVars`（每个用户填自己的变量，`sensitive` 默认遮罩）、`apiKey.source = 'admin' | 'user'`（共享密钥 vs 每用户密钥）、
  `startup: false`（需要人工认证的服务器不在启动时连接）、`UserConnectionManager`（**每用户连接**）、
  `approval.ts`（工具审批的"授权摘要"，配置/凭据变化后需重新确认）、`domainValidation`（SSRF）。
- 管理员配置和用户配置的 MCP 分离；用户可创建 MCP 服务器并按资源分享。

### 2.9 Cherry Studio（`src/shared/data/types/mcpServer.ts`、`mcpProtocolInstall.ts`、`presets/mcpServers.ts`）
- 字段：`type: stdio|sse|streamableHttp|inMemory`、`installSource: builtin|manual|ai_assisted|protocol|unknown`、`isTrusted`、
  `disabledTools[]`、`disabledAutoApproveTools[]`、`shouldConfig`、`dxtVersion/dxtPath`（DXT 包）。
- **协议深链安装（`cherrystudio://`）强制 `isTrusted:false, isActive:false`**：从链接来的服务器默认不信任、不启用，用户确认后才激活。
  → 我们的「导入 / 个人添加」默认 `pending/unapproved`，不连接。
- **工具级**禁用与"免确认"分离。→ 我们的 `allow / ask(write) / disabled` 三态。
- 桌面应用，stdio 直接在本机起进程（不适用服务端；我们必须进沙箱）。

### 2.10 LambChat（本地参考，`src/api/routes/marketplace.py`、`skill_uploads.py`、`infra/skill/*`）
- 有市场：列表 / 标签 / 创建 / 更新 / 文件列表 / 安装 / 更新 / 管理员激活停用；**没有审核流**（创建者发布即上架，管理员只能停用）。
- 文件**逐个存进 Mongo 的文本字段**（`skill_marketplace_files`），限制：文件数、单文件字符数、总字符数、zip 10 MB / 500 成员。
- **安装 = 把文件复制到用户目录**（`sync_skill_files`），之后是可变副本（记录 `installed_from`）；沙箱里通过 `routes={"/skills/": skills_backend}` 暴露。
- zip 解析有 `..`、绝对路径、盘符、`__MACOSX`、`.git/`、单顶层目录前缀剥离处理。→ 我们的 zip-slip 防护参考它，并加上符号链接 / 压缩比 / 重名检查。
- 教训：没有不可变版本 → 无法审计"当时运行的是哪一版"；没有审核 → 市场内容即攻击面。

### 2.11 DEEIX-Chat（本地参考，`backend/internal/{domain,repository,application}/{skill,mcp}`）
- 技能只有 markdown（`Title/Trigger/Description/Markdown/Enabled/SortOrder`），`scope: builtin | user`；选择技能时拼进 `<skill_context>`；
  每条消息可选技能数有上限。
- MCP 是**管理员控制面**：服务器（`BaseURL`、`AuthTokenEnc` 加密、`HeadersJSON`、状态）→ 工具（`DisplayName`、状态、可单工具计价）；
  `secretrotation` 服务轮换密钥；`outbound_policy` 防 SSRF。→ 工具级启停、密钥轮换思路。

## 3. 对比表

| 维度 | Agent Skills / Claude Code | MCP Registry | Open WebUI | LobeHub | Dify | LibreChat | Cherry Studio | LambChat | DEEIX |
|---|---|---|---|---|---|---|---|---|---|
| **包格式** | 目录 + `SKILL.md` frontmatter；插件 `plugin.json` | `server.json`（packages + remotes） | Python 源码文本 + 头注释 frontmatter；skill = 文本 + files | skill zip（`zipFileHash`）+ manifest；旧插件 = manifest URL | `.difypkg`（zip）+ `manifest.yaml` | YAML/JSON 配置 + UI 创建 | 配置行；DXT 包 | 逐文件文本入 Mongo | 单条 markdown |
| **存储布局** | 磁盘目录；云端下载到 `synced/` | 注册表只存元数据，包在 npm/pypi/oci | DB 行 | DB + CAS（globalFiles） | 对象存储 + 解包到运行目录 | DB（Mongo） | 本地 DB + 本机路径 | Mongo 集合 | DB 行 |
| **隔离** | 本机权限 + `allowed-tools`；云端沙箱 | 无（只是目录） | **无**（进程内 exec） | 浏览器端 / 服务端工具 | 子进程 / serverless，manifest 声明权限 | 外部 MCP 进程 | 本机进程（桌面） | 沙箱里 `/skills/` 路由 | 远程 MCP over HTTP |
| **审核流** | 市场条目由市场维护者管理（PR）；组织可限制来源 | 极少（只删恶意/垃圾），下游自审 | 管理员导入；无流程 | 仓库 PR + 人工审核；安装需人工确认 | 官方市场审核 + 签名；第三方需公钥 | 无（靠 ACL 分享） | 深链安装默认不信任 | **无** | 管理员配置 |
| **版本** | `version` 计算值变化才更新；archive 用 sha256 固定 | 版本字符串不可变，禁范围 | `version_id` + history 快照 | manifest.version | manifest.version | — | `dxtVersion` | 字符串 `version`，原地覆盖 | — |
| **权限模型** | `allowed-tools`（实验） | 无 | `workspace.tools` 开关 + access_grant | 工作区 | manifest `permission{tool,model,node,endpoint,app,storage}` | 位掩码 ACL + 角色 | `isTrusted`、工具级免确认 | RBAC `marketplace:read` | 管理员 |
| **安装范围** | 企业 / 个人 / 项目 / 嵌套 | 不涉及 | 用户 / 群组 / 公开 | 用户 / 工作区 | 工作区（租户） | 用户 / 群组 / 公开 | 本机 | 用户（复制） | builtin / user |
| **密钥** | — | `environmentVariables.isSecret` / `headers.isSecret` | Valves（加密） | — | 凭据 provider | `customUserVars`，`apiKey.source` | env 明文（桌面） | — | `AuthTokenEnc` |

## 4. 我们采纳了什么（以及不采纳什么）

1. **包与清单：Agent Skills 规范**（SKILL.md + frontmatter + scripts/references/assets，渐进披露，name 校验规则、1024 描述上限）。
   在此之上加服务端的包级校验（大小/路径/压缩比/静态扫描）。
2. **存储：LobeHub 的"元数据 + zip CAS + 资源路径表"**，加上 Claude Code `synced/` 的"只读物化目录、只下载不回写"。
   与 LambChat 相反：版本不可变、安装不复制可变副本。
3. **审核与签名思路：Dify 的 manifest 权限逐项声明 + 总大小限制**；我们没有离线签名分发场景，改用 **zip 的 sha256 作为版本身份**（Claude Code `archive` 同款），
   不实现 RSA 签名（缺口，见设计文档）。LobeHub 的"人工审核 + 下架"与"模型发起安装必须人工确认"直接采用。
4. **MCP 目录：官方 Registry 的 `server.json`**（导入、校验 `name` 命名空间格式与版本不可变）；Registry 把审核下放给下游 → 我们做组织内审核；
   Cherry Studio 的 "protocol 安装 ⇒ 不信任、不启用" 与工具级三态；LibreChat 的 per-user secrets / per-user connection / 审批摘要。
5. **权限与作用域**：Claude Code 的 enterprise > personal > project 优先级（我们取 org > department > project > personal）；
   Open WebUI/LibreChat 的资源级共享思想由本项目 RBAC 的 `skill.*`、`mcp.connector.*` 权限（带 org/department/project 范围）取代。
6. **不采纳**：Open WebUI 的进程内执行（我们所有脚本与 stdio MCP 只进沙箱）；LambChat 的"发布即上架"；Cherry Studio 的本机 stdio；
   Dify 的 RSA 签名（见缺口）。

## 5. 未核实 / 不确定

- 没有逐行读 Dify 官方市场的审核后台（闭源服务），只确认了包格式与签名校验代码。
- LobeHub 云端市场的服务端审核规则（`market.lobehub.com`）不在仓库内，只有仓库侧的提交流程与客户端的搜索/导入接口。
- 没有在线调用官方 MCP Registry API（本环境对外网络受限）；`server.json` 结构取自仓库内的 schema 与文档。
