# fix-lint-style-degraded-loop-v2

> 全链路工具超时统一拉高至 10 分钟 + snapshot 一致性修复

## 背景

v1（commit f7f7205 + ac051e8）修复了 lint.style 降级后的死循环重试和 LLM 继承问题。用户再次报告同样症状，触发本轮深度复盘。

**核心发现**：用户报告的所有失败发生在 ac051e8 部署之前（旧进程 pid 537107），新进程中无任何 lint.style 调用。v1 修复尚未被实际验证。

## 根因分析

### 根因 1（已修复，待验证）：orchestrator 不检查 lintGateDegraded

**状态**：commit ac051e8 已部署，`dist/agent/runtime/GatewayRuntime.js` 和 `dist/agent/styleOrchestrator.js` 均包含 `lintGateDegraded` 检查。

**修复机制**（三路封堵）：
1. `buildStyleSnapshot()`: `styleLintAccepted = styleLintPassed || lintGateDegraded` → phase 跳到 completed
2. `computeStyleTurnCaps()`: phase=completed 时工具白名单只有 write/edit，**lint.style 被物理移除**
3. `_getFollowUpMessages()`: `styleCompleted` 纳入降级判定，不再注入 retry hint

### 根因 2（S 级）：全链路工具超时配置零散且偏低

lint.style 超时只是冰山一角。整个系统中**每种工具类 LLM 调用都有独立的超时配置**，默认值从 10 秒到 150 秒不等，分散在 gateway 和 desktop 的十几个位置。逐个调整是打地鼠游戏——修了 lint.style 的超时，split/card/playbook/genre 随时可能遇到同样问题。

**正确做法**：把所有工具类调用的超时统一拉高到 10 分钟（600,000ms），一劳永逸。

### 根因 3（B 级）：workflowSkills.ts snapshot 不一致

**文件**：`packages/agent-core/src/workflowSkills.ts:32-66`

`computeStylePhaseAndMissing` 只看 `styleLintPassed`，不看 `lintGateDegraded`。降级后 snapshot 仍显示 `need_style_lint`，与 orchestrator 的 `completed` 不一致。

## 修复方案

### Fix 1（S 级）：全链路超时统一至 600,000ms

#### 1.1 Gateway — LLM 工具调用超时

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| a | `apps/gateway/src/index.ts` | L625 | `60_000` | → `600_000` |
| b | `apps/gateway/src/index.ts` | L665 | `60_000` | → `600_000` |
| c | `apps/gateway/src/index.ts` | L5826 | `30_000`（upstreamTimeoutMs 上限） | → `600_000` |
| d | `apps/gateway/src/index.ts` | L3805 | `120_000`（LLM_SPLIT） | → `600_000` |
| e | `apps/gateway/src/index.ts` | L3980 | `120_000`（LLM_CARD） | → `600_000` |
| f | `apps/gateway/src/index.ts` | L4353 | `150_000`（LLM_PLAYBOOK） | → `600_000` |
| g | `apps/gateway/src/index.ts` | L4882 | `120_000`（LLM_PLAYBOOK batch） | → `600_000` |
| h | `apps/gateway/src/index.ts` | L5160 | `90_000`（LLM_GENRE） | → `600_000` |

```diff
# L625 — getLinterEnv lint.style 总超时
-    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 60_000;
+    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 600_000;

# L665 — getLinterEnv copy lint 兜底
-      : Number(process.env.LLM_LINTER_TIMEOUT_MS ?? 60_000);
+      : Number(process.env.LLM_LINTER_TIMEOUT_MS ?? 600_000);

# L5826 — upstreamTimeoutMs 默认上限
-  const upstreamTimeoutMsDefault = Math.max(10_000, Math.min(timeoutMs, 30_000));
+  const upstreamTimeoutMsDefault = Math.max(10_000, Math.min(timeoutMs, 600_000));

# L3805 — LLM_SPLIT_TIMEOUT_MS
-  ... : 120_000;
+  ... : 600_000;

# L3980 — LLM_CARD_TIMEOUT_MS
-  ... : 120_000;
+  ... : 600_000;

# L4353 — LLM_PLAYBOOK_TIMEOUT_MS
-  ... : 150_000;
+  ... : 600_000;

# L4882 — LLM_PLAYBOOK_TIMEOUT_MS (batch)
-  ... : 120_000;
+  ... : 600_000;

# L5160 — LLM_GENRE_TIMEOUT_MS
-  ... : 90_000;
+  ... : 600_000;
```

#### 1.2 Gateway — Anthropic Messages API 默认超时

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| i | `apps/gateway/src/llm/anthropicMessages.ts` | L438 | `90_000` | → `600_000` |

```diff
-  ... : 90_000;
+  ... : 600_000;
```

#### 1.3 Gateway — web.search / web.fetch 超时上限

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| j | `apps/gateway/src/agent/serverToolRunner.ts` | L224 | `clampInt(..., 1000, 120_000, 10_000)` | 上限 → `600_000` |
| k | `apps/gateway/src/agent/serverToolRunner.ts` | L319 | `clampInt(..., 1000, 120_000, 10_000)` | 上限 → `600_000` |

```diff
# L224 — web.search fetchWithTimeout
-  const timeoutMs = clampInt((init as any)?.timeoutMs, 1000, 120_000, 10_000);
+  const timeoutMs = clampInt((init as any)?.timeoutMs, 1000, 600_000, 10_000);

# L319 — web.fetch
-  const timeoutMs = clampInt((call?.args as any)?.timeoutMs, 1000, 120_000, 10_000);
+  const timeoutMs = clampInt((call?.args as any)?.timeoutMs, 1000, 600_000, 10_000);
```

#### 1.4 Desktop — WS stalled watchdog

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| l | `apps/desktop/src/agent/wsTransport.ts` | L501 | `180_000`（hard timeout） | → `660_000`（10min + 1min 余量） |
| m | `apps/desktop/src/agent/wsTransport.ts` | L508 | `120_000`（soft warning） | → `540_000`（9min，比 hard 早 2min 预警） |

```diff
# L501 — stalled hard timeout
-        if (ms >= 180_000) {
+        if (ms >= 660_000) {

# L508 — stalled soft warning
-        if (ms < 120_000 || stalledLogged) return;
+        if (ms < 540_000 || stalledLogged) return;
```

> 注意：WS stalled watchdog 必须 > 工具最大执行时间（600s），否则工具还没超时 WS 先断了。

#### 1.5 Desktop — MCP Search Server 超时

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| n | `apps/desktop/electron/mcp-servers/web-search.mjs` | L17 | `15_000`（SEARCH_TIMEOUT） | → `600_000` |
| o | `apps/desktop/electron/mcp-servers/web-search.mjs` | L18 | `10_000`（PAGE_TIMEOUT） | → `600_000` |
| p | `apps/desktop/electron/mcp-servers/bocha-search.mjs` | L17 | `15_000`（TIMEOUT_MS） | → `600_000` |

```diff
# web-search.mjs
-const SEARCH_TIMEOUT = 15_000;
-const PAGE_TIMEOUT = 10_000;
+const SEARCH_TIMEOUT = 600_000;
+const PAGE_TIMEOUT = 600_000;

# bocha-search.mjs
-const TIMEOUT_MS = 15_000;
+const TIMEOUT_MS = 600_000;
```

#### 1.6 Desktop — 子 Agent 预算超时

| # | 文件 | 行号 | 当前值 | 改动 |
|---|------|------|--------|------|
| q | `apps/desktop/src/state/marketplaceStore.ts` | L91 | `180_000`（默认 budget） | → `600_000` |
| r | `apps/desktop/src/state/marketplaceStore.ts` | L168 | `300_000`（上限 clamp） | → `600_000` |

```diff
# L91 — DEFAULT_SUB_AGENT_BUDGET
-  timeoutMs: 180_000,
+  timeoutMs: 600_000,

# L168 — toBudget clamp 上限
-    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(300_000, ...)) : ...,
+    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, Math.min(600_000, ...)) : ...,
```

#### 1.7 已满足 600s，无需改动

| 文件 | 当前值 | 说明 |
|------|--------|------|
| `GatewayRuntime.ts:87` | `TOOL_RESULT_TIMEOUT_MS = 600_000` | Desktop 工具结果等待 ✅ |
| `toolRegistry.ts` shell.exec / code.exec | `600_000` | 本地执行 ✅ |
| Vite proxy timeout | `600_000` | 开发环境 ✅ |

### Fix 2（B 级）：workflowSkills.ts snapshot 一致性

**文件**：`packages/agent-core/src/workflowSkills.ts`

```diff
   const hasStyleKbSearch = Boolean((state as any).hasStyleKbSearch);
   const hasDraftText = Boolean((state as any).hasDraftText);
   const copyLintPassed = Boolean((state as any).copyLintPassed);
   const styleLintPassed = Boolean((state as any).styleLintPassed);
+  const lintGateDegraded = Boolean((state as any).lintGateDegraded);
+  // 与 styleOrchestrator.buildStyleSnapshot 保持一致：
+  // 降级视为"已尽力，可放行"
+  const styleLintAccepted = styleLintPassed || lintGateDegraded;

   let currentPhase: string;
   if (!hasStyleKbSearch) currentPhase = "need_style_kb";
   else if (!hasDraftText) currentPhase = "need_draft";
   else if (!copyLintPassed) currentPhase = "need_copy_lint";
-  else if (!styleLintPassed) currentPhase = "need_style_lint";
+  else if (!styleLintAccepted) currentPhase = "need_style_lint";
   else currentPhase = "completed";

   const missingSteps: string[] = [];
   if (!hasStyleKbSearch) missingSteps.push("kb.search(style)");
   if (!hasDraftText) missingSteps.push("draft");
   if (!copyLintPassed) missingSteps.push("lint.copy");
-  if (!styleLintPassed) missingSteps.push("lint.style");
+  if (!styleLintAccepted) missingSteps.push("lint.style");
```

## 服务器 .env 同步

部署后需同步更新服务器 `.env`，删除或调高已过时的低值配置：

```bash
# 以下 env 变量的默认值已在代码中改为 600_000，
# 如果 .env 中有显式配置且值偏低，需删除或调高：
LLM_LINTER_TIMEOUT_MS=600000        # 原 120000
LLM_LINTER_UPSTREAM_TIMEOUT_MS=600000  # 原 120000
# 以下若 .env 中未配置则无需操作（代码默认值已改）：
# LLM_SPLIT_TIMEOUT_MS
# LLM_CARD_TIMEOUT_MS
# LLM_PLAYBOOK_TIMEOUT_MS
# LLM_GENRE_TIMEOUT_MS
```

## 改动总览

| # | 文件 | 改动点 | 当前值 | 目标值 |
|---|------|--------|--------|--------|
| a | `gateway/src/index.ts:625` | lint.style 总超时 | 60s | 600s |
| b | `gateway/src/index.ts:665` | copy lint 兜底 | 60s | 600s |
| c | `gateway/src/index.ts:5826` | upstream per-attempt 上限 | 30s | 600s |
| d | `gateway/src/index.ts:3805` | split 超时 | 120s | 600s |
| e | `gateway/src/index.ts:3980` | card 超时 | 120s | 600s |
| f | `gateway/src/index.ts:4353` | playbook 超时 | 150s | 600s |
| g | `gateway/src/index.ts:4882` | playbook batch 超时 | 120s | 600s |
| h | `gateway/src/index.ts:5160` | genre 超时 | 90s | 600s |
| i | `gateway/src/llm/anthropicMessages.ts:438` | Anthropic API 默认超时 | 90s | 600s |
| j | `gateway/src/agent/serverToolRunner.ts:224` | fetchWithTimeout 上限 | 120s | 600s |
| k | `gateway/src/agent/serverToolRunner.ts:319` | web.fetch 上限 | 120s | 600s |
| l | `desktop/src/agent/wsTransport.ts:501` | WS stalled hard | 180s | 660s |
| m | `desktop/src/agent/wsTransport.ts:508` | WS stalled soft | 120s | 540s |
| n | `desktop/electron/mcp-servers/web-search.mjs:17` | search timeout | 15s | 600s |
| o | `desktop/electron/mcp-servers/web-search.mjs:18` | page timeout | 10s | 600s |
| p | `desktop/electron/mcp-servers/bocha-search.mjs:17` | bocha timeout | 15s | 600s |
| q | `desktop/src/state/marketplaceStore.ts:91` | 子 Agent 默认 budget | 180s | 600s |
| r | `desktop/src/state/marketplaceStore.ts:168` | 子 Agent budget 上限 | 300s | 600s |
| s | `agent-core/src/workflowSkills.ts:32-66` | snapshot lintGateDegraded | — | Fix 2 |

## 与 v1 的关系

v1 的修复（f7f7205 + ac051e8）已覆盖核心问题：
- LLM 继承 ✅
- 死循环重试 ✅
- stageMaxTokens 默认值 ✅
- resolveModel 覆盖 ✅

v2 是 v1 的补充：
- 确认 v1 修复已正确部署
- **全链路超时统一拉高到 10 分钟**（S 级，一劳永逸）
- 修复 snapshot 不一致（B 级）

## 验证 checklist

1. **v1 修复验证**：
   - [ ] `@风格库` 写作 → lint.style 超时降级 → Agent 应直接交付终稿，不再重试
   - [ ] 确认日志中只有 1 次 lint.style 调用
   - [ ] 确认 Agent 最终调用 write 写入终稿

2. **超时统一验证**：
   - [ ] lint.style 不再出现 ~90s 超时（允许等待至 600s）
   - [ ] split/card/playbook/genre 调用不因超时而降级
   - [ ] web.search / web.fetch 可容忍慢速响应
   - [ ] WS 连接在工具执行期间不被 stalled watchdog 误断
   - [ ] 子 Agent 不因 budget timeout 过早中断

3. **正常路径回归**：
   - [ ] `@风格库` 写作 → lint.style 正常返回 → 按结果处理
   - [ ] 不带风格库的普通写作 → 不受影响

4. **Fix 2 验证**：
   - [ ] 降级后 workflowSkills snapshot 显示 phase=completed
