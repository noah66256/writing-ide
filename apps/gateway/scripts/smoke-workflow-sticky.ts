import assert from "node:assert/strict";
import { computeIntentRouteDecisionPhase0, resolveStickyMcpServerIds } from "../src/agent/runFactory";

function ok(name: string) {
  console.log(`ok ${name}`);
}

const freshIso = new Date().toISOString();

const browserMainDoc = {
  workflowV1: {
    v: 1,
    status: "running",
    routeId: "web_radar",
    kind: "browser_session",
    intentHint: "ops",
    selectedServerIds: ["playwright"],
    preferredToolNames: ["mcp.playwright.browser_navigate"],
    updatedAt: freshIso,
  },
};

const browserRoute = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "我登好了，继续看看数据",
  mainDocRunIntent: "auto",
  mainDoc: browserMainDoc,
  runTodo: [],
  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
  ideSummary: null,
});
assert.equal(browserRoute.routeId, "web_radar");
ok("sticky.browser_route");

const taskMainDoc = {
  workflowV1: {
    v: 1,
    status: "running",
    routeId: "task_execution",
    kind: "task_workflow",
    intentHint: "writing",
    updatedAt: freshIso,
  },
};

const taskRoute = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "写吧",
  mainDocRunIntent: "auto",
  mainDoc: taskMainDoc,
  runTodo: [],
  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
  ideSummary: null,
});
assert.equal(taskRoute.routeId, "task_execution");
ok("sticky.task_route");

const discussionRoute = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "先讨论原因，不要执行",
  mainDocRunIntent: "auto",
  mainDoc: browserMainDoc,
  runTodo: [],
  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
  ideSummary: null,
});
assert.notEqual(discussionRoute.routeId, "web_radar");
ok("sticky.discussion_breaks_workflow");

const stickyServerIds = resolveStickyMcpServerIds({
  mainDoc: browserMainDoc,
  availableServerIds: ["playwright", "web-search"],
  userPrompt: "我登好了，继续看看数据",
  routeId: "web_radar",
  maxServers: 2,
});
assert.deepEqual(stickyServerIds, ["playwright"]);
ok("sticky.mcp_server_fallback");

const noStickyServerIds = resolveStickyMcpServerIds({
  mainDoc: browserMainDoc,
  availableServerIds: ["playwright", "web-search"],
  userPrompt: "先讨论原因，不要执行",
  routeId: "discussion",
  maxServers: 2,
});
assert.deepEqual(noStickyServerIds, []);
ok("sticky.mcp_fallback_respects_non_task");
