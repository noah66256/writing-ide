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

export class WritingAgentRunner {
  private readonly ctx: RunContext;
  private readonly messages: AnthropicMessage[] = [];
  private readonly runState: RunState;
  private turn = 0;
  private readonly maxTurns = MAX_TURNS;

  constructor(ctx: RunContext) {
    this.ctx = ctx;
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
