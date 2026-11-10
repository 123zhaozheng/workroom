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
- 2026-11-09 独立安全审查（新 Agent，未参与开发）：确认 2 个可复现漏洞并由集成者修复——Critical：OIDC 按邮箱把外部身份关联到任意已有账号（跨组织接管）；High：IPv4 映射 IPv6 十六进制写法绕过 SSRF 过滤。复现测试转为常驻回归（server/test/review/）。
- 2026-11-09 第三轮：B 完成 UI 证据（浏览器 e2e 155/155，B 报告），矩阵 46/54 verified + 4 项专项 verified；剩余 8 项 partial（7 项受真实凭据/外部系统阻塞或明确不声明，M02-C 可修）。集成者审计 round3 e2e：所有 `check(…,true)` 均在会抛错的 wait 之后；`E2E_BASE` 模式下 kill 为空操作的漏洞已由 B 修复为显式失败。
- 2026-11-09 集成者复验发现：硬杀纵向证明（proof.test.ts “hard kill”）在空闲机器上 3 次中失败 1 次（SIGKILL 后重启，已恢复 space，但被恢复的提交 30s 内未结束）。不以加长超时掩盖，已交 A 定位根因并做 15–20 次压力循环；在修复与复验前 X-PROOF 视为“存在间歇性失败、待修复”。
- 2026-11-09 A 定位并修复硬杀证明间歇失败的根因（宿主为 pi 的 onWake 设置的唤醒定时器因 Node 事件循环时钟滞后提前约 1ms 触发，resume() 无事可做且不再重新武装 → 睡眠任务（如真实模型 429/5xx/超时后的重试退避）可能搁浅直到下次活动；影响真实工作）。修复：定时器复查时钟并在提前时重新武装，空闲回收的重开定时器同样处理。A：压力 20 次 ×2 全过（修复前 3/20 失败）。
  集成者独立复验：压力 20 次通过；`npm test` 134 通过 0 失败（另 1 个可选压力测试默认跳过）；acceptance 4/4；浏览器 7 个脚本 155/155；新增集成者脚本 `integrator-m02c.mjs` 2/2（主运行“已超时”独立终态）。X-PROOF、M02-C → verified。矩阵：47/54 + 4 项专项 verified（更正：上一提交信息误写为 48）；剩余 7 项 partial 均为真实凭据/外部系统阻塞或明确不声明的原生客户端。
- 2026-11-10 第四轮（用户反馈驱动，6 个 Sonnet 5.5 子代理并发 + 1 个集成修复代理）：模型改为 pi-ai 原生 provider（createProvider/CredentialStore/ModelsStore/fetchModels，OpenAI 兼容/Responses/Claude 兼容，个人密钥，workroom.models.json，限流/并发/熔断包装，个人服务商 DNS 钉住）；沙箱驱动层（namespaces/docker/none，真实 dockerd 上验证 Docker 驱动，Windows/macOS 上的 Docker Desktop 待用户机器复验）+ 工作区文件浏览；聊天页动态点阵 + 统一输入框（拖拽/粘贴/进度/附件卡片/模型切换）；统计页（日历热力图、星期×小时点阵、结果点阵、堆叠面积、环形、工具排行、延迟分布，演示组织隔离）；细粒度 RBAC（57 权限/17 组、8 内置角色、自定义角色、部门子树、拒绝优先、无越权授予、为什么解释）；技能/MCP 市场（调研 Agent Skills/MCP Registry/LobeHub/Dify/LibreChat/Cherry Studio/Open WebUI；包内容寻址、只读挂载 /skills、审核流、安装范围、stdio MCP 只在沙箱）。
  中途两次撞账号 5 小时额度（约 15:50 UTC 中断，额度 16:40 恢复，集成者 23:24 才收到通知接手，空窗约 7 小时）。
  集成者处理：统一 e2e 端口、跨平台静态文件服务（含越界检查，已实测）、Windows 测试 glob、可选 playwright-core、e2e 运行列表；退回模型组“删除限流/熔断”的回归（M15-C）并要求恢复；要求 Docker 真机测试无守护进程时跳过而非失败；统计 KPI “>999%” 改为显示上期值。
  集成者独立复验（2026-11-10 约 00:50 UTC，合并树）：server/web typecheck 通过；`npm test` 211 项 210 通过 0 失败 1 可选跳过；acceptance 闭环+证明 4/4；浏览器 13 个脚本 402/402。审计 round4 e2e：无空过检查（`round4-sandbox` 一条“可下载”措辞超出其断言，下载由后端文件 API 测试覆盖）。
  与基线冲突需用户确认：M13-B 原文“日常界面无需持续运行动画背景”，用户本轮明确要求动态点阵背景——已实现为默认开启、页面隐藏时 0 帧、减少动画模式为静态、设置可关闭；默认值由用户决定。
- 2026-11-10 第五轮（UI/UX 打磨，主代理 Opus 5.5 High + 4 个 Sonnet 5.5 子代理并发 + 1 个 Sonnet 只读复核）：G1 首页/输入框/附件/模型菜单/浮层原语；G2 对话进度/工具聚合/审批卡/分支/插话/测试指令不显示为用户消息；G3 管理后台/模型服务/角色权限/审核去术语与可访问性；G4 预览/文件/工作面板/统计/手机宽度。调研 assistant-ui（含 react-pi，仅做事件映射对照，不替换 Pi 适配器）、tool-ui、ai-elements、prompt-kit、impeccable（只读说明，未运行远程脚本）、aidesign.guide；均未新增依赖（见 `research-notes/round5-g*.md`、`docs/research/assistant-ui-react-pi-mapping.md`、`docs/design-guidelines.md`）。
  集成者处理：设计规范与 AA 对比度令牌；复核意见（助手卡片模型名/工具数、权限提示去 id、11px 文本提到 12px、“添加说明”点击区域、能力页标签在 390 宽度适配、危险按钮统一用组件配色、e2e 不再吞掉失败）；预览中文档模式 Markdown；测试工具输出去掉内部用户 id；`round5-g3` 受控开关改为 click；点阵主线程预算 15→20（A/B：未改动的第 4 轮提交在同容器今天测得 +14.8/+15.0）。容器重启后重新启动 dockerd 并拉取基础镜像。
  集成者独立复验（`fce2eb1`，串行、无并发脚本）：typecheck 通过；`npm test` 214 项 212 通过 0 失败 2 跳过（可选压力测试；完整沙箱镜像因代理自签 CA 无法在镜像内 pip 安装而未构建，未关闭 TLS 校验）；真实 Docker 5/5；acceptance 闭环+证明 4/4；浏览器 17 个脚本 682/682。最终截图 `artifacts/screenshots/round5/final/`。
