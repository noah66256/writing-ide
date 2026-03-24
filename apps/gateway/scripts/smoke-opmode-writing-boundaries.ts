import assert from "node:assert/strict";

import { createInitialRunState } from "@ohmycrab/agent-core";

import { HIGH_RISK_TOOL_NAME_SET } from "../src/agent/coreTools.js";
import { collectPortableActivationToolNames } from "../src/agent/portableSkillCompat.js";
import { shouldExposeRuntimeHighRiskToolsForRun } from "../src/agent/runFactory.js";
import { GatewayRuntime } from "../src/agent/runtime/GatewayRuntime.js";
import { executeServerToolOnGateway } from "../src/agent/serverToolRunner.js";
import { computeStyleTurnCaps } from "../src/agent/styleOrchestrator.js";

function ok(name: string) {
  console.log(`[smoke-opmode-writing-boundaries] OK: ${name}`);
}

function baseAllowedTools() {
  return new Set([
    "run.done",
    "run.mainDoc.update",
    "kb.listLibraries",
    "kb.search",
    "write",
    "edit",
    "lint.copy",
    "lint.style",
  ]);
}

class MockKernel {
  capturedArgs: any = null;

  run(args: any): any {
    this.capturedArgs = args;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { value: undefined, done: true as const };
          },
        };
      },
      async result() {
        return [];
      },
    };
  }
}

function createMockRunContext(overrides?: Record<string, unknown>) {
  return {
    runId: `smoke_${Date.now()}`,
    mode: "agent" as const,
    opMode: "creative" as const,
    intent: {
      forceProceed: false,
      wantsWrite: false,
      wantsOkOnly: false,
      isWritingTask: false,
      skipLint: true,
      skipCta: true,
    } as any,
    gates: {
      styleGateEnabled: false,
      lintGateEnabled: false,
      copyGateEnabled: false,
      hasStyleLibrary: false,
      hasNonStyleLibraries: false,
      styleLibIds: [],
      nonStyleLibIds: [],
      styleLibIdSet: new Set<string>(),
    } as any,
    activeSkills: [],
    allowedToolNames: new Set(["run.done"]),
    systemPrompt: "smoke test",
    toolSidecar: null,
    styleLinterLibraries: [],
    fastify: { log: { info() {}, warn() {}, error() {} } },
    authorization: null,
    modelId: "test-model",
    apiKey: "test-key",
    baseUrl: "https://mock.local",
    endpoint: "/v1/chat/completions",
    apiType: "openai-completions" as const,
    toolResultFormat: "xml" as const,
    styleLibIds: [],
    writeEvent: () => {},
    waiters: new Map(),
    abortSignal: new AbortController().signal,
    mainDoc: {},
    maxTurns: 1,
    jsonToolFallbackEnabled: false,
    ...(overrides ?? {}),
  } as any;
}

function scenario1_highRiskSetIncludesBash() {
  assert.equal(HIGH_RISK_TOOL_NAME_SET.has("Bash"), true, "Bash should be part of high-risk tool set");
  assert.equal(HIGH_RISK_TOOL_NAME_SET.has("Agent"), true, "Agent should be part of high-risk tool set");
  ok("scenario1.high_risk_contains_bash_and_agent");
}

function scenario2_portableActivationFiltersHighRiskTools() {
  const toolNames = collectPortableActivationToolNames([
    {
      id: "portable_writer",
      name: "Portable Writer",
      portable: true,
      allowedTools: ["Read", "Bash(python -V)", "Write", "Task"],
    } as any,
  ]);

  assert.equal(toolNames.has("read"), true, "read should still be exposed for activation");
  assert.equal(toolNames.has("write"), true, "write should still be exposed for activation");
  assert.equal(toolNames.has("spawn_agent"), true, "Task alias should still be exposed for activation");
  assert.equal(toolNames.has("Bash"), false, "high-risk Bash should not leak into activation toolNames");
  ok("scenario2.portable_activation_filters_high_risk");
}

async function scenario3_skillsActivateDoesNotLeakHighRiskTools() {
  const result = await executeServerToolOnGateway({
    fastify: { log: { info() {}, warn() {}, error() {} } } as any,
    call: {
      name: "skills.activate",
      args: {
        name: "portable_writer",
        arguments: "",
      },
    },
    toolSidecar: null,
    styleLinterLibraries: [],
    mainDoc: {},
    mode: "agent",
    allowedToolNames: new Set(["skills.activate"]),
    skillManifestById: new Map([
      [
        "portable_writer",
        {
          id: "portable_writer",
          name: "Portable Writer",
          portable: true,
          toolCaps: { allowTools: ["Bash", "write"] },
          allowedTools: ["Read", "Bash(python -V)", "Write"],
        },
      ],
    ]) as any,
    activeSkillIds: [],
  } as any);

  assert.equal(result.ok, true, "skills.activate should succeed");
  const toolNames = Array.isArray((result as any).output?.activation?.toolNames) ? (result as any).output.activation.toolNames : [];
  assert.equal(toolNames.includes("write"), true, "safe write tool should remain in activation payload");
  assert.equal(toolNames.includes("Bash"), false, "high-risk Bash should not leak into activation payload");
  assert.equal((result as any).output?.activation?.executionScope, "skill_activation", "activation payload should expose non-escalating scope");
  ok("scenario3.skills_activate_does_not_leak_high_risk");
}

function scenario4_runtimeHighRiskExposurePolicy() {
  assert.equal(
    shouldExposeRuntimeHighRiskToolsForRun({
      opMode: "creative",
      userPrompt: "写一篇口播稿",
      routeId: "task_execution",
      intentIsWritingTask: true,
      styleWorkflowActive: true,
      hasPortableScopedHighRiskGrant: false,
    }),
    false,
    "creative writing run should hide runtime high-risk tools",
  );

  assert.equal(
    shouldExposeRuntimeHighRiskToolsForRun({
      opMode: "creative",
      userPrompt: "执行 /portable-writer",
      routeId: "task_execution",
      intentIsWritingTask: true,
      styleWorkflowActive: false,
      hasPortableScopedHighRiskGrant: true,
    }),
    true,
    "explicit portable scoped grant should keep runtime high-risk tools visible",
  );

  assert.equal(
    shouldExposeRuntimeHighRiskToolsForRun({
      opMode: "assistant",
      userPrompt: "写一篇小红书文案",
      routeId: "task_execution",
      intentIsWritingTask: true,
      styleWorkflowActive: true,
      hasPortableScopedHighRiskGrant: false,
    }),
    true,
    "assistant mode should always expose runtime high-risk tools (LLM decides usage)",
  );

  assert.equal(
    shouldExposeRuntimeHighRiskToolsForRun({
      opMode: "assistant",
      userPrompt: "写一个 python 脚本生成 docx",
      routeId: "task_execution",
      intentIsWritingTask: true,
      styleWorkflowActive: false,
      hasPortableScopedHighRiskGrant: false,
    }),
    true,
    "explicit code intent should reopen runtime high-risk tools in assistant mode",
  );

  assert.equal(
    shouldExposeRuntimeHighRiskToolsForRun({
      opMode: "assistant",
      userPrompt: "把 drafts/a.md 改名到 archive/a.md",
      routeId: "file_ops",
      intentIsWritingTask: true,
      styleWorkflowActive: true,
      hasPortableScopedHighRiskGrant: false,
    }),
    true,
    "file ops route should not be swallowed by sticky writing gate",
  );

  ok("scenario4.runtime_high_risk_exposure_policy");
}

function scenario5_styleHintWarnsAgainstBypass() {
  const state = createInitialRunState() as any;
  state.hasSelectedStyleLibrary = true;
  state.topicConfirmed = true;
  state.hasStyleKbSearch = true;
  state.hasStylePlan = true;

  const caps = computeStyleTurnCaps({
    runState: state,
    runCtx: {
      intent: { isWritingTask: true },
      gates: { styleGateEnabled: true },
      activeSkills: [{ id: "style_imitate" }],
    } as any,
    baseAllowedToolNames: baseAllowedTools(),
  });

  assert.equal(caps?.snapshot.currentPhase, "need_draft", "expected style phase to be need_draft");
  assert.match(
    String(caps?.hint ?? ""),
    /code\.exec \/ shell\.exec \/ process\.\*/,
    "need_draft hint should warn against shell/code bypass",
  );
  ok("scenario5.style_hint_warns_against_bypass");
}

async function scenario6_runtimeCreativeDenyCodeExec() {
  const kernel = new MockKernel();
  const runtime = new GatewayRuntime(
    {
      mode: "pi",
      runCtx: createMockRunContext({
        opMode: "creative",
        allowedToolNames: new Set(["Bash"]),
      }),
    } as any,
    kernel as any,
  );

  await runtime.run("test prompt");
  await kernel.capturedArgs.transformContext([]);

  const result = await (runtime as any)._executeAgentTool("tc_bash", "Bash", { code: "print(1)" });
  assert.equal(result.ok, false, "creative Bash should be denied");
  assert.equal(result.output?.error, "ASSISTANT_MODE_REQUIRED");
  ok("scenario6.runtime_creative_deny_bash");
}

async function scenario7_runtimeSkillActivationStillDenied() {
  const kernel = new MockKernel();
  const runtime = new GatewayRuntime(
    {
      mode: "pi",
      runCtx: createMockRunContext({
        opMode: "creative",
        allowedToolNames: new Set(["Bash"]),
        portableSkillContext: {
          activeSkillIds: ["portable_writer"],
          primarySkillId: "portable_writer",
          executionScope: "skill_activation",
          scopedHighRiskToolNames: ["Bash"],
          allowedToolPolicy: {
            activeSkillIds: ["portable_writer"],
            allowedToolNames: new Set(["Bash"]),
            rules: [],
            rulesByTool: new Map(),
            unsupportedEntries: [],
          },
        },
      }),
    } as any,
    kernel as any,
  );

  await runtime.run("test prompt");
  await kernel.capturedArgs.transformContext([]);

  const result = await (runtime as any)._executeAgentTool("tc_skill_activation", "Bash", { code: "print(2)" });
  assert.equal(result.ok, false, "skill_activation scope should not bypass creative deny");
  assert.equal(result.output?.error, "ASSISTANT_MODE_REQUIRED");
  ok("scenario7.runtime_skill_activation_still_denied");
}

async function main() {
  scenario1_highRiskSetIncludesBash();
  scenario2_portableActivationFiltersHighRiskTools();
  await scenario3_skillsActivateDoesNotLeakHighRiskTools();
  scenario4_runtimeHighRiskExposurePolicy();
  scenario5_styleHintWarnsAgainstBypass();
  await scenario6_runtimeCreativeDenyCodeExec();
  await scenario7_runtimeSkillActivationStillDenied();
  console.log("ALL_PASS smoke-opmode-writing-boundaries");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
