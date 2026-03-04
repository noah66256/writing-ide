import type {
  ChatCompletionOnceResult,
  OpenAiChatMessage,
  OpenAiCompatTool,
  OpenAiCompatToolChoice,
  StreamDeltaEvent,
} from "./openaiCompat.js";
import { chatCompletionOnce, streamChatCompletions } from "./openaiCompat.js";
import { isGeminiEndpoint, streamGeminiGenerateContent } from "./gemini.js";
import { completionOnceAnthropicMessages } from "./anthropicMessages.js";

export type ProviderStreamArgs = {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  includeUsage?: boolean;
  tools?: OpenAiCompatTool[];
  toolChoice?: OpenAiCompatToolChoice;
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
};

export type ToolResultFormat = "xml" | "text";

export function isGeminiLikeEndpoint(endpoint: string) {
  return isGeminiEndpoint(endpoint);
}

export async function* streamChatCompletionViaProvider(args: ProviderStreamArgs): AsyncGenerator<StreamDeltaEvent> {
  const endpoint = String(args.endpoint || "/v1/chat/completions");
  if (isGeminiEndpoint(endpoint)) {
    yield* streamGeminiGenerateContent({
      baseUrl: args.baseUrl,
      endpoint,
      apiKey: args.apiKey,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
    });
    return;
  }

  yield* streamChatCompletions({
    config: { baseUrl: args.baseUrl, apiKey: args.apiKey },
    endpoint,
    model: args.model,
    messages: args.messages,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    includeUsage: args.includeUsage,
    tools: args.tools,
    toolChoice: args.toolChoice,
    parallelToolCalls: args.parallelToolCalls,
    signal: args.signal,
  });
}

export function buildInjectedToolResultMessages(args: {
  toolResultFormat: ToolResultFormat;
  toolResultXml: string;
  toolResultText: string;
}): OpenAiChatMessage[] {
  const useText = args.toolResultFormat === "text";
  const out: OpenAiChatMessage[] = [
    { role: useText ? "user" : "system", content: useText ? args.toolResultText : args.toolResultXml },
  ];
  // 兼容部分代理：当 tool_result 作为最后一条消息时，可能会出现“choices 为空不续写”。
  // 这里额外补一条普通 user 消息，让模型明确“继续推进下一步”（XML/text 都加，避免空输出）。
  out.push({
    role: "user",
    content:
      "继续。请基于以上 tool_result 推进下一步。若需要调用工具，请按协议输出 XML（优先 <tool_calls>...</tool_calls>；旧式 <function_calls>...</function_calls> 也可被兼容解析），整条消息不要夹杂自然语言。",
  });
  return out;
}

function parseUpstreamStatusFromErrorText(errorText: string): number | undefined {
  const raw = String(errorText ?? "").trim();
  if (!raw) return undefined;
  // 1) 我们自己生成的占位：UPSTREAM_429 / UPSTREAM_503 ...
  const m1 = raw.match(/\bUPSTREAM_(\d{3})\b/);
  if (m1?.[1]) {
    const n = Number(m1[1]);
    if (Number.isFinite(n)) return n;
  }
  // 2) 上游 JSON（常见：{ error: { code: 429, message: "..."} }）
  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const j: any = JSON.parse(raw);
      const code = Number(j?.error?.code ?? j?.code);
      if (Number.isFinite(code) && code >= 100 && code < 600) return Math.floor(code);
    } catch {
      // ignore
    }
  }
  return undefined;
}

export async function completionOnceViaProvider(args: ProviderStreamArgs): Promise<ChatCompletionOnceResult> {
  const endpoint = String(args.endpoint || "/v1/chat/completions");

  // Claude 模型走原生 Anthropic Messages API（避免代理的 OpenAI 兼容层非流式转换问题）
  const modelLower = String(args.model ?? "").toLowerCase();
  if (modelLower.includes("claude")) {
    // 转换 OpenAI 格式的 messages 为 Anthropic 格式（提取 system）
    let systemText = "";
    const userAssistantMsgs: Array<{ role: string; content: string }> = [];
    for (const m of args.messages) {
      if (m.role === "system") {
        systemText += (systemText ? "\n\n" : "") + String(m.content ?? "");
      } else {
        userAssistantMsgs.push({ role: m.role, content: String(m.content ?? "") });
      }
    }
    const r = await completionOnceAnthropicMessages({
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      model: args.model,
      system: systemText || undefined,
      messages: userAssistantMsgs,
      temperature: args.temperature,
      maxTokens: args.maxTokens ?? undefined,
      signal: args.signal,
    });
    return r as ChatCompletionOnceResult;
  }

  if (!isGeminiEndpoint(endpoint)) {
    return chatCompletionOnce({
      config: { baseUrl: args.baseUrl, apiKey: args.apiKey },
      endpoint,
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      tools: args.tools,
      toolChoice: args.toolChoice,
      parallelToolCalls: args.parallelToolCalls,
      signal: args.signal,
    });
  }

  let out = "";
  let lastUsage: any = null;
  try {
    for await (const ev of streamGeminiGenerateContent({
      baseUrl: args.baseUrl,
      endpoint,
      apiKey: args.apiKey,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
    })) {
      if (ev.type === "delta") out += String(ev.delta ?? "");
      else if (ev.type === "usage") lastUsage = (ev as any).usage ?? null;
      else if (ev.type === "error") {
        const errText = String((ev as any).error ?? "UPSTREAM_ERROR");
        const status = parseUpstreamStatusFromErrorText(errText);
        return { ok: false, error: errText, ...(Number.isFinite(status as any) ? { status } : {}), rawText: errText };
      } else if (ev.type === "done") break;
    }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    const status = parseUpstreamStatusFromErrorText(msg);
    return { ok: false, error: msg, ...(Number.isFinite(status as any) ? { status } : {}), rawText: msg };
  }

  const content = out;
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, error: "UPSTREAM_EMPTY_CONTENT", rawText: String(content ?? "") };
  }
  return lastUsage
    ? { ok: true, content, raw: { provider: "gemini", usage: lastUsage }, usage: lastUsage }
    : { ok: true, content, raw: { provider: "gemini", usage: null } };
}
