import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode, type ToolApplyPolicy, type ToolRiskLevel } from "../state/runStore";

export type ToolArgSpec = {
  name: string;
  required?: boolean;
  desc: string;
};

export type ToolExecOk = {
  ok: true;
  output: unknown;
  // proposal-first：返回 apply 供 Keep 执行（apply 返回 undo 供 Undo 回滚）
  apply?: () => void | { undo?: () => void };
  undoable: boolean;
  undo?: () => void;
};

export type ToolExecErr = {
  ok: false;
  error: string;
  output?: unknown;
};

export type ToolExecResult = ToolExecOk | ToolExecErr;

export type ToolDefinition = {
  name: string;
  description: string;
  args: ToolArgSpec[];
  riskLevel: ToolRiskLevel;
  applyPolicy: ToolApplyPolicy;
  reversible: boolean;
  run: (args: Record<string, unknown>, ctx: { mode: Mode }) => Promise<ToolExecResult> | ToolExecResult;
};

function coerceValue(v: string): unknown {
  const raw = v;
  const s = v.trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 32) return Number(s);
  return raw;
}

function parseArgs(rawArgs: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs)) out[k] = coerceValue(v);
  return out;
}

const tools: ToolDefinition[] = [
  {
    name: "project.listFiles",
    description: "列出当前项目内存文件列表（path）。需要知道可用文件时使用。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const files = useProjectStore.getState().files.map((f) => ({ path: f.path }));
      return { ok: true, output: { ok: true, files }, undoable: false };
    },
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。写作风格/禁用项等约束在这里。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const file = useProjectStore.getState().getFileByPath("doc.rules.md");
      if (!file) return { ok: false, error: "DOC_RULES_NOT_FOUND" };
      return { ok: true, output: { ok: true, path: file.path, content: file.content }, undoable: false };
    },
  },
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const mainDoc = useRunStore.getState().mainDoc;
      return { ok: true, output: { ok: true, mainDoc }, undoable: false };
    },
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。仅写关键决策/约束，不要塞长文本。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const patch = args.patch;
      if (!patch || typeof patch !== "object") return { ok: false, error: "INVALID_PATCH" };
      const { undo } = useRunStore.getState().updateMainDoc(patch as any);
      const mainDoc = useRunStore.getState().mainDoc;
      return { ok: true, output: { ok: true, mainDoc }, undoable: true, undo };
    },
  },
  {
    name: "doc.read",
    description: "读取文件内容（path）。需要基于现有文稿/规则做改写时使用。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）" }],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const path = String(args.path ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const file = useProjectStore.getState().getFileByPath(path);
      if (!file) return { ok: false, error: "FILE_NOT_FOUND" };
      return { ok: true, output: { ok: true, path: file.path, content: file.content }, undoable: false };
    },
  },
  {
    name: "doc.write",
    description:
      "写入新文件（path, content）。仅允许创建新文件；不要覆盖已有文件（覆盖属于更高风险，后续再做 proposal+Keep）。",
    args: [
      { name: "path", required: true, desc: "新文件路径（如 drafts/run-xxx.md）" },
      { name: "content", required: true, desc: "文件全文内容" },
    ],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const exists = !!useProjectStore.getState().getFileByPath(path);
      if (exists) return { ok: false, error: "FILE_EXISTS" };
      const snap = useProjectStore.getState().snapshot();
      useProjectStore.getState().createFile(path, content);
      const undo = () => useProjectStore.getState().restore(snap);
      return { ok: true, output: { ok: true, path }, undoable: true, undo };
    },
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选中内容（用于段落改写/润色）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      if (!ed) return { ok: false, error: "NO_EDITOR" };
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel) return { ok: false, error: "NO_SELECTION" };
      const selectedText = model.getValueInRange(sel);
      return {
        ok: true,
        output: {
          ok: true,
          path: s.activePath,
          selectedText,
          hasSelection: selectedText.length > 0,
          range: {
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: sel.endLineNumber,
            endColumn: sel.endColumn,
          },
        },
        undoable: false,
      };
    },
  },
  {
    name: "doc.replaceSelection",
    description: "用 text 替换当前选区（低风险自动落盘，可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const text = String(args.text ?? "");
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      if (!ed) return { ok: false, error: "NO_EDITOR" };
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel) return { ok: false, error: "NO_SELECTION" };
      const before = model.getValueInRange(sel);
      if (!before) return { ok: false, error: "EMPTY_SELECTION" };

      const snap = s.snapshot();
      ed.executeEdits("agent", [{ range: sel, text, forceMoveMarkers: true }]);
      // 确保项目 store 与 Monaco 模型一致（避免 onChange 没触发导致回弹）
      const next = ed.getModel()?.getValue() ?? "";
      useProjectStore.getState().updateFile(s.activePath, next);
      const undo = () => useProjectStore.getState().restore(snap);

      return {
        ok: true,
        output: { ok: true, replacedChars: before.length, newChars: text.length },
        undoable: true,
        undo,
      };
    },
  },
  {
    name: "doc.applyEdits",
    description:
      "对当前活动文件应用一组文本编辑（edits）。默认先生成预览（proposal-first），点击 Keep 才真正写入；Undo 可回滚。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath；MVP 仅支持 activePath）" },
      {
        name: "edits",
        required: true,
        desc:
          'JSON 数组：[{ startLineNumber, startColumn, endLineNumber, endColumn, text }...]（基于 Monaco range）',
      },
    ],
    riskLevel: "medium",
    applyPolicy: "proposal",
    reversible: true,
    run: async (args) => {
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      if (!ed) return { ok: false, error: "NO_EDITOR" };
      const model = ed.getModel();
      if (!model) return { ok: false, error: "NO_MODEL" };

      const path = String(args.path ?? s.activePath ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      if (path !== s.activePath) return { ok: false, error: "ONLY_ACTIVE_FILE_SUPPORTED" };

      const edits = args.edits as any;
      if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "EMPTY_EDITS" };

      type One = {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
        text: string;
      };
      const normalized: One[] = [];
      for (const e of edits) {
        const sl = Number(e?.startLineNumber);
        const sc = Number(e?.startColumn);
        const el = Number(e?.endLineNumber);
        const ec = Number(e?.endColumn);
        const text = String(e?.text ?? "");
        if (![sl, sc, el, ec].every((n) => Number.isFinite(n) && n > 0)) {
          return { ok: false, error: "INVALID_RANGE" };
        }
        normalized.push({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec, text });
      }

      // 预览：用 offset 在纯字符串上应用（倒序，避免偏移）
      const before = model.getValue();
      const ranges = normalized
        .map((e) => {
          const startOffset = model.getOffsetAt({ lineNumber: e.startLineNumber, column: e.startColumn });
          const endOffset = model.getOffsetAt({ lineNumber: e.endLineNumber, column: e.endColumn });
          return { ...e, startOffset, endOffset };
        })
        .sort((a, b) => b.startOffset - a.startOffset);

      let after = before;
      for (const r of ranges) {
        after = after.slice(0, r.startOffset) + r.text + after.slice(r.endOffset);
      }

      const first = ranges[ranges.length - 1];
      const ctx = 400;
      const start = Math.max(0, first.startOffset - ctx);
      const end = Math.min(before.length, first.endOffset + ctx);
      const beforeExcerpt = before.slice(start, end);
      const afterExcerpt = after.slice(start, Math.min(after.length, start + (end - start)));

      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        ed.executeEdits(
          "agent",
          normalized.map((e) => ({
            range: {
              startLineNumber: e.startLineNumber,
              startColumn: e.startColumn,
              endLineNumber: e.endLineNumber,
              endColumn: e.endColumn,
            },
            text: e.text,
            forceMoveMarkers: true,
          })),
        );
        const next = ed.getModel()?.getValue() ?? "";
        useProjectStore.getState().updateFile(path, next);
        return { undo: () => useProjectStore.getState().restore(snap) };
      };

      return {
        ok: true,
        output: {
          ok: true,
          path,
          editsCount: normalized.length,
          preview: {
            note: "这是修改提案。点击 Keep 才会应用到编辑器；Undo 可回滚。",
            beforeExcerpt,
            afterExcerpt,
          },
        },
        apply,
        undoable: false,
      };
    },
  },
];

export function listTools() {
  return tools;
}

export function getTool(name: string) {
  return tools.find((t) => t.name === name);
}

export function toolsPrompt() {
  const lines = tools.map((t) => {
    const args = t.args.length
      ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n")
      : "- （无参数）";
    return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
  });
  return lines.join("\n");
}

export async function executeToolCall(args: {
  toolName: string;
  rawArgs: Record<string, string>;
  mode: Mode;
}): Promise<{
  def?: ToolDefinition;
  parsedArgs: Record<string, unknown>;
  result: ToolExecResult;
}> {
  const def = getTool(args.toolName);
  const parsedArgs = parseArgs(args.rawArgs);
  if (!def) {
    return { parsedArgs, result: { ok: false, error: "UNKNOWN_TOOL" } };
  }

  // required check
  for (const a of def.args) {
    if (!a.required) continue;
    if (parsedArgs[a.name] === undefined || parsedArgs[a.name] === null || String(parsedArgs[a.name]).length === 0) {
      return { def, parsedArgs, result: { ok: false, error: `MISSING_ARG:${a.name}` } };
    }
  }

  try {
    const result = await def.run(parsedArgs, { mode: args.mode });
    return { def, parsedArgs, result };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { def, parsedArgs, result: { ok: false, error: msg } };
  }
}


