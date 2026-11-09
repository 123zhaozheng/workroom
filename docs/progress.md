# 集成进度日志（集成者维护）

- 2026-11-09 冻结架构 v1；锁定 pi-durable 1.5.0；基线 identity 与共享契约；5 个工作组（A–E）作为真实并发 Agent 启动（Opus，effort high）。
- 2026-11-09 第一阶段集成：A–E 五组完成首轮交付。集成者处理共享契约请求（RuntimeService 工具/提示作用域方法、via 扩展）、锁定依赖、修正模块加载（模块内错误不再被静默吞掉）。
  集成者独立验收 `server/test/acceptance-loop.test.ts`（公开 HTTP，含真实重启）通过；全量后端 `npm test` 101/101（70s）；server/web typecheck 通过；web build 通过。
  发现并记录：fixture 回答显示 faux provider 估算的 token 数（需改为“模拟用量/不计量”）；模型选择器文案重复；标题含 fixture 指令。
- 2026-11-09 部署演练（M18-A）：从 `artifacts/backups/workroom-20261109T025135Z.bundle` 克隆到空目录 → `npm ci`（14s）→ `npm run build:web` → `npm start`，`/api/health` 与 `/` 均 200；页面不引用任何外部主机（字体离线）。
- 2026-11-09 第二轮（A–E 并发）启动后约 02:55 UTC 全部因账号 5 小时用量上限中断（429），未产生半成品提交；06:41 UTC 额度恢复后通过 SendMessage 让同一批 Agent 带原上下文继续。
- 新增 `npm run acceptance`（M18-C 固定回归：集成者闭环验收 + 纵向证明 + 浏览器 e2e）。
