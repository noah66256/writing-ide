import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MainDoc, TodoItem, Step, LogEntry, Mode, ToolBlockStep } from "./runStore";

export type SerializableToolStep = Omit<ToolBlockStep, "apply" | "undo"> & {
  // 历史会话只做展示/续聊入口，不保留可执行的 apply/undo 函数
  apply?: never;
  undo?: never;
  undoable: false;
};

export type SerializableStep = Exclude<Step, ToolBlockStep> | SerializableToolStep;

export type RunSnapshot = {
  mode: Mode;
  model: string;
  mainDoc: MainDoc;
  todoList: TodoItem[];
  steps: SerializableStep[];
  logs: LogEntry[];
  kbAttachedLibraryIds: string[];
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  snapshot: RunSnapshot;
};

type ConversationState = {
  conversations: Conversation[];
  addConversation: (c: Omit<Conversation, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  clearAll: () => void;
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clampTitle(s: string) {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "未命名对话";
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      addConversation: (c) => {
        const id = String(c.id ?? makeId("conv"));
        const now = Date.now();
        const next: Conversation = {
          id,
          title: clampTitle(c.title),
          createdAt: now,
          updatedAt: now,
          snapshot: c.snapshot,
        };
        set(() => {
          const prev = get().conversations ?? [];
          const merged = [next, ...prev.filter((x) => x.id !== id)];
          // cap：避免 localStorage 爆炸（仅保留最近 20 条）
          const capped = merged.length > 20 ? merged.slice(0, 20) : merged;
          return { conversations: capped };
        });
        return id;
      },
      deleteConversation: (id) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => ({ conversations: (s.conversations ?? []).filter((x) => x.id !== v) }));
      },
      renameConversation: (id, title) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => ({
          conversations: (s.conversations ?? []).map((x) =>
            x.id === v ? { ...x, title: clampTitle(title), updatedAt: Date.now() } : x,
          ),
        }));
      },
      clearAll: () => set({ conversations: [] }),
    }),
    { name: "writing-ide.conversations.v1" },
  ),
);







