# 知识、检索、引用与记忆（C 组）

代码：`server/src/knowledge/**`；DTO：`shared/knowledge.ts`；测试：`server/test/knowledge*.test.ts`。
服务：`knowledge`（核心 `KnowledgeService` 契约）、`knowledgeAdmin`（`Knowledge` 门面：store / memory / pipeline / 文件钩子 / 能力）。
pi-durable 扩展：`wr.knowledge`（工具 `kb_search`、`memory_save`；提示词段 `knowledge_scope`、`memory`）。

```
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 server/test/knowledge*.test.ts   # 25 tests
```

## 1. 数据模型（app.sqlite，前缀 `kb_` / `mem_`）

| 表 | 作用 |
|---|---|
| `kb_bases` | 知识库：`scope` = personal / project / department / org，`owner_user_id`，`project_id`/`department_id` |
| `kb_maintainers` | 每个知识库的维护者 |
| `kb_docs` | 逻辑文档 = 某文件在某知识库中（`file_id`），`serving_version_id`（检索使用的版本）、`latest_version_id`，治理字段 |
| `kb_doc_versions` | 文档版本 = 一个不可变文件版本（`version_id`/`version_no`/`sha256`）+ 处理状态 |
| `kb_chunks` | 分片 + 锚点（page / section / paragraph / sheet / row_start..row_end / ocr）。**永不硬删**：失效时写 `tombstoned_at` + `tombstone_reason`（superseded / deleted），以便旧引用查询状态 |
| `kb_fts` | FTS5 `tokenize='trigram'`，只含**在用**分片（rowid = `kb_chunks.seq`），索引内容 = 章节路径 + 正文 |
| `kb_jobs` | 持久化处理任务（pending / running / done / failed / cancelled，`attempt`、`run_after`） |
| `kb_meta.generation` | 检索结果缓存的代数，任何影响检索的变更都会 +1 |
| `mem_items` / `mem_revisions` | 记忆与修订历史 |

## 2. 处理流水线（M06-A、M08-C）

- **显式加入**：上传文件（D 的 `POST /api/files`）不会进入知识库；必须 `POST /api/kb/:id/docs {fileId, versionId}`。加入时以调用者身份 `files.getVersion(principal, versionId)` 校验文件读权限，并要求对知识库有 write 权限。
- 状态机：`queued → parsing → indexing → ready | failed(errorCode, error, retryable)`。`GET /api/kb/:id/docs` 的 `availability`（ready / processing / failed）就是“知识是否可用”，与文件存储状态（D）分开；`GET /api/kb/files/:fileId/status` 给出一个文件在各知识库中的知识状态。
- 任务持久化在 `kb_jobs`。`start()` 时把 `running`（上个进程崩溃遗留）改回 `pending`，版本状态回到 `queued`，并为没有任务的 queued 版本补任务，然后继续处理。单进程串行处理（SQLite 单写者）。
- 后台读取来源时以**添加者**身份重新解析（`identity.principalFor`），撤权同样作用于后台任务。
- 失败：`unsupported_type`、`parse_error`、`encrypted`、`no_text`、`ocr_unavailable`、`ocr_failed`（不可重试，除非标注）；`source_unavailable`、`internal`（可重试）。可重试错误自动重试（默认共 3 次，指数退避 2s 起；`WORKROOM_KB_MAX_ATTEMPTS`、`WORKROOM_KB_RETRY_BASE_MS`），最后进入 failed；`POST /api/kb/:id/docs/:docId/retry` 手动重试。
- 解析器（`parsers.ts`）：txt（UTF-8/BOM/GB18030）、md（标题路径，忽略代码块中的 #）、html（h1–h6 路径、段落、列表、表格行；去掉 script/style）、docx（mammoth → html，Word 标题样式成为章节路径）、csv/tsv（表头标注的行，行号锚点）、xlsx（exceljs，工作表 + 行号，公式取结果）、json（按顶层键分组的路径行）、pdf（unpdf 按页提取，页码锚点）。
- **OCR（离线，已实现并验证）**：tesseract.js（WASM，worker 线程）+ npm 包内的 `chi_sim`/`eng` best_int 语言数据（首次使用复制到 `<dataDir>/ocr/lang`，不访问网络）。图片（png/jpg/webp/bmp/tiff/gif）整体识别；PDF 中**没有文本层的页面**用 unpdf + `@napi-rs/canvas` 以 2 倍栅格化后识别（单文档最多 100 页），保留页码锚点。OCR 文本的分片与引用带 `ocr: true`，定位显示“第 N 页（OCR 识别）”。`WORKROOM_KB_OCR=0` 关闭。
- 分片（`chunker.ts`）：同一锚点单元（页 / 章节路径 / 工作表 / OCR 标志）内打包到 ≤900 字，超长段落在句末切分（中英标点）并带少量重叠；分片永不跨页、跨章节、跨工作表。

## 3. 权限模型（M07-A，检索阶段过滤）

| 范围 | 读 | 写（加文档/重试/治理） | 管理（改名/维护者/删除） |
|---|---|---|---|
| personal | 所有者 | 所有者 | 所有者 |
| project | 当前项目成员（任意角色） | 项目 owner/editor；或仍是成员的 KB 所有者/维护者 | 项目 owner 或 KB 所有者 |
| department | 当前部门成员 + KB 所有者/维护者 | KB 所有者/维护者、组织 owner/admin | KB 所有者、组织 owner/admin |
| org | 组织所有当前成员 | KB 所有者/维护者、组织 owner/admin | KB 所有者、组织 owner/admin |

- 所有判断都基于**当前**身份状态（项目成员、部门成员、组织成员、用户停用），不缓存。`acl.ts` 的 `ACCESSIBLE_KB_SQL` 是一个 SQL 子查询，检索 SQL 中 `c.kb_id IN (<该子查询>)` 直接过滤分片——权限过滤发生在检索内部，不在 UI 或结果后处理。
- 为 `ResourceRef` kind `"kb"` 注册了 ACL resolver（其他模块可 `acl.check(p, action, {kind:"kb", id})`）。
- 不可读的知识库对外表现为 404（不泄露存在性）；显式请求不可读的 kbId 时，检索诊断为 `forbidden` 且这些 id 列在 `forbiddenKbIds`，不会被检索。
- **会话上下文默认范围**：项目会话（`projectId`）默认只检索该项目知识库 + 企业知识库；个人/部门知识库只有在用户以知识引用（`knowledgeRefs`）显式带入时才检索——因为项目会话对其他成员可见。个人会话默认检索调用者可读的全部知识库。
- 依赖：检索 SQL 读取 E 的 `id_project_members`、`id_projects`、`id_department_members`、`id_departments`、`id_org_members`、`id_users`。

## 4. 检索与诊断（M07-C）

- 查询规划（`query.ts`）：NFKC + 小写；拉丁词 ≥3 字符作为带引号的 FTS 词（用户输入永远无法构成 FTS 语法）；中文连续串 ≥3 字时取整串（≤8 字）+ 所有三字组；仅有 <3 字词时走 LIKE 回退（子串扫描）；三字组无命中时用中文二字组（去掉疑问词/虚词）LIKE 回退，得分低于任何三字组命中。
- 排序：FTS5 `bm25()` 归一化（0.3）+ 查询词覆盖度（0.7）。片段 `snippet` 取命中最密集的 ~220 字窗口（纯文本）。
- 治理过滤：默认只检索 `gov_status='effective'` 且在生效期内的文档（`includeInactive: true` 可包含）。
- 结果缓存：键 = 组织、用户、本次可检索的 kbId 集合、查询与选项、`generation`、到期边界计数；TTL 60s。成员变化改变可检索集合（换键），文档增删改/就绪/治理变化使 `generation` 加一并清空缓存，所以撤权、删除、更新后**下一次**检索不会命中旧缓存。命中缓存时 `diagnostics.cached = true`。
- 诊断（`RetrievalDiagnostics`）：`reason` 区分 `no_evidence`（可检索文档中无相关内容/范围内无知识库）、`index_not_ready`（有文档在处理中，或全部处理失败）、`forbidden`（请求的知识库无权访问）、`error`（检索异常）；另含 `searchedKbIds`、`forbiddenKbIds`、`readyDocs`/`pendingDocs`/`failedDocs`、`strategy`（fts / like / fts+like）、`tookMs`、`vector: "blocked"`。“模型错误”不属于检索，由运行时（A）在提交结果中反馈（`unanswered` + `model_error`）。
- 调试：`POST /api/kb/search {query, kbIds?, docIds?, projectId?, limit?, includeInactive?, debug: true}` 额外返回 `debug { ftsQuery, likeTerms, accessibleKbIds, candidates, embedding }`。
- 评估：`server/src/knowledge/eval-samples.ts`（md/txt/csv/html/json 语料 + 14 个样例，测试中再加 PDF 页码样例）；`POST /api/kb/eval {samples, kbIds?}` 返回 `passed`、`recallAt5`、`mrr`、逐条 rank。当前：16/16，recall@5 = 1，MRR = 1（`knowledge-eval.test.ts`）。
- **向量检索：blocked**。没有嵌入模型凭据；`embeddings.ts` 定义了 `EmbeddingProvider` 接口和解锁步骤（`kb_vectors` 表、流水线写入、与 FTS 结果做 RRF 融合并保持同一 SQL 权限过滤），没有伪造向量。

## 5. 引用语义（M06-B、M06-C）

- `Citation`（核心契约）+ 展示字段：`kbId/kbName/docId/fileId/versionId/versionNo/fileName/chunkId/page?/section?/paragraph?/sheet?/rowStart?/rowEnd?/ocr?/snippet/score/locator`。`versionId` 就是 D 的不可变文件版本，可直接 `GET /api/files/:fileId/versions/:versionId/download`。
- 定位优先级：页码（PDF）→ 工作表 + 行 → 行（CSV）→ 章节路径（+ 段落序号）→ 段落序号 → “原文片段”。
- **更新**：文件新版本（D 调用 `knowledgeAdmin.fileVersionAdded`，或再次 `POST /kb/:id/docs` 指定更新的版本）在该文档下新建文档版本并排队；新版本**就绪时**在同一事务中：新分片入索引、旧版本分片从 FTS 移除并标记 `superseded`、`serving_version_id` 切换。新版本处理期间旧版本继续提供检索；新版本失败时旧版本继续服务（`latest` 显示失败，`serving` 仍是旧版）。不能加入比现有更旧的版本（409）。
- **删除/撤权**：`DELETE /api/kb/:id/docs/:docId`、删除知识库、D 删除文件（`fileDeleted`）→ 同一事务中移除 FTS 行并 tombstone，下一次检索即不可见。撤权（移出项目/部门/组织、停用）在下一次检索的 SQL 中直接生效。
- **已有回答**：引用快照保存在 pi-durable 的工具结果 `details.citations` 中（不可变）。UI 用 `GET /api/kb/citations/:chunkId/status`（或批量 `POST /api/kb/citations/status {chunkIds}`）获取当前有效性：`valid` / `superseded`（附当前 `vN`）/ `deleted` / `withdrawn` / `expired` / `forbidden`（当前用户已无权查看来源，不再透露其他信息）/ `not_found`，以及中文 `message` 用于失效提示。

## 6. 制度治理（M07-B）

`PATCH /api/kb/:id/docs/:docId/governance {kind, responsibleUserId, versionLabel, status, effectiveFrom, expiresAt, replacedByDocId}`；
`kind` = reference / policy / template；`status` = draft / effective / expired / withdrawn；`effectiveStatus` 由状态 + 日期计算（另有 `pending` = 未到生效日）。
默认检索只用 `effectiveStatus = effective` 的文档；草案、过期、下架、未生效均排除（`includeInactive` 可查看）。
替换：给旧文档设置 `replacedByDocId` —— 替换文档已就绪则旧文档立即 `withdrawn`，否则在替换文档首次就绪时自动下架。治理变更写入审计（`id_audit`，action `kb.doc.governance`）。

## 7. pi-durable 扩展（`extension.ts`）

- `kb_search {query, kbIds?, limit?}`：`replay: "safe"`——只读：不写任何行、不调用外部服务；崩溃后重放只是以**当前** ACL 与索引再检索一次，与新的调用等价。行动者通过 `runtime.actorForToolCall(api, ctx)` 解析（A 从 `wr.space` 会话文档取空间，从当前运行的第一条输入取用户与 `knowledgeRefs`，并按当前 ACL 复核）。未指定 kbIds 时使用本次输入的 `knowledgeRefs`（含 docId 时限定到文档），否则按空间默认范围。输出给模型的文本带 `[n]` 编号与“只依据片段陈述”的说明；各失败原因有明确指示（如 no_evidence：不得声称有知识库依据）。`details = { kind: "wr.kb_search", query, citations(n), diagnostics }` 供 UI 渲染。
- `memory_save {content, scope (必填: private|project|org), kind?}`：`replay: "safe"`——按 `{spaceId, callId}` 幂等，重放返回第一次写入的记忆。project 仅允许在项目会话中、需 owner/editor；org 需组织管理员。来源记为 `extracted`，`sourceRef = {spaceId, conversationId, callId, taskId}`。
- 提示词段 `knowledge_scope`：列出当前会话默认可检索的知识库及就绪文档数。
- 提示词段 `memory`：见下。空间与行动者来自 `runtime.promptScope(input, ctx)`（行动者 = 当前运行输入的作者，按当前身份重新解析；`principal: null` 表示已撤权，此时不输出任何依赖行动者的内容）。

## 8. 记忆（M10）

- 范围：`private`（仅本人）、`project`（项目成员共享背景）、`org`（全组织，管理员写）。来源：`user`（手动）、`extracted`（`memory_save`，带会话引用）、`corrected`（纠正产生）。类型：constraint / preference / fact / background。
- API：`GET /api/memory?scope=&projectId=&includeSuperseded=1`、`POST /api/memory`、`GET|PATCH|DELETE /api/memory/:id`、`GET /api/memory/:id/history`、`POST /api/memory/:id/correct {content, note}`（返回 `{previous, current, change{before, after, note, at, by}}`：旧条目 `superseded` 并互相链接）、`GET /api/memory/context?spaceId=`（该空间的记忆段原文，供 UI 展示“当前上下文包含哪些记忆”）。
- **隔离规则（`MemoryStore.contextFor`）**：个人空间 = 本人 private（仅当行动者就是空间所有者）+ org；项目空间 = 该项目 project（行动者须是当前成员）+ org，**永远不含任何人的 private 记忆**（项目会话对其他成员可见）；切换空间即切换上下文。约束类排在最前，最多 60 条 / 6000 字。
- **分支语义**：记忆是全局事实（app.sqlite），不是分支局部状态。分支、编辑重试、再生成在下一次模型请求时看到的都是**当前**记忆（`knowledge-extension.test.ts` 验证：纠正后从早期 entry 分叉的会话看到纠正后的内容）。
- **压缩**：记忆段是系统提示词段，每次请求前重新渲染；压缩只摘要转录内容，压缩后 pi 会为新上下文重新写入提示词段（测试验证压缩后 `memory` 段仍含约束）。

## 9. HTTP 路由一览（均在 `/api` 下，需要登录）

`GET /kb/capabilities` · `GET|POST /kb` · `GET|PATCH|DELETE /kb/:id` · `PUT /kb/:id/maintainers {userId|email, maintainer}` ·
`GET|POST /kb/:id/docs` · `GET|DELETE /kb/:id/docs/:docId` · `POST /kb/:id/docs/:docId/retry` · `PATCH /kb/:id/docs/:docId/governance` ·
`POST /kb/search` · `POST /kb/eval` · `GET /kb/citations/:chunkId/status` · `POST /kb/citations/status` · `GET /kb/files/:fileId/status` ·
`GET|POST /memory` · `GET /memory/context` · `GET|PATCH|DELETE /memory/:id` · `GET /memory/:id/history` · `POST /memory/:id/correct`

## 10. 已知限制 / 阻塞

- **向量检索**：blocked（无嵌入凭据），见 §4。
- OCR 质量取决于 tesseract（chi_sim best_int）；扫描质量差的页面可能识别错误，引用会标注 OCR。单文档 OCR 上限 100 页。OCR 在主进程外的 worker 线程中运行，但 PDF 栅格化在主线程。
- 处理是单进程串行；多 worker 部署需要按 `owner_instance` 租约领取任务（未实现，与架构 §2 的单 owner 前提一致）。
- 引用状态依赖 `kb_chunks` 中保留的 tombstone 行；目前不做物理清理（体量可控时可加按时间清理，代价是更早的回答只能显示 `not_found`）。
