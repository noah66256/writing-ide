import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
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
  /** 当前”草稿对话”（未归档到历史，也无需点 +），用于重启后自动恢复右侧内容 */
  draftSnapshot: RunSnapshot | null;
  /** 当前活跃的对话 ID（发送首条消息时创建，侧边栏切换时设置） */
  activeConvId: string | null;
  hydrateFromDisk: () => Promise<void>;
  addConversation: (c: Omit<Conversation, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  updateConversation: (id: string, patch: { snapshot?: RunSnapshot; title?: string }) => void;
  setActiveConvId: (id: string | null) => void;
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

function hasDiskHistoryApi() {
  try {
    return Boolean(window.desktop?.history?.saveConversations && window.desktop?.history?.loadConversations);
  } catch {
    return false;
  }
}

// localStorage 可能因为配额/隐私模式/禁用等原因直接抛异常；必须吞掉，避免渲染链路被打断。
const safeLocalStorage = {
  getItem(name: string) {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // ignore (QuotaExceededError etc.)
    }
  },
  removeItem(name: string) {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

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
      activeConvId: null,
      hydrateFromDisk: async () => {
        if (diskHydrated) return;
        diskHydrated = true;
        const api = window.desktop?.history;
        if (!api?.loadConversations) return;

        try {
          const res = await api.loadConversations();
          const list = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          const diskDraft = ((res as any)?.draftSnapshot ?? null) as any;

          // 磁盘优先：localStorage 只作为极弱兜底（避免 QuotaExceededError 把渲染打崩）
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

          // 并把 localStorage 写回一个“很小的占位”，清掉旧的大对象（避免下一次 setItem 直接 quota 崩溃）
          try {
            safeLocalStorage.setItem(
              "writing-ide.conversations.v1",
              JSON.stringify({ state: { conversations: [], draftSnapshot: null }, version: 1 }),
            );
          } catch {
            // ignore
          }
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
      updateConversation: (id, patch) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) => {
            if (x.id !== v) return x;
            return {
              ...x,
              ...(patch.title != null ? { title: clampTitle(patch.title) } : {}),
              ...(patch.snapshot != null ? { snapshot: patch.snapshot } : {}),
              updatedAt: Date.now(),
            };
          });
          schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null });
          return { conversations: next };
        });
      },
      setActiveConvId: (id) => {
        set({ activeConvId: id });
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
    {
      name: "writing-ide.conversations.v1",
      // 关键：历史对话与草稿快照都落盘到 userData（history.saveConversations）。
      // localStorage 只存“极小占位”用于兜底（否则会因 5MB 配额触发 QuotaExceededError，导致渲染崩溃）。
      storage: createJSONStorage(() => safeLocalStorage as any),
      partialize: (_s) => {
        // Electron 环境：禁用 localStorage 持久化大对象
        if (hasDiskHistoryApi()) return { conversations: [], draftSnapshot: null };
        // 非 Electron 环境：也不要存大对象，保守兜底
        return { conversations: [], draftSnapshot: null };
      },
    },
  ),
);







