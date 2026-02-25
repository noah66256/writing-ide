// Anthropic Messages API 规范类型 + SSE 流适配器
// 内部规范格式：所有工具协议统一以此表示，取代原 XML ReAct 协议

import type { ToolMeta } from "@writing-ide/tools";
import { encodeToolName, decodeToolName } from "@writing-ide/tools";

// ──────────────────────────────────────────────
// 核心类型（对齐 Anthropic Messages API v1）
// ──────────────────────────────────────────────

export type ContentBlockText = {
  type: "text";
  text: string;
};

export type ContentBlockToolUse = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ContentBlockToolResult = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
};

export type ContentBlock = ContentBlockText | ContentBlockToolUse | ContentBlockToolResult;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

// ──────────────────────────────────────────────
// 流事件类型（规范化后）
// ──────────────────────────────────────────────

export type MsgStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_done"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done" }
  | { type: "error"; error: string };

export type AnthropicStreamArgs = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string } | { type: "none" };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

// ──────────────────────────────────────────────
// 内部辅助函数
// ──────────────────────────────────────────────

function normalizeBaseUrl(baseUrl?: string): string {
  const b = String(baseUrl || "https://api.anthropic.com").trim().replace(/\/+$/, "");
  return b.endsWith("/v1") ? b : `${b}/v1`;
}

function toErrorString(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? "UNKNOWN_ERROR");
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  // Node.js undici fetch errors wrap the real cause (ECONNREFUSED, ETIMEDOUT, etc.)
  const cause = (err as any).cause;
  if (cause instanceof Error && cause.message && cause.message !== err.message) {
    parts.push(cause.message);
    const inner = (cause as any).cause;
    if (inner instanceof Error && inner.message) parts.push(inner.message);
  }
  return parts.join(" → ") || "UNKNOWN_ERROR";
}

// 将 ToolMeta arg 转为标准 JSON Schema property。
// ToolArgType 与 JSON Schema type 一一对应（string/number/boolean/object/array）。
function toolArgToJsonSchemaProp(arg: ToolMeta["args"][number]): Record<string, unknown> {
  const type = arg.type ?? "string";
  return arg.desc ? { type, description: arg.desc } : { type };
}

// ──────────────────────────────────────────────
// 工具格式转换：ToolMeta → AnthropicToolDef
// ──────────────────────────────────────────────

export function toolMetaToAnthropicDef(meta: ToolMeta): AnthropicToolDef {
  // ToolArgType 现已与 JSON Schema type 一一对应，直接透传。
  const properties = Object.fromEntries(
    (meta.args ?? []).map((arg) => [arg.name, toolArgToJsonSchemaProp(arg)]),
  );

  // required：优先 inputSchema.required，否则从 args 推导
  const required: string[] =
    (meta.inputSchema?.required?.length ?? 0) > 0
      ? meta.inputSchema!.required!
      : (meta.args ?? []).filter((a) => Boolean(a.required)).map((a) => a.name);

  return {
    name: encodeToolName(meta.name),
    description: meta.description,
    input_schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

// ──────────────────────────────────────────────
// 工具结果消息构建（写入 messages 数组）
// ──────────────────────────────────────────────

export function buildToolResultMessage(
  toolUseId: string,
  result: unknown,
  isError = false,
): AnthropicMessage {
  const content = typeof result === "string" ? result : JSON.stringify(result ?? null);
  const block: ContentBlockToolResult = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
  return { role: "user", content: [block] };
}

// ──────────────────────────────────────────────
// Anthropic Messages API 流式调用（SSE）
// ──────────────────────────────────────────────

export async function* streamAnthropicMessages(
  args: AnthropicStreamArgs,
): AsyncGenerator<MsgStreamEvent> {
  const url = `${normalizeBaseUrl(args.baseUrl)}/messages`;

  const maxTokens =
    typeof args.maxTokens === "number" && args.maxTokens > 0 ? Math.floor(args.maxTokens) : 8192;

  // Re-encode tool_use names in historical messages:
  // Internal code uses decoded names (e.g., "run.setTodoList") but the API
  // requires them to match the encoded names in the tools parameter (e.g., "run_dot_setTodoList").
  const messages = args.messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
    const hasToolUse = (msg.content as any[]).some((b) => b?.type === "tool_use");
    if (!hasToolUse) return msg;
    return {
      ...msg,
      content: (msg.content as any[]).map((b) =>
        b?.type === "tool_use" ? { ...b, name: encodeToolName(String(b.name ?? "")) } : b,
      ),
    };
  });

  const body: Record<string, unknown> = {
    model: args.model,
    messages,
    stream: true,
    max_tokens: maxTokens,
  };
  if (typeof args.system === "string" && args.system.length > 0) body.system = args.system;
  if (Array.isArray(args.tools) && args.tools.length > 0) body.tools = args.tools;
  if (args.tool_choice) body.tool_choice = args.tool_choice;
  if (typeof args.temperature === "number" && Number.isFinite(args.temperature)) {
    body.temperature = args.temperature;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": args.apiKey,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (err) {
    yield { type: "error", error: toErrorString(err) };
    return;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    yield { type: "error", error: `HTTP_${res.status}: ${errText.slice(0, 500)}` };
    return;
  }

  if (!res.body) {
    yield { type: "error", error: "UPSTREAM_EMPTY_BODY" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // block index（Anthropic SSE content_block_start 里的 index 字段）→ { id, name }
  const toolIndexMap = new Map<number, { id: string; name: string }>();
  // tool id → 已积累的 partial JSON 字符串
  const toolInputAccum = new Map<string, string>();

  let promptTokensCumulative = 0;
  let completionTokensCumulative = 0;
  let buf = "";

  // 同步 generator：解析一行 SSE data 并产出流事件（无 async 操作，yield* 即可）
  function* handleLine(line: string): Generator<MsgStreamEvent> {
    if (!line.startsWith("data:")) return;
    const raw = line.slice("data:".length).trim();
    if (!raw || raw === "[DONE]") return;

    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }

    switch (String(ev?.type ?? "")) {
      case "message_start": {
        const n = Number(ev?.message?.usage?.input_tokens);
        if (Number.isFinite(n) && n > 0) {
          promptTokensCumulative = Math.floor(n);
          yield { type: "usage", promptTokens: promptTokensCumulative, completionTokens: 0 };
        }
        break;
      }

      case "content_block_start": {
        const block = ev?.content_block;
        if (block?.type !== "tool_use") break;
        const idx = Number(ev?.index);
        if (!Number.isFinite(idx)) break;
        const id = String(block.id ?? "");
        const name = decodeToolName(String(block.name ?? ""));
        if (!id || !name) break;
        toolIndexMap.set(idx, { id, name });
        toolInputAccum.set(id, "");
        yield { type: "tool_use_start", id, name };
        break;
      }

      case "content_block_delta": {
        const delta = ev?.delta;
        if (!delta || typeof delta !== "object") break;
        if (delta.type === "text_delta") {
          const text = String(delta.text ?? "");
          if (text) yield { type: "text_delta", delta: text };
        } else if (delta.type === "input_json_delta") {
          const idx = Number(ev?.index);
          if (!Number.isFinite(idx)) break;
          const tool = toolIndexMap.get(idx);
          if (!tool) break;
          const partial = String(delta.partial_json ?? "");
          if (!partial) break;
          toolInputAccum.set(tool.id, (toolInputAccum.get(tool.id) ?? "") + partial);
          yield { type: "tool_use_input_delta", id: tool.id, partial_json: partial };
        }
        break;
      }

      case "content_block_stop": {
        const idx = Number(ev?.index);
        if (!Number.isFinite(idx)) break;
        const tool = toolIndexMap.get(idx);
        if (!tool || !toolInputAccum.has(tool.id)) break;
        const jsonStr = toolInputAccum.get(tool.id) ?? "{}";
        toolInputAccum.delete(tool.id);
        toolIndexMap.delete(idx);
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // 解析失败给空 input，不中断流
        }
        yield { type: "tool_use_done", id: tool.id, name: tool.name, input };
        break;
      }

      case "message_delta": {
        const n = Number(ev?.usage?.output_tokens);
        if (Number.isFinite(n) && n > 0) {
          completionTokensCumulative = Math.floor(n);
          yield {
            type: "usage",
            promptTokens: promptTokensCumulative,
            completionTokens: completionTokensCumulative,
          };
        }
        break;
      }

      case "message_stop": {
        yield { type: "done" };
        break;
      }

      case "error": {
        const errObj = ev?.error;
        const msg =
          typeof errObj?.message === "string"
            ? errObj.message
            : typeof errObj === "string"
              ? errObj
              : "ANTHROPIC_STREAM_ERROR";
        yield { type: "error", error: msg };
        break;
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        yield* handleLine(line);
        nl = buf.indexOf("\n");
      }
    }

    // 处理末尾无换行的残留行
    if (buf.trim()) yield* handleLine(buf.replace(/\r$/, ""));
  } catch (err) {
    yield { type: "error", error: toErrorString(err) };
  } finally {
    reader.releaseLock();
  }
}

// ──────────────────────────────────────────────
// Anthropic Messages API 非流式调用（用于抽卡等后台任务）
// ──────────────────────────────────────────────

export type AnthropicOnceArgs = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type AnthropicOnceResult = {
  ok: boolean;
  content?: string;
  error?: string;
  status?: number;
  rawText?: string;
  raw?: any;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
};

/**
 * Anthropic Messages API 非流式调用。
 * 用于抽卡、评估等后台工作流——这些场景不需要流式，但需要走原生 Anthropic 协议。
 */
export async function completionOnceAnthropicMessages(args: AnthropicOnceArgs): Promise<AnthropicOnceResult> {
  const url = `${normalizeBaseUrl(args.baseUrl)}/messages`;
  const maxTokens =
    typeof args.maxTokens === "number" && args.maxTokens > 0 ? Math.floor(args.maxTokens) : 8192;

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    max_tokens: maxTokens,
    stream: false,
  };
  if (typeof args.system === "string" && args.system.length > 0) body.system = args.system;
  if (typeof args.temperature === "number" && Number.isFinite(args.temperature)) {
    body.temperature = args.temperature;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": args.apiKey,
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (e) {
    return { ok: false, error: toErrorString(e) };
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

  // Anthropic Messages API 响应格式：{ content: [{ type: "text", text: "..." }], usage: {...} }
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  const textParts = blocks
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b?.text ?? ""));
  const content = textParts.join("");

  if (!content.trim()) {
    return { ok: false, error: "UPSTREAM_EMPTY_CONTENT", status: res.status, rawText: JSON.stringify(json) };
  }

  const u = json?.usage;
  const pt = Number(u?.input_tokens ?? 0);
  const ct = Number(u?.output_tokens ?? 0);
  const usage =
    Number.isFinite(pt) || Number.isFinite(ct)
      ? {
          promptTokens: Math.max(0, Math.floor(pt)),
          completionTokens: Math.max(0, Math.floor(ct)),
          totalTokens: Math.max(0, Math.floor(pt) + Math.floor(ct)),
        }
      : undefined;

  return usage
    ? { ok: true, content, raw: json, usage }
    : { ok: true, content, raw: json };
}
