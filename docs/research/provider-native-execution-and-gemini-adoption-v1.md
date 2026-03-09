# Provider-native 执行框架 + Gemini 接入方案 v1

> 日期：2026-03-09
> 背景：当前 Anthropic 路径相对稳定，但切到 GPT 后出现两个系统性问题：Todo/计划清单丢失、同一副作用工具重复执行；同时 Gemini transport 已有半套实现，但尚未完成正式接入与默认配置。

## 结论先行

这不是单一 provider 的抽风，而是当前运行时对 provider 的抽象过于“同构”，导致：

1. **计划阶段依赖模型自觉**：`run.setTodoList` 没被提升为跨 provider 的硬门禁。
2. **执行收口依赖 prompt 提示**：`run.done` / 停止条件更多靠提示词，不是 runtime latch。
3. **副作用幂等不足**：`doc.write` 等工具的 loop guard 只看“同名同参同结果”，遇到自动改名/路径漂移会失效。
4. **provider continuation 不够 native**：OpenAI `/responses`、Gemini `generateContent/streamGenerateContent` 都仍掺杂 prompt 补偿，而不是优先走 provider-native 状态续接。

因此建议按 P0–P2 逐层推进，而不是继续做补丁式 provider 特判。

---

## 本地对照组

为避免每轮重复上网，本仓库本地保留两个一手源码参考：

- `third_party/openai-codex`
- `third_party/google-gemini-cli`

后续凡是涉及：
- OpenAI `/responses` 的续跑 / tool call / streaming
- Gemini CLI / Gemini API 的 endpoint 适配 / 续跑 / 工具协议

优先先读本地源码，再做结论。

---

## 现状诊断

### 1. GPT provider 下计划清单丢失

当前 `writingAgentRunner` 存在“非 Anthropic 且已有可读文本时，允许跳过工具重试”的软降级：

- 位置：`apps/gateway/src/agent/writingAgentRunner.ts`
- 关键逻辑：`ExecutionContractBypass` / `ExecutionContractSoftDegrade`

问题在于：
- `run.setTodoList` 和初始执行工具都属于 execution contract 的一部分；
- 一旦 GPT 先输出自然语言，就可能在尚未建立 Todo 的情况下直接进入交付路径；
- Anthropic 因为工具遵循度更高，不容易触发该缺陷。

### 2. 副作用工具重复执行

当前 loop guard：
- 只拦截“同一工具 + 同参 + 同结果/同错”的连续重试；
- 对 `doc.write` 这种“同语义但路径变化”的操作不敏感；
- 自动 rename/覆盖策略会让参数签名发生变化，绕过保护。

### 3. provider continuation 仍以 prompt 补偿为主

当前 tool_result 注入后，会补一条 continuation user message：
- “继续。请基于以上 tool_result 推进任务。”

这对 GPT/Gemini 很容易被理解为“继续执行同一任务下一轮动作”，而不是“如果已完成则停止”。

### 4. Gemini 支持现状

已存在：
- `apps/gateway/src/llm/gemini.ts`
- `apps/gateway/src/llm/providerAdapter.ts` 内对 Gemini endpoint 的分流
- `apps/admin-web/src/pages/LlmPage.tsx` 中有 Gemini endpoint suggestion

未完成：
- 默认 provider/model seed
- 面向用户可直接选择的 Gemini 默认模型接入
- Gemini 专属 capability registry
- Gemini 与 OpenAI/Anthropic 一致的 execution/plan/idempotency 验证矩阵

---

## 对标成熟实现的设计原则

### A. Provider-native，而不是 provider-same

目标不是做一个“看起来统一”的 provider 层，而是：

- 抽象统一：**canonical events / canonical transcript / canonical tool results**
- 续跑与 transport：**provider-native**

也就是：
- OpenAI `/responses` 走 Responses-native continuation
- OpenAI `/chat/completions` 走 chat-native function calling
- Gemini 走 `generateContent` / `streamGenerateContent` native transform
- Anthropic 走 messages-native tool use

### B. Plan / Execute / Deliver 要由 runtime 保证，不靠模型自觉

运行时需要明确 3 个阶段：

1. `plan_required`
2. `execution_required`
3. `delivery_required`

不同 provider 只影响 transport，不影响阶段约束。

### C. 副作用工具必须走语义幂等

对以下工具统一引入 side-effect ledger：

- `doc.write`
- `doc.applyEdits`
- `mcp.*create_document`
- `publish/post/send` 类工具

幂等判断不能只看 raw args，要看：
- tool semantic type
- target logical artifact
- normalized content hash / output hash
- run goal / task boundary

---

## P0：先把 provider 执行骨架做对

### P0.1 Provider Capability Registry

新增统一 registry，例如：

```ts
ProviderCapabilities = {
  supportsNativeToolCalling: boolean,
  supportsForcedToolChoice: boolean,
  supportsPreviousResponseId: boolean,
  supportsStrictToolSchema: boolean,
  prefersTextToolResult: boolean,
  supportsParallelToolCalls: boolean,
  continuationMode: "native" | "prompt_fallback",
}
```

当前问题：
- `supportsForcedToolChoice` 直接绑定 `isAnthropicApi`
- 这会把 provider 能力误写成“厂商判断”而不是“端点能力判断”

### P0.2 Plan Gate 独立

进入 `task_execution` 时，先要求 Todo 建立成功：

- 没有 Todo，不进入自由执行
- `ExecutionContractBypass` 不能跨过 Todo Gate
- 即使 provider 不稳，也先 retry `run.setTodoList` / `run.todo.upsertMany`

### P0.3 Delivery Latch

一旦满足：
- 已有成功副作用产物（例如 `doc.write ok`）
- 并且 assistant 已形成最终交付文本或调用 `run.done`

则 run 进入 delivery latch：
- 禁止再次调用同类副作用工具
- 仅允许 `run.done` / `run.mainDoc.update` / 轻量收尾工具

---

## P1：副作用幂等与 provider-native continuation

### P1.1 Side-effect Ledger

建议为本轮 run 建立 ledger：

```ts
SideEffectRecord = {
  semanticKind: "artifact_write" | "publish" | "doc_edit" | ...,
  toolName: string,
  logicalTarget: string,
  argsFingerprint: string,
  resultFingerprint: string,
  contentFingerprint?: string,
  ts: number,
}
```

其中 `logicalTarget` 不是原始 path，而是语义路径：
- `output/口播稿_OpenClaw_李叔风格`
- 即使被 rename 成 `_v2` / `_v3`，仍视为同一 logical artifact family

### P1.2 OpenAI Responses native continuation

目标：
- 不再主要靠 “继续。请基于以上 tool_result 推进任务。” 这类 user continuation 文本续跑
- 优先使用 OpenAI Responses-native continuation 机制
- continuation prompt 仅作 fallback

### P1.3 Gemini native stage adapter

Gemini 正式接入时，不应只做“endpoint 识别 + 文本拼接”，还需补：
- capability registry
- todo/plan gate 行为
- tool result 注入策略
- stream/no-stream fallback 策略
- 与 loop guard / side-effect ledger 的整合

---

## P2：回归矩阵与运维可观察性

### P2.1 Provider Parity Smoke

新增统一 smoke case：

1. `task_execution.todo_gate`
2. `task_execution.single_artifact_write_once`
3. `task_execution.run_done_stops_loop`
4. `task_execution.delivery_latch_blocks_repeat_write`
5. `browser_session.waiting_user_not_cleared`

provider 维度至少覆盖：
- anthropic-messages
- openai-responses
- openai-chat-completions
- gemini-generateContent

### P2.2 Run 审计埋点

新增以下埋点：
- `providerApi`
- `providerCapabilitiesSnapshot`
- `todoGateSatisfiedAtTurn`
- `deliveryLatchActivatedAtTurn`
- `sideEffectLedgerSize`
- `toolLoopGuardReason`
- `providerContinuationMode`

### P2.3 Debug 面板/日志

当出现“没 Todo / 重复写文件”时，日志直接能回答：
- 本轮是否进入 Todo Gate
- 是否被 bypass
- 最近副作用 ledger 是什么
- 为什么没有拦截重复写入

---

## Gemini 接入落地范围（本轮建议）

### 最小可交付

1. 在默认 AI config 中加入 Gemini provider / 2 个模型 seed
2. admin-web / desktop 模型列表可看到 Gemini 模型
3. endpoint 支持：
   - `/v1beta/models/gemini-3.1-pro-preview:generateContent`
   - `/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`
4. 允许用户通过 provider/baseURL + model endpoint 正常测试和选择
5. 补 smoke：Gemini once/stream/tool-result continuation 基本可通

### 不建议混在这轮一起做完的

- 完整 provider-native continuation 重构
- 全量 side-effect ledger
- 全运行时 phase machine 替换

这些需要按 P0→P1→P2 分段推进。

---

## 本轮推荐实施顺序

1. 写入常驻规则：本地参考仓库路径 + “优先读本地源码”原则
2. 补默认 Gemini provider/model seed
3. 打通 admin-web/desktop 模型可见性
4. 增加 Gemini smoke
5. 再开下一轮做 P0（Todo Gate / Delivery Latch / Capability Registry）

---

## 本轮相关固定信息

### 本地参考仓库
- `third_party/openai-codex`
- `third_party/google-gemini-cli`

### Gemini provider 配置（开发期）
- baseURL: `https://generativelanguage.googleapis.com`
- model A: `gemini-3.1-pro-preview`
- endpoint A: `/v1beta/models/gemini-3.1-pro-preview:generateContent`
- model B: `gemini-3.1-flash-lite-preview`
- endpoint B: `/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`

> API Key 不写入仓库文档；通过本地/服务端配置注入。
