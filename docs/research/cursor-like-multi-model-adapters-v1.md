# Cursor 类 IDE 多模型接口适配范式（research v1）

> 目的：回答“Cursor 这类 IDE 怎么同时支持 OpenAI / Anthropic / Gemini / DeepSeek / 各种 OpenAI-compatible 中转接口？它们怎么处理不同 endpoint（尤其 `/v1/responses`）？”
>
> 本文是“上一轮对话里已达成的结论”落盘版，便于团队/LLM 复用；后续如需补外链证据与更多实现细节，可在 v2 迭代。

## 背景：为什么会“看起来都能配”，但实际容易跑不通

Cursor / Continue / Windsurf / Cline 这类 IDE 并不是“无脑支持所有 endpoint”。它们通常都会做：

- **统一协议（internal canonical schema）**：IDE 内部先统一成一种请求/响应形态（常见是 OpenAI `chat.completions` 风格的 `messages`）。
- **Adapter / Proxy 翻译**：对不同供应商、不同 endpoint 走适配器（adapter）或代理转换（proxy，例如 LiteLLM 一类）把差异抹平。
- **能力探测（capability matrix）**：记录/探测一个模型到底支持哪些能力（stream、tools、JSON schema、vision…），并据此选择调用方式与降级策略。

> 经验结论：**“支持多家模型”本质是“支持多套协议 + 做好能力边界”**，不是简单堆 baseURL。

## 结论：Cursor 类 IDE 的通用范式

### 1) 统一“模型身份”，不要只用 model name

常见做法是用 **provider + model + baseURL + keyRef（或 credentialId）+ endpointKind** 作为稳定身份。

否则会出现典型事故：

- **同名串台**：两个配置都叫 `gpt-4o`，但 baseURL 不同；系统仅用 name 做 key，会把 A 的请求打到 B。
- **测速误判**：把 `/v1/responses` 当成 `/v1/chat/completions` 去测，必然 4xx，但 UI 又显示“模型可用/不可用”混乱。

### 2) 明确 endpointKind / apiType（不要猜）

主流 IDE/中间层不会假设“所有 OpenAI-compatible 都等价”，而是把 API 形态显式化（或至少在内部判定并缓存）：

- **API 形态（endpoint kind）**：
  - `openai_chat_completions`（`/v1/chat/completions`）
  - `openai_responses`（`/v1/responses`）
  - `openai_embeddings`（`/v1/embeddings`）
  - `gemini_generateContent`（`/v1beta/models/...:generateContent`）
  - `anthropic_messages`（`/v1/messages`）
- **能力（capabilities）**：
  - `stream`
  - `tools/functionCalling`
  - `json_schema` / `response_format`
  - `vision`
  - `multiple_candidates` 等

> 关键点：**测速/校验也必须按 endpointKind 发送最小请求**，不能“一套 ping 走天下”。

### 3) adapter 负责“协议翻译”，proxy 负责“兼容保底”

现实中 IDE 经常选两种路线之一：

- **多适配器**：IDE/Gateway 内置多套 adapter，分别构造请求并解析响应。
- **只支持一种规范接口，其它强制走代理**：例如要求用户把各家模型统一接到“OpenAI chat.completions 风格”的代理层，然后 IDE 只认一种协议。

在 BYOK + BaseURL override 场景下，社区也常见这种取舍：

- IDE 对 `/v1/responses` 这种新接口兼容不稳定时，用户会用代理把 `responses` 翻译成 `chat.completions` 再喂给 IDE，避免路径/字段差异导致失败。

## 对我们项目的落地方向（建议）

结合仓库现状：我们目前多处默认值是 **`/v1/chat/completions`**（Admin/Gateway），属于“只保证 chat.completions 可靠”的阶段。要稳妥扩展到 `/v1/responses`，建议走“显式 apiType + 适配器”的范式。

### 方案 A（推荐）：在 AiModel 增加 `apiType`（或 `endpointKind`），由 Gateway 统一适配

- **Admin Web（模型配置）**
  - 新增字段：`apiType`（枚举）
  - `endpoint` 仍保留，但其含义由 `apiType` 解释（例如 `openai_chat_completions` 对应 `/v1/chat/completions`）
  - UI 文案明确：**Chat/Agent 默认只保证 `openai_chat_completions` 可用**；`openai_responses` 需选择对应 apiType，并通过专用测速。

- **Gateway（调用与测速）**
  - 按 `apiType` 走不同 adapter：
    - `openai_chat_completions`：走现有 OpenAI-compatible 适配
    - `openai_responses`：新增 Responses adapter（请求体/解析/流式事件映射）
    - 其它：逐步扩展
  - `test connection` 也按 `apiType` 发最小请求，返回结构化诊断（错误码 + 建议）。

### 方案 B（短期折中）：先不支持 `/v1/responses`，但把“不能用”说清楚

- 仍然只保证 `/v1/chat/completions`（以及 Gemini/Anthropic 走各自 adapter）
- B 端明确提示：`/v1/responses` 需要走代理转换成 `chat.completions`，避免“能配置但跑不通”的体验。

## 验收标准（建议写进实现任务）

- **模型身份不串台**：同名 model 不同 baseURL/endpointKind 不会互相覆盖。
- **测速准确**：按 `apiType` 发送最小请求，错误提示包含“你选错 endpointKind/endpoint 了”的可操作建议。
- **运行链路一致**：Chat / Agent / Embeddings（如有）分别使用正确的 adapter。
- **可回滚**：把 `apiType` 切回 `openai_chat_completions` 不影响现有功能。

## 备注：后续可补充的研究项（v2）

- 收集并补充外链证据：社区对 Cursor BYOK + BaseURL override + `/v1/responses` 的报错案例、Continue/Windsurf 的 provider 适配方式等。
- 细化 `/v1/responses` 的最小请求体与 streaming 事件映射到我们现有 SSE 事件模型的方案。


