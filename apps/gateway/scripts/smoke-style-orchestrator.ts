import { createInitialRunState } from "@ohmycrab/agent-core";
import { computeStyleTurnCaps } from "../src/agent/styleOrchestrator.js";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`SMOKE_ASSERT_FAILED: ${message}`);
}

function baseAllowed(): Set<string> {
  return new Set([
    "time.now",
    "run.mainDoc.get",
    "run.mainDoc.update",
    "run.setTodoList",
    "run.todo",
    "run.done",
    "kb.search",
    "write",
    "edit",
    "lint.copy",
    "lint.style",
  ]);
}

function activeRunCtx() {
  return {
    intent: { isWritingTask: true },
    gates: { styleGateEnabled: true },
    activeSkills: [{ id: "style_imitate" }],
  } as any;
}

function runCase(name: string, mutate: (state: any) => void, expectedPhase: string, requiredTools: string[], forbiddenTools: string[] = []) {
  const state = createInitialRunState();
  mutate(state as any);
  const caps = computeStyleTurnCaps({
    runState: state as any,
    runCtx: activeRunCtx(),
    baseAllowedToolNames: baseAllowed(),
  });
  assert(caps, `${name}: caps should exist`);
  assert(caps?.orchestratorMode === true, `${name}: orchestratorMode should be true`);
  assert(caps?.snapshot.currentPhase === expectedPhase, `${name}: phase should be ${expectedPhase}, got ${caps?.snapshot.currentPhase}`);
  for (const tool of requiredTools) {
    assert(caps?.allowedToolNames.includes(tool), `${name}: expected tool ${tool}`);
  }
  for (const tool of forbiddenTools) {
    assert(!caps?.allowedToolNames.includes(tool), `${name}: forbidden tool ${tool}`);
  }
  console.log(`PASS ${name}: phase=${caps?.snapshot.currentPhase} tools=${caps?.allowedToolNames.join(",")}`);
}

function main() {
  console.log("[Phase A] 接口与 helper 可导入");
  assert(typeof computeStyleTurnCaps === "function", "computeStyleTurnCaps should be function");
  console.log("PASS Phase A");

  console.log("[Phase B] 阶段化工具暴露");
  runCase(
    "need_style_kb",
    () => {},
    "need_style_kb",
    ["kb.search", "run.done"],
    ["lint.copy", "lint.style"],
  );
  runCase(
    "need_draft",
    (s) => { s.hasStyleKbSearch = true; },
    "need_draft",
    ["write"],
    ["lint.copy", "lint.style"],
  );

  console.log("[Phase C] lint / 改稿阶段状态机");
  runCase(
    "need_copy_lint_first_pass",
    (s) => { s.hasStyleKbSearch = true; s.hasDraftText = true; },
    "need_copy_lint",
    ["lint.copy"],
    ["lint.style"],
  );
  runCase(
    "need_copy_lint_rework",
    (s) => { s.hasStyleKbSearch = true; s.hasDraftText = true; s.lastCopyLint = { riskLevel: "high" }; },
    "need_copy_lint",
    ["lint.copy", "edit", "write"],
  );
  runCase(
    "need_style_lint_first_pass",
    (s) => { s.hasStyleKbSearch = true; s.hasDraftText = true; s.copyLintPassed = true; },
    "need_style_lint",
    ["lint.style"],
    ["lint.copy"],
  );
  runCase(
    "need_style_lint_rework",
    (s) => { s.hasStyleKbSearch = true; s.hasDraftText = true; s.copyLintPassed = true; s.lastStyleLint = { score: 61 }; },
    "need_style_lint",
    ["lint.style", "edit", "write"],
  );

  console.log("[Phase D] 完成态只做交付");
  runCase(
    "completed",
    (s) => { s.hasStyleKbSearch = true; s.hasDraftText = true; s.copyLintPassed = true; s.styleLintPassed = true; },
    "completed",
    ["write", "edit", "run.done"],
    ["lint.copy", "lint.style", "kb.search"],
  );

  console.log("[Phase E] 非风格任务不介入");
  const idle = computeStyleTurnCaps({
    runState: createInitialRunState() as any,
    runCtx: { intent: { isWritingTask: false }, gates: { styleGateEnabled: false }, activeSkills: [] } as any,
    baseAllowedToolNames: baseAllowed(),
  });
  assert(idle === null, "style orchestrator should stay inactive for non-writing task");
  console.log("PASS Phase E");

  console.log("ALL_PASS smoke-style-orchestrator");
}

main();
