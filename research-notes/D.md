# D 组研究笔记（文件 / 工具 / MCP / 技能 / 云端执行）

## 参考项目（只参考行为，未复制代码）

- **PigeonAgent `app/agents/tools/workspace.py`**：Agent 发布文件 = 写入统一文件记录 + 向前端发“成果”事件。对应做法：`file_create`/`file_revise`/`sandbox_publish`/`browse` 的工具结果 `details.artifact`（FileVersionRef），前端据此渲染文件卡片；文件本身进入文件库并带来源。
- **DEEIX-Chat `mcp/service.go` + `service_tool_execution.go`**：MCP 调用有参数校验、启用范围、结果预算、调用记录与计费关联。对应：pi 按工具 JSON Schema 校验参数；调用时检查连接启用/用户启用/ACL；`tool_calls` 记录（参数摘要脱敏、耗时、状态、错误）；输出受 pi 输出限额约束。
- **DEEIX-Chat `service_skill_prompt.go`**：选中 Skill 只把 SKILL.md 作为上下文注入，并明确声明“不授予执行系统命令、脚本、后台任务、网络或未选择工具的权限”。对应：`skill_load` 返回同样的声明；执行只能走 `skill_run` + 按版本授权，二者分开验收。
- **LambChat skills/sandbox**：技能市场 + 沙箱执行。我们补上了版本固定/回滚、按版本授权、运行记录精确版本、从任务整理并经样例验证后发布。

## pi-durable 1.5.0 要点（已在代码中使用）

- `ToolRegistration.replay`：`safe` 才会在崩溃后重跑；外部写必须靠自己的幂等（文件写入的幂等键、effects 文档的回执）。
- `deferred: true` + `control.addTools`：大工具集按需加载；加载记录在分支的 `modelTools`。
- `callers: ["model"]`：工具不被 code mode 脚本调用（我们用于 MCP 工具，避免进程级注册表经 `searchTools()` 泄露其他组织的工具名）。
- 注册表 `RegistryState.tools()` 在每次快照时读取 `extension.tools`：用 getter 可让新发现的 MCP 工具无需重装即可出现；同时调用 A 的 `reinstallExtension` 发布新状态。
- `createCodemodeExtension({ sandbox: new CodemodeSandbox(...) })`：QuickJS 隔离，脚本确定性重放。
- pi 自带 `tool_search` 搜索注册表中所有 deferred 工具（跨租户）——我们自己实现了按用户过滤的同名工具，并请求 A 不安装通用版。

## 环境探测（本主机）

- `unshare --user --map-root-user --mount --pid --net --ipc --uts --kill-child` 可用；`pivot_root`、`setpriv`、`prlimit` 可用 → 采用命名空间沙箱。
- `docker` 二进制存在但 daemon 不可用（`/var/run/docker.sock` 不存在）→ 不使用容器。
- 运行在 root 下：`--map-root-user` 映射为宿主 root；因此必须 pivot_root + 只读绑定 + 丢弃 capabilities，仅限制 cwd 不是隔离。
- Node 22 的 V8 在 512 MB 地址空间下无法启动（CodeRange 预留）→ node 语言给 1 GB 地址空间并设 `--max-old-space-size`。
- Playwright 1.63.0 预装在 `/opt/node-tools/node_modules/playwright`，浏览器在 `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`；ESM 中用 `createRequire` 加载。
- CJK 字体：仅 `wqy-zenhei.ttc`（TTC 集合）。pdf-lib 只能嵌入单字体 → 写了 TTC→TTF 抽取（表目录重写），再用 fontkit 子集嵌入；PDF 中文可被 unpdf 提取回读。

## 设计决定

- 文件权限 = 所在空间权限，每次请求实时计算；版本行用触发器保证不可变。
- stdio MCP 会在服务器上启动进程：仅系统连接 + 管理员 + 运维白名单命令前缀；个人连接只能 HTTP 并受 URL 策略约束。
- 未配置 `WORKROOM_SECRET_KEY` 时拒绝保存密钥（不降级为明文）。
- 写类 MCP 工具在没有 effects 服务时拒绝执行（fail closed）。

## 第二轮

- 后台任务：`TaskOptions.background` 只对会话所有的任务有效（不参与普通 idle 等待、会话 abort 与级联）。phase 中途因 Harness 关闭或 abort 标记而抛错时调度器返回 END（不 fault），因此任务在重启后从 phase 顶部重跑，或由 abort 处理器收尾；用 durable memo `attempt:N` 区分“首次运行”和“被中断后的重跑”。
- `--kill-child` 下若沙箱程序直接 exec 为 pid 1 并被信号杀死，unshare 会以 “sigprocmask unblock failed” 退出 1；改为 shell 留作 pid 1，退出码恢复为 128+N。RLIMIT_CPU 软硬相同会直接 SIGKILL，需设软/硬两档。
- DNS 固定：Playwright 的 `route.fulfill` 让服务端完全接管网络（Chromium 不解析域名）；MCP SDK 的 `StreamableHTTPClientTransport` 接受自定义 `fetch`。
- LibreOffice 在沙箱内可运行，但需要绑定 `/etc/libreoffice`（`share/registry` 是指向它的符号链接）并设置可写的 `UserInstallation`。
