import { isWriteLikeTool } from "@ohmycrab/agent-core";
import { TOOL_LIST, type ToolMeta, type ToolMode } from "@ohmycrab/tools";

export type ToolCatalogSource = "builtin" | "mcp";

export type ToolCatalogEntry = {
  name: string;
  source: ToolCatalogSource;
  description: string;
  modes: ToolMode[];
  inputSchema?: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  capabilities: string[];
  serverId?: string;
  serverName?: string;
};

export type ToolCatalogSummary = {
  total: number;
  builtin: number;
  mcp: number;
  selected: number;
  pruned: number;
  selectedToolNames: string[];
  prunedToolNames: string[];
  rankingSample: Array<{ name: string; score: number; reasons: string[] }>;
};

export type McpSidecarTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
  serverName?: string;
  originalName?: string;
};

export type McpSidecarServer = {
  serverId: string;
  serverName?: string;
  status?: string;
  toolCount?: number;
  agentToolCount?: number;
  toolNamesSample?: string[];
  familyHint?: string;
  toolProfile?: string;
};

export type McpServerFamily = "browser" | "search" | "word" | "spreadsheet" | "pdf" | "custom";
export type McpServerSessionMode = "stateful" | "stateless" | "unknown";

export type McpServerCatalogEntry = {
  serverId: string;
  serverName: string;
  family: McpServerFamily;
  sessionMode: McpServerSessionMode;
  status: string;
  toolCount: number;
  agentToolCount?: number;
  toolProfile?: string;
  capabilities: string[];
  entryToolNames: string[];
};

export type McpServerSelectionSummary = {
  totalServers: number;
  selectedServerIds: string[];
  prunedServerIds: string[];
  rankingSample: Array<{ serverId: string; family: McpServerFamily; sessionMode: McpServerSessionMode; score: number; reasons: string[] }>;
};

const ROUTE_CAPABILITY_MAP: Record<string, string[]> = {
  file_delete_only: ["run_control", "todo", "file_delete", "file_list"],
  project_search: ["run_control", "project_search", "file_read", "kb_search"],
  web_radar: ["run_control", "web_search", "web_fetch", "time"],
  file_ops: ["run_control", "todo", "file_write", "file_delete", "file_read"],
  task_execution: ["run_control", "todo", "file_write", "project_search", "kb_search"],
  analysis_readonly: ["file_read", "project_search", "kb_search", "time"],
  discussion: ["time"],
  unclear: ["run_control", "todo", "project_search"],
};

const CAPABILITY_KEYWORDS: Array<{ capability: string; re: RegExp }> = [
  { capability: "file_delete", re: /(删|删除|清理|清空|remove|delete|rm\b|del\b)/i },
  { capability: "file_list", re: /(列出|列表|list\s*files|listfiles|文件列表|目录)/i },
  { capability: "file_read", re: /(读取|查看|读|read|open|解析|提取|总结|摘要)/i },
  { capability: "file_write", re: /(写入|改写|创建|新建|保存|rename|move|apply|落盘)/i },
  { capability: "project_search", re: /(搜索|查找|find|grep|rg|全项目|项目内)/i },
  { capability: "web_search", re: /(全网|联网|上网|搜索网页|新闻|热点|最新|today|latest|搜一下|百度一下|google一下|网上搜|大搜)/i },
  { capability: "web_fetch", re: /(网页|url|链接|fetch|抓取|访问|打开百度|打开谷歌|打开网站|打开网页|open\s+.*https?)/i },
  { capability: "kb_search", re: /(知识库|kb|风格库|语料|检索|抽卡|learn|ingest)/i },
  { capability: "code_exec", re: /(code\.exec|python\b|py脚本|python脚本|写(?:一个|一段)?(?:python|py)?(?:脚本|代码)|执行(?:一段)?代码|运行(?:一段)?代码|跑脚本|python-docx|python-pptx|openpyxl|entryfile|requirements)/i },
  { capability: "shell_exec", re: /(命令行|终端|shell|bash|zsh|ssh|\bnpm run\b|\bpnpm\b|\byarn\b|\bpytest\b|\bmake\b|编译|构建|打包|部署)/i },
  { capability: "delegate", re: /(委派|分派|指派|派给|delegate|sub[\s_-]?agent|agent\s*delegate)/i },
  { capability: "browser_open", re: /(打开.*网页|打开网站|浏览器|网站|navigate|open\s+.*(baidu|google|url))/i },
  { capability: "mcp_spreadsheet", re: /(excel|xlsx|表格|电子表格|spreadsheet|工作表)/i },
  { capability: "mcp_word_doc", re: /(word文档|docx|word\s*文件|写.*word|导出.*word|word.*版|生成.*word)/i },
  { capability: "mcp_pdf", re: /(pdf|转.*pdf|导出.*pdf)/i },
];

export function detectPromptCapabilities(prompt: string): Set<string> {
  const text = String(prompt ?? "").trim();
  const out = new Set<string>();
  if (!text) return out;
  for (const rule of CAPABILITY_KEYWORDS) {
    if (rule.re.test(text)) out.add(rule.capability);
  }
  return out;
}

export function inferCapabilities(name: string, description: string, source: ToolCatalogSource): string[] {
  const n = String(name ?? "").trim().toLowerCase();
  const d = String(description ?? "").toLowerCase();
  const caps = new Set<string>();

  if (n.startsWith("run.")) {
    caps.add("run_control");
    if (n.includes("todo")) caps.add("todo");
  }
  if (n === "time.now") caps.add("time");
  if (n.startsWith("doc.delete") || /\bdelete\b|\bremove\b/.test(n)) caps.add("file_delete");
  if (n.startsWith("project.list") || /listfiles|list_files|目录/.test(d)) caps.add("file_list");
  if (n.startsWith("read") || n.startsWith("project.read") || /\bread\b|\bparse\b/.test(n)) caps.add("file_read");
  if (isWriteLikeTool(name)) caps.add("file_write");
  if (n === "doc.snapshot") {
    caps.add("file_read");
    caps.add("file_write");
  }
  if (n === "memory") caps.add("kb_search");
  if (n === "agent.config") caps.add("delegate");
  if (n.startsWith("project.search") || n.startsWith("project.find")) caps.add("project_search");
  if (n.startsWith("web.search")) caps.add("web_search");
  if (n.startsWith("web.fetch")) caps.add("web_fetch");
  if (n.startsWith("kb.")) caps.add("kb_search");
  if (n === "code.exec") caps.add("code_exec");
  if (n === "shell.exec" || /^mcp\.[^.]*?(terminal|ssh)[^.]*\./i.test(n)) caps.add("shell_exec");
  if (n === "agent.delegate") caps.add("delegate");

  if (source === "mcp") {
    caps.add("mcp");
    if (/(search|搜索|web_search|bochasearch|tavily|serp|bing|google)/i.test(`${n} ${d}`)) {
      caps.add("web_search");
    }
    if (
      /(playwright|browser|chrom(e|ium)|firefox|webkit|navigate|browser_navigate|open_url|openurl|goto|go_to)/i.test(n) ||
      /(浏览器|navigate|open url|网页自动化|web automation)/i.test(d)
    ) {
      caps.add("browser_open");
      caps.add("web_fetch");
    }
    const mcpText = `${n} ${d}`;
    if (/(excel|workbook|worksheet|sheet|spreadsheet)/i.test(mcpText)) {
      caps.add("mcp_spreadsheet");
    }
    if (/(word|docx)/i.test(mcpText) || (/(document)/i.test(mcpText) && /(office|word|docx|创建文档|文档转换)/i.test(mcpText))) {
      caps.add("mcp_word_doc");
    }
    if (/(pdf)/i.test(mcpText)) {
      caps.add("mcp_pdf");
    }
  }

  if (caps.size === 0) caps.add("generic");
  return Array.from(caps);
}

function inferRiskLevel(name: string, source: ToolCatalogSource): "low" | "medium" | "high" {
  const n = String(name ?? "").toLowerCase();
  if (n === "code.exec" || /publish|deploy|billing|charge/.test(n)) return "high";
  if (source === "mcp" && /delete|remove|write|exec|run|shell/.test(n)) return "high";
  if (isWriteLikeTool(name) || /delete|remove|write|update|rename|move/.test(n)) return "medium";
  return "low";
}

function toBuiltinEntry(meta: ToolMeta): ToolCatalogEntry {
  return {
    name: String(meta.name ?? "").trim(),
    source: "builtin",
    description: String(meta.description ?? "").trim(),
    modes: Array.isArray(meta.modes) && meta.modes.length > 0 ? meta.modes : (["agent", "chat"] as ToolMode[]),
    inputSchema: meta.inputSchema,
    riskLevel: inferRiskLevel(meta.name, "builtin"),
    capabilities: inferCapabilities(meta.name, meta.description ?? "", "builtin"),
  };
}

function toMcpEntry(meta: McpSidecarTool, mode: ToolMode): ToolCatalogEntry | null {
  const name = String(meta?.name ?? "").trim();
  if (!name) return null;
  const description = String(meta?.description ?? "").trim();
  return {
    name,
    source: "mcp",
    description,
    modes: [mode],
    inputSchema: meta?.inputSchema && typeof meta.inputSchema === "object" ? meta.inputSchema : undefined,
    riskLevel: inferRiskLevel(name, "mcp"),
    capabilities: inferCapabilities(name, description, "mcp"),
    serverId: String(meta?.serverId ?? "").trim() || undefined,
    serverName: String(meta?.serverName ?? "").trim() || undefined,
  };
}

function inferMcpServerFamily(capabilities: string[]): McpServerFamily {
  const caps = new Set((capabilities ?? []).map((x) => String(x ?? "").trim()));
  if (caps.has("browser_open")) return "browser";
  if (caps.has("mcp_word_doc")) return "word";
  if (caps.has("mcp_spreadsheet")) return "spreadsheet";
  if (caps.has("mcp_pdf")) return "pdf";
  if (caps.has("web_search") || caps.has("web_fetch")) return "search";
  return "custom";
}

function inferMcpServerSessionMode(family: McpServerFamily): McpServerSessionMode {
  if (family === "browser" || family === "word" || family === "spreadsheet" || family === "pdf") return "stateful";
  if (family === "search") return "stateless";
  return "unknown";
}

function isLikelyEntryToolName(name: string): boolean {
  const n = String(name ?? "").trim().toLowerCase();
  return /(^|\.)(browser_navigate|navigate|open|open_url|openurl|goto|go_to|create|create_document|create_doc|new|new_document|save|export|create_workbook|new_workbook|get_doc|read_doc|search|fetch|get_page|browser_snapshot)$/.test(n);
}

function normalizeMcpToolVerb(name: string): string {
  const n = String(name ?? "").trim().toLowerCase();
  const parts = n.split(".");
  return parts.length >= 3 ? parts.slice(2).join(".") : n;
}

export type McpToolClass = "entry" | "read" | "write" | "export" | "inspect" | "admin";

export function inferMcpToolClass(args: {
  toolName: string;
  description?: string;
  serverFamily?: McpServerFamily | string | null;
}): McpToolClass {
  const verb = normalizeMcpToolVerb(args.toolName);
  const family = String(args.serverFamily ?? "").trim().toLowerCase();
  const combined = `${verb} ${String(args.description ?? "").toLowerCase()}`;
  if (/(^|[._-])(export|save|download|render|convert|print)(?:$|[._-])/.test(combined)) return "export";
  if (/(^|[._-])(add|append|insert|write|update|replace|set|fill|type|click|press|merge|annotate|comment)(?:$|[._-])/.test(combined)) return "write";
  if ((family === "word" || family === "spreadsheet") && /(paragraph|text|table|image|header|footer|cell|row|column|range|worksheet|sheet|chart)/.test(combined)) return "write";
  if (/(^|[._-])(inspect|snapshot|extract|parse|analyze)(?:$|[._-])/.test(combined)) return "inspect";
  if (/(^|[._-])(read|get|list|search|query|fetch|view)(?:$|[._-])/.test(combined)) return "read";
  if (/(^|[._-])(delete|remove|close|clear|reset|stop|cancel)(?:$|[._-])/.test(combined)) return "admin";
  if (/(^|[._-])(create|new|open|launch|goto|navigate|start|init)(?:$|[._-])/.test(combined)) return "entry";
  return "inspect";
}

export function hasMcpWriteCapability(args: {
  toolName: string;
  description?: string;
  serverFamily?: McpServerFamily | string | null;
}): boolean {
  const klass = inferMcpToolClass(args);
  return klass === "write" || klass === "export";
}

export function buildMcpServerCatalog(args: {
  servers?: McpSidecarServer[];
  tools?: McpSidecarTool[];
}): McpServerCatalogEntry[] {
  const tools = Array.isArray(args.tools) ? args.tools : [];
  const serverMap = new Map<string, McpServerCatalogEntry>();

  for (const server of Array.isArray(args.servers) ? args.servers : []) {
    const serverId = String(server?.serverId ?? "").trim();
    if (!serverId) continue;
    const hintedFamily = String(server?.familyHint ?? "").trim().toLowerCase();
    serverMap.set(serverId, {
      serverId,
      serverName: String(server?.serverName ?? "").trim() || serverId,
      family: (["browser", "search", "word", "spreadsheet", "pdf", "custom"] as string[]).includes(hintedFamily) ? (hintedFamily as McpServerFamily) : "custom",
      sessionMode: "unknown",
      status: String(server?.status ?? "connected").trim() || "connected",
      toolCount: Math.max(0, Math.floor(Number(server?.toolCount ?? 0) || 0)),
      agentToolCount: Math.max(0, Math.floor(Number(server?.agentToolCount ?? 0) || 0)) || undefined,
      toolProfile: String(server?.toolProfile ?? "").trim() || undefined,
      capabilities: [],
      entryToolNames: [],
    });
  }

  for (const tool of tools) {
    const serverId = String(tool?.serverId ?? "").trim();
    if (!serverId) continue;
    const serverName = String(tool?.serverName ?? "").trim() || serverId;
    const existing = serverMap.get(serverId) ?? {
      serverId,
      serverName,
      family: "custom" as McpServerFamily,
      sessionMode: "unknown" as McpServerSessionMode,
      status: "connected",
      toolCount: 0,
      agentToolCount: undefined,
      toolProfile: undefined,
      capabilities: [] as string[],
      entryToolNames: [] as string[],
    };
    const description = String(tool?.description ?? "");
    const caps = inferCapabilities(String(tool?.name ?? ""), description, "mcp");
    existing.toolCount += 1;
    existing.capabilities = Array.from(new Set([...existing.capabilities, ...caps]));
    const toolName = String(tool?.name ?? "").trim();
    const originalName = String(tool?.originalName ?? "").trim();
    const entryCandidate = originalName || toolName;
    if (isLikelyEntryToolName(entryCandidate)) {
      existing.entryToolNames = Array.from(new Set([...existing.entryToolNames, toolName]));
    }
    existing.family = inferMcpServerFamily(existing.capabilities);
    existing.sessionMode = inferMcpServerSessionMode(existing.family);
    serverMap.set(serverId, existing);
  }

  return Array.from(serverMap.values())
    .map((entry) => ({
      ...entry,
      toolCount: entry.toolCount || entry.entryToolNames.length,
      agentToolCount: entry.agentToolCount ?? entry.toolCount ?? entry.entryToolNames.length,
      toolProfile: entry.toolProfile,
      capabilities: Array.from(new Set(entry.capabilities)),
      entryToolNames: Array.from(new Set(entry.entryToolNames)).slice(0, 24),
      sessionMode: inferMcpServerSessionMode(entry.family),
    }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId));
}

export function selectMcpServerSubset(args: {
  servers?: McpServerCatalogEntry[];
  routeId?: string | null;
  userPrompt: string;
  maxServers?: number;
  preferBrowser?: boolean;
}): { selectedServerIds: Set<string>; summary: McpServerSelectionSummary } {
  const servers = Array.isArray(args.servers) ? args.servers : [];
  const routeId = String(args.routeId ?? "").trim().toLowerCase();
  const routeCaps = new Set(ROUTE_CAPABILITY_MAP[routeId] ?? []);
  const promptCaps = detectPromptCapabilities(args.userPrompt);
  const maxServers = Math.max(1, Math.min(4, Math.floor(Number(args.maxServers ?? 2) || 2)));

  const rank = servers.map((server) => {
    let score = 0;
    const reasons: string[] = [];
    if (server.status === "connected") {
      score += 20;
      reasons.push("connected");
    }
    if (server.entryToolNames.length > 0) {
      score += 10;
      reasons.push("entry_tools");
    }
    if (server.family === "browser") {
      if (args.preferBrowser || promptCaps.has("browser_open")) {
        score += 260;
        reasons.push("browser_open");
      }
      if (routeId === "web_radar") {
        score += 120;
        reasons.push("route:web_radar");
      }
    }
    if (server.family === "search") {
      if (promptCaps.has("web_search") || routeCaps.has("web_search")) {
        score += 220;
        reasons.push("search_needed");
      }
      if (promptCaps.has("web_fetch") || routeCaps.has("web_fetch")) {
        score += 80;
        reasons.push("fetch_needed");
      }
    }
    if (server.family === "word" && promptCaps.has("mcp_word_doc")) {
      score += 240;
      reasons.push("word_doc");
    }
    if (server.family === "spreadsheet" && promptCaps.has("mcp_spreadsheet")) {
      score += 240;
      reasons.push("spreadsheet");
    }
    if (server.family === "pdf" && promptCaps.has("mcp_pdf")) {
      score += 220;
      reasons.push("pdf");
    }
    if (server.family === "custom" && promptCaps.size === 0) {
      score += 5;
      reasons.push("custom_fallback");
    }
    const matchedIntent = reasons.some((reason) => !["connected", "entry_tools", "custom_fallback"].includes(reason));
    if (!matchedIntent && server.family !== "custom") {
      score = 0;
      reasons.push(promptCaps.size > 0 ? "irrelevant_for_prompt" : "no_server_signal");
    }
    return { serverId: server.serverId, family: server.family, sessionMode: server.sessionMode, score, reasons };
  });

  rank.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.serverId.localeCompare(b.serverId);
  });

  const selected = new Set<string>();
  for (const item of rank) {
    if (selected.size >= maxServers) break;
    if (item.score <= 0) continue;
    selected.add(item.serverId);
  }

  const selectedServerIds = Array.from(selected);
  const prunedServerIds = servers.map((x) => x.serverId).filter((id) => !selected.has(id));
  return {
    selectedServerIds: selected,
    summary: {
      totalServers: servers.length,
      selectedServerIds: selectedServerIds.slice(0, 12),
      prunedServerIds: prunedServerIds.slice(0, 24),
      rankingSample: rank.slice(0, 12),
    },
  };
}

export function filterMcpToolsByServerIds(args: {
  tools?: McpSidecarTool[];
  selectedServerIds?: Set<string>;
}): McpSidecarTool[] {
  const tools = Array.isArray(args.tools) ? args.tools : [];
  const selected = args.selectedServerIds ?? new Set<string>();
  if (selected.size === 0) return tools;
  return tools.filter((tool) => selected.has(String(tool?.serverId ?? "").trim()));
}

export function buildToolCatalog(args: {
  mode: ToolMode;
  allowedToolNames: Set<string>;
  mcpTools?: McpSidecarTool[];
}): ToolCatalogEntry[] {
  const out: ToolCatalogEntry[] = [];
  for (const tool of TOOL_LIST) {
    const entry = toBuiltinEntry(tool);
    if (!args.allowedToolNames.has(entry.name)) continue;
    if (entry.modes.length > 0 && !entry.modes.includes(args.mode)) continue;
    out.push(entry);
  }

  const mcpList = Array.isArray(args.mcpTools) ? args.mcpTools : [];
  for (const t of mcpList) {
    if (!args.allowedToolNames.has(String(t?.name ?? "").trim())) continue;
    const entry = toMcpEntry(t, args.mode);
    if (entry) out.push(entry);
  }

  return out;
}

export function selectToolSubset(args: {
  catalog: ToolCatalogEntry[];
  routeId?: string | null;
  userPrompt: string;
  preferredToolNames?: string[];
  preserveToolNames?: string[];
  maxTools?: number;
}): { selectedToolNames: Set<string>; summary: ToolCatalogSummary } {
  const catalog = Array.isArray(args.catalog) ? args.catalog : [];
  const maxTools = Math.max(6, Math.min(64, Math.floor(Number(args.maxTools ?? 28) || 28)));
  const routeId = String(args.routeId ?? "").trim().toLowerCase();
  const routeCaps = new Set(ROUTE_CAPABILITY_MAP[routeId] ?? []);
  const promptCaps = detectPromptCapabilities(args.userPrompt);
  const preferred = new Set((args.preferredToolNames ?? []).map((x) => String(x ?? "").trim()).filter(Boolean));
  const preserve = new Set((args.preserveToolNames ?? []).map((x) => String(x ?? "").trim()).filter(Boolean));

  const rank = catalog.map((entry) => {
    let score = 0;
    const reasons: string[] = [];
    if (preserve.has(entry.name)) {
      score += 500;
      reasons.push("preserve");
    }
    if (preferred.has(entry.name)) {
      score += 420;
      reasons.push("preferred");
    }
    for (const cap of entry.capabilities) {
      if (routeCaps.has(cap)) {
        score += 90;
        reasons.push(`route:${cap}`);
      }
      if (promptCaps.has(cap)) {
        score += 70;
        reasons.push(`prompt:${cap}`);
      }
    }
    if (entry.source === "mcp" && promptCaps.has("browser_open") && entry.capabilities.includes("browser_open")) {
      score += 80;
      reasons.push("mcp_browser_boost");
    }
    if (entry.source === "mcp") {
      const hasRelevantCap = entry.capabilities.some((c) =>
        (c === "mcp_word_doc" && promptCaps.has("mcp_word_doc")) ||
        (c === "mcp_spreadsheet" && promptCaps.has("mcp_spreadsheet")) ||
        (c === "mcp_pdf" && promptCaps.has("mcp_pdf")),
      );
      if (hasRelevantCap) {
        const family: McpServerFamily = entry.capabilities.includes("mcp_word_doc")
          ? "word"
          : entry.capabilities.includes("mcp_spreadsheet")
            ? "spreadsheet"
            : entry.capabilities.includes("mcp_pdf")
              ? "pdf"
              : "custom";
        const toolClass = inferMcpToolClass({
          toolName: entry.name,
          description: entry.description,
          serverFamily: family,
        });
        if (toolClass === "write") {
          score += 140;
          reasons.push("mcp_write_priority");
        } else if (toolClass === "export") {
          score += 120;
          reasons.push("mcp_export_priority");
        } else if (toolClass === "entry") {
          score += 60;
          reasons.push("mcp_lifecycle_entry");
        } else if (toolClass === "read") {
          score += 20;
          reasons.push("mcp_read_support");
        }
      }
    }
    if ((routeId === "analysis_readonly" || routeId === "project_search") && entry.riskLevel === "high") {
      score -= 120;
      reasons.push("readonly_risk_penalty");
    }
    if (entry.name.startsWith("run.")) {
      score += 25;
      reasons.push("run_tool");
    }
    return { name: entry.name, score, reasons };
  });

  rank.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const selected = new Set<string>();
  for (const name of preserve) {
    if (catalog.some((x) => x.name === name)) selected.add(name);
  }
  for (const name of preferred) {
    if (catalog.some((x) => x.name === name)) selected.add(name);
  }
  for (const item of rank) {
    if (selected.size >= maxTools) break;
    selected.add(item.name);
  }
  if (selected.size === 0 && rank[0]?.name) selected.add(rank[0].name);

  const selectedNames = Array.from(selected);
  const prunedNames = catalog.map((x) => x.name).filter((name) => !selected.has(name));
  const summary: ToolCatalogSummary = {
    total: catalog.length,
    builtin: catalog.filter((x) => x.source === "builtin").length,
    mcp: catalog.filter((x) => x.source === "mcp").length,
    selected: selected.size,
    pruned: Math.max(0, catalog.length - selected.size),
    selectedToolNames: selectedNames.slice(0, 48),
    prunedToolNames: prunedNames.slice(0, 48),
    rankingSample: rank.slice(0, 20),
  };
  return { selectedToolNames: selected, summary };
}
