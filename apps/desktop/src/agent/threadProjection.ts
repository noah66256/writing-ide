import type { ItemRecord } from "@ohmycrab/shared";
import type {
  AssistantStep,
  RuntimeCollabSessionRecord,
  RuntimeItemRecord,
  Step,
  ToolApplyPolicy,
  ToolBlockStep,
  ToolRiskLevel,
  UserStep,
} from "../state/runStore";

type RuntimeStateLike = {
  steps?: Step[];
  items?: RuntimeItemRecord[];
  activeItemIds?: string[];
  collabSessions?: RuntimeCollabSessionRecord[];
};

function toEpochMs(raw: unknown, fallback: number) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeToolStatus(
  status: unknown,
): ToolBlockStep["status"] {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "in_progress" || value === "running") return "running";
  if (value === "failed") return "failed";
  if (value === "declined" || value === "undone") return "undone";
  return "success";
}

function normalizeToolRiskLevel(value: unknown, fallback: ToolRiskLevel = "low"): ToolRiskLevel {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "medium" || raw === "high" || raw === "low" ? (raw as ToolRiskLevel) : fallback;
}

function normalizeToolApplyPolicy(value: unknown, fallback: ToolApplyPolicy = "auto_apply"): ToolApplyPolicy {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "proposal" || raw === "auto_apply" ? (raw as ToolApplyPolicy) : fallback;
}

function buildFileChangeOutput(item: any) {
  const preview = item?.preview && typeof item.preview === "object" ? item.preview : null;
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  if (preview) {
    return {
      ok: true,
      preview,
      ...(changes.length ? { changes } : {}),
      ...(item?.note ? { note: item.note } : {}),
    };
  }
  const firstChange = changes[0] && typeof changes[0] === "object" ? changes[0] : null;
  if (!firstChange) {
    return {
      ok: true,
      ...(item?.note ? { note: item.note } : {}),
    };
  }
  return {
    ok: true,
    preview: {
      path: firstChange.path,
      diffUnified: typeof firstChange.diff === "string" ? firstChange.diff : "",
      note: item?.note,
    },
    changes,
  };
}

function buildApprovalText(item: any) {
  const question = String(item?.question ?? "").trim();
  const note = String(item?.note ?? "").trim();
  if (question && note) return `${question}\n\n${note}`;
  return question || note || "等待确认";
}

function projectItemToStep(item: ItemRecord): Step | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage") {
    return {
      id: item.id,
      type: "assistant",
      text: String((item as any).text ?? ""),
      streaming: item.status === "in_progress",
      hidden: false,
      variant: "default",
      ...(String((item as any).agentId ?? "").trim() ? {
        agentId: String((item as any).agentId ?? "").trim(),
        agentName: String((item as any).agentName ?? "").trim() || undefined,
      } : {}),
    } satisfies AssistantStep;
  }
  if (item.type === "progress") {
    return {
      id: item.id,
      type: "assistant",
      text: String((item as any).message ?? ""),
      streaming: item.status === "in_progress",
      hidden: false,
      variant: "progress",
    } satisfies AssistantStep;
  }
  if (item.type === "approval") {
    return {
      id: item.id,
      type: "assistant",
      text: buildApprovalText(item),
      streaming: item.status === "in_progress",
      hidden: false,
      variant: "default",
    } satisfies AssistantStep;
  }
  if (item.type === "toolCall") {
    return {
      id: item.id,
      type: "tool",
      toolName: String((item as any).name ?? "tool.call"),
      status: normalizeToolStatus((item as any).status),
      input: (item as any).args,
      output:
        (item as any).status === "failed"
          ? { ok: false, error: (item as any).error ?? "TOOL_FAILED" }
          : (item as any).result,
      riskLevel: normalizeToolRiskLevel((item as any).riskLevel, "low"),
      applyPolicy: normalizeToolApplyPolicy((item as any).applyPolicy, "auto_apply"),
      kept: true,
      applied: normalizeToolApplyPolicy((item as any).applyPolicy, "auto_apply") === "auto_apply",
      undoable: false,
      ...(String((item as any).agentId ?? "").trim() ? {
        agentId: String((item as any).agentId ?? "").trim(),
      } : {}),
    } satisfies ToolBlockStep;
  }
  if (item.type === "fileChange") {
    const kept = Boolean((item as any).kept);
    const applied = Boolean((item as any).applied);
    const undoable = Boolean((item as any).undoable ?? (item as any).canUndo);
    const status =
      (item as any).status === "declined"
        ? "undone"
        : (item as any).status === "failed"
          ? "failed"
          : applied || (item as any).status === "completed"
            ? "success"
            : "success";
    return {
      id: item.id,
      type: "tool",
      toolName: String((item as any).sourceToolName ?? "file.change"),
      status,
      output: buildFileChangeOutput(item),
      riskLevel: normalizeToolRiskLevel((item as any).riskLevel, "low"),
      applyPolicy: normalizeToolApplyPolicy((item as any).applyPolicy, "proposal"),
      kept,
      applied,
      undoable: undoable && applied,
    } satisfies ToolBlockStep;
  }
  if (item.type === "collabAgentToolCall") {
    return {
      id: item.id,
      type: "tool",
      toolName: String((item as any).tool ?? "collab"),
      status: normalizeToolStatus((item as any).status),
      input: {
        prompt: (item as any).prompt ?? null,
        receiverThreadIds: Array.isArray((item as any).receiverThreadIds) ? (item as any).receiverThreadIds : [],
      },
      output: {
        ok: (item as any).status !== "failed",
        agentsStates: (item as any).agentsStates ?? null,
      },
      riskLevel: "low",
      applyPolicy: "auto_apply",
      kept: true,
      applied: true,
      undoable: false,
    } satisfies ToolBlockStep;
  }
  return null;
}

function isAssistantFallbackStep(step: AssistantStep, hasProjectedAssistantItems: boolean) {
  if (!hasProjectedAssistantItems) return true;
  if (Array.isArray(step.quickActions) && step.quickActions.length > 0) return true;
  if (String(step.agentId ?? "").trim()) return true;
  if (/\[模型错误\]/.test(String(step.text ?? ""))) return true;
  return false;
}

function isLegacyFallbackStep(
  step: Step,
  projectedItemIds: Set<string>,
  hasProjectedAssistantItems: boolean,
) {
  if (step.type === "user") return true;
  if (projectedItemIds.has(String(step.id ?? "").trim())) return false;
  if (step.type === "assistant") {
    return isAssistantFallbackStep(step, hasProjectedAssistantItems);
  }
  return true;
}

export function projectRuntimeItemsToSteps(args?: RuntimeStateLike): Step[] {
  const existingSteps = Array.isArray(args?.steps) ? args!.steps : [];
  const items = Array.isArray(args?.items) ? args!.items : [];
  if (!items.length) return existingSteps;

  const projectedPairs = items
    .map((item, index) => ({
      item,
      index,
      step: projectItemToStep(item as ItemRecord),
      ts: toEpochMs((item as any)?.createdAt ?? (item as any)?.updatedAt, index),
    }))
    .filter((entry): entry is { item: RuntimeItemRecord; index: number; step: Step; ts: number } => Boolean(entry.step));

  if (!projectedPairs.length) return existingSteps;

  const projectedItemIds = new Set(projectedPairs.map((entry) => String((entry.item as any)?.id ?? "").trim()).filter(Boolean));
  const hasProjectedAssistantItems = projectedPairs.some((entry) => entry.step.type === "assistant");
  const userSteps = existingSteps.filter((step): step is UserStep => step.type === "user");
  const legacyFallback = existingSteps.filter((step) => isLegacyFallbackStep(step, projectedItemIds, hasProjectedAssistantItems) && step.type !== "user");

  const merged = [
    ...userSteps.map((step, index) => ({ step, order: index, ts: toEpochMs(step.ts, index), lane: 0 })),
    ...legacyFallback.map((step, index) => ({ step, order: 10_000 + index, ts: Number.MAX_SAFE_INTEGER - 10_000 + index, lane: 2 })),
    ...projectedPairs.map((entry, index) => ({ step: entry.step, order: 1000 + index, ts: entry.ts, lane: 1 })),
  ]
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.lane !== b.lane) return a.lane - b.lane;
      return a.order - b.order;
    })
    .map((entry) => entry.step);

  const deduped: Step[] = [];
  const seen = new Set<string>();
  for (const step of merged) {
    const id = String(step?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(step);
  }
  return deduped;
}

export function getProjectedStepsFromRuntime(args?: RuntimeStateLike): Step[] {
  return projectRuntimeItemsToSteps(args);
}

export function buildPendingFileProposalsFromItems(items?: RuntimeItemRecord[]) {
  const list = Array.isArray(items) ? items : [];
  return list
    .filter((item) => item && typeof item === "object" && (item as any).type === "fileChange")
    .filter((item) => normalizeToolApplyPolicy((item as any).applyPolicy, "proposal") === "proposal")
    .filter((item) => !Boolean((item as any).applied))
    .filter((item) => String((item as any).status ?? "").trim().toLowerCase() !== "declined")
    .map((item) => {
      const changes = Array.isArray((item as any).changes) ? (item as any).changes : [];
      const firstChange = changes[0] && typeof changes[0] === "object" ? changes[0] : null;
      const preview = (item as any).preview && typeof (item as any).preview === "object" ? (item as any).preview : null;
      const path =
        String(preview?.path ?? firstChange?.path ?? (item as any)?.actionSpec?.applyOp?.path ?? "").trim() || undefined;
      const note = String((item as any).note ?? preview?.note ?? "").trim() || undefined;
      return {
        toolName: String((item as any).sourceToolName ?? "file.change").trim() || "file.change",
        path,
        note,
      };
    })
    .slice(-20);
}
