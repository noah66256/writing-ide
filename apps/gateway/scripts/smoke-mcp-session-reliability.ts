import assert from "node:assert/strict";
import { buildMcpServerCatalog, type McpSidecarServer, type McpSidecarTool } from "../src/agent/toolCatalog.js";
import { mergeWorkflowStickyFromMcpSuccess } from "../../../apps/desktop/src/agent/mcpWorkflowSticky.ts";
import { shouldAttemptMcpSessionRecovery } from "../../../apps/desktop/electron/mcp-session-recovery.mjs";

function ok(name: string) {
  console.log(`[smoke-mcp-session-reliability] OK: ${name}`);
}

function buildFixtures(): { servers: McpSidecarServer[]; tools: McpSidecarTool[] } {
  const servers: McpSidecarServer[] = [
    { serverId: "playwright", serverName: "Playwright", status: "connected", toolCount: 2, toolNamesSample: ["browser_navigate", "browser_snapshot"] },
    { serverId: "web-search", serverName: "Web Search", status: "connected", toolCount: 2, toolNamesSample: ["web_search", "get_page_content"] },
    { serverId: "word", serverName: "Word", status: "connected", toolCount: 2, toolNamesSample: ["create_document", "read_doc"] },
  ];
  const tools: McpSidecarTool[] = [
    { name: "mcp.playwright.browser_navigate", description: "[MCP:Playwright] 浏览器导航", serverId: "playwright", serverName: "Playwright", originalName: "browser_navigate" },
    { name: "mcp.playwright.browser_snapshot", description: "[MCP:Playwright] 页面快照", serverId: "playwright", serverName: "Playwright", originalName: "browser_snapshot" },
    { name: "mcp.web-search.web_search", description: "[MCP:Web Search] 全网搜索", serverId: "web-search", serverName: "Web Search", originalName: "web_search" },
    { name: "mcp.web-search.get_page_content", description: "[MCP:Web Search] 获取页面正文", serverId: "web-search", serverName: "Web Search", originalName: "get_page_content" },
    { name: "mcp.word.create_document", description: "[MCP:Word] 创建文档", serverId: "word", serverName: "Word", originalName: "create_document" },
    { name: "mcp.word.read_doc", description: "[MCP:Word] 读取文档", serverId: "word", serverName: "Word", originalName: "read_doc" },
  ];
  return { servers, tools };
}

function scenarioStickyMerge() {
  const next = mergeWorkflowStickyFromMcpSuccess({}, {
    serverId: "playwright",
    toolName: "mcp.playwright.browser_navigate",
    nowIso: "2026-03-08T10:00:00.000Z",
  });
  assert.equal(next.routeId, "web_radar");
  assert.equal(next.kind, "browser_session");
  assert.deepEqual(next.selectedServerIds, ["playwright"]);
  assert.deepEqual(next.preferredToolNames, ["mcp.playwright.browser_navigate"]);
  ok("sticky merge from actual browser mcp success");
}

function scenarioStickyAppend() {
  const next = mergeWorkflowStickyFromMcpSuccess({
    v: 1,
    routeId: "task_execution",
    kind: "task_workflow",
    status: "running",
    intentHint: "ops",
    selectedServerIds: ["word"],
    preferredToolNames: ["mcp.word.read_doc"],
    updatedAt: "2026-03-08T09:59:00.000Z",
  }, {
    serverId: "word",
    toolName: "mcp.word.create_document",
    nowIso: "2026-03-08T10:00:00.000Z",
  });
  assert.equal(next.routeId, "task_execution");
  assert.equal(next.kind, "task_workflow");
  assert.deepEqual(next.selectedServerIds, ["word"]);
  assert.deepEqual(next.preferredToolNames, ["mcp.word.read_doc", "mcp.word.create_document"]);
  ok("sticky append preserves non-browser workflow");
}

function scenarioSessionModeCatalog() {
  const { servers, tools } = buildFixtures();
  const catalog = buildMcpServerCatalog({ servers, tools });
  const byId = new Map(catalog.map((item) => [item.serverId, item]));
  assert.equal(byId.get("playwright")?.sessionMode, "stateful");
  assert.equal(byId.get("word")?.sessionMode, "stateful");
  assert.equal(byId.get("web-search")?.sessionMode, "stateless");
  ok("server catalog exposes session mode");
}

function scenarioSessionRecovery() {
  assert.equal(shouldAttemptMcpSessionRecovery({
    serverId: "playwright",
    toolName: "browser_navigate",
    errorText: "Another browser context is being closed.",
  }), true);
  assert.equal(shouldAttemptMcpSessionRecovery({
    serverId: "web-search",
    toolName: "web_search",
    errorText: "Another browser context is being closed.",
  }), false);
  ok("session recovery only targets stateful mcp servers");
}

scenarioStickyMerge();
scenarioStickyAppend();
scenarioSessionModeCatalog();
scenarioSessionRecovery();
console.log("[smoke-mcp-session-reliability] all scenarios passed");
