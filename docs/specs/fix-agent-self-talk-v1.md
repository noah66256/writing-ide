# 修复 Agent 在单次 run 中"自问自答"

> 状态：待实施 | 优先级：P1 | 日期：2026-03-15

## 0. 现象

用户让 Agent 测试工具可用性。Agent 调用 `read` → 失败（UNKNOWN_TOOL），调用 `tools.search` 确认工具存在，然后输出一段完整的状态总结表格。但随后在**没有用户输入**的情况下，Agent 又自行追加了第二段回复（"了解，read 在本轮不可用..."），像在"自言自语"。

这种"追加自言自语"在多种场景下可复现：只要有工具执行失败，Agent 输出总结后还会再追加一轮多余的回复。

---

## 1. 根因分析

### 1.1 主根因：`tool_failure_repair` 软提示在 followUp 通道强制追加一轮

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**调用链**：

```
Agent Turn N: 调用 read → UNKNOWN_TOOL, 调用 tools.search → 成功
  → currentTurnToolCalls > 0 → consecutiveTextOnlyTurns = 0
  → failureDigest.failedCount++

Agent Turn N+1: 输出纯文本总结（"Boss，测试完毕，read ❌ 不可用..."）
  → currentTurnToolCalls = 0 → consecutiveTextOnlyTurns = 1
  → agentLoop 调用 getFollowUpMessages()
    → 检查隐式完成：totalToolCalls > 0 && consecutiveTextOnlyTurns(1) >= 2？否
    → _collectSoftGuidanceMessages()
      → failureDigest.failedCount(1) > lastSteeringFailureCount(0)？是
      → 注入 tool_failure_repair hint: "刚刚有工具执行失败...请修复参数..."
    → 返回 [hint] → agentLoop 继续新一轮

Agent Turn N+2: 模型收到 hint，输出第二段纯文本（"了解，read 不可用..."）
  → consecutiveTextOnlyTurns = 2
  → getFollowUpMessages(): consecutiveTextOnlyTurns(2) >= 2 → return []
  → 自然结束
```

**核心问题**：`tool_failure_repair` 不区分"失败是否已被模型在后续行为中处理过"。即使模型已经用 `tools.search` 自查并输出了完整总结，这条失败仍会触发一轮多余的 followUp 提示。

### 1.2 次根因：`consecutiveTextOnlyTurns` 阈值为 2 允许追加一轮

**文件**：`GatewayRuntime.ts:1014`

```typescript
if (this.totalToolCalls > 0 && this.consecutiveTextOnlyTurns >= 2) {
  return [];
}
```

阈值 `>= 2` 意味着模型在做过工具调用后，可以连续产生 2 轮纯文本才被终止。这个设计本身是为了给"追问-执行"留一次机会，但叠加 `tool_failure_repair` 后导致必定追加一轮。

### 1.3 影响范围：所有 followUp 追问路径

| reasonCode | 触发条件 | 追加轮数 | 自言自语风险 |
|------------|---------|---------|------------|
| `tool_failure_repair` | 有工具失败 | 1轮 | **高** — 模型已自行处理失败时仍追加 |
| `execution_contract_enforce` | 执行契约要求工具调用 | 1轮 | 中 — 纯 Q&A 场景误触发时 |
| `style_workflow_followup` | style_imitate 闭环未完成 | 多轮（有 budget 控制） | 低 — 合理的工作流强制 |
| `pending_todo` | todo 有未完成项 | 1轮 | 低 — 有"等待用户"检测 |
| `plan_no_execution` | 有计划无执行 | 1轮 | 低 — 合理的催促 |
| `delivery_latch_followup` | 产物已生成 | 1轮 | 低 — 合理的收口提醒 |
| `orchestrator_long_text_blocked` | 编排者长文本 | 1轮 | 低 — 合理的角色矫正 |

---

## 2. 修复方案

### Fix 1（P1）：抑制已被后续行为处理过的 `tool_failure_repair`

**方案**：在 `_getFollowUpMessages` 中，当 `consecutiveTextOnlyTurns >= 1` 时（模型已输出一轮纯文本总结），对 `tool_failure_repair` 做特殊处理：提前将 `lastSteeringFailureCount` 更新到当前 `failedCount`，使其不再触发 followUp。

**原理**：如果模型在工具失败后已经自行输出了一轮纯文本总结（而不是继续盲目调用工具），说明模型已经"消化"了失败信息，不需要 runtime 再提醒一遍。

**修改位置**：`GatewayRuntime.ts:_getFollowUpMessages()`，在隐式完成检查之后、调用 `_collectSoftGuidanceMessages` 之前，加入抑制逻辑：

```typescript
// 隐式完成：连续纯文本 >= 2 → 自然终止
if (this.totalToolCalls > 0 && this.consecutiveTextOnlyTurns >= 2) {
  return [];
}

// [NEW] 模型已输出一轮纯文本总结（consecutiveTextOnlyTurns >= 1），
// 说明失败已被语义处理过，提前消耗 failure 计数，避免 tool_failure_repair 追加多余一轮
if (this.consecutiveTextOnlyTurns >= 1 && this.failureDigest.failedCount > this.lastSteeringFailureCount) {
  this.lastSteeringFailureCount = this.failureDigest.failedCount;
}

const softGuidance = this._collectSoftGuidanceMessages();
```

**保留的机制**：
- `style_workflow_followup`（在 `_collectSoftGuidanceMessages` 之前就已返回）不受影响
- `pending_todo`、`plan_no_execution`、`delivery_latch_followup` 不受影响
- `execution_contract_enforce`、`delivery_latch_active` 仍正常工作
- 只有 `tool_failure_repair` 在模型已输出纯文本总结后被抑制

**边界情况**：
- 如果模型在失败后没有输出纯文本总结而是继续调用工具（`consecutiveTextOnlyTurns = 0`），`tool_failure_repair` 仍会正常触发
- 如果有多次不同工具的失败发生在不同轮次，只要最后一次失败后模型输出了纯文本，就不再追加

### Fix 2（P2，可选）：增强版 — 基于后续行为判断失败是否已被处理

**方案**：在 `_handleKernelEvent("tool_execution_end")` 中，当检测到"失败后模型主动调用了 `tools.search` / `tools.describe`"时，将该失败标记为"已处理"，提前更新 `lastSteeringFailureCount`。

**优点**：更精确，不依赖"是否有纯文本回合"这个粗粒度信号。
**缺点**：需要额外的状态追踪，实现更复杂。

**适合作为 Fix 1 的后续增强**，当前阶段 Fix 1 已足够解决用户报告的问题。

---

## 3. 不采用的方案

### 方案 B：将 `consecutiveTextOnlyTurns` 阈值从 2 改为 1

**不采用原因**：过于粗暴。会砍掉所有 followUp 追问机会，包括合理的 `pending_todo`、`delivery_latch_followup`、`execution_contract_enforce` 等。

### 方案 C：将 `tool_failure_repair` 从 followUp 移到 steering 通道

**不采用原因**：
1. `_getSteeringMessages` 当前被强制返回 `[]`，是因为 steering 消息会导致"当前回合剩余工具调用被跳过"（pi-agent-core 语义）
2. 已有前车之鉴：之前把软提示塞进 steering 导致 Gemini 把同轮其他工具误判为 "Skipped due to queued user message."
3. 即使移到 steering，也不能消除"多一轮回复"的现象

---

## 4. 验证 Checklist

### 4.1 自言自语场景

- [ ] 工具调用失败 → Agent 输出总结 → 不应再追加第二段回复
- [ ] 工具调用失败 → Agent 没有输出总结就结束 → 仍应注入 `tool_failure_repair` 提示

### 4.2 不受影响的追问场景

- [ ] style_imitate 闭环未完成 → 仍应追问
- [ ] todo 有未完成项 → 仍应追问
- [ ] 有计划无执行 → 仍应追问
- [ ] 产物已生成 → 仍应提醒 run.done
- [ ] 执行契约要求工具调用 → 仍应提醒

### 4.3 已有测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 5. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | Fix 1 | `_getFollowUpMessages` 中添加 failure 抑制逻辑 |
