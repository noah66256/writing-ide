# 修复对话历史丢失（v2）：Agent 运行期间自动保存失效

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

用户让 Agent 使用 Playwright MCP 工具在阿里云连续查询域名可用性。Agent 多次工具调用（间隔 < 2 秒），最终输出完整的域名汇总表格和推荐建议。随后用户 Ctrl+C 杀掉 dev 进程并重启。

**结果**：整个域名搜索会话消失——没有标签页、没有任何记录。在 `conversations.v1.json`、`.bak`、所有 `.tmp` 备份文件中均找不到该会话。

**关联**：v1 修复（commit `b3111cb`）解决了 hydration 竞态（空 snapshot 覆盖），但本次丢失属于全新的根因——数据**从未落盘**。

---

## 1. 根因分析

### 1.1 主根因：自动保存定时器在连续工具调用/流式输出期间"饿死"

**文件**：`apps/desktop/src/ui/components/ChatArea.tsx:332-374`

ChatArea 的自动保存使用 `setTimeout(fn, 2000)` + `clearTimeout` 清理模式：

```typescript
useEffect(() => {
    ...
    const timer = setTimeout(() => {
      store.setDraftSnapshot(snap);
      if (convId) store.updateConversation(convId, { snapshot: snap });
    }, 2000);
    return () => clearTimeout(timer);
}, [steps, mainDoc, todoList, ...]);
```

依赖列表包含 `steps`。Agent 每次工具调用都添加/更新 step，触发 useEffect 重新执行。**如果工具调用间隔 < 2s，timer 不断被重置，自动保存永远不触发**。

**受害场景**：
| 场景 | steps 变化频率 | 自动保存触发？ |
|------|--------------|--------------|
| Playwright MCP 连续工具调用 | ~0.5-1.5s/次 | 否 |
| 模型流式长文本输出 | `appendAssistantDelta` 每 ~100ms | 否 |
| 连续 shell.exec/web.fetch | ~1-3s/次 | 可能不触发 |
| mainDoc 持续编辑（不暂停 > 2s） | 按键间隔 ~100-500ms | 否 |

### 1.2 次根因：beforeunload 的 flush 不等待异步保存

**文件**：`apps/desktop/src/ui/layouts/ConversationLayout.tsx:34-36`

```typescript
const flush = () => {
    void useConversationStore.getState().flushDraftSnapshotNow().catch(() => void 0);
};
window.addEventListener("beforeunload", flush);
```

`flushDraftSnapshotNow()` 是 async 函数（内部调 IPC `api.saveConversations()`），但 `flush()` 用 `void` 调用不 await。`beforeunload` 是同步事件，handler 返回后窗口立即关闭，IPC 来不及完成。

**注意**：对于 Ctrl+C 杀 dev 进程的场景，`beforeunload` 事件**可能根本不触发**（主进程直接被 kill），所以此根因更多影响"正常关窗/HMR 卸载"场景。

### 1.3 次根因：运行完成保护不覆盖"运行中杀进程"

**文件**：`apps/desktop/src/ui/components/ChatArea.tsx:377-387`

```typescript
useEffect(() => {
    const prev = prevRunningRef.current;
    if (prev && !isRunning) {
        void flushDraftSnapshotNow().catch(() => void 0);
    }
}, [isRunning]);
```

只在 `isRunning` 从 true → false 时触发。进程在 Agent 仍运行时被杀，`isRunning` 始终为 true，该保护永远不触发。

### 1.4 隐患：loadConversations 的文件选择策略可能回退到旧数据

**文件**：`apps/desktop/electron/main.cjs:2506-2512`

```typescript
parsedList.sort((a, b) => {
    const c1 = Number(a.conversations?.length ?? 0);
    const c2 = Number(b.conversations?.length ?? 0);
    if (c2 !== c1) return c2 - c1;
    return Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
});
```

读 primary + `.bak` + legacy 路径，**选会话数最多的**。如果 `.bak`（旧版本备份）有更多会话（例如用户删了一些旧对话导致 primary 会话数 < .bak），会回退到旧数据，覆盖 primary。

实际观察到对话在不同保存快照间"来来去去"（某些对话在 backup 中有但当前文件没有，反之亦然），与此策略吻合。

---

## 2. 影响范围

| 功能 | 影响 |
|------|------|
| 所有 Agent 运行中的对话保存 | 连续工具调用/流式输出期间数据不落盘 |
| dev 模式 Ctrl+C 重启 | 运行中数据全丢 |
| 正常关窗 | 最后一次 flush 可能不完成 |
| 会话历史 hydration | 可能加载到旧版 .bak 数据 |

---

## 3. 修复方案

### Fix 1（P0）：自动保存从 setTimeout 改为脏标记 + 固定间隔轮询

**原理**：用 `setInterval(2000)` 代替 `setTimeout(2000)`。步骤变化只设置脏标记，不重置定时器。定时器每 2s 固定触发一次，检查脏标记决定是否保存。

**修改文件**：`apps/desktop/src/ui/components/ChatArea.tsx`

**修改内容**：
1. 新增 `autoSaveDirtyRef = useRef(false)`
2. 原自动保存 useEffect 改为仅设置 `autoSaveDirtyRef.current = true`
3. 新增 `useEffect([])` 启动 `setInterval`，每 2s 检查脏标记，为 true 则执行保存并清除标记
4. 保留所有防降级逻辑（空 snapshot 不覆盖有内容 snapshot）

### Fix 2（P1）：新增同步 IPC 写盘通道 + beforeunload 走同步路径

**原理**：使用 Electron 的 `ipcMain.on` + `ipcRenderer.sendSync` 提供同步写盘能力。`beforeunload` 和组件卸载时优先走同步通道。

**修改文件**：
- `apps/desktop/electron/main.cjs` — 新增 `history.saveConversationsSync` handler（用 `fs.writeFileSync`）
- `apps/desktop/electron/preload.cjs` — 暴露 `saveConversationsSync` API
- `apps/desktop/src/state/conversationStore.ts` — 新增 `flushDraftSnapshotNowSync` 方法
- `apps/desktop/src/ui/layouts/ConversationLayout.tsx` — beforeunload 优先调同步 flush

**注意**：同步 IPC 会阻塞渲染进程，仅在 beforeunload/卸载等关键路径使用。

### Fix 3（P1）：loadConversations 文件选择策略调整

**原理**：优先选择 primary/fallback 主文件，在同一来源内按 updatedAt 排序。只有主文件缺失或为空时才回退到 `.bak`/legacy。

**修改文件**：`apps/desktop/electron/main.cjs`（`history.loadConversations` handler）

**修改内容**：
1. 将候选文件分为"主文件"（primary/fallback）和"备份文件"（.bak/legacy）
2. 主文件组内按 updatedAt 降序排列，非空文件优先
3. 仅当主文件组全部为空或缺失时才回退到备份组

---

## 4. 不采用的方案

### 方案 A：降低 setTimeout 超时至 500ms

**不采用原因**：仍然是 setTimeout + clearTimeout 模式，在流式输出（delta 间隔 ~100ms）时依然会被饿死。需要从根本上改为固定间隔轮询。

### 方案 B：在 runStore.addTool/patchTool 中直接触发保存

**不采用原因**：过于耦合。runStore 不应知道 conversationStore 的保存逻辑。通过脏标记 + 定时轮询保持松耦合。

### 方案 C：使用 navigator.sendBeacon 替代 beforeunload 中的 IPC

**不采用原因**：sendBeacon 只能发 HTTP POST，不能写本地文件。Electron 场景需要同步 IPC 或 fs 写入。

---

## 5. Codex Diff Patch

### 5.1 ChatArea.tsx — 自动保存改为脏标记 + 固定间隔

```diff
--- a/apps/desktop/src/ui/components/ChatArea.tsx
+++ b/apps/desktop/src/ui/components/ChatArea.tsx
@@ scrollRef, bottomRef, stickRef, loadingMoreHistoryRef 声明区域
+  const autoSaveDirtyRef = useRef(false);

-  // 自动保存草稿到 conversationStore，同时更新活跃对话（带防降级保护）
+  // 标记发生了可能需要持久化的变更
   useEffect(() => {
-    const hasDraftState = ...;
-    const hasConversationContext = ...;
-    if (!hasDraftState && !hasConversationContext) return;
-    // 防降级 ...
-    const timer = setTimeout(() => {
-      const snap = buildCurrentSnapshot();
-      const store = useConversationStore.getState();
-      store.setDraftSnapshot(snap);
-      const convId = store.activeConvId;
-      if (convId) store.updateConversation(convId, { snapshot: snap });
-    }, 2000);
-    return () => clearTimeout(timer);
-  }, [steps, mainDoc, todoList, kbAttachedLibraryIds, ctxRefs, pendingArtifacts, mode, model, activeConvId]);
+    autoSaveDirtyRef.current = true;
+  }, [steps, mainDoc, todoList, kbAttachedLibraryIds, ctxRefs, pendingArtifacts, mode, model, activeConvId]);
+
+  // 固定间隔轮询：每 2s 检查脏标记，有变更则保存
+  useEffect(() => {
+    const timer = window.setInterval(() => {
+      if (!autoSaveDirtyRef.current) return;
+      const convStore = useConversationStore.getState();
+      const runState = useRunStore.getState();
+      const convIdNow = convStore.activeConvId;
+      // ... hasDraftState / hasConversationContext / 防降级检查 ...
+      const snap = buildCurrentSnapshot();
+      convStore.setDraftSnapshot(snap);
+      if (convIdNow) convStore.updateConversation(convIdNow, { snapshot: snap });
+      autoSaveDirtyRef.current = false;
+    }, 2000);
+    return () => window.clearInterval(timer);
+  }, []);
```

### 5.2 main.cjs — 同步写盘 handler + 文件选择策略

```diff
--- a/apps/desktop/electron/main.cjs
+++ b/apps/desktop/electron/main.cjs
+  // 同步写盘：仅在 beforeunload/卸载等关键路径使用
+  ipcMain.on("history.saveConversationsSync", (event, payload) => {
+    try {
+      const { primary, fallback } = historyCandidateDirs();
+      const dir = primary || fallback;
+      if (!dir) { event.returnValue = { ok: false, error: "NO_DIR" }; return; }
+      const file = path.join(dir, HISTORY_FILENAME);
+      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
+      const bak = file + HISTORY_BAK_SUFFIX;
+      try { fs.copyFileSync(file, bak); } catch {}
+      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
+      fs.writeFileSync(tmp, text, "utf-8");
+      try { fs.renameSync(tmp, file); } catch { fs.unlinkSync(file); fs.renameSync(tmp, file); }
+      event.returnValue = { ok: true };
+    } catch (e) {
+      event.returnValue = { ok: false, error: String(e?.message ?? e) };
+    }
+  });

   // loadConversations: 改文件选择策略
-  parsedList.sort((a, b) => {
-    const c1 = Number(a.conversations?.length ?? 0);
-    const c2 = Number(b.conversations?.length ?? 0);
-    if (c2 !== c1) return c2 - c1;
-    return Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
-  });
-  const picked = parsedList[0];
+  // 优先 primary/fallback 主文件；主文件为空时才回退到 .bak/legacy
+  const mainCandidates = parsedList.filter(x => x.used === "primary" || x.used === "fallback");
+  let picked = pickBestByFreshness(mainCandidates);
+  if (!picked) picked = pickBestByFreshness(parsedList);
```

---

## 6. 验证 Checklist

### 场景 1：连续工具调用 + Ctrl+C

- [ ] 新建会话，使用 Playwright MCP 连续查询域名（工具间隔 < 2s，运行 > 10s）
- [ ] 运行中观察 `conversations.v1.json` 的 updatedAt 每隔几秒在变化
- [ ] 运行中 Ctrl+C 杀 dev
- [ ] 重启 → 应能看到域名搜索会话标签和大部分内容

### 场景 2：流式长文本输出

- [ ] 让模型输出 2000+ 字长文本
- [ ] 过程中 `conversations.v1.json` 有周期性更新
- [ ] 关闭窗口后重启 → 能恢复到接近关闭前的状态

### 场景 3：.bak 回退保护

- [ ] 构造 primary 有 10 个会话（updatedAt 较新）、.bak 有 15 个会话（updatedAt 较旧）
- [ ] 启动应用 → 应使用 primary 的 10 个会话，不回退到 .bak

### 场景 4：防降级仍有效

- [ ] 有会话 A（含消息）→ dev console 手动 `updateConversation(id, { snapshot: { steps: [] } })`
- [ ] 验证 snapshot.steps 仍 > 0（防降级生效）

### 场景 5：正常关窗 flush

- [ ] 运行中正常关闭窗口
- [ ] 重启 → 对话内容完整

---

## 7. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/desktop/src/ui/components/ChatArea.tsx` | Fix 1 | 自动保存 setTimeout → setInterval |
| `apps/desktop/src/state/conversationStore.ts` | Fix 2 | 新增 `flushDraftSnapshotNowSync` + 提取 `computeSafeSnapshotUpdate` |
| `apps/desktop/src/ui/layouts/ConversationLayout.tsx` | Fix 2 | beforeunload 走同步 flush |
| `apps/desktop/electron/main.cjs` | Fix 2, Fix 3 | 同步写盘 handler + 文件选择策略调整 |
| `apps/desktop/electron/preload.cjs` | Fix 2 | 暴露 `saveConversationsSync` |
| `apps/desktop/src/vite-env.d.ts` | Fix 2 | 类型定义更新 |
