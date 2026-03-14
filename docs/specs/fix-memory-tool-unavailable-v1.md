# 修复 memory 工具（及核心工具）频繁不可用

> 状态：Fix 1-3 已部署(a5448da) + Fix 5 已实施 | 优先级：P0 | 日期：2026-03-14

## 0. 现象

用户反馈 `memory` 工具在 agent run 中频繁不可用，收到两类错误：

- `TOOL_NOT_ALLOWED_THIS_TURN`：工具被 per-turn gating 拦截（**已通过 commit a5448da 修复**）
- `UNKNOWN_TOOL`：Desktop 端找不到工具定义（**根因：GatewayRuntime 缺少合并工具名展开**）

### UNKNOWN_TOOL 的独立根因（Fix 5）

`UNKNOWN_TOOL` 错误来自 Desktop `toolRegistry.ts:4232-4239`，与 per-turn gating 无关：

- LLM 看到的合并工具名是 `memory`（带 `action: "read"|"update"` 参数）
- 旧版 `writingAgentRunner.ts` 有 `MERGED_TOOL_MAP` + `expandMergedToolName()`，在发送到 Desktop 前把 `memory` 展开为 `memory.read` / `memory.update`
- 新版 `GatewayRuntime` 迁移时**遗漏了这个映射**，直接发送 `name: "memory"` 到 Desktop
- Desktop 只注册了 `memory.read` 和 `memory.update`，找不到 `memory` → 返回 `UNKNOWN_TOOL`
- 同样受影响的还有 `doc.snapshot`（需展开为 `doc.commitSnapshot/listSnapshots/restoreSnapshot`）

---

## 1. 根因分析

### 1.1 主根因：execution boot phase 遗漏核心工具

**文件**：`apps/gateway/src/agent/runFactory.ts:3550-3673`

`computePerTurnAllowed` 闭包中的"执行启动阶段 boot"逻辑，在首轮工具调用前（`executionContract.required && !state.hasAnyToolCall`），构造一个硬编码的 boot 候选列表，然后**完全替换** `effectiveAllowed`。

```
executionContract.required && !state.hasAnyToolCall
  → 构造 boot 集合（仅含 run.*/time.*/web.*/kb.search/write 等）
  → allowed = boot（完全替换！）
  → memory 及其他 CORE_TOOLS 被排除
```

**触发条件**：
- route 是 `task_execution` / `file_ops` / `web_radar` 等执行路由
- `executionContract.required === true`（大多数 "让 Agent 干活" 的场景）
- 当前 run 尚无工具调用：`runState.hasAnyToolCall === false`

这覆盖了几乎所有 agent.run 的首轮。

### 1.2 次要根因：hasAnyToolCall 语义缺陷

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1762-1769`

`_updateRunState` 在所有工具调用（包括被 gate 拦截的失败调用）后都将 `hasAnyToolCall` 置为 `true`。这导致：

- boot 阶段剪掉 memory → LLM 调 memory 被拒 → `hasAnyToolCall = true`
- ExecutionContract 认为"已执行过工具"（即使是失败的）→ 不再强制继续调工具
- run 在 1-2 回合内就被视为完成，memory 始终没有机会被使用

### 1.3 次要根因：自愈机制作用范围极窄

**文件**：`apps/gateway/src/agent/runFactory.ts:3439-3452`

`lastToolNotAllowedName → healTools` 自愈机制仅在**同一个 run 的下一轮**生效：

- 每个 `/api/agent/run` 重新初始化 RunState，自愈状态不跨 run
- 大部分 "帮我记一下" 请求是单/双回合 run，自愈没有触发窗口
- 错误文案 "当前阶段不可用，请使用其他工具" 反激励 LLM 重试同一工具

### 1.4 commit 93f5240 为什么没有完全修复

该 commit 修复的是 **style orchestrator 路径**（`computeStyleTurnCaps`），在 `styleOrchestrator.ts` 中添加了 `CORE_TOOL_NAME_SET` 兜底。

但 style orchestrator 在 `computePerTurnAllowed` 中是一个**提前返回**路径（L3502-3513）。当 `style_imitate` 不活跃时（非写作任务 / 无风格库），代码走的是后续的 **boot 路径**（L3550-3673），该路径完全不受 93f5240 修复影响。

### 1.5 两套核心工具常量不同步

| 常量 | 位置 | 工具数 | 含 memory |
|------|------|--------|-----------|
| `CORE_TOOL_NAME_SET` | `coreTools.ts:3-37` | 26 | ✅ |
| `CORE_WORKFLOW_TOOL_NAMES` | `runFactory.ts:250-259` | 8 | ❌ |
| `ALWAYS_ALLOW_TOOL_NAMES`（基于 CORE_WORKFLOW） | `runFactory.ts:3386` | ≤8 | ❌ |
| boot 集（多个硬编码数组） | `runFactory.ts:3555-3643` | 变化 | ❌ |

`ALWAYS_ALLOW_TOOL_NAMES` 本应是 per-turn 层的核心工具兜底机制，但：
1. 基于 `CORE_WORKFLOW_TOOL_NAMES`（不含 memory）构造
2. 在 `computePerTurnAllowed` 中**完全没被使用**，只存在于 `prepared` 返回值中

---

## 2. 影响范围

### 2.1 受影响的核心工具

以下 `CORE_TOOL_NAME_SET` 工具在所有 boot 集中均缺席，首轮会被 boot 完全剪掉：

| 工具 | 典型用户场景 | 首轮表现 |
|------|-------------|---------|
| `memory` | "帮我记一下这个决策" | TOOL_NOT_ALLOWED_THIS_TURN |
| `kb.listLibraries` | "先看看有哪些知识库" | TOOL_NOT_ALLOWED_THIS_TURN |
| `run.done` | 快速单步任务 | TOOL_NOT_ALLOWED_THIS_TURN |
| `edit` | "帮我改一下这段" | TOOL_NOT_ALLOWED_THIS_TURN |
| `doc.previewDiff` | "先看看 diff 提案" | TOOL_NOT_ALLOWED_THIS_TURN |
| `doc.snapshot` | 快照操作 | TOOL_NOT_ALLOWED_THIS_TURN |
| `doc.splitToDir` | 拆分文件 | TOOL_NOT_ALLOWED_THIS_TURN |
| `mkdir` | 创建目录 | TOOL_NOT_ALLOWED_THIS_TURN |
| `rename` | 重命名文件 | TOOL_NOT_ALLOWED_THIS_TURN |
| `file.open` | "用默认应用打开这个文件" | TOOL_NOT_ALLOWED_THIS_TURN |

### 2.2 MCP 工具同样受影响

`bootCandidates` 仅覆盖极少数浏览器 MCP 工具（browser_navigate / web_search 回退链）。其他所有用户配置的 MCP 工具在首轮也会从 `effectiveAllowed` 中消失。

### 2.3 memory 工具路由补充

Codex 确认 `memory` 被路由到 Desktop 执行（`serverToolRunner.ts` 的 `GATEWAY_SERVER_TOOL_ALLOWLIST` 不含 memory，返回 `executedBy: "desktop"`）是**合理设计**——memory 数据完全存在 Desktop 本地：
- L1 全局记忆：`userData/memory/global.md`
- L2 项目记忆：`<projectRoot>/.ohmycrab/project-memory.md`

问题不在路由层，纯在 per-turn gating 层（`_executeAgentTool` L1140-1166 在到达路由之前就拦截了调用）。

---

## 3. 修复方案

### Fix 1：boot 逻辑兜底 CORE_TOOLS（P0）

**文件**：`apps/gateway/src/agent/runFactory.ts`

**原理**：在 toolDiscoveryBoot 和执行 boot 的 `boot` 集构建后，union `CORE_TOOL_NAME_SET ∩ allowedNow`，确保核心工具不被首轮剪掉。

#### 1a. toolDiscoveryBoot 分支（约 L3554-3575）

在 `boot` 构建后、return 前，插入 CORE_TOOLS 兜底：

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ toolDiscoveryBoot 分支（约 L3570 后）
         .filter(Boolean)
         .filter((n) => allowedNow.has(n)),
       );
+      // 兜底：工具发现启动阶段也不应剪掉 CORE_TOOLS（包括 memory / run.* / 基础读写等）。
+      // 只要这些工具在本轮基线 allowedNow 中，就强制并入 boot 集。
+      if (boot.size > 0) {
+        for (const name of CORE_TOOL_NAME_SET) {
+          if (allowedNow.has(name)) boot.add(name);
+        }
+      }
-      hints.push("工具发现契约：...");
-      return { allowed: boot.size ? boot : allowedNow, hint: hints.join("\n\n") };
+      hints.push("工具发现契约：用户明确表示不知道用哪些工具时，必须先 tools.search（必要时再 tools.describe），再继续执行。当前已将本回合工具收敛到工具发现启动集（CORE_TOOLS 始终保留）。");
+      return { allowed: boot.size ? boot : allowedNow, hint: hints.join("\n\n") };
```

#### 1b. 执行 boot 分支（约 L3668-3673）

在 `if (boot.size > 0) { allowed = boot; }` 之前，插入 CORE_TOOLS 兜底：

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ 执行 boot 分支（约 L3668）
       if (boot.size > 0) {
+        // 兜底：执行启动阶段同样不应剪掉 CORE_TOOLS。
+        // 只要 CORE_TOOLS 在基线 allowedNow 中，就强制并入 boot 集，
+        // 避免 memory / edit / file.open 等核心工具在首轮被 TOOL_NOT_ALLOWED。
+        for (const name of CORE_TOOL_NAME_SET) {
+          if (allowedNow.has(name)) boot.add(name);
+        }
+
         allowed = boot;
         hints.push(
           "执行启动阶段：请先调用首工具（优先 executionPreferred；默认先用 L0/L1），完成一次有效工具调用后再进入全工具阶段。",
```

#### 1c. delete-only 路由注释补充（约 L3475-3486）

不修改逻辑，补充注释说明为什么 delete-only 不兜底 CORE_TOOLS：

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ delete-only route（约 L3475）
     if (isDeleteOnlyRoute) {
       allowed = new Set(Array.from(selectedAllowedToolNames).filter((name) => DELETE_ONLY_ALLOWED_TOOL_NAMES.has(name)));
-      // 兜底确保关键链路可用（受 mode/toolPolicy 影响时仍保留）。
+      // 兜底确保删除场景的关键链路可用（受 mode/toolPolicy 影响时仍保留）。
+      // 注意：file_delete_only 是"删除专用"路由，这里刻意不额外 union CORE_TOOL_NAME_SET，
+      // 避免在删除任务中误放开 read/memory/edit 等非删除类工具。
       if (baseAllowedToolNames.has("project.listFiles")) allowed.add("project.listFiles");
```

**备注**：`CORE_TOOL_NAME_SET` 已在 `runFactory.ts` 顶部导入（L9），无需新增 import。

---

### Fix 2：hasAnyToolCall 语义调整（P0）

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**原理**：`TOOL_NOT_ALLOWED_THIS_TURN` 表示工具被 per-turn gating 拦截，**实际未执行**。不应将此类调用计入 `hasAnyToolCall`，否则 ExecutionContract 会误判"已有工具调用"。

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@ _handleKernelEvent 中的 _updateRunState 调用（约 L1762-1769）
-        // RunState（使用原始工具名做匹配）
-        this._updateRunState(rawToolName, snap?.args ?? {}, {
-          ok,
-          output,
-          meta,
-          executedBy,
-          dryRun,
-        });
+        // RunState（使用原始工具名做匹配）
+        // TOOL_NOT_ALLOWED_THIS_TURN 表示本轮 per-turn gating 拦截了调用，
+        // 工具实际未执行，不应计入 hasAnyToolCall / stickyToolNames 等状态，
+        // 否则 ExecutionContract 会误判"已有工具调用"而过早结束 run。
+        const isGatingRejection =
+          !ok &&
+          executedBy === "gateway" &&
+          output &&
+          typeof output === "object" &&
+          (output as any).error === "TOOL_NOT_ALLOWED_THIS_TURN";
+
+        if (!isGatingRejection) {
+          this._updateRunState(rawToolName, snap?.args ?? {}, {
+            ok,
+            output,
+            meta,
+            executedBy,
+            dryRun,
+          });
+        }
```

---

### Fix 3：ALWAYS_ALLOW_TOOL_NAMES 改造（P1）

**文件**：`apps/gateway/src/agent/runFactory.ts`

**原理**：将 `ALWAYS_ALLOW_TOOL_NAMES` 从基于 `CORE_WORKFLOW_TOOL_NAMES`（8 个）改为基于 `CORE_TOOL_NAME_SET`（26 个），并在 `computePerTurnAllowed` 的统一出口 `perTurnResult()` 中兜底，作为最后一道防线。

#### 3a. 修改 ALWAYS_ALLOW_TOOL_NAMES 构造（L3386-3388）

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ -3386,3 +3386,4 @@
-  const ALWAYS_ALLOW_TOOL_NAMES = new Set<string>(
-    CORE_WORKFLOW_TOOL_NAMES.filter((name) => selectedAllowedToolNames.has(name)),
-  );
+  // ALWAYS_ALLOW_TOOL_NAMES：per-turn gating 的最终兜底层。
+  // 无论 boot / style orchestrator / 其他 gate 如何收窄工具集，这些核心工具永远不会被剪掉。
+  const ALWAYS_ALLOW_TOOL_NAMES = new Set<string>(
+    Array.from(CORE_TOOL_NAME_SET).filter((name) => selectedAllowedToolNames.has(name)),
+  );
```

#### 3b. 在 perTurnResult() 中使用 ALWAYS_ALLOW_TOOL_NAMES（L3693-3696）

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ -3692,5 +3692,14 @@
-    // 构建返回值
-    const perTurnResult = () => {
-      const base = { allowed: allowed as Set<string>, hint: hints.join("\n\n") };
-      return base;
-    };
+    // 构建返回值：最终一步兜底 ALWAYS_ALLOW_TOOL_NAMES，确保 CORE_TOOLS 不被任何 per-turn gate 剪掉。
+    // 注意：delete-only 路由在此之前已经 early return，不受此兜底影响。
+    const perTurnResult = () => {
+      // 只有非 delete-only 路由才兜底（delete-only 在 L3475 已 early return 或在其 allowed 后直接 return）
+      if (!isDeleteOnlyRoute) {
+        for (const name of ALWAYS_ALLOW_TOOL_NAMES) {
+          if (baseAllowedToolNames.has(name)) {
+            allowed.add(name);
+          }
+        }
+      }
+      const base = { allowed: allowed as Set<string>, hint: hints.join("\n\n") };
+      return base;
+    };
```

**注意**：Fix 1 和 Fix 3 是双层防护。Fix 1 解决 boot 阶段的直接遗漏，Fix 3 作为统一出口的最终兜底。两者可以同时存在，互为冗余。

---

### Fix 4：per-turn gating 日志增强（P1）

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**原理**：在 `_transformContext` 中，当 `gating.allowed` 替换 `effectiveAllowed` 时，输出 `run.notice` 日志，便于线上排查工具可见性问题。

#### 4a. 新增 import（导入区，约 L48 后）

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@ import 区域（约 L48）
 import {
   decideServerToolExecution,
   executeServerToolOnGateway,
 } from "../serverToolRunner.js";
+import { CORE_TOOL_NAME_SET } from "../coreTools.js";
```

#### 4b. _transformContext 日志（约 L784-811）

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@ _transformContext（约 L784-811）
   private async _transformContext(
     messages: AgentMessage[],
     _signal?: AbortSignal,
   ): Promise<AgentMessage[]> {
     // 每轮重置为基线
-    this.effectiveAllowed = new Set(this.config.runCtx.allowedToolNames);
+    const baselineAllowed = new Set(this.config.runCtx.allowedToolNames);
+    this.effectiveAllowed = new Set(baselineAllowed);
     this.orchestratorMode = false;

     const gating = this.config.runCtx.computePerTurnAllowed?.(this.runState) ?? null;
     if (!gating) return messages;

     if (gating.allowed) {
-      this.effectiveAllowed = new Set(gating.allowed);
+      const nextAllowed = new Set(gating.allowed);
+      this.effectiveAllowed = nextAllowed;
+
+      // 观测 per-turn gating 效果，特别是 CORE_TOOLS 是否被剪掉
+      try {
+        const removedCore: string[] = [];
+        for (const name of CORE_TOOL_NAME_SET) {
+          if (baselineAllowed.has(name) && !nextAllowed.has(name)) {
+            removedCore.push(name);
+          }
+        }
+        this.config.runCtx.writeEvent("run.notice", {
+          turn: this.turn,
+          kind: removedCore.length > 0 ? "warn" : "debug",
+          title: "PerTurnToolGating",
+          message:
+            `per-turn gating：baseline=${baselineAllowed.size} / gated=${nextAllowed.size}` +
+            (removedCore.length ? ` / removedCore=${removedCore.join(",")}` : ""),
+          detail: {
+            baselineCount: baselineAllowed.size,
+            gatedCount: nextAllowed.size,
+            removedCoreTools: removedCore,
+          },
+        });
+      } catch {
+        // logging failures must not 影响正常执行
+      }
     }
     if (gating.orchestratorMode) {
       this.orchestratorMode = true;
```

---

## 4. 架构层隐患清单

以下是此次调查中发现的所有"完全替换式 per-turn gating"范式下的系统性风险，按严重程度排序。

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | boot 集硬编码 + 完全替换 effectiveAllowed → 10+ 核心工具首轮不可用 | `runFactory.ts:3550-3673` | memory/edit/file.open 等核心工具在大多数 run 首轮被剪掉 |
| S2 | hasAnyToolCall 不区分"成功执行"和"被 gate 拒绝" → ExecutionContract 误判 | `GatewayRuntime.ts:1762-1769` + `_updateRunState` | 被 gate 拦截的失败调用也计入"已执行工具"，导致 run 过早结束 |
| S3 | 三套核心工具常量不同步（CORE_TOOL_NAME_SET / CORE_WORKFLOW_TOOL_NAMES / boot 数组） | 多文件 | 维护时"只改其中一个"就重演 memory 问题 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | MCP 工具首轮被 boot 剪掉 | `runFactory.ts:3604-3673` | 用户付费/配置的 MCP 能力在新任务首步失效 |
| A2 | 多 Skill 共存缺乏合并策略 | `runFactory.ts:3502-3513` | style_imitate 的 early return 覆盖其他 skill 的 gating |
| A3 | ALWAYS_ALLOW_TOOL_NAMES 语义半残 | `runFactory.ts:3386-3388` | 基于 CORE_WORKFLOW_TOOL_NAMES 构造，且 per-turn 未使用 |

### B 级（影响可维护性 / 调试）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | 自愈机制作用范围极窄（仅同 run 下一轮） | `runFactory.ts:3439-3452` | 对一轮一指令的用户模式几乎无效 |
| B2 | TOOL_NOT_ALLOWED 错误文案反激励 LLM 重试 | `GatewayRuntime.ts:1157-1162` | "请使用其他工具"导致 LLM 不会在后续回合重试 memory |
| B3 | per-turn gating 的影响缺乏可视化日志 | `GatewayRuntime.ts:784-811` | 排查"某工具不可用"需读大量代码手动推导 |

### C 级（中长期架构演进风险）

| # | 问题 | 影响 |
|---|------|------|
| C1 | boot 范式本身（硬编码白名单 + 完全替换）不可扩展 | 每新增核心工具/MCP 都需手动同步多个列表 |
| C2 | memory 完全绑定 Desktop，无法多端共享 | 云端/多设备场景下需要重构 |

---

## 5. 验证 Checklist

### 5.1 回归场景（Fix 1 + Fix 3）

- [ ] **普通 agent run + "帮我记一下"**：memory 首轮应可用，不再返回 TOOL_NOT_ALLOWED_THIS_TURN
- [ ] **普通 agent run + "先看看有哪些知识库"**：kb.listLibraries 首轮应可用
- [ ] **普通 agent run + "帮我改一下这段"**：edit 首轮应可用
- [ ] **普通 agent run + "用默认应用打开这个文件"**：file.open 首轮应可用
- [ ] **style_imitate 激活场景**：行为不变，memory 仍可用（已被 93f5240 修复）
- [ ] **file_delete_only 路由**：行为不变，仍是最小工具集（不含 memory/edit 等）
- [ ] **toolDiscoveryBoot 场景**：tools.search 仍在 boot 集中，但 memory 等核心工具也可用
- [ ] **MCP 工具**：首轮是否也被保留（取决于是否在 CORE_TOOL_NAME_SET 中——大部分 MCP 不在，Fix 1 不保证 MCP 首轮可用，需后续 P1 处理）

### 5.2 回归场景（Fix 2）

- [ ] **memory 首轮被拒后**：`hasAnyToolCall` 不应被设为 true
- [ ] **ExecutionContract 检查**：首轮 memory 被拒后，contract 应继续要求"至少一次有效工具调用"
- [ ] **正常工具失败**（非 gate 拦截）：`hasAnyToolCall` 仍应被正确设为 true（例如 web.search 网络超时）

### 5.3 日志验证（Fix 4）

- [ ] 每轮的 `run.notice` 事件中有 `PerTurnToolGating` 记录
- [ ] 当 CORE_TOOLS 被剪掉时，日志 kind 为 `warn`，`removedCoreTools` 字段非空
- [ ] 正常运行时日志 kind 为 `debug`（不产生噪音）

### 5.4 已有测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

修改后必须跑此测试，确保 6 个场景覆盖双路径全部通过。

---

## 6. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/gateway/src/agent/runFactory.ts` | Fix 1, 3 | boot 兜底 + ALWAYS_ALLOW 改造 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | Fix 2, 4, 5 | hasAnyToolCall 语义 + 日志 + 合并工具名展开 |
| `apps/gateway/src/agent/coreTools.ts` | - | 无需修改（已定义 CORE_TOOL_NAME_SET） |
| `apps/gateway/src/agent/styleOrchestrator.ts` | - | 无需修改（93f5240 已修复） |
| `apps/gateway/src/agent/serverToolRunner.ts` | - | 无需修改（memory 路由到 Desktop 是合理设计） |

---

## 8. Fix 5：GatewayRuntime 合并工具名展开（P0）

### 8.1 根因

GatewayRuntime 从旧版 `writingAgentRunner.ts` 迁移时，遗漏了 `MERGED_TOOL_MAP` + `expandMergedToolName()` 逻辑。

旧版在发送工具调用到 Desktop 前，会把合并工具名（LLM 视角）展开为 Desktop 原始工具名：
- `memory` + `action=read` → `memory.read`
- `memory` + `action=update` → `memory.update`
- `doc.snapshot` + `action=create` → `doc.commitSnapshot`
- `doc.snapshot` + `action=list` → `doc.listSnapshots`
- `doc.snapshot` + `action=restore` → `doc.restoreSnapshot`

GatewayRuntime 完全缺少此映射，直接发送 `"memory"` 到 Desktop → Desktop 找不到工具 → `UNKNOWN_TOOL`。

### 8.2 修复内容

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

1. 在文件顶部工具函数区添加 `MERGED_TOOL_MAP` + `expandMergedToolName()` + `stripMergedActionField()`
2. 在 `_executeAgentTool` 的 Desktop 分支，调用 `_waitForDesktopToolResult` 前做名称展开和 action 字段移除

关键设计：
- 所有上游逻辑（per-turn gating、ExecutionContract、RunState 更新等）仍使用合并工具名
- 只在发送到 Desktop 时才展开为底层工具名
- toolCallSnapshots 和 _handleKernelEvent 中的 tool.result 映射不受影响（基于 toolCallId，不依赖工具名）

### 8.3 测试

`npm -w @ohmycrab/gateway run test:runner-turn` 全部 10 个场景通过。

---

## 7. Codex 讨论记录摘要

本方案经过三轮 Codex 深度讨论（session: `019cec96-c34c-7060-9850-2e1329d2f585`）。

**第一轮**：确认主根因（boot 阶段遗漏核心工具），分析自愈机制为何失效，确认 5 条代码路径中 A/E 安全、B/C 有问题、D 符合设计。

**第二轮**：排查同类受害者（10 个核心工具 + MCP 工具），分析完全替换模式的 4 类系统性风险（KV-cache / MCP 可见性 / 多 Skill 共存 / ExecutionContract 交互），讨论 "boot → hint" 软化方案的可行性和跨 provider 有效性。

**第三轮**：确认 memory 路由到 Desktop 执行是合理设计（数据在本地），最终根因总结和隐患清单，获取完整 unified diff patch。
