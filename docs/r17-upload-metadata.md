# R17：上传附件的元数据注入

## 现象
用户上传「对公客户贷款及征信信息表.xlsx」让 agent 分析，agent 先猜 `/uploads/对公客户贷款及征信信息表.xlsx` → `not_found`，再 `ls /uploads`、`ls /uploads/m762` 才找到文件，多走了几步，后续还失败。

## 根因
`RuntimeService.composeContent()` 只给模型写 `[附件] name (fileId=…, versionId=…)`。附件在虚拟文件系统里的真实位置是 `/uploads/m<entryId>/<name>`（`vfs/backends/uploads.ts`），而 `entryId` 要等消息条目写入后才有，拼文本时还不知道；大小、类型也没有给。

## 做法
1. **提交前就能确定的稳定路径**：`/uploads/<versionId>/<name>`（`uploadAliasPath()`）。`UploadsBackend` 在原有 `m<entryId>/<name>` 之外，同时按 versionId 解析这条别名，`stat / ls / read / copy_to_work` 都能用。原有路径与同消息同名附件的去重规则（`<fileId>-<name>`）不变，旧会话不受影响；别名按版本寻址，同名不同版本不会混淆。回显的节点路径就是被请求的那条路径。
2. **`composeContent` 改为异步**，每个附件一行：`路径 · 人类可读大小（字节数）· MIME`；xlsx 额外列出工作表名（只读 zip 里的 `xl/workbook.xml`，不解析单元格，超过 25 MB 不读）。MIME 对 `application/octet-stream` 按扩展名推断。
3. **权限**：ids 来自客户端，所以只给发送者有读权限、且 fileId 与 versionId 匹配的文件写元数据；否则退回只有名称和 ids 的一行，不泄露大小、类型、工作表名。
4. **所有调用点**：`submit`、`promote`（立即发送/steer，使用点击人的 principal）、`reconcilePromoteIntents`（启动恢复，按记录的 userId/orgId 取 principal）都走同一个函数；`followUp`/`steer` 路由最终也经 `submit`。
5. **提示与错误**：harness 的“文件与执行”段和 `copy_to_work` 描述指向消息里的 `[附件]` 行，并说明附件在 `/uploads/<目录>/` 下而不是 `/uploads/` 根。`/uploads` 下 `read / ls / copy_to_work` 的 `not_found` 会追加提示：同名文件的真实路径（`/uploads/m<id>/<name>`），或没有同名文件时列出本会话的附件名。其他目录不加提示（`VfsBackend.suggest` 可选钩子，`VfsRouter.hint`）。

示例（模型看到的消息）：
```
分析一下

[附件] 1 个，路径可直接用于 read / copy_to_work（路径之外不要猜）：
- /uploads/fv_…/对公客户贷款及征信信息表.xlsx · 38.2 KB（39104 字节） · application/vnd.openxmlformats-officedocument.spreadsheetml.sheet · 工作表：贷款明细、征信 (fileId=file_…, versionId=fv_…)
```

## 测试
`server/test/r17-upload-meta.test.ts`：注入文本含路径/大小/类型/工作表；无权限与伪造 ids 不泄露；注入的路径经真实运行时的 `read`/`ls`/`copy_to_work` 可读，同名附件各指各的版本，旧的 `m<id>` 路径仍可用，写入仍只读；猜错路径的 `not_found` 带正确路径；steer 路径同样注入。修复前后对比：修复前 3 项失败，修复后全部通过。

## 未覆盖
- 真实模型是否因此少走弯路（无模型凭据，只验证了注入内容和路径可用）。
- 老会话里已经存在的历史消息不会补写元数据（它们的文本是当时落盘的）。
- csv 的行数、列名等内容级信息没有注入（需要读内容，代价高）；模型用 `read` 即可。
