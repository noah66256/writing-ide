import type { AgentMode } from "./index.js";
import type {
  RunIntent,
  RunGates,
  RunState,
  ParsedToolCall,
  StyleWorkflowBatchAnalysis,
} from "./runMachine.js";
import { analyzeStyleWorkflowBatch } from "./runMachine.js";

export type WorkflowSkillPhaseSnapshot = {
  id: string;
  active: boolean;
  phases: string[];
  currentPhase: string;
  missingSteps: string[];
};

export type WorkflowSkillContract = {
  id: string;
  kind: "workflow";
  match: (args: {
    mode: AgentMode;
    intent: RunIntent;
    gates: RunGates;
    activeSkillIds?: string[] | null;
  }) => boolean;
  snapshot: (state: RunState) => WorkflowSkillPhaseSnapshot;
  analyzeBatch: (args: {
    mode: AgentMode;
    intent: RunIntent;
    gates: RunGates;
    state: RunState;
    lintMaxRework: number;
    toolCalls: ParsedToolCall[];
  }) => StyleWorkflowBatchAnalysis;
};

function computeStylePhaseAndMissing(state: RunState): {
  phases: string[];
  currentPhase: string;
  missingSteps: string[];
} {
  const phases = [
    "need_style_kb",
    "need_draft",
    "need_copy_lint",
    "need_style_lint",
    "completed",
  ];

  const hasStyleKbSearch = Boolean((state as any).hasStyleKbSearch);
  const hasDraftText = Boolean((state as any).hasDraftText);
  const copyLintPassed = Boolean((state as any).copyLintPassed);
  const styleLintPassed = Boolean((state as any).styleLintPassed);

  let currentPhase: string;
  if (!hasStyleKbSearch) currentPhase = "need_style_kb";
  else if (!hasDraftText) currentPhase = "need_draft";
  else if (!copyLintPassed) currentPhase = "need_copy_lint";
  else if (!styleLintPassed) currentPhase = "need_style_lint";
  else currentPhase = "completed";

  const missingSteps: string[] = [];
  if (!hasStyleKbSearch) missingSteps.push("kb.search(style)");
  if (!hasDraftText) missingSteps.push("draft");
  if (!copyLintPassed) missingSteps.push("lint.copy");
  if (!styleLintPassed) missingSteps.push("lint.style");

  return { phases, currentPhase, missingSteps };
}

const styleImitateWorkflowContract: WorkflowSkillContract = {
  id: "style_imitate",
  kind: "workflow",
  match: ({ mode, intent, gates, activeSkillIds }) => {
    if (mode !== "agent") return false;
    const skillIds = Array.isArray(activeSkillIds)
      ? activeSkillIds.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const hasSkillId = skillIds.includes("style_imitate");
    // 与 deriveStyleGate 保持一致：有风格库 + 写作意图 即视为需要启用 style_imitate
    const gateEnabled = gates.styleGateEnabled && intent.isWritingTask;
    return gateEnabled || hasSkillId;
  },
  snapshot: (state) => {
    const { phases, currentPhase, missingSteps } = computeStylePhaseAndMissing(state);
    const completed = currentPhase === "completed";
    return {
      id: "style_imitate",
      active: true,
      phases,
      currentPhase,
      missingSteps: completed ? [] : missingSteps,
    };
  },
  analyzeBatch: ({ mode, intent, gates, state, lintMaxRework, toolCalls }) =>
    analyzeStyleWorkflowBatch({ mode, intent, gates, state, lintMaxRework, toolCalls }),
};

export function getWorkflowSkillContracts(): WorkflowSkillContract[] {
  // 目前仅有 style_imitate 一个 workflow skill；后续可在此扩展。
  return [styleImitateWorkflowContract];
}

export function getActiveWorkflowSkills(args: {
  mode: AgentMode;
  intent: RunIntent;
  gates: RunGates;
  activeSkillIds?: string[] | null;
}): WorkflowSkillContract[] {
  const contracts = getWorkflowSkillContracts();
  return contracts.filter((c) => {
    try {
      return c.match(args);
    } catch {
      return false;
    }
  });
}

export function planStyleNextStep(snapshot: WorkflowSkillPhaseSnapshot): string | null {
  if (snapshot.id !== "style_imitate") return null;
  const phase = snapshot.currentPhase;
  if (phase === "need_style_kb") return "kb.search";
  if (phase === "need_draft") return "write";
  if (phase === "need_copy_lint") return "lint.copy";
  if (phase === "need_style_lint") return "lint.style";
  return null;
}
