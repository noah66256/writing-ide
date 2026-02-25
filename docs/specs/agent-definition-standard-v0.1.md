# Sub-Agent 定义规范 v0.1

> 本文档定义了如何创建、注册和管理子 Agent（Sub-Agent）。所有子 Agent 必须遵循 `SubAgentDefinition` 接口标准。

## 1. 核心接口

```typescript
interface SubAgentDefinition {
  id: string;                    // 唯一标识，kebab-case（如 "copywriter"、"seo-specialist"）
  name: string;                  // 显示名称（如 "文案写手"）
  avatar?: string;               // 头像，emoji 或图片 URL
  description: string;           // 一句话职责描述
  systemPrompt: string;          // 完整 system prompt，描述角色、职责和行为约束
  tools: string[];               // 允许使用的工具 ID 列表（白名单，不在列表中的工具会被拒绝）
  skills: string[];              // 允许激活的技能 ID 列表
  mcpServers: string[];          // 允许使用的 MCP Server ID 列表（v0.1 预留，暂未实装）
  model: string;                 // 偏好模型 ID（如 "sonnet"、"haiku"）
  fallbackModels?: string[];     // 降级模型列表，按优先级排列
  toolPolicy: ToolPolicy;        // 工具执行策略
  budget: AgentBudget;           // 执行预算（防失控）
  triggerPatterns?: string[];    // 触发关键词（负责人自动路由时参考）
  priority?: number;             // 路由优先级（数字越大越优先）
  enabled: boolean;              // 是否启用
  version?: string;              // 版本号（语义化版本）
}

type ToolPolicy = "readonly" | "proposal_first" | "auto_apply";

type AgentBudget = {
  maxTurns: number;              // 最大推理轮数（建议 5-20）
  maxToolCalls: number;          // 最大工具调用次数（建议 10-50）
  timeoutMs: number;             // 总超时（毫秒，建议 60000-300000）
};
```

## 2. 字段说明

### 2.1 id

全局唯一，kebab-case 格式。内置 Agent 使用简短 ID（如 `copywriter`），用户自定义 Agent 建议加前缀（如 `user.my-writer`）。

### 2.2 systemPrompt

**最关键的字段**。必须包含：
- 角色定位和职责边界
- 可用工具列表及使用场景
- 输出格式要求
- 禁止事项

**反面教材**：使用占位符（如 `[TODO]`）会导致继承主 Agent 的 prompt，引发工具幻觉调用。

### 2.3 tools（工具白名单）

运行时严格校验：子 Agent 调用不在列表中的工具会收到 `TOOL_NOT_ALLOWED` 错误。设计原则：
- 只列该角色真正需要的工具
- `agent.delegate` 自动排除（防止嵌套委托）
- 工具 ID 必须是系统中已注册的有效工具

### 2.4 toolPolicy

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| `readonly` | 只能使用只读工具 | 分析、调研类 Agent |
| `proposal_first` | 写入操作需先提案再确认 | 写作、编辑类 Agent |
| `auto_apply` | 写入操作直接执行（必须可回滚） | 自动化任务 |

### 2.5 budget

防止子 Agent 失控的硬约束：
- `maxTurns`：达到后强制结束，返回已有产出
- `maxToolCalls`：达到后中止工具调用
- `timeoutMs`：超时后触发 AbortController

## 3. 执行机制

### 3.1 委托流程

1. 负责人（主 Agent）调用 `agent.delegate({ agentId, task })` 工具
2. Gateway 从 `BUILTIN_SUB_AGENTS` 查找对应 Agent
3. 创建 `SubAgentRunContext`：独立 system prompt、工具白名单、独立 AbortController
4. 子 Agent 独立运行，SSE 事件注入 `agentId` 路由到前端对应气泡
5. 执行结果返回给负责人做汇总

### 3.2 并行执行

多个 `agent.delegate` 调用通过 `Promise.all` 并行执行。用户通过 `@` 指定多个 Agent 时，Gateway 自动构造并行委托。

### 3.3 用户 @ 直达

用户在输入框 `@agent名` 可跳过负责人的路由判断，直接委托到指定子 Agent。

## 4. 注册方式

### 4.1 内置 Agent（builtin）

定义在 `packages/agent-core/src/subAgent.ts` 的 `BUILTIN_SUB_AGENTS` 数组中。

### 4.2 用户自定义 Agent（规划中）

通过设置页 > 团队管理 > 添加 Agent，或通过负责人对话式配置。配置存储在用户本地 `userData/agents.json`。

## 5. 示例

```typescript
const copywriter: SubAgentDefinition = {
  id: "copywriter",
  name: "文案写手",
  avatar: "✍️",
  description: "负责风格仿写、文案撰写和内容润色",
  systemPrompt: `你是一位专业的文案写手...（完整 prompt）`,
  tools: ["kb.search", "doc.write", "doc.applyEdits", "lint.style", "lint.copy"],
  skills: ["style_imitate"],
  mcpServers: [],
  model: "sonnet",
  fallbackModels: ["haiku"],
  toolPolicy: "proposal_first",
  budget: { maxTurns: 15, maxToolCalls: 30, timeoutMs: 120_000 },
  triggerPatterns: ["写", "仿写", "文案", "润色", "改稿"],
  priority: 10,
  enabled: true,
  version: "0.1.0",
};
```

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-22 | v0.1 | 初稿：SubAgentDefinition 接口、字段说明、执行机制、注册方式 |
