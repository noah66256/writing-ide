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
  { capability: "web_search", re: /(全网|联网|上网|搜索网页|新闻|热点|最新|today|latest)/i },
  { capability: "web_fetch", re: /(网页|url|链接|fetch|抓取|访问|打开百度|open\s+.*https?)/i },
  { capability: "kb_search", re: /(知识库|kb|风格库|语料|检索|抽卡|learn|ingest)/i },
  { capability: "code_exec", re: /(运行|执行脚本|命令|shell|打包|构建|部署|code\.exec)/i },
  { capability: "delegate", re: /(委派|分派|指派|派给|delegate|sub[\s_-]?agent|agent\s*delegate)/i },
  { capability: "browser_open", re: /(打开.*网页|打开网站|浏览器|网站|navigate|open\s+.*(baidu|google|url))/i },
  // MCP 文档类：仅用户明确提到时才激活
  { capability: "mcp_spreadsheet", re: /(excel|表格|电子表格|spreadsheet|工作表)/i },
  { capability: "mcp_word_doc", re: /(word文档|docx|word\s*文件|写.*word)/i },
  { capability: "mcp_pdf", re: /(pdf|转.*pdf|导出.*pdf)/i },
];

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
  if (n.startsWith("doc.read") || n.startsWith("project.read") || /\bread\b|\bparse\b/.test(n)) caps.add("file_read");
  if (isWriteLikeTool(name)) caps.add("file_write");
  // 合并工具的能力映射
  if (n === "doc.snapshot") { caps.add("file_read"); caps.add("file_write"); }
  if (n === "memory") caps.add("kb_search");
  if (n === "agent.config") caps.add("delegate");
  if (n.startsWith("project.search") || n.startsWith("project.find")) caps.add("project_search");
  if (n.startsWith("web.search")) caps.add("web_search");
  if (n.startsWith("web.fetch")) caps.add("web_fetch");
  if (n.startsWith("kb.")) caps.add("kb_search");
  if (n === "code.exec") caps.add("code_exec");
  if (n === "agent.delegate") caps.add("delegate");

  if (source === "mcp") {
    caps.add("mcp");
    // 搜索类 MCP 工具
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
    // 文档类 MCP 工具：使用 MCP 专属能力名，避免与 builtin file_read/file_write 混淆
    // （builtin doc.write 是本地编辑器写入，MCP 是外部文档处理，不应同权重竞争）
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

function toMcpEntry(meta: any, mode: ToolMode): ToolCatalogEntry | null {
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

export function buildToolCatalog(args: {
  mode: ToolMode;
  allowedToolNames: Set<string>;
  mcpTools?: Array<{ name: string; description?: string; inputSchema?: any; serverId?: string; serverName?: string }>;
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

function detectPromptCapabilities(prompt: string): Set<string> {
  const text = String(prompt ?? "").trim();
  const out = new Set<string>();
  if (!text) return out;
  for (const rule of CAPABILITY_KEYWORDS) {
    if (rule.re.test(text)) out.add(rule.capability);
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
