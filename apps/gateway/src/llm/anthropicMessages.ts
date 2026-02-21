// Anthropic Messages API 规范类型 + SSE 流适配器
// 内部规范格式：所有工具协议统一以此表示，取代原 XML ReAct 协议

import type { ToolMeta } from "@writing-ide/tools";

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
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "UNKNOWN_ERROR");
}

// 将 ToolMeta arg 转为标准 JSON Schema property。
// ToolMeta 使用自定义类型 "json"，需映射到标准的 "object"/"array"。
function toolArgToJsonSchemaProp(arg: ToolMeta["args"][number]): Record<string, unknown> {
  let type: string;
  if (arg.type === "number") type = "number";
  else if (arg.type === "boolean") type = "boolean";
  else if (arg.type === "json") type = arg.jsonType === "array" ? "array" : "object";
  else type = "string";

  return arg.desc ? { type, description: arg.desc } : { type };
}

// ──────────────────────────────────────────────
// 工具名编/解码：把 "run.setTodoList" 这类含 "." 的名字
// 编码为符合 OpenAI function name 规则 [a-zA-Z0-9_-] 的形式，
// 避免 VectorEngine 等兼容层代理因严格校验而拒绝请求。
// 编码规则：. → __dot__（保证可逆且不与合法字符冲突）
// ──────────────────────────────────────────────
function encodeToolName(name: string): string {
  return name.replace(/\./g, "__dot__");
}

function decodeToolName(name: string): string {
  return name.replace(/__dot__/g, ".");
}

// ──────────────────────────────────────────────
// 工具格式转换：ToolMeta → AnthropicToolDef
// ──────────────────────────────────────────────

export function toolMetaToAnthropicDef(meta: ToolMeta): AnthropicToolDef {
  // 不能直接透传 inputSchema.properties：其 type 是自定义 ToolArgType（含 "json"），
  // Anthropic API 要求标准 JSON Schema 类型（string/number/boolean/object/array）。
  // 始终从 meta.args 构建 properties，经 toolArgToJsonSchemaProp 规范化。
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

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
    max_tokens: maxTokens,
  };
  if (typeof args.system === "string" && args.system.length > 0) body.system = args.system;
  if (Array.isArray(args.tools) && args.tools.length > 0) body.tools = args.tools;
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
