import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProjectSnapshot } from "./projectStore";

export type Mode = "plan" | "agent" | "chat";
export type ToolApplyPolicy = "proposal" | "auto_apply";
export type ToolRiskLevel = "low" | "medium" | "high";

export type MainDoc = {
  goal?: string;
  platformType?: "feed_preview" | "search_click" | "long_subscription";
  topic?: string;
  angle?: string;
  title?: string;
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

type RunState = {
  mode: Mode;
  model: string;
  mainDoc: MainDoc;
  steps: Step[];
  logs: LogEntry[];
  isRunning: boolean;

  setMode: (mode: Mode) => void;
  setModel: (model: string) => void;
  setMainDoc: (mainDoc: MainDoc) => void;
  resetRun: () => void;

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

  updateMainDoc: (patch: Partial<MainDoc>) => { undo: () => void };
  log: (level: LogEntry["level"], message: string, data?: unknown) => void;
  clearLogs: () => void;
  setRunning: (running: boolean) => void;
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export const useRunStore = create<RunState>()(
  persist(
    (set, get) => ({
  mode: "plan",
  model: "",
  mainDoc: { goal: "" },
  steps: [],
  logs: [],
  isRunning: false,

  setMode: (mode) => set({ mode }),
  setModel: (model) => set({ model }),
  setMainDoc: (mainDoc) => set({ mainDoc }),
  setRunning: (running) => set({ isRunning: running }),
  resetRun: () => set({ steps: [], logs: [], isRunning: false, mainDoc: { goal: "" } }),

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

  updateMainDoc: (patch) => {
    const prev = get().mainDoc;
    set({ mainDoc: { ...prev, ...patch } });
    return { undo: () => set({ mainDoc: prev }) };
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
      partialize: (s) => ({ mode: s.mode, model: s.model }),
    },
  ),
);


