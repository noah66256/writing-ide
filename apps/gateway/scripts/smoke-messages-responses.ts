import assert from "node:assert/strict";
import { detectRunIntent } from "@ohmycrab/agent-core";
import { completionOnceViaProvider, streamChatCompletionViaProvider } from "../src/llm/providerAdapter.js";
import { getAdapterByEndpoint } from "../src/llm/providerAdapter.js";
import { computeIntentRouteDecisionPhase0 } from "../src/agent/runFactory.js";
import { sanitizeAssistantUserFacingText } from "../src/agent/userFacingText.js";
import { TurnEngine } from "../src/agent/turnEngine.js";

function ok(name: string) {
  // eslint-disable-next-line no-console
  console.log(`[smoke-messages-responses] OK: ${name}`);
}

async function smokeRouteDeleteOnly() {
  const mode = "agent" as const;
  const userPrompt = "把桌面里 ~ 开头的临时文件都删了";
  const intent = detectRunIntent({ mode, userPrompt, mainDocRunIntent: "auto" });
  const r = computeIntentRouteDecisionPhase0({
    mode,
    userPrompt,
    mainDocRunIntent: "auto",
    runTodo: [],
    intent,
    ideSummary: null,
  });
  assert.equal(r.routeId, "file_delete_only");
  ok("route.file_delete_only");
}

async function smokeProviderEndpoints() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const bodyTextFromInit = typeof init?.body === "string" ? init.body : "";

    if (url.endsWith("/v1/responses") || url.endsWith("/responses")) {
      const req = input instanceof Request ? input : null;
      const bodyText = req ? await req.text().catch(() => "") : bodyTextFromInit;
      const bodyJson = bodyText ? JSON.parse(bodyText) : {};
      if (String(bodyJson?.model ?? "").includes("toolcall-streamdelta")) {
        const stream = new ReadableStream({
          start(controller) {
            const lines = [
              `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_resp_stream_1","call_id":"fc_resp_stream_1","name":"run_dot_setTodoList","arguments":""}}\n\n`,
              `data: {"type":"response.function_call_arguments.delta","item_id":"fc_resp_stream_1","output_index":0,"delta":"{\\"items\\":[{\\"text\\":\\"第一步\\"}]}"}\n\n`,
              `data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":3,"output_tokens":5}}}\n\n`,
              `data: [DONE]\n\n`,
            ];
            for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (String(bodyJson?.model ?? "").includes("toolcall")) {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "function_call",
                id: "fc_resp_1",
                name: "project_dot_listFiles",
                arguments: "{}",
              },
            ],
            usage: { input_tokens: 3, output_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "ok responses" }] }],
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/v1/chat/completions") || url.endsWith("/chat/completions")) {
      const req = input instanceof Request ? input : null;
      const bodyText = req ? await req.text().catch(() => "") : bodyTextFromInit;
      const bodyJson = bodyText ? JSON.parse(bodyText) : {};
      if (String(bodyJson?.model ?? "").includes("toolcall")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "fc_chat_1",
                      type: "function",
                      function: {
                        name: "project_dot_listFiles",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok chat completions" } }],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes(":generateContent") || url.includes(":streamGenerateContent")) {
      if (url.includes(":streamGenerateContent")) {
        const stream = new ReadableStream({
          start(controller) {
            const lines = [
              JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok gemini stream" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 } }) + "\n",
            ];
            for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok gemini generate" }] } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/messages")) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok anthropic messages" }],
          usage: { input_tokens: 7, output_tokens: 9 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `unexpected url: ${url}` }), { status: 500 });
  }) as typeof globalThis.fetch;

  try {
    const messages = [{ role: "user" as const, content: "hello" }];

    const r1 = await completionOnceViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/responses",
      apiKey: "k",
      model: "gpt-4o-mini",
      messages,
    });
    assert.equal(r1.ok, true);
    assert.equal((r1 as any).content, "ok responses");
    ok("provider.responses");

    const r2 = await completionOnceViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/chat/completions",
      apiKey: "k",
      model: "gpt-4o-mini",
      messages,
    });
    assert.equal(r2.ok, true);
    assert.equal((r2 as any).content, "ok chat completions");
    ok("provider.chat_completions");

    const r4 = await completionOnceViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/responses",
      apiKey: "k",
      model: "gpt-4o-mini-toolcall",
      messages,
      tools: [{ name: "project_dot_listFiles", description: "list files", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { type: "any" },
      parallelToolCalls: false,
    });
    assert.equal(r4.ok, true);
    assert.match(String((r4 as any).content ?? ""), /<tool_calls>/);
    ok("provider.responses.tool_call_bridge");

    const r5 = await completionOnceViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/chat/completions",
      apiKey: "k",
      model: "gpt-4o-mini-toolcall",
      messages,
      tools: [{ name: "project_dot_listFiles", description: "list files", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { type: "any" },
      parallelToolCalls: false,
    });
    assert.equal(r5.ok, true);
    assert.match(String((r5 as any).content ?? ""), /<tool_calls>/);
    ok("provider.chat_completions.tool_call_bridge");

    const streamResPieces: string[] = [];
    const streamResEvents: any[] = [];
    for await (const ev of streamChatCompletionViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/responses",
      apiKey: "k",
      model: "gpt-4o-mini-toolcall",
      messages,
      tools: [{ name: "project_dot_listFiles", description: "list files", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { type: "any" },
      parallelToolCalls: false,
    })) {
      streamResEvents.push(ev);
      if (ev.type === "delta") streamResPieces.push(String(ev.delta ?? ""));
      if (ev.type === "error") throw new Error(String((ev as any).error ?? "stream responses failed"));
    }
    assert.match(streamResPieces.join(""), /<tool_calls>/);
    ok("provider.responses.stream_tool_call_bridge");

    const streamResDeltaPieces: string[] = [];
    for await (const ev of streamChatCompletionViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/responses",
      apiKey: "k",
      model: "gpt-4o-mini-toolcall-streamdelta",
      messages,
      tools: [{ name: "run_dot_setTodoList", description: "todo", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } }, required: ["items"] } }],
      toolChoice: { type: "any" },
      parallelToolCalls: false,
    })) {
      if (ev.type === "delta") streamResDeltaPieces.push(String(ev.delta ?? ""));
      if (ev.type === "error") throw new Error(String((ev as any).error ?? "stream responses delta failed"));
    }
    assert.match(streamResDeltaPieces.join(""), /run_dot_setTodoList/);
    assert.match(streamResDeltaPieces.join(""), /items/);
    ok("provider.responses.stream_function_call_arguments_delta");

    const streamChatPieces: string[] = [];
    for await (const ev of streamChatCompletionViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/chat/completions",
      apiKey: "k",
      model: "gpt-4o-mini-toolcall",
      messages,
      tools: [{ name: "project_dot_listFiles", description: "list files", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { type: "any" },
      parallelToolCalls: false,
    })) {
      if (ev.type === "delta") streamChatPieces.push(String(ev.delta ?? ""));
      if (ev.type === "error") throw new Error(String((ev as any).error ?? "stream chat failed"));
    }
    assert.match(streamChatPieces.join(""), /<tool_calls>/);
    ok("provider.chat_completions.stream_tool_call_bridge");

    const responsesAdapter = getAdapterByEndpoint("/v1/responses");
    assert.equal(responsesAdapter.id, "responses");
    const canonical = responsesAdapter.toCanonicalEvents(streamResEvents as any);
    assert.ok(canonical.some((ev) => ev.type === "tool_call"));
    ok("provider.responses.adapter.canonical");

    const rGemini = await completionOnceViaProvider({
      baseUrl: "https://generativelanguage.googleapis.com",
      endpoint: "/v1beta/models/gemini-3.1-pro-preview:generateContent",
      apiKey: "k",
      model: "gemini-3.1-pro-preview",
      messages,
    });
    assert.equal(rGemini.ok, true);
    assert.equal((rGemini as any).content, "ok gemini generate");
    ok("provider.gemini.generate_content");

    const geminiStreamPieces: string[] = [];
    for await (const ev of streamChatCompletionViaProvider({
      baseUrl: "https://generativelanguage.googleapis.com",
      endpoint: "/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent",
      apiKey: "k",
      model: "gemini-3.1-flash-lite-preview",
      messages,
    })) {
      if (ev.type === "delta") geminiStreamPieces.push(String(ev.delta ?? ""));
      if (ev.type === "error") throw new Error(String((ev as any).error ?? "gemini stream failed"));
    }
    assert.equal(geminiStreamPieces.join(""), "ok gemini stream");
    ok("provider.gemini.stream_generate_content");

    const r3 = await completionOnceViaProvider({
      baseUrl: "https://mock.local",
      endpoint: "/v1/messages",
      apiKey: "k",
      model: "claude-3-5-haiku",
      messages,
    });
    assert.equal(r3.ok, true);
    assert.equal((r3 as any).content, "ok anthropic messages");
    ok("provider.messages");
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function smokeOutputGuards() {
  {
    const s = sanitizeAssistantUserFacingText('{\"id\":\"todo\",\"status\":\"done\"}', {
      dropPureJsonPayload: true,
    });
    assert.equal(s.text, "");
    assert.equal(s.dropped, true);
  }
  {
    const s = sanitizeAssistantUserFacingText(
      "Before\\n[Tool Call: exec (ID: call_1)]\\nArguments: {\"cmd\":\"ls\"}\\nAfter",
      { dropPureJsonPayload: false },
    );
    assert.match(s.text, /Before/);
    assert.match(s.text, /After/);
    assert.doesNotMatch(s.text, /Tool Call/i);
  }
  {
    const te = new TurnEngine();
    te.record({ type: "model_tool_call", callId: "call_1", name: "project.listFiles", args: {} });
    te.record({ type: "tool_result", callId: "call_2", name: "project.listFiles", ok: true, output: { ok: true } });
    const snapshot = te.getSnapshot();
    assert.equal(snapshot.pendingToolCallCount, 1);
    assert.equal(snapshot.unmatchedToolResultCount, 1);
  }
  ok("output.guards");
}

async function main() {
  await smokeRouteDeleteOnly();
  await smokeProviderEndpoints();
  await smokeOutputGuards();
  // eslint-disable-next-line no-console
  console.log("[smoke-messages-responses] DONE");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[smoke-messages-responses] FAIL", e);
  process.exit(1);
});
