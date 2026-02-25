# 负责人自主配置能力 v0.1

> 本文档规划"负责人自主添加 Agent / MCP Server / Skill"的功能方案。用户不需要懂技术细节，只需在对话中告诉负责人要添加什么，负责人通过系统工具完成配置。

## 1. 概述

### 1.1 问题

当前系统中 Agent、Skill、MCP Server 的定义都是**硬编码**在代码中的：
- `BUILTIN_SUB_AGENTS`（`packages/agent-core/src/subAgent.ts`）
- `SKILL_MANIFESTS_V1`（`packages/agent-core/src/skills.ts`）
- MCP Server 尚未实装

用户无法通过 UI 或对话动态添加新角色/技能/外部工具。

### 1.2 目标

让负责人（主 Agent）具备通过对话自主配置系统的能力：

```
用户："帮我加一个视频剪辑助手，能调用 ffmpeg 和字幕工具"
负责人：
  1. 调用 system.addAgent 创建 "video-editor" 子 Agent
  2. 调用 system.addMcpServer 接入 ffmpeg MCP Server
  3. 向用户确认配置完成，新 Agent 立即可用
```

### 1.3 设计原则

- **对话驱动**：用户用自然语言描述需求，负责人翻译为具体配置
- **proposal-first**：所有配置变更先提案，用户确认后才生效
- **可回滚**：每次配置变更记录版本，支持撤销
- **安全边界**：system.* 工具仅主 Agent 可调用，子 Agent 不可用

## 2. 系统工具定义

### 2.1 Agent 管理

```typescript
// 添加子 Agent
"system.addAgent": {
  input: {
    id: string;                    // kebab-case，如 "video-editor"
    name: string;                  // 显示名称，如 "视频剪辑助手"
    avatar?: string;               // emoji 或图片 URL
    description: string;           // 一句话职责
    systemPrompt: string;          // 完整 system prompt
    tools: string[];               // 工具白名单
    skills?: string[];             // 技能列表
    mcpServers?: string[];         // MCP Server ID 列表
    model?: string;                // 偏好模型（默认 "sonnet"）
    toolPolicy?: ToolPolicy;       // 工具策略（默认 "proposal_first"）
    budget?: Partial<AgentBudget>; // 执行预算（有默认值）
    triggerPatterns?: string[];    // 触发关键词
  };
  output: { ok: boolean; agentId: string; error?: string };
}

// 列出所有子 Agent（含内置 + 用户自定义）
"system.listAgents": {
  input: {};
  output: {
    agents: Array<{
      id: string;
      name: string;
      source: "builtin" | "user";
      enabled: boolean;
      tools: string[];
      model: string;
    }>;
  };
}

// 更新子 Agent
"system.updateAgent": {
  input: {
    agentId: string;
    patch: Partial<Omit<SubAgentDefinition, "id">>;
  };
  output: { ok: boolean; error?: string };
}

// 删除用户自定义 Agent（内置不可删）
"system.removeAgent": {
  input: { agentId: string };
  output: { ok: boolean; error?: string };
}
```

### 2.2 MCP Server 管理

```typescript
// 添加 MCP Server
"system.addMcpServer": {
  input: {
    id: string;                    // 如 "ffmpeg-tools"
    name: string;                  // 如 "FFmpeg 工具集"
    description: string;
    transport: "stdio" | "streamable-http" | "sse";
    // stdio 模式
    command?: string;              // 如 "npx"
    args?: string[];               // 如 ["-y", "@anthropic/mcp-server-filesystem"]
    env?: Record<string, string>;
    cwd?: string;
    // HTTP/SSE 模式
    endpoint?: string;             // 如 "http://localhost:3100/mcp"
    headers?: Record<string, string>;
    // 工具过滤
    toolFilter?: { allow?: string[]; deny?: string[] };
  };
  output: { ok: boolean; serverId: string; error?: string };
}

// 列出 MCP Server
"system.listMcpServers": {
  input: {};
  output: {
    servers: Array<{
      id: string;
      name: string;
      transport: string;
      enabled: boolean;
      status: "connected" | "disconnected" | "error";
      toolCount: number;
    }>;
  };
}

// 更新/删除 MCP Server
"system.updateMcpServer": {
  input: { serverId: string; patch: Partial<McpServerDefinition> };
  output: { ok: boolean; error?: string };
}

"system.removeMcpServer": {
  input: { serverId: string };
  output: { ok: boolean; error?: string };
}
```

### 2.3 Skill 管理

```typescript
// 添加用户 Skill
"system.addSkill": {
  input: {
    id: string;                    // 如 "user.seo-check"
    name: string;                  // 如 "SEO 检查"
    description: string;
    priority?: number;             // 默认 50
    triggers: TriggerRule[];       // 激活条件
    promptFragments: {
      system?: string;             // 注入 system prompt
      context?: string;            // 注入 context
    };
    toolCaps?: { allowTools?: string[]; denyTools?: string[] };
    conflicts?: string[];
    requires?: string[];
  };
  output: { ok: boolean; skillId: string; error?: string };
}

// 列出所有 Skill
"system.listSkills": {
  input: {};
  output: {
    skills: Array<{
      id: string;
      name: string;
      source: "builtin" | "user";
      enabled: boolean;
      priority: number;
      badge: string;
    }>;
  };
}

// 列出可用工具（帮助负责人了解有哪些工具可分配）
"system.listTools": {
  input: {};
  output: {
    tools: Array<{
      name: string;
      description: string;
      modes: string[];
    }>;
  };
}
```

## 3. 数据存储

### 3.1 Desktop 本地存储

用户自定义配置存储在 `userData/` 目录下：

```
userData/
  user-agents.json          # 用户自定义 Agent 列表
  user-skills.json          # 用户自定义 Skill 列表
  mcp-servers.json          # MCP Server 配置列表
```

### 3.2 合并策略

运行时合并内置 + 用户自定义配置：

```typescript
// Agent 合并
function getEffectiveAgents(): SubAgentDefinition[] {
  const builtin = BUILTIN_SUB_AGENTS;
  const user = loadUserAgents();           // 从 user-agents.json
  const overrides = teamStore.agentOverrides; // 启用/禁用覆盖
  return mergeAgents(builtin, user, overrides);
}

// Skill 合并（已有 mergeSkillManifests 函数）
function getEffectiveSkills(): SkillManifest[] {
  return mergeSkillManifests({
    builtinOverrides: skillStore.skillOverrides,
    userSkills: loadUserSkills(),           // 从 user-skills.json
  });
}
```

### 3.3 版本控制

每次配置变更生成版本快照：

```typescript
type ConfigSnapshot = {
  version: number;
  timestamp: string;
  action: "add" | "update" | "remove";
  target: "agent" | "skill" | "mcpServer";
  targetId: string;
  before?: unknown;      // 变更前状态
  after?: unknown;       // 变更后状态
};
```

## 4. 执行流程

### 4.1 用户对话触发

```
用户："帮我加一个翻译助手，能翻译中英文"
    ↓
负责人分析需求
    ↓
调用 system.listTools() 了解可用工具
    ↓
构造 SubAgentDefinition
    ↓
调用 system.addAgent({
  id: "translator",
  name: "翻译助手",
  description: "负责中英文互译与术语统一",
  systemPrompt: "你是翻译助手...",
  tools: ["doc.read", "doc.write", "kb.search"],
  model: "haiku",
  toolPolicy: "auto_apply",
  budget: { maxTurns: 10, maxToolCalls: 20, timeoutMs: 60000 },
  triggerPatterns: ["翻译", "translate", "中译英", "英译中"],
})
    ↓
[proposal-first] 向用户展示配置摘要
    ↓
用户确认 → 写入 user-agents.json → 热生效
```

### 4.2 proposal-first 配置确认

system.* 工具采用 proposal-first 模式：

1. 负责人调用 `system.addAgent(...)`
2. 系统不立即写入，而是返回 `{ ok: true, proposal: true, summary: "..." }`
3. 负责人向用户展示配置摘要（名称、工具、模型等）
4. 用户说"确认"/"可以" → 负责人调用 `system.confirmProposal(proposalId)`
5. 配置正式写入并热生效

### 4.3 热生效

配置写入后立即生效，无需重启：

- **Agent**：下次 `agent.delegate` 调用时从合并列表中查找
- **Skill**：下次 `activateSkills()` 调用时从合并列表中匹配
- **MCP**：触发 MCP Client 重连（暂无，待 MCP Client 实装后对接）

## 5. 安全约束

### 5.1 工具权限

- `system.*` 工具仅主 Agent（负责人）可调用
- 子 Agent 的 tools 白名单中不允许包含 `system.*`
- 防止子 Agent 自我提权或修改其他 Agent 配置

### 5.2 配置校验

- `id` 必须符合 kebab-case 格式
- 用户自定义 Agent ID 建议加 `user.` 前缀（与内置区分）
- `tools` 列表中的工具必须在 TOOL_LIST 中注册（防止幻觉工具）
- `systemPrompt` 不能为空或占位符
- `budget` 有上限约束（maxTurns <= 30, timeoutMs <= 300000）

### 5.3 内置保护

- 内置 Agent/Skill 不可删除，只能禁用
- 内置 Agent/Skill 的核心字段不可被用户覆盖（如 id、source）

## 6. 实现路径

| 阶段 | 内容 | 前置依赖 |
|------|------|----------|
| Phase 1 | 数据层：user-agents.json / user-skills.json 读写 + 合并逻辑 | 无 |
| Phase 2 | system.* 工具注册 + Gateway 端点 | Phase 1 |
| Phase 3 | 负责人 system prompt 增加自配置指导 | Phase 2 |
| Phase 4 | 设置页 UI：用户自定义 Agent/Skill 列表管理 | Phase 1 |
| Phase 5 | MCP Server 管理（依赖 MCP Client 实装） | MCP Client |

## 7. 负责人 System Prompt 增强

Phase 3 需要在负责人的 system prompt 中增加自配置指导：

```
当用户要求添加新的团队成员、技能或外部工具时：

1. 先调用 system.listTools() 了解当前可用的工具列表
2. 根据用户描述，构造合适的配置参数
3. 调用 system.addAgent / system.addSkill / system.addMcpServer
4. 向用户确认配置摘要，等待用户确认后生效
5. 配置完成后告知用户如何使用新添加的能力

注意：
- 新 Agent 的 systemPrompt 必须清晰描述角色和职责
- tools 列表只能包含系统中已注册的工具
- 不要给子 Agent 分配 system.* 工具
```

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-22 | v0.1 | 初稿：system.* 工具定义、数据存储、执行流程、安全约束、实现路径 |
