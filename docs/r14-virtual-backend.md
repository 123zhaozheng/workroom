# 第 14 轮：Agent 虚拟后端重构（变更清单、设计、迁移）

需求原文：`docs/requests/agent-virtual-backend-requirements.md`（用户提供，基准为 `ca22e85`）。另有新增需求：右侧面板改为三个区块，分别是“输出 / 子任务 / 浏览器”。

本文是动手前的变更清单。实施过程中如有调整，会回写本文并注明。

## 0. 核对结论（实施前）

- **pi-durable 1.5.0**：
  - `./env` 导出 `FileSystem`、`Shell`、`ExecutionEnv`；`./tools` 导出 `read`、`write`、`edit`、`bash` 工具。
  - 这些工具都依赖 `HarnessOptions.env`（目前没有接入），而且 replay 都是 unsafe，没有 ACL、etag 或多后端路由。
  - 本次**不接入** `HarnessOptions.env`：接入后存在命令落到应用宿主机执行的风险。改为自建一层薄的 TypeScript 工具，下接虚拟文件系统路由（VFS router）。
  - 内核本身（会话、ToolTask、恢复、submission）照旧沿用。
- **执行身份**：第 13 轮已落地，每次提交都记录操作人（`wr.run-actor`），工具、模型、提示词统一通过 `actorOfRun` 解析身份。本次的文件工具全部复用它。
- **文件模型**：所有写入都经过 `Files.putVersion`。调用方有 file_create、file_revise、sandbox_publish（工具和路由两处）、浏览器截图、后台任务、上传；读取 versionId 的位置都在盘点表里，详见下文第 5 节。
- **记忆**：有两套入口。一套是数据库中的 `mem_items`（私有、项目、组织三种 scope，以及 memory_save 工具和提示词注入）；另一套是第 11 轮的 `stores/memories/<user>` 目录（挂载进沙盒）。
- **技能**：存在 `skill_*` 表和 blob 中；运行时只把本会话加载过的技能挂载到 `/skills/<slug>`；没有“系统技能”这个概念。
- **工作区**：宿主机目录 `<space>/sandbox/c<conv>` 是唯一事实来源，远端沙盒通过 sha256 清单同步，exec 前推、exec 后拉。读写宿主机文件不会启动沙盒。

## 1. 虚拟命名空间与后端（新目录 `server/src/vfs/`）

| 路径 | 后端 | 存储（复用） | 读 | 写 / 编辑 | 删除 |
|---|---|---|---|---|---|
| `/skills/<slug>/…` | SkillsBackend | skill 包，blob 存储 | 当前身份可用的技能 | 只有自己拥有的个人技能可写（每次写入生成一个新的技能包版本：这是技能已有的机制，不属于成果版本）；已安装的、组织共享的技能拒绝写入 | 同写入规则 |
| `/memory/…` | MemoryBackend | `<dataDir>/orgs/<org>/memory/user/<userId>/*.md`；共享记忆在 `…/memory/project/<pid>/`、`…/memory/org/`，映射为 `/memory/shared/project/<pid>/`、`/memory/shared/org/` | 本人；共享记忆按原 ACL | 本人可写；项目记忆需项目写权限；组织记忆需组织管理员 | 同写入规则，同时更新 MEMORY.md 中的索引 |
| `/library/<目录>/…` | LibraryBackend | 新表 `lib_items`，内容仍存 blob（借用 `file_files` 的稳定 id） | 有权读取该会话的人 | 返回指引：交付请用 present_file | 撤回交付（状态变为 removed） |
| `/uploads/<消息>/<文件名>` | UploadsBackend | 用户消息里的附件（`AttachmentRef`） | 能读该会话的人 | 只读 | 拒绝 |
| `/work/…` | WorkBackend | 宿主机会话工作区（权威），按需同步到沙盒 | 支持 | 支持（含配额检查） | 支持（递归删除需显式参数） |

- **路由**：按最长前缀匹配；路径统一为 POSIX 格式，相对路径相对 `/work`；拒绝 `..` 越界、符号链接越界和未知根路径（返回结构化错误）。工具输出中不出现宿主机路径。
- **ls 结果**：每项包含 `type`、`size`、`mtime`、`caps`（read/write/edit/remove/exec），由后端按当前身份如实给出。
- **沙盒按需启动**：读写 `/memory`、`/skills`、`/library`、`/uploads` 以及 `/work` 的文件都不会启动沙盒；只有 `exec`，或第 11 轮已有的显式准备和预热会启动，并复用同一把获取锁。

## 2. 统一工具（扩展 `wr.vfs`）

| 工具 | 重放（replay） | 说明 |
|---|---|---|
| `ls(path, cursor?)` | safe | 分页；`ls('/')` 返回当前身份可用的根目录 |
| `read(path, offset?, limit?)` | safe | 文本按行分段读取；二进制返回类型说明，不伪装成 UTF-8；可解析的文档按现有预览能力抽取文本 |
| `write(path, content, expected_etag?)` | safe（条件写，内容相同即不变） | 返回新 etag |
| `edit(path, old_text, new_text, expected_etag?)` | safe（同一调用重放时，回执中已有记录则直接返回） | 匹配不到或匹配到多处时报错 |
| `search(path, query, mode=name\|content)` | safe | 有数量上限，返回虚拟路径 |
| `remove(path, recursive?)` | safe | 在 `/library` 中表示撤回交付 |
| `exec(command, cwd?, timeout_ms?)` | **unsafe** | 只在 `/work` 所在的完整沙盒中执行。进程重启后不会盲目重放：持久化的“已开始”标记在、结果却丢失时，返回“执行结果未知” |
| `present_file(source, name?, description?)` | safe（凭回执） | 来源可以是 `/work` 文件或 HTTP(S) URL；同名覆盖，fileId 保持不变 |
| `copy_to_work(source, destination?, overwrite?)` | safe（凭回执） | 来源可以是有读权限的虚拟文件、URL，或技能目录（需显式递归）；目标已存在且不是同一来源时报冲突 |

**旧工具**：file_create、file_revise、file_read、file_list、sandbox_exec / write_file / read_file / list / import / publish、code_run、memory_save、skill（load/read/run）。
- 新会话不再提供这些工具，也不再写进提示词。
- 旧会话中未完成的工具任务由兼容适配器处理到终态。tool 名称和 task kind 都不改名，以免 pi-durable 无法解析已持久化的任务。

codemode 仍可编排工具，只作编排用，不再作为计算后端。

## 3. 交付：present_file 与文件库

**新表**：
- `lib_items`（fileId, org, space, conversation, folder, name, name_key, mime, size, sha256, etag, status active|removed, presented_by, 时间戳）。同一会话、同一规范化文件名，只允许存在一条 active 记录。
- `lib_receipts`（call_key → fileId, status, result）。
- `lib_folders`（conversation → 首次交付时确定的目录名，例如“咖啡店销售分析--c123”，之后固定不变）。

**内容存储**：借用 `file_files` / blob 来保存字节，fileId 就是 `file_files.id`。同名覆盖时内部会追加一条 `file_versions` 记录，但它只是内部实现：对外的 API 和界面都不展示版本。

**一致性**：元数据、回执、待推送事件在业务库的**同一个 SQLite 事务**里写入。
- 同一调用重放时，命中回执直接返回；
- 重放的旧调用不会覆盖之后成功的新交付；
- 同一目标的并发交付按顺序执行，并用 etag 做条件更新。
- pi-durable 侧只依赖工具结果，靠回执即可恢复。这里不宣称两个 SQLite 文件之间存在原子事务。

**新路由**：
- `GET /api/files/:id/download`、`/preview`、`/text`：始终返回当前内容，以 etag 作为缓存键；
- `GET /api/library?conversation=…`、`DELETE /api/library/:fileId`（撤回）。
- 旧的 `/versions/:vid/*` 路由保留，供知识库引用和旧链接继续解析。

**聊天卡片**：只认 `present_file` 结果中的 `details.kind = "wr.presented"`。卡片按 fileId 去重，并通过会话状态中的 `outputs`（本会话的 lib_items）显示当前状态；已撤回的显示“已删除”，不提供下载。浏览器截图、后台任务输出、上传附件和读取结果都不会生成卡片。

**右侧面板**：重建为“输出 / 子任务 / 浏览器”三个区块。
- 输出：数据源就是 `outputs`；
- 子任务：子代理和后台任务；
- 浏览器：浏览器会话。

面板可以收起；原来的终端、工作区文件这两个页签删除。

## 4. Markdown 记忆

- 个人记忆的约定文件：`MEMORY.md`（索引）、`preferences.md`、`profile.md`、`facts.md`、`projects/<slug>.md`，都在用到时才创建。
- 写入：先写临时文件再重命名，保证原子性；`etag` 取 sha256；`If-Match` 不一致时返回冲突。前端和 Agent 走同一个服务。
- 注入：每次新运行时注入当前 `MEMORY.md`，上限 6000 字符；超出时截断并附上提示和主题文件路径，磁盘上的原文不动。
  - 只有在本人的个人空间里，才会注入个人记忆；
  - 项目空间注入该项目的共享记忆和组织记忆，不注入任何人的个人记忆。
- 前端记忆页：按分类列出文件，可阅读、编辑、新建主题、删除；显示最近修改时间；保存冲突时给出可理解的提示。

## 5. 迁移与备份（不丢原数据，结果可核查）

所有迁移在服务启动时执行一次，执行过后打上标记，不会重复执行。迁移前先备份；原表和原记录保留不删。

1. **数据库记忆 → Markdown**
   - 先导出 JSON 备份：`<dataDir>/backups/r14/memory-<ts>.json`。
   - 按 scope 和 owner 写入对应目录：preference 写入 preferences.md，fact/constraint 写入 facts.md，background 写入 profile.md；生成 MEMORY.md 索引。
   - 重复内容合并，冲突内容并存并标注，全部记入迁移报告 `<dataDir>/backups/r14/memory-report.json`。
   - `mem_items` 保留但不再读取，不会被重新导入。
   - 原 `stores/memories/<user>` 目录中非 Markdown 的文件不移动、不删除，迁移报告中列出它们的位置。
2. **历史成果 → 当前文件**
   - Agent 产出的文件（origin 为 agent 或 automation，来自 file_create、file_revise、sandbox_publish、job:*）按会话写入 `lib_items`，取每个文件的最新版本作为当前内容，目录名由会话标题生成。
   - 用户上传（origin 为 upload）、浏览器截图（tool 为 browse）不进入文件库。来源无法判断的文件不自动公开，记入报告。
   - 旧的 versionId 链接继续可以解析。
3. **上传附件**：不搬运数据，直接从历史消息的 `AttachmentRef` 映射到 `/uploads`。
4. **浏览器执行**：删除浏览器执行的代码、路由、设置、界面、Pyodide 依赖和 SSE 事件。已有的待领取任务，在 broker 删除前不会再有标签页领取，相关工具调用以 `unclaimed` 失败收尾，不会自动换环境重跑。`local_exec:*` 和 `local_pref:*` 设置项保留但不再读取。
5. **独立的版本机制**：知识库文档版本、技能包版本、工作区保存点、pi-durable 检查点都不受影响。

## 6. 验收

每个用例 V01–V24 都对应一条服务层或工具层测试，见 `server/test/r14-*.test.ts`；界面部分对应浏览器测试 `web/e2e/round14-*.mjs`。执行链路在本机真实的 Docker、namespaces 或 OpenSandbox 上验证。跳过的用例会注明原因，不算作通过。
