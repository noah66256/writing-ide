import type {
  CollabAgentRef,
  SkillRef,
  ThreadCapabilityState,
  ThreadImageArtifactRef,
  ThreadImageSessionV1,
  TaskStateV2,
  ThreadRecord,
  ThreadWaitingFor,
} from "@ohmycrab/shared";
import { normalizeThreadCapabilityState } from "../threadCapabilityState.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeThreadImageSession(
  session: ThreadImageSessionV1 | null | undefined,
): ThreadImageSessionV1 | null {
  if (!session || typeof session !== "object") return null;
  const recentArtifacts = Array.isArray(session.recentArtifacts)
    ? session.recentArtifacts
        .filter((item) => item && typeof item === "object" && String(item.artifactId ?? "").trim())
        .map<ThreadImageArtifactRef>((item) => {
          const source: ThreadImageArtifactRef["source"] =
            item.source === "user_upload" ? "user_upload" : item.source === "edited" ? "edited" : "generated";
          return {
            artifactId: String(item.artifactId ?? "").trim(),
            ...(String(item.path ?? "").trim() ? { path: String(item.path ?? "").trim() } : {}),
            source,
            createdAt: String(item.createdAt ?? "").trim() || nowIso(),
            ...(String(item.prompt ?? "").trim() ? { prompt: String(item.prompt ?? "").trim() } : {}),
            ...(String(item.aspectRatio ?? "").trim() ? { aspectRatio: String(item.aspectRatio ?? "").trim() } : {}),
            ...(String(item.mimeType ?? "").trim() ? { mimeType: String(item.mimeType ?? "").trim() } : {}),
          };
        })
        .slice(-24)
    : [];
  return {
    v: 1,
    recentArtifacts,
    lastGeneratedArtifactId: String(session.lastGeneratedArtifactId ?? "").trim() || null,
    lastEditedArtifactId: String(session.lastEditedArtifactId ?? "").trim() || null,
    defaultAspectRatio: String(session.defaultAspectRatio ?? "").trim() || null,
    preferredProvider: "gemini_nb",
    updatedAt: String(session.updatedAt ?? "").trim() || nowIso(),
  };
}

export function createThreadState(args: {
  threadId: string;
  convId?: string | null;
  activeSkillRefs?: SkillRef[];
  taskState?: TaskStateV2 | null;
  capabilityState?: ThreadCapabilityState | null;
  imageSession?: ThreadImageSessionV1 | null;
}): ThreadRecord {
  const now = nowIso();
  return {
    id: String(args.threadId ?? "").trim(),
    convId: args.convId ?? null,
    status: "idle",
    waitingFor: "none",
    waiting: null,
    activeSkillRefs: Array.isArray(args.activeSkillRefs) ? args.activeSkillRefs : [],
    activeCollabAgents: [],
    pendingProposalIds: [],
    pendingApprovalIds: [],
    taskState: args.taskState ?? null,
    capabilityState: normalizeThreadCapabilityState(args.capabilityState),
    imageSession: normalizeThreadImageSession(args.imageSession),
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneThreadState(thread: ThreadRecord): ThreadRecord {
  return {
    ...thread,
    activeSkillRefs: [...(thread.activeSkillRefs ?? [])],
    activeCollabAgents: [...(thread.activeCollabAgents ?? [])],
    pendingProposalIds: [...(thread.pendingProposalIds ?? [])],
    pendingApprovalIds: [...(thread.pendingApprovalIds ?? [])],
    waiting: thread.waiting ? { ...thread.waiting } : null,
    taskState: thread.taskState
      ? {
          ...thread.taskState,
          workflow: thread.taskState.workflow ? { ...thread.taskState.workflow } : null,
          compositeTask: thread.taskState.compositeTask ? { ...thread.taskState.compositeTask } : null,
          pendingArtifacts: Array.isArray(thread.taskState.pendingArtifacts)
            ? thread.taskState.pendingArtifacts.map((item) => ({ ...item }))
            : thread.taskState.pendingArtifacts,
        }
      : null,
    capabilityState: thread.capabilityState
      ? {
          ...normalizeThreadCapabilityState(thread.capabilityState),
          lastActivatedAt: thread.capabilityState.lastActivatedAt
            ? { ...thread.capabilityState.lastActivatedAt }
            : undefined,
        }
      : null,
    imageSession: normalizeThreadImageSession(thread.imageSession),
  };
}

export function setThreadStatus(
  thread: ThreadRecord,
  status: ThreadRecord["status"],
): ThreadRecord {
  return {
    ...cloneThreadState(thread),
    status,
    updatedAt: nowIso(),
  };
}

export function updateThreadWaiting(args: {
  thread: ThreadRecord;
  waitingFor: ThreadWaitingFor;
  waiting?: ThreadRecord["waiting"];
}): ThreadRecord {
  const nextStatus =
    args.waitingFor === "none"
      ? args.thread.status === "failed"
        ? "failed"
        : "running"
      : "waiting";
  return {
    ...cloneThreadState(args.thread),
    status: nextStatus,
    waitingFor: args.waitingFor,
    waiting: args.waiting ?? null,
    updatedAt: nowIso(),
  };
}

export function updateActiveSkills(
  thread: ThreadRecord,
  activeSkillRefs: SkillRef[],
): ThreadRecord {
  return {
    ...cloneThreadState(thread),
    activeSkillRefs: Array.isArray(activeSkillRefs) ? activeSkillRefs : [],
    updatedAt: nowIso(),
  };
}

export function upsertCollabAgent(
  thread: ThreadRecord,
  agent: CollabAgentRef,
): ThreadRecord {
  const next = [...(thread.activeCollabAgents ?? [])];
  const idx = next.findIndex((item) => item.threadId === agent.threadId || item.agentId === agent.agentId);
  if (idx >= 0) next[idx] = { ...next[idx], ...agent };
  else next.push(agent);
  return {
    ...cloneThreadState(thread),
    activeCollabAgents: next,
    updatedAt: nowIso(),
  };
}

export function updateTaskState(
  thread: ThreadRecord,
  taskState: TaskStateV2 | null | undefined,
): ThreadRecord {
  return {
    ...cloneThreadState(thread),
    taskState: taskState ?? null,
    updatedAt: nowIso(),
  };
}

export function updateThreadCapabilityState(
  thread: ThreadRecord,
  capabilityState: ThreadCapabilityState | null | undefined,
): ThreadRecord {
  return {
    ...cloneThreadState(thread),
    capabilityState: normalizeThreadCapabilityState(capabilityState),
    updatedAt: nowIso(),
  };
}
