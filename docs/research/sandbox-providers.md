# 远程沙箱提供方调研：E2B / Daytona（第 7 轮）

调研日期：2026-11-11。本环境没有任何提供方的 API Key，所以**所有"已实现"的能力都标为 unverified（未经真实服务验证）**；
"verified by" 一列只写本轮真实做过的检查（读 SDK 类型定义 / 读源码 / 抓取官方页面 / 单元测试替身），不写没做过的事。

## 1. E2B

| 项 | 结论 | 来源 |
|---|---|---|
| JS SDK | `e2b@2.63.0`（npm 最近更新 2026-11-04），**MIT** | `npm view`，已安装并读了 `dist/index.d.ts` |
| 仓库 | github.com/e2b-dev/E2B，Apache-2.0，未归档，描述为 "Open-source, secure environment … for enterprise-grade agents" | 抓取仓库页 |
| 运行时 | github.com/e2b-dev/runtime（页面描述为 E2B 云/企业版/自建机器背后的 Go 后端：控制面 API、节点编排器、envd、边缘路由、模板构建），Apache-2.0，未归档 | 抓取仓库页 |
| 自托管 | 官方称可自建：单机 "Embed"（需 KVM 的 Linux，Docker Compose）、GCP/AWS/Azure Terraform、K8s 清单；企业版由 E2B 在客户云账号内运行。**本轮未部署，未验证**。 | 抓取仓库页 |
| 隔离 | Firecracker microVM（官方云；自建同一运行时） | runtime 仓库描述 |
| 数据位置 | 官方云：厂商云（代码与文件离开组织）；自建/兼容服务：取决于部署，故 `location: configurable` | — |
| 指向非默认地址 | `ConnectionOpts.domain`（默认 `E2B_DOMAIN` 或 `e2b.app`）；`apiUrl`（`E2B_API_URL`，类型注释标记 `@internal` + `@deprecated`，下个大版本将移除）；`sandboxUrl` 同样已弃用。构造函数里 `apiUrl = opts.apiUrl \|\| env \|\| https://api.${domain}`。适配器显式传 `apiUrl`/`domain`，不读宿主环境变量。 | 读 `ConnectionConfig` 源码 |
| 风险 | `apiUrl` 被标记弃用：升级 SDK 前必须重跑契约测试，版本已精确锁定 | 类型注释 |

### E2B 能力 → ProviderCapabilities

| 字段 | 适配器取值 | SDK 中的对应物 | verified by |
|---|---|---|---|
| exec | unverified | `commands.run(cmd,{cwd,envs,timeoutMs,background,onStdout,onStderr})`，非零退出抛 `CommandExitError` | 类型定义 + 替身单测 |
| streamOutput | unverified | `onStdout/onStderr` | 同上 |
| cancel | unverified | `CommandHandle.kill()`（SIGKILL） | 同上；真实 kill 未验证 |
| commandTimeout | unverified | `timeoutMs`（远端）+ 客户端截止时间（+3s）后 kill | 同上 |
| files | unverified | `files.read/write/list/remove/makeDir`；`EntryInfo.type` 含 `symlink` 与 `symlinkTarget`；`list(path,{depth})` | 类型定义 |
| networkOff | unverified | `SandboxOpts.allowInternetAccess=false`（注释：等价于 `network.denyOut=[0.0.0.0/0]`） | 类型定义 + 替身单测；真实阻断未验证 |
| networkOn | unverified | 默认 | — |
| resourceLimits | unsupported | CPU/内存属于**模板**，create 调用没有该参数；指定则抛 UnsupportedError | 类型定义 |
| reconnect | unverified | `Sandbox.connect(id)`（暂停的会被恢复，已删除抛 `SandboxNotFoundError`→返回 null） | 类型定义 |
| list（孤儿清理） | unverified | `Sandbox.list({query:{metadata}})` 分页器 | 类型定义 |
| keepAlive | unverified | `sandbox.setTimeout(ms)` | 类型定义 |
| services / pty / preview / snapshot / pauseResume | unsupported | SDK 有 `pty`、`createSnapshot`、`pause`、`getHost` 等，但本轮不暴露未验证的高级功能 | 设计决定 |

沙箱最长存活：Pro 24 小时，Hobby 1 小时（SDK 注释）——`lifetimeSec` 超过会被厂商截断或拒绝。

## 2. E2B 兼容服务（以阿里云 Agent Sandbox 为例）

来源：alibabacloud.com/help/en/agent-sandbox/e2b-compatibility-explanation（已抓取）。

**兼容 ≠ 完全一致。适配器不声明"通用 E2B 兼容"**：兼容服务只能由管理员显式填写 `endpoint`（API URL）+ `domain`，能力保持 unverified，
直到在该服务上真实跑过契约测试（见第 6 节）。该页面列出的差异：

- 迁移主要是替换 API Key、API URL 和 domain；自定义域名/证书是扩展而不是 E2B 原生接口。
- **不支持 Volume API**；**不支持 Metrics API**；团队管理与 API Key/访问令牌不能通过 SDK 管理（只能控制台）。
- 日志、VPC、OSS、监控告警走"扩展"，不是 E2B 原生接口。
- 快照仅 MicroVM、需白名单；命名、删除、恢复约束与官方不同；默认保留 7 天。
- 文件元数据仅 MicroVM 且要求 envd ≥ 0.6.2，更早版本在写请求发出前报错。
- 图表不原生渲染（需生成图片文件再取回）。
- CLI 只覆盖常用命令。
- **SDK 版本**：页面写明 `e2b` 2.51.0 不支持 create/connect，建议 Node `e2b@^2.31.0`——这与我们锁定的 2.63.0 之间的关系**未验证**，是上线前必须在目标服务上实测的点。
- 页面未提及 `allowInternetAccess`、`list` 的 metadata 过滤、`files.list` 的符号链接字段是否支持——**不得假定支持**。`networkOff` 在兼容服务上尤其要实测，否则策略为"无网络"时会出现联网沙箱（适配器只信任 SDK 参数，不会替服务验证）。

## 3. Daytona

| 项 | 结论 | 来源 |
|---|---|---|
| JS SDK | `@daytonaio/sdk@0.231.1`（npm 最近更新 2026-11-09），**Apache-2.0** | `npm view`，已安装并读类型定义 |
| 开源仓库状态 | github.com/daytonaio/daytona **已于 2026-10-03 被所有者归档（只读）**；README 公告："As of June 2026, Daytona's core development has moved to a private codebase."，"This repository will receive no further updates, fixes, or releases." 仓库保持公开，可在其 LICENSE（链接到 v0.190.0 标签）下使用/fork，"as is and without support or warranty"。仓库页未给出许可证类型名称，**未核实**（不要据此推断可商用自托管）。 | 抓取仓库页（与用户反馈一致） |
| 自托管 | **不能当作"受维护的可自托管开源产品"**。归档仓库是 v0.190.0 时代的快照，无更新、无修复、无支持，且与现行 SDK（0.231.x）已经分叉。本项目把 Daytona 视为**厂商云服务**；`endpoint` 仅用于 Daytona 自己提供的企业/区域端点，不代表可自建。 | 同上 |
| 隔离 | 厂商托管；具体隔离技术未在本轮核实，界面文案写"由厂商决定，未验证" | — |
| 数据位置 | `vendor_cloud`（代码与工作区文件离开组织，启用前必须管理员确认） | 设计决定 |

### Daytona 能力 → ProviderCapabilities

| 字段 | 适配器取值 | SDK 中的对应物 | verified by |
|---|---|---|---|
| exec | unverified | 会话方式：`createSession` → `executeSessionCommand({command,runAsync:true})` → `getSessionCommandLogs(stdout,stderr)` → `getSessionCommand().exitCode` → `deleteSession`。cwd/env 编码在命令行里（`env K=V /bin/sh -c 'cd CWD && CMD'`，全部 shell 转义）。 | 官方文档页 + 类型定义 + 替身单测 |
| streamOutput | unverified | `getSessionCommandLogs` 回调 | 文档页 |
| cancel / commandTimeout | unverified | 客户端截止时间/AbortSignal → `deleteSession` 作为远端终止。`executeCommand` 的 timeout 默认 10 秒、且无流式输出，所以不采用。**删除会话是否杀掉子进程树未验证** | 文档页；真实行为未验证 |
| files | unverified | `fs.uploadFile/downloadFile/deleteFile/createFolder`。`FileInfo` **没有符号链接字段**（只有 `isDir`/`mode`），因此 list 通过 `find -printf`（lstat 语义，`%y=l`）实现，镜像里没有 GNU find 则报错而不是猜测 | 类型定义 |
| networkOff | unverified | `networkBlockAll: true`（另有 `networkAllowList`、`domainAllowList`） | 类型定义 + 替身单测 |
| resourceLimits | unsupported | 仅"从镜像创建"（`CreateSandboxFromImageParams.resources`）支持；本适配器走快照/默认方式 | 类型定义 |
| reconnect | unverified | `daytona.get(id)`；`stopped/archived` 先 `start()`，`destroyed/error` 视为不存在 | 类型定义 |
| list（孤儿清理） | unverified | `daytona.list({labels})` | 类型定义 |
| 生命周期 | unverified | `ttlMinutes`（自创建起的硬上限）+ `autoStopInterval`（空闲） | 类型定义；keepAlive 只刷新空闲窗口，不延长硬 TTL |
| services / pty / preview / snapshot / pauseResume | unsupported | SDK 有 PTY、预览链接、快照、pause，本轮不暴露 | 设计决定 |

## 4. 参考项目（不引入代码）

**Alibaba-Agent-Sandbox/agent-sandbox**（仓库页已抓取）：Apache-2.0（README 链接 LICENSE，并有 NOTICE 做署名；LICENSE 全文本轮未能打开核对）。
是 `abx` 命令行（预览版，可能有破坏性变更，README 称 1.0.0 预计 2026-11-15）：默认后端 `alicloud-express`，其它后端以"provider 插件"形式接入，
命令用 `--provider` 选择，各 provider 自带凭据与配置。可借鉴的只有"后端可插拔 + 每个后端自带能力说明"的思路，
我们的 `RemoteProvider` + `ProviderCapabilities` 已覆盖。**未复制任何代码**，也没有读取其源码。

**Kubernetes Agent Sandbox**（agent-sandbox.sigs.k8s.io，已抓取）：Kubernetes 项目，提供"把执行层与隔离技术分离的标准 K8s API"，
隔离后端可选 gVisor（用户态内核）或 Kata Containers（每沙箱独立内核，QEMU/硬件虚拟化）；有 Python 与 Go SDK（创建/运行/终止，基于 warm pool + 命名空间）。
页面**没有**给出 CRD 名称、成熟度（alpha/beta）和版本号——这些未核实。未来作为一个 provider 的可行形态是：新增 `providers/k8s-agent-sandbox.ts`，
`create`=按 warm pool 申请，`exec/files`=其 SDK 的 run/文件接口，`destroy`=terminate，`location: self_hosted`。**本轮不实现**；
实现前要先确认 CRD 版本、文件接口是否存在、网络策略如何表达（NetworkPolicy）。

## 5. 对比一览

| | OpenSandbox（A1） | E2B | Daytona |
|---|---|---|---|
| SDK/协议 | 自有 | `e2b@2.63.0`（MIT） | `@daytonaio/sdk@0.231.1`（Apache-2.0） |
| 自托管 | 是（见 A1 文档） | 官方称可（runtime 仓库，未验证）；兼容服务另算 | **否（不当作可自托管开源产品）** |
| 数据位置 | 自建 | 官方云=厂商云；其余可配置 | 厂商云 |
| 网络关闭 | — | `allowInternetAccess=false` | `networkBlockAll=true` |
| 资源限制 | — | 模板决定 | 仅镜像创建 |
| 符号链接 | — | SDK 原生字段 | 通过 `find` |

## 6. 管理员如何做真实验证（实时契约运行）

前提：已 `npm ci`（可选依赖会随之安装；若缺失，健康检查会返回"未安装 SDK"并给出安装命令）。

```bash
# E2B 官方云
export WORKROOM_TEST_E2B_API_KEY=...            # 专用测试 Key
# E2B 兼容服务 / 自建：再加
export WORKROOM_TEST_E2B_ENDPOINT=https://<api-url>  WORKROOM_TEST_E2B_DOMAIN=<sandbox-domain>
# Daytona
export WORKROOM_TEST_DAYTONA_API_KEY=...        # 可选：WORKROOM_TEST_DAYTONA_ENDPOINT
node --disable-warning=ExperimentalWarning --test server/test/sandbox-providers-unit.test.ts
```

LIVE 段会：health → create(network=false) → mkdir/写/读 → exec（cwd/env/退出码/stderr）→ 符号链接是否被如实列出 →
超时与 abort 是否真的终止远端进程 → 联网是否真被阻断 → list(metadata) → connect → destroy 幂等。
全部通过后，才可在管理页把对应能力从 unverified 改为 supported（这需要代码改动并附上运行记录，不能只改界面）。
也可以在管理页对该提供方点"测试连接 / roundtrip"。测试创建的沙箱带 `wr-test` 标签，失败残留可按标签清理。
