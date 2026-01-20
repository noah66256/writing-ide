import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProjectSnapshot } from "./projectStore";

export type Mode = "plan" | "agent" | "chat";
export type ToolApplyPolicy = "proposal" | "auto_apply";
export type ToolRiskLevel = "low" | "medium" | "high";

export type CtxRefItem = { kind: "file" | "dir"; path: string };

export type MainDoc = {
  goal?: string;
  // 结构化意图（优先于正则启发式；用于后端门禁/skills 自动启用）
  runIntent?: "auto" | "writing" | "rewrite" | "polish" | "analysis" | "ops";
  platformType?: "feed_preview" | "search_click" | "long_subscription";
  audience?: string;
  persona?: string;
  tone?: string;
  sourcesPolicy?: "user_only" | "kb" | "web" | "kb_and_web";
  topic?: string;
  angle?: string;
  title?: string;
  outline?: string;
  // 风格 Lint 未通过时的策略（用于 Context Pack 注入与后端行为）
  styleLintFailPolicy?: "ask_user" | "keep_best" | "skip";
  // M3：风格契约（由“写法候选/anchors/默认写法”生成；跨回合注入，作为仿写的硬约束地基）
  // 说明：保持短小可验证，不要塞长原文。
  styleContractV1?: any;
};

export type TodoStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
};

export type UserStep = {
  id: string;
  type: "user";
  text: string;
  ts: number;
  edited?: boolean;
  // 用于“从历史消息提交”时回滚（文件 + 主文档）
  baseline?: {
    project: ProjectSnapshot;
    mainDoc: MainDoc;
    todoList: TodoItem[];
    ctxRefs?: CtxRefItem[];
  };
};

export type AssistantStep = {
  id: string;
  type: "assistant";
  text: string;
  streaming?: boolean;
  hidden?: boolean;
};

export type ToolBlockStep = {
  id: string;
  type: "tool";
  toolName: string;
  status: "running" | "success" | "failed" | "undone";
  input?: unknown;
  output?: unknown;
  riskLevel: ToolRiskLevel;
  applyPolicy: ToolApplyPolicy;

  kept: boolean;
  applied: boolean;

  // proposal-first：Keep 时执行 apply（如存在），再标记 applied/undoable
  apply?: () => void | { undo?: () => void };

  undoable: boolean;
  undo?: () => void;
};

export type Step = UserStep | AssistantStep | ToolBlockStep;

export type LogEntry = {
  id: string;
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
};

export type RunActivity = {
  text: string;
  startedAt: number; // 用于 UI 显示耗时
};

type RunState = {
  mode: Mode;
  /** Chat 模式选中的模型（可与 Agent/Plan 分开记忆） */
  chatModel: string;
  /** Plan/Agent 模式选中的模型（共用） */
  agentModel: string;
  model: string;
  /** 对话滚动摘要（按 mode 存储；用于长对话上下文压缩） */
  dialogueSummaryByMode: Record<Mode, string>;
  /** 已纳入摘要的“完整回合数”（turn cursor），用于增量滚动 */
  dialogueSummaryTurnCursorByMode: Record<Mode, number>;

  mainDoc: MainDoc;
  todoList: TodoItem[];
  steps: Step[];
  logs: LogEntry[];
  isRunning: boolean;
  activity: RunActivity | null;

  // KB：右侧 Agent 关联的库（多选；持久化，便于常用库默认保持关联）
  kbAttachedLibraryIds: string[];
  setKbAttachedLibraries: (ids: string[]) => void;
  toggleKbAttachedLibrary: (id: string) => void;
  clearKbAttachedLibraries: () => void;

  // Context：常驻“引用文件/目录”列表（用于构建 REFERENCES；不随输入框清空而丢失）
  ctxRefs: CtxRefItem[];
  setCtxRefs: (items: CtxRefItem[]) => void;
  addCtxRef: (item: CtxRefItem) => void;
  removeCtxRef: (item: CtxRefItem) => void;
  clearCtxRefs: () => void;

  setMode: (mode: Mode) => void;
  setModel: (model: string) => void;
  setModelForMode: (mode: "chat" | "agent", model: string) => void;
  setDialogueSummary: (mode: Mode, summary: string, cursorTurns: number) => void;
  setMainDoc: (mainDoc: MainDoc) => void;
  resetRun: () => void;
  // 会话/历史：加载一段历史快照到当前 Run（用于“对话历史/切换”）
  loadSnapshot: (snap: {
    mode: Mode;
    model: string;
    mainDoc: MainDoc;
    todoList: TodoItem[];
    steps: Array<Step | Omit<ToolBlockStep, "apply" | "undo">>;
    logs: LogEntry[];
    kbAttachedLibraryIds: string[];
    ctxRefs?: CtxRefItem[];
  }) => void;

  addUser: (text: string, baseline?: UserStep["baseline"]) => string;
  patchUser: (stepId: string, patch: Partial<UserStep>) => void;
  truncateAfter: (stepId: string) => void; // 保留 stepId（包含它），清除其后
  truncateFrom: (stepId: string) => void; // 清除 stepId（包含它）及其后

  addAssistant: (initialText?: string, streaming?: boolean, hidden?: boolean) => string;
  appendAssistantDelta: (stepId: string, delta: string) => void;
  finishAssistant: (stepId: string) => void;
  patchAssistant: (stepId: string, patch: Partial<AssistantStep>) => void;

  addTool: (
    tool: Omit<ToolBlockStep, "id" | "type" | "kept" | "applied"> & {
      id?: string;
      applied?: boolean;
      kept?: boolean;
    },
  ) => string;
  patchTool: (stepId: string, patch: Partial<ToolBlockStep>) => void;

  keepStep: (stepId: string) => void;
  undoStep: (stepId: string) => void;
  keepAllProposals: () => void;

  updateMainDoc: (patch: Partial<MainDoc>) => { undo: () => void };
  setTodoList: (items: TodoItem[]) => { undo: () => void };
  updateTodo: (id: string, patch: Partial<TodoItem>) => { undo: () => void };
  log: (level: LogEntry["level"], message: string, data?: unknown) => void;
  clearLogs: () => void;
  setRunning: (running: boolean) => void;
  setActivity: (text: string | null, opts?: { resetTimer?: boolean }) => void;
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeRefPath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+$/g, ""); // 统一不带末尾 /
  return s;
}

function normalizeCtxRef(item: CtxRefItem | null | undefined): CtxRefItem | null {
  const it = item && typeof item === "object" ? item : null;
  const kind = it?.kind === "dir" ? "dir" : "file";
  const path = normalizeRefPath(String((it as any)?.path ?? ""));
  if (!path) return null;
  return { kind, path };
}

function dedupeCtxRefs(items: CtxRefItem[]) {
  const seen = new Set<string>();
  const out: CtxRefItem[] = [];
  for (const it of items ?? []) {
    const norm = normalizeCtxRef(it);
    if (!norm) continue;
    const key = `${norm.kind}:${norm.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

export const useRunStore = create<RunState>()(
  persist(
    (set, get) => ({
  mode: "plan",
  chatModel: "",
  agentModel: "",
  model: "",
  dialogueSummaryByMode: { plan: "", agent: "", chat: "" },
  dialogueSummaryTurnCursorByMode: { plan: 0, agent: 0, chat: 0 },
  mainDoc: { goal: "" },
  todoList: [],
  steps: [],
  logs: [],
  isRunning: false,
  activity: null,
  ctxRefs: [],
  kbAttachedLibraryIds: [],

  setMode: (mode) =>
    set((s) => {
      const nextModel = mode === "chat" ? s.chatModel || s.model : s.agentModel || s.model;
      return { mode, model: nextModel };
    }),
  setModel: (model) =>
    set((s) => {
      const v = String(model ?? "").trim();
      if (s.mode === "chat") return { model: v, chatModel: v };
      return { model: v, agentModel: v };
    }),
  setModelForMode: (modeKey, model) =>
    set((s) => {
      const v = String(model ?? "").trim();
      if (modeKey === "chat") return { chatModel: v, ...(s.mode === "chat" ? { model: v } : {}) };
      return { agentModel: v, ...(s.mode !== "chat" ? { model: v } : {}) };
    }),
  setMainDoc: (mainDoc) => set({ mainDoc }),
  setDialogueSummary: (mode, summary, cursorTurns) =>
    set((s) => {
      const m: Mode = mode === "chat" ? "chat" : mode === "agent" ? "agent" : "plan";
      const nextSummary = String(summary ?? "");
      const nextCursor = Number.isFinite(Number(cursorTurns)) ? Math.max(0, Math.floor(Number(cursorTurns))) : 0;
      return {
        dialogueSummaryByMode: { ...s.dialogueSummaryByMode, [m]: nextSummary },
        dialogueSummaryTurnCursorByMode: { ...s.dialogueSummaryTurnCursorByMode, [m]: nextCursor },
      };
    }),
  setRunning: (running) =>
    set((s) => ({
      isRunning: running,
      // run 结束/停止时，清空 activity，避免残留“像卡死”
      activity: running ? s.activity : null,
    })),
  setActivity: (text, opts) =>
    set((s) => {
      const t = text ? String(text).trim() : "";
      if (!t) return { activity: null };
      const prev = s.activity;
      const same = prev && prev.text === t;
      const resetTimer = Boolean(opts?.resetTimer);
      return {
        activity: {
          text: t,
          startedAt: same && !resetTimer ? prev!.startedAt : Date.now(),
        },
      };
    }),
  resetRun: () =>
    set({
      steps: [],
      logs: [],
      isRunning: false,
      activity: null,
      mainDoc: { goal: "" },
      todoList: [],
      ctxRefs: [],
      dialogueSummaryByMode: { plan: "", agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode: { plan: 0, agent: 0, chat: 0 },
    }),
  loadSnapshot: (snap) => {
    const s = snap && typeof snap === "object" ? snap : ({} as any);
    const cleanSteps = Array.isArray(s.steps) ? s.steps : [];
    // 历史快照不携带可执行函数，统一清掉 apply/undo，并标记 undoable=false。
    // 同时做“契约修复”：确保 steps[].id 唯一（旧版本可能把 toolCallId=1/2/3… 当作 step.id，跨回合会重复，触发 wx:key 警告）。
    const seenIds = new Set<string>();
    const normalized: Step[] = cleanSteps.map((step: any) => {
      if (!step || typeof step !== "object") return step as any;
      const type0 = String((step as any).type ?? "");
      const prefix = type0 === "user" ? "u" : type0 === "assistant" ? "a" : type0 === "tool" ? "t" : "s";
      let id = typeof (step as any).id === "string" ? String((step as any).id) : "";
      if (!id || seenIds.has(id)) {
        let next = makeId(prefix);
        while (seenIds.has(next)) next = makeId(prefix);
        id = next;
      }
      seenIds.add(id);

      if (type0 === "tool") {
        const t = step as any;
        return {
          ...t,
          id,
          apply: undefined,
          undo: undefined,
          undoable: false,
        } as ToolBlockStep;
      }
      return { ...(step as any), id } as Step;
    });
    const mode = s.mode === "plan" || s.mode === "agent" || s.mode === "chat" ? s.mode : get().mode;
    const model = typeof s.model === "string" ? s.model : get().model;
    const prev = get();
    const chatModel = mode === "chat" ? model : prev.chatModel;
    const agentModel = mode !== "chat" ? model : prev.agentModel;
    const ds = (s as any).dialogueSummaryByMode;
    const dc = (s as any).dialogueSummaryTurnCursorByMode;
    set({
      mode,
      model,
      chatModel,
      agentModel,
      dialogueSummaryByMode:
        ds && typeof ds === "object"
          ? {
              plan: String((ds as any).plan ?? ""),
              agent: String((ds as any).agent ?? ""),
              chat: String((ds as any).chat ?? ""),
            }
          : { plan: "", agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode:
        dc && typeof dc === "object"
          ? {
              plan: Number.isFinite(Number((dc as any).plan)) ? Math.max(0, Math.floor(Number((dc as any).plan))) : 0,
              agent: Number.isFinite(Number((dc as any).agent)) ? Math.max(0, Math.floor(Number((dc as any).agent))) : 0,
              chat: Number.isFinite(Number((dc as any).chat)) ? Math.max(0, Math.floor(Number((dc as any).chat))) : 0,
            }
          : { plan: 0, agent: 0, chat: 0 },
      mainDoc: (s.mainDoc && typeof s.mainDoc === "object" ? s.mainDoc : get().mainDoc) as MainDoc,
      todoList: Array.isArray(s.todoList) ? (s.todoList as TodoItem[]) : [],
      steps: normalized,
      logs: Array.isArray(s.logs) ? (s.logs as LogEntry[]) : [],
      kbAttachedLibraryIds: Array.isArray(s.kbAttachedLibraryIds)
        ? (s.kbAttachedLibraryIds as string[]).map((x) => String(x ?? "").trim()).filter(Boolean)
        : get().kbAttachedLibraryIds,
      ctxRefs: Array.isArray((s as any).ctxRefs) ? dedupeCtxRefs((s as any).ctxRefs as any) : [],
      isRunning: false,
      activity: null,
    });
  },

  setKbAttachedLibraries: (ids) => {
    const unique = Array.from(new Set((ids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
    set({ kbAttachedLibraryIds: unique });
  },
  toggleKbAttachedLibrary: (id) => {
    const v = String(id ?? "").trim();
    if (!v) return;
    const cur = get().kbAttachedLibraryIds ?? [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    set({ kbAttachedLibraryIds: next });
  },
  clearKbAttachedLibraries: () => set({ kbAttachedLibraryIds: [] }),

  setCtxRefs: (items) => set({ ctxRefs: dedupeCtxRefs(Array.isArray(items) ? items : []) }),
  addCtxRef: (item) =>
    set((s) => {
      const norm = normalizeCtxRef(item);
      if (!norm) return {};
      const cur = Array.isArray(s.ctxRefs) ? s.ctxRefs : [];
      const exists = cur.some((x) => x.kind === norm.kind && x.path === norm.path);
      if (exists) return {};
      return { ctxRefs: [...cur, norm] };
    }),
  removeCtxRef: (item) =>
    set((s) => {
      const norm = normalizeCtxRef(item);
      if (!norm) return {};
      const cur = Array.isArray(s.ctxRefs) ? s.ctxRefs : [];
      return { ctxRefs: cur.filter((x) => !(x.kind === norm.kind && x.path === norm.path)) };
    }),
  clearCtxRefs: () => set({ ctxRefs: [] }),

  addUser: (text, baseline) => {
    const id = makeId("u");
    const step: UserStep = { id, type: "user", text, ts: Date.now(), baseline };
    set((s) => ({ steps: [...s.steps, step] }));
    return id;
  },
  patchUser: (stepId, patch) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "user" ? { ...step, ...patch } : step,
      ),
    })),
  truncateAfter: (stepId) =>
    set((s) => {
      const idx = s.steps.findIndex((x) => x.id === stepId);
      if (idx < 0) return {};
      return { steps: s.steps.slice(0, idx + 1) };
    }),
  truncateFrom: (stepId) =>
    set((s) => {
      const idx = s.steps.findIndex((x) => x.id === stepId);
      if (idx < 0) return {};
      return { steps: s.steps.slice(0, idx) };
    }),

  addAssistant: (initialText = "", streaming = false, hidden = false) => {
    const id = makeId("a");
    set((s) => ({
      steps: [...s.steps, { id, type: "assistant", text: initialText, streaming, hidden }],
    }));
    return id;
  },
  appendAssistantDelta: (stepId, delta) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "assistant"
          ? { ...step, text: step.text + delta }
          : step,
      ),
    })),
  finishAssistant: (stepId) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "assistant"
          ? { ...step, streaming: false }
          : step,
      ),
    })),
  patchAssistant: (stepId, patch) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "assistant" ? { ...step, ...patch } : step,
      ),
    })),

  addTool: (tool) => {
    const id = tool.id ?? makeId("t");
    const step: ToolBlockStep = {
      id,
      type: "tool",
      toolName: tool.toolName,
      status: tool.status,
      input: tool.input,
      output: tool.output,
      riskLevel: tool.riskLevel,
      applyPolicy: tool.applyPolicy,
      kept: tool.kept ?? false,
      applied: tool.applied ?? tool.applyPolicy === "auto_apply",
      apply: tool.apply,
      undoable: tool.undoable,
      undo: tool.undo,
    };
    set((s) => ({ steps: [...s.steps, step] }));
    return id;
  },
  patchTool: (stepId, patch) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "tool" ? { ...step, ...patch } : step,
      ),
    })),

  keepStep: (stepId) => {
    const step = get().steps.find((s) => s.id === stepId);
    if (!step || step.type !== "tool") return;
    if (step.status === "running" || step.status === "undone" || step.kept) return;

    // proposal-first：Keep 时执行 apply（并补齐 undo）
    if (step.applyPolicy === "proposal" && !step.applied && step.apply) {
      try {
        const ret = step.apply();
        const undo = (ret as any)?.undo as (() => void) | undefined;
        set((s) => ({
          steps: s.steps.map((x) =>
            x.id === stepId && x.type === "tool"
              ? {
                  ...x,
                  kept: true,
                  applied: true,
                  undoable: Boolean(undo) || x.undoable,
                  undo: undo ?? x.undo,
                }
              : x,
          ),
        }));
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        set((s) => ({
          steps: s.steps.map((x) =>
            x.id === stepId && x.type === "tool"
              ? { ...x, status: "failed", output: { ok: false, error: msg } }
              : x,
          ),
        }));
      }
      return;
    }

    // 默认：仅采纳进入上下文
    set((s) => ({
      steps: s.steps.map((x) => (x.id === stepId && x.type === "tool" ? { ...x, kept: true } : x)),
    }));
  },
  undoStep: (stepId) => {
    const step = get().steps.find((s) => s.id === stepId);
    if (!step || step.type !== "tool") return;
    if (step.undoable && step.undo) step.undo();
    set((s) => ({
      steps: s.steps.map((x) =>
        x.id === stepId && x.type === "tool"
          ? { ...x, status: "undone", kept: false, applied: false }
          : x,
      ),
    }));
  },
  keepAllProposals: () => {
    const steps = get().steps ?? [];
    const pending = steps
      .filter((s: any) => s && s.type === "tool")
      .filter((s: any) => s.applyPolicy === "proposal" && s.status === "success" && !s.kept)
      .filter((s: any) => typeof s.apply === "function"); // 只处理“真的需要 Keep 才会应用”的提案
    for (const st of pending) {
      try {
        get().keepStep(String((st as any).id ?? ""));
      } catch {
        // ignore：单个提案失败不应影响其它提案
      }
    }
  },

  updateMainDoc: (patch) => {
    const prev = get().mainDoc;
    set({ mainDoc: { ...prev, ...patch } });
    return { undo: () => set({ mainDoc: prev }) };
  },

  setTodoList: (items) => {
    const prev = get().todoList;
    set({ todoList: Array.isArray(items) ? items : [] });
    return { undo: () => set({ todoList: prev }) };
  },

  updateTodo: (id, patch) => {
    const prev = get().todoList;
    const idx = prev.findIndex((t) => t.id === id);
    if (idx < 0) return { undo: () => void 0 };
    const next = prev.map((t) => (t.id === id ? { ...t, ...patch, id: t.id } : t));
    set({ todoList: next });
    return { undo: () => set({ todoList: prev }) };
  },

  log: (level, message, data) => {
    const entry: LogEntry = {
      id: makeId("log"),
      ts: Date.now(),
      level,
      message,
      data
    };
    set((s) => {
      const next = [...s.logs, entry];
      // cap，避免长时间测试占用内存
      const capped = next.length > 500 ? next.slice(next.length - 500) : next;
      return { logs: capped };
    });
  },
  clearLogs: () => set({ logs: [] })
}),
    {
      name: "writing-ide.runprefs.v1",
      partialize: (s) => ({
        mode: s.mode,
        model: s.model,
        chatModel: s.chatModel,
        agentModel: s.agentModel,
        kbAttachedLibraryIds: s.kbAttachedLibraryIds,
      }),
    },
  ),
);


