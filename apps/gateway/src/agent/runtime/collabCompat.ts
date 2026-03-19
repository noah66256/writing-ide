import { BUILTIN_SUB_AGENTS } from "@ohmycrab/agent-core";
import type { CollabAgentSessionRecord } from "@ohmycrab/shared";

type CollabItem = Record<string, unknown>;

export type NormalizedCollabInput = {
  message?: string;
  items?: CollabItem[];
  prompt: string;
};

export type NormalizedSpawnAgentArgs = {
  agentId: string;
  requestedAgentType?: string;
  message?: string;
  items?: CollabItem[];
  task: string;
  prompt: string;
  context: {
    role?: string;
    requested_role?: string;
    model?: string;
    reasoning_effort?: string;
    fork_context?: boolean;
  };
};

const DEFAULT_AGENT_ID = "copywriter";

const ROLE_ALIASES: Record<string, string> = {
  copy: "copywriter",
  writer: "copywriter",
  editor: "copywriter",
  worker: "copywriter",
  general: "copywriter",
  generic: "copywriter",
  default: "copywriter",
  custom: "copywriter",
  researcher: "topic_planner",
  research: "topic_planner",
  planner: "topic_planner",
  explorer: "topic_planner",
  search: "topic_planner",
  searcher: "topic_planner",
  seo: "seo_specialist",
  learning: "learning_specialist",
  learner: "learning_specialist",
  ingest: "learning_specialist",
  ingester: "learning_specialist",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneItems(items: unknown): CollabItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => JSON.parse(JSON.stringify(item)) as CollabItem);
}

function previewItem(item: CollabItem, index: number): string {
  const text = cleanText(item.text);
  if (text) return text;

  const type = cleanText(item.type) || `item_${index + 1}`;
  const name = cleanText(item.name);
  const path = cleanText(item.path);
  const imageUrl = cleanText(item.image_url);
  const parts = [name, path, imageUrl].filter(Boolean);
  if (parts.length) return `[${type}] ${parts.join(" ")}`;
  try {
    return `[${type}] ${JSON.stringify(item)}`;
  } catch {
    return `[${type}]`;
  }
}

export function normalizeCollabInput(args: {
  message?: unknown;
  items?: unknown;
}): { ok: true; value: NormalizedCollabInput } | { ok: false; error: string } {
  const hasMessage = Object.prototype.hasOwnProperty.call(args, "message") && args.message !== undefined && args.message !== null;
  const hasItems = Object.prototype.hasOwnProperty.call(args, "items") && args.items !== undefined && args.items !== null;
  if (hasMessage && hasItems) {
    return { ok: false, error: "Provide either message or items, but not both" };
  }

  const message = cleanText(args.message);
  if (hasMessage) {
    if (!message) return { ok: false, error: "Empty message can't be sent to an agent" };
    return { ok: true, value: { message, prompt: message } };
  }

  const items = cloneItems(args.items);
  if (hasItems) {
    if (!items.length) return { ok: false, error: "Items can't be empty" };
    const prompt = items.map((item, index) => previewItem(item, index)).join("\n\n").trim();
    if (!prompt) return { ok: false, error: "Items can't be empty" };
    return { ok: true, value: { items, prompt } };
  }

  return { ok: false, error: "Provide one of: message or items" };
}

function normalizeRoleKey(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function resolveSpawnAgentRole(raw: unknown): {
  requestedAgentType?: string;
  agentId: string;
} {
  const requestedAgentType = cleanText(raw);
  if (!requestedAgentType) return { agentId: DEFAULT_AGENT_ID };

  const exact = BUILTIN_SUB_AGENTS.find((agent) => agent.id === requestedAgentType);
  if (exact) return { requestedAgentType, agentId: exact.id };

  const byName = BUILTIN_SUB_AGENTS.find((agent) => agent.name === requestedAgentType);
  if (byName) return { requestedAgentType, agentId: byName.id };

  const alias = ROLE_ALIASES[normalizeRoleKey(requestedAgentType)];
  return {
    requestedAgentType,
    agentId: alias || requestedAgentType,
  };
}

export function normalizeSpawnAgentArgs(
  rawArgs: Record<string, unknown>,
): { ok: true; value: NormalizedSpawnAgentArgs } | { ok: false; error: string } {
  const input = normalizeCollabInput({
    message: rawArgs.message,
    items: rawArgs.items,
  });
  if (!input.ok) return input;

  const role = resolveSpawnAgentRole(
    rawArgs.agent_type ?? rawArgs.agentId ?? rawArgs.role ?? rawArgs.agent ?? rawArgs.agent_type_id,
  );
  const model = cleanText(rawArgs.model);
  const reasoningEffort = cleanText(rawArgs.reasoning_effort);
  return {
    ok: true,
    value: {
      agentId: role.agentId,
      requestedAgentType: role.requestedAgentType,
      message: input.value.message,
      items: input.value.items,
      task: input.value.prompt,
      prompt: input.value.prompt,
      context: {
        role: role.agentId || undefined,
        requested_role: role.requestedAgentType || undefined,
        model: model || undefined,
        reasoning_effort: reasoningEffort || undefined,
        fork_context: rawArgs.fork_context === true,
      },
    },
  };
}

export function getCollabSessionExternalId(session: Pick<CollabAgentSessionRecord, "id" | "childThreadId">): string {
  return cleanText(session.childThreadId) || cleanText(session.id);
}

export function getCollabAgentNickname(agentId: string): string | null {
  return BUILTIN_SUB_AGENTS.find((agent) => agent.id === agentId)?.name ?? null;
}

export function resolveCollabSessionByExternalId<T extends { record: CollabAgentSessionRecord }>(
  sessions: Iterable<T>,
  ref: unknown,
): T | null {
  const id = cleanText(ref);
  if (!id) return null;
  for (const session of sessions) {
    if (session.record.id === id || session.record.childThreadId === id) return session;
  }
  return null;
}

function mapSessionStatusForModel(status: CollabAgentSessionRecord["status"] | string | undefined): string {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "closed":
      return "shutdown";
    case "waiting":
      return "interrupted";
    case "running":
      return "running";
    default:
      return "not_found";
  }
}

export function buildSpawnAgentToolOutput(session: CollabAgentSessionRecord) {
  const externalId = getCollabSessionExternalId(session);
  const nickname = getCollabAgentNickname(session.agentId);
  return {
    ok: true,
    agent_id: externalId,
    nickname,
    id: externalId,
    session_id: session.id,
    threadId: session.childThreadId,
    status: session.status,
    agentId: externalId,
    role_id: session.agentId,
    role: session.role ?? session.agentId,
  };
}

export function buildSendInputToolOutput(
  session: CollabAgentSessionRecord,
  submissionId: string,
) {
  const externalId = getCollabSessionExternalId(session);
  return {
    ok: true,
    submission_id: submissionId,
    id: externalId,
    session_id: session.id,
    status: session.status,
    inboxCount: session.inbox.length,
  };
}

export function buildResumeAgentToolOutput(
  session: CollabAgentSessionRecord,
  args?: { resumed?: boolean },
) {
  const externalId = getCollabSessionExternalId(session);
  const compatStatus = mapSessionStatusForModel(session.status);
  return {
    ok: true,
    status: compatStatus,
    id: externalId,
    session_id: session.id,
    resumed: args?.resumed ?? true,
  };
}

export function buildCloseAgentToolOutput(
  session: CollabAgentSessionRecord,
  previousStatus: CollabAgentSessionRecord["status"],
) {
  const externalId = getCollabSessionExternalId(session);
  return {
    ok: true,
    previous_status: mapSessionStatusForModel(previousStatus),
    id: externalId,
    session_id: session.id,
    status: session.status,
  };
}

export function buildWaitAgentToolOutput(args: {
  resolved: CollabAgentSessionRecord[];
  unresolvedIds?: string[];
  timedOut: boolean;
}) {
  const status: Record<string, string> = {};
  const completed = args.resolved
    .filter((record) => record.status === "completed" || record.status === "failed" || record.status === "closed")
    .map((record) => ({
      id: getCollabSessionExternalId(record),
      session_id: record.id,
      agentId: record.agentId,
      threadId: record.childThreadId,
      status: record.status,
      closeReason: record.closeReason ?? null,
    }));
  const pending = args.resolved
    .filter((record) => !(record.status === "completed" || record.status === "failed" || record.status === "closed"))
    .map((record) => getCollabSessionExternalId(record));

  for (const record of args.resolved) {
    status[getCollabSessionExternalId(record)] = mapSessionStatusForModel(record.status);
  }
  for (const unresolvedId of args.unresolvedIds ?? []) {
    if (!cleanText(unresolvedId)) continue;
    status[cleanText(unresolvedId)] = "not_found";
  }

  return {
    ok: true,
    status,
    timed_out: args.timedOut,
    completed,
    pending,
    timedOut: args.timedOut,
  };
}
