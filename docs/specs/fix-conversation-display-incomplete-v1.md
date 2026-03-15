# 修复会话恢复显示为欢迎页 + 历史内容截断

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

### 现象 A：重启 dev 后活跃会话显示为空白欢迎页

用户重启 `npm run dev` 后，上一次活跃的会话在右侧显示空白欢迎页（WelcomePage），而不是之前的对话内容。但点击侧边栏另一个会话标签，再切回来，内容就正常出现了。

用户原话："打开新dev后，我们之前那个session，它还是欢迎页面，但点别的session再切回来，它就有了"

### 现象 B：恢复后的会话内容显示不全

恢复后的会话内容被裁掉，只保留最近几轮。Agent 模式下，3 个 run 之前的内容完全不可见。

用户原话："随之来的第二个问题，它显示不全，就是以前的它会裁掉，最新的几轮会保留，但保留的不多，如果跑助手模式的话三个run前面的就看不到了"

**关联**：`fix-conversation-data-loss-v2.md` 的自动保存修复（setTimeout → setInterval）已部署，本次属于修复后遗留的"尾巴"。

---

## 1. 根因分析

### 1.1 主根因 A：初始恢复路径与 NavSidebar 路径使用不同数据源

**文件**：
- `apps/desktop/src/ui/layouts/ConversationLayout.tsx:63-99`（restore effect）
- `apps/desktop/src/ui/components/NavSidebar.tsx:261-315`（handleLoadConversation）

系统有两条独立的会话恢复路径：

**路径 A — 初始恢复**（`ConversationLayout` restore effect）：
```typescript
// ConversationLayout.tsx:63-99
useEffect(() => {
    if (restoredRef.current) return;
    ...
    const snap = draftSteps >= convSteps ? draftSnapshot : conv?.snapshot;
    if (!snap) return;
    st.loadSnapshot(snap);
    restoredRef.current = true;
}, [draftSnapshot, activeConvId, conversations]);
```
直接使用 `draftSnapshot` 或 `conv.snapshot`（来自 `conversations.v1.json`），**不调用 `loadConversationSegment`**。

**路径 B — NavSidebar 点击切换**（`handleLoadConversation`）：
```typescript
// NavSidebar.tsx:261-315
void historyApi({ conversationId: id, limit: 80 })
    .then((res) => {
        const segmentSteps = res?.steps ?? [];
        const snapshotToLoad = {
            ...baseSnapshot,
            steps: segmentSteps.length ? segmentSteps : (baseSnapshot?.steps ?? []),
        };
        loadSnapshot(snapshotToLoad);
    });
```
通过 `loadConversationSegment` IPC 从 v2 per-conversation 文件（`conversations/conv_{id}.json`）加载 steps。

**问题**：当 v1 文件中的 snapshot 的 `steps` 为空数组（但 snapshot 对象本身非 null），路径 A 会调用 `loadSnapshot(snap)`（steps=[]），然后标记 `restoredRef.current = true`，永远不再重试。而路径 B 从 v2 文件加载，能拿到完整 steps。

### 1.2 主根因 B：空 snapshot 触发 `loadSnapshot` 后 `restoredRef` 被永久锁定

**文件**：`apps/desktop/src/ui/layouts/ConversationLayout.tsx:87-98`

```typescript
const snap = draftSteps >= convSteps ? (draftSnapshot as any) : (conv?.snapshot as any);
if (!snap) return;          // ← 只检查 snap 是否为 null/undefined
st.loadSnapshot(snap);       // ← snap 是 {mode: "agent", steps: [], ...} 时仍然执行
restoredRef.current = true;  // ← 永久锁定，不再重试
```

当 `draftSteps` 和 `convSteps` 都为 0 时（`0 >= 0` 为 true），`snap = draftSnapshot`。如果 `draftSnapshot` 是一个有 `mode`/`model` 等字段但 `steps: []` 的对象，它通过了 `if (!snap) return` 检查（非 null），导致 `loadSnapshot` 用空 steps 填充 runStore → `hasMessages = false` → WelcomePage。

**v1 snapshot 变成 steps=[] 的场景**：

| 场景 | 触发路径 | 概率 |
|------|---------|------|
| 用户点"新任务"后退出 | `handleNewChat` → `resetRun()` → `buildCurrentSnapshot()` → steps=[] | 高 |
| 会话切换瞬间自动保存 | activeConvId 已更新但 runStore 还没加载新 steps → autosave 写空 | 中 |
| v1 退化：从 v2 加载 80 步后写回 v1 | 自动保存把 limit=80 的 snapshot 写入 v1，然后 capConversations 挤掉旧对话 | 低 |

### 1.3 主根因 C：`loadConversationSegment` limit=80 导致历史步数截断

**文件**：`apps/desktop/src/ui/components/NavSidebar.tsx:262`

```typescript
void historyApi({ conversationId: id, limit: 80 })
```

会话切换时只加载最近 80 个 step。Agent 模式下每个 run 的步数：
- 1 条 user message
- 1 条 assistant response
- 10-30 条 tool calls（MCP 工具如 Playwright 可能更多）

即每个 run ≈ 15-30 步。**3 个 run ≈ 45-90 步，4 个 run ≈ 60-120 步**。limit=80 只能覆盖约 3-5 个 run。

虽然 `ChatArea` 有滚动到顶部加载更多的机制（line 297-328），但用户不知道需要上滑，且没有可见的"加载更多"提示。

### 1.4 次根因：`slimSnapshotForHistory` 对 tool I/O 的截断限制过于激进

**文件**：`apps/desktop/src/state/conversationStore.ts:47-49`

```typescript
const MAX_TOOL_STDIO_HISTORY_CHARS = 4000;
const MAX_TOOL_GENERIC_STRING_CHARS = 800;
const MAX_LOG_MESSAGE_HISTORY_CHARS = 400;
```

每次 `buildCurrentSnapshot()` 都调用 `slimSnapshotForHistory()`，对 tool step 的 input/output 做字符串截断。`800 chars` 对于以下工具输出严重不足：

| 工具 | 典型输出大小 | 800 字符能保留 |
|------|------------|--------------|
| `browser_snapshot` (Playwright) | 5000-50000 chars | ~2-15% |
| `shell.exec` stdout | 1000-10000 chars（走 stdio 限制 4000） | 40-100% |
| `web.fetch` 内容 | 2000-20000 chars | ~4-40% |
| `browser_evaluate` 结果 | 500-5000 chars | ~16-100% |

恢复后查看历史工具结果时，大量关键信息被截断为 `"…[历史已截断]"`。

### 1.5 隐患：v1 snapshot 步数退化

**文件**：
- `apps/desktop/src/ui/components/ChatArea.tsx:377-380`
- `apps/desktop/src/state/conversationStore.ts:493-496`

当通过 NavSidebar 从 v2 文件加载 limit=80 步后，下一次自动保存会将这 80 步的 snapshot 写回 v1（通过 `updateConversation`）。v1 的 snapshot 步数从完整退化到最多 80 步。

`updateConversation` 的防降级只检查 `steps > 0 vs steps = 0`（line 493-496），**不保护"200 步退化为 80 步"**。

### 1.6 隐患：`flushDraftSnapshotNow` 防降级不足

**文件**：`apps/desktop/src/state/conversationStore.ts:538-542`

```typescript
const safeSnapshot =
    prevSteps > 0 && candSteps === 0 ? prevSnap : (candidate as any);
```

只防止 `steps > 0` 退化为 `steps = 0`。如果 `prevSteps = 200` 而 `candSteps = 80`，不会触发保护，允许步数减少。

---

## 2. 影响范围

### 2.1 Bug A：重启后欢迎页

| 场景 | 复现率 | 原因 |
|------|--------|------|
| 用户点"新任务"后立即重启 | 高 | 空 snapshot 成为 draftSnapshot |
| 快速切换会话后重启 | 中 | 自动保存竞态 |
| 长时间使用后重启 | 低 | v1 退化 + draftSnapshot 步数退化 |

### 2.2 Bug B：历史内容截断

| 场景 | 影响 | 原因 |
|------|------|------|
| Agent 模式 4+ run 的会话 | 早期 run 不可见 | limit=80 |
| 含 Playwright/shell.exec 的历史 | 工具输出被截断为 800/4000 chars | slimSnapshotForHistory |
| 用户不知道可以上滑加载 | 以为旧内容丢失 | 无可见"加载更多"提示 |

---

## 3. 修复方案

### Fix 1（P0）：初始恢复路径统一走 `loadConversationSegment`

**原理**：消除路径 A/B 的数据源不一致。初始恢复也通过 IPC 从 v2 per-conversation 文件加载 steps，与 NavSidebar 一致。

**修改文件**：`apps/desktop/src/ui/layouts/ConversationLayout.tsx`

**修改内容**：

```diff
--- a/apps/desktop/src/ui/layouts/ConversationLayout.tsx
+++ b/apps/desktop/src/ui/layouts/ConversationLayout.tsx
@@ L63-99（restore effect）
   // 水合后恢复草稿/最近一次对话快照（若当前 run 为空）
   useEffect(() => {
     if (restoredRef.current) return;
     const st = useRunStore.getState();
     const hasAny =
       (st.steps ?? []).length > 0 ||
       Object.values(st.mainDoc ?? {}).some((v) => String(v ?? "").trim());
     if (hasAny) {
       restoredRef.current = true;
       return;
     }

     // 在 draftSnapshot 和 activeConv snapshot 之间选择 steps 更多的一份
     const conv =
       activeConvId && conversations
         ? conversations.find((c) => c.id === activeConvId)
         : null;
     const draftSteps =
       draftSnapshot && Array.isArray((draftSnapshot as any).steps)
         ? (draftSnapshot as any).steps.length
         : 0;
     const convSteps =
       conv && conv.snapshot && Array.isArray((conv.snapshot as any).steps)
         ? (conv.snapshot as any).steps.length
         : 0;
-    const snap =
-      draftSteps >= convSteps ? (draftSnapshot as any) : (conv?.snapshot as any);
-    if (!snap) return;
-
-    st.loadSnapshot(snap);
-    // 恢复快照绑定的项目文件夹
-    const snapDir = (snap as any)?.projectDir ?? null;
-    const currentDir = useProjectStore.getState().rootDir;
-    if (snapDir && snapDir !== currentDir) {
-      void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
-    }
-    restoredRef.current = true;
+    const snap =
+      draftSteps >= convSteps ? (draftSnapshot as any) : (conv?.snapshot as any);
+    if (!snap) return;
+
+    // 优先通过 loadConversationSegment 从 v2 per-conv 文件加载 steps，
+    // 与 NavSidebar handleLoadConversation 保持一致的数据源。
+    // v2 文件保留完整 steps；v1 snapshot 可能被退化到 ≤80 步或 steps=[]。
+    const historyApi = (window as any).desktop?.history?.loadConversationSegment;
+    const restoreConvId = activeConvId;
+
+    const doRestore = (finalSnap: any) => {
+      if (!finalSnap) return;
+      st.loadSnapshot(finalSnap);
+      const snapDir = finalSnap?.projectDir ?? null;
+      const currentDir = useProjectStore.getState().rootDir;
+      if (snapDir && snapDir !== currentDir) {
+        void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
+      }
+      restoredRef.current = true;
+    };
+
+    if (historyApi && restoreConvId) {
+      // Electron 环境：走 v2 路径加载 steps
+      void historyApi({ conversationId: restoreConvId, limit: 150 })
+        .then((res: any) => {
+          if (restoredRef.current) return; // 防止并发恢复
+          const segmentSteps = Array.isArray(res?.steps) ? res.steps : [];
+          const hasMoreBefore = Boolean(res?.hasMoreBefore);
+          st.setHistoryWindowHasMoreBefore(hasMoreBefore);
+
+          if (segmentSteps.length > 0) {
+            doRestore({ ...snap, steps: segmentSteps });
+          } else {
+            // v2 文件也没有 steps，退回 v1 snapshot
+            if ((snap as any)?.steps?.length > 0) {
+              doRestore(snap);
+            } else {
+              // 真的没有内容（空对话），不标记 restoredRef，允许后续有内容时再恢复
+              return;
+            }
+          }
+        })
+        .catch(() => {
+          // IPC 失败，退回 v1 snapshot
+          if ((snap as any)?.steps?.length > 0) {
+            doRestore(snap);
+          }
+        });
+    } else {
+      // 非 Electron 环境或无 activeConvId：直接用 v1 snapshot
+      if ((snap as any)?.steps?.length > 0) {
+        doRestore(snap);
+      }
+      // steps=[] 的空 snapshot 不标记 restoredRef，避免永久锁定
+    }
   }, [draftSnapshot, activeConvId, conversations]);
```

**设计原则**：
- Electron 环境优先走 v2 路径，与 NavSidebar 一致
- v2 加载失败时退回 v1 snapshot
- **空 snapshot（steps=[]）不标记 `restoredRef = true`**，避免永久锁定
- 初始恢复使用 limit=150（比 NavSidebar 的 80 更大，首次恢复时用户期望看到更多内容）

### Fix 2（P0）：提高 `loadConversationSegment` 默认 limit + 加载更多提示

**原理**：limit=80 对 agent 模式过小。同时在 ChatArea 顶部增加可见的"加载更多历史"提示。

**修改文件**：
- `apps/desktop/src/ui/components/NavSidebar.tsx`
- `apps/desktop/src/ui/components/ChatArea.tsx`

**修改内容**：

#### 2a. NavSidebar limit 从 80 提到 200

```diff
--- a/apps/desktop/src/ui/components/NavSidebar.tsx
+++ b/apps/desktop/src/ui/components/NavSidebar.tsx
@@ L262
-      void historyApi({ conversationId: id, limit: 80 })
+      void historyApi({ conversationId: id, limit: 200 })
```

**预算对照**：

| limit | 覆盖 agent run 数（~25 步/run） | 覆盖 chat 轮数（~2 步/轮） |
|-------|-------------------------------|--------------------------|
| 80（旧） | ~3 | ~40 |
| 200（新） | ~8 | ~100 |

#### 2b. ChatArea 顶部加"加载更多历史"提示

```diff
--- a/apps/desktop/src/ui/components/ChatArea.tsx
+++ b/apps/desktop/src/ui/components/ChatArea.tsx
@@ L571-572（消息列表顶部 spacer 之后）
             {/* spacer: 消息少时把内容推到底部 */}
             <div className="flex-1 min-h-6" />
+            {hasMoreHistoryBefore && (
+              <div className="max-w-[var(--chat-max-width)] mx-auto w-full px-6 pb-2">
+                <button
+                  type="button"
+                  className="w-full text-center py-2 text-[12px] text-text-faint hover:text-text-muted transition-colors"
+                  onClick={() => {
+                    const el = scrollRef.current;
+                    if (el) el.scrollTop = 0; // 触发滚动加载
+                  }}
+                >
+                  ↑ 上滑加载更早的对话历史
+                </button>
+              </div>
+            )}
```

### Fix 3（P1）：提高 `slimSnapshotForHistory` 的 per-tool 截断限制

**原理**：800 chars 对 Playwright snapshot 等大输出过于激进。提高通用限制并为 MCP 工具设置独立限制。

**修改文件**：`apps/desktop/src/state/conversationStore.ts`

**修改内容**：

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@ L47-49（截断常量）
-const MAX_TOOL_STDIO_HISTORY_CHARS = 4000;
-const MAX_TOOL_GENERIC_STRING_CHARS = 800;
-const MAX_LOG_MESSAGE_HISTORY_CHARS = 400;
+const MAX_TOOL_STDIO_HISTORY_CHARS = 8000;
+const MAX_TOOL_GENERIC_STRING_CHARS = 2000;
+const MAX_TOOL_MCP_OUTPUT_CHARS = 6000;  // MCP 工具（如 Playwright browser_snapshot）输出更大
+const MAX_LOG_MESSAGE_HISTORY_CHARS = 400;

@@ slimToolIoForHistory（L59-73）
 function slimToolIoForHistory(toolName: string, io: unknown): unknown {
   if (!io || typeof io !== "object" || Array.isArray(io)) return io;
+  const isMcpTool = toolName.startsWith("mcp.");
   const src = io as Record<string, unknown>;
   const dst: Record<string, unknown> = {};
   for (const [k, v] of Object.entries(src)) {
     if (typeof v === "string") {
       const limit =
-        k === "stdout" || k === "stderr" ? MAX_TOOL_STDIO_HISTORY_CHARS : MAX_TOOL_GENERIC_STRING_CHARS;
+        k === "stdout" || k === "stderr"
+          ? MAX_TOOL_STDIO_HISTORY_CHARS
+          : isMcpTool
+            ? MAX_TOOL_MCP_OUTPUT_CHARS
+            : MAX_TOOL_GENERIC_STRING_CHARS;
       dst[k] = truncateForHistory(v, limit);
     } else {
       dst[k] = v;
     }
   }
   return dst;
 }
```

**截断限制对照**：

| 类型 | 旧值 | 新值 | 提升 |
|------|------|------|------|
| stdout/stderr | 4,000 | 8,000 | 2× |
| 通用 string | 800 | 2,000 | 2.5× |
| MCP 工具输出 | 800（通用） | 6,000（独立） | 7.5× |

### Fix 4（P1）：防降级保护增强——步数显著减少时不覆盖

**原理**：当前防降级只检查 `steps > 0 → steps = 0`。应额外保护"步数显著减少"（如 200 步退化为 80 步）。

**修改文件**：`apps/desktop/src/state/conversationStore.ts`

**修改内容**：

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@ updateConversation 中的防降级（L491-496）
             if (patch.snapshot != null) {
               const incoming = patch.snapshot as RunSnapshot;
               const prevSteps = getSnapshotStepsCount(nextSnapshot as any);
               const incomingSteps = getSnapshotStepsCount(incoming as any);
-              // 防降级：避免把已有 steps>0 的对话误写成 steps=0 的快照
-              nextSnapshot = prevSteps > 0 && incomingSteps === 0 ? nextSnapshot : incoming;
+              // 防降级：
+              // 1. 已有 steps>0 的对话不允许退化为 steps=0
+              // 2. 步数减少超过 50% 时保留旧 snapshot（防止 limit=80/200 截断覆盖完整历史）
+              const isZeroDegradation = prevSteps > 0 && incomingSteps === 0;
+              const isSignificantReduction = prevSteps > 20 && incomingSteps < prevSteps * 0.5;
+              nextSnapshot = isZeroDegradation || isSignificantReduction ? nextSnapshot : incoming;
             }
```

**同步修改**：`flushDraftSnapshotNow` 和 `flushDraftSnapshotNowSync` 中的防降级逻辑也做同样增强。

---

## 4. 不采用的方案

### 方案 A：直接去掉 `slimSnapshotForHistory`

**不采用原因**：无截断的 snapshot 在长会话中可能产生数十 MB 的 JSON（Playwright 单次 snapshot 输出可达 50KB），导致 conversations.v1.json 膨胀、IPC 传输变慢、localStorage quota 溢出。需要保留截断但调整限制。

### 方案 B：v1 文件不存储 snapshot.steps

**不采用原因**：v1 文件是兜底数据源。如果 v2 per-conv 文件损坏/缺失，v1 是最后的恢复手段。去掉 v1 的 steps 会失去这个安全网。

### 方案 C：恢复 effect 中只检查 `snap !== null` 就标记 `restoredRef`

**不采用原因**：这正是当前 Bug 1 的触发点。空 snapshot（steps=[]）非 null 但无内容，标记 restoredRef 后永远不会再恢复。Fix 1 的策略是只在有实质内容时才标记。

---

## 5. 架构隐患清单

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | 初始恢复路径（路径 A）与 NavSidebar（路径 B）使用不同数据源 | `ConversationLayout.tsx:63-99` vs `NavSidebar.tsx:261-315` | 重启后显示欢迎页 |
| S2 | 空 snapshot 通过 `!snap` 检查后永久锁定 `restoredRef` | `ConversationLayout.tsx:89-98` | 恢复失败后不再重试 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | `loadConversationSegment` limit=80 对 agent 模式过小 | `NavSidebar.tsx:262` | 3+ run 的历史不可见 |
| A2 | v1 snapshot 步数退化（从 v2 加载 80 步后写回 v1） | `ChatArea.tsx:377-380` + `conversationStore.ts:493-496` | v1 兜底数据逐渐退化 |
| A3 | 防降级只检查 `steps>0 vs steps=0`，不保护步数显著减少 | `conversationStore.ts:493-496` | 200 步退化为 80 步不触发保护 |

### B 级（影响可维护性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | `slimSnapshotForHistory` 800 chars 对 MCP 工具输出过小 | `conversationStore.ts:48` | 恢复后工具结果信息严重不足 |
| B2 | 滚动加载更多无可见 UI 提示 | `ChatArea.tsx:297-328` | 用户不知道可以上滑加载 |
| B3 | `saveConversationsV2` 每次保存都重写所有 per-conv 文件 | `main.cjs:776-891` | 长会话列表 I/O 压力大 |

### C 级（中长期架构演进风险）

| # | 问题 | 影响 |
|---|------|------|
| C1 | v1 和 v2 双写机制缺乏一致性保障（v1 步数可退化，v2 不会） | 需要明确 v1 是索引、v2 是数据的定位 |
| C2 | `slimSnapshotForHistory` 在每次 `buildCurrentSnapshot` 时都执行 | 高频保存时 CPU 开销（每 2 秒 slim 一次所有 steps） |
| C3 | per-conv v2 文件无增量更新（每次全量重写所有 steps） | 长会话的 v2 文件可能达数 MB |

---

## 6. 验证 Checklist

### 场景 1：重启后会话恢复

- [ ] 新建会话，发送 3 条消息（确保有内容）
- [ ] 重启 `npm run dev`
- [ ] 启动后应自动恢复上一次会话内容（不是欢迎页）
- [ ] 确认 `restoredRef` 在有内容时才被标记为 true

### 场景 2：点"新任务"后重启

- [ ] 点"新任务"按钮（创建空白对话）
- [ ] 重启 `npm run dev`
- [ ] 应恢复空白对话（欢迎页），而不是之前的对话
- [ ] 这种情况下显示欢迎页是正确行为

### 场景 3：Agent 模式历史可见性

- [ ] 在 agent 模式运行 5+ 个 run（每个 run 有多次工具调用）
- [ ] 切换到另一个会话再切回
- [ ] 应能看到至少 8 个 run 的内容（limit=200，约 200/25 ≈ 8 个 run）
- [ ] 顶部显示"上滑加载更早的对话历史"提示

### 场景 4：上滑加载更多

- [ ] 长会话（200+ 步）切换后，顶部有加载提示
- [ ] 上滑到顶部，自动加载更早的 50 步
- [ ] 重复上滑直到全部加载完毕

### 场景 5：工具输出截断放宽

- [ ] 执行含 Playwright browser_snapshot 的任务
- [ ] 重启后查看历史，browser_snapshot 输出应保留 ~6000 chars（而非 800）
- [ ] shell.exec stdout 应保留 ~8000 chars（而非 4000）

### 场景 6：防降级增强

- [ ] 会话有 200 步 → 切换到该会话（加载 200 步）→ 自动保存
- [ ] 确认 conversations.v1.json 中该会话的 snapshot 步数不减少
- [ ] 或只在步数减少 < 50% 时才允许更新

### 已有测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | Fix 1 | 初始恢复走 v2 路径 + 空 snapshot 不锁定 restoredRef |
| `apps/desktop/src/ui/components/NavSidebar.tsx` | Fix 2a | limit 从 80 提到 200 |
| `apps/desktop/src/ui/components/ChatArea.tsx` | Fix 2b | 顶部"加载更多历史"提示 |
| `apps/desktop/src/state/conversationStore.ts` | Fix 3, Fix 4 | slimSnapshotForHistory 截断限制调整 + 防降级增强 |

---

## 8. Codex 讨论记录摘要

本方案经过 Codex 深度分析（threadId: 见 session）。

**Codex 确认了全部根因**，并补充：
- Bug 1 的直接触发点是"空 snapshot 非 null，通过 `!snap` 检查后执行 `loadSnapshot(steps=[])` 并永久锁定 `restoredRef`"
- `hydrateFromDisk` 的 `bestSteps` 初始值 `-1` 意味着即使所有候选 steps=0 也会选中一个空 snapshot（`0 > -1`）
- v1 snapshot 步数退化是一个渐进过程：每次从 v2 加载 limit=80 后写回 v1，v1 逐渐退化
- React 18 StrictMode 的双调用 effects **不是本次 bug 的原因**
- `flushDraftSnapshotNow` 的防降级只检查 `>0 vs =0`，不保护"步数显著减少"

**同类受害者**：
- MiniMap 只显示当前加载的 steps（不反映完整历史）
- 续跑时 runStore 只有最后一段 steps，可能影响上下文
- `saveConversationsV2` 每次全量重写所有 per-conv 文件，I/O 压力大
