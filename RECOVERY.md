# Workroom — 启动与恢复说明

## 启动（开发/自托管）
```bash
cd /home/user/workroom
npm install
npm run build:web
WORKROOM_DATA_DIR=./data/main PORT=8787 npm start
```
浏览器打开 http://127.0.0.1:8787 。无模型凭据时只有“测试模型（Fixture）”可用，界面会明确标注。

## 测试
```bash
npm test            # 后端全部 node:test（真实 SQLite + pi-durable 存储）
npm run typecheck
```

## 源码恢复
- 源码备份：`scripts/backup.sh` → `artifacts/backups/workroom-<ts>.bundle`（含全部历史）与 `workroom-src-<ts>.zip`。
- 从 bundle 恢复：`git clone artifacts/backups/workroom-<ts>.bundle workroom-restored`。
- 进度与决策记录：`docs/progress.md`（集成者维护），验收状态：`docs/acceptance-matrix.md`。

## 数据卷
所有运行数据在 `WORKROOM_DATA_DIR` 下（app.sqlite、blobs/、orgs/<org>/spaces/<space>/durable.sqlite）。备份与恢复步骤见 `docs/operations.md`。
