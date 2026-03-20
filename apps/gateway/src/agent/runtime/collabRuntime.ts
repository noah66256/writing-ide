import { randomUUID } from "node:crypto";

import type { CollabAgentSessionRecord } from "@ohmycrab/shared";

import type { RunContext } from "../writingAgentRunner.js";
import {
  SubAgentExecutionBridge,
  type SubAgentExecutionBridgeResult,
} from "./SubAgentExecutionBridge.js";
import {
  buildCloseAgentToolOutput,
  buildResumeAgentToolOutput,
  buildSendInputToolOutput,
  buildSpawnAgentToolOutput,
  buildWaitAgentToolOutput,
  getCollabSessionExternalId,
  normalizeCollabInput,
  normalizeSpawnAgentArgs,
  resolveCollabSessionByExternalId,
} from "./collabCompat.js";

type CollabToolExecResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
  executedBy: "gateway";
  dryRun?: boolean;
};

type LiveSession = {
  record: CollabAgentSessionRecord;
  abortController: AbortController;
  promise: Promise<SubAgentExecutionBridgeResult> | null;
  lastResult: SubAgentExecutionBridgeResult | null;
  spawnArgs: Record<string, unknown>;
  turn: number;
};

const liveCollabRuntimeByThread = new Map<string, CollabRuntime>();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildInboxPayload(args: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  if (typeof args.message === "string" && args.message.trim()) payload.message = args.message.trim();
  if (Array.isArray(args.items)) payload.items = args.items;
  if (args.interrupt === true) payload.interrupt = true;
  return payload;
}

function runtimeThreadKey(parentCtx: Pick<RunContext, "threadId" | "runId">) {
  return String(parentCtx.threadId ?? parentCtx.runId ?? "").trim() || String(parentCtx.runId ?? "").trim();
}

export async function closeLiveCollabSession(args: { threadId: string; sessionId: string }) {
  const threadId = String(args.threadId ?? "").trim();
  const sessionId = String(args.sessionId ?? "").trim();
  if (!threadId || !sessionId) {
    return {
      ok: false as const,
      error: "VALIDATION_ERROR",
      detail: "threadId and sessionId are required",
    };
  }
  const runtime = liveCollabRuntimeByThread.get(threadId);
  if (!runtime) {
    return {
      ok: false as const,
      error: "NOT_AVAILABLE",
      detail: threadId,
    };
  }
  const result = await runtime.closeAgent({ id: sessionId });
  return {
    ok: Boolean(result.ok),
    output: result.output,
    detail: result.ok ? undefined : sessionId,
  };
}

export function releaseLiveCollabRuntime(threadId: string) {
  const key = String(threadId ?? "").trim();
  if (!key) return;
  liveCollabRuntimeByThread.delete(key);
}

export class CollabRuntime {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly parentCtx: RunContext) {
    const threadKey = runtimeThreadKey(parentCtx);
    if (threadKey) liveCollabRuntimeByThread.set(threadKey, this);
    this.hydrateFromHint();
  }

  async spawn(
    toolCallId: string,
    toolArgs: Record<string, unknown>,
    turn: number,
  ): Promise<CollabToolExecResult> {
    const normalized = normalizeSpawnAgentArgs(toolArgs);
    if (!normalized.ok) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: normalized.error },
        executedBy: "gateway",
      };
    }
    const spawnArgs = normalized.value;
    const agentId = spawnArgs.agentId;
    const task = spawnArgs.task;

    const sessionId = makeId("collab");
    const childThreadId = `${this.parentCtx.runId}:sub:${toolCallId}`;
    const createdAt = nowIso();
    const inbox = [
      {
        id: makeId("inbox"),
        createdAt,
        kind: "system_message" as const,
        payload: buildInboxPayload({
          message: spawnArgs.message,
          items: spawnArgs.items,
        }),
      },
    ];
    const record: CollabAgentSessionRecord = {
      id: sessionId,
      parentThreadId: String(this.parentCtx.threadId ?? this.parentCtx.runId).trim() || this.parentCtx.runId,
      childThreadId,
      agentId,
      role: spawnArgs.context.requested_role ?? spawnArgs.context.role ?? undefined,
      status: "running",
      inbox,
      lastDeliveredInboxItemId: inbox[0]?.id,
      waitState: { kind: "join", updatedAt: createdAt },
      closeReason: null,
      createdAt,
      updatedAt: createdAt,
    };
    const live: LiveSession = {
      record,
      abortController: new AbortController(),
      promise: null,
      lastResult: null,
      spawnArgs: { ...spawnArgs },
      turn,
    };
    this.sessions.set(sessionId, live);
    this.emitSessionUpdated(record);

    const bridge = new SubAgentExecutionBridge(this.parentCtx);
    live.promise = bridge
      .execute(toolCallId, spawnArgs, turn, { extraAbortSignal: live.abortController.signal })
      .then((result) => {
        live.lastResult = result;
        const output = asObject(result.output);
        const statusRaw = String(output.status ?? "").trim().toLowerCase();
        const status =
          live.record.status === "closed"
            ? "closed"
            : live.record.status === "waiting"
              ? "waiting"
            : statusRaw === "completed"
              ? "completed"
              : "failed";
        this.updateSession(sessionId, {
          status,
          waitState: null,
          closeReason:
            live.record.status === "closed"
              ? live.record.closeReason ?? "closed_by_user"
              : status === "completed"
                ? null
                : String(output.error ?? "").trim() || live.record.closeReason || null,
        });
        return result;
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error ?? "UNKNOWN_ERROR");
        if (live.record.status !== "closed") {
          this.updateSession(sessionId, {
            status: "failed",
            waitState: null,
            closeReason: detail || "COLLAB_RUNTIME_ERROR",
          });
        }
        const result: SubAgentExecutionBridgeResult = {
          ok: false,
          output: { ok: false, error: "COLLAB_RUNTIME_ERROR", detail },
          executedBy: "gateway",
        };
        live.lastResult = result;
        return result;
      });

    return {
      ok: true,
      output: buildSpawnAgentToolOutput(record),
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      executedBy: "gateway",
    };
  }

  async sendInput(toolArgs: Record<string, unknown>): Promise<CollabToolExecResult> {
    const id = String(toolArgs.id ?? toolArgs.agent_id ?? "").trim();
    if (!id) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "id is required" },
        executedBy: "gateway",
      };
    }
    const session = this.findSession(id);
    if (!session) return this.notFound(id);
    const normalizedInput = normalizeCollabInput({
      message: toolArgs.message,
      items: toolArgs.items,
    });
    if (!normalizedInput.ok) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: normalizedInput.error },
        executedBy: "gateway",
      };
    }
    const payload = buildInboxPayload({
      message: normalizedInput.value.message,
      items: normalizedInput.value.items,
      interrupt: toolArgs.interrupt,
    });
    const createdAt = nowIso();
    const inboxItem = {
      id: makeId("inbox"),
      createdAt,
      kind: "user_message" as const,
      payload,
    };
    if (toolArgs.interrupt === true && session.record.status === "running") {
      session.abortController.abort();
    }
    this.updateSession(id, {
      inbox: [...session.record.inbox, inboxItem],
      ...(toolArgs.interrupt === true && session.record.status === "running"
        ? {
            status: "waiting",
            waitState: { kind: "user" as const, updatedAt: createdAt },
          }
        : session.record.status === "running"
          ? { waitState: session.record.waitState }
          : { waitState: { kind: "user" as const, updatedAt: createdAt } }),
    });
    return {
      ok: true,
      output: buildSendInputToolOutput(this.findSession(id)?.record ?? session.record, inboxItem.id),
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      executedBy: "gateway",
    };
  }

  async resumeAgent(
    toolCallId: string,
    toolArgs: Record<string, unknown>,
    turn: number,
  ): Promise<CollabToolExecResult> {
    const id = String(toolArgs.id ?? toolArgs.agent_id ?? "").trim();
    if (!id) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "id is required" },
        executedBy: "gateway",
      };
    }
    const session = this.findSession(id);
    if (!session) return this.notFound(id);
    if (session.record.status === "running") {
      return {
        ok: true,
        output: buildResumeAgentToolOutput(session.record, { resumed: false }),
        meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
        executedBy: "gateway",
      };
    }
    if (session.record.status === "closed") {
      return {
        ok: false,
        output: { ok: false, error: "SESSION_CLOSED", detail: id },
        executedBy: "gateway",
      };
    }

    const latestInbox = session.record.inbox.at(-1);
    const normalizedInput = normalizeCollabInput(asObject(latestInbox?.payload));
    if (!normalizedInput.ok) {
      return {
        ok: false,
        output: { ok: false, error: "SESSION_NOT_RESUMABLE", detail: normalizedInput.error },
        executedBy: "gateway",
      };
    }

    const nextArgs = {
      ...session.spawnArgs,
      message: normalizedInput.value.message,
      items: normalizedInput.value.items,
      task: normalizedInput.value.prompt,
      prompt: normalizedInput.value.prompt,
      inputArtifacts: undefined,
      acceptanceCriteria: undefined,
    };
    const nextToolCallId = `${toolCallId}:resume:${makeId("turn")}`;
    this.updateSession(id, {
      status: "running",
      waitState: { kind: "join", updatedAt: nowIso() },
      closeReason: null,
    });
    const bridge = new SubAgentExecutionBridge(this.parentCtx);
    session.abortController = new AbortController();
    session.turn = turn;
    session.promise = bridge
      .execute(nextToolCallId, nextArgs, turn, { extraAbortSignal: session.abortController.signal })
      .then((result) => {
        session.lastResult = result;
        const output = asObject(result.output);
        const statusRaw = String(output.status ?? "").trim().toLowerCase();
        this.updateSession(id, {
          status: session.record.status === "waiting" ? "waiting" : statusRaw === "completed" ? "completed" : "failed",
          waitState: null,
          closeReason:
            session.record.status === "waiting"
              ? null
              : statusRaw === "completed"
                ? null
                : String(output.error ?? "").trim() || null,
        });
        return result;
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error ?? "UNKNOWN_ERROR");
        this.updateSession(id, {
          status: "failed",
          waitState: null,
          closeReason: detail || "COLLAB_RUNTIME_ERROR",
        });
        const result: SubAgentExecutionBridgeResult = {
          ok: false,
          output: { ok: false, error: "COLLAB_RUNTIME_ERROR", detail },
          executedBy: "gateway",
        };
        session.lastResult = result;
        return result;
      });

    return {
      ok: true,
      output: buildResumeAgentToolOutput(this.findSession(id)?.record ?? session.record, { resumed: true }),
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      executedBy: "gateway",
    };
  }

  async waitAgent(toolArgs: Record<string, unknown>): Promise<CollabToolExecResult> {
    const ids = Array.isArray(toolArgs.ids)
      ? toolArgs.ids.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    if (!ids.length) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "ids is required" },
        executedBy: "gateway",
      };
    }
    const timeoutMs = Math.max(0, Math.floor(Number(toolArgs.timeout_ms ?? 30_000) || 30_000));
    const resolvedSessions: LiveSession[] = [];
    const seenSessionIds = new Set<string>();
    const unresolvedIds: string[] = [];
    for (const id of ids) {
      const session = this.findSession(id);
      if (!session) {
        unresolvedIds.push(id);
        continue;
      }
      if (seenSessionIds.has(session.record.id)) continue;
      seenSessionIds.add(session.record.id);
      resolvedSessions.push(session);
    }
    if (!resolvedSessions.length) {
      return {
        ok: true,
        output: buildWaitAgentToolOutput({
          resolved: [],
          unresolvedIds,
          timedOut: false,
        }),
        meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
        executedBy: "gateway",
      };
    }

    const terminal = resolvedSessions.filter((session) => this.isTerminal(session.record.status));
    if (!terminal.length) {
      const pendingPromises = resolvedSessions
        .map((session) => session.promise)
        .filter((promise): promise is Promise<SubAgentExecutionBridgeResult> => Boolean(promise));
      if (pendingPromises.length) {
        await Promise.race([
          Promise.race(pendingPromises),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } else if (timeoutMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      }
    }

    const currentRecords = resolvedSessions
      .map((session) => this.findSession(session.record.id)?.record ?? session.record)
      .filter((record): record is CollabAgentSessionRecord => Boolean(record));
    const pending = currentRecords
      .filter((record) => !this.isTerminal(record.status))
      .map((record) => getCollabSessionExternalId(record));

    return {
      ok: true,
      output: buildWaitAgentToolOutput({
        resolved: currentRecords,
        unresolvedIds,
        timedOut: pending.length > 0,
      }),
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      executedBy: "gateway",
    };
  }

  async closeAgent(toolArgs: Record<string, unknown>): Promise<CollabToolExecResult> {
    const id = String(toolArgs.id ?? toolArgs.agent_id ?? "").trim();
    if (!id) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "id is required" },
        executedBy: "gateway",
      };
    }
    const session = this.findSession(id);
    if (!session) return this.notFound(id);
    const previousStatus = session.record.status;
    session.abortController.abort();
    this.updateSession(id, {
      status: "closed",
      waitState: null,
      closeReason: "closed_by_user",
    });
    return {
      ok: true,
      output: buildCloseAgentToolOutput(this.findSession(id)?.record ?? session.record, previousStatus),
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      executedBy: "gateway",
    };
  }

  private hydrateFromHint() {
    const rawSessions = Array.isArray(this.parentCtx.threadSnapshotHint?.collabSessions)
      ? this.parentCtx.threadSnapshotHint?.collabSessions
      : [];
    for (const raw of rawSessions) {
      const session = this.normalizeHydratedSession(raw);
      if (!session?.id) continue;
      if (this.sessions.has(session.id)) continue;
      const live: LiveSession = {
        record: session,
        abortController: new AbortController(),
        promise: null,
        lastResult: null,
        spawnArgs: (() => {
          const latestPayload = asObject(session.inbox.at(-1)?.payload);
          const normalizedInput = normalizeCollabInput(latestPayload);
          const prompt = normalizedInput.ok
            ? normalizedInput.value.prompt
            : String(latestPayload.message ?? "").trim();
          return {
            agentId: session.agentId,
            requestedAgentType: session.role,
            message: normalizedInput.ok ? normalizedInput.value.message : cleanMessage(latestPayload.message),
            items: normalizedInput.ok ? normalizedInput.value.items : undefined,
            task: prompt,
            prompt,
            context: session.role ? { role: session.role, requested_role: session.role } : undefined,
          };
        })(),
        turn: 0,
      };
      this.sessions.set(session.id, live);
      this.emitSessionUpdated(session);
    }
  }

  private normalizeHydratedSession(raw: unknown): CollabAgentSessionRecord | null {
    const session = asObject(raw);
    const id = String(session.id ?? "").trim();
    const parentThreadId =
      String(session.parentThreadId ?? this.parentCtx.threadId ?? this.parentCtx.runId).trim() ||
      this.parentCtx.runId;
    const childThreadId = String(session.childThreadId ?? "").trim();
    const agentId = String(session.agentId ?? "").trim();
    if (!id || !childThreadId || !agentId) return null;
    const statusRaw = String(session.status ?? "").trim().toLowerCase();
    const status: CollabAgentSessionRecord["status"] =
      statusRaw === "running" || statusRaw === "completed" || statusRaw === "failed" || statusRaw === "closed" || statusRaw === "waiting"
        ? statusRaw
        : "waiting";
    const inbox = Array.isArray(session.inbox)
      ? session.inbox
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const row = asObject(item);
            const kindRaw = String(row.kind ?? "").trim().toLowerCase();
            const kind: "user_message" | "system_message" | "tool_result" =
              kindRaw === "system_message"
                ? "system_message"
                : kindRaw === "tool_result"
                  ? "tool_result"
                  : "user_message";
            return {
              id: String(row.id ?? makeId("inbox")).trim() || makeId("inbox"),
              createdAt: String(row.createdAt ?? nowIso()).trim() || nowIso(),
              kind,
              payload: asObject(row.payload),
            };
          })
      : [];
    const updatedAt = String(session.updatedAt ?? nowIso()).trim() || nowIso();
    return {
      id,
      parentThreadId,
      childThreadId,
      agentId,
      role: String(session.role ?? "").trim() || undefined,
      status,
      inbox,
      lastDeliveredInboxItemId: String(session.lastDeliveredInboxItemId ?? "").trim() || undefined,
      waitState:
        session.waitState && typeof session.waitState === "object"
          ? {
              kind:
                (session.waitState as any).kind === "approval" || (session.waitState as any).kind === "user"
                  ? (session.waitState as any).kind
                  : "join",
              updatedAt: String((session.waitState as any).updatedAt ?? updatedAt).trim() || updatedAt,
            }
          : status === "waiting"
            ? { kind: "user", updatedAt }
            : null,
      closeReason: String(session.closeReason ?? "").trim() || null,
      createdAt: String(session.createdAt ?? updatedAt).trim() || updatedAt,
      updatedAt,
    };
  }

  private updateSession(id: string, patch: Partial<CollabAgentSessionRecord>) {
    const session = this.findSession(id);
    if (!session) return;
    session.record = {
      ...session.record,
      ...patch,
      inbox: Array.isArray(patch.inbox) ? patch.inbox : session.record.inbox,
      updatedAt: nowIso(),
    };
    this.emitSessionUpdated(session.record);
  }

  private emitSessionUpdated(session: CollabAgentSessionRecord) {
    this.parentCtx.writeEvent("collab.session.updated", {
      session: JSON.parse(JSON.stringify(session)),
      emittedAt: nowIso(),
    });
  }

  private isTerminal(status: CollabAgentSessionRecord["status"]) {
    return status === "completed" || status === "failed" || status === "closed";
  }

  private findSession(id: string): LiveSession | null {
    return resolveCollabSessionByExternalId(this.sessions.values(), id);
  }

  private notFound(id: string): CollabToolExecResult {
    return {
      ok: false,
      output: { ok: false, error: "COLLAB_SESSION_NOT_FOUND", detail: id },
      executedBy: "gateway",
    };
  }
}

function cleanMessage(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
