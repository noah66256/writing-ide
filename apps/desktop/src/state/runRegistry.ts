/**
 * runRegistry —— 多任务并发执行的注册表
 *
 * 按 convId 维护后台任务的运行状态和步骤缓冲。
 * useRunStore（flat singleton）始终代表当前 active 对话的实时显示；
 * useRunRegistry 负责存储其余后台 run 的 isRunning 状态和 steps buffer。
 *
 * 不持久化 — 重启后后台 run 的 buffer 不需要恢复。
 */

import { create } from "zustand";
import type { CtxRefItem, LogEntry, MainDoc, RunActivity, Step, TodoItem } from "./runStore";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type RunBuffer = {
  steps: Step[];
  logs: LogEntry[];
  mainDoc: MainDoc;
  todoList: TodoItem[];
  ctxRefs: CtxRefItem[];
  activity: RunActivity | null;
};

export type ConvRunEntry = {
  /** run 是否仍在执行 */
  isRunning: boolean;
  /** run 完成时的时间戳（用于 30s 后消隐 ✓ 标记） */
  completedAt: number | null;
  /** 后台执行期间的步骤缓冲 */
  buffer: RunBuffer;
};

type RunRegistryState = {
  runs: Record<string, ConvRunEntry>;
  /** 初始化（或重置）某对话的 entry，可选地以 seed 填充 buffer */
  start: (convId: string, seed?: Partial<RunBuffer>) => void;
  setRunning: (convId: string, running: boolean) => void;
  setCompletedAt: (convId: string, completedAt: number | null) => void;
  addStep: (convId: string, step: Step) => void;
  patchStep: (convId: string, stepId: string, patch: Partial<Step>) => void;
  updateBuffer: (convId: string, patch: Partial<RunBuffer>) => void;
  remove: (convId: string) => void;
};

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function emptyBuffer(): RunBuffer {
  return {
    steps: [],
    logs: [],
    mainDoc: {},
    todoList: [],
    ctxRefs: [],
    activity: null,
  };
}

function cloneBuffer(seed?: Partial<RunBuffer>): RunBuffer {
  return {
    steps: Array.isArray(seed?.steps) ? [...seed!.steps] : [],
    logs: Array.isArray(seed?.logs) ? [...seed!.logs] : [],
    mainDoc: seed?.mainDoc ? { ...seed.mainDoc } : {},
    todoList: Array.isArray(seed?.todoList) ? [...seed!.todoList] : [],
    ctxRefs: Array.isArray(seed?.ctxRefs) ? [...seed!.ctxRefs] : [],
    activity: seed?.activity ? { ...seed.activity } : null,
  };
}

function getOrEmpty(runs: Record<string, ConvRunEntry>, convId: string): ConvRunEntry {
  return runs[convId] ?? { isRunning: false, completedAt: null, buffer: emptyBuffer() };
}

const hasOwn = (obj: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(obj, key);

// ─── Store ────────────────────────────────────────────────────────────────────

export const useRunRegistry = create<RunRegistryState>()((set) => ({
  runs: {},

  start: (convId, seed) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      return {
        runs: {
          ...s.runs,
          [id]: {
            isRunning: prev.isRunning,
            completedAt: prev.completedAt,
            buffer: cloneBuffer(seed),
          },
        },
      };
    });
  },

  setRunning: (convId, running) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      return {
        runs: { ...s.runs, [id]: { ...prev, isRunning: running } },
      };
    });
  },

  setCompletedAt: (convId, completedAt) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      return {
        runs: { ...s.runs, [id]: { ...prev, completedAt } },
      };
    });
  },

  addStep: (convId, step) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      return {
        runs: {
          ...s.runs,
          [id]: {
            ...prev,
            buffer: { ...prev.buffer, steps: [...prev.buffer.steps, step] },
          },
        },
      };
    });
  },

  patchStep: (convId, stepId, patch) => {
    const id = String(convId ?? "").trim();
    if (!id || !stepId) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      const nextSteps = prev.buffer.steps.map((step) =>
        step.id === stepId ? ({ ...step, ...(patch as any) } as Step) : step,
      );
      return {
        runs: {
          ...s.runs,
          [id]: { ...prev, buffer: { ...prev.buffer, steps: nextSteps } },
        },
      };
    });
  },

  updateBuffer: (convId, patch) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const prev = getOrEmpty(s.runs, id);
      const cur = prev.buffer;
      const next: RunBuffer = {
        steps: hasOwn(patch, "steps") ? [...(patch.steps ?? [])] : cur.steps,
        logs: hasOwn(patch, "logs") ? [...(patch.logs ?? [])] : cur.logs,
        mainDoc: hasOwn(patch, "mainDoc") ? { ...(patch.mainDoc ?? {}) } : cur.mainDoc,
        todoList: hasOwn(patch, "todoList") ? [...(patch.todoList ?? [])] : cur.todoList,
        ctxRefs: hasOwn(patch, "ctxRefs") ? [...(patch.ctxRefs ?? [])] : cur.ctxRefs,
        activity: hasOwn(patch, "activity")
          ? patch.activity ? { ...patch.activity } : null
          : cur.activity,
      };
      return {
        runs: { ...s.runs, [id]: { ...prev, buffer: next } },
      };
    });
  },

  remove: (convId) => {
    const id = String(convId ?? "").trim();
    if (!id) return;
    set((s) => {
      const { [id]: _, ...rest } = s.runs;
      return { runs: rest };
    });
  },
}));

// ─── 每对话取消句柄（不放入 Zustand，避免序列化 + 高频更新） ────────────────────

const _convCancelFns = new Map<string, (reason?: string) => void>();

/** 注册（或清除）某对话的当前 run cancel 函数 */
export function setConvRunCancel(convId: string, fn: ((reason?: string) => void) | null) {
  const id = String(convId ?? "").trim();
  if (!id) return;
  if (fn) _convCancelFns.set(id, fn);
  else _convCancelFns.delete(id);
}

/** 取消某对话正在进行的 run（若有） */
export function cancelConvRun(convId: string, reason?: string) {
  const id = String(convId ?? "").trim();
  if (!id) return;
  const fn = _convCancelFns.get(id);
  if (!fn) return;
  _convCancelFns.delete(id);
  try { fn(reason); } catch { /* ignore */ }
}
