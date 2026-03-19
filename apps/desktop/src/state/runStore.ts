import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ItemActionSpec } from "@ohmycrab/shared";
import type { ProjectSnapshot } from "./projectStore";

export type Mode = "agent" | "chat";
export type OpMode = "creative" | "assistant";
export type ToolApplyPolicy = "proposal" | "auto_apply";
export type ToolRiskLevel = "low" | "medium" | "high";

export type CtxRefItem = { kind: "file" | "dir"; path: string };

export type ImageAttachment = { mediaType: string; data: string; name: string };

export type MainDoc = {
  goal?: string;
  path?: string;
  // 结构化意图（优先于正则启发式；用于后端门禁/skills 自动启用）
  runIntent?: "auto" | "writing" | "rewrite" | "polish" | "analysis" | "ops";
  platformType?: "feed_preview" | "search_click" | "long_subscription";
  audience?: string;
  persona?: string;
  tone?: string;
  sourcesPolicy?: "user_only" | "kb" | "web" | "kb_and_web";
  topic?: string;
  angle?: string;
  title?: string;
  outline?: string;
  // 风格 Lint 未通过时的策略（用于 Context Pack 注入与后端行为）
  styleLintFailPolicy?: "ask_user" | "keep_best" | "skip";
  // M3：风格契约（由“写法候选/anchors/默认写法”生成；跨回合注入，作为仿写的硬约束地基）
  // 说明：保持短小可验证，不要塞长原文。
  styleContractV1?: any;
  taskStateV2?: RuntimeTaskStateV2 | null;
  threadWaitingFor?: RuntimeThreadRecord["waitingFor"];
};

export type TodoStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
};

export type UserMention = { id: string; label: string; type: string };

export type UserStep = {
  id: string;
  type: "user";
  text: string;
  ts: number;
  edited?: boolean;
  mentions?: UserMention[];
  images?: ImageAttachment[];
  // 用于“从历史消息提交”时回滚（文件 + 主文档）
  baseline?: {
    project: ProjectSnapshot;
    mainDoc: MainDoc;
    todoList: TodoItem[];
    ctxRefs?: CtxRefItem[];
  };
};

export type AssistantStep = {
  id: string;
  type: "assistant";
  text: string;
  streaming?: boolean;
  hidden?: boolean;
  variant?: "default" | "progress";
  quickActions?: Array<
    | "open_kb_manager"
    | "kb_done_continue"
    | "file_op_deny"
    | "file_op_allow_once"
    | "file_op_always_allow"
  >;
  /** Sub-agent ID (if this message is from a sub-agent) */
  agentId?: string;
  /** Sub-agent display name */
  agentName?: string;
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

  // proposal-first: Keep apply then mark applied/undoable
  apply?: () => void | { undo?: () => void } | Promise<void | { undo?: () => void }>;

  undoable: boolean;
  undo?: () => void;

  /** Sub-agent ID (if this tool call is from a sub-agent) */
  agentId?: string;
};

export type Step = UserStep | AssistantStep | ToolBlockStep;

export type LogEntry = {
  id: string;
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
};

export type RunActivity = {
  text: string;
  startedAt: number; // 用于 UI 显示耗时
};

export type PendingArtifact = {
  id: string;
  kind: "doc_write";
  status: "pending" | "used" | "discarded";
  pathHint: string;
  format: "md" | "txt" | "json" | "unknown";
  content: string;
  ifExists?: "rename" | "overwrite" | "error";
  suggestedName?: string;
  sourceTool?: "write";
  sourceTask?: string;
  createdAt: number;
  updatedAt: number;
};

export type RuntimeSkillRef = {
  id: string;
  source?: "builtin" | "user" | "admin";
  activation?: "explicit" | "auto" | "sticky";
  scope?: "thread" | "turn";
  configPath?: string | null;
  enabled?: boolean;
};

export type RuntimeCollabAgentRef = {
  threadId: string;
  agentId: string;
  agentName?: string;
  role?: string;
  status?: "running" | "waiting" | "completed" | "failed" | "closed";
};

export type RuntimeTaskStateV2 = {
  runIntent?: "auto" | "writing" | "rewrite" | "polish" | "analysis" | "ops";
  workflow?: {
    kind?: string;
    status?: "running" | "waiting_user" | "waiting_approval" | "done" | "failed";
    updatedAt?: string;
  } | null;
  compositeTask?: Record<string, unknown> | null;
  pendingArtifacts?: Array<{
    id: string;
    kind: string;
    status: "pending" | "used" | "discarded";
    pathHint?: string;
    updatedAt?: string;
  }>;
};

export type RuntimeThreadRecord = {
  id: string;
  convId?: string | null;
  status?: "idle" | "running" | "waiting" | "completed" | "failed";
  waitingFor?: "none" | "user" | "approval";
  waiting?: {
    kind?: "clarify" | "proposal" | "approval" | "resume_or_narrow" | "login_or_choice";
    question?: string;
    replyHint?: string;
    sourceTurnId?: string;
    updatedAt?: string;
  } | null;
  activeSkillRefs?: RuntimeSkillRef[];
  activeCollabAgents?: RuntimeCollabAgentRef[];
  pendingProposalIds?: string[];
  pendingApprovalIds?: string[];
  taskState?: RuntimeTaskStateV2 | null;
  createdAt?: string;
  updatedAt?: string;
};

export type RuntimeTurnRecord = {
  id: string;
  threadId: string;
  seq?: number;
  status?: "in_progress" | "completed" | "failed" | "aborted" | "interrupted";
  startedAt?: string;
  completedAt?: string;
  reason?: string;
  reasonCodes?: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  } | null;
  itemIds?: string[];
  executionReport?: Record<string, unknown> | null;
};

export type RuntimeItemRecord = {
  id: string;
  threadId: string;
  turnId: string;
  type?: string;
  status?: "in_progress" | "completed" | "failed" | "declined";
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

type ItemActionRuntime = {
  spec?: ItemActionSpec | null;
  apply?: () => void | { undo?: () => void } | Promise<void | { undo?: () => void }>;
  undo?: () => void | Promise<void>;
};

export type RuntimeCollabSessionRecord = {
  id: string;
  parentThreadId: string;
  childThreadId: string;
  agentId: string;
  role?: string;
  status?: "running" | "waiting" | "completed" | "failed" | "closed";
  inbox?: Array<{
    id: string;
    createdAt: string;
    kind: "user_message" | "system_message" | "tool_result";
    payload: Record<string, unknown>;
  }>;
  lastDeliveredInboxItemId?: string;
  waitState?: {
    kind: "join" | "user" | "approval";
    updatedAt: string;
  } | null;
  closeReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

// ─── 全局 Run 取消句柄（不放 store state，避免序列化问题） ─────────────────
let _activeRunCancel: ((reason?: string) => void) | null = null;
const _itemActionRuntimeById = new Map<string, ItemActionRuntime>();

export function setActiveRunCancel(fn: ((reason?: string) => void) | null) {
  _activeRunCancel = fn;
}

export function cancelActiveRun(reason = "manual_cancel") {
  if (!_activeRunCancel) return;
  const cancel = _activeRunCancel;
  _activeRunCancel = null;
  try { cancel(reason); } catch { /* ignore */ }
}

export function registerItemActionRuntime(
  itemId: string,
  runtime: ItemActionRuntime | null | undefined,
) {
  const id = String(itemId ?? "").trim();
  if (!id) return;
  if (!runtime) {
    _itemActionRuntimeById.delete(id);
    return;
  }
  const prev = _itemActionRuntimeById.get(id) ?? {};
  _itemActionRuntimeById.set(id, {
    ...prev,
    ...(runtime.spec !== undefined ? { spec: runtime.spec } : {}),
    ...(runtime.apply ? { apply: runtime.apply } : {}),
    ...(runtime.undo ? { undo: runtime.undo } : {}),
  });
}

export function getItemActionRuntime(itemId: string): ItemActionRuntime | null {
  const id = String(itemId ?? "").trim();
  return id ? (_itemActionRuntimeById.get(id) ?? null) : null;
}

export function clearItemActionRuntime(itemId?: string) {
  const id = String(itemId ?? "").trim();
  if (id) {
    _itemActionRuntimeById.delete(id);
    return;
  }
  _itemActionRuntimeById.clear();
}

type RunState = {
  mode: Mode;
  opMode: OpMode;
  /** Chat 模式选中的模型（可与 Agent 分开记忆） */
  chatModel: string;
  /** Agent 模式选中的模型 */
  agentModel: string;
  model: string;
  /** 对话滚动摘要（按 mode 存储；用于长对话上下文压缩） */
  dialogueSummaryByMode: Record<Mode, string>;
  /** 已纳入摘要的”完整回合数”（turn cursor），用于增量滚动 */
  dialogueSummaryTurnCursorByMode: Record<Mode, number>;
  /** 已完成记忆提取的”完整回合数”（turn cursor），用于提取去重 */
  memoryExtractTurnCursorByMode: Record<Mode, number>;

  mainDoc: MainDoc;
  todoList: TodoItem[];
  steps: Step[];
  logs: LogEntry[];
  thread: RuntimeThreadRecord | null;
  turns: RuntimeTurnRecord[];
  items: RuntimeItemRecord[];
  collabSessions: RuntimeCollabSessionRecord[];
  activeItemIds: string[];
  isRunning: boolean;
  activity: RunActivity | null;

  /** 会话历史窗口信息（用于滚动加载与迷你地图） */
  historyWindow?: {
    hasMoreBefore: boolean;
  };

  // KB：右侧 Agent 关联的库（多选；持久化，便于常用库默认保持关联）
  kbAttachedLibraryIds: string[];
  setKbAttachedLibraries: (ids: string[]) => void;
  toggleKbAttachedLibrary: (id: string) => void;
  clearKbAttachedLibraries: () => void;

  // Workflow Skills：上一轮运行时的闭环快照（写入 TASK_STATE，指导续跑补步骤）
  workflowSkills?: Record<string, { status: "not_started" | "in_progress" | "completed" | "degraded"; missingSteps?: string[] }>;
  setWorkflowSkills: (skills: Record<string, { status: "not_started" | "in_progress" | "completed" | "degraded"; missingSteps?: string[] }>) => void;

  // Context：常驻“引用文件/目录”列表（用于构建 REFERENCES；不随输入框清空而丢失）
  ctxRefs: CtxRefItem[];
  pendingArtifacts: PendingArtifact[];
  setCtxRefs: (items: CtxRefItem[]) => void;
  addCtxRef: (item: CtxRefItem) => void;
  removeCtxRef: (item: CtxRefItem) => void;
  clearCtxRefs: () => void;
  upsertPendingArtifact: (artifact: PendingArtifact) => void;
  removePendingArtifact: (artifactId: string) => void;
  markPendingArtifactUsed: (artifactId: string) => void;
  clearPendingArtifacts: () => void;
  startFreshWritingTaskBoundary: () => void;

  setMode: (mode: Mode) => void;
  setOpMode: (mode: OpMode) => void;
  setModel: (model: string) => void;
  setModelForMode: (mode: "chat" | "agent", model: string) => void;
  setDialogueSummary: (mode: Mode, summary: string, cursorTurns: number) => void;
  setMemoryExtractTurnCursor: (mode: Mode, cursorTurns: number) => void;
  setMainDoc: (mainDoc: MainDoc) => void;
  setThread: (thread: RuntimeThreadRecord | null) => void;
  setTurns: (turns: RuntimeTurnRecord[]) => void;
  upsertTurn: (turn: RuntimeTurnRecord) => void;
  setItems: (items: RuntimeItemRecord[]) => void;
  upsertItem: (item: RuntimeItemRecord) => void;
  setCollabSessions: (sessions: RuntimeCollabSessionRecord[]) => void;
  upsertCollabSession: (session: RuntimeCollabSessionRecord) => void;
  setActiveItemIds: (itemIds: string[]) => void;
  resetRun: () => void;
  /** 仅清空对话步骤/日志（保留 MainDoc/Todo/Refs/绑定库），用于“清空当前对话但不丢计划” */
  clearConversationSteps: () => void;
  // 会话/历史：加载一段历史快照到当前 Run（用于“对话历史/切换”）
  loadSnapshot: (snap: {
    mode: Mode;
    model: string;
    opMode?: OpMode;
    mainDoc: MainDoc;
    todoList: TodoItem[];
    steps: Array<Step | Omit<ToolBlockStep, "apply" | "undo">>;
    logs: LogEntry[];
    kbAttachedLibraryIds: string[];
    ctxRefs?: CtxRefItem[];
    pendingArtifacts?: PendingArtifact[];
    thread?: RuntimeThreadRecord | null;
    turns?: RuntimeTurnRecord[];
    items?: RuntimeItemRecord[];
    collabSessions?: RuntimeCollabSessionRecord[];
    activeItemIds?: string[];
  }) => void;

  /** 在当前 steps 前面追加一段更早的历史步骤，用于滚动加载 */
  prependSteps: (olderSteps: Array<Step | Omit<ToolBlockStep, "apply" | "undo">>) => void;
  setHistoryWindowHasMoreBefore: (hasMore: boolean) => void;

  addUser: (text: string, baseline?: UserStep["baseline"], mentions?: UserMention[], images?: ImageAttachment[]) => string;
  patchUser: (stepId: string, patch: Partial<UserStep>) => void;
  truncateAfter: (stepId: string) => void; // 保留 stepId（包含它），清除其后
  truncateFrom: (stepId: string) => void; // 清除 stepId（包含它）及其后

  addAssistant: (
    initialText?: string,
    streaming?: boolean,
    hidden?: boolean,
    opts?: { agentId?: string; agentName?: string; quickActions?: AssistantStep["quickActions"]; variant?: AssistantStep["variant"] },
  ) => string;
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

  dispatchItemAction: (itemId: string, action: "keep" | "undo" | "approve" | "decline") => void;
  keepStep: (stepId: string) => void;
  undoStep: (stepId: string) => void;
  keepAllProposals: () => void;

  updateMainDoc: (patch: Partial<MainDoc>) => { undo: () => void };
  setTodoList: (items: TodoItem[]) => { undo: () => void };
  updateTodo: (id: string, patch: Partial<TodoItem>) => { undo: () => void };
  log: (level: LogEntry["level"], message: string, data?: unknown) => void;
  clearLogs: () => void;
  setRunning: (running: boolean) => void;
  setActivity: (text: string | null, opts?: { resetTimer?: boolean }) => void;
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeRefPath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+$/g, ""); // 统一不带末尾 /
  return s;
}

function normalizeCtxRef(item: CtxRefItem | null | undefined): CtxRefItem | null {
  const it = item && typeof item === "object" ? item : null;
  const kind = it?.kind === "dir" ? "dir" : "file";
  const path = normalizeRefPath(String((it as any)?.path ?? ""));
  if (!path) return null;
  return { kind, path };
}

function dedupeCtxRefs(items: CtxRefItem[]) {
  const seen = new Set<string>();
  const out: CtxRefItem[] = [];
  for (const it of items ?? []) {
    const norm = normalizeCtxRef(it);
    if (!norm) continue;
    const key = `${norm.kind}:${norm.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}


function normalizePendingArtifact(item: PendingArtifact | null | undefined): PendingArtifact | null {
  const it = item && typeof item === "object" ? item : null;
  const id = String((it as any)?.id ?? "").trim() || makeId("artifact");
  const pathHint = normalizeRefPath(String((it as any)?.pathHint ?? ""));
  const content = String((it as any)?.content ?? "");
  if (!pathHint || !content) return null;
  const status0 = String((it as any)?.status ?? "pending").trim().toLowerCase();
  const status = status0 === "used" || status0 === "discarded" ? status0 : "pending";
  const format0 = String((it as any)?.format ?? "unknown").trim().toLowerCase();
  const format = format0 === "md" || format0 === "txt" || format0 === "json" ? format0 : "unknown";
  const createdAt = Number.isFinite(Number((it as any)?.createdAt)) ? Math.max(0, Math.floor(Number((it as any).createdAt))) : Date.now();
  const updatedAt = Number.isFinite(Number((it as any)?.updatedAt)) ? Math.max(createdAt, Math.floor(Number((it as any).updatedAt))) : Date.now();
  const ifExists0 = String((it as any)?.ifExists ?? "").trim().toLowerCase();
  const ifExists = ifExists0 === "overwrite" || ifExists0 === "error" ? ifExists0 : ifExists0 === "rename" ? "rename" : undefined;
  const suggestedName = String((it as any)?.suggestedName ?? "").trim() || undefined;
  const sourceTask = String((it as any)?.sourceTask ?? "").trim() || undefined;
  return {
    id,
    kind: "doc_write",
    status: status as any,
    pathHint,
    format: format as any,
    content,
    ...(ifExists ? { ifExists: ifExists as any } : {}),
    ...(suggestedName ? { suggestedName } : {}),
    sourceTool: "write",
    ...(sourceTask ? { sourceTask } : {}),
    createdAt,
    updatedAt,
  };
}

function dedupePendingArtifacts(items: PendingArtifact[]) {
  const map = new Map<string, PendingArtifact>();
  for (const it of items ?? []) {
    const norm = normalizePendingArtifact(it);
    if (!norm) continue;
    map.set(norm.id, norm);
  }
  return Array.from(map.values()).sort((a, b) => a.updatedAt - b.updatedAt).slice(-3);
}

function upsertById<T extends { id: string }>(list: T[], nextItem: T): T[] {
  const arr = Array.isArray(list) ? list : [];
  const id = String(nextItem?.id ?? "").trim();
  if (!id) return arr;
  const idx = arr.findIndex((x) => String(x?.id ?? "") === id);
  if (idx < 0) return [...arr, nextItem];
  const out = arr.slice();
  out[idx] = nextItem;
  return out;
}

function stepStatusToItemStatus(step: ToolBlockStep): RuntimeItemRecord["status"] {
  if (step.status === "running") return "in_progress";
  if (step.status === "failed") return "failed";
  if (step.status === "undone") return "declined";
  return "completed";
}

function extractProposalPreview(step: ToolBlockStep) {
  const output = step.output && typeof step.output === "object" ? (step.output as any) : null;
  const input = step.input && typeof step.input === "object" ? (step.input as any) : null;
  const preview = output?.preview && typeof output.preview === "object" ? output.preview : null;
  const path =
    String(
      preview?.path ??
        output?.path ??
        output?.targetDir ??
        output?.artifact?.relPath ??
        output?.artifact?.absPath ??
        input?.path ??
        "",
    ).trim() || undefined;
  const diffUnified =
    typeof output?.diffUnified === "string"
      ? output.diffUnified
      : typeof preview?.diffUnified === "string"
        ? preview.diffUnified
        : undefined;
  const note =
    String(preview?.note ?? output?.note ?? "").trim() || undefined;
  return {
    preview: preview
      ? { ...preview, ...(path ? { path } : {}) }
      : path || diffUnified || note
        ? {
            ...(path ? { path } : {}),
            ...(diffUnified ? { diffUnified } : {}),
            ...(note ? { note } : {}),
          }
        : null,
    changes:
      path || diffUnified
        ? [
            {
              path: path ?? "",
              diff: diffUnified,
            },
          ]
        : [],
    note,
    path,
  };
}

function buildItemActionSpecFromToolStep(step: ToolBlockStep): ItemActionSpec | null {
  const meta = extractProposalPreview(step);
  if (step.applyPolicy !== "proposal" && !step.undoable) return null;
  return {
    executor: step.applyPolicy === "proposal" || step.undoable ? "desktop.fs" : "gateway.noop",
    applyOp: {
      toolName: step.toolName,
      ...(meta.path ? { path: meta.path } : {}),
    },
    undoOp: step.undoable
      ? {
          toolName: step.toolName,
          ...(meta.path ? { path: meta.path } : {}),
        }
      : undefined,
    canReplayAfterReload: false,
  };
}

function buildShadowItemFromToolStep(args: {
  step: ToolBlockStep;
  existingItem?: RuntimeItemRecord | null;
  threadId?: string | null;
  turnId?: string | null;
}): RuntimeItemRecord {
  const step = args.step;
  const existing = args.existingItem && typeof args.existingItem === "object" ? args.existingItem : null;
  const nowIso = new Date().toISOString();
  const threadId = String(args.threadId ?? existing?.threadId ?? "").trim() || "local-thread";
  const turnId = String(args.turnId ?? existing?.turnId ?? "").trim() || "local-turn";
  const looksLikeFileMutationTool =
    step.toolName === "write" ||
    step.toolName === "edit" ||
    step.toolName === "doc.restoreSnapshot" ||
    step.toolName === "doc.splitToDir" ||
    step.toolName === "lint.style" ||
    Boolean((step.output as any)?.preview?.diffUnified);
  if (step.applyPolicy === "proposal" || (step.undoable && looksLikeFileMutationTool)) {
    const meta = extractProposalPreview(step);
    return {
      id: step.id,
      threadId,
      turnId,
      type: "fileChange",
      status: stepStatusToItemStatus(step),
      createdAt: String((existing as any)?.createdAt ?? nowIso),
      updatedAt: nowIso,
      sourceToolName: step.toolName,
      riskLevel: step.riskLevel,
      applyPolicy: step.applyPolicy,
      preview: meta.preview,
      changes: meta.changes,
      note: meta.note,
      actionSpec: buildItemActionSpecFromToolStep(step),
      kept: step.kept,
      applied: step.applied,
      undoable: step.undoable,
      canUndo: step.undoable,
    } as RuntimeItemRecord;
  }
  return {
    id: step.id,
    threadId,
    turnId,
    type: "toolCall",
    status: stepStatusToItemStatus(step),
    createdAt: String((existing as any)?.createdAt ?? nowIso),
    updatedAt: nowIso,
    toolCallId: step.id,
    name: step.toolName,
    args: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? (step.input as Record<string, unknown>) : {},
    executedBy: "desktop",
    result: step.output,
    error: step.status === "failed" ? String((step.output as any)?.error ?? "TOOL_FAILED") : undefined,
    riskLevel: step.riskLevel,
    applyPolicy: step.applyPolicy,
  } as RuntimeItemRecord;
}

export function createShadowItemFromToolStep(args: {
  step: ToolBlockStep;
  existingItem?: RuntimeItemRecord | null;
  threadId?: string | null;
  turnId?: string | null;
}) {
  return buildShadowItemFromToolStep(args);
}

export const useRunStore = create<RunState>()(
  persist(
    (set, get) => ({
  mode: "agent",
  chatModel: "",
  agentModel: "",
  model: "",
  opMode: "creative",
  dialogueSummaryByMode: { agent: "", chat: "" },
  dialogueSummaryTurnCursorByMode: { agent: 0, chat: 0 },
  memoryExtractTurnCursorByMode: { agent: 0, chat: 0 },
  mainDoc: { goal: "" },
  todoList: [],
  steps: [],
  logs: [],
  thread: null,
  turns: [],
  items: [],
  collabSessions: [],
  activeItemIds: [],
  isRunning: false,
  activity: null,
  historyWindow: { hasMoreBefore: false },
  ctxRefs: [],
  pendingArtifacts: [],
  kbAttachedLibraryIds: [],
  workflowSkills: {},

  setMode: (mode) =>
    set((s) => {
      const nextModel = mode === "chat" ? s.chatModel || s.model : s.agentModel || s.model;
      return { mode, model: nextModel };
    }),
  setOpMode: (opMode) => set({ opMode }),
  setModel: (model) =>
    set((s) => {
      const v = String(model ?? "").trim();
      if (s.mode === "chat") return { model: v, chatModel: v };
      return { model: v, agentModel: v };
    }),
  setModelForMode: (modeKey, model) =>
    set((s) => {
      const v = String(model ?? "").trim();
      if (modeKey === "chat") return { chatModel: v, ...(s.mode === "chat" ? { model: v } : {}) };
      return { agentModel: v, ...(s.mode !== "chat" ? { model: v } : {}) };
    }),
  setMainDoc: (mainDoc) => set({ mainDoc }),
  setThread: (thread) => set({ thread: thread && typeof thread === "object" ? ({ ...(thread as any) } as RuntimeThreadRecord) : null }),
  setTurns: (turns) =>
    set({
      turns: Array.isArray(turns)
        ? turns
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeTurnRecord))
        : [],
    }),
  upsertTurn: (turn) =>
    set((s) => {
      if (!turn || typeof turn !== "object" || !String((turn as any).id ?? "").trim()) return {};
      const nextTurn = { ...(turn as any) } as RuntimeTurnRecord;
      return { turns: upsertById(s.turns, nextTurn) };
    }),
  setItems: (items) =>
    set({
      items: Array.isArray(items)
        ? items
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeItemRecord))
        : [],
    }),
  upsertItem: (item) =>
    set((s) => {
      if (!item || typeof item !== "object" || !String((item as any).id ?? "").trim()) return {};
      const nextItem = { ...(item as any) } as RuntimeItemRecord;
      return { items: upsertById(s.items, nextItem) };
    }),
  setCollabSessions: (sessions) =>
    set({
      collabSessions: Array.isArray(sessions)
        ? sessions
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeCollabSessionRecord))
        : [],
    }),
  upsertCollabSession: (session) =>
    set((s) => {
      if (!session || typeof session !== "object" || !String((session as any).id ?? "").trim()) return {};
      const nextSession = { ...(session as any) } as RuntimeCollabSessionRecord;
      return { collabSessions: upsertById(s.collabSessions, nextSession) };
    }),
  setActiveItemIds: (itemIds) =>
    set({
      activeItemIds: Array.from(
        new Set((Array.isArray(itemIds) ? itemIds : []).map((x) => String(x ?? "").trim()).filter(Boolean)),
      ),
    }),
  setDialogueSummary: (mode, summary, cursorTurns) =>
    set((s) => {
      const m: Mode = mode === "chat" ? "chat" : "agent";
      const nextSummary = String(summary ?? "");
      const nextCursor = Number.isFinite(Number(cursorTurns)) ? Math.max(0, Math.floor(Number(cursorTurns))) : 0;
      return {
        dialogueSummaryByMode: { ...s.dialogueSummaryByMode, [m]: nextSummary },
        dialogueSummaryTurnCursorByMode: { ...s.dialogueSummaryTurnCursorByMode, [m]: nextCursor },
      };
    }),
  setMemoryExtractTurnCursor: (mode, cursorTurns) =>
    set((s) => {
      const m: Mode = mode === "chat" ? "chat" : "agent";
      const prevCursor = Number.isFinite(Number(s.memoryExtractTurnCursorByMode?.[m]))
        ? Math.max(0, Math.floor(Number(s.memoryExtractTurnCursorByMode[m])))
        : 0;
      const nextCursor = Number.isFinite(Number(cursorTurns)) ? Math.max(0, Math.floor(Number(cursorTurns))) : 0;
      // 单调递增：不允许游标回退
      return {
        memoryExtractTurnCursorByMode: { ...s.memoryExtractTurnCursorByMode, [m]: Math.max(prevCursor, nextCursor) },
      };
    }),
  setRunning: (running) =>
    set((s) => ({
      isRunning: running,
      // run 结束/停止时，清空 activity，避免残留“像卡死”
      activity: running ? s.activity : null,
    })),
  setActivity: (text, opts) =>
    set((s) => {
      const t = text ? String(text).trim() : "";
      if (!t) return { activity: null };
      const prev = s.activity;
      const same = prev && prev.text === t;
      const resetTimer = Boolean(opts?.resetTimer);
      return {
        activity: {
          text: t,
          startedAt: same && !resetTimer ? prev!.startedAt : Date.now(),
        },
      };
    }),
  resetRun: () => {
    clearItemActionRuntime();
    set({
      steps: [],
      logs: [],
      isRunning: false,
      activity: null,
      mainDoc: { goal: "" },
      todoList: [],
      ctxRefs: [],
      pendingArtifacts: [],
      thread: null,
      turns: [],
      items: [],
      collabSessions: [],
      activeItemIds: [],
      workflowSkills: {},
      dialogueSummaryByMode: { agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode: { agent: 0, chat: 0 },
      memoryExtractTurnCursorByMode: { agent: 0, chat: 0 },
      historyWindow: { hasMoreBefore: false },
    });
  },
  clearConversationSteps: () => {
    clearItemActionRuntime();
    set({
      steps: [],
      logs: [],
      isRunning: false,
      activity: null,
      workflowSkills: {},
      thread: null,
      turns: [],
      items: [],
      collabSessions: [],
      activeItemIds: [],
      // 对话清空后摘要无意义：一并清掉，避免旧摘要被注入 Context Pack 造成跑偏
      dialogueSummaryByMode: { agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode: { agent: 0, chat: 0 },
      memoryExtractTurnCursorByMode: { agent: 0, chat: 0 },
    });
  },
  loadSnapshot: (snap) => {
    clearItemActionRuntime();
    const s = snap && typeof snap === "object" ? snap : ({} as any);
    const cleanSteps = Array.isArray(s.steps) ? s.steps : [];
    // 历史快照不携带可执行函数，统一清掉 apply/undo，并标记 undoable=false。
    // 同时做“契约修复”：确保 steps[].id 唯一（旧版本可能把 toolCallId=1/2/3… 当作 step.id，跨回合会重复，触发 wx:key 警告）。
    const seenIds = new Set<string>();
    const normalized: Step[] = cleanSteps.map((step: any) => {
      if (!step || typeof step !== "object") return step as any;
      const type0 = String((step as any).type ?? "");
      const prefix = type0 === "user" ? "u" : type0 === "assistant" ? "a" : type0 === "tool" ? "t" : "s";
      let id = typeof (step as any).id === "string" ? String((step as any).id) : "";
      if (!id || seenIds.has(id)) {
        let next = makeId(prefix);
        while (seenIds.has(next)) next = makeId(prefix);
        id = next;
      }
      seenIds.add(id);

      if (type0 === "tool") {
        const t = step as any;
        return {
          ...t,
          id,
          apply: undefined,
          undo: undefined,
          undoable: false,
        } as ToolBlockStep;
      }
      return { ...(step as any), id } as Step;
    });
    const mode = s.mode === "agent" || s.mode === "chat" ? s.mode : get().mode;
    const model = typeof s.model === "string" ? s.model : get().model;
    const opModeRaw = (s as any).opMode;
    const opMode: OpMode = opModeRaw === "assistant" ? "assistant" : "creative";
    const prev = get();
    const chatModel = mode === "chat" ? model : prev.chatModel;
    const agentModel = mode !== "chat" ? model : prev.agentModel;
    const ds = (s as any).dialogueSummaryByMode;
    const dc = (s as any).dialogueSummaryTurnCursorByMode;
    set({
      mode,
      model,
      chatModel,
      agentModel,
      opMode,
      dialogueSummaryByMode:
        ds && typeof ds === "object"
          ? {
              agent: String((ds as any).agent ?? ""),
              chat: String((ds as any).chat ?? ""),
            }
          : { agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode:
        dc && typeof dc === "object"
          ? {
              agent: Number.isFinite(Number((dc as any).agent)) ? Math.max(0, Math.floor(Number((dc as any).agent))) : 0,
              chat: Number.isFinite(Number((dc as any).chat)) ? Math.max(0, Math.floor(Number((dc as any).chat))) : 0,
            }
          : { agent: 0, chat: 0 },
      // memory 游标初始化对齐 summary 游标：加载已有快照时，summary cursor 以内的内容视为已处理，不重复提取
      memoryExtractTurnCursorByMode:
        dc && typeof dc === "object"
          ? {
              agent: Number.isFinite(Number((dc as any).agent)) ? Math.max(0, Math.floor(Number((dc as any).agent))) : 0,
              chat: Number.isFinite(Number((dc as any).chat)) ? Math.max(0, Math.floor(Number((dc as any).chat))) : 0,
            }
          : { agent: 0, chat: 0 },
      mainDoc: (s.mainDoc && typeof s.mainDoc === "object" ? s.mainDoc : get().mainDoc) as MainDoc,
      todoList: Array.isArray(s.todoList) ? (s.todoList as TodoItem[]) : [],
      steps: normalized,
      logs: Array.isArray(s.logs) ? (s.logs as LogEntry[]) : [],
      kbAttachedLibraryIds: Array.isArray((s as any).kbAttachedLibraryIds)
        ? Array.from(new Set(((s as any).kbAttachedLibraryIds as any[]).map((x: any) => String(x ?? "").trim()).filter(Boolean)))
        : [],
      ctxRefs: Array.isArray((s as any).ctxRefs) ? dedupeCtxRefs((s as any).ctxRefs as any) : [],
      pendingArtifacts: Array.isArray((s as any).pendingArtifacts) ? dedupePendingArtifacts((s as any).pendingArtifacts as any) : [],
      thread:
        (s as any).thread && typeof (s as any).thread === "object"
          ? ({ ...((s as any).thread as any) } as RuntimeThreadRecord)
          : null,
      turns: Array.isArray((s as any).turns)
        ? ((s as any).turns as any[])
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeTurnRecord))
        : [],
      items: Array.isArray((s as any).items)
        ? ((s as any).items as any[])
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeItemRecord))
        : [],
      collabSessions: Array.isArray((s as any).collabSessions)
        ? ((s as any).collabSessions as any[])
            .filter((x) => x && typeof x === "object" && String((x as any).id ?? "").trim())
            .map((x) => ({ ...(x as any) } as RuntimeCollabSessionRecord))
        : [],
      activeItemIds: Array.from(
        new Set((Array.isArray((s as any).activeItemIds) ? (s as any).activeItemIds : []).map((x: any) => String(x ?? "").trim()).filter(Boolean)),
      ),
      isRunning: false,
      activity: null,
      historyWindow: { hasMoreBefore: false },
    });
  },
  prependSteps: (olderSteps) =>
    set((s) => {
      const current = Array.isArray(s.steps) ? s.steps : [];
      const incoming = Array.isArray(olderSteps) ? olderSteps : [];
      if (!incoming.length) return {};
      const existingIds = new Set(current.map((x: any) => String(x?.id ?? "")));
      const filtered = incoming.filter((step: any) => {
        const id = String(step?.id ?? "");
        if (!id) return false;
        return !existingIds.has(id);
      }) as Step[];
      if (!filtered.length) return {};
      return { steps: [...filtered, ...current] };
    }),
  setHistoryWindowHasMoreBefore: (hasMore) =>
    set(() => ({
      historyWindow: { hasMoreBefore: Boolean(hasMore) },
    })),

  setKbAttachedLibraries: (ids) => {
    const unique = Array.from(new Set((ids ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
    set({ kbAttachedLibraryIds: unique });
  },
  toggleKbAttachedLibrary: (id) => {
    const v = String(id ?? "").trim();
    if (!v) return;
    const cur = get().kbAttachedLibraryIds ?? [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    set({ kbAttachedLibraryIds: next });
  },
  clearKbAttachedLibraries: () => set({ kbAttachedLibraryIds: [] }),

  setWorkflowSkills: (skills) => {
    const safe = skills && typeof skills === "object" ? skills : {};
    set({ workflowSkills: safe as any });
  },

  setCtxRefs: (items) => set({ ctxRefs: dedupeCtxRefs(Array.isArray(items) ? items : []) }),
  addCtxRef: (item) =>
    set((s) => {
      const norm = normalizeCtxRef(item);
      if (!norm) return {};
      const cur = Array.isArray(s.ctxRefs) ? s.ctxRefs : [];
      const exists = cur.some((x) => x.kind === norm.kind && x.path === norm.path);
      if (exists) return {};
      return { ctxRefs: [...cur, norm] };
    }),
  removeCtxRef: (item) =>
    set((s) => {
      const norm = normalizeCtxRef(item);
      if (!norm) return {};
      const cur = Array.isArray(s.ctxRefs) ? s.ctxRefs : [];
      return { ctxRefs: cur.filter((x) => !(x.kind === norm.kind && x.path === norm.path)) };
    }),
  clearCtxRefs: () => set({ ctxRefs: [] }),
  upsertPendingArtifact: (artifact) =>
    set((s) => {
      const norm = normalizePendingArtifact(artifact as any);
      if (!norm) return {};
      const cur = Array.isArray(s.pendingArtifacts) ? s.pendingArtifacts : [];
      const next = dedupePendingArtifacts([...cur.filter((x) => x.id !== norm.id), norm]);
      return { pendingArtifacts: next };
    }),
  removePendingArtifact: (artifactId) =>
    set((s) => ({
      pendingArtifacts: (Array.isArray(s.pendingArtifacts) ? s.pendingArtifacts : []).filter((x) => x.id !== String(artifactId ?? "").trim()),
    })),
  markPendingArtifactUsed: (artifactId) =>
    set((s) => ({
      pendingArtifacts: (Array.isArray(s.pendingArtifacts) ? s.pendingArtifacts : []).map((x) =>
        x.id === String(artifactId ?? "").trim() ? { ...x, status: "used", updatedAt: Date.now() } : x,
      ),
    })),
  clearPendingArtifacts: () => set({ pendingArtifacts: [] }),
  startFreshWritingTaskBoundary: () => {
    clearItemActionRuntime();
    set((s) => ({
      todoList: [],
      ctxRefs: [],
      pendingArtifacts: [],
      thread: null,
      turns: [],
      items: [],
      collabSessions: [],
      activeItemIds: [],
      isRunning: false,
      activity: null,
      mainDoc: {
        audience: s.mainDoc?.audience,
        persona: s.mainDoc?.persona,
        tone: s.mainDoc?.tone,
        platformType: s.mainDoc?.platformType,
        sourcesPolicy: s.mainDoc?.sourcesPolicy,
        styleLintFailPolicy: s.mainDoc?.styleLintFailPolicy,
        runIntent: "auto",
      },
      dialogueSummaryByMode: { agent: "", chat: "" },
      dialogueSummaryTurnCursorByMode: { agent: 0, chat: 0 },
      memoryExtractTurnCursorByMode: { agent: 0, chat: 0 },
    }));
  },

  addUser: (text, baseline, mentions, images) => {
    const id = makeId("u");
    const step: UserStep = {
      id, type: "user", text, ts: Date.now(), baseline,
      ...(mentions?.length ? { mentions } : {}),
      ...(images?.length ? { images } : {}),
    };
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

  addAssistant: (
    initialText = "",
    streaming = false,
    hidden = false,
    opts?: { agentId?: string; agentName?: string; quickActions?: AssistantStep["quickActions"]; variant?: AssistantStep["variant"] },
  ) => {
    const id = makeId("a");
    set((s) => ({
      steps: [
        ...s.steps,
        {
          id,
          type: "assistant" as const,
          text: initialText,
          streaming,
          hidden,
          variant: opts?.variant === "progress" ? "progress" : "default",
          ...(opts?.agentId ? { agentId: opts.agentId, agentName: opts.agentName } : {}),
          ...(Array.isArray(opts?.quickActions) && opts!.quickActions!.length ? { quickActions: opts!.quickActions } : {}),
        },
      ],
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
    set((s) => {
      const cur = s.steps.find((step) => step.id === stepId);
      if (!cur || cur.type !== "assistant") return {};
      const hasText = String(cur.text ?? "").trim().length > 0;
      const hasQuickActions = Array.isArray(cur.quickActions) && cur.quickActions.length > 0;
      if (!hasText && !hasQuickActions) {
        return { steps: s.steps.filter((step) => step.id !== stepId) };
      }
      return {
        steps: s.steps.map((step) =>
          step.id === stepId && step.type === "assistant"
            ? { ...step, streaming: false }
            : step,
        ),
      };
    }),
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
      ...(tool.agentId ? { agentId: tool.agentId } : {}),
    };
    const threadId = String((get().thread as any)?.id ?? "").trim() || "local-thread";
    const latestTurnId =
      String((get().turns ?? []).slice(-1)[0]?.id ?? "").trim() || "local-turn";
    const shadowItem = buildShadowItemFromToolStep({ step, threadId, turnId: latestTurnId });
    if (tool.applyPolicy === "proposal" || tool.undoable || tool.apply || tool.undo) {
      registerItemActionRuntime(id, {
        spec: buildItemActionSpecFromToolStep(step),
        ...(tool.apply ? { apply: tool.apply } : {}),
        ...(tool.undo ? { undo: tool.undo } : {}),
      });
    }
    set((s) => ({ steps: [...s.steps, step], items: upsertById(s.items, shadowItem) }));
    return id;
  },
  patchTool: (stepId, patch) =>
    set((s) => {
      let nextTool: ToolBlockStep | null = null;
      const nextSteps = s.steps.map((step) => {
        if (step.id === stepId && step.type === "tool") {
          nextTool = { ...step, ...patch };
          return nextTool;
        }
        return step;
      });
      const resolvedTool = nextTool as ToolBlockStep | null;
      if (resolvedTool && (resolvedTool.applyPolicy === "proposal" || resolvedTool.undoable || resolvedTool.apply || resolvedTool.undo)) {
        registerItemActionRuntime(stepId, {
          spec: buildItemActionSpecFromToolStep(resolvedTool),
          ...(resolvedTool.apply ? { apply: resolvedTool.apply } : {}),
          ...(resolvedTool.undo ? { undo: resolvedTool.undo } : {}),
        });
      }
      const nextItems = resolvedTool
        ? upsertById(
            s.items,
            buildShadowItemFromToolStep({
              step: resolvedTool,
              existingItem: s.items.find((item) => item.id === stepId) ?? null,
              threadId: String((s.thread as any)?.id ?? "").trim() || "local-thread",
              turnId: String((s.turns ?? []).slice(-1)[0]?.id ?? "").trim() || "local-turn",
            }),
          )
        : s.items;
      return { steps: nextSteps, items: nextItems };
    }),

  dispatchItemAction: (itemId, action) => {
    const id = String(itemId ?? "").trim();
    if (!id) return;
    const item = get().items.find((entry) => String(entry?.id ?? "") === id);
    if (!item) return;
    const runtime = getItemActionRuntime(id);
    const spec = runtime?.spec ?? ((item as any)?.actionSpec as ItemActionSpec | null | undefined) ?? null;
    const canReplay = spec?.canReplayAfterReload !== false;
    const noopExecutor = spec?.executor === "gateway.noop";
    const runApply = action === "keep" || action === "approve";
    const handler = runApply ? runtime?.apply : runtime?.undo;
    if (!handler && !noopExecutor && !canReplay) {
      get().log("warn", "item.action.unavailable", { itemId: id, action });
      return;
    }

    const setRunningState = () =>
      set((s) => ({
        steps: s.steps.map((step) =>
          step.id === id && step.type === "tool" ? { ...step, status: "running" } : step,
        ),
        items: s.items.map((entry) =>
          entry.id === id ? { ...entry, status: "in_progress", updatedAt: new Date().toISOString() } : entry,
        ),
      }));

    const finalize = (ret?: void | { undo?: () => void }) => {
      const undo = (ret as any)?.undo as (() => void) | undefined;
      if (undo) {
        registerItemActionRuntime(id, { undo });
      }
      const nowIso = new Date().toISOString();
      set((s) => ({
        steps: s.steps.map((step) => {
          if (step.id !== id || step.type !== "tool") return step;
          if (runApply) {
            return {
              ...step,
              status: "success",
              kept: true,
              applied: true,
              undoable: Boolean(undo) || step.undoable,
              undo: undo ?? step.undo,
            };
          }
          return { ...step, status: "undone", kept: false, applied: false };
        }),
        items: s.items.map((entry) => {
          if (entry.id !== id) return entry;
          return {
            ...entry,
            status: runApply ? "completed" : "declined",
            updatedAt: nowIso,
            ...(runApply ? { kept: true, applied: true, undoable: Boolean(undo) || Boolean((entry as any).undoable), canUndo: Boolean(undo) || Boolean((entry as any).canUndo) } : { kept: false, applied: false }),
          };
        }),
      }));
    };

    const fail = (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error ?? "ITEM_ACTION_FAILED");
      const nowIso = new Date().toISOString();
      set((s) => ({
        steps: s.steps.map((step) =>
          step.id === id && step.type === "tool" ? { ...step, status: "failed", output: { ok: false, error: msg } } : step,
        ),
        items: s.items.map((entry) =>
          entry.id === id ? { ...entry, status: "failed", updatedAt: nowIso, error: msg } as RuntimeItemRecord : entry,
        ),
      }));
      get().log("error", "item.action.failed", { itemId: id, action, error: msg });
    };

    if (!handler) {
      finalize();
      return;
    }

    try {
      const ret = handler();
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        setRunningState();
        void (ret as Promise<void | { undo?: () => void }>).then(finalize).catch(fail);
        return;
      }
      finalize(ret as void | { undo?: () => void });
    } catch (error) {
      fail(error);
    }
  },
  keepStep: (stepId) => {
    const item = get().items.find((entry) => String(entry?.id ?? "") === String(stepId ?? "").trim());
    if (item) {
      get().dispatchItemAction(stepId, "keep");
      return;
    }
    const step = get().steps.find((s) => s.id === stepId);
    if (!step || step.type !== "tool") return;
    if (step.status === "running" || step.status === "undone" || step.kept) return;
    set((s) => ({
      steps: s.steps.map((x) => (x.id === stepId && x.type === "tool" ? { ...x, kept: true } : x)),
    }));
  },
  undoStep: (stepId) => {
    const item = get().items.find((entry) => String(entry?.id ?? "") === String(stepId ?? "").trim());
    if (item) {
      get().dispatchItemAction(stepId, "undo");
      return;
    }
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
  keepAllProposals: () => {
    const pendingItems = (get().items ?? [])
      .filter((item: any) => item && item.type === "fileChange")
      .filter((item: any) => item.applyPolicy === "proposal" && !item.applied && item.status !== "declined");
    if (pendingItems.length > 0) {
      for (const item of pendingItems) {
        try {
          get().dispatchItemAction(String((item as any).id ?? ""), "keep");
        } catch {
          // ignore：单个提案失败不应影响其它提案
        }
      }
      return;
    }
    const steps = get().steps ?? [];
    const pending = steps
      .filter((s: any) => s && s.type === "tool")
      .filter((s: any) => s.applyPolicy === "proposal" && s.status === "success" && !s.kept);
    for (const st of pending) {
      try {
        get().keepStep(String((st as any).id ?? ""));
      } catch {
        // ignore：单个提案失败不应影响其它提案
      }
    }
  },

  updateMainDoc: (patch) => {
    const prev = get().mainDoc;
    const rawPatch = patch && typeof patch === "object" ? patch : {};
    set({
      mainDoc: {
        ...prev,
        ...rawPatch,
      },
    });
    return { undo: () => set({ mainDoc: prev }) };
  },

  setTodoList: (items) => {
    const prev = get().todoList;
    set({ todoList: Array.isArray(items) ? items : [] });
    return { undo: () => set({ todoList: prev }) };
  },

  updateTodo: (id, patch) => {
    const prev = get().todoList;
    const idx = prev.findIndex((t) => t.id === id);
    if (idx < 0) return { undo: () => void 0 };
    const next = prev.map((t) => (t.id === id ? { ...t, ...patch, id: t.id } : t));
    set({ todoList: next });
    return { undo: () => set({ todoList: prev }) };
  },

  log: (level, message, data) => {
    const entry: LogEntry = {
      id: makeId("log"),
      ts: Date.now(),
      level,
      message,
      data
    };
    // DEV: mirror to browser console with CST (UTC+8) timestamp
    const _ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const _tag = level === "error" ? "ERR" : level === "warn" ? "WRN" : "INF";
    const _fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    _fn(`[${_ts}] [${_tag}] ${message}`, data !== undefined ? data : "");
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
      partialize: (s) => ({
        mode: s.mode,
        model: s.model,
        chatModel: s.chatModel,
        agentModel: s.agentModel,
        opMode: s.opMode,
        kbAttachedLibraryIds: s.kbAttachedLibraryIds,
      }),
      merge: (persisted: unknown, current: RunState) => {
        const p = persisted && typeof persisted === "object" ? { ...(persisted as Record<string, unknown>) } : {};
        // 老版本可能存了 mode:"plan" 等已废弃值，新版 Gateway 只接受 "agent"|"chat"
        if (p.mode !== "agent" && p.mode !== "chat") p.mode = "agent";
        if (p.opMode !== "creative" && p.opMode !== "assistant") p.opMode = "creative";
        return { ...current, ...p } as RunState;
      },
    },
  ),
);
