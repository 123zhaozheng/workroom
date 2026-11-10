# 第 6 轮：对话创建技能、按需加载、范围权限（集成者）

## 1. 实施前核查（提交 `9519453`，以源码为准）

- **运行时**：`@earendil-works/pi-durable` 1.5.0（pi-ai / pi-codemode / chord 均为 1.5.0，精确锁定）。
- **技能工具不是 pi-durable 原生能力**：`skill_list`、`skill_load`、`skill_read`、`skill_run` 都是 Workroom 在 `server/src/tools/skills.ts` 中用 `defineTool` 自定义的工具，属于扩展 `wr.skills`。pi-durable 提供的是通用机制：工具注册（`replay`、`deferred`）、提示词分段（`PromptSection`）、durable 文档和任务恢复。

### 原调用链

- **发现**：系统提示词里没有技能元数据。模型只能调用 `skill_list`，或从 `tool_search` 的附带提示（`mcp.ts`）得知有哪些技能。
- **加载**：`skill_load` 依次经过：
  1. `Skills.resolveForUse`：检查 `skill.use` 权限、技能可见、已安装、版本已审核、未下架；
  2. 返回 SKILL.md 正文和资源清单。
- **读取**：`skill_read` 从内容寻址的 blob 中读取包内文本文件。
- **运行**：`skill_run` 依次经过：
  1. 检查是否为可执行技能、用户是否授予了所需权限、对空间是否有写权限；
  2. `Skills.execute` → `market.materialize`，把技能包只读物化到 `<dataDir>/sandbox-mounts/skills/<slug>-<digest>`；
  3. `sandbox.run` 在受限沙箱中执行。
- **挂载**：**每一次**沙箱运行（包括普通的 `sandbox_exec`）都会经过：
  1. mount provider `skills`；
  2. `market.mountPlan`；
  3. `skills.active()`，对用户的全部可用技能做权限查询；
  4. 逐个物化，然后逐个只读挂载。

### 差距

1. 沙箱每次运行的开销随已安装技能数增长；**超过 32 个后其余技能被悄悄丢弃**（`market.ts` 中 `if (out.length >= 32) break`）。
2. 系统提示词里没有元数据，模型只能靠先调 `skill_list` 才知道有哪些技能。
3. 没有“Agent 在工作区生成目录 → 受控提交 → 用户批准 → 保存为个人技能”的路径。现有的 `draftFromConversation` 是把整段任务整理成草稿，不读取 Agent 工作区里的文件。
4. 部门范围技能只认用户直接所属的部门，子部门成员看不到也用不了；但部门级的审核和发布权限按子树生效（`authz.deptWithin`），两套规则不一致。
5. 跨组织隔离靠代码中各处的 `org_id` 过滤，但没有针对 `/api/market/*` 中真实已发布技能的跨组织测试。
6. 界面上“提交审核”的目标范围默认是“组织”，即使用户没有 `skill.publish` 权限也是如此。

## 2. 方案与取舍

- **发现**：在 `wr.skills` 扩展中加一个 pi-durable 提示词分段，只列出当前用户此刻能用的技能，每个一行：名称、slug、用途。最多列 50 个，超出时明确写“另有 N 个，用 skill 工具 search 查找”，不悄悄截断。
- **内容按需**：SKILL.md 只在 `load` 时返回，包内文件只在 `read` 时读取，脚本只在 `run` 时在现有受限沙箱中执行。
- **挂载按需**：只挂载**本会话加载过**的技能，并在每次运行时重新校验权限，所以撤销、下架、版本固定都会立即生效。挂载有上限，超出时把未挂载的技能明确告诉模型。物化继续按内容哈希寻址，只读写入，用临时目录加原子重命名。
- **工具数量**：新增 `skill`（action：list / search / load / read / run，按 action 严格校验参数、分别授权）和 `skill_manage`（写操作：submit_draft / get_draft）。旧的四个工具保留注册，但标记 `deferred: true`：不再提供给模型，已有记录在重放或恢复时仍能执行。
- **对话创建**：
  - `skill_manage submit_draft` 只接受工作区内的相对路径 `dir`。服务端根据登录身份和任务绑定的真实工作区解析路径，拒绝穿越、符号链接和超限；
  - 用现有的包校验生成规范 zip，**固定快照和哈希**；
  - 通过现有 durable 审批（`wr.approvals`，按 callId 幂等）在对话中展示草稿卡；
  - 用户批准后才走 `Market.upload` 保存为个人技能，遵守组织的个人技能策略；
  - 拒绝则不生效。同一 callId 重放时复用同一快照，不会重复创建。
  - 绝不自动发布到商城，发布仍走现有的“提交审核 → 审核员审批”流程。
- **部门规则**：部门范围的技能和部门安装，覆盖该部门及其所有子部门，与权限子树的规则一致。由服务端强制执行。

## 3. 实施结果

| 部分 | 提交 | 主要文件 |
|---|---|---|
| 调研与基线测量（Sonnet A） | `a56105c` | `docs/research/skills-on-demand.md`、`scripts/bench-skills.mjs`、`artifacts/bench/skills-baseline-9519453.json` |
| 按需发现、统一 `skill` 工具、只挂载已加载技能、部门子树、跨组织测试（Sonnet B1） | `6ccf3e7` | `server/src/tools/{skills,market,sandbox,mcp,policy}.ts`、`server/src/core/contracts.ts`、`server/src/identity/module.ts`、`server/test/skills-ondemand.test.ts`、`skills-scopes.test.ts` |
| 对话创建技能 `skill_manage`（Sonnet B2） | `15194be` | `server/src/tools/skill-drafts.ts`、`server/test/skills-drafts.test.ts` |
| 草稿卡、工具文案、提交范围默认值、e2e（Sonnet C） | `220e74f`、`e9d308c` | `web/src/features/chat/{SkillDraftCard,Cards,toolDescribe}.tsx`、`web/src/pages/ChatPage.tsx`、`web/src/features/market/MySkills.tsx`、`web/e2e/round6-skills.mjs` |
| 集成：契约、接线、测量补充 | `9519453`、`be77f39`、`db264ed` | `shared/skill-drafts.ts`、`server/src/tools/module.ts` |

### 测量

条件：namespaces 驱动，4 核，Node 22.23.4，每个数据点热运行 20 次（`echo ok`），日期 2026-11-10。

热运行中位数：

| 已安装技能数 | 改前（全部挂载） | 改后：新会话 | 改后：会话已加载 5 个 | 改后：全部已加载 |
|---|---|---|---|---|
| 0 | 94 ms | 98 ms | 92 ms | 94 ms |
| 5 | 114 ms | 94 ms | 117 ms | 114 ms |
| 32 | 241 ms | 92 ms | 121 ms | 243 ms |
| 40 | 242 ms（只挂 32 个，8 个被悄悄丢弃） | 92 ms | 123 ms | 238 ms（挂 32 个，其余 8 个明确提示） |

结论：每多挂载一个技能，每次运行约增加 4–5 ms。改后开销只与本会话实际加载的技能数相关，与已安装总数无关。如果会话加载了全部技能，速度与改前相同，但超出上限的部分不再被悄悄丢弃。

原始数据在 `artifacts/bench/*.json`，复现命令：

```bash
node --disable-warning=ExperimentalWarning scripts/bench-skills.mjs --skills 0,5,32,40 --runs 20 [--loaded K]
```

## 4. 迁移说明

- **只增加，不改动、不删除已有数据**：
  - 新表 `skill_conv_loaded`（tools 模块迁移 602，即 `MARKET_MIGRATIONS` v2），记录每个会话加载过的技能。
  - 新表 `skill_ws_drafts`（tools 模块迁移 801），存技能草稿的快照记录；快照内容放在已有的 blob 存储里。
  - 两张表都由启动时自动迁移创建。
- **行为变化**：
  - 部门范围的技能和部门安装，现在也覆盖子部门成员，可见范围因此扩大，符合本轮确认的规则。
  - 沙箱只挂载本会话加载过的技能。旧会话首次在沙箱中使用某个技能前，需要先加载它；`skill run` 会自动挂载自己的技能。
- **兼容**：
  - `skill_list`、`skill_load`、`skill_read`、`skill_run` 仍然注册（`deferred`），旧记录的重放和恢复不受影响。
  - 新的会话提供给模型的是 `skill` 和 `skill_manage`。
- **回滚**：回退代码即可。两张新表不被旧代码读取，可以保留。
- **运维**：没有新的环境变量。`skill_manage` 受工具策略中“技能”组的开关控制。
