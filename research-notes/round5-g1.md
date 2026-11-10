# Round 5 · UI 组 1（首页 / 输入框 / 附件 / 模型菜单 / 共享控件）调研与问题清单

范围：`web/src/pages/HomePage.tsx`、`web/src/features/composer/**`、`features/chat/pickers.tsx`、`components/ui/**`、`components/file/**`、`DotMatrix.tsx`。
只读克隆在 `/home/user/research/{prompt-kit,ai-elements,impeccable}`（`--depth 1`，未执行其中任何脚本，未安装任何依赖）。

## 1. 调研

| 项目 | 适用性 | 许可 | 维护 | 依赖 | 采纳 | 不采纳 |
|---|---|---|---|---|---|---|
| **prompt-kit**（ibelick） | 高：shadcn 风格的 prompt-input / file-upload / suggestion，与我们栈一致（React + Tailwind + Radix） | MIT | 活跃（2026-09 最近提交，v0.1.0，以“复制组件”方式分发） | Next.js 文档站；组件本身只需 radix tooltip + cva | ① 点击整个输入框聚焦文本框；② 拖拽用 `dragenter/leave` 计数器 + 全页覆盖层（我们早已有，核对后保持）；③ 建议按钮只“填入”文本不直接发送；④ 输入框 `maxHeight` 自增长 | 不引入包：它的 PromptInput 是 compound components + Context，会重写我们已通过 e2e 的 IME / 斜杠 / 粘贴逻辑；`rounded-3xl` 圆角与规范（rounded-xl/2xl）不符 |
| **vercel/ai-elements** | 中：Prompt Input（附件、模型选择、`accept/maxFiles/maxFileSize` 错误码）值得借鉴 | Apache-2.0 | 活跃（2026-10 发版 #521） | 重：`ai`（AI SDK）、streamdown、xyflow、motion、shiki、rive 等——**明确不拉入** | ① 错误分类思想：`max_files / max_file_size / accept` 三类错误并给出明确提示（我们对应：超过 10 个 → 提示、超过 100 MB → 卡片报错且不给重试）；② `globalDrop` 为“显式选择加入”（我们按 `dropScope` 限定在页面容器内）；③ 附件缩略图 + 类型图标 + 可移除的卡片布局 | ModelSelector 基于 cmdk `Command` 对话框，带搜索；我们模型数量少且要“浮层不遮挡标题”，用 Radix DropdownMenu 的碰撞处理更合适；`ai` SDK 依赖不引入 |
| **impeccable**（pbakaus） | 方法论高：不安装、不运行；只读 `skill/reference/{critique,harden,clarify,adapt}.md` 的评审清单 | Apache-2.0 | 非常活跃（v4.8.2，2026-11-10 提交）；CLI 需 Node ≥22 | 无需（我们不安装） | 用作自查清单：① Nielsen 十项启发式 + “可见选项 > 4 个就要拆分”的认知负荷规则 → 首页只留 3 个起步建议、菜单一行一项；② harden：超长文件名、错误态、空态、无网络、窄屏溢出 → 对应 e2e；③ “AI slop”常见症状（每个标题上方一个圆角图标块、灰字叠色底）→ 避免；④ audit 按 P0–P3 排序 → 下面的问题表采用同样的优先级 | 不使用其 `npx impeccable install`、live 模式（会以 bypass 权限调用外部 agent CLI）和 hook；不采用其“更大胆”的视觉建议（与我们“克制、中性”的规范冲突） |

结论：**不新增任何依赖**。采纳的是行为与检查方法，不是代码。

## 2. 改造前问题清单（P0 阻塞 → P3 打磨）

截图：`artifacts/screenshots/round5/before/g1-{1440,1366,390}-*.png`

| 级别 | 问题 | 证据 / 位置 | 处理 |
|---|---|---|---|
| P0 | 首页模型菜单固定向上展开，盖住问候语和输入框；菜单没有“可用高度”上限，矮窗口会顶到标题栏下面 | `before/g1-1440-model-menu.png`；`ModelSwitcher` 固定 `side="top"`，`MenuContent` 无 collisionPadding | `MenuContent/PopoverContent` 统一 `collisionPadding.top=64`（顶栏高度 56 + 间距）并设 `max-h: var(--radix-*-available-height)`，超出滚动；首页 `side="bottom"`，聊天页 `side="top"` 并翻转 |
| P0 | `Button variant="danger"` 深色下白字 + 浅红 = 2.7:1（AA 不过）。G3 请求 | `button.tsx` | 改为 `bg-danger text-accent-fg`（浅色 5.5:1，深色 6.6:1）；e2e 计算对比度 |
| P0 | 菜单里的“思考强度”是普通按钮，Radix 菜单吞掉 Tab，键盘无法到达 | `ThinkingRow` | 桌面改为 `menuitemradio`（上下/左右/End 可达，Enter 选择）；手机底部弹层保持 radiogroup |
| P1 | `Dialog / Sheet / BottomSheet` 关闭后不把焦点还给打开者（受控、无 Trigger 的弹窗焦点丢到 body）。G4 请求 | `overlay.tsx` | `useFocusRestore`：打开时记下 `document.activeElement`，关闭时若仍在 DOM 则聚焦；选择器弹窗关闭且焦点丢失时回到输入框 |
| P1 | 390 宽下附件区横向滚动，卡片被截成“封面.p…”；上传失败原因被截成一行；失败卡片在 150px 滚动区里被切掉一半 | `before/g1-390-attachments.png`、`g1-1440-upload-error.png` | 卡片在手机上整行显示、自动换行；列表 `max-h 184` 垂直滚动并滚到最新/失败项；失败原因最多两行；文件名尾部（扩展名）不再压到“移除”按钮 |
| P1 | 触控目标：+ 和发送 32px，模型 chip 32px | 390 截图 | 手机 40px（+、发送，圆形）/ 36px（模型），桌面 36/32；e2e 断言 |
| P1 | 对用户暴露内部词：菜单分组“测试模型（Fixture）”、“可勾选“无需密钥”用于本地服务”、`未连接 … 需要：GET /api/files（D 组）`、“服务端尚未提供该功能的接口” | `ModelSwitcher`、`pickers`、`Unavailable` | 分组改“测试”；阻塞原因只留第一句（“不可用：未配置密钥”）；`Unavailable` 改“{功能}暂不可用”，缺失接口收进“技术详情”折叠 / title |
| P2 | 解释性副标题过多：首页 tagline、+ 菜单每项一行说明、斜杠菜单每项说明、三个选择弹窗的 description、拖拽覆盖层“文件会随你的第一条消息…” | 各文件 | 首页只留问候 + 输入框 + 3 个起步建议；+ 菜单只保留一条“也可拖入文件或粘贴图片”；斜杠菜单/技能/文件库弹窗去掉说明；拖拽覆盖层改为真实限制“最多 10 个，每个不超过 100 MB”；保留知识库“只有可检索的资料会参与回答”（影响结果的决策信息） |
| P2 | 能力徽标是带文字的小药丸（图片/工具/推理 + “128K 上下文”），行很高 | `before/g1-1440-model-menu.png` | 改为 24px 图标，tooltip 用人话（“能看图片 / 能使用工具 / 擅长复杂推理（可调思考强度：…）”），上下文长度只显示 “128K” 并带 tooltip；一行名称 + 一行描述 |
| P2 | 字号混乱：11 / 11.5 / 12 / 13 / 15 px 任意值 | composer、file、ui | 统一到 `text-xs`(12) / `text-sm`(14) / `text-base`(16)；无 <12px |
| P2 | 发送按钮禁用时没有原因；运行中发送/停止两个按钮同权重 | `Composer` | 禁用原因进 tooltip（“输入内容后发送 / 文件上传完成后才能发送 / 有文件上传失败：请重试或移除”）；运行中无输入 → 停止为主按钮（实心），有输入 → 发送（插话）为主、停止为次 |
| P2 | 模型列表加载中 / 失败 / 为空时整块消失，用户不知道发生了什么 | `Composer` | 骨架 → “模型列表加载失败” / “暂无可用模型” |
| P2 | 斜杠菜单在首页同样向上盖住问候语 | `Composer` | 首页向下展开；加 `aria-activedescendant` |
| P3 | 选择器弹窗无空状态说明；文件行只有同一个图标 | `pickers` | 空状态给出下一步；文件行用类型图标 |
| P3 | 弹窗关闭按钮 28px、无焦点环；弹窗在矮屏会超出视口 | `overlay.tsx` | 32px + `focus-visible` 环；`max-h: calc(100dvh - 32px)` 内部滚动 |

已满足、保持不变：点阵背景（两侧画布、30fps、隐藏/离屏零 rAF、减少动效静态、设置页开关）；浮层 `bg-surface` + 边框 + `shadow-pop`；动画仅 opacity/transform，结束完全不透明（`wr-fade-in` 带 `both` 填充，e2e 读取计算样式验证）。

## 3. 对其他组 / 集成者的影响

- `Unavailable` 文案改变（“未连接” → “暂不可用”），`data-testid="unavailable"` 不变；`Loadable` 的 `need` 参数现在显示在“技术详情”折叠里。
- `Menu*`/`Popover*` 默认带 collisionPadding 与 `max-h`；`Dialog` 默认 `max-h` 并滚动；`Dialog/Sheet/BottomSheet` 关闭后恢复焦点；`Button` 的 `sm` 为 14px。API 向后兼容；新增导出 `MenuRadioGroup / MenuRadioItem`。
- `Button variant="danger"` 已自带深色文字，G3 在三个按钮上的 `dark:text-[#2a0c09]` 覆盖可删除（无害）。
