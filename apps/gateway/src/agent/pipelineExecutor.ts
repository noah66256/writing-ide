import { randomUUID } from "node:crypto";

import {
  completionOnceViaProvider,
} from "../llm/providerAdapter.js";
import type { ChatCompletionOnceResult, OpenAiChatMessage } from "../llm/openaiCompat.js";
import type { RunContext } from "./writingAgentRunner.js";
import { parseStyleLintResult, type RunState } from "@ohmycrab/agent-core";
import type {
  PipelineConfigV1,
  DraftTextPayloadV1,
  StylePipelinePayloadV1,
  StructureOutlineV1,
  ToneCardV1,
} from "@ohmycrab/agent-core";

const TOOL_RESULT_TIMEOUT_MS = 600_000;

type PipelineOutcome = {
  status: "completed" | "failed" | "aborted";
  reason: string;
  reasonCodes: string[];
  detail?: unknown;
};

type PipelineRunResult = {
  outcome: PipelineOutcome;
  executionReport: Record<string, unknown>;
};

function nowIso() {
  return new Date().toISOString();
}

function hasAbortSignal(signal?: AbortSignal) {
  try {
    return Boolean(signal?.aborted);
  } catch {
    return false;
  }
}

function extractJsonObject(content: string): string | null {
  const raw = String(content ?? "").trim();
  if (!raw) return null;
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    return raw;
  }
  // 去掉代码块包裹
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = String(fenced[1]).trim();
    if (inner.startsWith("{") && inner.includes("}")) return inner;
  }
  // 尝试从头找第一个 "{" 到最后一个 "}" 的片段
  const i0 = raw.indexOf("{");
  const i1 = raw.lastIndexOf("}");
  if (i0 >= 0 && i1 > i0) return raw.slice(i0, i1 + 1);
  return null;
}

function normalizeText(content: string) {
  return String(content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function truncateForPrompt(value: unknown, maxChars = 1600) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  const normalized = String(text ?? "").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}\n…`;
}

function buildCopyRewriteMessages(args: { draft: string; lintOutput: any }): OpenAiChatMessage[] {
  const output = args.lintOutput && typeof args.lintOutput === "object" ? args.lintOutput : {};
  const feedback = {
    riskLevel: String(output?.riskLevel ?? "").trim() || null,
    maxOverlapChars: Number(output?.maxOverlapChars ?? 0) || 0,
    maxChar5gramJaccard: Number(output?.maxChar5gramJaccard ?? 0) || 0,
    topOverlaps: Array.isArray(output?.topOverlaps) ? output.topOverlaps.slice(0, 3) : [],
  };
  return [
    {
      role: "system",
      content:
        "你是风格仿写管线中的 copy-lint 修稿器。\n" +
        "- 目标：降低复述/重合风险，但保留原信息结构与事实。\n" +
        "- 严禁新增事实、数字、案例、结论。\n" +
        "- 优先改写高重合片段：换句式、拆句、改转折、改表达顺序。\n" +
        "- 只输出改写后的全文，不要解释。",
    },
    {
      role: "user",
      content:
        `当前草稿：\n${args.draft}\n\n` +
        `copy lint 反馈（精简）：\n${truncateForPrompt(feedback, 1200)}`,
    },
  ];
}

function buildStyleRewriteMessages(args: { draft: string; lintOutput: any }): OpenAiChatMessage[] {
  const parsed = parseStyleLintResult(args.lintOutput);
  const issues = Array.isArray(args.lintOutput?.issues) ? args.lintOutput.issues.slice(0, 5) : [];
  const feedback = {
    score: parsed.score,
    highIssues: parsed.highIssues,
    summary: parsed.summary,
    missingDimensions: parsed.missingDimensions,
    issues,
    rewritePrompt: parsed.rewritePrompt,
  };
  return [
    {
      role: "system",
      content:
        "你是风格仿写管线中的 style-lint 修稿器。\n" +
        "- 目标：在不新增事实/案例/数字的前提下，让草稿更贴近目标风格。\n" +
        "- 必须优先解决高优先级 issue 与 missingDimensions。\n" +
        "- 保留原主题、原信息点、原结构，不要重起炉灶。\n" +
        "- 只输出改写后的全文，不要解释。",
    },
    {
      role: "user",
      content:
        `当前草稿：\n${args.draft}\n\n` +
        `style lint 反馈（精简）：\n${truncateForPrompt(feedback, 2200)}`,
    },
  ];
}

async function rewriteDraftWithMessages(args: {
  runCtx: RunContext;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number;
}) {
  const { ret } = await completionOnce(args.runCtx, {
    messages: args.messages,
    temperature: typeof args.temperature === "number" ? args.temperature : 0.4,
    maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : 2200,
  });
  if (!ret.ok) throw new Error(String(ret.error ?? "PIPELINE_REWRITE_FAILED"));
  const text = normalizeText(ret.content);
  if (!text) throw new Error("PIPELINE_REWRITE_EMPTY");
  return text;
}

function derivePipelineTargetPath(args: { runCtx: RunContext; payload: StylePipelinePayloadV1 }) {
  const mainDocPath = String(((args.runCtx.mainDoc as any)?.path ?? "")).trim();
  const payloadOutputPath = String(((args.payload as any)?.taskSpec?.outputPath ?? "")).trim();
  return payloadOutputPath || mainDocPath || `drafts/style_imitate_${Date.now()}.md`;
}

function buildStepMessages(args: {
  stepId: string;
  taskSpec: any;
  toneCard?: ToneCardV1 | null;
  structureOutline?: StructureOutlineV1 | null;
  draftText?: string | null;
  materials: any;
}): OpenAiChatMessage[] {
  const cards = args.materials ?? {};
  const sys =
    "你是“风格仿写管线（V3）”的单步执行器。\n" +
    "- 你只输出本步骤要求的内容，不要解释，不要闲聊。\n" +
    "- 禁止输出工具调用 XML。\n" +
    "- 禁止输出多余标题（除非任务明确要求标题）。\n";

  const payload: any = {
    v: 1,
    stepId: args.stepId,
    taskSpec: args.taskSpec,
    ...(args.toneCard ? { toneCard: args.toneCard } : {}),
    ...(args.structureOutline ? { structureOutline: args.structureOutline } : {}),
    ...(args.draftText ? { draftText: args.draftText } : {}),
    materials: {
      clusterRules: cards.clusterRules ?? null,
      styleProfileCard: cards.styleProfileCard ?? null,
      playbookCards: Array.isArray(cards.playbookCards) ? cards.playbookCards : [],
      elementCards: Array.isArray(cards.elementCards) ? cards.elementCards : [],
    },
    outputContract: (() => {
      if (args.stepId === "tone_setting") return { kind: "json", schema: "ToneCardV1" };
      if (args.stepId === "structure") return { kind: "json", schema: "StructureOutlineV1" };
      if (args.stepId === "opening") return { kind: "text", stage: "opening" };
      if (args.stepId === "body") return { kind: "text", stage: "body" };
      if (args.stepId === "language_rhythm") return { kind: "text", stage: "styled" };
      if (args.stepId === "polish") return { kind: "text", stage: "polished" };
      if (args.stepId === "closure") return { kind: "text", stage: "final" };
      return { kind: "text" };
    })(),
  };

  const user =
    args.stepId === "tone_setting" || args.stepId === "structure"
      ? "只输出一个 JSON 对象（不要 Markdown、不要代码块）。字段要完整。"
      : "只输出正文文本（不要 Markdown 解释，不要代码块）。";

  return [
    { role: "system", content: sys },
    { role: "user", content: `${user}\n\n${JSON.stringify(payload)}` },
  ];
}

async function completionOnce(runCtx: RunContext, args: { messages: OpenAiChatMessage[]; temperature?: number; maxTokens?: number }) {
  const baseUrl = String(runCtx.baseUrl ?? "");
  const endpoint = String(runCtx.endpoint ?? "/v1/chat/completions");
  const apiKey = String(runCtx.apiKey ?? "");
  const model = String(runCtx.modelId ?? "");
  const startedAt = Date.now();
  const ret: ChatCompletionOnceResult = await completionOnceViaProvider({
    baseUrl,
    endpoint,
    apiKey,
    model,
    temperature: typeof args.temperature === "number" ? args.temperature : undefined,
    maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
    timeoutMs: 300_000,
    messages: args.messages,
    signal: runCtx.abortSignal,
  });
  const latencyMs = Date.now() - startedAt;
  if (ret.ok && ret.usage && typeof runCtx.onTurnUsage === "function") {
    try {
      runCtx.onTurnUsage(ret.usage.promptTokens, ret.usage.completionTokens);
    } catch {
      // ignore
    }
  }
  return { ret, latencyMs };
}

function setArtifactText(runState: RunState, stepId: string, text: string) {
  const artifacts = (runState as any).pipelineArtifacts && typeof (runState as any).pipelineArtifacts === "object"
    ? (runState as any).pipelineArtifacts
    : ((runState as any).pipelineArtifacts = {});
  if (stepId === "opening") artifacts.openingDraft = text;
  else if (stepId === "body") artifacts.bodyDraft = text;
  else if (stepId === "language_rhythm") artifacts.styledDraft = text;
  else if (stepId === "polish") artifacts.polishedDraft = text;
  else if (stepId === "closure") artifacts.finalDraft = text;
}

function getLatestDraftForStep(runState: RunState, stepId: string): string | null {
  const artifacts: any = (runState as any).pipelineArtifacts ?? null;
  if (!artifacts || typeof artifacts !== "object") return null;
  if (stepId === "opening") return String(artifacts.openingDraft ?? "").trim() || null;
  if (stepId === "body") return String(artifacts.bodyDraft ?? "").trim() || null;
  if (stepId === "language_rhythm") return String(artifacts.styledDraft ?? "").trim() || null;
  if (stepId === "polish") return String(artifacts.polishedDraft ?? "").trim() || null;
  if (stepId === "closure") return String(artifacts.finalDraft ?? "").trim() || null;
  // 后续 step 用“累计全文”即可：优先 final/polished/styled/body+opening
  return (
    String(artifacts.finalDraft ?? "").trim() ||
    String(artifacts.polishedDraft ?? "").trim() ||
    String(artifacts.styledDraft ?? "").trim() ||
    (() => {
      const o = String(artifacts.openingDraft ?? "").trim();
      const b = String(artifacts.bodyDraft ?? "").trim();
      const merged = [o, b].filter(Boolean).join("\n\n").trim();
      return merged;
    })() ||
    null
  );
}

async function waitForDesktopToolResult(args: {
  runCtx: RunContext;
  toolName: string;
  toolArgs: Record<string, unknown>;
  turn: number;
}): Promise<{ ok: boolean; output: any; meta?: any; toolCallId: string }> {
  const toolCallId = `pipeline_${randomUUID()}`;
  return new Promise((resolve) => {
    let settled = false;

    const finish = (payload: { ok: boolean; output: any; meta?: any }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      args.runCtx.waiters.delete(toolCallId);
      args.runCtx.abortSignal.removeEventListener("abort", onAbort);
      resolve({ ...payload, toolCallId });
    };

    const timeoutId = setTimeout(() => {
      finish({ ok: false, output: { ok: false, error: "TOOL_RESULT_TIMEOUT", toolCallId, name: args.toolName } });
    }, TOOL_RESULT_TIMEOUT_MS);

    const onAbort = () => {
      finish({ ok: false, output: { ok: false, error: "ABORTED", toolCallId, name: args.toolName } });
    };

    args.runCtx.waiters.set(toolCallId, (payload: any) => {
      finish({ ok: Boolean(payload?.ok), output: payload?.output, meta: payload?.meta ?? null });
    });

    args.runCtx.writeEvent("tool.call", {
      toolCallId,
      name: args.toolName,
      args: args.toolArgs,
      executedBy: "desktop",
      turn: args.turn,
    });
    args.runCtx.abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PipelineExecutor {
  static async run(args: {
    pipelineConfig: PipelineConfigV1;
    payload: StylePipelinePayloadV1;
    runCtx: RunContext;
    runState: RunState;
  }): Promise<PipelineRunResult> {
    const { pipelineConfig, payload, runCtx, runState } = args;

    const startedAt = nowIso();
    const workflowId = `style_pipeline_${runCtx.runId}`;

    const stepOrder = pipelineConfig.stepOrder;
    const missingPayload = !payload || typeof payload !== "object";
    if (missingPayload) {
      return {
        outcome: { status: "failed", reason: "style_pipeline_missing_payload", reasonCodes: ["style_pipeline_missing_payload"] },
        executionReport: { providerApi: runCtx.apiType, runState, stylePipeline: { active: true, status: "failed", workflowId } },
      };
    }

    // ensure artifacts container
    if (!(runState as any).pipelineArtifacts || typeof (runState as any).pipelineArtifacts !== "object") {
      (runState as any).pipelineArtifacts = {};
    }

    // resolve step index from persisted state
    let idx = Math.max(0, Math.floor(Number((runState as any).pipelineStepIndex ?? 0)));
    if (idx >= stepOrder.length) idx = 0;

    const stepStates: Record<string, any> = {};

    const markStep = (stepId: string, patch: Record<string, unknown>) => {
      const prev = stepStates[stepId] && typeof stepStates[stepId] === "object" ? stepStates[stepId] : {};
      stepStates[stepId] = { ...prev, ...patch, stepId };
    };

    const report = (detail: Record<string, unknown>) => {
      try {
        runCtx.writeEvent("run.execution.report", {
          runId: runCtx.runId,
          stylePipeline: {
            active: true,
            workflowId,
            pipelineConfigId: pipelineConfig.id,
            pipelineVersion: pipelineConfig.version,
            status: "running",
            currentStepId: detail.currentStepId ?? null,
            stepStates,
            updatedAt: nowIso(),
            startedAt,
          },
          runState,
          ...(detail.extra ? { extra: detail.extra } : {}),
        });
      } catch {
        // ignore
      }
    };

    const setBool = (key: string, val: boolean) => {
      (runState as any)[key] = Boolean(val);
    };

    try {
      runCtx.writeEvent("assistant.start", { turn: 0 });
      // pipeline main loop
      for (; idx < stepOrder.length; idx += 1) {
        if (hasAbortSignal(runCtx.abortSignal)) {
          return {
            outcome: { status: "aborted", reason: "aborted", reasonCodes: ["aborted"] },
            executionReport: {
              providerApi: runCtx.apiType,
              runState,
              stylePipeline: {
                active: true,
                executionMode: "pipeline_v1",
                workflowId,
                pipelineConfigId: pipelineConfig.id,
                status: "aborted",
                currentStepId: stepOrder[idx] ?? null,
                stepStates,
                startedAt,
                updatedAt: nowIso(),
              },
            },
          };
        }

        const stepId = stepOrder[idx];
        (runState as any).pipelineStepIndex = idx;

        report({ currentStepId: stepId });
        markStep(stepId, { status: "running", attempts: (stepStates[stepId]?.attempts ?? 0) + 1 });

        if (stepId === "lint_loop") {
          let finalDraft = getLatestDraftForStep(runState, "closure");
          if (!finalDraft) throw new Error("PIPELINE_MISSING_FINAL_DRAFT");

          const lintCfg = pipelineConfig.global?.lint ?? { maxCopyAttempts: 1, maxStyleAttempts: 1, pickBestOnExhaust: true };
          let copyAttempt = 0;
          let copyPassed = false;
          setBool("copyGateDegraded", false);
          (runState as any).copyLintPassed = false;
          while (copyAttempt < Math.max(1, lintCfg.maxCopyAttempts) && !copyPassed) {
            copyAttempt += 1;
            const copyRes = await waitForDesktopToolResult({
              runCtx,
              toolName: "lint.copy",
              toolArgs: { text: finalDraft },
              turn: 0,
            });
            runCtx.writeEvent("tool.result", {
              toolCallId: copyRes.toolCallId,
              name: "lint.copy",
              output: copyRes.output,
              ok: copyRes.ok,
              executedBy: "desktop",
              turn: 0,
            });
            if (!copyRes.ok) {
              markStep(stepId, { status: "failed", error: copyRes.output?.error ?? "lint.copy_failed" });
              throw new Error(String(copyRes.output?.error ?? "LINT_COPY_FAILED"));
            }
            copyPassed = Boolean(copyRes.output?.passed ?? copyRes.output?.ok?.passed ?? copyRes.output?.output?.passed);
            (runState as any).copyLintPassed = copyPassed;
            (runState as any).copyLintFailCount = copyPassed ? 0 : copyAttempt;
            (runState as any).lastCopyLint = {
              riskLevel: String(copyRes.output?.riskLevel ?? "medium").trim().toLowerCase() || "medium",
              maxOverlapChars: Number(copyRes.output?.maxOverlapChars ?? 0) || 0,
              maxChar5gramJaccard: Number(copyRes.output?.maxChar5gramJaccard ?? 0) || 0,
              topOverlaps: Array.isArray(copyRes.output?.topOverlaps) ? copyRes.output.topOverlaps : [],
              sources: copyRes.output?.sources ?? null,
            };
            (runState as any).bestCopyScore = null;
            (runState as any).bestCopyArtifactId = null;
            if (!copyPassed && copyAttempt < Math.max(1, lintCfg.maxCopyAttempts)) {
              finalDraft = await rewriteDraftWithMessages({
                runCtx,
                messages: buildCopyRewriteMessages({ draft: finalDraft, lintOutput: copyRes.output }),
                temperature: 0.35,
                maxTokens: 2200,
              });
              setArtifactText(runState, "closure", finalDraft);
            }
          }
          if (!copyPassed) {
            setBool("copyGateDegraded", true);
          }

          let styleAttempt = 0;
          let stylePassed = false;
          let bestStyleScore: number | null = null;
          let bestStyleDraft = finalDraft;
          setBool("lintGateDegraded", false);
          (runState as any).styleLintPassed = false;
          while (styleAttempt < Math.max(1, lintCfg.maxStyleAttempts) && !stylePassed) {
            styleAttempt += 1;
            const styleRes = await waitForDesktopToolResult({
              runCtx,
              toolName: "lint.style",
              toolArgs: { text: finalDraft },
              turn: 0,
            });
            runCtx.writeEvent("tool.result", {
              toolCallId: styleRes.toolCallId,
              name: "lint.style",
              output: styleRes.output,
              ok: styleRes.ok,
              executedBy: "desktop",
              turn: 0,
            });
            if (!styleRes.ok) {
              markStep(stepId, { status: "failed", error: styleRes.output?.error ?? "lint.style_failed" });
              throw new Error(String(styleRes.output?.error ?? "LINT_STYLE_FAILED"));
            }
            const parsedStyle = parseStyleLintResult(styleRes.output);
            stylePassed = Boolean(styleRes.output?.passed ?? styleRes.output?.ok?.passed ?? styleRes.output?.output?.passed);
            (runState as any).styleLintPassed = stylePassed;
            (runState as any).styleLintFailCount = stylePassed ? 0 : styleAttempt;
            (runState as any).lastStyleLint = parsedStyle;
            (runState as any).bestStyleScore = parsedStyle.score;
            (runState as any).bestStyleArtifactId = null;
            if (parsedStyle.score !== null && (bestStyleScore === null || parsedStyle.score > bestStyleScore)) {
              bestStyleScore = parsedStyle.score;
              bestStyleDraft = finalDraft;
              (runState as any).bestStyleDraft = {
                score: parsedStyle.score,
                highIssues: parsedStyle.highIssues,
                text: finalDraft,
              };
            }
            if (!stylePassed && styleAttempt < Math.max(1, lintCfg.maxStyleAttempts)) {
              finalDraft = await rewriteDraftWithMessages({
                runCtx,
                messages: buildStyleRewriteMessages({ draft: finalDraft, lintOutput: styleRes.output }),
                temperature: 0.45,
                maxTokens: 2600,
              });
              setArtifactText(runState, "closure", finalDraft);
            }
          }
          if (!stylePassed) {
            setBool("lintGateDegraded", true);
            if (lintCfg.pickBestOnExhaust && bestStyleDraft) {
              finalDraft = bestStyleDraft;
              setArtifactText(runState, "closure", finalDraft);
            }
          }
          (runState as any).bestStyleScore = bestStyleScore;
          if (bestStyleScore !== null && bestStyleDraft) {
            (runState as any).bestStyleDraft = {
              score: bestStyleScore,
              highIssues: Number((runState as any).bestStyleDraft?.highIssues ?? 0) || 0,
              text: bestStyleDraft,
            };
          }

          // write: 落盘草稿（优先 payload/mainDoc 路径）
          const targetPath = derivePipelineTargetPath({ runCtx, payload });
          const writeRes = await waitForDesktopToolResult({
            runCtx,
            toolName: "write",
            toolArgs: { path: targetPath, content: finalDraft, ifExists: "rename" },
            turn: 0,
          });
          runCtx.writeEvent("tool.result", {
            toolCallId: writeRes.toolCallId,
            name: "write",
            output: writeRes.output,
            ok: writeRes.ok,
            executedBy: "desktop",
            turn: 0,
          });
          if (!writeRes.ok) {
            markStep(stepId, { status: "failed", error: writeRes.output?.error ?? "write_failed" });
            throw new Error(String(writeRes.output?.error ?? "WRITE_FAILED"));
          }
          if (runCtx.mainDoc && typeof runCtx.mainDoc === "object") {
            (runCtx.mainDoc as any).path = targetPath;
          }

          setBool("lintLoopCompleted", true);
          setBool("pipelineCompleted", true);
          (runState as any).pipelineStepIndex = stepOrder.length;
          markStep(stepId, { status: "succeeded" });
          break;
        }

        const cfg = pipelineConfig.steps[stepId];
        const materials = payload.materialsByStep?.[stepId] ?? {};
        const taskSpec = payload.taskSpec ?? {};

        const toneCard = (runState as any).pipelineArtifacts?.toneCard ?? null;
        const structureOutline = (runState as any).pipelineArtifacts?.structureOutline ?? null;
        const draftText = getLatestDraftForStep(runState, stepId);

        const messages = buildStepMessages({
          stepId,
          taskSpec,
          toneCard,
          structureOutline,
          draftText,
          materials,
        });

        const { ret, latencyMs } = await completionOnce(runCtx, {
          messages,
          temperature: cfg.llm?.temperature ?? 0.4,
          maxTokens: cfg.llm?.maxOutputTokens ?? 1800,
        });
        if (!ret.ok) throw new Error(String(ret.error ?? "UPSTREAM_ERROR"));
        const content = normalizeText(ret.content);

        if (cfg.llm?.responseFormat === "json_schema") {
          const jsonText = extractJsonObject(content);
          if (!jsonText) throw new Error("PIPELINE_INVALID_JSON");
          const parsed = JSON.parse(jsonText);
          if (!parsed || typeof parsed !== "object") throw new Error("PIPELINE_INVALID_JSON");
          if (stepId === "tone_setting") {
            (runState as any).pipelineArtifacts.toneCard = parsed as ToneCardV1;
            setBool("hasToneCard", true);
          }
          if (stepId === "structure") {
            (runState as any).pipelineArtifacts.structureOutline = parsed as StructureOutlineV1;
            setBool("hasStructureOutline", true);
          }
        } else {
          // text steps
          const text = content;
          if (!text) throw new Error("PIPELINE_EMPTY_TEXT");
          setArtifactText(runState, stepId, text);
          if (stepId === "opening") setBool("hasOpeningDraft", true);
          if (stepId === "body") setBool("hasBodyDraft", true);
          if (stepId === "language_rhythm") setBool("hasStyledDraft", true);
          if (stepId === "polish") setBool("hasPolishedDraft", true);
          if (stepId === "closure") setBool("hasFinalDraft", true);

          // also keep a DraftTextPayload (for future UI)
          const draftPayload: DraftTextPayloadV1 = {
            stage:
              stepId === "opening"
                ? "opening"
                : stepId === "body"
                  ? "body"
                  : stepId === "language_rhythm"
                    ? "styled"
                    : stepId === "polish"
                      ? "polished"
                      : "final",
            text,
            coverage: stepId === "opening" || stepId === "body" ? "partial_document" : "full_document",
            charCount: text.length,
          };
          (runState as any).lastDraftPayloadV3 = draftPayload;
        }

        markStep(stepId, {
          status: "succeeded",
          latencyMs,
          usage: ret.usage ?? null,
        });
        report({ currentStepId: stepId, extra: { stepDone: stepId } });
      }

      runCtx.writeEvent("assistant.delta", {
        delta: "风格仿写 V3 管线已完成，并已通过 lint/写入终稿。",
        turn: 0,
      });

      return {
        outcome: { status: "completed", reason: "completed", reasonCodes: ["completed"] },
        executionReport: {
          providerApi: runCtx.apiType,
          runState,
          stylePipeline: {
            active: true,
            executionMode: "pipeline_v1",
            workflowId,
            pipelineConfigId: pipelineConfig.id,
            status: "completed",
            currentStepId: null,
            completed: true,
            stepStates,
            startedAt,
            updatedAt: nowIso(),
          },
        },
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "PIPELINE_FAILED");
      const currentStepId = stepOrder[idx] ?? null;
      if (currentStepId) {
        markStep(currentStepId, { status: "failed", error: msg });
      }
      return {
        outcome: {
          status: "failed",
          reason: "style_pipeline_failed",
          reasonCodes: ["style_pipeline_failed"],
          detail: { message: msg, stepId: currentStepId },
        },
        executionReport: {
          providerApi: runCtx.apiType,
          runState,
          stylePipeline: {
            active: true,
            executionMode: "pipeline_v1",
            workflowId,
            pipelineConfigId: pipelineConfig.id,
            status: "failed",
            currentStepId,
            completed: false,
            stepStates,
            startedAt,
            updatedAt: nowIso(),
            lastError: { code: "PIPELINE_FAILED", message: msg, stepId: currentStepId },
          },
        },
      };
    }
  }
}
