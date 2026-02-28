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
  parseStyleLintResult,
  type RunIntent,
  type RunGates,
  type RunState,
  type ActiveSkill,
  type ParsedToolCall,
  BUILTIN_SUB_AGENTS,
  type SubAgentBudget,
  type SubAgentDefinition,
} from "@writing-ide/agent-core";

import { TOOL_LIST, encodeToolName } from "@writing-ide/tools";

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
  /** 子 Agent 模型解析回调：按候选列表顺序尝试解析，命中即返回；全部失败返回 null（回退父 agent 配置） */
  resolveSubAgentModel?: (
    candidates: string[],
  ) => Promise<{ modelId: string; apiKey: string; baseUrl: string } | null>;
  /** 初始运行状态：由 gateway 从 contextPack 预初始化（hasTodoList、multiWrite 等），供 runner 继承。 */
  initialRunState?: RunState;
  /** 用户通过 @mention 指定的目标子 Agent ID 列表 */
  targetAgentIds?: string[];
  /** 子 Agent ID（设置后 writeEvent 自动注入 agentId 到每条 SSE 事件） */
  agentId?: string;
  /** 允许覆盖默认最大回合数（子 Agent 可用） */
  maxTurns?: number;
  /** 首轮 tool_choice 覆盖（仅首轮生效；用于子 Agent 强制调工具） */
  toolChoiceFirstTurn?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  /** 目标字数（从 userPrompt/mainDoc.goal 中提取），用于 AutoRetry 字数校验 */
  targetChars?: number | null;
  /** 运行期间 mainDoc 的可变状态，供 run.mainDoc.get / run.mainDoc.update 读写 */
  mainDoc: Record<string, unknown>;
  /** Custom agent definitions from Desktop (for agent.delegate to resolve custom agents) */
  customAgentDefinitions?: SubAgentDefinition[];
  /** 大文本 blob 池：避免大文本经过 LLM 回显。key=blobId, value=原始文本 */
  textBlobPool?: Map<string, string>;
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
const MAIN_DOC_UPDATE_SOFT_LIMIT = 5;
const MAIN_DOC_UPDATE_HARD_LIMIT = 8;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "UNKNOWN_ERROR");
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

function resolveSubAgentBudget(baseBudget: SubAgentBudget, budgetOverride: unknown): SubAgentBudget {
  const override = (typeof budgetOverride === "object" && budgetOverride !== null)
    ? budgetOverride as Record<string, unknown>
    : parseObjectJson(String(budgetOverride ?? ""));
  return {
    maxTurns: clampIntLocal(override.maxTurns, 1, MAX_TURNS, Math.max(1, Math.floor(baseBudget.maxTurns))),
    maxToolCalls: clampIntLocal(override.maxToolCalls, 1, 100, Math.max(1, Math.floor(baseBudget.maxToolCalls))),
    timeoutMs: clampIntLocal(override.timeoutMs, 5_000, 300_000, Math.max(5_000, Math.floor(baseBudget.timeoutMs))),
  };
}

function buildSubAgentContextHint(args: {
  styleLibIds: string[];
  mainDoc: Record<string, unknown> | null | undefined;
  styleLibIdSet: Set<string>;
}): string {
  const styleLibIds = Array.from(
    new Set((args.styleLibIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean)),
  );
  const selectedStyleLibIds = Array.from(
    new Set(
      Array.from(args.styleLibIdSet ?? new Set<string>())
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    ),
  );
  const mainDoc = args.mainDoc && typeof args.mainDoc === "object" ? args.mainDoc : {};

  const goal = String((mainDoc as { goal?: unknown }).goal ?? "").trim();
  if (styleLibIds.length === 0 && !goal) return "";

  const title = String((mainDoc as { title?: unknown }).title ?? "").trim();
  const constraintsRaw = (mainDoc as { constraints?: unknown }).constraints;
  const constraints = Array.isArray(constraintsRaw)
    ? constraintsRaw.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 8)
    : String(constraintsRaw ?? "").trim()
      ? [String(constraintsRaw ?? "").trim()]
      : [];

  const lines: string[] = ["## 上下文（自动注入）"];
  if (styleLibIds.length > 0) {
    lines.push(`- 风格库 ID: ${styleLibIds.join(", ")}`);
  }
  if (selectedStyleLibIds.length > 0 && selectedStyleLibIds.join(",") !== styleLibIds.join(",")) {
    lines.push(`- 已选风格库 ID: ${selectedStyleLibIds.join(", ")}`);
  }
  if (title) lines.push(`- 任务标题: ${title}`);
  if (goal) lines.push(`- 任务目标: ${goal}`);
  if (constraints.length > 0) {
    lines.push("- 约束:");
    for (const c of constraints) lines.push(`  - ${c}`);
  }

  return lines.join("\n");
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
  private consecutiveMainDocOnlyTurns = 0;
  private blockMainDocUpdate = false;

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

    // If user @mentioned specific agents, auto-delegate before main loop
    if (this.ctx.targetAgentIds?.length) {
      await this._bootstrapTargetDelegation(userMessage);
      return;
    }

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

  /**
   * When user @mentions specific agents, bypass the main LLM loop and directly
   * delegate to the specified sub-agents (in parallel if multiple).
   */
  private async _bootstrapTargetDelegation(userMessage: string): Promise<void> {
    const ids = (this.ctx.targetAgentIds ?? []).filter(Boolean);
    const allAgents = [
      ...BUILTIN_SUB_AGENTS,
      ...(this.ctx.customAgentDefinitions ?? []),
    ];
    const validAgents = ids
      .map((id) => allAgents.find((a) => a.id === id))
      .filter(Boolean);

    if (validAgents.length === 0) {
      // No valid agents found, fall back to normal run
      while (this.turn < this.maxTurns) {
        if (this.ctx.abortSignal.aborted) return;
        this.turn += 1;
        const shouldContinue = await this._runOneTurn();
        if (!shouldContinue) return;
      }
      return;
    }

    // Build synthetic tool_use blocks for each target agent
    const toolUses = validAgents.map((agent: any, i: number) => ({
      type: "tool_use" as const,
      id: `bootstrap_delegate_${i}_${Date.now()}`,
      name: "agent.delegate",
      input: { agentId: agent.id, task: userMessage } as Record<string, unknown>,
    }));

    // Push synthetic assistant message with delegation calls
    this.messages.push({ role: "assistant", content: toolUses });

    // Execute all delegations in parallel
    const results = await Promise.all(
      toolUses.map(async (toolUse) => {
        const result = await this._executeTool(toolUse);
        return { toolUse, result };
      }),
    );

    // Build tool_result messages and emit events
    const toolResultBlocks: any[] = [];
    for (const { toolUse, result } of results) {
      const output = result.output;
      this.ctx.writeEvent("tool.result", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        output,
      });
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: typeof output === "string" ? output : JSON.stringify(output),
      });
    }

    if (toolResultBlocks.length > 0) {
      this.messages.push({ role: "user", content: toolResultBlocks });
    }

    // After delegation, let main agent continue normally to summarize
    while (this.turn < this.maxTurns) {
      if (this.ctx.abortSignal.aborted) return;
      this.turn += 1;
      const shouldContinue = await this._runOneTurn();
      if (!shouldContinue) return;
    }
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

    // MCP 工具：从 context 的 mcpTools 生成 tool definitions（需编码 name，与内置工具一致）
    const mcpToolDefs = ((this.ctx as any).mcpTools ?? [])
      .filter((t: any) => effectiveAllowed.has(t.name))
      .map((t: any) => ({
        name: encodeToolName(String(t.name ?? "")),
        description: String(t.description ?? ""),
        input_schema: t.inputSchema ?? { type: "object" as const, properties: {} },
      }));
    tools.push(...mcpToolDefs);

    // hint 追加到本轮 system prompt（不修改 ctx.systemPrompt 本身）
    const turnSystemPrompt = perTurnCaps?.hint
      ? `${this.ctx.systemPrompt}\n\n${perTurnCaps.hint}`
      : this.ctx.systemPrompt;

    this.ctx.writeEvent("assistant.start", { turn: this.turn });

    let assistantText = "";
    let streamErrored = false;
    let lastStreamError = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const pendingToolUses = new Map<string, PendingToolUse>();
    const completedToolUses: ContentBlockToolUse[] = [];

    const STREAM_RETRY_MAX = 3;
    const STREAM_RETRY_BASE_MS = 800;

    for (let attempt = 0; attempt <= STREAM_RETRY_MAX; attempt++) {
      if (this.ctx.abortSignal.aborted) break;

      // Reset per-attempt state
      assistantText = "";
      streamErrored = false;
      lastStreamError = "";
      promptTokens = 0;
      completionTokens = 0;
      pendingToolUses.clear();
      completedToolUses.length = 0;

      const stream = streamAnthropicMessages({
        apiKey: this.ctx.apiKey,
        model: this.ctx.modelId,
        baseUrl: this.ctx.baseUrl,
        system: turnSystemPrompt,
        messages: this.messages,
        tools,
        tool_choice: this.turn === 1 && tools.length > 0 ? this.ctx.toolChoiceFirstTurn : undefined,
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
          onError: (error) => {
            streamErrored = true;
            lastStreamError = error;
          },
        });

        if (streamErrored) break;
      }

      // HTTP 200 但 body 为空（代理/上游异常）：视为可重试错误
      const hasContent = assistantText.length > 0 || completedToolUses.length > 0;
      if (!streamErrored && !hasContent) {
        streamErrored = true;
        lastStreamError = "模型服务返回了空响应，正在重试...";
      }

      if (!streamErrored) break;

      // Only retry if no content was produced (connection failed before model responded)
      if (hasContent || attempt >= STREAM_RETRY_MAX) break;

      const jitter = Math.floor(Math.random() * 200);
      const waitMs = STREAM_RETRY_BASE_MS * Math.pow(2, attempt) + jitter;
      console.warn(
        `[agent-stream] retry ${attempt + 1}/${STREAM_RETRY_MAX} after ${waitMs}ms — ${lastStreamError}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // After all retries exhausted, emit error to client
    if (streamErrored) {
      this.ctx.writeEvent("error", { error: lastStreamError, turn: this.turn });
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
      args: toolUse.input ?? {},
    }));

    // Batch analysis: still track state for observability, but no longer block tool execution.
    // Workflow ordering is guided by skill promptFragments, not enforced by code.
    const batch = analyzeStyleWorkflowBatch({
      mode: this.ctx.mode,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: LINT_MAX_REWORK,
      toolCalls: parsedToolCalls,
    });

    if (batch.violation) {
      // Log for observability but don't block execution
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: "StyleWorkflow",
        message: `工具调用顺序提示（${batch.violation}），已放行，由 LLM 自行判断。`,
      });
    }

    const toolResultMessages = [] as AnthropicMessage[];
    let hasRunDone = false;

    // 将工具调用拆分为子 Agent 委托调用与常规调用，委托调用可并行执行
    const delegateCalls: { index: number; toolUse: ContentBlockToolUse }[] = [];
    const regularCalls: { index: number; toolUse: ContentBlockToolUse }[] = [];
    completedToolUses.forEach((toolUse, i) => {
      if (toolUse.name === "agent.delegate") {
        delegateCalls.push({ index: i, toolUse });
      } else {
        regularCalls.push({ index: i, toolUse });
      }
    });

    // 收集按原始顺序排列的结果
    const orderedResults: { index: number; toolUse: ContentBlockToolUse; result: ToolExecResult }[] = [];

    // 1) 并行执行所有 agent.delegate 调用
    if (delegateCalls.length > 0) {
      const delegateResults = await Promise.all(
        delegateCalls.map(async ({ index, toolUse }) => {
          const result = await this._executeTool(toolUse);
          return { index, toolUse, result };
        }),
      );
      orderedResults.push(...delegateResults);
    }

    // 2) 顺序执行常规工具调用
    for (const { index, toolUse } of regularCalls) {
      if (this.ctx.abortSignal.aborted) break;
      const result = await this._executeTool(toolUse);
      orderedResults.push({ index, toolUse, result });
    }

    // 3) 按原始顺序合并结果，发送事件
    orderedResults.sort((a, b) => a.index - b.index);
    for (const { toolUse, result } of orderedResults) {
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
    }

    // ── mainDoc 连续更新熔断（防止把 mainDoc 当写字板循环） ──────────────
    let mainDocLoopWarning: string | null = null;
    const isMainDocOnlyTurn =
      orderedResults.length > 0 &&
      orderedResults.every(({ toolUse }) =>
        toolUse.name === "run.mainDoc.update" || toolUse.name === "run.mainDoc.get",
      );

    if (isMainDocOnlyTurn) {
      this.consecutiveMainDocOnlyTurns += 1;
    } else {
      this.consecutiveMainDocOnlyTurns = 0;
    }

    if (
      isMainDocOnlyTurn &&
      this.consecutiveMainDocOnlyTurns >= MAIN_DOC_UPDATE_SOFT_LIMIT &&
      this.consecutiveMainDocOnlyTurns < MAIN_DOC_UPDATE_HARD_LIMIT
    ) {
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "MainDocLoopGuard",
        message: `连续 ${this.consecutiveMainDocOnlyTurns} 轮仅更新 mainDoc，请立即改用 lint.copy 或 doc.write。`,
      });
      // 注入普通 user text 而非伪造 tool_result（后者因缺少对应 tool_use 会触发 API 400）
      // 延迟到 tool results 合并后再 push，见下方 mainDocLoopWarning 变量
      mainDocLoopWarning =
        "【系统约束】你已连续更新 mainDoc 多轮且未推进实质步骤。请立即调用 lint.copy 完成检查，或调用 doc.write 输出最终稿。禁止继续将正文/改写记录写入 mainDoc。";
    }

    if (isMainDocOnlyTurn && this.consecutiveMainDocOnlyTurns >= MAIN_DOC_UPDATE_HARD_LIMIT) {
      this.blockMainDocUpdate = true;
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "error",
        title: "MainDocLoopGuard",
        message: `run.mainDoc.update 熔断（连续 ${this.consecutiveMainDocOnlyTurns} 轮）。`,
      });
    }

    if (toolResultMessages.length > 0) {
      const mergedBlocks = toolResultMessages.flatMap((msg) =>
        Array.isArray(msg.content) ? msg.content : [],
      );
      // 软提示作为 text block 追加到同一条 user 消息（避免连续 user 消息触发 API 错误）
      if (mainDocLoopWarning) {
        mergedBlocks.push({ type: "text", text: mainDocLoopWarning });
      }
      if (mergedBlocks.length > 0) {
        this.messages.push({ role: "user", content: mergedBlocks });
      }
    } else if (mainDocLoopWarning) {
      // 理论上不可达：mainDoc 更新必有 tool result。
      // 若因重构导致此分支被触发，仅记录日志，不注入消息（避免破坏 user/assistant 交替）
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "MainDocLoopGuard",
        message: `[fallback] ${mainDocLoopWarning}`,
      });
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
      onError: (error: string) => void;
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
        handlers.onError(ev.error);
        return;
      }

      case "done": {
        return;
      }
    }
  }

  private async _executeTool(toolUse: ContentBlockToolUse): Promise<ToolExecResult> {
    let rawInput = toolUse.input ?? {};

    // Sub-agent delegation: intercept before generic server tool routing
    if (toolUse.name === "agent.delegate") {
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      return this._executeSubAgent(toolUse, rawInput);
    }

    // Tool allowlist enforcement: prevent hallucinated tool calls for sub-agents
    if (this.ctx.allowedToolNames.size > 0 && !this.ctx.allowedToolNames.has(toolUse.name)) {
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      return {
        ok: false as const,
        output: { ok: false, error: "TOOL_NOT_ALLOWED", detail: `Tool "${toolUse.name}" is not available for this agent.` },
      };
    }

    // mainDoc 熔断：连续更新过多后直接拒绝
    if (toolUse.name === "run.mainDoc.update" && this.blockMainDocUpdate) {
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      return {
        ok: false as const,
        output: {
          ok: false,
          error: "MAIN_DOC_UPDATE_BLOCKED: 连续调用过多，已熔断。请改用 lint.copy 或 doc.write。",
        },
      };
    }

    // 子 agent 写文件拦截：暂存为 artifact，不直接写入（防止并行冲突）
    // 只拦截 doc.write / doc.applyEdits（不拦截 replaceSelection/restoreSnapshot 等）
    if (this.ctx.agentId && (toolUse.name === "doc.write" || toolUse.name === "doc.applyEdits")) {
      const path = String(rawInput.path ?? rawInput.file ?? "").trim();
      const content = String(rawInput.content ?? rawInput.text ?? "").trim();
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      return {
        ok: true,
        output: {
          ok: true,
          redirected: true,
          path,
          content,
          chars: content.length,
          message: "内容已暂存为 artifact，等待负责人审核后决定是否写入。",
        },
        meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
      };
    }

    // MCP 工具：直接路由到 Desktop 执行
    if (toolUse.name.startsWith("mcp.")) {
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "desktop",
        turn: this.turn,
      });
      return this._waitForDesktopToolResult(toolUse.id, toolUse.name);
    }

    // textRef 解析：将 blob 引用替换为实际文本（在路由到 Desktop 前注入）
    if (toolUse.name === "kb.learn") {
      const textRef = String((rawInput as Record<string, unknown>).textRef ?? "").trim();
      if (textRef) {
        const blobText = this.ctx.textBlobPool?.get(textRef);
        if (blobText) {
          rawInput = { ...rawInput, text: blobText };
          // 清理冲突字段，确保 Desktop 端 one-of 校验通过
          delete (rawInput as Record<string, unknown>).textRef;
          delete (rawInput as Record<string, unknown>).path;
          delete (rawInput as Record<string, unknown>).url;
          // 不在此处删除 blob：如果工具执行失败 LLM 重试时仍需引用。
          // blob 随 runner 上下文 GC 自动清理（每次 run 最多 1 个 blob）。
        } else {
          this.ctx.writeEvent("tool.call", {
            toolCallId: toolUse.id,
            name: toolUse.name,
            args: { textRef, error: "TEXT_REF_NOT_FOUND" },
            executedBy: "gateway",
            turn: this.turn,
          });
          return {
            ok: false as const,
            output: {
              ok: false,
              error: "TEXT_REF_NOT_FOUND",
              detail: `文本引用 "${textRef}" 未找到，可能已过期。请要求用户重新提交文本。`,
            },
          };
        }
      }
    }

    const decision = decideServerToolExecution({
      name: toolUse.name,
      toolArgs: rawInput,
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
          call: { name: toolUse.name, args: rawInput },
          toolSidecar: this.ctx.toolSidecar,
          styleLinterLibraries: this.ctx.styleLinterLibraries,
          authorization: this.ctx.authorization ?? null,
          mainDoc: this.ctx.mainDoc,
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
    rawArgs: Record<string, unknown>,
  ): Promise<ToolExecResult> {
    const agentId = String(rawArgs.agentId ?? "").trim();
    const task = String(rawArgs.task ?? "").trim();

    if (!agentId) {
      return { ok: false, output: { ok: false, error: "VALIDATION_ERROR", detail: "agentId is required" } };
    }
    if (!task) {
      return { ok: false, output: { ok: false, error: "VALIDATION_ERROR", detail: "task is required" } };
    }

    const subAgent: SubAgentDefinition | undefined =
      BUILTIN_SUB_AGENTS.find((a) => a.id === agentId && a.enabled)
      ?? (this.ctx.customAgentDefinitions ?? []).find((a) => a.id === agentId && a.enabled);
    if (!subAgent) {
      const allAgents = [
        ...BUILTIN_SUB_AGENTS.filter((a) => a.enabled),
        ...(this.ctx.customAgentDefinitions ?? []).filter((a) => a.enabled),
      ];
      const knownIds = allAgents.map((a) => a.id);
      return {
        ok: false,
        output: { ok: false, error: "NOT_FOUND", detail: `Unknown or disabled agentId "${agentId}". Available: ${knownIds.join(", ")}` },
      };
    }

    const budget = resolveSubAgentBudget(subAgent.budget, rawArgs.budget);
    const subRunId = `${this.ctx.runId}:sub:${toolUse.id}`;

    // 解析子 agent 偏好模型：model -> fallbackModels -> 父 agent 配置
    const subModelCandidates = [
      String(subAgent.model ?? "").trim(),
      ...((subAgent.fallbackModels ?? []).map((m) => String(m ?? "").trim())),
    ].filter(Boolean);

    let resolvedSubModel: { modelId: string; apiKey: string; baseUrl: string } | null = null;
    if (this.ctx.resolveSubAgentModel && subModelCandidates.length > 0) {
      try {
        resolvedSubModel = await this.ctx.resolveSubAgentModel(subModelCandidates);
      } catch {
        resolvedSubModel = null;
      }
    }

    const subModelId = resolvedSubModel?.modelId ?? this.ctx.modelId;
    const subApiKey = resolvedSubModel?.apiKey ?? this.ctx.apiKey;
    const subBaseUrl = resolvedSubModel?.baseUrl ?? this.ctx.baseUrl;

    // Sub-agent tools: from definition, exclude agent.delegate (prevent nesting)
    const subAllowedToolNames = new Set(
      (subAgent.tools ?? []).map((n) => String(n ?? "").trim()).filter(Boolean),
    );
    subAllowedToolNames.delete("agent.delegate");

    // 方案 A：自动注入 MCP 工具到子 Agent（与负责人共享 MCP 工具池）
    const mcpTools: any[] = (this.ctx as any).mcpTools ?? [];
    for (const t of mcpTools) {
      if (t.name) subAllowedToolNames.add(t.name);
    }

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

    // Wrap writeEvent to count tool calls, enforce budget, filter lifecycle events,
    // and inject agentId for desktop-side parallel routing
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
      // Inject agentId into all sub-agent events so desktop can route parallel streams
      const enriched = typeof data === "object" && data !== null
        ? { ...(data as Record<string, unknown>), agentId: subAgent.id, agentName: subAgent.name }
        : data;
      this.ctx.writeEvent(event, enriched);
    };

    // Determine if this sub-agent should inherit the parent's style/lint gates.
    // Condition: parent has lint enabled AND sub-agent has lint.style in its tool list.
    const subCanLint = subAllowedToolNames.has("lint.style");
    const inheritStyleGates = this.ctx.gates.lintGateEnabled && subCanLint;

    const subIntent = inheritStyleGates
      ? { forceProceed: true, wantsWrite: false, wantsOkOnly: true, isWritingTask: true, skipLint: false, skipCta: this.ctx.intent.skipCta }
      : { forceProceed: true, wantsWrite: false, wantsOkOnly: true, isWritingTask: false, skipLint: true, skipCta: true };

    const subGates = inheritStyleGates
      ? { ...this.ctx.gates }
      : { styleGateEnabled: false, lintGateEnabled: false, copyGateEnabled: false, hasStyleLibrary: false, hasNonStyleLibraries: false, styleLibIds: [] as string[], nonStyleLibIds: [] as string[], styleLibIdSet: new Set<string>() };

    // 大文本预判：若子 agent 有 kb.learn 且 task 超阈值，提前初始化 blob 池
    // 必须在 subCtx 构建之前，确保 Map 引用能共享给子 runner
    const needsTextBlob = task.length > 2000 && subAllowedToolNames.has("kb.learn");
    if (needsTextBlob && !this.ctx.textBlobPool) {
      (this.ctx as any).textBlobPool = new Map<string, string>();
    }

    // Build sub-agent RunContext
    const subCtx: RunContext = {
      runId: subRunId,
      mode: "agent",
      intent: subIntent,
      gates: subGates,
      activeSkills: [],
      allowedToolNames: subAllowedToolNames,
      systemPrompt: String(subAgent.systemPrompt ?? "").trim() || this.ctx.systemPrompt,
      toolSidecar: this.ctx.toolSidecar,
      styleLinterLibraries: this.ctx.styleLinterLibraries,
      fastify: this.ctx.fastify,
      authorization: this.ctx.authorization,
      modelId: subModelId,
      apiKey: subApiKey,
      baseUrl: subBaseUrl,
      styleLibIds: this.ctx.styleLibIds,
      writeEvent: subWriteEvent,
      waiters: this.ctx.waiters,
      abortSignal: subAbort.signal,
      agentId: subAgent.id,
      maxTurns: budget.maxTurns,
      // 不再对子 agent 第一轮强制 tool_choice=any：
      // 大上下文时模型推理选工具期间 SSE 流长时间静默，代理 idle timeout 会断连。
      // 子 agent 的 systemPrompt 已明确指示第一步调哪个工具，无需强制。
      toolChoiceFirstTurn: undefined,
      mainDoc: this.ctx.mainDoc,
      textBlobPool: this.ctx.textBlobPool,
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

    // 将 MCP 工具传递给子 Agent context
    if (mcpTools.length) {
      (subCtx as any).mcpTools = mcpTools;
    }

    const subRunner = new WritingAgentRunner(subCtx);
    const startedAt = Date.now();

    // Build task message with inputArtifacts and acceptanceCriteria
    const inputArtifacts = (() => {
      const raw = rawArgs.inputArtifacts;
      if (Array.isArray(raw)) return raw;
      const s = String(raw ?? "").trim();
      if (!s) return [];
      try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; }
      catch { return []; }
    })();
    const acceptanceCriteria = String(rawArgs.acceptanceCriteria ?? "").trim();

    let taskMessage = task;

    // 大文本外置到 blob pool —— 避免 LLM 回显巨量文本导致 SSE 超时
    if (needsTextBlob && this.ctx.textBlobPool) {
      const blobId = `blob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.ctx.textBlobPool.set(blobId, task);
      const charCount = task.length;
      const preview = task.slice(0, 150).replace(/\n/g, " ") + "...";
      taskMessage = [
        `用户提交了约${charCount}字的文本，内容预览：「${preview}」`,
        "",
        `请调用 kb.learn 工具开始学习入库流程，传入 textRef="${blobId}"。`,
        "文本已由系统预存，无需你传递原文。",
      ].join("\n");
    }

    // 自动注入精简上下文到 taskMessage（风格库 ID + mainDoc 目标/约束）
    const contextHint = buildSubAgentContextHint({
      styleLibIds: this.ctx.styleLibIds,
      mainDoc: this.ctx.mainDoc,
      styleLibIdSet: this.ctx.gates.styleLibIdSet,
    });
    if (contextHint) {
      taskMessage += `\n\n${contextHint}`;
    }

    if (inputArtifacts.length > 0) {
      const artifactTexts = inputArtifacts.map((a: any, i: number) => {
        if (typeof a === "string") return `[${i + 1}] ${a}`;
        const label = String(a?.agentId ?? a?.label ?? `artifact_${i + 1}`);
        const content = String(a?.artifact ?? a?.content ?? JSON.stringify(a));
        return `[${label}]\n${content}`;
      });
      taskMessage = `## 上游产物\n${artifactTexts.join("\n\n")}\n\n## 任务\n${taskMessage}`;
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
      modelId: subModelId,
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
      artifact,
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

    if (name === "kb.search") {
      this.runState.hasKbSearch = true;

      const parsedCall: ParsedToolCall = {
        name,
        args: toolUse.input ?? {},
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

      // MUST 维度覆盖：当 lint.style 返回了 expectedDimensions 时，missingDimensions 必须为空才算通过
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

    if (name === "lint.copy") {
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

    if (isWriteLikeTool(name)) {
      this.runState.hasWriteOps = true;
    }

    if (isContentWriteTool(name)) {
      this.runState.hasWriteOps = true;
      this.runState.hasWriteApplied = true;
    }
  }

  private _checkAutoRetry(assistantText: string): boolean {
    // Sub-agent tool nudge: if a sub-agent's early turns produce text without
    // calling any tools (and tools are available), inject a nudge message.
    // This handles API proxies that strip tool_choice: "any" from the request.
    if (this.ctx.agentId && this.turn <= 2 && this.ctx.allowedToolNames.size > 0) {
      this.messages.push({
        role: "user",
        content: "请立即调用工具执行任务。不要输出分析或计划——直接调用第一个需要的工具。",
      });
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: "SubAgentToolNudge",
        message: "子 Agent 未调用工具，已注入工具调用提醒并继续下一轮。",
      });
      return true;
    }

    if (!this.ctx.intent.isWritingTask) return false;

    const analysis = analyzeAutoRetryText({
      assistantText,
      intent: this.ctx.intent,
      gates: this.ctx.gates,
      state: this.runState,
      lintMaxRework: LINT_MAX_REWORK,
      targetChars: this.ctx.targetChars ?? null,
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
