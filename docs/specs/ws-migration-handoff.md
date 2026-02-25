# SSE → WebSocket 迁移：交接文档

## 一、总体目标

将 Desktop↔Gateway 通信从 **SSE + HTTP POST** 双通道迁移为 **per-run WebSocket 全双工连接**。
分 4 个 Phase 实施，完整方案见 `~/.claude/plans/prancy-beaming-moth.md`。

## 二、完成进度

### Phase 1: Gateway — 提取共享 run 逻辑 ✅ 已完成

- **新增** `apps/gateway/src/agent/runFactory.ts`（2805 行，untracked）
  - 导出 `prepareAgentRun()`、`executeAgentRun()`
  - 类型：`RunServices`、`TransportAdapter`、`PreparedRun`、`PrepareError`
  - 包含从 index.ts 移出的所有 helper（parseContextManifest、buildRunTodoSummary 等）
- **修改** `apps/gateway/src/index.ts`（7665→5167 行）
  - SSE handler 瘦身至 ~60 行，调用 runFactory
  - 删除 7 个已移出的 helper 函数
  - 清理 24 个未使用 import
- **构建验证**：`npm run -w @writing-ide/gateway build` 通过

### Phase 2: Gateway — WS 端点 ✅ 已完成

- **依赖** `@fastify/websocket@10` + `@types/ws` 已安装
- **新增路由** `GET /ws/agent/run`（在 index.ts ~line 1312）
  - WebSocket upgrade + JWT 认证（URL query `?token=xxx`）
  - 等待客户端 `run.request` → `prepareAgentRun` → `executeAgentRun`
  - `tool_result`/`cancel` 走 WS 消息
- **新增函数**：
  - `authenticateWs`（line ~169）— WS preHandler，从 query 提取 token
  - `remapUserSubIfNeeded`（~line 144）— 共享的 sub-ID 重映射
  - `waitForMessage`（~line 1298）— Promise 化的"等第一条 WS 消息"
  - `tryGetJwtUser` 增加 fast path（WS 场景下 request.user 已设置）
- **构建验证**：通过

### Phase 3: Desktop — WS 客户端 🔧 进行中

**已完成的小改动**：
1. `apps/desktop/vite.config.ts` — 已添加 `/ws` proxy（`ws: true`）
2. `apps/desktop/src/agent/gatewayAgent.ts` — 已完成以下小改动：
   - 添加 `import { startGatewayRunWs } from "./wsTransport"`
   - `authHeader` → `export function authHeader`
   - `requireLoginForLlm` → `export function requireLoginForLlm`
   - `GatewayRunController` → `export type GatewayRunController`
   - 新增 `export type GatewayRunArgs`

**尚未完成**（卡在大文件编辑上）：
1. 在 `gatewayAgent.ts` 中插入共享函数 `prepareGatewayRunPayload()` 和 `processServerEvent()`
2. 瘦身 `startGatewayRun()` 使用共享函数
3. 添加 feature flag 分支 `useWebSocketTransport()`
4. 新建 `apps/desktop/src/agent/wsTransport.ts`

### Phase 4: 清理（未开始）

- 默认启用 WS
- 移除 SSE handler、tool_result endpoint、agentRunWaiters
- 移除 feature flag

## 三、Phase 3 详细实施指南

### 3.1 架构设计（已由 Codex 审查确认）

```
gatewayAgent.ts
├── prepareGatewayRunPayload(args, deps)   ← 新增导出函数
│   提取所有请求前逻辑：refs、selector v1、context pack、toolSidecar、dialogue summary
│   返回 { promptForGateway, contextPack, toolSidecar }
├── processServerEvent(evt, ctx)           ← 新增导出函数
│   统一事件处理（run.start, assistant.delta, tool.call, tool.result, error 等）
│   返回 { stopRun: boolean }
├── useWebSocketTransport()                ← 新增
│   env VITE_AGENT_TRANSPORT=ws 或 localStorage writing-ide.agentTransport=ws
└── startGatewayRun(args)                  ← 修改
    if (useWebSocketTransport()) return startGatewayRunWs(args);
    // 原 SSE 逻辑，改用 prepareGatewayRunPayload + processServerEvent

wsTransport.ts（新文件）
└── startGatewayRunWs(args)
    WebSocket 连接 → send run.request → onmessage 调 processServerEvent
    tool_result 走 ws.send
    cancel 走 ws.send + ws.close
```

### 3.2 关键类型定义

```typescript
export type GatewayServerEvent = {
  event: string;
  data: unknown;  // SSE 传 string，WS 传已解析对象
};

export type PrepareGatewayRunPayloadDeps = {
  abort: AbortController;
  setActivity: RunStoreApi["setActivity"];
  bumpProgress: () => void;
  log: RunStoreApi["log"];
};

export type RunEventContext = {
  args: GatewayRunArgs;
  abort: AbortController;
  // Store actions
  setRunning, setActivity, addAssistant, appendAssistantDelta,
  finishAssistant, patchAssistant, addTool, patchTool, log;
  // Mutable state
  runId: string | null;
  assistantId: string | null;
  currentAssistantId: string | null;
  subAgentBubbles: Map<string, string>;
  gatewayToolStepIdsByCallId: Map<string, string[]>;
  // Transport-specific callback
  submitToolResult: (payload: any) => Promise<void>;
  // SSE: HTTP POST to /api/agent/run/{runId}/tool_result
  // WS:  ws.send({ type: "tool_result", payload })
};
```

### 3.3 WS 消息协议

```
Client → Server:
  { type: "run.request", payload: { model, mode, prompt, contextPack, toolSidecar, targetAgentIds? } }
  { type: "tool_result", payload: { toolCallId, name, ok, output, meta? } }
  { type: "cancel", payload: { reason? } }

Server → Client:
  { type: "event", payload: { event: "run.start"|"assistant.delta"|..., data: {...} } }
  { type: "error", payload: { code: string, message: string } }
```

### 3.4 WS URL 构造

```typescript
function toWsBase(baseUrl: string): string {
  // "" (dev/Vite proxy) → ws://localhost:5173
  // "http://localhost:8000" → "ws://localhost:8000"
  // "https://api.example.com" → "wss://api.example.com"
}
// 完整 URL: ${wsBase}/ws/agent/run?token=${encodeURIComponent(token)}
```

### 3.5 Feature Flag

```typescript
function useWebSocketTransport(): boolean {
  // 1. env: VITE_AGENT_TRANSPORT=ws|websocket|1|true
  // 2. localStorage: writing-ide.agentTransport=ws|websocket
  // 默认 false（SSE）
}
```

### 3.6 实施建议（避免之前的卡顿问题）

之前卡住的原因：试图在 3000+ 行的 `gatewayAgent.ts` 中间用 Edit tool 插入 600 行代码，超出单次输出 token 限制。

**推荐方式**：用 Python 脚本一次性完成 gatewayAgent.ts 的修改：

```python
# 1. 读取整个文件
# 2. 在 line 1956（startGatewayRun 之前）插入共享函数块
# 3. 替换 startGatewayRun 的 body：
#    - 添加 feature flag 入口
#    - 用 prepareGatewayRunPayload 替换内联的预请求逻辑（lines 2057-2398）
#    - 用 processServerEvent 替换内联的事件处理循环（lines 2577-3007）
#    - 更新 cleanup 引用（currentAssistantId → eventCtx.currentAssistantId）
# 4. 写回文件
```

或者更安全的方式：
1. 先用 Write 创建 `wsTransport.ts`（它不依赖共享函数，可以自带事件处理）
2. `gatewayAgent.ts` 只做最小改动：在 `startGatewayRun` 开头加 feature flag
3. Phase 4 时再统一提取共享函数

### 3.7 Codex Session ID

之前的 Codex 对话 session：`019c8e1c-e5f3-79c1-8836-702fa4a14884`
可用 `SESSION_ID` 继续对话获取更多细节。

## 四、当前文件状态

### 已修改（未提交）

| 文件 | 状态 | 说明 |
|------|------|------|
| `apps/gateway/src/index.ts` | M | Phase 1+2：瘦身 SSE handler + WS 端点 |
| `apps/gateway/package.json` | M | 添加 @fastify/websocket |
| `apps/desktop/vite.config.ts` | M | 添加 /ws proxy |
| `apps/desktop/src/agent/gatewayAgent.ts` | M | 部分 Phase 3 改动（exports + import） |
| 其他 desktop/gateway 文件 | M | 用户之前的功能开发（非本任务） |

### 新增（untracked）

| 文件 | 说明 |
|------|------|
| `apps/gateway/src/agent/runFactory.ts` | Phase 1 核心：提取的 run 逻辑 |
| `apps/desktop/src/agent/wsTransport.ts` | Phase 3：**待创建** |

### 重要提醒

- 用户的工作树有**大量其他未提交改动**（InputBar、NavSidebar、conversationStore 等），与本任务无关，不要动
- `runFactory.ts` 是基于用户**之前的工作树版本**生成的（含 AgentPersona 等特性），与当前 committed 版本的 index.ts 有差异，但构建通过
- index.ts 在 Phase 1 重构过程中丢失过工作树变更（误执行 `git checkout --`），已用 Python 脚本从 committed 版本重建

## 五、验证方法

Phase 3 完成后：
1. `npm run -w @writing-ide/gateway build` — Gateway 构建通过
2. `npx tsc --noEmit -p apps/desktop/tsconfig.json`（或等效）— Desktop 类型检查通过
3. 启动 gateway + desktop：`npm run dev`
4. 默认走 SSE（feature flag off），确认行为不变
5. `localStorage.setItem("writing-ide.agentTransport", "ws")` → 刷新 → 确认走 WS
6. 执行完整写作任务（含 kb.search + lint.copy + lint.style），对比一致性
