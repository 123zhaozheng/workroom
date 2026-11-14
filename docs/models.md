# 模型服务商配置（运维手册）

适用范围：Workroom 第 4 轮起的模型配置。代码：`server/src/ops/gateway.ts`、`server/src/ops/models-*.ts`；管理界面：管理 → “模型与渠道”。

**诚实声明**：本仓库的测试只使用进程内启动的本地 mock 上游（OpenAI 兼容 Chat Completions 与 Anthropic Messages，含 SSE 流式、`/models`、工具调用）。**没有对 OpenAI、Anthropic、DeepSeek、通义、Kimi、智谱、OpenRouter、硅基流动、Azure 等任何真实第三方服务做过验证**（这里没有它们的凭据）。下文各厂商的 Base URL 与注意事项来自 pi-ai 的内置目录与厂商公开文档，首次接入请先用“测试连接”核对，并以厂商当前文档为准。

## 1. 设计：直接使用 pi-ai 的模型体系

不再有自造的“渠道/路由/平台模型”三层。每个**模型服务商**就是一个真正的 pi-ai Provider：

- 用 `createProvider({ id, name, baseUrl, headers, auth, models, fetchModels, api })` 构建，用 `setProvider()` 注册到运行内核使用的**唯一一个** `MutableModels`（`gateway.piModels()`）。
- 会话保存 pi-durable 的原生引用 `{ provider: <服务商 id>, modelId }`，不再有 `workroom` 之类的中间模型。
- 密钥加密存放在 app 库（AES-256-GCM，`WORKROOM_SECRET_KEY`），通过 DB 版 `CredentialStore`（`models-store.ts`）交给 pi-ai；`fetchModels()` 取回的目录通过 DB 版 `ModelsStore` 持久化（表 `model_catalog`），重启后无需联网即可恢复。
- pi-ai 看不到进程环境变量（`authContext` 为空），所以开发机上的 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 永远不会被误用。

pi-ai 不做、Workroom 在其之上加的一薄层：组织内可见范围（部门/成员）、组织默认模型、个人自带密钥、用量归属（`ops_route_attempts` → 用量账本）、故障切换（包裹原生 provider 的 stream，不合成模型）。

## 2. 三步上手

1. 管理 → 模型与渠道 → **添加服务商**：选“快速选择”（或自选类型），填名称、Base URL、API Key → 保存。
2. 点 **测试连接**（真实请求：`GET /models` + 一次极小的对话，不计入用量）→ 点 **获取模型列表**。
3. 在模型表里勾选“对成员开放”（或“启用全部对话模型”）。需要时点编辑调整上下文长度、价格、思考档位、`compat`，并设置可见范围。

从厂商获取的模型默认**不开放**（OpenAI 的列表里有向量、语音、绘图模型，OpenRouter 有近 400 个）。

## 3. 选哪种类型、Base URL 怎么写

| 类型 | 请求地址（SDK 追加） | 获取列表 | 适用 |
|---|---|---|---|
| `openai-completions`（OpenAI 兼容 · Chat Completions） | `{baseUrl}/chat/completions` | `GET {baseUrl}/models` | 绝大多数第三方与自建服务 |
| `openai-responses`（OpenAI Responses） | `{baseUrl}/responses` | `GET {baseUrl}/models` | OpenAI 官方；少数实现了 Responses 的网关 |
| `anthropic-messages`（Claude 兼容 · Messages） | `{baseUrl}/v1/messages?beta=true` | `GET {baseUrl}/v1/models` | Anthropic 官方、Claude 兼容中转 |
| `builtin`（pi-ai 内置） | pi-ai 自带 | pi-ai 自带 | Azure OpenAI、Amazon Bedrock、Google、Mistral 等；**每个部署只能配一个实例**，不能做个人密钥 |

**Base URL 规则**

- OpenAI 类：按厂商文档原样填，**通常以 `/v1` 结尾**（OpenAI、Ollama、vLLM、LM Studio、OpenRouter、Moonshot、硅基流动）；例外：DeepSeek 可不带 `/v1`，智谱是 `/api/paas/v4`，百炼是 `/compatible-mode/v1`。系统只去掉结尾的 `/`。
- Claude 类：**不要带 `/v1`**（SDK 自己追加 `/v1/messages`）。填了会被自动去掉，界面会显示最终请求地址。
- 判断是否填对：界面“对话请求”一行就是最终地址；列表接口返回的不是 JSON（多半是少了 `/v1` 或指到了网页）时，错误里会写明。
- Claude 兼容中转必须支持 `/v1/messages?beta=true`（pi-ai 使用 Anthropic SDK 的 beta 通道），多数中转支持；若报 404，换成同一中转的 OpenAI 兼容地址并选 `openai-completions`。

**鉴权方式**（高级选项）：默认 OpenAI 发 `Authorization: Bearer`，Claude 发 `x-api-key`。部分 Claude 中转只认 `Authorization: Bearer`，选 `bearer`；Azure 风格网关用 `api-key`。

## 4. 各厂商示例

所有例子在界面中都有“快速选择”预设（Base URL 已预填，**仍需自己核对**）。

### 4.1 Anthropic 官方
类型 `anthropic-messages`；Base URL `https://api.anthropic.com`；密钥 `sk-ant-…`。获取列表后，pi-ai 目录里已有的 Claude 模型会自动带上上下文长度、价格、思考档位与 `compat`。

### 4.2 Claude 兼容中转站
类型 `anthropic-messages`；Base URL = 中转站给的地址（不带 `/v1`）；密钥 = 中转站的 key。若中转要求 `Authorization: Bearer`，鉴权方式选 `bearer`。模型 id 以中转站为准（常与官方同名，则目录元数据同样自动匹配）。

### 4.3 OpenAI 官方
类型 `openai-responses`；Base URL `https://api.openai.com/v1`。若只想用 Chat Completions 也可选 `openai-completions`。

### 4.4 OpenAI 兼容（国内常见）
统一选 `openai-completions`：

| 厂商 | Base URL | 说明 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | pi-ai 内置识别 DeepSeek 的 compat（思考参数、`max_tokens` 字段）；`deepseek-reasoner` 是推理模型 |
| 通义千问 / 百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1`（国际站 `dashscope-intl…`） | 深度思考模型需在模型上设 `compat.thinkingFormat = "qwen"` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1`（国际站 `api.moonshot.ai/v1`） | pi-ai 内置识别 |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 版本路径是 `/v4`；思考参数用 `compat.thinkingFormat = "zai"` |
| OpenRouter | `https://openrouter.ai/api/v1` | 获取列表自带价格与上下文长度；id 形如 `anthropic/claude-…`（含 `/`，API 路径里请 URL 编码） |
| 硅基流动 | `https://api.siliconflow.cn/v1` | id 形如 `Qwen/Qwen3-…`；列表不含上下文长度，需手动核对 |
| 本地 Ollama | `http://localhost:11434/v1` | 勾“无需密钥”；建议 `compat.supportsDeveloperRole=false`、`supportsReasoningEffort=false` |
| 本地 vLLM | `http://localhost:8000/v1` | 启动带 `--api-key` 时不要勾“无需密钥”；工具调用需 `--enable-auto-tool-choice --tool-call-parser …` |
| LM Studio | `http://localhost:1234/v1` | 勾“无需密钥” |

管理员可指向本机/内网地址；**个人服务商**不允许（SSRF 防护）。Workroom 跑在容器里时，宿主机用 `host.docker.internal`。

### 4.5 Azure OpenAI
pi-ai 内置 `azure` provider（Azure OpenAI Responses）：类型选“pi-ai 内置”→ `azure`，API Key 填密钥，“额外配置”填 `AZURE_OPENAI_BASE_URL`（形如 `https://{资源}.openai.azure.com`，根地址会被规范化到 `/openai/v1`）或 `AZURE_OPENAI_RESOURCE_NAME`，可选 `AZURE_OPENAI_API_VERSION`、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。**未经真实验证**；每个部署只能有一个 `azure` 实例。

## 5. 常见坑

- **工具调用（tool calls）**：Agent 每次请求都带工具定义。不支持工具的模型会报 400 或乱答：在模型上取消“支持工具调用”只会做标记与故障切换筛选，**不会剥离工具**，应改用支持工具的模型。vLLM 需要上面的启动参数；Ollama 需模型本身支持 tools。
- **developer 角色**：pi-ai 对推理模型默认把系统提示以 `developer` 角色发送。Ollama/vLLM/SGLang 等常不认，出现 400 时设 `compat.supportsDeveloperRole=false`（必要时再设 `supportsReasoningEffort=false`）。
- **`max_tokens` 字段名**：新版 OpenAI 用 `max_completion_tokens`，很多兼容端只认 `max_tokens`：设 `compat.maxTokensField = "max_tokens"`。
- **流式用量**：个别端点不返回流式 usage：设 `compat.supportsUsageInStreaming=false`，用量会偏低/为 0。
- **思考参数**：各家不同。`compat.thinkingFormat` 取值 `openai | openrouter | deepseek | together | baseten | zai | qwen | chat-template | qwen-chat-template | string-thinking | ant-ling`。再用“思考档位”勾选哪些档位可用（未勾选的档位 = `thinkingLevelMap` 里为 `null`，界面不会提供）。
- **价格**：列表接口通常没有价格；为空则用量费用为 0（`cost_source = unpriced`）。自己填“美元/百万 Token”。
- **上下文长度**：列表接口缺失时用 pi-ai 目录值或默认 128K/8K，**请核对**，否则会过早/过晚触发压缩。
- **Anthropic 中转 404**：见 §3，必须支持 `?beta=true`。
- **密钥**：直接填写需要服务端设置 `WORKROOM_SECRET_KEY`，否则 409；也可引用环境变量名（只能 `WORKROOM_` 开头，防止读取进程里别的密钥）。

## 6. 模型字段（手动添加 / 覆盖目录值）

`id`（发给厂商的 model 参数）、`name`、`contextWindow`、`maxTokens`、`input`（`text`、`image`）、`reasoning`、`thinkingLevelMap`、`cost`（`input/output/cacheRead/cacheWrite`，美元/百万 Token）、`tools`、`compat`（用 pi-ai 自己的 schema 校验，未知键或类型错误直接拒绝）。对目录模型的修改保存为**覆盖项**，可“恢复目录默认值”。

## 7. 可见范围、默认模型、故障切换、预算

- **可见范围**：每个模型可限定部门、成员（`visibility.departmentIds/userIds`，项目 `projectIds` 仅 API）。管理员（`model.manage`）看全部。限制不只影响选择器：网关在**每次请求**时用当前权限复核，已有会话里的模型一旦对该用户不可见，请求会以 `model_not_allowed` 失败且不会到达上游。
- **权限**：`model.provider.manage` = 服务商与密钥；`model.manage` = 模型开关/可见范围/默认模型；`model.use` = 使用模型。没有 RBAC 服务时退化为组织 owner/admin。
- **默认模型**：组织设置（`PUT /api/admin/model-settings {defaultModel}`）；配置文件的 `defaultModel` 作为实例级兜底。
- **故障切换**：模型的 `fallbacks`（最多 5 个，可跨服务商）。主模型在**尚未输出任何内容**且错误可重试（429/529/5xx/超时/网络/鉴权）时按序尝试备用；已开始输出或 400 类错误不切换。最终消息的 `provider/model` 是真正应答的模型，`usage` 为所有实际调用之和。备用模型须满足图片需求。每次尝试写入 `ops_route_attempts`（会话“模型与路由记录”可查）。
- **本地限流与熔断**（`models-limits.ts`，包裹原生 stream，与故障切换同一层）：服务商可设每分钟请求数（RPM，滑动 60 秒）、最大并发、熔断阈值/时长（默认连续 3 次基础设施失败——5xx/网络/超时/过载/鉴权——熔断 30 秒；阈值 0 关闭）；单个模型还可再设 RPM/并发。熔断到期后**半开**：只放行一个探测请求，成功即关闭，失败则重新熔断；其它请求在探测期间被跳过。400 类错误说明上游在应答，不计失败；测试连接不计入。可在管理页点“重置熔断”。测试模型（fixture）没有服务商行，不受限、不熔断。
  命中限制时：先**跳过**并尝试该模型的备用模型（每次跳过都记入 `ops_route_attempts`，`status=skipped`，`error_class` 为 `local_rate_limit` / `concurrency` / `circuit_open`）；没有可用备用时**拒绝**——请求不会发往上游，助手消息报错 `local_rate_limit: …` / `concurrency: …` / `circuit_open: …`（错误文字含 “rate limit / too many requests / service unavailable”，pi-ai 判为可重试，pi-durable 按退避重试，效果等同排队）。
- **预算/用量**：照旧（见 `docs/ops.md` §3），平台模型 id 现为 `<服务商 id>/<modelId>`。

## 8. 个人自带密钥（M15）

管理员在“模型与渠道”打开“允许成员自带密钥”。成员在设置页（`<PersonalProviders />`）添加自己的服务商：仅本人可见、可用、可编辑；管理员也看不到。限制：只能是三种通用类型；不能引用服务器环境变量；Base URL 须解析到公网地址：创建时检查，每次请求前再检查，并且获取列表、测试连接、对话请求都通过 `tools/netpolicy.ts` 的 `pinnedFetch` 发出（只连接刚校验过的 IP，TLS 仍按域名校验，不跟随重定向），所以不存在 DNS 重绑定窗口；组织的网络访问策略（管理后台 › 角色与权限 › 网络访问，见 `docs/files-tools.md`）同样适用——阻止名单、仅名单模式、内网例外按服务商所属组织生效；运维环境变量 `WORKROOM_URL_ALLOWLIST`（host 或 host:port）仍可放行特定内网名，与内网例外合并；别人继续你的个人密钥会话（例如共享项目）会被拒绝，不会消耗你的密钥；策略关闭后个人模型立即失效。

## 9. 配置文件 `workroom.models.json`

位置（先到先得）：环境变量 `WORKROOM_MODELS_CONFIG` → `<数据目录>/workroom.models.json` → 当前目录。每次启动读取，文件里的服务商是**实例级、只读、以文件为准**（从文件删除即在下次启动移除）。类似 pi 的 `models.json`，但**密钥只能写环境变量名**：

```json
{
  "providers": {
    "deepseek": {
      "name": "DeepSeek",
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "headers": { "X-Team": { "env": "WORKROOM_TEAM_HEADER" } },
      "models": [
        { "id": "deepseek-chat", "name": "DeepSeek V3", "contextWindow": 128000, "maxTokens": 8192,
          "cost": { "input": 0.27, "output": 1.1, "cacheRead": 0.07, "cacheWrite": 0 }, "compat": { "maxTokensField": "max_tokens" } }
      ]
    },
    "claude-relay": { "name": "Claude 中转", "type": "anthropic-messages", "baseUrl": "https://relay.example.com",
      "apiKeyEnv": "RELAY_KEY", "authStyle": "bearer", "models": [{ "id": "claude-sonnet-5-5", "name": "Claude Sonnet" }] },
    "azure": { "builtin": "azure", "apiKeyEnv": "AZURE_KEY", "env": { "AZURE_OPENAI_BASE_URL": "https://x.openai.azure.com" }, "enable": ["gpt-5"] }
  },
  "defaultModel": "deepseek/deepseek-chat"
}
```

字段：`api`/`type`（三种通用类型）或 `builtin`（pi-ai 内置 id）；`baseUrl`；`rpmLimit`、`concurrencyLimit`、`breakerThreshold`、`breakerWindowMs`（模型条目可设 `rpmLimit`/`concurrencyLimit`）；`apiKeyEnv`（任意环境变量名，不是密钥本身）；`headers`/`env` 的值为字符串或 `{ "env": "NAME" }`（启动时解析并加密入库）；`authStyle`、`keyless`、`timeoutMs`；`models[]`（字段同 §6，另有 `enabled`、`visibility`、`fallbacks`、`description`）；`enable[]`（启用目录中已有的模型）。**文件里出现 `apiKey` 会拒绝该服务商**；任何校验失败（含 `compat`）只跳过该服务商并在管理页顶部与日志报错。另：旧环境变量 `WORKROOM_ANTHROPIC_API_KEY` / `WORKROOM_OPENAI_API_KEY` / `WORKROOM_OPENAI_COMPAT_*` 仍被识别（生成 `env-anthropic` / `env-openai` / `env-compat`，Key 仅作为变量名保存）。

## 10. 从旧版迁移

首次启动自动一次性迁移旧 `ops_channels / ops_platform_models / ops_model_routes`：渠道 → 服务商（密文原样沿用，`WORKROOM_SECRET_KEY` 不变）；平台模型 → 其第一条路由所在服务商上的手动模型（名称、上下文、价格、可见范围、默认模型沿用），其余路由 → `fallbacks`；旧平台模型 id 保留为**别名**（`model_aliases`），所以保存着 `{provider:"workroom", modelId:<旧 id>}` 的会话仍能运行（别名在 `/api/models` 默认隐藏，`?include=legacy` 可见）。旧表保留不删。

## 11. API 速查（均在 `/api` 下）

- 用户：`GET /models`（`PlatformModelDTO` 兼容，新增 `providerName/providerType/scope/personal/input/reasoning/cost/thinkingLevels`）、`GET /model-settings`。
- 管理：`/admin/model-providers[/:id]`（GET/POST/PATCH/DELETE），`/:id/test`、`/:id/fetch-models`、`/:id/models`（GET/POST/PATCH 批量）、`/:id/models/:modelId`（PATCH/DELETE，`modelId` 含 `/` 时请 URL 编码），`PUT /admin/model-settings`，`GET /admin/route-attempts`，`GET /conversations/:space/:id/routes`。
- 个人：`/me/model-providers…`，形状同上。
- 密钥永不出现在任何响应、日志、审计、转录里（测试逐一扫描响应、日志与数据目录下所有文件）。

## 12. 让 Claude Code（AI 编码助手）新增一种 provider 类型

大多数服务**不需要改代码**（用 `openai-completions` / `anthropic-messages` 即可）。需要新增一种线协议时，对 Claude Code 说“按 `docs/models.md` §12 新增类型 X”，它应修改：

1. 先看 `node_modules/@earendil-works/pi-ai/dist/api/` 下是否已有该协议的实现（如 `google-generative-ai`、`mistral-conversations`、`azure-openai-responses`）；pi-ai 自带的 provider 直接用“内置”类型即可。
2. `server/src/ops/models-types.ts`：把类型 id 加入 `GENERIC_TYPES`。
3. `server/src/ops/gateway.ts` 的 `#api()`：返回该 API 的实现，如 `import { xApi } from "@earendil-works/pi-ai/api/<id>.lazy"`（提供 `ProviderStreams`）；构建发生在 `#build()` 里的 `createProvider({ id, name, baseUrl, auth, models, fetchModels, api })`。
4. `server/src/ops/models-fetch.ts`：`listRemoteModels()` 增加该类型的列表接口与响应解析；`requestAuth()` 处理鉴权头。
5. `server/src/ops/models-service.ts`：`validateSpec()` 已按 `CompatSchemasByApi[api]`（pi-ai `providers/compat-schema`）校验 compat，无需改动；`models-presets.ts` 加预设与 `normalizeBaseUrl()` 规则。
6. `shared/ops.ts`（`ModelProviderType`）与 `web/src/features/admin/models/`（`shared.tsx` 的 `TYPE_LABEL`、`ProviderDialog.tsx` 的 `TYPES`）。
7. 在 `server/test/models-mock-servers.ts` 加该协议的 mock，仿 `models-providers.test.ts` 写“添加 → 获取列表 → 对话 + 工具往返 → 密钥不泄露”测试。**全新的线协议**需要在 pi-ai 里实现 API（见其 README “Adding a New Provider”），Workroom 不 fork 内核。

## 13. 测试

`server/test/models-providers.test.ts`（两种 mock 上游、流式 + 工具往返、密钥不泄露）、`models-limits.test.ts`（RPM/并发溢出与拒绝、熔断开/半开/恢复、故障切换与计费）、`models-gateway.test.ts`（故障切换、compat 上线、无密钥服务、Bearer、blocked）、`models-access.test.ts`（可见范围、RBAC、个人密钥隔离/SSRF、跨组织）、`models-bootstrap.test.ts`（旧数据迁移、环境变量、配置文件）。
