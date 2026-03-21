import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { slimToolResultEnvelopeForHistory } from "@ohmycrab/shared";
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
  type RuntimeThreadRecord,
  type RuntimeTurnRecord,
  type RuntimeItemRecord,
  type RuntimeCollabSessionRecord,
  sanitizeThreadCollabState,
} from "./runStore";
import { getProjectedStepsFromRuntime } from "../agent/threadProjection";

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
  thread?: RuntimeThreadRecord | null;
  turns?: RuntimeTurnRecord[];
  items?: RuntimeItemRecord[];
  collabSessions?: RuntimeCollabSessionRecord[];
  activeItemIds?: string[];
  projectDir?: string | null;
  dialogueSummaryByMode?: Record<Mode, string>;
  dialogueSummaryTurnCursorByMode?: Record<Mode, number>;
};

type StepDialogueStats = {
  total: number;
  userCount: number;
  assistantTextCount: number;
  failedToolCount: number;
  score: number;
};

function normalizeId(raw: unknown): string {
  return String(raw ?? "").trim();
}

function isItemBackedStepId(id: string): boolean {
  return id.startsWith("item_") || id.startsWith("t_");
}

function hasMeaningfulAssistantContent(step: unknown): boolean {
  const src = step && typeof step === "object" ? (step as Record<string, unknown>) : null;
  if (!src || src.type !== "assistant") return false;
  const text = String(src.text ?? "").trim();
  const quickActions = Array.isArray(src.quickActions) ? src.quickActions : [];
  return text.length > 0 || quickActions.length > 0;
}

function getStepDialogueStats(rawSteps: unknown): StepDialogueStats {
  const steps = Array.isArray(rawSteps) ? rawSteps : [];
  let userCount = 0;
  let assistantTextCount = 0;
  let failedToolCount = 0;
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    const type = String(step.type ?? "").trim();
    if (type === "user") {
      userCount += 1;
      continue;
    }
    if (type === "assistant") {
      if (hasMeaningfulAssistantContent(step)) assistantTextCount += 1;
      continue;
    }
    if (type === "tool" && String(step.status ?? "").trim() === "failed") {
      failedToolCount += 1;
    }
  }
  return {
    total: steps.length,
    userCount,
    assistantTextCount,
    failedToolCount,
    score: userCount * 10 + assistantTextCount * 6 + failedToolCount * 2,
  };
}

export function getConversationStepDialogueScore(rawSteps: unknown): number {
  return getStepDialogueStats(rawSteps).score;
}

function filterTurnsForConversation(convId: string, turns: RuntimeTurnRecord[]): RuntimeTurnRecord[] {
  if (!convId || !turns.length) return turns;
  const hasThreadIds = turns.some((turn) => normalizeId(turn?.threadId).length > 0);
  const matching = turns.filter((turn) => normalizeId(turn?.threadId) === convId);
  return hasThreadIds ? matching : turns;
}

function filterItemsForConversation(
  convId: string,
  turnIds: Set<string>,
  items: RuntimeItemRecord[],
): RuntimeItemRecord[] {
  if ((!convId && !turnIds.size) || !items.length) return items;
  const hasThreadFacts = items.some(
    (item) => normalizeId((item as any)?.threadId).length > 0 || normalizeId((item as any)?.turnId).length > 0,
  );
  const matching = items.filter((item) => {
    const threadId = normalizeId((item as any)?.threadId);
    const turnId = normalizeId((item as any)?.turnId);
    return (convId && threadId === convId) || (turnIds.size > 0 && turnIds.has(turnId));
  });
  return hasThreadFacts ? matching : items;
}

function filterCollabSessionsForConversation(
  convId: string,
  sessions: RuntimeCollabSessionRecord[],
): RuntimeCollabSessionRecord[] {
  if (!convId || !sessions.length) return sessions;
  const hasThreadFacts = sessions.some(
    (session) =>
      normalizeId((session as any)?.parentThreadId).length > 0 ||
      normalizeId((session as any)?.childThreadId).length > 0,
  );
  const matching = sessions.filter((session) => {
    const parentThreadId = normalizeId((session as any)?.parentThreadId);
    const childThreadId = normalizeId((session as any)?.childThreadId);
    return parentThreadId === convId || childThreadId === convId;
  });
  return hasThreadFacts ? matching : sessions;
}

export function repairConversationSnapshotForDisplay(
  convId: string | null | undefined,
  rawSnapshot: RunSnapshot | null | undefined,
): RunSnapshot | null {
  if (!rawSnapshot || typeof rawSnapshot !== "object") return rawSnapshot ?? null;
  const snapshot = rawSnapshot as RunSnapshot;
  const normalizedConvId = normalizeId(convId);
  if (!normalizedConvId) return snapshot;

  const turnsRaw = Array.isArray(snapshot.turns) ? snapshot.turns : [];
  const filteredTurns = filterTurnsForConversation(normalizedConvId, turnsRaw);
  const turnIds = new Set(filteredTurns.map((turn) => normalizeId(turn?.id)).filter(Boolean));

  const itemsRaw = Array.isArray(snapshot.items) ? snapshot.items : [];
  const filteredItems = filterItemsForConversation(normalizedConvId, turnIds, itemsRaw);
  const allowedItemIds = new Set(filteredItems.map((item) => normalizeId(item?.id)).filter(Boolean));

  const collabSessionsRaw = Array.isArray(snapshot.collabSessions) ? snapshot.collabSessions : [];
  const filteredCollabSessions = filterCollabSessionsForConversation(normalizedConvId, collabSessionsRaw);
  const filteredActiveItemIds = Array.from(
    new Set(
      (Array.isArray(snapshot.activeItemIds) ? snapshot.activeItemIds : [])
        .map((id) => normalizeId(id))
        .filter((id) => !allowedItemIds.size || allowedItemIds.has(id)),
    ),
  );

  const stepsRaw = Array.isArray(snapshot.steps) ? snapshot.steps : [];
  const filteredSteps = stepsRaw.filter((rawStep) => {
    if (!rawStep || typeof rawStep !== "object") return false;
    const step = rawStep as Record<string, unknown>;
    const stepType = String(step.type ?? "").trim();
    const stepId = normalizeId(step.id);
    if (stepType === "user") return true;
    if (allowedItemIds.has(stepId)) return true;
    const itemBacked = isItemBackedStepId(stepId);
    if (itemBacked && allowedItemIds.size > 0) return false;
    if (stepType === "assistant") return hasMeaningfulAssistantContent(step) || !itemBacked;
    if (stepType === "tool") return String(step.status ?? "").trim() === "failed" || !itemBacked;
    return !itemBacked;
  }) as SerializableStep[];

  const repairedSteps = getProjectedStepsFromRuntime({
    steps: filteredSteps,
    items: filteredItems,
    activeItemIds: filteredActiveItemIds,
    collabSessions: filteredCollabSessions,
  }) as SerializableStep[];

  const hadForeignRuntime =
    filteredTurns.length !== turnsRaw.length ||
    filteredItems.length !== itemsRaw.length ||
    filteredCollabSessions.length !== collabSessionsRaw.length;
  const hadForeignItemBackedSteps =
    allowedItemIds.size > 0 &&
    stepsRaw.some((rawStep) => {
      const stepId = normalizeId((rawStep as any)?.id);
      return stepId.length > 0 && isItemBackedStepId(stepId) && !allowedItemIds.has(stepId);
    });

  const existingStats = getStepDialogueStats(stepsRaw);
  const repairedStats = getStepDialogueStats(repairedSteps);
  const shouldReplaceSteps =
    (hadForeignRuntime || hadForeignItemBackedSteps)
      ? repairedSteps.length > 0
      : repairedStats.score > existingStats.score;

  const threadRaw = snapshot.thread && typeof snapshot.thread === "object" ? snapshot.thread : null;
  const threadId = normalizeId((threadRaw as any)?.id);
  const threadConvId = normalizeId((threadRaw as any)?.convId);
  const filteredThread =
    threadRaw && (threadId === normalizedConvId || threadConvId === normalizedConvId)
      ? sanitizeThreadCollabState(threadRaw, filteredCollabSessions)
      : null;

  return {
    ...snapshot,
    ...(shouldReplaceSteps ? { steps: repairedSteps } : {}),
    thread: filteredThread,
    turns: filteredTurns,
    items: filteredItems,
    collabSessions: filteredCollabSessions,
    activeItemIds: filteredActiveItemIds,
  };
}

export function pickPreferredHistorySteps(args: {
  snapshot: RunSnapshot | null | undefined;
  segmentSteps: SerializableStep[];
  limit: number;
  hasMoreBefore: boolean;
}) {
  const snapshotSteps = Array.isArray(args.snapshot?.steps) ? (args.snapshot?.steps as SerializableStep[]) : [];
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 200;
  const fallbackWindow =
    snapshotSteps.length > limit ? snapshotSteps.slice(snapshotSteps.length - limit) : snapshotSteps;
  const segmentSteps = Array.isArray(args.segmentSteps) ? args.segmentSteps : [];
  const fallbackStats = getStepDialogueStats(fallbackWindow);
  const segmentStats = getStepDialogueStats(segmentSteps);
  const preferFallback =
    fallbackWindow.length > 0 &&
    (
      segmentSteps.length === 0 ||
      fallbackStats.score > segmentStats.score ||
      fallbackStats.userCount > segmentStats.userCount ||
      fallbackStats.assistantTextCount > segmentStats.assistantTextCount
    );
  return {
    steps: preferFallback ? fallbackWindow : segmentSteps,
    hasMoreBefore: preferFallback ? snapshotSteps.length > fallbackWindow.length : Boolean(args.hasMoreBefore),
  };
}

// ─── 历史快照“瘦身”工具（对齐 Codex：历史只做入口，不当运行时缓存） ─────────────

const MAX_TOOL_STDIO_HISTORY_CHARS = 8000;
const MAX_TOOL_GENERIC_STRING_CHARS = 2000;
const MAX_TOOL_MCP_OUTPUT_CHARS = 6000; // MCP 工具（如 Playwright browser_snapshot）输出更大
const MAX_LOG_MESSAGE_HISTORY_CHARS = 400;
const MAX_LOG_ENTRIES_HISTORY = 80;
const MAX_LOG_DATA_HISTORY_DEPTH = 4;
const MAX_LOG_DATA_HISTORY_KEYS = 24;
const MAX_LOG_DATA_HISTORY_ARRAY = 24;
const MAX_RUNTIME_ITEM_TEXT_HISTORY_CHARS = 4000;
const MAX_RUNTIME_ITEM_CONTENT_HISTORY_CHARS = 6000;
const MAX_RUNTIME_ITEMS_HISTORY = 160;
const MAX_RUNTIME_TURNS_HISTORY = 80;
const MAX_RUNTIME_TURN_ITEM_IDS_HISTORY = 160;
const MAX_COLLAB_SESSIONS_HISTORY = 40;
const MAX_THREAD_ID_LIST_HISTORY = 80;
const MAX_SUMMARY_HISTORY_CHARS = 4000;

function truncateForHistory(raw: unknown, max: number): string {
  const s = String(raw ?? "");
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[历史已截断]";
}

function clampTailForHistory<T>(raw: T[] | undefined | null, limit: number): T[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length <= limit) return list;
  return list.slice(list.length - limit);
}

function getStructuredStringLimitForHistory(key: string, fallback: number) {
  switch (String(key ?? "").trim()) {
    case "stdout":
    case "stderr":
    case "diff":
    case "diffUnified":
    case "patch":
      return MAX_TOOL_STDIO_HISTORY_CHARS;
    case "content":
      return MAX_RUNTIME_ITEM_CONTENT_HISTORY_CHARS;
    case "text":
      return MAX_RUNTIME_ITEM_TEXT_HISTORY_CHARS;
    case "message":
    case "summary":
    case "error":
    case "reason":
    case "note":
    case "question":
    case "replyHint":
      return MAX_TOOL_GENERIC_STRING_CHARS;
    default:
      return fallback;
  }
}

function slimStructuredValueForHistory(
  raw: unknown,
  options?: {
    defaultStringLimit?: number;
    maxDepth?: number;
    maxKeys?: number;
    maxArray?: number;
  },
  depth = 0,
): unknown {
  const defaultStringLimit = options?.defaultStringLimit ?? MAX_TOOL_GENERIC_STRING_CHARS;
  const maxDepth = options?.maxDepth ?? 4;
  const maxKeys = options?.maxKeys ?? 24;
  const maxArray = options?.maxArray ?? 24;

  if (typeof raw === "string") {
    return truncateForHistory(raw, defaultStringLimit);
  }
  if (raw == null || typeof raw !== "object") {
    return raw;
  }
  if (depth >= maxDepth) {
    return Array.isArray(raw) ? [] : {};
  }
  if (Array.isArray(raw)) {
    return raw
      .slice(0, maxArray)
      .map((item) => slimStructuredValueForHistory(item, options, depth + 1));
  }

  const out: Record<string, unknown> = {};
  let seen = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (seen >= maxKeys) break;
    seen += 1;
    if (typeof value === "string") {
      out[key] = truncateForHistory(value, getStructuredStringLimitForHistory(key, defaultStringLimit));
      continue;
    }
    out[key] = slimStructuredValueForHistory(
      value,
      {
        defaultStringLimit: getStructuredStringLimitForHistory(key, defaultStringLimit),
        maxDepth,
        maxKeys,
        maxArray,
      },
      depth + 1,
    );
  }
  return out;
}

function slimToolIoForHistory(toolName: string, io: unknown): unknown {
  const isMcpTool = toolName.startsWith("mcp.");
  return slimStructuredValueForHistory(io, {
    defaultStringLimit: isMcpTool ? MAX_TOOL_MCP_OUTPUT_CHARS : MAX_TOOL_GENERIC_STRING_CHARS,
    maxDepth: 5,
    maxKeys: 32,
    maxArray: 32,
  });
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
      toolStep.output = slimToolResultEnvelopeForHistory(toolStep.toolName, toolStep.output);
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
    ...(log.data !== undefined
      ? {
          data: slimStructuredValueForHistory(log.data, {
            defaultStringLimit: MAX_LOG_MESSAGE_HISTORY_CHARS,
            maxDepth: MAX_LOG_DATA_HISTORY_DEPTH,
            maxKeys: MAX_LOG_DATA_HISTORY_KEYS,
            maxArray: MAX_LOG_DATA_HISTORY_ARRAY,
          }),
        }
      : {}),
  }));
}

function slimRuntimeTurnForHistory(turn: RuntimeTurnRecord): RuntimeTurnRecord {
  if (!turn || typeof turn !== "object") return turn;
  const next = slimStructuredValueForHistory(turn, {
    defaultStringLimit: MAX_TOOL_GENERIC_STRING_CHARS,
    maxDepth: 4,
    maxKeys: 24,
    maxArray: 24,
  }) as RuntimeTurnRecord;
  return {
    ...next,
    ...(Array.isArray(turn.itemIds)
      ? {
          itemIds: clampTailForHistory(turn.itemIds, MAX_RUNTIME_TURN_ITEM_IDS_HISTORY).map((id) => String(id ?? "").trim()).filter(Boolean),
        }
      : {}),
    ...(turn.executionReport !== undefined
      ? {
          executionReport: slimStructuredValueForHistory(turn.executionReport, {
            defaultStringLimit: MAX_LOG_MESSAGE_HISTORY_CHARS,
            maxDepth: 3,
            maxKeys: 20,
            maxArray: 20,
          }) as Record<string, unknown> | null,
        }
      : {}),
  };
}

function slimRuntimeItemForHistory(item: RuntimeItemRecord): RuntimeItemRecord {
  if (!item || typeof item !== "object") return item;
  const toolName = String((item as any).name ?? (item as any).tool ?? (item as any).sourceToolName ?? "").trim();
  const next = slimStructuredValueForHistory(item, {
    defaultStringLimit: MAX_TOOL_GENERIC_STRING_CHARS,
    maxDepth: 4,
    maxKeys: 32,
    maxArray: 24,
  }) as RuntimeItemRecord;
  return {
    ...next,
    ...(typeof (item as any).text === "string"
      ? { text: truncateForHistory((item as any).text, MAX_RUNTIME_ITEM_TEXT_HISTORY_CHARS) }
      : {}),
    ...(typeof (item as any).message === "string"
      ? { message: truncateForHistory((item as any).message, MAX_TOOL_GENERIC_STRING_CHARS) }
      : {}),
    ...(typeof (item as any).summary === "string"
      ? { summary: truncateForHistory((item as any).summary, MAX_TOOL_GENERIC_STRING_CHARS) }
      : {}),
    ...(typeof (item as any).content === "string"
      ? { content: truncateForHistory((item as any).content, MAX_RUNTIME_ITEM_CONTENT_HISTORY_CHARS) }
      : {}),
    ...(typeof (item as any).error === "string"
      ? { error: truncateForHistory((item as any).error, MAX_TOOL_GENERIC_STRING_CHARS) }
      : {}),
    ...((item as any).args !== undefined ? { args: slimToolIoForHistory(toolName, (item as any).args) } : {}),
    ...((item as any).result !== undefined ? { result: slimToolResultEnvelopeForHistory(toolName, (item as any).result) } : {}),
  };
}

function compactRuntimeItemsForHistory(items?: RuntimeItemRecord[]) {
  const grouped = new Map<string, RuntimeItemRecord>();
  const aliasMap = new Map<string, string>();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const itemId = String((item as any).id ?? "").trim();
    if (!itemId) continue;
    const logicalKey =
      String((item as any).type ?? "").trim() === "toolCall"
        ? `tool:${String((item as any).toolCallId ?? "").trim() || itemId}`
        : `id:${itemId}`;
    const prev = grouped.get(logicalKey);
    const prevIsShadow = String((prev as any)?.shadowSource ?? "").trim() === "tool_step";
    const nextIsShadow = String((item as any)?.shadowSource ?? "").trim() === "tool_step";
    const keepIncoming = !prev || (prevIsShadow && !nextIsShadow);
    if (keepIncoming) {
      if (prev) aliasMap.set(String((prev as any).id ?? "").trim(), itemId);
      grouped.set(logicalKey, item);
    } else if (prev) {
      aliasMap.set(itemId, String((prev as any).id ?? "").trim());
    }
  }
  return { items: Array.from(grouped.values()), aliasMap };
}

function remapHistoryItemIds(ids: string[] | undefined, aliasMap: Map<string, string>) {
  return Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(aliasMap.get(String(id ?? "").trim()) ?? String(id ?? "").trim()).trim())
      .filter(Boolean),
  ));
}

function slimRuntimeThreadForHistory(thread: RuntimeThreadRecord | null | undefined): RuntimeThreadRecord | null {
  if (!thread || typeof thread !== "object") return thread ?? null;
  const next = slimStructuredValueForHistory(thread, {
    defaultStringLimit: MAX_TOOL_GENERIC_STRING_CHARS,
    maxDepth: 4,
    maxKeys: 24,
    maxArray: 20,
  }) as RuntimeThreadRecord;
  return {
    ...next,
    ...(Array.isArray(thread.pendingProposalIds)
      ? { pendingProposalIds: clampTailForHistory(thread.pendingProposalIds, MAX_THREAD_ID_LIST_HISTORY).map((id) => String(id ?? "").trim()).filter(Boolean) }
      : {}),
    ...(Array.isArray(thread.pendingApprovalIds)
      ? { pendingApprovalIds: clampTailForHistory(thread.pendingApprovalIds, MAX_THREAD_ID_LIST_HISTORY).map((id) => String(id ?? "").trim()).filter(Boolean) }
      : {}),
  };
}

function slimSnapshotForHistory(snapshot: RunSnapshot | null | undefined): RunSnapshot | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const compactedItems = compactRuntimeItemsForHistory((snapshot as any).items as RuntimeItemRecord[] | undefined);
  const stepsRaw = Array.isArray((snapshot as any).steps) ? ((snapshot as any).steps as any[]) : [];
  const stepsSlim: SerializableStep[] = stepsRaw.map((step) => slimStepForHistory(step));
  const logsSlim = slimLogsForHistory((snapshot as any).logs as LogEntry[]);
  const turnsSlim = clampTailForHistory((snapshot as any).turns as RuntimeTurnRecord[] | undefined, MAX_RUNTIME_TURNS_HISTORY)
    .map((turn) =>
      slimRuntimeTurnForHistory({
        ...(turn as RuntimeTurnRecord),
        ...(Array.isArray((turn as any)?.itemIds)
          ? { itemIds: remapHistoryItemIds((turn as any).itemIds as string[] | undefined, compactedItems.aliasMap) }
          : {}),
      }),
    );
  const itemsSlim = clampTailForHistory(compactedItems.items, MAX_RUNTIME_ITEMS_HISTORY)
    .map((item) => slimRuntimeItemForHistory(item));
  const collabSessionsSlim = clampTailForHistory(
    (snapshot as any).collabSessions as RuntimeCollabSessionRecord[] | undefined,
    MAX_COLLAB_SESSIONS_HISTORY,
  ).map((session) =>
    slimStructuredValueForHistory(session, {
      defaultStringLimit: MAX_TOOL_GENERIC_STRING_CHARS,
      maxDepth: 4,
      maxKeys: 24,
      maxArray: 20,
    }) as RuntimeCollabSessionRecord,
  );
  return {
    ...(snapshot as RunSnapshot),
    mainDoc: slimStructuredValueForHistory((snapshot as RunSnapshot).mainDoc ?? {}, {
      defaultStringLimit: MAX_SUMMARY_HISTORY_CHARS,
      maxDepth: 4,
      maxKeys: 32,
      maxArray: 24,
    }) as MainDoc,
    steps: stepsSlim,
    logs: logsSlim,
    thread: slimRuntimeThreadForHistory((snapshot as any).thread as RuntimeThreadRecord | null | undefined),
    turns: turnsSlim,
    items: itemsSlim,
    collabSessions: collabSessionsSlim,
    activeItemIds: clampTailForHistory(
      remapHistoryItemIds((snapshot as any).activeItemIds as string[] | undefined, compactedItems.aliasMap),
      MAX_RUNTIME_TURN_ITEM_IDS_HISTORY,
    ),
    dialogueSummaryByMode: slimStructuredValueForHistory((snapshot as any).dialogueSummaryByMode ?? null, {
      defaultStringLimit: MAX_SUMMARY_HISTORY_CHARS,
      maxDepth: 2,
      maxKeys: 8,
      maxArray: 8,
    }) as Record<Mode, string> | undefined,
  };
}

function getSnapshotStepsCount(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const steps = (raw as any).steps;
  return Array.isArray(steps) ? steps.length : 0;
}

function mergeListById<T extends { id?: string | number }>(prevList: T[] | undefined | null, incomingList: T[] | undefined | null): T[] {
  const prev = Array.isArray(prevList) ? prevList : [];
  const incoming = Array.isArray(incomingList) ? incomingList : [];
  if (!prev.length) return incoming;
  if (!incoming.length) return prev;

  const incomingById = new Map<string, T>();
  for (const item of incoming) {
    const id = String(item?.id ?? "").trim();
    if (!id) continue;
    incomingById.set(id, item);
  }

  const merged: T[] = [];
  const seen = new Set<string>();

  for (const item of prev) {
    const id = String(item?.id ?? "").trim();
    if (!id) {
      merged.push(item);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(incomingById.get(id) ?? item);
  }

  for (const item of incoming) {
    const id = String(item?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }

  return merged;
}

function mergeSnapshotForHistory(prev: RunSnapshot | null | undefined, incoming: RunSnapshot | null | undefined): RunSnapshot | null {
  if (!incoming || typeof incoming !== "object") return incoming ?? null;
  if (!prev || typeof prev !== "object") return incoming;
  return {
    ...incoming,
    steps: mergeListById(prev.steps as SerializableStep[] | undefined, incoming.steps as SerializableStep[] | undefined),
    logs: Array.isArray(incoming.logs) ? incoming.logs : prev.logs,
    turns: Array.isArray(incoming.turns) ? incoming.turns : prev.turns,
    items: Array.isArray(incoming.items) ? incoming.items : prev.items,
    collabSessions: Array.isArray(incoming.collabSessions) ? incoming.collabSessions : prev.collabSessions,
    activeItemIds: Array.isArray(incoming.activeItemIds) ? incoming.activeItemIds : prev.activeItemIds,
  };
}

/**
 * 从当前 runStore + projectStore 构建可序列化的 RunSnapshot。
 * 替代 NavSidebar / ChatArea 中的 inline buildSnapshot()。
 */
export function buildCurrentSnapshot(): RunSnapshot {
  const s = useRunStore.getState();
  const projectDir = useProjectStore.getState().rootDir ?? null;
  const normalizedCollabSessions = Array.isArray((s as any).collabSessions)
    ? (((s as any).collabSessions as RuntimeCollabSessionRecord[]).map((session) => ({ ...(session as any) })))
    : [];
  const projectedSteps = getProjectedStepsFromRuntime({
    steps: s.steps ?? [],
    items: ((s as any).items ?? []) as RuntimeItemRecord[],
    activeItemIds: ((s as any).activeItemIds ?? []) as string[],
    collabSessions: normalizedCollabSessions as RuntimeCollabSessionRecord[],
  });

  const rawSnapshot: RunSnapshot = {
    mode: s.mode,
    model: s.model,
    opMode: s.opMode,
    mainDoc: { ...(s.mainDoc ?? {}) },
    todoList: [...(s.todoList ?? [])],
    // steps / logs 统一交给 slimSnapshotForHistory 处理，避免 JSON 深拷贝大对象。
    steps: projectedSteps as any,
    logs: (s.logs ?? []) as any,
    kbAttachedLibraryIds: [...(s.kbAttachedLibraryIds ?? [])],
    ctxRefs: [...(s.ctxRefs ?? [])],
    pendingArtifacts: [...(((s as any).pendingArtifacts ?? []) as PendingArtifact[])],
    thread: sanitizeThreadCollabState(
      (s.thread && typeof s.thread === "object") ? (s.thread as RuntimeThreadRecord) : null,
      normalizedCollabSessions as RuntimeCollabSessionRecord[],
    ),
    turns: Array.isArray((s as any).turns) ? (((s as any).turns as RuntimeTurnRecord[]).map((turn) => ({ ...(turn as any) }))) : [],
    items: Array.isArray((s as any).items) ? (((s as any).items as RuntimeItemRecord[]).map((item) => ({ ...(item as any) }))) : [],
    collabSessions: normalizedCollabSessions as RuntimeCollabSessionRecord[],
    activeItemIds: Array.from(new Set(((s as any).activeItemIds ?? []).map((x: any) => String(x ?? "").trim()).filter(Boolean))),
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
  snapshotLoaded?: boolean;
  pinned?: boolean;
  /** 手动归档标记：归档后从“进行中”列表移至“已归档”分组 */
  archived?: boolean;
};

type HistoryWriteSource = "autosave" | "switch" | "shutdown" | "hydrate-repair" | "manual";

type HistoryOperation =
  | { type: "sync-order"; conversationIds: string[] }
  | {
      type: "upsert-meta";
      conversationId: string;
      patch: {
        title?: string;
        pinned?: boolean;
        archived?: boolean;
        createdAt?: number;
        updatedAt?: number;
      };
    }
  | { type: "write-body"; conversationId: string; snapshot: RunSnapshot; source: HistoryWriteSource }
  | { type: "write-draft"; draftSnapshot: RunSnapshot | null; draftSnapshotOwnerId?: string | null }
  | { type: "set-active"; conversationId: string | null }
  | { type: "delete-conversation"; conversationId: string }
  | { type: "clear-all" };

type HistoryOperationBatch = {
  version: 1;
  updatedAt: number;
  ops: HistoryOperation[];
};

type ConversationState = {
  conversations: Conversation[];
  /** 当前"草稿对话"（未归档到历史，也无需点 +），用于重启后自动恢复右侧内容 */
  draftSnapshot: RunSnapshot | null;
  draftSnapshotOwnerId: string | null;
  /** 当前活跃的对话 ID（发送首条消息时创建，侧边栏切换时设置） */
  activeConvId: string | null;
  hydrateFromDisk: () => Promise<void>;
  addConversation: (c: Omit<Conversation, "id" | "createdAt" | "updatedAt"> & { id?: string }) => string;
  deleteConversation: (id: string) => void;
  pinConversation: (id: string, pinned: boolean) => void;
  archiveConversation: (id: string, archived: boolean) => void;
  renameConversation: (id: string, title: string) => void;
  updateConversation: (id: string, patch: { snapshot?: RunSnapshot; title?: string }) => void;
  loadConversationSnapshot: (id: string, opts?: { includeSteps?: boolean }) => Promise<RunSnapshot | null>;
  setActiveConvId: (id: string | null) => void;
  setDraftSnapshot: (snap: RunSnapshot | null) => void;
  flushDraftSnapshotNow: (snap?: RunSnapshot | null) => Promise<void>;
  flushDraftSnapshotNowSync: (snap?: RunSnapshot | null) => void;
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

function createHistoryPlaceholderSnapshot(raw?: Partial<RunSnapshot> | null): RunSnapshot {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode = src.mode === "chat" ? "chat" : "agent";
  return {
    mode,
    model: String(src.model ?? ""),
    ...(src.opMode != null ? { opMode: src.opMode } : {}),
    mainDoc: src.mainDoc && typeof src.mainDoc === "object" ? (src.mainDoc as MainDoc) : ({} as MainDoc),
    todoList: Array.isArray(src.todoList) ? (src.todoList as TodoItem[]) : [],
    steps: Array.isArray(src.steps) ? (src.steps as SerializableStep[]) : [],
    logs: Array.isArray(src.logs) ? (src.logs as LogEntry[]) : [],
    kbAttachedLibraryIds: Array.isArray(src.kbAttachedLibraryIds) ? src.kbAttachedLibraryIds : [],
    ctxRefs: Array.isArray(src.ctxRefs) ? src.ctxRefs : [],
    pendingArtifacts: Array.isArray(src.pendingArtifacts) ? src.pendingArtifacts : [],
    thread: src.thread && typeof src.thread === "object" ? src.thread : null,
    turns: Array.isArray(src.turns) ? src.turns : [],
    items: Array.isArray(src.items) ? src.items : [],
    collabSessions: Array.isArray(src.collabSessions) ? src.collabSessions : [],
    activeItemIds: Array.isArray(src.activeItemIds) ? src.activeItemIds : [],
    projectDir: typeof src.projectDir === "string" ? src.projectDir : null,
    ...(src.dialogueSummaryByMode && typeof src.dialogueSummaryByMode === "object"
      ? { dialogueSummaryByMode: src.dialogueSummaryByMode }
      : {}),
    ...(src.dialogueSummaryTurnCursorByMode && typeof src.dialogueSummaryTurnCursorByMode === "object"
      ? { dialogueSummaryTurnCursorByMode: src.dialogueSummaryTurnCursorByMode }
      : {}),
  };
}

function mergeConversationSnapshotFromDisk(
  current: Conversation | null,
  incoming: RunSnapshot | null | undefined,
  opts?: { includeSteps?: boolean },
): { snapshot: RunSnapshot; snapshotLoaded: boolean } | null {
  if (!incoming || typeof incoming !== "object") return null;
  const currentSnapshot = current?.snapshot && typeof current.snapshot === "object" ? (current.snapshot as RunSnapshot) : null;
  const merged =
    repairConversationSnapshotForDisplay(
      current?.id ?? null,
      mergeSnapshotForHistory(currentSnapshot, incoming) ?? incoming,
    ) ?? incoming;
  const snapshotLoaded =
    opts?.includeSteps === true ||
    current?.snapshotLoaded !== false ||
    getSnapshotStepsCount(merged) > 0;
  return {
    snapshot: snapshotLoaded
      ? (slimSnapshotForHistory(merged) ?? merged)
      : createHistoryPlaceholderSnapshot(merged),
    snapshotLoaded,
  };
}

let diskHydrated = false;
/** 水化完成前禁止写盘，防止 hydrateFromDisk IPC 未返回时把 conversations:[] 覆盖掉已有数据 */
let diskWriteAllowed = false;
let persistTimer: any = null;
let pendingHistoryBatch: HistoryOperationBatch | null = null;

function hasDiskHistoryApi() {
  try {
    const historyApi = window.desktop?.history;
    return Boolean(
      (historyApi?.applyOperations || historyApi?.saveConversations) &&
      (historyApi?.loadConversationIndex || historyApi?.loadConversations),
    );
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

function schedulePersistToDisk(args: {
  conversations: Conversation[];
  draftSnapshot: RunSnapshot | null;
  draftSnapshotOwnerId?: string | null;
  activeConvIdOverride?: string | null;
  touchedConversationIds?: string[];
  deletedConversationIds?: string[];
  clearAll?: boolean;
  source?: HistoryWriteSource;
  sync?: boolean;
}) {
  const api = window.desktop?.history;
  if (!api?.applyOperations && !api?.saveConversations) return;

  const conversations = capConversations(args.conversations);
  const draftSnapshot = args.draftSnapshot ?? null;
  const activeConvId =
    args.activeConvIdOverride !== undefined
      ? normalizeId(args.activeConvIdOverride) || null
      : (useConversationStore?.getState?.()?.activeConvId ?? null);
  const draftSnapshotOwnerId =
    args.draftSnapshotOwnerId !== undefined
      ? normalizeId(args.draftSnapshotOwnerId) || null
      : normalizeId(useConversationStore?.getState?.()?.draftSnapshotOwnerId) || null;
  const touchedConversationIds = new Set(
    (Array.isArray(args.touchedConversationIds) ? args.touchedConversationIds : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  );
  const deletedConversationIds = Array.from(
    new Set(
      (Array.isArray(args.deletedConversationIds) ? args.deletedConversationIds : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    ),
  );
  const source = args.source ?? "manual";
  const ops: HistoryOperation[] = [];
  if (args.clearAll === true) {
    ops.push({ type: "clear-all" });
  }
  ops.push({
    type: "sync-order",
    conversationIds: conversations.map((conv) => String(conv.id ?? "").trim()).filter(Boolean),
  });
  for (const conv of conversations) {
    const convId = String(conv.id ?? "").trim();
    if (!convId) continue;
    ops.push({
      type: "upsert-meta",
      conversationId: convId,
      patch: {
        title: clampTitle(conv.title),
        pinned: Boolean(conv.pinned),
        archived: Boolean(conv.archived),
        createdAt: Number(conv.createdAt ?? Date.now()) || Date.now(),
        updatedAt: Number(conv.updatedAt ?? Date.now()) || Date.now(),
      },
    });
    if (touchedConversationIds.has(convId) && conv.snapshotLoaded !== false && conv.snapshot && typeof conv.snapshot === "object") {
      ops.push({
        type: "write-body",
        conversationId: convId,
        snapshot: conv.snapshot,
        source,
      });
    }
  }
  for (const convId of deletedConversationIds) {
    ops.push({ type: "delete-conversation", conversationId: convId });
  }
  ops.push({
    type: "write-draft",
    draftSnapshot,
    draftSnapshotOwnerId,
  });
  ops.push({
    type: "set-active",
    conversationId: normalizeId(activeConvId) || null,
  });
  const batch: HistoryOperationBatch = {
    version: 1,
    updatedAt: Date.now(),
    ops,
  };

  pendingHistoryBatch = pendingHistoryBatch
    ? {
        version: 1,
        updatedAt: batch.updatedAt,
        ops: [...pendingHistoryBatch.ops, ...batch.ops],
      }
    : batch;

  if (!diskWriteAllowed) return;

  const flush = () => {
    const next = pendingHistoryBatch;
    pendingHistoryBatch = null;
    persistTimer = null;
    if (!next || next.ops.length === 0) return;
    if (args.sync === true && api?.applyOperationsSync) {
      try {
        api.applyOperationsSync(next);
      } catch {
        void api.applyOperations?.(next).catch(() => void 0);
      }
      return;
    }
    if (api?.applyOperations) {
      void api.applyOperations(next).catch(() => void 0);
      return;
    }
  };

  if (args.sync === true) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    flush();
    return;
  }

  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    flush();
  }, 220);
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      draftSnapshot: null,
      draftSnapshotOwnerId: null,
      activeConvId: null,
      hydrateFromDisk: async () => {
        if (diskHydrated) return;
        diskHydrated = true;
        const api = window.desktop?.history;
        if (!api?.loadConversations && !api?.loadConversationIndex) {
          // 无 Electron disk API（纯浏览器模式），直接开放写权限
          diskWriteAllowed = true;
          return;
        }

        try {
          const pendingResPromise = api.loadPendingConversations
            ? api.loadPendingConversations().catch(() => null)
            : Promise.resolve(null);
          const indexRes = api.loadConversationIndex
            ? await api.loadConversationIndex().catch(() => null)
            : null;

          const hasUsableIndex =
            Boolean(indexRes) &&
            (indexRes as any)?.ok !== false &&
            (
              (Array.isArray((indexRes as any)?.conversations) && ((indexRes as any)?.conversations?.length ?? 0) > 0) ||
              Boolean((indexRes as any)?.draftSnapshot) ||
              Boolean((indexRes as any)?.activeConvId)
            );
          const legacyRes = !hasUsableIndex && api.loadConversations
            ? await api.loadConversations().catch(() => null)
            : null;
          const pendingRes = await pendingResPromise;
          const res = hasUsableIndex ? indexRes : legacyRes;
          if (!res) {
            throw new Error("history_load_failed");
          }
          if ((res as any)?.ok === false) {
            throw new Error(String((res as any)?.error || (res as any)?.detail || "history_load_failed"));
          }

          const diskListRaw = Array.isArray((res as any)?.conversations) ? ((res as any).conversations as any[]) : [];
          const diskList = hasUsableIndex
            ? diskListRaw.map((c) => ({
                id: String((c as any)?.id ?? "").trim(),
                title: clampTitle(String((c as any)?.title ?? "")),
                createdAt: Number((c as any)?.createdAt ?? Date.now()) || Date.now(),
                updatedAt: Number((c as any)?.updatedAt ?? Date.now()) || Date.now(),
                pinned: Boolean((c as any)?.pinned),
                archived: Boolean((c as any)?.archived),
                snapshot: createHistoryPlaceholderSnapshot(),
                snapshotLoaded: false,
              }))
            : diskListRaw;
          const diskDraft = ((res as any)?.draftSnapshot ?? null) as any;
          const diskDraftOwnerId = normalizeId((res as any)?.draftSnapshotOwnerId) || null;
          const diskActiveConvId = ((res as any)?.activeConvId ?? null) as string | null;

          const pendingPayload = pendingRes && (pendingRes as any).ok !== false ? (pendingRes as any).payload : null;
          const pendingList = Array.isArray(pendingPayload?.conversations) ? (pendingPayload.conversations as any[]) : [];
          const pendingDraft = pendingPayload?.draftSnapshot && typeof pendingPayload.draftSnapshot === "object" ? pendingPayload.draftSnapshot : null;
          const pendingDraftOwnerId = normalizeId(pendingPayload?.draftSnapshotOwnerId) || null;
          const pendingActiveConvId = typeof pendingPayload?.activeConvId === "string" ? pendingPayload.activeConvId : null;

          // 当前内存态（可能在 hydrate 尚未完成时，用户已经发了消息/产生草稿）
          const curConvs = get().conversations ?? [];
          const curDraft = get().draftSnapshot ?? null;
          const curDraftOwnerId = normalizeId(get().draftSnapshotOwnerId) || null;
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
            if ((c as any)?.snapshotLoaded === false) {
              return {
                ...c,
                snapshot: createHistoryPlaceholderSnapshot(snap ?? null),
                snapshotLoaded: false,
              };
            }
            const repaired = repairConversationSnapshotForDisplay(String((c as any)?.id ?? "").trim(), snap);
            const slim = slimSnapshotForHistory(repaired);
            return {
              ...c,
              snapshot: slim ? slim : createHistoryPlaceholderSnapshot(repaired ?? null),
              snapshotLoaded: true,
            };
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
          const draftCandidates: Array<{ snapshot: RunSnapshot; ownerId: string | null }> = [];
          if (curDraft && typeof curDraft === "object") {
            draftCandidates.push({ snapshot: curDraft as RunSnapshot, ownerId: curDraftOwnerId });
          }
          if (pendingDraft && typeof pendingDraft === "object") {
            draftCandidates.push({ snapshot: pendingDraft as RunSnapshot, ownerId: pendingDraftOwnerId });
          }
          if (diskDraft && typeof diskDraft === "object") {
            draftCandidates.push({ snapshot: diskDraft as RunSnapshot, ownerId: diskDraftOwnerId });
          }

          let finalDraftRaw: RunSnapshot | null = null;
          let finalDraftOwnerId: string | null = null;
          let bestSteps = -1;
          for (const candidate of draftCandidates) {
            const ownerId = candidate.ownerId && merged.some((c) => c.id === candidate.ownerId) ? candidate.ownerId : null;
            const snap = repairConversationSnapshotForDisplay(ownerId, candidate.snapshot);
            if (!snap || typeof snap !== "object") continue;
            const steps = getSnapshotStepsCount(snap);
            if (steps > bestSteps) {
              bestSteps = steps;
              finalDraftRaw = snap;
              finalDraftOwnerId = ownerId;
            }
          }

          // 草稿源都不存在时，尝试用当前 activeConv 的 snapshot 作为最近草稿
          if (!finalDraftRaw && finalActiveConvId) {
            const activeConv = merged.find((c) => c.id === finalActiveConvId);
            if (activeConv && activeConv.snapshotLoaded !== false && activeConv.snapshot && typeof activeConv.snapshot === "object") {
              finalDraftRaw = activeConv.snapshot as RunSnapshot;
              finalDraftOwnerId = finalActiveConvId;
            }
          }

          const finalDraft = finalDraftRaw
            ? slimSnapshotForHistory(finalDraftRaw as any) ?? finalDraftRaw
            : null;

          set({
            conversations: merged,
            draftSnapshot: finalDraft as any,
            draftSnapshotOwnerId: finalDraftOwnerId,
            activeConvId: finalActiveConvId,
          } as any);

          // 水化成功后开放写权限，并把最终态同步回磁盘
          diskWriteAllowed = true;
          const shouldSyncImmediately = !hasUsableIndex || Boolean(pendingPayload) || (curConvs?.length ?? 0) > 0;
          if (shouldSyncImmediately) {
            schedulePersistToDisk({
              conversations: merged,
              draftSnapshot: (finalDraft as any) ?? null,
              draftSnapshotOwnerId: finalDraftOwnerId,
              touchedConversationIds: merged.filter((item) => item.snapshotLoaded !== false).map((item) => item.id),
              clearAll: true,
              source: "hydrate-repair",
            });
          }
          void api.clearPendingConversations?.().catch(() => void 0);

          // 并把 localStorage 写回一个"很小的占位"，清掉旧的大对象（避免下一次 setItem 直接 quota 崩溃）
          try {
            safeLocalStorage.setItem(
              "writing-ide.conversations.v1",
              JSON.stringify({ state: { conversations: [], draftSnapshot: null, draftSnapshotOwnerId: null }, version: 1 }),
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
        const safeSnapshot = repairConversationSnapshotForDisplay(id, c.snapshot) ?? c.snapshot;
        const next: Conversation = {
          id,
          title: clampTitle(c.title),
          createdAt: now,
          updatedAt: now,
          snapshot: safeSnapshot,
          snapshotLoaded: true,
          ...(c.pinned != null ? { pinned: c.pinned } : {}),
          ...(c.archived != null ? { archived: c.archived } : {}),
        };
        set(() => {
          const prev = get().conversations ?? [];
          const merged = [next, ...prev.filter((x) => x.id !== id)];
          const capped = capConversations(merged);
          schedulePersistToDisk({
            conversations: capped,
            draftSnapshot: get().draftSnapshot ?? null,
            draftSnapshotOwnerId: get().draftSnapshotOwnerId ?? null,
            touchedConversationIds: [id],
            source: "manual",
          });
          return { conversations: capped };
        });
        return id;
      },
      deleteConversation: (id) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).filter((x) => x.id !== v);
          const nextDraftOwnerId = get().draftSnapshotOwnerId === v ? null : get().draftSnapshotOwnerId;
          const nextDraft = nextDraftOwnerId ? get().draftSnapshot : null;
          const nextActiveConvId = get().activeConvId === v ? null : get().activeConvId;
          schedulePersistToDisk({
            conversations: next,
            draftSnapshot: nextDraft ?? null,
            draftSnapshotOwnerId: nextDraftOwnerId,
            activeConvIdOverride: nextActiveConvId,
            deletedConversationIds: [v],
            source: "manual",
          });
          return {
            conversations: next,
            activeConvId: nextActiveConvId,
            ...(nextDraftOwnerId ? {} : { draftSnapshot: null, draftSnapshotOwnerId: null }),
          };
        });
      },
      pinConversation: (id, pinned) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) =>
            x.id === v ? { ...x, pinned, updatedAt: Date.now() } : x,
          );
          schedulePersistToDisk({
            conversations: next,
            draftSnapshot: get().draftSnapshot ?? null,
            draftSnapshotOwnerId: get().draftSnapshotOwnerId ?? null,
            source: "manual",
          });
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
          schedulePersistToDisk({
            conversations: next,
            draftSnapshot: get().draftSnapshot ?? null,
            draftSnapshotOwnerId: get().draftSnapshotOwnerId ?? null,
            source: "manual",
          });
          return { conversations: next };
        });
      },
      renameConversation: (id, title) => {
        const v = String(id ?? "").trim();
        if (!v) return;
        set((s) => {
          const next = (s.conversations ?? []).map((x) => (x.id === v ? { ...x, title: clampTitle(title), updatedAt: Date.now() } : x));
          schedulePersistToDisk({
            conversations: next,
            draftSnapshot: get().draftSnapshot ?? null,
            draftSnapshotOwnerId: get().draftSnapshotOwnerId ?? null,
            source: "manual",
          });
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
              const mergedSnapshot =
                mergeSnapshotForHistory(nextSnapshot as RunSnapshot | null, incoming) ?? incoming;
              nextSnapshot = repairConversationSnapshotForDisplay(v, mergedSnapshot) ?? mergedSnapshot;
            }
            return {
              ...x,
              ...(patch.title != null ? { title: clampTitle(patch.title) } : {}),
              ...(patch.snapshot != null ? { snapshot: nextSnapshot } : {}),
              ...(patch.snapshot != null ? { snapshotLoaded: true } : {}),
              updatedAt: Date.now(),
            };
          });
          schedulePersistToDisk({
            conversations: next,
            draftSnapshot: get().draftSnapshot ?? null,
            draftSnapshotOwnerId: get().draftSnapshotOwnerId ?? null,
            touchedConversationIds: patch.snapshot != null ? [v] : [],
            source: patch.snapshot != null ? "autosave" : "manual",
          });
          return { conversations: next };
        });
      },
      loadConversationSnapshot: async (id, opts) => {
        const convId = String(id ?? "").trim();
        if (!convId) return null;
        const current = (get().conversations ?? []).find((c) => c.id === convId) ?? null;
        const includeSteps = opts?.includeSteps === true;
        if (current?.snapshotLoaded !== false && current?.snapshot) {
          if (!includeSteps || (Array.isArray((current.snapshot as any)?.steps) && (current.snapshot as any).steps.length > 0)) {
            return current.snapshot;
          }
        }
        const api = window.desktop?.history?.readConversationSnapshot;
        if (!api) {
          return current?.snapshotLoaded !== false ? (current?.snapshot ?? null) : null;
        }
        try {
          const res: any = await api({ conversationId: convId, includeSteps });
          if (!res || res.ok === false || !res.snapshot || typeof res.snapshot !== "object") {
            return current?.snapshotLoaded !== false ? (current?.snapshot ?? null) : null;
          }
          const merged = mergeConversationSnapshotFromDisk(current, res.snapshot as RunSnapshot, { includeSteps });
          if (!merged) {
            return current?.snapshotLoaded !== false ? (current?.snapshot ?? null) : null;
          }
          set((s) => ({
            conversations: (s.conversations ?? []).map((item) =>
              item.id === convId ? { ...item, snapshot: merged.snapshot, snapshotLoaded: merged.snapshotLoaded } : item,
            ),
          }));
          return merged.snapshot;
        } catch {
          return current?.snapshotLoaded !== false ? (current?.snapshot ?? null) : null;
        }
      },
      setActiveConvId: (id) => {
        set({ activeConvId: id });
        // activeConvId 变更需要落盘，避免重启后丢失导致重复创建对话
        const s = get();
        schedulePersistToDisk({
          conversations: s.conversations ?? [],
          draftSnapshot: s.draftSnapshot ?? null,
          draftSnapshotOwnerId: s.draftSnapshotOwnerId ?? null,
          source: "manual",
        });
      },
      setDraftSnapshot: (snap) => {
        const nextRaw = snap && typeof snap === "object" ? (snap as any) : null;
        const prevDraft = get().draftSnapshot ?? null;
        const ownerId = normalizeId(get().activeConvId) || null;
        const prevOwnerId = normalizeId(get().draftSnapshotOwnerId) || null;
        const baseNext = nextRaw ? repairConversationSnapshotForDisplay(ownerId, nextRaw as RunSnapshot) ?? nextRaw : null;
        const merged =
          baseNext == null
            ? null
            : ownerId && prevOwnerId && ownerId === prevOwnerId
              ? mergeSnapshotForHistory(prevDraft, baseNext as RunSnapshot) ?? baseNext
              : baseNext;
        const repaired = merged ? repairConversationSnapshotForDisplay(ownerId, merged) ?? merged : null;
        const next = repaired ? slimSnapshotForHistory(repaired) ?? repaired : null;
        set(() => {
          const conversations = get().conversations ?? [];
          schedulePersistToDisk({
            conversations,
            draftSnapshot: next,
            draftSnapshotOwnerId: ownerId,
            source: "autosave",
          });
          return { draftSnapshot: next, draftSnapshotOwnerId: ownerId };
        });
      },
      flushDraftSnapshotNow: async (snap) => {
        const base =
          snap && typeof snap === "object"
            ? (snap as any)
            : snap === null
              ? null
              : buildCurrentSnapshot();
        const activeConvId = get().activeConvId;
        const ownerId = normalizeId(activeConvId) || null;
        const candidateRaw = base ? repairConversationSnapshotForDisplay(ownerId, base as any) ?? base : null;
        const candidate = candidateRaw ? slimSnapshotForHistory(candidateRaw as any) ?? candidateRaw : null;
        const prevConversations = get().conversations ?? [];
        const conversations = activeConvId
          ? prevConversations.map((x) => {
              if (x.id !== activeConvId) return x;
              const prevSnap = x.snapshot as any;
              const safeSnapshot =
                candidate == null
                  ? null
                  : repairConversationSnapshotForDisplay(
                      activeConvId,
                      mergeSnapshotForHistory(prevSnap as RunSnapshot | null, candidate as RunSnapshot) ?? candidate,
                    ) ?? candidate;
              return { ...x, snapshot: safeSnapshot, snapshotLoaded: true, updatedAt: Date.now() };
            })
          : prevConversations;

        const prevDraft = get().draftSnapshot as any;
        const prevDraftOwnerId = normalizeId(get().draftSnapshotOwnerId) || null;
        const nextDraft =
          candidate == null
            ? null
            : ownerId && prevDraftOwnerId && ownerId === prevDraftOwnerId
              ? repairConversationSnapshotForDisplay(
                  ownerId,
                  mergeSnapshotForHistory(prevDraft as RunSnapshot | null, candidate as RunSnapshot) ?? candidate,
                ) ?? candidate
              : candidate;

        set({ draftSnapshot: nextDraft as any, draftSnapshotOwnerId: ownerId, conversations });

        schedulePersistToDisk({
          conversations,
          draftSnapshot: nextDraft as any,
          draftSnapshotOwnerId: ownerId,
          touchedConversationIds: activeConvId ? [activeConvId] : [],
          source: "shutdown",
          sync: true,
        });
      },
      flushDraftSnapshotNowSync: (snap) => {
        const base =
          snap && typeof snap === "object"
            ? (snap as any)
            : snap === null
              ? null
              : buildCurrentSnapshot();
        const activeConvId = get().activeConvId;
        const ownerId = normalizeId(activeConvId) || null;
        const candidateRaw = base ? repairConversationSnapshotForDisplay(ownerId, base as any) ?? base : null;
        const candidate = candidateRaw ? slimSnapshotForHistory(candidateRaw as any) ?? candidateRaw : null;
        const prevConversations = get().conversations ?? [];
        const conversations = activeConvId
          ? prevConversations.map((x) => {
              if (x.id !== activeConvId) return x;
              const prevSnap = x.snapshot as any;
              const safeSnapshot =
                candidate == null
                  ? null
                  : repairConversationSnapshotForDisplay(
                      activeConvId,
                      mergeSnapshotForHistory(prevSnap as RunSnapshot | null, candidate as RunSnapshot) ?? candidate,
                    ) ?? candidate;
              return { ...x, snapshot: safeSnapshot, snapshotLoaded: true, updatedAt: Date.now() };
            })
          : prevConversations;

        const prevDraft = get().draftSnapshot as any;
        const prevDraftOwnerId = normalizeId(get().draftSnapshotOwnerId) || null;
        const nextDraft =
          candidate == null
            ? null
            : ownerId && prevDraftOwnerId && ownerId === prevDraftOwnerId
              ? repairConversationSnapshotForDisplay(
                  ownerId,
                  mergeSnapshotForHistory(prevDraft as RunSnapshot | null, candidate as RunSnapshot) ?? candidate,
                ) ?? candidate
              : candidate;

        set({ draftSnapshot: nextDraft as any, draftSnapshotOwnerId: ownerId, conversations });

        schedulePersistToDisk({
          conversations,
          draftSnapshot: nextDraft as any,
          draftSnapshotOwnerId: ownerId,
          touchedConversationIds: activeConvId ? [activeConvId] : [],
          source: "shutdown",
          sync: true,
        });
      },
      clearAll: () =>
        set(() => {
          schedulePersistToDisk({
            conversations: [],
            draftSnapshot: null,
            draftSnapshotOwnerId: null,
            activeConvIdOverride: null,
            clearAll: true,
            source: "manual",
          });
          return { conversations: [], draftSnapshot: null, draftSnapshotOwnerId: null, activeConvId: null };
        }),
    }),
    {
      name: "writing-ide.conversations.v1",
      // 关键：历史对话与草稿快照都落盘到 userData（history.saveConversations）。
      // localStorage 只存"极小占位"用于兜底（否则会因 5MB 配额触发 QuotaExceededError，导致渲染崩溃）。
      storage: createJSONStorage(() => safeLocalStorage as any),
      partialize: (s) => {
        // Electron 环境：磁盘 API 负责持久化，localStorage 只存极小占位
        if (hasDiskHistoryApi()) {
          return { conversations: [], draftSnapshot: null, draftSnapshotOwnerId: null, activeConvId: null };
        }
        // 非 Electron 环境（纯浏览器 dev / Web）：localStorage 作为唯一持久化方式
        // 限制最多 10 条以控制体积，避免 QuotaExceededError
        const capped = (s.conversations ?? []).slice(0, 10);
        return {
          conversations: capped,
          draftSnapshot: s.draftSnapshot ?? null,
          draftSnapshotOwnerId: s.draftSnapshotOwnerId ?? null,
          activeConvId: s.activeConvId ?? null,
        };
      },
    },
  ),
);
