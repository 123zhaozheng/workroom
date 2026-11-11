# 第 11 轮 R2：三级触发与意图预热

范围：沙箱什么时候被拉起。生命周期（暂停/恢复/回收）见 R1/R3，浏览器本地执行见 R4，不在本文。

## 1. 三级触发

| 级别 | 触发 | 实现 | 状态 |
|---|---|---|---|
| a 显式选择 | 用户点环境按钮的“准备”（POST `/conversations/:s/:c/environment/prepare`，body `{ "trigger": "explicit" }`） | 服务端 `ConversationEnvironments.prepare(..., { trigger: "explicit" })`，trigger 一路传到 driver，记入生命周期事件 | 服务端已有；按钮接线由主 agent 负责 |
| b 意图预测 | 用户消息被接受之后，意图分 ≥ 阈值 → 后台 `prepare(..., { trigger: "prewarm" })` | `server/src/tools/sandbox/intent.ts`（打分）+ `prewarm.ts`（决策、去重、日志）+ `runtime/service.ts` 的 `#prewarmHint`（一行不等待的调用） | 本文 |
| c 首次 exec 兜底 | agent 第一次调用 `sandbox_exec` 等工具，RemoteDriver 按需创建 | 原有逻辑，未改动 | 已有 |

纯聊天永远不会拉起沙箱：只有第 b 级里分数过阈值的消息，或第 c 级里 agent 自己调用执行类工具，才会走到 provider。`GET .../environment` 仍然只读。

## 2. 预热的门槛（全部满足才会发起）

1. 消息已被接受（`Runtime.submit` 成功之后调用，**不 await**，异常全部吞掉并只记 `console.warn`）。运行时自己写入的输入（自动化、子任务回报，带 `via`）不触发。
2. 组织设置里预热为开（默认开）。
3. 组织当前渠道是远程提供方（本地驱动没有什么可预热的）。
4. 用户对该空间有写权限，且有 `sandbox.use`。
5. 意图分 ≥ 阈值（默认 0.3）。
6. 该会话的沙箱不是 `ready`，也不在 `preparing` / `resuming`。`paused`、`archived`、`lost`、`none`、最近 2 分钟之外的 `failed` 都算“没有可用的”，由 `prepare` 创建或恢复（恢复走 R1 的 prepare 路径，不重建）。
7. 同一工作区同一时刻只有一个预热在飞（进程内去重）；同一组织同时最多 4 个预热（`MAX_PREWARMS_PER_ORG`）。
8. 上一次预热失败后 2 分钟内不重试（失败状态照常显示；第一次 exec 仍会自己尝试创建）。

聊天运行不等预热：`#prewarmHint` 同步返回，决策与 `prepare` 都在脱离的 promise 里。测试里让假 provider 的 `create` 一直挂起，固定模型的回答照常完成（`sandbox-prewarm.test.ts`）。

## 3. 意图打分

`scoreExecIntent({ text, attachments, usedSandbox, assistantTools }) → { p, signals }`，纯函数，无 I/O、无模型调用，约 0.006 毫秒一条。

    p = sigmoid(-2.4 + Σ 命中特征的权重)

截距 -2.4 对应“什么特征都没有”时 8%。文本只扫描前 6000 个字符。正文里的中英文关键词同时覆盖。

对“纯文字请求”的负特征（写作、翻译、解释、建议），当消息带了数据/代码/压缩包附件时权重减半（`ATTACHMENT_DAMPING = 0.5`）：用户明显想让附件被处理。

### 输入里没有的东西

- “开发类模板”：代码里没有这个概念（助手没有类别，项目只有 `container` / `space`），所以没有做这个信号，也没有发明它。
- “技能”：技能由模型在回合内加载，消息到达时还没有选择，不是输入。
- 唯一现成的配置级信号：助手的默认工具清单里写了 `sandbox_*` / `codemode`（`assistant_sandbox_tools`，+1.0，单独不足以过 0.3）。

### 权重表（由 `INTENT_FEATURES` 导出）

| 特征 id | 权重 | 含义 |
|---|---:|---|
| `used_sandbox` | +2.2 | this conversation already ran code in a sandbox (the next message usually continues that work) |
| `assistant_sandbox_tools` | +1.0 | the bound assistant's default tools name sandbox tools |
| `sandbox_word` | +2.6 | mentions a sandbox / terminal / Jupyter / REPL |
| `run_code` | +2.0 | asks to run / execute code, a script, a command or tests |
| `shell_command` | +1.5 | a line that looks like a shell command (ls, cd, git, pip, npm, python …) |
| `install_build_deploy` | +1.4 | install / build / compile / package / deploy / docker |
| `fenced_code` | +1.0 | a fenced code block |
| `fenced_code_lang` | +0.5 | the fence names a runnable language |
| `code_like_lines` | +0.8 | unfenced lines that look like source code: def / import / SELECT … FROM (a fenced block is counted once, by fenced_code) |
| `build_program` | +1.4 | asks for a script / scraper / small app to be written |
| `code_language` | +0.6 | names Python / pandas / numpy / bash / regex … |
| `data_analysis` | +1.8 | data analysis / statistics / regression / pivot / counting by group |
| `chart` | +1.7 | draw / plot a chart or graph |
| `file_task` | +1.6 | a conversion / merge / split / compress / batch verb together with a file noun |
| `network_task` | +1.6 | scrape / crawl / download / call an API / curl |
| `compute_task` | +1.6 | simulation / benchmark / hash / large or exact computation / generate many rows |
| `attach_data` | +2.0 | a data file (csv / xlsx / json / parquet / sqlite …) is attached |
| `attach_archive` | +2.0 | an archive (zip / tar / gz / 7z …) is attached |
| `attach_code` | +1.8 | a source file or notebook is attached |
| `attach_media` | +0.8 | an image / audio / video file is attached |
| `attach_work_verb` | +0.8 | a data / code / archive / media attachment together with a work verb (analyse, convert, count, …) |
| `writing_request` | -1.4 | write / polish / rewrite an email, article, report, poem … |
| `translation` | -1.4 | translate |
| `explain_summarize` | -0.9 | explain / summarise / describe / what is … / why … |
| `advice_opinion` | -0.8 | recommendation / opinion / comparison / career / planning questions |
| `chitchat` | -1.5 | a short greeting / thanks (not inside a conversation that is already running code) |

## 4. 数据集与指标

文件：`server/test/fixtures/sandbox-intent.json`，140 条中英文消息（含附件名、是否已用过沙箱），一半“需要沙箱”一半不需要。标注口径：**一个合格的 agent 要把这条消息答好，是否需要真的执行代码/命令/文件处理**。仅仅“写一个函数”“怎么安装 Python”“解释这段代码”“Excel 怎么做透视表”按“不需要”标。

- `train`（60 条）：调权重时看的。
- `heldout`（80 条）：不用来调权重。其中 20 条是后加的难例（没有关键词的执行需求、带关键词的非执行需求）。

**诚实说明**

- 数据是作者按经验手写的，不是真实流量。负例比真实聊天“干净”，所以下面的精度**偏乐观**；真实精度要用第 6 节的日志估计。
- train 上的 100% 说明规则拟合了 train，不说明泛化。看 heldout。
- heldout 不是完全干净的：第一版权重定下后我看过 heldout 的汇总数字，并据其中两个失败修了两处**正则缺陷**（“画…图”的间隔上限从 8 个字符放宽到 24；`pytest` 加入“运行 X”的对象词）。没有为任何单条 heldout 样本加关键词或改权重。修之前 heldout 在 0.3 为 P 0.94 / R 0.75，修后 P 0.94 / R 0.80。
- 仍然漏掉的典型：没有任何关键词的执行需求（“检查网站能不能打开”“Is 1000000007 prime?”“这个 PPT 里的图片导出来”）、只有文档附件的计数类问题。这类由第 c 级兜底（首次 exec 才创建，冷启动一次）。

### 阈值 0.3 下

| 集合 | 精度 | 召回 | tp / fp / fn / tn |
|---|---:|---:|---|
| train（60） | 1.00 | 1.00 | 30 / 0 / 0 / 30 |
| heldout（80） | 0.94 | 0.80 | 32 / 2 / 8 / 38 |
| 全部（140） | 0.97 | 0.89 | 62 / 2 / 8 / 68 |

heldout 的两个误报：“How do I install Python on Windows 11?”和“用 Excel 怎么做数据透视表？”。

### 阈值扫描

| 阈值 | train 精度/召回 | heldout 精度/召回 | 全部 精度/召回 |
|---:|---|---|---|
| 0.1 | 0.88 / 1.00 | 0.83 / 0.85 | 0.85 / 0.91 |
| 0.2 | 1.00 / 1.00 | 0.94 / 0.82 | 0.97 / 0.90 |
| 0.3 | 1.00 / 1.00 | 0.94 / 0.80 | 0.97 / 0.89 |
| 0.4 | 1.00 / 0.90 | 0.96 / 0.57 | 0.98 / 0.71 |
| 0.5 | 1.00 / 0.77 | 1.00 / 0.47 | 1.00 / 0.60 |
| 0.6 | 1.00 / 0.67 | 1.00 / 0.40 | 1.00 / 0.51 |
| 0.7 | 1.00 / 0.57 | 1.00 / 0.30 | 1.00 / 0.41 |

0.3 落在召回开始明显下降之前，精度已经平台化：预热的代价（一个空闲沙箱，由 R3 回收）远小于漏掉的代价（一次冷启动），所以默认偏向召回。阈值的最终值应该用真实日志定，不是这份手写数据。

测试 `server/test/sandbox-intent.test.ts` 断言的下限（低于实测值）：train P/R ≥ 0.9，heldout P ≥ 0.85 且 R ≥ 0.7，全部 P ≥ 0.88 且 R ≥ 0.78，且召回随阈值单调不增；运行 `node --disable-warning=ExperimentalWarning --test server/test/sandbox-intent.test.ts` 会把整张扫描表打印出来。

## 5. 设置与接口

组织级，存在已有的 `tool_sandbox_settings` 键值表（键 `prewarm:<orgId>`，值 `{ "enabled": true, "threshold": 0.3 }`）。权限：`sandbox.policy.manage`，和沙箱渠道设置相同；修改写入审计（`sandbox.prewarm.update`）。

| 接口 | 说明 |
|---|---|
| `GET /api/sandbox/prewarm` | `{ settings: { enabled, threshold } }`，默认 `{ true, 0.3 }` |
| `PUT /api/sandbox/prewarm` | 可只传 `enabled` 或 `threshold`（0..1，否则 400） |
| `GET /api/sandbox/prewarm/stats?days=30` | 第 6 节的统计 |

后台管理 › 沙箱：当前渠道是远程提供方时，渠道选择下面多一行（开关 + 触发阈值 %）。组件 `web/src/features/admin/PrewarmSettings.tsx`。没有说明文字。

## 6. 预热日志与调阈值

表 `tool_sandbox_prewarm_log`（迁移在 `prewarm.ts`，tools 模块版本偏移 +1500）：

| 列 | 含义 |
|---|---|
| `org_id, space_id, conversation_id, at` | 哪条消息的决策 |
| `score, threshold` | 当时的分数与阈值 |
| `fired` / `reason` | `fired`（发起了预热）、`below`（低于阈值）、`ready`（过阈值但沙箱已就绪）、`inflight`（已在准备/恢复，或同工作区已有预热）、`capped`（组织并发上限）、`failed_recently`（刚失败过） |
| `signals` | 命中的特征 id，逗号分隔（不存消息正文） |
| `used_at` | 之后该会话真的发生了 `sandbox_exec` 的时间 |

只记录“本来可以预热”的决策（组织渠道是远程、用户有权限、设置为开）；每条消息一行，保留 90 天。`used_at` 由 `sandbox-tools.ts` 的 `sandbox_exec` 在运行返回后写：(1) 该会话最近一条还没标记的决策；(2) 该会话 24 小时内所有已发起、未标记的预热。

统计（`prewarmStats`，也是 `/stats` 的返回）只用 `fired` 与 `below` 两类行：

- 精度 = 发起且后来有 exec 的 / 发起的
- 召回（估计）= 发起且有 exec 的 / （发起且有 exec 的 + 低于阈值但之后有 exec 的）
- `sweep`：用日志里记下的分数，在 0.1 到 0.7 的其他阈值下重算 tp / fp / fn 与精度、召回

局限：召回是下界附近的估计（只统计到真的 exec 过的会话；一条低分消息后面的 exec 可能是更晚的消息引起的）；精度里“发起但用户本来就会 exec”的算正确。样本少时别调。

调阈值的步骤：

1. 管理员调用 `GET /api/sandbox/prewarm/stats?days=30`，看 `sweep`。
2. 选精度可接受、召回尽量高的阈值：精度低说明空闲沙箱成本高（上调），召回低说明很多会话还是冷启动（下调）。
3. 在后台管理 › 沙箱改“触发阈值 %”，或 `PUT /api/sandbox/prewarm { threshold }`。
4. 想看是哪些特征在误报/漏报：
   ```sql
   -- 误报：发起了但没用上，按特征统计
   SELECT signals, COUNT(*) FROM tool_sandbox_prewarm_log WHERE fired = 1 AND used_at IS NULL GROUP BY signals ORDER BY 2 DESC;
   -- 漏报：低于阈值，但后来执行了
   SELECT signals, ROUND(AVG(score), 2), COUNT(*) FROM tool_sandbox_prewarm_log WHERE reason = 'below' AND used_at IS NOT NULL GROUP BY signals ORDER BY 3 DESC;
   ```
5. 改权重在 `intent.ts` 的特征表里；每个权重都有测试断言的行为，改完跑 `sandbox-intent.test.ts`。

## 7. 没有做 / 没有验证

- 没有对真实 E2B / Daytona / OpenSandbox 验证预热（本环境没有密钥；自托管 OpenSandbox 只跑了原有测试）。测试用的是带标注的假 provider，只证明 Workroom 自己的逻辑。
- 没有真实流量，阈值 0.3 是按用户要求的默认值 + 手写数据的扫描，不是用线上日志标定的。
- 意图打分是规则，不理解语义；不做语言之外的归一化（繁体、日语、韩语未覆盖）。
- 开发类模板、技能作为输入：代码里没有对应概念（见第 3 节），没做。
- R6 的 UI 面板不在本轮范围；统计只有接口。
