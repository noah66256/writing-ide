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
  // 允许运行时覆盖 tool 元数据（用于“同名工具在不同场景下风险/策略不同”）
  riskLevel?: ToolRiskLevel;
  applyPolicy?: ToolApplyPolicy;
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

function computeLineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function getOffsetAt(text: string, lineStarts: number[], lineNumber: number, column: number) {
  const ln = Math.max(1, Math.floor(lineNumber));
  const col = Math.max(1, Math.floor(column));
  const lineIdx = ln - 1;
  const lineStart = lineStarts[lineIdx] ?? text.length;
  const nextLineStart = lineStarts[lineIdx + 1] ?? text.length;
  const lineEnd = nextLineStart > 0 ? Math.max(lineStart, nextLineStart - 1) : lineStart;
  const maxCol0 = Math.max(0, lineEnd - lineStart);
  const col0 = Math.min(maxCol0, col - 1);
  return Math.min(text.length, lineStart + col0);
}

function applyTextEdits(args: {
  before: string;
  edits: Array<{
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    text: string;
  }>;
}) {
  const before = args.before;
  const lineStarts = computeLineStarts(before);
  const ranges = args.edits
    .map((e) => {
      const startOffset = getOffsetAt(before, lineStarts, e.startLineNumber, e.startColumn);
      const endOffset = getOffsetAt(before, lineStarts, e.endLineNumber, e.endColumn);
      return { ...e, startOffset, endOffset };
    })
    .sort((a, b) => b.startOffset - a.startOffset);

  let after = before;
  for (const r of ranges) {
    after = after.slice(0, r.startOffset) + r.text + after.slice(r.endOffset);
  }
  return { after };
}

function unifiedDiff(args: { path: string; before: string; after: string; context?: number; maxCells?: number; maxHunkLines?: number }) {
  const beforeLines = args.before.split("\n");
  const afterLines = args.after.split("\n");
  const n = beforeLines.length;
  const m = afterLines.length;

  const maxCells = args.maxCells ?? 900_000; // 约 900k cells（避免大文件卡死）
  if (n * m > maxCells) {
    return {
      truncated: true,
      diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(文件过大：diff 预览已跳过。建议先缩小改动范围或仅显示片段预览)\n`,
    };
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    const ai = beforeLines[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j += 1) {
      if (ai === afterLines[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = Math.max(prev[j], row[j - 1]);
    }
  }

  type Op = { type: " " | "+" | "-"; line: string; oldLine: number | null; newLine: number | null };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  let oldNo = n;
  let newNo = m;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      ops.push({ type: " ", line: beforeLines[i - 1], oldLine: oldNo, newLine: newNo });
      i -= 1;
      j -= 1;
      oldNo -= 1;
      newNo -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
      i -= 1;
      oldNo -= 1;
    } else {
      ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
      j -= 1;
      newNo -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
    i -= 1;
    oldNo -= 1;
  }
  while (j > 0) {
    ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
    j -= 1;
    newNo -= 1;
  }
  ops.reverse();

  // 重新赋正向行号（更易算 hunk 头）
  let o = 1;
  let nn = 1;
  const seq: Op[] = ops.map((x) => {
    const out: Op = { ...x, oldLine: null, newLine: null };
    if (x.type !== "+") out.oldLine = o;
    if (x.type !== "-") out.newLine = nn;
    if (x.type !== "+") o += 1;
    if (x.type !== "-") nn += 1;
    return out;
  });

  const context = args.context ?? 3;
  const changeIdx: number[] = [];
  for (let k = 0; k < seq.length; k += 1) if (seq[k].type !== " ") changeIdx.push(k);
  if (!changeIdx.length) {
    return {
      truncated: false,
      diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(无差异)\n`,
    };
  }

  const hunks: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos < changeIdx.length) {
    const first = changeIdx[pos];
    let start = Math.max(0, first - context);
    let end = Math.min(seq.length, first + context + 1);
    let last = first;
    while (true) {
      pos += 1;
      const next = changeIdx[pos];
      if (next === undefined) break;
      if (next <= end + context) {
        end = Math.min(seq.length, next + context + 1);
        last = next;
        continue;
      }
      // 不合并
      break;
    }
    hunks.push({ start, end });
  }

  let added = 0;
  let removed = 0;
  const maxHunkLines = args.maxHunkLines ?? 320;
  let outLines: string[] = [`--- a/${args.path}`, `+++ b/${args.path}`];
  let emitted = 0;

  for (const h of hunks) {
    const slice = seq.slice(h.start, h.end);
    const oldStart = slice.find((x) => x.oldLine !== null)?.oldLine ?? 1;
    const newStart = slice.find((x) => x.newLine !== null)?.newLine ?? 1;
    const oldCount = slice.filter((x) => x.type !== "+").length;
    const newCount = slice.filter((x) => x.type !== "-").length;
    outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const x of slice) {
      if (emitted >= maxHunkLines) {
        outLines.push("...(diff 已截断)");
        return { truncated: true, diff: outLines.join("\n") + "\n", stats: { added, removed } };
      }
      if (x.type === "+") added += 1;
      if (x.type === "-") removed += 1;
      outLines.push(`${x.type}${x.line}`);
      emitted += 1;
    }
  }

  return { truncated: false, diff: outLines.join("\n") + "\n", stats: { added, removed } };
}

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
    name: "doc.previewDiff",
    description:
      "生成 diff 预览（无副作用）。可以传入 newContent 或 edits；系统会和当前文件内容比较并返回 unified diff 文本。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "newContent", required: false, desc: "新内容全文（JSON 字符串）" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]（同 doc.applyEdits）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const path = String(args.path ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const file = useProjectStore.getState().getFileByPath(path);
      if (!file) return { ok: false, error: "FILE_NOT_FOUND" };
      const before = file.content ?? "";
      const newContent = typeof args.newContent === "string" ? String(args.newContent) : undefined;
      const edits = args.edits as any;
      let after = newContent ?? before;
      if (!newContent && Array.isArray(edits) && edits.length) {
        const norm = edits.map((e: any) => ({
          startLineNumber: Number(e?.startLineNumber),
          startColumn: Number(e?.startColumn),
          endLineNumber: Number(e?.endLineNumber),
          endColumn: Number(e?.endColumn),
          text: String(e?.text ?? ""),
        }));
        after = applyTextEdits({ before, edits: norm }).after;
      }
      const d = unifiedDiff({ path, before, after });
      return {
        ok: true,
        output: {
          ok: true,
          path,
          diffUnified: d.diff,
          truncated: d.truncated,
          stats: d.stats ?? null,
        },
        undoable: false,
      };
    },
  },
  {
    name: "doc.write",
    description:
      "写入文件（path, content）。新建可自动落盘；覆盖已有文件会走 proposal-first（Keep 才覆盖，Undo 可回滚）。",
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
      if (!exists) {
        const snap = useProjectStore.getState().snapshot();
        useProjectStore.getState().createFile(path, content);
        const undo = () => useProjectStore.getState().restore(snap);
        const d = unifiedDiff({ path, before: "", after: content, maxCells: 400_000 });
        return {
          ok: true,
          output: { ok: true, path, created: true, diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null },
          applyPolicy: "auto_apply",
          riskLevel: "low",
          undoable: true,
          undo,
        };
      }

      // 覆盖：proposal-first
      const prev = useProjectStore.getState().getFileByPath(path)?.content ?? "";
      const d = unifiedDiff({ path, before: prev, after: content });
      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        const s = useProjectStore.getState();
        if (s.activePath === path && s.editorRef?.getModel()) {
          const model = s.editorRef.getModel()!;
          const full = model.getFullModelRange();
          s.editorRef.executeEdits("agent", [{ range: full, text: content, forceMoveMarkers: true }]);
          const next = s.editorRef.getModel()?.getValue() ?? content;
          useProjectStore.getState().updateFile(path, next);
        } else {
          useProjectStore.getState().updateFile(path, content);
        }
        return { undo: () => useProjectStore.getState().restore(snap) };
      };

      return {
        ok: true,
        output: {
          ok: true,
          path,
          created: false,
          preview: { note: "覆盖写入为提案：点击 Keep 才会覆盖文件；Undo 可回滚。", diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null },
        },
        applyPolicy: "proposal",
        riskLevel: "medium",
        apply,
        undoable: false,
      };
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
      const path = String(args.path ?? s.activePath ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const file = s.getFileByPath(path);
      if (!file) return { ok: false, error: "FILE_NOT_FOUND" };

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

      const before = file.content ?? "";
      const { after } = applyTextEdits({ before, edits: normalized });
      const d = unifiedDiff({ path, before, after });

      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        const st = useProjectStore.getState();
        // 如果目标文件正是当前活动文件且 editor 可用，优先用 Monaco 应用（保光标/markers）
        if (st.activePath === path && st.editorRef?.getModel()) {
          st.editorRef.executeEdits(
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
          const next = st.editorRef.getModel()?.getValue() ?? after;
          useProjectStore.getState().updateFile(path, next);
        } else {
          // 非活动文件：直接更新 store 内容
          useProjectStore.getState().updateFile(path, after);
        }
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
            diffUnified: d.diff,
            truncated: d.truncated,
            stats: d.stats ?? null,
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


