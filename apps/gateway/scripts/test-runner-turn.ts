/**
 * WritingAgentRunner 双路径回归测试（Phase C 安全网）
 *
 * 覆盖场景：
 *   1. Anthropic 路径 - 纯文本回复
 *   2. Anthropic 路径 - tool_use(run.done)
 *   3. OpenAI 路径 - 纯文本回复
 *   4. OpenAI 路径 - XML 工具调用(run.done)
 *   5. OpenAI 路径 - 空响应重试
 *   6. tool_result 注入格式（preferNativeToolCall 分支）
 *
 * 运行：npm -w @writing-ide/gateway run test:runner-turn
 */
import assert from "node:assert/strict";
import { encodeToolName } from "@writing-ide/tools";
import { WritingAgentRunner, type ModelApiType, type RunContext } from "../src/agent/writingAgentRunner.js";
import { buildInjectedToolResultMessages } from "../src/llm/providerAdapter.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Emitted = { event: string; data: any };

function ok(name: string) {
  console.log(`[test-runner-turn] OK: ${name}`);
}

/** 构造 SSE 响应 */
function sseResponse(lines: string[]): Response {
  const body = lines.join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---- Anthropic SSE helpers ----

function anthropicTextSse(text: string): Response {
  return sseResponse([
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ]);
}

function anthropicToolUseSse(toolName: string, inputJson = "{}"): Response {
  const encodedName = encodeToolName(toolName);
  return sseResponse([
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}`,
    "",
    "event: content_block_start",
    `data: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_test_1", name: encodedName },
    })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: inputJson },
    })}`,
    "",
    "event: content_block_stop",
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ]);
}

// ---- OpenAI SSE helpers ----

function openAiTextSse(text: string): Response {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ]);
}

function openAiXmlToolCallSse(xml: string): Response {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: xml } }] })}`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ]);
}

// ---- RunContext / Runner 工厂 ----

function buildRunner(args: {
  endpoint: string;
  apiType: ModelApiType;
  allowedToolNames?: string[];
  toolResultFormat?: "xml" | "text";
  maxTurns?: number;
}) {
  const events: Emitted[] = [];
  const abort = new AbortController();
  const ctx: RunContext = {
    runId: `test_${Date.now()}`,
    mode: "agent",
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
    allowedToolNames: new Set(args.allowedToolNames ?? ["run.done", "run.mainDoc.get"]),
    systemPrompt: "test system prompt",
    toolSidecar: null,
    styleLinterLibraries: [],
    fastify: { log: { info() {}, warn() {}, error() {} } },
    authorization: null,
    modelId: "test-model",
    apiKey: "test-key",
    baseUrl: "https://mock.local",
    endpoint: args.endpoint,
    apiType: args.apiType,
    toolResultFormat: args.toolResultFormat ?? "xml",
    styleLibIds: [],
    writeEvent: (event, data) => events.push({ event, data }),
    waiters: new Map(),
    abortSignal: abort.signal,
    mainDoc: {},
    maxTurns: args.maxTurns ?? 3,
    jsonToolFallbackEnabled: false,
  };
  return { runner: new WritingAgentRunner(ctx), events, abort };
}

function hasEvent(events: Emitted[], eventName: string): boolean {
  return events.some((e) => e.event === eventName);
}

function hasToolCallEvent(events: Emitted[], toolName: string): boolean {
  return events.some(
    (e) => e.event === "tool.call" && String((e.data as any)?.name ?? "") === toolName,
  );
}

function hasAssistantDelta(events: Emitted[]): boolean {
  return events.some(
    (e) => e.event === "assistant.delta" && String((e.data as any)?.delta ?? "").trim().length > 0,
  );
}

// ---- fetch mock 包装 ----

async function withMockFetch(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// 场景 1: Anthropic 路径 - 纯文本回复
// ---------------------------------------------------------------------------
async function scenario1_anthropicText() {
  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/messages")) return anthropicTextSse("hello from anthropic");
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "anthropic-messages",
      endpoint: "/v1/messages",
    });
    await runner.run("hi");
    const outcome = runner.getOutcome();
    assert.equal(outcome.status, "completed", `expected completed, got ${outcome.status} (${outcome.reason})`);
    assert.equal(hasAssistantDelta(events), true, "should emit assistant.delta");
    assert.equal(hasEvent(events, "assistant.start"), true, "should emit assistant.start");
    assert.equal(hasEvent(events, "assistant.done"), true, "should emit assistant.done");
  });
  ok("scenario1.anthropic.text");
}

// ---------------------------------------------------------------------------
// 场景 2: Anthropic 路径 - tool_use(run.done)
// ---------------------------------------------------------------------------
async function scenario2_anthropicToolUse() {
  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/messages")) return anthropicToolUseSse("run.done", "{}");
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "anthropic-messages",
      endpoint: "/v1/messages",
      allowedToolNames: ["run.done"],
    });
    await runner.run("finish the task");
    const outcome = runner.getOutcome();
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason, "run_done", `expected run_done, got ${outcome.reason}`);
    assert.equal(hasToolCallEvent(events, "run.done"), true, "should emit tool.call for run.done");
  });
  ok("scenario2.anthropic.tool_use.run_done");
}

// ---------------------------------------------------------------------------
// 场景 3: OpenAI 路径 - 纯文本回复
// ---------------------------------------------------------------------------
async function scenario3_openAiText() {
  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/chat/completions")) return openAiTextSse("hello from openai");
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "openai-completions",
      endpoint: "/v1/chat/completions",
    });
    await runner.run("hi");
    const outcome = runner.getOutcome();
    assert.equal(outcome.status, "completed", `expected completed, got ${outcome.status} (${outcome.reason})`);
    assert.equal(hasAssistantDelta(events), true, "should emit assistant.delta");
  });
  ok("scenario3.openai.text");
}

// ---------------------------------------------------------------------------
// 场景 4: OpenAI 路径 - XML 工具调用(run.done)
// ---------------------------------------------------------------------------
async function scenario4_openAiXmlToolCall() {
  const xml = [
    "<tool_calls>",
    `  <tool_call name="run.done">`,
    `    <arg name="note"><![CDATA[all done]]></arg>`,
    "  </tool_call>",
    "</tool_calls>",
  ].join("\n");

  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/chat/completions")) return openAiXmlToolCallSse(xml);
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "openai-completions",
      endpoint: "/v1/chat/completions",
      allowedToolNames: ["run.done"],
    });
    await runner.run("finish the task");
    const outcome = runner.getOutcome();
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason, "run_done", `expected run_done, got ${outcome.reason}`);
    assert.equal(hasToolCallEvent(events, "run.done"), true, "should emit tool.call for run.done");
  });
  ok("scenario4.openai.xml_tool_call.run_done");
}

// ---------------------------------------------------------------------------
// 场景 5: OpenAI 路径 - 空响应触发重试
// ---------------------------------------------------------------------------
async function scenario5_openAiEmptyRetry() {
  let callCount = 0;
  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/chat/completions")) {
      return new Response("unexpected", { status: 500 });
    }
    callCount += 1;
    if (callCount === 1) {
      // 首次返回空 body——触发重试
      return sseResponse(["data: [DONE]"]);
    }
    return openAiTextSse("retry succeeded");
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "openai-completions",
      endpoint: "/v1/chat/completions",
    });
    await runner.run("hello");
    const outcome = runner.getOutcome();
    assert.equal(outcome.status, "completed", `expected completed, got ${outcome.status} (${outcome.reason})`);
    assert.ok(callCount >= 2, `expected >= 2 fetch calls, got ${callCount}`);
    assert.equal(hasAssistantDelta(events), true, "should emit assistant.delta after retry");
  });
  ok("scenario5.openai.empty_retry");
}

// ---------------------------------------------------------------------------
// 场景 6: tool_result 注入格式
// ---------------------------------------------------------------------------
async function scenario6_toolResultInjectionFormat() {
  // 6a: Anthropic 路径不加 preferNativeToolCall
  const msgsA = buildInjectedToolResultMessages({
    toolResultFormat: "xml",
    toolResultXml: `<tool_result name="run.done"><![CDATA[{"ok":true}]]></tool_result>`,
    toolResultText: `[tool_result] run.done: {"ok":true}`,
    preferNativeToolCall: false,
  });
  assert.ok(msgsA.length >= 2, "should have system + user messages");
  // continuation prompt 应催促 XML 输出
  const continuationA = String(msgsA[msgsA.length - 1]?.content ?? "");
  assert.match(continuationA, /按协议输出 XML/, "Anthropic continuation should mention XML");

  // 6b: OpenAI 路径使用 preferNativeToolCall=true
  const msgsB = buildInjectedToolResultMessages({
    toolResultFormat: "xml",
    toolResultXml: `<tool_result name="run.done"><![CDATA[{"ok":true}]]></tool_result>`,
    toolResultText: `[tool_result] run.done: {"ok":true}`,
    preferNativeToolCall: true,
  });
  assert.ok(msgsB.length >= 2, "should have system + user messages");
  const continuationB = String(msgsB[msgsB.length - 1]?.content ?? "");
  assert.match(continuationB, /只有在确有必要时再调用工具/, "OpenAI continuation should be softer");
  assert.doesNotMatch(continuationB, /按协议输出 XML/, "OpenAI continuation should NOT mention XML");

  ok("scenario6.tool_result_injection_format");
}

// ---------------------------------------------------------------------------
// 场景 7: Anthropic 路径 - 缺参工具调用触发预验证拦截
// ---------------------------------------------------------------------------
async function scenario7_anthropicMissingParamPreValidation() {
  // 模型返回 kb.search({})，缺少 required 参数 query
  // 预期：Gateway 在 step 11.5 预验证拦截，presetResults 命中，
  //       _executeTool 不被调用（不下发到 Desktop），
  //       但 tool.result 事件包含 ERR_PARAM_SCHEMA_MISMATCH
  await withMockFetch(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/messages")) return anthropicToolUseSse("kb.search", "{}");
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const { runner, events } = buildRunner({
      apiType: "anthropic-messages",
      endpoint: "/v1/messages",
      allowedToolNames: ["kb.search", "run.done"],
      maxTurns: 1,
    });

    await runner.run("搜索知识库");

    // presetResults 命中 → _executeTool 未被调用 → 不应有 tool.call 事件
    assert.equal(
      hasToolCallEvent(events, "kb.search"), false,
      "should NOT emit tool.call for kb.search (preset intercept, not sent to Desktop)",
    );

    // tool.result 事件应包含 ERR_PARAM_SCHEMA_MISMATCH
    const toolResultEvent = events.find(
      (e) => e.event === "tool.result" && String(e.data?.name ?? "") === "kb.search",
    );
    assert.ok(toolResultEvent, "should have tool.result event for kb.search");
    const resultOutput = toolResultEvent!.data?.output;
    assert.equal(
      String(resultOutput?.error ?? ""),
      "ERR_PARAM_SCHEMA_MISMATCH",
      `tool.result should contain ERR_PARAM_SCHEMA_MISMATCH, got: ${JSON.stringify(resultOutput)}`,
    );
  });
  ok("scenario7.anthropic.missing_param_pre_validation");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  await scenario1_anthropicText();
  await scenario2_anthropicToolUse();
  await scenario3_openAiText();
  await scenario4_openAiXmlToolCall();
  await scenario5_openAiEmptyRetry();
  await scenario6_toolResultInjectionFormat();
  await scenario7_anthropicMissingParamPreValidation();
  console.log("[test-runner-turn] ALL PASSED");
}

main().catch((err) => {
  console.error("[test-runner-turn] FAIL", err);
  process.exitCode = 1;
});
