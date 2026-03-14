# 修复 MCP 工具在 Agent Run 中渐进式消失

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

用户让 Agent 在阿里云购买域名 ohmycrab.top。Agent 使用 Playwright MCP 工具多次导航、截图、点击页面。运行初期 click/type/snapshot 等工具正常可用，但随着 run 进行，Agent 发现越来越多的 Playwright 工具不可用。最终 `tools.search` 查询浏览器相关工具时，**只返回 `browser_navigate` 和 `browser_navigate_back` 两个工具**——Playwright 全量暴露的 ~21 个工具中，19 个"消失"了。

用户原话：**"playwright是全量暴露工具的，但在这个run，玩到最后就剩俩了，而且前面它还点的好好的，这也是个范式上的问题，以后可能会在各种带工具的mcp上面复现"**

**关联**：`fix-memory-tool-unavailable-v1.md` 的架构隐患 A1 已预警"MCP 工具首轮被 boot 剪掉"，但当时只修了 CORE_TOOLS 兜底，未处理 MCP 工具的系统性问题。

---

## 1. 根因分析

### 1.1 主根因：`selectToolSubset` top-K 裁剪永久淘汰大量 MCP 工具

**文件**：`apps/gateway/src/agent/runFactory.ts:2953-2960`

`selectToolSubset` 在 run 启动时执行**一次**，从全量工具目录（builtin ~30 + MCP ~21 = ~51）中按评分选出 top-K（`maxTools=30`，agent 模式）。被淘汰的 ~21 个工具从 `selectedAllowedToolNames` 中永久移除。

```typescript
const toolSelection = selectToolSubset({
  catalog: toolCatalog,
  routeId: routeIdLower || intentRoute.routeId,
  userPrompt,
  preferredToolNames: preferredToolNamesWithRetrieval,
  preserveToolNames: Array.from(preserveToolNamesWithComposite),
  maxTools: maxToolsForMode,  // agent=30
});
```

**关键**：`ensureCoreToolsSelected()`（L2974）只兜底 `CORE_TOOL_NAME_SET`（26 个内置工具），**不保护 MCP 工具**。因此 MCP 工具中只有被 `preferredToolNames`（来自 Tool Retrieval）提名或评分足够高的才能存活。

**工具声明是 run 级静态的**（`GatewayRuntime.ts:432-445`）：
```typescript
// 重要：Pi runtime 的 tools 声明集在 run 内基本是静态的（pi-agent-core 不支持每 turn 替换 tools）。
const declaredAllowed = this.config.runCtx.allowedToolNames;
const visibleTools = this._buildAgentTools(declaredAllowed);
```

被 `selectToolSubset` 淘汰的工具在整个 run 内**不可见、不可调用、不可发现**。

### 1.2 次根因：`detectPromptCapabilities` 的 browser_open 正则与 `STRONG_BROWSER_RE` 不同步

**文件**：
- `apps/gateway/src/agent/toolCatalog.ts:95`（`detectPromptCapabilities` 用）
- `apps/gateway/src/agent/toolRetriever.ts:16`（`retrieveToolsForRun` 用）

两套正则本应检测同一件事——"用户意图是否涉及浏览器操作"——但覆盖范围严重不一致：

| 正则 | 位置 | 匹配"页面" | 匹配"扫码" | 匹配"后台" | 匹配"登录" |
|------|------|-----------|-----------|-----------|-----------|
| `detectPromptCapabilities` browser_open | `toolCatalog.ts:95` | ❌ | ❌ | ❌ | ❌ |
| `STRONG_BROWSER_RE` | `toolRetriever.ts:16` | ❌ | ✅ | ✅ | ✅ |

`detectPromptCapabilities` 的 browser_open 正则：
```typescript
/(打开.*网页|打开网站|浏览器|网站|navigate|open\s+.*(baidu|google|url))/i
```

`STRONG_BROWSER_RE`：
```typescript
/(公众号|小红书|抖音|知乎|微博|后台|管理后台|扫码|扫码登录|登录|浏览器|网页|网站|打开.*(网页|网站)|navigate|goto|open\s+.*https?:\/\/)/i
```

**受害场景**：用户说"去阿里云国内版的**页面**"。`STRONG_BROWSER_RE` 匹配"页面"？——不，两个正则都不匹配"页面"。但 `STRONG_BROWSER_RE` 能匹配更多浏览器相关意图词，而 `detectPromptCapabilities` 极度保守。

**后果**：`selectToolSubset` 调用 `detectPromptCapabilities` 获取 `promptCaps`（L467）。如果 `promptCaps` 中没有 `browser_open`，MCP 浏览器工具就拿不到 `mcp_browser_boost`（+80 分，L492-495），大量 Playwright 工具在评分竞争中被淘汰。

### 1.3 次根因：`browser_entry_boost` 只覆盖 5/21 个 Playwright 工具

**文件**：`apps/gateway/src/agent/toolRetriever.ts:148-155`

Tool Retrieval 阶段的 `browser_entry_boost` 正则只匹配有限的工具名模式：

```typescript
if (/(playwright|browser)/i.test(n) && /(navigate|goto|open|click|snapshot|screenshot)/i.test(n)) {
  score += 6.5;
  reasons.push("browser_entry_boost");
}
```

**只匹配**：`browser_navigate`、`browser_navigate_back`、`browser_click`、`browser_snapshot`、`browser_take_screenshot`（5 个）

**遗漏**：`browser_type`、`browser_fill_form`、`browser_hover`、`browser_select_option`、`browser_press_key`、`browser_evaluate`、`browser_drag`、`browser_tabs`、`browser_file_upload`、`browser_handle_dialog`、`browser_wait_for`、`browser_console_messages`、`browser_network_requests`、`browser_resize`、`browser_close`、`browser_install`（16 个）

这些遗漏工具在 Tool Retrieval 阶段没有入口加分，不会被 `retrieveToolsForRun` 提名为 `retrievedToolNames`，进而不会作为 `preferredToolNames`（+420 分）进入 `selectToolSubset`，最终在 top-K 竞争中被淘汰。

### 1.4 次根因：`tools.search` 只搜索已裁剪的 `allowedToolNames`，无法发现被淘汰的工具

**文件**：
- `apps/gateway/src/agent/serverToolRunner.ts:618-631`（`listCatalogForDiscovery`）
- `apps/gateway/src/agent/serverToolRunner.ts:646-648`（`executeToolsSearchOnGateway` 传入 `allowedToolNames`）
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:1415`（传入 `allowedToolNames`）

`tools.search` 的搜索范围是 `allowedToolNames`——即经过 `selectToolSubset` 裁剪后的 run 级工具集：

```typescript
// serverToolRunner.ts:618-631
function listCatalogForDiscovery(args: {
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;  // ← 裁剪后的集合
  toolSidecar: ToolSidecar | null;
}): ToolCatalogEntry[] {
  const allowed = args.allowedToolNames ?? new Set(TOOL_LIST.map(...));
  const mcpTools = Array.isArray(sidecar?.mcpTools) ? sidecar.mcpTools : [];
  return buildToolCatalog({ mode: args.mode, allowedToolNames: allowed, mcpTools });
}
```

**后果**：被 `selectToolSubset` 淘汰的 MCP 工具，即使 Agent 用 `tools.search` 主动搜索，也**永远找不到**。这就是用户观察到"搜浏览器工具只返回 navigate 和 navigate_back"的直接原因。

### 1.5 隐患：`computePerTurnAllowed` 的浏览器工具屏蔽进一步收窄

**文件**：`apps/gateway/src/agent/runFactory.ts:3542-3550`

```typescript
if (!allowBrowserForTurn && browserMcpToolNames.size > 0) {
  let removed = 0;
  for (const n of browserMcpToolNames) {
    if (allowed.delete(n)) removed += 1;
  }
}
```

当 `allowBrowserForTurn = false` 时（非浏览器导航场景），per-turn gating 会**删除所有浏览器 MCP 工具**。即使某些 Playwright 工具侥幸通过了 `selectToolSubset`，也可能在特定 turn 被 per-turn gating 删除。

这本身是合理设计（非浏览器任务不暴露浏览器工具），但与 1.2 的正则不同步叠加后，会导致本应被识别为浏览器任务的场景也误删浏览器工具。

---

## 2. 影响范围

### 2.1 受影响的 MCP 工具类型

| MCP 类别 | 典型工具数 | 首轮可见数（估算） | 后果 |
|----------|----------|-------------------|------|
| Playwright 浏览器 | ~21 | 3-5 | 只能 navigate/screenshot，不能 click/type/fill |
| Word/Excel（将来） | ~10-15 | 3-5 | 大量操作工具不可用 |
| 博查搜索 | ~2-3 | 全量（数量少） | 不受影响 |
| 任何 > 10 工具的 MCP Server | N | min(N, ~5) | 大量工具被裁剪 |

### 2.2 受害场景

| 场景 | `detectPromptCapabilities` 命中？ | Tool Retrieval 提名数 | 最终可用 Playwright 工具 |
|------|----------------------------------|---------------------|------------------------|
| "帮我去阿里云买域名" | ❌（无"网页/网站/浏览器"） | 0-2 | 2-3 |
| "打开网站 xxx 帮我操作" | ✅（"打开网站"） | 5 | 8-10 |
| "帮我在后台管理页面配置" | ❌ | 0-1 | 1-2 |
| "扫码登录微信公众号后台" | ❌ | 0-1 | 1-2 |

### 2.3 同类受害者

任何注册了大量工具（> 10）的 MCP Server 都会遇到同样的 top-K 裁剪问题。这是**范式级缺陷**，不是 Playwright 特有的。

---

## 3. 修复方案

### Fix 1（P0）：`tools.search` 搜索全量 MCP 目录，不受 `selectToolSubset` 裁剪限制

**原理**：`tools.search` 是 Agent 运行时发现新工具的唯一通道。它的搜索范围不应被 run 启动时的静态裁剪限制，应该能搜到所有已注册的 MCP 工具。

**修改文件**：`apps/gateway/src/agent/serverToolRunner.ts`

**修改内容**：

修改 `listCatalogForDiscovery`，接受额外的 `fullMcpTools` 参数。当 `tools.search` 调用时，MCP 工具部分使用全量目录而非 `allowedToolNames` 过滤后的子集。

```diff
--- a/apps/gateway/src/agent/serverToolRunner.ts
+++ b/apps/gateway/src/agent/serverToolRunner.ts
@@ listCatalogForDiscovery（L618-631）
 function listCatalogForDiscovery(args: {
   mode: "chat" | "agent";
   allowedToolNames: Set<string> | null;
   toolSidecar: ToolSidecar | null;
+  includeAllMcpTools?: boolean;
 }): ToolCatalogEntry[] {
   const allowed = args.allowedToolNames ?? new Set(TOOL_LIST.map((t) => String(t?.name ?? "").trim()).filter(Boolean));
   const sidecar = (args.toolSidecar ?? null) as any;
   const mcpTools = Array.isArray(sidecar?.mcpTools) ? (sidecar.mcpTools as any[]) : [];
-  return buildToolCatalog({
-    mode: args.mode,
-    allowedToolNames: allowed,
-    mcpTools,
-  });
+
+  if (args.includeAllMcpTools && mcpTools.length > 0) {
+    // tools.search 模式：内置工具仍用 allowed 过滤，但 MCP 工具使用全量目录。
+    // 构建一个扩展的 allowed 集合，把所有 MCP 工具名加入。
+    const expandedAllowed = new Set(allowed);
+    for (const t of mcpTools) {
+      const name = String(t?.name ?? "").trim();
+      if (name) expandedAllowed.add(name);
+    }
+    return buildToolCatalog({
+      mode: args.mode,
+      allowedToolNames: expandedAllowed,
+      mcpTools,
+    });
+  }
+
+  return buildToolCatalog({ mode: args.mode, allowedToolNames: allowed, mcpTools });
 }

@@ executeToolsSearchOnGateway（L646-648）
   const catalog = listCatalogForDiscovery({
     mode: args.mode,
     allowedToolNames: args.allowedToolNames,
     toolSidecar: args.toolSidecar,
+    includeAllMcpTools: true,
   });
```

**边界情况**：
- 内置工具仍受 `allowedToolNames` 过滤（避免 `tools.search` 暴露被意图路由排除的内置工具）
- MCP 工具全量可搜，但搜索结果中的工具可能不在当前 run 的 `allowedToolNames` 中——需要 Fix 4 配合动态添加

### Fix 2（P0）：统一 `detectPromptCapabilities` 的 browser_open 正则

**原理**：`detectPromptCapabilities` 的 browser_open 正则过于保守，与 `STRONG_BROWSER_RE` 不同步，导致 `selectToolSubset` 的 `mcp_browser_boost`（+80 分）在大量浏览器场景中失效。

**修改文件**：`apps/gateway/src/agent/toolCatalog.ts`

**修改内容**：

将 `detectPromptCapabilities` 的 browser_open 正则与 `STRONG_BROWSER_RE` 对齐，覆盖常见的中文浏览器意图词。

```diff
--- a/apps/gateway/src/agent/toolCatalog.ts
+++ b/apps/gateway/src/agent/toolCatalog.ts
@@ CAPABILITY_KEYWORDS browser_open 条目（L95）
-  { capability: "browser_open", re: /(打开.*网页|打开网站|浏览器|网站|navigate|open\s+.*(baidu|google|url))/i },
+  { capability: "browser_open", re: /(打开.*(网页|网站|页面)|浏览器|网页|网站|页面|公众号|小红书|抖音|知乎|微博|后台|管理后台|扫码|扫码登录|登录.*页面|navigate|goto|open\s+.*(baidu|google|url|https?:\/\/))/i },
```

**设计原则**：
- 与 `STRONG_BROWSER_RE` 保持同步，新增关键词时两处一起改
- 新增"页面"——这是用户最常用的浏览器意图词之一（"去阿里云的**页面**"）
- 新增"公众号/小红书/抖音/知乎/微博/后台/管理后台/扫码/登录页面"——这些场景必然需要浏览器

**注意**：同时建议在 `toolRetriever.ts` 的 `STRONG_BROWSER_RE` 中也加入"页面"：

```diff
--- a/apps/gateway/src/agent/toolRetriever.ts
+++ b/apps/gateway/src/agent/toolRetriever.ts
@@ STRONG_BROWSER_RE（L16）
-const STRONG_BROWSER_RE = /(公众号|小红书|抖音|知乎|微博|后台|管理后台|扫码|扫码登录|登录|浏览器|网页|网站|打开.*(网页|网站)|navigate|goto|open\s+.*https?:\/\/)/i;
+const STRONG_BROWSER_RE = /(公众号|小红书|抖音|知乎|微博|后台|管理后台|扫码|扫码登录|登录|浏览器|网页|网站|页面|打开.*(网页|网站|页面)|navigate|goto|open\s+.*https?:\/\/)/i;
```

### Fix 3（P1）：`selectToolSubset` 后按 MCP Server 粒度补齐工具

**原理**：当 `selectToolSubset` 选中了某个 MCP Server 的部分工具时，说明该 Server 与当前任务相关。应该把该 Server 的**全部工具**补齐到 `selectedAllowedToolNames` 中，避免"选了 navigate 但没选 click"的割裂。

**修改文件**：`apps/gateway/src/agent/runFactory.ts`

**修改位置**：`ensureCoreToolsSelected()` 调用之后（约 L2974 后）

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ ensureCoreToolsSelected 调用之后（约 L2974）
   // 兜底：确保 CORE_TOOLS 不被 B2 裁剪掉，只要它们在 baseAllowedToolNames 中。
   ensureCoreToolsSelected({ baseAllowedToolNames, selectedAllowedToolNames });

+  // MCP Server 粒度补齐：如果 selectToolSubset 选中了某个 MCP Server 的任一工具，
+  // 就把该 Server 的全部工具补入 selectedAllowedToolNames。
+  // 原理：MCP Server 的工具是功能上紧密耦合的整体（如 Playwright 的 navigate/click/type/fill），
+  // 只选部分工具会导致 Agent 能开始操作但无法完成（能导航但不能点击）。
+  if (mcpTools.length > 0) {
+    // 构建 serverName → toolNames 映射
+    const serverToolMap = new Map<string, string[]>();
+    for (const t of mcpTools) {
+      const name = String(t?.name ?? "").trim();
+      const server = String(t?.serverName ?? t?.metadata?.serverName ?? "").trim();
+      if (!name || !server) continue;
+      if (!serverToolMap.has(server)) serverToolMap.set(server, []);
+      serverToolMap.get(server)!.push(name);
+    }
+
+    // 找出已被选中的 MCP Server
+    const selectedServers = new Set<string>();
+    for (const [server, tools] of serverToolMap) {
+      if (tools.some((n) => selectedAllowedToolNames.has(n))) {
+        selectedServers.add(server);
+      }
+    }
+
+    // 补齐这些 Server 的全部工具
+    for (const server of selectedServers) {
+      const tools = serverToolMap.get(server) ?? [];
+      for (const name of tools) {
+        if (baseAllowedToolNames.has(name)) {
+          selectedAllowedToolNames.add(name);
+        }
+      }
+    }
+  }
```

**边界情况**：
- 只补齐在 `baseAllowedToolNames` 中的工具（受 mode/toolPolicy 约束的工具不强行加入）
- 如果没有任何 MCP 工具被选中（例如纯文本任务），不做补齐
- Word/Excel MCP 同理：选了 `create_document` 就应该补齐 `add_paragraph`、`save_document` 等

**与 maxTools 的关系**：补齐后可能超过 `maxTools=30`。这是可接受的——MCP Server 工具之间的功能耦合性远高于 builtin 工具之间的耦合性，截断 MCP Server 的工具集比超额更有害。如果担心 context 长度，可以在此步骤后重新检查总数，但优先级低于功能完整性。

### Fix 4（P1）：`tools.search` 发现的工具动态加入 `effectiveAllowed`

**原理**：Fix 1 让 `tools.search` 能搜到全量 MCP 工具，但搜到不等于能用——如果发现的工具不在 `effectiveAllowed` 中，Agent 调用时仍会被 `_executeAgentTool` 的软 gating 拒绝。需要在 `tools.search` 返回结果后，将发现的工具动态加入可用集合。

**修改文件**：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/gateway/src/agent/runFactory.ts`

**修改内容**：

#### 4a. GatewayRuntime：记录 `tools.search` 发现的工具名

在 `_executeGatewayTool` 处理 `tools.search` 返回后，将发现的 MCP 工具名记录到 `runState.discoveredMcpToolNames`：

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@ _executeGatewayTool 中 tools.search 返回后
+      // 记录 tools.search 发现的 MCP 工具名，供 computePerTurnAllowed 在后续 turn 放行
+      if (toolName === "tools.search" && ret.ok) {
+        const output = (ret as any).output;
+        const tools = Array.isArray(output?.tools) ? output.tools : [];
+        const discovered = (this.runState as any).discoveredMcpToolNames ??
+          ((this.runState as any).discoveredMcpToolNames = new Set<string>());
+        for (const t of tools) {
+          const name = String(t?.name ?? "").trim();
+          if (name) discovered.add(name);
+        }
+      }
```

#### 4b. runFactory：`computePerTurnAllowed` 合并发现的工具

在 `computePerTurnAllowed` 的最终出口（`perTurnResult()`）中，将 `discoveredMcpToolNames` 合并到 `allowed`：

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@ perTurnResult() 中 ALWAYS_ALLOW_TOOL_NAMES 兜底之后
+      // tools.search 动态发现的 MCP 工具放行：Agent 通过 tools.search 发现了新工具后，
+      // 后续 turn 应允许调用这些工具，即使它们不在 run 启动时的 selectedAllowedToolNames 中。
+      const discovered = (state as any).discoveredMcpToolNames;
+      if (discovered instanceof Set && discovered.size > 0) {
+        for (const name of discovered) {
+          if (baseAllowedToolNames.has(name)) {
+            allowed.add(name);
+          }
+        }
+      }
```

**边界情况**：
- 只放行在 `baseAllowedToolNames` 中的工具（尊重 mode/toolPolicy 约束）
- `discoveredMcpToolNames` 是累积的——一旦发现就持续放行，不会在下一 turn 消失
- 不影响浏览器工具的 per-turn 屏蔽逻辑（`!allowBrowserForTurn` 仍能删除浏览器工具）——但如果 Agent 主动搜索了浏览器工具，说明当前任务确实需要，应该由 `allowBrowserForTurn` 的逻辑来判断

---

## 4. 不采用的方案

### 方案 A：去掉 `selectToolSubset` 的 top-K 限制

**不采用原因**：top-K 存在的理由是控制 LLM 的工具选择空间，避免 token 浪费和选择困难。完全去掉会导致所有 51+ 工具声明到 system prompt，显著增加 token 消耗和模型迷航概率。Fix 3（按 Server 补齐）是更精准的解法。

### 方案 B：在 `_buildAgentTools` 中动态声明工具

**不采用原因**：pi-agent-core 的 `agentLoop` 不支持每 turn 动态替换工具声明（L432 注释明确说明）。需要修改 pi-agent-core 才能实现，改动范围过大。

### 方案 C：把 MCP 工具从 top-K 竞争中完全豁免

**不采用原因**：如果用户配置了多个大型 MCP Server（如 Playwright + Word + Excel），全量豁免会导致工具列表膨胀到 60+。Fix 3（按 Server 粒度补齐）是折中方案——只补齐"与当前任务相关的 Server"的工具。

---

## 5. 架构隐患清单

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | `selectToolSubset` top-K 对 MCP 工具是"剪刀式"淘汰，无 Server 粒度感知 | `runFactory.ts:2953-2960` | 任何 >10 工具的 MCP Server 都会被截断 |
| S2 | `tools.search` 搜索范围被 run 级裁剪限制 | `serverToolRunner.ts:618-631` | Agent 的自愈能力（通过搜索发现工具）完全失效 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | `detectPromptCapabilities` 与 `STRONG_BROWSER_RE` 正则不同步 | `toolCatalog.ts:95` vs `toolRetriever.ts:16` | 浏览器意图检测在两个阶段给出矛盾结论 |
| A2 | `browser_entry_boost` 只覆盖 5/21 个 Playwright 工具 | `toolRetriever.ts:148-155` | 大量交互工具（type/fill/hover）在 Retrieval 阶段没有加分 |
| A3 | 两套正则都不匹配"页面"——中文中最常见的浏览器意图词之一 | 两处 | "去某个**页面**"这类请求无法触发浏览器工具优先 |

### B 级（影响可维护性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | 三处浏览器意图检测逻辑（`detectPromptCapabilities`、`STRONG_BROWSER_RE`、`allowBrowserToolsEffective`）各自维护 | 三个文件 | 改一处容易漏另两处，已发生 |
| B2 | `browser_entry_boost` 的工具名正则是硬编码模式匹配 | `toolRetriever.ts:151` | 新增 MCP 工具需要手动更新正则 |

### C 级（中长期架构演进风险）

| # | 问题 | 影响 |
|---|------|------|
| C1 | `selectToolSubset` 的扁平评分模型不区分"工具间依赖关系" | navigate 和 click 独立评分，但功能上强依赖 |
| C2 | 工具声明 run 级静态，无法响应 Agent 在 run 中的新发现 | 需要 pi-agent-core 支持动态工具声明 |

---

## 6. 验证 Checklist

### 场景 1：Playwright 全量工具可用

- [ ] 新建会话，发送"帮我去阿里云买域名 ohmycrab.top"
- [ ] 验证 Agent 调用的 Playwright 工具种类 >= 5（应包含 navigate, click, type/fill_form, snapshot, screenshot）
- [ ] 中途 `tools.search` 搜"浏览器点击"能返回 `browser_click`

### 场景 2：`tools.search` 搜索全量 MCP

- [ ] 在 run 中调用 `tools.search` 搜"fill form"
- [ ] 返回结果应包含 `browser_fill_form`（即使它不在初始 `selectedAllowedToolNames` 中）
- [ ] 搜到后，后续 turn 应能成功调用 `browser_fill_form`

### 场景 3：`detectPromptCapabilities` 正则覆盖

- [ ] 发送"帮我去管理后台配置"→ `promptCaps` 应包含 `browser_open`
- [ ] 发送"扫码登录公众号后台"→ `promptCaps` 应包含 `browser_open`
- [ ] 发送"去阿里云的页面"→ `promptCaps` 应包含 `browser_open`

### 场景 4：Server 粒度补齐

- [ ] 确认 Playwright MCP 的全部 ~21 个工具都在 `selectedAllowedToolNames` 中
- [ ] `selectToolSubset` 日志中能看到 Server 补齐的 trace

### 场景 5：非浏览器任务不受影响

- [ ] 发送"帮我写一篇关于海洋的文章"→ 不应出现 Playwright 工具
- [ ] 发送"帮我记一下这个决策"→ memory 工具可用（不影响 CORE_TOOLS 兜底）

### 已有测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

修改后必须通过全部场景。

---

## 7. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/gateway/src/agent/serverToolRunner.ts` | Fix 1 | `listCatalogForDiscovery` 支持全量 MCP 搜索 |
| `apps/gateway/src/agent/toolCatalog.ts` | Fix 2 | `detectPromptCapabilities` browser_open 正则扩展 |
| `apps/gateway/src/agent/toolRetriever.ts` | Fix 2 | `STRONG_BROWSER_RE` 新增"页面" |
| `apps/gateway/src/agent/runFactory.ts` | Fix 3, Fix 4 | MCP Server 粒度补齐 + 动态发现工具放行 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | Fix 4 | 记录 `tools.search` 发现的工具名 |

---

## 8. Codex 讨论记录摘要

本方案经过 Codex 深度分析（threadId: `019ced95-4331-75b0-bf0c-c1b44078356d`）。

**Codex 确认了全部 5 个根因**，并补充：
- `selectMcpServerSubset`（Server 级选择）虽已存在，但后续 tool 级 top-K 仍会把选中 Server 的大量工具裁掉——Server-first 选择被 tool-level top-K 架空
- 同类受害者：Word/Excel MCP、web fallback MCP、任何多工具 MCP Server
- 系统性评估：这是范式级缺陷，不是 Playwright 特有的

**Codex 提供的 4 个 Fix 均被采纳**，Claude 在原始 diff 基础上增加了边界情况说明和设计原则注释。
