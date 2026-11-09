# Workroom 沙箱镜像

`Dockerfile` 构建 `workroom/sandbox:1`：python3.12 + node22 + numpy/pandas/scipy/matplotlib/openpyxl/python-docx/python-pptx/pypdf/pillow/… + 中文字体（约 700 MB）。基础镜像按摘要固定。

```bash
docker build -t workroom/sandbox:1 server/sandbox        # 或: node server/sandbox/build-image.mjs
# 国内/企业代理: docker build --build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple -t workroom/sandbox:1 server/sandbox
```

没有这个镜像时，Docker 驱动回退到公共 slim 镜像（`python:3.12-slim`、`node:22-slim`，同样按摘要固定，见 `server/src/tools/sandbox/docker.ts`），并在首次运行时自动 `docker pull`（可用 `WORKROOM_SANDBOX_AUTOPULL=0` 或管理设置关闭）。回退镜像只有标准库，没有 pandas 等库；需要数据分析库请构建完整镜像。

升级基础镜像：`docker pull` 新标签 → 把新摘要写进 Dockerfile 与 `docker.ts` → 重建并把镜像标签加一（`workroom/sandbox:2`，同时改 `DEFAULT_IMAGE`）。

容器如何启动、隔离了什么：`docs/files-tools.md` “沙箱”一节。Windows：`docs/windows.md`。
