import { create } from "zustand";

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

  undoable: boolean;
  undo?: () => void;
};

export type Step = AssistantStep | ToolBlockStep;

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
  resetRun: () => void;

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

export const useRunStore = create<RunState>((set, get) => ({
  mode: "plan",
  model: "mock",
  mainDoc: { goal: "" },
  steps: [],
  logs: [],
  isRunning: false,

  setMode: (mode) => set({ mode }),
  setModel: (model) => set({ model }),
  setRunning: (running) => set({ isRunning: running }),
  resetRun: () => set({ steps: [], logs: [], isRunning: false, mainDoc: { goal: "" } }),

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

  keepStep: (stepId) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === stepId && step.type === "tool" ? { ...step, kept: true } : step,
      ),
    })),
  undoStep: (stepId) => {
    const step = get().steps.find((s) => s.id === stepId);
    if (!step || step.type !== "tool") return;
    if (step.undoable && step.undo) step.undo();
    set((s) => ({
      steps: s.steps.map((x) =>
        x.id === stepId && x.type === "tool"
          ? { ...x, status: "undone", kept: false }
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
}));


