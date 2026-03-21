# fix-lint-style-degraded-loop-v1

> lint.style 降级后 Agent 死循环重试 + LLM 继承缺失 + maxTokens 不足

## 现象

用户使用 `@风格库` 写作时，lint.style 因上游超时返回降级结果后：
1. Agent 反复重试 lint.style（"先对 v2 跑 lint.style 复检" → "再试一次"），即使已声明"跳出阻塞"
2. 尝试 `edit` 工具时因编造无效行号范围导致 `INVALID_RANGE` 失败
3. lint.style 本身持续超时，从未成功返回有效结果

## 根因分析

### 根因 1（S 级）：lint.style 被排除在 llmOverride 之外

**文件**：`GatewayRuntime.ts:1493-1495`

```typescript
llmOverride:
  toolName === "lint.style" || !this.config.runCtx.baseUrl ...
    ? null  // ← lint.style 永远不继承主 agent 的 LLM
```

lint.style 无法跟随用户选择的模型，被迫使用硬编码 `gpt-5.4`（resolveModel 后实际跑的是 `claude-sonnet-4-6`），在大 prompt 下频繁超时。

**修复**：commit `f7f7205` — 删除 `toolName === "lint.style" ||` 条件。

### 根因 2（S 级）：forcedLinterModelId 硬编码 "gpt-5.4"

**文件**：`index.ts:5655-5663`

之前 Claude 崩溃时的应急措施，已过时。

**修复**：commit `f7f7205` — 删除 `forcedLinterModelId`，改为标准优先级链。

### 根因 3（A 级）：stageMaxTokens 默认 null 导致 JSON 输出截断

**文件**：`index.ts:5645`

`st?.maxTokens ?? null` 传给 provider，lint.style 的复杂 JSON（issues + edits + dimensions + rewritePrompt）被截断，导致 `Expected ',' or '}' after property value in JSON at position 536`。

**修复**：commit `f7f7205` — 默认值改为 4096。

### 根因 4（S 级）：lint.style 降级后 orchestrator 不放行，死循环

**文件**：
- `styleOrchestrator.ts:53-78` — `buildStyleSnapshot()` 不检查 `lintGateDegraded`
- `GatewayRuntime.ts:996-1034` — `styleCompleted` 不含降级判定

三路同时推动重试但都不检查降级标记：
1. `buildStyleSnapshot()` → phase 永远卡在 `need_style_lint`
2. `computeStyleTurnCaps()` → 工具白名单锁定 lint.style/edit/write
3. `_getFollowUpMessages()` → 注入 `style_workflow_followup` runtime_hint

**修复**：commit `ac051e8` — `lintGateDegraded` 视为 `styleLintAccepted`，phase 跳到 completed。

### 根因 5（A 级）：hasLlmOverride 时 resolveModel 覆盖透传配置

**文件**：`index.ts:6239`

for 循环内 `resolveModel(mid)` 会用 DB 配置覆盖 llmOverride 的 baseUrl/apiKey。

**修复**：commit `f7f7205` — `if (!hasLlmOverride && mid)` 短路。

### 根因 6（B 级）：edit INVALID_RANGE

Agent 在 `need_style_lint` 阶段被迫改稿时，基于 degraded rewritePrompt 自行编造 edits 坐标。
根因 4 修复后（不再卡在 need_style_lint），此问题自然减轻。

## 修复方案

| Commit | 文件 | 改动 |
|--------|------|------|
| `f7f7205` | `GatewayRuntime.ts:1493` | 删除 lint.style 排除条件，继承主 agent LLM |
| `f7f7205` | `index.ts:5645` | `stageMaxTokens` 默认 4096 |
| `f7f7205` | `index.ts:5655-5681` | 删除 forcedLinterModelId + gpt-5.4 硬编码 |
| `f7f7205` | `index.ts:6239` | hasLlmOverride 时跳过 resolveModel |
| `ac051e8` | `styleOrchestrator.ts:53-78` | buildStyleSnapshot 纳入 lintGateDegraded |
| `ac051e8` | `GatewayRuntime.ts:1003-1008` | styleCompleted 纳入降级判定 |

## 行为矩阵

### lint.style LLM 选择

| 场景 | lint.style 用什么模型 |
|------|---------------------|
| 主 agent 有 LLM 配置 | 跟主 agent 同款（via llmOverride） |
| 无主 agent 配置 + 有 LLM_LINTER_MODEL env | env 指定的模型 |
| 无主 agent 配置 + 无 env + 有 stage | stage 配置 |
| 全都没有 | 报 LLM_NOT_CONFIGURED |

### lint.style 降级后的编排行为

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| lint.style 超时降级 | phase=need_style_lint，死循环重试 | phase=completed，直接交付终稿 |
| lint.style 正常返回但 score<70 | 回炉改稿，受 LINT_MAX_REWORK 限制 | 不变 |

## 验证 checklist

1. `@风格库` 写作 → lint.style 超时降级 → Agent 应直接交付终稿，不再重试 lint.style
2. `@风格库` 写作 → lint.style 正常返回 score=50 → Agent 应按 rewritePrompt 改稿再检
3. 切换主 agent 模型 → lint.style 应使用同一模型
4. 不带风格库的普通写作 → 不受影响

## 涉及文件

- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/gateway/src/agent/styleOrchestrator.ts`
- `apps/gateway/src/index.ts`
