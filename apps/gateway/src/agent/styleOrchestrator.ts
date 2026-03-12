import { planStyleNextStep, type RunState, type WorkflowSkillPhaseSnapshot } from "@ohmycrab/agent-core";
import type { RunContext } from "./writingAgentRunner.js";

export type StyleOrchestratorTask = {
  description: string;
  lengthHint?: string;
  outputPathHint?: string;
};

export type StyleOrchestratorResult = {
  ok: boolean;
  path?: string;
  summary?: string;
  error?: string;
};

export type StyleOrchestratorArgs = {
  ctx: RunContext;
  runState: RunState;
  task: StyleOrchestratorTask;
};

export type StyleTurnCaps = {
  active: boolean;
  orchestratorMode: boolean;
  snapshot: WorkflowSkillPhaseSnapshot;
  allowedToolNames: string[];
  hint: string;
};

function buildStyleSnapshot(state: RunState): WorkflowSkillPhaseSnapshot {
  const hasStyleKbSearch = Boolean((state as any).hasStyleKbSearch);
  const hasDraftText = Boolean((state as any).hasDraftText);
  const copyLintPassed = Boolean((state as any).copyLintPassed);
  const styleLintPassed = Boolean((state as any).styleLintPassed);

  let currentPhase = "completed";
  if (!hasStyleKbSearch) currentPhase = "need_style_kb";
  else if (!hasDraftText) currentPhase = "need_draft";
  else if (!copyLintPassed) currentPhase = "need_copy_lint";
  else if (!styleLintPassed) currentPhase = "need_style_lint";

  const missingSteps: string[] = [];
  if (!hasStyleKbSearch) missingSteps.push("kb.search(style)");
  if (!hasDraftText) missingSteps.push("draft");
  if (!copyLintPassed) missingSteps.push("lint.copy");
  if (!styleLintPassed) missingSteps.push("lint.style");

  return {
    id: "style_imitate",
    active: true,
    phases: ["need_style_kb", "need_draft", "need_copy_lint", "need_style_lint", "completed"],
    currentPhase,
    missingSteps: currentPhase === "completed" ? [] : missingSteps,
  };
}

function uniq(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const value = String(item ?? "").trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function buildHint(snapshot: WorkflowSkillPhaseSnapshot, state: RunState, nextTool: string | null): string {
  const phase = String(snapshot.currentPhase ?? "").trim();
  const lastCopyLint = (state as any).lastCopyLint ?? null;
  const lastStyleLint = (state as any).lastStyleLint ?? null;

  if (phase === "need_style_kb") {
    return [
      "style_imitate 编排阶段：当前先做风格样例检索。",
      "- 只调用 kb.search，并限定在 purpose=style 的风格库中检索写法模板/规则卡。",
      "- 不要先写草稿，不要先跑 lint。",
    ].join("\n");
  }

  if (phase === "need_draft") {
    return [
      "style_imitate 编排阶段：风格样例已具备，现在先产出候选草稿。",
      "- 只调用 doc.write 生成候选稿（draft），不要直接宣称终稿完成。",
      "- 草稿应服务于后续 lint.copy / lint.style，不要跳过审计。",
    ].join("\n");
  }

  if (phase === "need_copy_lint") {
    if (lastCopyLint && !Boolean((state as any).copyLintPassed)) {
      return [
        "style_imitate 编排阶段：copy lint 尚未通过，先改稿再复检。",
        "- 优先使用 doc.applyEdits（或必要时 doc.write）根据上轮 lint.copy 的 rewritePrompt/重合风险做降重。",
        "- 改完后再调用 lint.copy 复检；不要提前进入 lint.style 或终稿写入。",
      ].join("\n");
    }
    return [
      "style_imitate 编排阶段：已有草稿，现在先做复述风险检查。",
      "- 优先调用 lint.copy，对候选稿做复述/重合风险审计。",
      "- copy lint 通过前，不要做终稿写入。",
    ].join("\n");
  }

  if (phase === "need_style_lint") {
    if (lastStyleLint && !Boolean((state as any).styleLintPassed)) {
      return [
        "style_imitate 编排阶段：style lint 尚未通过，先按风格问题清单修稿。",
        "- 优先使用 doc.applyEdits（或必要时 doc.write）根据上轮 lint.style 的 issues/rewritePrompt 改稿。",
        "- 改完后再调用 lint.style 复检；不要直接终稿写入。",
      ].join("\n");
    }
    return [
      "style_imitate 编排阶段：copy lint 已通过，现在做风格校验。",
      "- 优先调用 lint.style，确认结构/节奏/语气已贴合目标风格。",
      "- style lint 通过后，才进入终稿写入。",
    ].join("\n");
  }

  return [
    "style_imitate 编排阶段：闭环已完成，可以进入交付。",
    "- 允许调用 doc.write / doc.applyEdits 落盘终稿，并最终 run.done。",
    nextTool ? `- 当前建议优先动作：${nextTool}` : "- 当前建议优先动作：doc.write（终稿）或 run.done。",
  ].join("\n");
}

export function computeStyleTurnCaps(args: {
  runState: RunState;
  runCtx: Pick<RunContext, "intent" | "gates" | "activeSkills">;
  baseAllowedToolNames: Set<string>;
}): StyleTurnCaps | null {
  const gates: any = args.runCtx.gates ?? {};
  const intent: any = args.runCtx.intent ?? {};
  const activeSkillsRaw = Array.isArray((args.runCtx as any).activeSkills) ? (args.runCtx as any).activeSkills : [];
  const activeSkillIds = activeSkillsRaw.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
  const styleSkillActive = activeSkillIds.includes("style_imitate") || Boolean(gates.styleGateEnabled && intent?.isWritingTask);
  if (!styleSkillActive || !intent?.isWritingTask) return null;

  const snapshot = buildStyleSnapshot(args.runState);
  const nextTool = planStyleNextStep(snapshot);
  const phase = String(snapshot.currentPhase ?? "").trim();
  const allowed = new Set<string>();
  const addIfAllowed = (toolName: string) => {
    if (args.baseAllowedToolNames.has(toolName)) allowed.add(toolName);
  };

  [
    "run.mainDoc.get",
    "run.mainDoc.update",
    "run.setTodoList",
    "run.todo",
    "run.done",
    "time.now",
  ].forEach(addIfAllowed);

  if (phase === "need_style_kb") {
    addIfAllowed("kb.search");
  } else if (phase === "need_draft") {
    addIfAllowed("doc.write");
  } else if (phase === "need_copy_lint") {
    const hasPriorCopyLint = Boolean((args.runState as any).lastCopyLint);
    if (hasPriorCopyLint) {
      addIfAllowed("doc.applyEdits");
      addIfAllowed("doc.write");
    }
    addIfAllowed("lint.copy");
  } else if (phase === "need_style_lint") {
    const hasPriorStyleLint = Boolean((args.runState as any).lastStyleLint);
    if (hasPriorStyleLint) {
      addIfAllowed("doc.applyEdits");
      addIfAllowed("doc.write");
    }
    addIfAllowed("lint.style");
  } else {
    addIfAllowed("doc.write");
    addIfAllowed("doc.applyEdits");
  }

  const ordered = uniq(Array.from(allowed));
  return {
    active: true,
    orchestratorMode: true,
    snapshot,
    allowedToolNames: ordered,
    hint: buildHint(snapshot, args.runState, nextTool),
  };
}

export async function runOrchestratedStyleImitate(
  _args: StyleOrchestratorArgs,
): Promise<StyleOrchestratorResult> {
  return { ok: false, error: "STYLE_ORCHESTRATOR_NOT_IMPLEMENTED" };
}
