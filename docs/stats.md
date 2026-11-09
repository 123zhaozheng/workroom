# 统计与分析页（round 4，统计组）

代码：`server/src/ops/stats.ts`（聚合）、`stats-routes.ts`（路由）、`stats-schema.ts`（迁移）、`usage.ts`（用量投影，E 的原有实现）；前端 `web/src/pages/StatsPage.tsx`、`web/src/features/stats/*`（设计与图表选型见 `docs/ui.md` §10）；DTO `shared/ops.ts`（`Stats*` 新类型，原有 `StatsDTO` 不变）；演示数据 `scripts/seed-demo.mjs`；测试 `server/test/ops-stats.test.ts`、`web/e2e/round4-stats.mjs`。

原有 `GET /stats`、`/usage`、`/usage/ledger`、`/usage/export.csv` 保持不变（向后兼容），新增接口只追加。

## 1. 接口

| 方法 路径 | 说明 |
|---|---|
| `GET /stats/scopes` | 当前用户可用的范围列表（个人 / 组织 / 部门 / 项目，只列有权限的）、是否演示组织 |
| `GET /stats/overview?scope=&from=&to=&granularity=hour\|day\|week&tz=&largeContextTokens=` | 一次返回整页数据 `StatsOverviewDTO` |
| `GET /stats/export.csv?…同上…&chart=<name>&metric=requests\|tokens` | 单个图表的 CSV（UTF-8 BOM，防公式注入），记审计 `stats.export` |

- `scope`：`personal` ｜ `org` ｜ `project:<id>` ｜ `department:<id>`。
- `from`/`to`：ISO 时间，`to` 不含；缺省为最近 30 天。上一周期 = 紧邻 `from` 之前等长的区间（用于“较上期”）。最长 800 天。
- `tz`：东八区为 `480`（分钟，UTC 向东为正）。小时桶、日桶、周桶（周一起）、日历、星期×小时点阵都按这个本地时间分；前端传浏览器时区。
- `granularity`：`hour` 最长 14 天、`day` 最长 400 天，超过则自动改粗一级，响应里 `requestedGranularity` ≠ `granularity`，前端提示。
- `chart`：`kpis | calendar | punchcard | series-model | series-provider | series-route | outcomes | tools | latency | top-users | top-projects | conversations | knowledge`。CSV 来自与图表同一次计算，所以与屏幕上的数字一致。

## 2. 权限

RBAC 的 `authz` 服务存在时（现为常态）它是唯一依据：

| 范围 | 查看 | 默认持有者 |
|---|---|---|
| 个人 | `stats.personal.view` | 所有基础角色 |
| 项目 | `stats.project.view`（范围=项目） | 项目所有者、组织管理员/所有者、审计员、计费管理员 |
| 部门 | `stats.department.view`（范围=部门，含子部门） | 部门负责人、部门管理员、组织管理员… |
| 组织 | `stats.org.view` | 组织管理员/所有者、审计员、计费管理员 |
| 导出（非个人范围） | `stats.export` | 组织管理员/所有者、审计员、计费管理员；导出自己的个人数据不需要 |

没有 `authz` 服务时退回 E 原有规则（`UsageService.scopeFilter`：个人任何成员；项目 owner/组织管理员；部门 manager/组织管理员；组织管理员），导出与查看同权限。禁止（deny）优先、组织所有者不会被锁定，都由 `authz` 保证。每次请求都按当前状态重新判定。

数据隔离：所有查询都带 `org_id`；个人范围按 `user_id`；项目范围按项目；部门范围按 `usage_ledger.department_ids`（导入时快照，同 `/stats`）或部门成员。**对话标题与链接**只在查看者对该对话有读权限时返回（`identity.check(read, conversation)`）——组织管理员能看到“某成员在某项目用了多少”，但看不到不属于自己的个人对话标题。成员/项目排行只在有权限的范围内出现（个人范围不列他人）。

## 3. 数字怎么来的（没有估算）

所有数字都是对已存记录的聚合：

| 指标 | 来源 / 口径 |
|---|---|
| 对话 | `usage_ledger` 中 `kind='task'` 的不同 (空间, 对话) 数（范围内有过用户输入的对话） |
| 运行 / 模型请求 / 工具调用 | `usage_ledger` 的 `run` / `model_request` / `tool_call` 行数（定义见 `docs/ops.md` §3.1–3.2） |
| 产出文件 | `file_versions`，`origin != 'upload'`（智能体/自动化产出的版本数） |
| 知识检索 | `kb_retrieval_events`，`source != 'eval'` |
| 自动化运行 | `auto_runs`（按 `created_at`） |
| 成功率 | 成功运行 ÷（成功 + 失败 + 超时）。已取消、待审批、进行中不进分母；没有分母时为 `null`（不显示 0%） |
| P50 / P95 延迟 | 真实（非 fixture）模型请求 `duration_ms` 的最近秩分位；没有真实请求时为 `null`，模拟值另给 `simulatedValue` |
| 输入/输出/缓存 Token、费用 | `model_request`、`tool_call`、`adjustment` 行之和（`run`/`task` 行是展示用汇总，不重复计）。**真实**与**模拟**分开：`fixture=1` 的行进 `simulatedValue`，不进 `value`；费用只统计真实行 |
| 较上期 | 同一指标在上一周期的值；两侧都有值才给 `delta`；`deltaPct` 在上一周期为 0 时为 `null`；成功率的 `delta` 为百分点 |
| 迷你趋势 | 每个桶的同一指标（成功率/延迟在桶内重新计算，无数据为 `null`） |
| 日历 | 以 `to` 所在本地日往前 365 天，每日 {运行、模型请求、工具调用、Token、失败/超时运行}，**不受范围筛选影响** |
| 点阵 | 范围内按（星期，小时）计的同类数值 |
| 模型/供应商/路由序列 | `model_request` 按平台模型 / 路由 `provider/upstream` 的第一段 / 完整路由分桶；Token 含可归属到模型的压缩调整行（`adjustment`）；最多 7 项 + “其他”；系列 `simulated` = 它的全部行都是 fixture |
| 结果占比 | `OutcomeCounts`：任务 / 运行 / 模型请求 / 工具调用各一份，状态 success/failed/cancelled/timeout/awaiting_approval/in_progress（`docs/ops.md` §3.2） |
| 工具排行 | `tool_call` 按 `tool_name`：调用数、出错数（`outcome != success`）、错误率、平均耗时，前 15 |
| 延迟直方图 | 与 `/stats` 相同的桶界（250ms…60s，>60s），真实请求优先，仅有模拟时标 `source:"simulated"` |
| 大上下文失败集中度 | 同 `/stats` 的定义（输入+缓存 Token ≥ 阈值，默认 32k；按模型/路由/阶段），在统计范围内重新计算 |
| 知识命中 | 命中率 = `hit_count>0` 的检索 ÷ 全部；“无证据”= 无命中且原因为空或 `no_evidence`；`forbidden` 等其他空结果单独计为“其他空结果” |
| 成员/项目排行、对话下钻 | `usage_ledger` 分组；个人空间的项目 id 为空，显示为“个人空间” |

没有的就不显示：节省工时不在本页（仍只由 `/stats` 的确认记录/管理员基准提供）；沙箱运行（`tool_sandbox_runs`）与路由尝试（`ops_route_attempts`）没有进入本页的 KPI，它们已经体现在 `tool_call` 与 `model_request` 的结果里，避免双计。

## 4. 测试模型与“模拟”

fixture（测试模型）请求仍记 `fixture=1`、费用 0。页面规则：Token / 延迟的真实数值与模拟数值分开；只有模拟时，KPI 卡显示“模拟”徽标（费用卡显示“模拟 · 测试模型不计费”），顶部提示条说明；面积图里模拟系列用虚线 + 低透明度 + “模拟”标签。图表按模型/供应商分组时，fixture 总是单独一项。

## 5. 演示数据与隔离

- 演示组织在 `ops_demo_orgs(org_id)` 中登记（迁移 `stats-schema.ts` v100）。`usage_ledger.demo` 列（默认 0）标记回填行。
- 回填的账本行 `demo=1` 且 `fixture=1`（全是模拟：Token 标“模拟”，费用 0，模型名为 `demo-*`，路由 `demo-gateway-*`）。其他表的回填行（知识检索 `request_id='demo-backfill'`、自动化运行 `reason='demo-backfill'`、文件版本 `change_note='demo-backfill'`）都只存在于演示组织里。
- **真实组织永远不会统计到 `demo=1` 的行**（所有账本查询对非演示组织加 `demo = 0`），也不会看到别的组织的行（每个查询带 `org_id`）。演示组织的页面顶部显示“演示数据”横幅（`demo: true`）。
- `usage` 重建（`rebuildSpace`）与核对（`reconcileSpace`）只处理 `demo = 0` 的行，演示回填不会被重建删除，也不会造成核对不一致。
- 回填行没有对应的真实对话，所以下钻表里它们没有链接；演示组织当天通过真实 API 产生的对话（测试模型）有链接。

## 6. 生成演示数据

```bash
# 1) 启动服务（任意数据目录；例）
WORKROOM_DATA_DIR=data/dev-stats PORT=8864 WORKROOM_FIXTURE_TOOLS=1 node --disable-warning=ExperimentalWarning server/src/main.ts
# 2) 生成（服务需在运行；脚本直接写同一个 app.sqlite 做回填）
node scripts/seed-demo.mjs --base http://127.0.0.1:8864 --data-dir data/dev-stats --days 365 --seed 42
```

脚本做的事：① 通过真实 API 注册演示组织（管理员 `demo-admin@demo.workroom.example` / `demo-password-2026`）、6 名成员、3 个部门（含负责人）、3 个项目；② 用测试模型通过真实 API 在 4 个对话里产生当天的运行（回复、一次失败、一次超时），走正常的用量导入；③ 在 `ops_demo_orgs` 登记该组织；④ 以固定随机种子回填过去 N 天（默认 365）：工作日/周末节律、上班时段（东八区）、逐年增长、4 个演示模型、8 种工具（含不同错误率）、约 6% 的大上下文请求（`demo-fast` 失败更集中）、成功/失败/超时/取消/待审批；知识检索（约 78% 命中）、产出文件版本、两个停用的自动化及其运行记录。可重复运行：账本/检索/自动化运行的回填行会先删后写；文件版本只追加（表有不可变触发器），想彻底重来请删掉数据目录。脚本只写演示组织的数据，不碰任何其他组织。

## 7. 已知限制

- 部门范围的账本口径是导入时的部门快照（沿用 E 的设计），之后调部门不会改写历史；子部门成员不会自动算入上级部门的账本聚合。
- 服务端聚合是对账本分组查询（有 `usage_ledger(org_id, kind, at)` 索引）；个别图（延迟分位）把范围内的耗时读入内存计算，演示规模（3.7 万行/年）毫秒级，极大组织需要改成预聚合。
- 演示数据的小时分布是按工作日节律生成的（用于展示图形态），不是真实使用。
