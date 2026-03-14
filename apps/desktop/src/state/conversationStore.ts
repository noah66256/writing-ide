import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useProjectStore } from "./projectStore";
import {
  useRunStore,
  type MainDoc,
  type TodoItem,
  type Step,
  type UserStep,
  type AssistantStep,
  type LogEntry,
  type Mode,
  type OpMode,
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
  /** 会话级执行模式：创作 / 助手 */
  opMode?: OpMode;
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

// ─── 历史快照“瘦身”工具（对齐 Codex：历史只做入口，不当运行时缓存） ─────────────

const MAX_TOOL_STDIO_HISTORY_CHARS = 4000;
const MAX_TOOL_GENERIC_STRING_CHARS = 800;
const MAX_LOG_MESSAGE_HISTORY_CHARS = 400;
const MAX_LOG_ENTRIES_HISTORY = 80;

function truncateForHistory(raw: unknown, max: number): string {
  const s = String(raw ?? "");
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[历史已截断]";
}

function slimToolIoForHistory(toolName: string, io: unknown): unknown {
  if (!io || typeof io !== "object" || Array.isArray(io)) return io;
  const src = io as Record<string, unknown>;
  const dst: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string") {
      const limit =
        k === "stdout" || k === "stderr" ? MAX_TOOL_STDIO_HISTORY_CHARS : MAX_TOOL_GENERIC_STRING_CHARS;
      dst[k] = truncateForHistory(v, limit);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

function slimStepForHistory(raw: Step | SerializableStep): SerializableStep {
  if (!raw || typeof raw !== "object") return raw as SerializableStep;
  const step = raw as any;
  if (step.type === "tool") {
    const { apply, undo, baseline, ...rest } = step;
    const toolStep: SerializableToolStep = {
      ...(rest as SerializableToolStep),
      undoable: false,
    };
    if (toolStep.toolName) {
      toolStep.input = slimToolIoForHistory(toolStep.toolName, toolStep.input);
      toolStep.output = slimToolIoForHistory(toolStep.toolName, toolStep.output);
    }
    return toolStep;
  }
  if (step.type === "user") {
    const { baseline, ...rest } = step;
    return { ...(rest as UserStep) } as SerializableStep;
  }
  if (step.type === "assistant") {
    return { ...(step as AssistantStep) } as SerializableStep;
  }
  return step as SerializableStep;
}

function slimLogsForHistory(logs: LogEntry[] | undefined | null): LogEntry[] {
  const list = Array.isArray(logs) ? logs : [];
  const sliced =
    list.length > MAX_LOG_ENTRIES_HISTORY ? list.slice(list.length - MAX_LOG_ENTRIES_HISTORY) : list;
  return sliced.map((log) => ({
    ...log,
    message: truncateForHistory(log.message, MAX_LOG_MESSAGE_HISTORY_CHARS),
  }));
}

function slimSnapshotForHistory(snapshot: RunSnapshot | null | undefined): RunSnapshot | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const stepsRaw = Array.isArray((snapshot as any).steps) ? ((snapshot as any).steps as any[]) : [];
  const stepsSlim: SerializableStep[] = stepsRaw.map((step) => slimStepForHistory(step));
  const logsSlim = slimLogsForHistory((snapshot as any).logs as LogEntry[]);
  return {
    ...(snapshot as RunSnapshot),
    steps: stepsSlim,
    logs: logsSlim,
  };
}

function getSnapshotStepsCount(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const steps = (raw as any).steps;
  return Array.isArray(steps) ? steps.length : 0;
}

/**
 * 从当前 runStore + projectStore 构建可序列化的 RunSnapshot。
 * 替代 NavSidebar / ChatArea 中的 inline buildSnapshot()。
 */
export function buildCurrentSnapshot(): RunSnapshot {
  const s = useRunStore.getState();
  const projectDir = useProjectStore.getState().rootDir ?? null;

  const rawSnapshot: RunSnapshot = {
    mode: s.mode,
    model: s.model,
    opMode: s.opMode,
    mainDoc: { ...(s.mainDoc ?? {}) },
    todoList: [...(s.todoList ?? [])],
    // steps / logs 统一交给 slimSnapshotForHistory 处理，避免 JSON 深拷贝大对象。
    steps: (s.steps ?? []) as any,
    logs: (s.logs ?? []) as any,
    kbAttachedLibraryIds: [...(s.kbAttachedLibraryIds ?? [])],
    ctxRefs: [...(s.ctxRefs ?? [])],
    pendingArtifacts: [...(((s as any).pendingArtifacts ?? []) as PendingArtifact[])],
    projectDir,
    dialogueSummaryByMode: { ...(s.dialogueSummaryByMode ?? { agent: "", chat: "" }) },
    dialogueSummaryTurnCursorByMode: {
      ...(s.dialogueSummaryTurnCursorByMode ?? { agent: 0, chat: 0 }),
    },
  };

  return slimSnapshotForHistory(rawSnapshot) ?? rawSnapshot;
}

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  snapshot: RunSnapshot;
  pinned?: boolean;
  /** 手动归档标记：归档后从“进行中”列表移至“已归档”分组 */
  archived?: boolean;
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
  archiveConversation: (id: string, archived: boolean) => void;
  renameConversation: (id: string, title: string) => void;
  updateConversation: (id: string, patch: { snapshot?: RunSnapshot; title?: string }) => void;
  setActiveConvId: (id: string | null) => void;
  setDraftSnapshot: (snap: RunSnapshot | null) => void;
  flushDraftSnapshotNow: (snap?: RunSnapshot | null) => Promise<void>;
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
  if (!api?.saveConversations && !api?.savePendingConversations) return;

  const conversations = capConversations(args.conversations);
  const draftSnapshot = args.draftSnapshot ?? null;
  // activeConvId 自动从 store 读取（避免改动所有调用处）
  const activeConvId = useConversationStore?.getState?.()?.activeConvId ?? null;
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    conversations,
    draftSnapshot,
    activeConvId,
  };

  // crash-safe：无论是否允许写主历史文件，都尽量先把最新 payload 写到 pending 文件。
  // 这样 dev/HMR/强制退出时，即使主历史还没来得及落盘，也能在下次启动时被 hydrate 合并回来。
  if (api?.savePendingConversations) {
    void api.savePendingConversations(payload).catch(() => void 0);
  }

  // 水化未完成时不写主历史文件，避免以 conversations:[] 覆盖已有数据。
  // 但上面的 pending 文件仍会保留最新 payload，供下一次启动合并。
  if (!api?.saveConversations) return;
  if (!diskWriteAllowed) return;

  pendingPayload = payload;

  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    const next = pendingPayload;
    pendingPayload = null;
    persistTimer = null;
    void api.saveConversations(next).catch(() => void 0);
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
          const [res, pendingRes] = await Promise.all([
            api.loadConversations(),
            api.loadPendingConversations ? api.loadPendingConversations().catch(() => null) : Promise.resolve(null),
          ]);

          if ((res as any)?.ok === false) {
            throw new Error(String((res as any)?.error || (res as any)?.detail || "history_load_failed"));
          }

          const diskList = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          const diskDraft = ((res as any)?.draftSnapshot ?? null) as any;
          const diskActiveConvId = ((res as any)?.activeConvId ?? null) as string | null;

          const pendingPayload = pendingRes && (pendingRes as any).ok !== false ? (pendingRes as any).payload : null;
          const pendingList = Array.isArray(pendingPayload?.conversations) ? (pendingPayload.conversations as any[]) : [];
          const pendingDraft = pendingPayload?.draftSnapshot && typeof pendingPayload.draftSnapshot === "object" ? pendingPayload.draftSnapshot : null;
          const pendingActiveConvId = typeof pendingPayload?.activeConvId === "string" ? pendingPayload.activeConvId : null;

          // 当前内存态（可能在 hydrate 尚未完成时，用户已经发了消息/产生草稿）
          const curConvs = get().conversations ?? [];
          const curDraft = get().draftSnapshot ?? null;
          const curActiveConvId = get().activeConvId ?? null;

          const diskConvs = capConversations(diskList as any);
          const pendConvs = capConversations(pendingList as any);

          // precedence：disk < pending < memory
          const byId = new Map();
          for (const list of [diskConvs, pendConvs, curConvs]) {
            for (const c of Array.isArray(list) ? list : []) {
              if (!c || !c.id) continue;
              byId.set(c.id, c);
            }
          }
          // order：memory > pending > disk
          const order: string[] = [];
          const seen = new Set<string>();
          for (const list of [curConvs, pendConvs, diskConvs]) {
            for (const c of Array.isArray(list) ? list : []) {
              const id = String(c?.id ?? "");
              if (!id || seen.has(id)) continue;
              seen.add(id);
              order.push(id);
            }
          }
          const mergedRaw = capConversations(order.map((id) => byId.get(id)).filter(Boolean) as any);
          const merged = (mergedRaw as any[]).map((c) => {
            const snap = (c && (c as any).snapshot) as RunSnapshot | null | undefined;
            const slim = slimSnapshotForHistory(snap);
            return slim ? { ...c, snapshot: slim } : c;
          }) as Conversation[];

          // 计算最终 activeConvId（memory > pending > disk）
          const pickActive = (id: string | null) =>
            id && merged.some((c) => c.id === id) ? id : null;
          const finalActiveConvId =
            pickActive(curActiveConvId) ||
            pickActive(pendingActiveConvId) ||
            pickActive(diskActiveConvId);

          // 在 curDraft / pendingDraft / diskDraft 之间选择 steps 更多的一份；
          // 若三者都不存在，则回退到 activeConvId 对应对话的 snapshot。
          const draftCandidates: Array<RunSnapshot | null> = [];
          if (curDraft && typeof curDraft === "object") {
            draftCandidates.push(curDraft as RunSnapshot);
          }
          if (pendingDraft && typeof pendingDraft === "object") {
            draftCandidates.push(pendingDraft as RunSnapshot);
          }
          if (diskDraft && typeof diskDraft === "object") {
            draftCandidates.push(diskDraft as RunSnapshot);
          }

          let finalDraftRaw: RunSnapshot | null = null;
          let bestSteps = -1;
          for (const snap of draftCandidates) {
            if (!snap || typeof snap !== "object") continue;
            const steps = getSnapshotStepsCount(snap);
            if (steps > bestSteps) {
              bestSteps = steps;
              finalDraftRaw = snap;
            }
          }

          // 草稿源都不存在时，尝试用当前 activeConv 的 snapshot 作为最近草稿
          if (!finalDraftRaw && finalActiveConvId) {
            const activeConv = merged.find((c) => c.id === finalActiveConvId);
            if (activeConv && activeConv.snapshot && typeof activeConv.snapshot === "object") {
              finalDraftRaw = activeConv.snapshot as RunSnapshot;
            }
          }

          const finalDraft = finalDraftRaw
            ? slimSnapshotForHistory(finalDraftRaw as any) ?? finalDraftRaw
            : null;

          set({
            conversations: merged,
            draftSnapshot: finalDraft as any,
            activeConvId: finalActiveConvId,
          } as any);

          // 水化成功后开放写权限，并把最终态同步回磁盘
          diskWriteAllowed = true;
          schedulePersistToDisk({ conversations: merged, draftSnapshot: (finalDraft as any) ?? null });
          void api.clearPendingConversations?.().catch(() => void 0);

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
          ...(c.pinned != null ? { pinned: c.pinned } : {}),
          ...(c.archived != null ? { archived: c.archived } : {}),
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
          const next = (s.conversations ?? []).map((x) =>
            x.id === v ? { ...x, pinned, updatedAt: Date.now() } : x,
          );
          schedulePersistToDisk({ conversations: next, draftSnapshot: get().draftSnapshot ?? null });
          return { conversations: next };
        });
      },
      archiveConversation: (id, archived) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) =>
            x.id === v ? { ...x, archived, updatedAt: Date.now() } : x,
          );
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
            let nextSnapshot = x.snapshot;
            if (patch.snapshot != null) {
              const incoming = patch.snapshot as RunSnapshot;
              const prevSteps = getSnapshotStepsCount(nextSnapshot as any);
              const incomingSteps = getSnapshotStepsCount(incoming as any);
              // 防降级：避免把已有 steps>0 的对话误写成 steps=0 的快照
              nextSnapshot = prevSteps > 0 && incomingSteps === 0 ? nextSnapshot : incoming;
            }
            return {
              ...x,
              ...(patch.title != null ? { title: clampTitle(patch.title) } : {}),
              ...(patch.snapshot != null ? { snapshot: nextSnapshot } : {}),
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
        const nextRaw = snap && typeof snap === "object" ? (snap as any) : null;
        const next = nextRaw ? slimSnapshotForHistory(nextRaw) ?? nextRaw : null;
        set(() => {
          const conversations = get().conversations ?? [];
          schedulePersistToDisk({ conversations, draftSnapshot: next });
          return { draftSnapshot: next };
        });
      },
      flushDraftSnapshotNow: async (snap) => {
        const base =
          snap && typeof snap === "object"
            ? (snap as any)
            : snap === null
              ? null
              : buildCurrentSnapshot();
        const candidate = base ? slimSnapshotForHistory(base as any) ?? base : null;
        const activeConvId = get().activeConvId;
        const prevConversations = get().conversations ?? [];
        const conversations = activeConvId
          ? prevConversations.map((x) => {
              if (x.id !== activeConvId) return x;
              const prevSnap = x.snapshot as any;
              const prevSteps = getSnapshotStepsCount(prevSnap);
              const candSteps = getSnapshotStepsCount(candidate as any);
              // 防降级：已有 snapshot.steps>0 而候选 steps=0 时，保留旧 snapshot
              const safeSnapshot =
                prevSteps > 0 && candSteps === 0 ? prevSnap : (candidate as any);
              return { ...x, snapshot: safeSnapshot, updatedAt: Date.now() };
            })
          : prevConversations;

        // draftSnapshot 也做防降级，避免从"有内容草稿"退化为"空草稿"
        const prevDraft = get().draftSnapshot as any;
        const prevDraftSteps = getSnapshotStepsCount(prevDraft);
        const candDraftSteps = getSnapshotStepsCount(candidate as any);
        const nextDraft =
          prevDraftSteps > 0 && candDraftSteps === 0 ? prevDraft : (candidate as any);

        set({ draftSnapshot: nextDraft as any, conversations });

        const api = window.desktop?.history;
        if (!api?.saveConversations || !diskWriteAllowed) {
          schedulePersistToDisk({ conversations, draftSnapshot: nextDraft as any });
          return;
        }

        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        pendingPayload = null;
        try {
          await api.saveConversations({
            version: 1,
            updatedAt: Date.now(),
            conversations: capConversations(conversations),
            draftSnapshot: nextDraft as any,
            activeConvId: activeConvId ?? null,
          });
        } catch {
          schedulePersistToDisk({ conversations, draftSnapshot: nextDraft as any });
        }
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
