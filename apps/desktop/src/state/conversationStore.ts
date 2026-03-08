import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useProjectStore } from "./projectStore";
import {
  useRunStore,
  type MainDoc,
  type TodoItem,
  type Step,
  type LogEntry,
  type Mode,
  type ToolBlockStep,
  type CtxRefItem,
  type PendingArtifact,
} from "./runStore";

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
  pendingArtifacts?: PendingArtifact[];
  projectDir?: string | null;
  dialogueSummaryByMode?: Record<Mode, string>;
  dialogueSummaryTurnCursorByMode?: Record<Mode, number>;
};

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 从当前 runStore + projectStore 构建可序列化的 RunSnapshot。
 * 替代 NavSidebar / ChatArea 中的 inline buildSnapshot()。
 */
export function buildCurrentSnapshot(): RunSnapshot {
  const s = useRunStore.getState();
  const projectDir = useProjectStore.getState().rootDir ?? null;

  const steps: SerializableStep[] = (s.steps ?? []).map((step) => {
    if (step.type !== "tool") return deepClone(step as Exclude<Step, ToolBlockStep>) as SerializableStep;
    const { apply, undo, ...rest } = step as ToolBlockStep;
    return deepClone({ ...rest, undoable: false } as SerializableToolStep);
  });

  return {
    mode: s.mode,
    model: s.model,
    mainDoc: deepClone(s.mainDoc ?? {}),
    todoList: deepClone(s.todoList ?? []),
    steps,
    logs: deepClone(s.logs ?? []),
    kbAttachedLibraryIds: deepClone(s.kbAttachedLibraryIds ?? []),
    ctxRefs: deepClone(s.ctxRefs ?? []),
    pendingArtifacts: deepClone((s as any).pendingArtifacts ?? []),
    projectDir,
    dialogueSummaryByMode: deepClone(s.dialogueSummaryByMode ?? { agent: "", chat: "" }),
    dialogueSummaryTurnCursorByMode: deepClone(s.dialogueSummaryTurnCursorByMode ?? { agent: 0, chat: 0 }),
  };
}

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  snapshot: RunSnapshot;
  pinned?: boolean;
};

type ConversationState = {
  conversations: Conversation[];
  /** 当前"草稿对话"（未归档到历史，也无需点 +），用于重启后自动恢复右侧内容 */
  draftSnapshot: RunSnapshot | null;
  /** 当前活跃的对话 ID（发送首条消息时创建，侧边栏切换时设置） */
  activeConvId: string | null;
  hydrateFromDisk: () => Promise<void>;
  addConversation: (c: Omit<Conversation, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  deleteConversation: (id: string) => void;
  pinConversation: (id: string, pinned: boolean) => void;
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
/** 水化完成前禁止写盘，防止 hydrateFromDisk IPC 未返回时把 conversations:[] 覆盖掉已有数据 */
let diskWriteAllowed = false;
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
  // 置顶的对话全部保留，非置顶最多保留 20 条
  const pinned = arr.filter((c) => c.pinned);
  const rest = arr.filter((c) => !c.pinned);
  const capped = rest.length > 20 ? rest.slice(0, 20) : rest;
  return [...pinned, ...capped];
}

function schedulePersistToDisk(args: { conversations: Conversation[]; draftSnapshot: RunSnapshot | null }) {
  const api = window.desktop?.history;
  if (!api?.saveConversations) return;
  // 水化未完成时不写盘，避免以 conversations:[] 覆盖已有数据
  if (!diskWriteAllowed) return;

  const conversations = capConversations(args.conversations);
  const draftSnapshot = args.draftSnapshot ?? null;
  // activeConvId 自动从 store 读取（避免改动所有调用处）
  const activeConvId = useConversationStore?.getState?.()?.activeConvId ?? null;
  pendingPayload = {
    version: 1,
    updatedAt: Date.now(),
    conversations,
    draftSnapshot,
    activeConvId,
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
        if (!api?.loadConversations) {
          // 无 Electron disk API（纯浏览器模式），直接开放写权限
          diskWriteAllowed = true;
          return;
        }

        try {
          const res = await api.loadConversations();
          if ((res as any)?.ok === false) {
            throw new Error(String((res as any)?.error || (res as any)?.detail || "history_load_failed"));
          }
          const list = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          const diskDraft = ((res as any)?.draftSnapshot ?? null) as any;
          const diskActiveConvId = ((res as any)?.activeConvId ?? null) as string | null;

          // 磁盘优先：localStorage 只作为极弱兜底（避免 QuotaExceededError 把渲染打崩）
          const curConvs = get().conversations ?? [];
          const curDraft = get().draftSnapshot ?? null;

          const patch: Partial<ConversationState> = {};
          // Electron 模式下磁盘是单一真实来源：只要磁盘有数据，就覆盖内存态（避免旧 localStorage 残留挡住历史恢复）
          if (list.length) patch.conversations = capConversations(list as any);
          if (diskDraft && typeof diskDraft === "object") patch.draftSnapshot = diskDraft as any;

          // 恢复 activeConvId（仅当对话仍存在时）
          const finalConvs = (patch.conversations ?? curConvs) as Conversation[];
          if (diskActiveConvId && finalConvs.some((c) => c.id === diskActiveConvId)) {
            patch.activeConvId = diskActiveConvId;
          }

          if (Object.keys(patch).length) set(patch as any);

          // 水化成功后开放写权限，并把最终态同步回磁盘
          diskWriteAllowed = true;
          const finalDraft = (patch.draftSnapshot ?? curDraft) as any;
          schedulePersistToDisk({ conversations: finalConvs, draftSnapshot: finalDraft });

          // 并把 localStorage 写回一个"很小的占位"，清掉旧的大对象（避免下一次 setItem 直接 quota 崩溃）
          try {
            safeLocalStorage.setItem(
              "writing-ide.conversations.v1",
              JSON.stringify({ state: { conversations: [], draftSnapshot: null }, version: 1 }),
            );
          } catch {
            // ignore
          }
        } catch {
          // 读盘出错也要开放写权限，否则永远无法写入
          diskWriteAllowed = true;
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
      pinConversation: (id, pinned) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) => (x.id === v ? { ...x, pinned, updatedAt: Date.now() } : x));
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
        // activeConvId 变更需要落盘，避免重启后丢失导致重复创建对话
        const s = get();
        schedulePersistToDisk({ conversations: s.conversations ?? [], draftSnapshot: s.draftSnapshot ?? null });
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
          return { conversations: [], draftSnapshot: null, activeConvId: null };
        }),
    }),
    {
      name: "writing-ide.conversations.v1",
      // 关键：历史对话与草稿快照都落盘到 userData（history.saveConversations）。
      // localStorage 只存"极小占位"用于兜底（否则会因 5MB 配额触发 QuotaExceededError，导致渲染崩溃）。
      storage: createJSONStorage(() => safeLocalStorage as any),
      partialize: (s) => {
        // Electron 环境：磁盘 API 负责持久化，localStorage 只存极小占位
        if (hasDiskHistoryApi()) return { conversations: [], draftSnapshot: null, activeConvId: null };
        // 非 Electron 环境（纯浏览器 dev / Web）：localStorage 作为唯一持久化方式
        // 限制最多 10 条以控制体积，避免 QuotaExceededError
        const capped = (s.conversations ?? []).slice(0, 10);
        return { conversations: capped, draftSnapshot: s.draftSnapshot ?? null, activeConvId: s.activeConvId ?? null };
      },
    },
  ),
);






