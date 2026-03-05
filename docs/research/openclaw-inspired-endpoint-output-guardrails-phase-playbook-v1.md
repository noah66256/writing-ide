# OpenClaw 对标：端点与输出护栏改造手册（Phase Playbook v1）

> 目标：按“单核心执行 + 薄适配 + 展示层清洗”范式，解决多端点一致性与 JSON/工具痕迹泄漏问题。
>
> 范围：Gateway（chat/responses/messages 统一执行）+ Desktop 消费不改协议。

---

## 0. 结论

1. 端点差异要被锁在适配层，核心层不感知 chat/responses 细节。
2. 工具调用必须结构化优先，文本 JSON 反推只作为可控、默认关闭的应急能力。
3. 用户可见文本必须经过清洗层，禁止暴露工具痕迹、tool result 包裹、纯参数 JSON。
4. run 结束前必须校验“tool_call 与 tool_result 成对”，否则按失败结束并给可读原因。

---

## 1. 现状问题（本轮针对）

- 执行回合中，模型偶发输出纯 JSON（如 `{"id":"...","status":"done"}`）被直接透传到用户。
- 在个别场景中，工具调用/结果配对异常未被核心层阻断，可能“看起来结束了但并未闭环”。
- chat/responses 的行为已经部分收口，但输出护栏仍不够硬。

---

## 2. 设计原则（借鉴 OpenClaw）

- **P1 结构化通路优先**：使用原生工具调用或 canonical tool_call 事件，不依赖文本猜测。
- **P2 适配层只翻译**：endpoint adapter 仅负责协议字段映射。
- **P3 展示层前置清洗**：assistant.delta 对外前统一过滤工具痕迹。
- **P4 回合闭环校验**：若有未配对工具调用，不允许 completed。

---

## 3. 分阶段实施

### Phase 1：收紧 JSON 兜底（执行层）

**改造**
- 将“从纯 JSON 文本反推工具调用”改为默认关闭。
- 仅通过显式开关 `WRITING_IDE_ENABLE_JSON_TOOL_FALLBACK=1` 启用。

**文件**
- `apps/gateway/src/agent/writingAgentRunner.ts`
- `apps/gateway/src/agent/runFactory.ts`

**验收**
- 默认配置下，纯 JSON 文本不再被反推成工具调用。
- 执行任务中若模型只给 JSON，系统进入重试/失败摘要，而不是把 JSON直接回复用户。

---

### Phase 2：新增用户可见文本清洗层（输出层）

**改造**
- 新增统一清洗函数：
  - 清掉工具协议壳：`<tool_calls>...</tool_calls>`、`<tool_result>`、`[tool_result]`。
  - 清掉工具痕迹文本：`[Tool Call ...]`、`[Tool Result ...]`、`[Historical context ...]`。
  - 清掉思考标签：`<think>/<thinking>/<reasoning>`。
  - 在执行回合可选丢弃“纯 JSON payload”。
- runner 所有 `assistant.delta` 统一走安全发射函数。

**文件**
- `apps/gateway/src/agent/userFacingText.ts`（新增）
- `apps/gateway/src/agent/writingAgentRunner.ts`

**验收**
- 用户侧不再看到工具壳与工具痕迹文本。
- 执行回合里纯参数 JSON 默认被过滤。

---

### Phase 3：工具配对守卫（核心状态机）

**改造**
- TurnEngine 增加：
  - pending tool calls（未收到结果）
  - unmatched tool results（孤儿结果）
- run 结束前若 outcome=completed 且仍有 pending tool calls，则转 failed：
  - reason=`tool_result_unpaired`
  - 输出失败摘要与下一步建议

**文件**
- `apps/gateway/src/agent/turnEngine.ts`
- `apps/gateway/src/agent/writingAgentRunner.ts`

**验收**
- 不再出现“completed 但工具结果未闭环”。
- run.execution.report 中可看到 pending/unmatched 计数。

---

### Phase 4：冒烟与回归（双端点）

**改造**
- 扩展 `smoke-messages-responses.ts`：
  - 文本清洗断言
  - TurnEngine 配对守卫断言
- 继续跑既有回归：`regress-agent-flow`

**文件**
- `apps/gateway/scripts/smoke-messages-responses.ts`

**验收**
- messages/responses 冒烟全绿。
- agent 回归全绿。

---

## 4. DoD（完成标准）

1. chat/responses 下执行语义一致，不因端点切换出现 JSON 直出。
2. 执行型回合中，纯 JSON 参数文本不会直达用户。
3. run.end 必有可读结果；工具未配对时明确失败原因。
4. 冒烟与回归通过：
   - `npm run -w @writing-ide/gateway smoke:endpoints`
   - `npm run -w @writing-ide/gateway regress:agent`

---

## 5. 风险与回滚

- 风险：关闭 JSON fallback 可能降低个别弱模型容错。
- 缓解：保留环境变量开关进行灰度恢复。
- 回滚：仅需恢复 `jsonToolFallbackEnabled` 默认开启（单点变更）。

