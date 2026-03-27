import { TOOL_LIST } from "@ohmycrab/tools";
import { buildToolCatalog, type McpSidecarTool, type ToolCatalogEntry } from "./toolCatalog.js";

export function buildModelVisibleCatalog(args: {
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;
  mcpTools?: McpSidecarTool[] | null;
}): ToolCatalogEntry[] {
  const allowed =
    args.allowedToolNames ??
    new Set(TOOL_LIST.map((tool) => String(tool?.name ?? "").trim()).filter(Boolean));
  const catalog = buildToolCatalog({
    mode: args.mode,
    allowedToolNames: allowed,
    mcpTools: Array.isArray(args.mcpTools) ? args.mcpTools : [],
  });

  // 注入合成 wrapper 的虚拟 catalog entry（Bash / Agent 不在 TOOL_LIST 中）
  if (allowed.has("shell.exec") || allowed.has("code.exec")) {
    catalog.push({
      name: "Bash",
      source: "builtin",
      description: "执行本机命令或脚本（高风险）。传 command 执行 shell 命令，传 code/entryFile 执行 Python。",
      modes: ["agent"],
      inputSchema: { type: "object", properties: { command: { type: "string" }, code: { type: "string" } }, additionalProperties: true },
      riskLevel: "high",
      capabilities: ["shell_exec", "code_exec"],
    });
  }
  if (allowed.has("spawn_agent")) {
    catalog.push({
      name: "Agent",
      source: "builtin",
      description: "统一的子 Agent 生命周期工具。action=spawn|send|resume|wait|close。",
      modes: ["agent"],
      inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: true },
      riskLevel: "high",
      capabilities: ["collab"],
    });
  }

  return catalog;
}

export function buildDiscoveryCatalogForToolSearch(args: {
  mode: "chat" | "agent";
  allowedToolNames: Set<string> | null;
  mcpTools?: McpSidecarTool[] | null;
  includeAllMcpTools?: boolean;
}): ToolCatalogEntry[] {
  const allowed =
    args.allowedToolNames ??
    new Set(TOOL_LIST.map((tool) => String(tool?.name ?? "").trim()).filter(Boolean));
  const mcpTools = Array.isArray(args.mcpTools) ? args.mcpTools : [];

  if (!args.includeAllMcpTools || mcpTools.length === 0) {
    return buildModelVisibleCatalog({
      mode: args.mode,
      allowedToolNames: allowed,
      mcpTools,
    });
  }

  const expandedAllowed = new Set(allowed);
  for (const tool of mcpTools) {
    const name = String(tool?.name ?? "").trim();
    if (name) expandedAllowed.add(name);
  }

  return buildModelVisibleCatalog({
    mode: args.mode,
    allowedToolNames: expandedAllowed,
    mcpTools,
  });
}

export function summarizeCatalogBySource(catalog: ToolCatalogEntry[]) {
  const entries = Array.isArray(catalog) ? catalog : [];
  return {
    total: entries.length,
    builtin: entries.filter((entry) => entry.source === "builtin").length,
    mcp: entries.filter((entry) => entry.source === "mcp").length,
  };
}
