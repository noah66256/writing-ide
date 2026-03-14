# 修复方案：对话数据丢失（会话恢复 + 破坏性自动保存）

> 日期：2026-03-14
> 状态：设计稿（前端待实施；Electron 端历史 IO 已部分落地）
> 影响范围：`apps/desktop`（dev + 打包版均受影响）

---

## 0. 当前状态与范围

- 本文中的 R1–S3 是 **前端 store 侧的候选修复方案**，截至 2026-03-14，这部分改动尚未在  
  `apps/desktop/src/state/conversationStore.ts` / `apps/desktop/src/ui/components/ChatArea.tsx` /  
  `apps/desktop/src/ui/layouts/ConversationLayout.tsx` 中真正落地，仍然是 proposal-first 设计。
- 与对话历史相关的 **Electron 端 IO 防护** 已经部分上线（`apps/desktop/electron/main.cjs`），包括：
  - `history.saveConversations` 使用 tmp + rename，并在写入前复制 `.bak`，降低“写入中断导致整文件损坏”的风险；
  - `history.savePendingConversations` / `history.loadPendingConversations` 作为 pending 缓冲，避免崩溃或 HMR 时丢失最近几轮；
  - v2 历史格式：索引文件 + per-conversation `conv_*.json` 拆分，单个会话读写不再拖整个巨型 JSON；
  - `tryMigrateConversationHistory` + productName 白名单，统一 dev / 打包版的 userData 路径，并迁移旧版 `Electron` 目录下的历史文件。
- 上述 Electron 端改造已经显著减轻了“看起来所有对话都没了”的假象，但**前端仍存在“空快照覆盖有内容对话”的潜在风险**，  
  因此 R1–S3 仍然有必要在后续版本逐步落地，用于进一步收紧前端的恢复和自动保存行为。

---

## 一、问题现象

关闭 Desktop 应用后再重新打开，最近一次的会话内容丢失：

- 侧边栏中会话的**标签和标题仍然存在**
- 但主区域显示**欢迎页面**（空白），而非该会话的对话内容
- dev 和打包版**都会出现**

## 二、实际数据验证

| 环境 | draftSnapshot.steps | 对话 steps 状况 | 文件大小 | 最后修改 |
|------|---|---|---|---|
| **打包版 (OhMyCrab)** | **0** | 11 个对话中 10 个 steps=0 | 1MB | 3-14 20:20 |
| **Dev (Electron)** | 24 | 8 个对话全部有 steps | 104.6MB | **3-10 13:29**（4 天未更新！） |

- 打包版：数据已被**破坏**——对话标题有意义（如"我们是不是装了飞书了"），但 steps 被清零
- Dev 版：文件自 3-10 以来**从未被更新**——说明每次启动后数据都没有成功持久化
- 在 `806e657`（feat: desktop history segments）之后，两个版本使用同一套 slim 逻辑，文件应该都很小；dev 仍是 104.6MB 证明没写过新文件

## 三、根因分析

### 核心结论

**双重缺陷叠加，形成自我强化的破坏循环：**

1. **恢复缺陷**：重启后只从 `draftSnapshot` 恢复，不会自动加载 `activeConvId` 对应的 conversation snapshot
2. **破坏性自动保存**：ChatArea 每 2s 的自动保存会无条件用当前（空的）runStore 覆盖已保存的对话 snapshot
3. **合并优先级错误**：`hydrateFromDisk` 中 `curDraft ?? pendingDraft ?? diskDraft` 让内存中的空 draft 凭 `??` 优先级高于磁盘上有内容的 draft

### 破坏链路

```
[某次启动] draftSnapshot 为空/null（首次升级、crash、竞态等触发）
    │
    ├─ ConversationLayout 恢复 effect:
    │   draftSnapshot 为空 → 不触发 loadSnapshot → runStore.steps = []
    │   或 draftSnapshot 存在但 steps=0 → loadSnapshot(空快照) → runStore.steps = []
    │
    ├─ ChatArea 2s 自动保存触发:
    │   hasConversationContext = Boolean(mode) → true  ← mode 默认 "agent"
    │   → buildCurrentSnapshot() → 空快照(steps=[])
    │   → setDraftSnapshot(空快照)              ← 污染 draftSnapshot
    │   → updateConversation(activeConvId, { snapshot: 空快照 })  ← 覆盖！
    │
    ├─ schedulePersistToDisk → 写入磁盘 → 不可逆！
    │
    └─ [下次启动] 重复上述循环，持续破坏更多对话
```

### 竞态触发路径（大文件场景，dev 版）

```
T=0ms     ChatArea mount, 自动保存 timer 启动 (2s 后触发)
          mode 默认 "agent" → hasConversationContext=true → timer 不会被跳过

T=0ms     hydrateFromDisk() 开始 (IPC 异步加载 104.6MB)

T=2000ms  自动保存 timer 触发！hydration 还没完成！
          → buildCurrentSnapshot() → 空快照 (steps=[])
          → setDraftSnapshot(空快照)  ← zustand state 被污染

T=2500ms+ hydrateFromDisk() 终于完成
          合并优先级: curDraft ?? pendingDraft ?? diskDraft
          curDraft = 空快照 (T=2000ms 被自动保存设的) ← 非 null！
          → finalDraftRaw = 空快照  ← 磁盘上有 24 步的真实草稿被忽略！

T=2501ms  draftSnapshot effect 触发 → loadSnapshot(空快照) → runStore.steps=[]
          → 显示欢迎页

T=4500ms  下一轮自动保存触发，此时 activeConvId 已被 hydrate 设置
          → updateConversation(activeConvId, { snapshot: 空快照 })
          → 对话数据被永久破坏！
```

### 关键代码位置

| 问题 | 文件 | 位置 |
|------|------|------|
| 缺失 activeConvId 自动加载 | `ConversationLayout.tsx` | L54-73: 只检查 `draftSnapshot`，不回退到 `conversations[activeConvId].snapshot` |
| 无条件覆盖对话 snapshot | `ChatArea.tsx` | L332-356: 自动保存 timer，`updateConversation(convId, { snapshot: snap })` |
| updateConversation 无防降级 | `conversationStore.ts` | L442-457: 直接 `{ ...x, snapshot: patch.snapshot }` |
| flushDraftSnapshotNow 无防降级 | `conversationStore.ts` | L474-507: 关闭时也可能用空快照覆盖 |
| curDraft 优先级问题 | `conversationStore.ts` | L347-350: `curDraft ?? pendingDraft ?? diskDraft`，空对象非 null，胜过磁盘数据 |

---

## 四、修复方案

### 修复点清单

| 编号 | 类别 | 位置 | 描述 |
|------|------|------|------|
| **R1** | 恢复侧 | `conversationStore.ts` hydrateFromDisk | draftSnapshot 选取改为"比较 steps 数量"而非简单 `??` 优先级；三者都空时回退到 activeConvId 的 conversation snapshot |
| **R2** | 恢复侧 | `ConversationLayout.tsx` 恢复 effect | 在 draftSnapshot 和 activeConv snapshot 之间选择 steps 更多的一份 |
| **S1** | 保存侧 | `ChatArea.tsx` 自动保存 | 防降级：当前 runStore 完全为空但已保存的对话有 steps 时，跳过本轮自动保存 |
| **S2** | 保存侧 | `conversationStore.ts` updateConversation | 防降级：新 snapshot steps=0 但旧的 >0 时，保留旧 snapshot |
| **S3** | 保存侧 | `conversationStore.ts` flushDraftSnapshotNow | 对 active 对话 snapshot 和 draftSnapshot 都加防降级保护 |

### HMR 影响评估

`persistTimer`、`pendingPayload`、`diskHydrated` 都是 module 级变量。Vite HMR 下模块重新执行时会重置，但：

- Zustand store state 保留，`hydrateFromDisk` 有 `diskHydrated` 守卫保证只跑一次
- 旧定时器的 `saveConversations` 调用会正常完成，主进程有 `.bak` + tmp 机制保护
- **结论：HMR 下不需要对 `schedulePersistToDisk` 做额外处理**

---

## 五、Codex Diff 提案

### 5.1 `apps/desktop/src/state/conversationStore.ts`

涵盖 R1 + S2 + S3 + curDraft 优先级修复

```diff
diff --git a/apps/desktop/src/state/conversationStore.ts b/apps/desktop/src/state/conversationStore.ts
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@ -80,6 +80,12 @@ function slimSnapshotForHistory(snapshot: RunSnapshot | null | undefined): RunSn
   const logsSlim = slimLogsForHistory((snapshot as any).logs as LogEntry[]);
   return {
     ...(snapshot as RunSnapshot),
     steps: stepsSlim,
     logs: logsSlim,
   };
 }
+
+function getSnapshotStepsCount(raw: unknown): number {
+  if (!raw || typeof raw !== "object") return 0;
+  const steps = (raw as any).steps;
+  return Array.isArray(steps) ? steps.length : 0;
+}
@@ -300,24 +306,56 @@ export const useConversationStore = create<ConversationState>()(
           }
           const mergedRaw = capConversations(order.map((id) => byId.get(id)).filter(Boolean) as any);
           const merged = (mergedRaw as any[]).map((c) => {
             const snap = (c && (c as any).snapshot) as RunSnapshot | null | undefined;
             const slim = slimSnapshotForHistory(snap);
             return slim ? { ...c, snapshot: slim } : c;
           }) as Conversation[];

-          const finalDraftRaw =
-            (curDraft && typeof curDraft === "object" ? curDraft : null) ??
-            pendingDraft ??
-            (diskDraft && typeof diskDraft === "object" ? diskDraft : null);
-          const finalDraft = finalDraftRaw ? slimSnapshotForHistory(finalDraftRaw as any) ?? finalDraftRaw : null;
-
-          const pickActive = (id: string | null) => (id && merged.some((c) => c.id === id) ? id : null);
-          const finalActiveConvId = pickActive(curActiveConvId) || pickActive(pendingActiveConvId) || pickActive(diskActiveConvId);
+          // 计算最终 activeConvId（memory > pending > disk）
+          const pickActive = (id: string | null) =>
+            id && merged.some((c) => c.id === id) ? id : null;
+          const finalActiveConvId =
+            pickActive(curActiveConvId) ||
+            pickActive(pendingActiveConvId) ||
+            pickActive(diskActiveConvId);
+
+          // 计算最终 draftSnapshot：
+          // 1) 在 curDraft / pendingDraft / diskDraft 三者之间选择 steps 更多的一份；
+          //    若步数相同，按顺序 memory > pending > disk；
+          // 2) 若三者都不存在，则回退到 activeConvId 对应对话的 snapshot（R1）。
+          const draftCandidates: Array<RunSnapshot | null> = [];
+          if (curDraft && typeof curDraft === "object") draftCandidates.push(curDraft as RunSnapshot);
+          if (pendingDraft && typeof pendingDraft === "object") draftCandidates.push(pendingDraft as RunSnapshot);
+          if (diskDraft && typeof diskDraft === "object") draftCandidates.push(diskDraft as RunSnapshot);
+
+          let finalDraftRaw: RunSnapshot | null = null;
+          let bestSteps = -1;
+          for (const snap of draftCandidates) {
+            if (!snap || typeof snap !== "object") continue;
+            const steps = getSnapshotStepsCount(snap);
+            if (steps > bestSteps) {
+              bestSteps = steps;
+              finalDraftRaw = snap;
+            }
+          }
+
+          // 草稿源都不存在时，尝试用当前 activeConv 的 snapshot 作为最近草稿
+          if (!finalDraftRaw && finalActiveConvId) {
+            const activeConv = merged.find((c) => c.id === finalActiveConvId);
+            if (activeConv && activeConv.snapshot && typeof activeConv.snapshot === "object") {
+              finalDraftRaw = activeConv.snapshot as RunSnapshot;
+            }
+          }
+
+          const finalDraft =
+            finalDraftRaw ? slimSnapshotForHistory(finalDraftRaw as any) ?? finalDraftRaw : null;

           set({
             conversations: merged,
             draftSnapshot: finalDraft as any,
             activeConvId: finalActiveConvId,
           } as any);
@@ -420,18 +458,32 @@ export const useConversationStore = create<ConversationState>()(
       updateConversation: (id, patch) => {
         const v = String(id ?? "").trim();
         if (!v) return;
         set((s) => {
           const next = (s.conversations ?? []).map((x) => {
             if (x.id !== v) return x;
-            return {
-              ...x,
-              ...(patch.title != null ? { title: clampTitle(patch.title) } : {}),
-              ...(patch.snapshot != null ? { snapshot: patch.snapshot } : {}),
-              updatedAt: Date.now(),
-            };
+            let nextSnapshot = x.snapshot;
+            if (patch.snapshot != null) {
+              const incoming = patch.snapshot as RunSnapshot;
+              const prevSteps = getSnapshotStepsCount(nextSnapshot as any);
+              const incomingSteps = getSnapshotStepsCount(incoming as any);
+              // S2：防降级 - 避免把已有 steps>0 的对话误写成 steps=0 的快照
+              nextSnapshot =
+                prevSteps > 0 && incomingSteps === 0 ? nextSnapshot : incoming;
+            }
+            return {
+              ...x,
+              ...(patch.title != null ? { title: clampTitle(patch.title) } : {}),
+              ...(patch.snapshot != null ? { snapshot: nextSnapshot } : {}),
+              updatedAt: Date.now(),
+            };
           });
           schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null });
           return { conversations: next };
         });
       },
@@ -450,22 +502,44 @@ export const useConversationStore = create<ConversationState>()(
           schedulePersistToDisk({ conversations, draftSnapshot: next });
           return { draftSnapshot: next };
         });
       },
       flushDraftSnapshotNow: async (snap) => {
-        const base =
-          snap && typeof snap === "object" ? (snap as any) : snap === null ? null : buildCurrentSnapshot();
-        const next = base ? slimSnapshotForHistory(base as any) ?? base : null;
+        const base =
+          snap && typeof snap === "object"
+            ? (snap as any)
+            : snap === null
+              ? null
+              : buildCurrentSnapshot();
+        const candidate = base ? slimSnapshotForHistory(base as any) ?? base : null;
         const activeConvId = get().activeConvId;
         const prevConversations = get().conversations ?? [];
-        const conversations = activeConvId
-          ? prevConversations.map((x) => (x.id === activeConvId ? { ...x, snapshot: next as any, updatedAt: Date.now() } : x))
-          : prevConversations;
-        set({ draftSnapshot: next as any, conversations });
+        const conversations = activeConvId
+          ? prevConversations.map((x) => {
+              if (x.id !== activeConvId) return x;
+              const prevSnap = x.snapshot as any;
+              const prevSteps = getSnapshotStepsCount(prevSnap);
+              const candSteps = getSnapshotStepsCount(candidate as any);
+              // S3：防降级 - 若已有 snapshot.steps>0 而本次候选 steps=0，保留旧 snapshot
+              const safeSnapshot =
+                prevSteps > 0 && candSteps === 0 ? prevSnap : (candidate as any);
+              return { ...x, snapshot: safeSnapshot, updatedAt: Date.now() };
+            })
+          : prevConversations;
+
+        // draftSnapshot 也做防降级，避免从"有内容草稿"退化为"空草稿"
+        const prevDraft = get().draftSnapshot as any;
+        const prevDraftSteps = getSnapshotStepsCount(prevDraft);
+        const candDraftSteps = getSnapshotStepsCount(candidate as any);
+        const nextDraft =
+          prevDraftSteps > 0 && candDraftSteps === 0 ? prevDraft : (candidate as any);
+
+        set({ draftSnapshot: nextDraft as any, conversations });

         const api = window.desktop?.history;
         if (!api?.saveConversations || !diskWriteAllowed) {
-          schedulePersistToDisk({ conversations, draftSnapshot: next as any });
+          schedulePersistToDisk({ conversations, draftSnapshot: nextDraft as any });
           return;
         }

         if (persistTimer) {
@@ -475,12 +549,12 @@ export const useConversationStore = create<ConversationState>()(
         pendingPayload = null;
         try {
           await api.saveConversations({
             version: 1,
             updatedAt: Date.now(),
             conversations: capConversations(conversations),
-            draftSnapshot: next as any,
+            draftSnapshot: nextDraft as any,
             activeConvId: activeConvId ?? null,
           });
         } catch {
-          schedulePersistToDisk({ conversations, draftSnapshot: next as any });
+          schedulePersistToDisk({ conversations, draftSnapshot: nextDraft as any });
         }
       },
```

### 5.2 `apps/desktop/src/ui/layouts/ConversationLayout.tsx`

对应 R2：draftSnapshot 与 activeConv snapshot 之间选择 steps 更多的一份

```diff
diff --git a/apps/desktop/src/ui/layouts/ConversationLayout.tsx b/apps/desktop/src/ui/layouts/ConversationLayout.tsx
--- a/apps/desktop/src/ui/layouts/ConversationLayout.tsx
+++ b/apps/desktop/src/ui/layouts/ConversationLayout.tsx
@@ -13,11 +13,15 @@ import { useConversationStore } from "@/state/conversationStore";
  * 挂载时从 Gateway 拉取可用模型列表，并同步到 runStore。
  */
 export function ConversationLayout() {
   const fetchModels = useModelStore((s) => s.fetchModels);
   const hydrateFromDisk = useConversationStore((s) => s.hydrateFromDisk);
-  const draftSnapshot = useConversationStore((s) => s.draftSnapshot);
+  const draftSnapshot = useConversationStore((s) => s.draftSnapshot);
+  const activeConvId = useConversationStore((s) => s.activeConvId);
+  const conversations = useConversationStore((s) => s.conversations);
+
   const restoredRef = useRef(false);
   const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
   const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
@@ -40,24 +44,44 @@ export function ConversationLayout() {
       flush();
     };
   }, []);

-  // 水合后恢复草稿快照（若当前 run 为空）
+  // 水合后恢复草稿/最近一次对话快照（若当前 run 为空）
   useEffect(() => {
     if (restoredRef.current) return;
-    if (!draftSnapshot) return;
     const st = useRunStore.getState();
     const hasAny =
       (st.steps ?? []).length > 0 ||
       Object.values(st.mainDoc ?? {}).some((v) => String(v ?? "").trim());
     if (hasAny) {
       restoredRef.current = true;
       return;
     }
-    st.loadSnapshot(draftSnapshot as any);
-    // 恢复草稿绑定的项目文件夹
-    const snapDir = (draftSnapshot as any)?.projectDir ?? null;
+
+    // R2：在 draftSnapshot 和 activeConv snapshot 之间选择 steps 更多的一份
+    const conv =
+      activeConvId && conversations
+        ? conversations.find((c) => c.id === activeConvId)
+        : null;
+    const draftSteps =
+      draftSnapshot && Array.isArray((draftSnapshot as any).steps)
+        ? (draftSnapshot as any).steps.length
+        : 0;
+    const convSteps =
+      conv && conv.snapshot && Array.isArray((conv.snapshot as any).steps)
+        ? (conv.snapshot as any).steps.length
+        : 0;
+    const snap =
+      draftSteps >= convSteps ? (draftSnapshot as any) : (conv?.snapshot as any);
+    if (!snap) return;
+
+    st.loadSnapshot(snap);
+
+    // 恢复快照绑定的项目文件夹
+    const snapDir = (snap as any)?.projectDir ?? null;
     const currentDir = useProjectStore.getState().rootDir;
     if (snapDir && snapDir !== currentDir) {
       void useProjectStore.getState().loadProjectFromDisk(snapDir).catch(() => {});
     }
     restoredRef.current = true;
-  }, [draftSnapshot]);
+  }, [draftSnapshot, activeConvId, conversations]);
```

### 5.3 `apps/desktop/src/ui/components/ChatArea.tsx`

对应 S1：自动保存防降级

```diff
diff --git a/apps/desktop/src/ui/components/ChatArea.tsx b/apps/desktop/src/ui/components/ChatArea.tsx
--- a/apps/desktop/src/ui/components/ChatArea.tsx
+++ b/apps/desktop/src/ui/components/ChatArea.tsx
@@ -320,27 +320,52 @@ export function ChatArea() {
     }
   }, [hasMoreHistoryBefore]);

-  // 自动保存草稿到 conversationStore，同时更新活跃对话
+  // 自动保存草稿到 conversationStore，同时更新活跃对话（带防降级保护）
   useEffect(() => {
     const hasDraftState =
       steps.length > 0 ||
       todoList.length > 0 ||
       pendingArtifacts.length > 0 ||
       ctxRefs.length > 0 ||
       kbAttachedLibraryIds.length > 0 ||
       Object.values(mainDoc ?? {}).some((v) => {
         if (v == null) return false;
         if (typeof v === "string") return Boolean(v.trim());
         if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
         return true;
       });
     const hasConversationContext = Boolean(activeConvId) || Boolean(model) || Boolean(mode);
-    if (!hasDraftState && !hasConversationContext) return;
+    if (!hasDraftState && !hasConversationContext) return;
+
+    // S1：防降级 - 当前运行态完全为空，但 active 对话已有非空 snapshot 时，
+    // 跳过本轮自动保存，避免把历史对话误写成"空对话"快照。
+    const convStore = useConversationStore.getState();
+    const convIdNow = convStore.activeConvId;
+    const existingSnapshot =
+      convIdNow
+        ? convStore.conversations.find((c) => c.id === convIdNow)?.snapshot
+        : null;
+    const existingSteps =
+      existingSnapshot && Array.isArray((existingSnapshot as any).steps)
+        ? (existingSnapshot as any).steps.length
+        : 0;
+    if (!hasDraftState && existingSteps > 0) {
+      return;
+    }
+
     const timer = setTimeout(() => {
       const snap = buildCurrentSnapshot();
-      useConversationStore.getState().setDraftSnapshot(snap);
-      const convId = useConversationStore.getState().activeConvId;
+      const store = useConversationStore.getState();
+      store.setDraftSnapshot(snap);
+      const convId = store.activeConvId;
       if (convId) {
-        useConversationStore.getState().updateConversation(convId, { snapshot: snap });
+        store.updateConversation(convId, { snapshot: snap });
       }
     }, 2000);
     return () => clearTimeout(timer);
-  }, [steps, mainDoc, todoList, kbAttachedLibraryIds, ctxRefs, pendingArtifacts, mode, model]);
+  }, [steps, mainDoc, todoList, kbAttachedLibraryIds, ctxRefs, pendingArtifacts, mode, model, activeConvId]);
```

---

## 六、验证 Checklist

### 场景 1：正常恢复（打包版 + dev 版）

- [ ] 打开应用，发送几条消息，关闭
- [ ] 重新打开 → 应显示最后一次对话内容，而非欢迎页
- [ ] 检查 `conversations.v1.json` 的 `draftSnapshot.steps` 数量 > 0

### 场景 2：新建对话后重启

- [ ] 有会话 A（含消息）→ 点"新任务"→ 创建空会话 B → 关闭
- [ ] 重新打开 → 应显示空白的会话 B（这是预期行为）
- [ ] 点击侧边栏会话 A → 应显示会话 A 的完整内容（steps > 0）

### 场景 3：防降级保护

- [ ] 有会话 A（含 10 条消息）→ 在 dev console 手动执行：
  ```js
  useConversationStore.getState().updateConversation("A的ID", { snapshot: { steps: [], mode: "agent", model: "", mainDoc: {}, todoList: [], logs: [], kbAttachedLibraryIds: [] } })
  ```
- [ ] 验证 `conversations.v1.json` 中 A 的 `snapshot.steps` 仍然 > 0（防降级生效）

### 场景 4：大文件竞态（dev 版）

- [ ] 使用旧的 104.6MB 数据文件启动 dev
- [ ] 验证启动后显示对话内容（而非欢迎页）
- [ ] 验证 2s 后 `conversations.v1.json` 被更新（文件大小应大幅缩小，且 steps > 0）

### 场景 5：HMR（dev 版）

- [ ] dev 启动，产生对话内容
- [ ] 修改一个无关文件触发 HMR
- [ ] 验证对话内容仍然显示，数据未被清空

---

## 七、附带问题

### 孤立 tmp 文件

OhMyCrab 数据目录下有 30+ 个孤立的 `.tmp` 文件（最大 45MB），这些是 `saveConversations` / `savePendingConversations` 写入 tmp 后未成功 `rename` 到最终路径所留下的。

建议后续在 `history.loadConversations` 或 `app.ready` 时添加清理逻辑：扫描数据目录，删除超过 1 小时的 `.tmp` 文件。本次不在修复范围内。

### 数据恢复

对于打包版已被清零的对话，可以尝试从孤立 tmp 文件中恢复：

```bash
# 找到最大的 tmp 文件（可能包含完整历史数据）
ls -lS ~/Library/Application\ Support/OhMyCrab/ohmycrab-data/*.tmp | head -5

# 检查其中是否有 steps > 0 的对话
python3 -c "
import json
with open('最大的tmp文件路径', 'r') as f:
    data = json.load(f)
for c in data.get('conversations', []):
    steps = len(c.get('snapshot', {}).get('steps', []))
    if steps > 0:
        print(f'{c[\"id\"]}: {c[\"title\"]}, steps={steps}')
"
```

如果找到有效数据，可以直接替换 `conversations.v1.json`。
