# HTTP / SSE API 草案（冻结 v1）

所有路由在 `/api` 下；认证用 httpOnly cookie `wr_session` 或 `Authorization: Bearer <token>`。错误体：`{ error: { code, message, detail? } }`。
每组拥有自己的前缀，可**增加**字段/路由，不得破坏已有字段。DTO 类型放在 `shared/<组>.ts`，前端通过 `@shared/*` 引用。
pi-durable 的 id（conversation/entry/task/submission）是数字，在 API 中保持为 number；会话以 `(spaceId, conversationId)` 定位。

## 身份（E，基线已实现）
- `POST /auth/register {email,name,password,orgName?,inviteCode?}` → `{me, token}`
- `POST /auth/login {email,password}` → `{me, token}`；`POST /auth/logout`
- `GET /me` → `{me:{userId,orgId,orgName,orgRole,name,email}, personalSpaceId, brand}`
- `GET|POST /projects`，`GET|PUT /projects/:id/members {email, role|null}`

## 会话与运行（A） — DTO：`shared/chat.ts`
- `GET /conversations?spaceId=&projectId=&q=&limit=` → `{conversations: ConversationSummary[]}`（默认跨所有可读 space）
- `POST /conversations {spaceId?, projectId?, title?, modelId?}` → `{conversation}`
- `GET /conversations/:spaceId/:id` → `{conversation, parent?:{conversationId, entryId}, branches: ConversationSummary[], agent}`
- `PATCH /conversations/:spaceId/:id {title?, archived?, modelId?, thinkingLevel?}`（`modelId`：切换已有对话的模型，需会话写权限 + 网关可见；`thinkingLevel` 须是该模型支持的档位，缺省为模型默认；记一条 `wr.notice`（code `model_switched`），从下一次请求起生效；分支各自保留自己的模型）
- `GET /conversations/:spaceId/:id/entries?before=&limit=` → `{items: EntryDTO[], next?}`
- `GET /conversations/:spaceId/:id/events`（SSE）：`snapshot`（连接时完整 `ConversationState`）、`state`（变化时完整状态，节流）、`ping`。断开只停止订阅。
- `POST /conversations/:spaceId/:id/messages {text, requestId, attachments?, knowledgeRefs?, mode?: "auto"|"steer"|"followUp"}` → `{submissionId, status}`；同 requestId 返回同一 submission
- `POST .../fork {entryId, title?}` → `{conversation}`
- `POST .../edit {entryId, text, requestId}` → `{conversation, submissionId}`（新分支，原会话不变）
- `POST .../regenerate {entryId}` → `{conversation, submissionId}`（新分支）
- `POST .../abort`，`POST .../continue`
- `POST .../approvals/:approvalId {decision: "approved"|"rejected", note?}`
- `GET .../submissions/:submissionId` → `{status: "received"|"queued"|"applied"|"done"|"unanswered"|"withdrawn", reason?}`
- `GET .../tasks` → 子 Agent/任务树 DTO

## 文件（D） — DTO：`shared/files.ts`
- `GET /files?spaceId=&projectId=&q=`；`POST /files`（multipart：`file`, `spaceId`|`projectId`）→ `{file, version}`
- `GET /files/:id` → `{file, versions:[{versionId, versionNo, size, mime, createdAt, createdBy, changeNote, provenance}]}`
- `POST /files/:id/versions`（multipart，`changeNote`）；`GET /files/:id/versions/:vid/download`；`GET /files/:id/versions/:vid/preview`

## 知识与记忆（C） — DTO：`shared/knowledge.ts`
- `GET|POST /kb`，`GET /kb/:id/docs`，`POST /kb/:id/docs {fileId, versionId}`（显式加入），`POST /kb/:id/docs/:docId/retry`，`DELETE /kb/:id/docs/:docId`
- `POST /kb/search {query, kbIds?}`（检索调试，返回命中与诊断）
- `GET /memory`，`POST /memory`，`PATCH|DELETE /memory/:id`

## 工具（D） — `/connectors`、`/skills`、`/sandbox/:spaceId/...`
## 运营（E） — `/models`、`/admin/*`、`/usage`、`/stats`、`/automations`、`/notifications`
