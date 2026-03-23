# Desktop History Event Log + Lightweight Persistence（v0.1）

> 目标：在现有 Desktop `index-first + single-writer + stale-overwrite guard` 基础上，把会话持久化从“compact snapshot 仍承载运行态真相”继续收口到“草稿历史分层 + append-only event log + background writer + 轻列表/重详情”的结构范式，解决 macOS / 长对话 / 高频工具调用下仍会出现的 OOM、卡顿与恢复脆弱问题。
>
> 对齐对象：
> - 本地一手参考 `third_party/openai-codex`
> - 已落盘文档：
>   - `docs/research/desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md`
>   - `docs/specs/desktop-history-and-project-loading-guardrails-v0.1.md`
>   - `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`
>   - `docs/specs/desktop-history-single-writer-and-fact-source-v0.1.md`
>   - `docs/specs/fix-desktop-history-stale-overwrite-guardrails-v1.md`

---

> 文档状态说明（2026-03-23 closeout）：
> 本文上半部分的“实施卡片 / 实现切片 / 实施状态 / 剩余未完成”已与当前代码事实同步；后文大段设计推导保留为方案背景，若与顶部状态描述冲突，以顶部 closeout 状态为准。

## 实施卡片

- spec：`docs/specs/desktop-history-event-log-and-lightweight-persistence-v0.1.md`
- 目标：完成历史持久化的三个结构性收口：`events.jsonl` 升级为长期 authority、runtime overlay 全量进入 event 模型、legacy `load/saveConversations*` compat IPC 退场，并把文档更新到 2026-03-23 当前代码事实。
- 范围：`apps/desktop/electron/main.cjs` 的 authority loader / event writer / materialize / legacy IPC 退场 / smoke；`apps/desktop/src/state/conversationStore.ts` 与 `apps/desktop/src/ui/components/ChatArea.tsx` 的 runtime event payload；`apps/desktop/src/ui/layouts/ConversationLayout.tsx` 的关窗 flush 探测；以及 source spec 回填。
- 不做什么：不在本轮引入 segment/artifact sidecar 新存储层；不做 ChatArea 窗口化；不把 derived body cache 进一步拆成更多物理文件。
- 当前状态：working tree（2026-03-23）
- 主要风险：sync shutdown 需要和 async writer queue 避免竞态；authority 保留 event log 后必须确保 materialize 幂等且不重复叠加；删掉 legacy IPC 后不能留下旧能力探测分支。

## 实现切片

| Slice | 对应 spec | Owner | 文件范围 | 风险 | 验证 |
|------|-----------|-------|---------|------|------|
| P1A-1 | `P1: Draft / Thread 分层` | main | `apps/desktop/src/state/conversationStore.ts` | 中：hydrate/恢复路径仍需兼容旧 draft | `npx tsc -p apps/desktop/tsconfig.json --noEmit` |
| P1A-2 | `P1: Draft / Thread 分层` | main | `apps/desktop/electron/main.cjs` | 高：history index / legacy / pending / compat 需共用同一 draft 合同 | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop smoke:history` |
| P1A-3 | 验证闭环 | main | `apps/desktop/electron/main.cjs` `apps/desktop/src/ui/components/SettingsModal.tsx` | 低：仅补 smoke 断言与 TS 校验阻塞 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop smoke:history` |
| P2A-1 | `P2: Event Log Writer` 最小 writer 合同 | main | `apps/desktop/electron/main.cjs` `apps/desktop/electron/preload.cjs` `apps/desktop/src/vite-env.d.ts` | 高：新增 Desktop IPC / 持久化 sidecar / internal replace-body 语义 | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` |
| P2A-2 | `P2: Event Log Writer` autosave 热路径切换 | main | `apps/desktop/src/ui/components/ChatArea.tsx` | 高：autosave 需要增量 step upsert，且不能把已加载历史误判为新增事件 | `npx tsc -p apps/desktop/tsconfig.json --noEmit` |
| P2A-3 | `P2: Event Log Writer` 行为验收 | main | `apps/desktop/electron/main.cjs` | 中：需要覆盖 event append / materialize / clear-field / 幂等 upsert | `npm run -w @ohmycrab/desktop smoke:history` |
| P2B-1 | `P2: Event Log Writer` 显式 flush 收口 | main | `apps/desktop/src/state/conversationStore.ts` `apps/desktop/electron/main.cjs` `apps/desktop/electron/preload.cjs` `apps/desktop/src/vite-env.d.ts` | 高：sync shutdown / IPC / pending batch 需要与现有 single-writer 合同兼容 | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` |
| P2B-2 | `P2: Event Log Writer` UI flush 点切换 | main | `apps/desktop/src/ui/layouts/ConversationLayout.tsx` `apps/desktop/src/ui/components/NavSidebar.tsx` | 中：切换会话 / 新建会话 / 关窗要保住现有保存语义 | `npx tsc -p apps/desktop/tsconfig.json --noEmit` |
| P2B-3 | `P2: Event Log Writer` sync smoke + 文档回填 | main | `apps/desktop/electron/main.cjs` `docs/specs/desktop-history-event-log-and-lightweight-persistence-v0.1.md` | 中：需要覆盖 sync append/materialize/clear-field，且把残留范围写清楚 | `npm run -w @ohmycrab/desktop smoke:history` |
| P3A-1 | `P3: Event Authority` 长期 authority 收口 | main | `apps/desktop/electron/main.cjs` | 高：materialize 后不再清 sidecar，authority loader 与 body cache 必须一致 | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop smoke:history` |
| P3A-2 | `P3: Event Authority` runtime overlay 事件化 | main | `apps/desktop/src/state/conversationStore.ts` `apps/desktop/src/ui/components/ChatArea.tsx` `apps/desktop/electron/main.cjs` | 高：`logs/turns/items/collabSessions/activeItemIds/transcript` 迁进 event 后，autosave 不能重新退回全量 body write | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop smoke:history` |
| P4-1 | `P4: Legacy Compat Shell` 退场 | main | `apps/desktop/electron/main.cjs` `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | 中：删除 public IPC 后，关窗/恢复路径不能再探测旧 API | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` |

## 实施状态

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| `draftSnapshot` 从 `RunSnapshot` 收成 `DraftState` | `conversationStore.ts` / `DraftState` / `slimDraftStateForHistory()` | 已完成（P1A） | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | draft 持久化不再保 `thread/turns/items/collabSessions/activeItemIds/logs/transcript` |
| history draft 读写合同统一轻量化 | `main.cjs` / `normalizeHistoryDraftSnapshot()` / `write-draft` / `history.loadConversationIndex` | 已完成（P1A） | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop smoke:history` | index / legacy / pending draft 都改走同一份轻量合同 |
| draft 轻量化最小行为验收 | `main.cjs` / `runHistorySmokeCli()` | 已完成（P1A） | `npm run -w @ohmycrab/desktop smoke:history` | smoke 新增断言：落盘 draft 不得再含 runtime 重字段 |
| main-process per-conversation event writer / materialize 合同 | `main.cjs` / `appendConversationEventBatchToWriter()` / `appendConversationEventBatchToWriterSync()` / `materializeConversationEventsToHistory()` / `materializeConversationEventsToHistorySync()` / `flushConversationEventWriter()` / `flushConversationEventWriterSync()` | 已完成（P2A/P2B/P3A） | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop smoke:history` | 当前 sidecar 为 `conv_<id>.events.jsonl`；sync/async 都可 materialize；materialize 会合并 event file + in-memory pending batches，并继续走 internal `replaceBody` 语义以支持清空 `todoList/thread`，且默认不再清 sidecar |
| renderer autosave 不再 `write-body(snapshot)`，改 `draft + append events` | `ChatArea.tsx` / `buildConversationHistoryEventPayload()` / `window.desktop.history.appendEvents()` | 已完成（P2A） | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | 仅覆盖运行中 autosave 热路径；step 走增量 upsert，head/thread 走轻量事件 |
| run end 改 append final events + materialize | `ChatArea.tsx` / `history.materializeConversation()` / `history.flushWriter()` | 已完成（P2A） | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop smoke:history` | 运行结束不再默认回到 `flushDraftSnapshotNow()`，而是优先走 writer/materialize |
| 恢复前消费 active conv event sidecar | `main.cjs` / `history.readConversationSnapshot` / `history.loadConversationIndex` | 已完成（P2A/P2B） | `npm run -w @ohmycrab/desktop smoke:history` | `readConversationSnapshot()` 与 `loadConversationIndex()` 返回前都会先 materialize active conversation；仍不会全量 materialize 整个列表 |
| `flushDraftSnapshotNow*()` 收口到 draft lane + writer/materialize | `conversationStore.ts` / `dropPendingHistoryBodyWritesForConversation()` / preload / main | 已完成（P2B） | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop smoke:history` | 成功走新链路时会先剔除当前会话挂在 `pendingHistoryBatch` 里的旧 `write-body`，避免 `beforeunload/switch/new chat` 又把 legacy body 夹带刷出 |
| `ConversationLayout` / `NavSidebar` 的显式 flush 点改走 writer/materialize | `ConversationLayout.tsx` / `flushDraftSnapshotNowSync()`；`NavSidebar.tsx` / `flushDraftSnapshotNow()` / `promoteDraftToConversation()` | 已完成（P2B） | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | `hide/pagehide/beforeunload`、切换会话、New Chat 优先走新 writer；无 active conversation 的草稿会先建 placeholder meta，再通过 event authority materialize 正文 |
| history smoke 覆盖 sync append/materialize | `main.cjs` / `runHistorySmokeCli()` | 已完成（P2B/P3A） | `npm run -w @ohmycrab/desktop smoke:history` | smoke 覆盖 async/sync append/materialize、clear-field、runtimeState 全覆盖、删 body 后从 authority 重建，以及 event log 保留断言 |
| 草稿晋升不再 `addConversation(snapshot)` 直写正文 | `conversationStore.ts` / `promoteDraftToConversation()` | 已完成（P2B） | `npx tsc -p apps/desktop/tsconfig.json --noEmit` | 新会话先写 placeholder meta，正文通过 `persistConversationSnapshotViaEvents(..., { materialize: true })` 进入 authority |
| renderer 热路径不再残留 `updateConversation(buildCurrentSnapshot())` | `InputBar.tsx` / `ChatArea.tsx` / `NavSidebar.tsx` / `runTarget.ts` | 已完成（P2B） | `rg -n "updateConversation\\(" apps/desktop/src` | `apps/desktop/src` 已无直接调用；renderer 主链统一走 helper + event writer |
| `events.jsonl` 成为长期 authority，`conv_<id>.json` 退为 derived cache | `main.cjs` / `loadConversationAuthoritySnapshotFromCurrentDir*()` / `materializeConversationEventsToHistory*()` / `history.readConversationSnapshot` | 已完成（P3A） | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop smoke:history` | event log 默认保留；删掉 body 后仍可由 authority 直接重建 snapshot，并重新 materialize cache |
| runtime overlay 全量进入 event authority | `conversationStore.ts` / `buildHistoryEventBatchFromSnapshot()`；`ChatArea.tsx` / `buildConversationHistoryEventPayload()`；`main.cjs` / `normalizeHistoryEventRuntimeState()` | 已完成（P3A） | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop smoke:history` | `logs / turns / items / collabSessions / activeItemIds / transcript` 已进入 runtimeState，append/materialize/clear-field 都有 smoke 覆盖 |
| legacy `load/saveConversations*` compat IPC 退场 | `main.cjs` / `ipcMain.handle(\"history.loadConversations\")` / `ipcMain.handle(\"history.saveConversations\")` / `ipcMain.on(\"history.saveConversationsSync\")`；`ConversationLayout.tsx` | 已完成（P4） | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` | renderer/public IPC 已不再暴露，也不再探测旧 handler；桌面主链只认 index/body/event authority |

## 剩余未完成

当前 spec 范围内已收口完成，无阻塞性剩余项。

## 范围外后续（截至 2026-03-23）

1. `conv_<id>.json` 目前仍保留为 derived/materialized cache，用于详情读取与恢复提速；它已经不再是事实源，但如果后续要继续瘦身，还可以再评估 cache 粒度与压缩策略。
2. `write-body.replaceBody` 仍保留为 main 内部 materialize 语义，用来表达 runtimeState 的“清空字段”；这是内部实现细节，不再对 renderer/public compat API 暴露。
3. `loadConversationIndex()` 仍坚持 index-first，不会为了 authority 收口去全量 materialize 整个列表；这是刻意保留的启动性能边界。

## 1. 结论先行

当前桌面端已经从“整包快照重写”推进到“draft lane + event writer + authority-first compat”的结构，但还没有彻底走到 `events.jsonl = 长期唯一 authority`。

已经完成的部分：

1. 启动恢复已经从 `loadConversations()` 向 `loadConversationIndex()` 倾斜，开始具备 `index-first` 能力。
2. 活跃会话 autosave、run end、beforeunload、切换会话、新建会话都已优先走 `appendEvents + materializeConversation + flushWriter`。
3. `legacy v1 mirror` 已退出默认热写链，只在 compat API 下显式回写；compat 翻译也改成从当前 authority 现算。
4. `clear-all`、stale overwrite、pending 覆盖等最危险的“直接写坏历史”路径，已经加上多层 guard。

还没完全切断的点是：

1. materialize 后的 v2 body 仍是 compact snapshot，`turns/items/thread/collabSessions` 这类运行态恢复层还没有从正文彻底剥离。
2. 事件模型当前只覆盖 `head + stepUpserts + thread`，大 runtime overlay 仍需通过 compact body/compat 链兜底。
3. `events.jsonl` 仍是 journal 而不是长期唯一 authority；materialize 成功后 sidecar 会被清空。

所以当前形态更像：

- “hot path 已切到事件流，materialized body 仍是 compact snapshot 读模型”

而不是：

- “线程历史已经完全变成 append-only event log 且长期只读派生视图”

本 spec 的推荐方向很明确：

> **把 Desktop history 从 `single-writer + snapshot merge` 再推进半步，收成 `draft history split + append-only thread event log + background writer + explicit materialize/flush points`。**

---

## 2. 问题定义

### 2.1 这次真正要修的不是“数据丢没丢”，而是“持久化边界错了”

根据最新排查，最近几轮修复已经显著改善了：

1. 启动时误写空
2. hydrate 竞态
3. autosave timer 饿死
4. legacy/pending 抢真相
5. dev 与 packaged `userData` 错位

但 macOS 端仍会在长任务、高频工具调用、重历史目录、长时间运行时继续崩，根因已经从“会话直接丢失”收敛成：

1. **历史正文仍然太像运行态**
2. **热路径仍然要构造并搬运一个 fat runtime snapshot**
3. **renderer / main / v2 body / index / legacy mirror 之间的职责边界仍不够硬**

### 2.2 目前最重的链还在 `runtime items`

`docs/research/desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md` 已确认：

1. 最大单会话文件里，主要体积仍在 `snapshot.items`
2. 最大 item 基本是 `toolCall(read)` 对应的大 `result.content`
3. 同一份工具结果经常以 shadow item + authoritative item 双份存在
4. `buildCurrentSnapshot()` 热路径仍会复制这些对象

换句话说，当前“历史持久化”虽然已经比最早安全，但本质仍偏向：

- 把当前运行态裁一点、瘦一点、合并一下，然后继续持久化

而不是：

- 持久层天然就是轻量、增量、日志式的；运行态再重也不会原样升格成持久化正文

---

## 3. 与 Codex 的一手对照结论

### 3.1 Codex 把“输入框历史”和“线程持久化”明确拆开

本地参考：

- `third_party/openai-codex/docs/tui-chat-composer.md`

公开实现明确区分：

1. `Persistent history`：跨 session，`~/.codex/history.jsonl`，text-only
2. `Local history`：当前 UI session，保留完整 draft state 与附件

这说明 Codex 不会把“完整输入框/草稿状态”直接当成线程持久化真相。

### 3.2 Codex 的线程持久化是 `sessions/*.jsonl`，不是周期性整份快照重写

本地参考：

- `third_party/openai-codex/sdk/typescript/src/codex.ts`
- `third_party/openai-codex/codex-rs/core/src/rollout/recorder.rs`
- `third_party/openai-codex/codex-rs/core/src/agent/control.rs`

可直接借鉴的结构结论：

1. thread 持久化放在 `~/.codex/sessions`
2. 真实写盘走 `RolloutRecorder`
3. `record_items()` 只负责把事件 `AddItems` 进队列
4. 真正写盘由后台 writer task 追加写 JSONL
5. 只有 fork / resume / shutdown 这种需要强一致的节点，才显式 `persist/flush`

### 3.3 Codex 的正常热路径是“轻列表 / 重详情”

仓库内已有研究已确认：

1. `thread/list`、`thread/read(includeTurns=false)` 走轻量热路径
2. 只有 `resume/fork/read(includeTurns=true)` 才恢复完整 turns
3. UI 当前线程可以重，但所有线程的启动/列表路径必须轻

这和我们现在已经落地的 `loadConversationIndex()`、`readConversationSnapshot()`、`loadConversationSegment()` 是同方向的，只差最后一层“正文事实源范式”还没彻底换掉。

---

## 4. 当前状态：已经修到哪了

## 4.1 已有基线，不能推翻

当前工作树里，以下能力已经存在，且本 spec 必须复用：

1. `conversationStore.hydrateFromDisk()` 已优先走 `history.loadConversationIndex()`
2. `history.readConversationSnapshot()` / `history.loadConversationSegment()` 已具备按需读详情能力
3. `history.applyOperations()` / `history.applyOperationsSync()` 已经是新热路径
4. main-process 已具备：
   - revision guard
   - stale write reject
   - pending journal
   - legacy compat shell
   - per-conv body + index mirror

对应当前文件：

- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/electron/preload.cjs`
- `apps/desktop/electron/main.cjs`

## 4.2 当前仍待继续收口的点

### A. `buildCurrentSnapshot()` 已变轻，但仍是 compact body 的输入之一

当前 `apps/desktop/src/state/conversationStore.ts` 的 `buildCurrentSnapshot()` 仍会把这些字段带进 snapshot：

1. `steps`
2. `logs`
3. `thread`
4. `turns`
5. `items`
6. `collabSessions`
7. `activeItemIds`

当前实现已经不再做最粗暴的整包 `JSON.parse(JSON.stringify(...))` 深拷贝，而是：

1. 运行态只做必要的浅拷贝
2. 保存前统一走 `slimSnapshotForHistory()`
3. `read` 工具结果、shadow item 去重、`turn.itemIds`/`activeItemIds` remap 都在这里收口

但它仍在语义上承担了：

- “把当前 runtime 压成一个可持久化正文”

所以它已经不再是最重的爆点，但仍是后续 `P3/P5` 继续抽离 runtime overlay 的关键入口。

### B. autosave 热路径已经切到事件流，但 materialize 后仍会回到 compact body

当前 `ChatArea` 的 autosave 已从会饿死的 `setTimeout` 改成“脏标记 + 固定间隔轮询”，这是对的。

当前运行中保存已经优先做的是：

1. `setDraftSnapshot(snap)`
2. `appendEvents(batch)`
3. run end / flush 点再 `materializeConversation(convId) + flushWriter(convId)`

也就是说，autosave 的“正文热写”问题已经切掉，但最终 authority 仍会 materialize 成 compact body，因此根因只切了一半。

### C. main-process 现在同时维护 event writer 与 snapshot compat

当前 `apps/desktop/electron/main.cjs` 的 `applyHistoryOperationsToDir()` 已经很接近正确方向：

1. 有 batch / intent / revision
2. 有 `write-body` / `write-draft` / `upsert-meta`
3. 有 pending journal 与 sync/async 路径

同时现在还新增了：

1. `appendConversationEventBatchToWriter()` / `Sync`
2. `materializeConversationEventsToHistory()` / `Sync`
3. `flushConversationEventWriter()` / `Sync`
4. `buildLegacyPayloadFromAuthority()` / `Sync`

所以 main-process 已不是“只有 snapshot-body 的 single writer”，而是：

- hot path：event writer
- read model：materialized compact body
- compat：legacy payload translator

残余问题是 event writer 还没有升级成长期唯一 authority。

### D. legacy mirror 已退出热路径，但 compat 期仍需保留

当前默认热路径写的是：

1. `conversations.index.v2.json`
2. `conversations/conv_<id>.json`

只有 legacy compat API（`saveConversations*`）才会显式写：

3. `conversations.v1.json`

这已经显著降低了写放大，但兼容期仍要继续保留这层 mirror，因此文档和代码都必须坚持：

1. legacy 只能从 authority 派生
2. 有 v2 body 时不得再 merge stale v1
3. compat 壳不能重新抢回事实源

---

## 5. 推荐范式

## 5.1 一句话

> **把“会话历史”拆成两条存储车道：`draft/composer lane` 与 `thread/event-log lane`；前者服务输入框回忆，后者服务线程恢复；真正的线程正文改为 append-only event log，由 main-process background writer 异步写入，UI snapshot 只作为读模型与缓存。**

## 5.2 目标状态

### Lane A：Draft / Composer History

只解决：

1. 用户输入框回忆
2. 当前会话未提交草稿恢复
3. 本地 session 内 richer draft state

不再承担：

1. 线程正文事实源
2. tool run/runtime state 的持久化真相

推荐合同：

1. `persistent draft history`：text-first、轻量、跨 session
2. `local draft state`：当前 session richer state，可带附件引用，但不进线程正文

### Lane B：Thread Event Log

线程持久化改为：

1. append-only event log
2. 事件由 main-process background writer 串行落盘
3. renderer 不再周期性提交完整 `RunSnapshot`

event log 只记录“线程发生了什么”，例如：

1. user message appended
2. assistant message chunk completed
3. tool call started / updated / completed
4. proposal created / accepted / undone
5. waiting-user entered / resolved
6. task state changed
7. metadata changed（title/pin/archive）

### Read Model：Index / Snapshot / Segment

读取层保留轻列表/重详情范式，但降级为“读模型”：

1. `thread index`：列表页/启动页热路径
2. `materialized compact snapshot`：当前活动线程恢复
3. `segment cache`：滚动加载/迷你地图
4. `legacy v1 mirror`：仅兼容壳，不再长期主写链

核心原则：

1. **event log 是 authority**
2. **snapshot / index / segment 都是 derived state**
3. **derived state 可以丢，可以重建，不反向覆盖 authority**

## 5.3 background writer + explicit flush

推荐直接对齐 Codex 的 writer 结构：

1. renderer 只发小粒度 op/event
2. preload 只暴露 event append / draft save / explicit flush
3. main-process 维护一个 writer queue
4. 正常路径：异步写 event log
5. 强一致节点：显式 materialize/flush

显式 flush 点建议定义为：

1. app quit / hide / unload
2. 切换 active conversation
3. 导出会话 / 复制线程 / 归档前
4. 启动恢复前需要消费 pending journal 时
5. 后续若支持 thread fork / sub-agent thread snapshot，也在 fork 前 flush

正常 autosave 不再 flush 整个正文，只负责：

1. 记录 draft lane
2. 推送 thread events

---

## 6. 存储合同建议

## 6.1 目录结构（建议）

保守演进版：

```text
userData/ohmycrab-data/
  conversations.index.v3.json
  conversations.pending.ops.v3.json
  conversations/
    <conversationId>/
      events.jsonl
      materialized.snapshot.json
      segments/
        seg_000001.json
  draft-history.jsonl
  drafts/
    <conversationId>.json
```

说明：

1. `events.jsonl`：唯一权威正文
2. `materialized.snapshot.json`：可重建读模型
3. `segments/*`：可选优化层，用于滚动加载与快速恢复
4. `draft-history.jsonl`：跨 session text-only 历史
5. `drafts/<id>.json`：当前 richer local draft state

## 6.2 事件模型（建议）

最小事件集：

```ts
type ThreadEvent =
  | { type: "thread.meta"; conversationId: string; title?: string; pinned?: boolean; archived?: boolean; ts: number }
  | { type: "thread.user_message"; conversationId: string; turnId: string; message: SerializedMessage; ts: number }
  | { type: "thread.assistant_message"; conversationId: string; turnId: string; message: SerializedMessage; ts: number }
  | { type: "thread.tool_call"; conversationId: string; itemId: string; toolCallId: string; toolName: string; state: "started" | "completed" | "failed"; payload: ToolPersistencePayload; ts: number }
  | { type: "thread.workflow"; conversationId: string; taskState: CompactTaskState; ts: number }
  | { type: "thread.waiting"; conversationId: string; waitingState: CompactWaitingState | null; ts: number }
  | { type: "thread.proposal"; conversationId: string; proposal: CompactProposalEvent; ts: number }
  | { type: "thread.active"; conversationId: string | null; ts: number };
```

关键约束：

1. `ToolPersistencePayload` 只保留历史恢复必要字段
2. `read.result.content` 默认只保 preview / pointer，不保 full content
3. shadow item 不再双写
4. runtime live object 不得直接原样进入 event

## 6.3 draft 合同（建议）

draft lane 明确只服务输入体验：

1. 已提交到线程的消息，不再靠 `draftSnapshot` 恢复
2. `draftSnapshot` 不再承载 `thread/turns/items`
3. `draftSnapshot` 最多保：
   - draft text
   - draft selection/cursor
   - local attachments reference
   - active conversation id

---

## 7. 对当前代码的落点

## 7.1 `apps/desktop/src/state/conversationStore.ts`

### 当前职责

1. `buildCurrentSnapshot()`
2. `schedulePersistToDisk()`
3. `setDraftSnapshot()`
4. `flushDraftSnapshotNow()`
5. `flushDraftSnapshotNowSync()`

### 推荐改动

1. `buildCurrentSnapshot()` 从“历史正文构造器”降级为“当前 UI 读模型快照构造器”
2. autosave 不再触发 `write-body(snapshot)`，改为：
   - `saveDraftState()`
   - `appendThreadEvents()`
3. `draftSnapshot` 从 `RunSnapshot` 收成 `DraftState`
4. `flushDraftSnapshotNow*()` 改成：
   - flush draft lane
   - request thread writer flush/materialize

### 不应继续保留的语义

1. “当前 active runtime 快照 = 可直接持久化正文”
2. “draftSnapshot 兼作线程恢复正文”

## 7.2 `apps/desktop/src/ui/components/ChatArea.tsx`

### 当前职责

1. 脏标记 autosave
2. run end flush
3. 历史滚动加载

### 推荐改动

1. 保留脏标记 + 固定 interval
2. interval 内不再 `buildCurrentSnapshot()` 后整包提交
3. 改为生成轻量增量事件：
   - new/updated transcript entries
   - tool state delta
   - task state delta
   - draft text delta
4. run end 只请求：
   - append final events
   - materialize current thread
   - flush writer

## 7.3 `apps/desktop/electron/preload.cjs`

### 当前职责

1. `applyOperations*`
2. `loadConversationIndex`
3. `readConversationSnapshot`
4. `loadConversationSegment`
5. legacy `saveConversations*`

### 推荐改动

新增并逐步切换到：

1. `history.appendEvents(batch)`
2. `history.appendEventsSync(batch)` 仅限关窗
3. `history.saveDraftState(payload)`
4. `history.materializeConversation(conversationId)`
5. `history.flushWriter(conversationId?)`
6. `history.readConversationIndex()`
7. `history.readConversationMaterializedSnapshot(params)`
8. `history.readConversationSegment(params)`

legacy `saveConversations*` 保留 compat phase，但退出热路径。

## 7.4 `apps/desktop/electron/main.cjs`

### 当前可复用部分

1. `normalizeHistoryOperationBatch()`
2. `applyHistoryOperationsToDir()`
3. pending journal
4. revision guard
5. `loadConversationIndex` / `readConversationSnapshot` / `loadConversationSegment`

### 推荐改动

1. 新增 `ConversationEventWriter`
2. `applyHistoryOperationsToDir()` 逐步降级为 compat translator
3. `write-body` 不再作为主热路径
4. main-process 维护：
   - event queue
   - per-conversation materialized snapshot
   - last materialized offset / revision
5. `conversations.v1.json` 改成非热路径 compat mirror

## 7.5 `apps/desktop/src/ui/layouts/ConversationLayout.tsx`

### 推荐改动

1. 恢复路径只读 `index + materialized snapshot + segment`
2. beforeunload / hide 不再同步交整份 payload
3. 改为同步：
   - flush draft
   - flush writer
   - optional materialize active conversation

---

## 8. 分 Phase 计划

## P0：基线冻结与术语收口

目标：

1. 明确当前已落能力是基线，不再重复改回旧范式
2. 明确新术语：
   - `DraftState`
   - `ThreadEvent`
   - `MaterializedSnapshot`
   - `ThreadIndex`

产物：

1. 本 spec
2. 类型草案
3. 迁移 checklist

## P1：Draft / Thread 分层

目标：

1. `draftSnapshot` 从 `RunSnapshot` 收成 `DraftState`
2. 输入框历史与线程持久化职责分离

代码落点：

- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/src/ui/components/ChatArea.tsx`
- `apps/desktop/electron/preload.cjs`
- `apps/desktop/electron/main.cjs`

验收：

1. 草稿恢复不再需要 `thread/turns/items`
2. 已提交消息的恢复不再依赖 draft

## P2：Event Log Writer

目标：

1. main-process 增加 per-conversation event writer
2. renderer autosave 改提交 events，不再写 body snapshot

代码落点：

- `apps/desktop/electron/main.cjs`
- `apps/desktop/electron/preload.cjs`
- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/src/ui/components/ChatArea.tsx`

验收：

1. 高频工具调用期间，热路径不再生成完整 `RunSnapshot`
2. 历史写盘量与线程总体积解耦

## P3：Materialized Snapshot / Index v3

目标：

1. `readConversationSnapshot` 改读 materialized snapshot
2. index 彻底只保 summary/meta
3. `events.jsonl` 成为 authority

验收：

1. 启动只读 index
2. active conversation 恢复不解析全量 event log 以外的其他会话

## P4：Legacy Mirror 退热路径

目标：

1. `conversations.v1.json` 改为迁移/诊断用途
2. compat shell 默认不参与每次热写

验收：

1. 日常 autosave 不再写 legacy v1
2. `loadConversations()` 不再是主恢复入口

## P5：Runtime Compact 深收口

目标：

1. `read.result.content` 改 preview-only persistence
2. shadow item / authoritative item 持久化前去重

说明：

这一期不是新问题，而是把 `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md` 作为 event-log 范式下的子任务继续落完。

---

## 9. 不做什么

本 spec 不做：

1. 不先改 Gateway 协议
2. 不先重写 Agent runtime 主合同
3. 不把 ChatArea DOM 虚拟化合并进本期
4. 不把项目加载链和历史持久化链重新绑在一起
5. 不要求一次性删除现有 `v2 index / per-conv / legacy` 文件
6. 不要求一次性上线完整数据库；文件制 event log 即可

---

## 10. 验证方案

## 10.1 功能验收

1. 长时间流式输出 / 高频工具调用期间，会话仍持续可恢复
2. 正常退出、强退、dev Ctrl+C 后，历史不丢且不写短
3. 启动只恢复列表和 active conversation，不吞所有会话正文
4. “加载更多历史”不会在下一次 autosave 后再被写丢
5. draft recall 与 thread resume 语义分离，互不污染

## 10.2 性能验收

1. autosave 热路径不再构造完整 `RunSnapshot`
2. 单次写盘 payload 大小从“与线程总历史相关”下降到“与本次新增事件相关”
3. `read.result.content` 不再成为持久化正文的大头
4. 启动时不再扫描/解析所有旧正文才能显示会话列表

## 10.3 回归门禁

必须新增：

1. history writer fixture
2. crash-recovery fixture
3. long-tool-run autosave fixture
4. stale-write rejection fixture
5. legacy migration fixture

建议新增 smoke：

1. 连续 5 分钟工具调用后强退重启
2. 10MB 以上旧历史目录启动
3. 历史分页后继续运行并 autosave

---

## 11. 回滚策略

为降低切换风险，本方案按“新写链上线，旧读链兜底”推进：

1. Phase 1-2 期间保留 `applyOperations` compat 壳
2. event log materialize 失败时，允许回退到现有 `v2 per-conv` 读取
3. `conversations.v1.json` 在 compat 期保留只读恢复能力
4. 新 writer 上线初期保留双写开关，但仅限短期灰度，不作为长期主线

核心原则：

1. 回滚只能影响“怎么写新数据”
2. 不能再允许 derived snapshot 反向覆盖 authority

---

## 12. 最终建议

这轮不建议继续在现有 `snapshot merge + guard` 上打补丁。

更合适的主线是：

1. 认定 `single-writer + index-first` 已经完成第一阶段
2. 把后续主战场明确成：
   - `draft history split`
   - `thread event log`
   - `background writer`
   - `explicit materialize/flush`
   - `legacy mirror off hot path`

这样做的直接收益不是“代码更优雅”，而是：

1. autosave 不再和线程总大小正相关
2. 历史恢复不再和当前 UI 运行态绑定
3. macOS 上最容易炸的主线程/IPC/序列化链会真正变短
4. 后续再做 runtime compact、segment cache、thread fork/resume，都会有稳定事实源可挂
