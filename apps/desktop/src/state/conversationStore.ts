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
  /** 当前“草稿对话”（未归档到历史，也无需点 +），用于重启后自动恢复右侧内容 */
  draftSnapshot: RunSnapshot | null;
  hydrateFromDisk: () => Promise<void>;
  addConversation: (c: Omit<Conversation, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  setDraftSnapshot: (snap: RunSnapshot | null) => void;
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

function schedulePersistToDisk(args: { conversations: Conversation[]; draftSnapshot: RunSnapshot | null }) {
  const api = window.desktop?.history;
  if (!api?.saveConversations) return;

  const conversations = capConversations(args.conversations);
  const draftSnapshot = args.draftSnapshot ?? null;
  pendingPayload = {
    version: 1,
    updatedAt: Date.now(),
    conversations,
    draftSnapshot,
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
      draftSnapshot: null,
      hydrateFromDisk: async () => {
        if (diskHydrated) return;
        diskHydrated = true;
        const api = window.desktop?.history;
        if (!api?.loadConversations) return;

        try {
          const res = await api.loadConversations();
          const list = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          const diskDraft = ((res as any)?.draftSnapshot ?? null) as any;

          // localStorage 优先：但允许“分别补齐”缺失项（例如本地有 conversations，但没有 draft）
          const curConvs = get().conversations ?? [];
          const curDraft = get().draftSnapshot ?? null;

          const patch: Partial<ConversationState> = {};
          if (!curConvs.length && list.length) patch.conversations = capConversations(list as any);
          if (!curDraft && diskDraft && typeof diskDraft === "object") patch.draftSnapshot = diskDraft as any;
          if (Object.keys(patch).length) set(patch as any);

          const finalConvs = (patch.conversations ?? curConvs) as any;
          const finalDraft = (patch.draftSnapshot ?? curDraft) as any;
          // 把“最终态”同步回磁盘，保证 dev/packaged/迁移都能恢复
          schedulePersistToDisk({ conversations: finalConvs, draftSnapshot: finalDraft });
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
          schedulePersistToDisk({ conversations: capped, draftSnapshot: get().draftSnapshot ?? null });
          return { conversations: capped };
        });
        return id;
      },
      deleteConversation: (id) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).filter((x) => x.id !== v);
          schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null });
          return { conversations: next };
        });
      },
      renameConversation: (id, title) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) => (x.id === v ? { ...x, title: clampTitle(title), updatedAt: Date.now() } : x));
          schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null });
          return { conversations: next };
        });
      },
      setDraftSnapshot: (snap) => {
        const next = snap && typeof snap === "object" ? (snap as any) : null;
        set(() => {
          const conversations = get().conversations ?? [];
          schedulePersistToDisk({ conversations, draftSnapshot: next });
          return { draftSnapshot: next };
        });
      },
      clearAll: () =>
        set(() => {
          schedulePersistToDisk({ conversations: [], draftSnapshot: null });
          return { conversations: [], draftSnapshot: null };
        }),
    }),
    { name: "writing-ide.conversations.v1" },
  ),
);







