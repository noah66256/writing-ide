import type { ToolResultEnvelope } from "./toolResultEnvelope";

export type ThreadWaitingFor = "none" | "user" | "approval";

export type SkillRef = {
  id: string;
  source: "builtin" | "user" | "admin";
  activation: "explicit" | "auto" | "sticky";
  scope: "thread" | "turn";
  configPath?: string | null;
  enabled: boolean;
};

export type CollabAgentRef = {
  threadId: string;
  agentId: string;
  agentName?: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed";
};

export type CollabCallKind =
  | "spawn_agent"
  | "send_input"
  | "resume_agent"
  | "wait_agent"
  | "close_agent";

export type CollabAgentSessionRecord = {
  id: string;
  parentThreadId: string;
  childThreadId: string;
  agentId: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed";
  inbox: Array<{
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
  createdAt: string;
  updatedAt: string;
};

export type TaskStateV2 = {
  runIntent?: "auto" | "writing" | "rewrite" | "polish" | "analysis" | "ops";
  workflow?: {
    kind?: string;
    status?: "running" | "waiting_user" | "waiting_approval" | "done" | "failed";
    routeId?: string;
    intentHint?: string;
    updatedAt?: string;
    lastEndReason?: string;
    selectedServerIds?: string[];
    preferredToolNames?: string[];
    resumeAction?: Record<string, unknown> | null;
    waiting?: Record<string, unknown> | null;
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

export type ThreadCapabilityState = {
  v: 1;
  activeMcpCapabilityIds: string[];
  activeSkillIds: string[];
  stickyCapabilityIds: string[];
  stickySkillIds: string[];
  recentlyDescribedIds: string[];
  lastActivatedAt?: Record<string, number>;
};

export type ThreadRecord = {
  id: string;
  convId?: string | null;
  status: "idle" | "running" | "waiting" | "completed" | "failed";
  waitingFor: ThreadWaitingFor;
  waiting?: {
    kind: "clarify" | "proposal" | "approval" | "resume_or_narrow" | "login_or_choice";
    question?: string;
    replyHint?: string;
    sourceTurnId?: string;
    updatedAt: string;
  } | null;
  activeSkillRefs: SkillRef[];
  activeCollabAgents: CollabAgentRef[];
  pendingProposalIds: string[];
  pendingApprovalIds: string[];
  taskState?: TaskStateV2 | null;
  capabilityState?: ThreadCapabilityState | null;
  createdAt: string;
  updatedAt: string;
};

export type TurnRecord = {
  id: string;
  threadId: string;
  seq: number;
  status: "in_progress" | "completed" | "failed" | "aborted" | "interrupted";
  startedAt: string;
  completedAt?: string;
  reason?: string;
  reasonCodes: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  } | null;
  itemIds: string[];
  executionReport?: Record<string, unknown> | null;
};

export type ItemBase = {
  id: string;
  threadId: string;
  turnId: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  createdAt: string;
  updatedAt: string;
};

export type AgentMessageItem = ItemBase & {
  type: "agentMessage";
  text: string;
  agentId?: string;
  agentName?: string;
};

export type ReasoningItem = ItemBase & {
  type: "reasoning";
  summary?: string;
  content?: string;
};

export type ToolCallItem = ItemBase & {
  type: "toolCall";
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  executedBy?: "gateway" | "desktop";
  agentId?: string;
  agentName?: string;
  result?: ToolResultEnvelope | unknown;
  error?: string;
  riskLevel?: "low" | "medium" | "high";
  applyPolicy?: "proposal" | "auto_apply";
  shadowSource?: "tool_step";
};

export type FileChangeItem = ItemBase & {
  type: "fileChange";
  sourceToolName?: string;
  riskLevel?: "low" | "medium" | "high";
  applyPolicy?: "proposal" | "auto_apply";
  note?: string;
  preview?: Record<string, unknown> | null;
  changes?: Array<{
    path: string;
    kind?: string;
    diff?: string;
  }>;
  proposalId?: string;
  approvalId?: string;
  actionSpec?: ItemActionSpec | null;
  kept?: boolean;
  applied?: boolean;
  undoable?: boolean;
  canUndo?: boolean;
};

export type ApprovalItem = ItemBase & {
  type: "approval";
  kind?: "proposal" | "approval";
  sourceToolName?: string;
  approvalId?: string;
  question?: string;
  note?: string;
  preview?: Record<string, unknown> | null;
  actionSpec?: ItemActionSpec | null;
  kept?: boolean;
  applied?: boolean;
};

export type CollabItem = ItemBase & {
  type: "collabAgentToolCall";
  tool: CollabCallKind;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentsStates?: Record<string, string>;
};

export type ProgressItem = ItemBase & {
  type: "progress";
  phase?: string;
  message: string;
};

export type ItemRecord =
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | FileChangeItem
  | ApprovalItem
  | CollabItem
  | ProgressItem;

export type ThreadSnapshotEvent = {
  thread: ThreadRecord;
  currentTurn?: TurnRecord | null;
  items?: ItemRecord[];
  collabSessions?: CollabAgentSessionRecord[];
  activeItemIds?: string[];
  stream?: {
    snapshotSeq: number;
    cursor: string;
    replaceStrategy: "replace";
  };
  emittedAt: string;
};

export type CollabSessionUpdatedEvent = {
  session: CollabAgentSessionRecord;
  emittedAt: string;
};

export type SkillsUpdatedEvent = {
  threadId: string;
  activeSkillRefs: SkillRef[];
  catalogVersion?: string;
  reasonCodes: string[];
  emittedAt: string;
};

export type ThreadWaitingUpdatedEvent = {
  threadId: string;
  waitingFor: ThreadWaitingFor;
  waiting?: ThreadRecord["waiting"];
  emittedAt: string;
};

export type WaitingCandidate = {
  source: "assistant_heuristic";
  question?: string;
  replyHint?: string;
  confidence?: number;
};

export type ItemAction =
  | { itemId: string; action: "keep"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "undo"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "approve"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "decline"; actor: "user" | "system"; at: string };

export type ItemActionSpec = {
  executor: "desktop.fs" | "desktop.mcp" | "gateway.noop";
  applyOp?: Record<string, unknown>;
  undoOp?: Record<string, unknown>;
  canReplayAfterReload: boolean;
};

export type StartGatewayRunPayloadV2 = {
  convId?: string;
  threadId?: string;
  mode: "agent" | "chat";
  model: string;
  opMode?: "creative" | "assistant";
  prompt: string;
  images?: Array<{
    id?: string;
    mimeType?: string;
    path?: string;
    base64DataUrl?: string;
  }>;
  kbMentionIds?: string[];
  skillRefs?: SkillRef[];
  builtinOverrides?: Record<string, { enabled?: boolean }>;
  userSkillManifests?: unknown[];
  threadSnapshotHint?: {
    threadId?: string;
    activeSkillRefs?: SkillRef[];
    waitingFor?: ThreadWaitingFor;
    pendingApprovalIds?: string[];
    pendingArtifactIds?: string[];
    collabSessionIds?: string[];
    collabSessions?: CollabAgentSessionRecord[];
    capabilityState?: ThreadCapabilityState | null;
  };
  portablePreRunCompact?: {
    trigger?: "auto" | "manual";
    scope?: "dialogue_summary";
    compactSummary?: string;
    customInstructions?: string;
    previousSummaryChars?: number;
    deltaTurns?: number;
    mode?: "agent" | "chat";
    performedAt?: string;
  };
};
