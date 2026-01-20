import type { OpenAiChatMessage, StreamDeltaEvent } from "./openaiCompat.js";

function normUrl(v: string) {
  return String(v || "").trim().replace(/\/+$/g, "");
}

function normPath(v: string) {
  const t = String(v || "").trim();
  if (!t) return "";
  return t.startsWith("/") ? t : `/${t}`;
}

function joinUrl(baseUrl: string, endpoint: string) {
  const b = normUrl(baseUrl);
  const p = normPath(endpoint);
  if (!b || !p) return "";
  return `${b}${p}`;
}

function withApiKeyQuery(url: string, apiKey: string) {
  const key = String(apiKey || "").trim();
  if (!key) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("key")) u.searchParams.set("key", key);
    return u.toString();
  } catch {
    // fallback: 简单拼接
    if (url.includes("key=")) return url;
    return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  }
}

function extractGeminiText(json: any): string {
  const c = json?.candidates?.[0];
  const parts = c?.content?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .filter((t: string) => t.length > 0);
    return texts.join("");
  }
  const t = c?.content?.parts?.[0]?.text;
  return typeof t === "string" ? t : "";
}

function extractGeminiUsage(json: any): { promptTokens: number; completionTokens: number; totalTokens?: number } | null {
  const u = json?.usageMetadata;
  if (!u || typeof u !== "object") return null;
  const pt = Number((u as any)?.promptTokenCount);
  const ct = Number((u as any)?.candidatesTokenCount);
  const tt = Number((u as any)?.totalTokenCount);
  const out = {
    promptTokens: Number.isFinite(pt) ? Math.max(0, Math.floor(pt)) : 0,
    completionTokens: Number.isFinite(ct) ? Math.max(0, Math.floor(ct)) : 0,
    ...(Number.isFinite(tt) ? { totalTokens: Math.max(0, Math.floor(tt)) } : {}),
  };
  if (out.promptTokens <= 0 && out.completionTokens <= 0 && !(out as any).totalTokens) return null;
  return out;
}

function buildGeminiBody(args: { messages: OpenAiChatMessage[]; temperature?: number; maxTokens?: number | null }) {
  const isToolResultSystem = (text: string) => {
    const t = String(text ?? "").trimStart();
    return t.startsWith("<tool_result") || t.includes("<tool_result");
  };

  // Gemini 建议：systemInstruction 用于“全局规则”，不适合塞动态的 tool_result。
  // 否则在多回合（tool_result 后）更容易出现“候选为空/无输出”的情况。
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const m of args.messages) {
    const raw = String(m.content ?? "");
    const text = raw.trim();
    if (!text) continue;

    if (m.role === "system") {
      if (isToolResultSystem(text)) {
        contents.push({ role: "user", parts: [{ text }] });
      } else {
        systemParts.push(text);
      }
      continue;
    }
    if (m.role === "tool") continue;

    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }

  const system = systemParts.join("\n\n");

  const generationConfig: any = {};
  if (typeof args.temperature === "number" && Number.isFinite(args.temperature)) generationConfig.temperature = args.temperature;
  const mt = Number(args.maxTokens);
  if (Number.isFinite(mt) && mt > 0) generationConfig.maxOutputTokens = Math.floor(mt);

  const body: any = { contents };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
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

export function isGeminiEndpoint(endpoint: string) {
  const e = String(endpoint || "");
  return /:streamGenerateContent/i.test(e) || /:generateContent/i.test(e) || /\/v1beta\/models\//i.test(e);
}

export async function* streamGeminiGenerateContent(args: {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
}): AsyncGenerator<StreamDeltaEvent> {
  if (!isGeminiEndpoint(args.endpoint)) {
    yield { type: "error", error: `NOT_GEMINI_ENDPOINT:${String(args.endpoint || "")}` };
    return;
  }

  const url0 = joinUrl(args.baseUrl, args.endpoint);
  if (!url0) {
    yield { type: "error", error: "GEMINI_URL_INVALID" };
    return;
  }

  const url = withApiKeyQuery(url0, args.apiKey);
  const body = buildGeminiBody({ messages: args.messages, temperature: args.temperature, maxTokens: args.maxTokens });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 官方 API 支持 key= 查询参数；这里额外放一份 header，兼容一些网关/代理
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (e: any) {
    yield { type: "error", error: String(e?.message ?? e) };
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    yield { type: "error", error: text || `UPSTREAM_${res.status}` };
    return;
  }

  // 非流式：一次性 JSON
  const isStream = /:streamGenerateContent/i.test(String(args.endpoint || ""));
  if (!isStream || !res.body) {
    const json = await res.json().catch(() => null);
    const text = extractGeminiText(json);
    const usage = extractGeminiUsage(json);
    if (text) yield { type: "delta", delta: text };
    if (usage) yield { type: "usage", usage, raw: json };
    yield { type: "done" };
    return;
  }

  // 流式：逐行 JSON（有些实现会用 data: 前缀）
  let lastText = "";
  let lastUsage: any = null;

  for await (const line0 of readLines(res.body)) {
    const line = String(line0 || "").trim();
    if (!line) continue;
    if (line.startsWith(":")) continue;
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    if (!payload) continue;
    if (payload === "[DONE]") break;
    let json: any = null;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }

    const text = extractGeminiText(json);
    if (text) {
      const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (delta) yield { type: "delta", delta };
    }

    const usage = extractGeminiUsage(json);
    if (usage) lastUsage = usage;
  }

  // 兜底：Gemini 偶发“流结束但 0 delta”（finish_reason=STOP 但 text 为空）。
  // 这里按 research v1：仅当 0 delta 时，额外尝试一次非流式 generateContent。
  if (!lastText) {
    const endpoint2 = String(args.endpoint || "").replace(/:streamGenerateContent/i, ":generateContent");
    if (endpoint2 && endpoint2 !== args.endpoint) {
      const url2 = withApiKeyQuery(joinUrl(args.baseUrl, endpoint2), args.apiKey);
      try {
        const res2 = await fetch(url2, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": args.apiKey,
          },
          body: JSON.stringify(body),
          signal: args.signal,
        });
        if (!res2.ok) {
          const text2 = await res2.text().catch(() => "");
          yield { type: "error", error: text2 || `UPSTREAM_${res2.status}` };
          return;
        }
        const json2 = await res2.json().catch(() => null);
        const text2 = extractGeminiText(json2);
        const usage2 = extractGeminiUsage(json2);
        if (text2) yield { type: "delta", delta: text2 };
        if (usage2) yield { type: "usage", usage: usage2, raw: json2 };
        if (!text2 || String(text2).trim().length === 0) {
          yield { type: "error", error: "UPSTREAM_EMPTY_CONTENT" };
          return;
        }
        yield { type: "done" };
        return;
      } catch (e: any) {
        yield { type: "error", error: String(e?.message ?? e) };
        return;
      }
    }
    yield { type: "error", error: "UPSTREAM_EMPTY_CONTENT" };
    return;
  }

  if (lastUsage) yield { type: "usage", usage: lastUsage };
  yield { type: "done" };
}


