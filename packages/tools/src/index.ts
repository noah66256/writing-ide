export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolApplyPolicy = "proposal" | "auto_apply";
export type ToolMode = "plan" | "agent" | "chat";

export type ToolArgType = "string" | "number" | "boolean" | "json";

export type ToolArgSpec = {
  name: string;
  required?: boolean;
  desc: string;
  type?: ToolArgType;
  jsonType?: "object" | "array";
};

export type ToolJsonSchema = {
  type: "object";
  properties: Record<string, { type: ToolArgType; jsonType?: "object" | "array" }>;
  required?: string[];
  additionalProperties?: boolean;
  oneOfRequired?: Array<{ required: string[] }>;
};

export type ToolMeta = {
  name: string;
  description: string;
  args: ToolArgSpec[];
  modes?: ToolMode[];
  inputSchema?: ToolJsonSchema;
  outputSchema?: unknown;
};

// 工具契约（单一来源）：
// - Gateway 用于 toolsPrompt/allowlist（提示词与审计）
// - Desktop 用于工具说明/参数校验提示（后续逐步对齐）
export const TOOL_LIST: ToolMeta[] = [
  {
    name: "kb.search",
    description:
      "在本地知识库中检索（按库过滤、按 source_doc 分组返回）。\n" +
      "【仿写检索 skill（强烈建议）】当用户要求“按某库风格仿写/改写”时：先用 kb.search 拉 3–8 条可抄样例，再写稿；写作中遇到具体段落（开头/转折/结尾/金句）再补一次 kb.search。\n" +
      "【查询建议】\n" +
      "- 结构套路/五段论：kind=card，cardTypes=[outline,thesis]（这是“抽卡产物”，更适合口播/无标题文本）\n" +
      "- Markdown 标题目录：kind=outline（仅当源文档含 # 标题时才会命中；0 命中不代表库为空）\n" +
      "- 口吻/句式/金句：kind=paragraph，配合 anchorParagraphIndexMax/anchorFromEndMax 拉开头/结尾原文段\n" +
      "- 维度：传 facetIds（FacetPack，例如 opening_design/logic_framework/ending 等；主要对 kind=card 生效）\n" +
      "【提示】如未关联库，会报错 NO_LIBRARY_SELECTED；请先在右侧把库关联上。",
    args: [
      { name: "query", required: true, desc: "搜索关键词/问题", type: "string" },
      { name: "kind", required: false, desc: '可选：artifact kind（"card"|"outline"|"paragraph"），默认 "card"', type: "string" },
      { name: "libraryIds", required: false, desc: "可选：库 ID 数组；不传则默认使用右侧已关联库", type: "json", jsonType: "array" },
      { name: "facetIds", required: false, desc: "可选：outlineFacet id 数组（多选）", type: "json", jsonType: "array" },
      { name: "cardTypes", required: false, desc: "可选：仅 kind=card 时生效；限制 cardType（例如 hook/one_liner/ending/outline/thesis）", type: "json", jsonType: "array" },
      { name: "anchorParagraphIndexMax", required: false, desc: "可选：只搜前 N 段（开头样例；paragraphIndex < N）", type: "number" },
      { name: "anchorFromEndMax", required: false, desc: "可选：只搜距结尾 N 段内（结尾样例）", type: "number" },
      { name: "debug", required: false, desc: "可选：返回检索诊断信息（默认 true）", type: "boolean" },
      { name: "perDocTopN", required: false, desc: "每篇文档最多返回多少条命中（默认 3）", type: "number" },
      { name: "topDocs", required: false, desc: "最多返回多少篇文档（默认 12）", type: "number" },
      { name: "useVector", required: false, desc: "可选：是否使用向量做重排（true/false；默认 true）", type: "boolean" },
      { name: "embeddingModel", required: false, desc: '可选：向量模型 id（例如 "text-embedding-3-large" 或 "Embedding-V1"）', type: "string" },
    ],
    modes: ["plan", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string" },
        libraryIds: { type: "json", jsonType: "array" },
        facetIds: { type: "json", jsonType: "array" },
        cardTypes: { type: "json", jsonType: "array" },
        anchorParagraphIndexMax: { type: "number" },
        anchorFromEndMax: { type: "number" },
        debug: { type: "boolean" },
        perDocTopN: { type: "number" },
        topDocs: { type: "number" },
        useVector: { type: "boolean" },
        embeddingModel: { type: "string" },
      },
      required: ["query"],
      additionalProperties: true,
    },
  },
  {
    name: "lint.style",
    description:
      "风格 Linter（强烈建议用于仿写/改写/润色终稿）。\n" +
      "给定一段“候选稿”（text 或 path 指向的文件内容），以及绑定的风格库（purpose=style）的统计指纹/高频口癖/少量原文样例，使用强模型（默认 gpt-5）做对照检查：\n" +
      "- 找出“不像”的具体点（含证据与可量化差异）\n" +
      "- 生成一段可直接喂给工作模型（如 deepseek）的 rewritePrompt，用来二次改写\n" +
      "\n" +
      "【推荐工作流】（风格库已绑定且任务为写作类）：\n" +
      "1) 先 kb.search(kind=card, cardTypes=[hook,one_liner,ending,outline,thesis]) 拉套路/结构，再按需 kb.search(kind=paragraph, anchorParagraphIndexMax/anchorFromEndMax) 拉原文证据\n" +
      "2) 先产出一版候选稿（不要立刻写入文件）\n" +
      "3) lint.style(text=候选稿) → 拿 rewritePrompt 再改一版 → 最后 doc.write/doc.applyEdits\n",
    args: [
      { name: "text", required: false, desc: "要检查的候选稿文本（text/path 二选一必填）", type: "string" },
      { name: "path", required: false, desc: "要检查的文件路径（text/path 二选一必填；会优先读取提案态内容）", type: "string" },
      { name: "libraryIds", required: false, desc: "可选：风格库 ID 数组；不传则默认使用右侧已绑定的风格库（purpose=style）", type: "json", jsonType: "array" },
      { name: "model", required: false, desc: "可选：用于 linter 的强模型（默认优先 LLM_LINTER_MODEL，其次 LLM_CARD_MODEL）", type: "string" },
      { name: "maxIssues", required: false, desc: "可选：最多返回多少条“不像点”（默认 10）", type: "number" },
    ],
    modes: ["plan", "agent"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        path: { type: "string" },
        libraryIds: { type: "json", jsonType: "array" },
        model: { type: "string" },
        maxIssues: { type: "number" },
      },
      oneOfRequired: [{ required: ["text"] }, { required: ["path"] }],
      additionalProperties: true,
    },
  },
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。输入 patch(JSON)。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch", type: "json", jsonType: "object" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { patch: { type: "json", jsonType: "object" } }, required: ["patch"], additionalProperties: true },
  },
  {
    name: "run.setTodoList",
    description: "设置本次 Run 的 Todo List（用于进度追踪与防跑偏）。",
    args: [{ name: "items", required: true, desc: 'JSON 数组：TodoItem[]（{ id?, text, status?, note? }）', type: "json", jsonType: "array" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { items: { type: "json", jsonType: "array" } }, required: ["items"], additionalProperties: true },
  },
  {
    name: "run.updateTodo",
    description: "更新某一条 Todo 的状态/备注（用于记录进度）。",
    args: [
      { name: "id", required: false, desc: "Todo ID（来自 run.setTodoList 的返回）。若当前仅有 1 条 todo，可省略。", type: "string" },
      { name: "patch", required: true, desc: "JSON 对象：{ status?, note?, text? }", type: "json", jsonType: "object" },
    ],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { id: { type: "string" }, patch: { type: "json", jsonType: "object" } }, required: ["patch"], additionalProperties: true },
  },
  {
    name: "project.listFiles",
    description: "列出当前项目文件列表（path）。",
    args: [],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。",
    args: [],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc.read",
    description: "读取文件内容（path）。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）", type: "string" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: true },
  },
  {
    name: "doc.commitSnapshot",
    description: "创建一个项目快照（用于回滚/Undo）。",
    args: [{ name: "label", required: false, desc: "快照备注（可选）", type: "string" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: true },
  },
  {
    name: "doc.listSnapshots",
    description: "列出当前项目的快照列表（只读）。",
    args: [],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc.restoreSnapshot",
    description: "恢复到指定快照（proposal-first：Keep 才会真正恢复；Undo 可回滚）。",
    args: [{ name: "snapshotId", required: true, desc: "快照 ID（doc.commitSnapshot 的返回）", type: "string" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { snapshotId: { type: "string" } }, required: ["snapshotId"], additionalProperties: true },
  },
  {
    name: "doc.previewDiff",
    description: "生成 diff 预览（无副作用）。可传 newContent 或 edits。",
    args: [
      { name: "path", required: true, desc: "文件路径", type: "string" },
      { name: "newContent", required: false, desc: "新内容全文", type: "string" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]", type: "json", jsonType: "array" },
    ],
    modes: ["plan", "agent"],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, newContent: { type: "string" }, edits: { type: "json", jsonType: "array" } },
      required: ["path"],
      additionalProperties: true,
    },
  },
  {
    name: "doc.write",
    description: "写入文件（path, content）。新建可自动落盘；覆盖会走提案确认（Keep）。",
    args: [
      { name: "path", required: true, desc: "文件路径", type: "string" },
      { name: "content", required: true, desc: "文件全文内容", type: "string" },
    ],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: true },
  },
  {
    name: "doc.splitToDir",
    description: "将一个大文档按“标题/文案(正文)”块分割成多篇，并写入目标文件夹（proposal-first：Keep 才会真正写入；Undo 可回滚）。",
    args: [
      { name: "path", required: true, desc: "源文件路径（如 直男财经.md）", type: "string" },
      { name: "targetDir", required: true, desc: "目标目录（如 直男财经/）", type: "string" },
    ],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { path: { type: "string" }, targetDir: { type: "string" } }, required: ["path", "targetDir"], additionalProperties: true },
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选区内容。",
    args: [],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doc.replaceSelection",
    description: "替换当前选区为 text（可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本", type: "string" }],
    modes: ["plan", "agent"],
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
  },
  {
    name: "doc.applyEdits",
    description: "对指定文件应用一组 TextEdit（默认提案，Keep 才 apply）。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath）", type: "string" },
      { name: "edits", required: true, desc: "JSON 数组：TextEdit[]", type: "json", jsonType: "array" },
    ],
    modes: ["plan", "agent"],
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, edits: { type: "json", jsonType: "array" } },
      required: ["edits"],
      additionalProperties: true,
    },
  },
];

export function getToolsForMode(mode: ToolMode) {
  return TOOL_LIST.filter((t) => (t.modes?.length ? t.modes.includes(mode) : true));
}

export function toolsPrompt(mode: ToolMode) {
  const list = getToolsForMode(mode);
  if (!list.length) return "（当前模式不允许调用工具）\n";
  return list
    .map((t) => {
      const args = t.args.length ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n") : "- （无参数）";
      return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
    })
    .join("\n");
}

export function toolNamesForMode(mode: ToolMode) {
  return new Set(getToolsForMode(mode).map((t) => t.name));
}

export function getToolMeta(name: string): ToolMeta | null {
  const key = String(name ?? "").trim();
  if (!key) return null;
  return TOOL_LIST.find((t) => t.name === key) ?? null;
}

export type ToolArgValidationError = {
  code: string;
  message: string;
  field?: string;
};

export function validateToolCallArgs(args: { name: string; toolArgs: Record<string, string> }) {
  const meta = getToolMeta(args.name);
  if (!meta?.inputSchema) return { ok: true as const };

  const schema = meta.inputSchema;
  const rawArgs = args.toolArgs ?? {};

  const hasNonEmpty = (k: string) => {
    const v = rawArgs[k];
    return typeof v === "string" && String(v).trim().length > 0;
  };

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const k of required) {
    if (!hasNonEmpty(k)) {
      return { ok: false as const, error: { code: "MISSING_REQUIRED", message: `缺少必填参数：${k}`, field: k } satisfies ToolArgValidationError };
    }
  }

  const oneOf = Array.isArray(schema.oneOfRequired) ? schema.oneOfRequired : [];
  if (oneOf.length) {
    const ok = oneOf.some((g) => Array.isArray(g.required) && g.required.length && g.required.every((k) => hasNonEmpty(k)));
    if (!ok) {
      return {
        ok: false as const,
        error: {
          code: "ONE_OF_REQUIRED",
          message: `参数不满足二选一约束：${oneOf.map((g) => `[${g.required.join(", ")}]`).join(" 或 ")}`,
        } satisfies ToolArgValidationError,
      };
    }
  }

  for (const [k, v] of Object.entries(rawArgs)) {
    if (!schema.properties?.[k]) continue;
    const rule = schema.properties[k]!;
    const s = String(v ?? "");
    if (!s.trim()) continue;

    if (rule.type === "number") {
      const n = Number(s);
      if (!Number.isFinite(n)) return { ok: false as const, error: { code: "INVALID_NUMBER", message: `参数 ${k} 不是合法数字`, field: k } };
    } else if (rule.type === "boolean") {
      const t = s.trim().toLowerCase();
      const ok = t === "true" || t === "false" || t === "1" || t === "0";
      if (!ok) return { ok: false as const, error: { code: "INVALID_BOOLEAN", message: `参数 ${k} 不是合法布尔值(true/false)`, field: k } };
    } else if (rule.type === "json") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(s);
      } catch {
        return { ok: false as const, error: { code: "INVALID_JSON", message: `参数 ${k} 不是合法 JSON`, field: k } };
      }
      if (rule.jsonType === "array" && !Array.isArray(parsed)) {
        return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是 JSON 数组`, field: k } };
      }
      if (rule.jsonType === "object" && (parsed === null || Array.isArray(parsed) || typeof parsed !== "object")) {
        return { ok: false as const, error: { code: "JSON_TYPE_MISMATCH", message: `参数 ${k} 必须是 JSON 对象`, field: k } };
      }
    }
  }

  return { ok: true as const };
}









