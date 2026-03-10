export type ContextSegmentPriorityV1 = "p0" | "p1" | "p2" | "p3";
export type ContextSegmentFormatV1 = "JSON" | "Markdown" | "Text";

/**
 * kind 主要用于 Gateway 选择/预算策略；保持开放字符串，避免协议僵化。
 * 推荐值：coreRules/taskState/memoryRecall/materials/meta/other
 */
export type ContextSegmentKindV1 = string;

export type ContextSegmentV1 = {
  /** 稳定 id：用于 selector/budget 精确裁剪 */
  id: string;
  /** 语义名：用于调试、人类可读 */
  name: string;
  kind: ContextSegmentKindV1;
  priority: ContextSegmentPriorityV1;
  trusted: boolean;
  format: ContextSegmentFormatV1;
  /** 纯内容，不包含 NAME(JSON): 包装壳 */
  content: string;
  meta?: Record<string, unknown>;
};

export type ContextManifestSegmentV1 = {
  id: string;
  name: string;
  kind?: string;
  chars: number;
  priority: ContextSegmentPriorityV1;
  trusted: boolean;
  truncated: boolean;
  source?: string;
  note?: string;
};

export type ContextManifestV1 = {
  v: 1;
  generatedAt: string;
  mode: "agent" | "chat";
  totalSegments: number;
  totalChars: number;
  segments: ContextManifestSegmentV1[];
  /** 可选：便于审计 UI 只展示 top N */
  top?: ContextManifestSegmentV1[];
};

export function buildContextManifestV1(args: {
  mode: "agent" | "chat";
  segments: ContextSegmentV1[];
}): ContextManifestV1 {
  const list = Array.isArray(args.segments) ? args.segments : [];
  const segs: ContextManifestSegmentV1[] = list.map((seg) => {
    const content = String(seg.content ?? "");
    return {
      id: String(seg.id ?? seg.name ?? "").trim() || String(seg.name ?? "").trim(),
      name: String(seg.name ?? "").trim(),
      kind: String(seg.kind ?? "").trim() || undefined,
      chars: content.length,
      priority: seg.priority,
      trusted: Boolean(seg.trusted),
      truncated: Boolean((seg.meta as any)?.truncated),
      source: typeof (seg.meta as any)?.source === "string" ? String((seg.meta as any).source) : undefined,
      note: typeof (seg.meta as any)?.note === "string" ? String((seg.meta as any).note) : undefined,
    };
  });
  const totalChars = segs.reduce((acc, s) => acc + (Number.isFinite(Number(s.chars)) ? s.chars : 0), 0);
  const payload: ContextManifestV1 = {
    v: 1,
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    totalSegments: segs.length,
    totalChars,
    segments: segs,
    top: segs
      .slice()
      .sort((a, b) => (b.chars || 0) - (a.chars || 0))
      .slice(0, 8),
  };
  return payload;
}

/** 兼容输出：渲染为旧版 contextPack 大字符串（便于渐进迁移）。 */
export function renderContextPackV1(args: {
  mode: "agent" | "chat";
  segments: ContextSegmentV1[];
  manifest?: ContextManifestV1 | null;
}): string {
  const segs = Array.isArray(args.segments) ? args.segments : [];
  const manifest = args.manifest ?? buildContextManifestV1({ mode: args.mode, segments: segs });
  const normalizeBlock = (s: string) => {
    const t = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return t.endsWith("\n\n") ? t : t + "\n\n";
  };
  const blocks: string[] = [];
  blocks.push(`CONTEXT_MANIFEST(JSON):\n${JSON.stringify(manifest, null, 2)}\n\n`);
  for (const seg of segs) {
    const name = String(seg.name ?? "").trim();
    if (!name || name === "CONTEXT_MANIFEST") continue;
    const format = seg.format === "Markdown" ? "Markdown" : seg.format === "Text" ? "Markdown" : "JSON";
    blocks.push(`${name}(${format}):\n${normalizeBlock(seg.content)}`);
  }
  return blocks.join("");
}

