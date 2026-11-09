# 部署、数据卷、备份恢复、迁移与升级

适用于单 owner 进程部署（架构 v1）。所有命令在仓库根目录执行，Node ≥ 22.19。

## 1. 部署

```bash
npm ci
npm run build:web                      # 前端静态资源 → web/dist（服务端自动托管）
export WORKROOM_DATA_DIR=/srv/workroom/data
export WORKROOM_SECRET_KEY="$(openssl rand -base64 48)"   # 必须妥善保存；丢失 = 已存储凭据无法解密
export PORT=8787 HOST=0.0.0.0 WORKROOM_SECURE_COOKIES=1    # 经 HTTPS 反向代理时
export WORKROOM_PUBLIC_URL=https://work.example.com        # OIDC 回调地址的基准
npm start
```

### 环境变量（运维相关）

| 变量 | 作用 | 默认 |
|---|---|---|
| `WORKROOM_DATA_DIR` | 数据卷根目录 | `./data` |
| `PORT` / `HOST` | 监听 | `8787` / `127.0.0.1` |
| `WORKROOM_SECRET_KEY` | 凭据加密密钥（模型 API Key、OIDC client secret、Webhook 签名密钥、TOTP 种子）。未设置时**拒绝存储**这些凭据（可改用 `WORKROOM_*` 环境变量凭据）；TOTP 种子退化为明文存储 | 无 |
| `WORKROOM_SECURE_COOKIES` | `1` = 会话 cookie 带 Secure | 关 |
| `WORKROOM_PUBLIC_URL` | 对外 URL（OIDC redirect_uri） | 请求来源 |
| `WORKROOM_FIXTURE_MODEL` | `0` 关闭测试模型 | 开 |
| `WORKROOM_ANTHROPIC_API_KEY` / `_BASE_URL` / `_MODEL` | 内置 Claude 渠道 | 无（模型显示 blocked） |
| `WORKROOM_OPENAI_API_KEY` / `_BASE_URL` / `_MODEL` | 内置 GPT 渠道 | 无（blocked） |
| `WORKROOM_OPENAI_COMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_LABEL` | 可选 OpenAI 兼容端点（内网模型） | 无 |
| `WORKROOM_REDACT` | 日志/记录脱敏：`standard` / `strict` / `off` | `standard` |
| `WORKROOM_LOG` | `info` / `debug` / `silent` | `info` |
| `WORKROOM_USAGE_IMPORT_MS` | 用量投影导入周期 | 30000 |
| `WORKROOM_AUTOMATION_TICK_MS` | 自动化调度周期（0 = 关闭） | 15000 |
| `WORKROOM_WEBHOOK_ALLOW_PRIVATE` | `1` 允许向内网地址发送 Webhook | 关 |
| `WORKROOM_SMTP_URL` | 预留；邮件发送未实现（blocked） | 无 |
| `WORKROOM_LEASE_TTL_MS` | space 单 owner 租约 TTL（运行内核） | 30000 |

产品模型凭据只读取 `WORKROOM_` 前缀变量；进程环境中的 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_BASE_URL` 等**永不使用**。

## 2. 数据卷

```
$WORKROOM_DATA_DIR/
├─ app.sqlite              身份/ACL/目录/文件版本/知识索引/自动化/用量投影（WAL 模式）
├─ blobs/<aa>/<sha256>     不可变内容寻址文件
└─ orgs/<orgId>/spaces/<spaceId>/
     ├─ durable.sqlite     该 space 唯一的 pi-durable 存储（会话、条目、任务、提交、pi.usage）
     └─ sandbox/           执行目录（可再生，默认不备份）
```

容量估算以实测为准：`du -sh $WORKROOM_DATA_DIR/{app.sqlite,blobs,orgs}`。`usage_ledger` 可随时从 pi 重建（`POST /api/admin/usage/rebuild`），不需要单独备份策略。

## 3. 备份（在线，服务运行中可执行）

使用 SQLite online backup API（`node:sqlite` 的 `backup()`），WAL 下读不阻塞写：

```bash
node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts backup "$WORKROOM_DATA_DIR" /backups/wr-$(date -u +%Y%m%dT%H%M%SZ)
node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts verify /backups/wr-<ts>
```

顺序与一致性：先 `app.sqlite`，再每个 `durable.sqlite`，最后 `blobs/`。每个数据库文件单独一致；跨文件保证“目录 ⊆ pi 存储”（备份里登记的会话一定存在）与“文件版本引用的 blob 一定存在”。备份副本中会清空单 owner 租约表（备份不是活动 owner），并切换为非 WAL 单文件。`manifest.json` 记录每个文件的 sha256 和各模块迁移版本；`verify` 校验校验和、`PRAGMA integrity_check` 与 blob 地址。

`--include-sandbox` 会同时复制执行目录（一般不需要）。源码备份另见 `scripts/backup.sh`（不含用户数据）。

停机冷备份同样有效：停止服务后整体复制 `WORKROOM_DATA_DIR`（包括 `-wal` 文件）。

## 4. 恢复

```bash
node --disable-warning=ExperimentalWarning server/src/ops/backup-cli.ts restore /backups/wr-<ts> /srv/workroom/data-restored
WORKROOM_DATA_DIR=/srv/workroom/data-restored WORKROOM_SECRET_KEY=<原密钥> npm start
```

`restore` 先校验，失败则拒绝；目标目录必须为空（不会覆盖在用数据）。必须使用**原来的** `WORKROOM_SECRET_KEY`，否则已存储凭据无法解密（模型渠道显示 blocked，需要重新录入）。恢复后：运行中的任务从 pi 存储的检查点恢复；自动化的已认领运行按 requestId 去重，不会重复触发；用量投影可用 `/api/admin/usage/rebuild` 与 `/api/admin/usage/reconcile` 复核。验证：`server/test/ops-observability.test.ts` › “online backup of a live data volume → verify → restore …”。

## 5. 迁移

- 每个模块在 `migrations` 中声明递增版本；启动时 `AppDb.migrate()` 在事务中应用未执行的版本并记入 `_migrations(module, version)`。只增不改：已发布的迁移 SQL 不得修改，新变更追加新版本。
- 表名前缀按模块划分（`id_`、`ops_`/`usage_`/`auto_`、`rt_`、`file_`/`tool_`/…、`kb_`/`mem_`）。
- pi-durable 自身存储的迁移由 pi-durable 负责（只用公开接口，不改其内部表）。

## 6. 升级流程

1. 在线备份并 `verify`。
2. 在分支上升级依赖（`--save-exact`）；pi-durable 升级先读 CHANGELOG 的 Breaking Changes。
3. `npm test`（含纵向证明、恢复、跨租户、自动化防重入测试）与 `npm run typecheck`。
4. 用备份副本做一次 reopen 演练：`restore` 到空目录 → 启动 → 登录、打开历史会话、检查 `/api/admin/usage/reconcile`。
5. 停服 → 部署新版本 → 启动（迁移自动执行）→ 观察日志中的 `migration`/`automation.*`/`model.route_*` 事件。
6. 回滚：停服，恢复升级前的备份到新目录并以旧版本启动（迁移不可逆，不要用新版本写过的库回退旧版本）。

## 7. 轮换 `WORKROOM_SECRET_KEY`

```bash
# 1) 停服并备份（见 §3）  2) 轮换（密钥只经环境变量传入，不出现在命令行参数/历史中）
WORKROOM_OLD_SECRET_KEY=<旧> WORKROOM_NEW_SECRET_KEY=<新> \
  node --disable-warning=ExperimentalWarning server/src/ops/rotate-secrets-cli.ts "$WORKROOM_DATA_DIR" --dry-run
WORKROOM_OLD_SECRET_KEY=<旧> WORKROOM_NEW_SECRET_KEY=<新> \
  node --disable-warning=ExperimentalWarning server/src/ops/rotate-secrets-cli.ts "$WORKROOM_DATA_DIR" [--seal-plaintext-totp]
# 3) 以 WORKROOM_SECRET_KEY=<新> 启动
```

覆盖：模型渠道 API Key、通知 Webhook 签名密钥、OIDC client secret、TOTP 种子（E），MCP 连接器密钥（D 的 `mcp_servers`，用 D 的编码与行绑定 AAD）。
在一个 `BEGIN EXCLUSIVE` 事务中完成；提交前逐条用新密钥解密核对明文且确认旧密钥已无法解密；任一失败（例如旧密钥错误）整体回滚、不写任何数据。
已是新密钥的值会被跳过（可重复执行）。检测到未过期的 space 租约（服务仍在运行）时拒绝执行（`--force` 可跳过）。
`--seal-plaintext-totp` 会把此前无密钥时明文存储的 TOTP 种子加密。验证：`server/test/ops-secrets.test.ts`。

## 8. 已知限制

- 单 owner：限流、并发、熔断计数在进程内；多 worker 需按 spaceId 路由（未实现）。
- 租约不是严格 fencing token（见 `docs/architecture.md`）。
- 被阻塞：真实模型凭据、支付、SMTP、真实企业 IdP（详见 `docs/ops.md` §8）。
