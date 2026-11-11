# 第 7 轮：可插拔沙箱、持久工作区、环境变量与凭据（集成者总览）

能力矩阵见 `docs/sandbox-support-matrix.md`。各部分的细节文档：

| 主题 | 文档 |
|---|---|
| 持久工作区 | `docs/workspace-persistence.md` |
| 凭据 | `docs/credentials.md` |
| 调研 | `docs/research/opensandbox.md`、`docs/research/sandbox-providers.md`、`docs/research/credentials-and-persistence.md` |

## 1. 分层：三者互不替代

| 层 | 由谁负责 | 承诺 | 不承诺 |
|---|---|---|---|
| 对话与编排的 checkpoint | pi-durable 1.5.0 | 对话、任务、审批、凭据请求的状态在重启后可恢复 | 恢复沙箱中的文件、内存或进程 |
| 工作区文件版本 | Workroom（`persist.ts`；blob 加 manifest、sha256） | 在保存点上的内容可恢复，恢复时逐个校验哈希 | 两个保存点之间、仍在运行中的命令在远端产生的改动 |
| 沙箱内存/进程快照 | 提供方 | 本轮不使用 | 跨提供方迁移，以及快照内容（可能包含内存和密钥） |

## 2. 工作区保存策略

- **保存点**：
  - 每次命令结束，包括失败和超时（`run_end`）；
  - 写入工作区文件之后，即 `sandbox_write_file` 和 `sandbox_import`（`file_write`）；
  - 发布成果之前（`before_publish`）；
  - 用户手动保存。
- **定期同步**：默认关闭，只作为补充。不能指望突发故障时还来得及拷贝。
- **保存范围**：`/work` 下的全部文件。依赖缓存和临时目录不保存，默认排除 `node_modules/`、`.venv/`、`__pycache__/`、`.cache/`、`tmp/` 等，管理员可配置。
- **最大可能丢失**：
  - 本机驱动：宿主机目录本身就是工作副本，丢失的只是自上次保存点以来、尚未写入版本的改动；如果宿主机磁盘损坏，这部分会丢。
  - 远端驱动：正在运行的命令在远端产生的改动，要等这条命令结束后回传到宿主机才算数；命令运行期间远端沙箱终止，这部分就会丢。
- **保存失败**：工作副本原样保留，状态记为“保存失败”，并写明原因，且不允许回收。
- **版本冲突**：提交时会核对基础版本；发现更新的版本时记为“冲突”，不覆盖任何内容。
- **回收**：只回收“已保存且空闲超过保留期”的整个工作副本。有未保存改动、保存失败或处于冲突状态的副本一律保留。
- **沙箱过期后继续原会话**：
  1. 先核对远端沙箱是否还在；如果已不存在，就新建一个；
  2. 宿主机工作副本缺失时，从最近一次成功保存的版本恢复，并逐个校验哈希；
  3. 有未保存的改动时拒绝覆盖；
  4. 技能在下次运行时重新校验授权、重新上传。
- **中断的命令**：服务重启时仍在运行的命令标记为“结果未知”，不会自动重跑。
  - `sandbox_exec` 和 `credential_http` 都设置为 `replay: "unsafe"`，可能有外部副作用的操作需要人工核实。
  - `credential_http` 会透传调用方提供的 `Idempotency-Key`。

## 3. 普通环境变量

- **优先级**：会话 > 用户 > 项目 > 组织；组织级变量如果设为“锁定”，下级不能覆盖。
- **权限**：
  - 组织级：需要 `sandbox.policy.manage`；
  - 项目级：需要项目管理权限，项目成员只读；
  - 用户级：只能设置自己的；
  - 会话级：需要对该空间的写权限。
- **拒绝的变量**：动态加载器（`LD_*`、`DYLD_*`）、`PATH`、`HOME`、各类代理变量、运行时钩子（`NODE_OPTIONS`、`PYTHON*`、`BASH_ENV` 等）、TLS 与 CA 相关变量、平台保留前缀，以及已被凭据占用的变量名。看起来像密钥的值也会被拒绝。这只是护栏，不能保证拦住所有密钥。
- **生效时机**：只对之后启动的命令和服务生效，正在运行的进程不受影响。
- **审计**：只记录名称和值的哈希前缀，不记录值本身。

## 4. 凭据

- **申请与填写**：
  1. Agent 调用 `credential_request`，说明服务、用途、目标主机、允许的 HTTP 方法、注入方式和有效期；
  2. 对话中显示安全表单；
  3. 密钥通过独立的 HTTPS 接口提交，接口带一次性 nonce，并与发起申请的用户、会话和那次工具调用绑定；
  4. 模型只能拿到状态（已提供、已拒绝、已过期等），拿不到密钥。
- **存储**：使用 `SecretStore`：
  - 本地 AES-256-GCM，主密钥来自 `WORKROOM_SECRET_KEY` 或 `WORKROOM_SECRET_KEY_FILE`，不放在数据库里，也不进入仓库或备份；
  - 也可选择 Vault/OpenBao Transit；
  - 未配置时拒绝保存，绝不使用固定密钥。
- **使用方式一：服务器代调用（`credential_http`，默认）**：
  - 只能访问声明过的主机和方法；
  - 只允许 https；
  - DNS 解析一次后固定连接，不再重新解析；
  - 不跟随重定向，也不使用代理环境变量；
  - 请求、响应大小和超时都有上限；
  - 返回给模型的响应会先去掉密钥。
- **代调用的局限**：目标主机本身会收到密钥；受控代理不能防住所有滥用。
- **使用方式二：注入进程环境变量**：
  - 需要用户单独、明确同意，并且只对当前会话的单次运行生效；
  - 不写入运行记录、工作区或快照；
  - 该进程及其子进程都能读到，可能被泄露；
  - 远端驱动下一律拒绝。

## 5. 无法实际联调的部分：环境配置与验收步骤

所有测试都会读取下面的环境变量；变量未设置时，测试会跳过并写明原因。

| 项 | 需要的条件 | 验收命令 |
|---|---|---|
| OpenSandbox（本机） | Docker；PyPI 能访问 | `scripts/opensandbox-local.sh`，然后执行：<br>`WORKROOM_TEST_OPENSANDBOX_URL=http://127.0.0.1:8080 WORKROOM_TEST_OPENSANDBOX_KEY=$(cat <key文件>) node --disable-warning=ExperimentalWarning --test server/test/sandbox-contract.test.ts server/test/sandbox-remote-e2e.test.ts` |
| E2B（官方或兼容端点） | API key；兼容服务另需 endpoint 和 domain | `WORKROOM_TEST_E2B_API_KEY=… [WORKROOM_TEST_E2B_ENDPOINT=… WORKROOM_TEST_E2B_DOMAIN=…] node --disable-warning=ExperimentalWarning --test server/test/sandbox-providers-unit.test.ts server/test/sandbox-contract.test.ts`。测试会创建临时沙箱（第 9 轮起不再传任何网络参数，按提供方默认），只使用合成数据。 |
| Daytona | API key | `WORKROOM_TEST_DAYTONA_API_KEY=… node --disable-warning=ExperimentalWarning --test server/test/sandbox-providers-unit.test.ts server/test/sandbox-contract.test.ts` |
| Vault/OpenBao Transit | 服务地址、token、transit key | `WORKROOM_SECRET_STORE=vault-transit` 加上 `docs/credentials.md` 中列出的变量，然后运行 `server/test/credentials.test.ts` |

注意：只有合同测试在真实服务上通过之后，才能在代码中把相应能力改为 `supported`。外部云服务涉及数据出境，测试只使用合成数据，不会发送真实用户资料。

## 6. 已知缺陷与后续工作

- **（第 9 轮已调整）沙箱网络**：Workroom 不再有自己的“无网络”策略，也不再因提供方断网未验证而拒绝运行；创建沙箱时不传网络参数，出站网络由提供方决定。第三方沙箱内的联网不受平台 URL 策略约束。详见 `docs/r9-network.md`。
- **远端沙箱冷启动慢**：首次运行需要 5–10 秒。每次运行都要对整个工作区计算哈希，工作区很大时会变慢。
- **远端技能的只读保护较弱**：用的是 `chmod` 加每次运行前的哈希复核，不是内核级只读。
- **长驻服务（沙箱内 MCP stdio）在远端提供方上不可用**，会返回 501。
- **凭据申请状态靠轮询**：界面每 1.5 秒查询一次，没有并入 SSE 状态。
- **主密钥轮换**：不支持在线重新加密，换主密钥后需要重新录入凭据。
- **Vault Transit 未接真实服务**：只对替身做过测试。
- **E2B、Daytona 未联调**。
- **Kubernetes Agent Sandbox 未实现**。
- **会话分支**：分支不继承父会话的工作区版本，分支有自己的工作区。
