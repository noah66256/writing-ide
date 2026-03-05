import { normalizeToolParametersSchema } from "./toolSchema.js";
import { buildToolCallsXml } from "./toolXmlProtocol.js";

export type OpenAiChatRole = "system" | "user" | "assistant" | "tool";

export type OpenAiChatMessage = {
  role: OpenAiChatRole;
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

export type OpenAiCompatTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type OpenAiCompatToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

export type OpenAiCompatConfig = {
  baseUrl: string;
  apiKey: string;
};

export function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

export function withV1(baseUrl: string) {
  const b = normalizeBaseUrl(baseUrl);
  return b.endsWith("/v1") ? b : `${b}/v1`;
}

export function openAiCompatUrl(baseUrl: string, path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  // 兼容两种用法：
  // 1) 传 "/chat/completions"（自动补 /v1）
  // 2) 传 "/v1/chat/completions"（不重复拼 /v1，便于对齐「锦李2.0」的 endpoint 存储）
  const b0 = normalizeBaseUrl(baseUrl);
  const bNoV1 = b0.endsWith("/v1") ? b0.slice(0, -3) : b0;
  if (p === "/v1" || p.startsWith("/v1/")) return `${bNoV1}${p}`;
  return `${withV1(b0)}${p}`;
}

function normalizeEndpointPath(endpoint?: string) {
  const raw = String(endpoint || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw.toLowerCase() : `/${raw.toLowerCase()}`;
}

function isResponsesEndpoint(endpoint?: string) {
  const p = normalizeEndpointPath(endpoint);
  return p.endsWith("/responses") || p === "/responses";
}

type NormalizedToolCall = {
  id: string;
  name: string;
  argsRaw: string;
};

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v ?? "");
  }
}

function parseToolArgsRaw(argsRaw: string): Record<string, unknown> {
  const s = String(argsRaw ?? "").trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { input: parsed };
  } catch {
    return { input: s };
  }
}

function toolCallsToXml(calls: NormalizedToolCall[]): string {
  if (!Array.isArray(calls) || calls.length === 0) return "";
  return buildToolCallsXml(
    calls.map((call) => ({
      id: String(call?.id ?? "").trim() || undefined,
      name: String(call?.name ?? "").trim(),
      args: parseToolArgsRaw(String(call?.argsRaw ?? "")),
    })),
  );
}

function mergeToolCall(target: Map<string, NormalizedToolCall>, incoming: NormalizedToolCall) {
  const name = String(incoming?.name ?? "").trim();
  if (!name) return;
  const key = String(incoming.id ?? "").trim() || `${name}#${target.size + 1}`;
  const prev = target.get(key);
  if (!prev) {
    target.set(key, { id: key, name, argsRaw: String(incoming.argsRaw ?? "") });
    return;
  }

  const nextRaw = String(incoming.argsRaw ?? "");
  if (!prev.argsRaw) prev.argsRaw = nextRaw;
  else if (nextRaw && nextRaw.startsWith(prev.argsRaw)) prev.argsRaw = nextRaw;
  else if (nextRaw && !prev.argsRaw.includes(nextRaw)) prev.argsRaw += nextRaw;
  if (!prev.name) prev.name = name;
}

function collectChatToolCallsFromChoice(choice: any): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  const append = (rawCalls: any[]) => {
    for (let i = 0; i < rawCalls.length; i++) {
      const c = rawCalls[i] ?? {};
      const fn = c?.function ?? c?.tool ?? {};
      const name = String(fn?.name ?? c?.name ?? "").trim();
      if (!name) continue;
      const id = String(c?.id ?? c?.tool_call_id ?? `${name}_${i + 1}`).trim();
      const argsRaw = (() => {
        const raw =
          fn?.arguments ??
          c?.arguments ??
          c?.input ??
          c?.args ??
          c?.parameters;
        return typeof raw === "string" ? raw : safeJsonStringify(raw ?? {});
      })();
      out.push({ id, name, argsRaw });
    }
  };

  if (Array.isArray(choice?.delta?.tool_calls)) append(choice.delta.tool_calls);
  if (Array.isArray(choice?.message?.tool_calls)) append(choice.message.tool_calls);
  if (Array.isArray(choice?.tool_calls)) append(choice.tool_calls);
  return out;
}

function collectToolCallsFromAny(node: any, out: NormalizedToolCall[], depth = 0) {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolCallsFromAny(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const type = String((node as any).type ?? "").trim().toLowerCase();
  const directName = String((node as any).name ?? (node as any)?.function?.name ?? "").trim();
  const directArgs =
    (node as any).arguments ??
    (node as any)?.function?.arguments ??
    (node as any).input ??
    (node as any).args ??
    (node as any).parameters;
  const looksLikeTool =
    type.includes("function_call") ||
    type.includes("tool_call") ||
    (Array.isArray((node as any)?.tool_calls) && (node as any).tool_calls.length > 0);
  if (directName && (looksLikeTool || directArgs !== undefined)) {
    out.push({
      id: String((node as any).id ?? (node as any).tool_call_id ?? `${directName}_${out.length + 1}`),
      name: directName,
      argsRaw: typeof directArgs === "string" ? directArgs : safeJsonStringify(directArgs ?? {}),
    });
  }

  if (Array.isArray((node as any).tool_calls)) {
    for (const tc of (node as any).tool_calls) {
      const choiceCalls = collectChatToolCallsFromChoice({ message: { tool_calls: [tc] } });
      for (const c of choiceCalls) out.push(c);
    }
  }

  const scanKeys = ["output", "response", "item", "items", "message", "content", "choices", "delta", "data"];
  for (const key of scanKeys) {
    if ((node as any)[key] !== undefined) collectToolCallsFromAny((node as any)[key], out, depth + 1);
  }
}

function extractToolCallsFromAny(node: any): NormalizedToolCall[] {
  const raw: NormalizedToolCall[] = [];
  collectToolCallsFromAny(node, raw, 0);
  const merged = new Map<string, NormalizedToolCall>();
  for (const call of raw) mergeToolCall(merged, call);
  return Array.from(merged.values()).filter((c) => String(c.name ?? "").trim().length > 0);
}

function toOpenAiToolsPayload(tools?: OpenAiCompatTool[]) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: String(tool.name ?? "").trim(),
      ...(String(tool.description ?? "").trim() ? { description: String(tool.description ?? "").trim() } : {}),
      parameters: normalizeToolParametersSchema(tool.inputSchema),
    },
  }));
}

function toResponsesToolsPayload(tools?: OpenAiCompatTool[]) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    name: String(tool.name ?? "").trim(),
    ...(String(tool.description ?? "").trim() ? { description: String(tool.description ?? "").trim() } : {}),
    parameters: normalizeToolParametersSchema(tool.inputSchema),
  }));
}

function toOpenAiToolChoicePayload(choice?: OpenAiCompatToolChoice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    const name = String(choice.name ?? "").trim();
    if (!name) return undefined;
    return { type: "function" as const, function: { name } };
  }
  return undefined;
}

function toResponsesToolChoicePayload(choice?: OpenAiCompatToolChoice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    const name = String(choice.name ?? "").trim();
    if (!name) return undefined;
    return { type: "function" as const, name };
  }
  return undefined;
}

function shouldRetryWithoutNativeTools(errorText: string) {
  const s = String(errorText ?? "").toLowerCase();
  if (!s) return false;
  return /(tool_choice|parallel_tool_calls|tools|function call|function_call|unknown field|unsupported)/.test(s);
}

export type StreamDeltaEvent =
  | { type: "delta"; delta: string }
  | {
      type: "usage";
      usage: { promptTokens: number; completionTokens: number; totalTokens?: number };
      raw?: any;
    }
  | { type: "done" }
  | { type: "error"; error: string };

export type ChatCompletionOnceResult =
  | { ok: true; content: string; raw: any; usage?: { promptTokens: number; completionTokens: number; totalTokens?: number } }
  | { ok: false; error: string; status?: number; rawText?: string };

function kindOfContentLike(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function coerceUsageLike(v: any):
  | { promptTokens: number; completionTokens: number; totalTokens?: number }
  | undefined {
  if (!v || typeof v !== "object") return undefined;
  const pt = Number(
    v?.prompt_tokens ??
      v?.input_tokens ??
      v?.promptTokens ??
      v?.inputTokens,
  );
  const ct = Number(
    v?.completion_tokens ??
      v?.output_tokens ??
      v?.completionTokens ??
      v?.outputTokens,
  );
  const tt = Number(v?.total_tokens ?? v?.totalTokens);
  if (!Number.isFinite(pt) && !Number.isFinite(ct) && !Number.isFinite(tt)) {
    return undefined;
  }
  return {
    promptTokens: Number.isFinite(pt) ? Math.max(0, Math.floor(pt)) : 0,
    completionTokens: Number.isFinite(ct) ? Math.max(0, Math.floor(ct)) : 0,
    ...(Number.isFinite(tt) ? { totalTokens: Math.max(0, Math.floor(tt)) } : {}),
  };
}

function messageContentToResponsesInput(
  content: OpenAiChatMessage["content"],
): Array<Record<string, unknown>> | string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part as any).type === "text") {
      out.push({ type: "input_text", text: String((part as any).text ?? "") });
      continue;
    }
    if ((part as any).type === "image_url") {
      const url = String((part as any)?.image_url?.url ?? "");
      if (!url) continue;
      out.push({ type: "input_image", image_url: url });
    }
  }
  if (out.length === 0) return "";
  return out;
}

function chatMessagesToResponsesInput(messages: OpenAiChatMessage[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    const role = String(m?.role ?? "").trim().toLowerCase();
    if (!role) continue;
    const content = messageContentToResponsesInput(m.content);
    if (
      (typeof content === "string" && content.length === 0) ||
      (Array.isArray(content) && content.length === 0)
    ) {
      continue;
    }
    out.push({
      role: role === "tool" ? "user" : role,
      content,
    });
  }
  return out;
}

function extractResponsesTextFromAny(v: any, depth = 0): string {
  if (depth > 6 || v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    let out = "";
    for (const item of v) out += extractResponsesTextFromAny(item, depth + 1);
    return out;
  }
  if (typeof v !== "object") return "";

  const type = String((v as any).type ?? "").trim().toLowerCase();
  if (type.includes("output_text") || type === "text" || type === "message") {
    const byText = coerceOpenAiContentToText((v as any).text);
    if (byText) return byText;
  }

  const candidates = [
    (v as any).output_text,
    (v as any).text,
    (v as any).delta,
    (v as any).content,
    (v as any).output,
    (v as any).response,
    (v as any).message,
    (v as any).item,
  ];
  let out = "";
  for (const c of candidates) out += extractResponsesTextFromAny(c, depth + 1);
  return out;
}

function extractResponsesTextDelta(ev: any): string {
  if (!ev || typeof ev !== "object") return "";
  const type = String(ev.type ?? "").trim().toLowerCase();
  if (type === "response.output_text.delta") {
    return String(ev.delta ?? "");
  }
  if (type.endsWith(".delta")) {
    const d = coerceOpenAiContentToText(ev.delta);
    if (d) return d;
  }
  return "";
}

// OpenAI-compatible：部分上游会把 content 返回为“content parts”（array/object），不是 string。
// 若只认 string，会导致 deltaChars==0 → empty_output。
function coerceOpenAiContentToText(v: any, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    let out = "";
    for (const part of v) {
      const t = coerceOpenAiContentToText(part, depth + 1);
      if (typeof t === "string" && t.length > 0) out += t;
    }
    return out.length > 0 ? out : null;
  }
  if (typeof v === "object") {
    // 常见：{ type:"text", text:"..." }
    const t1 = coerceOpenAiContentToText((v as any).text, depth + 1);
    if (typeof t1 === "string" && t1.length > 0) return t1;
    // 兼容：某些代理返回 { content: ... }
    const t2 = coerceOpenAiContentToText((v as any).content, depth + 1);
    if (typeof t2 === "string" && t2.length > 0) return t2;
    // 宽松兜底：{ value:"..." }
    const value = (v as any).value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

async function* readLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      yield line;
      idx = buf.indexOf("\n");
    }
  }

  if (buf.length > 0) yield buf.replace(/\r$/, "");
}

async function* streamResponses(args: {
  config: OpenAiCompatConfig;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
  endpoint?: string;
  tools?: OpenAiCompatTool[];
  toolChoice?: OpenAiCompatToolChoice;
  parallelToolCalls?: boolean;
}): AsyncGenerator<StreamDeltaEvent> {
  const url = openAiCompatUrl(args.config.baseUrl, args.endpoint || "/responses");
  const bodyBase: Record<string, unknown> = {
    model: args.model,
    input: chatMessagesToResponsesInput(args.messages),
    stream: true,
  };
  if (Number.isFinite(Number(args.maxTokens)) && Number(args.maxTokens) > 0) {
    bodyBase.max_output_tokens = Math.floor(Number(args.maxTokens));
  }
  if (typeof args.temperature === "number" && Number.isFinite(args.temperature)) {
    bodyBase.temperature = args.temperature;
  }
  const openAiTools = toResponsesToolsPayload(args.tools);
  const openAiToolChoice = toResponsesToolChoicePayload(args.toolChoice);
  const wantsNativeTools = Boolean(openAiTools?.length);

  const withNativeToolsBody = (): Record<string, unknown> => ({
    ...bodyBase,
    ...(openAiTools?.length ? { tools: openAiTools } : {}),
    ...(openAiToolChoice ? { tool_choice: openAiToolChoice } : {}),
    ...(typeof args.parallelToolCalls === "boolean" ? { parallel_tool_calls: args.parallelToolCalls } : {}),
  });

  let res: Response;
  try {
    const bodyFirst = wantsNativeTools ? withNativeToolsBody() : bodyBase;
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.config.apiKey}`,
      },
      body: JSON.stringify(bodyFirst),
      signal: args.signal,
    });
  } catch (e: any) {
    yield { type: "error", error: String(e?.message ?? e) };
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (wantsNativeTools && res.status === 400 && shouldRetryWithoutNativeTools(text)) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.config.apiKey}`,
          },
          body: JSON.stringify(bodyBase),
          signal: args.signal,
        });
      } catch (e: any) {
        yield { type: "error", error: String(e?.message ?? e) };
        return;
      }
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        yield { type: "error", error: text2 || `UPSTREAM_${res.status}` };
        return;
      }
    } else {
      yield { type: "error", error: text || `UPSTREAM_${res.status}` };
      return;
    }
  }

  const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
  if (!res.body) {
    yield { type: "error", error: "UPSTREAM_EMPTY_BODY" };
    return;
  }

  const isEventStream = contentType.includes("text/event-stream");
  const isJson = contentType.includes("application/json");
  if (!isEventStream && isJson) {
    const text = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      yield { type: "error", error: text || "UPSTREAM_INVALID_JSON" };
      return;
    }
    const content = extractResponsesTextFromAny(json).trim();
    if (content) {
      yield { type: "delta", delta: content };
    } else {
      const toolCalls = extractToolCallsFromAny(json);
      const xml = toolCallsToXml(toolCalls);
      if (xml) yield { type: "delta", delta: xml };
    }
    const usage = coerceUsageLike(json?.usage ?? json?.response?.usage);
    if (usage) yield { type: "usage", usage, raw: json };
    yield { type: "done" };
    return;
  }

  let emittedChars = 0;
  let emittedUsage = false;
  let completedPayload: any = null;
  const streamedToolCalls = new Map<string, NormalizedToolCall>();
  for await (const line0 of readLines(res.body)) {
    const line = String(line0 ?? "");
    if (!line) continue;
    if (line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) continue;
    const raw = line.startsWith("data:") ? line.slice("data:".length).trim() : line.trim();
    if (!raw) continue;
    if (raw === "[DONE]") break;

    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }

    const delta = extractResponsesTextDelta(json);
    if (delta) {
      emittedChars += delta.length;
      yield { type: "delta", delta };
    }
    const calls = extractToolCallsFromAny(json);
    for (const call of calls) mergeToolCall(streamedToolCalls, call);

    const usage = coerceUsageLike(json?.usage ?? json?.response?.usage);
    if (usage) {
      emittedUsage = true;
      yield { type: "usage", usage, raw: json };
    }

    const t = String(json?.type ?? "").trim().toLowerCase();
    if (t === "response.completed") {
      completedPayload = json;
      const finalUsage = coerceUsageLike(json?.response?.usage ?? json?.usage);
      if (finalUsage && !emittedUsage) {
        emittedUsage = true;
        yield { type: "usage", usage: finalUsage, raw: json };
      }
      break;
    }
    if (t === "response.failed" || t === "error") {
      const err =
        String(json?.error?.message ?? "") ||
        String(json?.message ?? "") ||
        "UPSTREAM_ERROR";
      yield { type: "error", error: err };
      return;
    }
  }

  // 当文本和 native tool_calls 同时存在时，tool_calls 不会进入文本 delta，
  // 需要额外追加 XML 格式的工具调用，确保上层 parseToolCallsXml 能统一解析。
  if (emittedChars > 0 && streamedToolCalls.size > 0) {
    const xml = toolCallsToXml(Array.from(streamedToolCalls.values()));
    if (xml) {
      emittedChars += xml.length;
      yield { type: "delta", delta: xml };
    }
  }

  if (emittedChars === 0 && completedPayload) {
    const fallback = extractResponsesTextFromAny(completedPayload?.response ?? completedPayload).trim();
    if (fallback) {
      emittedChars += fallback.length;
      yield { type: "delta", delta: fallback };
    } else {
      const xml = toolCallsToXml(Array.from(streamedToolCalls.values()));
      if (xml) {
        emittedChars += xml.length;
        yield { type: "delta", delta: xml };
      }
    }
  }

  if (emittedChars === 0 && !args.signal?.aborted) {
    const once = await chatCompletionOnce({
      config: args.config,
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
      endpoint: args.endpoint,
      tools: args.tools,
      toolChoice: args.toolChoice,
      parallelToolCalls: args.parallelToolCalls,
    });
    if (once.ok && once.content.trim().length > 0) {
      yield { type: "delta", delta: once.content };
      if (once.usage) yield { type: "usage", usage: once.usage, raw: once.raw };
      yield { type: "done" };
      return;
    }
    yield { type: "error", error: "UPSTREAM_EMPTY_CONTENT" };
    return;
  }

  yield { type: "done" };
}

export async function* streamChatCompletions(args: {
  config: OpenAiCompatConfig;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
  includeUsage?: boolean;
  /** OpenAI-compatible endpoint（支持 /chat/completions 或 /v1/chat/completions） */
  endpoint?: string;
  tools?: OpenAiCompatTool[];
  toolChoice?: OpenAiCompatToolChoice;
  parallelToolCalls?: boolean;
}): AsyncGenerator<StreamDeltaEvent> {
  if (isResponsesEndpoint(args.endpoint)) {
    yield* streamResponses(args);
    return;
  }

  const url = openAiCompatUrl(args.config.baseUrl, args.endpoint || "/chat/completions");

  const wantsUsage = Boolean(args.includeUsage);
  const openAiTools = toOpenAiToolsPayload(args.tools);
  const openAiToolChoice = toOpenAiToolChoicePayload(args.toolChoice);
  const wantsNativeTools = Boolean(openAiTools?.length);

  // 诊断：用于定位“上游返回了东西，但我们解析不到 delta（例如字段不兼容 / 非 SSE data: 格式）”的根因。
  // 仅在“整段流结束后 deltaChars==0”时输出少量信息（pm2 logs 可见），避免污染正常日志。
  const diag = {
    model: String(args.model || ""),
    url,
    status: 0,
    contentType: "" as string,
    sawDataLine: false,
    sawPayloadLine: false,
    dataLinesSample: [] as string[],
    parsedJsonOk: 0,
    parsedJsonFail: 0,
    sampleShape: null as null | {
      keys: string[];
      hasChoices: boolean;
      choice0Keys: string[];
      deltaKeys: string[];
      hasDeltaContent: boolean;
      deltaContentType: string;
      hasMessageContent: boolean;
      messageContentType: string;
      hasTextContent: boolean;
      textContentType: string;
      hasToolCalls: boolean;
      hasReasoning: boolean;
    },
    deltaChars: 0,
    sawFinishReason: false,
    sawDone: false,
    endedBy: "" as string,
  };

  const doFetch = async (withUsage: boolean, withNativeTools: boolean) => {
    const body: any = {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      stream: true
    };
    const mt = Number(args.maxTokens);
    if (Number.isFinite(mt) && mt > 0) body.max_tokens = Math.floor(mt);
    if (withUsage) body.stream_options = { include_usage: true };
    if (withNativeTools && openAiTools?.length) {
      body.tools = openAiTools;
      if (openAiToolChoice) body.tool_choice = openAiToolChoice;
      if (typeof args.parallelToolCalls === "boolean") body.parallel_tool_calls = args.parallelToolCalls;
    }
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: args.signal
    });
  };

  let res: Response;
  try {
    res = await doFetch(wantsUsage, wantsNativeTools);
    if (!res.ok && wantsUsage) {
      const text = await res.text().catch(() => "");
      // 兼容性兜底：有些 OpenAI-compatible 不接受 stream_options/include_usage
      if (res.status === 400 && /stream_options|include_usage/i.test(text)) {
        res = await doFetch(false, wantsNativeTools);
      } else if (wantsNativeTools && res.status === 400 && shouldRetryWithoutNativeTools(text)) {
        res = await doFetch(wantsUsage, false);
      } else {
        // 复用已读到的错误文本
        yield { type: "error", error: text || `UPSTREAM_${res.status}` };
        return;
      }
    }
  } catch (e: any) {
    yield { type: "error", error: String(e?.message ?? e) };
    return;
  }

  diag.status = res.status;
  diag.contentType = String(res.headers.get("content-type") ?? "").trim();

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    yield { type: "error", error: text || `UPSTREAM_${res.status}` };
    return;
  }
  if (!res.body) {
    yield { type: "error", error: "UPSTREAM_EMPTY_BODY" };
    return;
  }

  // 兼容：一些 OpenAI-compatible 会忽略 stream=true，直接返回 application/json（一次性 JSON）。
  // 这时不应该按 SSE 的 data: 逐行去解析，否则会出现 0 delta / empty_output。
  {
    const ct = diag.contentType.toLowerCase();
    const isEventStream = ct.includes("text/event-stream");
    const isNdjson = ct.includes("application/x-ndjson") || ct.includes("application/ndjson");
    const isJson = ct.includes("application/json");
    if (!isEventStream && !isNdjson && isJson) {
      const text = await res.text().catch(() => "");
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        yield { type: "error", error: text || "UPSTREAM_INVALID_JSON" };
        return;
      }

      const contentLike =
        json?.choices?.[0]?.message?.content ??
        (json?.choices?.[0] as any)?.text ??
        json?.choices?.[0]?.delta?.content;
      const contentText = coerceOpenAiContentToText(contentLike);
      if (typeof contentText === "string" && contentText.trim().length > 0) {
        yield { type: "delta", delta: contentText };
      } else {
        const calls = extractToolCallsFromAny(json);
        const xml = toolCallsToXml(calls);
        if (xml) yield { type: "delta", delta: xml };
      }

      const u = json?.usage;
      const pt = Number(u?.prompt_tokens ?? u?.promptTokens);
      const ct2 = Number(u?.completion_tokens ?? u?.completionTokens);
      const tt = Number(u?.total_tokens ?? u?.totalTokens);
      if (Number.isFinite(pt) || Number.isFinite(ct2) || Number.isFinite(tt)) {
        yield {
          type: "usage",
          usage: {
            promptTokens: Number.isFinite(pt) ? Math.max(0, Math.floor(pt)) : 0,
            completionTokens: Number.isFinite(ct2) ? Math.max(0, Math.floor(ct2)) : 0,
            ...(Number.isFinite(tt) ? { totalTokens: Math.max(0, Math.floor(tt)) } : {}),
          },
          raw: json,
        };
      }

      yield { type: "done" };
      return;
    }
  }

  let sawFinishReason = false;
  let lastMessageContent = "";
  let lastTextContent = "";
  let lastDeltaContentCoerced = "";
  const streamedToolCalls = new Map<string, NormalizedToolCall>();
  for await (const line0 of readLines(res.body)) {
    const line = String(line0 ?? "");
    if (!line) continue;
    if (line.startsWith(":")) continue; // sse comment/ping
    if (line.startsWith("event:")) continue;
    if (line.startsWith("id:")) continue;
    if (line.startsWith("retry:")) continue;

    const isData = line.startsWith("data:");
    if (isData) diag.sawDataLine = true;
    const data = isData ? line.slice("data:".length).trim() : line.trim();
    if (!data) continue;
    diag.sawPayloadLine = true;

    if (data === "[DONE]") {
      diag.sawDone = true;
      diag.endedBy = "DONE";
      break;
    }

    if (diag.dataLinesSample.length < 6) {
      // 仅保留少量 sample；避免日志过大
      diag.dataLinesSample.push(data.length > 500 ? `${data.slice(0, 500)}…` : data);
    }

    let json: any;
    try {
      json = JSON.parse(data);
      diag.parsedJsonOk += 1;
    } catch {
      diag.parsedJsonFail += 1;
      continue;
    }

    if (!diag.sampleShape) {
      const keys = json && typeof json === "object" ? Object.keys(json) : [];
      const c0 = json?.choices?.[0];
      const choice0Keys = c0 && typeof c0 === "object" ? Object.keys(c0) : [];
      const d0 = c0?.delta;
      const deltaKeys = d0 && typeof d0 === "object" ? Object.keys(d0) : [];
      const deltaContent = d0?.content;
      const msgContent = c0?.message?.content;
      const textContent = (c0 as any)?.text;
      diag.sampleShape = {
        keys,
        hasChoices: Array.isArray(json?.choices),
        choice0Keys,
        deltaKeys,
        hasDeltaContent: deltaContent !== undefined,
        deltaContentType: kindOfContentLike(deltaContent),
        hasMessageContent: msgContent !== undefined,
        messageContentType: kindOfContentLike(msgContent),
        hasTextContent: textContent !== undefined,
        textContentType: kindOfContentLike(textContent),
        hasToolCalls: Boolean((d0 as any)?.tool_calls || (c0 as any)?.tool_calls),
        hasReasoning: Boolean((d0 as any)?.reasoning || (d0 as any)?.reasoning_content || (c0 as any)?.reasoning),
      };
    }

    const usageRaw = json?.usage;
    if (usageRaw && typeof usageRaw === "object") {
      const pt = Number((usageRaw as any)?.prompt_tokens);
      const ct = Number((usageRaw as any)?.completion_tokens);
      const tt = Number((usageRaw as any)?.total_tokens);
      const usage = {
        promptTokens: Number.isFinite(pt) ? pt : 0,
        completionTokens: Number.isFinite(ct) ? ct : 0,
        ...(Number.isFinite(tt) ? { totalTokens: tt } : {})
      };
      // 仅当至少有一种 token 计数有效时才上报
      if (usage.promptTokens > 0 || usage.completionTokens > 0 || (usage as any).totalTokens > 0) {
        yield { type: "usage", usage, raw: json };
      }
    }

    const choice = json?.choices?.[0];
    for (const call of collectChatToolCallsFromChoice(choice)) {
      mergeToolCall(streamedToolCalls, call);
    }
    let emitted = false;
    const deltaText = coerceOpenAiContentToText(choice?.delta?.content);
    if (typeof deltaText === "string" && deltaText.length > 0) {
      let piece = deltaText;
      if (lastDeltaContentCoerced.length > 0 && deltaText.startsWith(lastDeltaContentCoerced)) {
        piece = deltaText.slice(lastDeltaContentCoerced.length);
      }
      lastDeltaContentCoerced = deltaText;
      if (piece.length > 0) {
        diag.deltaChars += piece.length;
        yield { type: "delta", delta: piece };
        emitted = true;
      }
    }
    if (!emitted) {
      const msgContentNow = coerceOpenAiContentToText(choice?.message?.content);
      if (typeof msgContentNow === "string" && msgContentNow.length > 0) {
        const diff = msgContentNow.startsWith(lastMessageContent)
          ? msgContentNow.slice(lastMessageContent.length)
          : msgContentNow;
        lastMessageContent = msgContentNow;
        if (diff.length > 0) {
          diag.deltaChars += diff.length;
          yield { type: "delta", delta: diff };
          emitted = true;
        }
      }
    }
    if (!emitted) {
      const textContentNow = coerceOpenAiContentToText((choice as any)?.text);
      if (typeof textContentNow === "string" && textContentNow.length > 0) {
        const diff = textContentNow.startsWith(lastTextContent)
          ? textContentNow.slice(lastTextContent.length)
          : textContentNow;
        lastTextContent = textContentNow;
        if (diff.length > 0) {
          diag.deltaChars += diff.length;
          yield { type: "delta", delta: diff };
          emitted = true;
        }
      }
    }

    const finishReason = choice?.finish_reason;
    if (finishReason) {
      sawFinishReason = true;
      diag.sawFinishReason = true;
      if (!wantsUsage) {
        diag.endedBy = `finish_reason:${String(finishReason)}`;
        break;
      }
    }
  }

  // 当文本和 native tool_calls 同时存在时（模型既输出了自然语言，又调用了 function），
  // 需要追加 XML 格式的工具调用，确保上层统一解析。
  if (diag.deltaChars > 0 && streamedToolCalls.size > 0) {
    const toolCallsXml = toolCallsToXml(Array.from(streamedToolCalls.values()));
    if (toolCallsXml) {
      diag.deltaChars += toolCallsXml.length;
      yield { type: "delta", delta: toolCallsXml };
    }
  }

  if (
    diag.deltaChars === 0 &&
    (diag.sawPayloadLine || diag.sawDataLine || diag.sawDone || sawFinishReason) &&
    !args.signal?.aborted
  ) {
    const toolCallsXml = toolCallsToXml(Array.from(streamedToolCalls.values()));
    if (toolCallsXml) {
      yield { type: "delta", delta: toolCallsXml };
      yield { type: "done" };
      return;
    }

    const once = await chatCompletionOnce({
      config: args.config,
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
      endpoint: args.endpoint,
      tools: args.tools,
      toolChoice: args.toolChoice,
      parallelToolCalls: args.parallelToolCalls,
    });
    if (once.ok && once.content.trim().length > 0) {
      // eslint-disable-next-line no-console
      console.log("[openaiCompat.diag] stream empty, fallback to non-stream succeeded", {
        model: args.model,
        endpoint: args.endpoint,
      });
      yield { type: "delta", delta: once.content };
      if (once.usage) yield { type: "usage", usage: once.usage, raw: once.raw };
      yield { type: "done" };
      return;
    }
    // 关键：如果流式 0 delta，且非流式兜底也拿不到内容，必须视为上游错误。
    // 否则 Gateway 会把它当成“模型输出为空”进入 AutoRetry，并且因为 usage 可能已上报而继续计费，造成“空输出还扣费”的黑洞体验。
    yield { type: "error", error: "UPSTREAM_EMPTY_CONTENT" };
    return;
  }

  if (sawFinishReason || diag.sawDone) {
    diag.endedBy = diag.endedBy || "eof_after_finish_reason";
    yield { type: "done" };
  } else {
    diag.endedBy = diag.endedBy || "eof_no_finish_reason";
  }

  // EOF 兜底诊断（无论是否 sawFinishReason，只要 deltaChars==0 都打印）
  if (diag.deltaChars === 0) {
    // eslint-disable-next-line no-console
    console.log("[openaiCompat.diag] upstream stream ended with 0 delta chars", diag);
  }
}

export async function chatCompletionOnce(args: {
  config: OpenAiCompatConfig;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
  /** OpenAI-compatible endpoint（支持 /chat/completions 或 /v1/chat/completions） */
  endpoint?: string;
  tools?: OpenAiCompatTool[];
  toolChoice?: OpenAiCompatToolChoice;
  parallelToolCalls?: boolean;
}): Promise<ChatCompletionOnceResult> {
  const endpoint = args.endpoint || "/chat/completions";
  const isResponses = isResponsesEndpoint(endpoint);
  const url = openAiCompatUrl(args.config.baseUrl, endpoint);

  const openAiTools = isResponses ? toResponsesToolsPayload(args.tools) : toOpenAiToolsPayload(args.tools);
  const openAiToolChoice = isResponses
    ? toResponsesToolChoicePayload(args.toolChoice)
    : toOpenAiToolChoicePayload(args.toolChoice);
  const wantsNativeTools = Boolean(openAiTools?.length);

  const buildBody = (withNativeTools: boolean) =>
    isResponses
      ? {
          model: args.model,
          input: chatMessagesToResponsesInput(args.messages),
          ...(typeof args.temperature === "number" && Number.isFinite(args.temperature)
            ? { temperature: args.temperature }
            : {}),
          ...(Number.isFinite(Number(args.maxTokens)) && Number(args.maxTokens) > 0
            ? { max_output_tokens: Math.floor(Number(args.maxTokens)) }
            : {}),
          ...(withNativeTools && openAiTools?.length ? { tools: openAiTools } : {}),
          ...(withNativeTools && openAiToolChoice ? { tool_choice: openAiToolChoice } : {}),
          ...(withNativeTools && typeof args.parallelToolCalls === "boolean" ? { parallel_tool_calls: args.parallelToolCalls } : {}),
          stream: false,
        }
      : {
          model: args.model,
          messages: args.messages,
          temperature: args.temperature,
          ...(Number.isFinite(Number(args.maxTokens)) && Number(args.maxTokens) > 0
            ? { max_tokens: Math.floor(Number(args.maxTokens)) }
            : {}),
          ...(withNativeTools && openAiTools?.length ? { tools: openAiTools } : {}),
          ...(withNativeTools && openAiToolChoice ? { tool_choice: openAiToolChoice } : {}),
          ...(withNativeTools && typeof args.parallelToolCalls === "boolean" ? { parallel_tool_calls: args.parallelToolCalls } : {}),
          stream: false,
        };

  let res: Response;
  const body = buildBody(wantsNativeTools);
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (wantsNativeTools && res.status === 400 && shouldRetryWithoutNativeTools(text)) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${args.config.apiKey}`,
          },
          body: JSON.stringify(buildBody(false)),
          signal: args.signal,
        });
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
      if (!res.ok) {
        const text2 = await res.text().catch(() => "");
        return { ok: false, error: text2 || `UPSTREAM_${res.status}`, status: res.status, rawText: text2 };
      }
    } else {
      return { ok: false, error: text || `UPSTREAM_${res.status}`, status: res.status, rawText: text };
    }
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "UPSTREAM_INVALID_JSON", status: res.status, rawText: text };
  }

  const content = isResponses
    ? extractResponsesTextFromAny(json).trim()
    : coerceOpenAiContentToText(
        json?.choices?.[0]?.message?.content ??
          (json?.choices?.[0] as any)?.text ??
          json?.choices?.[0]?.delta?.content,
      );
  if (typeof content !== "string" || content.trim().length === 0) {
    const toolCalls = extractToolCallsFromAny(json);
    const xml = toolCallsToXml(toolCalls);
    if (xml) {
      const usage2 = coerceUsageLike(json?.usage ?? json?.response?.usage);
      return usage2 ? { ok: true, content: xml, raw: json, usage: usage2 } : { ok: true, content: xml, raw: json };
    }
    return { ok: false, error: "UPSTREAM_EMPTY_CONTENT", status: res.status, rawText: JSON.stringify(json) };
  }
  const usage = coerceUsageLike(json?.usage ?? json?.response?.usage);
  return usage ? { ok: true, content, raw: json, usage } : { ok: true, content, raw: json };
}
