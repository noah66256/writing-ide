# Desktop History Single Writer + Fact Source（v0.1）

> 目标：把桌面端会话历史从“renderer 整包快照保存 + 多真相源兜底”收敛成“主进程单写者 + per-conv 单一正文事实源 + index 镜像 + 固定回归门禁”，降低后续改动再次误杀历史会话的概率。
>
> 绑定基线：
> - 当前 `HEAD`：`989e827bd7fc62201845e7daba9265a12a23f86c`
> - 本 spec 是对 `docs/specs/desktop-history-and-project-loading-guardrails-v0.1.md`、`docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md` 之后剩余问题的继续收口。

---

## 1. 需求卡片

- 场景：桌面端近期多轮修复后，历史会话仍会因 hydrate、autosave、hide/unload、runtime 改造被误写空、写短或读错，用户对会话可靠性已经疲劳。
- 目标：把桌面端会话历史收敛成“单写者 + 单一正文事实源 + 明确镜像层 + 强回归门禁”的机制，降低后续改动再误杀历史的概率。
- 对标：本地 `third_party/openai-codex` 的 `thread/list`、`thread/read(includeTurns=false)`、轻列表重详情范式，以及仓库内既有 history guardrails 文档。
- 约束：优先 Desktop-only；不先推翻 Gateway 合同；要兼容现有 v1/v2 历史；保留 `draftSnapshot` / `pending conversations` / `activeConvId` / 恢复能力；spec 必须绑定当前 `HEAD`。
- 不做什么：这份 spec 不直接改代码；不把项目文件 lazy load、ChatArea 虚拟化、Gateway runtime 重构一起并入。

---

## 2. 结论先行

当前 `989e827` 已经完成 **P0 止血**，但还没有解决根因。现状更接近：

1. 主进程在保存前做“空列表保护、placeholder 保护、字段保底”。
2. renderer 仍在多个入口构造并提交 **full payload snapshot**。
3. `conversations.v1.json`、`conversations.index.v2.json`、`conversations/conv_<id>.json`、`pending`、内存态仍共同承担“事实源”角色。

因此，这一轮不推荐继续加局部 guard。推荐把剩余工作明确为三期：

1. `P1`：**Main-process single writer**
2. `P2`：**Per-conv authoritative body + index summary mirror + v1 compat mirror**
3. `P3`：**History regression fixtures + invariants + recovery tooling**

---

## 3. 现状地图

### 3.1 相关文件

| 文件 | 当前职责 | 与本问题的关系 |
|------|----------|----------------|
| `apps/desktop/src/state/conversationStore.ts` | hydrate、autosave、draft、active conversation 持久化入口 | renderer 仍在这里整包组织并提交历史 payload |
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | 启动恢复、隐藏/卸载刷盘 | hide / unload 会触发 full snapshot flush |
| `apps/desktop/src/ui/components/NavSidebar.tsx` | 切换会话、创建新会话 | 切会话时会把当前 run 组装成 snapshot 并更新 history |
| `apps/desktop/src/ui/components/ChatArea.tsx` | autosave、run end flush | 运行中高频保存路径，最容易把 partial state 写回历史 |
| `apps/desktop/electron/preload.cjs` | history IPC surface | 目前暴露的是 full-payload `saveConversations*` 接口 |
| `apps/desktop/electron/main.cjs` | history 文件读写、v1/v2 兼容、自愈与 guard | 已有主进程护栏，但仍以 renderer payload 为输入 |

### 3.2 关键锚点

| 文件 | 符号/函数 | 当前行号 | 问题说明 |
|------|-----------|----------|----------|
| `apps/desktop/src/state/conversationStore.ts` | `schedulePersistToDisk` | `850-897` | 把 `conversations[] + draftSnapshot + activeConvId` 组装成整包 payload，并写入 pending/main |
| `apps/desktop/src/state/conversationStore.ts` | `hydrateFromDisk` | `906-1095` | 已有 `index-first` 读取，但 hydrate 结束仍可能立刻回写整包 |
| `apps/desktop/src/state/conversationStore.ts` | `loadConversationSnapshot` | `1213-1245` | 详情读取已具备 lazy 能力，但写入链未同步收口 |
| `apps/desktop/src/state/conversationStore.ts` | `setDraftSnapshot` | `1256-1275` | 写 draft 时仍触发整包保存 |
| `apps/desktop/src/state/conversationStore.ts` | `flushDraftSnapshotNow` | `1276-1340` | hide/unload/run end 的主刷盘入口，仍提交 full payload |
| `apps/desktop/src/state/conversationStore.ts` | `flushDraftSnapshotNowSync` | `1341-1400` | shutdown 同步刷盘仍是 full payload |
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | unload/hide flush effect | `33-69` | 背景化/关闭窗口时可能把不完整 snapshot 直接刷盘 |
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | initial restore effect | `71-170` | 恢复逻辑已是 index/segment 优先，但写路径还没跟上 |
| `apps/desktop/src/ui/components/NavSidebar.tsx` | `handleLoadConversation` | `227-338` | 切会话前会把当前 run `buildCurrentSnapshot()` 后保存 |
| `apps/desktop/src/ui/components/ChatArea.tsx` | autosave interval | `1330-1355` | 高风险高频入口，虽有防降级但仍会更新 full snapshot |
| `apps/desktop/src/ui/components/ChatArea.tsx` | run-end flush | `1357-1371` | 结束时立即落盘，仍走 full payload |
| `apps/desktop/electron/preload.cjs` | `history.*` | `92-129` | preload 仍以 `saveConversations/saveConversationsSync` 为热路径 |
| `apps/desktop/electron/main.cjs` | `sanitizeHistoryPayloadForPersist` | `1126-1168` | 这是补救层，不是职责收口 |
| `apps/desktop/electron/main.cjs` | `saveConversationsV2` | `1776-1898+` | per-conv/index 虽已存在，但输入仍来自 renderer 整包 payload |
| `apps/desktop/electron/main.cjs` | `history.loadConversationIndex` | `3716-3792` | 已具备 index-first 读取 |
| `apps/desktop/electron/main.cjs` | `history.readConversationSnapshot` | `3794-3849` | 已具备单会话详情读取 |
| `apps/desktop/electron/main.cjs` | `history.loadConversationSegment` | `3852-3925` | 已具备 transcript segment 读取 |
| `apps/desktop/electron/main.cjs` | `history.savePendingConversations` | `4139-4196` | pending 仍写整包 payload |
| `apps/desktop/electron/main.cjs` | `history.saveConversationsSync` | `4207-4258` | shutdown 同步保存仍是 full payload |
| `apps/desktop/electron/main.cjs` | `history.saveConversations` | `4260-4295+` | 主历史写入仍以 full payload 为边界 |

### 3.3 已有设施

- 已有 `conversations.index.v2.json` 和 `conversations/conv_<id>.json` 双层落盘。
- 已有 `history.loadConversationIndex`、`history.readConversationSnapshot`、`history.loadConversationSegment`。
- 已有 `pending` crash-safe 文件与启动合并逻辑。
- 已有 dev `userData` 对齐正式版目录逻辑，已降低“写到错目录”的概率。

### 3.4 当前根因

1. **renderer 仍是历史写入发起者**
   - 主进程虽有 guard，但核心输入仍是 renderer 组装的 full snapshot。
2. **正文事实源不唯一**
   - v1、v2 index、per-conv、pending 都可能在不同阶段被当成“最真”。
3. **partial snapshot 与 placeholder 仍可能升格为新真相**
   - 现有实现主要依赖保存时补救，而不是禁止这类数据进入主写链。
4. **UI transcript、恢复载体、持久化正文边界不清**
   - `snapshot.steps` 仍同时承担多个职责。

---

## 4. 外部调研结论

### 4.1 本地一手对标

已核对：

- `third_party/openai-codex/codex-rs/app-server/README.md`
- `third_party/openai-codex/sdk/typescript/src/thread.ts`
- `third_party/openai-codex/codex-rs/app-server/tests/suite/v2/thread_read.rs`
- `docs/research/electron-chat-history-loss-codex-parity-2026-03-19.md`
- `docs/research/codex-desktop-history-loading-parity-2026-03-20.md`

### 4.2 对设计真正有影响的结论

1. `thread/list` 与 `thread/read(includeTurns=false)` 是正常热路径。
2. 当前 thread 的完整历史可重，但列表与启动路径必须轻。
3. 持久化历史不应该直接等同于 UI 当前上下文窗口。
4. 缺失语义应靠明确 history contract 补齐，而不是长期依赖“原样保存整个 runtime blob”。

### 4.3 推荐模式与放弃模式

- 推荐模式：
  - 轻列表、重详情
  - 单写者
  - 单会话正文事实源
  - 兼容层只做镜像/迁移，不反向覆盖正文
- 放弃模式：
  - 继续把 renderer full snapshot 作为持久化边界
  - 继续依赖 `sanitizeHistoryPayloadForPersist` 充当主合同
  - 让 v1 / v2 / pending / 内存态长期共同竞争“最终真相”

---

## 5. 推荐方案与备选方案

## 5.1 推荐方案

一句话：

> **把历史保存从“renderer 交整包结果”改成“renderer 提交操作意图，main 基于 authoritative store 落盘”。**

核心组成：

1. `main-process single writer`
2. `operation-based IPC`
3. `per-conv authoritative body`
4. `index = summary mirror`
5. `v1 = compatibility mirror`
6. `fixture + invariant gates`

为什么契合当前框架：

- 不需要推翻现有 `loadConversationIndex/readConversationSnapshot/loadConversationSegment`。
- 不需要先改 Gateway。
- 可以保留 `pending`、`draftSnapshot`、`activeConvId`。
- 可以把 `saveConversations*` 逐步降级为兼容壳，而不是一次性硬删除。

### 5.2 备选方案

继续保留 full-payload `saveConversations*`，只加强：

- 空列表拒写
- placeholder 拒写
- `updatedAt` / 版本戳比较
- `steps` 更短时拒写
- `model/opMode/projectDir` 空值拒写

### 5.3 为什么不推荐备选

它仍然保留两个根问题：

1. renderer 依旧负责构造“整份历史真相”。
2. 多真相源竞争关系依旧存在，只是 guard 更复杂。

结论：备选方案只能作为短期过渡，不应再作为主线。

---

## 6. 分 Phase 收口

## 6.1 P0：现有止血层，保留但降级为兼容护栏

保留当前这些能力，但明确降级为兼容层：

- `sanitizeHistoryPayloadForPersist`
- `mergeConversationSnapshotPreservingHistory`
- `saveConversations*`
- `savePendingConversations`

P0 的定位改为：

- 兼容旧 renderer / 旧历史文件
- 为迁移期提供兜底
- 不再承担长期主合同

## 6.2 P1：Main-process single writer + operation-based IPC

设计要求：

1. renderer 不再把 `conversations[]` 整包交给 main。
2. renderer 只提交操作意图，main 串行应用操作并落盘。
3. unload/shutdown 仍允许 sync 版本，但语义是“同步提交操作批次”，不是“同步提交整份 payload”。

推荐 IPC 合同：

```ts
type HistoryOp =
  | { type: "upsert-meta"; conversationId: string; patch: { title?: string; pinned?: boolean; archived?: boolean; updatedAt?: number } }
  | { type: "write-body"; conversationId: string; snapshot: RunSnapshot; source: "autosave" | "switch" | "shutdown" | "hydrate-repair" | "manual" }
  | { type: "write-draft"; draftSnapshot: RunSnapshot | null; draftSnapshotOwnerId?: string | null }
  | { type: "set-active"; conversationId: string | null }
  | { type: "delete-conversation"; conversationId: string }
  | { type: "clear-all" };
```

推荐 preload 暴露：

```ts
history.applyOperations(batch)
history.applyOperationsSync(batch)
history.loadConversationIndex()
history.readConversationSnapshot(params)
history.loadConversationSegment(params)
```

兼容期：

- `saveConversations`
- `saveConversationsSync`
- `savePendingConversations`

保留一个 phase，但内部改为：

1. 先把 legacy payload 转译为 op batch。
2. 再走 single writer。

## 6.3 P2：Per-conv authoritative body + index summary mirror

职责重划：

1. `conversations/conv_<id>.json`
   - 单会话正文唯一事实源
   - 保存 `head + steps + logs + thread + turns + items + collabSessions + activeItemIds`
2. `conversations.index.v2.json`
   - 只保存会话摘要、排序、预览、`activeConvId`、`draftSnapshot`、`draftSnapshotOwnerId`
   - 不再保存可反向覆盖正文的 fat snapshot
3. `conversations.v1.json`
   - 降级为兼容镜像/迁移输入
   - 不再作为存在 v2 时的主正文来源

额外约束：

- `snapshotLoaded`、placeholder、segment slice 都是 renderer 层状态，不能进入 authoritative body。
- `readConversationSnapshot(includeSteps=false)` 返回的是 head + runtime compact body，不是“窗口化 transcript”。
- `loadConversationSegment` 只负责 transcript segment，不得再被当成新事实源写回。

## 6.4 P3：Regression gates + recovery tooling

必须新增固定门禁：

1. fixture 测试
2. 不变量检查
3. 冒烟脚本
4. 恢复脚本

必须覆盖的场景：

- hide / pagehide / beforeunload
- autosave 中断
- HMR / dev reload
- index-only hydrate
- placeholder + partial snapshot
- per-conv 缺失时 v1 fallback
- dev 与 packaged `userData` 路径一致性
- runtime items -> steps projection 变化后历史不被写短

---

## 7. 数据合同与不变量

### 7.1 历史层职责

| 层 | 责任 | 允许保存什么 | 不允许承担什么 |
|----|------|--------------|----------------|
| per-conv body | 单会话 authoritative body | head、steps、runtime compact body | UI placeholder、窗口化 steps、未加载详情状态 |
| index v2 | 列表与轻量恢复镜像 | title、pinned、archived、updatedAt、preview、recentStepsMeta、activeConvId、draftSnapshot | 完整正文、可回写正文的 fat snapshot |
| v1 mirror | 兼容旧版本/迁移 | 兼容镜像 | 主正文事实源 |
| pending | crash-safe 恢复旁路 | main 生成的最近已接受状态 | renderer 未验证整包真相 |

### 7.2 必须写死的不变量

非显式 `deleteConversation` / `clear-all` / 用户确认裁剪 时：

1. `conversation count` 不允许从 `>0` 变成 `0`
2. 某会话 `steps.length` 不允许从 `>0` 变成 `0`
3. 某会话 `model/opMode/projectDir` 不允许被空值覆盖
4. `activeConvId` 不允许被空值或不存在的 id 降级
5. `snapshotLoaded=false`、placeholder、segment slice 不能覆盖 authoritative body
6. `loadConversationSegment` 的返回值只能合并进 renderer 内存，不得直接持久化为正文

推荐新增元数据：

- `bodyStepCount`
- `bodyUpdatedAt`
- `bodyHash`

用途：

- 主进程写入前做 downgrade 检测
- fixture 测试时做机器校验
- 恢复脚本选择“更完整正文”

---

## 8. 精确改动点

## 8.1 [P1] 历史写入口从 full payload 改为 op batch

优先级：`P1`

### 涉及文件

| 文件 | 符号/函数 | HEAD | 当前行号 |
|------|-----------|------|----------|
| `apps/desktop/electron/preload.cjs` | `history.*` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `92-129` |
| `apps/desktop/electron/main.cjs` | `history.saveConversations` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `4260-4295+` |
| `apps/desktop/electron/main.cjs` | `history.saveConversationsSync` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `4207-4258` |
| `apps/desktop/electron/main.cjs` | `history.savePendingConversations` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `4139-4196` |
| `apps/desktop/src/state/conversationStore.ts` | `schedulePersistToDisk` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `850-897` |

### 改动原理

- preload 暴露 `applyOperations/applyOperationsSync`。
- `conversationStore` 内部维护 `historyWriteQueue`，按会话/草稿/active id 聚合操作，而不是聚合 full payload。
- main 端按顺序应用 op batch，应用成功后再统一写 index/per-conv/v1/pending。

### unified diff

```diff
--- a/apps/desktop/electron/preload.cjs
+++ b/apps/desktop/electron/preload.cjs
@@
-    saveConversations(payload) {
-      return ipcRenderer.invoke("history.saveConversations", payload);
-    },
-    saveConversationsSync(payload) {
-      ...
-    },
+    applyOperations(batch) {
+      return ipcRenderer.invoke("history.applyOperations", batch);
+    },
+    applyOperationsSync(batch) {
+      return ipcRenderer.sendSync("history.applyOperationsSync", JSON.stringify(batch ?? null));
+    },
+    saveConversations(payload) {
+      return ipcRenderer.invoke("history.saveConversationsCompat", payload);
+    },
+    saveConversationsSync(payload) {
+      return ipcRenderer.sendSync("history.saveConversationsCompatSync", JSON.stringify(payload ?? null));
+    },
```

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@
-function schedulePersistToDisk(args) {
-  const payload = { version: 1, updatedAt: Date.now(), conversations, draftSnapshot, draftSnapshotOwnerId, activeConvId };
-  ...
-  void api.savePendingConversations(payload)
-  ...
-  void api.saveConversations(next)
-}
+function schedulePersistToDisk(args) {
+  const batch = buildHistoryOperationBatch(args);
+  ...
+  void api.applyOperations(batch)
+}
```

### 边界情况

- renderer 仍可能调用旧接口，兼容层必须能转译 legacy payload。
- sync 关闭窗口路径不能依赖异步队列。
- `clear-all` 必须显式传达，不允许通过空数组隐式表达。

### 验证方式

- 单测：legacy payload 能被稳定转译为 op batch。
- 集成：连续 autosave + hide/unload 后，不再出现 “incoming empty payload 覆盖 main history”。

## 8.2 [P1] store 改成 queued operations，不再把 `buildCurrentSnapshot()` 当通用持久化格式

优先级：`P1`

### 涉及文件

| 文件 | 符号/函数 | HEAD | 当前行号 |
|------|-----------|------|----------|
| `apps/desktop/src/state/conversationStore.ts` | `updateConversation` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1184-1212` |
| `apps/desktop/src/state/conversationStore.ts` | `setDraftSnapshot` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1256-1275` |
| `apps/desktop/src/state/conversationStore.ts` | `flushDraftSnapshotNow` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1276-1340` |
| `apps/desktop/src/state/conversationStore.ts` | `flushDraftSnapshotNowSync` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1341-1400` |

### 改动原理

- `buildCurrentSnapshot()` 继续服务于 run 恢复与 UI 内存态。
- 进入 history 写链前，必须转成：
  - `upsert-meta`
  - `write-body`
  - `write-draft`
  - `set-active`
- `snapshotLoaded` 保留为 renderer 内存标记，不再进入持久化层。

### unified diff

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@
-schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null, draftSnapshotOwnerId: ... })
+enqueueHistoryOps([
+  buildUpsertMetaOp(nextConversationMeta),
+  buildWriteBodyOp(convId, nextSnapshot, "autosave"),
+  buildWriteDraftOp(nextDraft, ownerId),
+])
```

### 边界情况

- 未加载完整正文的 inactive conversation 只允许更新 meta，不允许写 body。
- active conversation 的 segment slice 必须先与完整 snapshot merge 后，才能生成 `write-body`。

### 验证方式

- store 层测试：对未加载详情会话做 pin/archive/rename，不会触发 per-conv body 覆盖。
- store 层测试：`snapshotLoaded=false` 会话不会因为 UI 操作写空正文。

## 8.3 [P2] 明确 per-conv 是正文唯一事实源，index/v1 只做镜像

优先级：`P1`

### 涉及文件

| 文件 | 符号/函数 | HEAD | 当前行号 |
|------|-----------|------|----------|
| `apps/desktop/electron/main.cjs` | `saveConversationsV2` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1776-1898+` |
| `apps/desktop/electron/main.cjs` | `history.loadConversationIndex` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `3716-3792` |
| `apps/desktop/electron/main.cjs` | `history.readConversationSnapshot` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `3794-3849` |
| `apps/desktop/electron/main.cjs` | `history.loadConversationSegment` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `3852-3925` |
| `apps/desktop/electron/main.cjs` | `sanitizeHistoryPayloadForPersist` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1126-1168` |

### 改动原理

- `saveConversationsV2` 需要拆成更明确的：
  - `writeConversationBodyFile()`
  - `writeConversationIndexFile()`
  - `writeLegacyConversationMirror()`
- `readConversationSnapshot` 只从 per-conv 读正文；v1 仅在 per-conv 缺失或损坏时 fallback。
- `loadConversationIndex` 只读 index/v1 summary，永远不再晋升为正文事实源。

### unified diff

```diff
--- a/apps/desktop/electron/main.cjs
+++ b/apps/desktop/electron/main.cjs
@@
-async function saveConversationsV2(historyDir, payloadObj) {
-  const conversations = Array.isArray(payloadObj?.conversations) ? payloadObj.conversations : [];
-  for (const raw of conversations) {
-    const snapshot = normalizeCompactSnapshot(raw.snapshot ...);
-    ...
-    await write conv_<id>.json
-  }
-  await write conversations.index.v2.json
-}
+async function applyHistoryOperations(historyDir, batch) {
+  const state = await loadAuthoritativeHistoryState(historyDir);
+  const next = reduceHistoryOperations(state, batch);
+  await writeConversationBodies(historyDir, next.changedBodies);
+  await writeConversationIndex(historyDir, next.index);
+  await writeLegacyConversationMirror(historyDir, next.legacyMirror);
+  await writePendingHistoryMirror(historyDir, next.pendingMirror);
+}
```

### 边界情况

- per-conv 文件存在但 `steps=[]` 时，允许从 v1 恢复一次并回写 per-conv。
- 一旦 per-conv 恢复成功，后续正文读取不得再优先 v1。
- `draftSnapshot` 仍可保存在 index 中，但不能携带会反向覆盖任意 conversation body 的语义。

### 验证方式

- fixture：构造 `index 完整 / per-conv 缺失 / v1 完整`，能稳定恢复正文并生成 per-conv。
- fixture：构造 `index 轻量 / per-conv 完整 / v1 较短`，读取详情仍拿 per-conv 正文。

## 8.4 [P2] UI 只负责读当前会话，不再在多入口主动“全权保存历史”

优先级：`P2`

### 涉及文件

| 文件 | 符号/函数 | HEAD | 当前行号 |
|------|-----------|------|----------|
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | hide/unload flush effect | `989e827bd7fc62201845e7daba9265a12a23f86c` | `33-69` |
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | initial restore effect | `989e827bd7fc62201845e7daba9265a12a23f86c` | `71-170` |
| `apps/desktop/src/ui/components/NavSidebar.tsx` | `handleLoadConversation` | `989e827bd7fc62201845e7daba9265a12a23f86c` | `227-338` |
| `apps/desktop/src/ui/components/ChatArea.tsx` | autosave / run-end flush | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1330-1371` |

### 改动原理

- `ConversationLayout`、`NavSidebar`、`ChatArea` 只提交“当前 active conversation body changed”或“meta changed”意图。
- 这些入口不再拥有 `conversations[]` 全量视图的持久化职责。
- hide/unload 刷盘保留，但只提交当前 dirty op batch。

### unified diff

```diff
--- a/apps/desktop/src/ui/components/ChatArea.tsx
+++ b/apps/desktop/src/ui/components/ChatArea.tsx
@@
-convStore.setDraftSnapshot(snap);
-if (convIdNow) {
-  convStore.updateConversation(convIdNow, { snapshot: snap });
-}
+convStore.stageDraftSnapshot(snap);
+if (convIdNow) {
+  convStore.stageActiveConversationBody(convIdNow, snap, "autosave");
+}
+convStore.flushHistoryOpsSoon();
```

### 边界情况

- 切会话时若当前 run 没有正文变化，只更新 `activeConvId`，不触发 body 写。
- 背景运行中的其他会话不得因当前 UI 切换而被重新持久化。

### 验证方式

- UI 冒烟：切换会话后，旧会话标题仍在，正文不回 welcome 页，模型/opMode 不丢。
- UI 冒烟：关闭窗口再打开，active conversation 与上次选中的模型仍正确恢复。

## 8.5 [P3] 固化历史回归门禁与恢复工具

优先级：`P1`

### 涉及文件

| 文件 | 符号/模块 | HEAD | 当前行号 |
|------|-----------|------|----------|
| `apps/desktop/electron/main.cjs` | history IPC / reducer / read path | `989e827bd7fc62201845e7daba9265a12a23f86c` | `1126-1168, 3716-3925, 4139-4295+` |
| `apps/desktop/src/state/conversationStore.ts` | hydrate / persist | `989e827bd7fc62201845e7daba9265a12a23f86c` | `850-1095, 1213-1400` |
| `apps/desktop/scripts/smoke-history-persistence.cjs` | 新增 | `n/a` | `n/a` |
| `apps/desktop/test-fixtures/history/` | 新增 | `n/a` | `n/a` |
| `apps/desktop/electron/history-recovery.mjs` | 新增 | `n/a` | `n/a` |

### 改动原理

- 新增固定 fixture 目录，覆盖已知炸点。
- 新增 smoke 脚本，最少跑“启动读取、切会话、autosave、hide/unload、重启恢复”。
- 新增恢复脚本，基于 `bodyStepCount/bodyUpdatedAt/bodyHash` 选择更完整正文进行修复。

### unified diff

```diff
--- /dev/null
+++ b/apps/desktop/scripts/smoke-history-persistence.cjs
@@
+// 1. 准备 fixture userData
+// 2. 启动 desktop history read path
+// 3. 模拟 autosave / hide / unload / restart
+// 4. 断言会话数、activeConvId、bodyStepCount、model/opMode/projectDir 不降级
```

### 边界情况

- fixture 必须同时覆盖 `OhMyCrab` 与 legacy `Electron` userData 目录。
- recovery 工具默认只读与 dry-run，只有显式 `--apply` 才落盘。

### 验证方式

- CI 至少跑 fixture + smoke。
- 手工冒烟至少跑一次 dev 模式，一次 packaged 模式。

---

## 9. 风险与连锁反应

### 9.1 连锁反应

1. `conversationStore` 会从“直接保存历史”转成“排队提交写意图”。
2. main 端 history 写路径会集中化，改动面比单点 guard 更大。
3. `saveConversations*` 将进入兼容期，相关调试日志与排查方式要同步更新。

### 9.2 性能风险

- main 端应用 op batch 时会多一次 state reduce，但会显著减少 renderer 深拷贝与 full payload 序列化。
- 需要避免每个 op 都立即 fs 写；应保留批次聚合与原子写。

### 9.3 兼容性风险

- 老版本 renderer 仍可能调用 `saveConversations*`。
- 老历史目录可能只有 v1 或 index 与 per-conv 不一致。

缓解方式：

- 保留 compat IPC 一期。
- `readConversationSnapshot` 对 per-conv 缺失仍允许 v1 fallback。
- 增加 recovery 脚本，而不是继续手工修用户数据。

### 9.4 proposal-first / rollback 影响

- 这是 Desktop 本地持久化机制改造，不涉及用户文档正文写入提案流。
- rollback 策略不是回退到 full payload，而是：
  - 保留 compat IPC
  - 保留现有 P0 guard
  - 允许临时只启用 single writer + legacy payload 转 op batch

---

## 10. 验证 Checklist

### 10.1 自动化

- fixture：`index-only + per-conv 完整 + v1 较短`，读取正文不降级
- fixture：`per-conv 缺失 + v1 完整`，恢复后自动生成 per-conv
- fixture：`pending 比 main 更新`，启动后恢复到更新版本
- fixture：`legacy Electron userData`，dev 启动仍能读到历史
- fixture：placeholder / `snapshotLoaded=false` / segment slice 不会覆盖正文

### 10.2 手工冒烟

1. 打开一个有旧历史的数据目录，确认左侧列表与正文都正常。
2. 切换到老会话，确认不会进入 welcome 页。
3. 记录当前模型、`opMode`、项目目录，关闭窗口再打开，确认三者不丢。
4. 运行一轮长任务，中途切会话、隐藏窗口、再回来，确认历史不被写短。
5. dev 模式 HMR 后重启，确认最新会话仍在。

### 10.3 上线门禁

- 新增/修改任何 history 持久化相关逻辑时，必须跑 fixture + smoke。
- 未通过门禁，不得只凭手测合并。

---

## 11. 实施顺序

1. `P1` 先落 `applyOperations/applyOperationsSync` 与 compat 转译层。
2. `P1` 同步改 `conversationStore` 为 queued operations。
3. `P2` 把 main 写路径重构为 authoritative reducer + per-conv/index/v1 明确职责。
4. `P2` 收口 `ConversationLayout/NavSidebar/ChatArea` 的写入口。
5. `P3` 补 fixture、smoke、recovery，再收尾删减无用 guard。

---

## 12. 实施状态

> 最近一次实现回填：基于 `HEAD 989e827bd7fc62201845e7daba9265a12a23f86c` 的后续工作树实现。

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|-----------|------|------|------|
| `P1` operation IPC | `apps/desktop/electron/preload.cjs` `history.applyOperations*` | 已实现 | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | 新增 op-batch IPC，保留旧接口兼容壳 |
| `P1` legacy compat 转 op batch | `apps/desktop/electron/main.cjs` `translateLegacyPayloadToHistoryOps` / `history.saveConversations*` | 已实现 | `node -c apps/desktop/electron/main.cjs` | 旧 `saveConversations*` 不再直接写主历史 |
| `P1` single writer | `apps/desktop/electron/main.cjs` `applyHistoryOperationsToDir*` | 已实现 | `npm run -w @ohmycrab/desktop smoke:history` | main 成为 history 主写者，并统一写 pending/index/body/v1 |
| `P1` store op queue | `apps/desktop/src/state/conversationStore.ts` `schedulePersistToDisk` | 已实现 | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | renderer 改为提交 op batch，而不是 full payload |
| `P2` per-conv authoritative body | `apps/desktop/electron/main.cjs` `writeConversationBodyFileV2*` / `loadConversationBodyFromCurrentDir*` | 已实现 | `npm run -w @ohmycrab/desktop smoke:history` | per-conv 正文成为主事实源，body stats 同步写入 index |
| `P2` index summary mirror | `apps/desktop/electron/main.cjs` `mergeConversationIndexEntryForPersist` / `applyHistoryOperationsToDir*` | 已实现 | `npm run -w @ohmycrab/desktop build` | index 只保摘要、draft、active，不再由 renderer 直接整包覆盖 |
| `P2` UI 写入口收口 | `apps/desktop/src/state/conversationStore.ts` 各 mutation / flush | 已实现 | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | UI 组件未大改，收口主要落在 store 内部 |
| `P3` smoke | `apps/desktop/scripts/smoke-history-persistence.cjs` / `apps/desktop/electron/main.cjs --history-smoke-cli` | 已实现 | `npm run -w @ohmycrab/desktop smoke:history` | 覆盖 legacy → index/body、自身防降级、pending 清理 |
| `P3` recovery | `apps/desktop/electron/history-recovery.mjs` | 已实现 | `node apps/desktop/electron/history-recovery.mjs --history-dir <tmpdir>` | 支持 dry-run 与 `--apply` 修复 per-conv 缺失/过短 |

## 13. 残留风险

1. `savePendingConversations` 旧 compat handler 仍保留旧写法，当前主路径已不依赖它，但后续可继续收口到 op reducer。
2. smoke CLI 仍会经过现有迁移逻辑，所以在临时 userData 下会看到一次“从正式目录迁移到临时目录”的日志；这是预期副作用，不影响结果。
3. 当前没有把 history fixture 接进正式测试框架，P3 先以 node smoke + recovery dry-run 形态落地，后续可再升级成 CI fixture 套件。

---

## 14. 明确不做

1. 不在这期重写 Gateway runtime 或 thread contract。
2. 不把 ChatArea 虚拟滚动/窗口化并入。
3. 不在这期引入新的远端 history 服务。
4. 不把 project lazy load 改造重新并入。
5. 不继续扩张 `sanitizeHistoryPayloadForPersist` 作为长期主合同。
