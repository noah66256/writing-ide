# Workflow RunState 跨 Run 持久化

状态：待实施 | 优先级：P0 | 日期：2026-03-17

## 0. 背景

### 问题

所有 workflow skill（style_imitate / style_imitate_v2）的 RunState **每次 run 从零开始**。用户写到一半被打断（max_turns / 手动取消 / 网络断连），下次 run 又从 `need_style_kb` 阶段重新走，已完成的 kb.search、draft、lint 全部浪费。

### 链路现状

```
Gateway runFactory.ts
  L3428: runState = createInitialRunState()           ← 每次从零
  L3441-3446: 从 contextPack 预设 mainDocLatest/hasTodoList 等
  L4761: initialRunState: runState → RunContext

GatewayRuntime.ts
  L583-585: this.runState = initialRunState ?? createInitialRunState()
  L2297-2540: _updateRunState() 每轮更新
  L2729: _buildExecutionReport() → { runState: this.runState }  ← ✅ 已包含完整 runState

runFactory.ts
  L4946: writeEvent("run.end", { executionReport })   ← ✅ 发给 Desktop

Desktop wsTransport.ts
  L1141: event === "run.end" → 处理结束逻辑
  ❌ 没有读取 data.executionReport.runState —— 完全丢弃
```

**链路到 Desktop 门口就断了。** Gateway 已经透传了完整 runState，Desktop 没有接收。

### 已有设施

Desktop 已有 `workflowV1` sticky 机制（`mainDoc.workflowV1`），通过 `updateWorkflowSticky()` 在 run 结束时保存 status/lastEndReason/routeId 等，下次 run 时通过 contextPack 的 mainDoc 传回 Gateway。Gateway 通过 `readWorkflowStickyState(mainDoc)` 读取。

这个机制只存了 workflow 路由级别的信息（routeId、status、selectedServerIds），不存 RunState 级别的状态（hasStyleKbSearch、copyLintPassed 等）。

---

## 1. 方案

### 核心思路

利用已有的 `mainDoc.workflowV1` 通道，新增一个 `runStatePatch` 字段，在 run 结束时保存需要持久化的 stateKey，下次 run 时 merge 进 initialRunState。

### 白名单机制

不是所有 RunState 字段都该持久化。按用途分三类：

| 类型 | 是否持久化 | 示例 |
|------|-----------|------|
| workflow 进度 | ✅ 持久化 | hasStyleKbSearch, hasDraftText, copyLintPassed, styleLintPassed, lintGateDegraded |
| 交付状态 | ✅ 持久化 | deliveryLatched, deliveredArtifactFamilies |
| per-run 计数/临时状态 | ❌ 不持久化 | webSearchCount, mcpToolCallCount, protocolRetryBudget, stickyToolNames |

白名单由 `PERSISTABLE_STATE_KEYS` 常量定义，只有在白名单中的 key 才会被保存和恢复。

### 清除时机

- `endReason === "completed"` 且无 `derivedWaitingPatch`：任务完成，清除 runStatePatch
- 用户发起明确的新任务（`looksLikeExplicitNewTaskPrompt` 为 true）：不使用 patch
- `workflowV1.isFresh === false`（超过 TTL）：不使用 patch

---

## 2. 改动点

### Fix 1: Desktop — run.end 时提取并存储 runStatePatch

**文件**: `apps/desktop/src/agent/wsTransport.ts`
**位置**: L1141-1164（`run.end` 事件处理块）

在现有 `updateWorkflowSticky()` 调用之后，新增 runStatePatch 提取：

```typescript
// ---- 现有代码 L1141-1164 不动 ----

// 新增：提取 workflow skill 的 runState patch
try {
  const report = data?.executionReport;
  const endRunState = report && typeof report === "object" ? (report as any).runState : null;
  if (endRunState && typeof endRunState === "object") {
    const patch: Record<string, unknown> = {};
    for (const key of PERSISTABLE_STATE_KEYS) {
      if (key in endRunState) patch[key] = (endRunState as any)[key];
    }
    if (Object.keys(patch).length > 0) {
      // completed 且无续跑需求时清除 patch
      const shouldClear = endReason === "completed" && !derivedWaitingPatch && !hitMaxTurns;
      updateWorkflowSticky({
        runStatePatch: shouldClear ? null : patch,
      });
    }
  }
} catch {
  // runStatePatch 提取失败不影响主流程
}
```

### Fix 2: Desktop — PERSISTABLE_STATE_KEYS 常量

**文件**: `apps/desktop/src/agent/wsTransport.ts`（文件顶部或抽到工具文件）

```typescript
/** workflow skill 的 RunState 中允许跨 run 持久化的字段白名单 */
const PERSISTABLE_STATE_KEYS: readonly string[] = [
  // style_imitate workflow 进度
  "hasStyleKbSearch",
  "hasStyleKbHit",
  "styleKbDegraded",
  "hasDraftText",
  "hasPostDraftStyleKbSearch",
  "copyLintPassed",
  "copyLintFailCount",
  "copyGateDegraded",
  "styleLintPassed",
  "styleLintFailCount",
  "lintGateDegraded",
  // 交付状态
  "deliveryLatched",
  "deliveredArtifactFamilies",
  // draft 候选集
  "draftCandidatesV1",
  "bestDraft",
  "bestStyleDraft",
  // lint 记录
  "lastStyleLint",
  "lastCopyLint",
];
```

### Fix 3: Gateway — 从 mainDoc 读 runStatePatch merge 进 initialRunState

**文件**: `apps/gateway/src/agent/runFactory.ts`
**位置**: L3428-3446（runState 创建之后）

```typescript
// ---- 现有代码 L3428-3432 不动 ----
const runState = createInitialRunState({
  protocolRetryBudget: 2,
  workflowRetryBudget: workflowRetryBudgetEffective,
  lintReworkBudget: lintMaxRework,
});

// 新增：从 mainDoc.workflowV1.runStatePatch 恢复 workflow 进度
const workflowSticky = readWorkflowStickyState(mainDocFromPack);
if (workflowSticky.isFresh) {
  const wfDoc = mainDocFromPack && typeof mainDocFromPack === "object"
    ? (mainDocFromPack as any)?.workflowV1 : null;
  const patch = wfDoc && typeof wfDoc === "object" ? (wfDoc as any).runStatePatch : null;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    // 仅恢复白名单字段，防止脏数据注入
    for (const key of PERSISTABLE_STATE_KEYS) {
      if (key in patch && key in runState) {
        (runState as any)[key] = (patch as any)[key];
      }
    }
  }
}

// ---- 现有代码 L3434+ 不动 ----
```

### Fix 4: Gateway — PERSISTABLE_STATE_KEYS 常量（共享）

**文件**: `packages/agent-core/src/runMachine.ts`（导出，Desktop 和 Gateway 共用）

```typescript
/**
 * workflow skill 的 RunState 中允许跨 run 持久化的字段白名单。
 * 只有在此白名单中的 key 才会被 Desktop 保存到 mainDoc.workflowV1.runStatePatch，
 * 并在下次 run 时被 Gateway merge 进 initialRunState。
 */
export const PERSISTABLE_STATE_KEYS: readonly string[] = [
  "hasStyleKbSearch",
  "hasStyleKbHit",
  "styleKbDegraded",
  "hasDraftText",
  "hasPostDraftStyleKbSearch",
  "copyLintPassed",
  "copyLintFailCount",
  "copyGateDegraded",
  "styleLintPassed",
  "styleLintFailCount",
  "lintGateDegraded",
  "deliveryLatched",
  "deliveredArtifactFamilies",
  "draftCandidatesV1",
  "bestDraft",
  "bestStyleDraft",
  "lastStyleLint",
  "lastCopyLint",
] as const;
```

注意：Desktop 和 Gateway 各自 import 这个常量。Desktop 通过 `@ohmycrab/agent-core` 包引用。

### Fix 5: 新任务时跳过 patch

**文件**: `apps/gateway/src/agent/runFactory.ts`
**位置**: Fix 3 的条件中

已有 `looksLikeExplicitNewTaskPrompt(userPrompt)` 函数。在 merge patch 时加一层判断：

```typescript
const isNewTask = looksLikeExplicitNewTaskPrompt(String(userPrompt ?? "").trim());
if (workflowSticky.isFresh && !isNewTask) {
  // ... merge patch
}
```

---

## 3. 数据流

```
Run N（被打断）:
  Gateway _buildExecutionReport() → { runState: { hasStyleKbSearch: true, hasDraftText: true, copyLintPassed: false, ... } }
  → writeEvent("run.end", { executionReport })
  → Desktop wsTransport.ts: 提取 runStatePatch = { hasStyleKbSearch: true, hasDraftText: true, ... }
  → updateWorkflowSticky({ runStatePatch })
  → mainDoc.workflowV1.runStatePatch = { hasStyleKbSearch: true, hasDraftText: true, ... }

Run N+1（续跑）:
  Desktop buildContextPack() → mainDoc（含 workflowV1.runStatePatch）
  → Gateway runFactory.ts: readWorkflowStickyState → isFresh=true
  → merge patch 进 initialRunState
  → GatewayRuntime: this.runState = { ...initialRunState }（hasStyleKbSearch=true, hasDraftText=true）
  → WorkflowPhaseInterpreter: resolvePhase() → 直接进入 need_copy_lint 阶段
```

---

## 4. 边界情况

| 场景 | 行为 |
|------|------|
| run 正常 completed + 无续跑 | runStatePatch 被清除（`shouldClear = true`） |
| run 被 max_turns 打断 | runStatePatch 保留，下次续跑 |
| run 被用户手动取消 | runStatePatch 保留（endReason 不是 completed） |
| workflowV1 过期（超 TTL） | `isFresh=false`，不使用 patch |
| 用户说"帮我写一篇新的" | `looksLikeExplicitNewTaskPrompt=true`，不使用 patch |
| patch 中有脏数据/旧字段 | 只恢复 `PERSISTABLE_STATE_KEYS` 白名单中且 runState 中存在的 key |
| 非 workflow skill run | runState 中无 workflow 字段为 true，patch 全 false，等于没 merge |
| Gateway 升级新增 stateKey | 旧 patch 中无该 key，不影响（`key in patch` 为 false） |
| Desktop 版本旧不发 patch | Gateway 侧 `patch` 为 null/undefined，跳过 merge |

---

## 5. 影响范围

| 改动 | 影响范围 | 风险 |
|------|---------|------|
| Desktop run.end 提取 patch | 只在 run.end handler 末尾新增逻辑 | 低：try/catch 包裹，失败不影响主流程 |
| updateWorkflowSticky 加 runStatePatch 字段 | mainDoc.workflowV1 结构 | 低：纯新增字段，不影响现有 reader |
| Gateway merge patch 进 initialRunState | createInitialRunState 之后、现有预设之前 | 低：白名单过滤，且现有预设（hasTodoList 等）在后面会覆盖 |
| PERSISTABLE_STATE_KEYS 导出 | agent-core 包公共 API | 低：纯新增导出 |

---

## 6. 验证 checklist

### 场景验证

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| style_imitate_v2: kb.search 完成后 max_turns 打断 | 下次 run 跳过 need_style_kb，直接进 need_draft | 检查 GatewayRuntime 首轮 resolvePhase 输出 |
| style_imitate_v2: draft 完成后用户手动取消 | 下次 run 跳过 need_style_kb 和 need_draft，直接进 need_copy_lint | 同上 |
| 正常 completed run 后再发新消息 | runStatePatch 已清除，从零开始 | 检查 mainDoc.workflowV1.runStatePatch === null |
| 用户说"写一篇新文章" | 不使用 patch，从零开始 | 检查 looksLikeExplicitNewTaskPrompt 返回 true |
| 非 workflow run（普通聊天） | 无 patch，行为不变 | runState 无 workflow 字段变化 |
| workflowV1 超 TTL 后续跑 | 不使用 patch，从零开始 | 检查 isFresh === false |

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

| 文件 | 改动类型 | 改动范围 |
|------|---------|---------|
| `packages/agent-core/src/runMachine.ts` | 新增导出 | `PERSISTABLE_STATE_KEYS` 常量 |
| `apps/desktop/src/agent/wsTransport.ts` | 新增逻辑 | run.end handler 末尾提取 runStatePatch |
| `apps/gateway/src/agent/runFactory.ts` | 新增逻辑 | createInitialRunState 后 merge patch（~10 行） |

总改动量：约 40-50 行新增代码，零修改现有逻辑。
