import assert from "node:assert/strict";
import { prepareAgentRun, type RunServices } from "../src/agent/runFactory.js";

function ok(name: string) {
  console.log(`[smoke-mcp-server-first] OK: ${name}`);
}

function createServices(): RunServices {
  return {
    IS_DEV: true,
    fastify: { log: { info() {}, warn() {}, error() {} } },
    aiConfig: {
      listStages: async () => [
        {
          stage: "agent.run",
          modelId: "mock-model",
          modelIds: ["mock-model"],
          temperature: 0.2,
          maxTokens: 2048,
        },
      ],
      listModels: async () => [
        {
          id: "mock-model",
          model: "gpt-4.1-mini",
          isEnabled: true,
        },
      ],
      resolveStage: async (stage: string) => ({
        stage,
        modelId: "mock-model",
        modelIds: ["mock-model"],
        temperature: 0.2,
        maxTokens: 2048,
      }),
      resolveModel: async (id: string) => ({
        id,
        modelId: id,
        model: "gpt-4.1-mini",
        baseURL: "https://mock.local",
        endpoint: "/v1/responses",
        apiKey: "test-key",
        toolResultFormat: "text" as const,
      }),
    },
    toolConfig: {
      resolveCapabilitiesRuntime: async () => ({ disabledToolsByMode: {} }),
      resolveWebSearchRuntime: async () => ({ isEnabled: true, apiKey: "bocha-key" }),
    },
    getLlmEnv: async () => ({
      baseUrl: "https://mock.local",
      endpoint: "/v1/responses",
      apiKey: "test-key",
      models: ["gpt-4.1-mini"],
      defaultModel: "mock-model",
      ok: true,
    }),
    tryGetJwtUser: async () => ({ id: "u_test", role: "admin" }),
    chargeUserForLlmUsage: async () => null,
    loadDb: async () => ({ users: [], audits: [] } as any),
    agentRunWaiters: new Map(),
  };
}

async function prepare(prompt: string, toolSidecar: any) {
  const prevRouterMode = process.env.INTENT_ROUTER_MODE;
  process.env.INTENT_ROUTER_MODE = "heuristic";
  try {
    const result = await prepareAgentRun({
      request: { headers: {} },
      body: {
        mode: "agent",
        prompt,
        toolSidecar,
      },
      services: createServices(),
    });
    assert.equal(!!result.error, false, `prepareAgentRun should succeed: ${JSON.stringify(result.error)}`);
    return result.prepared!;
  } finally {
    if (prevRouterMode == null) delete process.env.INTENT_ROUTER_MODE;
    else process.env.INTENT_ROUTER_MODE = prevRouterMode;
  }
}

function makeSidecar() {
  return {
    mcpServers: [
      { serverId: "playwright", serverName: "Playwright", status: "connected", toolCount: 2 },
      { serverId: "web-search", serverName: "Web Search", status: "connected", toolCount: 2 },
      { serverId: "word", serverName: "Word", status: "connected", toolCount: 2 },
    ],
    mcpTools: [
      {
        name: "mcp.playwright.browser_navigate",
        description: "[MCP:Playwright] 浏览器导航",
        serverId: "playwright",
        serverName: "Playwright",
        originalName: "browser_navigate",
      },
      {
        name: "mcp.playwright.browser_snapshot",
        description: "[MCP:Playwright] 页面快照",
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
        description: "[MCP:Web Search] 获取网页内容",
        serverId: "web-search",
        serverName: "Web Search",
        originalName: "get_page_content",
      },
      {
        name: "mcp.word.create_document",
        description: "[MCP:Word] 创建 docx 文档",
        serverId: "word",
        serverName: "Word",
        originalName: "create_document",
      },
      {
        name: "mcp.word.read_doc",
        description: "[MCP:Word] 读取 docx 文档",
        serverId: "word",
        serverName: "Word",
        originalName: "read_doc",
      },
    ],
  };
}

async function scenarioBrowserOpen() {
  const prepared = await prepare("打开小红书登录页，等我登录后继续", makeSidecar());
  assert.equal(prepared.compositeTaskPlan, null, "simple browser scenario should not create composite plan");
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("playwright"), true, "browser scenario should select playwright");
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("word"), false, "browser scenario should prune word");
  assert.equal(prepared.mcpToolsForRun.every((tool) => tool.serverId !== "word"), true, "runtime MCP tools should exclude word server");
  assert.equal(prepared.selectedAllowedToolNames.has("mcp.playwright.browser_navigate"), true, "selected tools should include browser_navigate");
  assert.equal(prepared.selectedAllowedToolNames.has("code.exec"), false, "browser scenario should suppress code.exec");
  ok("browser scenario");
}

async function scenarioWordDoc() {
  const prepared = await prepare("帮我创建一个 Word 文档并导出 docx", makeSidecar());
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("word"), true, "docx scenario should select word");
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("playwright"), false, "docx scenario should prune playwright");
  assert.equal(prepared.mcpToolsForRun.every((tool) => tool.serverId === "word"), true, "runtime MCP tools should only keep word server");
  assert.equal(prepared.selectedAllowedToolNames.has("mcp.word.create_document"), true, "selected tools should include create_document");
  ok("word scenario");
}


async function scenarioCompositeBrowserToWord() {
  const prepared = await prepare("打开小红书创作后台，拉取数据并生成 Word 报告导出 docx", makeSidecar());
  assert.ok(prepared.compositeTaskPlan, "composite scenario should derive composite task plan");
  const phaseKinds = prepared.compositeTaskPlan?.phases.map((phase) => phase.kind) ?? [];
  assert.equal(phaseKinds.includes("browser_collect"), true, "composite plan should include browser_collect");
  assert.equal(phaseKinds.includes("structured_extract"), true, "composite plan should include structured_extract");
  assert.equal(phaseKinds.includes("word_delivery"), true, "composite plan should include word_delivery");
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("playwright"), true, "composite scenario should keep playwright");
  assert.equal(prepared.mcpServerSelectionSummary.selectedServerIds.includes("word"), true, "composite scenario should keep word");
  assert.equal(prepared.selectedAllowedToolNames.has("mcp.playwright.browser_navigate"), true, "composite scenario should include browser_navigate");
  assert.equal(prepared.selectedAllowedToolNames.has("mcp.word.create_document"), true, "composite scenario should include create_document");
  ok("composite browser to word scenario");
}

async function scenarioExplicitCodeExec() {
  const prepared = await prepare(
    "写一个 Python 脚本扫描项目里的 Markdown 文件并输出统计结果",
    {
      ...makeSidecar(),
      ideSummary: { projectDir: "/tmp/mock-project", activePath: "/tmp/mock-project/README.md", openPaths: 1 },
    },
  );
  assert.equal(prepared.selectedAllowedToolNames.has("code.exec"), true, "explicit code scenario should keep code.exec");
  ok("explicit code scenario");
}

async function main() {
  await scenarioBrowserOpen();
  await scenarioWordDoc();
  await scenarioCompositeBrowserToWord();
  await scenarioExplicitCodeExec();
  console.log("[smoke-mcp-server-first] all scenarios passed");
}

main().catch((error) => {
  console.error("[smoke-mcp-server-first] FAILED", error);
  process.exit(1);
});
