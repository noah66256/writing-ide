import type { ItemRecord } from "@ohmycrab/shared";
import type {
  AssistantStep,
  RuntimeCollabSessionRecord,
  RuntimeItemRecord,
  Step,
  ToolApplyPolicy,
  ToolBlockStep,
  ToolRiskLevel,
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

function isDerivedRuntimeProjectionStepId(id: unknown) {
  return String(id ?? "").trim().startsWith("item_");
}

function hasRenderableAssistantStep(step: Step): boolean {
  if (!step || step.type !== "assistant") return false;
  if (String((step as AssistantStep).variant ?? "default") === "progress") return false;
  const text = String((step as AssistantStep).text ?? "").trim();
  const quickActionsCount = Array.isArray((step as AssistantStep).quickActions)
    ? (step as AssistantStep).quickActions!.length
    : 0;
  return text.length > 0 || quickActionsCount > 0 || Boolean((step as AssistantStep).streaming);
}

function stripDerivedRuntimeProjectionSteps(steps: Step[]): Step[] {
  const list = Array.isArray(steps) ? steps : [];
  const hasLocalAssistantTranscript = list.some(
    (step) => step?.type === "assistant" && !isDerivedRuntimeProjectionStepId(step.id) && hasRenderableAssistantStep(step),
  );
  const hasLocalToolTranscript = list.some(
    (step) => step?.type === "tool" && !isDerivedRuntimeProjectionStepId(step.id),
  );
  return list.filter((step) => {
    if (!step || typeof step !== "object") return false;
    if (!isDerivedRuntimeProjectionStepId(step.id)) return true;
    if (step.type === "assistant" && hasLocalAssistantTranscript) return false;
    if (step.type === "tool" && hasLocalToolTranscript) return false;
    return true;
  });
}

function projectItemToStep(item: ItemRecord): Step | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage") {
    const text = String((item as any).text ?? "");
    if (!text.trim()) return null;
    return {
      id: item.id,
      type: "assistant",
      text,
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

function hasLocalAssistantTranscriptStep(steps: Step[]): boolean {
  return steps.some(
    (step) =>
      step?.type === "assistant"
      && String((step as AssistantStep).variant ?? "default") !== "progress",
  );
}

function hasLocalToolTranscriptStep(steps: Step[]): boolean {
  return steps.some((step) => step?.type === "tool");
}

export function projectRuntimeItemsToSteps(args?: RuntimeStateLike): Step[] {
  const existingSteps = stripDerivedRuntimeProjectionSteps(Array.isArray(args?.steps) ? args!.steps : []);
  const items = Array.isArray(args?.items) ? args!.items : [];
  if (!items.length) return existingSteps;

  const shouldSuppressAgentMessageItems = hasLocalAssistantTranscriptStep(existingSteps);
  const shouldSuppressToolCallItems = hasLocalToolTranscriptStep(existingSteps);

  const projectedPairs = items
    .filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (item.type === "progress") return false;
      if (item.type === "agentMessage" && shouldSuppressAgentMessageItems) return false;
      if (item.type === "toolCall" && shouldSuppressToolCallItems) return false;
      if (item.type === "collabAgentToolCall" && shouldSuppressToolCallItems) return false;
      return true;
    })
    .map((item, index) => ({
      item,
      index,
      step: projectItemToStep(item as ItemRecord),
      ts: toEpochMs((item as any)?.createdAt ?? (item as any)?.updatedAt, index),
    }))
    .filter((entry): entry is { item: RuntimeItemRecord; index: number; step: Step; ts: number } => Boolean(entry.step));

  if (!projectedPairs.length) return existingSteps;

  if (!existingSteps.length) {
    return projectedPairs
      .sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return a.index - b.index;
      })
      .map((entry) => entry.step);
  }

  // 运行时 items 负责“覆盖同 id 的最新状态 + 补充 step 流中没有的新条目”，
  // 但绝不能反向删除已经加载出来的历史 transcript。
  const projectedById = new Map(
    projectedPairs
      .map((entry) => [String((entry.item as any)?.id ?? "").trim(), entry.step] as const)
      .filter(([id]) => Boolean(id)),
  );

  const merged: Step[] = [];
  const seen = new Set<string>();
  for (const step of existingSteps) {
    if (!step || typeof step !== "object") continue;
    const id = String(step.id ?? "").trim();
    if (!id) {
      merged.push(step);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(projectedById.get(id) ?? step);
  }

  const appended = projectedPairs
    .filter((entry) => {
      const id = String((entry.item as any)?.id ?? "").trim();
      return Boolean(id) && !seen.has(id);
    })
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a.index - b.index;
    });

  for (const entry of appended) {
    const id = String((entry.item as any)?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(entry.step);
  }

  return merged;
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
