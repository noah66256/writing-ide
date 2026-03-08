import assert from "node:assert/strict";
import {
  buildMcpServerCatalog,
  buildToolCatalog,
  filterMcpToolsByServerIds,
  selectMcpServerSubset,
  selectToolSubset,
  type McpSidecarServer,
  type McpSidecarTool,
} from "../src/agent/toolCatalog.js";

function ok(name: string) {
  console.log(`[validate-mcp-selection] OK: ${name}`);
}

function buildFixtures(): { servers: McpSidecarServer[]; tools: McpSidecarTool[] } {
  const servers: McpSidecarServer[] = [
    {
      serverId: "playwright",
      serverName: "Playwright",
      status: "connected",
      toolCount: 2,
      toolNamesSample: ["browser_navigate", "browser_snapshot"],
    },
    {
      serverId: "web-search",
      serverName: "Web Search",
      status: "connected",
      toolCount: 2,
      toolNamesSample: ["web_search", "get_page_content"],
    },
    {
      serverId: "word",
      serverName: "Word",
      status: "connected",
      toolCount: 4,
      agentToolCount: 4,
      familyHint: "word",
      toolProfile: "word_delivery_minimal",
      toolNamesSample: ["create_document", "add_paragraph", "save_document", "read_doc"],
    },
  ];

  const tools: McpSidecarTool[] = [
    {
      name: "mcp.playwright.browser_navigate",
      description: "[MCP:Playwright] 浏览器导航到指定 URL",
      serverId: "playwright",
      serverName: "Playwright",
      originalName: "browser_navigate",
    },
    {
      name: "mcp.playwright.browser_snapshot",
      description: "[MCP:Playwright] 浏览器页面截图",
      serverId: "playwright",
      serverName: "Playwright",
      originalName: "browser_snapshot",
    },
    {
      name: "mcp.web-search.web_search",
      description: "[MCP:Web Search] 全网搜索",
      serverId: "web-search",
      serverName: "Web Search",
      originalName: "web_search",
    },
    {
      name: "mcp.web-search.get_page_content",
      description: "[MCP:Web Search] 获取网页正文",
      serverId: "web-search",
      serverName: "Web Search",
      originalName: "get_page_content",
    },
    {
      name: "mcp.word.create_document",
      description: "[MCP:Word] 创建 Word / docx 文档",
      serverId: "word",
      serverName: "Word",
      originalName: "create_document",
    },
    {
      name: "mcp.word.add_paragraph",
      description: "[MCP:Word] 向 Word 文档追加段落",
      serverId: "word",
      serverName: "Word",
      originalName: "add_paragraph",
    },
    {
      name: "mcp.word.save_document",
      description: "[MCP:Word] 保存并导出 docx 文档",
      serverId: "word",
      serverName: "Word",
      originalName: "save_document",
    },
    {
      name: "mcp.word.read_doc",
      description: "[MCP:Word] 读取 Word / docx 文档",
      serverId: "word",
      serverName: "Word",
      originalName: "read_doc",
    },
  ];

  return { servers, tools };
}

function runScenario(args: {
  prompt: string;
  routeId: string;
  preferBrowser?: boolean;
  maxServers?: number;
}) {
  const { servers, tools } = buildFixtures();
  const catalog = buildMcpServerCatalog({ servers, tools });
  const serverSelection = selectMcpServerSubset({
    servers: catalog,
    routeId: args.routeId,
    userPrompt: args.prompt,
    preferBrowser: args.preferBrowser,
    maxServers: args.maxServers,
  });
  const filteredTools =
    serverSelection.selectedServerIds.size > 0
      ? filterMcpToolsByServerIds({ tools, selectedServerIds: serverSelection.selectedServerIds })
      : tools;
  const allowedToolNames = new Set(filteredTools.map((tool) => String(tool.name ?? "").trim()).filter(Boolean));
  const toolCatalog = buildToolCatalog({
    mode: "agent",
    allowedToolNames,
    mcpTools: filteredTools,
  });
  const toolSelection = selectToolSubset({
    catalog: toolCatalog,
    routeId: args.routeId,
    userPrompt: args.prompt,
    maxTools: 8,
  });
  return { serverSelection, filteredTools, toolSelection };
}

function scenarioBrowserFirst() {
  const result = runScenario({
    prompt: "打开小红书登录页，等我登录完再继续",
    routeId: "web_radar",
    preferBrowser: true,
  });

  assert.equal(result.serverSelection.selectedServerIds.has("playwright"), true, "browser intent should keep playwright server");
  assert.equal(result.serverSelection.selectedServerIds.has("word"), false, "browser intent should prune word server");
  assert.equal(result.filteredTools.some((tool) => tool.serverId === "word"), false, "filtered tools should exclude word server tools");
  assert.equal(result.toolSelection.selectedToolNames.has("mcp.playwright.browser_navigate"), true, "browser navigate should be selected");
  ok("browser-first selection");
}

function scenarioSearchFirst() {
  const result = runScenario({
    prompt: "全网搜一下今天 OpenAI 的最新消息",
    routeId: "web_radar",
  });

  assert.equal(result.serverSelection.selectedServerIds.has("web-search"), true, "search intent should keep web-search server");
  assert.equal(result.serverSelection.selectedServerIds.has("word"), false, "search intent should prune word server");
  assert.equal(result.toolSelection.selectedToolNames.has("mcp.web-search.web_search"), true, "web_search should be selected");
  ok("search-first selection");
}

function scenarioWordFirst() {
  const result = runScenario({
    prompt: "创建一个 Word 文档并导出 docx 给我",
    routeId: "file_ops",
  });

  assert.equal(result.serverSelection.selectedServerIds.has("word"), true, "docx intent should keep word server");
  assert.equal(result.serverSelection.selectedServerIds.has("playwright"), false, "docx intent should prune playwright server");
  assert.equal(result.filteredTools.every((tool) => tool.serverId === "word"), true, "word intent should only retain word tools");
  assert.equal(result.toolSelection.selectedToolNames.has("mcp.word.create_document"), true, "create_document should be selected");
  assert.equal(result.toolSelection.selectedToolNames.has("mcp.word.add_paragraph"), true, "word write tool should be selected");
  ok("word-first selection");
}

function scenarioFallbackCompatibility() {
  const result = runScenario({
    prompt: "帮我想一个标题",
    routeId: "discussion",
  });

  assert.equal(result.serverSelection.selectedServerIds.size, 0, "non-mcp prompt should not force a server");
  assert.equal(result.filteredTools.length, 8, "when no server selected, should fall back to all tools for compatibility");
  ok("fallback compatibility");
}

scenarioBrowserFirst();
scenarioSearchFirst();
scenarioWordFirst();
scenarioFallbackCompatibility();

console.log("[validate-mcp-selection] all scenarios passed");
