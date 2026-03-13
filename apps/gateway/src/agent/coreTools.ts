// 核心工具目录与 opMode 映射（对齐 docs/research/core-tools-exposure-refactor-2026-03-13.md）

export const CORE_TOOL_NAMES = [
  // 时间 / 工具发现
  "time.now",
  "tools.search",
  "tools.describe",

  // Web / KB
  "web.search",
  "web.fetch",
  "kb.listLibraries",
  "kb.search",

  // Run 编排
  "run.mainDoc.get",
  "run.mainDoc.update",
  "run.setTodoList",
  "run.todo",
  "run.done",

  // 文件系统（读/写/编辑/快照/拆分/目录/重命名/删除/列表/打开）
  "read",
  "write",
  "edit",
  "doc.previewDiff",
  "doc.snapshot",
  "doc.splitToDir",
  "mkdir",
  "rename",
  "delete",
  "project.listFiles",
  "file.open",

  // 记忆
  "memory",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export const CORE_TOOL_NAME_SET = new Set<string>(CORE_TOOL_NAMES as readonly string[]);

// 高风险工具：仅在助手模式（opMode=assistant）开放
export const HIGH_RISK_TOOL_NAMES = [
  "shell.exec",
  "code.exec",
  "process.run",
  "process.list",
  "process.stop",
  "cron.create",
  "cron.list",
] as const;

export type HighRiskToolName = (typeof HIGH_RISK_TOOL_NAMES)[number];

export const HIGH_RISK_TOOL_NAME_SET = new Set<string>(HIGH_RISK_TOOL_NAMES as readonly string[]);

export type OpMode = "creative" | "assistant";

export function applyOpModeToBaseAllowedTools(args: {
  baseAllowedToolNames: Set<string>;
  opMode: OpMode;
}): void {
  const { baseAllowedToolNames, opMode } = args;
  if (opMode !== "assistant") {
    // 创作模式：统一剔除高危工具（即使被 toolPolicy/allowlist 打开）
    for (const name of HIGH_RISK_TOOL_NAME_SET) {
      baseAllowedToolNames.delete(name);
    }
  }
}

export function ensureCoreToolsSelected(args: {
  baseAllowedToolNames: Set<string>;
  selectedAllowedToolNames: Set<string>;
}): void {
  const { baseAllowedToolNames, selectedAllowedToolNames } = args;
  // 兜底：确保所有在 baseAllowed 内的 CORE_TOOLS 始终可见，不被 B2 裁剪掉。
  for (const name of CORE_TOOL_NAMES) {
    if (baseAllowedToolNames.has(name)) {
      selectedAllowedToolNames.add(name);
    }
  }
}

