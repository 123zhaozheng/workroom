# 第 9 轮：沙箱网络——去掉 Workroom 自己的网络控制

## 1. 变了什么（一句话）

Workroom 不再有自己的“沙箱无网络”开关或策略。沙箱能不能联网，由沙箱本身决定：

- 第三方沙箱（OpenSandbox / E2B / Daytona）遵循**提供方自己的**网络行为，Workroom 创建沙箱时不传任何网络参数，也不修改提供方的设置。
- 本机 Docker 默认接入 Docker 的默认桥接网络（可访问互联网）；运维可用部署级环境变量 `WORKROOM_DOCKER_NETWORK` 改成 `none` 或自建网络。没有面向用户或管理页面的开关。
- 本机命名空间驱动没有网络，这是技术限制，不是策略；界面如实写出。

沙箱隔离（容器/命名空间、只读根、只写 `/work`、资源限制）、用户授权、凭据保护、租户与空间权限、提供方端点的 SSRF 检查都没有变。

## 2. 行为：之前 → 之后

| 对象 | 之前 | 之后 |
|---|---|---|
| 设置项 `network`（`none`/`allowed`，表 `tool_sandbox_settings`、环境变量 `WORKROOM_SANDBOX_NETWORK`、`PUT /api/sandbox/driver`） | 默认 `none` | 读取但**忽略**：旧行、旧环境变量不报错也不生效；`PUT` 里带 `network` 会被接受并忽略，响应的 `deprecations` 说明；下次保存设置时旧字段从存储里移除 |
| `Sandbox.run` / `startService` | 远端提供方的断网“未验证”⇒ 默认**拒绝运行**（501）；开 `allowed` 后加一行“[网络] 按可联网处理”；请求联网还要 `sandbox.network` 权限 | 不拒绝、不追加提示；`RunInput.network` 废弃并忽略；`sandbox.network` 不再检查 |
| 远端实例 | 网络策略变化 ⇒ 销毁并重建 | 不再因网络重建。旧版本在“无网络”下创建的实例（`tool_sandbox_instances.network = 0`，创建时带过 deny 选项）在下一次使用时**惰性重建一次**（工作区由宿主机副本重新同步，运行输出里有一行说明）；新行一律写 `1` |
| OpenSandbox 创建 | 无网络时传 `networkPolicy: { defaultAction: "deny" }` | 不传 `networkPolicy` |
| E2B 创建 | `allowInternetAccess: <network>` | 不传 `allowInternetAccess` |
| Daytona 创建 | 无网络时 `networkBlockAll: true` | 不传 `networkBlockAll` |
| 提供方连接测试 | 临时沙箱带“无网络” | 不传网络参数（临时沙箱，合成数据，结束即销毁） |
| 本机 Docker | `--network none`；仅当调用方声明且开关为 allowed 才 `bridge`（实际几乎无人声明，所以永远断网） | `--network <WORKROOM_DOCKER_NETWORK>`，默认 `bridge` |
| 命名空间驱动 | 两种设置下都无网络；请求联网报 `network_unsupported` | 仍无网络，不再报错；能力如实报告 |
| `execIsolated`（内部渲染不可信文档，如幻灯片转 PDF） | 固定无网络 | **不变**，仍固定无网络（不是用户沙箱，属服务内部执行） |
| 环境面板 `network` | “可联网/不联网”取决于策略；远端提供方在“无网络”策略下显示“失败：无法保证断网” | 如实显示驱动/提供方的能力：`可联网`、`无网络（本机命名空间驱动的技术限制）`、`由提供方决定（Workroom 不限制，也不修改提供方的网络设置）`。DTO 增加 `networkText`；旧字段 `network` 保留为能力镜像（已废弃） |
| 技能运行 | 声明 `network` 的技能被“沙箱未开放网络”拒绝，草稿校验失败 | 不再拒绝。`network` 仍是技能声明的权限，仍需用户逐版本授权（授权边界不变）；沙箱能否联网取决于所用环境 |
| 权限 `sandbox.network` | 联网请求需要 | 保留一版作为**空操作**（目录里标“已停用”，已有角色授权不会出错），不再校验，下一版移除 |
| 管理页 SandboxProviders | “禁止联网：尚未验证，请不要依赖它隔离网络”警告 + 能力行 | 删除该警告与“禁止联网”行；改为一行说明“沙箱能否联网由提供方决定”；“允许联网”行改名“出站网络（由提供方决定）” |
| 提供方能力 `networkOff` | 决定是否拒绝 | 不再被 Workroom 使用（字段保留，兼容旧数据与旧客户端）；`networkOn` 仅作信息（OpenSandbox 在本机实测过：不带策略创建的沙箱可联网） |

## 3. 运维说明

### 3.1 `WORKROOM_DOCKER_NETWORK`（部署级，仅本机 Docker 驱动）

| 值 | 含义 |
|---|---|
| 未设置 / 空 | Docker 默认 `bridge`：容器可访问互联网 |
| `none` | 容器只有回环，完全没有网络（等同旧默认） |
| 自建网络名（如 `wr-sandbox`） | 容器接入该 Docker 网络；出口规则由运维用 Docker/主机防火墙配置 |
| `host`、`container:…`、含空格或非法字符 | **拒绝并按 `none` 处理**（fail closed）。`host` 会共享服务器网络栈，包括 Workroom 自己监听的回环端口。管理员页的驱动详情会显示这条警告 |

该变量在每次启动容器时读取，修改后无需重启即对**新容器**生效。

### 3.2 要如实知道的风险

桥接网络下，沙箱里的代码（包括模型生成的代码）可以：访问互联网；访问网桥网关、服务器所在的局域网与其他容器；访问云主机的元数据地址（`169.254.169.254`）；在 Workroom 绑定 `0.0.0.0` 时经网关访问 Workroom 自己。平台的 URL 策略（代理的 SSRF 防护、`ops/egress.ts` 的私网名单）只作用于 Workroom 自己发起的请求，**不作用于沙箱内**。沙箱内的凭据（环境变量方式）也可能被代码外传。第三方沙箱同理：它们能到哪里，由提供方决定。

Workroom 不会替你配置防火墙，也不承诺任何出口过滤。想限制时：

1. 建一个专用 Docker 网络：`docker network create --driver bridge wr-sandbox`（可加 `-o com.docker.network.bridge.enable_icc=false` 禁止容器互访）。
2. 用主机防火墙限制该网桥的出口（Linux 示例思路：在 `DOCKER-USER` 链里对来自该网桥的流量，丢弃目的为 RFC1918 私网、链路本地与 `169.254.169.254` 的包，只放行需要的外网）。具体规则取决于你的网络，请自行测试。
3. 设置 `WORKROOM_DOCKER_NETWORK=wr-sandbox`。
4. 或者设为 `none`，并接受沙箱里的 `pip install` / `npm install` / MCP npm、pypi 包不可用。
5. Workroom 服务建议绑定回环地址或放在反向代理之后，不要无故监听 `0.0.0.0`。

### 3.3 升级后行为变化（发布说明请写明）

原先“默认无网络”的部署，升级后沙箱**默认变为可联网**（本机 Docker 走桥接，第三方沙箱按提供方默认）。不能接受的部署请在升级前设置 `WORKROOM_DOCKER_NETWORK=none`（本机 Docker），第三方沙箱请在提供方一侧配置网络（Workroom 不会去改）。

## 4. 迁移与回滚

- **迁移**：无需手工步骤。`tool_sandbox_settings.driver` 里的旧 `network` 被忽略；`WORKROOM_SANDBOX_NETWORK` 被忽略（管理页 `deprecations` 里能看到）。旧远端实例按 3 的表惰性重建一次。
- **数据库**：没有新的迁移；`tool_sandbox_instances.network` 列保留（新行写 1）。
- **回滚**：回到第 8 轮代码后，旧代码会把 `network` 缺省当作 `none`（默认）：远端提供方又会被“断网未验证”拒绝，需要管理员重新把 `network` 设为 `allowed`；这一次重建的远端实例带 `network=1`，回滚后不会再被重建。本机 Docker 回到 `--network none`。
- `sandbox.network` 权限 id 仍在目录里，回滚不会丢失已有角色授权。

## 5. 联网实测（真实结果，不是推断）

测试环境：Linux 容器，出站 HTTPS 经环境自带的代理；本机 Docker（默认桥接）与本机 OpenSandbox 1.2.0（`http://127.0.0.1:8080`，Docker 运行时）。

探测命令（沙箱内 Python）：`socket.gethostbyname('example.com')` 与 `urllib.request.urlopen('https://example.com', timeout=…)`。运行命令：

```
WORKROOM_TEST_OPENSANDBOX_URL=http://127.0.0.1:8080 WORKROOM_TEST_OPENSANDBOX_KEY=$(cat <key文件>) \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 \
  server/test/sandbox-contract.test.ts server/test/sandbox-remote-e2e.test.ts server/test/tools-sandbox-docker.test.ts
```

测试会在输出里打印 `[network probe] …` 一行（真实结果，不会伪造）。设 `WORKROOM_TEST_REQUIRE_EGRESS=1` 可要求必须到达外网（在出口受限的环境里会失败，这是预期的）。

结果（本次执行）：见交付报告中的“LIVE 结果”一节；记录如下。

{{LIVE_RESULTS}}

E2B、Daytona：没有密钥，**未联调**，不宣称任何联网结论；适配器测试用 SDK 替身证明“不传任何网络参数”。

## 6. 本轮改动的文件

服务端：`server/src/tools/sandbox.ts`、`sandbox/registry.ts`、`sandbox/remote-driver.ts`、`sandbox/docker.ts`、`sandbox/driver.ts`、`sandbox/environment.ts`、`sandbox/network.ts`（新，只描述能力）、`sandbox/provider.ts`、`sandbox/provider-config.ts`、`sandbox/providers/{opensandbox,e2b,daytona}.ts`、`sandbox/perm.ts`、`sandbox-routes.ts`、`skills.ts`（只删网络拒绝）；共享：`shared/sandbox.ts`（只增、标注废弃）、`shared/permissions.ts`；界面文案：`SandboxProviders.tsx`、`EnvironmentButton.tsx`。

仍留有旧文案、不在本轮范围的位置（由对应负责人处理）：`skills-package.ts`/`market.ts`（“沙箱默认无网络，需管理员开启”的检查提示）、`mcp-market.ts`（npm/pypi 包的“沙箱默认无网络”阻断文案；判断已改为按驱动能力）、`sandbox-tools.ts` 的工具描述、`web/src/features/market/common.tsx` 的“默认不允许，需管理员另外开启”、`rbac-ui.tsx` 的权限标签。
