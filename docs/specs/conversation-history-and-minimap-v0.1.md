# 对话历史存储 + 滚动加载 + 迷你地图方案 v0.1

> 目标：在不牺牲「打开就是对话」范式的前提下，  
> 让超长对话既**不会再把桌面端撑爆**，又能通过「迷你地图」一眼看清线程结构。

## 0. 现状小结（基线）

- 存储结构
  - 单文件：`userData/ohmycrab-data/conversations.v1.json`
  - 结构：`{ version, updatedAt, conversations: Conversation[], draftSnapshot, activeConvId }`
  - 每个 `Conversation.snapshot` 是一个完整 `RunSnapshot`，包含：
    - 全量 `steps`（user/assistant/tool）
    - `logs`
    - `mainDoc / todoList / kbAttachedLibraryIds / ctxRefs / pendingArtifacts`
    - 模式/摘要：`mode / model / opMode / dialogueSummary*`
- 已做的“止血”改动（本方案视为 Phase 0）
  - **历史快照瘦身**
    - 对 `ToolBlockStep` 的 `input/output` 做字符串截断：
      - `stdout/stderr`：最多约 4000 字符
      - 其他字符串字段：最多约 800 字符
    - `LogEntry`：
      - 最多保留最近 80 条
      - 每条 `message` 最多 400 字符
    - 去掉历史里不必要的超大字段（例如 user step 的 `baseline`）
  - **读盘时自动瘦身**
    - `hydrateFromDisk` 会在将历史载入内存前，对 `snapshot` 跑一遍瘦身逻辑，再写回磁盘。
  - **对话数量上限**
    - `capConversations`：非置顶会话最多保留 20 条；置顶全部保留。

> 结论：在这个基线下，即使用得比较猛，也很难再因为单个 JSON 超大而把 Electron 顶到 OOM/abort。  
> 但问题仍然存在：
> - 所有步骤仍然集中在一个文件里，长线使用会越来越胖；
> - ChatArea 一次性加载全部 `steps`，超长对话渲染成本高；
> - 没有“全局视角”，看不到这条线程整体结构（适合做迷你地图的基础尚未抽象出来）。

后续改造从这里出发，分 Phase 做完三件事：
1. 存储从“单大 JSON”演化为「索引 + 多文件」；
2. ChatArea 支持滚动加载/按段 hydration；
3. 在此基础上叠加对话迷你地图。

---

## 1. 总体设计：索引 + 多文件 + 滚动窗口

### 1.1 设计原则

- **历史只做入口 &索引，不当运行时缓存**
  - 借鉴 Codex：历史文件的职责是“记录发生了什么”，而不是存一份完整的运行时快照。
  - 运行时需要的结构（`RunSnapshot`）可以随时由历史重建，必要时只保留最近一段。
- **持久化分层**
  - 顶层索引文件：轻量 + 小；用于列表展示 & 最近 N 条预览；
  - 每个会话独立存储文件：承载完整步骤/metadata，按需加载。
- **运行时滚动窗口**
  - `runStore` 内只保留“当前窗口”中的 steps（最近 N 条 + 用户当前可见部分），而不是整条历史。
  - 往上滚动时，通过 IPC 向主进程请求更早的一段 steps，逐段填充。
- **渐进演进**
  - 保持 `history.saveConversations / loadConversations` API 向后兼容；
  - 利用版本字段区分 `v1`（单文件）与 `v2`（索引 + 多文件），按需迁移。

### 1.2 目标产物

- 新的索引文件（示例命名）：
  - `userData/ohmycrab-data/conversations.index.v2.json`
- 每个会话的独立文件：
  - `userData/ohmycrab-data/conversations/conv_<id>.json` 或 `.jsonl`
- Electron 主进程历史 API 扩展：
  - 在现有 `history.load/save*` 基础上，增加按会话加载/保存片段的能力（新 handler，不破坏旧接口）。
- 前端：
  - `conversationStore` & `runStore` 支持加载「部分 steps」的 snapshot；
  - ChatArea 支持滚动加载；
  - 右上角迷你地��组件（MiniMap），可视化整条 thread 的结构和当前 viewport。

---

## 2. Phase 1 — 存储结构：索引 + 多文件（不动 UI）

> 目标：把“单大 JSON”重构为「轻量索引 + per-conv 文件」，  
> 在完全不改变 UI 行为的前提下，为后续滚动加载/迷你地图打基础。

### 2.1 数据结构设计

#### 2.1.1 会话索引文件（Index）

建议路径（可调）：  
`userData/ohmycrab-data/conversations.index.v2.json`

示例结构：

```ts
type ConversationIndexEntry = {
  id: string;
  title: string;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  // 最近一条消息的摘要（用于列表预览）
  lastMessagePreview?: {
    type: "user" | "assistant";
    text: string;
    ts: number;
  } | null;
  // 最近 N 条 step 的简要元数据（类型/是否工具等，可选）
  recentStepsMeta?: Array<{
    id: string;
    type: "user" | "assistant" | "tool";
    toolName?: string;
    hasError?: boolean;
    ts?: number;
  }>;
};

type ConversationIndexV2 = {
  version: 2;
  updatedAt: number;
  conversations: ConversationIndexEntry[];
  activeConvId: string | null;
};
```

说明：
- `recentStepsMeta` 仅用于列表 hover/未来 Hover Card 之类的小预览，可选，后续迷你地图也可参考。
- 索引文件不再承载完整 snapshot，只存轻量信息。

#### 2.1.2 会话详细文件（Per-conversation）

建议路径：  
`userData/ohmycrab-data/conversations/conv_<id>.json`（先用 JSON，后续有需要再演进 JSONL）

示例结构（延续 RunSnapshot，但允许“分段”）：

```ts
type ConversationFileV2 = {
  version: 2;
  conversationId: string;
  // 全局级别的 snapshot 头部：主文档、todo、上下文、模式等
  head: {
    mode: Mode;
    model: string;
    opMode?: OpMode;
    mainDoc: MainDoc;
    todoList: TodoItem[];
    kbAttachedLibraryIds: string[];
    ctxRefs?: CtxRefItem[];
    pendingArtifacts?: PendingArtifact[];
    dialogueSummaryByMode?: Record<Mode, string>;
    dialogueSummaryTurnCursorByMode?: Record<Mode, number>;
  };
  // 完整 steps 列表（已瘦身），按时间顺序
  steps: SerializableStep[];
  logs: LogEntry[]; // 可选：只保存重要日志/最近一段
};
```

Phase 1 的目标是：  
> **先把现有的 “完整 RunSnapshot” 分流到 per-conv 文件里，  
> 但仍然一次性加载全部 steps 到前端，不引入滚动窗口。**

也就是说，这一阶段只是换“磁盘布局”，前端照旧。

### 2.2 迁移策略（v1 → v2）

1. 检测
   - 启动时，主进程检查：
     - 是否存在 `conversations.v1.json`
     - 是否存在 `conversations.index.v2.json`
2. 冷启动迁移流程（仅当 v2 不存在时触发）
   - 从 `conversations.v1.json` 读出所有 `Conversation`（已被瘦身逻辑处理过，体积可控）。
   - 对每个 `Conversation`：
     - 生成对应的 `ConversationFileV2` 并写入 `conv_<id>.json`。
     - 从 snapshot 里抽取 head 信息和 lastMessagePreview/recentStepsMeta，写入索引 entry。
   - 写出新的 `conversations.index.v2.json`。
   - 旧的 `conversations.v1.json`：
     - 保留为备份（例如 `conversations.v1.legacy.json`），
     - 或在数次成功启动后再提示用户手动清理。
3. 运行时读写策略
   - `history.loadConversations`：
     - 如果检测到 v2：
       - 只从索引文件返回 `conversations`（不含 steps）、`activeConvId`；
       - `draftSnapshot` 可以单独放到一个 `draft.json` 文件里，或继续存回索引。
   - `history.saveConversations`：
     - 写索引文件时：
       - 只更新 `ConversationIndexEntry` 数组（title/pinned/archived/updatedAt/预览）；
     - 每个会话的最新 snapshot（步骤/头部）写入对应的 `conv_<id>.json`。

### 2.3 难点 & 风险点（Phase 1）

1. **迁移过程的原子性 & 崩溃风险**
   - 风险：
     - 迁移过程中崩溃，可能出现「v1 已删 / v2 未写完」的尴尬状态。
   - 方案：
     - 整个迁移在一个新的 handler 中完成，核心步骤：
       1. 始终保留原始 `conversations.v1.json`，迁移期间不删除；
       2. 先写 `conv_<id>.json.tmp`，写完再 `rename`；
       3. 索引文件也先写 `.tmp`，最后一次性覆盖；
       4. 启动时逻辑：
          - 若存在有效 v2，优先使用；
          - 若 v2 不完整（索引损坏或 conv 文件缺失），可回退到 v1 重新迁移。

2. **前后端 API 兼容**
   - 风险：
     - 当前 `conversationStore.hydrateFromDisk` 依赖 `loadConversations` 返回完整 `conversations` + `draftSnapshot`。
   - 方案：
     - Phase 1 保持 `loadConversations` 形态不变（继续返回完整结构），
     - 只是内部实现从 per-conv 文件重建 `Conversation`：
       - 先读索引 entry；
       - 再读 `conv_<id>.json` 填上 snapshot 字段；
     - 这样 React 侧完全无感，迁移可以渐进 rollout。

3. **磁盘体积短期内会上升一小截**
   - 风险：
     - 迁移期间 v1 + v2 并存，短期多占一些空间。
   - 方案：
     - 通过 debug 文档提示用户可在确认迁移稳定后手动清理 v1 旧文件；
     - 或在将来追加一个“历史压缩/清理”工具/菜单项。

---

## 3. Phase 2 — 滚动加载：前端只持有窗口内 steps

> 目标：让 ChatArea 不再一次性把整个会话 steps 全塞进内存，  
> 保留一个“滚动窗口”，往上滚动时按需加载老步骤。

### 3.1 运行时模型调整（runStore）

当前 `RunState`：

```ts
steps: Step[];
```

建议演进为：

```ts
steps: Step[]; // 当前窗口内的完整 Step 对象（用于 UI 渲染）

// 可选：帮助判断是否还有更多历史可加载
historyWindow?: {
  hasMoreBefore: boolean;
  // 首条 step 在整个会话中的索引（可选）
  startIndex?: number;
};
```

> 注意：**第一阶段可以不暴露 startIndex，只判断有/无更多即可**，实现更简单。

### 3.2 新增历史分段加载 API（主进程）

在 Electron `main.cjs` 中，为 history 增加一个新的 handler（不破坏旧接口）：

```ts
ipcMain.handle("history.loadConversationSegment", async (_event, params) => {
  // params: { conversationId, beforeStepId?: string, limit?: number }
  // 返回：{ ok, steps, hasMoreBefore }
});
```

语义：
- 如果 `beforeStepId` 为空：
  - 返回从“末尾往前”的最近 `limit` 条 steps（默认可设为 50）。
- 如果有 `beforeStepId`：
  - 在 per-conv 文件中找到该 step 的位置，
  - 往前取 `limit` 条 steps，返回给前端。
- `hasMoreBefore`：
  - 用于前端判断是否还要继续显示“加载更多消息”入口。

由于 per-conv 文件中已经有完整 `steps` 数组（Phase 1），  
Phase 2 的分段加载可以先简单实现为「基于数组的切片」，不必一上来就做真正的 JSONL 流式读取。

### 3.3 ChatArea / conversationStore 行为调整

1. 初始加载
   - 进入某个会话时，当前行为：`loadSnapshot` 把整个 `steps` 塞进 `runStore`。
   - 调整为：
     - 先通过 `history.loadConversationSegment` 拉取“末尾 N 条”，
     - 用这些 steps 初始化 `runStore.steps`，
     - `historyWindow.hasMoreBefore` 根据返回值设置。

2. 滚动加载
   - 在 ChatArea 的 `onScroll` 中：
     - 当用户向上滚动、接近顶部时（比如距离顶部 < 200px 且 `hasMoreBefore === true`），
       - 触发一次 `history.loadConversationSegment`，
       - 请求 `beforeStepId = 当前 steps[0].id`，limit=N，
       - 把返回的 steps prepend 到 `runStore.steps` 前面。
   - 为避免重复请求：
     - 设置简单的节流/防重入标记（例如 `isLoadingMoreHistory`）。

3. 与 snapshot / draftSnapshot 的关系
   - 在 Phase 2 中，**继续向磁盘保存完整 snapshot**（per-conv 文件仍是全量 steps）：
     - 方便兼容已有逻辑，也方便后续迁移/回滚。
   - 当用户发送新消息或工具调用结束时：
     - 只需 append 最新 steps 到内存窗口，并调用现有持久化逻辑更新 per-conv 文件；
     - 不用每次都重新从 per-conv 文件重建 steps。

### 3.4 难点 & 风险点（Phase 2）

1. **部分 steps vs 完整 snapshot 的语义冲突**
   - 风险：
     - 目前代码默认认为 `snapshot.steps` 是“完整历史”；引入窗口后，某些使用场景需要知道“现在是不是全量”。
   - 方案：
     - 引入 `historyWindow.hasMoreBefore` 做显式标记；
     - 所有需要“完整历史”的逻辑（例如：某些 debug 功能）要么：
       - 明确注释“只对当前窗口生效”，
       - 要么在使用前主动拉满历史（仅用于 debug）。

2. **滚动与加载的时机控制**
   - 风险：
     - 滚动得过快、网络/磁盘抖动时，可能出现多次重复请求或闪烁。
   - 方案：
     - 在 ChatArea 中为“加载更多”加一个简单的节流：
       - 每次加载完成前不再发起新的请求；
       - 错误时重置状态 + 提供“点击重试”入口（可以是一个小按钮）。

3. **与未来虚拟列表/性能优化的耦合**
   - 风险：
     - 如果未来引入 `react-window` 这类虚拟列表，滚动加载的实现细节会有所变化。
   - 方案：
     - Phase 2 先用“纯粹 prepend + DOM 自适应高度”的简单实现；
     - 把未来虚拟列表视为 Phase 2.5/独立优化，不影响整体协议设计。

---

## 4. Phase 3 — 迷你地图 v1：基于已加载 steps 的局部视图

> 目标：在不引入额外数据结构的前提下，  
> 先做一个“局部 minimap”，帮助用户在当前窗口内快速定位消息区域。

> 注意：这一期的迷你地图只依赖“当前窗口的 steps”，  
> 不要求覆盖整条线程，仅作为 Phase 4 的 UI 骨架和交互预演。

### 4.1 UI 行为

- 位置：
  - ChatArea 右上角贴边，一个窄窄的纵向条（类似 VS Code minimap）。
- 表现：
  - 当前窗口内的每个 step 映射为一小段色块：
    - user / assistant / tool 不同色；
    - 特殊 tool（如 `shell.exec` / `process.run`）可用突出色；
  - 当前 viewport 区域在 minimap 上用一个半透明高亮框标记。
- 交互：
  - 点击 minimap 的某一点：
    - 把点击的位置映射到 steps 中的一个大致 index，
    - 滚动 ChatArea 使该 step 落在视口中部。

### 4.2 数据来源

- 仅使用 `runStore.steps`（当前窗口）：
  - 降低首次实现复杂度；
  - 在「已经有滚动加载」的基础上，这个 minimap 自动随着用户滚动/加载更多而成长。

### 4.3 难点 & 风险点（Phase 3）

1. **视口与 minimap 的映射精度**
   - 风险：
     - step 的实际高度不等（长消息/短消息），简单按“均分”来算位置可能偏差较大。
   - 方案（v1）：
     - 先用“均分”近似：每个 step 视为相同高度；
     - 只保证点击/高亮区域大致对得上消息区，用户可以再微调滚轮/触控板；
     - 把“高度感知 + 更精确映射”留到 Phase 4。

2. **性能**
   - 风险：
     - steps 很多时（例如窗口内 200+ 条），minimap 更新太频繁会卡。
   - 方案：
     - minimap 渲染本身很轻（几十/几百个小 div），但仍然：
       - 使用 `useMemo` 缓存 map 结果；
       - 滚动时通过 `requestAnimationFrame` 或简单节流更新高亮框位置。

> Phase 3 的核心是：**先把 minimap 的组件结构和交互打通，  
> 不追求“全局视角”，而是预演未来完整 minimap 需要的接口。**

---

## 5. Phase 4 — 迷你地图 v2：全局视图 + 与滚动加载/未加载区域的协同

> 目标：让迷你地图真正成为「一眼看清整条对话」的全局视图，  
> 并与“滚动加载 + 多文件存储”协同工作。

### 5.1 全局 minimap 数据结构

在已有 per-conv 文件基础上，新增一个轻量的 “step meta 列表” 缓存（也可放在 conv 文件里）：

```ts
type StepMiniMeta = {
  id: string;
  type: "user" | "assistant" | "tool";
  toolName?: string;
  hasError?: boolean;
  isShellExec?: boolean;
  isBackgroundProcess?: boolean;
  // 可选：用于估算高度，可按 type + 字符数粗略估计
  sizeHint?: number;
};
```

这一列表可以：
- 在写入 per-conv 文件时同步维护（snapshot → meta）；或
- 单独维护一个 `conv_<id>.meta.json`，仅在需要全局 minimap 时读取。

minimap 渲染就不再依赖“当前窗口 steps”，而是基于完整 `StepMiniMeta[]`。

### 5.2 未加载区域的表示

**难点 1：如何在 minimap 上标记“还没加载到内存”的区域？**

- 风险：
  - 用户点击 minimap 未加载区域，如果 ChatArea 不能立刻跳到对应消息，会出现 UX 断裂。
- 方案：
  - 引入三类区域：
    1. **已加载且可见的 steps**：高亮 + 可滚动；
    2. **已加载但在当前窗口之外的 steps**：普通色块；
    3. **未加载的历史区域**：略带条纹/浅灰色，表示“存在，但需要加载”。
  - 当用户点击到“未加载区域”时：
    - 计算一个 target index（例如按总步数比例粗略估算）；
    - 调用新的 IPC（例如 `history.loadConversationAroundIndex`）在该位置附近加载一段 steps；
    - 然后更新 `runStore.steps` 窗口 + ChatArea scroll。

### 5.3 与滚动加载的协同

**难点 2：滚动加载与 minimap 的同步更新**

- 风险：
  - 频繁加载/卸载窗口内 steps 时，minimap 高亮区域与实际 viewport 不一致。
- 方案：
  - 把 minimap 的“可见范围”计算基于：
    - `historyWindow.startIndex`（窗口内第一条 step 在全局 meta 里的 index）
    - `steps.length`（窗口大小）
  - 大致映射关系：

    ```text
    全局 step 数: M
    窗口起始 index: s
    窗口长度: k

    minimap 高亮起点 = (s / M) * minimapHeight
    minimap 高亮高度 ≈ (k / M) * minimapHeight
    ```

  - 滚动/加载更多时：
    - 更新 `historyWindow.startIndex` 和 `hasMoreBefore`；
    - minimap 通过 `useEffect`/`useMemo` 更新高亮框。

### 5.4 风险汇总（Phase 4）与解法

1. **高度估算不准**
   - 短期可接受“近似比例”；
   - 如果需要更准，可以引入：
     - 简单 `sizeHint`（按字符数分档），
     - 再根据已渲染区域的真实 scrollHeight 做动态校正（可选）。

2. **API 复杂度上升**
   - 新增/扩展 IPC：
     - `history.loadConversationSegment`（按 stepId/索引加载前一段/后一段）
     - （可选）`history.loadConversationAroundIndex`（为 minimap 点击服务）
   - 建议：
     - 统一在文档中画出「前端 -> 主进程」的数据流，
     - 把 load API 收束为 1~2 个通用 handler，参数控制模式。

---

## 6. Phase 分工建议 & 开工顺序

按风险和依赖关系，推荐顺序：

1. **Phase 1：存储结构重构（索引 + 多文件）**
   - 仅动 Electron main + history API 内部实现；
   - 前端 `conversationStore` / `runStore` 暂时不改，继续一次性加载；
   - 完成后历史文件体积更稳定，可为后续滚动加载/迷你地图打基础。

2. **Phase 2：滚动加载**
   - 在保持当前 UI 行为不变的前提下，实现“页面顶部加载更多”的最小版；
   - 先不引入 minimap，只在 ChatArea 中做分段 hydration；
   - 整体风险主要在滚动时机和状态管理，可通过简单节流 + debug 日志控制。

3. **Phase 3：迷你地图 v1（窗口级）**
   - 只依赖 `runStore.steps` 的局部 minimap；
   - 作为后续全局 minimap 的 UI 骨架和交互预演；
   - 实现成本低，可以按 Feature Flag 控制上线范围。

4. **Phase 4：迷你地图 v2（全局视图）**
   - 扩展 per-conv 文件/额外 meta 文件，支持全局 `StepMiniMeta`；
   - 完善 minimap 与滚动加载/未加载区域的协同；
   - 如果需要，再考虑与虚拟列表结合优化性能。

> 建议：本方案可以作为「历史存储 & 迷你地图 v0.1」的对外设计文档。  
> 接下来可以在此基础上拆任务卡/PR（Phase1/2/3/4），  
> 每个 Phase 都有清晰的 Done 条件和回滚策略，方便渐进落地。 

