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
| `namespaces` | 已实现 | `sandbox/namespaces.ts` | Linux 下的 user/mount/pid/net/ipc/uts 命名空间，用 pivot_root 进入只读系统镜像，只有 `/work` 可写。用宿主机自带的 python3 和 node，rlimit 是按进程而不是按整个沙箱限制。`capabilities.network = false`：无法联网，这是技术限制而不是策略（非特权用户命名空间不能自行出网；去掉 `--net` 会共享宿主网络栈，不可接受），环境面板如实写“无网络（本机命名空间驱动的技术限制）”。 |
| `docker` | 已实现 | `sandbox/docker.ts` | 每次运行一个容器：根文件系统只读、非 root、丢弃全部 capabilities、默认 seccomp、网络由部署决定（第 9 轮起默认 Docker 桥接网络 `bridge`，环境变量 `WORKROOM_DOCKER_NETWORK` 可设为 `none` 或自建网络，没有面向用户的开关；见 `docs/r9-network.md`）、cgroup 限制 CPU/内存/进程数，容器打标签，`reapStale` 清理遗留容器。真实 Docker 测试见 `server/test/tools-sandbox-docker.test.ts`。 |
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
| 出站网络 | 无网络（技术限制） | 默认可联网（桥接） | 第 9 轮起 Workroom 没有自己的“无网络”开关或策略；docker 用 `WORKROOM_DOCKER_NETWORK`（部署级，默认 `bridge`，可设 `none` 或自建网络）；内部文档渲染（`execIsolated`）仍固定断网 |
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

## B. 第 7 轮（含 7b）完成后

**图例**
- **联调通过**：对真实服务运行合同测试，并通过。
- **已实现未联调**：代码完成，单元测试使用的是标注清楚的 SDK 替身，没有接真实服务。
- **不支持**：返回 501 `UNSUPPORTED`，绝不回退到宿主机执行。

### 驱动与提供方

| 提供方 | 版本 / 许可 | 状态 | 证据 |
|---|---|---|---|
| namespaces、docker（本机） | — | 联调通过（与之前相同） | `server/test/tools-sandbox*.test.ts`；合同测试中适用于本机的 6 项 |
| OpenSandbox（自托管） | `@alibaba-group/opensandbox` 1.2.0，服务端 `opensandbox-server` 1.2.0，均为 Apache-2.0 | **联调通过**：本机 Docker 运行时 | `server/test/sandbox-contract.test.ts` 共 20 项、`server/test/sandbox-remote-e2e.test.ts` 共 1 项，都对 `scripts/opensandbox-local.sh` 拉起的真实服务运行 |
| E2B（官方，或明确配置的兼容端点） | `e2b` 2.63.0，MIT | 已实现未联调：没有密钥 | `server/test/sandbox-providers-unit.test.ts`，用 SDK 替身；真实测试自动跳过 |
| Daytona（厂商云） | `@daytonaio/sdk` 0.231.1，Apache-2.0 | 已实现未联调：没有密钥。开源仓库已于 2026-10-03 归档，不作为自托管开源方案 | 同上 |
| Kubernetes Agent Sandbox | — | 未实现，只做了调研 | `docs/research/sandbox-providers.md` |

### OpenSandbox 能力（实测）

| 能力 | 状态 |
|---|---|
| exec、输出流、取消、命令超时、文件、联网、重连 | 联调通过 |
| 出站网络 | 第 9 轮起 Workroom **不再要求提供方断网，也不再拒绝运行**：创建沙箱时不传任何网络参数（无 `networkPolicy`），由 OpenSandbox 服务自身配置决定。早先的实测：不带策略创建的沙箱可联网；带 deny 策略时 DNS 上游仍可达（存在隧道风险），此项 `networkOff` 现在不被 Workroom 使用。第 9 轮的联网实测结果见 `docs/r9-network.md`。 |
| 资源限制 | 未验证：参数已下发，但嵌套 Docker 环境中无法回读 cgroup 确认是否生效 |
| 长驻服务（沙箱内 MCP stdio）、PTY、预览、快照、暂停/恢复 | 不支持（501） |
| 技能 | 哈希校验后受控上传，再用 `chmod a-w` 设为只读。这不是内核级只读挂载；每次运行前会重新校验哈希 |

### 统一行为（远端驱动）

- 宿主机工作区是权威副本。每次运行时按 sha256 清单增量上传；运行结束后回传结果，回传时拒绝符号链接和特殊文件，路径规范化，限制大小。
- 实例持久化在表 `tool_sandbox_instances`，记录租户、提供方、远端 ID、状态和生命周期。
- 恢复时先重连并核实远端沙箱；如果已不存在，就重建并完整重新同步。
- 空闲回收、最长存活和孤儿清理按 metadata 标签进行。

### 第 7b 轮

| 项 | 状态 | 证据 |
|---|---|---|
| 工作区版本化（清单、哈希、原子提交、冲突处理、恢复与校验、安全回收、中断的运行标为“未知”） | 已实现，有测试；在 OpenSandbox 上真实联调通过 | `server/test/workspace-persist.test.ts`（14 项）、`tools-sandbox.test.ts`、`sandbox-remote-e2e.test.ts` |
| 普通环境变量（组织、项目、用户、会话四级；锁定；危险变量拒绝；审计只记哈希） | 已实现，有测试 | `server/test/sandbox-env-vars.test.ts` |
| 凭据（`credential_request`、安全表单、SecretStore、`credential_http` 代理、单次运行的环境注入） | 已实现，有测试。本地 AES-GCM 实测通过；Vault Transit 只对替身测试过，**未接真实 Vault** | `server/test/credentials.test.ts`（20 项，使用假密钥） |
| 把凭据注入远端沙箱的进程环境 | **不支持（501）**：提供方未验证进程环境不会被持久化 | `sandbox.ts` |
| 提供方快照、内存或进程迁移 | **不承诺、未启用** | — |
