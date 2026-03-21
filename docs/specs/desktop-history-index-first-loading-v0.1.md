# Desktop 会话历史 Index-First 加载方案（v0.1）

## 1. 目标

在 **不改 Gateway 合同**、**不推翻现有 v2 per-conv 存储**、**不破坏最近几轮 runtime/恢复修复** 的前提下，把桌面端会话恢复从“启动即全量 hydrate 所有会话”收敛为：

1. **启动先读轻量索引**
2. **用户进入某条会话时再按需读详情**
3. **详情恢复继续复用现有 `loadConversationSegment`**

本期只做 **Desktop 侧 P0**，不顺手扩 scope 到 gateway / project lazy load 全改造。

---

## 2. 背景与问题

当前桌面端已经完成多轮“历史瘦身 / runtime 语义补齐”，但启动恢复仍有一个结构性问题：

- `conversationStore.hydrateFromDisk()` 启动即调用 `history.loadConversations()`
- 主进程 `history.loadConversations` 仍返回完整 `conversations`
- 结果是 **所有会话 snapshot** 都会先进入 renderer 内存

对应代码：

- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/electron/main.cjs`

这会和已经确认的 V8 OOM 风险叠加：

- 即使 `runtime items / turns / logs.data / merge` 已瘦身
- 只要恢复入口仍然是 **all conversations eager hydrate**
- 长期仍会继续把阈值往上推，而不是切断根因

---

## 3. 一手参考与已核对 commit

## 3.1 官方 Codex（本地参考仓）

已核对：

- `third_party/openai-codex` 已 fetch 到最新 `origin/main`
- 重点看过以下提交与代码：

### 官方 commit

1. `78e8ee4` — `fix(tui): restore remote resume and fork history`
2. `334164a` — `feat(tui): restore composer history in app-server tui`
3. `461ba01` — `Feat/restore image generation history`
4. `2cc4ee4` — `temporarily disable private desktop until it works with elevated IPC path`

### 官方代码/文档结论

- `Thread.turns` 默认空；只有 `resume/fork/read(includeTurns=true)` 才带完整 turns
  - `third_party/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
- session lookup / picker 先走 `thread/list`、`thread/read(include_turns=false)`
  - `third_party/openai-codex/codex-rs/tui_app_server/src/lib.rs`
  - `third_party/openai-codex/codex-rs/app-server/tests/suite/v2/thread_read.rs`
- composer 历史明确分层：
  - persistent history：text-only
  - local history：full draft state
  - `third_party/openai-codex/docs/tui-chat-composer.md`

### 对本项目的直接启发

Codex 公开实现的关键不是“永远不加载完整历史”，而是：

1. **列表轻**
2. **当前 thread 重**
3. **持久层轻 / 本地 session 重**

这与我们当前“启动即全量 hydrate conversations”存在范式差异。

## 3.2 我们仓库内已存在的相关提交

### 已有能力（必须保留）

1. `806e657` — `feat: desktop history segments & waiting-user state`
   - 已引入 `history.loadConversationSegment`
2. `569f18f` — `fix(desktop): improve conversation restore and history display`
   - 已把首次 restore 收敛到 `loadConversationSegment`
3. `56a7800` — `fix(desktop): make conversation autosave robust under streaming and ctrl-c`
   - 已加固 autosave / pending
4. `003a2e2` — `feat: cut over codex-style thread runtime`
   - 已引入 runtime items/turns 投影链
5. `703176a` / `c0b5c6d`
   - 已修补 runtime strip / item merge / display 修复

### 更早的来源

6. `ba98459` — `feat(project): local disk project open/read/write + recent projects`
   - 当前 `projectStore` 的“打开项目即全量 readFile”逻辑来自这里

---

## 4. 当前事实（已经在代码中存在）

## 4.1 v2 index 已经在写，但启动没有消费

主进程当前已经在 `saveConversationsV2()` 写：

- `conversations.index.v2.json`
- `conversations/conv_<id>.json`

索引内容已经包括：

- `id`
- `title`
- `pinned`
- `archived`
- `createdAt`
- `updatedAt`
- `lastMessagePreview`
- `recentStepsMeta`

但目前启动恢复没有真正使用这份 index；`history.loadConversations` 仍从 v1 主文件路径返回完整 conversations。

## 4.2 per-conv 文件已经足够承载按需详情恢复

`conv_<id>.json` 当前已存：

- `head`
- `steps`
- `logs`
- `thread`
- `turns`
- `items`
- `collabSessions`
- `activeItemIds`

这意味着：

- 我们不需要先重做存储格式
- 只需要补齐“**怎么读**”和“**什么时候读**”

## 4.3 `projectStore` 已经有 lazy read 基础能力

当前 `ensureLoaded(path)` 已存在：

- 单文件第一次真正用到时才 `readFile`

但 `loadProjectFromDisk(rootDir)` 仍在打开项目时把所有文件正文读入。

这条链确认是后续 phase 的目标，但本期先不一起改，以免改动面过大。

---

## 5. 本期范围（P0）

本 spec 只覆盖：

1. 会话列表改为 **index-first**
2. 单会话详情改为 **按需读取**
3. 保存链保证 **不会因 index-only hydrate 把未加载会话的 per-conv 文件写坏**

### 明确不做

1. 不改 Gateway
2. 不改线程/runtime 合同
3. 不同时改项目树 lazy load
4. 不重写 `threadProjection` / `mergeSnapshotForHistory`
5. 不推翻现有 `pending conversations` / `draftSnapshot` 机制

---

## 6. 方案概览

## 6.1 新增两条 Desktop IPC，旧接口保留兼容

### 新接口 A：`history.loadConversationIndex`

职责：

- 启动阶段只返回会话索引，不返回完整 snapshot

返回建议：

```ts
{
  ok: true,
  conversations: Array<{
    id: string,
    title: string,
    pinned?: boolean,
    archived?: boolean,
    createdAt: number,
    updatedAt: number,
    lastMessagePreview?: { type: "user" | "assistant"; text: string; ts?: number } | null,
    recentStepsMeta?: Array<{ id: string; type: "user" | "assistant" | "tool"; toolName?: string; hasError?: boolean }>
  }>,
  activeConvId?: string | null,
  draftSnapshot?: any | null,
  draftSnapshotOwnerId?: string | null,
  used?: "primary" | "fallback",
  file?: string
}
```

说明：

- `draftSnapshot` 本期先沿用现状，不在这次一并拆轻重
- 这是为了减小回归面；真正的大头是“所有历史会话一起 hydrate”

### 新接口 B：`history.readConversationSnapshot`

职责：

- 用户进入某条会话时，按需读取该会话详情

入参建议：

```ts
{
  conversationId: string,
  includeSteps?: boolean // 默认 false
}
```

返回建议：

```ts
{
  ok: true,
  snapshot?: RunSnapshot | null,
  error?: string
}
```

读取策略：

1. 优先读 `conversations/conv_<id>.json`
2. 找不到再回退 v1 历史
3. `includeSteps=false` 时不返回大 steps，步骤仍由 `loadConversationSegment` 负责

这样更接近 Codex 的：

- `thread/list`
- `thread/read(includeTurns=false)`
- `thread/resume`

分层方式。

## 6.2 `hydrateFromDisk()` 改为优先 index-first

目标逻辑：

1. 若存在 `history.loadConversationIndex`，优先使用
2. 否则回退旧 `history.loadConversations`

hydrate 后 store 中的 `conversations` 先只放 **轻量会话条目**

但为了兼容现有 `Conversation` 类型，本期不立刻拆 store 结构，而是给每条记录放一个 **summary snapshot 占位**。

占位 snapshot 仅保证 UI 不炸：

```ts
{
  mode: "agent",
  model: "",
  mainDoc: {},
  todoList: [],
  steps: [],
  logs: [],
  kbAttachedLibraryIds: [],
  ctxRefs: [],
  pendingArtifacts: []
}
```

同时新增内部状态位：

```ts
snapshotLoadState?: "summary" | "full"
```

约束：

- `summary` 只用于“列表可展示”
- 不能被当成真正的详情快照写回 per-conv

## 6.3 进入会话时再读详情

### 启动自动恢复 active conversation

当前 `ConversationLayout` 已经会：

1. 从 active conversation 取 snapshot
2. 调 `loadConversationSegment`

本期改为：

1. 若 active conversation 是 `summary`
2. 先 `readConversationSnapshot(includeSteps=false)`
3. 再 `loadConversationSegment(limit=150)`
4. 组装成最终 `loadSnapshot(...)`

### Sidebar 切换会话

当前 `NavSidebar.handleLoadConversation()` 直接拿 `conv.snapshot` 当 base。

本期改为：

1. 若 `snapshotLoadState === "full"`，沿用现有逻辑
2. 若 `snapshotLoadState === "summary"`，先按需读详情，再恢复

这样可以把改动收敛在：

- `ConversationLayout`
- `NavSidebar`
- `conversationStore`

而不是把所有读取快照的地方全部打散。

---

## 7. 最关键的风险：不能把未加载会话写坏

这是本期最高优先级风险。

### 现状风险

当前 `schedulePersistToDisk()` / `flushDraftSnapshotNow()` 会把 store 里的 `conversations` 整包丢给：

- `history.saveConversations`

而主进程 `saveConversationsV2()` 会遍历这些 conversations 并重写每个 `conv_<id>.json`。

如果我们只把会话 hydrate 成 summary placeholder，但保存链不改，就会发生：

- 用户只是 pin / archive / rename 了一条未真正打开过的会话
- 下一次保存时该会话的 per-conv 文件被 summary placeholder 覆盖
- 历史正文丢失

### 本期护栏

`saveConversationsV2()` 需要升级成“**索引写全量，详情只写 full 会话**”：

1. **index 文件**
   - 所有 conversations 都参与写入
   - 以 store 中 metadata 为准

2. **per-conv 文件**
   - 仅对 `snapshotLoadState === "full"` 的会话重写
   - `summary` 会话保留磁盘上的旧 `conv_<id>.json`

3. **v1 主文件**
   - 降级为兼容兜底文件
   - 可以允许其中对未加载会话只存轻量 placeholder
   - 正常启动新路径优先读 v2 index，不再依赖 v1 主文件承载所有完整详情

### 额外规则

- `snapshotLoadState` 属于内部元信息
- 写磁盘时必须 strip，不能原样写入 snapshot/head

---

## 8. 数据与接口约束

## 8.1 本期不改 per-conv 主体合同

不改：

- `conv_<id>.json` 内 `steps/logs/thread/turns/items/...` 结构
- `loadConversationSegment`
- `repairConversationSnapshotForDisplay`
- `mergeSnapshotForHistory`

原因：

- 这些正是最近几轮修复的稳定核心
- 本期只改“入口是先全量读还是先索引读”

## 8.2 `conversations.index.v2.json` 继续作为事实源

本期应明确：

- 启动列表事实源：`conversations.index.v2.json`
- 单会话详情事实源：`conversations/conv_<id>.json`
- `conversations.v1.json`：兼容 / 迁移 / fallback

---

## 9. 实施顺序（建议严格按顺序）

## Phase 1：加新 IPC，不动现有调用

1. `main.cjs`
   - 新增 `history.loadConversationIndex`
   - 新增 `history.readConversationSnapshot`
2. `preload.cjs`
   - 暴露新 API
3. `vite-env.d.ts`
   - 补类型

验收：

- 旧路径 `history.loadConversations` 仍可工作
- 新路径能从现有 v2 文件读出 index / detail

## Phase 2：Renderer hydrate 切到 index-first

1. `conversationStore.hydrateFromDisk()`
   - 优先走 `loadConversationIndex`
   - 旧接口 fallback 保留
2. 轻量 conversations 注入 store
3. active conversation 自动恢复前，先按需读 detail

验收：

- 冷启动时不再把所有 conversations 完整塞进内存
- active conversation 仍能正常恢复

## Phase 3：Sidebar 打开会话切换到按需详情

1. `NavSidebar.handleLoadConversation()`
2. 已 full 的会话走旧逻辑
3. summary 会话先读 detail，再补 segment

验收：

- 打开旧会话仍能恢复 `mainDoc / todo / pendingArtifacts / projectDir`
- 未打开会话不会在后台被错误重写

---

## 10. 验证清单

## 10.1 冷启动 / 恢复

1. 准备 20+ 历史会话，其中至少 1 条是大对话
2. 重启桌面端
3. 验证：
   - 启动不再长时间卡在 hydrate
   - 侧边栏正常显示历史列表
   - 当前 active conversation 可自动恢复

## 10.2 会话切换

1. 点击一个本次启动后尚未打开过的旧会话
2. 验证：
   - 会话内容可恢复
   - projectDir 对应项目仍会切换
   - steps 仍由 segment 路径分页恢复

## 10.3 元数据修改不丢正文

1. 对未打开过的旧会话执行：
   - rename
   - pin
   - archive / unarchive
2. 重启应用
3. 再打开该会话
4. 验证历史正文仍在

## 10.4 兼容旧数据

1. 删除 `conversations.index.v2.json`
2. 保留 `conversations.v1.json`
3. 启动应用
4. 验证 fallback 仍可读

## 10.5 最近修复不回退

重点回归：

1. streaming / ctrl-c autosave
2. pending conversations 合并
3. waiting-user / resume
4. runtime items / turns / merge 语义

---

## 11. 回滚策略

本期所有接口均采用 **加法改造 + fallback**：

1. 保留 `history.loadConversations`
2. renderer 侧优先新接口，失败后回退旧接口
3. 若上线后发现 summary/full 混写问题，可临时关闭 index-first，回退到旧 hydrate 逻辑

---

## 12. 后续 Phase（本 spec 不实现）

## Phase 2：项目树 Tree-First

后续单开 spec 处理：

- `loadProjectFromDisk()` 只 hydrate 文件树
- 文件内容统一走 `ensureLoaded()`

原因：

- `projectStore` 调用面明显比会话历史更广
- 和本期一起改，回归风险偏高

---

## 13. 最终决策

本期采用：

- **复用现有 `conversations.index.v2.json`**
- **新增 `loadConversationIndex + readConversationSnapshot`**
- **renderer 改成 index-first**
- **saveConversationsV2 改成“索引全写、详情按 full 写”**

不采用：

- 继续只做 snapshot 瘦身
- 启动阶段继续全量 `loadConversations`
- 本期顺手重构 projectStore

这是当前风险最低、又能真正切断 OOM 主因的收敛方案。
