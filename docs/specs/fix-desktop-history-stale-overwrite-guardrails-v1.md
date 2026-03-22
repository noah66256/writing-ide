# Desktop History Stale Overwrite Guardrails（v1）

> 目标：在继续推进 Desktop 侧剩余 OOM 收口前，先把“新快照/旧 pending/兼容壳把老记录直接覆盖掉”的风险切断。  
> 这份 spec 是 `docs/specs/desktop-history-single-writer-and-fact-source-v0.1.md` 与 `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md` 的继续收口，但范围只聚焦 **history 正确性与覆盖安全**，不直接展开 runtime item compact 细节实现。
>
> 绑定基线：
> - 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
> - 相关已落能力：
>   - history `index-first + readConversationSnapshot + loadConversationSegment`
>   - main-process `applyOperations`
>   - project `tree-first + ensureLoaded(path)`

---

## 1. 需求卡片

- 场景：桌面端最近几轮已经把 history 从 full-payload 热路径收到了 `applyOperations`，但 OOM 尾巴还没彻底切干净；如果继续动 runtime 持久化，最怕再次出现“新快照把老记录写空/写短/整包替换”的事故。
- 目标：在不推翻现有 Desktop history 架构的前提下，补齐“禁止隐式清库、禁止 stale write 升格、禁止 pending 反向覆盖、禁止 legacy 整包误删”的硬门禁。
- 对标：本地 `third_party/openai-codex` 的 `thread/list` / `thread_read(include_turns=False)` 与 composer `persistent history` 轻量合同；仓库内已有 `desktop-history-single-writer-and-fact-source` / `desktop-runtime-item-persistence-guardrails` / OOM forensics 文档。
- 约束：优先 Desktop-only；不先改 Gateway；不要求一次性删除旧历史文件格式；不能牺牲已有恢复能力；不能把“修 OOM”再做成“历史直接覆盖”。
- 不做什么：本 spec 不直接展开 ChatArea 窗口化；不直接落 `read.result.content` compact 细节；不改 Gateway transcript 合同；不做大规模 UI 重构。

---

## 2. 结论先行

当前 `HEAD` 已经不是“完全旧状态”，但还留着 4 个会再次误伤老记录的口子：

1. `hydrateFromDisk()` 成功后仍可能发出 `clear-all + rewrite`。
2. `legacy saveConversations*` 兼容壳仍可把“缺失 id”翻译成删除。
3. `pending conversations` 仍以 full payload 形式参与 `disk < pending < memory` 竞争。
4. `applyOperations` 虽已是主热路径，但还没有 per-conversation revision / stale-write guard。

因此，本轮推荐方案不是再加一层“更聪明的 merge”，而是加 4 条硬约束：

1. **非显式用户清空，任何路径都不得发出 `clear-all`。**
2. **非显式 delete，不得因为 payload 缺某个 id 就删老记录。**
3. **pending 只做恢复日志，不再作为与 v2 body 并列的事实源。**
4. **write-body / write-draft 必须带 base revision，main 拒绝 stale batch。**

这 4 条补完后，才能安全继续推进 `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md` 里的剩余 OOM 收口，否则 runtime compact 做得再对，也还是有机会把历史写崩。

---

## 3. 已有上下文索引

### 3.1 已有文档

- [desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md](/Users/noah/writing-ide/docs/research/desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md)
- [codex-desktop-history-loading-parity-2026-03-20.md](/Users/noah/writing-ide/docs/research/codex-desktop-history-loading-parity-2026-03-20.md)
- [electron-chat-history-loss-codex-parity-2026-03-19.md](/Users/noah/writing-ide/docs/research/electron-chat-history-loss-codex-parity-2026-03-19.md)
- [desktop-history-single-writer-and-fact-source-v0.1.md](/Users/noah/writing-ide/docs/specs/desktop-history-single-writer-and-fact-source-v0.1.md)
- [desktop-runtime-item-persistence-guardrails-v0.1.md](/Users/noah/writing-ide/docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md)

### 3.2 近期相关 commit

- `abe73ab` `feat(desktop): land single-writer history persistence`
- `989e827` `fix(desktop): harden conversation history persistence guards`
- `c0b5c6d` `fix(desktop): dedupe projected runtime steps`
- `703176a` `fix(desktop): stabilize active runtime strips`
- `003a2e2` `feat: cut over codex-style thread runtime`

### 3.3 已确认的不重复结论

- 启动 eager hydrate 与项目全文 eager read 的主链，已经不是完全未处理状态。
- 剩余 OOM 风险主要落在 `runtime items / read.result.content / autosave / history body` 这一条。
- 这条尾巴如果继续沿用“renderer 视图可整包升格为历史真相”的语义，仍可能复现会话被写短、被写空、被替换的问题。

---

## 4. 现状地图

### 4.1 相关文件

| 文件 | 职责 | 与本需求关系 |
|------|------|--------------|
| `apps/desktop/src/state/conversationStore.ts` | renderer 侧 history state、hydrate、autosave、shutdown flush | 仍会组织 op batch；hydrate-repair 仍可能触发 `clear-all` |
| `apps/desktop/electron/main.cjs` | history 读写、legacy 转译、pending、自愈、v1/v2 mirror | 单写者已在这里，但还缺 revision / stale-write guard |
| `apps/desktop/electron/preload.cjs` | history IPC surface | 新旧 history API 仍同时暴露 |
| `apps/desktop/src/vite-env.d.ts` | history IPC 类型约束 | 仍暴露 legacy full-payload 接口 |
| `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md` | 剩余 OOM 收口路线 | 这份 spec 的安全前置条件 |

### 4.2 关键锚点

| 文件 | 符号/函数 | 当前 HEAD 行号 | 当前问题 |
|------|-----------|----------------|----------|
| `apps/desktop/src/state/conversationStore.ts` | `HistoryOperation` | `720-736` | 已有 op-based IPC，但缺 `batchId/baseRevision/intent` |
| `apps/desktop/src/state/conversationStore.ts` | `schedulePersistToDisk` | `881-1008` | 仍允许 `clearAll` 参数进入 batch |
| `apps/desktop/src/state/conversationStore.ts` | `hydrateFromDisk` | `1018-1205` | 成功后仍可能 `clearAll: true` 触发全量重写 |
| `apps/desktop/electron/main.cjs` | `translateLegacyPayloadToHistoryOps` | `2075-2141` | 仍会根据缺失 id 推导 `delete-conversation`，并在特定条件下推导 `clear-all` |
| `apps/desktop/electron/main.cjs` | `applyHistoryOperationsToDir` | `2224-2399` | 已按 op 落盘，但没有 stale-write / revision guard |
| `apps/desktop/electron/main.cjs` | `applyHistoryOperationsToDirSync` | `2402-2575` | sync 路径同样没有 stale-write guard |
| `apps/desktop/electron/main.cjs` | `history.loadPendingConversations` | `5034-5057` | pending 仍以 payload 形式回到 renderer 合并 |
| `apps/desktop/electron/main.cjs` | `history.saveConversationsSync` | `5188-5219` | legacy full payload 兼容入口仍可做 destructive translate |
| `apps/desktop/electron/main.cjs` | `history.saveConversations` | `5222-5245` | async legacy full payload 兼容入口仍可做 destructive translate |
| `apps/desktop/electron/preload.cjs` | `history.saveConversations* / savePendingConversations` | `113-129` | 新旧接口并存，容易让后续改动误回退到旧边界 |
| `apps/desktop/src/vite-env.d.ts` | `window.desktop.history` | `138-174` | 类型层仍默认把 legacy 接口当一等公民 |

### 4.3 当前最危险的事实

1. `schedulePersistToDisk({ clearAll: true })` 现在仍能从 renderer 发出 `clear-all`。
2. `translateLegacyPayloadToHistoryOps()` 仍把“当前 payload 没带到的旧 id”视作 delete 候选。
3. `loadPendingConversations()` 仍让 pending payload 在 renderer hydrate 阶段参与抢真相。
4. `updatedAt` 只是时间戳，不是 per-conversation authoritative revision；晚到但更差的 payload 仍可能被接受。

### 4.4 已有可复用设施

- `applyOperations / applyOperationsSync` 已经是新热路径。
- `loadConversationIndex / readConversationSnapshot / loadConversationSegment` 已可支撑轻列表重详情。
- per-conv body + v2 index + v1 mirror 已存在。
- 当前工作树里没有发现 renderer 热路径还在调用 `saveConversations* / savePendingConversations`；它们已基本退到兼容壳地位。

---

## 5. 调研摘要

### 5.1 本地一手对标

证据：

- [third_party/openai-codex/sdk/python/src/codex_app_server/async_client.py](/Users/noah/writing-ide/third_party/openai-codex/sdk/python/src/codex_app_server/async_client.py#L112)
- [third_party/openai-codex/sdk/python/src/codex_app_server/api.py](/Users/noah/writing-ide/third_party/openai-codex/sdk/python/src/codex_app_server/api.py#L541)
- [third_party/openai-codex/docs/tui-chat-composer.md](/Users/noah/writing-ide/third_party/openai-codex/docs/tui-chat-composer.md#L161)

可借鉴：

1. `thread_list` 与 `thread_read(include_turns=False)` 明确区分轻列表与重详情。
2. persistent history 只恢复 text，不把完整 draft attachments / payload 当持久化真相。
3. 当前 UI session 的重状态可以保留，但不能直接等同于跨 session 历史事实源。

要规避：

1. 不要让 renderer 当前窗口态直接变成 persistent truth。
2. 不要让 crash-safe 数据与 authoritative body 长期并列竞争。
3. 不要把“兼容旧接口”继续当成主写链。

### 5.2 仓库内历史教训

证据：

- [electron-chat-history-loss-codex-parity-2026-03-19.md](/Users/noah/writing-ide/docs/research/electron-chat-history-loss-codex-parity-2026-03-19.md)
- [desktop-history-single-writer-and-fact-source-v0.1.md](/Users/noah/writing-ide/docs/specs/desktop-history-single-writer-and-fact-source-v0.1.md)

结论：

1. “做更聪明的 merge”只够止血，不够当长期合同。
2. 只要还能隐式 `clear-all` 或隐式 delete-missing，历史就还有被整包抹掉的风险。
3. 继续做 runtime compact 前，必须先把 write contract 收到“显式意图 + revision guard + pending replay only”。

---

## 6. 推荐方案

一句话：

> **把 Desktop history 从“operation-based single writer”再推进半步，收成“explicit intent + revision-guarded writer + pending journal replay only”。**

### 6.1 推荐模式

1. `clear-all` 只能来自显式用户动作，且 batch 中必须带确认意图。
2. 缺 id 不是删除信号；删除只能来自显式 `delete-conversation`。
3. `write-body / write-draft` 必须带 base revision；main 拒绝 stale batch。
4. `pending` 只保存未提交 op journal，不再给 renderer 一个 full payload 参与合并。
5. `saveConversations* / savePendingConversations` 保留兼容壳，但默认只能 upsert，不能 replace-all。

### 6.2 备选方案

继续沿用当前合同，只在 merge 里再补几层 guard：

- `steps` 更短则拒写
- `projectDir/model/opMode` 为空则回退
- pending 与 disk 比 `updatedAt`
- hydrate-repair 仅在特定条件下 `clear-all`

### 6.3 为什么不推荐备选

1. 它仍然允许“当前视图缺失 == 老数据删除”的表达方式存在。
2. 它仍然让 pending payload 与 v2 body 竞争真相。
3. 它仍然依赖时间戳与启发式，而不是显式意图与版本约束。

---

## 7. 改动点清单

## Fix 1（P0）：禁止隐式 `clear-all` 与隐式 delete-missing

- 优先级：`P0`
- 文件：
  - `apps/desktop/src/state/conversationStore.ts`
  - `apps/desktop/electron/main.cjs`
- 符号/函数：
  - `schedulePersistToDisk`
  - `hydrateFromDisk`
  - `translateLegacyPayloadToHistoryOps`
  - `applyHistoryOperationsToDir`
  - `applyHistoryOperationsToDirSync`
- 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
- 当前行号：
  - `apps/desktop/src/state/conversationStore.ts:881-1008`
  - `apps/desktop/src/state/conversationStore.ts:1182-1193`
  - `apps/desktop/electron/main.cjs:2075-2141`
  - `apps/desktop/electron/main.cjs:2266-2276`
  - `apps/desktop/electron/main.cjs:2444-2455`

改动原理：

- `hydrate-repair` 的职责应是“把已知记录补齐并同步索引”，不是“先清库再重建”。
- legacy payload 缺某个 id，不能再被解释为“用户要删掉旧记录”；这在 capped list / placeholder list / 兼容回退场景里都很危险。
- `clear-all` 与“删除未出现 id”都必须提升为显式 destructive intent。

建议 diff：

```diff
@@ apps/desktop/src/state/conversationStore.ts
 type HistoryOperationBatch = {
-  version: 1;
+  version: 2;
   updatedAt: number;
+  intent?: "autosave" | "hydrate-repair" | "manual" | "shutdown" | "explicit-clear-all";
   ops: HistoryOperation[];
 };

 @@ hydrateFromDisk()
           schedulePersistToDisk({
             conversations: merged,
             draftSnapshot: (finalDraft as any) ?? null,
             draftSnapshotOwnerId: finalDraftOwnerId,
             touchedConversationIds: merged.filter((item) => item.snapshotLoaded !== false).map((item) => item.id),
-            clearAll: true,
             source: "hydrate-repair",
           });

@@ apps/desktop/electron/main.cjs
 function translateLegacyPayloadToHistoryOps(payloadObj, previousPayload) {
-  if (allowEmptyConversations && nextIds.length === 0) {
+  if (payload.intent === "explicit-clear-all" && payload.userConfirmed === true && nextIds.length === 0) {
     ops.push({ type: "clear-all" });
     return { ... };
   }

-  for (const prevId of previousIds) {
-    if (!nextIds.includes(prevId)) {
-      ops.push({ type: "delete-conversation", conversationId: prevId });
-    }
-  }
+  if (payload.replaceMode === "replace-all" && payload.allowDeleteMissingIds === true) {
+    for (const prevId of previousIds) {
+      if (!nextIds.includes(prevId)) {
+        ops.push({ type: "delete-conversation", conversationId: prevId });
+      }
+    }
+  }
 }

@@ applyHistoryOperationsToDir(...)
-    if (op.type === "clear-all") {
+    if (op.type === "clear-all" && batch.intent === "explicit-clear-all") {
       ...
     }
 ```

边界情况：

1. 用户显式“清空所有历史”仍要能工作，但必须走专门 UI/IPC，不可复用 hydrate/autosave。
2. 旧版本 desktop 可能仍发 `allowEmptyConversations=true`；新 main 应把它当 no-op + warning，而不是 destructive clear。
3. `sync-order` 仍可更新排序，但不能顺带删除未出现 id。

验证方式：

1. 准备 50 条历史，只 hydrate 出 20 条 capped 列表；执行 hydrate-repair 后，磁盘仍保留全部 50 条 body 文件。
2. 用 legacy `saveConversations` 发送只有 1 条对话的 payload；旧 id 不应被删除。
3. 显式“清空全部历史”操作仍能成功，且只有这一路能触发 `clear-all`。

## Fix 2（P0）：为 body / draft / index 引入 revision guard，拒绝 stale write

- 优先级：`P0`
- 文件：
  - `apps/desktop/src/state/conversationStore.ts`
  - `apps/desktop/electron/main.cjs`
- 符号/函数：
  - `HistoryOperation`
  - `schedulePersistToDisk`
  - `loadConversationSnapshot`
  - `applyHistoryOperationsToDir`
  - `applyHistoryOperationsToDirSync`
  - `writeConversationBodyFileV2`
  - `buildConversationIndexEntry`
- 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
- 当前行号：
  - `apps/desktop/src/state/conversationStore.ts:720-742`
  - `apps/desktop/src/state/conversationStore.ts:926-965`
  - `apps/desktop/src/state/conversationStore.ts:1340-1368`
  - `apps/desktop/electron/main.cjs:2224-2399`
  - `apps/desktop/electron/main.cjs:2402-2575`

改动原理：

- `updatedAt = Date.now()` 不是可靠的 authority；更晚的差快照也可能把更好的老快照盖掉。
- 需要为每个 conversation body 引入单调递增 `bodyRevision`，并为 index / draft 引入对应 revision。
- renderer 每次 `loadConversationSnapshot()` 后拿到 `bodyRevision`；后续 `write-body` 必须带 `expectedBaseRevision`。main 若发现磁盘 revision 已前进，则拒绝这次写入并记录 telemetry。

建议 diff：

```diff
@@ apps/desktop/src/state/conversationStore.ts
 type HistoryOperation =
-  | { type: "write-body"; conversationId: string; snapshot: RunSnapshot; source: HistoryWriteSource }
-  | { type: "write-draft"; draftSnapshot: RunSnapshot | null; draftSnapshotOwnerId?: string | null }
+  | { type: "write-body"; conversationId: string; snapshot: RunSnapshot; source: HistoryWriteSource; expectedBaseRevision?: number | null }
+  | { type: "write-draft"; draftSnapshot: RunSnapshot | null; draftSnapshotOwnerId?: string | null; expectedDraftRevision?: number | null }

@@ loadConversationSnapshot()
-  return { ok: true, snapshot };
+  return { ok: true, snapshot, bodyRevision };

@@ apps/desktop/electron/main.cjs
+function rejectStaleHistoryWrite(kind, conversationId, expected, actual) {
+  recordMainEvent("history.write.rejected_stale", { kind, conversationId, expected, actual });
+}

@@ applyHistoryOperationsToDir(...)
+      const currentRevision = Number(previousBody?.bodyRevision ?? 0) || 0;
+      const expectedRevision = Number(op.expectedBaseRevision ?? currentRevision);
+      if (expectedRevision !== currentRevision) {
+        rejectStaleHistoryWrite("body", id, expectedRevision, currentRevision);
+        continue;
+      }
+      const nextRevision = currentRevision + 1;
+      const mergedSnapshot = ...
+      changedSnapshots.set(id, { ...mergedSnapshot, __bodyRevision: nextRevision });
 ```

边界情况：

1. 第一次写入新 conversation 时 `expectedBaseRevision = 0`。
2. hydrate-repair 只能对 `snapshotLoaded=true` 且 base revision 匹配的会话做 write-body；否则只修 meta/index。
3. stale batch 被拒绝后，不得回退到 legacy `saveConversations*` 补写。

验证方式：

1. 人工构造同一 conversation 的两个 batch：A 先读旧 revision，B 先写成功；随后 A 写入应被拒绝，body 文件不变。
2. shutdown flush 在 active conversation 已被别处推进 revision 后，不应把更旧 snapshot 重新写回。
3. telemetry 中能看到 `history.write.rejected_stale`，并带 `conversationId/expected/actual`。

## Fix 3（P1）：把 pending 从 full payload 改成 recovery journal

- 优先级：`P1`
- 文件：
  - `apps/desktop/electron/main.cjs`
  - `apps/desktop/src/state/conversationStore.ts`
  - `apps/desktop/electron/preload.cjs`
  - `apps/desktop/src/vite-env.d.ts`
- 符号/函数：
  - `history.loadPendingConversations`
  - `applyHistoryOperationsToDir`
  - `applyHistoryOperationsToDirSync`
  - `hydrateFromDisk`
- 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
- 当前行号：
  - `apps/desktop/electron/main.cjs:2230`
  - `apps/desktop/electron/main.cjs:2375-2394`
  - `apps/desktop/electron/main.cjs:5034-5057`
  - `apps/desktop/src/state/conversationStore.ts:1028-1195`
  - `apps/desktop/electron/preload.cjs:125-132`

改动原理：

- pending 的职责应该是 crash-safe recovery，不是另一份可被 renderer 拿来参与合并的 history payload。
- 只要 renderer 继续做 `disk < pending < memory` 合并，就还是多真相源。
- recovery 应回到 main：启动时先 replay pending journal 到 authoritative store，再给 renderer 只读 index/body 结果。

建议 diff：

```diff
@@ apps/desktop/electron/main.cjs
- const HISTORY_PENDING_FILENAME = "conversations.pending.v1.json";
+ const HISTORY_PENDING_JOURNAL_FILENAME_V2 = "conversations.pending.ops.v2.json";

@@ applyHistoryOperationsToDir(...)
-  if (options?.writePending !== false) {
-    await writeJsonFileAtomic(pendingFile, legacyPayload);
-  }
+  if (options?.writePending !== false) {
+    await writeJsonFileAtomic(pendingJournalFile, {
+      version: 2,
+      batchId: batch.batchId,
+      updatedAt,
+      intent: batch.intent ?? "unknown",
+      ops: batch.ops,
+    });
+  }

+async function replayPendingHistoryJournalIfNeeded(dir) {
+  // 只在 main 里 replay，renderer 不再读取 pending payload。
+}

@@ apps/desktop/src/state/conversationStore.ts
- const pendingResPromise = api.loadPendingConversations ? ... : Promise.resolve(null);
- const pendingRes = await pendingResPromise;
- // disk < pending < memory
+ await api.recoverHistoryIfNeeded?.().catch(() => null);
+ // hydrate 只读 index/body，不再把 pending 当事实源
 ```

边界情况：

1. crash 发生在写 pending journal 后、写 body/index 前：下次启动 main 应 replay 该 journal。
2. crash 发生在 body/index 已写成功但 pending journal 未删：下次启动应识别 journal 已应用过，直接清理，不得重复覆盖。
3. 旧版 pending payload 可保留一次性迁移读取，但迁移应在 main 完成，renderer 不再直接 merge。

验证方式：

1. 在 `applyHistoryOperationsToDir` 写完 pending journal 后故意中断；重启后能自动恢复到正确 body/index。
2. 制造一个比当前 revision 旧的 pending journal；启动后应被忽略并记录 warning。
3. renderer hydrate 期间不再依赖 `loadPendingConversations()` 参与合并。

## Fix 4（P1）：把 legacy `saveConversations* / savePendingConversations` 降成兼容壳，不再是隐式主写链

- 优先级：`P1`
- 文件：
  - `apps/desktop/electron/preload.cjs`
  - `apps/desktop/src/vite-env.d.ts`
  - `apps/desktop/electron/main.cjs`
- 符号/函数：
  - `history.saveConversations`
  - `history.saveConversationsSync`
  - `history.savePendingConversations`
- 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
- 当前行号：
  - `apps/desktop/electron/preload.cjs:113-129`
  - `apps/desktop/src/vite-env.d.ts:163-174`
  - `apps/desktop/electron/main.cjs:5119-5175`
  - `apps/desktop/electron/main.cjs:5188-5245`

改动原理：

- 当前热路径已经是 `applyOperations`，旧接口只剩兼容职责。
- 只要旧接口继续表现得像“等价主写链”，后续改动就有机会误回退到 full payload worldview。
- 因此应把旧接口改成：
  - 默认 upsert-only
  - 带 telemetry warning
  - 不支持 implicit delete / clear
  - 仅在显式 compat 模式下允许 destructive intent

建议 diff：

```diff
@@ apps/desktop/electron/preload.cjs
   history: {
+    // 新热路径
     applyOperations(batch) { ... }
     applyOperationsSync(batch) { ... }
+    // 兼容壳：仅供旧版本/迁移期使用
     saveConversations(payload) { ... }
   }

@@ apps/desktop/electron/main.cjs
 ipcMain.handle("history.saveConversations", async (_event, payload) => {
+  recordMainEvent("history.legacy_api.used", { api: "saveConversations" });
   const translated = translateLegacyPayloadToHistoryOps(rawObj, previousPayload);
+  translated.intent = rawObj?.intent === "explicit-clear-all" ? "explicit-clear-all" : "legacy-upsert-only";
   ...
 });
 ```

边界情况：

1. 老版本桌面端接到新主进程时，仍应能继续保存，但只能追加/更新，不能因为 payload 不完整而删旧记录。
2. `savePendingConversations` 在 journal 化完成后可保留兼容入口，但内部应直接写 compat journal，不再写 full payload 文件。

验证方式：

1. 全仓搜索确认 renderer 热路径只有 `applyOperations*` 在用旧 API。
2. 手工调用 `history.saveConversations()`，检查日志出现 `history.legacy_api.used`，且无 destructive 删除。
3. 回归测试确认旧用户升级后仍能保住历史。

## Fix 5（P2）：补齐“不会再直接覆盖老记录”的 smoke / fixture / 回滚门禁

- 优先级：`P2`
- 文件：
  - `apps/desktop/scripts/smoke-history-persistence.cjs`
  - 新增 `apps/desktop/scripts/smoke-history-no-overwrite.cjs`
  - 可选新增 `apps/desktop/electron/__fixtures__/history/`
- 符号/函数：
  - `runHistorySmokeCli`
  - 新增 no-overwrite smoke
- 当前 `HEAD`：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`
- 当前行号：
  - `apps/desktop/electron/main.cjs:2577-2697`
  - `apps/desktop/scripts/smoke-history-persistence.cjs`

改动原理：

- 这类回归不是 lint 能看出来的，必须有 fixture 和 smoke。
- 需要把“旧记录不得被缺失 payload 直接覆盖”变成持续门禁。

建议 smoke 覆盖：

1. hydrate-repair 不得删未加载到的历史。
2. stale body write 必须被拒绝。
3. old pending journal 不得覆盖新 body。
4. legacy compat payload 不得删除 omitted ids。
5. explicit clear-all 仍能正常工作。

建议 diff：

```diff
+// apps/desktop/scripts/smoke-history-no-overwrite.cjs
+// 1) seed 多会话 + 多 revision
+// 2) 发送 capped hydrate-repair batch
+// 3) 发送 stale body batch
+// 4) replay old pending journal
+// 5) assert body/index/legacy mirror 均未被误删
```

边界情况：

1. smoke 要在 primary/fallback history dir 两种模式下都能跑。
2. 需要覆盖 sync 与 async 两条写链。

验证方式：

1. `node apps/desktop/scripts/smoke-history-persistence.cjs`
2. `node apps/desktop/scripts/smoke-history-no-overwrite.cjs`
3. `npx tsc -p apps/desktop/tsconfig.json --noEmit`
4. `npm run -w @ohmycrab/desktop build`

---

## 8. 风险与连锁反应

### 8.1 连锁反应

1. `pending` journal 化后，renderer hydrate 逻辑会明显变轻，但需要同步改 IPC surface。
2. `bodyRevision` 引入后，部分旧逻辑会暴露“先读 index placeholder、后写 body”的竞态；这是好事，需要显式处理而不是继续默写。
3. 旧版 desktop 与新版 main 混跑时，legacy compat handler 的策略变化要谨慎，避免直接报错阻断保存。

### 8.2 性能风险

1. per-conversation revision 检查会增加少量磁盘读取，但相比误覆盖风险可以接受。
2. pending journal replay 若做得不好，启动会多一轮 IO；应限制为“仅发现 journal 时执行”。

### 8.3 兼容性风险

1. 若直接移除 `saveConversations*`，旧版桌面端可能保存失败；因此本轮只降级为 compat shell，不直接删除。
2. `clear-all` 若改得过严，可能影响合法的“清空历史”功能；必须补显式 UI/IPC。

### 8.4 proposal-first / rollback 影响

1. 本 spec 不改 proposal/undo 合同。
2. 但 `pendingArtifacts / waiting-user / taskState` 必须在 revision guard 下保留，不得因 compact/stale reject 被误清空。

---

## 9. 回滚与兼容说明

1. 若 `revision guard` 引发异常，可先保留字段写入但只做 telemetry，不立即 hard reject；待 smoke 稳定后再切到 reject。
2. 若 pending journal 路径出问题，可短期回退为“main 内部读旧 pending payload 并迁移”，但 renderer 端不要恢复 `disk < pending < memory`。
3. `saveConversations*` compat shell 可以保留两个版本周期，再决定彻底移除类型与 preload 暴露。

---

## 10. 验证 Checklist

- [x] `hydrate-repair` 不再发出 `clear-all`
- [x] `translateLegacyPayloadToHistoryOps()` 默认不再删除 omitted ids
- [x] `write-body` stale batch 被拒绝，不覆盖新 body
- [x] `pending` 不再以 full payload 参与 renderer hydrate
- [x] `saveConversations*` 只作为 compat shell 存在，并打 warning telemetry
- [x] 显式 clear-all 仍能在专用路径工作
- [ ] 现有 `loadConversationIndex/readConversationSnapshot/loadConversationSegment` 行为不退化
- [ ] `pendingArtifacts / projectDir / waiting-user / taskState` 不因新 guard 丢失

---

## 11. 实施状态

### 11.1 Spec -> Files -> Status

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Fix 1：禁止 hydrate / legacy 隐式 `clear-all` | `apps/desktop/src/state/conversationStore.ts` `schedulePersistToDisk` / `hydrateFromDisk` / `clearAll`; `apps/desktop/electron/main.cjs` `normalizeHistoryOperationBatch` / `translateLegacyPayloadToHistoryOps` / `applyHistoryOperationsToDir*` | 已实现 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`; `node apps/desktop/scripts/smoke-history-persistence.cjs` | `hydrate-repair` 不再发 `clear-all`；`clear-all` 只接受显式 intent |
| Fix 4：legacy API 降为 compat shell | `apps/desktop/electron/main.cjs` `history.saveConversations*` / `history.savePendingConversations`; `apps/desktop/electron/preload.cjs`; `apps/desktop/src/vite-env.d.ts` | 已实现 | `node -c apps/desktop/electron/main.cjs`; `node -c apps/desktop/electron/preload.cjs`; `npx tsc -p apps/desktop/tsconfig.json --noEmit` | 旧接口保留，但默认 upsert-only，并打 `history.legacy_api.used` telemetry |
| Fix 2：revision guard | `apps/desktop/src/state/conversationStore.ts`; `apps/desktop/electron/main.cjs`; `apps/desktop/src/vite-env.d.ts` | 已实现 | `node -c apps/desktop/electron/main.cjs`; `node apps/desktop/scripts/smoke-history-persistence.cjs`; `npx tsc -p apps/desktop/tsconfig.json --noEmit` | renderer 现在乐观维护 `bodyRevision/draftRevision`，`write-body/write-draft` 带 `expected*Revision`；main 对 stale batch 直接 reject 并打 `history.write.rejected_stale` telemetry |
| Fix 3：pending journal replay only | `apps/desktop/electron/main.cjs` `recoverHistoryIfNeeded` / `history.recoverHistoryIfNeeded` / `applyHistoryOperationsToDir*`; `apps/desktop/src/state/conversationStore.ts` `hydrateFromDisk`; `apps/desktop/electron/preload.cjs`; `apps/desktop/src/vite-env.d.ts` | 已实现 | `node -c apps/desktop/electron/main.cjs`; `node -c apps/desktop/electron/preload.cjs`; `npx tsc -p apps/desktop/tsconfig.json --noEmit`; `node apps/desktop/scripts/smoke-history-persistence.cjs` | 主写链现在把 pending 写成 `conversations.pending.ops.v2.json` journal；main 启动/读取前会 replay journal，并对旧 `conversations.pending.v1.json` 做一次性保守迁移；renderer hydrate 只读 index/body，不再做 `disk < pending < memory` 合并。`loadPendingConversations` 退成 compat shell，默认返回 `payload:null` |

### 11.2 偏差说明

这轮把 `Fix 3` 也按最小闭环落掉了，但实现上有两个刻意保守的取舍：

1. 新主链只把 `applyOperations*` 写成 journal；`savePendingConversations` 这个 legacy compat shell 还保留旧 payload 文件格式，靠 main-side `recoverHistoryIfNeeded` 做一次性迁移。
2. 旧 payload 迁移是“保守补洞”而不是“整包覆盖”：只补 authoritative store 里缺失的 conversation / draft / active，不再让 legacy pending 反向覆盖已有 history。
3. 这样做的目的是先切断多真相源和反向覆盖风险，再决定是否彻底移除 `loadPendingConversations/savePendingConversations` 这组兼容壳。

### 11.3 本轮实际验证结果

- `node -c apps/desktop/electron/main.cjs`：通过
- `node -c apps/desktop/electron/preload.cjs`：通过
- `npx tsc -p apps/desktop/tsconfig.json --noEmit`：通过
- `node apps/desktop/scripts/smoke-history-persistence.cjs`：通过
  - 已覆盖“legacy omitted ids 不删”
  - 已覆盖“隐式 clear-all 不生效”
  - 已覆盖“fresh body/draft write 成功后，stale `expected*Revision` batch 被 reject，且不会覆盖新 body/draft”
  - 已覆盖“pending journal 在 main-side replay 后恢复 body/index/draft，并自动清理 journal”
  - 已覆盖“比当前 revision 更旧的 pending journal 会被忽略并清理，不会反向覆盖”
  - 已覆盖“旧 `conversations.pending.v1.json` 会在 main 侧做一次性保守迁移，并清理旧文件”

---

## 12. 实施顺序

1. 先落 `Fix 1`：切断隐式 `clear-all` / delete-missing。
2. 再落 `Fix 2`：给 body/draft/index 上 revision guard。
3. 再落 `Fix 3`：pending journal 化，renderer 停止合并 pending payload。
4. 然后落 `Fix 4`：旧接口彻底降级为 compat shell。
5. 最后落 `Fix 5`：补 smoke / fixture / telemetry gate。
6. 上述完成后，再继续 `desktop-runtime-item-persistence-guardrails-v0.1.md` 剩余的 runtime compact 工作。

---

## 13. 不做什么

1. 不在这份 spec 里直接实现 `read.result.content` preview-only compact。
2. 不在这份 spec 里处理 Gateway authoritative item 合同。
3. 不在这份 spec 里处理 ChatArea 虚拟化或 transcript 窗口化。
4. 不在这份 spec 里引入新的云端存储/同步方案。
