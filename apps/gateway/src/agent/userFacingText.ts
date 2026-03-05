export type SanitizeAssistantTextOptions = {
  dropPureJsonPayload?: boolean;
};

export type SanitizedAssistantText = {
  text: string;
  dropped: boolean;
  reason?: "pure_json_payload" | "empty_after_strip";
};

const TOOL_XML_RE = /<(tool_calls|function_calls)\b[\s\S]*?<\/\1>/gi;
const TOOL_RESULT_XML_RE = /<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi;
const TOOL_RESULT_BLOCK_RE = /\[tool_result\b[^\]]*\][\s\S]*?\[\/tool_result\]/gi;
const TOOL_CALL_LINE_RE = /\[Tool Call:[^\]]*\]\s*(?:\r?\n\s*Arguments\s*:\s*[\s\S]*?(?=\r?\n\r?\n|$))?/gi;
const TOOL_RESULT_LINE_RE = /\[Tool Result[^\]]*\][\s\S]*?(?=\r?\n\r?\n|$)/gi;
const HISTORICAL_CONTEXT_RE = /\[Historical context:[^\]]*\]\s*/gi;
const THINKING_TAG_RE = /<\s*\/?\s*(think(?:ing)?|thought|reasoning)\b[^>]*>/gi;

function parseJsonObjectOrArrayFromWholeText(raw: string): unknown {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ? String(fenced[1]).trim() : text;
  if (!candidate) return null;
  const startsLikeJson =
    (candidate.startsWith("{") && candidate.endsWith("}")) ||
    (candidate.startsWith("[") && candidate.endsWith("]"));
  if (!startsLikeJson) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function sanitizeAssistantUserFacingText(
  raw: string,
  opts: SanitizeAssistantTextOptions = {},
): SanitizedAssistantText {
  let text = String(raw ?? "");
  if (!text.trim()) return { text: "", dropped: true, reason: "empty_after_strip" };

  text = text
    .replace(TOOL_XML_RE, " ")
    .replace(TOOL_RESULT_XML_RE, " ")
    .replace(TOOL_RESULT_BLOCK_RE, " ")
    .replace(TOOL_CALL_LINE_RE, " ")
    .replace(TOOL_RESULT_LINE_RE, " ")
    .replace(HISTORICAL_CONTEXT_RE, " ")
    .replace(THINKING_TAG_RE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) return { text: "", dropped: true, reason: "empty_after_strip" };

  if (opts.dropPureJsonPayload) {
    const parsed = parseJsonObjectOrArrayFromWholeText(text);
    if (parsed !== null) {
      return { text: "", dropped: true, reason: "pure_json_payload" };
    }
  }

  return { text, dropped: false };
}
