import assert from "node:assert/strict";
import { detectRunIntent } from "@writing-ide/agent-core";
import { completionOnceViaProvider } from "../src/llm/providerAdapter.js";
import { computeIntentRouteDecisionPhase0 } from "../src/agent/runFactory.js";

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
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.endsWith("/v1/responses") || url.endsWith("/responses")) {
      return new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "ok responses" }] }],
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith("/v1/chat/completions") || url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok chat completions" } }],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
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

async function main() {
  await smokeRouteDeleteOnly();
  await smokeProviderEndpoints();
  // eslint-disable-next-line no-console
  console.log("[smoke-messages-responses] DONE");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[smoke-messages-responses] FAIL", e);
  process.exit(1);
});

