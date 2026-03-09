/**
 * LegacySubAgentBridge — 子 Agent 委派桥接层
 *
 * 当前由 GatewayRuntime 的 agent.delegate 调用，并继续使用独立 sub-run 的预算/SSE 包装。
 * 文件名暂保留，仅为减少迁移噪音；内部已不再依赖旧 AgentRunner。
 */

import {
  BUILTIN_SUB_AGENTS,
  type SubAgentBudget,
  type SubAgentDefinition,
} from "@ohmycrab/agent-core";

import {
  type RunContext,
  type SseWriter,
} from "../writingAgentRunner.js";

// ── 常量 ─────────────────────────────────────────

const MAX_SUB_AGENT_TURNS = 30;

/** 子 Agent artifact 最大长度（超长截断避免 SSE 超载） */
const MAX_ARTIFACT_LENGTH = 30_000;

/** 模型常见幻觉名 → 正确 agentId */
const AGENT_ALIASES: Record<string, string> = {
  researcher: "topic_planner",
  research: "topic_planner",
  planner: "topic_planner",
  search: "topic_planner",
  searcher: "topic_planner",
  writer: "copywriter",
  copy: "copywriter",
  editor: "copywriter",
  seo: "seo_specialist",
};

// ── 导出类型 ─────────────────────────────────────

export type LegacySubAgentBridgeResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
  executedBy: "gateway";
  dryRun?: boolean;
};

// ── 辅助函数（从 writingAgentRunner.ts 内联，避免导出私有实现） ──

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? "UNKNOWN_ERROR");
}

function parseObjectJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function resolveSubAgentBudget(
  baseBudget: SubAgentBudget,
  budgetOverride: unknown,
): SubAgentBudget {
  const override = parseObjectJson(budgetOverride);
  return {
    maxTurns: clampInt(override.maxTurns, 1, MAX_SUB_AGENT_TURNS, Math.max(1, Math.floor(baseBudget.maxTurns))),
    maxToolCalls: clampInt(override.maxToolCalls, 1, 100, Math.max(1, Math.floor(baseBudget.maxToolCalls))),
    timeoutMs: clampInt(override.timeoutMs, 5_000, 300_000, Math.max(5_000, Math.floor(baseBudget.timeoutMs))),
  };
}

function cleanSubAgentArtifactText(raw: string): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  // 清理 XML 工具调用残留
  text = text.replace(/<(tool_calls|function_calls)\b[\s\S]*?<\/\1>/gi, " ");
  text = text
    .replace(/^\s*<\/?(tool_calls|function_calls)[^>]*>\s*$/gim, "")
    .replace(/^\s*<\/?(tool_call|invoke)[^>]*>\s*$/gim, "")
    .replace(/^\s*<\/?(arg|parameter)[^>]*>\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";

  // 去除连续重复段落
  const paragraphs = text.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return text;
  const deduped: string[] = [];
  for (const p of paragraphs) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === p) continue;
    deduped.push(p);
  }
  return deduped.join("\n\n").trim();
}

function normalizeDelegationTask(rawTask: unknown): string {
  const text = String(rawTask ?? "").trim();
  if (!text) return "";
  const noMentions = text.replace(/^(?:@\S+\s*)+/g, "").trim();
  return noMentions || text;
}

// ── Agent 查找 ───────────────────────────────────

function resolveSubAgent(
  requestedAgentId: string,
  customAgentDefinitions: SubAgentDefinition[],
): SubAgentDefinition | undefined {
  const allAgents = [
    ...BUILTIN_SUB_AGENTS.filter((a) => a.enabled),
    ...customAgentDefinitions.filter((a) => a.enabled),
  ];

  // 精确匹配
  const exact = allAgents.find((a) => a.id === requestedAgentId);
  if (exact) return exact;

  // 别名匹配
  const lower = requestedAgentId.toLowerCase();
  const aliasId = AGENT_ALIASES[lower];
  if (aliasId) {
    const alias = allAgents.find((a) => a.id === aliasId);
    if (alias) return alias;
  }

  // 模糊匹配（中文名 / id 子串）
  return allAgents.find(
    (a) =>
      a.name === requestedAgentId ||
      a.name.includes(requestedAgentId) ||
      a.id.includes(lower) ||
      lower.includes(a.id),
  );
}

// ── 任务消息构建（MVP 简化版） ────────────────────

function buildTaskMessage(toolArgs: Record<string, unknown>): string {
  const baseTask =
    normalizeDelegationTask(toolArgs.task ?? toolArgs.prompt) ||
    String(toolArgs.task ?? toolArgs.prompt ?? "").trim();

  // 解析 inputArtifacts
  const rawArtifacts = toolArgs.inputArtifacts;
  const inputArtifacts: unknown[] = Array.isArray(rawArtifacts)
    ? rawArtifacts
    : (() => {
        const s = String(rawArtifacts ?? "").trim();
        if (!s) return [];
        try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; }
        catch { return []; }
      })();

  const acceptanceCriteria = String(toolArgs.acceptanceCriteria ?? "").trim();

  let taskMessage = baseTask;

  if (inputArtifacts.length > 0) {
    const texts = inputArtifacts.map((a: any, i: number) => {
      if (typeof a === "string") return `[${i + 1}] ${a}`;
      const label = String(a?.agentId ?? a?.label ?? `artifact_${i + 1}`);
      const content = String(a?.artifact ?? a?.content ?? JSON.stringify(a));
      return `[${label}]\n${content}`;
    });
    taskMessage = `## 上游产物\n${texts.join("\n\n")}\n\n## 任务\n${taskMessage}`;
  }

  if (acceptanceCriteria) {
    taskMessage += `\n\n## 验收标准\n${acceptanceCriteria}`;
  }

  return taskMessage;
}

// ── LegacySubAgentBridge ─────────────────────────

export class LegacySubAgentBridge {
  constructor(private readonly parentCtx: RunContext) {}

  /**
   * 执行子 Agent 委派。
   * 创建 sub RunContext → 实例化 GatewayRuntime → run → 提取 artifact。
   */
  async execute(
    toolCallId: string,
    toolArgs: Record<string, unknown>,
    turn: number,
  ): Promise<LegacySubAgentBridgeResult> {
    const agentId = String(toolArgs.agentId ?? "").trim();
    const task = String(toolArgs.task ?? toolArgs.prompt ?? "").trim();

    // ── 校验 ──
    if (!agentId) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "agentId is required" },
        executedBy: "gateway",
      };
    }
    if (!task) {
      return {
        ok: false,
        output: { ok: false, error: "VALIDATION_ERROR", detail: "task is required" },
        executedBy: "gateway",
      };
    }

    // ── Agent 查找 ──
    const customAgents = this.parentCtx.customAgentDefinitions ?? [];
    const subAgent = resolveSubAgent(agentId, customAgents);
    if (!subAgent) {
      const knownIds = [
        ...BUILTIN_SUB_AGENTS.filter((a) => a.enabled),
        ...customAgents.filter((a) => a.enabled),
      ].map((a) => a.id);
      return {
        ok: false,
        output: {
          ok: false,
          error: "NOT_FOUND",
          detail: `Unknown or disabled agentId "${agentId}". Available: ${knownIds.join(", ")}`,
        },
        executedBy: "gateway",
      };
    }

    // ── Budget ──
    const budget = resolveSubAgentBudget(subAgent.budget, toolArgs.budget);
    const subRunId = `${this.parentCtx.runId}:sub:${toolCallId}`;

    // ── 工具白名单 ──
    const subAllowedToolNames = new Set(
      (subAgent.tools ?? []).map((n) => String(n ?? "").trim()).filter(Boolean),
    );
    subAllowedToolNames.delete("agent.delegate"); // 禁止子 Agent 嵌套委派

    // ── Abort 控制 ──
    const subAbort = new AbortController();
    let timeoutTriggered = false;
    let toolBudgetExceeded = false;
    let toolCallsUsed = 0;

    const onParentAbort = () => {
      if (!subAbort.signal.aborted) subAbort.abort();
    };
    if (this.parentCtx.abortSignal.aborted) {
      onParentAbort();
    } else {
      this.parentCtx.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    const budgetTimeout = setTimeout(() => {
      timeoutTriggered = true;
      if (!subAbort.signal.aborted) subAbort.abort();
    }, budget.timeoutMs);

    let artifactBuffer = "";

    // ── writeEvent 包装：计数 + 预算 + agentId 注入 ──
    const subWriteEvent: SseWriter = (event, data) => {
      // 过滤子 Agent 的 run.end 防止 UI 提前终止
      if (event === "run.end") return;

      if (event === "assistant.delta") {
        const delta = typeof (data as any)?.delta === "string" ? String((data as any).delta) : "";
        if (delta) artifactBuffer += delta;
      }

      if (event === "tool.call") {
        toolCallsUsed += 1;
        if (toolCallsUsed > budget.maxToolCalls && !subAbort.signal.aborted) {
          toolBudgetExceeded = true;
          subAbort.abort();
        }
      }

      // 注入 agentId/agentName 供 Desktop 路由
      const enriched =
        data && typeof data === "object"
          ? { ...(data as Record<string, unknown>), agentId: subAgent.id, agentName: subAgent.name }
          : data;
      this.parentCtx.writeEvent(event, enriched);
    };

    // ── 构造 sub RunContext ──
    const subCtx: RunContext = {
      runId: subRunId,
      mode: "agent",
      intent: {
        forceProceed: true,
        wantsWrite: false,
        wantsOkOnly: true,
        isWritingTask: false,
        skipLint: true,
        skipCta: true,
      } as any,
      gates: {
        styleGateEnabled: false,
        lintGateEnabled: false,
        copyGateEnabled: false,
        hasStyleLibrary: false,
        hasNonStyleLibraries: false,
        styleLibIds: [] as string[],
        nonStyleLibIds: [] as string[],
        styleLibIdSet: new Set<string>(),
      } as any,
      activeSkills: [],
      allowedToolNames: subAllowedToolNames,
      systemPrompt: String(subAgent.systemPrompt ?? "").trim() || this.parentCtx.systemPrompt,
      toolSidecar: this.parentCtx.toolSidecar,
      styleLinterLibraries: this.parentCtx.styleLinterLibraries,
      fastify: this.parentCtx.fastify,
      authorization: this.parentCtx.authorization,
      modelId: this.parentCtx.modelId,
      apiKey: this.parentCtx.apiKey,
      baseUrl: this.parentCtx.baseUrl,
      endpoint: this.parentCtx.endpoint,
      apiType: this.parentCtx.apiType,
      toolResultFormat: this.parentCtx.toolResultFormat,
      styleLibIds: this.parentCtx.styleLibIds,
      writeEvent: subWriteEvent,
      // 复用父 ctx 的 waiters Map（当前安全：父子串行 + toolCallId 唯一；
      // 若未来支持并行子 Agent，需改为 `${runId}:${toolCallId}` 复合键）
      waiters: this.parentCtx.waiters,
      abortSignal: subAbort.signal,
      onTurnUsage: (promptTokens, completionTokens) => {
        this.parentCtx.onTurnUsage?.(promptTokens, completionTokens);
        this.parentCtx.writeEvent("subagent.usage", {
          turn,
          toolCallId,
          parentRunId: this.parentCtx.runId,
          runId: subRunId,
          agentId: subAgent.id,
          agentName: subAgent.name,
          promptTokens,
          completionTokens,
        });
      },
      agentId: subAgent.id,
      maxTurns: budget.maxTurns,
      toolChoiceFirstTurn: undefined, // 不强制首轮工具
      mainDoc: this.parentCtx.mainDoc,
      customAgentDefinitions: this.parentCtx.customAgentDefinitions,
      jsonToolFallbackEnabled: this.parentCtx.jsonToolFallbackEnabled ?? false,
    };

    // ── 执行 ──
    const startedAt = Date.now();
    const taskMessage = buildTaskMessage(toolArgs);

    this.parentCtx.writeEvent("subagent.start", {
      turn,
      toolCallId,
      parentRunId: this.parentCtx.runId,
      runId: subRunId,
      agentId: subAgent.id,
      agentName: subAgent.name,
      budget,
      modelId: this.parentCtx.modelId,
    });

    let status: "completed" | "error" | "timeout" = "completed";
    let errorDetail: string | null = null;
    let turnsUsed = 0;

    try {
      const { GatewayRuntime } = await import("./GatewayRuntime.js");
      const subRuntime = new GatewayRuntime({ mode: "pi", runCtx: subCtx, shadowMode: "off" } as any);
      const result = await subRuntime.run(taskMessage);
      turnsUsed = result.turn;
      if (this.parentCtx.abortSignal.aborted) {
        status = "error";
        errorDetail = "PARENT_ABORTED";
      } else if (timeoutTriggered) {
        status = "timeout";
      } else if (toolBudgetExceeded) {
        status = "error";
      } else if (result.outcome.status !== "completed") {
        status = "error";
        errorDetail = String(result.outcome.reason ?? "SUB_AGENT_FAILED");
      }
    } catch (err) {
      errorDetail = toErrorMessage(err);
      if (this.parentCtx.abortSignal.aborted) {
        status = "error";
        errorDetail = errorDetail || "PARENT_ABORTED";
      } else if (timeoutTriggered) {
        status = "timeout";
      } else {
        status = "error";
      }
    } finally {
      clearTimeout(budgetTimeout);
      this.parentCtx.abortSignal.removeEventListener("abort", onParentAbort);
    }

    if (toolBudgetExceeded && !errorDetail) {
      errorDetail = `SUB_AGENT_TOOL_BUDGET_EXCEEDED(${budget.maxToolCalls})`;
    }

    // ── 结果提取 ──
    let artifact = artifactBuffer.trim();
    if (artifact.length > MAX_ARTIFACT_LENGTH) {
      artifact = `${artifact.slice(0, MAX_ARTIFACT_LENGTH)}
...[artifact 已截断，共 ${artifact.length} 字符]`;
    }
    const toolCallsUsedFinal = toolCallsUsed;

    this.parentCtx.writeEvent("subagent.done", {
      turn,
      toolCallId,
      parentRunId: this.parentCtx.runId,
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
      executedBy: "gateway",
    };
  }
}
