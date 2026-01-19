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
  | { ok: true; content: string; raw: any; usage?: { promptTokens: number; completionTokens: number; totalTokens?: number } }
  | { ok: false; error: string; status?: number; rawText?: string };

function kindOfContentLike(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
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

  if (
    diag.deltaChars === 0 &&
    (diag.sawPayloadLine || diag.sawDataLine || diag.sawDone || sawFinishReason) &&
    !args.signal?.aborted
  ) {
    const once = await chatCompletionOnce({
      config: args.config,
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
      endpoint: args.endpoint,
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

  const contentLike =
    json?.choices?.[0]?.message?.content ??
    (json?.choices?.[0] as any)?.text ??
    json?.choices?.[0]?.delta?.content;
  const content = coerceOpenAiContentToText(contentLike);
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, error: "UPSTREAM_EMPTY_CONTENT", status: res.status, rawText: JSON.stringify(json) };
  }
  const u = json?.usage;
  const pt = Number(u?.prompt_tokens ?? u?.promptTokens);
  const ct = Number(u?.completion_tokens ?? u?.completionTokens);
  const tt = Number(u?.total_tokens ?? u?.totalTokens);
  const usage =
    (Number.isFinite(pt) || Number.isFinite(ct) || Number.isFinite(tt))
      ? {
          promptTokens: Number.isFinite(pt) ? Math.max(0, Math.floor(pt)) : 0,
          completionTokens: Number.isFinite(ct) ? Math.max(0, Math.floor(ct)) : 0,
          ...(Number.isFinite(tt) ? { totalTokens: Math.max(0, Math.floor(tt)) } : {}),
        }
      : undefined;
  return usage ? { ok: true, content, raw: json, usage } : { ok: true, content, raw: json };
}


