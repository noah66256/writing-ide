# kb.search 首次调用 NO_LIBRARY_SELECTED + write 后 lint 步骤被完全跳过

状态：待实施 | 优先级：P0 | 日期：2026-03-17

## 0. 现象

### 现象 A：kb.search 首次调用返回 NO_LIBRARY_SELECTED

用户 `/风格仿写闭环` 激活 `style_imitate`，没有 `@` 提及具体知识库。

Agent 行为：
1. `style_imitate` 激活成功（`has_style_library` trigger 通过）
2. Agent 调用 `kb.search` 检索风格样例
3. 返回 `{ ok: false, error: "NO_LIBRARY_SELECTED" }`
4. Agent 认为无法检索，尝试其他策略或跳过

### 现象 B：write 完成后 lint.copy / lint.style 被完全跳过

Agent 完成 `kb.search`（重试或带参成功后）和 `write` 后，不继续调用 `lint.copy / lint.style`，直接结束。

用户原话："不是找不到工具，是没后面的步骤了"。

---

## 1. 根因分析

### 根因 1（S 级）：style 库 ID 在 skill 激活和工具执行之间断裂——级联失效

核心发现：Bug A 导致 Bug B。这是一条级联失效链。

文件：
- `apps/desktop/src/agent/toolRegistry.ts:1633-1642`（`kb.search libraryIds` 优先级链）
- `apps/desktop/src/agent/gatewayAgent.ts:1338-1340`（`buildContextPack kbSelectedIds`）
- `apps/desktop/src/agent/wsTransport.ts:731-735`（`sidecarLibraryIds`）
- `packages/agent-core/src/runMachine.ts:488-513`（`deriveStyleGate`）
- `apps/gateway/src/agent/runFactory.ts:3365`（`gates` 计算）
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:1011-1016`（`_getFollowUpMessages` 入口条件）

级联失效链路：

用户 `/风格仿写闭环`（无 `@kb` 提及）
  │
  ├─ [Desktop] `kbMentionIds = []`
  │
  ├─ [Desktop `gatewayAgent.ts:1340`] `kbSelectedIds = kbMentionIds = []`
  │   → `KB_SELECTED_LIBRARIES(JSON) = []`（空）
  │
  ├─ [Desktop `wsTransport.ts:735`] `sidecarLibraryIds = mentionLibIds=[] → att=[] → []`
  │   → `styleLinterLibraries sidecar` 为空
  │
  ├─ [Gateway `runFactory.ts:2110`] `kbSelectedList = []`（从 `KB_SELECTED_LIBRARIES` 解析）
  │
  ├─ [Gateway `runFactory.ts:3365`] `gates = deriveStyleGate({ kbSelected: [] })`
  │   → [runMachine.ts:491-493] `styleLibIds = kbSelected.filter(purpose=style) = []`
  │   → `hasStyleLibrary = false`
  │   → [L501] `styleGateEnabled = false`
  │   → [L502] `lintGateEnabled = false`
  │
  ├─ [Bug A] Agent 调用 `kb.search` → Desktop `toolRegistry.ts:1633-1642`
  │   → `libraryIds` 优先级链全空（`explicitLibs=[] → mentioned=[] → attached=[] → libFromMainDoc=[]`）
  │   → `return { ok: false, error: "NO_LIBRARY_SELECTED" }`
  │
  └─ [Bug B] Agent 调用 `write` 后，GatewayRuntime._getFollowUpMessages
      → [L1011] `if (styleSkillActive && gates.styleGateEnabled && gates.lintGateEnabled && ...)`
      → `gates.styleGateEnabled = false` → 条件不满足
      → 整个 v1 followUp 块被跳过
      → Agent 无 lint 推进提示，自然结束

三个子问题叠加：

1. `kbMentionIds` 是唯一事实源：`buildContextPack`（`gatewayAgent.ts:1340`）的 `kbSelectedIds` 仅来自 `@` 提及（`kbMentionIds`），不会自动检测已有的 style 库。旧的 `kbAttachedLibraryIds` 绑定机制已废弃（`wsTransport.ts:600` 注释）
2. `kb.search` 不感知 skill 激活：`toolRegistry.ts:1633-1642` 的 `libraryIds` 优先级链（`explicitLibs → mentioned → attached → libFromMainDoc`）完全不包含“系统存在可用 style 库”这一层回退
3. `styleGateEnabled` 取决于 `kbSelected`：`deriveStyleGate`（`runMachine.ts:501`）的 `styleGateEnabled = hasStyleLibrary && mode !== "chat" && intent.isWritingTask`。`hasStyleLibrary` 来自 `kbSelected` 中 `purpose=style` 的库。`kbSelected` 为空时，gate 永远 false。

### 根因 2（A 级）：run.done 无条件终止，不感知 style_imitate 闭环状态

文件：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:2074-2083`（`run.done handler`）
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:994-996`（`_getFollowUpMessages` 的 `run.done` 短路）

机制分析：

即使根因 1 被修复（`gates` 为 true、`followUp` 可以工作），如果 Agent 在 `write` 后直接调用 `run.done`，仍然会绕过 lint 闭环：

Agent 调用 `run.done`
  → [L2074] `this._activateDeliveryLatch("run_done")`
  → `this._setOutcome({ status: "completed", reason: "run_done" })`
  → `this.internalAc?.abort()`  ← 立即终止 `agentLoop`
  → `_getFollowUpMessages` 无机会注入
      （即使能注入，`L996: if (outcome.reason === "run_done") return []` 也会短路）

旧 runner `writingAgentRunner.ts:2458` 已有同类拦截先例——检测到闭环未完成时不执行 `run.done`，改为注入 hint 继续下一轮。

### 根因 3（B 级）：hasDraftText 设置条件依赖 gates

文件：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:2520-2524`（`_updateRunState write path`）

```ts
if (!this.runState.hasDraftText && gates.styleGateEnabled && gates.lintGateEnabled && this.runState.hasStyleKbSearch) {
  this.runState.hasDraftText = true;
}
```

当 `gates` 为 false（根因 1 导致），即使 Agent 成功调用 `write` 生成了草稿，`hasDraftText` 也不会被标记为 true。这导致 phase 一直停在 `need_draft`，即使 `followUp` 被修复也会给出错误的阶段提示。

根因 1 修复后此问题自动消解——`gates` 为 true 时，`write` 后 `hasDraftText` 正常标记。

---

## 2. 影响范围

功能: `style_imitate` 闭环  
影响: `/skill` 唤起不 `@` 知识库时，`kb.search` 必然失败；`gates` 为 false 导致 lint 永远不推进
────────────────────────────────────────
功能: `style_imitate_v2` 闭环  
影响: 同样受影响（v2 的 `followUp` 也依赖 `gates.styleGateEnabled`）
────────────────────────────────────────
功能: `lint.copy / lint.style`  
影响: 即使工具在池中，`gates` 为 false 时 `computeStyleTurnCaps` 不输出白名单
────────────────────────────────────────
功能: `run.done`  
影响: 所有 workflow 类 skill 的闭环都可被 `run.done` 无条件绕过
────────────────────────────────────────
功能: `KB_SELECTED_LIBRARIES`  
影响: 无 `@` 提及时始终为空，Gateway 侧无法推断 style 库信息

---

## 3. 修复方案

### Fix 1（P0）：Desktop 统一 style 库隐式解析

文件：
- `apps/desktop/src/agent/kbSelection.ts`（新建）
- `apps/desktop/src/agent/toolRegistry.ts`
- `apps/desktop/src/agent/gatewayAgent.ts`
- `apps/desktop/src/agent/wsTransport.ts`
- `apps/desktop/src/state/kbStore.ts`

原理：新建 `resolveImplicitStyleLibraryIds()` 纯函数，在 `@` 提及为空时自动解析 style 库 ID。所有需要 style 库 ID 的调用点统一复用此函数，消除事实源断裂。

优先级链：
1. `mainDoc styleContractV1.libraryId / stylePlanV1.libraryId`（已有写入的库优先）
2. 唯一 style 库隐式回退（仅当系统中恰好有 1 个 `purpose=style` 的库）
3. 多库返回空 + `STYLE_LIBRARY_AMBIGUOUS` 错误码（不自动猜）

设计约束：
- 同步函数，不调用 `refreshLibraries()`（store 在 run 启动时已由 `wsTransport.ts:596` 刷新）
- 多 style 库时不猜测，返回空数组 + 歧义错误码
- 4 个消费方统一复用：`buildContextPack`、`wsTransport sidecarLibraryIds`、`kb.search`、`buildStyleLinterLibrariesSidecar`

### Fix 2（P0）：run.done 在 style 闭环未完成时拦截

文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

原理：从 `_getFollowUpMessages` 提取 `_resolveStyleWorkflowFollowUp()` 共用方法。在 `run.done handler` 中调用此方法——如果闭环未完成且 `budget > 0`，则不设 outcome、不 abort、直接 return。让 `agentLoop` 继续，由 `_getFollowUpMessages()` 在下一轮统一注入 hint。

改动：

1. 新增 `_resolveStyleWorkflowFollowUp()` 私有方法（从 `_getFollowUpMessages` 提取）
2. `_getFollowUpMessages` 简化为调用此方法
3. `run.done handler` 增加闭环检查：

```ts
if (rawToolName === "run.done") {
  const followUp = this._resolveStyleWorkflowFollowUp();
  const budget = Math.max(0, Math.floor(Number((this.runState as any).workflowRetryBudget ?? 0)));
  if (followUp && budget > 0) {
    this.config.runCtx.writeEvent("run.notice", { ... });
    this.toolCallSnapshots.delete(event.toolCallId);
    return;
  }
  this._activateDeliveryLatch("run_done");
  this._setOutcome({ ... });
  this.internalAc?.abort();
}
```

### Fix 3（P1）：错误码细化——区分 STYLE_LIBRARY_AMBIGUOUS

文件：
- `apps/desktop/src/state/kbStore.ts`（新增 `KbLibrarySelectionError` 类型）
- `apps/desktop/src/agent/toolRegistry.ts`（`kb.search / lint.copy / lint.style` 返回细化错误码）

原理：当用户有多个 style 库但未显式选择时，返回 `STYLE_LIBRARY_AMBIGUOUS` 而非 `NO_LIBRARY_SELECTED`。Agent 可据此引导用户 `@` 选择具体库。

---

## 4. 边界情况

### Fix 1 边界

- 有 `@` 提及时：`kbMentionIds` 非空 → 不走隐式解析，行为不变
- 有 attached 库时：`kbAttachedLibraryIds` 非空 → 不走隐式解析，行为不变
- 有 `mainDoc styleContract` 时：优先用 contract 中的 `libraryId`，与首次写作场景区分
- 多 style 库无选择：返回空 + `STYLE_LIBRARY_AMBIGUOUS`，不自动猜测
- 无 style 库：`resolveImplicitStyleLibraryIds` 返回空，回退到原有 `NO_LIBRARY_SELECTED`
- 非 style 检索（`purpose≠style`）：`resolveImplicitStyleLibraryIds` 只识别 `purpose=style`，非 style 场景不受影响

### Fix 2 边界

- 闭环已完成时：`_resolveStyleWorkflowFollowUp()` 返回 `null` → `run.done` 正常终止
- budget 耗尽时：`budget === 0` → `run.done` 正常终止（安全阀，防死循环）
- 非 `style_imitate` 场景：方法返回 `null` → `run.done` 正常终止
- gates 为 false 时：方法返回 `null` → `run.done` 正常终止（Fix 1 修复后 gates 应为 true）
- Agent 反复调用 `run.done`：每次都被拦截直到 budget 耗尽（budget 由 `followUp` 在下一轮递减）

### Fix 3 边界

- 单 style 库：不触发 `AMBIGUOUS`，正常隐式选中
- 多 style 库 + `@` 提及：不触发 `AMBIGUOUS`，用提及的库
- 无 style 库：返回 `NO_LIBRARY_SELECTED`（原有错误码）

---

## 5. 架构隐患

### S 级：kbSelected 是 style 闭环的隐式前置条件

当前 `KB_SELECTED_LIBRARIES`（`kbSelected`）既是 context pack 中的信息段，又是 `deriveStyleGate` 的输入。但它只从 `@` 提及生成。这意味着：
- `/skill` 唤起（无 `@`）
- 自动激活（`activateSkills` 判断有 style 库 + 写作意图）

这两种路径都不会填充 `kbSelected`，导致 `gates` 一定为 false。Fix 1 是缓解（增加隐式回退），但理想方案是将 “style 库已选择” 作为 skill 激活的一等公民信号，在激活阶段就确定并透传。

### A 级：run.done 对所有 workflow skill 无感知

当前 `run.done` 只认一个语义——“结束”。没有 workflow 级别的完成检查。Fix 2 硬编码了 `style_imitate` 的检查。后续应统一为：任何带 `kind: "workflow"` 的 skill，其 `completed` 状态应被 `run.done` 检查。

### B 级：styleGateEnabled 语义不应被 activeSkillIds 覆盖

`styleGateEnabled` 当前语义是“已解析到可执行风格库”（有具体 `libraryId`）。如果改为“skill 已激活就 gate=true”，会出现“Gate 为真，但执行条件不存在”的假闭环。正确做法是保持 gate 含义不变，新增并行信号（如 `styleSkillActiveButNoResolvedLibrary`）用于澄清/选库路径。

---

## 6. 验证 checklist

### Fix 1 验证

- `/风格仿写闭环`（无 `@` 库）+ 系统中有唯一 style 库 → `kb.search` 使用隐式库 ID，不再 `NO_LIBRARY_SELECTED`
- `/风格仿写闭环`（无 `@` 库）+ 系统中有多个 style 库 → `kb.search` 返回 `STYLE_LIBRARY_AMBIGUOUS`
- `/风格仿写闭环` + `@` 某个库 → 使用 `@` 指定的库（行为不变）
- `KB_SELECTED_LIBRARIES` 在无 `@` 但有唯一 style 库时非空
- Gateway 的 `deriveStyleGate.styleGateEnabled` 在上述场景为 `true`

### Fix 2 验证

- Agent 在 `write` 后调用 `run.done` → 被拦截 → 下一轮收到 lint 推进 hint → 继续 `lint.copy`
- Agent 完成 `lint.copy + lint.style` 后调用 `run.done` → 正常终止
- budget 耗尽（默认 3 次）后 `run.done` → 正常终止（安全阀）
- 非 `style_imitate` 场景 `run.done` → 正常终止（不受影响）
- `_getFollowUpMessages` 简化后行为与原版一致

### Fix 3 验证

- 多 style 库场景 → 错误码为 `STYLE_LIBRARY_AMBIGUOUS`，非 `NO_LIBRARY_SELECTED`
- `lint.copy / lint.style` 在无库时透传正确错误码

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

文件: `apps/desktop/src/agent/kbSelection.ts`  
改动类型: 新建 Fix 1  
改动范围: `resolveImplicitStyleLibrarySelection() / resolveImplicitStyleLibraryIds()`
────────────────────────────────────────
文件: `apps/desktop/src/state/kbStore.ts`  
改动类型: Fix 3  
改动范围: 新增 `KbLibrarySelectionError` 类型
────────────────────────────────────────
文件: `apps/desktop/src/agent/toolRegistry.ts`  
改动类型: Fix 1 + Fix 3  
改动范围: `kb.search` 增加隐式库回退 + `buildStyleLinterLibrariesSidecar` 增加隐式库回退 + lint 错误码透传
────────────────────────────────────────
文件: `apps/desktop/src/agent/gatewayAgent.ts`  
改动类型: Fix 1  
改动范围: `buildContextPack` 的 `kbSelectedIds` 增加隐式库回退
────────────────────────────────────────
文件: `apps/desktop/src/agent/wsTransport.ts`  
改动类型: Fix 1  
改动范围: `sidecarLibraryIds` 增加隐式库回退
────────────────────────────────────────
文件: `apps/gateway/src/agent/runtime/GatewayRuntime.ts`  
改动类型: Fix 2  
改动范围: 新增 `_resolveStyleWorkflowFollowUp()` + `_getFollowUpMessages` 简化 + `run.done` 拦截

---

以上就是第三轮 bug 复盘的完整 spec。核心发现是 Bug A→Bug B 的级联失效：`@` 提及是 style 库 ID 的唯一事实源，`/skill` 路径不填充它，导致 `gates` 永远 false，lint 闭环从头到尾不可能推进。Fix 1 解决事实源断裂，Fix 2 补上 `run.done` 的安全网。
