# 集成进度日志（集成者维护）

- 2026-11-09 冻结架构 v1；锁定 pi-durable 1.5.0；基线 identity 与共享契约；5 个工作组（A–E）作为真实并发 Agent 启动（Opus，effort high）。
- 2026-11-09 第一阶段集成：A–E 五组完成首轮交付。集成者处理共享契约请求（RuntimeService 工具/提示作用域方法、via 扩展）、锁定依赖、修正模块加载（模块内错误不再被静默吞掉）。
  集成者独立验收 `server/test/acceptance-loop.test.ts`（公开 HTTP，含真实重启）通过；全量后端 `npm test` 101/101（70s）；server/web typecheck 通过；web build 通过。
  发现并记录：fixture 回答显示 faux provider 估算的 token 数（需改为“模拟用量/不计量”）；模型选择器文案重复；标题含 fixture 指令。
- 2026-11-09 部署演练（M18-A）：从 `artifacts/backups/workroom-20261109T025135Z.bundle` 克隆到空目录 → `npm ci`（14s）→ `npm run build:web` → `npm start`，`/api/health` 与 `/` 均 200；页面不引用任何外部主机（字体离线）。
- 2026-11-09 第二轮（A–E 并发）启动后约 02:55 UTC 全部因账号 5 小时用量上限中断（429），未产生半成品提交；06:41 UTC 额度恢复后通过 SendMessage 让同一批 Agent 带原上下文继续。
- 新增 `npm run acceptance`（M18-C 固定回归：集成者闭环验收 + 纵向证明 + 浏览器 e2e）。
- 2026-11-09 07:16 UTC 第二轮集成验收（合并树）：server/web typecheck 通过；`npm test` 131/131；`npm run acceptance`：闭环+证明 4/4，浏览器 e2e 110/110（core-loop 36、states 24、pages 31、round2 19）。集成者审查 e2e：`check(…,true)` 均位于会抛错的 wait 之后；已要求并确认移除“未连接即通过”的回退分支。
  第二轮新增：消息级结果、服务端标题、交接摘要（M09-B，派生自 pi 状态，无新事实表）、审批/外部写审计、模型可用性检查、模拟用量标注、空闲回收、后台作业（M14-C）、浏览器接管、DNS 重绑定防护、工具策略、PPTX 渲染、密钥轮换、Webhook SSRF 防护、跨模块 trace、子 Agent 知识范围、引用失效批量查询、可操作的自动化/管理/能力页面。
