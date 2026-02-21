# Agent Runner 迁移后修补 v0.1

> **前置文档**：[pi-agent-core 迁移方案 v0.1](pi-agent-core-migration-v0.1.md)
> **日期**：2026-02-21
> **状态**：已落地 + 冒烟通过

---

## 0. 概述

迁移完成后发现的问题和补充改动，分为三部分：
1. **死代码清理** — 移除 XML 时代残留
2. **per-turn 工具限制策略** — 恢复旧循环中丢失的阶段门禁
3. **冒烟测试暴露的兼容性修复** — 工具名编码、violation 消息格式、server-side 工具执行

---

## 1. 死代码清理

### 1.1 gateway/index.ts — computeToolCapsForTurn

| 项 | 说明 |
|---|---|
| 删除内容 | `lastToolCapsPhase` 变量 + `computeToolCapsForTurn` 函数（~264 行） |
| 原因 | 迁移后 WritingAgentRunner 使用静态 `allowedToolNames`，此函数从未被调用 |
| 替代 | `computePerTurnAllowed` 闭包（见第 2 节） |

### 1.2 AgentPane.tsx — stripToolXml

```
删除：stripToolXml 函数（6 行）
修改：第 1178 行 stripToolXml(step.text) → step.text
```

**原因**：新 runner 通过 `assistant.delta` 事件发送纯文本，不再有 `<tool_calls>` XML 标签混入。

### 1.3 gatewayAgent.ts — stripToolXmlFromText

```
删除：stripToolXmlFromText 函数（6 行）
修改：line 929/936 调用处 → String(st.text ?? "").trim()
```

### 1.4 PHASE_CONTRACTS_V1 — XML 格式提示

删除 `style_need_catalog_pick` 合约中两处残留：
- hint 末行："注意：若要调用工具，本条消息必须且只能输出严格的 `<tool_calls>` XML"
- autoRetry.systemMessage 末行："本条消息必须是纯 `<tool_calls>` XML"

### 1.5 agent-core/skills.ts — 弯引号编译错误

第 168 行字符串界定符为 `"` (U+201C) 和 `"` (U+201D)（弯引号），tsc 无法识别。替换为 ASCII `"` (U+0022)。

---

## 2. per-turn 工具限制策略

### 2.1 问题

迁移后 WritingAgentRunner 对所有回合使用同一静态 `allowedToolNames`，丢失了旧循环中的"per-turn 阶段门禁"：

- **TodoGate**：首轮只允许 `run.setTodoList` 等白名单工具
- **WebGate**：need_search / need_fetch 阶段限制工具可见性
- **StyleGate**：need_templates / need_draft / need_copy / need_style 各阶段限制写入类工具

### 2.2 方案：回调注入

在 `RunContext` 新增两个可选字段：

```typescript
// 每轮回调：根据当前运行状态动态计算本轮可用工具集和 hint
computePerTurnAllowed?: (state: RunState) => { allowed: Set<string>; hint: string } | null;

// 初始运行状态：由 gateway 从 contextPack 预初始化
initialRunState?: RunState;
```

### 2.3 改动文件

| 文件 | 改动 |
|---|---|
| `writingAgentRunner.ts` — RunContext | 新增 `computePerTurnAllowed` + `initialRunState` |
| `writingAgentRunner.ts` — constructor | `this.runState = ctx.initialRunState ? { ...ctx.initialRunState } : createInitialRunState()` |
| `writingAgentRunner.ts` — _runOneTurn | 每轮调用回调→动态过滤工具集→hint 追加到 system prompt |
| `writingAgentRunner.ts` — _updateRunState | 补充 `hasTodoList` 追踪（`run.setTodoList` / `run.todo.upsertMany`） |
| `gateway/index.ts` | 新建 `computePerTurnAllowed` 闭包，捕获 webGate/effectiveGates/intentRoute 等外层变量 |
| `gateway/index.ts` — runCtx | 新增 `initialRunState: runState` + `computePerTurnAllowed` |

### 2.4 回调语义

```
computePerTurnAllowed(state) → { allowed, hint } | null
```

- 返回 `{ allowed, hint }`：本轮工具集限制为 `allowed`，`hint` 追加到 system prompt
- 返回 `null`：无阶段限制，使用默认 `allowedToolNames`

阶段优先级（短路返回）：
1. TodoGate — `!state.hasTodoList && todoPolicy === "required"`
2. WebGate — `needSearch` / `needFetch`
3. WritingBatch — `batch_active`
4. StyleGate — `need_catalog_pick` → `need_templates` → `need_draft` → `need_punchline` → `need_copy` → `need_style` → `can_write`

---

## 3. 冒烟测试暴露的兼容性修复

### 3.1 工具名编码（anthropicMessages.ts）

**问题**：Anthropic Messages API 工具名限制 `^[a-zA-Z0-9_-]{1,128}$`，不允许 `.`。工具名如 `run.setTodoList`、`kb.search` 等含 `.` 的名字被 API 拒绝。此限制与代理无关（VectorEngine / 原生 Anthropic 均如此）。

**修复**：

```typescript
// 编码：发送到 API 前
function encodeToolName(name: string): string {
  return name.replace(/\./g, "__dot__");
}

// 解码：接收 API 响应后
function decodeToolName(name: string): string {
  return name.replace(/__dot__/g, ".");
}
```

- `toolMetaToAnthropicDef`：`name: encodeToolName(meta.name)`
- `content_block_start` 事件：`name = decodeToolName(block.name)`
- 对 runner 完全透明，无需改动 `writingAgentRunner.ts`

### 3.2 violation 分支补 tool_result（writingAgentRunner.ts）

**问题**：`analyzeStyleWorkflowBatch` 检测到违规时，原代码直接推送违规文本消息但跳过 `tool_result` block。Anthropic API 要求每个 `tool_use` 必须有对应的 `tool_result`。

**修复**：violation 分支先构造 skipped tool_result blocks，再附加违规提示：

```typescript
if (batch.violation) {
  // 补充 tool_result（Anthropic API 强制要求）
  const skippedResultBlocks = completedToolUses.flatMap((toolUse) => {
    const msg = buildToolResultMessage(toolUse.id, { ok: false, error: "SKIPPED_DUE_TO_VIOLATION" }, true);
    return Array.isArray(msg.content) ? msg.content : [];
  });
  this.messages.push({
    role: "user",
    content: [...skippedResultBlocks, { type: "text", text: `继续推进。${message}` }],
  });
}
```

### 3.3 run.* 编排工具 server-side 执行（serverToolRunner.ts）

**问题**：`run.setTodoList`、`run.todo.upsertMany` 等编排工具未列入 server tool allowlist，路由到 desktop 客户端回调。无桌面端时 180 秒超时后 agent 循环中断。

**修复**：

1. **allowlist 扩展**：

```
run.done, run.setTodoList, run.todo.upsertMany, run.todo.update,
run.updateTodo, run.mainDoc.update, run.mainDoc.get
```

2. **路由统一**：`if (name.startsWith("run.")) return { executedBy: "gateway" }`

3. **执行实现**：

| 工具 | server-side 行为 |
|---|---|
| `run.setTodoList` / `run.todo.upsertMany` / `run.todo.update` | 返回 `{ ok: true, items }` |
| `run.mainDoc.update` | 返回 `{ ok: true }` |
| `run.mainDoc.get` | 返回 `{ ok: true, mainDoc: null }` |

Desktop 端仍通过 SSE `tool.result` 事件接收结果并更新 UI，行为不变。

---

## 4. 冒烟测试结果

**环境**：gateway standalone（无 Desktop），LLM: claude-sonnet-4-6 via VectorEngine proxy

| 测试 | 模式 | Prompt | 关键路径 | 结果 |
|---|---|---|---|---|
| 1 | chat | 宠物猫朋友圈文案 | 违规恢复 → 纯文本回复 | ✅ |
| 2 | agent | 200 字清晨散步短文 | TodoGate → setTodoList → 写作 | ✅ |
| 3 | chat | 起标题建议 | 纯文本回复（无工具） | ✅ |
| 4 | agent | 小红书咖啡店文案 | TodoGate → setTodoList → 写作 | ✅ |

---

## 5. 改动文件汇总

| 文件 | 改动类别 |
|---|---|
| `apps/gateway/src/agent/writingAgentRunner.ts` | RunContext 扩展 + constructor + per-turn 过滤 + hasTodoList + violation fix |
| `apps/gateway/src/index.ts` | 删 computeToolCapsForTurn + 新建 computePerTurnAllowed + 清除 XML hints + runCtx 扩展 |
| `apps/gateway/src/llm/anthropicMessages.ts` | encodeToolName / decodeToolName |
| `apps/gateway/src/agent/serverToolRunner.ts` | run.* allowlist + server-side 执行 |
| `apps/desktop/src/components/AgentPane.tsx` | 删 stripToolXml |
| `apps/desktop/src/agent/gatewayAgent.ts` | 删 stripToolXmlFromText |
| `packages/agent-core/src/skills.ts` | 修复弯引号 |
| `apps/gateway/src/index.ts` (PHASE_CONTRACTS_V1) | 清除 XML 格式提示 |
