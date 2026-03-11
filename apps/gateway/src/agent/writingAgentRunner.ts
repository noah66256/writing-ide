import {
  streamAnthropicMessages,
  toolMetaToAnthropicDef,
  type AnthropicMessage,
  type ContentBlockImage,
  type ContentBlockToolUse,
  type MsgStreamEvent,
} from "../llm/anthropicMessages.js";
import {
  buildInjectedToolResultMessages,
  getAdapterByEndpoint,
  isGeminiLikeEndpoint,
} from "../llm/providerAdapter.js";
import type { OpenAiChatMessage, OpenAiCompatTool } from "../llm/openaiCompat.js";
import { normalizeToolParametersSchema } from "../llm/toolSchema.js";
import {
  buildToolCallsXml,
  xmlCdataSafe,
  xmlEscapeAttr,
} from "../llm/toolXmlProtocol.js";
import { sanitizeAssistantUserFacingText } from "./userFacingText.js";
import { deriveProviderCapabilities, type ProviderCapabilitySnapshot } from "../llm/providerCapabilities.js";

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
  STYLE_IMITATE_SKILL,
  BUILTIN_SUB_AGENTS,
  type SubAgentBudget,
  type SubAgentDefinition,
} from "@ohmycrab/agent-core";

import { TOOL_LIST, decodeToolName, encodeToolName, validateToolCallArgs } from "@ohmycrab/tools";

import {
  decideServerToolExecution,
  executeServerToolOnGateway,
} from "./serverToolRunner.js";
import { inferCapabilities } from "./toolCatalog.js";
import { TurnEngine, type RunOutcome } from "./turnEngine.js";

export type SseWriter = (event: string, data: unknown) => void;

export type ToolResultPayload = {
  toolCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

type ExecutionContract = {
  required: boolean;
  minToolCalls?: number;
  maxNoToolTurns?: number;
  reason?: string;
  preferredToolNames?: string[];
};

type DeliveryContract = {
  required: boolean;
  kind?: "file_markdown" | "file_office" | "unknown" | "none";
  recommendedPath?: string;
  preferredWriteToolNames?: string[];
};

export type WaiterMap = Map<string, (payload: ToolResultPayload) => void>;

export type ModelApiType =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "gemini";

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
  endpoint?: string;
  apiType?: ModelApiType;
  toolResultFormat?: "xml" | "text";
  styleLibIds: string[];
  writeEvent: SseWriter;
  waiters: WaiterMap;
  abortSignal: AbortSignal;
  onTurnUsage?: (promptTokens: number, completionTokens: number) => void;
  /** 每轮回调：根据当前运行状态动态计算本轮可用工具集和 hint。返回 null 表示无阶段限制。 */
  computePerTurnAllowed?: (state: RunState) => { allowed: Set<string>; hint: string; orchestratorMode?: boolean } | null;
  /** 子 Agent 模型解析回调：按候选列表顺序尝试解析，命中即返回；全部失败返回 null（回退父 agent 配置） */
  resolveSubAgentModel?: (
    candidates: string[],
  ) => Promise<{ modelId: string; apiKey: string; baseUrl: string; endpoint?: string; toolResultFormat?: "xml" | "text" } | null>;
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

  /**
   * Phase2：交付契约（Deliverability Contract）
   * - required=true 时，run 结束前必须产出至少一个“可审计的交付物（artifact）”，否则不允许按纯文本完成。
   * - 当前最常见的是 file_markdown：要求 doc.write / doc.applyEdits / code.exec 等成功写入。
   */
  deliveryContract?: {
    required: boolean;
    kind?: "file_markdown" | "file_office" | "unknown" | "none";
    recommendedPath?: string;
    preferredWriteToolNames?: string[];
  };
  /** Custom agent definitions from Desktop (for agent.delegate to resolve custom agents) */
  customAgentDefinitions?: SubAgentDefinition[];
  /** 注入给子 Agent 的 L1 全局记忆（裁剪过的 section 子集） */
  l1Memory?: string;
  /** 注入给子 Agent 的 L2 项目记忆（裁剪过的 section 子集） */
  l2Memory?: string;
  /** 注入给子 Agent 的对话摘要 */
  ctxDialogueSummary?: string;
  /** 当前 Run 的路由 ID（来自 intent router） */
  intentRouteId?: string;
  /** 路由层下发的执行达成约束（要求本轮至少触发工具） */
  executionContract?: ExecutionContract;
  /** 是否启用"从纯 JSON 文本反推工具调用"兜底（默认关闭，避免 JSON 泄漏）。 */
  jsonToolFallbackEnabled?: boolean;
  /** 大文本 blob 池：避免大文本经过 LLM 回显。key=blobId, value=原始文本 */
  textBlobPool?: Map<string, string>;
  /** 首轮图片附件（base64，Anthropic image block 格式） */
  images?: Array<{ mediaType: string; data: string }>;
};

type ToolExecResult = {
  ok: boolean;
  output: unknown;
  meta?: Record<string, unknown> | null;
};

type ToolFailureDigest = {
  toolCallId: string;
  name: string;
  error: string;
  message?: string;
  path?: string;
  next_actions?: string[];
  turn: number;
};

type PendingToolUse = {
  name: string;
  inputJson: string;
};

type ForcedToolChoice = { type: "any" } | { type: "tool"; name: string };

type ToolAttemptSnapshot = {
  name: string;
  argsSig: string;
  ok: boolean;
  resultSig: string;
  turn: number;
};

// ---------------------------------------------------------------------------
// Phase C: canonical 消息存储类型
// ---------------------------------------------------------------------------
type CanonicalToolResult = {
  toolUseId: string;
  toolName: string;
  content: string;
  isError?: boolean;
};

type CanonicalHistoryEntry =
  | {
      role: "user";
      text: string;
      images?: Array<{ mediaType: string; data: string }>;
    }
  | {
      role: "assistant";
      blocks: Array<{ type: "text"; text: string } | ContentBlockToolUse>;
      /** 原始流输出文本（provider 路径无 tool_use 时用作历史文本） */
      rawStreamText?: string;
    }
  | {
      role: "tool_result";
      results: CanonicalToolResult[];
      /** 附加系统约束文本（如 mainDocLoopWarning） */
      noteText?: string;
    }
  | {
      role: "user_hint";
      text: string;
    };

// ---------------------------------------------------------------------------
// Phase D: TurnAdapter 抽象
// ---------------------------------------------------------------------------

/**
 * 统一 turn 函数消费流后的结果。
 * Anthropic 和 Provider 两个 adapter 产出相同的结构，供统一 _runOneTurn 使用。
 */
type StreamConsumeResult = {
  /** 用户可见文本（Anthropic = assistantText，Provider = plainText，已去除 XML wrapper） */
  displayText: string;
  /** 原始流文本（仅 Provider 路径有意义，Anthropic 为 undefined） */
  rawStreamText: string | undefined;
  /** 已完成的 tool_use block 列表 */
  completedToolUses: ContentBlockToolUse[];
  /** 流是否出错 */
  streamErrored: boolean;
  /** 最后一次流错误信息 */
  lastStreamError: string;
  /** prompt token 用量 */
  promptTokens: number;
  /** completion token 用量 */
  completionTokens: number;
  /** 是否检测到 <tool_calls> 标记（Provider 特有） */
  hasToolCallMarker: boolean;
  /** XML wrapper 计数（Provider 特有） */
  wrapperCount: number;
  /** Provider 路径中 schema 验证失败的预设结果 */
  presetResults: Map<string, ToolExecResult>;
};

/**
 * TurnAdapter 抽象：封装 Anthropic 与 Provider 两条路径的差异。
 * 统一的 _runOneTurn 通过 adapter 方法调用，不再做端点类型判断。
 */
interface TurnAdapter {
  /** 重试策略 */
  retryPolicy: { maxRetries: number; baseDelayMs: number; jitterMs: number };
  /** 是否需要检测 XML 协议违规（Provider 路径需要，Anthropic 不需要） */
  detectsProtocolViolation: boolean;

  /** 构建工具定义列表，返回定义数组和工具名集合 */
  buildToolDefs(effectiveAllowed: Set<string>): {
    defs: unknown[];
    toolNameSet: Set<string>;
  };

  /** 消费一次模型流，返回统一结果 */
  consumeStream(args: {
    toolDefs: unknown[];
    turnSystemPrompt: string;
    effectiveAllowed: Set<string>;
    turnToolChoice: any;
    emitTextDelta: boolean;
    signal: AbortSignal;
  }): Promise<StreamConsumeResult>;

  /** 判断流结果是否有实质内容（用于空响应重试判断） */
  hasContent(result: StreamConsumeResult): boolean;

  /** 获取用于 autoRetry 判断的文本 */
  getAutoRetryText(result: StreamConsumeResult): string;

  /** 构建历史条目 */
  buildHistoryEntry(args: {
    result: StreamConsumeResult;
    suppressText: boolean;
    hasProtocolViolation: boolean;
  }): { entry: CanonicalHistoryEntry; shouldPush: boolean };
}

const MAX_TURNS = 48;
const TOOL_RESULT_TIMEOUT_MS = 180_000;
const LINT_MAX_REWORK = 2;
const STYLE_LINT_PASS_SCORE = 70;
const MAIN_DOC_UPDATE_SOFT_LIMIT = 5;
const MAIN_DOC_UPDATE_HARD_LIMIT = 8;
/** 子 Agent 自动注入记忆段的字符上限 */
const SUB_AGENT_MEMORY_MAX_CHARS = 1500;


// P1：按子 Agent 角色模板化注入记忆（降低噪声，提升角色对齐）
const ROLE_MEMORY_TEMPLATES: Record<
  string,
  { l1Sections: string[]; l2Sections: string[]; budgetChars: number }
> = {
  copywriter: { l1Sections: ["用户画像", "决策偏好"], l2Sections: ["重要约定"], budgetChars: 1200 },
  seo_specialist: { l1Sections: ["决策偏好"], l2Sections: ["项目决策", "重要约定"], budgetChars: 1500 },
  topic_planner: { l1Sections: ["用户画像"], l2Sections: ["项目概况", "项目决策"], budgetChars: 1500 },
  _default: { l1Sections: ["用户画像", "决策偏好"], l2Sections: ["项目决策", "重要约定"], budgetChars: 1500 },
};

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

function parseJsonObjectFromFreeText(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ? String(fenced[1]).trim() : text;
  if (!(candidate.startsWith("{") && candidate.endsWith("}"))) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function hasNonEmptyStringField(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return typeof v === "string" && v.trim().length > 0;
}

function stableStringify(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value ?? "");
  }
}

function inferApiType(endpoint?: string): ModelApiType {
  const ep = String(endpoint ?? "").trim().toLowerCase();
  if (ep.endsWith("/messages") || ep === "/messages") return "anthropic-messages";
  if (isGeminiLikeEndpoint(ep)) return "gemini";
  if (ep.endsWith("/responses") || ep === "/responses") return "openai-responses";
  return "openai-completions";
}

function toOpenAiCompatToolDefs(args: { allowed: Set<string>; mode: "agent" | "chat"; mcpTools: any[] }): OpenAiCompatTool[] {
  const builtins = TOOL_LIST.filter((tool) => {
    if (!args.allowed.has(tool.name)) return false;
    if (!tool.modes || tool.modes.length === 0) return true;
    return tool.modes.includes(args.mode);
  }).map((tool) => ({
    name: encodeToolName(tool.name),
    description: String(tool.description ?? ""),
    inputSchema: normalizeToolParametersSchema(tool.inputSchema),
  }));

  const mcpDefs = (Array.isArray(args.mcpTools) ? args.mcpTools : [])
    .filter((t: any) => args.allowed.has(String(t?.name ?? "").trim()))
    .map((t: any) => ({
      name: encodeToolName(String(t?.name ?? "")),
      description: String(t?.description ?? ""),
      inputSchema: normalizeToolParametersSchema(t?.inputSchema),
    }));

  return [...builtins, ...mcpDefs].filter((t) => String(t.name ?? "").trim().length > 0);
}

function coerceToolArgByType(value: unknown, type: string | undefined): unknown {
  const expected = String(type ?? "").trim().toLowerCase();
  if (!expected) return value;

  if (expected === "array") {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const s = value.trim();
      if (!s) return [];
      if (s.startsWith("[") && s.endsWith("]")) {
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // ignore
        }
      }
      return [value];
    }
    return [value];
  }

  if (expected === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return value;
  }

  if (expected === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const s = value.trim().toLowerCase();
      if (s === "true") return true;
      if (s === "false") return false;
    }
    return value;
  }

  if (expected === "object") {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string") {
      const s = value.trim();
      if (!s) return {};
      if (s.startsWith("{") && s.endsWith("}")) {
        try {
          const parsed = JSON.parse(s);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // ignore
        }
      }
    }
    return value;
  }

  return value;
}

function normalizeToolCallForValidation(nameRaw: string, argsRaw: Record<string, unknown>): {
  name: string;
  args: Record<string, unknown>;
  sanitized: boolean;
} {
  const name = decodeToolName(String(nameRaw ?? "").trim());
  const meta = TOOL_LIST.find((t) => t.name === name);
  const baseArgs = argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw) ? argsRaw : {};
  if (!meta) return { name, args: baseArgs, sanitized: false };

  const metaArgs = Array.isArray(meta.args) ? meta.args : [];
  if (metaArgs.length === 0) {
    return {
      name,
      args: {},
      sanitized: Object.keys(baseArgs).length > 0,
    };
  }

  const normalizedInput: Record<string, unknown> = { ...baseArgs };
  if (name === "project.search" && normalizedInput.path !== undefined && normalizedInput.paths === undefined) {
    normalizedInput.paths = Array.isArray(normalizedInput.path) ? normalizedInput.path : [normalizedInput.path];
  }

  const allowed = new Map(metaArgs.map((a) => [String(a.name), String(a.type ?? "string").toLowerCase()]));
  const sanitizedArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalizedInput)) {
    if (!allowed.has(k)) continue;
    sanitizedArgs[k] = coerceToolArgByType(v, allowed.get(k));
  }
  const sanitized = Object.keys(sanitizedArgs).length !== Object.keys(baseArgs).length;
  return { name, args: sanitizedArgs, sanitized };
}


function clampIntLocal(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 合并工具 → Desktop 原名翻译表。
 * LLM 看到一个合并工具（如 agent.config），Desktop 仍处理原名（如 agent.config.create）。
 */
const MERGED_TOOL_MAP: Record<string, Record<string, string>> = {
  "agent.config": {
    list: "agent.config.list",
    create: "agent.config.create",
    update: "agent.config.update",
    remove: "agent.config.remove",
  },
  "doc.snapshot": {
    create: "doc.commitSnapshot",
    list: "doc.listSnapshots",
    restore: "doc.restoreSnapshot",
  },
  "memory": {
    read: "memory.read",
    update: "memory.update",
  },
};

function expandMergedToolName(name: string, args: Record<string, unknown>): string {
  const map = MERGED_TOOL_MAP[name];
  if (!map) return name;
  const action = String(args?.action ?? "").trim().toLowerCase();
  return map[action] ?? name;
}

function stripActionField(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _, ...rest } = args;
  return rest;
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

// ── 子 Agent MCP 作用域：按角色能力匹配 ──

/** 从子 agent 的内置工具列表推导出所需能力集 */
function inferAgentNeededCapabilities(toolNames: Iterable<string>): Set<string> {
  const needed = new Set<string>();
  for (const rawName of toolNames) {
    const name = String(rawName ?? "").trim();
    if (!name || name === "agent.delegate") continue;
    const meta = TOOL_LIST.find((t) => t.name === name);
    const caps = inferCapabilities(name, String(meta?.description ?? ""), "builtin");
    for (const cap of caps) {
      if (cap === "generic" || cap === "mcp" || cap === "delegate") continue;
      needed.add(cap);
    }
  }
  return needed;
}

/** 判断 MCP 工具是否与子 agent 的能力需求匹配 */
function isMcpToolRelevantForAgent(mcpTool: any, agentNeededCaps: Set<string>): boolean {
  if (agentNeededCaps.size === 0) return false;
  const name = String(mcpTool?.name ?? "").trim();
  if (!name) return false;
  const description = String(mcpTool?.description ?? "");
  const mcpCaps = inferCapabilities(name, description, "mcp");
  return mcpCaps.some((cap) => agentNeededCaps.has(cap));
}

/** 根据实际 allowedToolNames 动态生成子 agent 的工具清单文本 */
function buildDynamicToolList(args: {
  allowedToolNames: Set<string>;
  mcpTools: any[];
}): string {
  const lines: string[] = [];
  // 内置工具
  for (const tool of TOOL_LIST) {
    if (!args.allowedToolNames.has(tool.name)) continue;
    const desc = String(tool.description ?? "").split("\n")[0].trim();
    lines.push(`- ${tool.name}：${desc || "(…)"}`);
  }
  // MCP 工具
  const mcpSeen = new Set<string>();
  for (const t of Array.isArray(args.mcpTools) ? args.mcpTools : []) {
    const name = String(t?.name ?? "").trim();
    if (!name || !args.allowedToolNames.has(name) || mcpSeen.has(name)) continue;
    mcpSeen.add(name);
    const rawDesc = String(t?.description ?? "").split("\n")[0].trim();
    lines.push(`- ${name}：${rawDesc ? `[MCP] ${rawDesc}` : "[MCP]"}`);
  }
  return lines.length > 0 ? lines.join("\n") : "- （无可用工具）";
}

/** 替换子 agent systemPrompt 中硬编码的工具清单部分 */
function replaceHardcodedToolList(prompt: string, dynamicToolList: string): string {
  // 匹配 "可用工具（仅此列表...）：\n" 到 "规则：/标准执行流程：/..." 之间的内容
  const sectionRe = /(可用工具（仅此列表[^）]*）[：:]\s*\n)([\s\S]*?)(\n(?:规则：|标准执行流程：|执行流程：|注意：))/;
  if (!sectionRe.test(prompt)) return prompt;
  return prompt.replace(
    sectionRe,
    (_m, header: string, _oldBody: string, tail: string) => `${header}${dynamicToolList}\n${tail}`,
  );
}

/** 从 Markdown 文档中按 heading 标题筛选 section。
 *  allowedTitles 中的标题经标准化后匹配（去装饰符号和编号）。
 *  未找到任何匹配 section 时返回空字符串。 */
function pickMarkdownSections(raw: unknown, allowedTitles: string[]): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const normalizeTitle = (t: string) =>
    t.replace(/[`*_~]/g, "").replace(/[：:]+$/g, "").replace(/^\d+[.)、\s-]*/g, "").trim();
  const allowed = new Set(allowedTitles.map(normalizeTitle).filter(Boolean));
  if (allowed.size === 0) return "";

  const lines = text.split(/\r?\n/g);
  let currentTitle = "";
  let currentBlock: string[] = [];
  const pickedBlocks: string[] = [];

  const flush = () => {
    if (currentBlock.length === 0) return;
    if (allowed.has(normalizeTitle(currentTitle))) {
      const blockText = currentBlock.join("\n").trim();
      if (blockText) pickedBlocks.push(blockText);
    }
    currentBlock = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentTitle = String(m[1] ?? "").trim();
      currentBlock = [line];
      continue;
    }
    if (currentBlock.length > 0) currentBlock.push(line);
  }
  flush();

  return pickedBlocks.join("\n\n").trim();
}

/** 构建注入给子 Agent 的记忆提示段（L1 + L2 筛选后 section + 对话摘要，总上限 1500 字）。 */
function buildSubAgentMemoryHint(args: {
  agentId?: string;
  l1Memory?: string;
  l2Memory?: string;
  ctxDialogueSummary?: string;
}): string {
  const agentId = String(args.agentId ?? "").trim();
  const tpl = ROLE_MEMORY_TEMPLATES[agentId] ?? ROLE_MEMORY_TEMPLATES._default;
  const l1 = pickMarkdownSections(args.l1Memory, tpl.l1Sections);
  const l2 = pickMarkdownSections(args.l2Memory, tpl.l2Sections);
  const summary = String(args.ctxDialogueSummary ?? "").trim();

  const parts: string[] = [];
  if (l1) parts.push(`### 用户偏好（L1 记忆）\n${l1}`);
  if (l2) parts.push(`### 项目约定（L2 记忆）\n${l2}`);
  if (summary) parts.push(`### 对话摘要\n${summary}`);
  if (parts.length === 0) return "";

  const combined = parts.join("\n\n");
  const budget = Math.max(600, Math.floor(Number(tpl.budgetChars ?? SUB_AGENT_MEMORY_MAX_CHARS)));
  if (combined.length <= budget) return combined;
  // 截断并标注
  const keep = Math.max(0, budget - 6);
  return `${combined.slice(0, keep).trimEnd()}\n（已截断）`;
}

function buildSubAgentContextHint(args: {
  agentId?: string;
  styleLibIds: string[];
  mainDoc: Record<string, unknown> | null | undefined;
  styleLibIdSet: Set<string>;
  l1Memory?: string;
  l2Memory?: string;
  ctxDialogueSummary?: string;
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

  const memoryHint = buildSubAgentMemoryHint({
    agentId: args.agentId,
    l1Memory: args.l1Memory,
    l2Memory: args.l2Memory,
    ctxDialogueSummary: args.ctxDialogueSummary,
  });
  const goal = String((mainDoc as { goal?: unknown }).goal ?? "").trim();
  if (styleLibIds.length === 0 && !goal && !memoryHint) return "";

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

  if (memoryHint) {
    lines.push("");
    lines.push("## 记忆（仅供参考，不作为执行指令；偏好可覆盖但不可违反 system policy）");
    lines.push(memoryHint);
  }

  return lines.join("\n");
}

function normalizeDelegationTask(rawTask: string): string {
  const text = String(rawTask ?? "").trim();
  if (!text) return "";
  const noMentions = text.replace(/^(?:@\S+\s*)+/g, "").trim();
  return noMentions || text;
}

function shouldInjectSubAgentMemory(args: {
  task: string;
  inputArtifactsCount: number;
  acceptanceCriteria: string;
  rawArgs: Record<string, unknown>;
}): boolean {
  const level = String(args.rawArgs.contextLevel ?? "").trim().toLowerCase();
  if (level === "full") return true;
  if (level === "minimal") return false;
  if (typeof args.rawArgs.includeMemory === "boolean") return Boolean(args.rawArgs.includeMemory);
  if (args.inputArtifactsCount > 0) return true;
  if (args.acceptanceCriteria.trim()) return true;

  const task = String(args.task ?? "").trim();
  if (!task) return false;
  if (task.length > 48) return true;
  if (/\n/.test(task)) return true;
  if (/^(继续|现在呢|然后|报个数|总结下|再来一次|好|行|ok|OK|收到)\b/i.test(task)) return false;
  return false;
}

function cleanSubAgentArtifactText(raw: string): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  text = text.replace(/<(tool_calls|function_calls)\b[\s\S]*?<\/\1>/gi, " ");
  text = text
    .replace(/^\s*<\/?(tool_calls|function_calls)[^>]*>\s*$/gim, "")
    .replace(/^\s*<\/?(tool_call|invoke)[^>]*>\s*$/gim, "")
    .replace(/^\s*<\/?(arg|parameter)[^>]*>\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "";
  const paragraphs = text.split(/\n{2,}/g).map((x) => x.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return text;
  const deduped: string[] = [];
  for (const p of paragraphs) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === p) continue;
    deduped.push(p);
  }
  return deduped.join("\n\n").trim();
}

function extractLastAssistantText(messages: AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      const text = cleanSubAgentArtifactText(msg.content);
      if (text) return text;
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (let j = (msg.content as any[]).length - 1; j >= 0; j -= 1) {
      const block = (msg.content as any[])[j];
      if (block.type !== "text") continue;
      const text = cleanSubAgentArtifactText(String(block.text ?? ""));
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

export class AgentRunner {
  private readonly ctx: RunContext;
  private readonly history: CanonicalHistoryEntry[] = [];
  private readonly runState: RunState;
  private turn = 0;
  private readonly maxTurns: number;

  // ---- 端点能力标记（Phase B）----
  private readonly apiType: ModelApiType;
  /** 是否为 Anthropic Messages API */
  private readonly isAnthropicApi: boolean;
  /** 端点是否支持 Anthropic 结构化 tool_use（content block 级别） */
  private readonly supportsNativeToolUse: boolean;
  /** 端点是否支持 OpenAI function calling（tools 参数） */
  private readonly supportsNativeFunctionCalling: boolean;
  /** OpenAI Responses native continuation：上一轮 response_id */
  private responsesPreviousResponseId: string | null = null;
  /** OpenAI Responses native continuation：已经提交给上游的消息计数 */
  private responsesHistoryCount = 0;
  /** 是否以 XML 工具协议为主协议（Gemini 或无原生工具支持的端点） */
  private readonly preferXmlProtocol: boolean;
  /** 端点是否真正尊重 tool_choice: any/tool（Anthropic 支持，GPT 代理多数会剥离） */
  private readonly supportsForcedToolChoice: boolean;
  /** Provider 能力快照（P0：统一 provider-native / fallback 判定） */
  private readonly providerCapabilities: ProviderCapabilitySnapshot;
  /** Phase D: 统一 turn 适配器 */
  private readonly turnAdapter: TurnAdapter;
  private consecutiveMainDocOnlyTurns = 0;
  private blockMainDocUpdate = false;
  private turnAllowedToolNames: Set<string> | null = null;
  private readonly failedToolDigests: ToolFailureDigest[] = [];
  private executionNoToolTurns = 0;
  private deliverabilityNoWriteTurns = 0;
  private hasDeliveryWriteAttempt = false;
  private orchestratorTextRetries = 0;
  private totalToolCalls = 0;
  private forcedToolChoice: ForcedToolChoice | null = null;
  private readonly turnEngine = new TurnEngine();
  private readonly recentToolAttempts: ToolAttemptSnapshot[] = [];

  private _deliveryContract(): DeliveryContract {
    const dc = this.ctx.deliveryContract && typeof this.ctx.deliveryContract === "object"
      ? (this.ctx.deliveryContract as DeliveryContract)
      : null;
    if (!dc || typeof dc.required !== "boolean") return { required: false, kind: "none" };
    return {
      required: Boolean(dc.required),
      kind: (dc.kind ?? "unknown"),
      recommendedPath: typeof dc.recommendedPath === "string" ? dc.recommendedPath : undefined,
      preferredWriteToolNames: Array.isArray(dc.preferredWriteToolNames)
        ? dc.preferredWriteToolNames.map((x) => String(x ?? "").trim()).filter(Boolean)
        : undefined,
    };
  }

  private _deliveredArtifactFamilies(): string[] {
    return Array.isArray(this.runState.deliveredArtifactFamilies)
      ? this.runState.deliveredArtifactFamilies.filter(Boolean)
      : [];
  }

  private _hasAnyDeliveredArtifact(): boolean {
    return this._deliveredArtifactFamilies().length > 0;
  }

  private _hasSatisfiedDeliveryContract(dc: DeliveryContract): boolean {
    if (!dc.required) return true;
    const families = this._deliveredArtifactFamilies();
    if (families.length <= 0) return false;

    const recFamily = dc.recommendedPath ? this._normalizeArtifactFamily(dc.recommendedPath) : null;
    if (recFamily) return families.includes(recFamily);

    // 没有明确推荐路径时：只要有任何一次可审计写入即可视为满足（保底）。
    return true;
  }

  private _projectDirAvailable(): boolean {
    const sidecar: any = this.ctx.toolSidecar ?? null;
    const dir = typeof sidecar?.ideSummary?.projectDir === "string" ? String(sidecar.ideSummary.projectDir).trim() : "";
    return Boolean(dir);
  }

  private _pickPreferredWriteToolName(dc: DeliveryContract, allowed: Set<string>): string | null {
    const candidates = Array.isArray(dc.preferredWriteToolNames) && dc.preferredWriteToolNames.length > 0
      ? dc.preferredWriteToolNames
      : ["doc.write", "doc.applyEdits", "code.exec"];
    for (const name of candidates) {
      const n = String(name ?? "").trim();
      if (n && allowed.has(n)) return n;
    }
    return null;
  }

  private _looksLikeClarifyQuestion(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (t.length > 260) return false;
    return /(请问|是否|要不要|需要.*确认|你希望|您希望|选哪个|选哪种|哪个更|更偏好|需要我.*吗)[?？]?$/.test(t);
  }

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
    // 兼容旧 runState 无 delegationCounts 字段
    if (!this.runState.delegationCounts || typeof this.runState.delegationCounts !== "object" || Array.isArray(this.runState.delegationCounts)) {
      this.runState.delegationCounts = {};
    }
    if (!Array.isArray(this.runState.deliveredArtifactFamilies)) {
      this.runState.deliveredArtifactFamilies = [];
    }
    this.hasDeliveryWriteAttempt = this._hasAnyDeliveredArtifact();
    if (typeof this.runState.deliveryLatched !== "boolean") {
      this.runState.deliveryLatched = false;
    }
    if (!Array.isArray(this.runState.sideEffectLedger)) {
      this.runState.sideEffectLedger = [];
    }
    if (this.runState.todoGateSatisfiedAtTurn === undefined) {
      this.runState.todoGateSatisfiedAtTurn = null;
    }
    if (this.runState.deliveryLatchActivatedAtTurn === undefined) {
      this.runState.deliveryLatchActivatedAtTurn = null;
    }
    if (this.runState.toolLoopGuardReason === undefined) {
      this.runState.toolLoopGuardReason = null;
    }

    // 端点能力推导
    this.apiType = ctx.apiType ?? inferApiType(ctx.endpoint);
    this.providerCapabilities = deriveProviderCapabilities({
      apiType: this.apiType,
      baseUrl: ctx.baseUrl,
      endpoint: ctx.endpoint,
    });
    this.isAnthropicApi = this.providerCapabilities.apiType === "anthropic-messages";
    this.supportsNativeToolUse = this.providerCapabilities.supportsNativeToolUse;
    this.supportsNativeFunctionCalling = this.providerCapabilities.supportsNativeFunctionCalling;
    this.preferXmlProtocol = this.providerCapabilities.preferXmlProtocol;
    this.supportsForcedToolChoice = this.providerCapabilities.supportsForcedToolChoice;
    this.turnAdapter = this._createTurnAdapter();
  }

  // ---------------------------------------------------------------------------
  // Phase C: 统一消息写入
  // ---------------------------------------------------------------------------
  private _pushHistory(entry: CanonicalHistoryEntry): void {
    this.history.push(entry);
    if (this._assistantEntryHasVisibleText(entry)) {
      this._activateDeliveryLatch("assistant_text");
    }
  }
  private _assistantEntryHasVisibleText(entry: CanonicalHistoryEntry): boolean {
    if (entry.role !== "assistant") return false;
    for (const block of entry.blocks) {
      if (block.type !== "text") continue;
      const sanitized = sanitizeAssistantUserFacingText(block.text, {
        dropPureJsonPayload: true,
      });
      if (sanitized.text && sanitized.text.trim()) return true;
    }
    return false;
  }

  private _activateDeliveryLatch(reason: "assistant_text" | "run_done"): void {
    if (this.runState.deliveryLatched) return;
    const families = Array.isArray(this.runState.deliveredArtifactFamilies)
      ? this.runState.deliveredArtifactFamilies.filter(Boolean)
      : [];
    if (families.length <= 0) return;
    this.runState.deliveryLatched = true;
    if (this.runState.deliveryLatchActivatedAtTurn == null) {
      this.runState.deliveryLatchActivatedAtTurn = this.turn;
    }
    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "DeliveryLatchActivated",
      message: "本轮已完成交付收口，后续相同逻辑目标将被拦截。",
      detail: {
        reason,
        deliveredArtifactFamilies: families,
        sideEffectLedgerSize: Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger.length : 0,
      },
    });
  }

  private _supportsResponsesNativeContinuation(): boolean {
    const apiType = String(this.ctx.apiType ?? "").trim().toLowerCase();
    const endpoint = String(this.ctx.endpoint ?? "").trim().toLowerCase();
    const baseUrl = String(this.ctx.baseUrl ?? "").trim().toLowerCase();
    const isResponses = apiType === "openai-responses" || endpoint.endsWith("/responses");
    const isOfficial = /(^|\.)api\.openai\.com(?:\/|$)/.test(baseUrl) || baseUrl.includes("openai.com");
    return isResponses && isOfficial;
  }

  private _extractResponsesResponseId(events: Array<any>): string | null {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const responseId = String(event?.responseId ?? event?.raw?.response?.id ?? event?.raw?.id ?? "").trim();
      if (responseId) return responseId;
    }
    return null;
  }

  /**
   * 将 canonical history 转为 Anthropic Messages API 格式。
   * 在 _runOneTurn 和 getMessages() 中按需调用。
   */
  private _toAnthropicMessages(): AnthropicMessage[] {
    const msgs: AnthropicMessage[] = [];
    for (const entry of this.history) {
      switch (entry.role) {
        case "user": {
          const content: AnthropicMessage["content"] = entry.images?.length
            ? [
                ...entry.images.map((img): ContentBlockImage => ({
                  type: "image",
                  source: { type: "base64", media_type: img.mediaType, data: img.data },
                })),
                { type: "text", text: entry.text },
              ]
            : entry.text;
          msgs.push({ role: "user", content });
          break;
        }
        case "assistant": {
          if (entry.blocks.length > 0) {
            msgs.push({ role: "assistant", content: entry.blocks });
          }
          break;
        }
        case "tool_result": {
          const blocks: any[] = entry.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          }));
          if (entry.noteText) blocks.push({ type: "text", text: entry.noteText });
          if (blocks.length > 0) msgs.push({ role: "user", content: blocks });
          break;
        }
        case "user_hint": {
          msgs.push({ role: "user", content: entry.text });
          break;
        }
      }
    }
    return msgs;
  }

  /**
   * 将 canonical history 转为 OpenAI Chat 格式。
   * 在 _runOneTurn（Provider 路径）中按需调用。
   */
  private _toProviderMessages(): OpenAiChatMessage[] {
    const msgs: OpenAiChatMessage[] = [];
    for (const entry of this.history) {
      switch (entry.role) {
        case "user": {
          const content: OpenAiChatMessage["content"] = entry.images?.length
            ? [
                ...entry.images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.data}` },
                })),
                { type: "text" as const, text: entry.text },
              ]
            : entry.text;
          msgs.push({ role: "user", content });
          break;
        }
        case "assistant": {
          const toolUses = entry.blocks.filter(
            (b): b is ContentBlockToolUse => b.type === "tool_use",
          );
          if (toolUses.length > 0) {
            msgs.push({
              role: "assistant",
              content: buildToolCallsXml(
                toolUses.map((t) => ({
                  name: String(t.name ?? ""),
                  args: t.input && typeof t.input === "object"
                    ? (t.input as Record<string, unknown>)
                    : {},
                })),
              ),
            });
          } else if (entry.rawStreamText !== undefined) {
            msgs.push({ role: "assistant", content: entry.rawStreamText });
          } else {
            const text = entry.blocks
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
            if (text) msgs.push({ role: "assistant", content: text });
          }
          break;
        }
        case "tool_result": {
          const xmlParts = entry.results.map(
            (r) => `<tool_result name="${xmlEscapeAttr(r.toolName)}"><![CDATA[${xmlCdataSafe(r.content)}]]></tool_result>`,
          );
          const textParts = entry.results.map(
            (r) => `[tool_result name="${r.toolName}"]\n${r.content}\n[/tool_result]`,
          );
          if (xmlParts.length > 0) {
            msgs.push(
              ...buildInjectedToolResultMessages({
                toolResultFormat: this.ctx.toolResultFormat === "text" ? "text" : "xml",
                toolResultXml: xmlParts.join("\n"),
                toolResultText: textParts.join("\n"),
                preferNativeToolCall: this.supportsNativeFunctionCalling,
                nativeContinuationActive: this._supportsResponsesNativeContinuation() && Boolean(this.responsesPreviousResponseId),
              }),
            );
          }
          if (entry.noteText) msgs.push({ role: "user", content: entry.noteText });
          break;
        }
        case "user_hint": {
          msgs.push({ role: "user", content: entry.text });
          break;
        }
      }
    }
    return msgs;
  }

  // ---------------------------------------------------------------------------
  // Phase D: TurnAdapter 工厂
  // ---------------------------------------------------------------------------

  private _createTurnAdapter(): TurnAdapter {
    if (this.supportsNativeToolUse) {
      return this._createAnthropicAdapter();
    }
    return this._createProviderAdapter();
  }

  /** Anthropic Messages API 适配器 */
  private _createAnthropicAdapter(): TurnAdapter {
    return {
      retryPolicy: { maxRetries: 3, baseDelayMs: 800, jitterMs: 200 },
      detectsProtocolViolation: false,

      buildToolDefs: (effectiveAllowed) => {
        const tools = TOOL_LIST.filter((tool) => {
          if (!effectiveAllowed.has(tool.name)) return false;
          if (!tool.modes || tool.modes.length === 0) return true;
          return tool.modes.includes(this.ctx.mode);
        }).map(toolMetaToAnthropicDef);

        const mcpToolDefs = ((this.ctx as any).mcpTools ?? [])
          .filter((t: any) => effectiveAllowed.has(t.name))
          .map((t: any) => ({
            name: encodeToolName(String(t.name ?? "")),
            description: String(t.description ?? ""),
            input_schema: normalizeToolParametersSchema(t?.inputSchema),
          }));
        tools.push(...mcpToolDefs);

        const toolNameSet = new Set(
          tools.map((t: any) => String(t?.name ?? "").trim()).filter(Boolean),
        );
        return { defs: tools, toolNameSet };
      },

      consumeStream: async (args) => {
        const pendingToolUses = new Map<string, PendingToolUse>();
        const completedToolUses: ContentBlockToolUse[] = [];
        let displayText = "";
        let streamErrored = false;
        let lastStreamError = "";
        let promptTokens = 0;
        let completionTokens = 0;

        const stream = streamAnthropicMessages({
          apiKey: this.ctx.apiKey,
          model: this.ctx.modelId,
          baseUrl: this.ctx.baseUrl,
          system: args.turnSystemPrompt,
          messages: this._toAnthropicMessages(),
          tools: args.toolDefs as any,
          tool_choice: args.turnToolChoice,
          signal: args.signal,
        });

        for await (const ev of stream) {
          if (args.signal.aborted) break;
          this._handleStreamEvent(ev, {
            pendingToolUses,
            completedToolUses,
            emitTextDelta: args.emitTextDelta,
            onTextDelta: (delta) => { displayText += delta; },
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

        return {
          displayText,
          rawStreamText: undefined,
          completedToolUses,
          streamErrored,
          lastStreamError,
          promptTokens,
          completionTokens,
          hasToolCallMarker: false,
          wrapperCount: 0,
          presetResults: new Map(),
        };
      },

      hasContent: (result) =>
        result.displayText.length > 0 || result.completedToolUses.length > 0,

      getAutoRetryText: (result) => result.displayText,

      buildHistoryEntry: (args) => {
        const blocks: Array<{ type: "text"; text: string } | ContentBlockToolUse> = [];
        if (args.result.displayText && !args.suppressText) {
          blocks.push({ type: "text", text: args.result.displayText });
        }
        if (args.result.completedToolUses.length > 0) {
          blocks.push(...args.result.completedToolUses);
        }
        return {
          entry: { role: "assistant" as const, blocks },
          shouldPush: blocks.length > 0,
        };
      },
    };
  }

  /** OpenAI/Gemini Provider 适配器 */
  private _createProviderAdapter(): TurnAdapter {
    return {
      retryPolicy: { maxRetries: 2, baseDelayMs: 600, jitterMs: 180 },
      detectsProtocolViolation: true,

      buildToolDefs: (effectiveAllowed) => {
        const nativeTools = toOpenAiCompatToolDefs({
          allowed: effectiveAllowed,
          mode: this.ctx.mode,
          mcpTools: ((this.ctx as any).mcpTools ?? []) as any[],
        });
        const toolNameSet = new Set(
          nativeTools.map((t) => String(t?.name ?? "").trim()).filter(Boolean),
        );
        return { defs: nativeTools, toolNameSet };
      },

      consumeStream: async (args) => {
        const endpoint = this.ctx.endpoint || "/v1/responses";
        const providerAdapter = getAdapterByEndpoint(endpoint);
        const nativeTools = args.toolDefs as OpenAiCompatTool[];
        const hasNativeTools = nativeTools.length > 0;

        // 系统消息构建
        const systemMessages: OpenAiChatMessage[] = [
          { role: "system", content: args.turnSystemPrompt },
        ];
        if (hasNativeTools) {
          const xmlToolPrompt = this._buildXmlToolProtocolPrompt(args.effectiveAllowed);
          systemMessages.push({
            role: "system",
            content:
              "工具调用说明：请优先使用 function/tool calling 进行工具调用。\n" +
              "如果 function calling 不可用，可退而使用下方 XML 格式调用工具。\n" +
              "收敛规则：任务完成后必须调用 run.done（可带 note），不要继续空转。\n" +
              "上一轮同名同参工具调用已成功时，禁止重复调用；应改为下一步或 run.done。\n" +
              "当不需要工具时，直接输出 Markdown。\n\n" +
              xmlToolPrompt,
          });
        } else {
          const xmlToolPrompt = this._buildXmlToolProtocolPrompt(args.effectiveAllowed);
          systemMessages.push({ role: "system", content: xmlToolPrompt });
        }

        let assistantRaw = "";
        let plainText = "";
        let wrapperCount = 0;
        let hasToolCallMarker = false;
        const parsedCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        let streamErrored = false;
        let lastStreamError = "";
        let promptTokens = 0;
        let completionTokens = 0;

        const providerMessages = [...systemMessages, ...this._toProviderMessages()];
        const useResponsesNativeContinuation = this._supportsResponsesNativeContinuation() && Boolean(this.responsesPreviousResponseId);
        const incrementalStart = Math.max(0, Math.min(this.responsesHistoryCount, providerMessages.length));
        const turnMessages = useResponsesNativeContinuation
          ? providerMessages.slice(incrementalStart)
          : providerMessages;
        const stream = providerAdapter.streamTurn({
          baseUrl: String(this.ctx.baseUrl ?? ""),
          endpoint,
          apiKey: this.ctx.apiKey,
          model: this.ctx.modelId,
          messages: turnMessages.length > 0 ? turnMessages : providerMessages.slice(-1),
          temperature: undefined,
          maxTokens: undefined,
          includeUsage: true,
          tools: hasNativeTools ? nativeTools : undefined,
          toolChoice: args.turnToolChoice,
          parallelToolCalls: false,
          previousResponseId: useResponsesNativeContinuation ? this.responsesPreviousResponseId : undefined,
          signal: args.signal,
        });

        const rawEvents: Array<any> = [];
        for await (const ev of stream) {
          if (args.signal.aborted) break;
          rawEvents.push(ev);
        }

        const latestResponsesResponseId = this._extractResponsesResponseId(rawEvents);
        if (latestResponsesResponseId) {
          this.responsesPreviousResponseId = latestResponsesResponseId;
          this.responsesHistoryCount = providerMessages.length;
        }

        const canonicalEvents = providerAdapter.toCanonicalEvents(rawEvents);
        for (const ev of canonicalEvents) {
          if (ev.type === "usage") {
            promptTokens = Math.max(promptTokens, Math.max(0, Math.floor(Number(ev.promptTokens ?? 0))));
            completionTokens = Math.max(completionTokens, Math.max(0, Math.floor(Number(ev.completionTokens ?? 0))));
            continue;
          }
          if (ev.type === "error") {
            streamErrored = true;
            lastStreamError = String(ev.error ?? "UPSTREAM_ERROR");
            this.turnEngine.record({ type: "model_error", error: lastStreamError });
            break;
          }
          if (ev.type === "tool_call") {
            parsedCalls.push({
              id: String(ev.id ?? "").trim(),
              name: String(ev.name ?? "").trim(),
              args: ev.args && typeof ev.args === "object" && !Array.isArray(ev.args) ? ev.args : {},
            });
            continue;
          }
          if (ev.type === "text_delta") continue;
          if (ev.type === "done") {
            assistantRaw = String(ev.assistantRaw ?? "");
            plainText = String(ev.plainText ?? "");
            hasToolCallMarker = Boolean(ev.hasToolCallMarker);
            wrapperCount = Math.max(0, Math.floor(Number(ev.wrapperCount ?? 0)));
            if (plainText) this.turnEngine.record({ type: "model_text_delta", text: plainText });
            this.turnEngine.record({ type: "model_done", finishReason: "stream_done" });
          }
        }

        // Provider 工具调用验证 + presetResults
        const completedToolUses: ContentBlockToolUse[] = [];
        const presetResults = new Map<string, ToolExecResult>();
        for (const c of parsedCalls) {
          const rawInput = c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args : {};
          const normalized = normalizeToolCallForValidation(c.name, rawInput);
          const input = normalized.args;
          const normalizedName = normalized.name;
          const v = validateToolCallArgs({ name: normalizedName, toolArgs: input });
          if (!v.ok) {
            presetResults.set(c.id, {
              ok: false,
              output: {
                ok: false,
                error: "ERR_PARAM_SCHEMA_MISMATCH",
                message: v.error?.message ?? "工具参数不符合 schema",
                detail: v.error?.field ? { field: v.error.field } : null,
                next_actions: ["按该工具 schema 重新组织参数", "缺参时先补齐必填字段后重试"],
              },
            });
          }
          completedToolUses.push({ type: "tool_use", id: c.id, name: normalizedName, input });
          this.turnEngine.record({
            type: "model_tool_call",
            callId: String(c.id ?? ""),
            name: normalizedName,
            args: input,
          });
          this.ctx.writeEvent("tool.call.args_ready", {
            toolCallId: c.id,
            name: normalizedName,
            args: input,
            turn: this.turn,
            ...(normalized.sanitized ? { note: "args_sanitized_against_schema" } : {}),
          });
        }

        return {
          displayText: plainText,
          rawStreamText: assistantRaw,
          completedToolUses,
          streamErrored,
          lastStreamError,
          promptTokens,
          completionTokens,
          hasToolCallMarker,
          wrapperCount,
          presetResults,
        };
      },

      hasContent: (result) =>
        (result.rawStreamText ?? "").trim().length > 0,

      getAutoRetryText: (result) =>
        result.displayText || (result.rawStreamText ?? ""),

      buildHistoryEntry: (args) => {
        const blocks: Array<{ type: "text"; text: string } | ContentBlockToolUse> = [];
        if (args.result.displayText && !args.suppressText && !args.hasProtocolViolation) {
          blocks.push({ type: "text", text: args.result.displayText });
        }
        if (args.result.completedToolUses.length > 0) {
          blocks.push(...args.result.completedToolUses);
        }
        return {
          entry: {
            role: "assistant" as const,
            blocks,
            rawStreamText: args.result.rawStreamText,
          },
          shouldPush: true, // Provider 路径始终 push（即使 blocks 为空也保留 rawStreamText）
        };
      },
    };
  }

  private _getExecutionContract(): {
    required: boolean;
    minToolCalls: number;
    maxNoToolTurns: number;
    reason: string;
    preferredToolNames: string[];
  } {
    const raw = (this.ctx.executionContract ?? {}) as ExecutionContract;
    const required = Boolean(raw.required);
    const minToolCalls = required ? Math.max(1, Math.floor(Number(raw.minToolCalls ?? 1) || 1)) : 0;
    const maxNoToolTurns = required ? Math.max(1, Math.min(3, Math.floor(Number(raw.maxNoToolTurns ?? 2) || 2))) : 0;
    const reason = String(raw.reason ?? "").trim();
    const preferredToolNames = Array.isArray(raw.preferredToolNames)
      ? raw.preferredToolNames.map((n) => String(n ?? "").trim()).filter(Boolean).slice(0, 8)
      : [];
    return { required, minToolCalls, maxNoToolTurns, reason, preferredToolNames };
  }

  private _pickExecutionFallbackToolName(): string | null {
    const allowed = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
    const deterministic = [
      "run.mainDoc.get",
      "run.setTodoList",
      "run.todo",
      "run.mainDoc.update",
      "project.listFiles",
      "kb.search",
    ];
    for (const name of deterministic) {
      if (allowed.has(name)) return name;
    }
    for (const name of allowed) {
      if (!String(name ?? "").startsWith("mcp.")) return String(name);
    }
    return null;
  }


  private _isTodoToolName(name: string): boolean {
    return (
      name === "run.setTodoList" ||
      name === "run.todo" ||
      name === "run.todo.upsertMany" ||
      name === "run.todo.update" ||
      name === "run.todo.remove" ||
      name === "run.todo.clear"
    );
  }

  private _isPreTodoAllowedTool(name: string): boolean {
    return (
      this._isTodoToolName(name) ||
      name === "run.mainDoc.get" ||
      name === "run.mainDoc.update" ||
      name === "time.now"
    );
  }

  private _todoGateRequired(contract: { required: boolean }): boolean {
    const allowed = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
    return Boolean(contract.required) && !this.ctx.agentId && Boolean(this._pickTodoGateToolName(allowed));
  }

  private _pickTodoGateToolName(allowed: Set<string>): string | null {
    for (const name of ["run.setTodoList", "run.todo", "run.todo.upsertMany"]) {
      if (allowed.has(name)) return name;
    }
    return null;
  }

  private _normalizeArtifactFamily(value: unknown): string | null {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    let normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
    normalized = normalized.replace(/\.[^/.]+$/, "");
    normalized = normalized.replace(/(?:[_-]v\d+|[（(]\d+[)）])$/i, "");
    normalized = normalized.replace(/\s+/g, " ").trim();
    return normalized || null;
  }

  private _getArtifactFamily(toolUse: ContentBlockToolUse, result?: ToolExecResult): string | null {
    const input = toolUse.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
    const output = result?.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};

    const candidates: unknown[] = [
      input.path,
      input.targetDir,
      output.path,
      output.renamedFrom,
    ];

    const artifact = output.artifact;
    if (artifact && typeof artifact === "object") {
      candidates.push((artifact as Record<string, unknown>).relPath);
      candidates.push((artifact as Record<string, unknown>).absPath);
    }

    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    for (const item of artifacts.slice(0, 3)) {
      if (!item || typeof item !== "object") continue;
      candidates.push((item as Record<string, unknown>).relPath);
      candidates.push((item as Record<string, unknown>).absPath);
    }

    for (const candidate of candidates) {
      const family = this._normalizeArtifactFamily(candidate);
      if (family) return family;
    }
    return null;
  }

  private _isDeliveryCandidateTool(name: string): boolean {
    return isContentWriteTool(name) || name === "doc.snapshot" || name === "code.exec";
  }

  private _recordDeliveredArtifact(toolUse: ContentBlockToolUse, result: ToolExecResult): void {
    const family = this._getArtifactFamily(toolUse, result);
    if (!family) return;
    const families = Array.isArray(this.runState.deliveredArtifactFamilies)
      ? this.runState.deliveredArtifactFamilies
      : [];
    if (!families.includes(family)) families.push(family);
    this.runState.deliveredArtifactFamilies = families;
    const outputObj = result.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
    const record = {
      semanticKind: "artifact_write",
      toolName: String(toolUse.name ?? ""),
      logicalTarget: family,
      argsFingerprint: stableStringify(toolUse.input ?? {}).slice(0, 200),
      resultFingerprint: stableStringify(result.output ?? {}).slice(0, 200),
      contentFingerprint: typeof outputObj.path === "string" ? String(outputObj.path) : family,
      ts: Date.now(),
    };
    const ledger = Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger : [];
    this.runState.sideEffectLedger = [...ledger, record as any].slice(-20);
  }

  private _isDeliveryLatchedFor(toolUse: ContentBlockToolUse): boolean {
    if (!this.runState.deliveryLatched) return false;
    if (!this._isDeliveryCandidateTool(toolUse.name)) return false;
    const family = this._getArtifactFamily(toolUse);
    if (!family) return false;
    return (this.runState.deliveredArtifactFamilies ?? []).includes(family);
  }

  private _resolveTurnToolChoice(availableToolNames: Set<string>) {
    if (availableToolNames.size <= 0) return undefined;

    if (this.forcedToolChoice) {
      if (this.forcedToolChoice.type === "any") return { type: "any" as const };
      const encoded = encodeToolName(String(this.forcedToolChoice.name ?? "").trim());
      if (encoded && availableToolNames.has(encoded)) return { type: "tool" as const, name: encoded };
      return { type: "any" as const };
    }

    if (this.turn === 1 && this.ctx.toolChoiceFirstTurn) {
      if (this.ctx.toolChoiceFirstTurn.type === "tool") {
        const encoded = encodeToolName(String(this.ctx.toolChoiceFirstTurn.name ?? "").trim());
        if (encoded && availableToolNames.has(encoded)) return { type: "tool" as const, name: encoded };
        return { type: "any" as const };
      }
      return this.ctx.toolChoiceFirstTurn;
    }

    return undefined;
  }

  private _findAllowedMcpToolName(pattern: RegExp): string | null {
    const allowed = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
    const mcpTools = Array.isArray((this.ctx as any).mcpTools) ? ((this.ctx as any).mcpTools as any[]) : [];
    for (const t of mcpTools) {
      const name = String(t?.name ?? "").trim();
      if (!name || !allowed.has(name)) continue;
      if (pattern.test(name)) return name;
    }
    return null;
  }

  private _mcpRequiredArgsSatisfied(toolName: string, args: Record<string, unknown>): boolean {
    const mcpTools = Array.isArray((this.ctx as any).mcpTools) ? ((this.ctx as any).mcpTools as any[]) : [];
    const meta = mcpTools.find((t) => String(t?.name ?? "").trim() === toolName);
    const required = Array.isArray(meta?.inputSchema?.required)
      ? (meta.inputSchema.required as any[]).map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    for (const k of required) {
      const v = (args as Record<string, unknown>)[k];
      if (typeof v === "string") {
        if (!v.trim()) return false;
        continue;
      }
      if (v === undefined || v === null) return false;
    }
    return true;
  }

  private _pickFallbackMcpToolName(parsed: Record<string, unknown>, preferredName: string): string | null {
    const hasUrl = hasNonEmptyStringField(parsed, "url");
    const hasRef = hasNonEmptyStringField(parsed, "ref");
    const hasElement = hasNonEmptyStringField(parsed, "element");
    const hasText = hasNonEmptyStringField(parsed, "text");
    const hasNoteOnly =
      Object.keys(parsed).every((k) => ["note", "message", "status"].includes(String(k).trim())) &&
      Object.keys(parsed).length > 0;
    if (hasNoteOnly) return null;

    if (hasUrl) {
      return (
        this._findAllowedMcpToolName(/(browser_navigate|navigate|open_url|openurl|goto|go_to)$/i) ||
        this._findAllowedMcpToolName(/browser|playwright|navigate|open_url|openurl|goto|go_to/i) ||
        preferredName
      );
    }
    if (hasRef || hasElement) {
      if (hasText) {
        const typeTool =
          this._findAllowedMcpToolName(/(browser_type|browser_fill|type|fill|input)/i);
        if (typeTool) return typeTool;
      }
      return this._findAllowedMcpToolName(/(browser_click|click)/i);
    }
    if (hasText) {
      return this._findAllowedMcpToolName(/(browser_type|browser_fill|type|fill|input)/i);
    }
    return null;
  }

  private _trySynthesizeToolUseFromJsonText(rawText: string): ContentBlockToolUse | null {
    const contract = this._getExecutionContract();
    if (!contract.required) return null;
    if (!this.ctx.jsonToolFallbackEnabled) return null;
    const allowed = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
    const parsed = parseJsonObjectFromFreeText(rawText);
    if (!parsed) return null;
    if (Object.keys(parsed).length === 0) return null;
    const preferredOrdered = contract.preferredToolNames
      .map((name) => String(name ?? "").trim())
      .filter((name) => name && allowed.has(name));
    const allCandidates = Array.from(allowed.values())
      .map((name) => String(name ?? "").trim())
      .filter(Boolean);
    const candidateNames = Array.from(new Set([...preferredOrdered, ...allCandidates]));

    let picked: { name: string; args: Record<string, unknown>; score: number } | null = null;
    for (let i = 0; i < candidateNames.length; i += 1) {
      const candidate = candidateNames[i];
      if (!candidate) continue;

      let toolName = candidate;
      if (candidate.startsWith("mcp.")) {
        const mcpPicked = this._pickFallbackMcpToolName(parsed, candidate);
        if (!mcpPicked) continue;
        toolName = mcpPicked;
      }

      const normalized = normalizeToolCallForValidation(toolName, parsed);
      if (!normalized.name) continue;
      const argCount = Object.keys(normalized.args ?? {}).length;
      if (argCount <= 0) continue;

      if (normalized.name.startsWith("mcp.")) {
        if (!this._mcpRequiredArgsSatisfied(normalized.name, normalized.args)) continue;
      } else {
        const v = validateToolCallArgs({ name: normalized.name, toolArgs: normalized.args });
        if (!v.ok) continue;
      }

      const meta = TOOL_LIST.find((t) => t.name === normalized.name);
      const argNames = new Set((meta?.args ?? []).map((a) => String(a?.name ?? "").trim()).filter(Boolean));
      let matchedKeys = 0;
      for (const k of Object.keys(parsed)) {
        if (argNames.has(String(k ?? "").trim())) matchedKeys += 1;
      }
      const preferredIdx = preferredOrdered.indexOf(candidate);
      const preferredBoost = preferredIdx >= 0 ? Math.max(0, 50 - preferredIdx) : 0;
      const score = preferredBoost + matchedKeys * 10 + argCount;

      if (!picked || score > picked.score) {
        picked = { name: normalized.name, args: normalized.args, score };
      }
    }
    if (!picked) return null;

    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "JsonToolFallback",
      message: `检测到参数 JSON，已按工具调用执行：${picked.name}`,
    });

    return {
      type: "tool_use",
      id: `json_fallback_${this.turn}_${Date.now()}`,
      name: picked.name,
      input: picked.args,
    };
  }

  private _recordToolAttempt(toolUse: ContentBlockToolUse, result: ToolExecResult): void {
    const argsSig = stableStringify(toolUse.input ?? {});
    const outputObj = result.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : null;
    const resultSig = result.ok
      ? `ok:${String(outputObj?.ok ?? true)}`
      : stableStringify({
          error: outputObj?.error ?? "ERR",
          message: outputObj?.message ?? outputObj?.detail ?? "",
          code: outputObj?.code ?? "",
          path: outputObj?.path ?? "",
        });
    this.recentToolAttempts.push({
      name: String(toolUse.name ?? ""),
      argsSig,
      ok: result.ok,
      resultSig: String(resultSig).slice(0, 500),
      turn: this.turn,
    });
    if (this.recentToolAttempts.length > 30) {
      this.recentToolAttempts.splice(0, this.recentToolAttempts.length - 30);
    }
  }

  private _detectToolLoopGuard(): { blocked: boolean; name?: string; reason?: string } {
    const recent = this.recentToolAttempts.slice(-6);
    if (recent.length < 4) return { blocked: false };
    const sameName = recent.every((x) => x.name === recent[0].name);
    if (!sameName) return { blocked: false };

    const failAttempts = recent.filter((x) => !x.ok);
    const failCount = failAttempts.length;
    if (failCount >= 4) {
      const firstFail = failAttempts[0];
      const sameArgsAndError = failAttempts.every((x) => x.argsSig === firstFail.argsSig && x.resultSig === firstFail.resultSig);
      if (sameArgsAndError) {
        return { blocked: true, name: recent[0].name, reason: "同一工具同参同错连续重试" };
      }
    }
    if (failCount >= 5 && recent.every((x) => !x.ok)) {
      return { blocked: true, name: recent[0].name, reason: "同一工具连续失败，未发生有效状态变化" };
    }

    const successAttempts = recent.filter((x) => x.ok);
    const successCount = successAttempts.length;
    if (successCount >= 4) {
      const firstOk = successAttempts[0];
      const sameArgsAndResult = successAttempts.every((x) => x.argsSig === firstOk.argsSig && x.resultSig === firstOk.resultSig);
      if (sameArgsAndResult) {
        return { blocked: true, name: recent[0].name, reason: "同一工具同参同结果重复执行，未推进新步骤" };
      }
    }

    return { blocked: false };
  }

  private _setOutcome(next: RunOutcome): void {
    this.turnEngine.setOutcome(next);
  }

  private _emitAssistantDeltaSafe(raw: string, opts?: { dropPureJsonPayload?: boolean }): void {
    const sanitized = sanitizeAssistantUserFacingText(raw, {
      dropPureJsonPayload: Boolean(opts?.dropPureJsonPayload),
    });
    if (sanitized.text) {
      this.ctx.writeEvent("assistant.delta", { delta: sanitized.text, turn: this.turn });
      return;
    }
    if (!String(raw ?? "").trim()) return;
    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "AssistantTextSanitized",
      message:
        sanitized.reason === "pure_json_payload"
          ? "检测到结构化 JSON 文本输出，已过滤并等待工具结果/下一步。"
          : "检测到非用户可读的系统文本，已过滤。",
    });
  }

  private _finalizeOutcomeBeforeReturn(): void {
    const snapshot = this.turnEngine.getSnapshot();
    const outcome = this.turnEngine.getOutcome();
    if (outcome.status !== "completed") return;
    if (snapshot.pendingToolCallCount <= 0) return;

    for (const pending of snapshot.pendingToolCalls.slice(0, 12)) {
      this.failedToolDigests.push({
        toolCallId: String(pending.callId ?? ""),
        name: String(pending.name ?? "unknown"),
        error: "TOOL_RESULT_MISSING",
        message: "工具调用后未收到对应 tool_result。",
        next_actions: ["检查该工具是否真正执行并回传了结果", "如为执行任务，请继续重试并完成该步骤"],
        turn: this.turn,
      });
    }
    if (this.failedToolDigests.length > 40) {
      this.failedToolDigests.splice(0, this.failedToolDigests.length - 40);
    }
    this._setOutcome({
      status: "failed",
      reason: "tool_result_unpaired",
      reasonCodes: ["tool_result_unpaired"],
      detail: {
        pendingToolCallCount: snapshot.pendingToolCallCount,
        pendingToolCalls: snapshot.pendingToolCalls,
      },
    });
    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "error",
      title: "ToolResultGuard",
      message: `检测到 ${snapshot.pendingToolCallCount} 个工具调用缺少结果，已按失败结束本轮。`,
    });
  }

  async run(userMessage: string, images?: Array<{ mediaType: string; data: string }>): Promise<void> {
    this.turnEngine.reset();
    this._setOutcome({ status: "completed", reason: "completed", reasonCodes: ["completed"] });
    this._pushHistory({ role: "user", text: userMessage, images });

    // If user @mentioned specific agents, auto-delegate before main loop
    if (this.ctx.targetAgentIds?.length) {
      await this._bootstrapTargetDelegation(userMessage);
      if (this.ctx.abortSignal.aborted) {
        this._setOutcome({ status: "aborted", reason: "aborted", reasonCodes: ["aborted"] });
      } else if (this.turnEngine.getOutcome().reason === "completed") {
        this._setOutcome({ status: "completed", reason: "delegation_completed", reasonCodes: ["delegation_completed"] });
      }
      this._finalizeOutcomeBeforeReturn();
      return;
    }

    while (this.turn < this.maxTurns) {
      if (this.ctx.abortSignal.aborted) {
        this._setOutcome({ status: "aborted", reason: "aborted", reasonCodes: ["aborted"] });
        return;
      }
      this.turn += 1;
      this.turnEngine.setTurn(this.turn);
      const shouldContinue = await this._runOneTurn();
      if (!shouldContinue) {
        if (this.ctx.abortSignal.aborted) {
          this._setOutcome({ status: "aborted", reason: "aborted", reasonCodes: ["aborted"] });
        }
        this._finalizeOutcomeBeforeReturn();
        return;
      }
    }

    this._setOutcome({
      status: "failed",
      reason: "max_turns",
      reasonCodes: ["max_turns"],
      detail: { turn: this.turn, maxTurns: this.maxTurns },
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
        this.turnEngine.setTurn(this.turn);
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
    this._pushHistory({
      role: "assistant",
      blocks: toolUses,
    });

    // Execute all delegations in parallel
    const results = await Promise.all(
      toolUses.map(async (toolUse) => {
        const result = await this._executeTool(toolUse);
        return { toolUse, result };
      }),
    );

    // Build canonical tool results and emit events
    const canonicalResults: CanonicalToolResult[] = [];
    const MAX_TOOL_RESULT_CHARS = 60_000;
    for (const { toolUse, result } of results) {
      const output = result.output;
      this._updateRunState(toolUse, { ok: result.ok, output });
      this.ctx.writeEvent("tool.result", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        output,
      });
      const outObj = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
      this.turnEngine.record({
        type: "tool_result",
        callId: String(toolUse.id ?? ""),
        name: String(toolUse.name ?? ""),
        ok: result.ok,
        output,
        error: result.ok ? undefined : String(outObj?.error ?? "UNKNOWN_ERROR"),
      });
      const rawContent = typeof output === "string" ? output : JSON.stringify(output);
      const content = rawContent.length > MAX_TOOL_RESULT_CHARS
        ? rawContent.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...[工具结果已截断，共 ${rawContent.length} 字符]`
        : rawContent;
      canonicalResults.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content,
        isError: result.ok ? undefined : true,
      });
    }

    if (canonicalResults.length > 0) {
      this._pushHistory({
        role: "tool_result",
        results: canonicalResults,
      });
    }

    // After delegation, let main agent continue normally to summarize
    while (this.turn < this.maxTurns) {
      if (this.ctx.abortSignal.aborted) return;
      this.turn += 1;
      this.turnEngine.setTurn(this.turn);
      const shouldContinue = await this._runOneTurn();
      if (!shouldContinue) return;
    }
  }

  private _buildXmlToolProtocolPrompt(allowed: Set<string>): string {
    const builtins = TOOL_LIST.filter((tool) => {
      if (!allowed.has(tool.name)) return false;
      if (!tool.modes || tool.modes.length === 0) return true;
      return tool.modes.includes(this.ctx.mode);
    });

    const lines: string[] = [];
    for (const tool of builtins) {
      const toolArgs = tool.args ?? [];
      const required = toolArgs.filter((a) => a.required);
      const optional = toolArgs.filter((a) => !a.required);
      const reqSig = required.map((a) => `${a.name}: ${a.type ?? "string"}${a.desc ? ` — ${a.desc}` : ""}`).join("; ");
      const optNames = optional.map((a) => a.name).join(", ");
      const briefDesc = (tool.description ?? "").split("\n")[0].trim();
      let line = `- ${tool.name}`;
      if (briefDesc) line += `：${briefDesc}`;
      if (reqSig) line += `\n  必填：${reqSig}`;
      if (optNames) line += `\n  可选：${optNames}`;
      if (!reqSig && !optNames) line += "()";
      lines.push(line);
    }

    const mcpToolsList = (((this.ctx as any).mcpTools ?? []) as any[]).filter(
      (t: any) => {
        const name = String(t?.name ?? "").trim();
        return name && allowed.has(name);
      },
    );
    const mcpSeen = new Set<string>();
    for (const t of mcpToolsList) {
      const name = String(t?.name ?? "").trim();
      if (mcpSeen.has(name)) continue;
      mcpSeen.add(name);
      const desc = String(t?.description ?? "").split("\n")[0].trim();
      lines.push(`- ${name}${desc ? `：${desc}` : "(...)"}`);
    }

    const toolListText = lines.length ? lines.join("\n") : "- （无可用工具）";
    return (
      "【工具调用协议（XML）】\n" +
      "优先使用模型原生工具调用（function/tool calling）；仅当上游不支持时，才输出 XML。\n" +
      "当需要调用工具时，整条回复必须只包含 XML，不得混入自然语言。\n" +
      "若调用工具，只允许一个 <tool_calls> 包裹，禁止输出多个 <tool_calls> 段。\n" +
      "禁止在 XML 前后追加解释文本（包括\u201c我将调用\u2026\u201d之类语句）。\n" +
      "格式：\n" +
      "<tool_calls>\n" +
      '  <tool_call name="tool.name">\n' +
      '    <arg name="param"><![CDATA[value_or_json]]></arg>\n' +
      "  </tool_call>\n" +
      "</tool_calls>\n" +
      "收敛规则：\n" +
      "- 任务完成后必须调用 run.done（可带 note），不要继续空转。\n" +
      "- 上一轮同名同参工具调用已成功时，禁止重复调用同一工具；应改为下一步或 run.done。\n" +
      "当不需要工具时，直接输出 Markdown。\n\n" +
      "本轮可用工具：\n" +
      `${toolListText}`
    );
  }

  private async _processCompletedToolUses(
    completedToolUses: ContentBlockToolUse[],
    opts?: { presetResults?: Map<string, ToolExecResult> },
  ): Promise<boolean> {
    const parsedToolCalls: ParsedToolCall[] = completedToolUses.map((toolUse) => ({
      name: toolUse.name,
      args: toolUse.input ?? {},
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
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: "StyleWorkflow",
        message: `工具调用顺序提示（${batch.violation}），已放行，由 LLM 自行判断。`,
      });
    }

    const canonicalResults: CanonicalToolResult[] = [];
    let hasRunDone = false;

    const delegateCalls: { index: number; toolUse: ContentBlockToolUse }[] = [];
    const regularCalls: { index: number; toolUse: ContentBlockToolUse }[] = [];
    completedToolUses.forEach((toolUse, i) => {
      if (this._isDeliveryCandidateTool(toolUse.name)) {
        this.hasDeliveryWriteAttempt = true;
        this.deliverabilityNoWriteTurns = 0;
      }
      if (toolUse.name === "agent.delegate") delegateCalls.push({ index: i, toolUse });
      else regularCalls.push({ index: i, toolUse });
    });

    const orderedResults: { index: number; toolUse: ContentBlockToolUse; result: ToolExecResult }[] = [];
    const presetResults = opts?.presetResults ?? new Map<string, ToolExecResult>();

    if (delegateCalls.length > 0) {
      const delegateResults = await Promise.all(
        delegateCalls.map(async ({ index, toolUse }) => {
          const preset = presetResults.get(toolUse.id);
          const result = preset ?? (await this._executeTool(toolUse));
          return { index, toolUse, result };
        }),
      );
      orderedResults.push(...delegateResults);
    }

    for (const { index, toolUse } of regularCalls) {
      if (this.ctx.abortSignal.aborted) break;
      const preset = presetResults.get(toolUse.id);
      const result = preset ?? (await this._executeTool(toolUse));
      orderedResults.push({ index, toolUse, result });
    }

    orderedResults.sort((a, b) => a.index - b.index);
    for (const { toolUse, result } of orderedResults) {
      this._updateRunState(toolUse, { ok: result.ok, output: result.output });
      this._recordToolAttempt(toolUse, result);

      this.ctx.writeEvent("tool.result", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        ok: result.ok,
        output: result.output,
        meta: result.meta ?? null,
        turn: this.turn,
      });
      const outObj = result.output && typeof result.output === "object"
        ? (result.output as Record<string, unknown>)
        : null;
      this.turnEngine.record({
        type: "tool_result",
        callId: String(toolUse.id ?? ""),
        name: String(toolUse.name ?? ""),
        ok: result.ok,
        output: result.output,
        error: result.ok ? undefined : String(outObj?.error ?? "UNKNOWN_ERROR"),
      });

      const MAX_TOOL_RESULT_CHARS = 60_000;
      const rawOutput = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
      const cappedOutput = rawOutput.length > MAX_TOOL_RESULT_CHARS
        ? rawOutput.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...[工具结果已截断，共 ${rawOutput.length} 字符]`
        : rawOutput;
      canonicalResults.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: cappedOutput,
        isError: result.ok ? undefined : true,
      });

      if (!result.ok) this._recordToolFailure(toolUse, result);

      if (toolUse.name === "run.done") hasRunDone = true;
    }

    let mainDocLoopWarning: string | null = null;
    const isMainDocOnlyTurn =
      orderedResults.length > 0 &&
      orderedResults.every(({ toolUse }) =>
        toolUse.name === "run.mainDoc.update" || toolUse.name === "run.mainDoc.get",
      );

    if (isMainDocOnlyTurn) this.consecutiveMainDocOnlyTurns += 1;
    else this.consecutiveMainDocOnlyTurns = 0;

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

    if (canonicalResults.length > 0) {
      this._pushHistory({
        role: "tool_result",
        results: canonicalResults,
        noteText: mainDocLoopWarning ?? undefined,
      });
    } else if (mainDocLoopWarning) {
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "MainDocLoopGuard",
        message: `[fallback] ${mainDocLoopWarning}`,
      });
    }

    if (this.ctx.abortSignal.aborted) {
      this._setOutcome({ status: "aborted", reason: "aborted", reasonCodes: ["aborted"] });
      return false;
    }
    const loopGuard = this._detectToolLoopGuard();
    if (loopGuard.blocked) {
      this.failedToolDigests.push({
        toolCallId: `tool_loop_guard_turn_${this.turn}`,
        name: loopGuard.name || "unknown",
        error: "TOOL_LOOP_DETECTED",
        message: loopGuard.reason || "检测到工具循环",
        next_actions: ["读取上一条工具结果后再决定下一步", "不要重复同一工具同参数，改为新动作或 run.done"],
        turn: this.turn,
      });
      if (this.failedToolDigests.length > 40) {
        this.failedToolDigests.splice(0, this.failedToolDigests.length - 40);
      }
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "error",
        title: "ToolLoopGuard",
        message: `检测到工具循环：${loopGuard.name || "unknown"}（${loopGuard.reason || "重复失败"}）。`,
      });
      this._setOutcome({
        status: "failed",
        reason: "tool_loop_detected",
        reasonCodes: ["tool_loop_detected"],
        detail: {
          toolName: loopGuard.name || null,
          reason: loopGuard.reason || "",
          recentAttempts: this.recentToolAttempts.slice(-6),
        },
      });
      return false;
    }
    if (hasRunDone) {
      const deliveryContract = this._deliveryContract();
      const needsArtifact = deliveryContract.required && !this._hasSatisfiedDeliveryContract(deliveryContract);
      const allowed = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
      const preferredWrite = this._pickPreferredWriteToolName(deliveryContract, allowed);
      const canAttemptWrite = this._projectDirAvailable() && Boolean(preferredWrite);

      // run.done 不能绕过文件交付契约：若还没落盘且具备写入条件，则拦截并继续下一轮。
      if (needsArtifact && canAttemptWrite) {
        this.deliverabilityNoWriteTurns += 1;
        this.forcedToolChoice = this.supportsForcedToolChoice
          ? (preferredWrite ? { type: "tool", name: preferredWrite } : { type: "any" })
          : null;
        const recPath = deliveryContract.recommendedPath ? `建议路径：${deliveryContract.recommendedPath}。` : "";
        this._pushHistory({
          role: "user_hint",
          text:
            `你调用了 run.done，但尚未真正产出交付文件。请先调用 ${preferredWrite} 写入交付文件，再 run.done 收口。${recPath}`,
        });
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "DeliverabilityContractBlockedRunDone",
          message: "检测到 run.done 早退但未满足文件交付契约，已拦截并继续下一轮。",
          detail: {
            kind: deliveryContract.kind ?? "unknown",
            recommendedPath: deliveryContract.recommendedPath ?? null,
            preferredWriteTool: preferredWrite,
            retries: this.deliverabilityNoWriteTurns,
          },
        });
        return true;
      }

      this._activateDeliveryLatch("run_done");
      this.turnEngine.record({ type: "model_done", finishReason: "run_done" });
      this._setOutcome({ status: "completed", reason: "run_done", reasonCodes: ["run_done"] });
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Phase D: 统一 turn 函数
  // ---------------------------------------------------------------------------

  private async _runOneTurn(): Promise<boolean> {
    const adapter = this.turnAdapter;

    // [1] perTurnCaps + effectiveAllowed + turnSystemPrompt
    const perTurnCaps = this.ctx.computePerTurnAllowed?.(this.runState) ?? null;
    const effectiveAllowed = perTurnCaps?.allowed ?? this.ctx.allowedToolNames;
    this.turnAllowedToolNames = effectiveAllowed;
    const orchestratorMode = perTurnCaps?.orchestratorMode === true;
    const turnSystemPrompt = perTurnCaps?.hint
      ? `${this.ctx.systemPrompt}\n\n${perTurnCaps.hint}`
      : this.ctx.systemPrompt;

    // [2] adapter.buildToolDefs
    const { defs: toolDefs, toolNameSet } = adapter.buildToolDefs(effectiveAllowed);

    // [3] _resolveTurnToolChoice
    const turnToolChoice = this._resolveTurnToolChoice(toolNameSet);

    // [4] executionContract + holdAssistantDelta
    const executionContract = this._getExecutionContract();
    const deliveryContract = this._deliveryContract();
    const needsArtifact = deliveryContract.required && !this._hasSatisfiedDeliveryContract(deliveryContract);
    const preferredWrite = this._pickPreferredWriteToolName(deliveryContract, effectiveAllowed);
    const deliveryHold = needsArtifact && this._projectDirAvailable() && Boolean(preferredWrite);
    const holdAssistantDelta =
      orchestratorMode ||
      (executionContract.required && this.totalToolCalls < executionContract.minToolCalls) ||
      deliveryHold;

    // [5] writeEvent("assistant.start")
    this.ctx.writeEvent("assistant.start", { turn: this.turn });

    // [6-8] 重试循环: adapter.consumeStream + 空响应检测 + 退避
    let result: StreamConsumeResult = {
      displayText: "",
      rawStreamText: undefined,
      completedToolUses: [],
      streamErrored: false,
      lastStreamError: "",
      promptTokens: 0,
      completionTokens: 0,
      hasToolCallMarker: false,
      wrapperCount: 0,
      presetResults: new Map(),
    };
    const { maxRetries, baseDelayMs, jitterMs } = adapter.retryPolicy;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.ctx.abortSignal.aborted) break;

      result = await adapter.consumeStream({
        toolDefs,
        turnSystemPrompt,
        effectiveAllowed,
        turnToolChoice,
        emitTextDelta: !holdAssistantDelta,
        signal: this.ctx.abortSignal,
      });

      // 空响应检测
      if (!result.streamErrored && !adapter.hasContent(result)) {
        result.streamErrored = true;
        result.lastStreamError = "模型服务返回了空响应，正在重试...";
        this.turnEngine.record({ type: "model_error", error: result.lastStreamError });
      }

      if (!result.streamErrored) break;
      if (adapter.hasContent(result) || attempt >= maxRetries) break;

      const jitter = Math.floor(Math.random() * jitterMs);
      const waitMs = baseDelayMs * Math.pow(2, attempt) + jitter;
      console.warn(
        `[agent-stream] retry ${attempt + 1}/${maxRetries} after ${waitMs}ms — ${result.lastStreamError}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }

    // [9] writeEvent("error") if streamErrored
    if (result.streamErrored) {
      this.ctx.writeEvent("error", { error: result.lastStreamError, turn: this.turn });
    }

    // [10] onTurnUsage 回调
    if (this.ctx.onTurnUsage && (result.promptTokens > 0 || result.completionTokens > 0)) {
      this.ctx.onTurnUsage(result.promptTokens, result.completionTokens);
    }

    // [11] JSON 工具回退
    // 在 fallback 前记录流解析的工具数量，用于 protocolViolation 判断
    const streamParsedToolCount = result.completedToolUses.length;
    if (result.completedToolUses.length === 0) {
      const autoRetryText = adapter.getAutoRetryText(result);
      const fallbackToolUse = this._trySynthesizeToolUseFromJsonText(autoRetryText);
      if (fallbackToolUse) {
        result.completedToolUses.push(fallbackToolUse);
        this.turnEngine.record({
          type: "model_tool_call",
          callId: String(fallbackToolUse.id ?? ""),
          name: String(fallbackToolUse.name ?? ""),
          args: fallbackToolUse.input && typeof fallbackToolUse.input === "object"
            ? (fallbackToolUse.input as Record<string, unknown>)
            : {},
        });
      }
    }

    // [11.5] 统一参数预验证
    // Provider 路径仅对验证失败的调用填充 presetResults，有效调用会在此被幂等地
    // 重复 normalize+validate（纯函数，无副作用）。Anthropic 路径则首次在此校验。
    for (const toolUse of result.completedToolUses) {
      const toolUseId = String(toolUse.id ?? "");
      if (result.presetResults.has(toolUseId)) continue;

      const rawInput = toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
        ? (toolUse.input as Record<string, unknown>)
        : {};
      const normalized = normalizeToolCallForValidation(toolUse.name, rawInput);
      const normalizedName = normalized.name;
      const normalizedInput = normalized.args;
      const nameChanged = normalizedName !== String(toolUse.name ?? "");

      toolUse.name = normalizedName;
      toolUse.input = normalizedInput;

      if (nameChanged) {
        this.turnEngine.record({
          type: "model_tool_call",
          callId: toolUseId,
          name: normalizedName,
          args: normalizedInput,
        });
      }

      const v = validateToolCallArgs({ name: normalizedName, toolArgs: normalizedInput });
      if (!v.ok) {
        result.presetResults.set(toolUseId, {
          ok: false,
          output: {
            ok: false,
            error: "ERR_PARAM_SCHEMA_MISMATCH",
            message: v.error?.message ?? "工具参数不符合 schema",
            detail: v.error?.field ? { field: v.error.field } : null,
            next_actions: ["按该工具 schema 重新组织参数", "缺参时先补齐必填字段后重试"],
          },
        });
      }
    }

    // [12-13] 协议违规检测 + 混输压制
    // 使用流解析的工具数量而非 fallback 后的数量，与旧逻辑保持一致
    const hasProtocolViolation = adapter.detectsProtocolViolation &&
      result.hasToolCallMarker && streamParsedToolCount === 0;
    const suppressMixedText = result.completedToolUses.length > 0 &&
      result.displayText.length > 0;

    if (hasProtocolViolation) {
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "warn",
        title: "XmlProtocol",
        message: "检测到无效的 <tool_calls> XML，已注入重试提醒。",
      });
    } else if (suppressMixedText) {
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: adapter.detectsProtocolViolation ? "XmlProtocol" : "MixedOutputSuppressed",
        message: adapter.detectsProtocolViolation
          ? `检测到 XML 混输（wrapper=${result.wrapperCount}），已忽略自然语言文本，仅执行工具调用。`
          : "检测到文本与工具混输，已忽略文本，仅执行工具调用。",
      });
    }

    // [14] adapter.buildHistoryEntry → _pushHistory
    const { entry, shouldPush } = adapter.buildHistoryEntry({
      result,
      suppressText: suppressMixedText,
      hasProtocolViolation,
    });
    if (shouldPush) this._pushHistory(entry);

    // [15] writeEvent("assistant.done")
    this.ctx.writeEvent("assistant.done", { turn: this.turn });

    // [16] abort/error → _setOutcome → return false
    if (this.ctx.abortSignal.aborted) {
      this.turnEngine.record({ type: "model_error", error: "ABORTED" });
      this._setOutcome({ status: "aborted", reason: "aborted", reasonCodes: ["aborted"] });
      return false;
    }
    if (result.streamErrored) {
      this._setOutcome({
        status: "failed",
        reason: "upstream_error",
        reasonCodes: ["upstream_error"],
        detail: { turn: this.turn, error: result.lastStreamError || "UPSTREAM_ERROR" },
      });
      return false;
    }

    // [17] protocolViolation → _pushHistory(user_hint) → return true
    if (hasProtocolViolation) {
      const retryHint =
        "你的工具调用 XML 无效。若需调用工具，请只输出一个合法的 <tool_calls>...</tool_calls>；否则输出纯 Markdown。现在请按协议重试。";
      this._pushHistory({ role: "user_hint", text: retryHint });
      return true;
    }

    // [18] 无工具分支: _checkAutoRetry + 延迟 delta 发送 + _setOutcome
    if (result.completedToolUses.length === 0) {
      const autoRetryText = adapter.getAutoRetryText(result);

      // ---- Orchestrator 长文本硬性拦截 ----
      // 编排者不持有执行工具，若无工具轮输出超 300 字符的长文，大概率是绕开委派直接写稿。
      // holdAssistantDelta 已确保文本未实时发送给客户端，此处拦截并重试。
      const orchestratorTextLen = String(result.displayText || autoRetryText || "").trim().length;
      if (orchestratorMode && orchestratorTextLen > 300 && this.orchestratorTextRetries < 2) {
        this.orchestratorTextRetries += 1;
        this._pushHistory({
          role: "user_hint",
          text:
            "你是编排者（负责人），禁止直接输出长文内容。请根据任务类型委派给合适成员（联网搜索→topic_planner，写作→copywriter）。" +
            "若任务同时需要搜索和写作，先委派 topic_planner 搜索，再把搜索结果通过 inputArtifacts 传给 copywriter。",
        });
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "OrchestratorLongTextBlocked",
          message:
            `检测到编排者无工具轮长文本输出（${orchestratorTextLen} 字符），` +
            `已拦截并重试（${this.orchestratorTextRetries}/2）。`,
        });
        return true;
      }
      // 未触发拦截（短文本或非 orchestrator）→ 重置连续违规计数
      if (orchestratorMode && orchestratorTextLen <= 300) {
        this.orchestratorTextRetries = 0;
      }

      const shouldRetry = this._checkAutoRetry(autoRetryText);
      if (shouldRetry) return true;

      // 编排者长文本拦截重试耗尽后，放行但发出警告
      if (orchestratorMode && orchestratorTextLen > 300) {
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "OrchestratorLongTextBypass",
          message: "编排者长文本拦截已达重试上限（2），本轮放行文本输出。",
        });
      }

      // 延迟 delta 发送：Anthropic 路径在 emitTextDelta=true 时已实时发送，
      // 只有 holdAssistantDelta 时才需延迟发送。
      // Provider 路径从不实时发送，但 detectsProtocolViolation=true 时 hasProtocolViolation
      // 已在上面处理，此处只需判断 holdAssistantDelta。
      const outcomeCompleted =
        this.turnEngine.getOutcome().status === "completed" &&
        this.turnEngine.getOutcome().reason === "completed";

      if (holdAssistantDelta && result.displayText && outcomeCompleted) {
        this._emitAssistantDeltaSafe(result.displayText, {
          dropPureJsonPayload: executionContract.required,
        });
      }
      // Provider 路径不实时发送文本，需在此补发
      if (!holdAssistantDelta && adapter.detectsProtocolViolation &&
          result.displayText && !hasProtocolViolation && outcomeCompleted) {
        this._emitAssistantDeltaSafe(result.displayText, {
          dropPureJsonPayload: executionContract.required,
        });
      }

      if (outcomeCompleted) {
        this.turnEngine.record({ type: "model_done", finishReason: "assistant_text" });
        this._setOutcome({ status: "completed", reason: "assistant_text", reasonCodes: ["assistant_text"] });
      }
      return false;
    }

    // [19] totalToolCalls++ → _processCompletedToolUses
    this.totalToolCalls += result.completedToolUses.length;
    this.executionNoToolTurns = 0;
    this.orchestratorTextRetries = 0;
    this.forcedToolChoice = null;
    return this._processCompletedToolUses(
      result.completedToolUses,
      result.presetResults.size > 0 ? { presetResults: result.presetResults } : undefined,
    );
  }

  private _handleStreamEvent(
    ev: MsgStreamEvent,
    handlers: {
      pendingToolUses: Map<string, PendingToolUse>;
      completedToolUses: ContentBlockToolUse[];
      emitTextDelta: boolean;
      onTextDelta: (delta: string) => void;
      onUsage: (promptTokens: number, completionTokens: number) => void;
      onError: (error: string) => void;
    },
  ): void {
    switch (ev.type) {
      case "text_delta": {
        handlers.onTextDelta(ev.delta);
        this.turnEngine.record({ type: "model_text_delta", text: ev.delta });
        if (handlers.emitTextDelta) {
          this._emitAssistantDeltaSafe(ev.delta, { dropPureJsonPayload: false });
        }
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
        this.turnEngine.record({
          type: "model_tool_call",
          callId: String(ev.id ?? ""),
          name: String(name ?? ""),
          args: input && typeof input === "object" ? input : {},
        });

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
        this.turnEngine.record({ type: "model_error", error: ev.error });
        handlers.onError(ev.error);
        return;
      }

      case "done": {
        this.turnEngine.record({ type: "model_done", finishReason: "stream_done" });
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

    const allowedForTurn = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;

    // Tool allowlist enforcement: prevent hallucinated tool calls for sub-agents
    if (allowedForTurn.size > 0 && !allowedForTurn.has(toolUse.name)) {
      const routeId = String(this.ctx.intentRouteId ?? "").trim().toLowerCase();
      const isDeleteOnlyReadBlocked = routeId === "file_delete_only" && toolUse.name === "doc.read";
      this.ctx.writeEvent("tool.call", {
        toolCallId: toolUse.id,
        name: toolUse.name,
        args: rawInput,
        executedBy: "gateway",
        turn: this.turn,
      });
      if (isDeleteOnlyReadBlocked) {
        this.ctx.writeEvent("intent.delete_only.guard", {
          runId: this.ctx.runId,
          turn: this.turn,
          blockedToolName: toolUse.name,
          routeId,
          reason: "delete_only_forbid_doc_read",
        });
      }
      return {
        ok: false as const,
        output: {
          ok: false,
          error: "ERR_TOOL_POLICY_DENIED",
          message: isDeleteOnlyReadBlocked
            ? "当前是删除/清理任务，已禁止 doc.read。"
            : `工具 "${toolUse.name}" 不在当前回合允许列表中。`,
          detail: isDeleteOnlyReadBlocked
            ? "file_delete_only 路由下禁止先读文件，除非用户明确要求\u201c先看内容再删\u201d。"
            : `Tool "${toolUse.name}" is not available for this agent.`,
          next_actions: isDeleteOnlyReadBlocked
            ? ["先 project.listFiles 确认目标", "再调用 doc.deletePath 删除目标路径"]
            : ["改用当前回合允许的工具", "或先调整任务意图后重试"],
        },
      };
    }

    const executionContract = this._getExecutionContract();
    const todoGateRequired = this._todoGateRequired(executionContract);
    if (todoGateRequired && !this.runState.hasTodoList && !this._isPreTodoAllowedTool(toolUse.name)) {
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
          error: "TODO_GATE_REQUIRED",
          message: "当前执行型任务必须先设置 Todo，再进行搜索、写作或交付。",
          detail: {
            preferred: this._pickTodoGateToolName(allowedForTurn),
            reason: executionContract.reason ?? "",
          },
          next_actions: [
            "先调用 run.setTodoList 或 run.todo(action=upsert) 建立可执行 Todo",
            "Todo 建立后再继续搜索、写文件或调用其它工具",
          ],
        },
      };
    }

    if (this._isDeliveryLatchedFor(toolUse)) {
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
          error: "DELIVERY_LATCHED",
          message: "该逻辑产物已完成交付，禁止重复写入同一产物族。",
          detail: {
            artifactFamily: this._getArtifactFamily(toolUse),
          },
          next_actions: [
            "读取上一条工具结果并确认是否已经交付成功",
            "若需新版本，请明确新的目标文件名或改写成新的产物",
            "如果任务已完成，请调用 run.done 收口",
          ],
        },
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
          // lint.style 共用主 Agent 的 LLM 配置，避免独立端点挂了导致 lint 不可用
          llmOverride: this.ctx.baseUrl && this.ctx.apiKey && this.ctx.modelId
            ? { baseUrl: this.ctx.baseUrl, endpoint: this.ctx.endpoint, apiKey: this.ctx.apiKey, model: this.ctx.modelId }
            : null,
          mode: this.ctx.mode,
          allowedToolNames: this.ctx.allowedToolNames,
        });

        if (ret.ok) {
          return {
            ok: true,
            output: (ret as { output: unknown }).output,
            meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
          };
        }

        // web 工具 Gateway 执行失败 → 回退到 MCP（搜索 MCP → Playwright）
        const retError = String((ret as { error?: unknown }).error ?? "");
        if (retError.includes("FALLBACK_TO_MCP")) {
          const fallbackResult = await this._tryWebFallbackViaMcp(toolUse, rawInput);
          if (fallbackResult) return fallbackResult;
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

    // 合并工具翻译：将 LLM 调用的合并名翻译回 Desktop 识别的原名
    const desktopToolName = expandMergedToolName(toolUse.name, rawInput as Record<string, unknown>);
    const desktopArgs = desktopToolName !== toolUse.name
      ? stripActionField(rawInput as Record<string, unknown>)
      : rawInput;

    this.ctx.writeEvent("tool.call", {
      toolCallId: toolUse.id,
      name: desktopToolName,
      args: desktopArgs,
      executedBy: "desktop",
      turn: this.turn,
      ...(desktopToolName !== toolUse.name ? { mergedFrom: toolUse.name } : {}),
    });
    return this._waitForDesktopToolResult(toolUse.id, desktopToolName);
  }

  /**
   * web.search / web.fetch 的 MCP 回退链：
   * 搜索：bocha-search MCP → web-search MCP → Playwright (百度)
   * 抓取：web-search MCP (get_page_content) → Playwright (navigate)
   */
  private async _tryWebFallbackViaMcp(
    toolUse: ContentBlockToolUse,
    rawInput: unknown,
  ): Promise<ToolExecResult | null> {
    const mcpTools: any[] = Array.isArray((this.ctx as any).mcpTools) ? (this.ctx as any).mcpTools : [];
    if (!mcpTools.length) return null;

    const isSearch = toolUse.name === "web.search";

    if (isSearch) {
      // 策略 1：找博查搜索 MCP
      const bochaMcp = mcpTools.find((t) =>
        /^mcp\.bocha-search\./i.test(String(t?.name ?? "")) &&
        /bocha_web_search/i.test(String(t?.originalName ?? t?.name ?? "")),
      );
      if (bochaMcp) {
        const query = String((rawInput as any)?.query ?? "").trim();
        const count = (rawInput as any)?.count;
        const freshness = (rawInput as any)?.freshness;
        return this._dispatchMcpFallback(toolUse, bochaMcp, { query, ...(count != null ? { count } : {}), ...(freshness ? { freshness } : {}) });
      }

      // 策略 2：找 web-search MCP
      const webSearchMcp = mcpTools.find((t) =>
        /^mcp\.web-search\./i.test(String(t?.name ?? "")) &&
        /web_search/i.test(String(t?.originalName ?? t?.name ?? "")),
      );
      if (webSearchMcp) {
        const query = String((rawInput as any)?.query ?? "").trim();
        const numResults = (rawInput as any)?.count;
        return this._dispatchMcpFallback(toolUse, webSearchMcp, { query, ...(numResults != null ? { num_results: numResults } : {}) });
      }

      // 策略 3：Playwright 保底 → 导航到百度搜索
      const playwrightNav = mcpTools.find((t) =>
        /^mcp\.playwright\./i.test(String(t?.name ?? "")) &&
        /browser_navigate/i.test(String(t?.originalName ?? t?.name ?? "")),
      );
      if (playwrightNav) {
        const query = String((rawInput as any)?.query ?? "").trim();
        if (!query) return null;
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
        return this._dispatchMcpFallback(toolUse, playwrightNav, { url });
      }
    } else {
      // web.fetch 回退
      const url = String((rawInput as any)?.url ?? "").trim();
      if (!url) return null;

      // 策略 1：web-search MCP 的 get_page_content
      const getPageMcp = mcpTools.find((t) =>
        /^mcp\.web-search\./i.test(String(t?.name ?? "")) &&
        /get_page_content/i.test(String(t?.originalName ?? t?.name ?? "")),
      );
      if (getPageMcp) {
        return this._dispatchMcpFallback(toolUse, getPageMcp, { url });
      }

      // 策略 2：Playwright 保底 → navigate 到目标 URL
      const playwrightNav = mcpTools.find((t) =>
        /^mcp\.playwright\./i.test(String(t?.name ?? "")) &&
        /browser_navigate/i.test(String(t?.originalName ?? t?.name ?? "")),
      );
      if (playwrightNav) {
        return this._dispatchMcpFallback(toolUse, playwrightNav, { url });
      }
    }

    return null;
  }

  private async _dispatchMcpFallback(
    originalToolUse: ContentBlockToolUse,
    mcpTool: any,
    args: unknown,
  ): Promise<ToolExecResult> {
    const mcpName = String(mcpTool?.name ?? "").trim();
    this.ctx.writeEvent("tool.call", {
      toolCallId: originalToolUse.id,
      name: mcpName,
      args,
      executedBy: "desktop",
      turn: this.turn,
      fallbackFrom: originalToolUse.name,
    });
    return this._waitForDesktopToolResult(originalToolUse.id, mcpName);
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

    let subAgent: SubAgentDefinition | undefined =
      BUILTIN_SUB_AGENTS.find((a) => a.id === agentId && a.enabled)
      ?? (this.ctx.customAgentDefinitions ?? []).find((a) => a.id === agentId && a.enabled);

    // 别名兜底：模型可能用中文名、自然语言名或缩写调用 agent
    if (!subAgent) {
      const AGENT_ALIASES: Record<string, string> = {
        // 模型常见幻觉名 → 正确 agentId
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
      const allAgents = [
        ...BUILTIN_SUB_AGENTS.filter((a) => a.enabled),
        ...(this.ctx.customAgentDefinitions ?? []).filter((a) => a.enabled),
      ];
      const lower = agentId.toLowerCase();
      // 先查别名表
      const aliasId = AGENT_ALIASES[lower];
      if (aliasId) subAgent = allAgents.find((a) => a.id === aliasId);
      // 再试中文名/描述模糊匹配
      if (!subAgent) {
        subAgent = allAgents.find((a) =>
          a.name === agentId ||
          a.name.includes(agentId) ||
          a.id.includes(lower) || lower.includes(a.id),
        );
      }
    }

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

    // 子 agent 直接继承父 agent 的 LLM 配置（用户选的模型即子 agent 用的模型）
    const subModelId = this.ctx.modelId;
    const subApiKey = this.ctx.apiKey;
    const subBaseUrl = this.ctx.baseUrl;
    const subEndpoint = this.ctx.endpoint;
    const subToolResultFormat = this.ctx.toolResultFormat;

    console.log("[sub-agent.model]", {
      agentId,
      inherited: { modelId: subModelId, endpoint: subEndpoint, apiType: inferApiType(subEndpoint) },
    });

    // Sub-agent tools: from definition, exclude agent.delegate (prevent nesting)
    const subAllowedToolNames = new Set(
      (subAgent.tools ?? []).map((n) => String(n ?? "").trim()).filter(Boolean),
    );
    subAllowedToolNames.delete("agent.delegate");

    // 仅注入与子 Agent 角色能力匹配的 MCP 工具，避免全量注入导致上下文膨胀
    const mcpTools: any[] = Array.isArray((this.ctx as any).mcpTools) ? (this.ctx as any).mcpTools : [];
    const neededCaps = inferAgentNeededCapabilities(subAgent.tools ?? []);
    const scopedMcpTools = mcpTools.filter((t) => isMcpToolRelevantForAgent(t, neededCaps));
    for (const t of scopedMcpTools) {
      if (t.name) subAllowedToolNames.add(t.name);
    }
    console.log("[sub-agent.mcp-scope]", {
      agentId,
      neededCaps: Array.from(neededCaps),
      totalMcp: mcpTools.length,
      scopedMcp: scopedMcpTools.length,
    });
    if (mcpTools.length > 0 && scopedMcpTools.length === 0) {
      console.warn("[sub-agent.mcp-scope] WARN: all MCP tools filtered out for", agentId,
        "— neededCaps may not match any MCP capability");
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

    // ── 子 agent skill 继承：若父 agent 激活了 style_imitate 且子 agent 可 lint，
    //    将仿写闭环指引注入子 agent 的 systemPrompt ──
    const parentStyleSkillActive = this.ctx.activeSkills.some((s) => s.id === "style_imitate");
    const shouldInjectStyleImitate = parentStyleSkillActive && subCanLint && inheritStyleGates;
    console.log("[sub-agent.style]", {
      agentId,
      parentStyleSkillActive,
      subCanLint,
      inheritStyleGates,
      shouldInjectStyleImitate,
      parentLintGateEnabled: this.ctx.gates.lintGateEnabled,
      parentActiveSkillIds: this.ctx.activeSkills.map((s) => s.id),
    });

    let subSystemPrompt = String(subAgent.systemPrompt ?? "").trim() || this.ctx.systemPrompt;
    if (shouldInjectStyleImitate) {
      const styleFragment = String(STYLE_IMITATE_SKILL.promptFragments?.system ?? "").trim();
      if (styleFragment) {
        subSystemPrompt += `\n\n【Active Skills】style_imitate\n- ${styleFragment}`;
      }
    }

    // 动态替换子 Agent prompt 中硬编码的工具清单，确保与实际 allowed + scoped MCP 一致
    if (/可用工具（仅此列表/.test(subSystemPrompt)) {
      const dynamicToolList = buildDynamicToolList({
        allowedToolNames: subAllowedToolNames,
        mcpTools: scopedMcpTools,
      });
      subSystemPrompt = replaceHardcodedToolList(subSystemPrompt, dynamicToolList);
    }

    const subActiveSkills: ActiveSkill[] = shouldInjectStyleImitate
      ? this.ctx.activeSkills.filter((s) => s.id === "style_imitate")
      : [];

    // Build sub-agent RunContext
    const subCtx: RunContext = {
      runId: subRunId,
      mode: "agent",
      intent: subIntent,
      gates: subGates,
      activeSkills: subActiveSkills,
      allowedToolNames: subAllowedToolNames,
      systemPrompt: subSystemPrompt,
      toolSidecar: this.ctx.toolSidecar,
      styleLinterLibraries: this.ctx.styleLinterLibraries,
      fastify: this.ctx.fastify,
      authorization: this.ctx.authorization,
      modelId: subModelId,
      apiKey: subApiKey,
      baseUrl: subBaseUrl,
      endpoint: subEndpoint,
      toolResultFormat: subToolResultFormat,
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
      l1Memory: this.ctx.l1Memory ?? "",
      l2Memory: this.ctx.l2Memory ?? "",
      ctxDialogueSummary: this.ctx.ctxDialogueSummary ?? "",
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

    // 将能力匹配后的 MCP 工具传递给子 Agent context
    if (scopedMcpTools.length) {
      (subCtx as any).mcpTools = scopedMcpTools;
    }

    const subRunner = new AgentRunner(subCtx);
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

    const normalizedTask = normalizeDelegationTask(task);
    let taskMessage = normalizedTask || task;

    // 大文本外置到 blob pool —— 避免 LLM 回显巨量文本导致 SSE 超时
    if (needsTextBlob && this.ctx.textBlobPool) {
      const blobId = `blob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.ctx.textBlobPool.set(blobId, normalizedTask || task);
      const charCount = (normalizedTask || task).length;
      const preview = (normalizedTask || task).slice(0, 150).replace(/\n/g, " ") + "...";
      taskMessage = [
        `用户提交了约${charCount}字的文本，内容预览：「${preview}」`,
        "",
        `请调用 kb.learn 工具开始学习入库流程，传入 textRef="${blobId}"。`,
        "文本已由系统预存，无需你传递原文。",
      ].join("\n");
    }

    // 先用原始 taskMessage 判断记忆注入（在结构化包装之前，避免包装后文本膨胀导致触发条件失真）
    const injectMemory = shouldInjectSubAgentMemory({
      task: taskMessage,
      inputArtifactsCount: inputArtifacts.length,
      acceptanceCriteria,
      rawArgs,
    });

    // ── 结构化任务传递（A2A 启发）：自动注入用户原始消息，防止"传声游戏" ──
    // orchestrator 对用户意图的重述可能失真，sub-agent 需同时看到用户原话和负责人指令
    if (!needsTextBlob) {
      const firstUserEntry = this.history.find(
        (e) => e.role === "user" && typeof (e as any).text === "string" && (e as any).text.trim().length > 0,
      );
      const originalUserMessage = firstUserEntry ? String((firstUserEntry as any).text).trim() : "";
      if (originalUserMessage) {
        // 解析 orchestrator 提供的补充上下文（可选 briefing / references）
        const rawContext = rawArgs.context;
        const delegationCtx = (rawContext && typeof rawContext === "object" && !Array.isArray(rawContext))
          ? rawContext as Record<string, unknown>
          : {};
        const briefing = typeof delegationCtx.briefing === "string" ? delegationCtx.briefing.trim() : "";
        const references = Array.isArray(delegationCtx.references)
          ? (delegationCtx.references as unknown[]).map((r) => String(r ?? "").trim()).filter(Boolean)
          : [];

        // 用户原始消息限长：避免极端长文膨胀子 agent 上下文
        const MAX_USER_MSG_INJECT = 2000;
        const userMsgTruncated = originalUserMessage.length > MAX_USER_MSG_INJECT
          ? originalUserMessage.slice(0, MAX_USER_MSG_INJECT) + "…（已截断）"
          : originalUserMessage;

        const sections: string[] = [
          `【用户原始需求】\n${userMsgTruncated}`,
          `【负责人指令】\n${taskMessage}`,
        ];
        if (briefing) sections.push(`【背景说明】\n${briefing}`);
        if (references.length > 0) sections.push(`【参考资料】\n${references.join("\n")}`);
        taskMessage = sections.join("\n\n");
      }
    }

    // 自动注入精简上下文到 taskMessage（风格库 ID + mainDoc 目标/约束 + 记忆/摘要）
    const contextHint = buildSubAgentContextHint({
      agentId: subAgent.id,
      styleLibIds: this.ctx.styleLibIds,
      mainDoc: this.ctx.mainDoc,
      styleLibIdSet: this.ctx.gates.styleLibIdSet,
      l1Memory: injectMemory ? (this.ctx.l1Memory ?? "") : "",
      l2Memory: injectMemory ? (this.ctx.l2Memory ?? "") : "",
      ctxDialogueSummary: injectMemory ? (this.ctx.ctxDialogueSummary ?? "") : "",
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

    this.runState.hasPlanCommitment = true;

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
    const name = toolUse.name;

    if (name.startsWith("mcp.")) {
      this.runState.hasMcpToolCall = true;
      this.runState.mcpToolCallCount = Math.max(
        0,
        Math.floor(Number(this.runState.mcpToolCallCount ?? 0)),
      ) + 1;
      if (result.ok) {
        this.runState.mcpToolSuccessCount = Math.max(
          0,
          Math.floor(Number(this.runState.mcpToolSuccessCount ?? 0)),
        ) + 1;
      } else {
        this.runState.mcpToolFailCount = Math.max(
          0,
          Math.floor(Number(this.runState.mcpToolFailCount ?? 0)),
        ) + 1;
      }
    }

    if (!result.ok) return;

    if (name === "time.now") {
      this.runState.hasTimeNow = true;
      const nowIso = String((result.output as { nowIso?: unknown })?.nowIso ?? "").trim();
      this.runState.lastTimeNowIso = nowIso || null;
      return;
    }

    if (name === "agent.delegate") {
      this.runState.hasPlanCommitment = true;
      // 累加委派计数
      const agentId = String((toolUse.input as any)?.agentId ?? "").trim();
      if (agentId) {
        const counts = this.runState.delegationCounts ?? {};
        counts[agentId] = (counts[agentId] ?? 0) + 1;
        this.runState.delegationCounts = counts;
      }
      return;
    }

    if (
      name === "run.setTodoList" ||
      name === "run.todo.upsertMany" ||
      (name === "run.todo" && String((toolUse.input as any)?.action ?? "").trim().toLowerCase() === "upsert")
    ) {
      this.runState.hasTodoList = true;
      this.runState.hasPlanCommitment = true;
      if (this.runState.todoGateSatisfiedAtTurn == null) {
        this.runState.todoGateSatisfiedAtTurn = this.turn;
      }
      this.runState.toolLoopGuardReason = null;
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

    // 合并工具 doc.snapshot 的 restore action 等同于 doc.restoreSnapshot（写操作）
    const isSnapshotRestore =
      name === "doc.snapshot" && String((toolUse.input as any)?.action ?? "").trim().toLowerCase() === "restore";

    if (isWriteLikeTool(name) || isSnapshotRestore) {
      this.runState.hasWriteOps = true;
    }

    if (isContentWriteTool(name) || isSnapshotRestore) {
      this.runState.hasWriteOps = true;
      this.runState.hasWriteApplied = true;
    }

    if (result.ok && (isContentWriteTool(name) || isSnapshotRestore || name === "code.exec" || name === "doc.write")) {
      this._recordDeliveredArtifact(toolUse, result);
    }
  }

  private _checkAutoRetry(assistantText: string): boolean {
    const pushRetryUserMessage = (content: string) => {
      this._pushHistory({ role: "user_hint", text: content });
    };

    const canForceToolChoice = this.supportsForcedToolChoice;
    const assistantHasText = String(assistantText ?? "").trim().length > 0;
    const executionContract = this._getExecutionContract();
    const deliveryContract = this._deliveryContract();
    const allowedToolNames = this.turnAllowedToolNames ?? this.ctx.allowedToolNames;
    const todoGateRequired = this._todoGateRequired(executionContract);
    const needsArtifact = deliveryContract.required && !this._hasSatisfiedDeliveryContract(deliveryContract);

    if (todoGateRequired && !this.runState.hasTodoList && allowedToolNames.size > 0) {
      this.executionNoToolTurns += 1;
      const todoToolName = this._pickTodoGateToolName(allowedToolNames);
      this.forcedToolChoice = canForceToolChoice
        ? (todoToolName ? { type: "tool", name: todoToolName } : { type: "any" })
        : null;

      if (this.executionNoToolTurns <= executionContract.maxNoToolTurns) {
        pushRetryUserMessage(
          `你还没有设置 Todo（第 ${this.executionNoToolTurns} 次重试）。` +
            "请先调用 run.setTodoList（或 run.todo action=upsert）写入可执行 Todo，再继续后续工具。禁止直接开始搜索、写文件或只回复文本。",
        );
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "TodoGateRetry",
          message:
            `执行型回合必须先建 Todo，已触发重试（${this.executionNoToolTurns}/${executionContract.maxNoToolTurns}）` +
            (todoToolName
              ? `，优先工具：${todoToolName}`
              : canForceToolChoice
                ? "，优先策略：任意 Todo 工具"
                : "，兼容端点：仅文本提醒（不强制 tool_choice）"),
          detail: {
            reason: executionContract.reason ?? "",
            hasTodoList: this.runState.hasTodoList,
            continuationMode: this.providerCapabilities.continuationMode,
          },
        });
        return true;
      }

      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "error",
        title: "TodoGateUnsatisfied",
        message: "执行型回合连续重试后仍未建立 Todo，已结束本轮。",
        detail: {
          reason: executionContract.reason ?? "",
          retries: this.executionNoToolTurns,
          continuationMode: this.providerCapabilities.continuationMode,
        },
      });
      this._setOutcome({
        status: "failed",
        reason: "todo_gate_unsatisfied",
        reasonCodes: ["todo_gate_unsatisfied"],
        detail: {
          reason: executionContract.reason ?? "",
          turn: this.turn,
          retries: this.executionNoToolTurns,
        },
      });
      return false;
    }

    // Sub-agent tool nudge: if a sub-agent's early turns produce text without
    // calling any tools (and tools are available), inject a nudge message.
    // This handles API proxies that strip tool_choice: "any" from the request.
    // 仅在 executionContract.required 时启用，避免误伤写作型子任务。
    if (this.ctx.agentId && this.turn <= 2 && this.ctx.allowedToolNames.size > 0 && executionContract.required) {
      pushRetryUserMessage("请立即调用工具执行任务。不要输出分析或计划——直接调用第一个需要的工具。");
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "info",
        title: "SubAgentToolNudge",
        message: "子 Agent 未调用工具，已注入工具调用提醒并继续下一轮。",
      });
      return true;
    }

    // Phase2：交付文件类任务（Delivery Contract）
    // 无论是否已满足 minToolCalls，只要本轮要求“产出文件”，就必须在收口前落盘。
    if (assistantHasText && needsArtifact) {
      // 如果是在向用户澄清/等待确认，不强行重试写入（避免卡死）。
      if (this._looksLikeClarifyQuestion(assistantText)) return false;

      const projectDirAvailable = this._projectDirAvailable();
      const preferredWrite = this._pickPreferredWriteToolName(deliveryContract, allowedToolNames);
      const canAttemptWrite = projectDirAvailable && Boolean(preferredWrite);

      // 缺少项目目录或写入工具不可用：放行文本，让助手提示用户补齐前置条件。
      if (!canAttemptWrite) {
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "DeliverabilityContractBlocked",
          message: "文件交付契约未满足：当前缺少项目目录或写入工具不可用，已放行文本提示用户补齐前置条件。",
          detail: {
            projectDirAvailable,
            preferredWriteTool: preferredWrite,
            recommendedPath: deliveryContract.recommendedPath ?? null,
          },
        });
        return false;
      }

      this.deliverabilityNoWriteTurns += 1;
      this.forcedToolChoice = canForceToolChoice
        ? (preferredWrite ? { type: "tool", name: preferredWrite } : { type: "any" })
        : null;

      if (this.deliverabilityNoWriteTurns <= 3) {
        const recPath = deliveryContract.recommendedPath ? `建议路径：${deliveryContract.recommendedPath}。` : "";
        pushRetryUserMessage(
          `你还没有真正产出可交付文件（第 ${this.deliverabilityNoWriteTurns} 次提醒）。` +
            `本轮属于文件交付任务，禁止只回复文本。请立即调用 doc.write（或等价写入工具）完成落盘。${recPath}`,
        );
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "DeliverabilityContractRetry",
          message: "文件交付契约未满足：检测到仅文本输出，已注入强制写入提示并重试。",
          detail: {
            kind: deliveryContract.kind ?? "unknown",
            recommendedPath: deliveryContract.recommendedPath ?? null,
            preferredWriteTool: preferredWrite ?? null,
            continuationMode: this.providerCapabilities.continuationMode,
          },
        });
        return true;
      }

      // 超过重试上限：放行文本，避免无限循环；但记录 error 方便排查。
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "error",
        title: "DeliverabilityContractRetryExceeded",
        message: "文件交付契约连续重试后仍未落盘，已放行文本输出（避免无限循环）。",
        detail: {
          kind: deliveryContract.kind ?? "unknown",
          recommendedPath: deliveryContract.recommendedPath ?? null,
          retries: this.deliverabilityNoWriteTurns,
        },
      });
      return false;
    }


    if (
      executionContract.required &&
      this.totalToolCalls < executionContract.minToolCalls &&
      this.ctx.allowedToolNames.size > 0
    ) {
      // 非 Anthropic 端点 + 非 strict 路由（task_execution）+ 已有可读文本：直接软降级。
      // GPT 等模型对 tool_choice 强制的遵循度低，反复重试会浪费 token 且最终仍失败。
      // 仅在 Todo Gate 已满足后才允许软降级；否则必须先建 Todo。
      const isNonStrictRoute = (this.ctx.intentRouteId ?? "") === "task_execution" ||
        (this.ctx.intentRouteId ?? "") === "kb_ops";
      if (!canForceToolChoice && assistantHasText && isNonStrictRoute && !needsArtifact) {
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "ExecutionContractBypass",
          message: "兼容端点：检测到可读文本输出，跳过强制工具重试，按文本回复交付。",
          detail: {
            endpoint: this.ctx.endpoint ?? "(default)",
            minToolCalls: executionContract.minToolCalls,
            reason: executionContract.reason ?? "",
          },
        });
        this.forcedToolChoice = null;
        return false;
      }

      this.executionNoToolTurns += 1;
      const preferredToolName = executionContract.preferredToolNames.find((name) =>
        this.ctx.allowedToolNames.has(String(name ?? "").trim()),
      );
      const fallbackToolName = preferredToolName ? null : this._pickExecutionFallbackToolName();

      // Anthropic 端点使用 forcedToolChoice 强制调工具；非 Anthropic 端点仅靠文本提醒，
      // 因为很多代理会剥离 tool_choice 参数。
      this.forcedToolChoice = canForceToolChoice
        ? (preferredToolName
            ? { type: "tool", name: preferredToolName }
            : fallbackToolName
              ? { type: "tool", name: fallbackToolName }
              : { type: "any" })
        : null;

      if (this.executionNoToolTurns <= executionContract.maxNoToolTurns) {
        pushRetryUserMessage(
          `你还没有执行任何工具调用（第 ${this.executionNoToolTurns} 次重试）。` +
            "本轮必须先调用工具完成动作，再输出说明。禁止只回复文本/JSON。",
        );
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "ExecutionContractRetry",
          message:
            `执行达成约束未满足，已触发重试（${this.executionNoToolTurns}/${executionContract.maxNoToolTurns}）` +
            (preferredToolName
              ? `，优先工具：${preferredToolName}`
              : fallbackToolName
                ? `，回退工具：${fallbackToolName}`
                : canForceToolChoice
                  ? "，优先策略：任意工具调用"
                  : "，兼容端点：仅文本提醒（不强制 tool_choice）"),
          detail: {
            minToolCalls: executionContract.minToolCalls,
            currentToolCalls: this.totalToolCalls,
            reason: executionContract.reason ?? "",
          },
        });
        return true;
      }

      // 软降级：若已有可读文本，则不直接失败，避免"只因未调工具而整轮失败"。
      if (assistantHasText && !needsArtifact) {
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "ExecutionContractSoftDegrade",
          message: "本轮未触发工具调用，已按文本回复返回；如需实际执行，请明确要求继续执行工具步骤。",
          detail: {
            minToolCalls: executionContract.minToolCalls,
            currentToolCalls: this.totalToolCalls,
            reason: executionContract.reason ?? "",
            retries: this.executionNoToolTurns,
          },
        });
        return false;
      }

      // Phase2：文件交付类任务禁止按文本软降级。
      if (assistantHasText && needsArtifact) {
        this.executionNoToolTurns += 1;
        const preferredWrite = (deliveryContract.preferredWriteToolNames ?? []).find((name) =>
          this.ctx.allowedToolNames.has(String(name ?? "").trim()),
        );
        this.forcedToolChoice = canForceToolChoice
          ? (preferredWrite ? { type: "tool", name: preferredWrite } : { type: "any" })
          : null;
        const recPath = deliveryContract.recommendedPath ? `建议路径：${deliveryContract.recommendedPath}。` : "";
        pushRetryUserMessage(
          `你还没有真正产出可交付文件（第 ${this.executionNoToolTurns} 次提醒）。` +
            `本轮属于文件交付任务，禁止只回复文本。请立即调用 doc.write（或等价写入工具）完成落盘。${recPath}`,
        );
        this.ctx.writeEvent("run.notice", {
          turn: this.turn,
          kind: "warn",
          title: "DeliverabilityContractRetry",
          message: "文件交付契约未满足：检测到仅文本输出，已注入强制写入提示并重试。",
          detail: {
            kind: deliveryContract.kind ?? "unknown",
            recommendedPath: deliveryContract.recommendedPath ?? null,
            preferredWriteTool: preferredWrite ?? null,
            continuationMode: this.providerCapabilities.continuationMode,
          },
        });
        return true;
      }

      // 无文本可回显时，保留失败分支，避免用户看起来"没结果却成功"。
      this.failedToolDigests.push({
        toolCallId: `execution_contract_turn_${this.turn}`,
        name: preferredToolName || "execution.contract",
        error: "EXECUTION_CONTRACT_UNSATISFIED",
        message: `执行型回合未触发工具调用（要求至少 ${executionContract.minToolCalls} 次）。`,
        next_actions: [
          "检查路由是否应为 discussion 而非 task_execution",
          "检查工具协议（native tools/XML）是否被模型正确遵循",
        ],
        turn: this.turn,
      });
      if (this.failedToolDigests.length > 40) {
        this.failedToolDigests.splice(0, this.failedToolDigests.length - 40);
      }
      this.ctx.writeEvent("run.notice", {
        turn: this.turn,
        kind: "error",
        title: "ExecutionContractFailed",
        message: "执行达成约束失败：连续重试后仍未触发工具调用，且无可读回复，已结束本轮。",
      });
      this._setOutcome({
        status: "failed",
        reason: "execution_contract_unsatisfied",
        reasonCodes: ["execution_contract_unsatisfied"],
        detail: {
          minToolCalls: executionContract.minToolCalls,
          currentToolCalls: this.totalToolCalls,
          reason: executionContract.reason ?? "",
          turn: this.turn,
        },
      });
      return false;
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

    pushRetryUserMessage(`继续推进。当前缺少：${reasonText}。请基于上下文完成未完成的步骤。`);

    this.ctx.writeEvent("run.notice", {
      turn: this.turn,
      kind: "info",
      title: "AutoRetry",
      message: `自动重试：${reasonText}`,
    });

    return true;
  }

  private _recordToolFailure(toolUse: ContentBlockToolUse, result: ToolExecResult): void {
    const out = result.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
    const error = String((out as any)?.error ?? "").trim() || "UNKNOWN_ERROR";
    const message = String((out as any)?.message ?? (out as any)?.detail ?? "").trim();
    const path = String((out as any)?.path ?? (toolUse.input as any)?.path ?? (toolUse.input as any)?.fromPath ?? "").trim();
    const nextActions = Array.isArray((out as any)?.next_actions)
      ? ((out as any).next_actions as any[]).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 3)
      : [];

    this.failedToolDigests.push({
      toolCallId: String(toolUse.id ?? ""),
      name: String(toolUse.name ?? ""),
      error,
      ...(message ? { message } : {}),
      ...(path ? { path } : {}),
      ...(nextActions.length ? { next_actions: nextActions } : {}),
      turn: this.turn,
    });
    if (this.failedToolDigests.length > 40) {
      this.failedToolDigests.splice(0, this.failedToolDigests.length - 40);
    }
  }

  getFailureDigest(): { failedCount: number; failedTools: ToolFailureDigest[] } {
    const failedTools = this.failedToolDigests.slice(0, 12);
    return { failedCount: this.failedToolDigests.length, failedTools };
  }

  getMessages(): AnthropicMessage[] {
    return this._toAnthropicMessages();
  }

  getRunState(): RunState {
    return this.runState;
  }

  getTurn(): number {
    return this.turn;
  }

  getExecutionReport(): Record<string, unknown> {
    const snapshot = this.turnEngine.getSnapshot();
    return {
      ...snapshot,
      totalToolCalls: this.totalToolCalls,
      executionNoToolTurns: this.executionNoToolTurns,
      failedToolCount: this.failedToolDigests.length,
      providerApi: this.apiType,
      providerCapabilitiesSnapshot: this.providerCapabilities,
      providerContinuationMode: this.providerCapabilities.continuationMode,
      todoGateSatisfiedAtTurn: this.runState.todoGateSatisfiedAtTurn,
      deliveryLatchActivatedAtTurn: this.runState.deliveryLatchActivatedAtTurn,
      sideEffectLedgerSize: Array.isArray(this.runState.sideEffectLedger) ? this.runState.sideEffectLedger.length : 0,
      toolLoopGuardReason: this.runState.toolLoopGuardReason,
      runState: this.runState,
    };
  }

  getOutcome(): RunOutcome {
    return this.turnEngine.getOutcome();
  }
}
