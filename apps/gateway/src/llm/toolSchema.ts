export function normalizeToolParametersSchema(raw: unknown): Record<string, unknown> {
  const fallback = { type: "object", properties: {}, additionalProperties: true } as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;

  // 提取 $defs / definitions 用于内联 $ref（draft 2020-12 用 $defs，draft-07 用 definitions）
  const src = raw as Record<string, unknown>;
  const defs: Record<string, unknown> = {};
  for (const defKey of ["$defs", "definitions"]) {
    const d = src[defKey];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) defs[k] = v;
    }
  }

  const resolving = new Set<string>(); // 防止循环引用

  const walk = (node: unknown, topLevel = false): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x));
    if (!node || typeof node !== "object") return node;

    const src = node as Record<string, unknown>;

    // 内联 $ref：将 { "$ref": "#/$defs/Foo" } 替换为 defs.Foo 的展开结果
    if (typeof src.$ref === "string") {
      const ref = src.$ref;
      const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
      if (match && defs[match[1]] && !resolving.has(match[1])) {
        resolving.add(match[1]);
        const resolved = walk(defs[match[1]], false);
        resolving.delete(match[1]);
        return resolved;
      }
      // 无法解析的 $ref → 退化为空 schema（接受任意值）
      return {};
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      // 剥离 JSON Schema 元信息：$schema / $defs / definitions
      // LLM API / pi-agent-core 的 Ajv 不支持 draft/2020-12，会报
      // "no schema with key or ref" 错误
      if (k === "$schema" || k === "$defs" || k === "definitions") continue;
      if (topLevel && (k === "oneOf" || k === "anyOf" || k === "allOf" || k === "enum" || k === "not")) {
        continue;
      }
      if (k === "oneOfRequired") continue;
      out[k] = walk(v, false);
    }

    if (String(out.type ?? "") === "array") {
      if (out.items === undefined || out.items === null) out.items = {};
      else out.items = walk(out.items, false);
    }
    if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
      const props = out.properties as Record<string, unknown>;
      const nextProps: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(props)) nextProps[pk] = walk(pv, false);
      out.properties = nextProps;
    }
    if (Array.isArray(out.required)) {
      out.required = (out.required as unknown[]).map((s) => String(s ?? "").trim()).filter(Boolean);
    }
    return out;
  };

  const normalized = walk(raw, true);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return fallback;
  const top = normalized as Record<string, unknown>;
  if (String(top.type ?? "") !== "object") top.type = "object";
  if (!top.properties || typeof top.properties !== "object" || Array.isArray(top.properties)) top.properties = {};
  if (top.additionalProperties === undefined) top.additionalProperties = true;
  return top;
}
