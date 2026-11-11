# 第 11 轮：远端沙箱生命周期（R1 状态机 + R3 空闲暂停 / 保留 / 销毁）+ 生命周期事件（R6 底座）

范围：只针对**远端**沙箱提供方（OpenSandbox / E2B / Daytona）。本机驱动（namespaces / docker）每次运行即用即毁，没有长期存在的沙箱，不受影响。

核心前提没有变：**宿主机上的会话工作区是唯一权威**，用 sha256 清单同步到沙箱；所以沙箱在任何阶段丢失，文件都不会丢，只有“装过的依赖”和后台进程取决于沙箱本身是否还在。

## 1. 状态机

实例表 `tool_sandbox_instances.state`（原有状态保留）：

| 状态 | 含义 | 进入 | 离开 |
|---|---|---|---|
| `creating` | 正在创建 | 会话内第一次需要（exec / 预热 / 显式准备） | → `ready` / `error` |
| `ready` | 可用 | 创建成功、恢复成功 | 空闲 ≥ idlePauseSec 且不忙 → `pausing`；未使用 ≥ destroyAfterSec → `stopping` |
| `pausing` | 暂停中（持锁，几秒） | reaper | → `paused`；暂停失败 → 回 `ready`（`last_error` 可见，下一轮重试） |
| `paused` | 已暂停。`resume_mode`=`provider`（厂商保留，快速恢复）或 `recreate`（提供方不能暂停：沙箱已销毁，行里 `remote_id` 为空） | 暂停成功 | 有运行到达 → `resuming`（provider）或直接重建（recreate）；暂停满 pausedRetentionSec 且提供方能归档 → `archived`；未使用 ≥ destroyAfterSec → 销毁 |
| `resuming` | 恢复中 | acquire 发现 paused / archived | → `ready`；失败 → 重建（见 4） |
| `archived` | 已归档到冷存储（仅 Daytona 有 archive） | retention 到期 | 运行到达 → `resuming`；未使用 ≥ destroyAfterSec → 销毁 |
| `stopping` → `destroyed` | 销毁 | destroyAfter / 管理员 / 卡死 | 终态 |
| `lost` / `error` | 沙箱丢失 / 创建或销毁失败 | — | 终态（保留 7 天，按**进入终态的时间**计） |

会话对象 `ConversationEnvironmentDTO.state` 新增 `paused` 与 `resuming`（`preparing` 仍然只表示首次创建/重建的“准备中”），并新增 `resumeMode`（仅 paused/resuming）：

| resumeMode | 含义 |
|---|---|
| `fast` | 厂商保留了暂停的沙箱：文件、已装依赖都在，秒级恢复 |
| `archived` | 厂商已归档：文件和依赖都在，恢复较慢 |
| `recreate` | 提供方不能暂停：沙箱已销毁，下次从宿主机工作区重新创建（文件在，**已装依赖需重装**） |

DTO 映射：`pausing` 对用户仍显示 `ready`；`resuming` 行在本进程有标记时显示 `resuming`，跨进程/重启遗留超过窗口后显示 `paused`。`get()` 仍然只读配置 + 实例表 + 进程内标记，**从不连接、探测或创建沙箱**（测试里用 Proxy 记录 provider 调用，GET 三次调用数为 0）。

## 2. 参数（每个提供方）

| 参数 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `idlePauseSec` | 300（5 分钟） | 60–86400 | 空闲这么久且不忙 → 暂停 |
| `pausedRetentionSec` | 86400（24 小时） | 300–2592000 | 快速恢复窗口：暂停后这么久 → 归档（能归档的提供方），否则保持暂停 |
| `destroyAfterSec` | 604800（7 天） | 3600–7776000 | 连续这么久没使用 → 销毁 |
| `createTimeoutSec` | 120 | 10–600 | 不变 |

校验（中文 400）：每个值必须是范围内的整数（例如“空闲暂停时间（idlePauseSec）必须是 60–86400 之间的整数（秒）”）；`destroyAfterSec` 不能早于 `idlePauseSec + pausedRetentionSec`（“未使用销毁时间不能早于‘空闲暂停时间 + 快速恢复保留时间’”）。管理后台提供方卡片里四个短输入：创建超时（秒）、空闲暂停（分钟）、快速恢复（小时）、未使用销毁（天），没有说明文字。

### 旧参数 `idleTimeoutSec` / `lifetimeSec` 的处理

- 表 `tool_sandbox_providers` 新增三列（迁移 v4），**所有已有行取新默认值（5 分钟 / 24 小时 / 7 天）**：暂停不具破坏性，因此从不比旧的“空闲 N 分钟即销毁”更贵。旧两列保留（NOT NULL，不再有含义、不再对外），所以旧版本仍能打开这个数据库。
- DTO 不再返回 `idleTimeoutSec` / `lifetimeSec`；PUT 带这两个字段会得到 400（“已废弃：请改用 idlePauseSec…”），不会被静默忽略。
- “最长存活 4 小时”不复存在：它与“暂停后 24 小时可恢复、7 天才销毁”冲突。迁移把实例表重建（SQLite 无法修改 CHECK），已有行原样拷贝，**live 行的 `expires_at` 清空**；新行不再写 `expires_at`（旧行若有未过期的 `expires_at` 仍按旧规则重建一次）。
- 厂商侧安全超时：`CreateOptions.lifetimeMs` 现在是“Workroom 失联时厂商多久后处理”，取 `idlePauseSec + 120 s + 本次命令超时`，每次使用都 `keepAlive` 续期；它不再是最长寿命。

## 3. 提供方契约与映射

`RemoteProvider` 新增可选方法 `pause(id, { retainMs })`、`resume(id)`（→ `RemoteSession | null`）、`archive(id)`；`CreateOptions.lifecycle`（idlePause / retention / destroyAfter）供厂商侧自动化使用。

| 提供方 | 暂停 | 恢复 | 归档 | 创建时的厂商侧设置 | pauseResume 能力 | 验证情况 |
|---|---|---|---|---|---|---|
| OpenSandbox | `POST /v1/sandboxes/{id}/pause`（先 `renew` 到保留窗口，再等 `Paused`） | `…/resume`，等 `Running` | 无 | `timeoutSeconds` = 安全超时 | `supported` | **已联调（本机 opensandbox-server 1.2.0，Docker 运行时）**，见下 |
| E2B（SDK 2.63.0） | `Sandbox.pause(id)`（默认 full：文件+内存） | `Sandbox.connect(id)`（对暂停的沙箱即恢复） | 无 | `timeoutMs` = 安全超时；`lifecycle: { onTimeout: "pause", autoResume: false }`（Workroom 失联时厂商自己暂停；不开 autoResume） | `unverified` | **未联调**（无密钥）：只对照 SDK 类型和测试替身验证 |
| Daytona（SDK 0.231.1） | `sandbox.stop()` | `sandbox.start()`（含从 archived） | `sandbox.archive()` | `autoStopInterval=ceil(idlePause/60)`、`autoArchiveInterval=ceil(retention/60)`、`autoDeleteInterval=ceil((destroyAfter−idlePause)/60)`，均为分钟；不再传 `ttlMinutes`（它会连已停止/归档的沙箱一起按创建时间销毁） | `unverified` | **未联调**（无密钥）：真实 SDK → 本机假 REST 服务，断言了创建字段和 `POST stop/start/archive` 请求；`autoDelete/autoArchive` “从停止时起算”的语义来自 SDK 文档，未对真实服务验证 |

OpenSandbox 联调事实（2026-11-11，本机服务）：
- `pause` 后状态 `Paused / CONTAINER_PAUSED`，写入的文件在 `resume` 后读回，恢复后 exec 约 1 秒内可用（`docker pause` 冻结进程，文件系统和内存都在）。
- **暂停的沙箱仍会按 TTL 过期**：60 秒 TTL 的沙箱暂停 75 秒后查询返回 404。因此 `pause()` 先把 TTL 续到“保留窗口 + 120 秒”。`renew` 到 1 年都被接受（无上限）。
- E2B / Daytona 厂商侧语义（暂停的沙箱是否计时过期）未验证。

## 4. 回收器（reaper）与获取（acquire）

reaper 每 60 秒一轮（`RemoteDrivers.start`），驱动内带“同一时刻只跑一轮”的保护；时钟可注入（`RemoteDriver({ now })`，`reapIdle(now?)`）。每个实例在**与运行相同的按工作区锁**内处理，并在锁内**重新读行并重新判断**：

1. `ready` 且 未使用 ≥ destroyAfter → 销毁（trigger `expiry`）；
2. `ready` 且 空闲 ≥ idlePause 且不忙 → 暂停：有 `pause` 的提供方 → provider 暂停；否则 **recreate 模式**：持锁（此时没有运行在进行）销毁沙箱，行改为 `paused / resume_mode=recreate / remote_id=NULL`（文件早已在宿主机工作区）；
3. `paused`（provider）暂停满 retention 且提供方有 `archive` → 归档（trigger `retention`），否则保持暂停；
4. `paused` / `archived` 未使用 ≥ destroyAfter → 销毁；
5. 卡死的 `pausing`（崩溃遗留）→ 回 `ready`，`resuming` → 回 `paused`，`creating`/`stopping` → 销毁。

忙碌的实例（有运行持锁，`#busy`）永远不会被暂停/回收；暂停进行中到达的运行在锁上等待，暂停结束后走恢复路径。

`#acquire`：
- `paused` / `archived` / `resuming` 且有 `remote_id` → 恢复：状态 `resuming`，`provider.resume`，用一条无害命令验证，`keepAlive`，记录 `resume` 事件（含耗时）；然后走**正常的清单同步**（宿主机可能在暂停期间改过文件，只上传有变化的文件）。
- 恢复失败（报错 / 沙箱已不存在 / 验证失败）→ 记 `resume_failed`，销毁残留，**重建 + 完整重传**，运行输出里带一句说明；**绝不回退到宿主机执行**。
- recreate 模式的 paused 行 → 重新创建（`create` 事件 detail=`after_pause_recreate`），说明里提示“已安装的依赖需要重新安装”。

## 5. 生命周期事件（R6 底座）

表 `tool_sandbox_events`（迁移 `sandbox` v12，文件 `server/src/tools/sandbox/lifecycle-events.ts`，导出 `recordSandboxEvent(db, …)`、`sandboxEventsOf`）。列：`org_id, space_id, workspace_key, conversation_id, provider, kind, trigger, duration_ms, running_ms, at, detail`。写入失败只打日志，不影响生命周期动作。

| kind | 时机 | duration_ms | running_ms |
|---|---|---|---|
| `create` / `create_failed` | 创建完成 / 失败 | 冷启动耗时（失败则为失败前耗时） | — |
| `resume` / `resume_failed` | 恢复完成 / 失败 | 恢复耗时 | — |
| `pause` | 暂停（含 recreate 模式的回收，detail=`recreate`） | — | 自上次创建/恢复起运行了多久（成本） |
| `archive` | 归档 | — | — |
| `destroy` | 销毁 | — | 暂停/归档状态销毁为 0，否则自上次创建/恢复起的运行时长 |

`trigger`：`exec`（沙箱工具调用）、`prewarm`（意图预热，由 `ConversationEnvironments.prepare(..., { trigger: "prewarm" })` 传入）、`explicit`（用户点“准备”；`POST …/environment/prepare` 可带 `{ "trigger": "explicit" }`，其它值 400，客户端不能冒充 prewarm）、`idle`（空闲暂停）、`retention`（归档）、`expiry`（destroyAfter / 卡死 / 旧版最长寿命 / 网络策略重建）、`admin`（管理员销毁）。事件不存命令、文件名或消息文本，`detail` 经凭据清洗且 ≤ 200 字符。

`DriverRunSpec.trigger`、`Sandbox.prepare({ trigger })`、`ConversationEnvironments.prepare(p, space, conversationId, signal?, opts?)` 已贯通。

## 6. 测试证据

| 文件 | 内容 | 结果 |
|---|---|---|
| `server/test/sandbox-lifecycle.test.ts`（新） | 14 个 FAKE 测试：每个状态迁移、注入时钟的边界（4:59 不暂停 / 5:00 暂停；retention 差 1 秒不归档；destroyAfter 差 1 秒不销毁）、忙碌保护、暂停进行中到达的运行、锁内重判、provider 无 archive 时保持暂停、恢复失败（报错 / 沙箱被删）→ 重建 + 完整重传、recreate 模式、暂停失败与卡死行自愈、管理员销毁与创建失败事件、迁移（旧行保留、唯一索引覆盖 paused）、DTO（paused fast / recreate、resuming、GET 不触碰 provider、prewarm/explicit 触发被记录、非法 trigger 400） | 14 通过 |
| 同文件 LIVE | 真实 OpenSandbox：空闲 6 分钟（注入时钟）→ `Paused`（厂商接口确认）→ 恢复后 `/tmp` 里的状态仍在（证明是**同一个**沙箱）→ 事件含冷启动/恢复耗时 → destroyAfter → 真的销毁 | 通过（一次实测：冷启动 614 ms，恢复 1045 ms；这是本机 Docker 的数字，不是厂商指标） |
| `server/test/sandbox-daytona-wire.test.ts` | 真实 Daytona SDK → 本机假 REST：生命周期创建字段（分钟换算、向上取整、无 ttlMinutes）、`POST stop/start/archive`、已停止/已启动时不重复调用、已删除沙箱 resume → null、厂商错误可见且清洗 | 11 通过 |
| `server/test/sandbox-providers-unit.test.ts`、`sandbox-provider-config.test.ts`、`sandbox-remote-driver.test.ts`、`round8-environment.test.ts`、`sandbox-workdir.test.ts`、`sandbox-contract.test.ts` | 更新旧的“空闲销毁”假设；E2B 暂停 / 恢复 / lifecycle；配置校验与中文错误；contract 里“空闲回收”改为 暂停 → 销毁 | 随 10 个沙箱相关文件一起跑：237 项，142 通过、0 失败、95 跳过（跳过的是需要真实服务/Docker 的 LIVE 与 contract 项，未设环境变量时） |
| LIVE 复跑（`WORKROOM_TEST_OPENSANDBOX_*` 指向本机服务） | `sandbox-lifecycle`（含 LIVE）+ `round8-environment`（含 LIVE）；`sandbox-contract` 只跑了“idle reaping and orphan reaping”一项（OpenSandbox 通过：暂停 → destroyAfter 销毁） | 26 项全部通过；contract 全套（含本机 docker 目标）耗时过长，本轮**没有**跑完整套 |

## 7. 没有做 / 未验证

- E2B、Daytona 的真实服务行为（暂停后是否过期、autoDelete 起算点、恢复耗时）**未联调**，能力标 `unverified`。
- E2B 的沙箱超时有厂商上限（SDK 注释：Pro 24 小时、Hobby 1 小时），而厂商侧安全超时 = `idlePauseSec + 120 s + 命令超时`：把 `idlePauseSec` 设得超过该上限时，E2B 会在创建时拒绝（错误可见，未做提前校验）。
- 暂停失败的实例每 60 秒重试一次，没有退避（失败原因在管理后台实例列表的 `lastError` 里）。
- 厂商自己暂停/停止的沙箱（Workroom 失联或 Daytona 自动停止）：下一次 acquire 的 `connect` 会隐式恢复（E2B connect / Daytona connect 带 start / OpenSandbox connect 唤醒），这种恢复**不会产生 `resume` 事件**。
- 环境按钮（`EnvironmentButton.tsx`）需要由主代理处理新状态 `paused` / `resuming`（以及 `resumeMode`）；本轮没有改它。
