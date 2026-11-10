# Round 5 · G1 对其他组 / 集成者的请求

1. **集成者（`web/e2e/run.mjs`）**：把 `round5-g1.mjs` 加入脚本列表（端口 8872，`npm run -w web build` 之后运行；54 项检查，约 1.5 分钟）。
2. **集成者（`docs/ui.md`、`docs/design-guidelines.md`）**：
   - 首页现在是“问候 + 输入框 + 3 个起步建议”，不再显示 `brand.tagline` 副标题（`/api/health` 的 `brand.tagline` 仍存在，首页不用）。
   - `Unavailable` 的文案从“{功能}：未连接 / 需要：GET …”改为“{功能}暂不可用”，缺失接口收进“技术详情”折叠；`Loadable` 的 `need` 只在该折叠内出现。
   - 共享浮层规则已落到 `components/ui/overlay.tsx`：Menu/Popover 带 `collisionPadding.top=64` 与 `max-h: var(--radix-*-available-height)`；Dialog/Sheet/BottomSheet 关闭后恢复焦点；`MenuRadioGroup/MenuRadioItem` 供菜单内的单选（键盘可达）。
3. **G3**：`variant="danger"` 已在组件内用 `text-accent-fg`（浅色 5.5:1、深色 6.6:1）；三处 `dark:text-[#2a0c09]` 覆盖可删除（保留也无害）。
4. **G2（ChatPage）**：`Composer` 在聊天页的 `variant="chat"` 下菜单向上展开；运行中“插话 / 稍后处理”分段控件在手机宽度下独占一行；运行中无输入时“停止”为主按钮（`data-testid="stop"` 仅在运行中存在，不变）。输入框新增 `data-testid="composer-error"`（上传失败/超出数量的提示）。
5. **其他**：`web/src/features/assistants/Assistants.tsx` 的 `AssistantPicker`（输入框 `tools` 插槽）在 390 宽度下建议只显示图标（不在 G1 路径内，未改动）。
