import { planStyleNextStep, type RunState, type WorkflowSkillPhaseSnapshot } from "@ohmycrab/agent-core";
import { CORE_TOOL_NAME_SET } from "./coreTools.js";
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

  return [
    "style_imitate 编排阶段：闭环已完成，可以进入交付。",
    "- 允许调用 write / edit 落盘终稿，并最终 run.done。",
    nextTool ? `- 当前建议优先动作：${nextTool}` : "- 当前建议优先动作：write（终稿）或 run.done。",
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

  // CORE_TOOLS：无论当前处于 style_imitate 的哪个阶段，只要在 baseAllowed 里，就不应被 per-turn gate 剪掉。
  // 这样可以确保 run.* / memory / 基础读写/检索 等核心能力始终可用。
  for (const name of CORE_TOOL_NAME_SET) {
    if (args.baseAllowedToolNames.has(name)) {
      allowed.add(name);
    }
  }

  if (phase === "need_style_kb") {
    addIfAllowed("kb.search");
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
  } else {
    addIfAllowed("write");
    addIfAllowed("edit");
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
