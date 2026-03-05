export function normalizeToolParametersSchema(raw: unknown): Record<string, unknown> {
  const fallback = { type: "object", properties: {}, additionalProperties: true } as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;

  const walk = (node: unknown, topLevel = false): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x));
    if (!node || typeof node !== "object") return node;

    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
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
