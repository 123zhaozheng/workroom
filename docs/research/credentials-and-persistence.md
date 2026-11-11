# 凭据与持久化调研（R2）

调研日期：2026-11-11。所有页面均未显示发布/更新日期，下文标注「页面无日期」；版本号取自页面文字。凡标「未核实」者为记忆或推断，不得当作事实。

## 1. OpenSandbox Credential Vault

来源：open-sandbox.ai/guides/credential-vault、/sdks/javascript（页面无日期，引用 release 1.2.1）。

| 项 | 已核实事实 |
|---|---|
| 本质 | 内置于 OpenSandbox **egress sidecar** 的出站凭据代理。宿主 SDK 把真实凭据写入 sidecar；沙箱内只有假值/空值；匹配规则的 HTTPS 请求在出站时由 sidecar 注入认证头 |
| 版本 | opensandbox-server >= 0.2.0；egress >= 1.1.1；JS/TS SDK >= 0.1.9；exchange credentials 需 1.2.1+ |
| 前置 | server 配置 `[egress].image` 与 `[egress].mode="dns+nft"`（DNS-only 被拒）；创建时带出站 networkPolicy 并开启 credentialProxy；建议 `defaultAction="deny"`；同 Pod 不能有透明 service-mesh sidecar |
| 运行模式 | Sidecar profile（Docker 支持，K8s 覆盖）；Fast-sandbox（模板）profile：创建时不能开启，须先建沙箱再调 vault API |
| 运行时/模板 | 任意含所需工具的镜像；JS 页称「不适用于 template-backed 沙箱」，与 guide 的 fsb profile 描述有出入，需实测 |
| 是否落盘 | Sidecar profile：仅进程内存，文档称真实值不得写入元数据/env/快照/日志。Fast-sandbox：每沙箱一个**明文**文件，位于 Pod 级 emptyDir（建议 `medium: Memory`） |
| 暂停/快照 | K8s pause 删除 Pod，vault 丢失，须在 Running 后重建；Docker pause 保留；sidecar 重启即清空；fsb 的 vault 文件随快照包携带（即快照含明文凭据） |
| JS API | `Sandbox.create({ credentialProxy: { enabled: true }, networkPolicy })`；`sandbox.credentialVault.create({ credentials, bindings })`；credential 用 `source: { value }`；binding 含 `match: { schemes, hosts, paths }` 与 `auth`（如 `type: "apiKey"`）。auth 类型：bearer/basic/apiKey/customHeaders/passthrough/exchange。值只写不读，读返回脱敏元数据。REST：`POST /sandboxes/{id}/credential-vault` |
| 限制 | 私有 vault socket 失效时**所有**被拦截流量阻断（fail-closed）；请求体 >~1MiB 或长度未知被丢弃；仅 HTTPS 注入；歧义绑定被拒；exchange 的 https resolver 无结构隔离且调用方认证未实现；live admission 模式实验性、不支持 |
| 其他 | 页面不涉及 CLI/非 HTTP 协议（如 git over ssh）；`match.ports` 已弃用改用 `schemes` |

**结论**：可以，且只能作为 **opensandbox provider 的可选后端**（`credential_proxy_backend = "opensandbox-vault"`），其他 provider 仍用 Workroom 自带服务端代理。理由：它天然满足「秘密不进沙箱」，但绑定 OpenSandbox 版本与 egress 模式。Workroom 须自己保存原始请求/SecretStore 引用，因为 pause/重启后 vault 会丢，需重新写入。

**需实机验证**：(a) 目标部署（docker 还是 K8s）实际支持哪个 profile；(b) server 版本 >= 0.2.0 且 egress dns+nft 可用；(c) JS SDK 0.1.9+ 的字段名是否与上表一致（页面为摘要提取）；(d) pause/resume 后 vault 是否需重建；(e) 重定向到非绑定主机时是否不注入；(f) 非 HTTPS 与 HTTP/2 行为；(g) 快照是否确实不含真实值（sidecar profile）。

## 2. HashiCorp Vault / OpenBao

来源：developer.hashicorp.com 各页（均无发布日期；Transit/KV 页版本选择器显示 v2.x latest）。

| 项 | 事实 |
|---|---|
| 静态 vs 动态 | 静态：存于 KV，手动变更才变；动态：「读取时才存在」，TTL 到期或用后撤销（教程中 DB 引擎每次请求建独立 PG 用户，默认 1h/最大 24h） |
| KV v2 | 版本化存储静态秘密；默认软删除可恢复，可永久销毁。CAS/max versions 本页未述，未核实 |
| Transit | 「加密即服务」：应用送明文、Vault 返回密文，Vault 不存数据，调用方自存密文；密钥版本轮换、`rewrap` 无需暴露明文；支持 AES-GCM 等。页面未明确写「密钥永不离开」，但建议让 Transit 内部生成密钥；datakey 抽取页面标为 Enterprise-only（与记忆不符，未核实，建议不依赖） |
| 许可 | HashiCorp 2023-08-10 博客：未来所有产品由 MPL 2.0 改为 BSL 1.1；限制为不得提供与 HashiCorp 竞争的产品。博客未列版本号（「自 1.15」未核实） |
| OpenBao | 页面称：Vault 的分叉，由 Linux Foundation 的 OpenSSF 管理，OpenSSF Sandbox 项目；MPL 2.0 未在页面确认；版本未显示 |
| 服务器认证 | AppRole：为机器/服务设计；RoleID + SecretID；推荐 pull 模式、batch token、短 TTL、`secret_id_bound_cidrs`、response wrapping；也可用静态 token（未核实其他方式，仅作备选） |
| 部署复杂度 | 需 unseal/HA/备份/审计，对自托管小团队偏重（一般判断，未核实） |

**建议先实现 Transit**：SecretStore 适配器 `vault-transit` = 密文仍存 Workroom 数据库，Vault 只负责 encrypt/decrypt（主密钥不离开 Vault，不改变现有数据模型，故障时只影响解密）。KV 方案则把秘密本体搬进 Vault，需处理路径、版本、一致性与删除语义，成本更高；放第二阶段。Transit 不要求 datakey，直接对小秘密 encrypt（<几 KB）即可。同时兼容 OpenBao（API 同源，未核实兼容度，需实测）。动态秘密本轮不做（需各目标系统引擎）。

## 3. 各沙箱 provider 的环境变量、持久化与 TTL

| | E2B（docs.e2b.dev，无日期） | Daytona（daytona.io/docs，无日期，文档版本 v0.231 latest） | OpenSandbox |
|---|---|---|---|
| env | 创建时 `envs`；`runCode`/`commands.run` 可逐次 `envs`，同名仅本次覆盖；页面明确「在 OS 中不是私密的」；无秘密指引 | 创建时传 env（SDK map/CLI `-e`/API `env`）；页面称「API key、token、密码请用 secrets」（secrets 页未取到，细节未核实） | create 选项 `env`；另有 Credential Vault |
| TTL | Hobby 连续运行 1h / Pro 24h；`setTimeout` 从调用时重置；到期 `onTimeout` 为 kill（默认）或 pause；`connect()` 只延长 | auto-stop/auto-archive/auto-delete 章节存在；默认值未取到（**未核实**）；auto-delete 间隔 0 = 停止即删；临时（ephemeral）沙箱停止即删 | `timeoutSeconds` 默认 10 分钟，可为 null（永不过期）；`renew(seconds)`；`lifecycle.renewalPolicy.extendSeconds`；`idlePolicy.idleTimeoutSeconds` 30–86400 |
| pause/快照 | 默认 pause 保存文件系统**和内存**（进程、变量存活）；`mode:'filesystem'` 仅磁盘，恢复为重启。暂停沙箱无 TTL 不会自动删；快照默认含内存+文件系统，可 filesystem-only；快照时短暂暂停并断连。**快照是否含 env/秘密：页面未说，未核实** | 快照：容器仅文件系统（冷）；Linux VM 可含内存（热，`includeMemory:true`）。env 是否保存页面未说；秘密写盘/在内存即会被带入快照（推断）；未使用快照 2 周变 inactive。VM 才支持 pause/resume/fork | `pause()`/`resume()`（返回新句柄，异步轮询 Paused）；`manager.createSnapshot/getSnapshot/listSnapshots/deleteSnapshot`，用 `Sandbox.create({snapshotId})` 恢复；Fast Sandbox 称暂停保留内存与磁盘状态；快照具体语义页面未述，未核实 |
| 卷 | 未取 | Volume：FUSE 挂载、对象存储、独立于沙箱生命周期、最后写入者胜、不适合块存储/数据库、较慢、每组织 100 个 | `volumes` 选项存在，语义未核实 |

通用结论：任何 provider 快照都可能带走沙箱内的明文秘密（env、写盘文件、内存），因此「秘密不落沙箱」优先，env 注入属显式同意的例外。

## 4. 分层承诺

| 层 | 载体 | Workroom 应承诺 | 不应承诺 |
|---|---|---|---|
| 对话检查点 | pi-durable | 对话/步骤状态可恢复，重启后可继续 | **不恢复沙箱文件与进程**；不保证长命令中途续跑 |
| 工作区文件 | 宿主版本化 blob store | 每次关键点产生版本，沙箱 TTL 过期后可从最新版本重建；宿主为权威副本；可回滚到指定版本 | 不保证未落版本的沙箱内改动；不保证二进制/超大文件无限保留；不保证目录外状态（已装包、进程、数据库） |
| 沙箱内存/进程快照 | provider 专有（E2B pause/snapshot、Daytona 热快照、OpenSandbox snapshot） | 仅在对该 provider 实测核验后，作为**显式开启**的优化 | **不承诺跨 provider 快照迁移**；不承诺快照不含秘密（需先清理）；默认关闭 |
| 秘密 | SecretStore | 加密静存、主密钥与 DB 分离、值不进日志/对话/版本 | 不承诺已注入 env 的进程无法读到秘密 |

## 5. 风险清单

### 5.1 凭据代理（服务端，限定目标主机/方法）

| 风险 | Workroom 缓解 |
|---|---|
| DNS rebinding | 解析一次，连接固定 IP；每次连接前校验 IP 不在内网/回环/链路本地/元数据段（含 IPv6 映射） |
| 重定向到其他主机 | 默认不跟随；若跟随，每跳重新校验主机/方法/协议，且不带凭据到未授权主机 |
| 代理环境变量绕过 | 代理在宿主侧执行，不依赖沙箱遵守 `HTTP_PROXY`；沙箱网络出口另行限制 |
| 响应回显秘密 | 对响应头/体做秘密值及常见编码（base64、URL 编码）替换为脱敏标记；限制响应大小；仍无法覆盖变形，须如实说明 |
| 方法/路径范围 | 凭据绑定 {host, 方法, 路径前缀}；路径规范化（拒 `..`、`\`、编码绕过）；歧义即拒 |
| 大小/超时 | 限制请求体/响应体、总时长、并发；超限直接拒绝 |
| SSRF 至内网 | 默认拒绝私网；仅 https；端口白名单；主机用精确匹配，不用子串 |
| 头注入 | 拒绝含 CR/LF 的头名/值；Agent 不得设置 Authorization 等受保护头 |
| 日志 | 日志只记凭据 ID、主机、方法、状态码；不记头、体、URL 查询串里的秘密 |

### 5.2 env 注入（仅限显式同意、受限进程）

| 风险 | 诚实的限度 |
|---|---|
| 子进程继承 env | 只对指定命令注入，不写入沙箱全局 env；无法阻止该命令的子进程读取 |
| `/proc/<pid>/environ`、core dump | 同用户进程可读；禁用 core dump（`ulimit -c 0`）可降低但不能杜绝 |
| 网络外泄 | 受限进程若有出站权限即可外传；应配合出口白名单，但无法完全阻止 |
| 快照/版本 | 禁止把含秘密的 env 文件纳入工作区版本；快照前清理 |
| E2B | 页面明确 per-command env 在 OS 中非私密 |

结论：env 注入只能称「受同意的有限暴露」，不能称安全隔离；每次使用须有用户同意记录、尽量短生命周期、结束后轮换提示。

## 6. 未核实 / 未取到

- Daytona auto-stop/archive/delete 默认值与归档语义（页面截断）。
- E2B、Daytona 快照是否包含 env/秘密。
- OpenSandbox 快照/pause 精确语义、专门的 lifecycle 页面不存在（404）。
- Vault 许可「自 1.15」；OpenBao 的 MPL 2.0；Transit datakey 许可级别；KV 的 CAS/max versions。
- 所有 OpenSandbox JS API 字段名为页面摘要，需对照 SDK 类型定义实测。
