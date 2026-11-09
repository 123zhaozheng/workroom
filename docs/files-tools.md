# 文件、成果、工具、连接器、技能与云端执行（D 组）

代码：`server/src/files/**`（`filesModule`）、`server/src/tools/**`（`toolsModule`）；DTO：`shared/files.ts`；
测试：`server/test/files*.test.ts`、`server/test/tools*.test.ts`（夹具在 `server/test/fixtures/`）。

运行全部 D 测试：

```bash
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/files*.test.ts server/test/tools*.test.ts
```

## 1. 文件库与不可变版本（M08-A/B，M14-B）

### 数据模型（app.sqlite）

| 表 | 内容 |
|---|---|
| `file_files` | 文件目录行：`space_id`（唯一归属空间）、`project_id`、名称、`origin`（upload/agent/automation）、最新版本指针、软删除 |
| `file_versions` | **不可变**版本：`version_no`、`sha256`（引用 `blobs/` 内容寻址文件）、`mime`、`size`、`change_note`、来源列（`conversation_id`/`task_id`/`call_id`/`submission_id`/`tool`）、完整 `provenance` JSON、`idempotency_key`。`UNIQUE(file_id, version_no)`、`UNIQUE(space_id, idempotency_key)`；`BEFORE UPDATE/DELETE` 触发器拒绝任何修改 |

- 来源（`FileProvenance` + `tool`）：创建者、空间、项目、会话、pi task、callId、提交、输入版本 id（`inputVersionIds`：附件/被修改的上一版本）、变更说明、来源类型、生成时间（`created_at`）。新版本自动把上一版本记入 `inputVersionIds`，因此 v2 → v1 可追溯。
- 同一内容在不同项目只存一份 blob，但文件、版本、ACL 完全独立（测试 "same file name in two projects stays isolated"）。
- 幂等：Agent 写入的 `idempotencyKey = tool:<conversationId>:<taskId>:<callId>:write`（同一空间内唯一）；上传可带 `Idempotency-Key` 头（按用户命名空间）。重复写返回已有版本，不产生第二个版本。
- 新版本写入后调用 C 的 `knowledgeAdmin.fileVersionAdded(...)`（失败不影响写入）；删除调用 `fileDeleted`。

### ACL

`identity.registerResolver("file")`：文件的权限 = 其所在空间的权限，每次请求按**当前**成员关系计算（个人空间仅本人；项目：viewer 读，editor/owner 写；`delete`→写，`share`→admin）。移除成员后下载、预览、列表立即 403/消失（测试 "ACL: … removed member loses download"）。`FileService.getVersion` 无权或不存在时返回 `null`。

### 路由（`/api` 下）

| 路由 | 说明 |
|---|---|
| `GET /files?spaceId=&projectId=&q=&origin=&conversationId=&limit=` | 默认跨所有可读空间；`q` 按文件名搜索 |
| `POST /files`（multipart：`file`，`spaceId`\|`projectId`，`changeNote?`）| 新文件 v1；无空间参数 → 个人空间 |
| `GET /files/:id` | `{file, versions[]}`（新→旧，含 provenance、previewKind、下载/预览 URL）|
| `POST /files/:id/versions`（multipart：`file`，`changeNote`）| 新版本，旧版本不变 |
| `DELETE /files/:id` | 软删除（需写权限）|
| `GET /files/:id/versions/:vid/download` | `attachment` + RFC 5987 `filename*`、原 MIME、`nosniff`、`CSP: sandbox`、`no-store` |
| `GET /files/:id/versions/:vid/preview` | 见下 |
| `GET /files/:id/versions/:vid/text` | 抽取的纯文本（≤200k 字符）|

### 预览安全

所有 HTML 预览（markdown/csv/text/docx/xlsx/pptx 转换结果及上传的 HTML）都带 `Content-Security-Policy: sandbox; default-src 'none'; …`（无 `allow-scripts`、无 `allow-same-origin`）：文档获得不透明源、不能执行脚本、不能带 cookie 调 API；即使直接在顶层打开也同样受限。Markdown 中的原始 HTML 被转义，`javascript:`/`data:` 链接被移除。图片直通（SVG 走 sandbox CSP），PDF 直通（浏览器内置查看器自行隔离；CSP sandbox 会使 Chromium 的 PDF 查看器无法工作，因此 PDF 不加 sandbox，仍有 `nosniff`）。

| 类型 | 预览 |
|---|---|
| md | marked → HTML（原始 HTML 转义） |
| html | 原文 + sandbox CSP（不执行脚本） |
| csv / text / json / 代码 | 表格 / `<pre>` |
| docx | mammoth → HTML |
| xlsx | exceljs → 每个工作表一张表（≤500 行 × 60 列） |
| pptx | 解压 `ppt/slides/slideN.xml` → 每页标题 + 要点 + 备注（大纲；版式需下载查看） |
| 图片 / PDF | 直通 |
| 其他 | 提示下载 |

## 2. 成果生成工具（pi-durable 扩展 `wr.files`）

| 工具 | 作用 | replay | 理由 |
|---|---|---|---|
| `file_create` | 从结构化参数（`title`、markdown-lite `content`、`sections`、`table`、`sheets`、`slides`）生成 md/html/csv/docx(docx)/xlsx(exceljs)/pptx(pptxgenjs)/pdf(pdf-lib + fontkit，CJK 字体子集嵌入) → `putVersion` v1；结果 `details.artifact = FileVersionRef`（文件卡片） | `safe` | 唯一副作用是版本写入，其幂等键 = 会话+task+callId；崩溃后重跑会重新生成字节（docx 时间戳等可能不同），但写入命中已存版本，返回同一个 `FileVersionRef`，库中只有一个版本 |
| `file_revise` | 生成新的不可变版本（必填变更说明；可选 `baseVersionId` 乐观并发，过期则 409） | `safe` | 同上；重跑时先按幂等键找到自己的版本，再做 base 校验，避免把自己写的 v2 误判为冲突 |
| `file_read` | 读取可访问版本的文本（docx/xlsx/pptx/pdf/md/csv/html/text，支持 offset 分页） | `safe` | 只读，重跑时重新校验 ACL |
| `file_list` | 列出当前空间的文件 | `safe` | 只读 |

每次调用通过 `runtime.actorForToolCall(api)`（缺失时 `actorForTool(api, spaceId)`）解析代表的用户，并按当前 ACL 重新校验；viewer 不能创建/修改，移除成员后连读取也被拒绝。生成文件经解析回读验证可打开：mammoth（docx）、exceljs（xlsx，含公式）、解压 pptx XML（含备注）、pdf-lib 加载 + unpdf 提取中文文本（测试 "file_create generates real …"）。

## 3. 工具调用记录（M04-B）

表 `tool_calls`：工具名、连接器、组织、用户、空间、会话、pi task、callId、**参数摘要**（密钥类字段名 → `[REDACTED]`，已知密钥值与常见令牌形态替换，长串截断）、状态（running/ok/error/denied/needs_reconciliation）、错误、结果摘要、尝试次数、耗时。同一 (space, task, call, tool) 重放复用同一记录。
路由：`GET /tool-calls?spaceId=&conversationId=&tool=`（按空间读权限）、`GET /connectors/:id/calls`（管理者看全部，其他人看自己的）。

## 4. MCP 连接器（M04-A/B/C）

- 表 `mcp_servers`（系统 = 组织级，组织 owner/admin 管理；个人 = 仅本人可见可用）与 `mcp_user_settings`（每用户启用开关，调用时校验）。
- 传输：streamable HTTP（`@modelcontextprotocol/sdk` 1.32.2）与 stdio。**stdio 会在服务器上启动进程**：仅系统连接、仅管理员、且命令行必须以运维白名单 `WORKROOM_MCP_STDIO_ALLOW`（分号/换行分隔的完整命令前缀）开头；进程只拿到 SDK 默认安全环境变量 + 该连接自己的 env/密钥，不继承服务端的 `WORKROOM_SECRET_KEY` 等。个人 HTTP 连接受 URL 策略约束（见 §6），系统连接可指向内网。
- 密钥：环境变量/HTTP 头作为整体 AES-256-GCM 加密（密钥由 `WORKROOM_SECRET_KEY` 经 HKDF 派生，AAD = 连接 id）。**未配置密钥时拒绝保存任何密钥**（400 `secret_storage_unavailable`），无密钥的连接仍可添加。API 只返回密钥名称，不返回值；密钥值及其凭据部分（`Bearer xxx` → `xxx`）在工具输出、错误、调用记录中被替换。
- 状态：`ready` / `needs_reconnect`（曾经可用，连接丢失或凭据无法解密）/ `unauthorized`（服务端 401/403）/ `error`（从未连通）/ `unchecked` / `disabled`。每个连接对当前用户还给出 `access: allowed|forbidden`（服务端 ACL resolver `connector`）与 `enabledForMe`。
- 工具发现：`listTools`（分页）→ 注册为 pi 工具 `mcp__<handle>__<tool>`（≤64 字符），全部 `deferred: true`、`callers: ["model"]`；扩展 `wr.mcp` 的 `tools` 是 getter，注册表每次快照读取最新列表，变更时调用 `runtime.reinstallExtension`。
- `tool_search`（D 自带，替代 pi 的通用版）：解析 actor，只在当前用户可用且已启用的连接中检索（BM25 近似打分），用 `control.addTools` 加载。其他组织的连接工具永不出现（测试覆盖）。
- 调用时校验：连接存在且启用、当前 ACL、用户启用、状态非 unauthorized、工具仍存在。
- 读/写策略：MCP `readOnlyHint: true` → `read`，否则 `write`；管理员可按工具覆盖（`toolPolicies`）。
  - `read`：直接调用（失败后重连重试一次）；`replay: "safe"`（读可重跑）。
  - `write`：`effects.requestApproval`（展示连接、工具与脱敏参数）→ `effects.externalEffect(key = mcp:<connector>:<tool>:<callId>)`，perform 内调用 MCP 并把 `idempotencyKey` 放入 `_meta`。`replay: "safe"` 仅因为 effects 协议：重跑时有回执 → 直接返回回执（不再调用）；只有 dispatching 无回执 → `needs_reconciliation`，**不盲目重做**。没有 `effects` 服务时写操作拒绝执行（fail closed）。
- 路由：`GET/POST /connectors`、`GET/PATCH/DELETE /connectors/:id`、`POST /connectors/:id/check`、`PUT /connectors/:id/enablement`、`GET /connectors/:id/calls`。创建/修改/删除写入 `id_audit`（只记录密钥名称）。
- 夹具：`server/test/fixtures/mcp-fixture-server.ts`（真实 MCP 协议的本地服务器：echo / whoami / add_note / fail；stdio 与需要 Bearer 的 HTTP 两种）。它只验证契约，不是第三方集成。

## 5. 技能（M05-A/B/C）

| 类型 | 含义 | 能否执行 |
|---|---|---|
| `prompt` | 提示词预设 | 否，`skill_load` 返回文本 |
| `context` | SKILL.md 说明（仅上下文） | 否 |
| `executable` | 资源文件（blob）+ 入口脚本（.py/.sh/.mjs/.js）+ 声明的工具与权限（`sandbox.exec` 自动加入；`network`、`file.write`、`tool:<name>`） | 仅 `skill_run`，需授权 |

- 表：`skill_skills`、`skill_versions`（不可变，触发器保护）、`skill_installs`（启用、固定版本；`pinned_version_no = NULL` 跟随最新）、`skill_install_history`、`skill_grants`（**按版本**的用户授权）、`skill_runs`（load/run/validate，记录 `version_id`/`version_no`、会话、task、call、状态）、`skill_drafts`。
- 生命周期：安装、固定（`PATCH /skills/:id/install {pinnedVersionNo}`）、升级（固定到最新）、停用/启用、回滚（回到上一次变更前使用的版本，否则 N-1）。
- **加载 ≠ 授权**：`skill_load` 只返回文本 + 明确声明（不授予执行脚本、系统命令、联网或未选择工具的权限）。`skill_run` 检查：可执行类型、已安装且启用、当前用户对**该版本**已授予全部声明权限、空间写权限；`network` 永远拒绝（沙箱无网络）。升级后需要重新授权。发布技能本身也不授予任何权限。
- 从成功任务整理（`POST /skills/drafts {spaceId, conversationId}`）：读取该会话的工具调用记录、成功的沙箱运行与产出文件（以及运行内核中的首条用户输入），生成草稿：SKILL.md（步骤、产出、注意事项）、资源（最后一次成功的沙箱代码作为入口脚本 → executable，否则 context）、所需工具与权限、样例（输入 + 期望输出）。`GET/PATCH /skills/drafts/:id` 预览/修改（修改使验证失效），`POST …/validate`：静态检查（说明、权限合法、所需工具存在、执行类需 `sandbox.exec`、写文件需 `file.write`、`network` 不可满足）+ 样例运行（可执行 → 在一次性沙箱目录真实运行并比对输出；prompt/context → **测试模型**（pi-ai faux，非真实 AI）通过 skill_load 契约加载说明并完成运行）。`POST …/publish` 只在最近一次验证通过且之后未修改时成功。
- 其他路由：`GET/POST /skills`、`GET /skills/:id`、`POST /skills/:id/versions`、`POST /skills/:id/install`、`/install/upgrade`、`/install/rollback`、`POST /skills/:id/grants`、`GET /skills/:id/runs`。ACL resolver `skill`：个人技能仅本人；组织技能组织内可见，组织管理员管理。

## 6. 云端执行（M11-A/B/C）

### 沙箱（`sandbox_exec` 等，扩展 `wr.sandbox`）

每个空间 `orgs/<org>/spaces/<space>/sandbox/c<conversationId>/` 是一个会话的工作目录（跨运行持久）。shell / Python 3 / Node 在以下环境中运行（`server/src/tools/sandbox.ts`）：

**保证**
- `unshare --user --map-root-user --mount --pid --fork --net --ipc --uts --kill-child`：独立 user/mount/pid/net/ipc/uts 命名空间。
- 新的 tmpfs 根 → 只读绑定 `/usr`、`/bin`、`/lib*`、`/sbin`、少量 `/etc` 文件（passwd、hosts、ld.so、ssl、fonts…）、Node 运行时（仅 node 语言）；`/work` = 本会话工作目录（唯一可写的持久位置），`/tmp` 为 64 MB 内存盘，`/code` 只读；`pivot_root` 后卸载旧根，根文件系统再设为只读。**看不到**数据目录（app.sqlite、blobs、其他空间/会话）、源码、`/home`、`/root`、`/opt` 其余部分（测试断言 app.sqlite 与仓库路径不存在、写 `/usr` 失败）。
- `setpriv --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all`：丢弃全部 capabilities（不能再 mount/chroot），`env -i` 最小环境。
- `prlimit`：地址空间 512 MB（node 1 GB + `--max-old-space-size`）、CPU 秒 = 超时秒数、单文件 64 MB、256 个文件描述符、进程数（相对当前 uid 进程数 + 64）、无 core。
- 墙钟超时（默认 30 s，最大 300 s）或运行被取消（pi 任务 abort）→ `kill(-pgid, SIGKILL)`；`--kill-child` + pid 命名空间保证所有子孙进程随之结束（测试用后台 `sleep` 验证无残留）。
- 无网络：只有未启用的 `lo`（测试 `connect_ex` 返回 ENETUNREACH）。
- 主机无法创建命名空间时拒绝执行（503），绝不退化为无隔离执行。

**不保证**
- 不是虚拟机：与宿主共享内核，内核漏洞可逃逸；以服务进程的 uid 映射运行（本环境为 root 映射）。
- 没有 cgroup：内存限制是每进程地址空间，不是总量；没有 IO/带宽限制。
- 磁盘配额是软配额：运行前检查空间沙箱总量（默认 512 MB，`WORKROOM_SANDBOX_QUOTA_MB`），单文件受 fsize 限制。
- 进程数限制按宿主 uid 计数（RLIMIT_NPROC 语义），是近似值。

**生命周期与持久化**：工作目录内文件在最后修改后 `WORKROOM_SANDBOX_RETENTION_HOURS`（默认 72 h）被清理（每小时 `reap()`；列表中给出每个文件的 `expiresAt`）。需要保留的结果在到期前用 `sandbox_publish`（或 `file_create`、`POST /sandbox/:spaceId/publish`）发布到文件库，成为不可变版本。

**工具**：`sandbox_exec`（`replay: "unsafe"`：脚本可能对工作目录有非幂等副作用，崩溃后给模型 interrupted 错误而不是重跑）、`sandbox_write_file` / `sandbox_read_file` / `sandbox_list`（safe）、`sandbox_publish`（safe，库写入幂等键）。运行记录表 `tool_sandbox_runs`（代码、状态、退出码、stdout/stderr ≤256 KB、耗时、限额）。

**路由**（与会话相同的空间 ACL；发布需写权限）：`GET /sandbox/:spaceId`（隔离说明、限额、用量、浏览器可用性）、`GET /sandbox/:spaceId/files?conversationId=`、`GET /sandbox/:spaceId/file?path=&conversationId=`（下载，路径不能逃出工作目录）、`GET /sandbox/:spaceId/runs?conversationId=`、`GET /sandbox/:spaceId/runs/:runId`、`POST /sandbox/:spaceId/publish`。

### Code Mode（QuickJS）

`createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 128 MB, timeoutMs: 120 s }) })`：模型写的 JavaScript 在 QuickJS（WebAssembly）中运行，没有 `process`/`require`/`fetch`，只能经 `tools.<name>()` 调用会话里的工具（嵌套调用各自做 ACL 与 replay 策略）。MCP 工具 `callers: ["model"]`，脚本不能调用（注册表是进程级的，避免脚本 `searchTools()` 看到其他组织的连接工具名称）。

### 浏览器（`browse`，扩展 `wr.browser`）

Playwright + Chromium（主机预装，`/opt/node-tools/node_modules/playwright`，可用 `WORKROOM_PLAYWRIGHT_PATH` 覆盖；未运行 `playwright install`）。每次调用新建无 cookie 的 context、禁用 service worker 和下载；**每个请求**（导航、重定向、子资源）先过 URL 策略；最终 URL 再检查一次。返回标题与可见文本，可选截图保存为文件版本（幂等键 = 调用键）。`replay: "safe"`（GET 可重复；截图写入幂等）。

### URL 策略（`server/src/tools/netpolicy.ts`）

只允许 http/https、不允许 URL 内含凭据；解析 DNS 后拒绝回环、私网、链路本地（含 169.254.169.254 元数据）、CGNAT、组播、保留地址及 `localhost`/`metadata.google.internal`，除非 `host[:port]` 或该 IP 在运维白名单 `WORKROOM_URL_ALLOWLIST` 中。

**DNS 固定（防重绑定）**：域名只解析一次，校验通过的 IP 被“钉住”，真正的 TCP 连接直接连到这个 IP（`pinnedRequest`：自定义 `lookup`；HTTPS 仍按域名做 SNI 与证书校验）。
- 浏览器（`browse` 与交互会话）：Chromium 自己**不解析也不连接**。每个请求（导航、每一跳重定向、子资源、fetch/XHR）都被拦截，由服务端用 `pinnedRequest` 重新发出，再 `route.fulfill` 回页面；同一 context 内每个 origin 只解析一次（之后不再重新解析）；WebSocket 被拒绝；响应 ≤25 MB。
- MCP HTTP：`StreamableHTTPClientTransport` 使用 `pinnedFetch`，每个连接内的所有请求复用首次校验的 IP。
- 测试 `server/test/tools-netpolicy.test.ts`：`rebind.test` 第一次解析为白名单 IP 127.0.0.2，之后解析为 127.0.0.1；pinnedRequest、browse（页面 + fetch）与 MCP（initialize/listTools/callTool）都只解析一次并连到 127.0.0.2，127.0.0.1 上的“攻击者”服务收到 0 个请求。
- 限制：服务端发出的请求不经过本环境的 HTTPS 代理（直连）；外部网络在本环境可能受限，测试使用本地服务器 + 白名单。

## 7. 能力声明（M14-A）

`GET /tools/capabilities`：成果格式与 PDF CJK 字体状态、沙箱（可用/不可用及原因）、Code Mode、浏览器、当前用户的连接器（状态、访问、是否启用、是否可用）、被阻塞的第三方连接器、已启用技能及缺少的授权、音视频（blocked：无服务/凭据）。模型能力由 E 的模型网关声明。

## 8. 第二轮新增

### 8.1 后台长任务（M14-C）

- `job_start`（kind = `sandbox` | `browse` | `generate`）立即返回 jobId；任务是 pi-durable 任务 `wr.job`，`{ ownership: conversation, background: true }`：不让会话处于忙碌状态（对话可继续），重启后由该空间的 Harness 恢复；取消 = `harness.abortTask()`（abort 处理器标记 cancelled 并杀掉沙箱进程组）。
- 状态：`queued → running → done | failed | cancelled | timeout`。预算：墙钟 `timeoutMs`（≤ `WORKROOM_JOB_MAX_TIMEOUT_MS`，默认 1 h）+ CPU 秒（沙箱 RLIMIT_CPU，超出 → timeout）+ 内存。结果以文件版本发布（沙箱：`publish` 列出的路径；browse：正文 .md + 截图；generate：文档），来源 `tool = job:<kind>`、`callId = job:<id>`。
- 重启：每次运行在 pi memo `attempt:N` 记账。发现上一个进程中断的运行时先杀残留进程组（记录的 pid，校验 cmdline 含 `wr-sandbox`），再按 `restartPolicy`：`rerun`（声明幂等）从头重跑（最多 3 次），`fail`（默认）标记 failed，**不盲目重做**有副作用的脚本。
- 状态镜像：pi 文档 `wr.jobs`（会话级，`fork: "initial"`），每次状态变化写入，会话 watch/SSE 可见；目录行在 `tool_jobs`。普通会话中止不会取消后台任务（设计如此），用 `POST /jobs/:id/cancel`。
- 工具：`job_start`（safe：jobId 由调用确定，重放找到同一任务）、`job_status`、`job_cancel`。
- 测试 `server/test/tools-jobs.test.ts`（经真实运行内核）：job_start <2.5 s 返回、任务运行中追问被回答且会话不忙、产出下载内容正确、`wr.jobs` 镜像、取消（无残留进程，viewer 403）、墙钟与 CPU 预算 → timeout、generate 产出 docx；重启测试：rerun 任务第 2 次运行完成并发布（日志显示两次运行），fail 任务标记 failed 且副作用只发生一次。

### 8.2 交互式浏览器会话与接管（M11-B）

每个会话一个服务端 Chromium 页面（1280×800），Agent 用 `browser_open` / `browser_act`（click/type/press/scroll/navigate/back/forward/reload）/`browser_close` 操作；空间成员可通过 API 接管：接管后 Agent 的动作被拒绝（409），直到用户交还。每次动作后刷新截图（`version` 递增）。观看 = 空间读权限（viewer 可看），操作/接管/关闭 = 空间写权限。网络与 `browse` 相同（URL 策略 + DNS 固定 + 禁 WebSocket），弹窗被合并到主页面、对话框自动关闭、禁止下载。空闲 `WORKROOM_BROWSER_IDLE_MS`（默认 15 min）自动关闭，进程内最多 `WORKROOM_BROWSER_MAX_SESSIONS` 个。测试 `server/test/tools-browser-session.test.ts`。

### 8.3 默认工具集与组织策略

默认会话（不设 `settings.extensions`）提供全部已安装工具：`file_*`、`sandbox_*`、`codemode`、`browse`、`browser_*`、`job_*`、`skill_*`、`tool_search`（MCP 工具保持 deferred）。组织管理员可按组关闭（sandbox / codemode / browser / jobs / connectors / skills），由 `wr.tool-policy` 的 `beforeTool` 钩子对每次调用（含 code mode 嵌套调用）执行；每个工具仍各自校验调用者 ACL。测试 `server/test/tools-defaults.test.ts`（经真实运行内核）。

## 9. API 路由总表（`/api` 下）

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /files` `POST /files` `GET /files/:id` `POST /files/:id/versions` `DELETE /files/:id` | 空间读 / 写 | 文件库（§1） |
| `GET /files/:id/versions/:vid/{download,preview,text}` | 空间读 | 下载 / 安全预览 / 文本 |
| `GET /tool-calls?spaceId=&conversationId=&tool=` | 空间读 | 工具调用记录 |
| `GET /tools/capabilities` | 登录 | 当前用户可用能力与不可用原因 |
| `GET /tools/policy` · `PUT /tools/policy {groups:{sandbox:false,…}}` | 成员读 · 组织管理员写 | 工具组策略 |
| `GET /connectors` · `POST /connectors` | 登录 · 个人=任何成员（仅 HTTP）/ 系统=管理员 | 连接列表（含 `blocked`、`secretStorage`）/ 新建并检查 |
| `GET /connectors/:id` · `PATCH /connectors/:id {name,enabled,secrets,toolPolicies,access,url}` · `DELETE /connectors/:id` | use · admin · admin | 详情 / 修改（停用、换凭据、工具读写策略）/ 删除 |
| `POST /connectors/:id/check` | use | 立即检查状态并发现工具 |
| `POST /connectors/:id/reconnect {secrets?}` | use；带 secrets 需 admin | 重新连接（可同时更换凭据）并检查 |
| `PUT /connectors/:id/enablement {enabled}` | use | 当前用户启用/关闭该连接 |
| `GET /connectors/:id/calls` | read | 调用记录（管理者看全部） |
| `GET /skills` · `POST /skills?install=0` | 登录 · 个人任何人 / 组织技能需管理员 | 技能库（含我的安装状态）/ 新建（默认自动安装） |
| `GET /skills/:id` · `POST /skills/:id/versions` | read · write | 详情（全部版本）/ 新版本 |
| `POST /skills/:id/install {pinVersionNo?}` · `DELETE /skills/:id/install` | use | 安装（可固定版本）/ 卸载 |
| `PATCH /skills/:id/install {enabled?, pinnedVersionNo?: n \| null}` | use | 停用/启用；固定版本或跟随最新（null） |
| `POST /skills/:id/install/upgrade` · `POST /skills/:id/install/rollback` | use | 升级到最新并固定 / 回滚到上一个使用的版本 |
| `POST /skills/:id/grants {versionNo, permissions}` | use | 为该版本授予（或以 `[]` 撤销）声明的权限 |
| `GET /skills/:id/runs` | read | 运行记录（含版本） |
| `GET /skills/drafts` · `POST /skills/drafts {spaceId, conversationId, name?}` | 本人 · 会话读 | 我的草稿 / 从成功任务生成草稿 |
| `GET /skills/drafts/:id` · `PATCH /skills/drafts/:id` | 本人 | 预览 / 修改（使验证失效） |
| `POST /skills/drafts/:id/validate` · `POST /skills/drafts/:id/publish {scope?}` | 本人 | 样例验证 / 发布（需最近一次验证通过） |
| `GET /sandbox/:spaceId` · `/files` · `/file?path=` · `/runs` · `/runs/:runId` | 空间读 | 执行环境、工作目录、下载、运行记录 |
| `POST /sandbox/:spaceId/publish {conversationId, path, name?, fileId?}` | 空间写 | 发布沙箱文件到文件库 |
| `GET /jobs?spaceId=&conversationId=&status=` · `GET /jobs/:id` | 空间读 | 后台任务（`canCancel`） |
| `POST /jobs/:id/cancel` | 空间写 | 取消 |
| `GET /browser-sessions?spaceId=&conversationId=` · `GET /browser-sessions/:id` | 空间读 | 会话列表/详情（`canControl`） |
| `GET /browser-sessions/:id/screenshot` | 空间读 | 最新截图 PNG（`?v=<version>` 防缓存） |
| `POST /browser-sessions {spaceId, conversationId, url}` | 空间写 | 用户打开（由该用户控制） |
| `POST /browser-sessions/:id/takeover` · `/release` | 空间写 | 接管 / 交还给 Agent |
| `POST /browser-sessions/:id/actions {type, url?, x?, y?, text?, key?, deltaY?}` | 空间写且为当前接管者 | 点击/输入/按键/滚动/导航/后退/前进/刷新 |
| `DELETE /browser-sessions/:id` | 空间写 | 关闭 |
| `GET /work/:spaceId/:conversationId` | 空间读 | `{ work: { jobs, browserSessions } }`（工作面板一次取全） |

## 10. 被阻塞 / 未实现（诚实说明）

- 真实第三方连接器（邮箱、日历、网盘、Slack/Teams/飞书/钉钉）：没有 OAuth 应用与凭据 → 在 `/connectors` 的 `blocked` 中列出，未伪造。MCP 的 OAuth 授权流（SDK `authProvider`）未接入；需要令牌的 HTTP 连接以密钥头方式配置。
- 音视频生成/理解：无模型或服务凭据（blocked）。长任务的异步状态/取消/预算目前由沙箱运行（运行记录、取消即杀进程、时间/CPU/内存限额）与运行内核的任务机制提供。
- 沙箱网络：不提供（策略决定）；需要网络的技能不能运行。
- pptx 预览只有文字大纲，不是版式渲染；docx 预览经 mammoth，复杂版式会丢失。
- 浏览器接管是“截图 + 动作”模式（每次动作后刷新截图），不是实时视频流；会话只在拥有该空间租约的进程内存中，服务重启后不保留。
- 多 worker：沙箱与 MCP 连接池在拥有该空间租约的进程内；未做跨进程路由。
