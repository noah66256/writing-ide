import assert from "node:assert/strict";
import {
  computeIntentRouteDecisionPhase0,
  looksLikeDeleteOnlyIntent,
  looksLikeExplicitNewTaskPrompt,
  resolveStickyMcpServerIds,
} from "../src/agent/runFactory";

function ok(name: string) {
  console.log(`ok ${name}`);
}

const freshIso = new Date().toISOString();

const browserMainDoc = {
  taskStateV2: {
    workflow: {
      status: "running",
      routeId: "web_radar",
      kind: "browser_session",
      intentHint: "ops",
      selectedServerIds: ["playwright"],
      preferredToolNames: ["mcp.playwright.browser_navigate"],
      updatedAt: freshIso,
    },
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
  taskStateV2: {
    workflow: {
      status: "running",
      routeId: "task_execution",
      kind: "task_workflow",
      intentHint: "writing",
      updatedAt: freshIso,
    },
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

assert.equal(
  looksLikeDeleteOnlyIntent("李叔挽回课直播稿.txt 不是，那8round+draft我手动删了以免你误解，目前要的是对比md，以及spec"),
  false,
);
ok("routing.delete_only_excludes_md_spec_delivery");

assert.equal(
  looksLikeExplicitNewTaskPrompt("我的意思是拿我们卖智能体这个项目和李一舟的对比md，以及spec"),
  true,
);
ok("routing.correction_prompt_breaks_sticky");

const todoShouldNotForceContinuation = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "为什么",
  mainDocRunIntent: "auto",
  mainDoc: {},
  runTodo: [{ id: "t1", text: "等待用户确认", status: "blocked", note: "等待你确认" }],
  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
  ideSummary: null,
});
assert.notEqual(todoShouldNotForceContinuation.routeId, "task_execution");
ok("sticky.todo_does_not_resume_without_explicit_continue");

const todoExplicitContinue = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "继续",
  mainDocRunIntent: "auto",
  mainDoc: {},
  runTodo: [{ id: "t1", text: "等待用户确认", status: "blocked", note: "等待你确认" }],
  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
  ideSummary: null,
});
assert.equal(todoExplicitContinue.routeId, "task_execution");
ok("sticky.todo_requires_explicit_continue");

const deleteStickyMainDoc = {
  taskStateV2: {
    workflow: {
      status: "running",
      routeId: "file_delete_only",
      kind: "task_workflow",
      intentHint: "ops",
      updatedAt: freshIso,
    },
  },
};

const correctionRoute = computeIntentRouteDecisionPhase0({
  mode: "agent",
  userPrompt: "我的意思是拿我们卖智能体这个项目和李一舟的对比md，以及spec",
  mainDocRunIntent: "auto",
  mainDoc: deleteStickyMainDoc,
  runTodo: [{ id: "t1", text: "删除显式目标 /智能体（若存在）", status: "in_progress" }],
  intent: { wantsWrite: true, isWritingTask: true, wantsOkOnly: false },
  ideSummary: null,
});
assert.notEqual(correctionRoute.routeId, "file_delete_only");
assert.equal(correctionRoute.routeId, "task_execution");
ok("sticky.delete_route_broken_by_explicit_correction");
