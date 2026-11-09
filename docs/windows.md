# 在 Windows 上运行 Workroom

> 验证状态（如实说明）：服务端路径翻译、Windows 可执行文件查找、LibreOffice/浏览器探测、`--mount` 引号规则有单元测试；**Docker 驱动的容器行为在 Linux 上的真实 Docker 守护进程里验证过**（隔离、限额、超时清理、服务模式、MCP 传输）。**尚未在真实的 Windows + Docker Desktop 机器上跑过**，因此“Windows 上的绑定挂载权限/性能”一节是依据 Docker Desktop 文档的预期，不是实测。首次在 Windows 上部署时请按末尾的“自检清单”走一遍。

## 1. 先决条件

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | **22.19 或更新**（建议 LTS 22.x） | 服务直接运行 TypeScript（Node 原生类型剥离），不需要编译步骤；低于 22.19 时 Node 无法直接运行 .ts 文件。<https://nodejs.org/>，安装时勾选 “Add to PATH” |
| Git | 可选 | 只有 `node scripts/backup.mjs`（源码备份）需要；从 zip 解压运行不需要 |
| Docker Desktop | **代码执行、终端、技能脚本、沙箱内 MCP 需要** | 没有它 Workroom 其余功能（对话、文件库、知识库、文件生成）照常工作，沙箱页显示“沙箱不可用”和启用方法 |
| Chrome 或 Edge | 可选（“浏览器”工具） | Windows 10/11 自带 Edge，不用另装 |
| LibreOffice | 可选（PPTX 缩略图预览） | 见第 7 节 |

Windows 没有 Linux 命名空间，所以**命名空间驱动在 Windows 上不可用**，Windows 上的沙箱就是 Docker 驱动。

## 2. 安装与启动（PowerShell）

```powershell
# 1) 取得源码：解压 workroom-src-*.zip 或 git clone，然后进入目录
cd C:\workroom

# 2) 安装依赖（精确按 package-lock.json；需要联网到 npm registry）
npm ci

# 3) 构建前端（生成 web\dist，服务会直接托管它）
npm run build:web

# 4) 配置并启动（数据目录请放在有足够空间、没有同步软件（OneDrive 等）的位置）
$env:WORKROOM_DATA_DIR = "D:\workroom-data"
$env:PORT = "8787"                       # 默认 8787，只监听 127.0.0.1
npm start
```

浏览器打开 <http://127.0.0.1:8787>，第一个注册的用户成为组织所有者。

- 要让局域网内其他电脑访问：`$env:HOST = "0.0.0.0"`，并放行 Windows 防火墙的该端口；对外使用请放在 HTTPS 反向代理后并设置 `WORKROOM_SECURE_COOKIES=1`。
- 要加密保存的模型/连接器凭据，设置 `WORKROOM_SECRET_KEY`（一串长随机字符；丢失后已保存的凭据无法解密）。
- 环境变量只对当前 PowerShell 窗口有效。长期运行请用“任务计划程序”（触发器：登录时/启动时，操作：`node.exe --disable-warning=ExperimentalWarning server\src\main.ts`，起始于 `C:\workroom`，在任务环境里设置上面的变量）或 NSSM 这类服务包装器。cmd.exe 写法：`set WORKROOM_DATA_DIR=D:\workroom-data`。

### 数据目录

`WORKROOM_DATA_DIR` 下的全部内容就是全部状态：`app.sqlite`（身份/目录/索引）、`blobs\`（文件内容）、`orgs\<组织>\spaces\<空间>\durable.sqlite`（对话）、`orgs\...\sandbox\c<对话>\`（沙箱工作区 /work）、`sandbox-mounts\`（技能等只读挂载的物化内容）。

- 备份：停服后复制整个目录；或在线备份见 `docs/operations.md`。源码备份：`node scripts\backup.mjs`（与 Linux 的 `scripts/backup.sh` 等价，产物在 `artifacts\backups\`）。
- 杀毒软件的实时扫描会拖慢 SQLite 与沙箱工作区；可把数据目录加入排除项。
- 路径含空格、中文、逗号都可以（已测试挂载引号规则）；不要放在网络驱动器或 OneDrive 同步目录里（SQLite WAL 不支持）。

## 3. 启用沙箱：Docker Desktop

1. 安装 Docker Desktop for Windows（<https://www.docker.com/products/docker-desktop/>），使用 **WSL 2 后端**；右下角托盘图标选择 **Linux containers**（不是 Windows containers）。启动并等到 “Engine running”。
2. 数据目录所在的盘要能被 Docker 共享：WSL 2 后端默认共享所有本地盘；若用 Hyper-V 后端，在 Settings → Resources → File sharing 里添加该盘。
3. 重启 Workroom（或在管理页“沙箱”点“重新检测”：`POST /api/sandbox/driver/detect`）。驱动设置为“自动”时，Windows 上会自动选择 Docker（命名空间不可用）。
4. **准备镜像**（首次一次性）。三选一：
   - 什么都不做：设置里 `autoPull` 默认开启，第一次运行代码时服务会自动 `docker pull` 两个公共镜像（`python:3.12-slim`、`node:22-slim`，已按摘要固定，约 200 MB），首次运行会多等一会儿。
   - 管理员在沙箱设置点“准备沙箱镜像”（`POST /api/sandbox/driver/prepare {"mode":"pull"}`）。
   - 终端预先拉取，或构建带数据分析库（numpy、pandas、matplotlib、openpyxl、python-docx、python-pptx、中文字体…，约 700 MB）的完整镜像：
     ```powershell
     docker pull python:3.12-slim
     docker pull node:22-slim
     node server\sandbox\build-image.mjs          # 构建 workroom/sandbox:1；国内网络可: $env:BUILD_ARGS="--build-arg PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple"
     ```
     存在 `workroom/sandbox:1` 时优先使用它。
5. 验证：登录后打开任意对话 → 工作面板 → “终端”，顶部显示当前驱动（“Docker 容器”）；让助手“运行一段 Python 代码”即可。也可 `GET /api/sandbox/driver` 查看每个驱动的状态与说明。

### Windows 上的路径与权限

- 工作区 `D:\workroom-data\orgs\...\sandbox\c7` 以 `--mount type=bind,source=D:\...,target=/work` 挂进容器；盘符大写、`\\?\` 前缀会被去掉、路径里的逗号/引号会按 Docker 的 CSV 规则加引号。如果 Workroom 本身运行在 WSL 或容器里而 Docker 在宿主上，用 `WORKROOM_SANDBOX_PATH_MAP="/容器内前缀=宿主前缀"` 做前缀映射。
- 容器以非 root 用户（uid 10001）运行；Docker Desktop 的文件共享层对绑定挂载的权限比较宽松，通常可直接写入。如果出现 “Permission denied” 写不进 /work，见排错表。
- 通过 Git Bash/MSYS 启动时已设置 `MSYS_NO_PATHCONV=1`，避免路径被改写。

## 4. 沙箱隔离范围（Docker 驱动，诚实说明）

隔离的：每次运行一个独立容器（独立进程/网络/文件系统命名空间 + cgroup 限额）；根文件系统只读；非 root；丢弃全部 capabilities + no-new-privileges；默认无网络；只有 /work 可写（/tmp 为内存盘）；内存 512 MB、CPU 1 核、进程数 64、单文件 64 MB、超时后容器被删除；技能等挂载只读。

不隔离/不保证的：容器与 Docker Desktop 的 Linux 虚拟机共享内核（容器逃逸类漏洞不在防护范围）；管理员开启“允许沙箱联网”后，容器能访问桥接网络（含局域网、云元数据地址）；没有磁盘配额（工作区总量是运行前检查的软配额）；Windows 上绑定挂载经过文件共享层，IO 比原生慢，权限位语义不同。能访问 Docker 的账号等同于拥有本机管理权限，请用专门账号运行 Workroom。

## 5. 其他功能在 Windows 上的状态

| 功能 | 状态 |
|---|---|
| 对话、文件库、知识库、文件生成（docx/xlsx/pptx/pdf）、MCP 远程连接器 | 纯 Node，Windows 可用（PDF 中文字体见下） |
| 代码执行/终端/文件树 | 需要 Docker Desktop（第 3 节）；文件树的浏览、上传、下载**不需要**沙箱驱动 |
| 浏览器工具 | `npm i playwright-core`（项目内）即可，使用系统 Edge/Chrome；或 `npm i -g playwright && npx playwright install chromium`。也可用 `WORKROOM_CHROME_PATH` 指定可执行文件。管理页能力表会显示“Chromium (Playwright)”或“系统浏览器 …”。 |
| PPTX 缩略图预览 | 目前服务端检测的是 `/usr/bin/soffice`，**Windows 上显示“未安装 LibreOffice”，回退为大纲预览**。已向文件组提了修改请求（`docs/requests/sandbox.md`）。 |
| PDF 中的中文 | 当前只搜索 Linux 字体路径；在 Windows 上可能回退为无中文字形。已提请求（同上）。 |
| 在线备份（`ops/backup`） | 请求中已指出清单路径分隔符问题；在修复前建议停服后复制数据目录。 |
| `npm test` | 脚本里的 glob 使用单引号，cmd/PowerShell 下不会展开；Windows 上运行单个测试：`node --disable-warning=ExperimentalWarning --test server\test\tools-sandbox-files.test.ts`。 |

## 6. 排错

| 现象 | 原因与处理 |
|---|---|
| 终端提示“沙箱不可用：Docker Desktop 没有运行” | 启动 Docker Desktop，等待 Engine running，点“重新检测” |
| “未找到 docker 命令” | Docker Desktop 未安装，或服务由没有 PATH 的服务账号启动；设置 `WORKROOM_DOCKER_BIN=C:\Program Files\Docker\Docker\resources\bin\docker.exe` |
| “Docker 处于 Windows 容器模式” | 托盘图标 → Switch to Linux containers |
| “Docker 可用，但沙箱镜像尚未准备” | 第 3 节第 4 步；若拉取失败检查代理（Docker Desktop → Settings → Resources → Proxies）与镜像站设置 |
| 运行报 `Permission denied` 写 /work | 数据目录所在盘没有共享给 Docker（Hyper-V 后端），或目录在 OneDrive/网络盘；换到本地普通目录。仍不行请把 `GET /api/sandbox/driver` 的诊断信息和 Docker Desktop 版本反馈（这是未在真实 Windows 上验证的部分） |
| 运行报 `invalid mount config` / `includes invalid characters` | 数据目录路径里有双引号或换行；改用普通路径 |
| 第一次运行很慢 | 在拉取镜像；之后每次容器启动约 1–2 秒 |
| 运行被 `killed`，stderr 写“超过内存限制” | 脚本用了超过 512 MB；让助手分块处理，或管理员提高限额（见 `server/src/tools/sandbox.ts` `DEFAULT_LIMITS`） |
| 管理页看不到沙箱设置 | 需要组织所有者/管理员，或拥有 `sandbox.policy.manage` 权限的角色 |
| 重启服务后残留容器 | 启动时会按标签 `workroom.sandbox=1`（只限本数据目录）自动清理；也可手动 `docker ps -a --filter label=workroom.sandbox=1` |
| 启动时报无法识别/不支持 .ts | Node 版本低于 22.19，升级 Node |
| 端口被占用 | 改 `PORT`；`netstat -ano | findstr :8787` 查占用进程 |
| 浏览器工具“找不到可用的浏览器” | 安装 Chrome/Edge 或设置 `WORKROOM_CHROME_PATH`，并确认项目里有 `playwright-core` |

## 7. LibreOffice（PPTX 预览）

`server/src/tools/sandbox/paths.ts` 的 `findSoffice()` 已实现 Windows/macOS/Linux 的探测（`WORKROOM_SOFFICE` → `C:\Program Files\LibreOffice\program\soffice.exe` 等 → PATH）。调用它的是文件组的 `files/slides.ts`，需要他们按请求接入后才生效；接入后在 Windows 上还需要决定是否允许在主机上直接运行 soffice（无沙箱，`runHost()` 提供了超时+杀进程树的外壳，但不是隔离）。

## 8. 首次部署自检清单

1. `node -v` ≥ 22.19；`npm ci`、`npm run build:web` 成功。
2. `npm start` 后 <http://127.0.0.1:8787/api/health> 返回 ok，页面能打开并注册。
3. `docker version` 能同时显示 Client 与 Server（Server OS/Arch: linux）。
4. 管理员调用 `GET /api/sandbox/driver`：`effective` 应为 `docker`，`drivers[1].state` 为 `ready`。
5. 让助手运行 `print(open('/work/x','w').write('hi'))`，在“文件”标签里看到 `x`；删除它。
6. 重启服务，确认 `docker ps -a` 没有残留的 `wr-*` 容器。
7. 如有问题，把 `GET /api/sandbox/driver` 的 `drivers[].details` 与 Docker Desktop 版本一起反馈。
