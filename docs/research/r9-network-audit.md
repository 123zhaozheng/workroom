# R9 沙箱网络控制审计（只读调查，未改代码、未联网实测）

## 结论
真正的阻断点是 Workroom 自己的策略层，不是第三方：默认 `network:"none"`（registry.ts:62）+ 三家适配器的 `networkOff` 均为 `unverified` ⇒ 远端运行在 `Sandbox.#networkAllowed`（sandbox.ts:357-361）与 `RemoteDriver.#preflight`（remote-driver.ts:681-686）**双重拒绝**，环境面板同步显示 failed（environment.ts:179-181）。管理员打开 `allowed` 才能用，且被"按可联网处理"（sandbox.ts:452）。本地 Docker 则是 `--network none`（docker.ts:272），而 `sandbox_exec`、技能、作业都不传 `network`（sandbox-tools.ts:49、skills.ts:538、jobs.ts:218），所以即使开关为 allowed，本地 Docker 里的模型代码也**永远断网**。管理页面没有网络开关控件，只有 API `PUT /sandbox/driver`、环境变量和只读告警。

## 1. 决策/执行点清单
| 位置 | 作用 | 处置 |
|---|---|---|
| registry.ts:17,62,105-107；sandbox-routes.ts:87；shared/sandbox.ts:50,63,73,259 | 设置项、env `WORKROOM_SANDBOX_NETWORK`、DTO | 删 |
| sandbox.ts:353-379 `#networkAllowed/#mayUseNetwork`，调用处 389/406/493 | 拒绝、`sandbox.network` 校验 | 删，不再传 network |
| sandbox.ts:252-293 capabilities/info | `network.allowed`、`limits.network` | 只保留驱动技术能力 `supported` |
| remote-driver.ts:296-300 | 网络变化则销毁重建 | 删 |
| remote-driver.ts:235,57；provider.ts:29-31；shared/sandbox.ts:149-150 | `networkOff/networkOn` 能力位 | 合并为信息性字段"出站网络由提供方配置"，删 networkOff 拒绝语义 |
| opensandbox.ts:286,294；e2b.ts:203；daytona.ts:219 | `networkPolicy deny`/`allowInternetAccess`/`networkBlockAll` | 全部不传（用提供方默认） |
| provider-config.ts:531 | 连接测试 `network:false` | 删参数 |
| environment.ts:79,170-181 | 网络徽标、"无法保证断网"失败态 | 徽标改为"网络：取决于提供方/驱动"；删失败态 |
| permissions.ts:119，perm.ts:7，rbac-ui.tsx:37，docs/rbac.md:114 | `sandbox.network` | 不再校验；常量保留一版为空操作（已存角色授权不会报错），随后删除 |
| skills.ts:659,868；skills-package.ts:435,454；market.ts:447 | "沙箱未开放网络"拒绝/警告 | 删拒绝，保留 `network` 作为技能声明 + 用户逐版本授权（授权边界不变） |
| mcp-market.ts:179,235；mcp.ts:491 | npm/pypi 因"未开放网络"被 blocked | 改为按驱动技术能力判断 |
| SandboxProviders.tsx:23-24,278-282；EnvironmentButton.tsx:124；terminal.tsx:54；sandbox-tools.ts:42 | 禁止联网告警/"网络关闭"/"No network by default" | 改文案 |
| sandbox.ts:477（`execIsolated`，仅 slides.ts 转 PDF 内部使用） | 内部转换固定断网 | **保留**：非用户沙箱，属服务内部执行，需你确认 |

## 2. 运行模式
| 模式 | 现状 none / allowed | 改后 |
|---|---|---|
| namespaces | `unshare --net`（namespaces.ts:137）得到空网络命名空间，`capabilities.network:false`（:157）。**技术限制 + 安全取舍**：非特权 user ns 不能自行联网；去掉 `--net` 会共享宿主网络栈（含 127.0.0.1 上的 Workroom 自身），不可接受；需 slirp4netns/pasta 才能出网。两种设置下都无网络，allowed 时报 `network_unsupported`（sandbox.ts:367） | 如实报告"此驱动无法联网"（能力，非策略）；不做策略拒绝 |
| docker | none→`--network none`；allowed 且调用方声明才 bridge（几乎无调用方声明，仅 MCP npm/pypi） | 见 §3 |
| 远端三家 | none→全部拒绝（unverified）；allowed→创建时不带限制并追加提示 | 不再区分；创建不带任何网络参数 |

## 3. 方案
各提供方创建：E2B 不传 `allowInternetAccess`（SDK 默认）；OpenSandbox 不传 `networkPolicy`（docs/research/opensandbox.md:91 记录"无策略即可联网"为早期本机实测，本次未重测）；Daytona 不传 `networkBlockAll`（实际是否出网取决于 Daytona 账户/组织自身设置，**本次未验证**）。不修改第三方服务的网络设置。

本地 Docker（需决策）：
- A 保留 `--network none`：隐藏的断网仍在，违背指示。
- B 默认 `bridge`，无开关：最简，与远端一致。
- C（**推荐**）：B + 部署级 Docker 设置 `WORKROOM_DOCKER_NETWORK`（与镜像、cpus 同级的基础设施项，默认 bridge，运维可指向自建受限网络；无用户界面开关、无逐次拒绝）。

保留项：sandbox.use、空间 ACL、租户隔离（remote-driver 的 orgId/space 校验）、凭据注入与代理 SSRF 防护（credentials/proxy.ts:224，ops/egress.ts 私网/元数据名单）、提供方 endpoint 的 SSRF 检查（provider-config.ts:7-9，`allowPrivateNetwork`）、技能/MCP 审核与授权、只读挂载、资源限制。这些针对 Workroom 自身出站，与沙箱网络无关。

迁移：`tool_sandbox_settings.driver` JSON 的 `network` 在 #load（registry.ts:75-86）忽略，下次保存时剔除；`WORKROOM_SANDBOX_NETWORK` 弃用。`tool_sandbox_instances.network` 列保留，新建行写 1；`#acquire` 遇 `network=0` 的旧行视为"带拒绝策略创建"，惰性重建一次（工作区由宿主副本重新同步）。因真实提供方 networkOff 均为 unverified，被拒绝时不会建实例，实际存量极少。

## 4. 风险（如实说明）
bridge 下沙箱代码可访问网桥网关、局域网及云元数据 169.254.169.254；平台 URL 策略不作用于沙箱内（docs/files-tools.md:133 已承认）。非面向用户的缓解：部署文档提示用 `WORKROOM_DOCKER_NETWORK` + 主机防火墙（iptables DOCKER-USER 链）封 RFC1918/元数据——Workroom 不代为配置，超出本次范围。Workroom 服务若绑定 0.0.0.0，容器可经网关访问；建议默认绑定回环并文档说明。沙箱内凭据仍可被外传（credentials.md 已述）。升级后原先"none"的部署行为变为联网，需在发布说明中写明。

## 5. 测试
| 需改/删 | 改为 |
|---|---|
| sandbox-remote-driver.test.ts:41（unverified 拒绝）、:264（重建） | 断言"不拒绝、不重建"；创建参数不含网络字段 |
| sandbox-contract.test.ts:153-155,419-436 | 删网络分支；能力字段校验保留 |
| sandbox-remote-e2e.test.ts:25-26,43,65-66 | 无开关，运行成功且输出无"按可联网处理" |
| tools-sandbox-drivers.test.ts:151,236-242；tools-sandbox-files.test.ts:236-263,316-318,343-347；tools-sandbox-services.test.ts:75-80；round8-environment.test.ts:43,88,318；tools-sandbox.test.ts:73 | 去开关；docker 断言默认 `--network bridge`，设置 `WORKROOM_DOCKER_NETWORK` 后断言对应值；namespaces 仅断言 `supported:false` |
| sandbox-providers-unit.test.ts:137-139,360-370；fake-remote-provider.ts:23 | 断言 `allowInternetAccess`、`networkPolicy`、`networkBlockAll` **均不出现**在 create 参数中 |
| tools-market-mcp.test.ts:319-332；identity-rbac.test.ts:44,78；web/e2e round7-sandbox.mjs:76、round8-env.mjs:74,141 | 按新文案/权限更新 |

无凭据即可做：替身 SDK 的参数断言（上表）、Docker 参数构造断言（已有 stub 方式）、字段迁移单测（旧 JSON 含 network → 加载不报错）、旧实例行惰性重建单测。真实联网只能凭各家凭据做 LIVE 契约测试（docs/research/sandbox-providers.md:118），本次未执行，不能宣称已联通。已运行 `sandbox-remote-driver.test.ts`：27 通过，仅用于确认当前行为。
