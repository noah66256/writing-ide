# Gateway + Desktop Large Payload Contract（v0.1）

> 状态：Proposal  
> 基线：`HEAD 5b8e1ab9596acd76b23e653f395717ec8548afb6`  
> 目标：把 `tool result / runtime item / thread.snapshot / conversation snapshot` 从“原始大 payload 多处常驻、重复复制”改成“当前执行链路可短暂持有 full payload，长期状态只保留 compact envelope”，切断 Desktop OOM 与后续同类隐患。

---

## 1. 结论先行

这次不能再做 `Desktop-only` 止血，也不能只在 Gateway 加一层字符串截断。

推荐方案只有一句话：

> **原始大 payload 只允许存在于“工具刚执行完到模型消费完”的短生命周期缓存；一旦进入 transcript / item / SSE / thread.snapshot / history，就必须先 compact 成统一 envelope。**

本期成功标准：

1. `tool.result` SSE 不再下发 raw `output`
2. `CanonicalToolResultItem.output` / `ToolCallItem.result` 不再默认持有 raw full payload
3. Desktop 本地执行工具后，不再把 raw full `output` 长驻进 `runStore.steps/items`
4. `thread.snapshot(stream.replaceStrategy="replace")` 在 Desktop 端真正按 authoritative replace 生效，shadow item 不再长期双份保留
5. pending / 主历史 / per-conv 不再保存完整 `read.result.content`
6. `proposal-first / undo / waiting-user / collab / projectDir / draftSnapshotOwnerId` 语义不退化

---

## 2. 为什么这次必须动 Gateway

当前放大链路已经确认是跨层问题，不是单点问题。

### 2.1 已确认事实（基于当前工作树）

1. Gateway 虽然有 `normalizeToolOutputText()` / `MAX_TOOL_RESULT_CHARS`，但 `tool.result` 事件仍直接发 raw `output`
   - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:2933`
2. Gateway canonical transcript 仍把 raw `output` 写进 `CanonicalToolResultItem.output`
   - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:3109`
   - `apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts:47`
3. Gateway 回放给模型时，仍把 `details: item.output` 带回 Provider 消息
   - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:3200`
4. Gateway `itemEmitter` 会把 raw `data.output` 原样挂进 authoritative `item.result`
   - `apps/gateway/src/agent/runtime/itemEmitter.ts:151`
5. `thread.snapshot` 再把整份 `snapshotItems` 发给 Desktop，且已有 `replaceStrategy: "replace"` 可复用
   - `apps/gateway/src/agent/runFactory.ts:5037`
6. Desktop 本地工具执行后，会先 `patchTool(output=full)`，再 `submitToolResult(full)`
   - `apps/desktop/src/agent/wsTransport.ts:1621`
   - `apps/desktop/src/agent/wsTransport.ts:1634`
7. Desktop 收到 `thread.snapshot` / `tool.result` 后，会继续把这些大对象塞回 `runStore.items/steps`
   - `apps/desktop/src/agent/wsTransport.ts:1131`
   - `apps/desktop/src/agent/wsTransport.ts:1665`
   - `apps/desktop/src/state/runStore.ts:704`
8. Desktop 持久化链仍从 `runStore` 深拷贝 `thread / turns / items`
   - `apps/desktop/src/state/conversationStore.ts:619`
   - `apps/desktop/src/state/conversationStore.ts:783`
   - `apps/desktop/electron/main.cjs:1071`
   - `apps/desktop/electron/main.cjs:3435`

### 2.2 结论

如果只做 Desktop：

- 启动恢复会更轻，但运行中 Gateway 仍会把 fat payload 继续喂给 Desktop
- canonical transcript / provider `details` / authoritative item 仍会继续长胖
- 只是把问题从“重启恢复爆”挪成“长任务运行中慢性爆”

如果只做 Gateway：

- Desktop 本地 `executeToolCall()` 之后，raw `output` 仍会先进入 `patchTool()` / shadow item / autosave
- OOM 会继续在 renderer 本地热链里发生

---

## 3. 为什么不是“再加一层 truncate”

单纯截断不是根因修复，原因有三条：

1. **截断只能缩小单份对象，不能消除多份复制**
   - 当前至少有 Desktop step、Desktop shadow item、Gateway transcript、Gateway authoritative item、SSE、thread snapshot、history 多处复制
2. **截断无法统一合同**
   - Gateway 和 Desktop 继续各自保存 `unknown`，后续一定再次漂移
3. **截断会混淆“当前执行需要 full payload”和“长期状态只需要 compact payload”**
   - 真正该做的是区分生命周期，而不是所有地方共用一个被截断后的值

因此，本期要收的是 **生命周期合同**，不是再补一层 `slice()`

---

## 4. 一手对照组结论（Codex 范式）

已核对本地参考源码：

- `third_party/openai-codex/codex-rs/app-server/src/codex_message_processor.rs:3115`
- `third_party/openai-codex/codex-rs/app-server/src/codex_message_processor.rs:7407`
- `third_party/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs:3033`
- `third_party/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs:3490`

对本问题最关键的启发只有两条：

1. `thread/read(includeTurns=false)` 默认走轻量热路径；重历史不是默认 full-fat hydrate
2. persistent history 不是默认把所有运行态大对象原样常驻

翻译到本项目：

> **当前 turn 的 full tool payload 可以短暂存在；thread/history 的长期形态必须轻。**

---

## 5. 本期范围与非目标

## 5.1 本期范围

1. 统一 `tool result` 的 compact envelope 合同
2. 收口 Gateway transcript / event / snapshot 的大 payload
3. 收口 Desktop 本地执行后的 shadow item / step.output
4. 修正 Desktop 对 authoritative snapshot 的消费语义
5. 将持久化统一到 compact envelope，而不是另造一套只给历史用的形状

## 5.2 明确不做

1. 不把 ChatArea 窗口化并入本期
2. 不改项目树加载 spec（`tree-first + ensureLoaded(path)` 另有既有 spec）
3. 不把 `proposal-first` / undo 语义简化成只剩摘要
4. 不把 collab / waiting-user / taskState 从 snapshot 中裁掉
5. 不把 raw full payload 落进 `apps/gateway/data/db.json`

---

## 6. 新合同：`ToolResultEnvelope`

## 6.1 设计原则

新合同必须同时满足：

1. **当前 turn 语义不变**：模型仍能消费刚刚执行完的 full result
2. **长期状态变轻**：transcript / item / snapshot / history 不再保存 raw full result
3. **Desktop / Gateway 同形**：两端不再各自发明“缩略版”
4. **兼容旧历史**：读取时允许 legacy `unknown`，写入时统一转新形状

## 6.2 推荐形状

建议在 `packages/shared` 新增统一类型（可放 `packages/shared/src/runtime/tool-result-envelope.ts`）：

```ts
export type ToolResultEnvelope =
  | {
      schemaVersion: 1;
      mode: "inline";
      previewKind: "text" | "json" | "error" | "read_file";
      summary: string;
      normalizedText: string;
      approxChars: number;
      truncated: boolean;
      inline: unknown;
      fullContentAvailability: "inline";
    }
  | {
      schemaVersion: 1;
      mode: "preview";
      previewKind: "text" | "json" | "error" | "read_file";
      summary: string;
      normalizedText: string;
      approxChars: number;
      truncated: boolean;
      preview: unknown;
      fullContentAvailability: "turn_local_only";
    };
```

约束：

1. 小 payload 允许 `mode="inline"`
2. 大 payload 必须转 `mode="preview"`
3. `normalizedText` 作为统一的人类可读摘要线，也是 Provider fallback 文本
4. `summary` 供工具卡、历史列表、调试输出使用
5. `fullContentAvailability: "turn_local_only"` 明确声明：full payload 只存在于当前 turn 的短生命周期缓存，不是长期状态

## 6.3 `read` 的 preview 形状

对 `read`，preview 必须保留最小可恢复语义：

```ts
{
  ok: true,
  path,
  totalChars,
  truncated,
  virtualFromProposal,
  proposalSources,
  previewChars,
  contentPreview,
}
```

并要求：

1. `path / totalChars / truncated / virtualFromProposal / proposalSources` 不能裁
2. `content` 不能再进入长期状态
3. `summary` 统一生成，例如：`已读取 drafts/a.md（历史仅保留预览）`

## 6.4 阈值建议

建议新增统一阈值：

- `MAX_INLINE_TOOL_RESULT_CHARS = 8_000`
- `MAX_TOOL_RESULT_PREVIEW_CHARS = 2_000`

原则：

1. 小结果继续 inline，避免小题大做
2. 大结果统一 preview，避免进入长期状态
3. 当前 `read` 本身已有 `40_000` 截断上限；本期不改工具返回上限，只改“进入长期状态前的形状”

## 6.5 生命周期原则

### 当前 turn

- 允许存在 raw full payload
- 但只允许存在于 **非持久化、非 store、非 transcript** 的短生命周期缓存里

### turn 结束后 / 历史持久化后

- 只允许保留 `ToolResultEnvelope`
- raw full payload 必须从 Desktop store / Gateway transcript / SSE / snapshot / history 中消失

---

## 7. 跨层机制设计

## 7.1 Shared：先把合同立住

目标：

1. Desktop / Gateway 不再用 `unknown` 裸奔
2. 后续读取旧数据时仍兼容 legacy 值

建议：

1. `ToolCallItem.result` 改为 `ToolResultEnvelope | unknown`
2. `ToolCallItem` 增加可选 `shadowSource?: "tool_step"`
3. `ToolBlockStep` 增加可选 `toolCallId?: string`
4. 新增 `isToolResultEnvelope()` / `toToolResultEnvelope()` 纯函数 helper

### 统一 diff 草案

```diff
--- a/packages/shared/src/runtime/thread-turn-item.ts
+++ b/packages/shared/src/runtime/thread-turn-item.ts
@@
+export type ToolResultEnvelope = ...;
@@
 export type ToolCallItem = ItemBase & {
   type: "toolCall";
   toolCallId: string;
   name: string;
@@
-  result?: unknown;
+  result?: ToolResultEnvelope | unknown;
   error?: string;
   riskLevel?: "low" | "medium" | "high";
   applyPolicy?: "proposal" | "auto_apply";
+  shadowSource?: "tool_step";
 };
```

---

## 7.2 Gateway：raw full payload 只保留在 turn-local cache

### 目标

1. Gateway 继续吃到 Desktop 上传的 raw full result
2. 但从 `tool.result` 事件开始，对外只发 compact envelope
3. canonical transcript 不再持有 raw full output
4. Provider 消费 full result 的能力只保留在当前 turn 内部，不再跨 turn 常驻

### 推荐机制

在 `GatewayRuntime` 增加两组 helper：

1. `compactToolResultEnvelope(toolName, rawOutput)`  
   - 把 raw output 转成 `ToolResultEnvelope`
2. `turnLocalRawToolResults: Map<string, unknown>`  
   - key=`toolCallId`
   - 只保存当前 turn 内刚执行完成的 raw full result
   - 在 `turn.completed` / `run.end` / `abort` 时清空

### 事件链改造

当前：

`desktop raw result -> tool.result(raw) -> itemEmitter(raw) -> canonical transcript(raw) -> provider details(raw) -> thread.snapshot(raw)`

改造后：

`desktop raw result -> Gateway turnLocalRawToolResults.set(raw) -> compact envelope -> tool.result(envelope) -> itemEmitter(envelope) -> canonical transcript(envelope) -> thread.snapshot(envelope)`

### Provider 回放规则

1. **当前 turn 内、且 `toolCallId` 命中 `turnLocalRawToolResults`**  
   - 可继续给 Provider 传 raw result（保持当前 turn 语义）
2. **历史 tool result / 已 compact 的旧 turn**
   - 只传 `normalizedText`
   - 不再把 legacy `details: raw` 常驻带回

这条规则是本期真正的“既不改坏当前 turn，又不把旧结果永久拖着跑”。

### `writingAgentRunner` 旁路约束

仓库中仍有多处 `writingAgentRunner.ts` 直接写 `tool.result` / `tool_result` 的路径。  
本期要求它们全部复用同一个 `compactToolResultEnvelope()` helper，禁止旁路继续发 raw `output`。

### 统一 diff 草案

```diff
--- a/apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts
+++ b/apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts
@@
 export type CanonicalToolResultItem = {
   kind: "tool_result";
   callId: string;
   toolName: string;
   ok: boolean;
-  output: unknown;
+  output: ToolResultEnvelope | unknown;
   normalizedText: string;
   providerMeta?: Record<string, unknown>;
 };
```

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
+private readonly turnLocalRawToolResults = new Map<string, unknown>();
@@
+function compactToolResultEnvelope(toolName: string, rawOutput: unknown): ToolResultEnvelope {
+  ...
+}
@@
 const output = details?.output ?? this._extractContentText(event.result?.content);
+const envelope = compactToolResultEnvelope(rawToolName, output);
+this.turnLocalRawToolResults.set(event.toolCallId, output);
@@
 this.config.runCtx.writeEvent("tool.result", {
   toolCallId: event.toolCallId,
   name: rawToolName,
   ok,
-  output,
+  output: envelope,
   meta,
 });
@@
 const item: CanonicalToolResultItem = {
   kind: "tool_result",
   callId: message.toolCallId,
   toolName: this._decodeRuntimeToolName(message.toolName),
   ok,
-  output,
+  output: envelope,
   normalizedText,
@@
 case "tool_result": {
   flushAssistant();
+  const rawForCurrentTurn = this.turnLocalRawToolResults.get(item.callId);
   out.push({
     role: "toolResult",
     toolCallId: item.callId,
     toolName: this._encodeRuntimeToolName(item.toolName),
     content: buildTextContent(item.normalizedText),
-    details: item.output,
+    ...(rawForCurrentTurn !== undefined ? { details: rawForCurrentTurn } : {}),
     isError: !item.ok,
   } as ToolResultMessage);
 }
@@
+// 在 turn completed / run end 时清空
+this.turnLocalRawToolResults.clear();
```

### 说明

这里故意不引入新的 Gateway 长期 sidecar/blob 存储。  
原因很简单：本期首要目标是**切断 OOM 链路**，不是立刻做完整的长期 artifact 系统。  
如果后续确实需要“历史工具卡重新打开 full payload”，再单开 `ref` 模式即可；当前 schema 已预留可扩展空间。

---

## 7.3 Gateway `itemEmitter` / `thread.snapshot`：权威状态只能发 compact

### 目标

1. authoritative item 不再带 raw `result`
2. `thread.snapshot.items` 不再成为 fat payload 扩散器

### 统一 diff 草案

```diff
--- a/apps/gateway/src/agent/runtime/itemEmitter.ts
+++ b/apps/gateway/src/agent/runtime/itemEmitter.ts
@@
   item.status = data.ok === false ? "failed" : "completed";
-  item.result = data.output;
+  item.result = data.output; // data.output 已是 ToolResultEnvelope
   item.error = typeof data.error === "string" ? data.error : undefined;
```

这里看似改动很小，但前提变了：  
`itemEmitter` 不再接 raw `output`，而是只接 compact envelope。

---

## 7.4 Desktop：本地工具执行后立刻 compact，不再把 raw 结果塞进 store

### 目标

1. 本地工具刚执行完时，raw 结果仍能发给 Gateway
2. 但 `runStore.steps/items` 只保留 compact envelope
3. shadow item 与 authoritative item 用真实 `toolCallId` 对齐

### 推荐机制

Desktop 端新增短生命周期 map：

```ts
const pendingRawToolResultsByCallId = new Map<string, unknown>();
```

执行顺序改为：

1. `executeToolCall()` 得到 raw result
2. `pendingRawToolResultsByCallId.set(toolCallId, rawResult)`
3. 本地 `patchTool(stepId, { output: compactEnvelope })`
4. `submitToolResult({ output: rawResult })`
5. 收到 Gateway 对应 `tool.result` / `item.completed` / `thread.snapshot` 后清掉 `pendingRawToolResultsByCallId`

这样：

1. 当前 turn 不丢 full result
2. UI/store/autosave/history 不再反复持有 full result

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
-  output?: unknown;
+  output?: ToolResultEnvelope | unknown;
@@
   return {
     id: step.id,
@@
-    toolCallId: step.id,
+    toolCallId: String(step.toolCallId ?? step.id),
@@
-    result: step.output,
+    result: step.output,
+    shadowSource: "tool_step",
```

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
+const pendingRawToolResultsByCallId = new Map<string, unknown>();
@@
 const stepId = addTool({
   toolName: name,
+  toolCallId,
   status: "running",
@@
 const rawOutput = exec.result.ok ? exec.result.output : failedOutput;
+const compactOutput = compactToolResultEnvelope(name, rawOutput);
+pendingRawToolResultsByCallId.set(toolCallId, rawOutput);
 patchTool(stepId, {
   status: exec.result.ok ? "success" : "failed",
+  toolCallId,
   input: exec.parsedArgs,
-  output: rawOutput,
+  output: compactOutput,
@@
 submitToolResult({
   toolCallId,
   name,
   ok: exec.result.ok,
-  output: rawOutput,
+  output: rawOutput,
   meta: { ... }
 });
@@
 if (event === "tool.result") {
   ...
   patchTool(stepId, {
     status: ok0 ? "success" : "failed",
-    output: out,
+    toolCallId,
+    output: out, // 这里 out 已是 Gateway 回来的 compact envelope
   });
+  pendingRawToolResultsByCallId.delete(toolCallId);
 }
```

---

## 7.5 Desktop：`thread.snapshot` 必须真正按 authoritative replace 消费

这一步和 payload contract 是同一件事，不补这里就还会双份。

### 当前问题

Gateway 已经发：

```ts
stream: {
  snapshotSeq,
  cursor,
  replaceStrategy: "replace",
}
```

但 Desktop 现在仍然：

1. `applyThreadSnapshot()` 直接 `mergeRuntimeItems(...)`
2. `mergeRuntimeItems()` 只按 `item.id` 合并，不按 `toolCallId`

结果：

1. 本地 shadow item `id=stepId`
2. authoritative item `id=item_tool_xxx`
3. 即使是同一 `toolCallId`，也会双份保留

### 推荐规则

1. 对 root thread 的 `thread.snapshot`，若 `replaceStrategy==="replace"`：
   - `items`、`activeItemIds`、`collabSessions` 按 authoritative replace
   - 不再 merge by id
2. 对 `item.started / item.completed` 单事件：
   - `toolCall` 类型优先按 `toolCallId` 匹配现有 shadow item
   - 匹配上后用 authoritative item 替换 shadow item

### 统一 diff 草案

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
 const applyThreadSnapshot = (payload: any) => {
@@
+  const replaceStrategy = String(payload?.stream?.replaceStrategy ?? "").trim();
@@
-  rt.setItems(mergeRuntimeItems(rt.getItems() ?? [], snapshotItems));
+  rt.setItems(
+    replaceStrategy === "replace" && isRootSnapshot
+      ? snapshotItems
+      : mergeRuntimeItems(rt.getItems() ?? [], snapshotItems),
+  );
@@
 const applyItemEvent = (kind, payload) => {
@@
-  const existing = items.find((entry) => String(entry?.id ?? "") === String(item.id));
+  const logicalToolCallId = String(item?.toolCallId ?? "").trim();
+  const existing =
+    logicalToolCallId && item?.type === "toolCall"
+      ? items.find((entry) => String((entry as any)?.toolCallId ?? "").trim() === logicalToolCallId)
+      : items.find((entry) => String(entry?.id ?? "") === String(item.id));
```

### 说明

这一步是把之前用户反复问到的 `runtime items / turns / merge` 语义真正补齐。  
不补它，compact contract 即使落了，也会继续因为 shadow / authoritative 双份而放大。

---

## 7.6 Desktop 持久化：不再另造“历史专属形状”，直接持久化 compact envelope

### 目标

1. `buildCurrentSnapshot()` 不再先深拷贝 fat runtime
2. `conversationStore` 只需要对 compact envelope 做轻量 slim / dedupe
3. pending / per-conv / v1 fallback 最终都写成同一种 compact 形状

### 推荐规则

1. `buildCurrentSnapshot()` 直接读取当前 `runStore` 的 compact `items/turns/thread`
2. `slimSnapshotForHistory()` 继续保留，但只做：
   - string clamp
   - dedupe by `toolCallId`
   - `turn.itemIds` / `activeItemIds` alias remap
3. `read.result.content` 的裁剪逻辑不再由 history 层单独发明；它来自统一 envelope

### 统一 diff 草案

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@
 function slimRuntimeItemForHistory(item: RuntimeItemRecord): RuntimeItemRecord {
@@
-  ...((item as any).result !== undefined ? { result: slimToolIoForHistory(toolName, (item as any).result) } : {}),
+  ...((item as any).result !== undefined ? { result: slimToolResultEnvelopeForHistory((item as any).result) } : {}),
 }
@@
 export function buildCurrentSnapshot(): RunSnapshot {
@@
-  thread: ... JSON.parse(JSON.stringify(s.thread)) ...
-  turns: ... JSON.parse(JSON.stringify(s.turns)) ...
-  items: ... JSON.parse(JSON.stringify(s.items)) ...
+  thread: s.thread ?? null,
+  turns: s.turns ?? [],
+  items: s.items ?? [],
@@
   return slimSnapshotForHistory(rawSnapshot) ?? rawSnapshot;
 }
```

### 说明

本期最重要的不是“磁盘文件更小”，而是 **renderer 在保存前就不再深拷贝 fat runtime**。

---

## 7.7 主进程 `main.cjs`：保留 defensive normalization

主进程这层不是主战场，但必须保留 safety net：

1. 避免未来某条 legacy / fallback / sync save 路径又把 fat payload 写回 v2
2. 保证 v1 fallback 合并进 v2 时也会转成 compact envelope

### 统一 diff 草案

```diff
--- a/apps/desktop/electron/main.cjs
+++ b/apps/desktop/electron/main.cjs
@@
+function normalizeCompactSnapshot(snapshot) {
+  // 只做 defensive normalization：
+  // 1) 识别 legacy raw tool result
+  // 2) 转成 ToolResultEnvelope
+  // 3) 不改 proposal / waiting / collab / projectDir 语义
+}
@@
-const snapshot = rawConv.snapshot && typeof rawConv.snapshot === "object" ? rawConv.snapshot : null;
+const snapshot = normalizeCompactSnapshot(
+  rawConv.snapshot && typeof rawConv.snapshot === "object" ? rawConv.snapshot : null,
+);
```

---

## 8. 绝不能裁掉的字段 / 语义

本期必须保留：

1. `item.id / threadId / turnId / type / status / createdAt / updatedAt`
2. `toolCallId / name / turn.itemIds / activeItemIds`
3. `preview / changes / actionSpec / kept / applied / undoable / canUndo`
4. `thread.waitingFor / waiting / taskState / pendingArtifacts`
5. `activeCollabAgents / collabSessions`
6. `projectDir / draftSnapshotOwnerId`
7. `read` 的 `path / totalChars / truncated / virtualFromProposal / proposalSources`

真正该裁掉的只有一类：

> **会在运行中、snapshot 中、history 中长期常驻的 raw full payload**

---

## 9. 备选方案与取舍

## 9.1 备选 A：只做 Desktop-only 持久化瘦身

不推荐。

遗留隐患：

1. Gateway transcript / provider `details` 仍胖
2. `tool.result` / `item.completed` / `thread.snapshot` 仍然把 fat payload 喂回 Desktop
3. 长 run 期间仍可能在 renderer 内慢性爆内存

## 9.2 备选 B：只做 Gateway compact event

不推荐。

遗留隐患：

1. Desktop 本地工具执行后，raw `output` 仍会先进入 `patchTool()` / shadow item
2. autosave 仍可能在 Gateway 回包前先把 fat local state 写盘

## 9.3 备选 C：直接上 Gateway blob/ref 存储

本期不作为默认方案。

原因：

1. 能做，但复杂度更高
2. 这期首要目标是切断 OOM 链路，不是立刻做“历史工具卡回看 full payload”
3. 本文的 `ToolResultEnvelope` 已留出未来 `mode:"ref"` 的扩展空间；需要时再开独立 spec

---

## 10. 验证清单

## 10.1 当前 turn 语义

准备一个大文件，跑一轮：

1. `read` 返回大文本
2. 模型在同一 run 内继续基于该文本输出总结 / 继续调用工具
3. 结果与当前行为保持可接受一致，不出现“工具结果刚执行完就丢上下文”

## 10.2 运行态不再长胖

验证：

1. Desktop 本地 `patchTool()` 后，`runStore.steps/items` 中不再出现完整 `read.content`
2. `tool.result` 事件的 `output` 变成 compact envelope
3. `thread.snapshot.items[].result` 不再是 raw full payload
4. `applyThreadSnapshot()` 真正按 `replaceStrategy:"replace"` 消费 root snapshot

## 10.3 历史与恢复

验证：

1. `conversations/*.json` 不再保存完整 `read.result.content`
2. `history.readConversationSnapshot({ includeSteps:false })` 仍能恢复：
   - `projectDir`
   - `thread.waitingFor`
   - `taskState`
   - `draftSnapshotOwnerId`
3. `history.loadConversationSegment()` 仍能补 transcript
4. v1 fallback 合并到 v2 后，tool result 也会转成 compact envelope

## 10.4 proposal / undo / collab

验证：

1. Keep / Undo 入口仍可见
2. reload 后 fileChange / approval 卡仍可恢复
3. collab session 不丢
4. waiting-user / waiting-approval 不误判

## 10.5 观测指标

建议在本期验收中记录：

1. 单次大 `read` 后 `thread.snapshot` payload 大小
2. 单会话 `conv_<id>.json` 大小变化
3. Desktop renderer 内存曲线（运行中 + reload 后）
4. Gateway 侧 transcript / run audit 单条 tool_result 大小

---

## 11. 实施顺序

按最小闭环建议分四步：

1. **Shared contract**
   - 落 `ToolResultEnvelope`
   - 补 `toolCallId` / `shadowSource`
2. **Gateway write-side**
   - GatewayRuntime / writingAgentRunner / itemEmitter 统一走 compact helper
3. **Desktop read-side**
   - 本地执行后立即 compact
   - authoritative snapshot / item 走 replace / logical merge
4. **Persistence safety net**
   - conversationStore / main.cjs 改成 compact-first + defensive normalization

---

## 12. 回滚策略

若本期落地后发现回归，回滚顺序建议如下：

1. 先保留 shared contract，不回滚类型
2. 先单独关闭 Desktop `replaceStrategy` authoritative replace（若 UI 合并异常）
3. 再关闭 Desktop 本地 `pendingRawToolResultsByCallId` compact patch
4. 最后才回退 Gateway compact emit

原因：

> Gateway compact emit 是切断 live amplification 的核心，不应轻易整体回退。

---

## 13. 与现有 Desktop-only spec 的关系

已有文档：

- `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`

该文档保留价值：

1. `shadow item / authoritative item` 去重分析仍然成立
2. `history` 层 preview-only 事实仍然成立

但它的范围已经不足：

1. 它明确排除了 Gateway
2. 它把“live runtime 可以继续富”作为前提
3. 这正是当前最大漏项

因此从本期开始，应以本文为主；旧文档可视为 Desktop 持久化子问题说明，不再单独作为最终方案。

---

## 14. 最终建议

这次推荐落成 **一份联动 spec**，而不是 Gateway / Desktop 两份平行文档。

因为我们真正要收的是同一件事：

> **tool result 大 payload 的生命周期合同。**

只要这个合同不统一，后面无论修多少轮瘦身、merge、autosave、history，都还会在别的层重新长回来。
