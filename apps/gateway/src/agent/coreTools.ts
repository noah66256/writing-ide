// L0 即时工具：完整 schema 每轮必带（对齐 docs/specs/feat-runtime-tool-exposure-v1.md）
// 内部使用 legacy 名，LLM 边界通过 toolNameBridge 映射到 PascalCase 公共名。

export const CORE_TOOL_NAMES = [
  // 工具发现（ToolSearch 入口）
  "tools.search",
  "tools.describe",

  // Web
  "web.search",
  "web.fetch",

  // Run 编排
  "run.mainDoc.get",
  "run.mainDoc.update",
  "run.todo",
  "run.done",

  // 文件系统
  "read",
  "write",
  "edit",
  "project.listFiles",
  "project.search",

  // 记忆
  "memory",
  // MCP 信息（只读）
  "mcp.info",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export const CORE_TOOL_NAME_SET = new Set<string>(CORE_TOOL_NAMES as readonly string[]);

// 高风险工具：仅在助手模式（opMode=assistant）开放
export const HIGH_RISK_TOOL_NAMES = [
  "Bash",
  "Agent",
  "process.run",
  "process.list",
  "process.stop",
  "cron.create",
  "cron.list",
  "skill.install",
] as const;

export type HighRiskToolName = (typeof HIGH_RISK_TOOL_NAMES)[number];

export const HIGH_RISK_TOOL_NAME_SET = new Set<string>(HIGH_RISK_TOOL_NAMES as readonly string[]);

export type OpMode = "creative" | "assistant";
