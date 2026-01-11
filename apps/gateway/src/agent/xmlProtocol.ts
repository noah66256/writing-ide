export type ParsedToolCall = {
  name: string;
  args: Record<string, string>;
};

function stripCodeFences(text: string) {
  const t = text.trim();
  if (!t.startsWith("```")) return text;
  const firstNl = t.indexOf("\n");
  if (firstNl < 0) return text;
  const body = t.slice(firstNl + 1);
  const end = body.lastIndexOf("```");
  if (end < 0) return body;
  return body.slice(0, end);
}

function extractXmlBlock(text: string): string | null {
  const t = stripCodeFences(text).trim();
  const i1 = t.indexOf("<tool_calls");
  if (i1 >= 0) {
    const i2 = t.indexOf("</tool_calls>");
    if (i2 >= 0) return t.slice(i1, i2 + "</tool_calls>".length);
  }
  const j1 = t.indexOf("<tool_call");
  if (j1 >= 0) {
    const j2 = t.indexOf("</tool_call>");
    if (j2 >= 0) return t.slice(j1, j2 + "</tool_call>".length);
  }
  if (t.startsWith("<tool_calls") || t.startsWith("<tool_call")) return t;
  return null;
}

export function isToolCallMessage(text: string) {
  const t = stripCodeFences(text).trim();
  return (
    t.startsWith("<tool_calls") ||
    t.startsWith("<tool_call") ||
    t.includes("<tool_calls") ||
    t.includes("<tool_call")
  );
}

export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const xml = extractXmlBlock(text);
  if (!xml) return null;

  const stripCdata = (s: string) => {
    const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return (m ? m[1] : s).trim();
  };

  const calls: ParsedToolCall[] = [];
  const toolRe = /<tool_call\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(xml))) {
    const name = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    if (!name) continue;
    const args: Record<string, string> = {};
    const argRe = /<arg\b[^>]*name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/arg>/g;
    let am: RegExpExecArray | null;
    while ((am = argRe.exec(body))) {
      const argName = (am[1] ?? "").trim();
      if (!argName) continue;
      args[argName] = stripCdata(am[2] ?? "");
    }
    calls.push({ name, args });
  }
  return calls.length ? calls : null;
}

function escapeAttr(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toCdata(text: string) {
  const safe = text.replaceAll("]]>", "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

export function renderToolResultXml(name: string, result: unknown) {
  let json = "";
  try {
    json = JSON.stringify(result ?? null);
  } catch {
    json = JSON.stringify({ ok: false, error: "RESULT_NOT_SERIALIZABLE" });
  }
  return `<tool_result name="${escapeAttr(name)}">${toCdata(json)}</tool_result>`;
}


