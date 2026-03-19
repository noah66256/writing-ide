import type {
  CollabAgentRef,
  SkillRef,
  TaskStateV2,
  ThreadRecord,
  ThreadWaitingFor,
} from "@ohmycrab/shared";

function nowIso() {
  return new Date().toISOString();
}

export function createThreadState(args: {
  threadId: string;
  convId?: string | null;
  activeSkillRefs?: SkillRef[];
  taskState?: TaskStateV2 | null;
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
