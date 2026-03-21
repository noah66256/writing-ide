import type { RunState, WorkflowSkillPhaseSnapshot } from "@ohmycrab/agent-core";
import type { RunContext } from "./writingAgentRunner.js";

export type StyleOrchestratorTask = {
  /** 写作任务描述（主题/受众/平台/长度等） */
  description: string;
  /** 候选稿文本（将用于 lint.copy / lint.style / 最终写入） */
  draft: string;
  /** 可选：长度提示（例如 “约 800 字”），主要给上游提示用 */
  lengthHint?: string;
  /** 可选：终稿写入路径（如 drafts/script.md）；不传则只做 lint 不写文件 */
  outputPathHint?: string;
};

export type StyleOrchestratorResult = {
  ok: boolean;
  /** 若已写入终稿，则为写入路径 */
  path?: string;
  /** 本次 orchestrator 的简要摘要，用于 tool_result 展示 */
  summary?: string;
  /** 若失败，则为错误编码/简要原因 */
  error?: string;
};

export type StyleOrchestratorToolExecResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

export type StyleOrchestratorArgs = {
  ctx: RunContext;
  runState: RunState;
  task: StyleOrchestratorTask;
  /**
   * 由上层 Runner 提供的工具执行回调。
   * 要求：
   * - 内部必须调用 _updateRunState，保持 RunState 与工具调用一致；
   * - 负责写入 tool.result SSE 与 turnEngine 记录。
   */
  executeTool: (toolName: string, args: Record<string, unknown>) => Promise<StyleOrchestratorToolExecResult>;
};

export type StyleTurnCaps = {
  active: boolean;
  orchestratorMode: boolean;
  snapshot: WorkflowSkillPhaseSnapshot;
  allowedToolNames: string[];
  hint: string;
};

function buildStyleSnapshot(state: RunState): WorkflowSkillPhaseSnapshot {
  const hasSelectedStyleLibrary = Boolean((state as any).hasSelectedStyleLibrary);
  const topicConfirmed = Boolean((state as any).topicConfirmed);
  const hasStyleKbSearch = Boolean((state as any).hasStyleKbSearch);
  const hasStylePlan = Boolean((state as any).hasStylePlan);
  const hasDraftText = Boolean((state as any).hasDraftText);
  const copyLintAccepted = Boolean((state as any).copyLintSatisfied || (state as any).copyLintPassed || (state as any).copyGateDegraded);
  const styleLintAccepted = Boolean((state as any).styleLintSatisfied || (state as any).styleLintPassed || (state as any).lintGateDegraded);
  const finalWritten = Boolean((state as any).finalWritten);

  let currentPhase = "completed";
  if (!hasSelectedStyleLibrary) currentPhase = "need_style_library";
  else if (!topicConfirmed) currentPhase = "need_topic";
  else if (!hasStyleKbSearch) currentPhase = "need_style_kb";
  else if (!hasStylePlan) currentPhase = "need_tone_outline";
  else if (!hasDraftText) currentPhase = "need_draft";
  else if (!copyLintAccepted) currentPhase = "need_copy_lint";
  else if (!styleLintAccepted) currentPhase = "need_style_lint";
  else if (!finalWritten) currentPhase = "need_final_write";

  const missingSteps: string[] = [];
  if (!hasSelectedStyleLibrary) missingSteps.push("select_style_library");
  if (!topicConfirmed) missingSteps.push("confirm_topic");
  if (!hasStyleKbSearch) missingSteps.push("kb.search(style)");
  if (!hasStylePlan) missingSteps.push("tone_and_outline");
  if (!hasDraftText) missingSteps.push("draft");
  if (!copyLintAccepted) missingSteps.push("lint.copy");
  if (!styleLintAccepted) missingSteps.push("lint.style");
  if (!finalWritten) missingSteps.push("final_write");

  return {
    id: "style_imitate",
    active: true,
    phases: [
      "need_style_library",
      "need_topic",
      "need_style_kb",
      "need_tone_outline",
      "need_draft",
      "need_copy_lint",
      "need_style_lint",
      "need_final_write",
      "completed",
    ],
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

function planStyleNextStep(snapshot: WorkflowSkillPhaseSnapshot): string | null {
  if (snapshot.id !== "style_imitate") return null;
  const phase = String(snapshot.currentPhase ?? "").trim();
  if (phase === "need_style_library") return "kb.listLibraries";
  if (phase === "need_topic") return "run.done";
  if (phase === "need_style_kb") return "kb.search";
  if (phase === "need_draft") return "write";
  if (phase === "need_copy_lint") return "lint.copy";
  if (phase === "need_style_lint") return "lint.style";
  if (phase === "need_final_write") return "write";
  return null;
}

function buildHint(snapshot: WorkflowSkillPhaseSnapshot, state: RunState, nextTool: string | null): string {
  const phase = String(snapshot.currentPhase ?? "").trim();
  const lastCopyLint = (state as any).lastCopyLint ?? null;
  const lastStyleLint = (state as any).lastStyleLint ?? null;

  if (phase === "need_style_library") {
    return [
      "style_imitate 编排阶段：当前先确认风格库。",
      "- 优先列出 style 库并等待用户确认；不要默认使用第一个库。",
    ].join("\n");
  }

  if (phase === "need_topic") {
    return [
      "style_imitate 编排阶段：当前缺少写作主题。",
      "- 先向用户确认题目或核心观点，然后 run.done 等待回复。",
    ].join("\n");
  }

  if (phase === "need_style_kb") {
    return [
      "style_imitate 编排阶段：当前先做风格样例检索。",
      "- 只调用 kb.search，并限定在 purpose=style 的风格库中检索写法模板/规则卡。",
      "- 不要先写草稿，不要先跑 lint。",
    ].join("\n");
  }

  if (phase === "need_tone_outline") {
    return [
      "style_imitate 编排阶段：风格规则卡已具备，先完成定调与骨架。",
      "- toneCard / structureOutline 必须先进入 runtime state，再继续正文写作。",
    ].join("\n");
  }

  if (phase === "need_draft") {
    return [
      "style_imitate 编排阶段：风格样例已具备，现在先产出候选草稿。",
      "- 只调用 write 生成候选稿（draft），不要直接宣称终稿完成。",
      "- 草稿应服务于后续 lint.copy / lint.style，不要跳过审计。",
    ].join("\n");
  }

  if (phase === "need_copy_lint") {
    if (lastCopyLint && !Boolean((state as any).copyLintPassed)) {
      return [
        "style_imitate 编排阶段：copy lint 尚未通过，先改稿再复检。",
        "- 优先使用 edit（或必要时 write）根据上轮 lint.copy 的 rewritePrompt/重合风险做降重。",
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
        "- 优先使用 edit（或必要时 write）根据上轮 lint.style 的 issues/rewritePrompt 改稿。",
        "- 改完后再调用 lint.style 复检；不要直接终稿写入。",
      ].join("\n");
    }
    return [
      "style_imitate 编排阶段：copy lint 已通过，现在做风格校验。",
      "- 优先调用 lint.style，确认结构/节奏/语气已贴合目标风格。",
      "- style lint 通过后，才进入终稿写入。",
    ].join("\n");
  }

  if (phase === "need_final_write") {
    return [
      "style_imitate 编排阶段：lint 已满足，现在把 best draft 落成终稿。",
      "- 优先 write / edit 更新终稿，再 run.done 收口。",
    ].join("\n");
  }

  return [
    "style_imitate 编排阶段：闭环已完成，可以进入交付。",
    "- 允许调用 write / edit 落盘终稿，并最终 run.done。",
    nextTool ? `- 当前建议优先动作：${nextTool}` : "- 当前建议优先动作：write（终稿）或 run.done。",
  ].join("\n");
}

function makeSyntheticArtifactId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function ensureStylePlanCheckpoint(runState: RunState, detail?: { task?: string | null }) {
  const state = runState as any;
  const refs =
    state.stepArtifactRefs && typeof state.stepArtifactRefs === "object" && !Array.isArray(state.stepArtifactRefs)
      ? { ...(state.stepArtifactRefs as Record<string, unknown>) }
      : {};
  if (!refs.tone_setting) {
    refs.tone_setting = {
      artifactId: makeSyntheticArtifactId("style_tone"),
      stepId: "tone_setting",
      kind: "tone_card",
      attempt: 1,
    };
  }
  if (!refs.structure) {
    refs.structure = {
      artifactId: makeSyntheticArtifactId("style_structure"),
      stepId: "structure",
      kind: "structure_outline",
      attempt: 1,
    };
  }
  state.stepArtifactRefs = refs;
  state.hasToneCard = true;
  state.hasStructureOutline = true;
  state.hasStylePlan = true;
  if (!String(state.styleTopic ?? "").trim()) {
    const task = String(detail?.task ?? "").trim();
    if (task) state.styleTopic = task;
  }
}

export function computeStyleTurnCaps(args: {
  runState: RunState;
  runCtx: Pick<RunContext, "intent" | "gates" | "activeSkills" | "styleWorkflowRequested">;
  baseAllowedToolNames: Set<string>;
}): StyleTurnCaps | null {
  const gates: any = args.runCtx.gates ?? {};
  const intent: any = args.runCtx.intent ?? {};
  const activeSkillsRaw = Array.isArray((args.runCtx as any).activeSkills) ? (args.runCtx as any).activeSkills : [];
  const activeSkillIds = activeSkillsRaw.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
  const styleSkillActive = activeSkillIds.includes("style_imitate");
  if (!styleSkillActive || !intent?.isWritingTask) return null;

  const snapshot = buildStyleSnapshot(args.runState);
  const nextTool = planStyleNextStep(snapshot);
  const phase = String(snapshot.currentPhase ?? "").trim();
  const allowed = new Set<string>();
  const addIfAllowed = (toolName: string) => {
    if (args.baseAllowedToolNames.has(toolName)) allowed.add(toolName);
  };

  if (phase === "need_style_library") {
    addIfAllowed("kb.listLibraries");
  } else if (phase === "need_topic") {
    addIfAllowed("run.done");
  } else if (phase === "need_style_kb") {
    addIfAllowed("kb.search");
  } else if (phase === "need_tone_outline") {
    addIfAllowed("write");
  } else if (phase === "need_draft") {
    addIfAllowed("write");
  } else if (phase === "need_copy_lint") {
    const hasPriorCopyLint = Boolean((args.runState as any).lastCopyLint);
    if (hasPriorCopyLint) {
      addIfAllowed("edit");
      addIfAllowed("write");
    }
    addIfAllowed("lint.copy");
  } else if (phase === "need_style_lint") {
    const hasPriorStyleLint = Boolean((args.runState as any).lastStyleLint);
    if (hasPriorStyleLint) {
      addIfAllowed("edit");
      addIfAllowed("write");
    }
    addIfAllowed("lint.style");
  } else if (phase === "need_final_write") {
    addIfAllowed("write");
    addIfAllowed("edit");
    addIfAllowed("run.mainDoc.update");
  } else {
    addIfAllowed("write");
    addIfAllowed("edit");
    addIfAllowed("run.mainDoc.update");
    addIfAllowed("run.done");
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
  args: StyleOrchestratorArgs,
): Promise<StyleOrchestratorResult> {
  const { ctx, runState, task, executeTool } = args;

  const description = String(task.description ?? "").trim();
  const draft = String((task as any).draft ?? "").trim();
  const outputPath = String(task.outputPathHint ?? "").trim();

  if (!draft) {
    return {
      ok: false,
      error: "DRAFT_REQUIRED",
      summary: "style_imitate.run 需要候选稿文本（draft）作为输入。",
    };
  }

  // 当前仅在写作 + 风格 gate 场景下才执行完整闭环；其它场景退回普通工具路径。
  const styleGateEnabled = Boolean(ctx.gates?.styleGateEnabled && ctx.intent?.isWritingTask);
  if (!styleGateEnabled) {
    return {
      ok: false,
      error: "STYLE_GATE_DISABLED",
      summary: "当前未启用风格闭环（未绑定风格库或非写作任务），style_imitate.run 不执行。",
    };
  }

  const styleLibIds = Array.isArray(ctx.styleLibIds)
    ? ctx.styleLibIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];

  (runState as any).hasDraftText = Boolean((runState as any).hasDraftText) || Boolean(draft);
  if (!(runState as any).bestDraft && draft) {
    const artifactId = makeSyntheticArtifactId("style_draft");
    (runState as any).bestDraft = {
      artifactId,
      charCount: draft.length,
      styleScore: 0,
      highIssues: 0,
      copy: null,
    };
    (runState as any).bestStyleDraft = {
      artifactId,
      charCount: draft.length,
      score: 0,
      highIssues: 0,
    };
  }

  // S0：若尚未完成风格样例检索，先做一轮 kb.search(card) 以满足 hasStyleKbSearch，
  // 避免 workflowSkills snapshot 长期停留在 need_style_kb。
  if (!runState.hasStyleKbSearch && styleLibIds.length > 0) {
    const kbArgs: Record<string, unknown> = {
      query: description || "风格样例",
      kind: "card",
      libraryIds: styleLibIds,
      cardTypes: ["hook", "one_liner", "ending", "outline", "thesis"],
      perDocTopN: 3,
      topDocs: 8,
      debug: false,
    };
    const kbRes = await executeTool("kb.search", kbArgs);
    if (!kbRes.ok) {
      return {
        ok: false,
        error: "STYLE_KB_SEARCH_FAILED",
        summary: "风格样例检索失败，未能进入 lint 阶段。",
      };
    }
  }
  if (runState.hasStyleKbSearch) {
    ensureStylePlanCheckpoint(runState, { task: description || null });
  }

  // S1：copy lint（anti-regurgitation）
  const copyArgs: Record<string, unknown> = { text: draft };
  if (styleLibIds.length > 0) copyArgs.libraryIds = styleLibIds;
  const copyRes = await executeTool("lint.copy", copyArgs);
  if (!copyRes.ok) {
    return {
      ok: false,
      error: "COPY_LINT_FAILED",
      summary: "lint.copy 执行失败，请检查工具调用参数或稍后重试。",
    };
  }

  if (!runState.copyLintPassed) {
    return {
      ok: false,
      error: "COPY_LINT_NOT_PASSED",
      summary: "复述/重合风险较高，lint.copy 未通过，请根据 lint 结果中的建议先做降重再重试。",
    };
  }

  // S2：style lint（风格对齐）
  const styleArgs: Record<string, unknown> = { text: draft };
  if (styleLibIds.length > 0) styleArgs.libraryIds = styleLibIds;
  const styleRes = await executeTool("lint.style", styleArgs);
  if (!styleRes.ok) {
    return {
      ok: false,
      error: "STYLE_LINT_FAILED",
      summary: "lint.style 执行失败，请检查工具调用参数或稍后重试。",
    };
  }

  if (!runState.styleLintPassed) {
    return {
      ok: false,
      error: "STYLE_LINT_NOT_PASSED",
      summary: "风格校验未通过，请根据 lint.style 的 issues/rewritePrompt 修稿后再重试。",
    };
  }

  // S3：终稿写入（可选）
  if (outputPath) {
    const writeArgs: Record<string, unknown> = { path: outputPath, content: draft };
    const writeRes = await executeTool("write", writeArgs);
    if (!writeRes.ok) {
      return {
        ok: false,
        error: "WRITE_FAILED",
        summary: `风格闭环已通过，但写入终稿到 ${outputPath} 失败，请检查路径。`,
      };
    }
    return {
      ok: true,
      path: outputPath,
      summary: `风格闭环已完成并写入终稿：${outputPath}`,
    };
  }

  return {
    ok: true,
    summary: "风格闭环 lint 已完成（未写入文件，请按需要调用 write/edit 落盘）。",
  };
}
