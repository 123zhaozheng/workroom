# 文件所有权与协作规则

| 组 | 职责 | 拥有路径（只改这些） |
|---|---|---|
| 主（集成者） | 架构、共享契约、组合根、测试 harness、验收矩阵、最终集成与对抗验收 | `server/src/core/**`, `server/src/modules.ts`, `server/src/main.ts`, `server/test/helpers/**`, `docs/architecture.md`, `docs/ownership.md`, `docs/acceptance-matrix.md`（各组可更新自己负责的行）, `package.json` 根 scripts |
| A 运行内核 | pi-durable harness owner、租约、恢复、会话/分支/编辑重试/再生成、提交/插话/取消、SSE watch、子 Agent 与小队、审批与外部写 effect 协议、fixture 模型脚本 | `server/src/runtime/**`, `server/test/runtime*.test.ts`, `server/test/proof*.test.ts`, `shared/chat.ts`, `docs/runtime.md` |
| B Web | 全部前端、视觉系统 tokens、组件、页面、浏览器端测试与截图 | `web/**`, `shared/ui.ts`（若需）, `docs/ui.md`, `artifacts/screenshots/**` |
| C 知识 | 知识库、解析、分片、FTS 检索、ACL 过滤、引用定位、记忆 | `server/src/knowledge/**`, `server/test/knowledge*.test.ts`, `shared/knowledge.ts`, `docs/knowledge.md` |
| D 文件与工具 | 文件库/版本/预览/下载、成果生成（docx/xlsx/pptx/pdf/md/html）、MCP、skills、云端沙箱、浏览器工具 | `server/src/files/**`, `server/src/tools/**`, `server/test/files*.test.ts`, `server/test/tools*.test.ts`, `shared/files.ts`, `docs/files-tools.md` |
| E 组织与运营 | 身份/组织/部门/成员/会话撤销/审计（接手 `server/src/identity/**`）、模型网关/渠道/路由/fallback、用量与预算、自动化与通知、统计与管理 API | `server/src/identity/**`, `server/src/ops/**`, `server/test/identity*.test.ts`, `server/test/ops*.test.ts`, `shared/ops.ts`, `docs/ops.md` |

## 规则

1. 只改自己路径。需要改共享文件（`server/src/core/**`、`contracts.ts`、`modules.ts`）时，在 `docs/requests/<组>.md` 写明需求，或在交付报告中说明；集成者统一修改。
2. 每个模块导出一个 `WorkroomModule`（`server/src/<module>/module.ts`），`modules.ts` 会自动加载。迁移表名使用模块前缀：`rt_`、`kb_`/`mem_`、`file_`/`tool_`/`skill_`/`mcp_`、`id_`/`ops_`/`usage_`/`auto_`。
3. 安装依赖必须串行：`flock /home/user/workroom/.npm.lock npm install --save-exact <pkg>`（前端：`-w web`）。不要删除或重写他人依赖。
4. 提交必须串行且只提交自己的路径：`cd /home/user/workroom && flock .git.lock sh -c 'git add <你的路径> && git commit -m "<组>: ..."'`。不要 `git add -A`，不要改写历史，不要 push。
5. 类型检查：`npx tsc -p server/tsconfig.json --noEmit`；他组 WIP 造成的错误不要去改，记录即可。测试：`node --disable-warning=ExperimentalWarning --test server/test/<你的>.test.ts`。
6. 端口：A 8801、B 5173/8802、C 8803、D 8804、E 8805、集成 8787。每组用自己的 `WORKROOM_DATA_DIR=/home/user/workroom/data/dev-<组>`。
7. 不得伪造：未连接的真实凭据（模型/支付/SSO/邮件/外部 MCP）标为 blocked；fixture 只验证契约。
