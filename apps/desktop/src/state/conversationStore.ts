import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MainDoc, TodoItem, Step, LogEntry, Mode, ToolBlockStep, CtxRefItem } from "./runStore";

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
  ctxRefs?: CtxRefItem[];
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
  hydrateFromDisk: () => Promise<void>;
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

let diskHydrated = false;
let persistTimer: any = null;
let pendingPayload: any = null;

function capConversations(list: Conversation[]) {
  const arr = Array.isArray(list) ? list : [];
  // cap：避免文件与 localStorage 爆炸（仅保留最近 20 条）
  return arr.length > 20 ? arr.slice(0, 20) : arr;
}

function schedulePersistToDisk(conversations: Conversation[]) {
  const api = window.desktop?.history;
  if (!api?.saveConversations) return;

  pendingPayload = {
    version: 1,
    updatedAt: Date.now(),
    conversations: capConversations(conversations),
  };

  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    const payload = pendingPayload;
    pendingPayload = null;
    persistTimer = null;
    void api.saveConversations(payload).catch(() => void 0);
  }, 220);
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      hydrateFromDisk: async () => {
        if (diskHydrated) return;
        diskHydrated = true;
        const api = window.desktop?.history;
        if (!api?.loadConversations) return;

        try {
          const res = await api.loadConversations();
          const list = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          if (!list.length) return;

          // 如果 localStorage 已有内容，优先保留（避免“覆盖用户最近操作”）
          const cur = get().conversations ?? [];
          if (cur.length) {
            // 但仍把当前内容同步到磁盘，保证“换端口/装包”也能恢复
            schedulePersistToDisk(cur);
            return;
          }

          set({ conversations: capConversations(list as any) });
        } catch {
          // ignore
        }
      },
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
          const capped = capConversations(merged);
          schedulePersistToDisk(capped);
          return { conversations: capped };
        });
        return id;
      },
      deleteConversation: (id) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).filter((x) => x.id !== v);
          schedulePersistToDisk(next);
          return { conversations: next };
        });
      },
      renameConversation: (id, title) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) => (x.id === v ? { ...x, title: clampTitle(title), updatedAt: Date.now() } : x));
          schedulePersistToDisk(next);
          return { conversations: next };
        });
      },
      clearAll: () =>
        set(() => {
          schedulePersistToDisk([]);
          return { conversations: [] };
        }),
    }),
    { name: "writing-ide.conversations.v1" },
  ),
);







