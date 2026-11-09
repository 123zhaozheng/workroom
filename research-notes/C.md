# C 组研读笔记（行为参考，未复制代码）

## DEEIX-Chat（Apache-2.0）

- `backend/internal/domain/knowledgebase/types.go`：知识库只有 `builtin`（管理员维护、所有登录用户可见）与 `user`（仅所属用户）两种范围；
  带 `FileCount / ReadyFileCount / ProcessingFileCount` 统计。→ 我们扩展为 personal / project / department / org 四种范围，
  并保留“就绪 / 处理中 / 失败”计数（`KbSummary.stats`）。
- `application/knowledgebase/service.go`：可见性检查 `isVisibleToUser`、按批查询文件处理状态（processing snapshot）、显式
  `AddUserFiles`/`RemoveUserFile`（文件加入知识库是独立动作）、删除知识库可选择是否删除文件。→ 我们：显式 `POST /kb/:id/docs`；
  删除知识库/文档不删除 D 的文件；处理状态按文档版本给出。
- `application/conversation/service_message_send_retrieval.go`：检索结果区分 失败（取消/超时/不可用/失败）、未命中（含低于阈值）、
  命中；**显式选择的知识库是硬性来源要求**：检索失败或不可用时终止发送而不是静默忽略；选择了知识库但无命中时给模型一段
  notice，要求不得声称答案有知识库依据；记录 candidate/filtered 数、最高分、是否命中缓存；未命中时附件回退为全文。
  → 我们：`RetrievalDiagnostics.reason`（no_evidence / index_not_ready / forbidden / error）+ 计数 + `cached` + `strategy`；
  `kb_search` 输出针对每种原因给模型明确指示（no_evidence 时“不要声称答案有知识库依据”）；调试接口返回查询计划与候选数。
  全文回退属于附件（A/D 的附件上下文），不在知识检索中做。

## LambChat（MIT + 名称/标志保留条款）

- `src/api/routes/memory.py`：记忆 CRUD；字段 `source`（manual 等）、`source_refs`（会话来源引用，写入前校验调用者对来源会话的访问）、
  `memory_type`、`revision_id`（每次更新换新）、内容长度限制、导入导出。
- `src/infra/memory/scope.py`：scope = user / project / reference；**项目归属只来自可靠来源**（显式参数或会话元数据），拿不到
  project_id 的项目类内容降级为 user，不猜。→ 我们：`memory_save` 的 project 范围只取运行所在空间的 `projectId`（不由模型提供），
  非项目会话中请求 project 范围直接报错；scope 必填。
- 我们增加了 LambChat 未见到的：纠正流程（旧条目 superseded、新条目 corrected、双向链接、修订历史）与“该空间上下文包含哪些记忆”
  的可视接口；私人记忆在项目会话中一律不注入。

## pi-durable 1.5.0

- 工具 `replay: "safe"` 才会在崩溃后重跑；`details` 通道给 UI，`output` 给模型；系统提示词段每次请求前渲染，只发送变化部分，
  并以 `pi.system` 条目记录（测试据此验证段内容）；压缩后为新上下文重新写入段。
- `PromptInput` 只有 `conversationId / agent / env / read`：空间与行动者需借助 A 的 `wr.space` 会话文档与 `principalOfRun`。

## SQLite

- 3.53.4，FTS5 `tokenize='trigram'` 可做中文子串检索；<3 字的词无法命中 trigram 索引 → LIKE 回退；小语料下 bm25 的 IDF
  会被截断到接近 0，因此最终分数以“查询词覆盖度”为主、bm25 为辅。
