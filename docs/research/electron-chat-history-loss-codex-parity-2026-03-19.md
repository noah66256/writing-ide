# Electron 聊天历史丢失排查与 Codex 对照

日期：2026-03-19

## 结论

当前桌面端“聊天记录丢失 / 长对话前文像被截断”不是单一问题，而是两条链路叠加：

1. 模型上下文压缩只保留 `RECENT_DIALOGUE + DIALOGUE_SUMMARY`，这是预期行为。
2. UI 历史快照也被运行时 `items -> steps` 投影结果反向覆盖，导致展示历史被写短，这是 bug。

## 与 Codex 的关键差异

对照本地参考：

- `third_party/openai-codex/codex-rs/app-server/README.md`
- `third_party/openai-codex/sdk/typescript/src/thread.ts`

Codex 的原则是：

- `thread/read(includeTurns)` 读取持久化 rollout
- `thread/compact/start` 只影响模型上下文，不删除 UI transcript
- 线程历史是独立事实源，不把“当前上下文窗口”当成历史真相

我们当前的问题则是：

- `conversationStore.buildCurrentSnapshot()` 直接持久化投影后的 `steps`
- `threadProjection.projectRuntimeItemsToSteps()` 会在有 `items` 时丢掉部分旧 assistant/tool step
- `ConversationLayout` 初次恢复只加载最近一段 `steps`
- 后续自动保存会把这段“窗口化 steps”继续写回主快照

## 本次修复

### 1. 投影改为“覆盖 + 补充”，不再删历史

文件：

- `apps/desktop/src/agent/threadProjection.ts`

调整后：

- 现有 `steps` 视为已确认 transcript
- `items` 只负责覆盖同 id 的最新状态
- `items` 中不存在于 `steps` 的新条目才追加
- 不再用旧 heuristics 过滤掉历史 assistant/tool 消息

### 2. 快照更新改为按 id 合并

文件：

- `apps/desktop/src/state/conversationStore.ts`

调整后：

- `updateConversation`
- `setDraftSnapshot`
- `flushDraftSnapshotNow`
- `flushDraftSnapshotNowSync`

都不再简单用新快照整包覆盖旧快照，而是对 `steps/logs/turns/items/collabSessions/activeItemIds` 做按 id 合并。

直接收益：

- 初次恢复只加载最近 150 条，不会把完整历史写短
- 顶部“加载更多”拿到的旧消息不会在下一次自动保存时再次丢失

### 3. 启动时用 per-conv 文件自愈主快照

文件：

- `apps/desktop/electron/main.cjs`

新增逻辑：

- `history.loadConversations` 读取主历史后，会对每个会话尝试读取 `conversations/conv_<id>.json`
- 如果 per-conv 的 `steps/logs` 比主快照更长，则用它回补主快照
- 回补后最佳努力写回 `conversations.v1.json`

## 当前状态

本次改动后，桌面端已满足一个更接近 Codex 的中间态：

- “模型上下文压缩”与“UI 历史显示”不再继续互相污染
- 历史恢复和分页加载不会再轻易把主快照写短
- 已有被写短的主快照在下次读取时有机会从 per-conv 文件恢复

## 后续建议

如果继续向 Codex 对齐，下一阶段建议做：

1. 把 `thread/turns/items` 提升为真正的持久化事实源
2. `snapshot.steps` 降级为 display transcript cache，而不是唯一真相
3. Electron 侧补一个等价于 `thread/read(includeTurns)` 的读取接口
4. 把上下文 compaction 明确标注为模型侧行为，彻底与历史 UI 脱钩
