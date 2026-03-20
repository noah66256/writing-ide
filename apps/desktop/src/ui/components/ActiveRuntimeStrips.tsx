import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square,
  SquareTerminal,
} from "lucide-react";

import { buildGatewayApiUrl } from "@/agent/gatewayUrl";
import {
  basename,
  buildActiveCollabRuntimeEntries,
  formatRelativeTime,
  normalizeTerminalRuntimeEntries,
  type CollabRuntimeEntry,
  type TerminalRuntimeEntry,
} from "@/lib/activeRuntime";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/state/authStore";
import { useRunStore } from "@/state/runStore";
import type {
  RuntimeCollabSessionRecord,
  RuntimeThreadRecord,
} from "@/state/runStore";

function stopButtonLabel(status: TerminalRuntimeEntry["status"]) {
  return status === "stopping" ? "停止中" : "停止";
}

function collabStopButtonLabel(status: CollabRuntimeEntry["status"]) {
  return status === "closing" ? "关闭中" : "停止";
}

function collabStatusLabel(entry: CollabRuntimeEntry) {
  if (entry.status === "closing") return "关闭中";
  if (entry.status === "waiting") {
    if (entry.waitKind === "approval") return "等待审批";
    if (entry.waitKind === "user") return "等待输入";
    return "等待中";
  }
  return "运行中";
}

function collabSummary(entries: CollabRuntimeEntry[]) {
  const running = entries.filter((item) => item.status === "running").length;
  const waiting = entries.filter((item) => item.status === "waiting").length;
  const closing = entries.filter((item) => item.status === "closing").length;
  if (running > 0) {
    const extras: string[] = [];
    if (waiting > 0) extras.push(`${waiting} 个等待中`);
    if (closing > 0) extras.push(`${closing} 个关闭中`);
    return extras.length
      ? `${running} 个子智能体运行中 · ${extras.join(" · ")}`
      : `${running} 个子智能体运行中`;
  }
  if (waiting > 0) {
    return closing > 0
      ? `${waiting} 个子智能体等待中 · ${closing} 个关闭中`
      : `${waiting} 个子智能体等待中`;
  }
  return `${closing} 个子智能体关闭中`;
}

function terminalSummary(entries: TerminalRuntimeEntry[]) {
  const running = entries.filter((item) => item.status === "running").length;
  const stopping = entries.filter((item) => item.status === "stopping").length;
  if (running > 0) {
    return stopping > 0
      ? `${running} 个后台终端运行中 · ${stopping} 个停止中`
      : `${running} 个后台终端运行中`;
  }
  return `${stopping} 个后台终端停止中`;
}

function headerIcon(isBusy: boolean, icon: ReactNode) {
  return isBusy ? <Loader2 size={14} className="animate-spin text-accent" /> : icon;
}

function StopActionButton({
  busy,
  title,
  onClick,
  disabled,
}: {
  busy?: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
        busy || disabled
          ? "cursor-not-allowed bg-surface text-text-faint"
          : "bg-error/10 text-error hover:bg-error/20",
      )}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-label={title}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
    </button>
  );
}

function optimisticCloseCollabSession(args: { sessionId: string; childThreadId?: string }) {
  const store = useRunStore.getState();
  store.setCollabSessions(
    (store.collabSessions ?? []).map((item) =>
      String(item?.id ?? "").trim() === args.sessionId
        ? {
            ...item,
            status: "closed",
            waitState: null,
            closeReason: "closed_by_user",
            updatedAt: new Date().toISOString(),
          }
        : item,
    ),
  );
  const prevThread = store.thread;
  if (!prevThread) return;
  const activeCollabAgents = Array.isArray(prevThread.activeCollabAgents)
    ? prevThread.activeCollabAgents.map((item) =>
        String(item?.threadId ?? "").trim() === String(args.childThreadId ?? "").trim()
          ? { ...item, status: "closed" as const }
          : item,
      )
    : [];
  store.setThread({
    ...prevThread,
    activeCollabAgents,
    updatedAt: new Date().toISOString(),
  });
}

function RuntimeStrip({
  icon,
  busy,
  summary,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  busy: boolean;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-soft bg-surface/88 shadow-sm backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-alt text-text-faint">
          {headerIcon(busy, icon)}
        </div>
        <div className="min-w-0 flex-1 text-[12px] leading-5 text-text-muted">
          <div className="truncate">{summary}</div>
        </div>
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-surface-alt hover:text-text"
          onClick={onToggle}
          aria-label={expanded ? "收起运行态详情" : "展开运行态详情"}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
      {expanded ? <div className="border-t border-border-soft px-3 py-2">{children}</div> : null}
    </div>
  );
}

export function ActiveRuntimeStrips({
  thread,
  collabSessions,
  isRunning,
}: {
  thread: RuntimeThreadRecord | null;
  collabSessions: RuntimeCollabSessionRecord[];
  isRunning: boolean;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);

  const [terminalEntries, setTerminalEntries] = useState<TerminalRuntimeEntry[]>([]);
  const [terminalsExpanded, setTerminalsExpanded] = useState(false);
  const [collabExpanded, setCollabExpanded] = useState(false);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(new Set());
  const [closingSessionIds, setClosingSessionIds] = useState<Set<string>>(new Set());

  const refreshTerminals = useCallback(async () => {
    const api = (window as any).desktop?.process;
    if (!api || typeof api.list !== "function") {
      setTerminalEntries((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const result = await api.list().catch(() => null);
    if (!result || result.ok === false) {
      setTerminalEntries((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const next = normalizeTerminalRuntimeEntries((result as any).processes);
    setTerminalEntries((prev) => {
      if (
        prev.length === next.length &&
        prev.every((item, index) => {
          const other = next[index];
          return Boolean(other)
            && item.id === other.id
            && item.status === other.status
            && item.command === other.command
            && item.cwd === other.cwd
            && item.startedAt === other.startedAt;
        })
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshTerminals();
  }, [refreshTerminals]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshTerminals();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshTerminals]);

  useEffect(() => {
    const shouldPollFast = terminalEntries.length > 0 || isRunning;
    if (!shouldPollFast) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshTerminals();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isRunning, refreshTerminals, terminalEntries.length]);

  const collabEntries = useMemo(
    () =>
      buildActiveCollabRuntimeEntries({
        collabSessions,
        activeCollabAgents: thread?.activeCollabAgents ?? [],
        closingSessionIds,
      }),
    [closingSessionIds, collabSessions, thread?.activeCollabAgents],
  );

  const handleStopTerminal = useCallback(
    async (entry: TerminalRuntimeEntry) => {
      const api = (window as any).desktop?.process;
      if (!api || typeof api.stop !== "function") return;
      setStoppingProcessIds((prev) => new Set(prev).add(entry.processId));
      try {
        await api.stop(entry.processId);
      } finally {
        setStoppingProcessIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.processId);
          return next;
        });
        await refreshTerminals();
      }
    },
    [refreshTerminals],
  );

  const handleCloseCollab = useCallback(
    async (entry: CollabRuntimeEntry) => {
      const threadId = String(thread?.id ?? "").trim();
      const closeRef = String(entry.closeRef ?? entry.sessionId ?? entry.childThreadId ?? "").trim();
      if (!closeRef || !threadId) return;
      setClosingSessionIds((prev) => new Set(prev).add(entry.id));
      try {
        const response = await fetch(buildGatewayApiUrl("/api/agent/collab/close"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            threadId,
            sessionId: closeRef,
          }),
        });
        const payload = await response.json().catch(() => null);
        const errorCode = String(payload?.error ?? "").trim();
        const isStaleRuntime =
          errorCode === "NOT_AVAILABLE" || errorCode === "COLLAB_SESSION_NOT_FOUND";
        if (!response.ok && !isStaleRuntime) {
          const detail = String(payload?.detail ?? payload?.error ?? "关闭子智能体失败").trim();
          throw new Error(detail || "关闭子智能体失败");
        }
        optimisticCloseCollabSession({
          sessionId: String(entry.sessionId ?? "").trim(),
          childThreadId: entry.childThreadId,
        });
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "关闭子智能体失败");
      } finally {
        setClosingSessionIds((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [accessToken, thread?.id],
  );

  if (terminalEntries.length <= 0 && collabEntries.length <= 0) return null;

  return (
    <div className="w-full max-w-[var(--chat-max-width)] mx-auto px-4 pb-2 space-y-2">
      {terminalEntries.length > 0 ? (
        <RuntimeStrip
          icon={<SquareTerminal size={14} />}
          busy={terminalEntries.some((item) => item.status === "running")}
          summary={terminalSummary(terminalEntries)}
          expanded={terminalsExpanded && terminalEntries.length > 0}
          onToggle={() => setTerminalsExpanded((prev) => !prev)}
        >
          <div className="space-y-2">
            {terminalEntries.map((entry) => {
              const stopping = stoppingProcessIds.has(entry.processId) || entry.status === "stopping";
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg bg-surface-alt/70 px-3 py-2"
                >
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-text-faint">
                    {stopping ? <Loader2 size={13} className="animate-spin text-accent" /> : <SquareTerminal size={13} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium leading-5 text-text">
                      {entry.command}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-text-faint">
                      {basename(entry.cwd) || "当前工作目录"}
                      {entry.startedAt ? ` · ${formatRelativeTime(entry.startedAt)}` : ""}
                      {stopping ? " · 正在停止" : ""}
                    </div>
                  </div>
                  <StopActionButton
                    busy={stopping}
                    title={stopButtonLabel(entry.status)}
                    onClick={() => void handleStopTerminal(entry)}
                  />
                </div>
              );
            })}
          </div>
        </RuntimeStrip>
      ) : null}

      {collabEntries.length > 0 ? (
        <RuntimeStrip
          icon={<Bot size={14} />}
          busy={collabEntries.some((item) => item.status === "running" || item.status === "closing")}
          summary={collabSummary(collabEntries)}
          expanded={collabExpanded && collabEntries.length > 0}
          onToggle={() => setCollabExpanded((prev) => !prev)}
        >
          <div className="space-y-2">
            {collabEntries.map((entry) => {
              const closing = entry.status === "closing";
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 rounded-lg bg-surface-alt/70 px-3 py-2"
                >
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-text-faint">
                    {closing || entry.status === "running"
                      ? <Loader2 size={13} className={cn("text-accent", (closing || entry.status === "running") && "animate-spin")} />
                      : <Bot size={13} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium leading-5 text-text">
                      {entry.agentName || entry.agentId}
                      {entry.role ? ` · ${entry.role}` : ""}
                    </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-text-faint">
                    {collabStatusLabel(entry)}
                    {entry.updatedAt ? ` · ${formatRelativeTime(entry.updatedAt)}` : ""}
                  </div>
                </div>
                  <StopActionButton
                    busy={closing}
                    title={collabStopButtonLabel(entry.status)}
                    onClick={() => void handleCloseCollab(entry)}
                    disabled={!entry.closeable}
                  />
                </div>
              );
            })}
          </div>
        </RuntimeStrip>
      ) : null}
    </div>
  );
}
