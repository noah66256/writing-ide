# Desktop History + Project Loading Guardrails（v0.1）

> 目标：在 **不改 Gateway 合同**、**不推翻最近几轮 runtime/恢复修复**、**尽量不引入新问题** 的前提下，切断 Desktop 侧两条已确认的 eager load 主链：
> 1. 会话历史启动即全量 hydrate
> 2. 项目打开 / `fs.watch` 刷新即全量读正文

---

## 1. 目标

本期只做 **Desktop 侧保守收口**，把当前“越用越容易爆”的加载范式改成：

1. **会话列表轻量加载**
2. **当前会话按需恢复**
3. **项目树先展示，文件正文按需读取**
4. **`fs.watch` 走路径级增量刷新**
5. **tmp / recovery 从热路径拆出去**

成功标准：

- 启动时不再把所有历史会话完整载入 renderer。
- 打开项目时不再把项目下所有文本正文一次性读入 `projectStore`。
- 跑任务时，`fs.watch` 不再触发整项目全文重读。
- 保留最近几轮修复过的：
  - `runtime items / turns / merge` 语义
  - active conversation 恢复
  - `draftSnapshot` / `pending conversations`
  - dirty 文件“本地优先”行为

---

## 2. 背景与根因摘要

根据最新 `Bug Forensics Brief` 与本机数据实查，本次 OOM / 崩溃的首因已经基本坐实：

### 2.1 会话历史链

- `conversationStore.hydrateFromDisk()` 启动即 `history.loadConversations()`
- `history.loadConversations()` 仍会：
  - 读完整 `conversations.v1.json`
  - 读 `bak/legacy`
  - 扫描并尝试解析大量 `conversations*.tmp`
- renderer 再对完整 conversations 做 repair/slim
- `ConversationLayout` 的 `loadConversationSegment` 只是 **full hydrate 之后** 的补充恢复

结果：

- 启动/恢复本身就要吞完整大历史；
- 目录里的大 tmp 还会把下一次启动继续放大。

### 2.2 项目加载链

- `loadProjectFromDisk(rootDir)` 打开项目时会对所有文本文件逐个 `readFile`
- `App.tsx` 收到 `project.fsEvent` 后直接 `refreshFromDisk("fs.watch")`
- `refreshFromDisk()` 又会对整项目文本文件再做一轮 `readFile`

结果：

- “选项目 + 跑任务”天然叠加两条大内存路径；
- 任务写文件越频繁，整项目全文重读越频繁。

### 2.3 高频 whole-snapshot clone/save

- `ChatArea` 每 2 秒 autosave
- `InputBar` / `NavSidebar` / `runTarget` 也会调 `buildCurrentSnapshot()`
- `buildCurrentSnapshot()` 仍对 `thread / turns / items / collabSessions` 做深拷贝

结果：

- 即使不重启，长任务运行中也会持续放大内存和序列化负担。

---

## 3. 一手输入与对照组

## 3.1 本仓已落盘文档

- `docs/research/desktop-oom-and-adjacent-frontend-risk-bug-forensics-2026-03-21.md`
- `docs/research/codex-desktop-history-loading-parity-2026-03-20.md`
- `docs/research/electron-macos-background-crash-triage-2026-03-20.md`
- `docs/specs/desktop-history-index-first-loading-v0.1.md`

## 3.2 本地一手源码参考

- `third_party/openai-codex/codex-rs/app-server/README.md`
- `third_party/openai-codex/codex-rs/tui_app_server/src/lib.rs`
- `third_party/openai-codex/docs/tui-chat-composer.md`

关键结论：

1. Codex 公开实现是 **列表轻 / 当前会话重**
2. `thread/read(includeTurns=false)` 是正常热路径
3. persistent history 明确 **text-only / lightweight**

## 3.3 已存在、必须复用的本项目能力

1. `saveConversationsV2()` 已在写：
   - `conversations.index.v2.json`
   - `conversations/conv_<id>.json`
2. `history.loadConversationSegment` 已存在
3. `projectStore.ensureLoaded(path)` 已存在
4. `project.fsEvent` 事件已带 `paths[]`

这意味着：

- 我们不需要从零造新范式；
- 只需要把现有能力从“补充路径”升级为“主路径”。

---

## 4. 范围与非目标

## 4.1 本期范围（P0）

1. 会话历史切为 `index-first + active on-demand`
2. 项目打开切为 `tree-first + file-lazy`
3. `fs.watch` 刷新切为 `path-based incremental refresh`
4. tmp / recovery 从正常热路径拆出
5. 保存链保证不会因“未加载会话”把已有 per-conv 详情写坏

## 4.2 本期明确不做

1. 不改 Gateway
2. 不改 provider / Responses / runtime 主合同
3. 不把 ChatArea 虚拟列表 / 窗口化并入 P0
4. 不重写 `threadProjection`
5. 不直接推翻现有 `pending conversations` 兜底机制

## 4.3 后续 Phase（先挂账，不在 P0 一起做）

1. runtime item / `read.result.content` 的长期持久化合同收口
2. whole-snapshot save 的进一步增量化
3. ChatArea 超长对话的窗口化 / 虚拟化
4. 项目索引链的进一步增量化

---

## 5. 设计原则

1. **列表轻、详情重**
   - 启动阶段只拿会话列表元数据
   - 只有 active conversation 才恢复完整 snapshot / steps

2. **树轻、正文懒**
   - 打开项目先拿树
   - 文件正文仅在真正打开/预览时读取

3. **recovery 是旁路，不是热路径**
   - `.tmp/.bak/legacy` 只在主路径缺失或明确损坏时参与恢复
   - 正常启动不扫一堆大 tmp

4. **恢复正确性优先于“极限瘦身”**
   - 不因为减内存把 `proposal/undo/waiting-user/runtime turns` 修坏

5. **尽量复用现有数据结构**
   - 优先在现有 IPC、现有 store 字段上做最小扩展
   - 不做一次性大翻修

---

## 6. 方案概览

## 6.1 会话历史：从 `loadConversations` 切到 `loadConversationIndex + readConversationSnapshot`

### 新主路径

启动阶段：

1. `conversationStore.hydrateFromDisk()`
2. 优先调 `history.loadConversationIndex()`
3. 仅返回：
   - 轻量 conversations metadata
   - `activeConvId`
   - `draftSnapshot`
   - `draftSnapshotOwnerId`
4. `conversations[]` 进入 store 时标记为 **未加载详情**

进入某条会话时：

1. 先读该条会话的轻量 metadata
2. 再调 `history.readConversationSnapshot(conversationId, { includeSteps:false })`
3. 最后用 `history.loadConversationSegment()` 拉首屏 steps

### 保留旧接口，但降级为 fallback

- `history.loadConversations`
  - 保留给旧数据/旧版本 fallback
  - 不再作为正常热路径主入口

### 需要新增的最小 IPC

#### A. `history.loadConversationIndex`

职责：

- 只返回 index，不返回完整 per-conv snapshot

建议返回：

```ts
{
  ok: true,
  conversations: Array<{
    id: string;
    title: string;
    pinned?: boolean;
    archived?: boolean;
    createdAt: number;
    updatedAt: number;
    lastMessagePreview?: { type: "user" | "assistant"; text: string; ts?: number } | null;
    recentStepsMeta?: Array<{ id: string; type: "user" | "assistant" | "tool"; toolName?: string; hasError?: boolean }>;
  }>;
  activeConvId?: string | null;
  draftSnapshot?: RunSnapshot | null;
  draftSnapshotOwnerId?: string | null;
  used?: string;
  file?: string | null;
}
```

#### B. `history.readConversationSnapshot`

职责：

- 按需读取单条会话 head/runtime 详情
- steps 仍优先由 `loadConversationSegment` 负责

建议入参：

```ts
{
  conversationId: string;
  includeSteps?: boolean; // 默认 false
}
```

### store 最小扩展

为避免大范围重构，`Conversation` 结构不必推翻，但要补一个最小状态位：

```ts
type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  snapshot: RunSnapshot | null;
  pinned?: boolean;
  archived?: boolean;
  snapshotLoaded?: boolean; // 新增
}
```

语义：

- `snapshotLoaded=false`：该条会话当前只有轻量元数据，不能拿它去覆盖 per-conv 真详情
- `snapshotLoaded=true`：该条会话详情已真正加载过，允许走当前保存路径

### 保存链约束

这是本 spec 的关键约束：

- **index-only hydrate 后，未加载会话绝不能被当成“空 snapshot”写回磁盘。**

因此需要：

1. `schedulePersistToDisk()` 写 index 时可以覆盖所有会话 metadata
2. 写 per-conv 文件时只写：
   - `snapshotLoaded=true` 的会话
   - 或本轮真正被修改过的 active conversation
3. 若某条会话当前未加载详情，则：
   - 更新其 `title/pinned/archived/updatedAt`
   - 不覆盖原 `conv_<id>.json`

---

## 6.2 项目加载：从 `loadProjectFromDisk = 全文全读` 切到 `tree-first + ensureLoaded`

### 新主路径

打开项目时：

1. `project.listEntries(rootDir)` 读取文件/目录树
2. `projectStore.files` 先只放文件占位：

```ts
{
  path: string;
  content: "";
  loaded: false;
  dirty: false;
}
```

3. UI 展示项目树与 tab
4. 用户真正打开/预览文件时，再通过 `ensureLoaded(path)` 读取正文

### 可接受的轻量首屏策略

为避免打开项目后一片空白，本期允许只做一个轻量特例：

- 如果存在 `README.md` 或当前 activePath 对应文件，则首屏只预读 **这一份** 文件；
- 其余文件仍保持 `loaded:false`。

### 为什么这是保守方案

- `ensureLoaded(path)` 已经存在，不需要重做能力；
- 只是把它从“补充能力”提到“默认能力”；
- dirty/undo/rename 等逻辑可以继续沿用。

---

## 6.3 `fs.watch`：从整项目 `refreshFromDisk` 切到路径级增量刷新

### 当前事实

主进程已经发送：

```ts
{
  rootDir,
  paths: string[],
  ts: number
}
```

因此 renderer **已经拿到了受影响路径列表**，不需要继续用“整项目刷新”这种保守但昂贵的旧策略。

### 新目标

`App.tsx` 收到 `project.fsEvent` 后：

1. 把 `paths[]` 传给 `projectStore.refreshFromDisk(paths, reason)`
2. `refreshFromDisk` 只处理受影响路径：
   - 新增文件：只为新增 path 建占位
   - 修改文件：
     - 若 `dirty=true`，保留本地版本
     - 否则只重读该 path
   - 删除文件：只移除该 path，并维护 open tab / activePath
   - 目录变动：仅在必要时补一轮树级刷新

### fallback 策略

以下情况允许回退 full refresh：

1. `paths` 缺失
2. 主进程事件类型不可靠
3. 检测到目录级 rename / 大范围删除

但这个 fallback 只能是 **异常路径**，不能继续当日常主路径。

---

## 6.4 tmp / recovery：从热路径拆出

### 当前问题

- 正常 `history.loadConversations()` 也会去扫描 `.tmp`
- 本机目录里大量大 tmp 会直接把启动恢复放大

### 新规则

正常热路径：

1. 先读 `conversations.index.v2.json`
2. 不读 `.tmp`
3. 只有 index/per-conv 不存在、主文件损坏、或明确检测到主路径截断时，才进入 recovery 分支

### 建议补一条启动前 cleanup

在主进程启动或首次 history 读取前，做一次 **过期 tmp 最佳努力清理**：

- 只清理超过 `HISTORY_TMP_FILE_MAX_AGE_MS` 的文件
- 不因为 cleanup 失败阻塞正常启动

这样可以把“历史遗留 tmp 把下一次启动继续放大”的问题切掉一半。

---

## 6.5 runtime 保存热路径：本期先“止频”，不一次性重写

本期不强行把 `buildCurrentSnapshot()` 全改成增量模型，但要明确两条保守约束：

1. **autosave 不再成为全局 whole-snapshot 热环**
   - 只在 active conversation / draft 真正脏时触发
   - 不因轻量 UI 状态抖动反复重建完整 snapshot

2. **active conversation 之外的会话不参与大对象重建**
   - 未加载会话只更新 index 元数据
   - 已加载但非当前活跃的会话，除非显式修改，否则不在 autosave 中重写

> 说明：`read.result.content` / runtime item 去重 / artifact pointer 是后续 Phase，需要单独定持久化合同；本期 spec 不把它硬并入 P0，以免恢复语义被一起改坏。

---

## 7. 分阶段交付建议

## Phase 1：History index-first（必须先落）

1. 新增 `history.loadConversationIndex`
2. 新增 `history.readConversationSnapshot`
3. `hydrateFromDisk()` 改走 index-first
4. `ConversationLayout` 在 active conversation 上按需拉 snapshot + segment
5. 保存链避免覆盖未加载会话详情

### 验收

- 重历史启动不再全量 hydrate 全会话
- active conversation 恢复仍正确

## Phase 2：Project tree-first + path-based refresh（紧跟）

1. `loadProjectFromDisk()` 改为树优先
2. `ensureLoaded(path)` 成为正文读取主入口
3. `project.fsEvent` 改传入路径级刷新
4. 目录级异常变更才 fallback 到 full refresh

### 验收

- 打开大项目时内存峰值明显下降
- 任务写文件期间不再整项目全文重读

## Phase 3：Hot-path guardrails（后续）

1. autosave 频率 / 触发条件再收口
2. `read.result.content` 等大 payload 的持久化合同收口
3. ChatArea 长会话窗口化另开 spec

---

## 7.1 实施状态（2026-03-21）

> 当前已完成 **Phase 1：History index-first + active on-demand**、**Phase 2：Desktop 项目加载主链**，以及 **启动期过期 tmp cleanup 前移**。  
> `read.result.content` 持久化合同与 ChatArea 长会话窗口化继续保持 **deferred**，不并入本轮 P0。

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| 启动改走 `loadConversationIndex` | `apps/desktop/electron/main.cjs` `ipcMain.handle("history.loadConversationIndex")`；`apps/desktop/src/state/conversationStore.ts` `hydrateFromDisk()` | 已完成 | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build` | 正常热路径优先读 `conversations.index.v2.json`，且 index 可用时不再并发触发 legacy `loadConversations()` |
| 单会话按需读取 snapshot | `apps/desktop/electron/main.cjs` `ipcMain.handle("history.readConversationSnapshot")`；`apps/desktop/src/state/conversationStore.ts` `loadConversationSnapshot()` | 已完成 | 同上 | 先读单条 head/runtime，再由 segment 拉首屏 steps |
| active conversation 恢复改按需加载 | `apps/desktop/src/ui/layouts/ConversationLayout.tsx` 恢复 effect；`apps/desktop/src/ui/components/NavSidebar.tsx` `handleLoadConversation()` | 已完成 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build` | 避免先 full hydrate 全量历史，再补 segment |
| 未加载会话禁止覆盖 per-conv 详情 | `apps/desktop/src/state/conversationStore.ts` `snapshotLoaded`；`apps/desktop/electron/main.cjs` `saveConversationsV2()` | 已完成 | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` | index-only 会话只更新 metadata，不重写已有 `conv_<id>.json` |
| 同步刷盘也写入 v2 | `apps/desktop/electron/main.cjs` `history.saveConversationsSync`；`saveConversationsV2Sync()` | 已完成 | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop build` | 避免 beforeunload 只写 v1、下次启动却优先信任旧 index |
| renderer/preload 类型合同补齐 | `apps/desktop/electron/preload.cjs`；`apps/desktop/src/vite-env.d.ts` | 已完成 | `node -c apps/desktop/electron/preload.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit` | 补齐 `history.loadConversationIndex` / `history.readConversationSnapshot` |
| 单条 v2 会话文件保留 `projectDir` | `apps/desktop/electron/main.cjs` `saveSingleConversationFileV2()` | 已完成 | `node -c apps/desktop/electron/main.cjs`；`npm run -w @ohmycrab/desktop build` | 避免 active 恢复时因缺目录信息退回旧路径 |
| 项目 `tree-first + ensureLoaded` | `apps/desktop/src/state/projectStore.ts` `loadProjectFromDisk()` / `ensureLoaded()` | 已完成 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build` | 打开项目仅扫描树，默认只预读 active/README 这一份，其余文件以 `loaded:false` 占位 |
| `fs.watch` 路径级增量刷新 | `apps/desktop/src/App.tsx` `onFsEvent`；`apps/desktop/src/state/projectStore.ts` `refreshFromDisk()` | 已完成 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build` | 主路径只对变更 path 读正文；无 path 或 `__all__` 时退回树级同步，但不再整项目逐文件 `readFile` |
| autosave 热路径止频 | `apps/desktop/src/ui/components/ChatArea.tsx` autosave effect / signature guards | 已完成 | `npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build`；浏览器 smoke | 只在 autosave 签名真正变化时才标脏；首次水化/切会话不再立即整快照回写 |
| 启动热路径 `tmp cleanup` 前移 | `apps/desktop/electron/main.cjs` `scheduleStartupHistoryTmpCleanup()`；`app.whenReady()` | 已完成 | `node -c apps/desktop/electron/main.cjs`；`npx tsc -p apps/desktop/tsconfig.json --noEmit`；`npm run -w @ohmycrab/desktop build`；浏览器 smoke | 启动迁移完成后后台触发一次过期 tmp 最佳努力清理；不 await、不阻塞正常恢复，保存后 cleanup 仍保留 |
| `read.result.content` 等大 payload 持久化合同收口 | - | 未开始 | - | 仍按 spec 延后，避免这轮把恢复合同一起改坏 |
| ChatArea 长会话窗口化 | - | 未开始 | - | 仍需单开 spec，不并入本轮 |

### 偏差说明

- 本轮没有改 Gateway，也没有改 runtime item / turns / merge 主合同。
- 本轮已把 **过期 tmp cleanup** 前移到启动期后台旁路任务；仍只清理超过 `HISTORY_TMP_FILE_MAX_AGE_MS` 的文件，不改变主恢复分支。
- Phase 3 本轮只落实了 **autosave 触发条件/频率守门**；`read.result.content` 与长会话窗口化继续延期。

---

## 8. 兼容性与回滚

## 8.1 兼容性要求

- 旧历史文件仍可读
- `v1` 主文件仍保留为 fallback
- `loadConversations` 仍保留兼容，不立即删除

## 8.2 回滚点

1. 若 `loadConversationIndex` 路径回归，可回退到旧 `loadConversations`
2. 若项目 lazy load 破坏编辑体验，可临时保留“只首屏预读 1 个文件”的折中方案
3. 若路径级刷新不稳定，可仅对目录级变更回退 full refresh

---

## 9. 风险与特别注意

本次改动的最大风险不是“代码不好写”，而是 **恢复语义回归**：

1. active conversation 恢复不完整
2. proposal / undo / waiting-user 状态丢失
3. 未加载会话被错误写成空 snapshot
4. dirty 文件与外部修改冲突处理退化

因此必须遵守：

- 先切热路径加载顺序，再逐步切持久化合同
- 不要在同一批改动里顺手重写 runtime item 持久化
- 不要为了减内存把恢复语义一起打散

---

## 10. 验证清单

1. 启动带重历史数据的 Desktop：
   - 只加载会话列表
   - 不再把全部会话 snapshot 送进 renderer
2. 进入 heavy conversation：
   - 只加载该条详情
   - `loadConversationSegment` 正常恢复首屏历史
3. 打开大项目：
   - 首屏先出树
   - 非当前文件不读正文
4. 任务运行写文件时：
   - `project.fsEvent` 只刷新受影响路径
   - 不再整项目 reread
5. 现有恢复能力验证：
   - `runtime items / turns / merge`
   - `draftSnapshot`
   - `pending conversations`
   - dirty 文件保护
6. tmp 验证：
   - 过期 tmp 会被最佳努力清理
   - 正常启动不再因 tmp 进入大规模 parse

---

## 11. 与现有历史 spec 的关系

本 spec **不替代** `docs/specs/desktop-history-index-first-loading-v0.1.md`，而是把它升级成更完整的 Desktop P0：

- 继承原 spec 的 history index-first 方向
- 补上本次 bug forensics 已确认同样危险的 project eager load 链
- 明确把 tmp/recovery 从热路径拆出

如果后续实现希望拆小 patch，建议按以下顺序：

1. 先落 `desktop-history-index-first-loading-v0.1`
2. 再按本 spec 的 `Phase 2` 收项目 lazy load
3. 最后单开 runtime persistence / ChatArea virtualization
