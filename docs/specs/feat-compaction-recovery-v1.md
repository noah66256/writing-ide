# feat: 对齐 CC 的 compaction 熔断 + max_tokens 续写 + loading 文案

> 终点是 spec 文档，不写代码。

---

## 需求卡片

**场景**：长对话中 context summary 超时（502），无熔断每轮重试白等 3 分钟；大文件写入 max_tokens 截断后 loop 卡死。

**目标**：
- P0: context summary 熔断 + 30s 超时 + loading 文案准确
- P1: max_tokens 续写（对标 CC 的 "Resume directly" 机制）

**对标**：Claude Code（HitCC 逆向文档）
- `consecutiveFailures >= 3` 熔断
- `max_output_tokens` → 注入 "Resume directly" → 最多 3 次

---

## 现状分析

### 当前问题链

```
问题 1（P0）：
context summary API 超时 (302s) → 502 → 无熔断 → 下一轮重试 → 又超时 → 每轮白等 3 分钟

问题 2（P1）：
模型 Write 大文件 → max_tokens 截断 → tool call JSON 不完整 → 被丢弃
→ pi-agent-core 认为无 tool call → getFollowUpMessages 返回空
→ consecutiveTextOnlyTurns++ → implicit_completion 触发 → "已完成"但实际没完成
```

### pi-agent-core 的 stopReason 处理

- Anthropic `stop_reason: "max_tokens"` → pi-ai 映射为 `stopReason: "length"`
- pi-agent-core 对 `"length"` **不退出 loop**（只有 "error" 和 "aborted" 才退出）
- loop 会自动进入下一轮，通过 `getFollowUpMessages` 注入消息

### 关键行号

| 文件 | 行号 | 职责 |
|------|------|------|
| `gatewayAgent.ts:2671` | rollDialogueSummaryIfNeeded | **P0: 加熔断** |
| `gatewayAgent.ts:2624` | fetchContextSummaryOnce | **P0: 加 30s 超时** |
| `wsTransport.ts:1258` | 摘要调用入口 | **P0: 改 loading 文案** |
| `GatewayRuntime.ts:message_end` | L3805 | **P1: 记录 lastStopReason** |
| `GatewayRuntime.ts:turn_end` | L4026 | **P1: length recovery 短路** |
| `GatewayRuntime.ts:_getFollowUpMessages` | L2068 | **P1: 注入续写提示** |

---

## 实施方案

### P0-1: Context summary 熔断 + 超时

**文件**：`apps/desktop/src/agent/gatewayAgent.ts`

#### 新增模块顶层熔断状态

```typescript
type SummaryFuseState = { consecutiveFailures: number; lastFailureTs: number };
const SUMMARY_FUSE_MAX = 3;
const SUMMARY_FUSE_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟
const SUMMARY_FETCH_TIMEOUT_MS = 30_000;         // 30 秒超时
const summaryFuseByKey = new Map<string, SummaryFuseState>();
```

Key 格式：`"gatewayUrl::mode::modelId"`，避免跨 session 误伤。

#### `rollDialogueSummaryIfNeeded()` 加熔断检查

在 `if (!preferModelId)` 之后、`args.log("info", "context.summary.roll")` 之前：

```typescript
const fuseKey = getSummaryFuseKey({ gatewayUrl, mode, preferModelId });
const fuse = readSummaryFuse(fuseKey);
if (fuse.fused) {
  args.log("info", "context.summary.fused", { failures: fuse.failures });
  return { ok: true, rolled: false };
}
```

成功时 `noteSummaryFuseSuccess(fuseKey)` 删除 key。
失败时 `noteSummaryFuseFailure(fuseKey)` 累加 failures。

#### `fetchContextSummaryOnce()` 加 30s 超时

用 `AbortController` + `setTimeout(30s)` 包裹 fetch，超时返回 `{ ok: false, error: "SUMMARY_TIMEOUT" }`。

---

### P0-2: Loading 文案改进

**文件**：`apps/desktop/src/agent/wsTransport.ts`

在 `rollDialogueSummaryIfNeeded` 调用前：
```typescript
setActivity("正在压缩上下文…", { resetTimer: true });
```

在 finally 中恢复：
```typescript
setActivity("正在构建上下文…", { resetTimer: false });
```

---

### P1-1: max_tokens 续写机制

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

#### 新增实例字段

```typescript
private lastStopReason: string | null = null;
private pendingMaxTokensRecovery = false;
private maxTokensRecoveryCount = 0;
private readonly MAX_TOKENS_RECOVERY_LIMIT = 3;
```

`_reset()` 中清零。

#### `message_end` 事件中设置 recovery flag

在 `_pushAssistantToTranscript(msg)` 之前：

```typescript
this.lastStopReason = msg.stopReason ?? null;
if (msg.stopReason === "length" && !hasToolCall) {
  this.pendingMaxTokensRecovery = this.maxTokensRecoveryCount < this.MAX_TOKENS_RECOVERY_LIMIT;
} else {
  this.pendingMaxTokensRecovery = false;
  this.maxTokensRecoveryCount = 0;
}
```

#### `turn_end` 中短路

在 implicit_completion 检查之前：

```typescript
// max_tokens 续写：不让 no-tool guard 和 implicit_completion 参与
if (this.pendingMaxTokensRecovery && this.currentTurnToolCalls === 0) {
  this.consecutiveTextOnlyTurns = 0; // 重置，避免 implicit_completion
  return; // 跳过所有 guard，让 loop 继续
}
```

#### `_getFollowUpMessages()` 注入续写提示

在方法开头（所有现有逻辑之前）：

```typescript
if (this.pendingMaxTokensRecovery) {
  this.pendingMaxTokensRecovery = false;
  this.lastStopReason = null;
  this.maxTokensRecoveryCount += 1;
  const item: CanonicalTranscriptItem = {
    kind: "runtime_hint",
    text: "上一轮输出因达到 token 上限被截断。请从中断处直接继续，不要道歉，不要回顾，不要重述。",
    reasonCodes: ["max_tokens_recovery"],
  };
  return [item as unknown as AgentMessage];
}
```

---

## 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| 熔断 Map + 超时 | Desktop 摘要调用 | 低：静默跳过，不阻塞 run | 5 分钟后自动恢复 |
| Loading 文案 | UI 显示 | 无风险 | — |
| lastStopReason 字段 | GatewayRuntime 实例 | 低：新增字段，不影响现有 | reset 清零 |
| turn_end 短路 | implicit_completion | 中：length 续写时跳过 guard | 3 次上限兜底 |
| _getFollowUpMessages 注入 | agent loop 续 turn | 中：续写可能产出不完整内容 | 3 次上限 + 续写提示明确要求续写 |

**不受影响的功能**：
- 正常对话（非长对话不触发 summary）
- 短文件写入（不触发 max_tokens）
- tool call 正常完成的 turn（stopReason != "length"）
- run.done 结束流程

---

## 验证 Checklist

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| summary 连续 3 次 502 | 第 4 次静默跳过，日志 `context.summary.fused` | 模拟服务端 502 |
| summary 熔断后 5 分钟 | 自动恢复重试 | 等 5 分钟后再试 |
| summary 超时 | 30 秒后返回 `SUMMARY_TIMEOUT`，不再等 300 秒 | 模拟慢响应 |
| loading 文案 | "正在压缩上下文…" → "正在构建上下文…" → "正在请求模型…" | 观察 UI |
| 模型写大文件被截断 | 自动注入续写提示，继续输出 | Write 一个 2 万字文件 |
| 续写 3 次后仍未完成 | 正常结束（不再续写） | 观察日志 |
| 正常短文件写入 | 行为不变（不触发续写） | 正常使用 |

---

## 实施优先级

1. **P0**（立竿见影）：熔断 + 超时 + 文案 — 止血，用户不再白等
2. **P1**（跟进）：max_tokens 续写 — 解决大文件写入卡死
3. **P2**（后续）：compaction 移到 loop 内部（对标 CC 架构，大改动）
4. **P2**：PiLoopKernel 从 raw agentLoop 收敛到 barriered Agent 接法

---

## 涉及文件清单

| 文件 | 改动类型 |
|------|---------|
| `apps/desktop/src/agent/gatewayAgent.ts` | 熔断状态 + 超时 + 熔断检查 |
| `apps/desktop/src/agent/wsTransport.ts` | loading 文案 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | lastStopReason + recovery flag + 续写注入 |
