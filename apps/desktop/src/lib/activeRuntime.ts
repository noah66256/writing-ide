import { BUILTIN_SUB_AGENTS } from "@ohmycrab/agent-core";

import type {
  RuntimeCollabAgentRef,
  RuntimeCollabSessionRecord,
} from "@/state/runStore";

export type TerminalRuntimeEntry = {
  id: string;
  processId: string;
  command: string;
  cwd?: string;
  status: "running" | "stopping" | "exited" | "error";
  startedAt?: number | null;
};

export type CollabRuntimeEntry = {
  id: string;
  sessionId?: string;
  closeRef?: string;
  childThreadId?: string;
  agentId: string;
  agentName?: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed" | "closing";
  waitKind?: "join" | "user" | "approval";
  updatedAt?: string;
  closeable: boolean;
};

function agentNameForId(agentId: string) {
  return BUILTIN_SUB_AGENTS.find((item) => item.id === agentId)?.name;
}

function parseDateMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function basename(pathLike: unknown): string {
  const raw = String(pathLike ?? "").trim().replace(/\/+$/g, "");
  if (!raw) return "";
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

export function formatRelativeTime(raw: unknown, now = Date.now()): string {
  const ts = parseDateMs(raw);
  if (!ts) return "";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 5) return "刚刚";
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

export function normalizeTerminalRuntimeEntries(rawProcesses: unknown): TerminalRuntimeEntry[] {
  const rows = Array.isArray(rawProcesses) ? rawProcesses : [];
  const entries = rows
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const id = String(row.processId ?? row.id ?? "").trim();
      const statusRaw = String(row.status ?? "").trim().toLowerCase();
      const status: TerminalRuntimeEntry["status"] =
        statusRaw === "stopping" || statusRaw === "exited" || statusRaw === "error"
          ? statusRaw
          : "running";
      if (!id || (status !== "running" && status !== "stopping")) return null;
      return {
        id,
        processId: id,
        command: String(row.command ?? "").trim() || "终端会话",
        cwd: String(row.cwd ?? "").trim() || undefined,
        status,
        startedAt: parseDateMs(row.startedAt),
      } satisfies TerminalRuntimeEntry;
    })
    .filter(Boolean) as TerminalRuntimeEntry[];

  return entries.sort((a, b) => {
    const aTime = a.startedAt ?? 0;
    const bTime = b.startedAt ?? 0;
    return aTime - bTime;
  });
}

export function buildActiveCollabRuntimeEntries(args: {
  collabSessions?: RuntimeCollabSessionRecord[];
  activeCollabAgents?: RuntimeCollabAgentRef[];
  closingSessionIds?: Set<string>;
}): CollabRuntimeEntry[] {
  const closingSessionIds = args.closingSessionIds ?? new Set<string>();
  const sessionRows = Array.isArray(args.collabSessions) ? args.collabSessions : [];
  const activeAgents = Array.isArray(args.activeCollabAgents) ? args.activeCollabAgents : [];

  const byChildThreadId = new Map<string, CollabRuntimeEntry>();
  const bySessionId = new Map<string, CollabRuntimeEntry>();

  for (const session of sessionRows) {
    const sessionId = String(session?.id ?? "").trim();
    const childThreadId = String(session?.childThreadId ?? "").trim();
    const agentId = String(session?.agentId ?? "").trim();
    if (!sessionId || !childThreadId || !agentId) continue;
    const statusRaw = String(session?.status ?? "").trim().toLowerCase();
    let status: CollabRuntimeEntry["status"] =
      statusRaw === "waiting" || statusRaw === "completed" || statusRaw === "failed" || statusRaw === "closed"
        ? (statusRaw as CollabRuntimeEntry["status"])
        : "running";
    if (closingSessionIds.has(sessionId) && (status === "running" || status === "waiting")) {
      status = "closing";
    }
    if (status !== "running" && status !== "waiting" && status !== "closing") continue;
    const entry: CollabRuntimeEntry = {
      id: sessionId,
      sessionId,
      closeRef: childThreadId || sessionId,
      childThreadId,
      agentId,
      agentName: agentNameForId(agentId),
      role: String(session?.role ?? "").trim() || undefined,
      status,
      waitKind:
        session?.waitState?.kind === "approval" || session?.waitState?.kind === "user"
          ? session.waitState.kind
          : session?.waitState?.kind === "join"
            ? "join"
            : undefined,
      updatedAt: String(session?.updatedAt ?? "").trim() || undefined,
      closeable: true,
    };
    byChildThreadId.set(childThreadId, entry);
    bySessionId.set(sessionId, entry);
  }

  for (const agent of activeAgents) {
    const childThreadId = String(agent?.threadId ?? "").trim();
    const agentId = String(agent?.agentId ?? "").trim();
    if (!childThreadId || !agentId || byChildThreadId.has(childThreadId)) continue;
    const statusRaw = String(agent?.status ?? "").trim().toLowerCase();
    const status: CollabRuntimeEntry["status"] =
      closingSessionIds.has(childThreadId)
        ? "closing"
        : statusRaw === "waiting"
          ? "waiting"
          : statusRaw === "running"
            ? "running"
            : "closed";
    if (status !== "running" && status !== "waiting" && status !== "closing") continue;
    byChildThreadId.set(childThreadId, {
      id: childThreadId,
      closeRef: childThreadId,
      childThreadId,
      agentId,
      agentName: String(agent?.agentName ?? "").trim() || agentNameForId(agentId) || undefined,
      role: String(agent?.role ?? "").trim() || undefined,
      status,
      updatedAt: undefined,
      closeable: true,
    });
  }

  return Array.from(byChildThreadId.values()).sort((a, b) => {
    const aWeight = a.status === "running" ? 0 : a.status === "closing" ? 1 : 2;
    const bWeight = b.status === "running" ? 0 : b.status === "closing" ? 1 : 2;
    if (aWeight !== bWeight) return aWeight - bWeight;
    const aTime = parseDateMs(a.updatedAt) ?? 0;
    const bTime = parseDateMs(b.updatedAt) ?? 0;
    return bTime - aTime;
  });
}
