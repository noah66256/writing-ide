# fix-agent-selftalk-mcp-failure-v4

> 自言自语系列第 4 轮修复：MCP 工具连续失败导致的无限自问自答循环

## 现象

### 用户报告

在使用飞书（Lark）MCP 工具时，Agent 调用 MCP 工具失败后进入无限自言自语循环：
- Agent 调用 `mcp.lark.XXX` → 工具返回错误（MCP server 参数错误/协议不兼容/不可达等）
- Agent 输出诊断文字（分析失败原因、尝试修复）→ 再次调用 → 又失败
- 循环不断持续，用户看到 Agent 自顾自地分析、重试、再分析，永不停止
- 直到 `maxTurns` 耗尽才强制结束

### 症状卡片

| 项目 | 信息 |
|------|------|
| 错误工具 | 飞书 MCP 系列工具 (mcp.lark.*) |
| 失败原因 | MCP 参数传递方式不兼容、server 返回 `-32602` / stderr 报错 |
| 复现条件 | MCP 工具持续不可用时（server down、工具名错误、参数格式不兼容） |
| 用户期望 | 失败 1-2 次后告知用户，停止重试 |
| 实际行为 | 每次失败都触发 `tool_failure_repair` hint，驱动 Agent 无限重试 |
| 影响范围 | 所有持续返回错误的工具（MCP 工具、delivery latch 拦截等） |

## 历史版本

| 版本 | Commit | 修复内容 | 未覆盖场景 |
|------|--------|---------|-----------|
| v1 | 7cf9acf | `consecutiveTextOnlyTurns >= 1` 预消耗 failure count | 混合回合（有工具调用+有文本）不触发 |
| v2 | 89991d6 | 隐式完成检测 + `_detectAssistantAskingUser` | 仅在 pending_todo 路径生效，被 softGuidance 短路 |
| v3 | 25fcec9 | `tailActionPlanPattern` 增强提问检测 | 同 v2，被 softGuidance 短路 |
| **v4** | — | **连续失败限流 + 提问检测全局化** | 本次修复 |

## 根因分析

### 根因 1（主因）：`tool_failure_repair` 对不可修复失败无退出机制

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
**位置**：`_collectSoftGuidanceMessages()` L904-920

```typescript
// L904-920: 每当 failedCount > lastSteeringFailureCount 就注入 hint
if (this.failureDigest.failedCount > this.lastSteeringFailureCount) {
  pushHint("刚刚有工具执行失败...请先根据失败结果修复参数...", ["tool_failure_repair"]);
  this.lastSteeringFailureCount = this.failureDigest.failedCount;
}
```

触发链路：

```
Turn 1: Agent 调用 MCP 工具 → 失败 → failedCount=1
        Agent 输出诊断文字 + 可能重试 → currentTurnToolCalls > 0
        turn_end → consecutiveTextOnlyTurns = 0（L1990 重置）

_getFollowUpMessages():
  L1014: consecutiveTextOnlyTurns=0 < 2 → 不退出
  L1021: consecutiveTextOnlyTurns=0 < 1 → 不消耗 failure count
  L1028: _collectSoftGuidanceMessages()
    L904: failedCount(1) > lastSteeringFailureCount(0) → TRUE
    → 注入 tool_failure_repair hint
    L919: lastSteeringFailureCount = 1

Turn 2: Agent 收到 hint 重试 → 又失败 → failedCount=2
        consecutiveTextOnlyTurns 仍然 = 0
        L904: failedCount(2) > lastSteeringFailureCount(1) → TRUE → 又注入

Turn 3, 4, 5... 无限循环
```

**核心问题**：每次重试产生新 failure → `failedCount` 持续递增 → L904 条件永远为真 → 没有任何机制在 N 次失败后停止注入 hint。

### 根因 2（v1 修复失效）：`consecutiveTextOnlyTurns` 守卫在混合回合下不触发

**位置**：`_getFollowUpMessages()` L1021-1026

```typescript
if (
  this.consecutiveTextOnlyTurns >= 1 &&   // 需要"纯文本回合"
  this.failureDigest.failedCount > this.lastSteeringFailureCount
) {
  this.lastSteeringFailureCount = this.failureDigest.failedCount;
}
```

v1 设计假设：失败后 Agent 会产生一个"纯文本回合"（不调用工具，只输出解释）。

实际行为：Agent 被 `tool_failure_repair` hint 驱动，每轮都会调用工具重试，`currentTurnToolCalls > 0` → `consecutiveTextOnlyTurns` 永远被重置为 0（L1990）→ 守卫条件 `>= 1` 永远不成立。

### 根因 3（辅助因素）：`_detectAssistantAskingUser` 被 softGuidance 短路

**位置**：`_getFollowUpMessages()` L1028-1029 vs L1070-1072

```typescript
// L1028-1029: softGuidance 在前，直接 return
const softGuidance = this._collectSoftGuidanceMessages();
if (softGuidance.length > 0) return softGuidance;  // ← 后续代码全被跳过

// ... (L1040-1066: todo 相关逻辑)

// L1070-1072: 提问检测在后，永远到不了
const lastText = this._getLastAssistantText();
if (lastText && this._detectAssistantAskingUser(lastText)) return [];
```

即使 Agent 输出了"工具不可用，需要您确认是否换个方式"这类向用户提问的文本，只要 `tool_failure_repair` 触发了，提问检测就被短路，runtime 仍然注入"请修复参数"的 hint。

## 影响范围

| 受影响场景 | 严重度 | 说明 |
|-----------|--------|------|
| MCP 工具不可达/协议错误 | **S 级** | 完全不可修复，100% 死循环 |
| MCP 工具名错误 (TOOL_NOT_FOUND) | **S 级** | 工具不存在，无法修复 |
| MCP 参数格式不兼容 | **A 级** | 多数情况不可修复（SDK 版本问题） |
| delivery latch 重复写入被拦截 | **A 级** | 写入工具返回错误进入 failureDigest |
| 工具权限不足 | **A 级** | 无法通过修改参数解决 |
| 临时性参数错误 | **B 级** | 可修复，但当前无上限仍有风险 |

## 修复方案

### Fix 1（P0）：`tool_failure_repair` 连续失败限流

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
**位置**：L103（常量区）+ L904-920（`_collectSoftGuidanceMessages`）

**改动原理**：按工具名统计尾部连续失败次数。< 3 次保持原有 `tool_failure_repair`；= 3 次改为 `tool_failure_give_up`（要求放弃该工具、告知用户）；> 3 次不再注入任何 hint。

**当前代码（L103）**：

```typescript
const STYLE_LINT_PASS_SCORE = 70;
const LINT_MAX_REWORK = 2;
```

**修改后（L103）**：

```typescript
const STYLE_LINT_PASS_SCORE = 70;
const LINT_MAX_REWORK = 2;
const MAX_TOOL_FAILURE_REPAIR_SERIES = 3;
```

**当前代码（L904-920）**：

```typescript
    if (this.failureDigest.failedCount > this.lastSteeringFailureCount) {
      const latest = this.failureDigest.failedTools[this.failureDigest.failedTools.length - 1];
      if (latest) {
        const nextActions =
          Array.isArray(latest.next_actions) && latest.next_actions.length > 0
            ? `\n建议下一步：${latest.next_actions.join("；")}`
            : "";
        pushHint(
          `刚刚有工具执行失败：${latest.name}（${latest.error}）。` +
            (latest.message ? `失败原因：${latest.message}。` : "") +
            "请先根据失败结果修复参数、补足前置条件或改用合适工具，不要重复同一失败调用。" +
            nextActions,
          ["tool_failure_repair"],
        );
      }
      this.lastSteeringFailureCount = this.failureDigest.failedCount;
    }
```

**修改后（L904-920）**：

```typescript
    if (this.failureDigest.failedCount > this.lastSteeringFailureCount) {
      const failures = this.failureDigest.failedTools;
      const latest = failures[failures.length - 1];
      if (latest) {
        // 统计尾部连续同工具失败次数（只按 name，不比较 error 文本，避免动态内容干扰）
        let consecutive = 1;
        for (let i = failures.length - 2; i >= 0; i -= 1) {
          if (failures[i].name !== latest.name) break;
          consecutive += 1;
        }

        const nextActions =
          Array.isArray(latest.next_actions) && latest.next_actions.length > 0
            ? `\n建议下一步：${latest.next_actions.join("；")}`
            : "";

        if (consecutive < MAX_TOOL_FAILURE_REPAIR_SERIES) {
          // 正常修复提示（前 1~2 次）
          pushHint(
            `刚刚有工具执行失败：${latest.name}（${latest.error}）。` +
              (latest.message ? `失败原因：${latest.message}。` : "") +
              "请先根据失败结果修复参数、补足前置条件或改用合适工具，不要重复同一失败调用。" +
              nextActions,
            ["tool_failure_repair"],
          );
        } else if (consecutive === MAX_TOOL_FAILURE_REPAIR_SERIES) {
          // 达到上限，明确要求放弃该工具
          pushHint(
            `工具 ${latest.name} 已连续 ${consecutive} 次失败（${latest.error}）。` +
              (latest.message ? `失败原因：${latest.message}。` : "") +
              "请不要再调用该工具；改为向用户说明当前限制或外部系统故障，" +
              "并尝试使用其他可用工具或调整任务范围，如仍无法完成，请诚实说明本轮任务无法完成。" +
              nextActions,
            ["tool_failure_give_up"],
          );
        }
        // consecutive > MAX_TOOL_FAILURE_REPAIR_SERIES: 不再注入任何 hint，
        // 从 runtime 侧彻底停止驱动 "再试一次" 的循环
      }
      this.lastSteeringFailureCount = this.failureDigest.failedCount;
    }
```

### Fix 2（P0）：`_detectAssistantAskingUser` 全局化提前

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
**位置**：`_getFollowUpMessages()` L1027 处（softGuidance 调用前）插入 + L1068-1073 处（旧提问检测）删除

**改动原理**：将"Agent 是否在向用户提问"的检测从 `pending_todo` 分支提升到所有 softGuidance 之前，使其对 `tool_failure_repair`、`execution_contract_enforce`、`delivery_latch_active` 等所有软提示生效。

**在 L1026 之后、L1028 之前插入**：

```typescript
    // 如果模型最后一条消息正在向用户提问/等待确认，则认为当前回合应交还控制权给用户，
    // 不再追加任何软提示或追问，避免在"等待用户"场景下继续自言自语重试工具。
    const lastText = this._getLastAssistantText();
    if (lastText && this._detectAssistantAskingUser(lastText)) {
      return [];
    }
```

**删除 L1068-1073 的旧检测代码**：

```typescript
    // 删除以下代码（已被上方全局版替代）：
    // const lastText = this._getLastAssistantText();
    // if (lastText && this._detectAssistantAskingUser(lastText)) {
    //   return [];
    // }
```

**注意**：`style_workflow_followup`（L971-1006）在更前面的位置检测，有独立的 `workflowRetryBudget` 预算控制，不受此改动影响。`hasWaiting` 判断（L1066）也在提问检测之前，同样不受影响。

### Fix 3（保留，不改动）：v1 预消耗守卫 L1021-1026

保留 L1021-1026 作为冗余安全层。在 Fix 1 的连续失败限流生效后，此守卫的实际作用已很小，但不引入新分支、不增加复杂度，保留以兜底未来可能的边缘路径。

## 同类受害者分析

| softGuidance / followUp | 是否有退出机制 | 状态 |
|------------------------|--------------|------|
| `tool_failure_repair` | ❌ 无限触发 → **本次修复** | Fix 1 解决 |
| `style_workflow_followup` | ✅ workflowRetryBudget 限流 | 安全 |
| `execution_contract_enforce` | ✅ 配合 _enforceTurnLevelGuards 硬退出 | 安全 |
| `delivery_latch_active` | ⚠️ 写入失败进入 failureDigest → **被 Fix 1 兜住** | Fix 1 附带解决 |
| `delivery_latch_followup` | ✅ 只在 softGuidance 为空时触发 | 安全 |
| `pending_todo` | ✅ hasWaiting + _detectAssistantAskingUser 检测 | 安全 |
| `plan_no_execution` | ✅ 条件苛刻（hasPlanCommitment && !hasAnyToolCall） | 安全 |

## 架构隐患清单

| 严重度 | 隐患 | 说明 |
|--------|------|------|
| A | `consecutiveTextOnlyTurns` 的设计假设与 ReAct 实际行为不匹配 | v1-v3 修复都依赖此计数器，但 Agent 在 hint 驱动下几乎不产生"纯文本回合"。本次通过连续失败限流绕过了这个问题，但未来如果新增依赖此计数器的逻辑，需警惕同类陷阱 |
| B | `failureDigest.failedTools` 数组持续增长 | 当前 run 内所有失败都追加到此数组，极端场景下可能累积大量条目。短期影响不大（maxTurns 限制了总量），长期考虑是否需要 rotation |
| C | `_detectAssistantAskingUser` 依赖启发式正则 | 中文+英文的提问检测不可能覆盖所有句式，存在漏判。但在"宁可多停一次，也不要多跑一轮"的设计原则下，当前精度可接受 |

## 验证 checklist

### 回归场景

| 场景 | 预期行为 | 验证方式 |
|------|---------|---------|
| MCP 工具不可达，连续调用 3+ 次 | 前 2 次 `tool_failure_repair`，第 3 次 `tool_failure_give_up`，之后不再注入 hint | 模拟 MCP server 不可达 |
| 可修复参数错误，第 2 次修正成功 | 第 1 次 `tool_failure_repair`，第 2 次成功，无多余 hint | 正常工具调用 |
| delivery latch 重复写入 3+ 次 | 同上限流行为 | 连续对同一文件 write |
| Agent 在文本中向用户提问 | 不注入 softGuidance，run 自然结束 | 检查 _detectAssistantAskingUser |
| style_imitate 闭环未完成 | 仍由 workflowRetryBudget 控制，不受影响 | 写作任务 + style skill |
| A 工具失败 → B 工具失败 → A 工具失败 | A 的连续计数重置为 1（中间有 B） | 混合工具失败 |
| 纯文本回合 2+ 轮后自然收口 | 隐式完成（L1014）正常工作 | Agent 连续 2 轮只输出文本 |

### 测试命令

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

## 实施优先级

1. **P0**：Fix 1（连续失败限流）+ Fix 2（提问检测全局化）— 同一次提交
2. **保留**：Fix 3（v1 守卫不改动）

## 涉及文件清单

| 文件 | 行号范围 | 改动类型 |
|------|---------|---------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | L103 | 新增常量 `MAX_TOOL_FAILURE_REPAIR_SERIES` |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | L904-920 | 重写：连续失败限流逻辑 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | L1027（插入） | 新增：`_detectAssistantAskingUser` 全局早退 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | L1068-1073 | 删除：旧的 pending_todo 内提问检测 |
