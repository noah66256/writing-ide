import {
  streamAnthropicMessages,
  toolMetaToAnthropicDef,
  buildToolResultMessage,
  type AnthropicMessage,
  type ContentBlockToolUse,
  type MsgStreamEvent,
} from "../llm/anthropicMessages.js";

import {
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  createInitialRunState,
  isContentWriteTool,
  isStyleExampleKbSearch,
  isWriteLikeTool,
  looksLikeDraftText,
  parseStyleLintResult,
  type RunIntent,
  type RunGates,
  type RunState,
  type ActiveSkill,
  type ParsedToolCall,
  BUILTIN_SUB_AGENTS,
  type SubAgentBudget,
} from "@writing-ide/agent-core";

import { TOOL_LIST } from "@writing-ide/tools";

import {
  decideServerToolExecution,
  executeServerToolOnGateway,
} from "./serverToolRunner.js";

export type SseWriter = (event: string, data: unknown) => void;

export type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

export type WaiterMap = Map<string, (payload: ToolResultPayload) => void>;

export type RunContext = {
  runId: string;
  mode: "agent" | "chat";
  intent: RunIntent;
  gates: RunGates;
  activeSkills: ActiveSkill[];
  allowedToolNames: Set<string>;
  systemPrompt: string;
  toolSidecar: any;
  styleLinterLibraries: any[];
  fastify: any;
  authorization?: string | null;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  styleLibIds: string[];
  writeEvent: SseWriter;
  waiters: WaiterMap;
  abortSignal: AbortSignal;
  onTurnUsage?: (promptTokens: number, completionTokens: number) => void;
  /** 每轮回调：根据当前运行状态动态计算本轮可用工具集和 hint。返回 null 表示无阶段限制。 */
  computePerTurnAllowed?: (state: RunState) => { allowed: Set<string>; hint: string } | null;
  /** 初始运行状态：由 gateway 从 contextPack 预初始化（hasTodoList、multiWrite 等），供 runner 继承。 */
  initialRunState?: RunState;
  /** 子 Agent ID（设置后 writeEvent 自动注入 agentId 到每条 SSE 事件） */
  agentId?: string;
  /** 允许覆盖默认最大回合数（子 Agent 可用） */
  maxTurns?: number;
};

type ToolExecResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

type PendingToolUse = {
  name: string;
  inputJson: string;
};

const MAX_TURNS = 30;
const TOOL_RESULT_TIMEOUT_MS = 180_000;
const LINT_MAX_REWORK = 2;
const STYLE_LINT_PASS_SCORE = 70;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "UNKNOWN_ERROR");
}

function normalizeToolArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function toStringArgs(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([k, v]) => [k, normalizeToolArgValue(v)]),
  );
}

function parseObjectJson(jsonText: string): Record<string, unknown> {
  const raw = String(jsonText ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}


function clampIntLocal(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function resolveSubAgentBudget(baseBudget: SubAgentBudget, budgetOverrideJson: string): SubAgentBudget {
  const override = parseObjectJson(budgetOverrideJson);
  return {
    maxTurns: clampIntLocal(override.maxTurns, 1, MAX_TURNS, Math.max(1, Math.floor(baseBudget.maxTurns))),
    maxToolCalls: clampIntLocal(override.maxToolCalls, 1, 100, Math.max(1, Math.floor(baseBudget.maxToolCalls))),
    timeoutMs: clampIntLocal(override.timeoutMs, 5_000, 300_000, Math.max(5_000, Math.floor(baseBudget.timeoutMs))),
  };
}

function extractLastAssistantText(messages: AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) return text;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let j = (msg.content as any[]).length - 1; j >= 0; j -= 1) {
      const block = (msg.content as any[])[j];
      if (block.type !== "text") continue;
      const text = String(block.text ?? "").trim();
      if (text) return text;
    }
  }
  return "";
}

function countAssistantToolUses(messages: AnthropicMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    total += (msg.content as any[]).filter((block: any) => block.type === "tool_use").length;
  }
  return total;
}

export class WritingAgentRunner {
  private readonly ctx: RunContext;
  private readonly messages: AnthropicMessage[] = [];
  private readonly runState: RunState;
  private turn = 0;
  private readonly maxTurns: number;

  constructor(ctx: RunContext) {
    // 若设置了 agentId，包装 writeEvent 自动注入到每条 SSE 事件
    if (ctx.agentId) {
      const raw = ctx.writeEvent;
      const aid = ctx.agentId;
      ctx = { ...ctx, writeEvent: (event, data) => {
        const d = data && typeof data === "object" ? { ...(data as any), agentId: aid } : data;
        raw(event, d);
      }};
    }
    this.ctx = ctx;
    this.maxTurns = Math.min(ctx.maxTurns ?? MAX_TURNS, MAX_TURNS);
    this.runState = ctx.initialRunState ? { ...ctx.initialRunState } : createInitialRunState();
  }

  async run(userMessage: string): Promise<void> {
    this.messages.push({ role: "user", content: userMessage });

    while (this.turn < this.maxTurns) {
      if (this.ctx.abortSignal.aborted) return;
      this.turn += 1;
      const shouldContinue = await this._runOneTurn();
      if (!shouldContinue) return;
    }

    this.ctx.writeEvent("run.end", {
      runId: this.ctx.runId,
      reason: "max_turns",
      reasonCodes: ["max_turns"],
      turn: this.turn,
      maxTurns: this.maxTurns,
    });
    this.ctx.writeEvent("assistant.done", {
      reason: "max_turns",
      turn: this.turn,
    });
  }

  private async _runOneTurn(): Promise<boolean> {
    // per-turn 阶段门禁：动态计算本轮可用工具集和 hint
    const perTurnCaps = this.ctx.computePerTurnAllowed?.(this.runState) ?? null;
    const effectiveAllowed = perTurnCaps?.allowed ?? this.ctx.allowedToolNames;

    const tools = TOOL_LIST.filter((tool) => {
      if (!effectiveAllowed.has(tool.name)) return false;
      if (!tool.modes || tool.modes.length === 0) return true;
      return tool.modes.includes(this.ctx.mode);
    }).map(toolMetaToAnthropicDef);

    // hint 追加到本轮 system prompt（不修改 ctx.systemPrompt 本身）
    const turnSystemPrompt = perTurnCaps?.hint
      ? `${this.ctx.systemPrompt}\n\n${perTurnCaps.hint}`
      : this.ctx.systemPrompt;

    this.ctx.writeEvent("assistant.start", { turn: this.turn });

    let assistantText = "";
    let streamErrored = false;
    let promptTokens = 0;
    let completionTokens = 0;

    const pendingToolUses = new Map<string, PendingToolUse>();
    const completedToolUses: ContentBlockToolUse[] = [];

    const stream = streamAnthropicMessages({
      apiKey: this.ctx.apiKey,
      model: this.ctx.modelId,
      baseUrl: this.ctx.baseUrl,
      system: turnSystemPrompt,
      messages: this.messages,
      tools,
      signal: this.ctx.abortSignal,
    });

    for await (const ev of stream) {
      if (this.ctx.abortSignal.aborted) break;

      this._handleStreamEvent(ev, {
        pendingToolUses,
        completedToolUses,
        onTextDelta: (delta) => {
          assistantText += delta;
        },
        onUsage: (p, c) => {
          promptTokens = Math.max(promptTokens, p);
          completionTokens = Math.max(completionTokens, c);
        },
        onError: () => {
          streamErrored = true;
        },
      });

      if (streamErrored) break;
    }

    if (this.ctx.onTurnUsage && (promptTokens > 0 || completionTokens > 0)) {
      this.ctx.onTurnUsage(promptTokens, completionTokens);
    }

    const assistantBlocks: Array<{ type: "text"; text: string } | ContentBlockToolUse> = [];
    if (assistantText) assistantBlocks.push({ type: "text", text: assistantText });
    if (completedToolUses.length > 0) assistantBlocks.push(...completedToolUses);
    if (assistantBlocks.length > 0) {
      this.messages.push({ role: "assistant", content: assistantBlocks });
    }

    this.ctx.writeEvent("assistant.done", { turn: this.turn });

    if (this.ctx.abortSignal.aborted || streamErrored) {
      return false;
    }

    if (completedToolUses.length === 0) {
      return this._checkAutoRetry(assistantText);
    }

    const parsedToolCalls: ParsedToolCall[] = completedToolUses.map((toolUse) => ({
      name: toolUse.name,
      args: toStringArgs(toolUse.input),
    }));

    const batch = analyzeStyleWorkflowBatch({
      mode: this.ctx.mode,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: LINT_MAX_REWORK,
      toolCalls: parsedToolCalls,
    });

    if (batch.violation) {
      const message = `工具调用顺序违规（${batch.violation}），请按顺序分回合执行。`;
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "StyleWorkflow",
        message,
      });

      // Anthropic API 要求：若 assistant 消息含 tool_use block，下一条 user 消息必须
      // 包含对应的 tool_result block，否则 API 会报 400。
      // 违规分支跳过了正常执行路径，需手动补充错误结果。
      const skippedResultBlocks = completedToolUses.flatMap((toolUse) => {
        const msg = buildToolResultMessage(
          toolUse.id,
          { ok: false, error: "SKIPPED_DUE_TO_VIOLATION" },
          true,
        );
        return Array.isArray(msg.content) ? msg.content : [];
      });

      this.messages.push({
        role: "user",
        content: [
          ...skippedResultBlocks,
          { type: "text", text: `继续推进。${message}` },
        ],
      });
      return true;
    }

    const toolResultMessages = [] as AnthropicMessage[];
    let hasRunDone = false;

    for (const toolUse of completedToolUses) {
      const result = await this._executeTool(toolUse);
      this._updateRunState(toolUse, { ok: result.ok, output: result.output });

      this.ctx.writeEvent("tool.result", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        output: result.output,
        meta: result.meta ?? null,
        turn: this.turn,
      });

      toolResultMessages.push(buildToolResultMessage(toolUse.id, result.output, !result.ok));

      if (toolUse.name === "run.done") {
        hasRunDone = true;
      }

      if (this.ctx.abortSignal.aborted) {
        break;
      }
    }

    if (toolResultMessages.length > 0) {
      const mergedBlocks = toolResultMessages.flatMap((msg) =>
        Array.isArray(msg.content) ? msg.content : [],
      );
      if (mergedBlocks.length > 0) {
        this.messages.push({ role: "user", content: mergedBlocks });
      }
    }

    if (this.ctx.abortSignal.aborted) return false;
    if (hasRunDone) return false;
    return true;
  }

  private _handleStreamEvent(
    ev: MsgStreamEvent,
    handlers: {
      pendingToolUses: Map<string, PendingToolUse>;
      completedToolUses: ContentBlockToolUse[];
      onTextDelta: (delta: string) => void;
      onUsage: (promptTokens: number, completionTokens: number) => void;
      onError: () => void;
    },
  ): void {
    switch (ev.type) {
      case "text_delta": {
        handlers.onTextDelta(ev.delta);
        this.ctx.writeEvent("assistant.delta", { delta: ev.delta, turn: this.turn });
        return;
      }

      case "tool_use_start": {
        handlers.pendingToolUses.set(ev.id, { name: ev.name, inputJson: "" });
        return;
      }

      case "tool_use_input_delta": {
        const pending = handlers.pendingToolUses.get(ev.id);
        if (pending) pending.inputJson += ev.partial_json;
        return;
      }

      case "tool_use_done": {
        const pending = handlers.pendingToolUses.get(ev.id);
        if (pending) handlers.pendingToolUses.delete(ev.id);

        const fallbackInput = pending ? parseObjectJson(pending.inputJson) : {};
        const input =
          Object.keys(ev.input ?? {}).length > 0
            ? ev.input
            : fallbackInput;
        const name = pending?.name ?? ev.name;

        const block: ContentBlockToolUse = {
          type: "tool_use",
          id: ev.id,
          name,
          input,
        };

        handlers.completedToolUses.push(block);

        this.ctx.writeEvent("tool.call.args_ready", {
          toolCallId: ev.id,
          name,
          args: input,
          turn: this.turn,
        });
        return;
      }

      case "usage": {
        const prompt = Number.isFinite(ev.promptTokens)
          ? Math.max(0, Math.floor(ev.promptTokens))
          : 0;
        const completion = Number.isFinite(ev.completionTokens)
          ? Math.max(0, Math.floor(ev.completionTokens))
          : 0;
        handlers.onUsage(prompt, completion);
        return;
      }

      case "error": {
        handlers.onError();
        this.ctx.writeEvent("error", { error: ev.error, turn: this.turn });
        return;
      }

      case "done": {
        return;
      }
    }
  }

  private async _executeTool(toolUse: ContentBlockToolUse): Promise<ToolExecResult> {
    const rawInput = toolUse.input ?? {};
    const strArgs = toStringArgs(rawInput);

    // Sub-agent delegation: intercept before generic server tool routing
    if (toolUse.name === "agent.delegate") {
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      return this._executeSubAgent(toolUse, strArgs);
    }

    const decision = decideServerToolExecution({
      name: toolUse.name,
      toolArgs: strArgs,
      toolSidecar: this.ctx.toolSidecar,
    });

    this.ctx.writeEvent("tool.call", {
      toolCallId: toolUse.id,
      name: toolUse.name,
      args: rawInput,
      executedBy: decision.executedBy,
      turn: this.turn,
    });

    if (decision.executedBy === "gateway") {
      try {
        const ret = await executeServerToolOnGateway({
          fastify: this.ctx.fastify,
          call: { name: toolUse.name, args: strArgs },
          toolSidecar: this.ctx.toolSidecar,
          styleLinterLibraries: this.ctx.styleLinterLibraries,
          authorization: this.ctx.authorization ?? null,
        });

        if (ret.ok) {
          return {
            ok: true,
            output: (ret as { output: unknown }).output,
            meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
          };
        }

        return {
          ok: false,
          output: {
            ok: false,
            error: (ret as { error?: unknown }).error ?? "SERVER_TOOL_FAILED",
          },
          meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
        };
      } catch (err) {
        return {
          ok: false,
          output: { ok: false, error: "SERVER_TOOL_EXEC_ERROR", detail: toErrorMessage(err) },
          meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
        };
      }
    }

    return this._waitForDesktopToolResult(toolUse.id, toolUse.name);
  }


  private async _executeSubAgent(
    toolUse: ContentBlockToolUse,
    strArgs: Record<string, string>,
  ): Promise<ToolExecResult> {
    const agentId = String(strArgs.agentId ?? "").trim();
    const task = String(strArgs.task ?? "").trim();

    if (!agentId) {
      return { ok: false, output: { ok: false, error: "VALIDATION_ERROR", detail: "agentId is required" } };
    }
    if (!task) {
      return { ok: false, output: { ok: false, error: "VALIDATION_ERROR", detail: "task is required" } };
    }

    const subAgent = BUILTIN_SUB_AGENTS.find((a) => a.id === agentId && a.enabled);
    if (!subAgent) {
      const knownIds = BUILTIN_SUB_AGENTS.filter((a) => a.enabled).map((a) => a.id);
      return {
        ok: false,
        output: { ok: false, error: "NOT_FOUND", detail: `Unknown or disabled agentId "${agentId}". Available: ${knownIds.join(", ")}` },
      };
    }

    const budget = resolveSubAgentBudget(subAgent.budget, strArgs.budget ?? "");
    const subRunId = `${this.ctx.runId}:sub:${toolUse.id}`;

    // Sub-agent tools: from definition, exclude agent.delegate (prevent nesting)
    const subAllowedToolNames = new Set(
      (subAgent.tools ?? []).map((n) => String(n ?? "").trim()).filter(Boolean),
    );
    subAllowedToolNames.delete("agent.delegate");

    // Abort control: chain parent abort + budget timeout
    const subAbort = new AbortController();
    let timeoutTriggered = false;
    let toolBudgetExceeded = false;
    let toolCallsUsed = 0;

    const onParentAbort = () => { if (!subAbort.signal.aborted) subAbort.abort(); };
    if (this.ctx.abortSignal.aborted) onParentAbort();
    else this.ctx.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    const budgetTimeout = setTimeout(() => {
      timeoutTriggered = true;
      if (!subAbort.signal.aborted) subAbort.abort();
    }, budget.timeoutMs);

    // Wrap writeEvent to count tool calls, enforce budget, and filter lifecycle events
    const subWriteEvent: SseWriter = (event, data) => {
      // Filter out sub-agent run.end to prevent premature UI stop
      if (event === "run.end") return;
      if (event === "tool.call") {
        toolCallsUsed += 1;
        if (toolCallsUsed > budget.maxToolCalls && !subAbort.signal.aborted) {
          toolBudgetExceeded = true;
          subAbort.abort();
        }
      }
      this.ctx.writeEvent(event, data);
    };

    // Build sub-agent RunContext with minimal intent/gates (no style workflow interference)
    const subCtx: RunContext = {
      runId: subRunId,
      mode: "agent",
      intent: { forceProceed: true, wantsWrite: false, wantsOkOnly: false, isWritingTask: false, skipLint: true, skipCta: true },
      gates: { styleGateEnabled: false, lintGateEnabled: false, copyGateEnabled: false, hasStyleLibrary: false, hasNonStyleLibraries: false, styleLibIds: [], nonStyleLibIds: [], styleLibIdSet: new Set() },
      activeSkills: [],
      allowedToolNames: subAllowedToolNames,
      systemPrompt: String(subAgent.systemPrompt ?? "").trim() || this.ctx.systemPrompt,
      toolSidecar: this.ctx.toolSidecar,
      styleLinterLibraries: this.ctx.styleLinterLibraries,
      fastify: this.ctx.fastify,
      authorization: this.ctx.authorization,
      modelId: this.ctx.modelId,
      apiKey: this.ctx.apiKey,
      baseUrl: this.ctx.baseUrl,
      styleLibIds: this.ctx.styleLibIds,
      writeEvent: subWriteEvent,
      waiters: this.ctx.waiters,
      abortSignal: subAbort.signal,
      agentId: subAgent.id,
      maxTurns: budget.maxTurns,
      onTurnUsage: (promptTokens, completionTokens) => {
        // Forward to parent's usage callback
        this.ctx.onTurnUsage?.(promptTokens, completionTokens);
        // Emit usage event with agentId for billing attribution
        this.ctx.writeEvent("subagent.usage", {
          parentRunId: this.ctx.runId,
          runId: subRunId,
          agentId: subAgent.id,
          promptTokens,
          completionTokens,
        });
      },
    };

    const subRunner = new WritingAgentRunner(subCtx);
    const startedAt = Date.now();

    // Build task message with inputArtifacts and acceptanceCriteria
    const inputArtifacts = (() => {
      const raw = strArgs.inputArtifacts ?? "";
      if (!raw.trim()) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })();
    const acceptanceCriteria = String(strArgs.acceptanceCriteria ?? "").trim();

    let taskMessage = task;
    if (inputArtifacts.length > 0) {
      const artifactTexts = inputArtifacts.map((a: any, i: number) => {
        if (typeof a === "string") return `[${i + 1}] ${a}`;
        const label = String(a?.agentId ?? a?.label ?? `artifact_${i + 1}`);
        const content = String(a?.artifact ?? a?.content ?? JSON.stringify(a));
        return `[${label}]\n${content}`;
      });
      taskMessage = `## 上游产物\n${artifactTexts.join("\n\n")}\n\n## 任务\n${task}`;
    }
    if (acceptanceCriteria) {
      taskMessage += `\n\n## 验收标准\n${acceptanceCriteria}`;
    }

    this.ctx.writeEvent("subagent.start", {
      turn: this.turn,
      toolCallId: toolUse.id,
      parentRunId: this.ctx.runId,
      runId: subRunId,
      agentId: subAgent.id,
      agentName: subAgent.name,
      budget,
    });

    let status: "completed" | "error" | "timeout" = "completed";
    let errorDetail: string | null = null;

    try {
      await subRunner.run(taskMessage);
      if (this.ctx.abortSignal.aborted) {
        status = "error";
        errorDetail = errorDetail ?? "PARENT_ABORTED";
      } else if (timeoutTriggered) {
        status = "timeout";
      } else if (toolBudgetExceeded) {
        status = "error";
      }
    } catch (err) {
      errorDetail = toErrorMessage(err);
      status = timeoutTriggered ? "timeout" : "error";
    } finally {
      clearTimeout(budgetTimeout);
      this.ctx.abortSignal.removeEventListener("abort", onParentAbort);
    }

    if (toolBudgetExceeded && !errorDetail) {
      errorDetail = `SUB_AGENT_TOOL_BUDGET_EXCEEDED(${budget.maxToolCalls})`;
    }

    const messages = subRunner.getMessages();
    const artifact = extractLastAssistantText(messages);
    const turnsUsed = subRunner.getTurn();
    const toolCallsUsedFinal = Math.max(toolCallsUsed, countAssistantToolUses(messages));

    this.ctx.writeEvent("subagent.done", {
      turn: this.turn,
      toolCallId: toolUse.id,
      parentRunId: this.ctx.runId,
      runId: subRunId,
      agentId: subAgent.id,
      agentName: subAgent.name,
      status,
      artifact: artifact.slice(0, 2000),
      turnsUsed,
      toolCallsUsed: toolCallsUsedFinal,
      budget,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: errorDetail ?? undefined,
    });

    return {
      ok: true,
      output: {
        agentId: subAgent.id,
        status,
        artifact,
        turnsUsed,
        toolCallsUsed: toolCallsUsedFinal,
      },
      meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
    };
  }

  private _waitForDesktopToolResult(
    toolCallId: string,
    toolName: string,
  ): Promise<ToolExecResult> {
    return new Promise<ToolExecResult>((resolve) => {
      let settled = false;

      const finish = (result: ToolExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.ctx.waiters.delete(toolCallId);
        this.ctx.abortSignal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finish({
          ok: false,
          output: { ok: false, error: "TOOL_RESULT_TIMEOUT", toolCallId, name: toolName },
        });
      }, TOOL_RESULT_TIMEOUT_MS);

      const onAbort = () => {
        finish({
          ok: false,
          output: { ok: false, error: "ABORTED", toolCallId, name: toolName },
        });
      };

      this.ctx.waiters.set(toolCallId, (payload) => {
        finish({
          ok: payload.ok,
          output: payload.output,
          meta: payload.meta ?? null,
        });
      });

      this.ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private _updateRunState(
    toolUse: ContentBlockToolUse,
    result: { ok: boolean; output: unknown },
  ): void {
    this.runState.hasAnyToolCall = true;

    if (!result.ok) return;

    const name = toolUse.name;

    if (name === "time.now") {
      this.runState.hasTimeNow = true;
      const nowIso = String((result.output as { nowIso?: unknown })?.nowIso ?? "").trim();
      this.runState.lastTimeNowIso = nowIso || null;
      return;
    }

    if (name === "run.setTodoList" || name === "run.todo.upsertMany") {
      this.runState.hasTodoList = true;
      return;
    }

    if (name === "web.search") {
      this.runState.hasWebSearch = true;
      this.runState.webSearchCount = Math.max(
        0,
        Math.floor(Number(this.runState.webSearchCount ?? 0)),
      ) + 1;
      return;
    }

    if (name === "kb.search") {
      this.runState.hasKbSearch = true;

      const parsedCall: ParsedToolCall = {
        name,
        args: toStringArgs(toolUse.input),
      };

      const isStyleKb = isStyleExampleKbSearch({
        call: parsedCall,
        styleLibIdSet: new Set(
          (this.ctx.styleLibIds ?? [])
            .map((id) => String(id ?? "").trim())
            .filter(Boolean),
        ),
        hasNonStyleLibraries: this.ctx.gates.hasNonStyleLibraries,
      });

      if (isStyleKb) {
        this.runState.hasStyleKbSearch = true;

        const groupsRaw = (result.output as { groups?: unknown })?.groups;
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

    if (name === "lint.style") {
      const parsed = parseStyleLintResult(result.output);
      this.runState.lastStyleLint = parsed;

      const passed =
        parsed.score !== null &&
        Number.isFinite(parsed.score) &&
        parsed.score >= STYLE_LINT_PASS_SCORE &&
        parsed.highIssues === 0;

      this.runState.styleLintPassed = passed;
      if (!passed) {
        this.runState.styleLintFailCount = Math.max(
          0,
          Math.floor(Number(this.runState.styleLintFailCount ?? 0)),
        ) + 1;
      }

      return;
    }

    if (isWriteLikeTool(name)) {
      this.runState.hasWriteOps = true;
    }

    if (isContentWriteTool(name)) {
      this.runState.hasWriteOps = true;
      this.runState.hasWriteApplied = true;
    }
  }

  private _checkAutoRetry(assistantText: string): boolean {
    if (!this.ctx.intent.isWritingTask) return false;

    if (looksLikeDraftText(assistantText)) {
      this.runState.hasDraftText = true;
    }

    const analysis = analyzeAutoRetryText({
      assistantText,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: LINT_MAX_REWORK,
    });

    if (!analysis.shouldRetry) return false;

    const reasons = Array.isArray(analysis.reasons)
      ? analysis.reasons.filter((r) => String(r ?? "").trim())
      : [];

    const reasonText = reasons.length ? reasons.join("、") : "仍有未完成步骤";

    this.messages.push({
      role: "user",
      content: `继续推进。当前缺少：${reasonText}。请基于上下文完成未完成的步骤。`,
    });

    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "AutoRetry",
      message: `自动重试：${reasonText}`,
    });

    return true;
  }

  getMessages(): AnthropicMessage[] {
    return this.messages;
  }

  getRunState(): RunState {
    return this.runState;
  }

  getTurn(): number {
    return this.turn;
  }
}
