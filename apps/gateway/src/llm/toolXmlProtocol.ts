export type ToolXmlCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

export function xmlEscapeAttr(raw: string): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function xmlCdataSafe(raw: string): string {
  return String(raw ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function stripCdata(raw: string): string {
  const m = String(raw ?? "").match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m?.[1] !== undefined ? String(m[1]) : String(raw ?? "");
}

function parseXmlArgValue(raw: string): unknown {
  const t = stripCdata(String(raw ?? "").trim());
  if (!t) return "";
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t) && t.length < 32) return Number(t);
  return t;
}

export function parseToolCallsXml(text: string): {
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  plainText: string;
  wrapperCount: number;
  hasToolCallMarker: boolean;
  mixedOutput: boolean;
} {
  const source = String(text ?? "");
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const wrappers = Array.from(source.matchAll(/<(tool_calls|function_calls)\b[\s\S]*?<\/\1>/gi));
  if (wrappers.length === 0) {
    return {
      calls: [],
      plainText: source.trim(),
      wrapperCount: 0,
      hasToolCallMarker: /<\s*\/?\s*(tool_calls|function_calls|tool_call|invoke|arg|parameter)\b/i.test(source),
      mixedOutput: false,
    };
  }

  const plainParts: string[] = [];
  let lastEnd = 0;
  let callIndex = 0;
  for (const wrapper of wrappers) {
    const xml = String(wrapper[0] ?? "");
    const start = typeof wrapper.index === "number" ? wrapper.index : source.indexOf(xml, lastEnd);
    const safeStart = start >= 0 ? start : lastEnd;
    plainParts.push(source.slice(lastEnd, safeStart));
    lastEnd = safeStart + xml.length;

    const toolCallRe = /<(tool_call|invoke)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null = null;
    while ((m = toolCallRe.exec(xml)) !== null) {
      callIndex += 1;
      const attrs = String(m[2] ?? "");
      const body = String(m[3] ?? "");
      const nameM = attrs.match(/\bname\s*=\s*"([^"]+)"/i) ?? attrs.match(/\bname\s*=\s*'([^']+)'/i);
      const idM = attrs.match(/\bid\s*=\s*"([^"]+)"/i) ?? attrs.match(/\bid\s*=\s*'([^']+)'/i);
      const name = String(nameM?.[1] ?? "").trim();
      if (!name) continue;
      const id = String(idM?.[1] ?? "").trim() || `xml_tool_${Date.now()}_${callIndex}`;
      const args: Record<string, unknown> = {};
      const argRe = /<(arg|parameter)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      let a: RegExpExecArray | null = null;
      while ((a = argRe.exec(body)) !== null) {
        const aAttrs = String(a[2] ?? "");
        const aNameM = aAttrs.match(/\bname\s*=\s*"([^"]+)"/i) ?? aAttrs.match(/\bname\s*=\s*'([^']+)'/i);
        const aName = String(aNameM?.[1] ?? "").trim();
        if (!aName) continue;
        args[aName] = parseXmlArgValue(String(a[3] ?? ""));
      }
      calls.push({ id, name, args });
    }
  }
  plainParts.push(source.slice(lastEnd));
  const plainText = plainParts.join("").trim();
  return {
    calls,
    plainText,
    wrapperCount: wrappers.length,
    hasToolCallMarker: true,
    mixedOutput: plainText.length > 0,
  };
}

export function buildToolCallsXml(calls: ToolXmlCall[]): string {
  const blocks = (Array.isArray(calls) ? calls : [])
    .map((c) => {
      const name = String(c?.name ?? "").trim();
      if (!name) return "";
      const args = c?.args && typeof c.args === "object" ? c.args : {};
      const argXml = Object.entries(args)
        .map(([k, v]) => {
          const encoded = typeof v === "string" ? v : JSON.stringify(v ?? null);
          return `<arg name="${xmlEscapeAttr(k)}"><![CDATA[${xmlCdataSafe(encoded)}]]></arg>`;
        })
        .join("");
      const idAttr = String(c?.id ?? "").trim() ? ` id="${xmlEscapeAttr(String(c.id))}"` : "";
      return `<tool_call${idAttr} name="${xmlEscapeAttr(name)}">${argXml}</tool_call>`;
    })
    .filter(Boolean)
    .join("");
  return blocks ? `<tool_calls>${blocks}</tool_calls>` : "";
}
