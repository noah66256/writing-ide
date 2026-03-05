# 单核心编排改造手册（Chat + Responses 对齐版）v1

> 目标：把我们现有的 Agent 编排改造成“单核心状态机 + 薄协议适配层”，并稳定支持 `chat.completions` 与 `responses`（后续再扩 OpenAI-compatible 变体）。
> 
> 适用范围：Gateway/Desktop 的主回合、工具调用、失败反馈、todo/end 判定。

## 0. 结论先行

1. 当前不是纯 ReAct，而是“Agentic Loop + 路由/护栏/重试策略拼接”。可跑，但边界场景多。
2. 核心问题不在某一个工具，而在“协议差异直接泄漏到业务逻辑层”。
3. 要稳住两端点与后续第三类兼容端点，必须先做**单核心执行状态机**，再把 messages/responses 放进 adapter。
4. 工具层保留“Schema 为主 + XML 兜底”是对的，但 XML 只能作为降级通道，不能反向污染主执行语义。

---

## 1. 四页官方文档给我们的硬约束

## A. Chat Completions（create + streaming）
- 请求入口是 `messages`。
- 工具定义在 `tools[].function.parameters`（JSON Schema）。
- 流式返回核心是 `chat.completion.chunk`，增量在 `choices[].delta`，包含文本与 `tool_calls` 增量。
- 工具结果回传是 `role: "tool"` + `tool_call_id`。

## B. Responses（create + migration）
- 请求入口是 `input`（不是 `messages`）。
- 工具定义在 `tools[]` 顶层函数项（`type/name/parameters`）。
- 多轮靠 `previous_response_id` 串联。
- 工具调用/结果是 `output` 项驱动：
  - 模型产出 `function_call`
  - 客户端回传 `function_call_output`
- 流事件语义化更强（如 `response.output_text.delta` / `response.completed`）。

## C. Migration 指南对我们最关键的点
- 不能只做字段替换，必须做“会话状态与工具事件模型”的迁移。
- Chat 的 `messages` 历史拼接思路，与 Responses 的 `response_id + output items` 思路不同。
- 因此需要内部 canonical schema，否则越修越散。

---

## 2. 我们当前实现（结合代码现状）

## 2.1 主循环与路由
- 主执行循环：`apps/gateway/src/agent/writingAgentRunner.ts`
- 路由注册与 phase0 决策：`apps/gateway/src/agent/runFactory.ts`
- 现状：路由、策略、协议细节交织；并非单一状态机核。

## 2.2 工具定义与协议桥
- 工具单一来源：`packages/tools/src/index.ts`（`TOOL_LIST`）
- OpenAI 适配：`apps/gateway/src/llm/openaiCompat.ts`
- Provider 统一入口：`apps/gateway/src/llm/providerAdapter.ts`
- 现状：
  - 已有 schema 归一化与兼容补丁；
  - 同时维护 native tool call 与 XML tool_call 解析；
  - 但“工具契约错误 -> 执行反馈 -> 下一步决策”未完全统一。

## 2.3 结束反馈
- Desktop run.end 反馈：`apps/desktop/src/agent/wsTransport.ts`
- 现状：有兜底，但仍可能出现“本轮结束了却不够可执行”的体感。

---

## 3. 目标范式：单核心 + 三层适配

## 3.1 三层模型
1. 核心层（Core Turn Engine）
- 只负责状态迁移与回合契约，不感知 Chat/Responses 细节。
- 输入：`UserIntent + ToolCatalog + RunState + PolicyHints`
- 输出：`AssistantText | ToolCallPlan | Clarify | RunDone | RunFailedDigest`

2. 策略层（Policy / Router Layer）
- 负责意图识别、工具白名单、风险分级、todo/end 判定策略。
- 产出“可执行约束”（如 executionPreferred、禁用工具、必须先做一步工具调用）。

3. 协议层（Protocol Adapters）
- `chat` adapter：messages/tool_calls/chunk
- `responses` adapter：input/output_items/semantic events
- 将外部协议映射成统一 `CanonicalTurnEvents`。

## 3.2 内部 canonical event（建议）

```ts
type CanonicalTurnEvent =
  | { type: 'model_text_delta'; text: string }
  | { type: 'model_tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; output: unknown; error?: string }
  | { type: 'model_done'; finishReason?: string }
  | { type: 'model_error'; error: string };
```

要点：
- Chat/Responses 只做“翻译”，不做业务决策。
- Core 永远基于 `CanonicalTurnEvent` 运行。

---

## 4. 六个核心问题的对标结论

## 4.1 流程（ReAct vs 当前）
- 现状：近似 ReAct，但混有大量协议/路由特判。
- 改造：Core 中明确 `Observe -> Think -> Act -> Observe -> ... -> End`，并把“至少一次有效工具调用”做成策略约束，不硬编码在协议分支里。

## 4.2 工具定义
- 结论：`Schema + XML 兜底`方向正确。
- 规则：
  - 主通路：严格 schema（object 顶层、array 有 items、无顶层 oneOf/anyOf/allOf/enum/not）。
  - 兜底通路：仅在供应商不支持 native 工具调用或返回异常时启用 XML。
  - XML 结果必须转换回 canonical tool_result，不允许核心层直接消费 XML 文本。

## 4.3 tool / skill / mcp / sub-agent 调用顺序
- 现状：同层可见，靠 prompt+路由约束，顺序不稳定。
- 建议分层：
  - L0：运行控制工具（`run.*`）
  - L1：安全本地工具（doc/project/kb）
  - L2：MCP 扩展工具（含浏览器）
  - L3：sub-agent 委派（`agent.delegate`）
- 执行优先级：`L0 决策 -> L1 直达 -> L2 条件放开 -> L3 最后`

## 4.4 上轮结果反馈机制
- 必须统一为结构化回执：
  - `completed`：做了什么
  - `failed_steps[]`：哪一步失败 + 原因 + 建议动作
  - `next_action`：继续重试 / 改参数 / 人工确认
- 桌面端显示保持一句话风格，但数据必须结构化，不再只给“有 N 步失败”。

## 4.5 语义理解 + 路由 + 状态机
- 语义理解不是根因，根因是“语义结果没被硬约束到状态机”。
- 改造：
  - 路由只产出 `RouteDecision`（意图、风险、建议工具）
  - 状态机最终裁决“可执行动作”
  - 所有“执行前条件”（如删除任务禁止 doc.read）由策略规则显式编码

## 4.6 todo/end 判定
- end 不应该依赖“模型看起来说完了”。
- 统一判定：
  - `run.done` 明确结束；或
  - Core 判定“目标达成且无待执行 todo 且无失败未处理步骤”后自动结束。
- 任一失败未解释时，不得静默 end。

---

## 5. Chat/Responses 字段映射（直接可改）

| 语义 | Chat | Responses | 内部 canonical |
|---|---|---|---|
| 用户输入 | `messages[]` | `input` | `turn_input` |
| 开发者约束 | `messages(system/developer)` | `instructions`/developer input | `policy_prompt` |
| 工具定义 | `tools[].function.parameters` | `tools[].parameters` | `tool_catalog` |
| 工具调用 | `choices[].delta.tool_calls` | `output` 中 `function_call` | `model_tool_call` |
| 工具结果回传 | `role: tool` + `tool_call_id` | `function_call_output` item | `tool_result` |
| 多轮串联 | 完整 messages 续传 | `previous_response_id` | `conversation_ref` |
| 文本增量 | `delta.content` | `response.output_text.delta` | `model_text_delta` |
| 结束事件 | chunk finish / done | `response.completed` | `model_done` |

---

## 6. 改造计划（可直接按 phase 执行）

## Phase 1：抽单核心状态机（必须先做）

目标：让所有端点都走同一套回合判定。

改动点：
1. 新增 `TurnEngine`（纯业务，不含协议字段）。
2. 把 `run.done`、failure_digest、todo 完成条件统一下沉到 Core。
3. 将 `writingAgentRunner` 的“端点分支逻辑”改为“adapter -> canonical events -> core”。

验收：
- 同一任务在 chat/responses 下，`run.end.reason` 一致。
- 不再出现“结束了但没有失败摘要”。

冒烟：
1. 简单删除任务（应调用 list + delete + done）。
2. 纯问答任务（不应强行工具调用）。
3. 工具失败任务（必须给失败步骤和下一步建议）。

## Phase 2：策略层插件化（路由/风险/顺序）

目标：解决偏航与误工具调用。

改动点：
1. 定义 `RouteDecision`（intent/risk/preferred/forbidden）。
2. 引入调用层级（L0~L3）与可配置优先级。
3. 高风险动作统一确认话术（对话内按钮，不弹窗）。

验收：
- “删除类”不再触发 `doc.read`。
- 写作任务不再误拉浏览器。
- 同一输入在不同模型下工具顺序稳定。

冒烟：
1. “删 ~ 开头临时文件”
2. “打开百度并读取标题再结束”
3. “@风格库写作”不应触发浏览器/MCP

## Phase 3：协议适配层收敛（chat/responses/openai-compatible）

目标：协议变化不再影响业务层。

改动点：
1. `ChatAdapter` / `ResponsesAdapter` 输出统一 canonical stream。
2. tool schema 正规化统一函数唯一入口（避免散落修补）。
3. XML 兜底只在 adapter 内生效。

验收：
- messages/responses 双端点均通过同一套回归集。
- 新增 OpenAI-compatible 端点时，只改 adapter，不动 core。

冒烟：
1. 双端点各跑 10 条典型任务（执行/问答/多工具/失败恢复）。
2. 强校验 schema 的供应商不再报 `invalid_function_parameters`。

---

## 7. 风险与防回归

1. 风险：核心迁移期可能出现“重复 run.done”或“工具结果丢帧”。
- 防护：事件幂等键（`callId + turn`）与 end-once 锁。

2. 风险：responses 语义事件不完整时误判结束。
- 防护：`model_done` 仅由 adapter 的明确 completed 信号触发。

3. 风险：过度依赖 XML 兜底，导致新模型能力退化。
- 防护：统计 native-tool 成功率，低于阈值才降级。

---

## 8. 立即执行清单（按这个顺序改）

1. 先落 `CanonicalTurnEvent` 与 `TurnEngine` 接口（不动 UI）。
2. 把现有 chat/responses 分支接入 adapter，打通最小闭环。
3. 再迁移路由策略到 `RouteDecision`，删除散落特判。
4. 最后统一 run.end 反馈格式到 Desktop。

---

## 9. 参考（本次使用的四页）

1. Chat Completions create  
https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

2. Chat Completions streaming events  
https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events

3. Responses create  
https://developers.openai.com/api/reference/resources/responses/methods/create

4. Migrate to Responses guide  
https://developers.openai.com/api/docs/guides/migrate-to-responses


---

## 10. 代码落点清单（按文件对着改）

1. `apps/gateway/src/agent/writingAgentRunner.ts`
- 抽离端点差异逻辑，改为调用 `ChatAdapter/ResponsesAdapter`。
- 主循环只接收 canonical events，不再直接解析各类 provider 原始字段。

2. `apps/gateway/src/agent/runFactory.ts`
- 路由层只输出 `RouteDecision`，移除协议感知特判。
- 把 executionPreferred/forbidden 归入策略层配置结构。

3. `apps/gateway/src/llm/openaiCompat.ts`
- 保留 schema normalize 与协议转换，但只负责 adapter 责任。
- XML fallback 限定在此层内，不向上暴露 XML 语义。

4. `apps/gateway/src/llm/providerAdapter.ts`
- 统一 adapter 接口：`sendTurn()`、`streamTurn()`、`toCanonicalEvents()`。
- 增加端点能力探测（native-tools 支持/降级策略）。

5. `packages/tools/src/index.ts`
- 工具 schema 规范前置校验（object 顶层、array items、禁顶层组合关键词）。
- 输出统一工具目录给 Core 与 adapter 共享。

6. `apps/desktop/src/agent/wsTransport.ts`
- run.end 反馈改为消费结构化回执（completed/failed_steps/next_action）。
- 对话内展示保留简洁话术，不使用弹窗。

---

## 11. Definition of Done（这轮改造完成标准）

1. 同一任务在 chat/responses 两端点下，工具序列与结束语义一致（允许文本措辞不同）。
2. “执行型任务”不会只吐 JSON 文本，必须产生可解释动作或明确失败步骤。
3. “问答型任务”不会被 execution gate 误伤（不强制工具调用）。
4. 工具 schema 错误在进入模型前被拦截并定位到具体工具字段。
5. 任一 run 结束必须有用户可读反馈：成功内容或失败步骤，不允许空结束。

