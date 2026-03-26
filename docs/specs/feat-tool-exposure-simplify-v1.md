# 工具管理架构简化：对标 Claude Code 两层模型（v1）

> 目标：把 Crab 的工具管理从自建 4+1 层过滤简化为 CC 验证过的 2 层模型（Always Visible + Deferred），删除全部多余的过滤/路由/门禁层，同时清理 pi 框架切换后残留的 legacy 代码。

---

## 0. 需求卡片

**场景**：用户先聊天讨论，再说"画个 macbook"——系统因 intent router 把画图降级为 analysis_readonly，MCP 工具全被裁掉，模型找不到生图工具。类似 bug 反复出现在各种"先聊后做"的场景。

**目标**：
1. 工具名对齐 CC 命名（Read/Write/Edit/Bash/Glob/Grep/Agent 等）
2. 渐进式暴露简化为 2 层（Always Visible + Deferred）
3. 删除 intent router / selectMcpServerSubset / BM25 retrieval / per-turn gating / effectiveToolPolicy 五层过滤
4. 清理 pi 框架切换后的 legacy 残留（writingAgentRunner.ts / pipelineExecutor.ts）

**对标**：Claude Code CLI 2.1.80

**约束**：不留技术债，风格仿写的 per-turn 依赖也一起砍

---

## 1. CC 架构对标

### CC 的 2 层模型

| 层 | 内容 | 实现方式 |
|---|------|---------|
| **Always Visible** | ~15 个核心工具（Read/Write/Edit/Bash/Glob/Grep/Agent/WebSearch/WebFetch/TodoWrite/NotebookEdit/Memory/ToolSearch 等） | 完整 schema 注册到 LLM，system prompt 详细描述 |
| **Deferred** | 所有 MCP 工具 + 低频内置工具 | 只在 `<available-deferred-tools>` 中列名字，模型调 ToolSearch 获取完整 schema 后再调用 |

CC 的关键设计原则：
- **工具永远可发现**——不存在"基于对话内容裁掉工具"的逻辑
- **权限只在执行时拦截**——不影响可见性
- **Plan Mode 是唯一的模式切换**——只限制写工具
- **MCP 工具全部 deferred**——`isDeferredTool(tool) { if (tool.isMcp) return true; }`

### 我们要删的 4+1 层

| 层 | 位置 | bug 历史 |
|---|------|---------|
| Intent Router | runFactory.ts:239-312 | #8: "画个"被判成 analysis_readonly |
| selectMcpServerSubset | toolCatalog.ts:346-447 | #5: "画个"不匹配正则导致 crab-image 被 prune |
| BM25 Tool Retrieval | toolRetriever.ts:139-258 | 各种工具丢失 |
| Per-turn Gating | GatewayRuntime.ts computePerTurnAllowed | 连锁反应难追踪，风格仿写依赖 |
| effectiveToolPolicy 预裁剪 | runFactory.ts:3741-3787, coreTools.ts:54-67 | 可见性受权限影响，不符合 CC 模型 |

### 目标架构（B1 方案）

由于 pi-agent-core 的 `agentLoop` 不支持动态 tools（`PiLoopKernel.ts:153` 一次性传入），选择 **B1**：

```
┌─────────────────────────────────────────────┐
│ Always Visible（全量注册到 kernel）          │
│ ~15 核心工具 + 全量 MCP 工具                │
│ 完整 schema 给 pi-agent-core               │
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│ System Prompt 渐进式暴露                     │
│ 核心工具：详细描述 + 使用指南               │
│ MCP 工具：一行摘要 + "用 tools.search 了解" │
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│ 执行时权限（保留）                           │
│ portable policy / opMode / 高风险审批        │
└─────────────────────────────────────────────┘
```

全部工具注册到 kernel，但 system prompt 只详细描述核心工具。MCP 工具在能力摘要中列名，模型通过 `tools.search` / `tools.describe` 按需了解详情。

---

## 2. 现状地图

### 文件改动清单

#### P0 必须做（架构目标）

| 文件 | 改动类型 | 行号 | 说明 |
|------|---------|------|------|
| `runFactory.ts` | 大改 | 239-312, 742, 1205, 2007, 3383-3635, 3758-3787, 3954-4043, 4094-4231, 4626-4696, 6195-6253, 6453-6458 | 删 intent router / MCP server-first / BM25 主链 / per-turn gating / effectiveToolPolicy |
| `toolCatalog.ts` | 大删 | 72-81, 346-447, 482+ | 删 ROUTE_CAPABILITY_MAP / selectMcpServerSubset / selectToolSubset |
| `GatewayRuntime.ts` | 大改 | 785-788, 945-961, 1763-1863, 2893, 3094, 3425, 3588-3601, 3982, 4281 | 删 effectiveAllowed / orchestratorMode / per-turn gate / sticky tools |
| `styleOrchestrator.ts` | 部分删 | 44, 52, 248 | 删 StyleTurnCaps / buildStyleSnapshot / computeStyleTurnCaps；保留 runOrchestratedStyleImitate |
| `pipelineExecutor.ts` | 整文件删 | 全部 | 已是死代码 |
| `writingAgentRunner.ts` | 整文件删 | 全部 | 类型迁移到新 types.ts 后删除 |
| `coreTools.ts` | 部分删 | 54, 67 | 删 applyOpModeToBaseAllowedTools / ensureCoreToolsSelected |
| `toolCatalogViews.ts` | 部分删 | 45 | 删 buildSelectionCatalog |
| `workflowPhaseInterpreter.ts` | 修改 | 153 | 删除返回值中的 orchestratorMode |
| `runMachine.ts` | 修改 | 109, 112, 246-247 | 删除 stickyToolNames / lastToolNotAllowedName |

#### P1 应该做（文案/摘要对齐）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `contextAssembler.ts` | 修改 | 修改 MCP 摘要，删除"selected server"语义 |
| `serverToolRunner.ts` | 修改 | `buildDiscoveryCatalog` 默认全量 MCP；L0 名单与 coreTools 单一来源 |
| `toolCatalogViews.ts` | 修改 | 去掉 includeAllMcpTools 分支 |
| `compositeTask.ts` | 部分删 | 删 getCompositeServerSelectionBudget / getCompositePreferredServerIds |

#### 新建文件

| 文件 | 说明 |
|------|------|
| `apps/gateway/src/agent/types.ts` | 从 writingAgentRunner.ts 迁移的共享类型：RunContext / WaiterMap / SseWriter / ToolResultPayload / ModelApiType / PortablePreRunCompactHint |

---

## 3. 实施方案

### Step 1：类型迁移（P0，前置依赖）

**目标**：将 `writingAgentRunner.ts` 中被广泛消费的类型抽到独立文件，为后续删除扫清障碍。

**新建** `apps/gateway/src/agent/types.ts`：
- 迁移 `RunContext`（writingAgentRunner.ts:101）
- 迁移 `WaiterMap`（writingAgentRunner.ts:82）
- 迁移 `SseWriter`（writingAgentRunner.ts:57）
- 迁移 `ToolResultPayload`（writingAgentRunner.ts:59）
- 迁移 `ModelApiType`（writingAgentRunner.ts:84）
- 迁移 `PortablePreRunCompactHint`（writingAgentRunner.ts:90）

**受影响的 import 修改**（7 个文件）：
- `runFactory.ts:95`
- `GatewayRuntime.ts:60`
- `styleOrchestrator.ts:2`
- `runtime/types.ts:8`
- `SubAgentExecutionBridge.ts:15`
- `collabRuntime.ts:5`
- `provider/PiProviderBridge.ts:29`

### Step 2：删除整文件（P0）

**删除** `pipelineExecutor.ts`：
- 清掉 runFactory.ts 中的 import 和引用（2702, 2836, 4870-4871, 6746 行）

**删除** `writingAgentRunner.ts`：
- Step 1 完成后所有 import 已迁移

### Step 3：删除 Intent Router（P0）

**runFactory.ts**：
- 删除 `ROUTE_REGISTRY_V1`（239-312 行）
- 删除 `buildRouteDecisionV1()`（742 行）——替换为轻量版 `buildExecutionContract()`，只基于 mode + 显式意图
- 删除 LLM Router 执行块（3383-3635 行）
- 删除 `buildProjectSearchRoutePolicy()`（405 行）
- 删除 `extractDeleteTargetsHint()`（2146 行）
- 修改 `buildAgentProtocolPrompt()`（1205 行）——去掉 routeId 分支，改为描述 Always Visible 核心工具 + Deferred MCP 发现方式
- 删除 route 驱动的事件/notice（6195-6253 行）
- 修改澄清分支（6253 行）——不再依赖 `intentRoute.nextAction === "ask_clarify"`

**toolCatalog.ts**：
- 删除 `ROUTE_CAPABILITY_MAP`（72-81 行）

### Step 4：删除 selectMcpServerSubset（P0）

**toolCatalog.ts**：
- 删除 `selectMcpServerSubset()`（346-447 行）
- 删除 `filterMcpToolsByServerIds()`（449 行）
- 删除 `McpServerSelectionSummary` 类型（65 行）

**runFactory.ts**：
- 修改 `mcpToolsForRun`（4043 行）——直接等于 `mcpToolsFromSidecar`（全量）
- 修改 `runtimeToolSidecar`（6453-6458 行）——传全量 MCP
- 删除 server selection 主链（3954-4043 行）
- 删除 MCP server selection notice（5968 行）

### Step 5：删除 BM25 主链调用（P0）

**runFactory.ts**：
- 删除主链中的 `retrieveToolsForRun()` / `selectToolSubset()` 调用（4094-4231 行）
- 删除 toolRetrieval notice（6045 行）

**保留** `toolRetriever.ts`——只供 `tools.search` 内部使用。

**toolCatalog.ts**：
- 删除 `selectToolSubset()`（482 行）

**toolCatalogViews.ts**：
- 删除 `buildSelectionCatalog()`（45 行）

### Step 6：删除 Per-turn Gating + effectiveToolPolicy（P0）

**runFactory.ts**：
- 删除 `effectiveToolPolicy` 预裁剪（3758-3787 行）
- 删除 `computePerTurnAllowed()` 完整实现（4626-4696 行）
- 删除 `PHASE_CONTRACTS_V1` / `ALWAYS_ALLOW_TOOL_NAMES` 传递（4696 行）
- 修改 `toolDiscoveryContract`（3789 行）——不再绑定 effectiveToolPolicy

**GatewayRuntime.ts**：
- 删除 `effectiveAllowed` / `orchestratorMode` 状态（785-788 行）
- 修改 run 启动（945-961 行）——直接用全量 declared tools，不预算 turn0 gate
- 删除 `_transformContext()` 的 per-turn gate 分支（1763 行）
- 删除编排者长文本阻断（1858 行）
- 修改 `_buildAgentTools()`（2893 行）——从全量 declared set 构建
- 删除 `_executeAgentTool()` 的 soft gate `TOOL_NOT_ALLOWED_THIS_TURN`（3094 行）
- 删除 `style_imitate.run` 内部的 effectiveAllowed bypass（3425 行）
- 删除 discoveredMcpToolNames 追踪（3588-3601 行）
- 删除 stickyToolNames 维护（4281 行）
- 删除 TOOL_NOT_ALLOWED_THIS_TURN runState 特判（3982 行）

**coreTools.ts**：
- 删除 `applyOpModeToBaseAllowedTools()`（54 行）
- 删除 `ensureCoreToolsSelected()`（67 行）
- 保留 `CORE_TOOL_NAMES` / `HIGH_RISK_TOOL_NAME_SET`

### Step 7：清理 Style Workflow 依赖（P0）

**styleOrchestrator.ts**：
- 删除 `StyleTurnCaps` 类型（44 行）
- 删除 `buildStyleSnapshot()`（52 行）
- 删除 `computeStyleTurnCaps()`（248 行）
- 保留 `runOrchestratedStyleImitate()`（313 行）——实际执行闭环

**workflowPhaseInterpreter.ts**：
- 删除返回值中的 `orchestratorMode`（153 行）

**runMachine.ts**：
- 删除 `stickyToolNames`（109 行）
- 删除 `lastToolNotAllowedName`（112 行）
- 保留 `hasToolsSearch` / `hasToolsDescribe`（95 行）

### Step 8：上下文/文案对齐（P1）

**contextAssembler.ts**：
- 修改 `BuildAssembledContextArgs`（70-74 行）——删除 `mcpServerSelectionSummary`
- 修改 MCP 摘要 helper（348 行）——删除 `selectedServerIds` 依赖
- 修改文案（520-572 行）——从"本轮已筛选"改为"已声明的工具池 + 已连接的 MCP 家族"

**serverToolRunner.ts**：
- `buildDiscoveryCatalog()` 默认全量 MCP（706-721 行）
- `L0_TOOL_NAMES` 从 coreTools.ts 导入（826 行）

**buildAgentProtocolPrompt()**：
- 删除"未在工具列表中出现的能力先 tools.search"这句（1339 行）——B1 下工具已全量注册
- 改为：核心工具详细描述 + "已连接的 MCP 工具可通过 tools.search/tools.describe 了解详情"

---

## 4. 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| 删 Intent Router | 所有 run 的工具可见性 | 低：删除限制，工具只会变多不会变少 | 执行时权限仍在 |
| 删 selectMcpServerSubset | MCP 工具可见性 | 低：全量 MCP 暴露，模型自行选择 | tools.search 仍可用于发现 |
| 删 BM25 主链 | 主链工具选择 | 低：已经不控制 allowed set | 保留给 tools.search 内部 |
| 删 per-turn gating | 风格仿写工具门禁 | 中：风格仿写不再有阶段化工具限制 | 用户明确说"不管它"；runOrchestratedStyleImitate 的核心执行逻辑保留 |
| 删 effectiveToolPolicy | 高风险工具可见性 | 低：执行时拦截仍在（portable policy/opMode/审批链） | 可见≠可执行 |
| 删 writingAgentRunner.ts | 类型依赖 | 低：类型迁移后无运行时影响 | Step 1 先迁移 |
| 全量 MCP 注册 | kernel tools 数量增加 | 中：40-80 工具可能影响模型选择准确率 | CC 证明模型能从 100+ 工具中选对；system prompt 只详细描述核心工具引导模型 |
| 子 Agent 工具池放大 | portable fork | 低：fork 本来就应该继承完整能力 | 与 CC 的 Agent 行为一致 |

---

## 5. 验证 checklist

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

### 场景验证

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| 新 session "画个 macbook" | crab-image generate_image 被调用 | DevTools 日志 tool.call |
| 先聊提示词技巧，再说"画个小红书博主" | crab-image 仍可用（不被降级为 analysis） | DevTools 日志 tool.call |
| generate_image 后说"修一下" | edit_image 拿到上一张图 | Electron 日志 [CrabImage-IPC] |
| 上传图片 + "帮我抠白底" | edit_image 自动注入上传图 | 同上 |
| Playwright 导航后搜索 | 搜索工具正常可用 | 工具执行成功 |
| 风格仿写 skill 激活 | 仿写流程不崩溃（但不再有阶段化门禁） | 执行完成 |
| tools.search "生图" | 返回 crab-image 工具 | 工具结果 |
| tools.describe "mcp.crab-image.generate_image" | 返回完整 schema | 工具结果 |

### 边界检查

- [ ] 编译通过（`npm -w @ohmycrab/gateway run build`）
- [ ] 无循环 import（类型迁移后）
- [ ] MCP 工具名编码仍正确（`_encodeRuntimeToolName` 未受影响）
- [ ] 执行时权限拦截仍工作（portable policy / opMode / 高风险审批）

---

## 6. 实施优先级与执行顺序

```
Step 1: 类型迁移（writingAgentRunner → types.ts）
Step 2: 删除整文件（pipelineExecutor.ts + writingAgentRunner.ts）
Step 3: 删除 Intent Router
Step 4: 删除 selectMcpServerSubset
Step 5: 删除 BM25 主链调用
Step 6: 删除 Per-turn Gating + effectiveToolPolicy
Step 7: 清理 Style Workflow 依赖
Step 8: 上下文/文案对齐
```

每个 Step 完成后应能编译通过。Step 1-2 是前置依赖。Step 3-7 可并行但建议按序（减少合并冲突）。Step 8 最后做。

---

## 7. 涉及文件清单

### 删除文件

| 文件 | 原因 |
|------|------|
| `apps/gateway/src/agent/pipelineExecutor.ts` | 已是死代码 |
| `apps/gateway/src/agent/writingAgentRunner.ts` | 类型迁移后无用 |

### 新建文件

| 文件 | 说明 |
|------|------|
| `apps/gateway/src/agent/types.ts` | 共享类型：RunContext / WaiterMap / SseWriter 等 |

### 修改文件

| 文件 | 改动量 |
|------|--------|
| `apps/gateway/src/agent/runFactory.ts` | 大改（删 ~800 行，改 ~200 行） |
| `apps/gateway/src/agent/toolCatalog.ts` | 大删（删 ~300 行） |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 大改（删 ~200 行，改 ~100 行） |
| `apps/gateway/src/agent/styleOrchestrator.ts` | 部分删（~100 行） |
| `apps/gateway/src/agent/coreTools.ts` | 部分删（~30 行） |
| `apps/gateway/src/agent/toolCatalogViews.ts` | 部分删（~30 行） |
| `apps/gateway/src/agent/contextAssembler.ts` | 修改文案（~50 行） |
| `apps/gateway/src/agent/serverToolRunner.ts` | 小改（~20 行） |
| `apps/gateway/src/agent/compositeTask.ts` | 部分删（~50 行） |
| `packages/agent-core/src/workflowPhaseInterpreter.ts` | 小改（删 orchestratorMode） |
| `packages/agent-core/src/runMachine.ts` | 小改（删 stickyToolNames 等） |
| `apps/gateway/src/agent/runtime/types.ts` | import 路径修改 |
| `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts` | import 路径修改 |
| `apps/gateway/src/agent/runtime/collabRuntime.ts` | import 路径修改 |
| `apps/gateway/src/agent/runtime/provider/PiProviderBridge.ts` | import 路径修改 |
