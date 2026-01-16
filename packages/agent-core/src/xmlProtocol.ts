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
  // 允许前后夹杂杂质（例如某些模型会输出 <|begin_of_sentence|>），只截取 XML 主体
  const m1 = t.match(/<tool_calls\b[\s\S]*?<\/tool_calls\s*>/);
  if (m1?.[0]) return m1[0];
  const m2 = t.match(/<tool_call\b[\s\S]*?<\/tool_call\s*>/);
  if (m2?.[0]) return m2[0];
  if (t.startsWith("<tool_calls") || t.startsWith("<tool_call")) return t;
  return null;
}

export function isToolCallMessage(text: string) {
  const t = stripCodeFences(text).trim();
  return t.startsWith("<tool_calls") || t.startsWith("<tool_call") || t.includes("<tool_calls") || t.includes("<tool_call");
}

export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const xml = extractXmlBlock(text);
  if (!xml) return null;

  // 1) DOMParser（浏览器环境优先；严格）
  const DOMParserCtor = (globalThis as any)?.DOMParser;
  if (typeof DOMParserCtor === "function") {
    try {
      const parser = new DOMParserCtor();
      const doc = parser.parseFromString(xml, "application/xml");
      const parseError = typeof doc?.querySelector === "function" ? doc.querySelector("parsererror") : null;
      if (!parseError) {
        const nodes = Array.from(doc.getElementsByTagName("tool_call") ?? []);
        if (nodes.length) {
          const calls: ParsedToolCall[] = [];
          for (const n of nodes as any[]) {
            const name = String(n?.getAttribute?.("name") ?? "").trim();
            if (!name) continue;
            const args: Record<string, string> = {};
            const argNodes = Array.from(n.getElementsByTagName?.("arg") ?? []);
            for (const a of argNodes as any[]) {
              const argName = String(a?.getAttribute?.("name") ?? "").trim();
              if (!argName) continue;
              args[argName] = String(a?.textContent ?? "");
            }
            calls.push({ name, args });
          }
          if (calls.length) return calls;
        }
      }
    } catch {
      // fallthrough
    }
  }

  // 2) regex 容错兜底（Node/兼容不规范 XML）
  const stripCdata = (s: string) => {
    const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return (m ? m[1] : s).trim();
  };

  const calls: ParsedToolCall[] = [];
  // 容错：允许 name= 未加引号（部分模型偶发），并允许 </tool_call\s*>
  const toolRe = /<tool_call\b[^>]*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/tool_call\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(xml))) {
    const name = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    const body = m[4] ?? "";
    if (!name) continue;
    const args: Record<string, string> = {};
    const argRe = /<arg\b[^>]*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/arg\s*>/g;
    let am: RegExpExecArray | null;
    while ((am = argRe.exec(body))) {
      const argName = (am[1] ?? am[2] ?? am[3] ?? "").trim();
      if (!argName) continue;
      args[argName] = stripCdata(am[4] ?? "");
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

export function renderToolErrorXml(name: string, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return renderToolResultXml(name, { ok: false, error: msg });
}


