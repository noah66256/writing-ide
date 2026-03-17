import { randomUUID } from "node:crypto";

import {
  completionOnceViaProvider,
} from "../llm/providerAdapter.js";
import type { ChatCompletionOnceResult, OpenAiChatMessage } from "../llm/openaiCompat.js";
import type { RunContext } from "./writingAgentRunner.js";
import type { RunState } from "@ohmycrab/agent-core";
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
          const finalDraft = getLatestDraftForStep(runState, "closure");
          if (!finalDraft) throw new Error("PIPELINE_MISSING_FINAL_DRAFT");

          // copy lint
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
          const copyPassed = Boolean(copyRes.output?.passed ?? copyRes.output?.ok?.passed ?? copyRes.output?.output?.passed);
          (runState as any).bestCopyScore = null;
          (runState as any).bestCopyArtifactId = null;
          if (!copyPassed) {
            // v1：先不重写循环，直接降级继续 style lint（copy lint 只是风险提示）
            setBool("copyGateDegraded", true);
          }

          // style lint
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
          const stylePassed = Boolean(styleRes.output?.passed ?? styleRes.output?.ok?.passed ?? styleRes.output?.output?.passed);
          const styleScore = Number(styleRes.output?.score ?? styleRes.output?.ok?.score ?? styleRes.output?.output?.score);
          (runState as any).bestStyleScore = Number.isFinite(styleScore) ? styleScore : null;
          (runState as any).bestStyleArtifactId = null;
          if (!stylePassed) {
            setBool("lintGateDegraded", true);
          }

          // write: 落盘草稿（沿用 write tool 契约，path 由 agent 决定）
          const targetPath = `drafts/style_imitate_v3_${Date.now()}.md`;
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
