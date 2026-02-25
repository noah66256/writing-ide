# MCP 接入规范 v0.1

> 本文档定义了如何在写作 IDE 中接入和管理 MCP（Model Context Protocol）服务器。MCP 是 Anthropic 提出的模型上下文协议，允许 AI 应用通过标准化接口连接外部工具和数据源。

## 1. 概述

### 1.1 什么是 MCP

MCP 提供标准化的客户端-服务器架构：
- **MCP Server**：暴露工具（tools）、资源（resources）和提示模板（prompts）的服务端
- **MCP Client**：连接到 MCP Server 并调用其能力的客户端（本产品的 Desktop 或 Gateway）

### 1.2 在写作 IDE 中的定位

MCP 是扩展 Agent 能力的第三种方式（另两种：内置工具、Skill 技能）：
- **内置工具**：系统预置，由 Desktop 或 Gateway 直接执行
- **Skill**：通过 prompt 注入增强 Agent 行为
- **MCP**：通过标准协议连接外部服务，获取更多工具和数据源

## 2. 核心接口

```typescript
type McpServerDefinition = {
  id: string;                    // 唯一标识（如 "jiguang-ads"）
  name: string;                  // 显示名称（如 "聚光投放"）
  description: string;           // 功能描述
  version: string;               // 版本号
  transport: McpTransport;       // 通信方式
  enabled: boolean;              // 是否启用

  // stdio 模式
  command?: string;              // 启动命令（如 "npx"）
  args?: string[];               // 命令参数（如 ["-y", "@anthropic/mcp-server-filesystem"]）
  env?: Record<string, string>;  // 环境变量
  cwd?: string;                  // 工作目录

  // HTTP/SSE 模式
  endpoint?: string;             // 服务器 URL（如 "http://localhost:3100/mcp"）
  headers?: Record<string, string>; // 请求头（如 API Key）

  // 认证（可选）
  auth?: McpAuth;

  // 工具过滤（可选）
  toolFilter?: {
    allow?: string[];            // 只暴露这些工具给 Agent
    deny?: string[];             // 隐藏这些工具
  };

  // 来源
  source?: "builtin" | "user" | "admin";
};

type McpTransport = "stdio" | "streamable-http" | "sse";

type McpAuth = {
  type: "api_key" | "oauth2" | "bearer";
  // api_key: 从 env 中读取
  // oauth2: 需要 clientId/clientSecret/tokenUrl
  // bearer: 固定 token
  configFields?: string[];       // 用户需要在设置页填写的字段
};
```

## 3. 配置存储

### 3.1 存储位置

```
userData/
  mcp-servers.json               // MCP Server 配置列表
```

### 3.2 配置格式

```json
{
  "version": 1,
  "servers": [
    {
      "id": "filesystem",
      "name": "文件系统",
      "description": "读写本地文件",
      "version": "1.0.0",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/path/to/allowed/dir"],
      "enabled": true,
      "source": "user"
    },
    {
      "id": "web-search",
      "name": "联网搜索",
      "description": "通过 MCP 提供联网搜索能力",
      "version": "1.0.0",
      "transport": "streamable-http",
      "endpoint": "http://localhost:3100/mcp",
      "enabled": true,
      "source": "user"
    }
  ]
}
```

## 4. 生命周期

### 4.1 连接管理

```
应用启动
    ↓
读取 mcp-servers.json
    ↓
├─ stdio: 启动子进程，建立 JSON-RPC 通信
└─ http/sse: 建立 HTTP 连接
    ↓
调用 initialize → 获取 capabilities
    ↓
调用 tools/list → 获取可用工具列表
    ↓
工具注入 Agent 可用工具池
```

### 4.2 工具调用

```
Agent 决定调用 MCP 工具
    ↓
Gateway/Desktop 路由到对应 MCP Client
    ↓
MCP Client → tools/call → MCP Server
    ↓
结果返回 → 转为标准 ToolResult 格式
    ↓
返回给 Agent
```

### 4.3 断开与重连

- MCP Server 崩溃时自动重连（最多 3 次，间隔递增）
- 用户在设置页可手动断开/重连
- 应用退出时优雅关闭所有连接

## 5. 与 Agent 集成

### 5.1 工具命名

MCP 工具以 `mcp.{serverId}.{toolName}` 格式注册到工具池：

```
mcp.filesystem.read_file
mcp.filesystem.write_file
mcp.web-search.search
```

### 5.2 子 Agent 配置

子 Agent 的 `mcpServers` 字段控制其可访问的 MCP Server：

```typescript
{
  id: "researcher",
  mcpServers: ["web-search"],   // 只能使用 web-search MCP Server 的工具
}
```

### 5.3 权限控制

- `toolFilter.allow/deny`：Server 级别的工具过滤
- 子 Agent `tools` 白名单：Agent 级别的工具过滤
- `toolPolicy`：Agent 级别的执行策略（影响所有工具包括 MCP）

## 6. 设置页 UI

设置 > MCP 标签页应提供：

| 功能 | 说明 |
|------|------|
| 添加 Server | 选择 transport 模式，填写连接信息 |
| 启用/禁用 | 开关控制 |
| 状态显示 | 已连接/断开/错误 + 可用工具数 |
| 工具列表 | 展开查看该 Server 暴露的工具 |
| 编辑/删除 | 修改配置或移除 |
| 测试连接 | 验证配置是否正确 |

## 7. 实现路径

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 接口定义 + 配置存储 + 设置页 UI | 进行中 |
| Phase 2 | MCP Client 实现（stdio + HTTP） | 规划中 |
| Phase 3 | 工具注入 Agent + 权限控制 | 规划中 |
| Phase 4 | 首个实用 MCP Server 接入 | 规划中 |

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-22 | v0.1 | 初稿：McpServerDefinition 接口、配置存储、生命周期、集成方式 |
