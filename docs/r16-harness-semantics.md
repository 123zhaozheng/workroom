# 第 16 轮：文件、技能、交付语义统一与能力闭环（H2）

范围：需求文档 三.3（统一文件、技能和交付语义）与 三.4（补齐能力使用的闭环）。上下文瘦身、工具按需加载、常驻“工作方式”规则由 H1 负责，不在此文。

## 一、发现的不一致（证据 → 处理）

| # | 现象 | 证据 | 处理 |
| --- | --- | --- | --- |
| 1 | 提示词说“/memory 用 expected_etag 防覆盖”，但 agent 不带 etag 直接 `write` 已有记忆文件会静默覆盖，可能冲掉用户刚在记忆页的修改（前端保存用 If-Match，agent 路径没有） | `vfs/backends/memory.ts` write 把 `expectedEtag` 原样透传，`MarkdownMemory.write` 在 `ifMatch === undefined` 时直接覆盖 | 后端：已有文件且未带 etag → `etag_required`（428），提示先 read；etag 不一致沿用原有 `etag_mismatch`，不改任何内容 |
| 2 | “不写密码/密钥”只是提示词建议，后端无任何拦截 | 全仓只有日志脱敏用 `redactText` | `findMemorySecret`（复用 `ops/log.redactText` + 私钥块 + 中文“密码：”）：只检查本次**新增的行**，已有内容不会挡住无关编辑；命中 → `secret_refused`（422）。仅限 agent 的 /memory 写入，用户自己在记忆页的编辑不拦截 |
| 3 | 只读技能（已安装/组织/市场）写入失败时只说“copy_to_work 后改副本”，但副本改完无法回到技能里；正确路径是 `skill_manage` checkout → submit_draft | `vfs/backends/skills.ts` `#denyReadOnly` | 错误文案改为指向 `skill_manage checkout` → `submit_draft`（用户确认后成为新版本）；只想参考才 copy_to_work |
| 4 | `/skills` 的两条修改路径没有说清：个人技能直接写 = 立即生成新版本（无需用户确认）；skill_manage = 走草稿+确认（市场技能走审核） | `skills.ts` `#commit` → `addVersion`；`skill-drafts.ts` | 文件段与 skill_manage 描述都按这个语义重写；skill_manage 描述约 1.5k → 约 330 字符，保留 checkout → 改 → submit_draft → 确认 → 新版本、version 要递增、市场技能名冲突的处理 |
| 5 | 描述说后台任务“结果发布到文件库”，实际 `Files.putVersion` 只写文件服务，不进入文件库、没有卡片（r14 V23 设计）；而且 browse/generate 任务的输出在 /work 里根本不存在，`present_file` 无法交付 | `tools/jobs.ts` `put`；`present_file` 只接受 /work 与 URL | 统一“交付 = present_file 成功”：job_start/job_status 文案明确“任务输出是中间文件，未交付”；browse/generate 的文本输出同时写入 `/work/jobs/<jobId>/<name>`，job_status 完成后列出可交付的 /work 路径 |
| 6 | `browse` 描述称截图“保存到文件库”，结果写“截图已保存” | `tools/browser.ts` | 改为“中间文件（未交付）”。截图字节仍只在文件服务中，暂不能 present（见“未完成”） |
| 7 | job_status 只有 queued/running/done/failed/cancelled/timeout；服务重启打断、声明为不可重跑的任务显示为普通 `failed`，模型会误以为没执行过而重做 | `tools/jobs.ts` 重启分支 | 该分支错误文案以“结果未知：”开头，job_status 渲染为“结果未知（failed）”并提示先检查 /work 与外部状态；其余状态给出中文标签。`DTO/JobStatus` 类型不变，前端不受影响 |
| 8 | `delegate` 只说“member：成员 id”，但没有任何地方告诉模型有哪些成员、id 是什么（只有填错后的报错里才列出） | `runtime/team.ts` | 新增 `team` 提示段：成员 id、名称、一句话用途；外部工具/第三方 Agent 标注；成员自己的子会话、不含 delegate 的白名单不显示。delegate 描述改为引用该段并提醒核对返回 |
| 9 | 浏览器会话只返回标题+正文，动作是纯坐标点击：模型没有任何依据知道元素在哪 | `tools/browser-sessions.ts` `result()` | 每次 open/act 的结果新增：刚才的操作、URL/标题、视口内（最多 40 个）可点击元素的“标签 类型 文字 (x,y) 焦点”、正文（4000 字符上限不变）。形成 观察 → 点击/输入 → 新观察核对 的闭环 |
| 10 | kb_search 描述没有指向 kb id 来源 | `knowledge/extension.ts` | 描述指向“当前可检索的知识库”段，说明 kbIds 可省略、无结果要如实说明（`knowledge_scope` 段本来就列出 id 与名称，`memory_save` 是 legacy 工具，新会话不提供） |

另：所有我负责的工具描述已压缩为中文短句，最长约 330 字符；files 段由约 600 字符降到约 560 字符，同时补齐了技能修改路径、memory 并发规则和“后台任务输出也需 present_file”（H1 的通用规则段不再重复这些文件语义）。

## 二、已核对且无需改动

- `present_file`：同会话同名覆盖、不留版本、同一 fileId 只一张卡；结果文案区分 已交付 / 已更新（同名覆盖）/ 内容未变化 / 已有更新的同名交付，卡片状态来自 `lib_items`（r14 已有，`r14-delivery.test.ts` 覆盖，本轮新测试再确认一次）。
- 撤回：`remove /library/...` → 卡片显示已删除。
- `/uploads` 读取不启动沙盒；处理需 `copy_to_work`（已有 overwrite 语义）。
- 记忆前端保存使用 If-Match（`web/src/pages/MemoryPage.tsx`），并发冲突返回 409，提示重新读取。
- exec：`replay: "unsafe"`，重启打断的命令不会重跑，结果标注中断；描述中说明“先检查再重试”。
- 长任务进度用 pi-durable 任务与 `wr.jobs` 文档、`tool_jobs` 表保存，不混入长期记忆（memory 段明确“任务进度不写在这里”）。

## 三、验证

- `npm run typecheck` 通过。
- 新增 `server/test/r16-semantics.test.ts`（8 项，全部通过）：记忆 etag 必填/用户并发编辑不被覆盖/凭证拒绝；只读技能错误指向 skill_manage；同名 present_file 覆盖且一张卡、job 输出不在文件库且 job_status 给出 /work 路径；job 各状态与“结果未知”；delegate 成员目录（自定义助手、默认助手、子会话不显示）；浏览器观察渲染与元素采集；files 段长度与关键规则。
- 回归：`r14-*`、`runtime-team`、`knowledge-*`、`skills-*`、`files*`、`tools-sandbox-files`、`tools-browser*`、`r13-job-atomic`、`tools-jobs` 共 98+ 项，唯一失败项在改动前同样失败（环境限制：沙盒内 `Cannot fork`、没有 Chromium），见下。

## 四、未验证 / 未完成

- 本环境沙盒无法 fork、没有 Chromium：真实 exec、后台 sandbox 任务（含重启恢复）、浏览器 e2e（真实点击后的元素列表）无法运行，相关既有测试在改动前后均失败。job 状态与浏览器观察用服务层/渲染层测试覆盖。
- browse 截图与 job 的截图输出仍只在文件服务里，没有 /work 路径，无法 present；如需交付需要在 `BrowserService.browse` 返回字节（不在本轮范围）。
- `/skills` 个人技能直接写入不经用户确认（r14 既有设计），本轮只把语义写清，没有改变。
- 记忆密钥检测是启发式（常见 token 形态、`key=value`、私钥块、中文“密码：”），不能保证拦住所有形式；不处理用户自己在记忆页的输入。
