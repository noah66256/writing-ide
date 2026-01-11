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
  return `${withV1(baseUrl)}${p}`;
}

export type StreamDeltaEvent =
  | { type: "delta"; delta: string }
  | { type: "done" }
  | { type: "error"; error: string };

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
  signal?: AbortSignal;
}): AsyncGenerator<StreamDeltaEvent> {
  const url = openAiCompatUrl(args.config.baseUrl, "/chat/completions");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.config.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      stream: true
    }),
    signal: args.signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    yield { type: "error", error: text || `UPSTREAM_${res.status}` };
    return;
  }
  if (!res.body) {
    yield { type: "error", error: "UPSTREAM_EMPTY_BODY" };
    return;
  }

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

    const choice = json?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      yield { type: "delta", delta };
    }

    const finishReason = choice?.finish_reason;
    if (finishReason) {
      yield { type: "done" };
      return;
    }
  }
}


