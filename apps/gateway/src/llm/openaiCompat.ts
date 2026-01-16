export type OpenAiChatRole = "system" | "user" | "assistant" | "tool";

export type OpenAiChatMessage = {
  role: OpenAiChatRole;
  content: string;
};

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
  | { ok: true; content: string; raw: any }
  | { ok: false; error: string; status?: number; rawText?: string };

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
}): AsyncGenerator<StreamDeltaEvent> {
  const url = openAiCompatUrl(args.config.baseUrl, args.endpoint || "/chat/completions");

  const wantsUsage = Boolean(args.includeUsage);

  const doFetch = async (withUsage: boolean) => {
    const body: any = {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      stream: true
    };
    const mt = Number(args.maxTokens);
    if (Number.isFinite(mt) && mt > 0) body.max_tokens = Math.floor(mt);
    if (withUsage) body.stream_options = { include_usage: true };
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
    res = await doFetch(wantsUsage);
    if (!res.ok && wantsUsage) {
      const text = await res.text().catch(() => "");
      // 兼容性兜底：有些 OpenAI-compatible 不接受 stream_options/include_usage
      if (res.status === 400 && /stream_options|include_usage/i.test(text)) {
        res = await doFetch(false);
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

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    yield { type: "error", error: text || `UPSTREAM_${res.status}` };
    return;
  }
  if (!res.body) {
    yield { type: "error", error: "UPSTREAM_EMPTY_BODY" };
    return;
  }

  let sawFinishReason = false;
  for await (const line of readLines(res.body)) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // sse comment/ping
    if (!line.startsWith("data:")) continue;

    const data = line.slice("data:".length).trim();
    if (!data) continue;

    if (data === "[DONE]") {
      yield { type: "done" };
      return;
    }

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
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
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      yield { type: "delta", delta };
    }

    const finishReason = choice?.finish_reason;
    if (finishReason) {
      sawFinishReason = true;
      if (!wantsUsage) {
        yield { type: "done" };
        return;
      }
    }
  }

  if (sawFinishReason) {
    yield { type: "done" };
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
}): Promise<ChatCompletionOnceResult> {
  const url = openAiCompatUrl(args.config.baseUrl, args.endpoint || "/chat/completions");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.config.apiKey}`,
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        ...(Number.isFinite(Number(args.maxTokens)) && Number(args.maxTokens) > 0
          ? { max_tokens: Math.floor(Number(args.maxTokens)) }
          : {}),
        stream: false,
      }),
      signal: args.signal,
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || `UPSTREAM_${res.status}`, status: res.status, rawText: text };
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "UPSTREAM_INVALID_JSON", status: res.status, rawText: text };
  }

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { ok: false, error: "UPSTREAM_EMPTY_CONTENT", status: res.status, rawText: JSON.stringify(json) };
  }
  return { ok: true, content, raw: json };
}


