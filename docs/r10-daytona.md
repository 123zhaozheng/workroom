# 第 10 轮：Daytona 创建路径修复

## 1. 问题与根因

用户创建 Daytona 工作区时报错：“沙箱提供方 daytona 不支持创建时指定 CPU/内存……已拒绝，不会回退到宿主机执行”。

根因在 `server/src/tools/sandbox/remote-driver.ts`。远端驱动把平台的通用内存上限（`spec.limits.memoryBytes`，每次运行都有）当作 `CreateOptions.resources` 传给提供方。Daytona 适配器用的是快照/默认方式，看到 `resources` 就按“用户显式指定了资源”拒绝创建。实际上用户从没设置过 CPU 或内存。E2B 存在同样的误判。

## 2. 修复（对照 `@daytonaio/sdk` 0.231.1）

SDK 的两种创建参数：

- `CreateSandboxFromSnapshotParams`：没有 `resources`，规格由快照或 Daytona 默认值决定。
- `CreateSandboxFromImageParams`：`image` 加上可选的 `resources { cpu, memory (GiB), disk (GiB) }`。SDK 把它们映射为 `POST /sandbox` 的 `buildInfo.dockerfileContent`、`cpu`、`memory`、`disk`。

改动：

| 层 | 改动 |
|---|---|
| 合同 `provider.ts` | `CreateOptions.resources` 只表示**管理员显式设置**（`ExplicitResources { cpus, memoryGb, diskGb }`）。通用上限改为提示字段 `defaultMemoryMb`，提供方可以忽略，绝不能据此拒绝。 |
| 驱动 `remote-driver.ts` | 只传显式设置 `image`/`resources`，通用上限放在 `defaultMemoryMb`。 |
| Daytona 适配器 | 默认/快照方式不发送任何规格。镜像方式发送 `image` 和显式规格。显式规格但没有镜像时，在**发请求之前**以 501 拒绝并写明原因，不会静默忽略。 |
| E2B 适配器 | 只拒绝显式规格（规格由模板决定），忽略提示字段。 |
| OpenSandbox 适配器 | CPU/内存取显式设置，没有设置时用提示字段；磁盘不支持，显式设置时拒绝。 |
| 配置 `provider-config.ts` | 迁移 v2 新增 `image`、`resources` 两列，带范围校验。按提供方的规则：Daytona 的镜像与快照二选一，规格必须配合镜像；E2B 不接受规格和镜像；OpenSandbox 不接受镜像和磁盘。违反时返回 400 并给出中文原因。 |
| 管理界面 | Daytona 卡片新增“创建方式”：“快照 / 默认规格”或“镜像（可指定 CPU、内存、磁盘）”。选镜像时才出现规格输入。E2B 卡片说明规格由模板决定。 |
| 加固 | 没有配置端点时，显式传入官方地址 `https://app.daytona.io/api`，防止 SDK 从宿主机的 `DAYTONA_API_URL` 环境变量取端点，把密钥发到别处。新增 `close()`：配置变更或服务关闭时释放 SDK 客户端的事件 WebSocket，避免一直重连。 |

命令、文件、生命周期和联网方面：

- 不发送任何网络参数，出站网络由 Daytona 组织或沙箱的默认设置决定（第 9 轮约定）。
- `ttlMinutes` 和 `autoStopInterval` 来自 Workroom 的生命周期设置。
- 错误带原始状态码，密钥会被脱敏。
- 任何失败都不会回退到宿主机执行。

## 3. 测试证据

| 证据 | 内容 | 结论 |
|---|---|---|
| `server/test/sandbox-daytona-wire.test.ts`（8 项） | **真实 SDK 0.231.1** 连接本机伪造的 Daytona REST 服务，断言线上请求：默认方式没有 `cpu`/`memory`/`disk`/`snapshot`/`buildInfo`/网络字段；快照方式只有 `snapshot`；镜像方式带 `buildInfo` 和规格；显式规格没有镜像时一个请求都不发；厂商错误带状态码且已脱敏；`connect`/`destroy` 依次发出 `GET`/`DELETE /api/sandbox/:id`；`close()` 释放客户端 | 控制面通过 |
| `server/test/sandbox-providers-unit.test.ts` 等 | 用 SDK 替身覆盖命令（会话、日志流、超时与取消）、文件和列目录 | 通过（替身） |
| `web/e2e/round10-daytona.mjs`（8 项） | 管理界面：默认快照方式、切换到镜像并保存规格、切回快照后清空、非法组合显示服务端原因、页面不回显密钥、390px 宽度下无横向滚动 | 通过 |
| 用户自测（直接调用官方 REST，不经过 Workroom） | 用默认快照创建沙箱：200，`started`。查询：200。经 toolbox 执行命令：200，`exitCode 0`。写入并读取临时文件：成功。在沙箱内访问 `https://example.com`：200。删除：200 | 说明凭据有效，Daytona 的创建、命令、文件、外网和删除链路可用。**这不是 Workroom 适配器的端到端结果** |

## 4. 仍需凭据：Workroom 适配器的真实端到端

当前开发环境没有安全保存的 Daytona 密钥，因此 Workroom 适配器对真实 Daytona 的端到端测试（创建、命令、文件、联网、清理）**还没有运行**。有密钥的环境可以直接运行：

```bash
WORKROOM_TEST_DAYTONA_API_KEY=… node --disable-warning=ExperimentalWarning --test server/test/sandbox-providers-unit.test.ts server/test/sandbox-contract.test.ts
```

只有这项测试在真实服务上通过之后，才能把 Daytona 的各项能力从 `unverified` 改为 `supported`。
