import { createHash } from "node:crypto";

/**
 * GatewayRuntime — Phase 3：基于 pi-agent-core 的新运行时
 *
 * 职责：
 * - 驱动 LoopKernel（pi-agent-core agentLoop）
 * - 维护 canonical transcript
 * - 路由工具执行（gateway / desktop）
 * - 发射 SSE 事件
 * - 维护 RunState / TurnEngine
 * - shadow 模式下 Desktop 工具 dry-run
 */

import {
  analyzeStyleWorkflowBatch,
  createInitialRunState,
  getActiveWorkflowSkills,
  isContentWriteTool,
  isStyleExampleKbSearch,
  isWriteLikeTool,
  looksLikeDraftText,
  parseStyleLintResult,
  type ParsedToolCall,
  type RunState,
  type SideEffectRecordV1,
} from "@ohmycrab/agent-core";
import { TOOL_LIST, encodeToolName, decodeToolName } from "@ohmycrab/tools";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

import {
  decideServerToolExecution,
  executeServerToolOnGateway,
} from "../serverToolRunner.js";
import { normalizeToolParametersSchema } from "../../llm/toolSchema.js";
import { TurnEngine, type RunOutcome } from "../turnEngine.js";
import type { ModelApiType, ToolResultPayload } from "../writingAgentRunner.js";
import { sanitizeAssistantUserFacingText } from "../userFacingText.js";
import type {
  AgentRuntime,
  RuntimeConfig,
  RuntimeExecutionReport,
  RuntimeFailureDigest,
  RuntimeMode,
  RuntimeResult,
  RuntimeRunImages,
  RuntimeShadowMode,
} from "./types.js";
import type {
  CanonicalToolResultItem,
  CanonicalTranscriptItem,
  CanonicalUserItem,
} from "./transcript/canonicalTranscript.js";
import {
  createTranscript,
  pushItem,
  summarizeTranscript,
} from "./transcript/canonicalTranscript.js";
import { getProviderCapabilities, type ProviderCapabilities } from "./provider/providerCapabilities.js";
import { PiLoopKernel } from "./kernel/PiLoopKernel.js";
import type { LoopKernel } from "./kernel/LoopKernel.types.js";
import { LegacySubAgentBridge } from "./LegacySubAgentBridge.js";

// ── 常量 ─────────────────────────────────────────

const EMPTY_FAILURE_DIGEST: RuntimeFailureDigest = {
  failedCount: 0,
  failedTools: [],
};

/** Desktop 工具结果超时（3 分钟） */
const TOOL_RESULT_TIMEOUT_MS = 180_000;

/** 工具结果文本截断上限 */
const MAX_TOOL_RESULT_CHARS = 60_000;

const COMPLETED_OUTCOME: RunOutcome = {
  status: "completed",
  reason: "completed",
  reasonCodes: ["completed"],
};

/** 默认最大回合数，防止无限循环 */
const DEFAULT_MAX_TURNS = 48;
const MAX_PROVIDER_TOOL_NAME_LEN = 64;

const STYLE_LINT_PASS_SCORE = 70;
const LINT_MAX_REWORK = 2;

// ── 内部类型 ─────────────────────────────────────

type GatewayToolExecResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
  executedBy: "gateway" | "desktop";
  dryRun?: boolean;
};

type ToolCallSnapshot = {
  args: Record<string, unknown>;
  executedBy?: "gateway" | "desktop";
  dryRun?: boolean;
};

function appendUniqueBounded(list: string[], item: string, limit: number): string[] {
  const value = String(item ?? "").trim();
  if (!value) return list;
  const out = Array.isArray(list) ? list.slice() : [];
  if (!out.includes(value)) out.push(value);
  const lim = Math.max(1, Math.floor(Number(limit) || 1));
  if (out.length > lim) out.splice(0, out.length - lim);
  return out;
}

// ── 辅助函数 ─────────────────────────────────────

function inferProviderApi(config: RuntimeConfig): ModelApiType {
  const apiType = String(config.runCtx.apiType ?? "").trim();
  if (apiType) return apiType as ModelApiType;
  const ep = String(config.runCtx.endpoint ?? "").trim().toLowerCase();
  if (ep.endsWith("/messages")) return "anthropic-messages";
  if (ep.includes("gemini")) return "gemini";
  if (ep.endsWith("/responses")) return "openai-responses";
  return "openai-completions";
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "UNKNOWN_ERROR");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function truncateText(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[工具结果已截断，共 ${text.length} 字符]`;
}

function normalizeToolOutputText(output: unknown): string {
  return truncateText(stringifyUnknown(output).trim() || "(empty tool result)");
}

function buildTextContent(text: string): TextContent[] {
  return [{ type: "text", text: truncateText(text || "(empty tool result)") }];
}

function cloneMainDoc(mainDoc: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(mainDoc ?? {})) as Record<string, unknown>;
  } catch {
    return { ...(mainDoc ?? {}) };
  }
}

function appendUnique(list: string[], value: string, limit = 10): string[] {
  const normalized = value.trim();
  if (!normalized) return list;
  if (list.includes(normalized)) return list;
  return [...list, normalized].slice(-limit);
}

function stableStringify(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((item) => walk(item));
    if (!input || typeof input !== "object") return input;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = walk((input as Record<string, unknown>)[key]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value ?? "");
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha1").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function normalizePathLike(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function extractDomain(rawUrl: unknown): string {
  try {
    return new URL(String(rawUrl ?? "").trim()).hostname || "";
  } catch {
    return "";
  }
}

/** 检查是否为 pi-ai 的 Message（user / assistant / toolResult） */
function isPiMessage(message: unknown): message is Message {
  const role = String((message as any)?.role ?? "");
  return role === "user" || role === "assistant" || role === "toolResult";
}

/** 检查是否为 CanonicalTranscriptItem */
function isCanonicalItem(message: unknown): message is CanonicalTranscriptItem {
  const kind = String((message as any)?.kind ?? "");
  return (
    kind === "user" ||
    kind === "assistant_text" ||
    kind === "assistant_tool_call" ||
    kind === "tool_result" ||
    kind === "runtime_hint" ||
    kind === "system_checkpoint"
  );
}

function isAssistantMsg(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

function isUserMsg(message: Message): message is UserMessage {
  return message.role === "user";
}

function isToolResultMsg(message: Message): message is ToolResultMessage<any> {
  return message.role === "toolResult";
}

function createZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ── GatewayRuntime ───────────────────────────────

export class GatewayRuntime implements AgentRuntime {
  readonly kind = "gateway" as const;
  readonly mode: RuntimeMode;
  readonly shadowMode: RuntimeShadowMode;

  private outcome: RunOutcome = { ...COMPLETED_OUTCOME };
  private failureDigest: RuntimeFailureDigest = { ...EMPTY_FAILURE_DIGEST };
  private executionReport: RuntimeExecutionReport = {};
  private turn = 0;
  private totalToolCalls = 0;
  private transcript = createTranscript();
  private runState: RunState = createInitialRunState();
  private readonly turnEngine = new TurnEngine();
  private readonly toolCallSnapshots = new Map<string, ToolCallSnapshot>();
  private readonly rawToEncodedToolName = new Map<string, string>();
  private readonly encodedToRawToolName = new Map<string, string>();
  private readonly providerCapabilities: ProviderCapabilities;
  private executionNoToolTurns = 0;
  private currentTurnToolCalls = 0;
  /** 连续纯文本回合计数——用于隐式完成检测（参考 Codex 模式） */
  private consecutiveTextOnlyTurns = 0;
  /** 当前 run() 的内部 AbortController，run.done / maxTurns 通过此终止 */
  private internalAc: AbortController | null = null;
  /** 当前轮次的有效工具白名单（由 computePerTurnAllowed 动态计算） */
  private effectiveAllowed: Set<string> | null = null;
  /** 编排者模式标记（由 computePerTurnAllowed 设置） */
  private orchestratorMode = false;
  /** 软提示上次处理时的失败工具计数（避免重复提示） */
  private lastSteeringFailureCount = 0;

  constructor(
    private readonly config: RuntimeConfig & {
      mode: RuntimeMode;
      shadowMode?: RuntimeShadowMode;
    },
    private readonly kernel: LoopKernel = new PiLoopKernel(),
  ) {
    this.mode = config.mode;
    this.shadowMode = config.shadowMode ?? "off";
    this.providerCapabilities = getProviderCapabilities(
      inferProviderApi(this.config),
      { baseUrl: this.config.runCtx.baseUrl, endpoint: this.config.runCtx.endpoint },
    );
  }

  private _encodeRuntimeToolName(rawToolName: string): string {
    const raw = String(rawToolName ?? "").trim();
    if (!raw) return "tool_unknown";
    const cached = this.rawToEncodedToolName.get(raw);
    if (cached) return cached;

    let encoded = encodeToolName(raw).replace(/[^A-Za-z0-9_.:-]/g, "_");
    if (!/^[A-Za-z_]/.test(encoded)) encoded = `t_${encoded}`;
    if (encoded.length > MAX_PROVIDER_TOOL_NAME_LEN) {
      const hash = createHash("sha1").update(raw).digest("hex").slice(0, 12);
      const normalized = encoded.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^[^A-Za-z_]+/, "tool_");
      const suffix = `_${hash}`;
      const headBudget = Math.max(1, MAX_PROVIDER_TOOL_NAME_LEN - suffix.length);
      encoded = `${normalized.slice(0, headBudget)}${suffix}`;
    }

    const existingRaw = this.encodedToRawToolName.get(encoded);
    if (existingRaw && existingRaw !== raw) {
      const hash = createHash("sha1").update(raw).digest("hex").slice(0, 20);
      const prefix = /^[A-Za-z_]/.test(encoded) ? encoded[0] : "t";
      encoded = `${prefix}_${hash}`.slice(0, MAX_PROVIDER_TOOL_NAME_LEN);
    }

    this.rawToEncodedToolName.set(raw, encoded);
    this.encodedToRawToolName.set(encoded, raw);
    return encoded;
  }

  private _decodeRuntimeToolName(encodedToolName: string): string {
    const encoded = String(encodedToolName ?? "").trim();
    if (!encoded) return "";
    return this.encodedToRawToolName.get(encoded) ?? decodeToolName(encoded);
  }

  // ── 公开方法 ───────────────────────────────────

  async run(userPrompt: string, images?: RuntimeRunImages): Promise<RuntimeResult> {
    this._resetForRun();

    const providerApi = inferProviderApi(this.config);
    const maxTurns = this.config.runCtx.maxTurns ?? DEFAULT_MAX_TURNS;

    this.config.runCtx.writeEvent("run.notice", {
      turn: 0,
      kind: "info",
      title: "ProviderRuntimeCapabilities",
      message: `runtime provider=${providerApi} continuation=${this.providerCapabilities.continuationMode}`,
      detail: this.providerCapabilities,
    });

    // 内部 AbortController：链接外部 signal + maxTurns / run.done 保护
    const ac = new AbortController();
    this.internalAc = ac;

    // 外部 signal 已提前 aborted 的边界情况
    if (this.config.runCtx.abortSignal.aborted) {
      this._setOutcome({
        status: "aborted",
        reason: "aborted",
        reasonCodes: ["aborted"],
      });
      this.executionReport = this._buildExecutionReport(providerApi);
      return {
        mode: this.mode, kind: this.kind, shadowMode: this.shadowMode,
        outcome: this.outcome, failureDigest: this.failureDigest,
        executionReport: this.executionReport, turn: this.turn,
      };
    }

    const onExternalAbort = () => ac.abort();
    this.config.runCtx.abortSignal.addEventListener("abort", onExternalAbort, { once: true });

    // 构造种子 transcript（已有上下文 + 本轮用户输入）
    const seedUserItem: CanonicalUserItem = images?.length
      ? { kind: "user", text: userPrompt, images }
      : { kind: "user", text: userPrompt };
    const seedTranscript = [...this.transcript, seedUserItem];

    // Shadow 模式审计事件
    if (this.shadowMode === "shadow") {
      this.config.runCtx.writeEvent("runtime.shadow.start", {
        runId: this.config.runCtx.runId,
        runtimeMode: this.mode,
        runtimeKind: this.kind,
        provider: providerApi,
        modelId: this.config.runCtx.modelId,
      });
    }

    try {
      // 重要：Pi runtime 的 tools 声明集在 run 内基本是静态的（pi-agent-core 不支持每 turn 替换 tools）。
      // 若按 turn0 的 effectiveAllowed（boot 收敛）去构建 kernel.tools，会出现：
      // - system prompt 里明明写了工具
      // - 但 kernel 只声明了 1~3 个工具
      // - 模型调用其它工具时直接报：Tool XXX not found（不是 TOOL_NOT_ALLOWED）
      // 因此这里必须用“稳定声明集”，保证每 turn 的 effectiveAllowed 都是它的子集。
      const declaredAllowed = this.config.runCtx.allowedToolNames;
      const turn0Gate = this.config.runCtx.computePerTurnAllowed?.(this.runState) ?? null;
      const turn0EffectiveAllowed = turn0Gate?.allowed instanceof Set
        ? turn0Gate.allowed
        : null;
      // 预置 effectiveAllowed，避免 transformContext 运行前出现空白窗口。
      this.effectiveAllowed = new Set(turn0EffectiveAllowed ?? declaredAllowed);
      const visibleTools = this._buildAgentTools(declaredAllowed);

      this.config.runCtx.writeEvent("run.notice", {
        turn: 0,
        kind: "info",
        title: "KernelInputProfile",
        message:
          "kernel 输入已收敛：system=" + String(this.config.runCtx.systemPrompt ?? "").length +
          " chars, user=" + String(userPrompt ?? "").length +
          " chars, tools=" + visibleTools.length,
        detail: {
          systemPromptChars: String(this.config.runCtx.systemPrompt ?? "").length,
          userPromptChars: String(userPrompt ?? "").length,
          visibleToolCount: visibleTools.length,
          declaredToolCount: declaredAllowed.size,
          turn0EffectiveAllowedCount: turn0EffectiveAllowed?.size ?? null,
          toolChoice: null,
        },
      });

      const stream = this.kernel.run({
        systemPrompt: this.config.runCtx.systemPrompt,
        transcript: seedTranscript,
        model: {
          providerApi,
          modelId: this.config.runCtx.modelId,
          baseUrl: this.config.runCtx.baseUrl,
          endpoint: this.config.runCtx.endpoint,
          apiKey: this.config.runCtx.apiKey,
        },
        tools: visibleTools,
        signal: ac.signal,
        convertToLlm: (messages) => this._convertToLlm(messages),
        transformContext: (messages, signal) => this._transformContext(messages, signal),
        getSteeringMessages: () => this._getSteeringMessages(),
        getFollowUpMessages: () => this._getFollowUpMessages(),
      });

      for await (const event of stream) {
        this._handleKernelEvent(event, ac, maxTurns);
      }
      await stream.result();

      // 最终 outcome（run.done 在 tool_execution_end 中已设置 outcome，此处不覆盖）
      if (this.outcome.reason === "run_done") {
        // 已由 run.done 处理器设置，保持不变
      } else if (ac.signal.aborted) {
        this._setOutcome({
          status: "aborted",
          reason: this.config.runCtx.abortSignal.aborted ? "aborted" : "max_turns",
          reasonCodes: this.config.runCtx.abortSignal.aborted
            ? ["aborted"]
            : ["max_turns", `turns_${this.turn}`],
        });
      } else if (this.outcome.status === "completed") {
        this._setOutcome({
          status: "completed",
          reason: "completed",
          reasonCodes: ["completed"],
        });
      }
    } catch (err) {
      const message = toErrorMessage(err);
      // 被 abort 的话不发 error 事件（可能是 maxTurns / run.done 触发）
      if (!ac.signal.aborted) {
        this.config.runCtx.writeEvent("error", { error: message });
      }
      this.turnEngine.record({ type: "model_error", error: message });
      // run.done 触发的 abort 不覆盖 outcome
      if (this.outcome.reason !== "run_done") {
        this._setOutcome({
          status: ac.signal.aborted ? "aborted" : "failed",
          reason: ac.signal.aborted
            ? (this.config.runCtx.abortSignal.aborted ? "aborted" : "max_turns")
            : "kernel_exception",
          reasonCodes: ac.signal.aborted
            ? (this.config.runCtx.abortSignal.aborted ? ["aborted"] : ["max_turns"])
            : ["kernel_exception"],
          detail: { message },
        });
      }
    } finally {
      this.config.runCtx.abortSignal.removeEventListener("abort", onExternalAbort);
      this.internalAc = null;
      this.executionReport = this._buildExecutionReport(providerApi);

      if (this.shadowMode === "shadow" && this.outcome.status !== "completed") {
        this.config.runCtx.writeEvent("runtime.shadow.fail", {
          runId: this.config.runCtx.runId,
          runtimeMode: this.mode,
          runtimeKind: this.kind,
          provider: providerApi,
          modelId: this.config.runCtx.modelId,
          reason: this.outcome.reason,
          reasonCodes: this.outcome.reasonCodes,
          detail: this.outcome.detail ?? null,
        });
      }
    }

    return {
      mode: this.mode,
      kind: this.kind,
      shadowMode: this.shadowMode,
      outcome: this.outcome,
      failureDigest: this.failureDigest,
      executionReport: this.executionReport,
      turn: this.turn,
    };
  }

  getOutcome(): RunOutcome {
    return this.outcome;
  }

  getFailureDigest(): RuntimeFailureDigest {
    return this.failureDigest;
  }

  getExecutionReport(): RuntimeExecutionReport {
    return this.executionReport;
  }

  getTurn(): number {
    return this.turn;
  }

  // ── 初始化 ─────────────────────────────────────

  private _resetForRun(): void {
    this.turn = 0;
    this.totalToolCalls = 0;
    this.transcript = createTranscript();
    this.runState = this.config.runCtx.initialRunState
      ? { ...this.config.runCtx.initialRunState }
      : createInitialRunState();
    this.failureDigest = { failedCount: 0, failedTools: [] };
    this.executionReport = {};
    this.effectiveAllowed = new Set(this.config.runCtx.allowedToolNames);
    this.orchestratorMode = false;
    this.lastSteeringFailureCount = 0;
    this.executionNoToolTurns = 0;
    this.consecutiveTextOnlyTurns = 0;
    this.currentTurnToolCalls = 0;
    this.toolCallSnapshots.clear();
    if (!Array.isArray(this.runState.deliveredArtifactFamilies)) this.runState.deliveredArtifactFamilies = [];
    if (!Array.isArray(this.runState.sideEffectLedger)) this.runState.sideEffectLedger = [];
    if (typeof this.runState.deliveryLatched !== "boolean") this.runState.deliveryLatched = false;
    if (this.runState.todoGateSatisfiedAtTurn === undefined) this.runState.todoGateSatisfiedAtTurn = null;
    if (this.runState.deliveryLatchActivatedAtTurn === undefined) this.runState.deliveryLatchActivatedAtTurn = null;
    if (this.runState.toolLoopGuardReason === undefined) this.runState.toolLoopGuardReason = null;
    this.turnEngine.reset();
    this._setOutcome({ ...COMPLETED_OUTCOME });
  }

  private _setOutcome(next: RunOutcome): void {
    this.outcome = {
      status: next.status,
      reason: String(next.reason ?? "").trim() || next.status,
      reasonCodes: Array.isArray(next.reasonCodes) && next.reasonCodes.length
        ? next.reasonCodes.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [next.status],
      detail: next.detail ?? null,
    };
    this.turnEngine.setOutcome(this.outcome);
  }

  private _getExecutionContract() {
    const raw = (this.config.runCtx.executionContract ?? {}) as {
      required?: boolean;
      minToolCalls?: number;
      maxNoToolTurns?: number;
      reason?: string;
      preferredToolNames?: string[];
    };
    const required = Boolean(raw.required);
    const minToolCalls = required ? Math.max(1, Math.floor(Number(raw.minToolCalls ?? 1) || 1)) : 0;
    const maxNoToolTurns = required ? Math.max(1, Math.min(3, Math.floor(Number(raw.maxNoToolTurns ?? 2) || 2))) : 0;
    const reason = String(raw.reason ?? "").trim();
    const preferredToolNames = Array.isArray(raw.preferredToolNames)
      ? raw.preferredToolNames.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 8)
      : [];
    return { required, minToolCalls, maxNoToolTurns, reason, preferredToolNames };
  }


  private _normalizeArtifactFamily(value: unknown): string | null {
    const raw = normalizePathLike(value);
    if (!raw) return null;
    let normalized = raw.replace(/\.[^/.]+$/, "");
    normalized = normalized.replace(/(?:[_-]v\d+|[（(]\d+[)）])$/i, "");
    normalized = normalized.replace(/\s+/g, " ").trim();
    return normalized || null;
  }

  private _semanticKindForTool(toolName: string): SideEffectRecordV1["semanticKind"] {
    if (toolName === "doc.applyEdits" || toolName === "doc.replaceSelection" || toolName === "doc.restoreSnapshot") {
      return "doc_edit";
    }
    if (toolName === "doc.write" || toolName === "doc.splitToDir" || toolName === "code.exec") {
      return "artifact_write";
    }
    return "other";
  }

  private _isDeliveryCandidateTool(toolName: string): boolean {
    return isContentWriteTool(toolName) || toolName === "doc.snapshot" || toolName === "code.exec";
  }

  private _logicalTargetForTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result?: GatewayToolExecResult,
  ): string | null {
    const output = result?.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
    const artifact = output.artifact && typeof output.artifact === "object"
      ? (output.artifact as Record<string, unknown>)
      : null;
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    const candidates: unknown[] = [
      toolArgs.path,
      toolArgs.targetDir,
      output.path,
      output.renamedFrom,
      artifact?.relPath,
      artifact?.absPath,
    ];
    for (const item of artifacts.slice(0, 3)) {
      if (!item || typeof item !== "object") continue;
      candidates.push((item as Record<string, unknown>).relPath);
      candidates.push((item as Record<string, unknown>).absPath);
    }
    for (const candidate of candidates) {
      const family = this._normalizeArtifactFamily(candidate);
      if (family) return family;
    }
    if (this._isDeliveryCandidateTool(toolName)) {
      return `${toolName}:${fingerprint({ args: toolArgs })}`;
    }
    return null;
  }

  private _recordToolLoopGuard(reason: string): void {
    this.runState.toolLoopGuardReason = reason;
  }

  private _recordSideEffect(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: GatewayToolExecResult,
  ): SideEffectRecordV1 | null {
    const logicalTarget = this._logicalTargetForTool(toolName, toolArgs, result);
    if (!logicalTarget) return null;
    const outputObj = result.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
    const contentValue = toolArgs.content ?? outputObj.diffUnified ?? outputObj.content ?? outputObj.path ?? logicalTarget;
    const record: SideEffectRecordV1 = {
      semanticKind: this._semanticKindForTool(toolName),
      toolName,
      logicalTarget,
      argsFingerprint: fingerprint(toolArgs),
      resultFingerprint: fingerprint(result.output),
      contentFingerprint: contentValue == null ? null : fingerprint(contentValue),
      ts: Date.now(),
    };
    const prev = Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger : [];
    this.runState.sideEffectLedger = [...prev, record].slice(-20);
    const family = this._normalizeArtifactFamily(logicalTarget);
    if (family && !this.runState.deliveredArtifactFamilies.includes(family)) {
      this.runState.deliveredArtifactFamilies.push(family);
    }
    return record;
  }

  private _findMatchingSideEffect(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): SideEffectRecordV1 | null {
    const logicalTarget = this._logicalTargetForTool(toolName, toolArgs);
    if (!logicalTarget) return null;
    const semanticKind = this._semanticKindForTool(toolName);
    const records = Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger : [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const item = records[i];
      if (item.logicalTarget === logicalTarget && item.semanticKind === semanticKind) return item;
    }
    return null;
  }

  private _markTodoSatisfied(): void {
    if (this.runState.todoGateSatisfiedAtTurn == null) {
      this.runState.todoGateSatisfiedAtTurn = this.turn;
    }
    this.runState.toolLoopGuardReason = null;
  }
  private _assistantHasVisibleText(message: AssistantMessage): boolean {
    for (const part of message.content) {
      if (part.type !== "text") continue;
      const sanitized = sanitizeAssistantUserFacingText(part.text, {
        dropPureJsonPayload: true,
      });
      if (sanitized.text && sanitized.text.trim()) return true;
    }
    return false;
  }

  private _activateDeliveryLatch(reason: "assistant_text" | "run_done", detail?: Record<string, unknown>): void {
    if (this.runState.deliveryLatched) return;
    const families = Array.isArray(this.runState.deliveredArtifactFamilies)
      ? this.runState.deliveredArtifactFamilies.filter(Boolean)
      : [];
    if (families.length <= 0) return;
    this.runState.deliveryLatched = true;
    if (this.runState.deliveryLatchActivatedAtTurn == null) {
      this.runState.deliveryLatchActivatedAtTurn = this.turn;
    }
    this.config.runCtx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "DeliveryLatchActivated",
      message: "本轮已完成交付收口，后续相同逻辑目标将被拦截。",
      detail: {
        reason,
        deliveredArtifactFamilies: families,
        sideEffectLedgerSize: this.runState.sideEffectLedger.length,
        ...(detail ?? {}),
      },
    });
  }


  private _enforceTurnLevelGuards(ac: AbortController): void {
    const executionContract = this._getExecutionContract();
    if (!executionContract.required) return;

    if (this.currentTurnToolCalls > 0) {
      this.executionNoToolTurns = 0;
      return;
    }

    if (this.totalToolCalls < executionContract.minToolCalls) {
      this.executionNoToolTurns += 1;
      if (this.executionNoToolTurns > executionContract.maxNoToolTurns) {
        this._recordToolLoopGuard("execution_contract_unsatisfied");
        this._setOutcome({
          status: "failed",
          reason: "execution_contract_unsatisfied",
          reasonCodes: ["execution_contract_unsatisfied"],
          detail: { turn: this.turn, retries: this.executionNoToolTurns },
        });
        this.config.runCtx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "error",
          title: "ExecutionContractFailed",
          message: "执行达成约束失败：连续重试后仍未触发工具调用。",
          detail: { retries: this.executionNoToolTurns, providerContinuationMode: this.providerCapabilities.continuationMode },
        });
        ac.abort();
      }
    }
  }

  // ── Hook 实现 ──────────────────────────────────

  /**
   * transformContext：每轮 LLM 调用前对上下文做变换。
   * 1. 调用 computePerTurnAllowed 计算本轮工具白名单和 hint
   * 2. 更新 effectiveAllowed / orchestratorMode
   * 3. 在 messages 末尾追加 runtime_hint（软 gating 提示）
   */
  private async _transformContext(
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    // 每轮重置为基线
    this.effectiveAllowed = new Set(this.config.runCtx.allowedToolNames);
    this.orchestratorMode = false;

    const gating = this.config.runCtx.computePerTurnAllowed?.(this.runState) ?? null;
    if (!gating) return messages;

    if (gating.allowed) {
      this.effectiveAllowed = new Set(gating.allowed);
    }
    if (gating.orchestratorMode) {
      this.orchestratorMode = true;
    }
    if (gating.hint) {
      const hintItem: CanonicalTranscriptItem = {
        kind: "runtime_hint",
        text: String(gating.hint),
        reasonCodes: ["per_turn_gating"],
      };
      messages.push(hintItem as unknown as AgentMessage);
    }

    return messages;
  }

  /**
   * 软提示收集：这些提示用于“下一轮继续执行/收口”，不能走 steering 通道。
   *
   * pi-agent-core 中 getSteeringMessages 的语义是“用户在当前回合中途插话/转向”，
   * 一旦这里返回消息，会直接跳过当前回合剩余工具调用。此前把 Todo Gate /
   * 执行契约 / 失败修复等软提示塞进 steering，导致 Gemini 在首个工具后把同轮
   * 其他工具误判成 “Skipped due to queued user message.”。
   */
  private _collectSoftGuidanceMessages(): AgentMessage[] {
    const hints: AgentMessage[] = [];
    const pushHint = (text: string, codes: string[]) => {
      const item: CanonicalTranscriptItem = {
        kind: "runtime_hint",
        text,
        reasonCodes: codes,
      };
      hints.push(item as unknown as AgentMessage);
    };

    const lastText = this._getLastAssistantText();
    if (this.orchestratorMode && lastText.length > 300) {
      pushHint(
        "你是编排者（负责人），禁止直接输出长文内容。请改为通过 agent.delegate 委派给合适成员执行；" +
          "如需联网搜索先委派 topic_planner，写作任务委派 copywriter。",
        ["orchestrator_long_text_blocked"],
      );
    }

    if (this.failureDigest.failedCount > this.lastSteeringFailureCount) {
      const latest = this.failureDigest.failedTools[this.failureDigest.failedTools.length - 1];
      if (latest) {
        const nextActions =
          Array.isArray(latest.next_actions) && latest.next_actions.length > 0
            ? `\n建议下一步：${latest.next_actions.join("；")}`
            : "";
        pushHint(
          `刚刚有工具执行失败：${latest.name}（${latest.error}）。` +
            (latest.message ? `失败原因：${latest.message}。` : "") +
            "请先根据失败结果修复参数、补足前置条件或改用合适工具，不要重复同一失败调用。" +
            nextActions,
          ["tool_failure_repair"],
        );
      }
      this.lastSteeringFailureCount = this.failureDigest.failedCount;
    }

    const ec = this._getExecutionContract();
    const minToolCalls = Math.max(0, Math.floor(Number(ec?.minToolCalls ?? 0)));
    if (this.totalToolCalls === 0 && ec.required && minToolCalls > 0 && this.totalToolCalls < minToolCalls) {
      pushHint(
        `当前回合要求至少触发 ${minToolCalls} 次工具调用。请不要只输出文本，先调用工具完成动作，再继续回复。`,
        ["execution_contract_enforce"],
      );
    }

    if (this.runState.deliveryLatched) {
      pushHint(
        "本轮已经生成交付类产物。除非你要创建一个新的目标文件，否则不要重复写入；若任务已完成，请直接调用 run.done 收口。",
        ["delivery_latch_active"],
      );
    }

    return hints;
  }

  /**
   * getSteeringMessages：仅用于“真实用户中途插话/转向”。
   * 当前 GatewayRuntime 尚未实现独立的用户 steering 队列，因此这里必须保持空，
   * 避免把软提示误当成 queued user message，导致同轮剩余工具被跳过。
   */
  private async _getSteeringMessages(): Promise<AgentMessage[]> {
    return [];
  }

  /**
   * getFollowUpMessages：循环即将结束时的追加消息（阻止过早结束）。
   * - 如果 run.done 已触发，不追加（尊重显式终止信号）
   * - 如果有未完成的 todo，注入追问让 Agent 继续
   * - 如果 hasPlanCommitment 但无工具调用，提醒执行
   */
  private async _getFollowUpMessages(): Promise<AgentMessage[]> {
    // run.done 已触发，不再追加
    if (this.outcome.reason === "run_done") return [];

    const runCtx: any = this.config.runCtx;
    const gates: any = runCtx.gates ?? {};
    const activeSkills = Array.isArray(runCtx.activeSkills) ? runCtx.activeSkills : [];
    const styleSkillActive =
      activeSkills.some((s: any) => String(s?.id ?? "").trim() === "style_imitate") ||
      (gates.styleGateEnabled && runCtx.intent?.isWritingTask);

    // Style_imitate：当风格闭环未完成且仅产生纯文本输出时，禁止模型“自然结束”，注入 runtime_hint 促使其按 Skill 闭环补齐。
    // - 仅在 style skill 激活且为写作任务时生效；
    // - 依赖 RunState.workflowRetryBudget 控制最大重试次数，避免死循环；
    // - 提示内容明确要求执行：kb.search → 草稿 draft → lint.copy → lint.style → doc.write/doc.applyEdits。
    if (
      styleSkillActive &&
      gates.styleGateEnabled &&
      gates.lintGateEnabled &&
      runCtx.intent?.isWritingTask
    ) {
      const st: any = this.runState as any;
      const styleCompleted = Boolean(
        st.hasStyleKbSearch &&
        st.hasDraftText &&
        st.copyLintPassed &&
        st.styleLintPassed,
      );
      if (!styleCompleted) {
        const budget = Math.max(0, Math.floor(Number(st.workflowRetryBudget ?? 0)));
        if (budget > 0) {
          st.workflowRetryBudget = budget - 1;
          const item: CanonicalTranscriptItem = {
            kind: "runtime_hint",
            text:
              "当前已启用 style_imitate 风格仿写 Skill，但尚未按 kb.search 样例 → 草稿 draft → lint.copy → lint.style → doc.write/doc.applyEdits 完整走完闭环。\n" +
              "请按以下顺序执行工具：先调用 kb.search 从风格库检索模板/规则卡，再输出候选草稿，然后依次调用 lint.copy 和 lint.style 进行审计，最后再用 doc.write 或 doc.applyEdits 落盘。",
            reasonCodes: ["style_workflow_followup"],
          };
          try {
            this.config.runCtx.writeEvent("run.notice", {
              turn: this.turn,
              kind: "warn",
              title: "StyleWorkflowTextBlocked",
              message:
                "检测到 style_imitate 已启用但尚未完成风格闭环，本轮纯文本收口已被拦截，将注入 runtime_hint 引导模型按闭环顺序补齐工具调用。",
            });
          } catch {
            // 非关键路径，忽略审计异常
          }
          return [item as unknown as AgentMessage];
        }
      }
    }

    // 隐式完成：模型已做过工具调用，且连续纯文本回合 ≥ 2 → 自然终止（参考 Codex 模式）
    // Codex 的设计：��型不返回 tool call 即视为完成，不注入追问。
    // 我们保留 1 次追问机会（consecutiveTextOnlyTurns < 2），超过后尊重模型的"自然结束"信号。
    if (this.totalToolCalls > 0 && this.consecutiveTextOnlyTurns >= 2) {
      return [];
    }

    const softGuidance = this._collectSoftGuidanceMessages();
    if (softGuidance.length > 0) return softGuidance;

    if (this.runState.deliveryLatched && this.runState.hasWriteApplied) {
      const item: CanonicalTranscriptItem = {
        kind: "runtime_hint",
        text: "交付类产物已经生成。若没有新的目标文件，请直接调用 run.done 结束，不要重复写入同一产物。",
        reasonCodes: ["delivery_latch_followup"],
      };
      return [item as unknown as AgentMessage];
    }

    // 检查 mainDoc 中的 todo 列表
    const runTodo = this.config.runCtx.mainDoc?.runTodo as
      | Array<{ status?: string; text?: string; note?: string }>
      | null
      | undefined;
    if (Array.isArray(runTodo) && runTodo.length > 0) {
      const normStatus = (s: unknown) => String(s ?? "").trim().toLowerCase();
      const done = runTodo.filter((t) => normStatus(t?.status) === "done").length;
      const total = runTodo.length;

      // 检测 "等待用户" 状态——此类项应让 run 自然结束，不追问
      const waitingPattern =
        /(等待用户|等待你|待确认|等你确认|需要你确认|请确认|请选择|选(一|1)个|从.*选)/;
      const hasWaiting = runTodo.some((t) => {
        const status = normStatus(t?.status);
        const note = String(t?.note ?? "").trim();
        const text = String(t?.text ?? "").trim();
        return (
          status === "blocked" ||
          /^blocked\b/i.test(note) ||
          waitingPattern.test(note) ||
          waitingPattern.test(text)
        );
      });

      // 有等待用户确认的项 → 不追问，让 run 自然结束
      if (hasWaiting) return [];

      if (done < total) {
        const item: CanonicalTranscriptItem = {
          kind: "runtime_hint",
          text:
            `你的待办列表还有 ${total - done}/${total} 项未完成。` +
            "请继续执行剩余任务，全部完成后调用 run.done 结束。",
          reasonCodes: ["pending_todo"],
        };
        return [item as unknown as AgentMessage];
      }
    }

    // 有 plan 但没调过工具（可能模型只输出了文本就想停）
    if (this.runState.hasPlanCommitment && !this.runState.hasAnyToolCall) {
      const item: CanonicalTranscriptItem = {
        kind: "runtime_hint",
        text: "你已经制定了计划但尚未开始执行。请调用工具开始执行任务。",
        reasonCodes: ["plan_no_execution"],
      };
      return [item as unknown as AgentMessage];
    }

    return [];
  }

  /** 从 transcript 中提取最近一条助手文本 */
  private _getLastAssistantText(): string {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const item = this.transcript[i];
      if (item.kind === "assistant_text") return item.text;
    }
    return "";
  }

  // ── 工具构建 ───────────────────────────────────

  /**
   * 将 TOOL_LIST + sidecar MCP 工具转为 pi-agent-core 的 AgentTool[]。
   * 工具名经过 encodeToolName 编码（dot → _dot_），兼容 OpenAI / Gemini 的 function name 限制。
   * execute 回调用原始名路由执行（MCP 工具走 _executeAgentTool → desktop）。
   */
  private _buildAgentTools(visibleAllowed?: Set<string> | null): AgentTool<any>[] {
    const allowed = visibleAllowed instanceof Set ? visibleAllowed : this.config.runCtx.allowedToolNames;

    // ── 内置工具 ──────────────────────────────────
    const builtins = TOOL_LIST
      .filter((tool) => allowed.size === 0 || allowed.has(tool.name))
      .filter((tool) => !tool.modes || tool.modes.includes(this.config.runCtx.mode))
      .map((tool) => ({
        name: this._encodeRuntimeToolName(tool.name),
        label: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: true,
        }) as any,
        execute: async (
          toolCallId: string,
          params: Record<string, unknown>,
        ): Promise<AgentToolResult<GatewayToolExecResult>> => {
          // 使用原始名（带 dot）路由执行
          const result = await this._executeAgentTool(toolCallId, tool.name, params ?? {});
          // 保存到 snapshot 供 _handleKernelEvent 使用（即使 throw 也能读取）
          this.toolCallSnapshots.set(toolCallId, {
            args: params ?? {},
            executedBy: result.executedBy,
            dryRun: result.dryRun,
          });
          // 失败时 throw 让 pi-agent-core 正确标记 isError=true
          if (!result.ok) {
            const errorText = normalizeToolOutputText(result.output);
            throw new Error(errorText);
          }
          return {
            content: buildTextContent(normalizeToolOutputText(result.output)),
            details: result,
          };
        },
      }));

    // ── Sidecar MCP 工具（playwright / web-search / bocha-search 等）──
    // 路由：_executeAgentTool → decideServerToolExecution → executedBy: "desktop"
    const seenMcpNames = new Set<string>();
    const mcpRaw: any[] = Array.isArray(this.config.runCtx.toolSidecar?.mcpTools)
      ? this.config.runCtx.toolSidecar.mcpTools
      : [];
    const mcpTools = mcpRaw
      .filter((t: any) => {
        const name = String(t?.name ?? "").trim();
        if (!name) return false;
        if (allowed.size > 0 && !allowed.has(name)) return false;
        if (seenMcpNames.has(name)) return false;
        seenMcpNames.add(name);
        return true;
      })
      .map((t: any) => {
        const toolName = String(t.name).trim();
        return {
          name: this._encodeRuntimeToolName(toolName),
          label: toolName,
          description: String(t.description ?? ""),
          parameters: normalizeToolParametersSchema(t.inputSchema) as any,
          execute: async (
            toolCallId: string,
            params: Record<string, unknown>,
          ): Promise<AgentToolResult<GatewayToolExecResult>> => {
            const result = await this._executeAgentTool(toolCallId, toolName, params ?? {});
            this.toolCallSnapshots.set(toolCallId, {
              args: params ?? {},
              executedBy: result.executedBy,
              dryRun: result.dryRun,
            });
            if (!result.ok) {
              const errorText = normalizeToolOutputText(result.output);
              throw new Error(errorText);
            }
            return {
              content: buildTextContent(normalizeToolOutputText(result.output)),
              details: result,
            };
          },
        };
      });

    return [...builtins, ...mcpTools];
  }

  // ── 工具执行 ───────────────────────────────────

  /**
   * 工具执行路由：
   * 1. shadow + desktop → dry-run
   * 2. gateway 工具 → executeServerToolOnGateway
   * 3. desktop 工具 → writeEvent("tool.call") + waiter
   */
  private async _executeAgentTool(
    toolCallId: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<GatewayToolExecResult> {
    const toolArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs
      : {};

    // 软 gating：工具不在本轮白名单中时拒绝执行
    if (
      this.effectiveAllowed &&
      this.effectiveAllowed.size > 0 &&
      !this.effectiveAllowed.has(toolName)
    ) {
      (this.runState as any).lastToolNotAllowedName = String(toolName ?? "").trim() || null;
      this.config.runCtx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "ToolNotAllowed",
        message: `工具 "${toolName}" 在当前回合不可用（TOOL_NOT_ALLOWED_THIS_TURN）。`,
        detail: {
          toolName,
          effectiveAllowedCount: this.effectiveAllowed?.size ?? 0,
        },
      });
      return {
        ok: false,
        output: {
          ok: false,
          error: "TOOL_NOT_ALLOWED_THIS_TURN",
          message: `工具 "${toolName}" 在当前阶段不可用，请使用其他工具。`,
        },
        executedBy: "gateway",
      };
    }

    const matchedSideEffect = this._isDeliveryCandidateTool(toolName)
      ? this._findMatchingSideEffect(toolName, toolArgs)
      : null;
    if (this.runState.deliveryLatched && matchedSideEffect) {
      this._recordToolLoopGuard("delivery_latch_blocked");
      this.config.runCtx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "DeliveryLatchBlocked",
        message: `工具 ${toolName} 命中了已交付产物，已拦截重复写入。`,
        detail: {
          logicalTarget: matchedSideEffect.logicalTarget,
          toolName,
          sideEffectLedgerSize: this.runState.sideEffectLedger.length,
        },
      });
      return {
        ok: false,
        output: {
          ok: false,
          error: "DELIVERY_LATCHED",
          message: "该逻辑产物已完成交付，禁止重复写入同一产物族。",
          detail: {
            logicalTarget: matchedSideEffect.logicalTarget,
            providerContinuationMode: this.providerCapabilities.continuationMode,
          },
          next_actions: [
            "读取上一条工具结果并确认是否已经交付成功",
            "若需新版本，请明确新的目标文件名或改写成新的产物",
            "如果任务已完成，请调用 run.done 收口",
          ],
        },
        executedBy: "gateway",
      };
    }

    // agent.delegate：通过子运行 bridge 执行子 Agent
    // shadow 模式下保持 stub，避免绕过 Desktop dry-run 保护
    if (toolName === "agent.delegate") {
      if (this.shadowMode === "shadow") {
        return this._handleDelegateStub(toolCallId, toolArgs);
      }
      return new LegacySubAgentBridge(this.config.runCtx).execute(
        toolCallId,
        toolArgs,
        this.turn,
      );
    }

    const decision = decideServerToolExecution({
      name: toolName,
      toolArgs,
      toolSidecar: this.config.runCtx.toolSidecar,
    });

    this.toolCallSnapshots.set(toolCallId, {
      args: toolArgs,
      executedBy: decision.executedBy,
    });

    // Shadow 模式下 Desktop 工具 dry-run
    if (this.shadowMode === "shadow" && decision.executedBy === "desktop") {
      this.toolCallSnapshots.set(toolCallId, {
        args: toolArgs,
        executedBy: "desktop",
        dryRun: true,
      });
      this.config.runCtx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: "ShadowDryRun",
        message: `shadow 模式跳过 Desktop 工具：${toolName}`,
        detail: { toolCallId, name: toolName },
      });
      return {
        ok: false,
        output: {
          ok: false,
          error: "SHADOW_DRY_RUN",
          message: `shadow 模式未真正执行 Desktop 工具 "${toolName}"`,
        },
        executedBy: "desktop",
        dryRun: true,
      };
    }

    // Gateway 工具
    if (decision.executedBy === "gateway") {
      const ret = await this._executeGatewayTool(toolCallId, toolName, toolArgs);
      // web.search/web.fetch 的 MCP 回退：bocha 不可用时尝试 sidecar 中的搜索 MCP
      if (!ret.ok) {
        const errCode = String((ret.output as any)?.error ?? "");
        if (errCode === "WEB_SEARCH_FALLBACK_TO_MCP" || errCode === "WEB_FETCH_FALLBACK_TO_MCP") {
          const mcpResult = await this._fallbackWebToolViaMcp(toolCallId, toolName, toolArgs);
          if (mcpResult) return mcpResult;
        }
      }
      return ret;
    }

    // Desktop 工具
    return this._waitForDesktopToolResult(toolCallId, toolName, toolArgs);
  }

  private async _executeGatewayTool(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<GatewayToolExecResult> {
    this.config.runCtx.writeEvent("tool.call", {
      toolCallId,
      name: toolName,
      args: toolArgs,
      executedBy: "gateway",
      turn: this.turn,
    });

    try {
      const ret = await executeServerToolOnGateway({
        fastify: this.config.runCtx.fastify,
        call: { name: toolName, args: toolArgs },
        toolSidecar: this.config.runCtx.toolSidecar,
        styleLinterLibraries: this.config.runCtx.styleLinterLibraries,
        authorization: this.config.runCtx.authorization ?? null,
        // shadow 模式下 clone mainDoc，避免污染主 run
        mainDoc: this.shadowMode === "shadow"
          ? cloneMainDoc(this.config.runCtx.mainDoc)
          : this.config.runCtx.mainDoc,
        llmOverride:
          toolName === "lint.style" || !this.config.runCtx.baseUrl || !this.config.runCtx.apiKey || !this.config.runCtx.modelId
            ? null
            : {
                baseUrl: this.config.runCtx.baseUrl,
                endpoint: this.config.runCtx.endpoint,
                apiKey: this.config.runCtx.apiKey,
                model: this.config.runCtx.modelId,
              },
        mode: this.config.runCtx.mode,
        allowedToolNames: this.config.runCtx.allowedToolNames,
      });

      if (ret.ok) {
        return {
          ok: true,
          output: (ret as { output: unknown }).output,
          executedBy: "gateway",
        };
      }

      return {
        ok: false,
        output: {
          ok: false,
          error: (ret as { error?: unknown }).error ?? "SERVER_TOOL_FAILED",
          detail: (ret as { detail?: unknown }).detail ?? null,
        },
        executedBy: "gateway",
      };
    } catch (err) {
      return {
        ok: false,
        output: {
          ok: false,
          error: "SERVER_TOOL_EXEC_ERROR",
          detail: toErrorMessage(err),
        },
        executedBy: "gateway",
      };
    }
  }

  private async _fallbackWebToolViaMcp(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<GatewayToolExecResult | null> {
    const mcpTools: Array<{ name: string; originalName?: string }> =
      Array.isArray(this.config.runCtx.toolSidecar?.mcpTools)
        ? (this.config.runCtx.toolSidecar.mcpTools as any[])
        : [];
    if (!mcpTools.length) return null;
    type FallbackCandidate = { name: string; args: Record<string, unknown> };
    const candidates: FallbackCandidate[] = [];

    if (toolName === "web.search") {
      const query = String(toolArgs.query ?? "").trim();
      if (!query) return null;

      const count = toolArgs.count;
      const freshness = toolArgs.freshness;

      // 策略 1：Bocha 搜索 MCP（若存在）
      const bochaSearch = mcpTools.find((t) =>
        /^mcp\.bocha-search\./i.test(String(t.name ?? "")) &&
        /bocha_web_search|web_search/i.test(String(t.originalName ?? t.name ?? "")),
      );
      if (bochaSearch) {
        const args: Record<string, unknown> = { query };
        if (count != null) args.count = count as unknown;
        if (freshness != null) args.freshness = freshness as unknown;
        candidates.push({ name: bochaSearch.name, args });
      }

      // 策略 2：通用 web-search MCP（Serper/Tavily）
      const webSearch = mcpTools.find((t) =>
        /^mcp\.web-search\./i.test(String(t.name ?? "")) &&
        /web_search/i.test(String(t.originalName ?? t.name ?? "")),
      );
      if (webSearch) {
        const args: Record<string, unknown> = { query };
        if (count != null) args.num_results = count as unknown;
        candidates.push({ name: webSearch.name, args });
      }

      // 策略 3：Playwright 保底 → 导航到百度搜索
      const playwrightNav = mcpTools.find((t) =>
        /^mcp\.playwright\./i.test(String(t.name ?? "")) &&
        /browser_navigate/i.test(String(t.originalName ?? t.name ?? "")),
      );
      if (playwrightNav) {
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
        candidates.push({ name: playwrightNav.name, args: { url } });
      }
    } else if (toolName === "web.fetch") {
      const url = String(toolArgs.url ?? "").trim();
      if (!url) return null;

      // 策略 1：web-search MCP 的 get_page_content
      const getPage = mcpTools.find((t) =>
        /^mcp\.web-search\./i.test(String(t.name ?? "")) &&
        /get_page_content/i.test(String(t.originalName ?? t.name ?? "")),
      );
      if (getPage) {
        candidates.push({ name: getPage.name, args: { url } });
      }

      // 策略 2：Playwright 保底 → 直接 navigate 到目标 URL
      const playwrightNav = mcpTools.find((t) =>
        /^mcp\.playwright\./i.test(String(t.name ?? "")) &&
        /browser_navigate/i.test(String(t.originalName ?? t.name ?? "")),
      );
      if (playwrightNav) {
        candidates.push({ name: playwrightNav.name, args: { url } });
      }
    }

    if (!candidates.length) return null;

    let lastResult: GatewayToolExecResult | null = null;
    for (const cand of candidates) {
      const res = await this._waitForDesktopToolResult(toolCallId, cand.name, cand.args);
      lastResult = res;
      if (res.ok) return res;
    }

    return lastResult;
  }

  /**
   * Desktop 工具执行：复用现有 waiter 模式。
   * 通过 writeEvent("tool.call") 发送给 Desktop，等待 WS 回调。
   */
  private _waitForDesktopToolResult(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<GatewayToolExecResult> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (payload: GatewayToolExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.config.runCtx.waiters.delete(toolCallId);
        this.config.runCtx.abortSignal.removeEventListener("abort", onAbort);
        resolve(payload);
      };

      const timeoutId = setTimeout(() => {
        finish({
          ok: false,
          output: {
            ok: false,
            error: "TOOL_RESULT_TIMEOUT",
            toolCallId,
            name: toolName,
          },
          executedBy: "desktop",
        });
      }, TOOL_RESULT_TIMEOUT_MS);

      const onAbort = () => {
        finish({
          ok: false,
          output: {
            ok: false,
            error: "ABORTED",
            toolCallId,
            name: toolName,
          },
          executedBy: "desktop",
        });
      };

      // 注册 waiter——Desktop 通过 WS 发送工具结果时触发
      this.config.runCtx.waiters.set(toolCallId, (payload: ToolResultPayload) => {
        finish({
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null,
          executedBy: "desktop",
        });
      });

      // 通知 Desktop 执行工具
      this.config.runCtx.writeEvent("tool.call", {
        toolCallId,
        name: toolName,
        args: toolArgs,
        executedBy: "desktop",
        turn: this.turn,
      });

      this.config.runCtx.abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── 内核事件处理 ───────────────────────────────

  /**
   * 处理 pi-agent-core 发出的 AgentEvent。
   * 映射为 SSE 事件 + canonical transcript 更新 + RunState 更新。
   * 工具名从 kernel 侧编码名（_dot_）解码回原始名（dot）。
   */
  private _handleKernelEvent(event: AgentEvent, ac: AbortController, maxTurns: number): void {
    switch (event.type) {
      case "agent_start":
        return;

      case "turn_start":
        this.turn += 1;
        this.currentTurnToolCalls = 0;
        this.turnEngine.setTurn(this.turn);
        // maxTurns 保护
        if (this.turn > maxTurns) {
          this.config.runCtx.writeEvent("run.notice", {
            turn: this.turn,
            kind: "warn",
            title: "MaxTurnsExceeded",
            message: `达到最大回合数 ${maxTurns}，终止运行`,
          });
          ac.abort();
          return;
        }
        this.config.runCtx.writeEvent("assistant.start", { turn: this.turn });
        return;

      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          const sanitized = sanitizeAssistantUserFacingText(inner.delta, {
            dropPureJsonPayload: true,
          });
          if (!sanitized.dropped && sanitized.text) {
            this.turnEngine.record({ type: "model_text_delta", text: sanitized.text });
            this.config.runCtx.writeEvent("assistant.delta", {
              delta: sanitized.text,
              turn: this.turn,
            });
          }
        }
        return;
      }

      case "message_end": {
        // message 可能是 pi-ai Message 或 CanonicalTranscriptItem
        if (isCanonicalItem(event.message)) {
          pushItem(this.transcript, event.message as CanonicalTranscriptItem);
          return;
        }

        if (!isPiMessage(event.message)) return;
        const msg = event.message as Message;

        if (isUserMsg(msg)) {
          this._pushUserToTranscript(msg);
          return;
        }

        if (isAssistantMsg(msg)) {
          this._pushAssistantToTranscript(msg);
          if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && this._assistantHasVisibleText(msg)) {
            this._activateDeliveryLatch("assistant_text", { stopReason: msg.stopReason ?? null });
          }
          // 上报 token usage
          this.config.runCtx.onTurnUsage?.(
            Math.max(0, Math.floor(Number(msg.usage?.input ?? 0))),
            Math.max(0, Math.floor(Number(msg.usage?.output ?? 0))),
          );
          this.config.runCtx.writeEvent("assistant.done", { turn: this.turn });

          // 错误检测
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            if (!(msg.stopReason === "aborted" && this.outcome.reason === "run_done")) {
              const errText = String(msg.errorMessage ?? msg.stopReason).trim() || "MODEL_ERROR";
              this.config.runCtx.writeEvent("error", { error: errText });
              this.turnEngine.record({ type: "model_error", error: errText });
              this._setOutcome({
                status: msg.stopReason === "aborted" ? "aborted" : "failed",
                reason: msg.stopReason === "aborted" ? "aborted" : "model_error",
                reasonCodes: [msg.stopReason === "aborted" ? "aborted" : "model_error"],
                detail: { error: errText },
              });
            }
          }
          return;
        }

        if (isToolResultMsg(msg)) {
          this._pushToolResultToTranscript(msg);
        }
        return;
      }

      case "tool_execution_start": {
        const rawToolName = this._decodeRuntimeToolName(event.toolName);
        this.totalToolCalls += 1;
        this.currentTurnToolCalls += 1;
        this.turnEngine.record({
          type: "model_tool_call",
          callId: event.toolCallId,
          name: rawToolName,
          args: event.args ?? {},
        });
        this.toolCallSnapshots.set(event.toolCallId, {
          ...(this.toolCallSnapshots.get(event.toolCallId) ?? { args: {} }),
          args: event.args ?? {},
        });
        return;
      }

      case "tool_execution_end": {
        const rawToolName = this._decodeRuntimeToolName(event.toolName);
        const details = this._extractExecDetails(event.result?.details);
        const snap = this.toolCallSnapshots.get(event.toolCallId);
        const ok = details?.ok ?? !event.isError;
        const output = details?.output ?? this._extractContentText(event.result?.content);
        const meta = details?.meta ?? null;
        const executedBy = details?.executedBy ?? snap?.executedBy ?? "gateway";
        const dryRun = Boolean(details?.dryRun ?? snap?.dryRun);

        // Workflow Skills Gate：当存在激活的 workflow skill 时，按闭环顺序拦截违规调用
        const runCtx: any = this.config.runCtx;
        const activeSkillsRaw = Array.isArray(runCtx.activeSkills) ? runCtx.activeSkills : [];
        const activeSkillIds = activeSkillsRaw.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
        const gates: any = runCtx.gates ?? {};

        const workflowSkills = getActiveWorkflowSkills({
          mode: runCtx.mode,
          intent: runCtx.intent,
          gates: runCtx.gates,
          activeSkillIds,
        });

        if (!dryRun) {
          for (const wf of workflowSkills) {
            if (wf.id !== "style_imitate") continue;

            const toolCalls: ParsedToolCall[] = [
              { name: rawToolName, args: snap?.args ?? {} },
            ];
            const batch = wf.analyzeBatch({
              mode: runCtx.mode,
              intent: runCtx.intent,
              gates: runCtx.gates,
              state: this.runState,
              lintMaxRework: LINT_MAX_REWORK,
              toolCalls,
            });

            const shouldEnforceStyleGate =
              batch.enforceCopy || batch.enforceLint || batch.needStyleKb || batch.needDraftText;
            if (batch.violation && shouldEnforceStyleGate) {
              const violation = String(batch.violation);
              const note = [
                "【StyleWorkflow】检测到风格闭环步骤顺序不合理（violation=" + violation + "）。",
                "请按\"先从风格库拉模板 kb.search → 写出候选稿 → 运行 lint.copy（防复用）→ 运行 lint.style（风格校验）→ 最后 doc.write/doc.applyEdits 落盘\"的顺序调整工具调用。",
              ].join("\n");

              this.config.runCtx.writeEvent("run.notice", {
                turn: this.turn,
                kind: "warn",
                title: "StyleWorkflowViolation",
                message: "StyleWorkflow violation=" + violation + "，本回合工具调用已被拦截，将返回错误结果提示模型按闭环顺序重试。",
                detail: { violation, enforceCopy: batch.enforceCopy, enforceLint: batch.enforceLint },
              });

              const errorOutput = {
                ok: false,
                error: "STYLE_WORKFLOW_VIOLATION",
                violation,
                message: note,
                toolName: rawToolName,
              };

              this.config.runCtx.writeEvent("tool.result", {
                toolCallId: event.toolCallId,
                name: rawToolName,
                ok: false,
                output: errorOutput,
                meta,
              });

              this.turnEngine.record({
                type: "tool_result",
                callId: event.toolCallId,
                name: rawToolName,
                ok: false,
                output: errorOutput,
                error: "STYLE_WORKFLOW_VIOLATION",
              });

              this.failureDigest.failedTools.push({
                toolCallId: event.toolCallId,
                name: rawToolName,
                error: "STYLE_WORKFLOW_VIOLATION",
                message: note,
                path: undefined,
                next_actions: [
                  "按提示调整 kb.search / lint.copy / lint.style / doc.write 的顺序",
                ],
                turn: this.turn,
              });
              this.failureDigest.failedCount = this.failureDigest.failedTools.length;

              this.toolCallSnapshots.delete(event.toolCallId);
              return;
            }

            if (batch.violation) {
              this.config.runCtx.writeEvent("run.notice", {
                turn: this.turn,
                kind: "info",
                title: "StyleWorkflow",
                message: "工具调用顺序提示（" + String(batch.violation) + "），已放行，由 LLM 自行判断。",
              });
            }
          }
        }
        // SSE：tool.result（使用原始工具名）
        this.config.runCtx.writeEvent("tool.result", {
          toolCallId: event.toolCallId,
          name: rawToolName,
          ok,
          output,
          meta,
        });

        // TurnEngine
        this.turnEngine.record({
          type: "tool_result",
          callId: event.toolCallId,
          name: rawToolName,
          ok,
          output,
          error: ok ? undefined : this._extractToolError(output),
        });

        // RunState（使用原始工具名做匹配）
        this._updateRunState(rawToolName, snap?.args ?? {}, {
          ok,
          output,
          meta,
          executedBy,
          dryRun,
        });

        // 失败摘要
        if (!ok && !dryRun) {
          const flat = normalizeToolOutputText(output);
          const m = flat.match(/\bTool\s+([A-Za-z0-9_]+)\s+not\s+found\b/i);
          if (m?.[1]) {
            const raw = this._decodeRuntimeToolName(String(m[1]));
            (this.runState as any).lastToolNotFoundName = raw || null;
            this.config.runCtx.writeEvent("run.notice", {
              turn: this.turn,
              kind: "warn",
              title: "ToolNotFound",
              message: `检测到 TOOL_NOT_FOUND：${raw || m[1]}，下一回合将自愈补齐工具池。`,
              detail: { toolName: raw || m[1], rawError: flat.slice(0, 240) },
            });
          }
          this.failureDigest.failedTools.push({
            toolCallId: event.toolCallId,
            name: rawToolName,
            error: this._extractToolError(output),
            message: this._extractField(output, "message"),
            path: this._extractField(output, "path"),
            next_actions: this._extractNextActions(output),
            turn: this.turn,
          });
          this.failureDigest.failedCount = this.failureDigest.failedTools.length;
        }

        // run.done 终止语义：与旧 runner 保持一致
        if (rawToolName === "run.done") {
          this._activateDeliveryLatch("run_done");
          this._setOutcome({
            status: "completed",
            reason: "run_done",
            reasonCodes: ["run_done"],
          });
          // 通过 abort 内部 controller 终止 agentLoop
          this.internalAc?.abort();
        }

        this.toolCallSnapshots.delete(event.toolCallId);
        return;
      }

      case "turn_end":
        // 追踪连续纯文本回合——用于隐式完成检测
        if (this.currentTurnToolCalls === 0) {
          this.consecutiveTextOnlyTurns += 1;
        } else {
          this.consecutiveTextOnlyTurns = 0;
        }
        this._enforceTurnLevelGuards(ac);
        return;
      case "message_start":
      case "tool_execution_update":
      case "agent_end":
        return;
    }
  }

  // ── Transcript 构建 ───────────────────────────

  private _pushUserToTranscript(message: UserMessage): void {
    const { text, images } = this._normalizeUserContent(message.content);
    pushItem(
      this.transcript,
      images.length
        ? { kind: "user", text, images }
        : { kind: "user", text },
    );
  }

  private _pushAssistantToTranscript(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type === "text") {
        const sanitized = sanitizeAssistantUserFacingText(part.text, {
          dropPureJsonPayload: true,
        });
        if (!sanitized.dropped && sanitized.text) {
          pushItem(this.transcript, {
            kind: "assistant_text",
            text: sanitized.text,
          });

          // 写作类任务：检测是否已产出 draft 文本（用于 style_imitate 闭环）
          try {
            if (this.config.runCtx.intent?.isWritingTask && looksLikeDraftText(sanitized.text)) {
              this.runState.hasDraftText = true;
            }
          } catch {
            // 兜底：intent 缺失时忽略 draft 标记
          }
        }
        continue;
      }

      if (part.type === "toolCall") {
        pushItem(this.transcript, {
          kind: "assistant_tool_call",
          callId: part.id,
          toolName: this._decodeRuntimeToolName(part.name),
          args: part.arguments ?? {},
          providerMeta: {
            api: message.api,
            provider: message.provider,
            model: message.model,
          },
        });
      }
    }
  }

  private _pushToolResultToTranscript(message: ToolResultMessage<any>): void {
    const details = this._extractExecDetails(message.details);
    const output = details?.output ?? this._extractContentText(message.content);
    const ok = details?.ok ?? !message.isError;
    const normalizedText = this._toolResultText(message);

    const item: CanonicalToolResultItem = {
      kind: "tool_result",
      callId: message.toolCallId,
      toolName: this._decodeRuntimeToolName(message.toolName),
      ok,
      output,
      normalizedText,
      providerMeta: details?.meta
        ? {
            executedBy: details.executedBy,
            dryRun: Boolean(details.dryRun),
            meta: details.meta,
          }
        : undefined,
    };
    pushItem(this.transcript, item);
  }

  // ── convertToLlm ──────────────────────────────

  /**
   * 将 AgentMessage[]（混合 CanonicalTranscriptItem 和 pi-ai Message）转为 LLM 可理解的 Message[]。
   * 这是 pi-agent-core 在每轮 LLM 调用前的转换钩子。
   */
  private _convertToLlm(messages: AgentMessage[]): Message[] {
    const providerApi = inferProviderApi(this.config);
    const capabilities = getProviderCapabilities(providerApi);
    let timestamp = Date.now();
    const out: Message[] = [];
    let assistantParts: Array<TextContent | ToolCall> = [];

    const nextTs = () => ++timestamp;

    const flushAssistant = () => {
      if (assistantParts.length === 0) return;
      out.push({
        role: "assistant",
        content: assistantParts,
        api: providerApi as any,
        provider: capabilities.providerKey,
        model: this.config.runCtx.modelId,
        usage: createZeroUsage(),
        stopReason: assistantParts.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
        timestamp: nextTs(),
      } as AssistantMessage);
      assistantParts = [];
    };

    for (const message of messages) {
      // 已经是 pi-ai Message，直接传递
      if (isPiMessage(message)) {
        flushAssistant();
        out.push(message as Message);
        continue;
      }

      // 非 CanonicalTranscriptItem，跳过
      if (!isCanonicalItem(message)) continue;
      const item = message as CanonicalTranscriptItem;

      switch (item.kind) {
        case "user": {
          flushAssistant();
          const content = this._userItemToPiContent(item);
          out.push({
            role: "user",
            content,
            timestamp: nextTs(),
          } as UserMessage);
          break;
        }

        case "assistant_text":
          assistantParts.push({ type: "text", text: item.text });
          break;

        case "assistant_tool_call":
          assistantParts.push({
            type: "toolCall",
            id: item.callId,
            name: this._encodeRuntimeToolName(item.toolName),
            arguments: item.args ?? {},
          } as ToolCall);
          break;

        case "tool_result": {
          flushAssistant();
          out.push({
            role: "toolResult",
            toolCallId: item.callId,
            toolName: this._encodeRuntimeToolName(item.toolName),
            content: buildTextContent(
              item.normalizedText || normalizeToolOutputText(item.output),
            ),
            details: item.output,
            isError: !item.ok,
            timestamp: nextTs(),
          } as ToolResultMessage);
          break;
        }

        case "runtime_hint": {
          flushAssistant();
          out.push({
            role: "user",
            content: `[runtime_hint]\n${item.text}`,
            timestamp: nextTs(),
          } as UserMessage);
          break;
        }

        case "system_checkpoint":
          // 不参与 LLM 上下文
          break;
      }
    }

    flushAssistant();
    return out;
  }

  // ── RunState 更新 ──────────────────────────────

  private _updateRunState(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: GatewayToolExecResult,
  ): void {
    this.runState.hasAnyToolCall = true;

    // B2：sticky 记录（成功工具跨 turn 保留；低成本提高稳定性）
    if (result.ok && !result.dryRun) {
      const nextSticky = appendUniqueBounded(
        Array.isArray((this.runState as any).stickyToolNames) ? ((this.runState as any).stickyToolNames as string[]) : [],
        toolName,
        10,
      );
      (this.runState as any).stickyToolNames = nextSticky;
    }

    // MCP 工具统计
    if (toolName.startsWith("mcp.")) {
      this.runState.hasMcpToolCall = true;
      this.runState.mcpToolCallCount += 1;
      if (result.ok) this.runState.mcpToolSuccessCount += 1;
      else this.runState.mcpToolFailCount += 1;
    }

    // Tool Discovery：即使失败也算“已尝试”，避免反复卡死在同一步
    if (toolName === "tools.search") this.runState.hasToolsSearch = true;
    if (toolName === "tools.describe") this.runState.hasToolsDescribe = true;
    // 浏览器类 MCP（Playwright/browser）标记：用于复合任务阶段推断
    if (toolName.startsWith("mcp.") && /(playwright|browser)/i.test(toolName)) {
      this.runState.hasBrowserMcpToolCall = true;
    }

    // B2：失败统计（用于 failure-driven tool expansion）
    if (!result.ok && !result.dryRun) {
      if (toolName === "web.search") {
        (this.runState as any).webSearchFailCount = Math.max(0, Math.floor(Number((this.runState as any).webSearchFailCount ?? 0))) + 1;
        return;
      }
      if (toolName === "web.fetch") {
        (this.runState as any).webFetchFailCount = Math.max(0, Math.floor(Number((this.runState as any).webFetchFailCount ?? 0))) + 1;
        // 同时保留 domain 观测（失败也应记一次，便于审计）
        this.runState.webFetchUniqueDomains = appendUnique(
          this.runState.webFetchUniqueDomains,
          extractDomain(toolArgs.url),
        );
        return;
      }
    }

    if (!result.ok || result.dryRun) return;

    if (toolName === "time.now") {
      this.runState.hasTimeNow = true;
      const nowIso = String((result.output as any)?.nowIso ?? "").trim();
      this.runState.lastTimeNowIso = nowIso || null;
      return;
    }

    if (toolName === "web.search") {
      this.runState.hasWebSearch = true;
      this.runState.webSearchCount += 1;
      this.runState.webSearchUniqueQueries = appendUnique(
        this.runState.webSearchUniqueQueries,
        String(toolArgs.query ?? ""),
      );
      return;
    }

    if (toolName === "web.fetch") {
      this.runState.hasWebFetch = true;
      this.runState.webFetchCount += 1;
      this.runState.webFetchUniqueDomains = appendUnique(
        this.runState.webFetchUniqueDomains,
        extractDomain(toolArgs.url),
      );
      return;
    }

    if (toolName === "agent.delegate") {
      this.runState.hasPlanCommitment = true;
      const agentId = String(toolArgs.agentId ?? "").trim();
      if (agentId) {
        this.runState.delegationCounts = {
          ...this.runState.delegationCounts,
          [agentId]: (this.runState.delegationCounts?.[agentId] ?? 0) + 1,
        };
      }
      return;
    }

    if (
      toolName === "run.setTodoList" ||
      toolName === "run.todo.upsertMany" ||
      (toolName === "run.todo" && String(toolArgs.action ?? "").trim().toLowerCase() === "upsert")
    ) {
      this.runState.hasTodoList = true;
      this.runState.hasPlanCommitment = true;
      this._markTodoSatisfied();
      return;
    }

    if (toolName === "kb.search") {
      this.runState.hasKbSearch = true;

      const parsedCall: ParsedToolCall = {
        name: toolName,
        args: toolArgs,
      };

      const styleLibIdSet = new Set(
        (this.config.runCtx.styleLibIds ?? [])
          .map((id: unknown) => String(id ?? "").trim())
          .filter(Boolean),
      );

      const isStyleKb = isStyleExampleKbSearch({
        call: parsedCall,
        styleLibIdSet,
        hasNonStyleLibraries: this.config.runCtx.gates?.hasNonStyleLibraries,
      });

      if (isStyleKb) {
        this.runState.hasStyleKbSearch = true;

        const groupsRaw = (result.output as any)?.groups;
        const groupCount = Array.isArray(groupsRaw)
          ? groupsRaw.length
          : Number.isFinite(Number(groupsRaw))
            ? Math.max(0, Math.floor(Number(groupsRaw)))
            : 0;

        if (groupCount > 0) {
          this.runState.hasStyleKbHit = true;
        } else if (!this.runState.hasStyleKbHit) {
          this.runState.styleKbDegraded = true;
        }

        if (this.runState.hasDraftText) {
          this.runState.hasPostDraftStyleKbSearch = true;
        }
      }

      return;
    }

    if (toolName === "lint.style") {
      const parsed = parseStyleLintResult(result.output);
      this.runState.lastStyleLint = parsed;

      const outObj = result.output && typeof result.output === "object"
        ? (result.output as Record<string, unknown>)
        : null;
      if (outObj && (outObj as any).degraded === true) {
        this.runState.lintGateDegraded = true;
      }

      const mustCovered =
        parsed.expectedDimensions.length === 0 || parsed.missingDimensions.length === 0;

      const passed =
        parsed.score !== null &&
        Number.isFinite(parsed.score) &&
        parsed.score >= STYLE_LINT_PASS_SCORE &&
        parsed.highIssues === 0 &&
        mustCovered;

      this.runState.styleLintPassed = passed;
      if (!passed) {
        this.runState.styleLintFailCount = Math.max(
          0,
          Math.floor(Number(this.runState.styleLintFailCount ?? 0)),
        ) + 1;
      }

      return;
    }

    if (toolName === "lint.copy") {
      const out =
        result.output && typeof result.output === "object"
          ? (result.output as Record<string, unknown>)
          : {};

      const passed = (out as any)?.passed === true;
      this.runState.copyLintPassed = passed;

      if (passed) {
        this.runState.copyLintFailCount = 0;
      } else {
        this.runState.copyLintFailCount =
          Math.max(0, Math.floor(Number(this.runState.copyLintFailCount ?? 0))) + 1;
      }

      const riskRaw = String((out as any)?.riskLevel ?? "").trim().toLowerCase();
      const riskLevel: "low" | "medium" | "high" =
        riskRaw === "high" ? "high" : riskRaw === "medium" ? "medium" : "low";
      const maxOverlapChars = Number.isFinite(Number((out as any)?.maxOverlapChars))
        ? Math.max(0, Math.floor(Number((out as any)?.maxOverlapChars)))
        : 0;
      const maxChar5gramJaccard = Number.isFinite(Number((out as any)?.maxChar5gramJaccard))
        ? Math.max(0, Number((out as any)?.maxChar5gramJaccard))
        : 0;
      const topOverlaps = Array.isArray((out as any)?.topOverlaps)
        ? (out as any).topOverlaps.slice(0, 8)
        : [];
      const sources =
        (out as any)?.sources && typeof (out as any).sources === "object"
          ? (out as any).sources
          : null;

      this.runState.lastCopyLint = {
        riskLevel,
        maxOverlapChars,
        maxChar5gramJaccard,
        topOverlaps,
        sources,
      };

      return;
    }

    const isSnapshotRestore =
      toolName === "doc.snapshot" && String(toolArgs.action ?? "").trim().toLowerCase() === "restore";
    if (isWriteLikeTool(toolName) || isSnapshotRestore) {
      this.runState.hasWriteOps = true;
    }
    if (isContentWriteTool(toolName) || isSnapshotRestore || toolName === "code.exec") {
      this.runState.hasWriteOps = true;
      this.runState.hasWriteApplied = true;
      this._recordSideEffect(toolName, toolArgs, result);
      this.runState.toolLoopGuardReason = null;

      // Style_imitate：允许首轮 doc.write/doc.applyEdits 作为“候选稿”，视为已产生 draft
      try {
        const gates: any = this.config.runCtx.gates ?? {};
        if (!this.runState.hasDraftText && gates.styleGateEnabled && gates.lintGateEnabled && this.runState.hasStyleKbSearch) {
          this.runState.hasDraftText = true;
        }
      } catch {
        // 若 runCtx 缺失 gate 信息，不影响主流程
      }
    }
  }

  // ── agent.delegate stub（仅 shadow 模式） ──────

  /**
   * agent.delegate 占位实现（仅 shadow 模式使用）。
   * 记录委派请求和审计事件，但不真正启动子 Agent 循环。
   * 非 shadow 模式走 LegacySubAgentBridge。
   */
  private _handleDelegateStub(
    toolCallId: string,
    toolArgs: Record<string, unknown>,
  ): GatewayToolExecResult {
    const agentId = String(toolArgs.agentId ?? "").trim();
    const task = String(toolArgs.task ?? toolArgs.prompt ?? "").trim();

    // 审计事件：记录委派请求
    this.config.runCtx.writeEvent("tool.call", {
      toolCallId,
      name: "agent.delegate",
      args: toolArgs,
      executedBy: "gateway",
      turn: this.turn,
      stub: true,
    });

    // RunState 由 _updateRunState 统一更新，此处不重复

    return {
      ok: true,
      output: {
        ok: true,
        status: "stub",
        message:
          `子 Agent "${agentId || "(未指定)"}" 的委派请求已记录，但当前 runtime 模式（${this.mode}）暂不支持实际委派执行。` +
          "请直接执行任务或改用其他工具。",
        agentId,
        task: task.length > 500 ? `${task.slice(0, 500)}…` : task,
      },
      executedBy: "gateway",
    };
  }

  // ── 辅助 ──────────────────────────────────────

  private _userItemToPiContent(
    item: CanonicalUserItem,
  ): string | (TextContent | ImageContent)[] {
    if (!item.images?.length) return item.text;

    const parts: Array<TextContent | ImageContent> = [];
    if (item.text.trim()) {
      parts.push({ type: "text", text: item.text });
    }
    for (const image of item.images) {
      parts.push({
        type: "image",
        data: image.data,
        mimeType: image.mediaType,
      } as ImageContent);
    }
    return parts;
  }

  private _normalizeUserContent(
    content: UserMessage["content"],
  ): { text: string; images: RuntimeRunImages } {
    if (typeof content === "string") {
      return { text: content, images: [] };
    }
    const texts: string[] = [];
    const images: RuntimeRunImages = [];
    for (const part of content) {
      if (part.type === "text") texts.push(part.text);
      if (part.type === "image") {
        images.push({ mediaType: (part as ImageContent).mimeType, data: (part as ImageContent).data });
      }
    }
    return { text: texts.join("\n\n").trim(), images };
  }

  private _extractExecDetails(details: unknown): GatewayToolExecResult | null {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const obj = details as Record<string, unknown>;
    if (!("ok" in obj) || !("output" in obj)) return null;
    return {
      ok: Boolean(obj.ok),
      output: obj.output,
      meta: (obj.meta as Record<string, unknown> | null | undefined) ?? null,
      executedBy: obj.executedBy === "desktop" ? "desktop" : "gateway",
      dryRun: Boolean(obj.dryRun),
    };
  }

  private _extractContentText(content: unknown): unknown {
    if (!Array.isArray(content)) return null;
    const text = content
      .filter((p) => p && typeof p === "object" && (p as any).type === "text")
      .map((p) => String((p as any).text ?? ""))
      .join("\n")
      .trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private _toolResultText(message: ToolResultMessage<any>): string {
    const text = Array.isArray(message.content)
      ? message.content
          .filter((p) => p.type === "text")
          .map((p) => (p as TextContent).text)
          .join("\n")
      : "";
    return truncateText(text.trim() || normalizeToolOutputText(message.details));
  }

  private _extractToolError(output: unknown): string {
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const raw = (output as Record<string, unknown>).error;
      if (raw != null) return String(raw);
    }
    return typeof output === "string" && output.trim() ? output.trim() : "TOOL_EXEC_FAILED";
  }

  private _extractField(output: unknown, field: string): string | undefined {
    if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
    const raw = (output as Record<string, unknown>)[field];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  }

  private _extractNextActions(output: unknown): string[] | undefined {
    if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
    const raw = (output as Record<string, unknown>).next_actions;
    if (!Array.isArray(raw)) return undefined;
    const actions = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
    return actions.length ? actions.slice(0, 8) : undefined;
  }

  private _buildExecutionReport(providerApi: ModelApiType): RuntimeExecutionReport {
    const snapshot = this.turnEngine.getSnapshot();

    // Workflow skills snapshot（当前仅 style_imitate）
    const runCtx: any = this.config.runCtx;
    const activeSkillsRaw = Array.isArray(runCtx.activeSkills) ? runCtx.activeSkills : [];
    const activeSkillIds = activeSkillsRaw.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
    const gates: any = runCtx.gates ?? {};
    const workflowSkills = getActiveWorkflowSkills({
      mode: runCtx.mode,
      intent: runCtx.intent,
      gates,
      activeSkillIds,
    }).map((wf) => wf.snapshot(this.runState));

    // Style_imitate 工作流摘要：保留旧字段，便于兼容既有审计逻辑
    const styleSkillActive =
      activeSkillsRaw.some((s: any) => String(s?.id ?? "").trim() === "style_imitate") ||
      (gates.styleGateEnabled && runCtx.intent?.isWritingTask);
    const styleWorkflow = styleSkillActive && runCtx.intent?.isWritingTask
      ? {
          active: true,
          hasStyleKbSearch: Boolean((this.runState as any)?.hasStyleKbSearch),
          hasDraftText: Boolean((this.runState as any)?.hasDraftText),
          copyLintPassed: Boolean((this.runState as any)?.copyLintPassed),
          styleLintPassed: Boolean((this.runState as any)?.styleLintPassed),
        }
      : undefined;

    return {
      runtimeKind: this.kind,
      runtimeMode: this.mode,
      shadowMode: this.shadowMode,
      provider: providerApi,
      providerApi,
      modelId: this.config.runCtx.modelId,
      implemented: true,
      failedToolCount: this.failureDigest.failedCount,
      providerCapabilitiesSnapshot: this.providerCapabilities,
      workflowSkills,
      providerContinuationMode: this.providerCapabilities.continuationMode,
      todoGateSatisfiedAtTurn: this.runState.todoGateSatisfiedAtTurn,
      deliveryLatchActivatedAtTurn: this.runState.deliveryLatchActivatedAtTurn,
      sideEffectLedgerSize: Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger.length : 0,
      recentSideEffectLedger: Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger.slice(-5) : [],
      toolLoopGuardReason: this.runState.toolLoopGuardReason,
      ...(styleWorkflow ? { styleWorkflow } : {}),
      transcriptSummary: summarizeTranscript(this.transcript),
      runState: this.runState,
      ...snapshot,
    };
  }
}