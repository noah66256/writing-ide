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
import { parseToolCallsXml } from "./toolXmlProtocol.js";

export type ProviderStreamArgs = {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  timeoutMs?: number;
  includeUsage?: boolean;
  tools?: OpenAiCompatTool[];
  toolChoice?: OpenAiCompatToolChoice;
  parallelToolCalls?: boolean;
  previousResponseId?: string | null;
  signal?: AbortSignal;
};

export type ToolResultFormat = "xml" | "text";

export type ProviderCanonicalEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "error"; error: string }
  | {
      type: "done";
      assistantRaw: string;
      plainText: string;
      hasToolCallMarker: boolean;
      wrapperCount: number;
    };

export type EndpointAdapter = {
  id: "chat" | "responses";
  sendTurn: (args: ProviderStreamArgs) => Promise<ChatCompletionOnceResult>;
  streamTurn: (args: ProviderStreamArgs) => AsyncGenerator<StreamDeltaEvent>;
  toCanonicalEvents: (events: StreamDeltaEvent[]) => ProviderCanonicalEvent[];
};

function normalizeEndpointPath(endpoint?: string): string {
  const raw = String(endpoint ?? "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function isResponsesEndpoint(endpoint?: string): boolean {
  const p = normalizeEndpointPath(endpoint);
  return p.endsWith("/responses") || p === "/responses";
}

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
    previousResponseId: args.previousResponseId,
    signal: args.signal,
  });
}

// Adapter v1: streamTurn / sendTurn / toCanonicalEvents
export async function* streamTurn(args: ProviderStreamArgs): AsyncGenerator<StreamDeltaEvent> {
  yield* streamChatCompletionViaProvider(args);
}

export async function sendTurn(args: ProviderStreamArgs): Promise<ChatCompletionOnceResult> {
  return completionOnceViaProvider(args);
}

export function toCanonicalEvents(events: StreamDeltaEvent[]): ProviderCanonicalEvent[] {
  const out: ProviderCanonicalEvent[] = [];
  const raw = Array.isArray(events) ? events : [];
  let assistantRaw = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let streamError = "";

  for (const ev of raw) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "delta") {
      assistantRaw += String(ev.delta ?? "");
      continue;
    }
    if (ev.type === "usage") {
      const p = Math.max(0, Math.floor(Number((ev as any)?.usage?.promptTokens ?? 0)));
      const c = Math.max(0, Math.floor(Number((ev as any)?.usage?.completionTokens ?? 0)));
      promptTokens = Math.max(promptTokens, p);
      completionTokens = Math.max(completionTokens, c);
      continue;
    }
    if (ev.type === "error") {
      streamError = String((ev as any)?.error ?? "UPSTREAM_ERROR");
      break;
    }
    if (ev.type === "done") break;
  }

  if (promptTokens > 0 || completionTokens > 0) {
    out.push({ type: "usage", promptTokens, completionTokens });
  }
  if (streamError) {
    out.push({ type: "error", error: streamError });
    return out;
  }

  const parsed = parseToolCallsXml(assistantRaw);
  for (const c of parsed.calls) {
    out.push({
      type: "tool_call",
      id: String(c.id ?? "").trim(),
      name: String(c.name ?? "").trim(),
      args: c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args : {},
    });
  }
  if (parsed.plainText) out.push({ type: "text_delta", delta: parsed.plainText });
  out.push({
    type: "done",
    assistantRaw,
    plainText: parsed.plainText,
    hasToolCallMarker: parsed.hasToolCallMarker,
    wrapperCount: parsed.wrapperCount,
  });
  return out;
}

export const ChatAdapter: EndpointAdapter = {
  id: "chat",
  sendTurn: (args) => sendTurn({ ...args, endpoint: "/v1/chat/completions" }),
  streamTurn: (args) => streamTurn({ ...args, endpoint: "/v1/chat/completions" }),
  toCanonicalEvents,
};

export const ResponsesAdapter: EndpointAdapter = {
  id: "responses",
  sendTurn: (args) => sendTurn({ ...args, endpoint: "/v1/responses" }),
  streamTurn: (args) => streamTurn({ ...args, endpoint: "/v1/responses" }),
  toCanonicalEvents,
};

export function getAdapterByEndpoint(endpoint?: string): EndpointAdapter {
  return isResponsesEndpoint(endpoint) ? ResponsesAdapter : ChatAdapter;
}

export function buildInjectedToolResultMessages(args: {
  toolResultFormat: ToolResultFormat;
  toolResultXml: string;
  toolResultText: string;
  /** 当使用 native function calling（非 XML 协议）时设为 true，续写提示不再催促 XML 输出 */
  preferNativeToolCall?: boolean;
  /** OpenAI Responses native continuation 已生效时，不再注入“继续”提示，仅保留 tool_result 本体 */
  nativeContinuationActive?: boolean;
}): OpenAiChatMessage[] {
  const useText = args.toolResultFormat === "text";
  const out: OpenAiChatMessage[] = [
    { role: useText ? "user" : "system", content: useText ? args.toolResultText : args.toolResultXml },
  ];
  if (args.nativeContinuationActive) {
    return out;
  }
  const continuation = args.preferNativeToolCall
    ? "继续。请基于以上 tool_result 推进任务。" +
      "只有在确有必要时再调用工具；若信息已足够，直接给出可交付文本。"
    : "继续。请基于以上 tool_result 推进下一步。" +
      "若需要调用工具，请按协议输出 XML（优先 <tool_calls>...</tool_calls>；旧式 <function_calls>...</function_calls> 也可被兼容解析），整条消息不要夹杂自然语言。";
  out.push({
    role: "user",
    content: continuation,
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
      timeoutMs: args.timeoutMs,
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
      previousResponseId: args.previousResponseId,
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
