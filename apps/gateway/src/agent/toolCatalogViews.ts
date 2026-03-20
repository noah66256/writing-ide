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
  return buildToolCatalog({
    mode: args.mode,
    allowedToolNames: allowed,
    mcpTools: Array.isArray(args.mcpTools) ? args.mcpTools : [],
  });
}

export function buildSelectionCatalog(args: {
  modelVisibleCatalog: ToolCatalogEntry[];
}): ToolCatalogEntry[] {
  return Array.isArray(args.modelVisibleCatalog) ? args.modelVisibleCatalog.slice() : [];
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
