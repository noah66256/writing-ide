# Desktop Runtime Item Persistence Guardrails（v0.1）

> 目标：在 **不改 Gateway 合同**、**不把 ChatArea 窗口化绑进这一期**、**不推翻最近几轮 history/runtime 恢复修复** 的前提下，只收口 Desktop 侧 `runtime items / turns / read.result.content` 的持久化合同，切断“运行中 autosave + 重启恢复 + 单会话落盘”继续把前端慢性撑炸的链路。

> 文档状态说明（2026-03-23）：
> 本文最初是设计稿；当前实现已经落下大部分 guardrail。以下“实施卡片 / 实施状态”与当前工作树保持同步；后面的 diff 草案保留作设计缘由参考，若与代码细节不一致，以源码现状为准。

---

## 实施卡片

- spec：`docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`
- 目标：把 runtime-item 持久化从“fat runtime 原样入盘”收口到“compact runtime snapshot + preview-only tool result + logical dedupe + id remap”，并与 event-log 持久化链对齐。
- 范围：`apps/desktop/src/state/conversationStore.ts`、`apps/desktop/src/state/runStore.ts`、`apps/desktop/src/agent/wsTransport.ts`、`packages/shared/src/runtime/toolResultEnvelope.ts`
- 当前状态：working tree（2026-03-23）
- 仍未做：artifact pointer/sidecar、ChatArea 窗口化，以及 derived body cache 的进一步瘦身

## 实施状态

| Spec 条目 | 文件/符号 | 状态 | 说明 |
|------|-----------|------|------|
| `buildCurrentSnapshot()` 不再为历史持久化深拷贝 fat runtime | `conversationStore.ts` / `buildCurrentSnapshot()` / `slimSnapshotForHistory()` | 已完成 | 已移除整包 `JSON.parse(JSON.stringify(...))`；保存前统一走 slim/compact |
| active conversation / draft / pending 统一走 compact runtime snapshot | `conversationStore.ts` / `setDraftSnapshot()` / `persistConversationSnapshotViaEvents()` / `flushDraftSnapshotNow*()` | 已完成 | draft lane、event lane、fallback legacy body write 都以 slim snapshot 为输入 |
| runtime overlay 已进入 event authority | `conversationStore.ts` / `buildHistoryEventBatchFromSnapshot()`；`ChatArea.tsx` / `buildConversationHistoryEventPayload()`；`main.cjs` / `normalizeHistoryEventRuntimeState()` | 已完成 | `logs / turns / items / collabSessions / activeItemIds / transcript` 已不再只靠 body 兜底，而是进入 `runtimeState` 事件模型 |
| `read.result.content` 历史持久化改成 preview-only | `packages/shared/src/runtime/toolResultEnvelope.ts` / `slimToolResultEnvelopeForHistory()` | 已完成 | `read` 结果历史只保留 `path/totalChars/truncated/proposalSources/contentPreview` 等预览字段 |
| shadow tool item 与 authoritative item 持久化前去重 | `conversationStore.ts` / `compactRuntimeItemsForHistory()` | 已完成 | `toolCall` 按 `toolCallId` 作为逻辑键；shadow 只兜底，不双份落盘 |
| `turn.itemIds` / `activeItemIds` 跟随 dedupe 重写 | `conversationStore.ts` / `remapHistoryItemIds()` | 已完成 | 去重后会统一 remap 并去重，避免 reload 指向不存在 item |
| shadow item 具备真实 `toolCallId` | `runStore.ts` / `ToolBlockStep.toolCallId` / `buildShadowItemFromToolStep()`；`wsTransport.ts` | 已完成 | 网关工具调用、MCP、子 agent 工具流都在本地 step 上透传真实 `toolCallId` |
| `proposal/undo/fileChange`、`waiting-user`、`projectDir`、`taskState` 语义保留 | `conversationStore.ts` / `slimRuntimeItemForHistory()` / `slimRuntimeThreadForHistory()` | 已完成 | 当前 slim 合同保留这些恢复正确性字段 |
| artifact pointer / sidecar | - | 未开始 | 本期仍坚持保守收口，不新增独立 artifact 存储层 |

## 剩余未完成

1. `artifact pointer / sidecar` 还没开始，历史工具卡如果将来要“点开重看全文”，还需要单开一轮存储设计。
2. ChatArea 窗口化还没做，但这是明确排除项，不属于本轮 runtime persistence guardrail 的阻塞项。
3. `items / turns / thread` 仍保留在 materialized body 这个 derived cache 里；不过 authority 已经迁到 event log，这一项现在属于后续继续瘦身，而不是本轮阻塞。

## 1. 目标

本期只做 **Desktop-only** 的保守收口，成功标准是：

1. `buildCurrentSnapshot()` 不再为历史持久化深拷贝整份 fat `items/turns/thread`
2. active conversation / draft / pending 的保存链统一走 **compact runtime snapshot**
3. `read` 工具的历史持久化不再保存完整 `result.content`
4. shadow tool item 与 authoritative runtime item 在持久化前能稳定去重
5. `proposal/undo/fileChange`、`waiting-user`、`projectDir`、`taskState`、`draftSnapshot`、`pending conversations` 语义不退化

---

## 2. 为什么这一期必须单开 spec

上一份源 spec `docs/specs/desktop-history-and-project-loading-guardrails-v0.1.md` 已经明确：

1. 启动期 `history index-first + active on-demand` 已经落地
2. 项目 `tree-first + ensureLoaded(path)` 已经落地
3. 当时 `read.result.content` 持久化合同、runtime item 去重、artifact pointer 仍是 **deferred**
4. ChatArea 长会话窗口化要 **单开 spec**

也就是说，P0 已经切掉了“启动即全量 hydrate 全历史 + 打开项目即全量读正文”两条主链，但还剩一条没有真正切断：

- **active conversation 的 runtime snapshot 仍然会在 renderer 内反复组装、深拷贝、落盘、重载**

这条链如果不单独收口，现象就会变成：

- 启动不一定第一时间爆
- 但长任务、频繁 autosave、切会话、重启恢复之后，仍会在 Desktop 端慢性把内存重新顶上去

---

## 3. 当前事实（基于当前工作树 / 2026-03-23）

## 3.1 现在最大的头仍然是 `snapshot.items`

来自 `docs/research/desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md` 的已确认事实：

1. 最大单会话文件约 `4MB`
2. 其中：
   - `steps` 约 `403KB`
   - `logs` 约 `215KB`
   - `items` 约 `3.56MB`
3. 最大 item 基本都是 `type=toolCall` 的 `read`
4. 同一份大 `read.result.content` 存在 **成对 item**
   - 一个是本地 `ToolBlockStep` 投影出来的 shadow item
   - 一个是 runtime authoritative item

这说明：

- 当前后续风险并不在 `steps`
- 当前后续风险主要在 **`items` 的大 payload + 双份保留**

## 3.2 当前保存链已经显著变轻，但 materialized body 仍保留 compact runtime overlay

关键代码点：

- `apps/desktop/src/state/conversationStore.ts` `buildCurrentSnapshot()`
- `apps/desktop/src/state/conversationStore.ts` `slimSnapshotForHistory()`
- `apps/desktop/src/state/conversationStore.ts` `persistConversationSnapshotViaEvents()`
- `apps/desktop/src/state/conversationStore.ts` `flushDraftSnapshotNow*()`
- `apps/desktop/src/ui/components/ChatArea.tsx` autosave / run end materialize

当前事实：

1. `buildCurrentSnapshot()` 已不再对 `thread / turns / items` 做整包 JSON 深拷贝，而是保留必要浅拷贝后统一走 `slimSnapshotForHistory()`
2. autosave 热路径已经优先切到 `draft + appendEvents`；run end / flush 点再做 `materializeConversation + flushWriter`
3. `setDraftSnapshot / persistConversationSnapshotViaEvents / flushDraftSnapshotNow*` 都会复用同一份 compact/safe snapshot 合同
4. 因此最重的“renderer 先做 fat clone 再落盘”已经切掉；当前残余问题是 materialized body 仍会保留 compact 版 `items/turns/thread`

## 3.3 v2 per-conv 仍保留 compact runtime 字段，但重 payload 已经先被收口

关键代码点：

- `packages/shared/src/runtime/toolResultEnvelope.ts` `slimToolResultEnvelopeForHistory()`
- `apps/desktop/src/state/conversationStore.ts` `compactRuntimeItemsForHistory()`
- `apps/desktop/electron/main.cjs` `buildSnapshotFromV2Payload()`
- `apps/desktop/electron/main.cjs` `history.readConversationSnapshot`
- `apps/desktop/electron/main.cjs` `history.loadConversationSegment`

当前事实：

1. per-conv body 仍会保留 `logs/thread/turns/items/collabSessions/activeItemIds` 这些恢复辅助字段，所以它还不是 text-only / event-only 形态
2. 但在进入 per-conv 之前，`read` 结果已经先被压成 preview-only，shadow/authoritative tool item 已先按 `toolCallId` 去重
3. `history.loadConversationSegment()` 仍是 transcript 的权威来源；当前剩余压力主要来自 compact runtime overlay 还未从 body 完全剥离

## 3.4 UI 对旧工具卡的依赖其实是“摘要线”，不是全文

关键代码点：

- `apps/desktop/src/ui/components/ChatArea.tsx:2107` `ToolCallCard`
- `apps/desktop/src/ui/components/ChatArea.tsx:2367` `summarizeToolOutput()`
- `apps/desktop/src/ui/components/ChatArea.tsx:2449` `formatToolStatusLine()`

当前事实：

1. 历史工具卡默认只显示 **一行状态摘要**
2. 对 `read` 来说，卡片并不要求重新展开完整正文
3. 这支持我们把 `read.result.content` 改成 **preview-only persistence contract**

---

## 4. 一手对照组结论（只取与本期直接相关的部分）

## 4.1 本地 Codex 参考仓

已核对：

- `third_party/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- `third_party/openai-codex/codex-rs/app-server/tests/suite/v2/thread_read.rs`
- `third_party/openai-codex/codex-rs/tui_app_server/src/lib.rs`
- `third_party/openai-codex/docs/tui-chat-composer.md`

对本期有直接启发的结论只有三条：

1. `thread/list` / `thread/read(includeTurns=false)` 走轻量热路径
2. 完整 turns / item 恢复只在当前 thread / resume / fork 时触发
3. persistent history 是 **lightweight / text-first**，不是默认 full-fat replay

## 4.2 对本项目的直接翻译

本项目这一期不需要“照搬 Codex 协议”，但要对齐它的范式：

1. `steps` 仍是历史 transcript 主体
2. `items/turns/thread` 是当前 thread 的恢复辅助层，不应该承载无限膨胀的大正文
3. 保存层应该允许“当前 live state 较重，但持久层显著更轻”

---

## 5. 本期范围与非目标

## 5.1 本期范围

1. Desktop runtime item 的 **持久化收口**
2. `read.result.content` 的 **preview-only history contract**
3. shadow item / authoritative item 的 **持久化前去重**
4. `turn.itemIds` / `activeItemIds` 的 **别名重写**
5. v2 per-conv 读写链的 **lazy migration**

## 5.2 明确不做

1. 不改 Gateway 编排、provider、Responses、runtime 协议
2. 不把 ChatArea DOM 窗口化并入这一期
3. 不引入新的 sidecar/artifact 文件系统
4. 不删掉 `turns/items/thread`
5. 不改 `memory > pending > disk` 的 hydrate 优先级

---

## 6. 落地方案

## 6.1 方案一句话

本期实际落地的核心收口点是：

> **live runtime 可以继续富；history persistence 必须轻且可恢复。**

具体拆成四条合同：

1. **保存前 compact，不在保存时深拷贝 fat runtime**
2. **`toolCall(read)` 历史只保留 preview，不保留完整 `content`**
3. **`toolCall` 按 `toolCallId` 做逻辑去重，shadow 只兜底、不落双份**
4. **`turn.itemIds` / `activeItemIds` 跟随 dedupe 结果重写**

## 6.2 `read` 的新持久化合同

### 当前 live 结果（保留现状）

运行中仍允许工具返回：

```ts
{
  ok: true,
  path,
  content,
  totalChars,
  truncated,
  virtualFromProposal,
  proposalSources
}
```

### 新的 history persistence 结果（推荐）

仅在 **落盘 / draft / pending / restore snapshot** 路径上改成：

```ts
{
  ok: true,
  path,
  totalChars,
  truncated,
  virtualFromProposal,
  proposalSources,
  persistedContentMode: "preview_only",
  previewChars: 2000,
  contentPreview: "...",
  summary: "已读取文件（历史仅保留预览）"
}
```

约束：

1. 不再把完整 `content` 写进 per-conv / pending / draftSnapshot
2. `summary` 必须存在，保证 `ToolCallCard` 恢复后仍能显示稳定状态线
3. `path / totalChars / truncated / virtualFromProposal / proposalSources` 必须保留，避免恢复语义退化
4. 后续如要支持“点击历史工具卡再看全文”，应单开 **artifact pointer / sidecar** spec，不在本期硬并

## 6.3 shadow item 与 authoritative item 的去重规则

### 为什么不能只靠 `id`

当前 authoritative runtime item 的形状来自 Gateway runtime：

- `id = item_tool_xxx`
- `toolCallId = 真正的 tool call id`

当前 shadow item 的形状来自 `runStore.addTool()/patchTool()`：

- `id = 本地 step id`
- 现在默认把 `toolCallId` 也写成 `step.id`

这会导致一个问题：

- 两份其实是同一逻辑工具调用，但既 **`id` 不同**，也可能 **`toolCallId` 对不上**

### 推荐修正

1. `ToolBlockStep` 增加可选 `toolCallId?: string`
2. `wsTransport` 在收到 `tool.call` 时，把真实 `toolCallId` 挂到本地 `ToolBlockStep`
3. `buildShadowItemFromToolStep()` 优先写入真实 `toolCallId`
4. shadow item 增加本地标记 `shadowSource: "tool_step"`（仅 Desktop 内部使用）
5. 持久化前按逻辑键去重：
   - `toolCall`：优先 `toolCallId`
   - 其它 item：继续按 `id`
6. 同一逻辑键下的保留优先级：
   - authoritative runtime item
   - 否则保留 shadow item

## 6.4 `turns` / `activeItemIds` 的别名重写

去重之后，旧的 shadow item id 可能不再存在。

因此必须同步做两件事：

1. `turn.itemIds` 通过 `aliasMap(oldId -> keptId)` 重写
2. `activeItemIds` 也做同样重写并去重

否则会出现两类伪回归：

1. turn 还在引用被删掉的 shadow id
2. active overlay 在 reload 后指向不存在的 item

## 6.5 保留什么，不裁什么

本期必须保留：

1. `fileChange` / proposal / undo 相关字段
   - `actionSpec`
   - `preview`
   - `changes`
   - `kept / applied / undoable / canUndo`
2. `thread.waitingFor`
3. `thread.taskState`
4. `projectDir`
5. `collabSessions`
6. `draftSnapshotOwnerId`
7. `pending conversations` crash-safe 兜底

原因：

- 这些字段都属于“恢复正确性合同”，不是大 payload 主因

---

## 7. 为什么不选别的方案

## 7.1 不选“这一期直接上 artifact sidecar”

不选原因：

1. 要新增 GC、引用一致性、迁移、删除时机
2. 会引入新的“主文件存在但 sidecar 丢了”的恢复分叉
3. 当前用户要求是 **保守方案优先**

## 7.2 不选“直接删掉 `items/turns`，只靠 `steps`”

不选原因：

1. 会破坏 proposal / undo / waiting / runtime overlay 恢复
2. 与最近几轮 runtime/restore 修复方向冲突

## 7.3 不选“顺手把 ChatArea 虚拟化也一起做了”

不选原因：

1. 当前最大头是 `snapshot.items`，不是 `steps`
2. 窗口化是另一类风险：会牵涉 transcript 恢复、滚动定位、segment 补档
3. 本期应该先切掉 fat payload；若之后仍是 DOM/渲染瓶颈，再单开窗口化 spec

---

## 8. 详细改动点（含锚点与 diff 草案）

以下内容主要保留为立项时的设计草案与对照思路。
当前实现已经覆盖其中大部分改动，阅读时请优先以上面的“实施状态”和当前源码为准；这里的旧行号 / diff 仅用于解释为什么这样收口。

## 8.1 `apps/desktop/src/state/runStore.ts`

- 符号：
  - `ToolBlockStep`
  - `buildShadowItemFromToolStep()` `:651`
  - `setItems()` `:782`
  - `addTool()` `:1194`
  - `patchTool()` `:1226`

### 目标

1. 给 shadow item 一个可靠的逻辑关联键
2. 不改 live UI 行为，只补齐“同一工具调用”的标识

### 统一 diff 草案

```diff
--- a/apps/desktop/src/state/runStore.ts
+++ b/apps/desktop/src/state/runStore.ts
@@
 export type ToolBlockStep = {
   id: string;
   type: "tool";
   toolName: string;
   status: "running" | "success" | "failed" | "undone";
+  toolCallId?: string;
   input?: unknown;
   output?: unknown;
@@
 function buildShadowItemFromToolStep(args: {
   step: ToolBlockStep;
@@
   return {
     id: step.id,
     threadId,
     turnId,
     type: "toolCall",
     status: stepStatusToItemStatus(step),
     createdAt: String((existing as any)?.createdAt ?? nowIso),
     updatedAt: nowIso,
-    toolCallId: step.id,
+    toolCallId: String(step.toolCallId ?? step.id),
     name: step.toolName,
     args: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? (step.input as Record<string, unknown>) : {},
     executedBy: "desktop",
     result: step.output,
+    shadowSource: "tool_step",
     error: step.status === "failed" ? String((step.output as any)?.error ?? "TOOL_FAILED") : undefined,
     riskLevel: step.riskLevel,
     applyPolicy: step.applyPolicy,
   } as RuntimeItemRecord;
 }
@@
   addTool: (tool) => {
@@
     const step: ToolBlockStep = {
       id,
       type: "tool",
       toolName: tool.toolName,
+      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
       status: tool.status,
@@
   patchTool: (stepId, patch) =>
     set((s) => {
@@
         if (step.id === stepId && step.type === "tool") {
           nextTool = { ...step, ...patch };
           return nextTool;
         }
```

### 说明

本期不建议在 `runStore.setItems()/upsertItem()` 直接改成“按逻辑键去重”，因为那会改变 live runtime 行为；先把去重放在 **持久化 projection** 层更保守。

## 8.2 `apps/desktop/src/agent/wsTransport.ts`

- 符号：
  - `tool.call` 事件处理 `:1365`
  - `tool.result` 回填 `:1648`

### 目标

把真实 `toolCallId` 传给本地 `ToolBlockStep`，让 shadow item 与 authoritative item 可关联。

### 统一 diff 草案

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
 const stepId = addTool({
   toolName: name,
+  toolCallId,
   status: "running",
   input: parsedArgsPreview,
   output: null,
@@
 patchTool(stepId, {
   status: exec.result.ok ? "success" : "failed",
+  toolCallId,
   input: exec.parsedArgs,
   output: exec.result.ok ? exec.result.output : failedOutput,
@@
 patchTool(stepId, {
   status: ok0 ? "success" : "failed",
+  toolCallId,
   output: out,
   ...(meta && typeof meta === "object"
     ? { applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy, riskLevel: (meta as any).riskLevel ?? st.riskLevel }
     : {}),
 });
```

### 说明

这一步只补关联键，不改现有 `gatewayToolStepIdsByCallId`、`submitToolResult()`、`tool.result` 回填流程。

## 8.3 `apps/desktop/src/state/conversationStore.ts`

- 符号：
  - `slimRuntimeItemForHistory()` `:462`
  - `slimSnapshotForHistory()` `:512`
  - `buildCurrentSnapshot()` `:619`
  - `schedulePersistToDisk()` `:783`
  - `updateConversation()` `:1115`
  - `setDraftSnapshot()` `:1185`
  - `flushDraftSnapshotNow()` `:1205`

### 目标

1. `buildCurrentSnapshot()` 不再先深拷贝 fat runtime
2. 新增明确的 runtime persistence compactor
3. `read` 只保留 preview
4. turns / active ids 跟随 dedupe 结果重写

### 统一 diff 草案

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@
+const MAX_READ_HISTORY_PREVIEW_CHARS = 2000;
+
+function compactToolResultForHistory(toolName: string, raw: unknown) {
+  const out = raw && typeof raw === "object" ? ({ ...(raw as any) } as Record<string, unknown>) : raw;
+  if (toolName !== "read" || !out || typeof out !== "object") {
+    return slimToolIoForHistory(toolName, raw);
+  }
+  const path = String((out as any).path ?? "").trim();
+  const totalChars = Number((out as any).totalChars ?? 0) || 0;
+  const fullContent = typeof (out as any).content === "string" ? String((out as any).content) : "";
+  const contentPreview = fullContent ? fullContent.slice(0, MAX_READ_HISTORY_PREVIEW_CHARS) : "";
+  return {
+    ok: (out as any).ok !== false,
+    path,
+    totalChars,
+    truncated: Boolean((out as any).truncated),
+    virtualFromProposal: Boolean((out as any).virtualFromProposal),
+    proposalSources: Array.isArray((out as any).proposalSources) ? (out as any).proposalSources : [],
+    persistedContentMode: "preview_only",
+    previewChars: contentPreview.length,
+    ...(contentPreview ? { contentPreview } : {}),
+    summary: path
+      ? `已读取 ${path}（历史仅保留预览）`
+      : "已读取文件（历史仅保留预览）",
+  };
+}
+
+function compactRuntimeItemsForHistory(items?: RuntimeItemRecord[]) {
+  const list = Array.isArray(items) ? items : [];
+  const aliasMap = new Map<string, string>();
+  const grouped = new Map<string, RuntimeItemRecord>();
+
+  for (const item of list) {
+    if (!item || typeof item !== "object") continue;
+    const logicalKey =
+      item.type === "toolCall"
+        ? `tool:${String((item as any).toolCallId ?? "").trim() || String(item.id ?? "").trim()}`
+        : `id:${String(item.id ?? "").trim()}`;
+    if (!logicalKey) continue;
+    const prev = grouped.get(logicalKey);
+    const preferIncoming =
+      !prev
+      || ((prev as any).shadowSource === "tool_step" && (item as any).shadowSource !== "tool_step");
+    if (preferIncoming) {
+      if (prev && String(prev.id ?? "").trim() && String(item.id ?? "").trim() && prev.id !== item.id) {
+        aliasMap.set(String(prev.id), String(item.id));
+      }
+      grouped.set(logicalKey, item);
+    } else if (String(item.id ?? "").trim() && prev && String(prev.id ?? "").trim() && prev.id !== item.id) {
+      aliasMap.set(String(item.id), String(prev.id));
+    }
+  }
+
+  const compacted = Array.from(grouped.values()).map((item) =>
+    slimRuntimeItemForHistory({
+      ...item,
+      ...(item.type === "toolCall"
+        ? { result: compactToolResultForHistory(String((item as any).name ?? ""), (item as any).result) }
+        : {}),
+    } as RuntimeItemRecord),
+  );
+  return { items: compacted, aliasMap };
+}
+
+function remapHistoryItemIds(ids: string[] | undefined, aliasMap: Map<string, string>) {
+  return Array.from(
+    new Set(
+      (Array.isArray(ids) ? ids : [])
+        .map((id) => String(aliasMap.get(String(id ?? "").trim()) ?? String(id ?? "").trim()).trim())
+        .filter(Boolean),
+    ),
+  );
+}
+
-function slimSnapshotForHistory(snapshot: RunSnapshot | null | undefined): RunSnapshot | null {
+function slimSnapshotForHistory(snapshot: RunSnapshot | null | undefined): RunSnapshot | null {
   if (!snapshot || typeof snapshot !== "object") return null;
+  const compactedItems = compactRuntimeItemsForHistory((snapshot as any).items as RuntimeItemRecord[] | undefined);
@@
-  const turnsSlim = clampTailForHistory((snapshot as any).turns as RuntimeTurnRecord[] | undefined, MAX_RUNTIME_TURNS_HISTORY)
-    .map((turn) => slimRuntimeTurnForHistory(turn));
-  const itemsSlim = clampTailForHistory((snapshot as any).items as RuntimeItemRecord[] | undefined, MAX_RUNTIME_ITEMS_HISTORY)
-    .map((item) => slimRuntimeItemForHistory(item));
+  const turnsSlim = clampTailForHistory((snapshot as any).turns as RuntimeTurnRecord[] | undefined, MAX_RUNTIME_TURNS_HISTORY)
+    .map((turn) => slimRuntimeTurnForHistory({
+      ...turn,
+      itemIds: remapHistoryItemIds((turn as any)?.itemIds, compactedItems.aliasMap),
+    } as RuntimeTurnRecord));
+  const itemsSlim = clampTailForHistory(compactedItems.items, MAX_RUNTIME_ITEMS_HISTORY);
@@
-    activeItemIds: clampTailForHistory((snapshot as any).activeItemIds as string[] | undefined, MAX_RUNTIME_TURN_ITEM_IDS_HISTORY)
-      .map((id) => String(id ?? "").trim())
-      .filter(Boolean),
+    activeItemIds: clampTailForHistory(
+      remapHistoryItemIds((snapshot as any).activeItemIds as string[] | undefined, compactedItems.aliasMap),
+      MAX_RUNTIME_TURN_ITEM_IDS_HISTORY,
+    ),
@@
 export function buildCurrentSnapshot(): RunSnapshot {
   const s = useRunStore.getState();
@@
-    thread: sanitizeThreadCollabState(
-      (s.thread && typeof s.thread === "object") ? JSON.parse(JSON.stringify(s.thread)) : null,
-      normalizedCollabSessions as RuntimeCollabSessionRecord[],
-    ),
-    turns: Array.isArray((s as any).turns) ? JSON.parse(JSON.stringify((s as any).turns)) : [],
-    items: Array.isArray((s as any).items) ? JSON.parse(JSON.stringify((s as any).items)) : [],
+    thread: sanitizeThreadCollabState(
+      (s.thread && typeof s.thread === "object") ? (s.thread as RuntimeThreadRecord) : null,
+      normalizedCollabSessions as RuntimeCollabSessionRecord[],
+    ),
+    turns: Array.isArray((s as any).turns) ? ((s as any).turns as RuntimeTurnRecord[]) : [],
+    items: Array.isArray((s as any).items) ? ((s as any).items as RuntimeItemRecord[]) : [],
     collabSessions: normalizedCollabSessions as RuntimeCollabSessionRecord[],
@@
   return slimSnapshotForHistory(rawSnapshot) ?? rawSnapshot;
 }
```

### 说明

这一段是本期真正的根因修复点：**不是只把磁盘文件写轻，而是让 renderer 在保存前就不再 clone fat runtime。**

## 8.4 `apps/desktop/electron/main.cjs`

- 符号：
  - `buildSnapshotFromV2Payload()` `:754`
  - `saveSingleConversationFileV2()` `:1071`
  - `saveConversationsV2()` `:1417`
  - `saveConversationsV2Sync()` `:1620`
  - `history.readConversationSnapshot` `:3435`

### 目标

1. 主进程做一次 **defensive normalization**
2. 避免 legacy / fallback / sync save 把 fat runtime 重新写回 v2
3. 继续保持 `includeSteps:false` + `loadConversationSegment()` 的恢复范式

### 统一 diff 草案

```diff
--- a/apps/desktop/electron/main.cjs
+++ b/apps/desktop/electron/main.cjs
@@
+function compactHistorySnapshotForV2(snapshot) {
+  const snap = snapshot && typeof snapshot === "object" ? snapshot : null;
+  if (!snap) return null;
+  // 与 renderer 侧 contract 对齐：
+  // 1) read.result.content 不落完整正文
+  // 2) turns/itemIds/activeItemIds 使用 compact 后的 item id
+  // 3) projectDir/thread/taskState/fileChange 相关字段不裁
+  return snap;
+}
+
 async function saveSingleConversationFileV2(historyDir, rawConv) {
@@
-  const snapshot = rawConv.snapshot && typeof rawConv.snapshot === "object" ? rawConv.snapshot : null;
+  const snapshot = compactHistorySnapshotForV2(
+    rawConv.snapshot && typeof rawConv.snapshot === "object" ? rawConv.snapshot : null,
+  );
@@
 async function saveConversationsV2(historyDir, payloadObj) {
@@
-    const snapshot = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null;
+    const snapshot = compactHistorySnapshotForV2(
+      raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null,
+    );
@@
 function saveConversationsV2Sync(historyDir, payloadObj) {
@@
-    const snapshot = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null;
+    const snapshot = compactHistorySnapshotForV2(
+      raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null,
+    );
@@
 ipcMain.handle("history.readConversationSnapshot", async (_event, params) => {
@@
-      if (v2Payload) {
-        snapshot = buildSnapshotFromV2Payload(v2Payload, { includeSteps });
-      }
+      if (v2Payload) {
+        snapshot = buildSnapshotFromV2Payload(v2Payload, { includeSteps });
+      }
@@
       if (needV1Fallback) {
         const fallbackConv = await tryLoadConversationFromV1(dir, convId);
@@
-          snapshot = snapshot
+          snapshot = snapshot
             ? {
                 ...fallbackSnapshot,
                 ...snapshot,
@@
-              };
+              };
+          snapshot = compactHistorySnapshotForV2(snapshot);
         }
       }
```

### 说明

主进程这层不是主战场，但必须作为 safety net 存在。这样即使：

1. 某条旧历史从 v1 fallback 回填
2. 某条同步写盘路径绕过 renderer 最新 helper
3. 未来某处又把 fat snapshot 传进来

也不会把 v2 per-conv 再写胖回去。

## 8.5 `apps/desktop/src/ui/components/ChatArea.tsx`

- 符号：
  - `renderSteps` `:1104`
  - `renderRows` `:1122`
  - autosave effect `:1267`

### 本期决策

**不在本 spec 里改成窗口化。**

本期只要求：

1. `buildCurrentSnapshot()` 变轻后，autosave 继续复用现有脏标记/轮询机制
2. `buildAutosaveSignature()` 保持当前轻量摘要签名，不升级为 full payload hash
3. 如果做完本期后仍然是超长 active transcript 的 DOM 压力，再单开 ChatArea virtualization spec

---

## 9. 验证清单

## 9.1 恢复正确性

准备一条包含大 `read.result.content` 的历史会话，验证：

1. `history.readConversationSnapshot({ includeSteps:false })` 仍能恢复：
   - `projectDir`
   - `thread.waitingFor`
   - `taskState`
   - `draftSnapshotOwnerId`
2. `history.loadConversationSegment()` 仍能补齐首屏 transcript
3. `title / pinned / archived / activeConvId` 不丢
4. `snapshotLoaded=false` 的 index-only 会话不会覆盖已有 per-conv 详情

## 9.2 proposal / undo 正确性

跑一轮带 `read + proposal/fileChange` 的长任务，验证：

1. Keep / Undo 入口仍可见
2. reload 后 proposal 卡仍能显示
3. `actionSpec` 没被 compact 掉
4. `canReplayAfterReload=false` 语义不变

## 9.3 体积与热路径

同一轮任务前后对比：

1. 单条 `conv_<id>.json` 文件体积明显下降
2. `draftSnapshot` / pending payload 不再出现完整 `read.result.content`
3. renderer 侧 `buildCurrentSnapshot()` 不再深拷贝 fat `items/turns/thread`

## 9.4 回归兜底

验证以下场景都不退化：

1. 切会话
2. 运行结束立即 flush
3. beforeunload 同步写盘
4. v1 fallback 恢复后回写 v2

---

## 10. 兼容性、迁移与回滚

## 10.1 兼容性

1. 不改 Gateway
2. 不改 v2 文件主结构（仍是 `head + steps + logs + thread + turns + items + collabSessions + activeItemIds`）
3. 只是把 `items.result` 的大正文收口为 preview-only contract
4. transcript 仍由 `steps + loadConversationSegment()` 承担

## 10.2 迁移方式

采用 **lazy migration**：

1. 旧 v2 / v1 数据不做全量批处理
2. 某条会话被恢复、保存、同步写盘时，按新 contract 重写
3. 这样风险最小，不需要一次性扫全历史

## 10.3 回滚

若本期出现回归，可按层回滚：

1. 先关掉主进程 `compactHistorySnapshotForV2()` safety net
2. 再回退 renderer 的 `compactRuntimeItemsForHistory()`
3. `history index-first / project tree-first / loadConversationSegment()` 不需要回退

---

## 11. 本期之后仍然存在的隐患（但不应阻止本期落地）

即使本期全部完成、且 **不动 Gateway**，仍有三类剩余风险：

1. **live run 峰值内存仍可能偏高**
   - 因为模型本轮真的发了很多大 `read`
   - 本期切掉的是“持久化放大”和“恢复放大”，不是“单轮 live 峰值上限”
2. **其它大文本工具输出还可能继续长胖**
   - 例如未来新增大 `web.fetch` / 大 `shell.exec` / 大结构化结果
   - 本期只对 `read` 做特化合同
3. **超长 transcript 的 DOM/渲染压力还在**
   - 这属于 ChatArea virtualization 的后续 phase

所以，本期是：

- **先把最危险、最确定、最保守的一段切掉**

而不是声称：

- “做完后 Desktop 永远不可能再 OOM”

---

## 12. 建议实施顺序

1. 先补 `ToolBlockStep.toolCallId` + shadow item 关联键
2. 再落 `conversationStore` 的 runtime compactor
3. 然后在 `main.cjs` 增加 defensive normalization
4. 最后跑：
   - 恢复 smoke
   - proposal / undo smoke
   - 大 `read` 历史体积 smoke

这个顺序最保守，也最接近当前仓库的已落能力。
