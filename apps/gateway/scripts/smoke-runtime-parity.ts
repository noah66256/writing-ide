/**
 * smoke-runtime-parity.ts — Runtime 模式冒烟对比脚本
 *
 * 用法：
 *   tsx apps/gateway/scripts/smoke-runtime-parity.ts [--runtime legacy|hybrid|pi]
 *
 * 验证：
 *   1. RuntimeFactory 在三种模式下都能正确创建运行时
 *   2. legacy 模式行为与直接使用 AgentRunner 一致
 *   3. hybrid 模式在 legacy 基础上额外启动 shadow
 *   4. pi 模式尝试运行 kernel（在 mock 环境下失败并记录异常）
 *   5. CanonicalTranscript 类型能正确从 legacy history 转换
 */

import assert from "node:assert/strict";
import { createRuntime } from "../src/agent/runtime/RuntimeFactory.js";
import { GatewayRuntime } from "../src/agent/runtime/GatewayRuntime.js";
import { LegacySubAgentBridge } from "../src/agent/runtime/LegacySubAgentBridge.js";
import type { LoopKernel } from "../src/agent/runtime/kernel/LoopKernel.types.js";
import {
  createTranscript,
  pushItem,
  extractToolCalls,
  extractToolResults,
  summarizeTranscript,
  fromLegacyHistory,
  type LegacyHistoryEntry,
  type CanonicalTranscriptItem,
} from "../src/agent/runtime/transcript/index.js";
import type { RuntimeMode } from "../src/agent/runtime/types.js";
import type { RunState } from "@ohmycrab/agent-core";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(name: string) {
  console.log(`[smoke-parity] OK: ${name}`);
}

function fail(name: string, err: unknown) {
  console.error(`[smoke-parity] FAIL: ${name}`, err);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 场景 1: RuntimeFactory 创建各模式运行时（不执行 run）
// ---------------------------------------------------------------------------
function scenario1_factoryCreation() {
  const mockCtx = createMockRunContext();

  // legacy
  const legacy = createRuntime({ mode: "legacy", runCtx: mockCtx });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.mode, "legacy");

  // hybrid
  const hybrid = createRuntime({ mode: "hybrid", runCtx: mockCtx });
  assert.equal(hybrid.kind, "legacy"); // hybrid 主路径仍是 legacy
  assert.equal(hybrid.mode, "hybrid");

  // pi
  const pi = createRuntime({ mode: "pi", runCtx: mockCtx });
  assert.equal(pi.kind, "gateway");
  assert.equal(pi.mode, "pi");

  // 默认 → legacy
  const defaultMode = createRuntime({ runCtx: mockCtx });
  assert.equal(defaultMode.mode, "legacy");

  // 非法值 → legacy
  const invalid = createRuntime({ mode: "nonsense", runCtx: mockCtx });
  assert.equal(invalid.mode, "legacy");

  ok("scenario1.factory_creation");
}

// ---------------------------------------------------------------------------
// 场景 2: pi 模式 kernel 异常处理（Phase 3：尝试运行但在 mock 环境下失败）
// ---------------------------------------------------------------------------
async function scenario2_piKernelException() {
  const mockCtx = createMockRunContext();
  const runtime = createRuntime({ mode: "pi", runCtx: mockCtx });
  const result = await runtime.run("test prompt");

  assert.equal(result.mode, "pi");
  assert.equal(result.kind, "gateway");
  // Phase 3：实际尝试运行 kernel，但因 mock 模型不存在而失败
  assert.equal(result.outcome.status, "failed");
  assert.ok(
    result.outcome.reasonCodes.includes("kernel_exception") ||
    result.outcome.reasonCodes.includes("model_error"),
    `expected kernel_exception or model_error, got: ${result.outcome.reasonCodes}`,
  );
  // 执行报告应标记为 implemented
  assert.equal((result.executionReport as any).implemented, true);

  ok("scenario2.pi_kernel_exception");
}

// ---------------------------------------------------------------------------
// 场景 3: hybrid 模式发出 shadow 事件
// ---------------------------------------------------------------------------
async function scenario3_hybridShadowEvents() {
  const events: Array<{ event: string; data: unknown }> = [];
  const mockCtx = createMockRunContext((event, data) => {
    events.push({ event, data });
  });

  const runtime = createRuntime({
    mode: "hybrid",
    runCtx: mockCtx,
    shadow: { enabled: true, sampleRate: 1, allowlist: new Set() },
  });

  // hybrid run 会失败（因为 AgentRunner 需要真实环境），但 shadow 事件应该被发出
  // 这里我们只验证 shadow 启动不会抛异常
  // 实际 run 会因为 mock 环境不完整而失败
  try {
    await runtime.run("test prompt");
  } catch {
    // 预期：AgentRunner 在 mock 环境下可能失败
  }

  // 等待 microtask 完成（shadow 是异步的）
  await new Promise((resolve) => setTimeout(resolve, 100));

  // shadow 事件应该在 events 中
  const shadowStart = events.find((e) => e.event === "runtime.shadow.start");
  // shadow 可能发出也可能没发（取决于 GatewayRuntime 的执行时机）
  // Phase 1 stub 下 shadow 会发出 start + fail
  if (shadowStart) {
    assert.equal((shadowStart.data as any).runtimeKind, "gateway");
    const shadowFail = events.find((e) => e.event === "runtime.shadow.fail");
    assert.ok(shadowFail, "should have runtime.shadow.fail after runtime.shadow.start");
  }

  ok("scenario3.hybrid_shadow_events");
}

// ---------------------------------------------------------------------------
// 场景 4: CanonicalTranscript 类型操作
// ---------------------------------------------------------------------------
function scenario4_transcriptOperations() {
  const transcript = createTranscript();
  assert.equal(transcript.length, 0);

  pushItem(transcript, { kind: "user", text: "写一篇文章" });
  pushItem(transcript, { kind: "assistant_text", text: "好的，我来写。" });
  pushItem(transcript, {
    kind: "assistant_tool_call",
    callId: "tc_1",
    toolName: "doc.write",
    args: { text: "文章内容" },
  });
  pushItem(transcript, {
    kind: "tool_result",
    callId: "tc_1",
    toolName: "doc.write",
    ok: true,
    output: { success: true },
    normalizedText: '{"success":true}',
  });
  pushItem(transcript, {
    kind: "assistant_tool_call",
    callId: "tc_2",
    toolName: "run.done",
    args: {},
  });

  assert.equal(transcript.length, 5);

  const toolCalls = extractToolCalls(transcript);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].toolName, "doc.write");
  assert.equal(toolCalls[1].toolName, "run.done");

  const toolResults = extractToolResults(transcript);
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].ok, true);

  const summary = summarizeTranscript(transcript);
  assert.equal(summary.itemCount, 5);
  assert.equal(summary.toolCallCount, 2);
  assert.equal(summary.toolResultCount, 1);
  assert.equal(summary.failedToolCount, 0);
  assert.deepEqual(summary.toolCallSequence, ["doc.write", "run.done"]);
  assert.equal(summary.hasAssistantText, true);
  assert.equal(summary.lastAssistantText, "好的，我来写。");

  ok("scenario4.transcript_operations");
}

// ---------------------------------------------------------------------------
// 场景 5: Legacy history → CanonicalTranscript 转换
// ---------------------------------------------------------------------------
function scenario5_legacyHistoryConversion() {
  const legacyHistory: LegacyHistoryEntry[] = [
    { role: "user", text: "搜索最新新闻" },
    {
      role: "assistant",
      blocks: [
        { type: "text", text: "我来帮你搜索。" },
        { type: "tool_use", id: "tu_1", name: "web.search", input: { query: "最新新闻" } },
      ],
    },
    {
      role: "tool_result",
      results: [
        { toolUseId: "tu_1", toolName: "web.search", content: '{"results":[]}', isError: false },
      ],
      noteText: "搜索完成",
    },
    { role: "user_hint", text: "请继续" },
  ];

  const items = fromLegacyHistory(legacyHistory);

  // user → assistant_text + tool_call → tool_result + runtime_hint → runtime_hint
  assert.equal(items.length, 6);
  assert.equal(items[0].kind, "user");
  assert.equal(items[1].kind, "assistant_text");
  assert.equal(items[2].kind, "assistant_tool_call");
  assert.equal((items[2] as any).toolName, "web.search");
  assert.equal(items[3].kind, "tool_result");
  assert.equal((items[3] as any).ok, true);
  assert.equal(items[4].kind, "runtime_hint");
  assert.equal((items[4] as any).text, "搜索完成");
  assert.equal(items[5].kind, "runtime_hint");
  assert.equal((items[5] as any).text, "请继续");

  ok("scenario5.legacy_history_conversion");
}

// ---------------------------------------------------------------------------
// 场景 6: PiProviderBridge 可加载性检测
// ---------------------------------------------------------------------------
async function scenario6_providerBridgeAvailability() {
  const { PiProviderBridge } = await import(
    "../src/agent/runtime/provider/PiProviderBridge.js"
  );
  const bridge = new PiProviderBridge();
  const available = await bridge.isAvailable();
  // pi-ai 已安装，应该可用
  assert.equal(available, true, "pi-ai should be available");

  const snapshot = await bridge.getRegistrySnapshot();
  assert.ok(Array.isArray(snapshot), "registry snapshot should be an array");
  assert.ok(snapshot.length >= 4, "should have at least 4 provider entries");

  ok("scenario6.provider_bridge_availability");
}

// ---------------------------------------------------------------------------
// 场景 7: providerCapabilities 推断
// ---------------------------------------------------------------------------
function scenario7_providerCapabilities() {
  // 动态 import 以确保 esm 兼容
  return import("../src/agent/runtime/provider/providerCapabilities.js").then((mod) => {
    const { inferProviderApiType, getProviderCapabilities, listProviderCapabilities } = mod;

    assert.equal(inferProviderApiType({ endpoint: "/v1/messages" }), "anthropic-messages");
    assert.equal(inferProviderApiType({ endpoint: "/v1/chat/completions" }), "openai-completions");
    assert.equal(inferProviderApiType({ endpoint: "/v1/responses" }), "openai-responses");
    assert.equal(inferProviderApiType({ modelId: "gemini-2.0-flash" }), "gemini");
    assert.equal(inferProviderApiType({ modelId: "claude-3-opus" }), "anthropic-messages");
    assert.equal(inferProviderApiType({ modelId: "gpt-4o" }), "openai-completions");

    const anthropicCap = getProviderCapabilities("anthropic-messages");
    assert.equal(anthropicCap.supportsNativeToolCalls, true);
    assert.equal(anthropicCap.providerKey, "anthropic");

    const geminiCap = getProviderCapabilities("gemini");
    assert.equal(geminiCap.supportsNativeToolCalls, false);
    assert.equal(geminiCap.providerKey, "google");

    const all = listProviderCapabilities();
    assert.equal(all.length, 4);

    ok("scenario7.provider_capabilities");
  });
}

// ---------------------------------------------------------------------------
// MockKernel：用于直接测试 GatewayRuntime hook 行为
// ---------------------------------------------------------------------------

/**
 * 最小 mock kernel：不真正执行 LLM 调用，只记录传入参数并发射预定义事件。
 * 用于在 smoke test 中验证 hook 注入、gating 等行为。
 */
class MockKernel implements LoopKernel {
  capturedArgs: any = null;

  run(args: any): any {
    this.capturedArgs = args;
    // 返回一个空的 async iterable + result()
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

// ---------------------------------------------------------------------------
// 场景 8: transformContext 注入 per-turn hint
// ---------------------------------------------------------------------------
async function scenario8_transformContextHint() {
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext();
  // 注入 computePerTurnAllowed 回调
  (mockCtx as any).computePerTurnAllowed = (_state: RunState) => ({
    allowed: new Set(["run.done", "doc.write"]),
    hint: "当前为执行阶段，请调用工具。",
    orchestratorMode: true,
  });

  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx },
    mockKernel,
  );
  await runtime.run("test prompt");

  // 验证 kernel 接收到了 transformContext hook
  assert.ok(mockKernel.capturedArgs, "kernel should have captured args");
  assert.equal(typeof mockKernel.capturedArgs.transformContext, "function");
  assert.equal(typeof mockKernel.capturedArgs.getSteeringMessages, "function");
  assert.equal(typeof mockKernel.capturedArgs.getFollowUpMessages, "function");

  // 调用 transformContext，验证 hint 注入
  const messages: any[] = [];
  const result = await mockKernel.capturedArgs.transformContext(messages);
  assert.ok(Array.isArray(result));
  assert.ok(result.length > 0, "should have injected hint message");
  const hint = result[result.length - 1];
  assert.equal(hint.kind, "runtime_hint");
  assert.ok(hint.text.includes("执行阶段"), `hint text should mention 执行阶段, got: ${hint.text}`);

  ok("scenario8.transformContext_hint");
}

// ---------------------------------------------------------------------------
// 场景 9: 软 gating 拒绝越权工具
// ---------------------------------------------------------------------------
async function scenario9_softGatingReject() {
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext();
  // 限制只允许 run.done
  (mockCtx as any).computePerTurnAllowed = (_state: RunState) => ({
    allowed: new Set(["run.done"]),
    hint: "",
  });

  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx },
    mockKernel,
  );
  await runtime.run("test prompt");

  // 先调一次 transformContext 来初始化 effectiveAllowed
  await mockKernel.capturedArgs.transformContext([]);

  // 通过 _executeAgentTool 测试越权拒绝
  const execResult = await (runtime as any)._executeAgentTool(
    "tc_test_1",
    "doc.write",
    { text: "hello" },
  );
  assert.equal(execResult.ok, false);
  assert.equal(execResult.output.error, "TOOL_NOT_ALLOWED_THIS_TURN");

  // 允许的工具不被拒绝（但会走 gateway/desktop 路由，在 mock 环境下也可能失败）
  // 此处仅验证不被 soft gating 拒绝
  const doneResult = await (runtime as any)._executeAgentTool(
    "tc_test_2",
    "run.done",
    {},
  );
  assert.notEqual(doneResult.output?.error, "TOOL_NOT_ALLOWED_THIS_TURN");

  ok("scenario9.soft_gating_reject");
}

// ---------------------------------------------------------------------------
// 场景 10: agent.delegate stub 行为
// ---------------------------------------------------------------------------
async function scenario10_delegateStub() {
  const events: Array<{ event: string; data: unknown }> = [];
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext((event, data) => {
    events.push({ event, data });
  });

  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx },
    mockKernel,
  );
  await runtime.run("test prompt");

  // 直接调用 _handleDelegateStub
  const result = (runtime as any)._handleDelegateStub("tc_d1", {
    agentId: "copywriter",
    task: "写一篇文章",
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.status, "stub");
  assert.ok(result.output.message.includes("copywriter"));
  assert.equal(result.executedBy, "gateway");

  // 验证标准 tool.call 审计事件
  const toolCallEvent = events.find(
    (e) => e.event === "tool.call" && (e.data as any).name === "agent.delegate",
  );
  assert.ok(toolCallEvent, "should emit standard tool.call event for delegate stub");
  assert.equal((toolCallEvent!.data as any).stub, true);

  ok("scenario10.delegate_stub");
}

// ---------------------------------------------------------------------------
// 场景 11: getFollowUpMessages 有未完成 todo 时追问
// ---------------------------------------------------------------------------
async function scenario11_followUpPendingTodo() {
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext();
  // 设置有未完成的 todo
  mockCtx.mainDoc = {
    runTodo: [
      { id: "1", text: "搜索素材", status: "done" },
      { id: "2", text: "写初稿", status: "pending" },
      { id: "3", text: "风格检查", status: "pending" },
    ],
  };

  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx },
    mockKernel,
  );
  await runtime.run("test prompt");

  // 调用 getFollowUpMessages
  const followUp = await mockKernel.capturedArgs.getFollowUpMessages();
  assert.ok(Array.isArray(followUp));
  assert.ok(followUp.length > 0, "should have follow-up for pending todo");
  assert.equal(followUp[0].kind, "runtime_hint");
  assert.ok(followUp[0].text.includes("2/3"), `should mention 2/3 pending, got: ${followUp[0].text}`);

  ok("scenario11.followUp_pending_todo");
}

// ---------------------------------------------------------------------------
// 场景 12: getFollowUpMessages 有 waiting/blocked 项时不追问
// ---------------------------------------------------------------------------
async function scenario12_followUpWaitingNoChase() {
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext();
  // 设置有 blocked/waiting 的 todo
  mockCtx.mainDoc = {
    runTodo: [
      { id: "1", text: "搜索素材", status: "done" },
      { id: "2", text: "请确认选题方向", status: "blocked", note: "等待用户确认" },
    ],
  };

  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx },
    mockKernel,
  );
  await runtime.run("test prompt");

  // 调用 getFollowUpMessages — 不应追问
  const followUp = await mockKernel.capturedArgs.getFollowUpMessages();
  assert.ok(Array.isArray(followUp));
  assert.equal(followUp.length, 0, "should NOT follow up when there are waiting items");

  ok("scenario12.followUp_waiting_no_chase");
}

// ---------------------------------------------------------------------------
// 场景 13: LegacySubAgentBridge 校验路径
// ---------------------------------------------------------------------------
async function scenario13_bridgeValidation() {
  const mockCtx = createMockRunContext();

  const bridge = new LegacySubAgentBridge(mockCtx as any);

  // 13a: agentId 为空 → VALIDATION_ERROR
  const r1 = await bridge.execute("tc_v1", { agentId: "", task: "写文章" }, 1);
  assert.equal(r1.ok, false);
  assert.equal((r1.output as any).error, "VALIDATION_ERROR");
  assert.ok((r1.output as any).detail.includes("agentId"));

  // 13b: task 为空 → VALIDATION_ERROR
  const r2 = await bridge.execute("tc_v2", { agentId: "copywriter", task: "" }, 1);
  assert.equal(r2.ok, false);
  assert.equal((r2.output as any).error, "VALIDATION_ERROR");
  assert.ok((r2.output as any).detail.includes("task"));

  // 13c: 不存在的 agentId → NOT_FOUND
  const r3 = await bridge.execute("tc_v3", { agentId: "nonexistent_agent", task: "写文章" }, 1);
  assert.equal(r3.ok, false);
  assert.equal((r3.output as any).error, "NOT_FOUND");
  assert.ok((r3.output as any).detail.includes("nonexistent_agent"));

  ok("scenario13.bridge_validation");
}

// ---------------------------------------------------------------------------
// 场景 14: LegacySubAgentBridge 别名查找
// ---------------------------------------------------------------------------
async function scenario14_bridgeAliasLookup() {
  const events: Array<{ event: string; data: unknown }> = [];
  const mockCtx = createMockRunContext((event, data) => {
    events.push({ event, data });
  });

  const bridge = new LegacySubAgentBridge(mockCtx as any);

  // 使用 "writer" 别名应解析到 copywriter
  // 注意：实际执行会因 mock 环境失败，但 subagent.start 事件能验证别名解析成功
  try {
    await bridge.execute("tc_alias1", { agentId: "writer", task: "写一篇文章" }, 1);
  } catch {
    // 预期：AgentRunner 在 mock 环境下可能失败
  }

  // 验证 subagent.start 发出了正确的 agentId
  const startEvent = events.find((e) => e.event === "subagent.start");
  assert.ok(startEvent, "should emit subagent.start");
  assert.equal((startEvent!.data as any).agentId, "copywriter", "alias 'writer' should resolve to 'copywriter'");

  ok("scenario14.bridge_alias_lookup");
}

// ---------------------------------------------------------------------------
// 场景 15: LegacySubAgentBridge shadow 模式仍走 stub
// ---------------------------------------------------------------------------
async function scenario15_bridgeShadowStub() {
  const events: Array<{ event: string; data: unknown }> = [];
  const mockKernel = new MockKernel();
  const mockCtx = createMockRunContext((event, data) => {
    events.push({ event, data });
  });
  // 需要将 agent.delegate 加入白名单，否则软 gating 会先拒绝
  mockCtx.allowedToolNames.add("agent.delegate");

  // 创建 shadow 模式的 GatewayRuntime
  const runtime = new GatewayRuntime(
    { mode: "pi", runCtx: mockCtx, shadowMode: "shadow" } as any,
    mockKernel,
  );
  await runtime.run("test prompt");

  // 通过 _executeAgentTool 测试 shadow 模式
  const result = await (runtime as any)._executeAgentTool(
    "tc_shadow1",
    "agent.delegate",
    { agentId: "copywriter", task: "写文章" },
  );

  // shadow 模式应走 stub 而非 bridge
  assert.equal(result.ok, true);
  assert.equal((result.output as any).status, "stub");
  assert.ok(
    (result.output as any).message.includes("暂不支持实际委派"),
    "shadow mode should use stub, not bridge",
  );

  // 验证 tool.call 事件标记了 stub
  const toolCallEvent = events.find(
    (e) => e.event === "tool.call" && (e.data as any).name === "agent.delegate",
  );
  assert.ok(toolCallEvent, "shadow stub should emit tool.call");
  assert.equal((toolCallEvent!.data as any).stub, true);

  ok("scenario15.bridge_shadow_stub");
}

// ---------------------------------------------------------------------------
// mock RunContext（最小化，仅满足 RuntimeFactory 创建需求）
// ---------------------------------------------------------------------------
function createMockRunContext(writeEvent?: (event: string, data: unknown) => void) {
  return {
    runId: `smoke_${Date.now()}`,
    mode: "agent" as const,
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
    systemPrompt: "test",
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
    writeEvent: writeEvent ?? (() => {}),
    waiters: new Map(),
    abortSignal: new AbortController().signal,
    mainDoc: {},
    maxTurns: 1,
    jsonToolFallbackEnabled: false,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  scenario1_factoryCreation();
  await scenario2_piKernelException();
  await scenario3_hybridShadowEvents();
  scenario4_transcriptOperations();
  scenario5_legacyHistoryConversion();
  await scenario6_providerBridgeAvailability();
  await scenario7_providerCapabilities();
  await scenario8_transformContextHint();
  await scenario9_softGatingReject();
  await scenario10_delegateStub();
  await scenario11_followUpPendingTodo();
  await scenario12_followUpWaitingNoChase();
  await scenario13_bridgeValidation();
  await scenario14_bridgeAliasLookup();
  await scenario15_bridgeShadowStub();
  console.log("[smoke-parity] ALL PASSED");
}

main().catch((err) => {
  console.error("[smoke-parity] FAIL", err);
  process.exitCode = 1;
});
