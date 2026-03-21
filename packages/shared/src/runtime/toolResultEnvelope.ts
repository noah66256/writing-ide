export const MAX_INLINE_TOOL_RESULT_CHARS = 8_000;
export const MAX_TOOL_RESULT_PREVIEW_CHARS = 2_000;
const MAX_GENERIC_PREVIEW_STRING_CHARS = 600;
const MAX_PREVIEW_KEYS = 20;
const MAX_PREVIEW_ARRAY = 12;
const MAX_PREVIEW_DEPTH = 3;

export type ToolResultPreviewKind = "text" | "json" | "error" | "read_file";

type ToolResultEnvelopeBase = {
  schemaVersion: 1;
  previewKind: ToolResultPreviewKind;
  summary: string;
  normalizedText: string;
  approxChars: number;
  truncated: boolean;
};

export type InlineToolResultEnvelope = ToolResultEnvelopeBase & {
  mode: "inline";
  inline: unknown;
  fullContentAvailability: "inline";
};

export type PreviewToolResultEnvelope = ToolResultEnvelopeBase & {
  mode: "preview";
  preview: unknown;
  fullContentAvailability: "turn_local_only";
};

export type ToolResultEnvelope = InlineToolResultEnvelope | PreviewToolResultEnvelope;

function truncateText(text: string, max: number): string {
  const raw = String(text ?? "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…(truncated,len=${raw.length})`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function compactStructuredPreview(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateText(value, MAX_GENERIC_PREVIEW_STRING_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[Function]";
  if (depth >= MAX_PREVIEW_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PREVIEW_ARRAY)
      .map((item) => compactStructuredPreview(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  let seen = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (seen >= MAX_PREVIEW_KEYS) break;
    seen += 1;
    out[key] = compactStructuredPreview(child, depth + 1);
  }
  return out;
}

function buildReadPreview(rawOutput: unknown, maxPreviewChars: number) {
  const out = rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)
    ? (rawOutput as Record<string, unknown>)
    : {};
  const path = String(out.path ?? "").trim();
  const fullContent = typeof out.content === "string" ? out.content : "";
  const contentPreview = fullContent ? fullContent.slice(0, maxPreviewChars) : "";
  const totalChars = Number(out.totalChars ?? fullContent.length ?? 0);
  const summary = path ? `已读取 ${path}（仅保留预览）` : "已读取文件（仅保留预览）";
  const normalizedText = truncateText(
    [summary, contentPreview].filter(Boolean).join("\n\n"),
    maxPreviewChars + 200,
  );
  return {
    summary,
    normalizedText,
    preview: {
      ok: out.ok !== false,
      path,
      totalChars: Number.isFinite(totalChars) ? totalChars : 0,
      truncated: Boolean(out.truncated) || fullContent.length > maxPreviewChars,
      virtualFromProposal: Boolean(out.virtualFromProposal),
      proposalSources: Array.isArray(out.proposalSources) ? out.proposalSources : [],
      previewChars: contentPreview.length,
      ...(contentPreview ? { contentPreview } : {}),
    },
  };
}

function buildErrorPreview(rawOutput: unknown) {
  const out = rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)
    ? (rawOutput as Record<string, unknown>)
    : {};
  const error = String(out.error ?? "TOOL_EXEC_FAILED").trim() || "TOOL_EXEC_FAILED";
  const message = String(out.message ?? out.detail ?? "").trim();
  const path = String(out.path ?? "").trim();
  const summary = message ? `${error}: ${message}` : error;
  return {
    summary: truncateText(summary, MAX_GENERIC_PREVIEW_STRING_CHARS),
    normalizedText: truncateText(stringifyUnknown(rawOutput), MAX_TOOL_RESULT_PREVIEW_CHARS + 200),
    preview: {
      ok: false,
      error,
      ...(message ? { message } : {}),
      ...(typeof out.code === "string" ? { code: out.code } : {}),
      ...(path ? { path } : {}),
      ...(Array.isArray(out.next_actions) ? { next_actions: out.next_actions.slice(0, 6) } : {}),
    },
  };
}

function inferPreviewKind(toolName: string, rawOutput: unknown): ToolResultPreviewKind {
  if (toolName === "read") return "read_file";
  if (
    rawOutput &&
    typeof rawOutput === "object" &&
    !Array.isArray(rawOutput) &&
    ((rawOutput as Record<string, unknown>).ok === false || "error" in (rawOutput as Record<string, unknown>))
  ) {
    return "error";
  }
  return typeof rawOutput === "string" ? "text" : "json";
}

function buildSummary(toolName: string, rawOutput: unknown, previewKind: ToolResultPreviewKind, approxChars: number): string {
  if (previewKind === "read_file") {
    const out = rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)
      ? (rawOutput as Record<string, unknown>)
      : {};
    const path = String(out.path ?? "").trim();
    return path ? `已读取 ${path}` : "已读取文件";
  }
  if (previewKind === "error") {
    const out = rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)
      ? (rawOutput as Record<string, unknown>)
      : {};
    const error = String(out.error ?? "TOOL_EXEC_FAILED").trim() || "TOOL_EXEC_FAILED";
    const message = String(out.message ?? out.detail ?? "").trim();
    return truncateText(message ? `${error}: ${message}` : error, MAX_GENERIC_PREVIEW_STRING_CHARS);
  }
  if (typeof rawOutput === "string") return truncateText(rawOutput.trim() || "(empty tool result)", MAX_GENERIC_PREVIEW_STRING_CHARS);
  if (Array.isArray(rawOutput)) return rawOutput.length > 0 ? `返回 ${rawOutput.length} 项` : "(empty tool result)";
  if (rawOutput && typeof rawOutput === "object") {
    const out = rawOutput as Record<string, unknown>;
    const summary = String(out.summary ?? out.message ?? out.note ?? "").trim();
    if (summary) return truncateText(summary, MAX_GENERIC_PREVIEW_STRING_CHARS);
    if (typeof out.path === "string" && out.path.trim()) return `${toolName || "工具"} 已处理 ${out.path.trim()}`;
  }
  return approxChars > 0 ? `工具结果已压缩（约 ${approxChars} 字符）` : "(empty tool result)";
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === 1 &&
    (obj.mode === "inline" || obj.mode === "preview") &&
    typeof obj.summary === "string" &&
    typeof obj.normalizedText === "string"
  );
}

export function getToolResultEnvelopePayload(value: unknown): unknown {
  if (!isToolResultEnvelope(value)) return value;
  return value.mode === "inline" ? value.inline : value.preview;
}

export function getToolResultEnvelopeSummary(value: unknown): string {
  if (isToolResultEnvelope(value)) return value.summary;
  return "";
}

export function getToolResultEnvelopeNormalizedText(value: unknown): string {
  if (isToolResultEnvelope(value)) return value.normalizedText;
  return truncateText(stringifyUnknown(value).trim() || "(empty tool result)", MAX_INLINE_TOOL_RESULT_CHARS);
}

export function compactToolResultEnvelope(
  toolName: string,
  rawOutput: unknown,
  options?: {
    maxInlineChars?: number;
    maxPreviewChars?: number;
  },
): ToolResultEnvelope {
  const maxInlineChars = Math.max(256, Math.floor(Number(options?.maxInlineChars ?? MAX_INLINE_TOOL_RESULT_CHARS)) || MAX_INLINE_TOOL_RESULT_CHARS);
  const maxPreviewChars = Math.max(128, Math.floor(Number(options?.maxPreviewChars ?? MAX_TOOL_RESULT_PREVIEW_CHARS)) || MAX_TOOL_RESULT_PREVIEW_CHARS);
  const rawText = stringifyUnknown(rawOutput).trim() || "(empty tool result)";
  const approxChars = rawText.length;
  const previewKind = inferPreviewKind(toolName, rawOutput);

  if (approxChars <= maxInlineChars) {
    const summary = buildSummary(toolName, rawOutput, previewKind, approxChars);
    return {
      schemaVersion: 1,
      mode: "inline",
      previewKind,
      summary,
      normalizedText: truncateText(rawText, maxInlineChars),
      approxChars,
      truncated: false,
      inline: rawOutput,
      fullContentAvailability: "inline",
    };
  }

  if (previewKind === "read_file") {
    const readPreview = buildReadPreview(rawOutput, maxPreviewChars);
    return {
      schemaVersion: 1,
      mode: "preview",
      previewKind,
      summary: readPreview.summary,
      normalizedText: readPreview.normalizedText,
      approxChars,
      truncated: true,
      preview: readPreview.preview,
      fullContentAvailability: "turn_local_only",
    };
  }

  if (previewKind === "error") {
    const errorPreview = buildErrorPreview(rawOutput);
    return {
      schemaVersion: 1,
      mode: "preview",
      previewKind,
      summary: errorPreview.summary,
      normalizedText: errorPreview.normalizedText,
      approxChars,
      truncated: true,
      preview: errorPreview.preview,
      fullContentAvailability: "turn_local_only",
    };
  }

  const preview = compactStructuredPreview(rawOutput);
  const summary = buildSummary(toolName, rawOutput, previewKind, approxChars);
  const normalizedText = truncateText(
    [summary, stringifyUnknown(preview).trim()].filter(Boolean).join("\n\n"),
    maxPreviewChars + 200,
  );
  return {
    schemaVersion: 1,
    mode: "preview",
    previewKind,
    summary,
    normalizedText,
    approxChars,
    truncated: true,
    preview,
    fullContentAvailability: "turn_local_only",
  };
}

export function slimToolResultEnvelopeForHistory(toolName: string, value: unknown): ToolResultEnvelope | unknown {
  if (!isToolResultEnvelope(value)) return compactToolResultEnvelope(toolName, value);
  if (value.mode === "inline") return compactToolResultEnvelope(toolName, value.inline);
  return {
    ...value,
    summary: truncateText(value.summary, MAX_GENERIC_PREVIEW_STRING_CHARS),
    normalizedText: truncateText(value.normalizedText, MAX_TOOL_RESULT_PREVIEW_CHARS + 200),
    preview: compactStructuredPreview(value.preview),
  };
}
