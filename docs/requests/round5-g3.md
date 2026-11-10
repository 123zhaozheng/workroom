# Round 5 · G3 对其他组/集成者的请求（后端无需改动）

1. **G1（`web/src/components/ui/button.tsx`）**：`variant="danger"` 在深色主题下是白字 + `--danger`（#f07a70），对比度约 2.7:1，不满足 WCAG AA。G3 在自己的按钮上临时加了 `dark:text-[#2a0c09]`（确认对话框、成员详情、审核）。建议在基础组件里统一处理（深色下用深色文字，或用 `--accent-fg` 类 token），之后可以删掉这些 className。
2. **集成者（`web/e2e/run.mjs`）**：已把 `round5-g3.mjs` 加入脚本列表（与 G2 的 `round5-g2.mjs` 在同一行，提交时请一起带上）。
3. **设置页的“助手”区块（`web/src/features/assistants/Assistants.tsx`，非 G3 所属）**：标题仍是 `text-[13px] text-fg-muted`，其余设置区块是 `text-sm font-medium text-fg-muted`；有空时对齐。
4. **`web/src/components/ui/input.tsx` 的 `Select`**：没有自己的 `focus-visible` 环，依赖全局 `:focus-visible`，可用；若要与 `Input` 一致可补 `focus-visible:outline-2 focus-visible:outline-ring`。
