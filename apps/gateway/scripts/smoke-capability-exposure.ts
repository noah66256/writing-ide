import assert from "node:assert/strict";
import {
  buildModelVisibleCatalog,
  buildSelectionCatalog,
  buildDiscoveryCatalogForToolSearch,
} from "../src/agent/toolCatalogViews.js";
import { retrieveToolsForRun } from "../src/agent/toolRetriever.js";
import { executeServerToolOnGateway } from "../src/agent/serverToolRunner.js";
import {
  activateMcpCapability,
  activateSkillCapability,
  clearThreadCapabilityStateForNewTask,
  createEmptyThreadCapabilityState,
  resolveMcpToolNamesForCapabilityIds,
} from "../src/agent/threadCapabilityState.js";
import { buildMcpCapabilityCards } from "../src/agent/capabilityIndex.js";
import type { McpSidecarServer, McpSidecarTool } from "../src/agent/toolCatalog.js";

function ok(name: string) {
  console.log(`[smoke-capability-exposure] OK: ${name}`);
}

function makeFixtures(): { mcpServers: McpSidecarServer[]; mcpTools: McpSidecarTool[] } {
  return {
    mcpServers: [
      {
        serverId: "playwright",
        serverName: "Playwright",
        status: "connected",
        toolCount: 2,
        agentToolCount: 2,
        familyHint: "browser",
        toolProfile: "browser_minimal",
      },
    ],
    mcpTools: [
      {
        name: "mcp.playwright.browser_navigate",
        description: "[MCP:Playwright] 打开网页并导航",
        serverId: "playwright",
        serverName: "Playwright",
        originalName: "browser_navigate",
      },
      {
        name: "mcp.playwright.browser_snapshot",
        description: "[MCP:Playwright] 读取页面快照并截图",
        serverId: "playwright",
        serverName: "Playwright",
        originalName: "browser_snapshot",
      },
    ],
  };
}

function makeAllowedToolNames(): Set<string> {
  return new Set([
    "tools.search",
    "tools.describe",
    "spawn_agent",
    "send_input",
    "wait_agent",
    "resume_agent",
    "close_agent",
    "mcp.playwright.browser_navigate",
    "mcp.playwright.browser_snapshot",
  ]);
}

function makeSkillManifestMap(): Map<string, any> {
  return new Map([
    [
      "style_imitate",
      {
        id: "style_imitate",
        name: "风格仿写",
        description: "按风格库完成样例、草稿、lint、终稿闭环。",
        priority: 100,
        stageKey: "agent.run",
        autoEnable: true,
        kind: "workflow",
        activationMode: "hybrid",
        triggers: [],
        promptFragments: {
          system: "workflow: kb.search -> doc.write(draft) -> lint.copy -> lint.style -> write",
        },
        policies: [],
        ui: { badge: "风格" },
        source: "builtin",
        userInvocable: true,
      },
    ],
  ]);
}

async function scenarioSelectionKeepsCollabWithMcp() {
  const fixtures = makeFixtures();
  const allowed = makeAllowedToolNames();
  const modelVisibleCatalog = buildModelVisibleCatalog({
    mode: "agent",
    allowedToolNames: allowed,
    mcpTools: fixtures.mcpTools,
  });
  const selectionCatalog = buildSelectionCatalog({ modelVisibleCatalog });
  const selectedNames = new Set(selectionCatalog.map((entry) => entry.name));

  assert.equal(selectedNames.has("spawn_agent"), true, "selection catalog should keep collab builtin");
  assert.equal(
    selectedNames.has("mcp.playwright.browser_navigate"),
    true,
    "selection catalog should include MCP tools alongside collab",
  );

  const retrieval = retrieveToolsForRun({
    catalog: selectionCatalog,
    userPrompt: "拉个子agent试试",
    routeId: "task_execution",
    desired: 6,
    maxCandidates: 12,
  });

  assert.equal(
    retrieval.retrievedToolNames.includes("spawn_agent"),
    true,
    "collab intent should still retrieve spawn_agent when MCP exists",
  );
  ok("selection catalog keeps collab + MCP");
}

async function scenarioDiscoveryAndDescribe() {
  const fixtures = makeFixtures();
  const allowed = makeAllowedToolNames();
  const skillManifestById = makeSkillManifestMap();
  const discoveryCatalog = buildDiscoveryCatalogForToolSearch({
    mode: "agent",
    allowedToolNames: new Set(["tools.search", "tools.describe", "spawn_agent"]),
    mcpTools: fixtures.mcpTools,
    includeAllMcpTools: true,
  });

  assert.equal(
    discoveryCatalog.some((entry) => entry.name === "mcp.playwright.browser_navigate"),
    true,
    "discovery catalog should be able to expand MCP tools without mutating selection semantics",
  );

  const searchResult = await executeServerToolOnGateway({
    fastify: { log: { info() {}, warn() {}, error() {} } } as any,
    call: {
      name: "tools.search",
      args: {
        query: "打开网页截图",
        limit: 6,
      },
    },
    toolSidecar: fixtures,
    styleLinterLibraries: [],
    mainDoc: {},
    mode: "agent",
    allowedToolNames: allowed,
    skillManifestById: skillManifestById as any,
    activeSkillIds: [],
  });

  assert.equal(searchResult.ok, true, "tools.search should succeed");
  const searchTools = Array.isArray((searchResult as any).output?.tools) ? (searchResult as any).output.tools : [];
  const browserCapability = searchTools.find((item: any) => item?.name === "mcp:playwright/browser");
  assert.equal(Boolean(browserCapability), true, "tools.search should expose mcp capability card");
  assert.equal(browserCapability?.resultType, "mcp_capability", "browser capability should be a capability card");

  const describeMcp = await executeServerToolOnGateway({
    fastify: { log: { info() {}, warn() {}, error() {} } } as any,
    call: {
      name: "tools.describe",
      args: {
        name: "mcp:playwright/browser",
      },
    },
    toolSidecar: fixtures,
    styleLinterLibraries: [],
    mainDoc: {},
    mode: "agent",
    allowedToolNames: allowed,
    skillManifestById: skillManifestById as any,
    activeSkillIds: [],
  });

  assert.equal(describeMcp.ok, true, "tools.describe(mcp:...) should succeed");
  assert.equal((describeMcp as any).output?.targetType, "mcp_capability", "describe should resolve MCP capability cards");
  const concreteTools = Array.isArray((describeMcp as any).output?.capability?.tools)
    ? (describeMcp as any).output.capability.tools.map((tool: any) => String(tool?.name ?? ""))
    : [];
  assert.equal(
    concreteTools.includes("mcp.playwright.browser_navigate"),
    true,
    "MCP capability describe should include concrete tool names",
  );

  const describeSkill = await executeServerToolOnGateway({
    fastify: { log: { info() {}, warn() {}, error() {} } } as any,
    call: {
      name: "tools.describe",
      args: {
        name: "skill:style_imitate",
      },
    },
    toolSidecar: fixtures,
    styleLinterLibraries: [],
    mainDoc: {},
    mode: "agent",
    allowedToolNames: allowed,
    skillManifestById: skillManifestById as any,
    activeSkillIds: [],
  });

  assert.equal(describeSkill.ok, true, "tools.describe(skill:...) should succeed");
  assert.equal((describeSkill as any).output?.targetType, "skill", "describe should resolve skill cards");
  assert.equal((describeSkill as any).output?.skill?.id, "style_imitate", "skill describe should expose skill id");
  ok("discovery cards + describe contract");
}

async function scenarioThreadCapabilitySticky() {
  const fixtures = makeFixtures();
  const mcpCatalog = buildModelVisibleCatalog({
    mode: "agent",
    allowedToolNames: makeAllowedToolNames(),
    mcpTools: fixtures.mcpTools,
  }).filter((entry) => entry.source === "mcp");
  const cards = buildMcpCapabilityCards({
    mcpCatalog,
    mcpServers: fixtures.mcpServers,
  });

  let state = createEmptyThreadCapabilityState();
  state = activateMcpCapability({
    state,
    capabilityId: "mcp:playwright/browser",
  });
  state = activateSkillCapability({
    state,
    skillId: "style_imitate",
  });

  assert.equal(state.activeMcpCapabilityIds.includes("mcp:playwright/browser"), true, "MCP capability should activate");
  assert.equal(state.stickyCapabilityIds.includes("mcp:playwright/browser"), true, "MCP capability should become sticky");
  assert.equal(state.activeSkillIds.includes("style_imitate"), true, "skill should activate");
  assert.equal(state.stickySkillIds.includes("style_imitate"), true, "skill should become sticky");

  const resolvedToolNames = resolveMcpToolNamesForCapabilityIds({
    capabilityIds: state.activeMcpCapabilityIds,
    cards,
  });
  assert.equal(
    resolvedToolNames.includes("mcp.playwright.browser_navigate"),
    true,
    "active MCP capability should resolve back to concrete tools",
  );

  const cleared = clearThreadCapabilityStateForNewTask(state);
  assert.equal(cleared.activeMcpCapabilityIds.length, 0, "new task should clear active MCP capability set");
  assert.equal(
    cleared.stickyCapabilityIds.includes("mcp:playwright/browser"),
    true,
    "new task should retain sticky MCP capability history",
  );
  assert.equal(
    cleared.activeSkillIds.includes("style_imitate"),
    true,
    "new task should preserve active skill ids for thread-level sticky skills",
  );
  ok("thread capability sticky + new-task clear");
}

await scenarioSelectionKeepsCollabWithMcp();
await scenarioDiscoveryAndDescribe();
await scenarioThreadCapabilitySticky();

console.log("[smoke-capability-exposure] all scenarios passed");
