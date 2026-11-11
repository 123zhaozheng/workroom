# 沙箱支持矩阵

## A. 第 7 轮开工前（提交 `1c509b8`），逐条对照源码

**图例**
- **已实现**：代码已有，并有测试证据。
- **仅配置**：只有配置项或界面，没有执行路径。
- **未实现**：代码里没有。

**对外部厂商的支持**：开工前**没有任何外部厂商（OpenSandbox、E2B、Daytona、Kubernetes Agent Sandbox）的代码**，`DriverId` 只有 `"namespaces" | "docker" | "none"`（`server/src/tools/sandbox/driver.ts`）。

### 驱动

| 驱动 | 状态 | 文件 | 说明 |
|---|---|---|---|
| `namespaces` | 已实现 | `sandbox/namespaces.ts` | Linux 下的 user/mount/pid/net/ipc/uts 命名空间，用 pivot_root 进入只读系统镜像，只有 `/work` 可写。用宿主机自带的 python3 和 node，rlimit 是按进程而不是按整个沙箱限制。`capabilities.network = false`，无法联网。 |
| `docker` | 已实现 | `sandbox/docker.ts` | 每次运行一个容器：根文件系统只读、非 root、丢弃全部 capabilities、默认 seccomp、`--network none`（管理员可放开）、cgroup 限制 CPU/内存/进程数，容器打标签，`reapStale` 清理遗留容器。真实 Docker 测试见 `server/test/tools-sandbox-docker.test.ts`。 |
| `none` | 已实现 | `sandbox/none.ts` | 不执行任何代码，每次调用都返回明确的启用说明。 |
| 选择方式 | 已实现 | `sandbox/registry.ts` | `auto`、`namespaces`、`docker`、`none` 四种，**整个实例共用一套设置**，表 `tool_sandbox_settings`；也可用环境变量 `WORKROOM_SANDBOX_DRIVER` 指定。 |

### 能力

| 能力 | namespaces | docker | 依据 |
|---|---|---|---|
| 执行命令，返回退出码、stdout、stderr | 已实现 | 已实现 | `Sandbox.run` → `driver.run` |
| 超时与取消（AbortSignal） | 已实现 | 已实现 | `namespaces.ts:195`、docker kill |
| 输出流 | 未实现 | 未实现 | 驱动内部收集完整输出后一次返回，对上层没有增量回调 |
| 工作区文件（读、写、列表、上传、删除、预览、发布） | 已实现 | 已实现 | 由宿主机目录 `<dataDir>/…/c<会话>` 承担，绑定挂载到 `/work`；见 `sandbox/workspace.ts`、`sandbox-routes.ts` |
| 只读挂载（技能） | 已实现 | 已实现 | 内核级只读绑定挂载；物化目录在 `<dataDir>/sandbox-mounts`（`sandbox.ts #collectMounts`） |
| 长驻进程（沙箱内的 MCP stdio 服务） | 已实现 | 已实现 | `sandbox/services.ts`：只在内存中登记，带空闲和寿命上限；服务重启后需要重新拉起 |
| 网络开关 | 不支持联网 | 已实现 | docker 默认 `--network none` |
| 资源限制 | rlimit | cgroup | — |
| PTY、预览 URL、快照、暂停/恢复 | 未实现 | 未实现 | 代码中没有 |
| 持久化与恢复 | 运行记录 `tool_sandbox_runs` | 同左，另有容器标签 | 沙箱本身每次运行即用即毁，没有长期存在的沙箱实例需要持久化。后台作业重启后按 `rerun` 或 `fail` 策略处理（`jobs.ts`）。 |
| 孤儿清理 | 子进程随服务一起退出；`killStale` 处理遗留 pid | `reapStale` 按标签清理 | — |
| 多租户隔离 | 已实现 | 已实现 | 每个空间、每个会话各有自己的工作区目录；访问控制在 `sandbox-routes` |

### 上层链路

上层链路全部基于宿主机目录：
- 技能：按需物化并挂载（第 6 轮）；
- 技能草稿：`snapshotDir` 读取宿主机工作区；
- 文件工具：`sandbox_write_file`、`sandbox_read_file`、`sandbox_publish` 等；
- 文档渲染：`execIsolated` 带 `hostTools` 时只允许 namespaces 驱动。

## B. 第 7 轮完成后

（集成完成后补充，各项按“真实联调通过 / 已实现但未联调 / 不支持”标注。）
