# MCP 工具参数归一化范式调研（2026-03-03）

## 背景

现象：同一 MCP 工具在不同调用中出现参数名不一致（如 `path` vs `filename`），导致 `tools/call` 失败。

目标：确定一个不依赖 LLM 记忆、可稳定覆盖多 MCP server 的客户端范式。

## 关键结论（先结论）

1. 参数契约的权威来源是 `tools/list` 返回的 `inputSchema`，客户端应围绕 schema 做调用。
2. 客户端应实现“事件驱动刷新工具注册表”：收到 `notifications/tools/list_changed` 后重新 `tools/list`。
3. 错误处理要区分：
   - 协议错误（请求结构问题）
   - 工具执行错误（业务/参数校验等，`isError: true`）
4. 在工程实践上，建议“分层兜底”：
   - L0：按 schema 直传
   - L1：schema 驱动参数别名归一化
   - L2：一次性错误驱动重试（仅参数缺失/未知字段）
   - 全链路审计（rawArgs / normalizedArgs / error）

## 官方依据

### 1) MCP Tools 规范（官方）
- `tools/list` 用于发现工具；`inputSchema` 定义参数。
- `tools/call` 以 `arguments` 调用。
- `inputSchema` 必须是合法 JSON Schema object。
- 工具变化通过 `notifications/tools/list_changed` 通知，客户端应刷新工具列表。
- 错误分层：
  - 协议错误：如 malformed request
  - 工具执行错误：在结果中 `isError: true`

来源：
- https://modelcontextprotocol.io/specification/draft/server/tools
- https://modelcontextprotocol.io/docs/learn/architecture

### 2) MCP TypeScript SDK Client 指南（官方）
- 客户端基线流程：`listTools()` -> `callTool({ name, arguments })`
- 提供 `listChanged` 机制以自动保持本地工具缓存与服务端同步。

来源：
- https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/client.md
- https://github.com/modelcontextprotocol/typescript-sdk

## 现实约束（GitHub issue 侧证）

- 社区反馈中存在工具 schema 生成/兼容问题，说明“只信 required 字段”在现实中可能不够稳。

来源：
- https://github.com/modelcontextprotocol/typescript-sdk/issues/1028
- https://github.com/modelcontextprotocol/typescript-sdk/issues/324

## 建议的实现范式（客户端）

### A. Registry 层（连接与刷新）
- 启动时 `listTools()` 拉全量 schema。
- 监听 `notifications/tools/list_changed`，收到后立即重新 `listTools()` 刷新。
- 工具缓存键：`serverId + toolName`。

### B. 调用层（参数归一）
- Step 1：直传原始参数。
- Step 2：若 schema 可用，补齐目标参数（仅在缺失时）：
  - 优先 `required`，其次 `properties`。
  - 使用有限别名组（如 `path/file/filepath -> filename`）。
- Step 3：若返回“缺参/未知字段”类错误，仅重试一次。

### C. 审计层（可观测）
- 必记字段：
  - `rawArgs`
  - `normalizedArgs`
  - `rewriteRules`
  - `toolResult`（完整错误文本）
- 避免只返回 `{ok:false}` 这种不可诊断结果。

## 对当前项目的落地建议

1. 保留现有“运行时归一化”方向（不依赖 LLM）。
2. 将归一化从“仅 required”提升为“required + properties + 一次重试”。
3. 保证 MCP 失败输出完整回传到网关审计。
4. 增加 `tools/list_changed` 触发的 sidecar 刷新（若当前链路未覆盖）。

