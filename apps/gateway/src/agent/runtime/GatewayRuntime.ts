import { createHash } from "node:crypto";
import { hasBillableUsage, normalizeLlmTokenUsage } from "../../billing.js";

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
  createInitialRunState,
  isContentWriteTool,
  isStyleExampleKbSearch,
  isWriteLikeTool,
  normalizeWorkflow,
  parseStyleLintResult,
  checkExclusions,
  resolveFollowUp,
  resolvePhase,
  type ParsedToolCall,
  type RunState,
  type SideEffectRecordV1,
  type WorkflowDeclaration,
} from "@ohmycrab/agent-core";
import {
  compactToolResultEnvelope,
  getToolResultEnvelopeNormalizedText,
  isToolResultEnvelope,
  type ToolResultEnvelope,
  type ToolResultImagePayload,
} from "@ohmycrab/shared";
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
import { CORE_TOOL_NAME_SET, HIGH_RISK_TOOL_NAME_SET } from "../coreTools.js";
import { normalizeToolParametersSchema } from "../../llm/toolSchema.js";
import { TurnEngine, type RunOutcome } from "../turnEngine.js";
import type { ModelApiType, ToolResultPayload } from "../types.js";
import { sanitizeAssistantUserFacingText } from "../userFacingText.js";
import { completionOnceViaProvider } from "../../llm/providerAdapter.js";
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
import { CollabRuntime } from "./collabRuntime.js";
import { normalizeSpawnAgentArgs } from "./collabCompat.js";
import { runOrchestratedStyleImitate } from "../styleOrchestrator.js";
import {
  buildPortableSkillActivationInstructions,
  collectPortableActivationToolNames,
  createActiveSkillFromManifest,
  evaluatePortableAllowedToolPolicy,
  normalizePortableContextMode,
  parsePortableAllowedToolPolicy,
  parsePortableSkillInvocationInput,
  resolvePortableSkillAgent,
  toPortableToolAliasName,
} from "../portableSkillCompat.js";

// ── 常量 ─────────────────────────────────────────

const EMPTY_FAILURE_DIGEST: RuntimeFailureDigest = {
  failedCount: 0,
  failedTools: [],
};

/** Desktop 工具结果超时（10 分钟） */
const TOOL_RESULT_TIMEOUT_MS = 600_000;
const PORTABLE_HOOK_COMMAND_TOOL_NAME = "portable.hook.command";
const CRAB_IMAGE_PRO_MODEL_ID = "gemini-3-pro-image-preview";
const CRAB_IMAGE_FLASH_MODEL_ID = "gemini-3.1-flash-image-preview";

/** 工具结果文本截断上限 */
const MAX_TOOL_RESULT_CHARS = 60_000;

const COMPLETED_OUTCOME: RunOutcome = {
  status: "completed",
  reason: "completed",
  reasonCodes: ["completed"],
};

function isCrabImageBillingTool(name: string): boolean {
  return name === "mcp.crab-image.generate_image" || name === "mcp.crab-image.edit_image";
}

function resolveImageGenModelIdFromArgs(args: unknown): string {
  const source = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const explicitModel = typeof source.model === "string" ? source.model.trim() : "";
  if (explicitModel) return explicitModel;
  const quality = typeof source.quality === "string" ? source.quality.trim().toLowerCase() : "";
  if (quality === "fast") return CRAB_IMAGE_FLASH_MODEL_ID;
  return CRAB_IMAGE_PRO_MODEL_ID;
}

/** 默认最大回合数，防止无限循环 */
const DEFAULT_MAX_TURNS = 200;
const PORTABLE_STOP_BLOCK_MAX_RETRIES = 3;
const MAX_PROVIDER_TOOL_NAME_LEN = 64;

const STYLE_LINT_PASS_SCORE = 70;
const LINT_MAX_REWORK = 2;
const MAX_TOOL_FAILURE_REPAIR_SERIES = 3;
const MAX_TOOL_RESULT_VISION_IMAGES = 3;

// ── 内部类型 ─────────────────────────────────────

type GatewayToolExecResult = {
  ok: boolean;
  output: unknown;
  images?: ToolResultImagePayload[];
  meta?: Record<string, unknown> | null;
  executedBy: "gateway" | "desktop";
  dryRun?: boolean;
};

type ToolCallSnapshot = {
  args: Record<string, unknown>;
  executedBy?: "gateway" | "desktop";
  dryRun?: boolean;
};

type PortableHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Notification"
  | "PermissionRequest"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreCompact"
  | "PostCompact"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop";

type PortableHookHandler = {
  type: "command" | "http" | "prompt" | "agent";
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  prompt?: string;
  model?: string;
  once?: boolean;
  timeoutMs?: number;
};

type PortableHookMatcher = {
  matcher?: string;
  hooks: PortableHookHandler[];
};

type PortableHookInvocationResult = {
  continue?: boolean;
  systemMessage?: string;
  decision?: { decision?: string; reason?: string };
  hookSpecificOutput?: Record<string, unknown> | null;
};

type PortablePermissionBehavior = "allow" | "deny";

type PortablePermissionRequestResult = {
  hookMessage?: string;
  updatedArgs?: Record<string, unknown>;
  permissionBehavior?: PortablePermissionBehavior;
  approvalRequested?: boolean;
  approvalId?: string;
  approvalQuestion?: string;
};

const PORTABLE_HOOK_IMMEDIATE_CONTEXT_EVENTS = new Set<PortableHookEventName>([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
]);

function appendUniqueBounded(list: string[], item: string, limit: number): string[] {
  const value = String(item ?? "").trim();
  if (!value) return list;
  const out = Array.isArray(list) ? list.slice() : [];
  if (!out.includes(value)) out.push(value);
  const lim = Math.max(1, Math.floor(Number(limit) || 1));
  if (out.length > lim) out.splice(0, out.length - lim);
  return out;
}

function extractJsonObjectLoose(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = String(fenced[1]).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return null;
}

function normalizePortableHookHandlers(raw: unknown): PortableHookHandler[] {
  const out: PortableHookHandler[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const handler = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const typeRaw = String(handler?.type ?? "").trim().toLowerCase();
    const type =
      typeRaw === "command" || typeRaw === "http" || typeRaw === "prompt" || typeRaw === "agent"
        ? (typeRaw as PortableHookHandler["type"])
        : "";
    if (!type) continue;
    out.push({
      type,
      command: typeof handler?.command === "string" ? String(handler.command) : undefined,
      url: typeof handler?.url === "string" ? String(handler.url) : undefined,
      method: typeof handler?.method === "string" ? String(handler.method) : undefined,
      headers:
        handler?.headers && typeof handler.headers === "object" && !Array.isArray(handler.headers)
          ? Object.fromEntries(
              Object.entries(handler.headers as Record<string, unknown>)
                .map(([key, value]) => [key, String(value ?? "").trim()] as const)
                .filter(([, value]) => Boolean(value)),
            )
          : undefined,
      prompt: typeof handler?.prompt === "string" ? String(handler.prompt) : undefined,
      model: typeof handler?.model === "string" ? String(handler.model) : undefined,
      once: handler?.once === true,
      timeoutMs: Number.isFinite(Number(handler?.timeoutMs)) ? Math.max(1000, Math.floor(Number(handler?.timeoutMs))) : undefined,
    });
  }
  return out;
}

function normalizePortableHookMatchers(raw: unknown): PortableHookMatcher[] {
  const out: PortableHookMatcher[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const matcherObj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (Array.isArray(matcherObj?.hooks)) {
      const hooks = normalizePortableHookHandlers(matcherObj.hooks);
      if (hooks.length > 0) {
        out.push({
          matcher: typeof matcherObj?.matcher === "string" ? String(matcherObj.matcher).trim() : undefined,
          hooks,
        });
      }
      continue;
    }
    const hooks = normalizePortableHookHandlers([item]);
    if (hooks.length > 0) out.push({ hooks });
  }
  return out;
}

function portableHookMatcherMatches(matcher: string | undefined, target: string): boolean {
  const raw = String(matcher ?? "").trim();
  if (!raw || raw === "*") return true;
  const patterns = raw.split("|").map((part) => part.trim()).filter(Boolean);
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    try {
      return new RegExp(`^(?:${pattern})$`, "i").test(target);
    } catch {
      return pattern.toLowerCase() === target.toLowerCase();
    }
  });
}

function mapPortablePermissionMode(opMode: "creative" | "assistant" | undefined) {
  return opMode === "assistant" ? "acceptEdits" : "default";
}

function normalizePortableHookResult(raw: unknown): PortableHookInvocationResult {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
  if (!value) return {};
  const systemMessage = typeof value.systemMessage === "string" ? String(value.systemMessage).trim() : "";
  const decisionRaw =
    value.decision && typeof value.decision === "object" && !Array.isArray(value.decision)
      ? (value.decision as Record<string, unknown>)
      : null;
  const hookSpecificOutput =
    value.hookSpecificOutput && typeof value.hookSpecificOutput === "object" && !Array.isArray(value.hookSpecificOutput)
      ? (value.hookSpecificOutput as Record<string, unknown>)
      : null;
  return {
    continue: typeof value.continue === "boolean" ? value.continue : undefined,
    systemMessage: systemMessage || undefined,
    decision: decisionRaw
      ? {
          decision: typeof decisionRaw.decision === "string" ? String(decisionRaw.decision).trim() : undefined,
          reason: typeof decisionRaw.reason === "string" ? String(decisionRaw.reason).trim() : undefined,
        }
      : undefined,
    hookSpecificOutput,
  };
}

function normalizePortablePermissionBehavior(raw: unknown): PortablePermissionBehavior | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "allow" || value === "approve") return "allow";
  if (value === "deny" || value === "block" || value === "reject") return "deny";
  return undefined;
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
  if (isToolResultEnvelope(output)) return truncateText(output.normalizedText.trim() || "(empty tool result)");
  return truncateText(stringifyUnknown(output).trim() || "(empty tool result)");
}

function buildTextContent(text: string): TextContent[] {
  return [{ type: "text", text: truncateText(text || "(empty tool result)") }];
}

function normalizeToolResultImages(images: unknown): ToolResultImagePayload[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const mediaType = String((item as any).mediaType ?? "").trim();
      const data = String((item as any).data ?? "").trim();
      if (!mediaType || !data) return null;
      const name = String((item as any).name ?? "").trim();
      const width = Number((item as any).width);
      const height = Number((item as any).height);
      const sizeBytes = Number((item as any).sizeBytes);
      return {
        mediaType,
        data,
        ...(name ? { name } : {}),
        ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width) } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height: Math.round(height) } : {}),
        ...(Number.isFinite(sizeBytes) && sizeBytes > 0 ? { sizeBytes: Math.round(sizeBytes) } : {}),
      } satisfies ToolResultImagePayload;
    })
    .filter((item): item is ToolResultImagePayload => Boolean(item))
    .slice(0, 1);
}

function buildToolResultImageFallbackText(images: ToolResultImagePayload[]): string {
  if (!images.length) return "";
  return images
    .map((image) => {
      const parts: string[] = [];
      if (image.name) parts.push(image.name);
      if (image.width && image.height) parts.push(`${image.width}x${image.height}`);
      return `[图片: ${parts.join(", ") || image.mediaType}]`;
    })
    .join("\n");
}

function buildToolResultContentParts(
  item: CanonicalToolResultItem,
  keepImages: boolean,
): Array<TextContent | ImageContent> {
  const images = normalizeToolResultImages(item.images);
  const textBase = item.normalizedText || normalizeToolOutputText(item.output);
  const fallbackText = keepImages ? "" : buildToolResultImageFallbackText(images);
  const text = [textBase, fallbackText].filter(Boolean).join("\n\n").trim() || "(empty tool result)";
  const parts: Array<TextContent | ImageContent> = buildTextContent(text);
  if (keepImages) {
    for (const image of images) {
      parts.push({
        type: "image",
        data: image.data,
        mimeType: image.mediaType,
      } as ImageContent);
    }
  }
  return parts;
}

function collectRecentToolResultImageCallIds(messages: AgentMessage[]): Set<string> {
  const out = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isCanonicalItem(message)) continue;
    const item = message as CanonicalTranscriptItem;
    if (item.kind !== "tool_result") continue;
    if (!normalizeToolResultImages(item.images).length) continue;
    out.add(item.callId);
    if (out.size >= MAX_TOOL_RESULT_VISION_IMAGES) break;
  }
  return out;
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

function normalizeStyleLibraryName(name: unknown) {
  return String(name ?? "").trim().replace(/风格库$/, "").replace(/知识库$/, "").replace(/库$/, "").trim();
}

function collectTopStyleArtifacts(output: unknown) {
  const groups = Array.isArray((output as any)?.groups) ? ((output as any).groups as any[]) : [];
  return groups
    .flatMap((group: any) => (Array.isArray(group?.hits) ? group.hits : []))
    .slice(0, 8)
    .map((hit: any) => ({
      id: String(hit?.artifact?.id ?? "").trim(),
      title: String(hit?.artifact?.title ?? "").trim(),
      cardType: String(hit?.artifact?.cardType ?? "").trim(),
    }))
    .filter((item) => item.id && item.title);
}

function summarizeStyleEvidencePack(input: unknown) {
  const pack = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!pack) return null;
  const topArtifacts = Array.isArray(pack.topArtifacts)
    ? pack.topArtifacts
        .map((item: any) => ({
          id: String(item?.id ?? "").trim(),
          title: String(item?.title ?? "").trim(),
          cardType: String(item?.cardType ?? "").trim(),
        }))
        .filter((item) => item.id && item.title)
        .slice(0, 6)
    : [];
  return {
    query: String(pack.query ?? "").trim() || null,
    libraryIds: Array.isArray(pack.libraryIds)
      ? (pack.libraryIds as unknown[]).map((id) => String(id ?? "").trim()).filter(Boolean).slice(0, 8)
      : [],
    groupCount: Number.isFinite(Number(pack.groupCount)) ? Math.max(0, Math.floor(Number(pack.groupCount))) : 0,
    hitCount: Number.isFinite(Number(pack.hitCount)) ? Math.max(0, Math.floor(Number(pack.hitCount))) : topArtifacts.length,
    ...(topArtifacts.length ? { topArtifacts } : {}),
  };
}

function fingerprintTextContent(text: string) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function ensureStyleArtifactRefMap(runState: RunState) {
  const state = runState as any;
  const current =
    state.stepArtifactRefs && typeof state.stepArtifactRefs === "object" && !Array.isArray(state.stepArtifactRefs)
      ? (state.stepArtifactRefs as Record<string, unknown>)
      : {};
  state.stepArtifactRefs = current;
  return current as Record<string, any>;
}

function buildStyleArtifactRef(args: {
  stepId: string;
  kind: string;
  textOrSeed: string;
  attempt?: number | null;
}) {
  const seed = String(args.textOrSeed ?? "").trim();
  if (!seed) return null;
  return {
    artifactId: `${String(args.stepId)}_${fingerprintTextContent(seed)}`,
    stepId: String(args.stepId),
    kind: String(args.kind),
    attempt: Number.isFinite(Number(args.attempt)) ? Math.max(1, Math.floor(Number(args.attempt))) : 1,
  };
}

function ensureStylePlanCheckpoint(runState: RunState, detail?: { topic?: string | null }) {
  const state = runState as any;
  const refs = ensureStyleArtifactRefMap(runState);
  const topic =
    String(detail?.topic ?? state.styleTopic ?? "").trim() ||
    String(state.selectedStyleLibraryId ?? "").trim() ||
    "style_plan";
  if (!refs.tone_setting) {
    refs.tone_setting = buildStyleArtifactRef({
      stepId: "tone_setting",
      kind: "tone_card",
      textOrSeed: `tone:${topic}`,
    });
  }
  if (!refs.structure) {
    refs.structure = buildStyleArtifactRef({
      stepId: "structure",
      kind: "structure_outline",
      textOrSeed: `structure:${topic}`,
    });
  }
  state.hasToneCard = true;
  state.hasStructureOutline = true;
  state.hasStylePlan = true;
}

function rankDraftCandidates(a: any, b: any) {
  const aHighRisk = String(a?.copy?.riskLevel ?? "").trim().toLowerCase() === "high";
  const bHighRisk = String(b?.copy?.riskLevel ?? "").trim().toLowerCase() === "high";
  if (aHighRisk !== bHighRisk) return aHighRisk ? 1 : -1;
  const styleDelta = Number(b?.styleScore ?? 0) - Number(a?.styleScore ?? 0);
  if (styleDelta !== 0) return styleDelta;
  const overlapDelta = Number(a?.copy?.maxOverlapChars ?? 0) - Number(b?.copy?.maxOverlapChars ?? 0);
  if (overlapDelta !== 0) return overlapDelta;
  return Number(a?.highIssues ?? 0) - Number(b?.highIssues ?? 0);
}

function upsertBestDraftCandidate(args: {
  runState: RunState;
  text: string;
  styleScore?: number | null;
  highIssues?: number | null;
  copy?: Record<string, unknown> | null;
}) {
  const text = String(args.text ?? "").trim();
  if (!text) return;
  const runState = args.runState as any;
  const artifactRef = buildStyleArtifactRef({
    stepId: "closure",
    kind: "draft_text",
    textOrSeed: text,
  });
  if (!artifactRef) return;
  const refs = ensureStyleArtifactRefMap(args.runState);
  const current = Array.isArray(runState.draftCandidatesV1) ? runState.draftCandidatesV1 : [];
  const candidate = {
    artifactId: artifactRef.artifactId,
    charCount: text.length,
    styleScore: Number.isFinite(Number(args.styleScore)) ? Number(args.styleScore) : 0,
    highIssues: Number.isFinite(Number(args.highIssues)) ? Math.max(0, Math.floor(Number(args.highIssues))) : 0,
    copy: args.copy && typeof args.copy === "object" ? args.copy : null,
  };
  const next = [...current.filter((item: any) => String(item?.artifactId ?? "") !== artifactRef.artifactId), candidate]
    .slice(-6)
    .sort(rankDraftCandidates);
  runState.draftCandidatesV1 = next;
  runState.bestDraft = next.length > 0 ? next[0] : null;
  runState.hasDraftText = true;
  refs.closure = artifactRef;
  if (candidate.styleScore > 0) {
    runState.bestStyleDraft = {
      score: candidate.styleScore,
      highIssues: candidate.highIssues,
      artifactId: artifactRef.artifactId,
      charCount: candidate.charCount,
    };
  }
}

function extractFinalDraftTextFromToolArgs(toolName: string, toolArgs: Record<string, unknown>): string {
  if (toolName === "write") {
    return String(toolArgs.content ?? "").trim();
  }
  return "";
}

function summarizeRunStateForExecutionReport(runState: RunState) {
  const state = runState as any;
  const refs =
    state.stepArtifactRefs && typeof state.stepArtifactRefs === "object" && !Array.isArray(state.stepArtifactRefs)
      ? Object.fromEntries(
          Object.entries(state.stepArtifactRefs as Record<string, any>)
            .map(([key, value]) => {
              const ref = value && typeof value === "object" ? value : null;
              if (!ref) return null;
              return [
                key,
                {
                  artifactId: String(ref.artifactId ?? "").trim() || null,
                  stepId: String(ref.stepId ?? key).trim() || key,
                  kind: String(ref.kind ?? "").trim() || null,
                  attempt: Number.isFinite(Number(ref.attempt)) ? Math.max(1, Math.floor(Number(ref.attempt))) : 1,
                },
              ];
            })
            .filter(Boolean) as Array<[string, Record<string, unknown>]>,
        )
      : null;
  return {
    ...state,
    styleEvidencePack: summarizeStyleEvidencePack(state.styleEvidencePack),
    bestStyleDraft: state.bestStyleDraft
      ? {
          score: Number(state.bestStyleDraft.score ?? 0) || 0,
          highIssues: Number(state.bestStyleDraft.highIssues ?? 0) || 0,
          artifactId: String(state.bestStyleDraft.artifactId ?? "").trim() || null,
          charCount: Number(state.bestStyleDraft.charCount ?? 0) || 0,
        }
      : null,
    draftCandidatesV1: Array.isArray(state.draftCandidatesV1)
      ? state.draftCandidatesV1.map((item: any) => ({
          artifactId: String(item?.artifactId ?? "").trim() || null,
          charCount: Number(item?.charCount ?? 0) || 0,
          styleScore: Number(item?.styleScore ?? 0) || 0,
          highIssues: Number(item?.highIssues ?? 0) || 0,
          copy: item?.copy ?? null,
        }))
      : [],
    bestDraft: state.bestDraft
      ? {
          artifactId: String(state.bestDraft.artifactId ?? "").trim() || null,
          charCount: Number(state.bestDraft.charCount ?? 0) || 0,
          styleScore: Number(state.bestDraft.styleScore ?? 0) || 0,
          highIssues: Number(state.bestDraft.highIssues ?? 0) || 0,
          copy: state.bestDraft.copy ?? null,
        }
      : null,
    finalWrittenPath: String(state.finalWrittenPath ?? "").trim() || null,
    stepArtifactRefs: refs,
  };
}

/**
 * 合并工具 → Desktop 原名翻译表。
 * LLM 看到一个合并工具（如 memory），Desktop 仍处理原名（如 memory.read）。
 * 与 writingAgentRunner.ts 中 MERGED_TOOL_MAP 保持一致。
 */
const MERGED_TOOL_MAP: Record<string, Record<string, string>> = {
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

function stripMergedActionField(args: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = args;
  return rest;
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

// ── 公共名 ↔ legacy 运行时名 桥接 ─────────────────
// 对齐 Claude Code PascalCase 工具名（feat-runtime-tool-exposure-v1）

const PUBLIC_TO_LEGACY = new Map<string, string>([
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["WebSearch", "web.search"],
  ["WebFetch", "web.fetch"],
  ["Glob", "project.searchPaths"],
  ["Grep", "project.search"],
  ["Bash", "shell.exec"],  // 默认路由；code/entryFile 时由 _resolveRuntimeToolName 动态切换
  ["Agent", "spawn_agent"], // 默认路由；其他 action 由 _resolveRuntimeToolName 动态切换
]);

const LEGACY_TO_PUBLIC = new Map<string, string>();
for (const [pub, leg] of PUBLIC_TO_LEGACY) {
  LEGACY_TO_PUBLIC.set(leg, pub);
}
// 多对一补充
LEGACY_TO_PUBLIC.set("send_input", "Agent");
LEGACY_TO_PUBLIC.set("resume_agent", "Agent");
LEGACY_TO_PUBLIC.set("wait_agent", "Agent");
LEGACY_TO_PUBLIC.set("close_agent", "Agent");

/** 将 legacy 或公共名统一为公共名 */
function normalizeToPublicToolName(raw: string): string {
  const name = String(raw ?? "").trim();
  if (!name) return "";
  return LEGACY_TO_PUBLIC.get(name) ?? name;
}

/** 将公共名 + 参数解析为 legacy 运行时名 */
function resolveRuntimeToolName(publicName: string, toolArgs: Record<string, unknown>): string {
  const name = String(publicName ?? "").trim();
  switch (name) {
    case "Bash": {
      const hasCode =
        (typeof toolArgs.code === "string" && toolArgs.code.trim().length > 0) ||
        (typeof toolArgs.entryFile === "string" && toolArgs.entryFile.trim().length > 0);
      return "Bash"; // Bash wrapper 直接下发给 Desktop，Desktop 按参数分发
    }
    case "Agent": {
      const action = String(toolArgs.action ?? "spawn").trim().toLowerCase();
      if (action === "send") return "send_input";
      if (action === "resume") return "resume_agent";
      if (action === "wait") return "wait_agent";
      if (action === "close") return "close_agent";
      return "spawn_agent";
    }
    default:
      return PUBLIC_TO_LEGACY.get(name) ?? name;
  }
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
  private readonly turnLocalRawToolResults = new Map<string, unknown>();
  private readonly rawToEncodedToolName = new Map<string, string>();
  private readonly encodedToRawToolName = new Map<string, string>();
  private readonly providerCapabilities: ProviderCapabilities;
  private executionNoToolTurns = 0;
  private currentTurnToolCalls = 0;
  /** 连续“有可见正文但无工具”回合，仅用于 follow-up 抑制 */
  private consecutiveVisibleNoToolTurns = 0;
  /** 连续“无可见正文且无工具”回合，用于 silent output 诊断 */
  private consecutiveSilentNoToolTurns = 0;
  /** 当前 run() 的内部 AbortController，run.done / maxTurns 通过此终止 */
  private internalAc: AbortController | null = null;
  /** 软提示上次处理时的失败工具计数（避免重复提示） */
  private lastSteeringFailureCount = 0;
  private readonly collabRuntime: CollabRuntime;
  private pendingImmediateItems: CanonicalTranscriptItem[] = [];
  private pendingFollowUpItems: CanonicalTranscriptItem[] = [];
  private executedPortableHookOnceKeys = new Set<string>();
  /** 当前轮用户上传的图片数量，用于 crab-image 多图重写 */
  private _currentTurnUserImageCount = 0;
  private activePortableHookEventStack: PortableHookEventName[] = [];
  private portableSessionStartSource = "startup";
  private portableHookInvocationSeq = 0;
  private portableApprovalSeq = 0;
  private portableStopBlockRetryCount = 0;
  /** max_tokens 续写：上一轮 stopReason */
  private lastStopReason: string | null = null;
  /** max_tokens 续写：是否需要注入续写提示 */
  private pendingMaxTokensRecovery = false;
  /** max_tokens 续写：已续写次数 */
  private maxTokensRecoveryCount = 0;
  private readonly MAX_TOKENS_RECOVERY_LIMIT = 3;

  constructor(
    private readonly config: RuntimeConfig & {
      mode: RuntimeMode;
      shadowMode?: RuntimeShadowMode;
    },
    private readonly kernel: LoopKernel = new PiLoopKernel(),
  ) {
    this.mode = config.mode;
    this.shadowMode = config.shadowMode ?? "off";
    this.collabRuntime = new CollabRuntime(this.config.runCtx);
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

    let encoded = encodeToolName(raw).replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(encoded)) encoded = `t_${encoded}`;
    if (encoded.length > MAX_PROVIDER_TOOL_NAME_LEN) {
      const hash = createHash("sha1").update(raw).digest("hex").slice(0, 12);
      const normalized = encoded.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "tool_");
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
    this.portableSessionStartSource = this._derivePortableSessionStartSource();

    const providerApi = inferProviderApi(this.config);
    const maxTurns = this.config.runCtx.maxTurns ?? DEFAULT_MAX_TURNS;

    await this._writePortableNotificationNotice({
      turn: 0,
      kind: "info",
      title: "ProviderRuntimeCapabilities",
      message: `runtime provider=${providerApi} continuation=${this.providerCapabilities.continuationMode}`,
      detail: this.providerCapabilities,
      source: "runtime.bootstrap",
    });

    const preRunCompact =
      this.config.runCtx.portablePreRunCompact &&
      typeof this.config.runCtx.portablePreRunCompact === "object" &&
      !Array.isArray(this.config.runCtx.portablePreRunCompact)
        ? (this.config.runCtx.portablePreRunCompact as Record<string, unknown>)
        : null;
    if (preRunCompact && String(preRunCompact.scope ?? "").trim().toLowerCase() === "dialogue_summary") {
      await this._runPortableHookEvent({
        eventName: "PreCompact",
        compact: {
          trigger: String(preRunCompact.trigger ?? "auto").trim() || "auto",
          scope: "dialogue_summary",
          custom_instructions: String(preRunCompact.customInstructions ?? "").trim(),
          compact_summary: "",
          compact: preRunCompact,
        } as Record<string, unknown>,
      });
      await this._runPortableHookEvent({
        eventName: "PostCompact",
        compact: {
          trigger: String(preRunCompact.trigger ?? "auto").trim() || "auto",
          scope: "dialogue_summary",
          custom_instructions: String(preRunCompact.customInstructions ?? "").trim(),
          compact_summary: String(preRunCompact.compactSummary ?? "").trim(),
          compact: preRunCompact,
        } as Record<string, unknown>,
      });
    }

    await this._runPortableHookEvent({ eventName: "UserPromptSubmit", userPrompt });
    await this._runPortableHookEvent({
      eventName: "SessionStart",
      userPrompt,
      sessionSource: this.portableSessionStartSource,
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
    this._currentTurnUserImageCount = images?.length ?? 0;

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
      // Pi runtime 的 tools 声明集在 run 内基本是静态的（pi-agent-core 不支持每 turn 替换 tools）。
      const declaredAllowed = new Set(this.config.runCtx.allowedToolNames);
      for (const name of this._collectDeclaredPortableActivationToolNames()) {
        declaredAllowed.add(name);
      }
      const visibleTools = this._buildAgentTools(declaredAllowed);

      await this._writePortableNotificationNotice({
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
          toolChoice: null,
        },
        source: "runtime.kernel_input",
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
        await this._handleKernelEvent(event, ac, maxTurns);
      }
      await stream.result();

      // 最终 outcome（run.done / approval_waiting / silent_no_output 在事件处理中已设置，此处不覆盖）
      if (this.outcome.reason === "run_done" || this.outcome.reason === "approval_waiting" || this.outcome.reason === "silent_no_output") {
        // 已由对应处理器设置，保持不变
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
      if (this.outcome.reason !== "run_done" && this.outcome.reason !== "approval_waiting") {
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
      if (this.outcome.reason !== "completed") {
        await this._runPortableHookEvent({ eventName: "Stop", stopReason: this.outcome.reason });
      }
      await this._runPortableHookEvent({ eventName: "SessionEnd", stopReason: this.outcome.reason });
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
    this.lastSteeringFailureCount = 0;
    this.executionNoToolTurns = 0;
    this.consecutiveVisibleNoToolTurns = 0;
    this.consecutiveSilentNoToolTurns = 0;
    this.currentTurnToolCalls = 0;
    this.pendingImmediateItems = [];
    this.pendingFollowUpItems = [];
    this.executedPortableHookOnceKeys.clear();
    this.activePortableHookEventStack = [];
    this.portableSessionStartSource = "startup";
    this.portableHookInvocationSeq = 0;
    this.portableApprovalSeq = 0;
    this.portableStopBlockRetryCount = 0;
    this.lastStopReason = null;
    this.pendingMaxTokensRecovery = false;
    this.maxTokensRecoveryCount = 0;
    this.toolCallSnapshots.clear();
    this.turnLocalRawToolResults.clear();
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

  private _queueRuntimeHint(text: string, reasonCodes: string[]) {
    const content = String(text ?? "").trim();
    if (!content) return;
    this.pendingFollowUpItems.push({
      kind: "runtime_hint",
      text: content,
      reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.filter(Boolean) : [],
    });
  }

  private _queuePortableImmediateHint(text: string, reasonCodes: string[]) {
    const content = String(text ?? "").trim();
    if (!content) return;
    this.pendingImmediateItems.push({
      kind: "runtime_hint",
      text: content,
      reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.filter(Boolean) : [],
    });
  }

  private _queuePortableHookContext(eventName: PortableHookEventName, text: string, reasonCodes: string[]) {
    if (PORTABLE_HOOK_IMMEDIATE_CONTEXT_EVENTS.has(eventName)) {
      this._queuePortableImmediateHint(text, reasonCodes);
      return;
    }
    this._queueRuntimeHint(text, reasonCodes);
  }

  private async _schedulePortableStopContinuation(args: {
    eventName: "Stop" | "SubagentStop";
    blockMessage?: string;
    detail?: Record<string, unknown>;
  }): Promise<boolean> {
    const blockMessage = String(args.blockMessage ?? "").trim();
    if (this.portableStopBlockRetryCount >= PORTABLE_STOP_BLOCK_MAX_RETRIES) {
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "warn",
        title: "PortableHookStopBlockLimitReached",
        message:
          `portable hook 已连续 ${this.portableStopBlockRetryCount} 次阻止 ${args.eventName} 收口，` +
          "为避免死循环，本次改为允许自然结束。",
        detail: {
          eventName: args.eventName,
          limit: PORTABLE_STOP_BLOCK_MAX_RETRIES,
          reason: blockMessage || null,
          ...(args.detail ?? {}),
        },
        source: "portable_hook.stop_guard",
      });
      return false;
    }

    this.portableStopBlockRetryCount += 1;
    const hintText =
      args.eventName === "SubagentStop"
        ? "子 Agent 已返回，但 portable hook 要求父 run 继续推进。\n" +
          (blockMessage || "请结合子 Agent 结果继续补齐遗漏项，再决定是否结束。")
        : "portable hook 阻止了当前回合自然结束。\n" +
          (blockMessage || "请继续推进剩余检查/收口动作，确认完成后再结束。");
    this._queueRuntimeHint(hintText, [
      "portable_hook_stop_block",
      `hook:${args.eventName.toLowerCase()}`,
      `retry:${this.portableStopBlockRetryCount}`,
    ]);
    await this._writePortableNotificationNotice({
      turn: this.turn,
      kind: "info",
      title: "PortableHookStopBlocked",
      message: `portable hook 阻止 ${args.eventName} 收口，已注入 follow-up 继续下一轮。`,
      detail: {
        eventName: args.eventName,
        retryCount: this.portableStopBlockRetryCount,
        limit: PORTABLE_STOP_BLOCK_MAX_RETRIES,
        reason: blockMessage || null,
        ...(args.detail ?? {}),
      },
      source: "portable_hook.stop_guard",
    });
    return true;
  }

  private _drainPortableImmediateItems(): AgentMessage[] {
    if (this.pendingImmediateItems.length <= 0) return [];
    return this.pendingImmediateItems
      .splice(0, this.pendingImmediateItems.length)
      .map((item) => item as unknown as AgentMessage);
  }

  private async _writePortableNotificationNotice(args: {
    turn?: number;
    kind: string;
    title: string;
    message: string;
    detail?: unknown;
    source?: string;
    notificationType?: string;
    skipPortableHook?: boolean;
  }) {
    const notificationType = String(args.notificationType ?? args.title ?? "").trim();
    const notice: Record<string, unknown> = {
      turn: Number.isFinite(Number(args.turn)) ? Math.floor(Number(args.turn)) : this.turn,
      kind: String(args.kind ?? "info").trim() || "info",
      title: String(args.title ?? "").trim(),
      message: String(args.message ?? "").trim(),
    };
    if (args.detail !== undefined) notice.detail = args.detail ?? null;
    if (notificationType) notice.notification_type = notificationType;
    this.config.runCtx.writeEvent("run.notice", notice);
    if (args.skipPortableHook === true) return;
    if (this.activePortableHookEventStack[this.activePortableHookEventStack.length - 1] === "Notification") return;
    await this._runPortableHookEvent({
      eventName: "Notification",
      notification: {
        ...notice,
        source: String(args.source ?? "run.notice").trim() || "run.notice",
        notification_type: notificationType || undefined,
      },
    });
  }

  private async _emitPortablePermissionRequest(args: {
    toolName: string;
    toolArgs: Record<string, unknown>;
    errorCode: string;
    decisionSource: string;
    message: string;
    detail?: unknown;
    requestKind?: string;
    approvalEligible?: boolean;
    allowCanProceed?: boolean;
  }): Promise<PortablePermissionRequestResult> {
    const result = await this._runPortableHookEvent({
      eventName: "PermissionRequest",
      toolName: args.toolName,
      toolArgs: args.toolArgs,
      permissionRequest: {
        request_kind: String(args.requestKind ?? "tool_use").trim() || "tool_use",
        decision_source: String(args.decisionSource ?? "").trim(),
        reason: String(args.errorCode ?? "").trim(),
        error: String(args.errorCode ?? "").trim(),
        message: String(args.message ?? "").trim(),
        detail: args.detail ?? null,
      },
    });
    const updatedArgs =
      result.updatedArgs && typeof result.updatedArgs === "object" && !Array.isArray(result.updatedArgs)
        ? result.updatedArgs
        : args.toolArgs;
    if (result.approvalRequest && args.approvalEligible) {
      const approval = result.approvalRequest;
      const question =
        String(approval.question ?? approval.prompt ?? result.hookMessage ?? args.message).trim() ||
        "需要你确认后我再继续。";
      const note =
        String(approval.note ?? approval.reason ?? "").trim() ||
        (result.hookMessage && result.hookMessage !== question ? result.hookMessage : "");
      const approvalId = `${this.config.runCtx.runId}:portable-approval:${++this.portableApprovalSeq}`;
      this.config.runCtx.writeEvent("portable.permission.requested", {
        turn: this.turn,
        approvalId,
        sourceToolName: args.toolName,
        question,
        note,
        detail: approval.detail ?? args.detail ?? null,
        requestKind: String(args.requestKind ?? "tool_use").trim() || "tool_use",
        decisionSource: String(args.decisionSource ?? "").trim(),
        updatedArgs,
      });
      this._setOutcome({
        status: "completed",
        reason: "approval_waiting",
        reasonCodes: [
          "approval_waiting",
          `tool:${args.toolName}`,
          `decision_source:${String(args.decisionSource ?? "").trim() || "portable_permission_request"}`,
        ],
        detail: {
          approvalId,
          toolName: args.toolName,
          question,
        },
      });
      this.internalAc?.abort();
      return {
        hookMessage: question,
        updatedArgs,
        approvalRequested: true,
        approvalId,
        approvalQuestion: question,
      };
    }
    if (result.permissionBehavior === "allow" && args.allowCanProceed) {
      return {
        hookMessage: result.hookMessage,
        updatedArgs,
        permissionBehavior: "allow",
      };
    }
    return {
      hookMessage: result.hookMessage,
      updatedArgs,
      permissionBehavior: result.permissionBehavior,
    };
  }

  private async _compactToolResultWithPortableHooks(args: {
    toolName: string;
    output: unknown;
    toolCallId?: string;
    ok?: boolean;
    source: string;
  }): Promise<ToolResultEnvelope> {
    if (isToolResultEnvelope(args.output)) return args.output as ToolResultEnvelope;
    const preview = normalizeToolOutputText(args.output);
    const compactBase = {
      source: String(args.source ?? "tool_result").trim() || "tool_result",
      tool_call_id: args.toolCallId ?? null,
      ok: args.ok !== false,
      before_chars: preview.length,
      preview: preview.slice(0, 2000),
      mode: "tool_result_envelope",
      scope: "tool_result_envelope",
      trigger: "auto",
      custom_instructions: "",
    };
    await this._runPortableHookEvent({
      eventName: "PreCompact",
      toolName: args.toolName,
      compact: compactBase,
    });
    const envelope = compactToolResultEnvelope(args.toolName, args.output);
    const compactedText = getToolResultEnvelopeNormalizedText(envelope);
    await this._runPortableHookEvent({
      eventName: "PostCompact",
      toolName: args.toolName,
      toolResult: envelope,
      compact: {
        ...compactBase,
        after_chars: compactedText.length,
        reduced: compactedText.length < preview.length,
        output_mode: envelope.mode,
        preview: compactedText.slice(0, 2000),
        compact_summary: compactedText.slice(0, 2000),
      },
    });
    return envelope;
  }

  private _allSkillManifests() {
    const map = this.config.runCtx.skillManifestById;
    return map instanceof Map ? Array.from(map.values()).filter(Boolean) : [];
  }

  private _collectDeclaredPortableActivationToolNames(): Set<string> {
    const out = new Set<string>();
    for (const manifest of this._allSkillManifests()) {
      if (!manifest || manifest.disableModelInvocation === true) continue;
      const toolCaps = Array.isArray((manifest as any)?.toolCaps?.allowTools)
        ? (manifest as any).toolCaps.allowTools
        : [];
      for (const raw of toolCaps) {
        const name = String(raw ?? "").trim();
        if (name && !HIGH_RISK_TOOL_NAME_SET.has(name)) out.add(name);
      }
      for (const name of collectPortableActivationToolNames([manifest])) out.add(name);
    }
    return out;
  }

  private async _applyDynamicSkillActivation(output: any, sourceToolName = "skills.activate") {
    const skillId =
      String(output?.activation?.skillId ?? "").trim() ||
      String(output?.skill?.id ?? "").trim();
    if (!skillId) return;
    const manifest = this.config.runCtx.skillManifestById?.get(skillId);
    if (!manifest) return;

    const activeSkills = Array.isArray(this.config.runCtx.activeSkills)
      ? this.config.runCtx.activeSkills.slice()
      : [];
    if (!activeSkills.some((item: any) => String(item?.id ?? "").trim() === skillId)) {
      activeSkills.push(
        createActiveSkillFromManifest({
          manifest,
          reasonCode: "skill:model_tool_activate",
          detail: { trigger: sourceToolName },
        }),
      );
      this.config.runCtx.activeSkills = activeSkills;
    }

    if (manifest.workflow) {
      const nextWorkflowDecls =
        this.config.runCtx.activeWorkflowDeclarations instanceof Map
          ? new Map(this.config.runCtx.activeWorkflowDeclarations)
          : new Map<string, any>();
      const workflow = normalizeWorkflow(manifest.workflow);
      if (skillId === "style_imitate" && !workflow) {
        throw new Error("STYLE_WORKFLOW_DECLARATION_MISSING");
      }
      if (workflow) nextWorkflowDecls.set(skillId, workflow);
      this.config.runCtx.activeWorkflowDeclarations = nextWorkflowDecls;
    }

    const nextAllowed = new Set(this.config.runCtx.allowedToolNames);
    const toolCaps = Array.isArray((manifest as any)?.toolCaps?.allowTools)
      ? (manifest as any).toolCaps.allowTools
      : [];
    for (const raw of toolCaps) {
      const name = String(raw ?? "").trim();
      if (name && !HIGH_RISK_TOOL_NAME_SET.has(name)) nextAllowed.add(name);
    }
    for (const raw of Array.isArray(output?.activation?.toolNames) ? output.activation.toolNames : []) {
      const name = String(raw ?? "").trim();
      if (name) nextAllowed.add(name);
    }
    this.config.runCtx.allowedToolNames = nextAllowed;

    if (manifest.portable) {
      const existing = this.config.runCtx.portableSkillContext ?? null;
      const activePortableIds = Array.from(new Set([
        ...(Array.isArray(existing?.activeSkillIds) ? existing!.activeSkillIds : []),
        skillId,
      ]));
      const activePortableManifests = activePortableIds
        .map((id) => this.config.runCtx.skillManifestById?.get(id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item?.portable));
      const allowedToolPolicy = parsePortableAllowedToolPolicy(activePortableManifests as any);
      const existingInputStates = Array.isArray(existing?.inputStates) ? existing!.inputStates : [];
      const inputState = output?.activation?.inputState ?? parsePortableSkillInvocationInput({
        skillId,
        rawArguments: String(output?.activation?.rawArguments ?? "").trim(),
        inputSchema: manifest.inputSchema,
      });
      const nextInputStates = [
        ...existingInputStates.filter((item: any) => String(item?.skillId ?? "").trim() !== skillId),
        ...(inputState ? [inputState] : []),
      ];
      const requestedAgent =
        String(output?.activation?.requestedAgent ?? "").trim() || manifest.agent || undefined;
      const resolvedAgent = resolvePortableSkillAgent(
        requestedAgent,
        this.config.runCtx.subAgentDefinitionById ?? null,
      );
      const contextMode = normalizePortableContextMode(output?.activation?.contextMode ?? manifest.context);
      const existingScopedHighRiskToolNames = Array.isArray(existing?.scopedHighRiskToolNames)
        ? Array.from(new Set(existing.scopedHighRiskToolNames.map((item) => String(item ?? "").trim()).filter(Boolean)))
        : [];
      this.config.runCtx.portableSkillContext = {
        activeSkillIds: activePortableIds,
        primarySkillId: String(existing?.primarySkillId ?? "").trim() || skillId,
        modelOverride:
          String(existing?.modelOverride ?? "").trim() ||
          String(output?.activation?.modelOverride ?? "").trim() ||
          String(manifest.model ?? "").trim() ||
          undefined,
        allowedToolPolicy: allowedToolPolicy ?? undefined,
        executionScope: existing?.executionScope ?? "skill_activation",
        scopedHighRiskToolNames: existingScopedHighRiskToolNames.length > 0 ? existingScopedHighRiskToolNames : undefined,
        inputStates: nextInputStates,
        hooksSkillIds: activePortableManifests
          .filter((item) => item.hooks !== undefined)
          .map((item) => String(item.id ?? "").trim())
          .filter(Boolean),
        fork:
          contextMode === "fork" || resolvedAgent.agentId
            ? {
                skillId,
                agentId: resolvedAgent.agentId,
                requestedAgent: resolvedAgent.requestedAgent,
                mode: contextMode,
              }
            : existing?.fork ?? null,
      };
    }

    const renderedPrompt =
      String(output?.activation?.renderedPrompt ?? "").trim() ||
      (manifest.portable
        ? buildPortableSkillActivationInstructions({
            manifest,
            rawArguments: String(output?.activation?.rawArguments ?? "").trim(),
            inputState: output?.activation?.inputState ?? null,
            allowedToolPolicy: manifest.portable ? parsePortableAllowedToolPolicy([manifest]) : null,
            includeHooksNotice: true,
            sessionId: this.config.runCtx.runId,
          })
        : String(manifest.promptFragments?.system ?? "").trim());
    const modelOverride = String(output?.activation?.modelOverride ?? "").trim();
    const contextMode = normalizePortableContextMode(output?.activation?.contextMode ?? manifest.context);
    const notes: string[] = [
      `Skill /${skillId} 已在当前 run 中激活。接下来优先遵守该 skill 的合同。`,
      renderedPrompt,
    ];
    if (modelOverride && modelOverride !== String(this.config.runCtx.modelId ?? "").trim()) {
      notes.push(`注意：该 skill 声明了 model=${modelOverride}；由于当前 provider run 已启动，该覆盖会从下一次 run 开始生效。`);
    }
    if (contextMode === "fork") {
      notes.push("该 skill 声明了 context=fork：从这一轮开始请把它视为相对独立的 clean-room 子任务，不要依赖未在当前对话里重新给出的历史状态。");
    }
    this._queueRuntimeHint(notes.filter(Boolean).join("\n\n"), ["skills_activate", `skill:${skillId}`]);

    await this._writePortableNotificationNotice({
      turn: this.turn,
      kind: "info",
      title: "DynamicSkillActivated",
      message: `模型通过 ${sourceToolName} 激活了 /${skillId}。`,
      detail: {
        skillId,
        portable: manifest.portable === true,
        contextMode,
        modelOverride: modelOverride || null,
        addedToolNames: Array.isArray(output?.activation?.toolNames) ? output.activation.toolNames : [],
      },
      source: sourceToolName,
    });
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
    if (toolName === "edit" || toolName === "doc.restoreSnapshot") {
      return "doc_edit";
    }
    if (toolName === "write" || toolName === "Bash") {
      return "artifact_write";
    }
    return "other";
  }

  private _isDeliveryCandidateTool(toolName: string): boolean {

    const opMode = (this.config.runCtx as any).opMode === "assistant" ? "assistant" : "creative";
    return isContentWriteTool(toolName) || toolName === "Bash";
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

  private _extractAssistantVisibleText(message: AssistantMessage): string {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type !== "text") continue;
      const sanitized = sanitizeAssistantUserFacingText(part.text, {
        dropPureJsonPayload: true,
      });
      const text = String(sanitized.text ?? "").trim();
      if (!sanitized.dropped && text) parts.push(text);
    }
    return parts.join("\n").trim();
  }

  private async _activateDeliveryLatch(reason: "assistant_text" | "run_done", detail?: Record<string, unknown>): Promise<void> {
    if (this.runState.deliveryLatched) return;
    const families = Array.isArray(this.runState.deliveredArtifactFamilies)
      ? this.runState.deliveredArtifactFamilies.filter(Boolean)
      : [];
    if (families.length <= 0) return;
    this.runState.deliveryLatched = true;
    if (this.runState.deliveryLatchActivatedAtTurn == null) {
      this.runState.deliveryLatchActivatedAtTurn = this.turn;
    }
    await this._writePortableNotificationNotice({
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
      source: "runtime.delivery_latch",
    });
  }


  private async _enforceTurnLevelGuards(ac: AbortController): Promise<void> {
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
        await this._writePortableNotificationNotice({
          turn: this.turn,
          kind: "error",
          title: "ExecutionContractFailed",
          message: "执行达成约束失败：连续重试后仍未触发工具调用。",
          detail: { retries: this.executionNoToolTurns, providerContinuationMode: this.providerCapabilities.continuationMode },
          source: "runtime.execution_contract",
        });
        ac.abort();
      }
    }
  }

  // ── Hook 实现 ──────────────────────────────────

  /**
   * transformContext：每轮 LLM 调用前对上下文做变换。
   * per-turn gating 已移除，仅处理 portable immediate items。
   */
  private async _transformContext(
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const immediateItems = this._drainPortableImmediateItems();
    if (immediateItems.length > 0) {
      const last = messages[messages.length - 1];
      const shouldInsertBeforeTrailingUser = Boolean(last) && (
        (isCanonicalItem(last) && last.kind === "user")
        || (isPiMessage(last) && isUserMsg(last as Message))
      );
      if (shouldInsertBeforeTrailingUser) {
        messages.splice(messages.length - 1, 0, ...immediateItems);
      } else {
        messages.push(...immediateItems);
      }
    }

    return messages;
  }

  /**
   * 软提示收集：这些提示用于"下一轮继续执行/收口"，不能走 steering 通道。
   *
   * pi-agent-core 中 getSteeringMessages 的语义是"用户在当前回合中途插话/转向"，
   * 一旦这里返回消息，会直接跳过当前回合剩余工具调用。此前把 Todo Gate /
   * 执行契约 / 失败修复等软提示塞进 steering，导致 Gemini 在首个工具后把同轮
   * 其他工具误判成 "Skipped due to queued user message."。
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

    if (this.failureDigest.failedCount > this.lastSteeringFailureCount) {
      const failures = this.failureDigest.failedTools;
      const latest = failures[failures.length - 1];
      if (latest) {
        // 统计尾部连续同工具失败次数（只按 name，不比较 error 文本，避免动态内容干扰）
        let consecutive = 1;
        for (let i = failures.length - 2; i >= 0; i -= 1) {
          if (failures[i].name !== latest.name) break;
          consecutive += 1;
        }

        const nextActions =
          Array.isArray(latest.next_actions) && latest.next_actions.length > 0
            ? `\n建议下一步：${latest.next_actions.join("；")}`
            : "";

        if (latest.error === "FILE_OP_PERMISSION_TIMEOUT") {
          if (consecutive === 1) {
            pushHint(
              "写入操作等待用户确认超时，已暂停。你可以告知用户此次文件操作需要手动确认；在用户明确允许前，不要重复发起同一文件操作。",
              ["file_op_permission_timeout"],
            );
          }
        } else if (latest.error === "FILE_OP_PERMISSION_DENIED") {
          // 用户显式拒绝：不注入任何 soft guidance，尊重用户决策
        } else if (consecutive < MAX_TOOL_FAILURE_REPAIR_SERIES) {
          // 正常修复提示（前 1~2 次）
          pushHint(
            `刚刚有工具执行失败：${latest.name}（${latest.error}）。` +
              (latest.message ? `失败原因：${latest.message}。` : "") +
              "请先根据失败结果修复参数、补足前置条件或改用合适工具，不要重复同一失败调用。" +
              nextActions,
            ["tool_failure_repair"],
          );
        } else if (consecutive === MAX_TOOL_FAILURE_REPAIR_SERIES) {
          // 达到上限，明确要求放弃该工具
          pushHint(
            `工具 ${latest.name} 已连续 ${consecutive} 次失败（${latest.error}）。` +
              (latest.message ? `失败原因：${latest.message}。` : "") +
              "请不要再调用该工具；改为向用户说明当前限制或外部系统故障，" +
              "并尝试使用其他可用工具或调整任务范围，如仍无法完成，请诚实说明本轮任务无法完成。" +
              nextActions,
            ["tool_failure_give_up"],
          );
        }
        // consecutive > MAX_TOOL_FAILURE_REPAIR_SERIES: 不再注入任何 hint，
        // 从 runtime 侧彻底停止驱动 \"再试一次\" 的循环
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
   * getSteeringMessages：仅用于"真实用户中途插话/转向"。
   * 当前 GatewayRuntime 尚未实现独立的用户 steering 队列，因此这里必须保持空，
   * 避免把软提示误当成 queued user message，导致同轮剩余工具被跳过。
   */
  private async _getSteeringMessages(): Promise<AgentMessage[]> {
    return [];
  }

  private _resolveStyleWorkflowFollowUp():
    | { item: CanonicalTranscriptItem; phase: string; skillId: "style_imitate" }
    | null {
    const runCtx: any = this.config.runCtx;
    const gates: any = runCtx.gates ?? {};
    const activeSkills = Array.isArray(runCtx.activeSkills) ? runCtx.activeSkills : [];
    const activeSkillIds = activeSkills.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean);
    const styleSkillActive = activeSkillIds.includes("style_imitate");

    if (this._isStyleWorkflowWaitingForUser({ styleSkillActive })) {
      return null;
    }

    if (!(styleSkillActive && gates.styleGateEnabled && gates.lintGateEnabled && runCtx.intent?.isWritingTask)) {
      return null;
    }

    const st: any = this.runState as any;
    const wfDecls: Map<string, WorkflowDeclaration> | undefined = runCtx.activeWorkflowDeclarations;
    const wfWorkflow = wfDecls?.get("style_imitate");
    if (!wfWorkflow) return null;
    const followUpMsg = resolveFollowUp(wfWorkflow, st);
    if (!followUpMsg) return null;
    const snapshot = resolvePhase(wfWorkflow, st);
    return {
      skillId: "style_imitate",
      phase: String(snapshot.currentPhase ?? "unknown").trim() || "unknown",
      item: {
        kind: "runtime_hint",
        text: followUpMsg,
        reasonCodes: ["style_workflow_followup", "phase:" + String(snapshot.currentPhase ?? "unknown").trim()],
      },
    };
  }

  private _isStyleWorkflowWaitingForUser(args?: { styleSkillActive?: boolean }): boolean {
    const runCtx: any = this.config.runCtx;
    const mainDoc: any = runCtx?.mainDoc && typeof runCtx.mainDoc === "object" ? runCtx.mainDoc : {};
    const taskState = mainDoc?.taskStateV2 && typeof mainDoc.taskStateV2 === "object" ? mainDoc.taskStateV2 : null;
    const workflowRaw = taskState?.workflow ?? null;
    const workflowObj = workflowRaw && typeof workflowRaw === "object" && !Array.isArray(workflowRaw) ? workflowRaw : null;
    const threadWaitingFor = String(mainDoc?.threadWaitingFor ?? mainDoc?.waitingFor ?? "").trim().toLowerCase();
    const workflowStatus = String(
      threadWaitingFor === "user"
        ? "waiting_user"
        : threadWaitingFor === "approval"
          ? "waiting_approval"
          : typeof workflowRaw === "string"
            ? workflowRaw
            : workflowObj?.status ?? "",
    ).trim().toLowerCase();
    const workflowKind = String(
      workflowObj?.kind ?? mainDoc?.workflowKind ?? "",
    ).trim().toLowerCase();
    const currentPhase = String(
      mainDoc?.currentPhase ?? workflowObj?.currentPhase ?? "",
    ).trim().toLowerCase();
    const waitingQuestion = String(
      mainDoc?.constraint ??
      workflowObj?.constraint ??
      workflowObj?.waiting?.question ??
      "",
    ).trim();
    const waitingStatuses = new Set(["waiting_user", "waiting", "clarify_waiting", "proposal_waiting", "approval_waiting", "waiting_approval"]);
    const waitingPhases = new Set([
      "need_topic",
      "need_style_library",
      "need_style_library_choice",
      "need_library",
      "need_clarification",
      "await_user_input",
    ]);
    const styleSkillActive = Boolean(args?.styleSkillActive);
    const styleWorkflowLike =
      styleSkillActive ||
      /style_imitate/.test(workflowKind) ||
      currentPhase.startsWith("need_");
    if (!styleWorkflowLike) return false;
    if (waitingPhases.has(currentPhase)) return true;
    if (waitingStatuses.has(workflowStatus) && (Boolean(waitingQuestion) || Boolean(currentPhase))) return true;
    return false;
  }

  /**
   * getFollowUpMessages：循环即将结束时的追加消息（阻止过早结束）。
   * - 如果 run.done 已触发，不追加（尊重显式终止信号）
   * - 如果有未完成的 todo，注入追问让 Agent 继续
   * - 如果 hasPlanCommitment 但无工具调用，提醒执行
   */
  private async _getFollowUpMessages(): Promise<AgentMessage[]> {
    // run.done 已触发，不再追加
    if (
      this.outcome.reason === "run_done" ||
      this.outcome.reason === "approval_waiting" ||
      this.outcome.reason === "silent_no_output"
    ) return [];

    // max_tokens 续写：注入续写提示让模型从中断处继续
    if (this.pendingMaxTokensRecovery) {
      this.pendingMaxTokensRecovery = false;
      this.lastStopReason = null;
      this.maxTokensRecoveryCount += 1;
      this.config.runCtx.writeEvent("max_tokens_recovery.inject", {
        turn: this.turn,
        count: this.maxTokensRecoveryCount,
      });
      const item: CanonicalTranscriptItem = {
        kind: "runtime_hint",
        text: "上一轮输出因达到 token 上限被截断。请从中断处直接继续，不要道歉，不要回顾，不要重述。",
        reasonCodes: ["max_tokens_recovery"],
      };
      return [item as unknown as AgentMessage];
    }

    if (this.pendingFollowUpItems.length > 0) {
      const items = this.pendingFollowUpItems
        .splice(0, this.pendingFollowUpItems.length)
        .map((item) => item as unknown as AgentMessage);
      if (items.length > 0) return items;
    }

    const stopHook = await this._runPortableHookEvent({
      eventName: "Stop",
      stopReason: this.outcome.reason || "completed",
    });
    if (stopHook.blocked) {
      await this._schedulePortableStopContinuation({
        eventName: "Stop",
        blockMessage: stopHook.blockMessage,
        detail: {
          stopReason: this.outcome.reason || "completed",
        },
      });
    }
    if (this.pendingFollowUpItems.length > 0) {
      const items = this.pendingFollowUpItems
        .splice(0, this.pendingFollowUpItems.length)
        .map((item) => item as unknown as AgentMessage);
      if (items.length > 0) return items;
    }

    // Agent 正在向用户提问/等待确认时，不注入任何 follow-up，交还控制权
    const lastTextForFollowUp = this._getLastAssistantText();
    if (lastTextForFollowUp && this._detectAssistantAskingUser(lastTextForFollowUp)) {
      return [];
    }

    const styleFollowUp = this._resolveStyleWorkflowFollowUp();
    if (styleFollowUp) {
      const st: any = this.runState as any;
      const budget = Math.max(0, Math.floor(Number(st.workflowRetryBudget ?? 0)));
      if (budget > 0) {
        st.workflowRetryBudget = budget - 1;
        try {
          await this._writePortableNotificationNotice({
            turn: this.turn,
            kind: "warn",
            title: "StyleWorkflowTextBlocked",
            message:
              `检测到 ${styleFollowUp.skillId} 已启用但尚未完成风格闭环（phase=${styleFollowUp.phase}），本轮纯文本收口已被拦截，将注入 runtime_hint。`,
            source: "runtime.follow_up",
          });
        } catch {
          // 非关键路径，忽略审计异常
        }
        return [styleFollowUp.item as unknown as AgentMessage];
      }
    }

    // 模型已输出一轮可见正文但无工具，说明最近一次工具失败
    // 已被语义层处理过（总结/解释原因等）。此时提前消耗 failure 计数，避免
    // tool_failure_repair 在 followUp 通道再追加一轮"自言自语"式提示。
    if (
      this.consecutiveVisibleNoToolTurns >= 1 &&
      this.failureDigest.failedCount > this.lastSteeringFailureCount
    ) {
      this.lastSteeringFailureCount = this.failureDigest.failedCount;
    }

    // 如果模型最后一条消息正在向用户提问/等待确认，则认为当前回合应交还控制权给用户，
    // 不再追加任何软提示或追问，避免在"等待用户"场景下继续自言自语重试工具。
    const lastText = this._getLastAssistantText();
    if (lastText && this._detectAssistantAskingUser(lastText)) {
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

  /**
   * 检测 Agent 最后一条文本是否在向用户提问/等待用户做决定。
   * 三层检测，避免"长文本中部有问句但尾部声明句"导致漏判。
   */
  private _detectAssistantAskingUser(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;

    const tail = t.slice(-400);

    // 层 1：尾部短窗直接命中提问模式（扩大到 400 字符）
    const tailAskPattern =
      /[？?]\s*$|要[^。\n]{0,12}吗[？?]?|还是[^。\n]{0,16}[？?]|(?:你|您)[^。\n]{0,16}(?:偏好|更倾向|选择|打算|决定)[^。\n]{0,12}[？?]?|帮你[^。\n]{0,16}[？?]|需要[^。\n]{0,12}确认|请[^。\n]{0,16}选择|请[^。\n]{0,16}告诉我|告诉我/;
    if (tailAskPattern.test(tail)) return true;

    // 层 1.5：尾部"行动宣示"模式——Agent 表达"确认后我就/我直接 做某事"，
    // 语义上在等用户确认，但文本不含问号也不含第二人称。
    const tailActionPlanPattern =
      /(?:确认|没问题|没有问题|觉得可以|ok|OK|可以的话|没问题的话|没有异议)[^。！？\n]{0,15}(?:我就|我会|我直接|我立即|我马上|我开始|就开始|我来|就来)/;
    if (tailActionPlanPattern.test(tail)) return true;

    const tailActionPlanPattern2 =
      /(?:如果|等你?|待|一旦)[^。！？\n]{0,15}(?:确认|没问题|同意|认可)[^。！？\n]{0,15}(?:我就|我会|我直接|我立即|我马上|我开始|就开始|我来|就来)/;
    if (tailActionPlanPattern2.test(tail)) return true;

    // 层 2+3：全文有"向用户提问/选择"的句子 + 尾部处于"等待用户决策"语气
    if (this._textHasUserDirectedQuestion(t) && this._textTailWaitsForUser(tail)) {
      return true;
    }

    return false;
  }

  /**
   * 检测文本中是否包含向用户直接提问/请求选择的句子。
   * 要求含第二人称（你/您）且有选择/确认类动词，排除引用/举例句式。
   */
  private _textHasUserDirectedQuestion(text: string): boolean {
    const sentences = text.split(/(?<=[。！？!?\n])/);
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s || s.length < 4) continue;
      // 排除引用/举例/说明类前缀
      if (/^(?:例如|比如|举例|常见问题|用户(?:通常|可能)会问|注意|备注|提示)/.test(s)) continue;
      // 要求第二人称 + 选择/确认类动词
      if (/(你|您)/.test(s) && /(选择|确认|决定|告诉我|告知|偏好|倾向|需要.*吗|要.*吗|还是)/.test(s)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检测尾部文本是否处于"等待用户做决定"的语气。
   * 用于与 _textHasUserDirectedQuestion 配合——
   * 当全文曾问过问题且尾部在等待用户回应时，判定为 asking user。
   */
  private _textTailWaitsForUser(tail: string): boolean {
    const t = String(tail ?? "").trim();
    if (!t) return false;
    const pattern =
      /(?:你|您)(?:告诉我|选|决定|确认|回复)|(?:选好|确认|决定)(?:之后|后)(?:我再|再)|(?:以上|上面)(?:是|为).{0,20}(?:方案|选项|材料|清单)|先.*(?:确认|决定)|(?:个人|企业).*(?:备案|选择)/;
    return pattern.test(t);
  }

  private _portableHookProjectDir() {
    const ideSummary =
      this.config.runCtx.toolSidecar && typeof this.config.runCtx.toolSidecar === "object"
        ? (this.config.runCtx.toolSidecar as any).ideSummary ?? null
        : null;
    const projectDir = String(ideSummary?.projectDir ?? "").trim();
    return projectDir || process.cwd();
  }

  private _derivePortableSessionStartSource(): string {
    const compactHint =
      this.config.runCtx.portablePreRunCompact &&
      typeof this.config.runCtx.portablePreRunCompact === "object" &&
      !Array.isArray(this.config.runCtx.portablePreRunCompact)
        ? (this.config.runCtx.portablePreRunCompact as Record<string, unknown>)
        : null;
    if (String(compactHint?.scope ?? "").trim().toLowerCase() === "dialogue_summary") return "compact";
    const waitingFor = String(
      this.config.runCtx.threadSnapshotHint?.waitingFor ??
      this.config.runCtx.mainDoc?.threadWaitingFor ??
      this.config.runCtx.mainDoc?.waitingFor ??
      "",
    ).trim().toLowerCase();
    if (waitingFor === "user" || waitingFor === "approval") return "resume";
    const workflow =
      this.config.runCtx.mainDoc?.taskStateV2 &&
      typeof this.config.runCtx.mainDoc.taskStateV2 === "object" &&
      !Array.isArray(this.config.runCtx.mainDoc.taskStateV2)
        ? (this.config.runCtx.mainDoc.taskStateV2 as Record<string, unknown>).workflow
        : null;
    const workflowObj = workflow && typeof workflow === "object" && !Array.isArray(workflow)
      ? (workflow as Record<string, unknown>)
      : null;
    const workflowStatus = String(workflowObj?.status ?? "").trim().toLowerCase();
    if (workflowStatus === "waiting_user" || workflowStatus === "waiting_approval") return "resume";
    const resumeAction = workflowObj?.resumeAction;
    if (resumeAction && typeof resumeAction === "object" && !Array.isArray(resumeAction)) return "resume";
    return "startup";
  }

  private _portableHookMatcherTargets(args: {
    eventName: PortableHookEventName;
    toolName?: string;
    notification?: Record<string, unknown> | null;
    compact?: Record<string, unknown> | null;
    subagent?: Record<string, unknown> | null;
    permissionRequest?: Record<string, unknown> | null;
    sessionSource?: string;
  }): string[] {
    const out: string[] = [];
    const push = (value: unknown) => {
      const text = String(value ?? "").trim();
      if (!text) return;
      if (!out.some((item) => item.toLowerCase() === text.toLowerCase())) out.push(text);
    };
    if (args.toolName) {
      push(toPortableToolAliasName(args.toolName));
      push(args.toolName);
    }
    switch (args.eventName) {
      case "SessionStart":
        push(args.sessionSource ?? this.portableSessionStartSource);
        break;
      case "Notification":
        push(args.notification?.notification_type);
        push(args.notification?.title);
        push(args.notification?.source);
        push(args.notification?.kind);
        break;
      case "PreCompact":
      case "PostCompact":
        push(args.compact?.trigger);
        push(args.compact?.scope);
        break;
      case "PermissionRequest":
        push(args.permissionRequest?.request_kind);
        break;
      case "SubagentStart":
      case "SubagentStop":
        push(args.subagent?.agent);
        break;
      default:
        break;
    }
    return out;
  }

  private _portableHookCommandShellRules(skillId: string): Array<{
    raw: string;
    kind: "any" | "command_pattern";
    specifier?: string;
  }> {
    const manifest = this.config.runCtx.skillManifestById?.get(skillId);
    const policy = parsePortableAllowedToolPolicy(manifest ? [manifest] : []);
    if (!policy?.rules?.length) return [];
    return policy.rules
      .filter((rule) => rule.toolName === "Bash" && (rule.kind === "any" || rule.kind === "command_pattern"))
      .map((rule) => ({
        raw: String(rule.raw ?? "").trim(),
        kind: rule.kind === "command_pattern" ? "command_pattern" : "any",
        ...(typeof rule.specifier === "string" && rule.specifier.trim() ? { specifier: rule.specifier.trim() } : {}),
      }));
  }

  private _selectPortableHookMatchers(args: {
    eventName: PortableHookEventName;
    matcherTargets?: string[];
  }) {
    const skillIds = Array.isArray(this.config.runCtx.portableSkillContext?.activeSkillIds)
      ? this.config.runCtx.portableSkillContext!.activeSkillIds
      : [];
    const matcherTargets = Array.isArray(args.matcherTargets) ? args.matcherTargets.filter(Boolean) : [];
    const selected: Array<{ skillId: string; hooks: PortableHookHandler[] }> = [];

    for (const skillIdRaw of skillIds) {
      const skillId = String(skillIdRaw ?? "").trim();
      if (!skillId) continue;
      const manifest = this.config.runCtx.skillManifestById?.get(skillId);
      if (!manifest?.portable || manifest.hooks === undefined || !manifest.hooks || typeof manifest.hooks !== "object") {
        continue;
        }
      const rawEventHooks = (manifest.hooks as Record<string, unknown>)[args.eventName];
      const matchers = normalizePortableHookMatchers(rawEventHooks);
      for (const matcher of matchers) {
        const targetHit =
          matcherTargets.length === 0 ||
          matcherTargets.some((target) => portableHookMatcherMatches(matcher.matcher, target));
        if (!targetHit) continue;
        if (matcher.hooks.length > 0) {
          selected.push({ skillId, hooks: matcher.hooks });
        }
      }
    }

    return selected;
  }

  private _buildPortableHookInput(args: {
    eventName: PortableHookEventName;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    toolError?: unknown;
    userPrompt?: string;
    subagent?: Record<string, unknown> | null;
    sessionSource?: string;
    stopReason?: string;
    notification?: Record<string, unknown> | null;
    permissionRequest?: Record<string, unknown> | null;
    compact?: Record<string, unknown> | null;
  }) {
    const base: Record<string, unknown> = {
      session_id: this.config.runCtx.runId,
      transcript_path: null,
      cwd: this._portableHookProjectDir(),
      hook_event_name: args.eventName,
      permission_mode: mapPortablePermissionMode(this.config.runCtx.opMode),
    };
    const toolAlias = args.toolName ? toPortableToolAliasName(args.toolName) : "";
    switch (args.eventName) {
      case "UserPromptSubmit":
        return { ...base, prompt: String(args.userPrompt ?? "") };
      case "SessionStart":
        return {
          ...base,
          prompt: String(args.userPrompt ?? ""),
          source: String(args.sessionSource ?? this.portableSessionStartSource).trim() || "startup",
        };
      case "Notification":
        return {
          ...base,
          title: String(args.notification?.title ?? "").trim(),
          message: String(args.notification?.message ?? "").trim(),
          kind: String(args.notification?.kind ?? "").trim(),
          source: String(args.notification?.source ?? "").trim(),
          notification_type: String(args.notification?.notification_type ?? args.notification?.title ?? "").trim(),
          detail: args.notification?.detail ?? null,
          notification: args.notification ?? null,
        };
      case "PermissionRequest":
        return {
          ...base,
          tool_name: toolAlias || args.toolName || "",
          tool_input: args.toolArgs ?? {},
          request_kind: String(args.permissionRequest?.request_kind ?? "").trim(),
          reason: String(args.permissionRequest?.reason ?? "").trim(),
          message: String(args.permissionRequest?.message ?? "").trim(),
          decision_source: String(args.permissionRequest?.decision_source ?? "").trim(),
          permission_request: args.permissionRequest ?? null,
        };
      case "PreToolUse":
        return { ...base, tool_name: toolAlias || args.toolName || "", tool_input: args.toolArgs ?? {} };
      case "PostToolUse":
        return {
          ...base,
          tool_name: toolAlias || args.toolName || "",
          tool_input: args.toolArgs ?? {},
          tool_response: args.toolResult ?? null,
        };
      case "PostToolUseFailure":
        return {
          ...base,
          tool_name: toolAlias || args.toolName || "",
          tool_input: args.toolArgs ?? {},
          tool_response: args.toolError ?? null,
        };
      case "PreCompact":
      case "PostCompact":
        return {
          ...base,
          tool_name: toolAlias || args.toolName || "",
          trigger: String(args.compact?.trigger ?? "").trim(),
          scope: String(args.compact?.scope ?? "").trim(),
          custom_instructions: String(args.compact?.custom_instructions ?? "").trim(),
          compact_summary: String(args.compact?.compact_summary ?? "").trim(),
          compact: args.compact ?? null,
          tool_response: args.toolResult ?? null,
        };
      case "SubagentStart":
      case "SubagentStop":
        return { ...base, subagent: args.subagent ?? null };
      case "Stop":
      case "SessionEnd":
        return { ...base, stop_reason: args.stopReason ?? this.outcome.reason ?? null };
      default:
        return base;
    }
  }

  private async _executePortableHookHandler(args: {
    skillId: string;
    eventName: PortableHookEventName;
    handler: PortableHookHandler;
    input: Record<string, unknown>;
  }): Promise<PortableHookInvocationResult> {
    const keySeed =
      args.handler.command ??
      args.handler.url ??
      args.handler.prompt ??
      `${args.handler.type}:${args.eventName}`;
    const onceKey = `${args.skillId}:${args.eventName}:${args.handler.type}:${keySeed}`;
    if (args.handler.once && this.executedPortableHookOnceKeys.has(onceKey)) {
      return {};
    }

    const commitOnce = () => {
      if (args.handler.once) this.executedPortableHookOnceKeys.add(onceKey);
    };

    if (args.handler.type === "command") {
      const command = String(args.handler.command ?? "").trim();
      if (!command) return {};
      const timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(Number(args.handler.timeoutMs ?? 20_000) || 20_000)));
      if (this.shadowMode === "shadow") {
        await this._writePortableNotificationNotice({
          turn: this.turn,
          kind: "info",
          title: "PortableHookCommandShadowDryRun",
          message: `shadow 模式跳过 portable hook command（${args.skillId}/${args.eventName}）。`,
          detail: { command, timeoutMs },
          source: "portable_hook.internal",
        });
        return {};
      }
      const toolCallId = `${this.config.runCtx.runId}:portable-hook:${++this.portableHookInvocationSeq}`;
      const result = await this._waitForDesktopToolResult(toolCallId, PORTABLE_HOOK_COMMAND_TOOL_NAME, {
        skillId: args.skillId,
        eventName: args.eventName,
        projectDir: this._portableHookProjectDir(),
        command,
        stdinJson: args.input,
        timeoutMs,
        shellRules: this._portableHookCommandShellRules(args.skillId),
        opMode: (this.config.runCtx.opMode === "assistant" ? "assistant" : "creative"),
      });
      const output = result.output && typeof result.output === "object" && !Array.isArray(result.output)
        ? (result.output as Record<string, unknown>)
        : {};
      const stdout = String(output.stdout ?? "");
      const stderr = String(output.stderr ?? "");
      const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
      const timedOut = output.timedOut === true;
      const jsonText = extractJsonObjectLoose(stdout);
      if (jsonText) {
        try {
          const parsed = normalizePortableHookResult(JSON.parse(jsonText));
          commitOnce();
          return parsed;
        } catch {
          // ignore malformed JSON and fall through
        }
      }
      if (exitCode === 2) {
        commitOnce();
        return {
          continue: false,
          systemMessage: stderr.trim() || `Portable hook blocked ${args.eventName}.`,
        };
      }
      if (!result.ok || timedOut || (exitCode !== null && exitCode !== 0)) {
        await this._writePortableNotificationNotice({
          turn: this.turn,
          kind: "warn",
          title: "PortableHookCommandFailed",
          message: `Portable hook command failed (${args.skillId}/${args.eventName}).`,
          detail: {
            exitCode,
            timedOut,
            stderr: stderr.trim().slice(0, 1000),
            error: String(output.error ?? "").trim() || null,
          },
          source: "portable_hook.internal",
        });
        return {};
      }
      const stdoutText = stdout.trim();
      if (stdoutText && (args.eventName === "SessionStart" || args.eventName === "UserPromptSubmit")) {
        commitOnce();
        return {
          hookSpecificOutput: {
            additionalContext: stdoutText,
          },
        };
      }
      commitOnce();
      return {};
    }

    if (args.handler.type === "http") {
      const url = String(args.handler.url ?? "").trim();
      if (!url) return {};
      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(Number(args.handler.timeoutMs ?? 20_000) || 20_000)));
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: String(args.handler.method ?? "POST").trim() || "POST",
          headers: {
            "Content-Type": "application/json",
            ...(args.handler.headers ?? {}),
          },
          body: JSON.stringify(args.input),
          signal: controller.signal,
        });
        const text = await res.text().catch(() => "");
        clearTimeout(timer);
        const jsonText = extractJsonObjectLoose(text);
        if (jsonText) {
          try {
            const parsed = normalizePortableHookResult(JSON.parse(jsonText));
            commitOnce();
            return parsed;
          } catch {
            // ignore malformed JSON
          }
        }
        if (!res.ok) {
          await this._writePortableNotificationNotice({
            turn: this.turn,
            kind: "warn",
            title: "PortableHookHttpFailed",
            message: `Portable hook HTTP failed (${args.skillId}/${args.eventName}).`,
            detail: { status: res.status, url },
            source: "portable_hook.internal",
          });
        }
        commitOnce();
        return {};
      } catch (error) {
        clearTimeout(timer);
        await this._writePortableNotificationNotice({
          turn: this.turn,
          kind: "warn",
          title: "PortableHookHttpFailed",
          message: `Portable hook HTTP failed (${args.skillId}/${args.eventName}).`,
          detail: { url, error: toErrorMessage(error) },
          source: "portable_hook.internal",
        });
        return {};
      }
    }

    const prompt = String(args.handler.prompt ?? "").trim();
    if (!prompt || !this.config.runCtx.apiKey || !this.config.runCtx.modelId) return {};
    try {
      const res = await completionOnceViaProvider({
        baseUrl: this.config.runCtx.baseUrl || "",
        endpoint: this.config.runCtx.endpoint || "/v1/chat/completions",
        apiKey: this.config.runCtx.apiKey,
        model: String(args.handler.model ?? "").trim() || this.config.runCtx.modelId,
        temperature: 0,
        maxTokens: 500,
        messages: [
          {
            role: "system",
            content:
              `You are executing a Claude Code compatible ${args.handler.type} hook.\n` +
              "Return only one JSON object. Do not use Markdown.\n" +
              "Supported top-level fields: continue(boolean), systemMessage(string), decision(object), hookSpecificOutput(object).",
          },
          {
            role: "user",
            content:
              `${prompt}\n\n[Hook Event]\n${args.eventName}\n\n[Hook Input JSON]\n${JSON.stringify(args.input, null, 2)}`,
          },
        ],
      });
      if (!res.ok) return {};
      const jsonText = extractJsonObjectLoose(res.content);
      if (!jsonText) return {};
      const parsed = normalizePortableHookResult(JSON.parse(jsonText));
      commitOnce();
      return parsed;
    } catch {
      return {};
    }
  }

  private async _runPortableHookEvent(args: {
    eventName: PortableHookEventName;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    toolError?: unknown;
    userPrompt?: string;
    subagent?: Record<string, unknown> | null;
    sessionSource?: string;
    stopReason?: string;
    notification?: Record<string, unknown> | null;
    permissionRequest?: Record<string, unknown> | null;
    compact?: Record<string, unknown> | null;
  }): Promise<{
    blocked?: boolean;
    blockMessage?: string;
    updatedArgs?: Record<string, unknown>;
    hookMessage?: string;
    permissionBehavior?: PortablePermissionBehavior;
    approvalRequest?: Record<string, unknown>;
  }> {
    const selected = this._selectPortableHookMatchers({
      eventName: args.eventName,
      matcherTargets: this._portableHookMatcherTargets(args),
    });
    if (selected.length === 0) {
      return { updatedArgs: args.toolArgs && typeof args.toolArgs === "object" ? { ...args.toolArgs } : {} };
    }
    let updatedArgs = args.toolArgs && typeof args.toolArgs === "object" ? { ...args.toolArgs } : {};
    let hookMessage = "";
    this.activePortableHookEventStack.push(args.eventName);
    try {
      for (const entry of selected) {
        for (const handler of entry.hooks) {
          const input = this._buildPortableHookInput({
            ...args,
            toolArgs: updatedArgs,
          });
          const result = await this._executePortableHookHandler({
            skillId: entry.skillId,
            eventName: args.eventName,
            handler,
            input,
          });
          if (result.systemMessage) {
            this._queuePortableHookContext(
              args.eventName,
              `[Portable Hook:${entry.skillId}/${args.eventName}]\n${result.systemMessage}`,
              ["portable_hook", `hook:${args.eventName.toLowerCase()}`, `skill:${entry.skillId}`],
            );
          }
          const hookOutput =
            result.hookSpecificOutput && typeof result.hookSpecificOutput === "object"
              ? result.hookSpecificOutput
              : null;
          const additionalContext = String(hookOutput?.additionalContext ?? "").trim();
          if (additionalContext) {
            this._queuePortableHookContext(
              args.eventName,
              `[Portable Hook Context:${entry.skillId}/${args.eventName}]\n${additionalContext}`,
              ["portable_hook_context", `skill:${entry.skillId}`],
            );
          }
          const hookMessageCandidate =
            String(hookOutput?.permissionDecisionReason ?? "").trim() ||
            String(hookOutput?.message ?? "").trim() ||
            String(result.decision?.reason ?? "").trim() ||
            "";
          const updatedInput =
            hookOutput?.updatedInput && typeof hookOutput.updatedInput === "object" && !Array.isArray(hookOutput.updatedInput)
              ? (hookOutput.updatedInput as Record<string, unknown>)
              : null;
          if (updatedInput) updatedArgs = updatedInput;
          if (args.eventName === "PermissionRequest") {
            const decisionObject =
              hookOutput?.decision && typeof hookOutput.decision === "object" && !Array.isArray(hookOutput.decision)
                ? (hookOutput.decision as Record<string, unknown>)
                : hookOutput?.approvalRequest && typeof hookOutput.approvalRequest === "object" && !Array.isArray(hookOutput.approvalRequest)
                  ? (hookOutput.approvalRequest as Record<string, unknown>)
                  : null;
            const permissionBehavior = normalizePortablePermissionBehavior(
              hookOutput?.permissionDecision ??
              decisionObject?.behavior ??
              decisionObject?.action ??
              decisionObject?.decision ??
              result.decision?.decision,
            );
            const approvalRequest =
              decisionObject &&
              (
                Boolean(String(decisionObject.question ?? decisionObject.prompt ?? "").trim()) ||
                Boolean(String(decisionObject.note ?? "").trim()) ||
                decisionObject.detail !== undefined ||
                decisionObject.updatedInput !== undefined ||
                ["approval", "ask", "request_approval", "approval_required", "wait_user", "defer"].includes(
                  String(decisionObject.behavior ?? decisionObject.action ?? decisionObject.decision ?? "").trim().toLowerCase(),
                )
              )
                ? decisionObject
                : null;
            if (permissionBehavior) {
              return {
                updatedArgs,
                hookMessage: hookMessageCandidate || undefined,
                permissionBehavior,
                ...(approvalRequest ? { approvalRequest } : {}),
              };
            }
            if (approvalRequest) {
              return {
                updatedArgs,
                hookMessage: hookMessageCandidate || undefined,
                approvalRequest,
              };
            }
            if (hookMessageCandidate) hookMessage = hookMessageCandidate;
          }
          if (args.eventName === "Stop" || args.eventName === "SubagentStop") {
            const blockedByDecision =
              result.continue === false ||
              String(result.decision?.decision ?? "").trim().toLowerCase() === "block";
            if (blockedByDecision) {
              return {
                blocked: true,
                blockMessage:
                  hookMessageCandidate ||
                  String(result.decision?.reason ?? "").trim() ||
                  result.systemMessage ||
                  `Portable hook blocked ${args.eventName}.`,
                updatedArgs,
              };
            }
          }
          if (args.eventName === "PreToolUse") {
            const permissionDecision = String(hookOutput?.permissionDecision ?? "").trim().toLowerCase();
            const permissionDecisionReason = String(hookOutput?.permissionDecisionReason ?? "").trim();
            const blockedByDecision =
              result.continue === false ||
              permissionDecision === "deny" ||
              String(result.decision?.decision ?? "").trim().toLowerCase() === "block";
            if (blockedByDecision) {
              return {
                blocked: true,
                blockMessage:
                  permissionDecisionReason ||
                  String(result.decision?.reason ?? "").trim() ||
                  result.systemMessage ||
                  `Portable hook blocked ${args.toolName ?? "tool"}.`,
                updatedArgs,
              };
            }
          }
        }
      }
    } finally {
      this.activePortableHookEventStack.pop();
    }
    return { updatedArgs, hookMessage: hookMessage || undefined };
  }

  // ── 工具构建 ───────────────────────────────────

  /**
   * 将 TOOL_LIST + sidecar MCP 工具转为 pi-agent-core 的 AgentTool[]。
   * 工具名经过 encodeToolName 编码（dot → _dot_），兼容 OpenAI / Gemini 的 function name 限制。
   * execute 回调用原始名路由执行（MCP 工具走 _executeAgentTool → desktop）。
   */
  private _buildAgentTools(visibleAllowed?: Set<string> | null): AgentTool<any>[] {
    const allowed = visibleAllowed instanceof Set ? visibleAllowed : this.config.runCtx.allowedToolNames;
    const mode = this.config.runCtx.mode;

    // 被 Bash/Agent wrapper 吞掉的 legacy 名
    const COLLAPSED = new Set([
            "spawn_agent", "send_input", "resume_agent", "wait_agent", "close_agent",
    ]);

    // ── 内置工具（参考 CC：单层过滤，modes:[] 直接排除）──
    const builtins = TOOL_LIST
      .filter((tool) => {
        if (Array.isArray(tool.modes) && tool.modes.length === 0) return false;
        if (Array.isArray(tool.modes) && tool.modes.length > 0 && !tool.modes.includes(mode)) return false;
        if (allowed.size > 0 && !allowed.has(tool.name)) return false;
        if (COLLAPSED.has(tool.name)) return false;
        return true;
      })
      .map((tool) => {
        const publicName = normalizeToPublicToolName(tool.name);
        return {
          name: this._encodeRuntimeToolName(publicName),
          label: publicName,
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
            const result = await this._executeAgentTool(toolCallId, tool.name, params ?? {});
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

    // ── 合成 Bash wrapper（shell.exec + code.exec）──
    // Bash wrapper 无条件创建——可见性不依赖 B2 选择
    const hasBash = true;
    const bashWrapper: AgentTool<any>[] = hasBash ? [{
      name: this._encodeRuntimeToolName("Bash"),
      label: "Bash",
      description:
        "执行本机命令或脚本（高风险）。\n" +
        "传 command：在项目工作目录执行 shell 命令。\n" +
        "传 code 或 entryFile：执行 Python 代码，支持 pip 依赖和产物回收。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "命令名或完整命令行" },
          args: { type: "array", items: { type: "string" }, description: "参数数组" },
          cwd: { type: "string", description: "工作目录（默认项目目录）" },
          runtime: { type: "string", description: "运行时（默认 python）" },
          code: { type: "string", description: "内联代码" },
          entryFile: { type: "string", description: "项目内脚本路径" },
          requirements: { type: "array", items: { type: "string" }, description: "pip 依赖" },
          timeoutMs: { type: "number", description: "超时毫秒" },
          artifactGlobs: { type: "array", items: { type: "string" }, description: "产物 glob" },
        },
        additionalProperties: true,
      } as any,
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        const result = await this._executeAgentTool(toolCallId, "Bash", params ?? {});
        this.toolCallSnapshots.set(toolCallId, { args: params ?? {}, executedBy: result.executedBy, dryRun: result.dryRun });
        if (!result.ok) throw new Error(normalizeToolOutputText(result.output));
        return { content: buildTextContent(normalizeToolOutputText(result.output)), details: result };
      },
    }] : [];

    // ── 合成 Agent wrapper（spawn/send/resume/wait/close）──
    const hasAgent = true;
    const agentWrapper: AgentTool<any>[] = hasAgent ? [{
      name: this._encodeRuntimeToolName("Agent"),
      label: "Agent",
      description:
        "统一的子 Agent 生命周期工具。\n" +
        "action=spawn|send|resume|wait|close",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "spawn|send|resume|wait|close" },
          id: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
          agent_type: { type: "string" },
          message: { type: "string" },
          items: { type: "array", items: { type: "object" } },
          model: { type: "string" },
          reasoning_effort: { type: "string" },
          fork_context: { type: "boolean" },
          interrupt: { type: "boolean" },
          timeout_ms: { type: "number" },
        },
        required: ["action"],
        additionalProperties: true,
      } as any,
      execute: async (toolCallId: string, params: Record<string, unknown>) => {
        const legacyName = resolveRuntimeToolName("Agent", params);
        const result = await this._executeAgentTool(toolCallId, legacyName, params ?? {});
        this.toolCallSnapshots.set(toolCallId, { args: params ?? {}, executedBy: result.executedBy, dryRun: result.dryRun });
        if (!result.ok) throw new Error(normalizeToolOutputText(result.output));
        return { content: buildTextContent(normalizeToolOutputText(result.output)), details: result };
      },
    }] : [];

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

    return [...builtins, ...bashWrapper, ...agentWrapper, ...mcpTools];
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
    let toolArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs
      : {};
    const finalizeToolResult = async (result: GatewayToolExecResult): Promise<GatewayToolExecResult> => {
      if (result.ok) {
        await this._runPortableHookEvent({
          eventName: "PostToolUse",
          toolName,
          toolArgs,
          toolResult: result.output,
        });
      } else {
        await this._runPortableHookEvent({
          eventName: "PostToolUseFailure",
          toolName,
          toolArgs,
          toolError: result.output,
        });
      }
      return result;
    };

    const preHook = await this._runPortableHookEvent({
      eventName: "PreToolUse",
      toolName,
      toolArgs,
    });
    if (preHook.updatedArgs && typeof preHook.updatedArgs === "object") {
      toolArgs = preHook.updatedArgs;
    }
    if (preHook.blocked) {
      const deniedMessage = preHook.blockMessage || `Portable hook blocked tool "${toolName}".`;
      const permissionHook = await this._emitPortablePermissionRequest({
        toolName,
        toolArgs,
        errorCode: "PORTABLE_SKILL_HOOK_DENIED",
        decisionSource: "portable_hook_pre_tool_use",
        message: deniedMessage,
        detail: { toolName, toolArgs },
        approvalEligible: true,
        allowCanProceed: true,
      });
      if (permissionHook.approvalRequested) {
        return finalizeToolResult({
          ok: false,
          output: {
            ok: false,
            error: "APPROVAL_REQUIRED",
            message: permissionHook.approvalQuestion || permissionHook.hookMessage || deniedMessage,
            approvalId: permissionHook.approvalId ?? null,
          },
          executedBy: "gateway",
        });
      }
      if (permissionHook.permissionBehavior === "allow") {
        toolArgs = permissionHook.updatedArgs ?? toolArgs;
      } else {
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "warn",
        title: "PortableHookBlockedTool",
        message: permissionHook.hookMessage || deniedMessage,
        detail: { toolName, toolArgs, permissionHookMessage: permissionHook.hookMessage ?? null },
        source: "tool.permission_denied",
      });
      return {
        ok: false,
        output: {
          ok: false,
          error: "PORTABLE_SKILL_HOOK_DENIED",
          message: permissionHook.hookMessage || deniedMessage,
        },
        executedBy: "gateway",
      };
      }
    }

    const portableToolPolicy = this.config.runCtx.portableSkillContext?.allowedToolPolicy ?? null;
    const portableScopedHighRiskToolNames = new Set(
      Array.isArray(this.config.runCtx.portableSkillContext?.scopedHighRiskToolNames)
        ? this.config.runCtx.portableSkillContext!.scopedHighRiskToolNames!.map((item) => String(item ?? "").trim()).filter(Boolean)
        : [],
    );
    const portableDecision = evaluatePortableAllowedToolPolicy(portableToolPolicy, toolName, toolArgs);
    if (!portableDecision.ok) {
      const deniedMessage = portableDecision.message || `Portable skill guardrails blocked tool "${toolName}".`;
      const permissionHook = await this._emitPortablePermissionRequest({
        toolName,
        toolArgs,
        errorCode: "PORTABLE_SKILL_TOOL_POLICY_DENIED",
        decisionSource: "portable_skill_allowed_tool_policy",
        message: deniedMessage,
        detail: {
          toolName,
          reason: portableDecision.reason ?? "portable_skill_tool_denied",
          matchedRule: portableDecision.matchedRule ?? null,
        },
        approvalEligible: false,
        allowCanProceed: false,
      });
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "warn",
        title: "PortableSkillToolDenied",
        message: permissionHook.hookMessage || deniedMessage,
        detail: {
          toolName,
          reason: portableDecision.reason ?? "portable_skill_tool_denied",
          matchedRule: portableDecision.matchedRule ?? null,
          permissionHookMessage: permissionHook.hookMessage ?? null,
        },
        source: "tool.permission_denied",
      });
      return {
        ok: false,
        output: {
          ok: false,
          error: "PORTABLE_SKILL_TOOL_POLICY_DENIED",
          message: permissionHook.hookMessage || deniedMessage,
          detail: {
            toolName,
            reason: portableDecision.reason ?? "portable_skill_tool_denied",
            matchedRule: portableDecision.matchedRule ?? null,
          },
          next_actions: [
            "改用当前 portable skill 允许的工具",
            "如果确需额外工具，请调整 skill 的 allowed-tools 后重试",
          ],
        },
        executedBy: "gateway",
      };
    }

    const opMode = (this.config.runCtx as any).opMode === "assistant" ? "assistant" : "creative";
    const runtimeHighRiskTools = HIGH_RISK_TOOL_NAME_SET;
    const portableHighRiskOverride =
      runtimeHighRiskTools.has(toolName) &&
      this.config.runCtx.portableSkillContext?.executionScope === "explicit_portable_invocation" &&
      portableScopedHighRiskToolNames.has(toolName);
    if (opMode !== "assistant" && runtimeHighRiskTools.has(toolName) && !portableHighRiskOverride) {
      const deniedMessage = toolName === "skill.install"
        ? "当前为创作模式，禁止直接安装到用户全局技能目录；请先在当前项目或临时 workspace 中完成 skill 草稿，再切到\u201c助手模式\u201d后调用 skill.install。"
        : "当前为创作模式，禁止执行 Bash / process.* / cron.* 等高风险本机操作；如确需执行，请先在桌面端切换到\u201c助手模式\u201d后再重试。";
      const permissionHook = await this._emitPortablePermissionRequest({
        toolName,
        toolArgs,
        errorCode: "ASSISTANT_MODE_REQUIRED",
        decisionSource: "op_mode_high_risk_gate",
        message: deniedMessage,
        detail: { toolName, opMode },
        approvalEligible: false,
        allowCanProceed: false,
      });
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "warn",
        title: "AssistantModeRequired",
        message: "当前为创作模式(opMode=" + opMode + ")，已拦截高风险运行时工具调用：" + toolName,
        detail: { toolName, opMode, permissionHookMessage: permissionHook.hookMessage ?? null },
        source: "tool.permission_denied",
      });
      return finalizeToolResult({
        ok: false,
        output: {
          ok: false,
          error: "ASSISTANT_MODE_REQUIRED",
          message: permissionHook.hookMessage || deniedMessage,
          next_actions: [
            toolName === "skill.install"
              ? "先在当前项目或临时 workspace 中整理好 skill 内容"
              : "如确需执行命令，请先在桌面端显式开启助手模式",
            toolName === "skill.install"
              ? "切到助手模式后，再调用 skill.install 安装到用户全局 skills 目录"
              : "助手模式开启后，可明确说明要执行的命令及目的",
          ],
        },
        executedBy: "desktop",
      });
    }

    const matchedSideEffect = this._isDeliveryCandidateTool(toolName)
      ? this._findMatchingSideEffect(toolName, toolArgs)
      : null;
    if (this.runState.deliveryLatched && matchedSideEffect) {
      this._recordToolLoopGuard("delivery_latch_blocked");
      const deniedMessage = "该逻辑产物已完成交付，禁止重复写入同一产物族。";
      const permissionHook = await this._emitPortablePermissionRequest({
        toolName,
        toolArgs,
        errorCode: "DELIVERY_LATCHED",
        decisionSource: "delivery_latch",
        message: deniedMessage,
        detail: {
          logicalTarget: matchedSideEffect.logicalTarget,
          toolName,
          sideEffectLedgerSize: this.runState.sideEffectLedger.length,
        },
        approvalEligible: false,
        allowCanProceed: false,
      });
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "warn",
        title: "DeliveryLatchBlocked",
        message: `工具 ${toolName} 命中了已交付产物，已拦截重复写入。`,
        detail: {
          logicalTarget: matchedSideEffect.logicalTarget,
          toolName,
          sideEffectLedgerSize: this.runState.sideEffectLedger.length,
          permissionHookMessage: permissionHook.hookMessage ?? null,
        },
        source: "tool.permission_denied",
      });
      return finalizeToolResult({
        ok: false,
        output: {
          ok: false,
          error: "DELIVERY_LATCHED",
          message: permissionHook.hookMessage || deniedMessage,
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
      });
    }

    if (toolName === "spawn_agent") {
      await this._runPortableHookEvent({
        eventName: "SubagentStart",
        toolName,
        toolArgs,
        subagent: {
          agent: toolArgs.agent ?? toolArgs.agentId ?? toolArgs.agent_type ?? null,
          task: toolArgs.task ?? toolArgs.message ?? null,
        },
      });
      if (this.shadowMode === "shadow") {
        return finalizeToolResult(await this._handleDelegateStub(toolCallId, toolArgs, toolName));
      }
      const result = await this.collabRuntime.spawn(toolCallId, toolArgs, this.turn);
      const subagentStopHook = await this._runPortableHookEvent({
        eventName: "SubagentStop",
        toolName,
        toolArgs,
        subagent: {
          agent: toolArgs.agent ?? toolArgs.agentId ?? toolArgs.agent_type ?? null,
          task: toolArgs.task ?? toolArgs.message ?? null,
          ok: result.ok,
        },
      });
      if (subagentStopHook.blocked) {
        await this._schedulePortableStopContinuation({
          eventName: "SubagentStop",
          blockMessage: subagentStopHook.blockMessage,
          detail: {
            toolName,
            subagent: toolArgs.agent ?? toolArgs.agentId ?? toolArgs.agent_type ?? null,
            ok: result.ok,
          },
        });
      }
      return finalizeToolResult(result);
    }

    if (toolName === "send_input") {
      return finalizeToolResult(await this.collabRuntime.sendInput(toolArgs));
    }

    if (toolName === "resume_agent") {
      return finalizeToolResult(await this.collabRuntime.resumeAgent(toolCallId, toolArgs, this.turn));
    }

    if (toolName === "wait_agent") {
      return finalizeToolResult(await this.collabRuntime.waitAgent(toolArgs));
    }

    if (toolName === "close_agent") {
      return finalizeToolResult(await this.collabRuntime.closeAgent(toolArgs));
    }

    if (toolName === "style_imitate.run") {
      const args = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
        ? (toolArgs as Record<string, unknown>)
        : {};
      const task = String(args.task ?? args.description ?? this.config.runCtx.mainDoc?.goal ?? "").trim();
      const draft = String(args.draft ?? "").trim();
      const outputPath = String(args.outputPath ?? "").trim();
      const lengthHint = String(args.lengthHint ?? "").trim();
      if (!task || !draft) {
        return finalizeToolResult({
          ok: false,
          output: {
            ok: false,
            error: "VALIDATION_ERROR",
            message: !task
              ? "style_imitate.run 需要 task（写作任务描述）。"
              : "style_imitate.run 需要 draft（候选稿文本）。",
          },
          executedBy: "gateway",
        });
      }

      const execTool = async (name: string, argsForTool: Record<string, unknown>): Promise<GatewayToolExecResult> => {
        const nestedToolCallId = `${toolCallId}::${name}:${Date.now()}`;
        const result = await this._executeAgentTool(nestedToolCallId, name, argsForTool);
        const outputEnvelope = compactToolResultEnvelope(name, result.output);
        this.config.runCtx.writeEvent("tool.result", {
          toolCallId: nestedToolCallId,
          name,
          ok: result.ok,
          output: outputEnvelope,
          meta: result.meta ?? null,
          turn: this.turn,
        });
        this.turnEngine.record({
          type: "tool_result",
          callId: nestedToolCallId,
          name,
          ok: result.ok,
          output: outputEnvelope,
          error: result.ok ? undefined : String(((result.output as any)?.error ?? "UNKNOWN_ERROR")),
        });
        this._updateRunState(name, argsForTool, {
          ok: result.ok,
          output: result.output,
          meta: result.meta ?? null,
          executedBy: result.executedBy,
          dryRun: result.dryRun,
        });
        return result;
      };

      const orchestratorResult = await runOrchestratedStyleImitate({
        ctx: this.config.runCtx as any,
        runState: this.runState,
        task: {
          description: task,
          draft,
          lengthHint: lengthHint || undefined,
          outputPathHint: outputPath || undefined,
        },
        executeTool: execTool,
      });
      return finalizeToolResult({
        ok: orchestratorResult.ok,
        output: orchestratorResult.ok
          ? {
              ok: true,
              path: orchestratorResult.path ?? null,
              summary: orchestratorResult.summary ?? "",
            }
          : {
              ok: false,
              error: orchestratorResult.error ?? "STYLE_ORCHESTRATOR_FAILED",
              summary: orchestratorResult.summary ?? "",
            },
        meta: { applyPolicy: "proposal", riskLevel: "low", hasApply: false },
        executedBy: "gateway",
      });
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
      await this._writePortableNotificationNotice({
        turn: this.turn,
        kind: "info",
        title: "ShadowDryRun",
        message: `shadow 模式跳过 Desktop 工具：${toolName}`,
        detail: { toolCallId, name: toolName },
        source: "runtime.shadow",
      });
      return finalizeToolResult({
        ok: false,
        output: {
          ok: false,
          error: "SHADOW_DRY_RUN",
          message: `shadow 模式未真正执行 Desktop 工具 "${toolName}"`,
        },
        executedBy: "desktop",
        dryRun: true,
      });
    }

    // Gateway 工具
    if (decision.executedBy === "gateway") {
      const ret = await this._executeGatewayTool(toolCallId, toolName, toolArgs);
      // web.search/web.fetch 的 MCP 回退：bocha 不可用时尝试 sidecar 中的搜索 MCP
      if (!ret.ok) {
        const errCode = String((ret.output as any)?.error ?? "");
        if (errCode === "WEB_SEARCH_FALLBACK_TO_MCP" || errCode === "WEB_FETCH_FALLBACK_TO_MCP") {
          const mcpResult = await this._fallbackWebToolViaMcp(toolCallId, toolName, toolArgs);
          if (mcpResult) return finalizeToolResult(mcpResult);
        }
      }
      return finalizeToolResult(ret);
    }

    // Desktop 工具：合并工具名展开（memory → memory.read / memory.update 等）
    const desktopToolName = expandMergedToolName(toolName, toolArgs);
    const desktopArgs = desktopToolName !== toolName ? stripMergedActionField(toolArgs) : toolArgs;
    return finalizeToolResult(await this._waitForDesktopToolResult(toolCallId, desktopToolName, desktopArgs));
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
        runId: this.config.runCtx.runId,
        // shadow 模式下 clone mainDoc，避免污染主 run
        mainDoc: this.shadowMode === "shadow"
          ? cloneMainDoc(this.config.runCtx.mainDoc)
          : this.config.runCtx.mainDoc,
        llmOverride:
          !this.config.runCtx.baseUrl || !this.config.runCtx.apiKey || !this.config.runCtx.modelId
            ? null
            : {
                baseUrl: this.config.runCtx.baseUrl,
                endpoint: this.config.runCtx.endpoint,
                apiKey: this.config.runCtx.apiKey,
                model: this.config.runCtx.modelId,
              },
        mode: this.config.runCtx.mode,
        subAgentDefinitionById: this.config.runCtx.subAgentDefinitionById ?? null,
        allowedToolNames: this.config.runCtx.allowedToolNames,
        skillManifestById: this.config.runCtx.skillManifestById ?? null,
        activeSkillIds: Array.isArray(this.config.runCtx.activeSkills)
          ? this.config.runCtx.activeSkills.map((s: any) => String(s?.id ?? "").trim()).filter(Boolean)
          : [],
      });

      if (ret.ok) {
        // 记录 tools.search 发现的 MCP 工具名
        if (toolName === "tools.search") {
          const output: any = (ret as any).output;
          const tools = Array.isArray(output?.tools) ? output.tools : [];
          const discovered: Set<string> =
            (this.runState as any).discoveredMcpToolNames ??
            ((this.runState as any).discoveredMcpToolNames = new Set<string>());
          for (const t of tools) {
            if (String(t?.resultType ?? "tool").trim() !== "tool") continue;
            if (String(t?.source ?? "").trim() !== "mcp") continue;
            const name = String(t?.name ?? "").trim();
            if (name) discovered.add(name);
          }
        } else if (toolName === "tools.describe") {
          const output: any = (ret as any).output;
          if (String(output?.targetType ?? "").trim() === "mcp_capability") {
            const tools = Array.isArray(output?.capability?.tools) ? output.capability.tools : [];
            const discovered: Set<string> =
              (this.runState as any).discoveredMcpToolNames ??
              ((this.runState as any).discoveredMcpToolNames = new Set<string>());
            for (const tool of tools) {
              const name = String(tool?.name ?? "").trim();
              if (name) discovered.add(name);
            }
          }
          // tools.describe(skill) 也触发激活（替代 skills.activate）
          if (
            String(output?.targetType ?? "").trim() === "skill" &&
            String(output?.skill?.id ?? "").trim()
          ) {
            await this._applyDynamicSkillActivation(output, "tools.describe");
          }
        } else if (toolName === "skills.activate") {
          await this._applyDynamicSkillActivation((ret as any).output, "skills.activate");
        }
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
          images: normalizeToolResultImages(payload.images),
          meta: payload.meta ?? null,
          executedBy: "desktop",
        });
      });

      // 诊断日志：crab-image 工具调用的 LLM 参数
      if (/crab-image/i.test(toolName)) {
        const diag = { ...toolArgs };
        // 不打 base64 数据
        delete (diag as any).resolvedReferenceImages;
        delete (diag as any).resolvedTargetImage;
        this.config.runCtx.fastify.log.info({ toolName, toolCallId, crabImageArgs: diag }, "crab-image.tool.call.diag");
      }

      // ── crab-image 多图重写 ──
      // LLM 经常在多图场景下错误选择 edit_image（单图编辑），
      // 导致只有 last_user_image（最后一张）被注入。
      // 当用户上传 ≥2 张图且 LLM 调用 edit_image 时，
      // 在 Gateway 侧重写为 generate_image，这样 Desktop 会自动注入所有用户图。
      if (
        toolName === "mcp.crab-image.edit_image" &&
        this._currentTurnUserImageCount >= 2
      ) {
        const editPrompt = String((toolArgs as any).editPrompt ?? "").trim();
        if (editPrompt) {
          toolName = "mcp.crab-image.generate_image";
          toolArgs = {
            ...toolArgs,
            prompt: editPrompt,
          };
          // 清理 edit_image 专用字段
          delete (toolArgs as any).editPrompt;
          delete (toolArgs as any).target;
          this.config.runCtx.fastify.log.info(
            { toolCallId, originalTool: "edit_image", rewrittenTo: "generate_image", userImageCount: this._currentTurnUserImageCount },
            "crab-image.multi-image-rewrite",
          );
        }
      }

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
  private async _handleKernelEvent(event: AgentEvent, ac: AbortController, maxTurns: number): Promise<void> {
    switch (event.type) {
      case "agent_start":
        return;

      case "turn_start":
        this.turn += 1;
        this.currentTurnToolCalls = 0;
        this.turnEngine.beginTurn();
        this.turnEngine.setTurn(this.turn);
        // maxTurns 保护
        if (this.turn > maxTurns) {
          await this._writePortableNotificationNotice({
            turn: this.turn,
            kind: "warn",
            title: "MaxTurnsExceeded",
            message: `达到最大回合数 ${maxTurns}，终止运行`,
            source: "runtime.turn_guard",
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
          const visibleAssistantText = this._extractAssistantVisibleText(msg);
          const hasVisibleAssistantText = visibleAssistantText.length > 0;
          this.turnEngine.noteAssistantTurn({
            hasVisibleAssistantText,
            askedUser: hasVisibleAssistantText && this._detectAssistantAskingUser(visibleAssistantText),
          });

          // max_tokens recovery: 检测 stopReason="length" 且无完整 tool call
          this.lastStopReason = msg.stopReason ?? null;
          const hasToolCall = Array.isArray((msg as any).content)
            && (msg as any).content.some((b: any) => b.type === "tool_use");
          if (msg.stopReason === "length" && !hasToolCall) {
            this.pendingMaxTokensRecovery = this.maxTokensRecoveryCount < this.MAX_TOKENS_RECOVERY_LIMIT;
            if (this.pendingMaxTokensRecovery) {
              this.config.runCtx.writeEvent("max_tokens_recovery.pending", {
                turn: this.turn,
                count: this.maxTokensRecoveryCount + 1,
                limit: this.MAX_TOKENS_RECOVERY_LIMIT,
              });
            }
          } else {
            this.pendingMaxTokensRecovery = false;
            this.maxTokensRecoveryCount = 0;
          }

          this._pushAssistantToTranscript(msg);
          if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && hasVisibleAssistantText) {
            await this._activateDeliveryLatch("assistant_text", { stopReason: msg.stopReason ?? null });
          }
          // 上报 token usage
          const usage = normalizeLlmTokenUsage({
            promptTokens: msg.usage?.input ?? 0,
            completionTokens: msg.usage?.output ?? 0,
          });
          if (hasBillableUsage(usage)) this.config.runCtx.onTurnUsage?.(usage);
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
        this.turnEngine.noteToolCall();
        this.portableStopBlockRetryCount = 0;
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
        const envelope = await this._compactToolResultWithPortableHooks({
          toolName: rawToolName,
          output,
          toolCallId: event.toolCallId,
          ok,
          source: "tool_execution_end",
        });
        const meta = details?.meta ?? null;
        const executedBy = details?.executedBy ?? snap?.executedBy ?? "gateway";
        const dryRun = Boolean(details?.dryRun ?? snap?.dryRun);
        this.turnLocalRawToolResults.set(event.toolCallId, output);

        if (!dryRun) {
          // ── 声明式 workflow：checkExclusions ──
          const runCtx: any = this.config.runCtx;
          const wfDecls: Map<string, WorkflowDeclaration> | undefined = runCtx.activeWorkflowDeclarations;
          const wfWorkflowExcl = wfDecls?.get("style_imitate");
          if (wfWorkflowExcl) {
            const violation = checkExclusions(wfWorkflowExcl, [rawToolName]);
            if (violation) {
              await this._writePortableNotificationNotice({
                turn: this.turn,
                kind: "info",
                title: "StyleWorkflow",
                message: "style workflow 工具调用提示（" + violation + "），已放行。",
                source: "runtime.style_workflow",
              });
            }
          }
        }
        // SSE：tool.result（使用原始工具名）
        this.config.runCtx.writeEvent("tool.result", {
          toolCallId: event.toolCallId,
          name: rawToolName,
          ok,
          output: envelope,
          meta,
        });

        // TurnEngine
        this.turnEngine.record({
          type: "tool_result",
          callId: event.toolCallId,
          name: rawToolName,
          ok,
          output: envelope,
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

        if (ok && !dryRun && isCrabImageBillingTool(rawToolName) && typeof this.config.runCtx.chargeUserForImageGen === "function") {
          try {
            const modelId = resolveImageGenModelIdFromArgs(snap?.args);
            const charged = await this.config.runCtx.chargeUserForImageGen({
              modelId,
              toolName: rawToolName,
              source: `run:${this.config.runCtx.runId}`,
              metaExtra: {
                toolCallId: event.toolCallId,
                args: snap?.args ?? {},
              },
            });
            const chargedPoints = Number(charged?.chargedPoints ?? 0);
            if (charged?.ok && Number.isFinite(chargedPoints) && chargedPoints > 0) {
              this.config.runCtx.writeEvent("policy.decision", {
                runId: this.config.runCtx.runId,
                ts: Date.now(),
                turn: this.turn,
                policy: "BillingPolicy",
                decision: "charged",
                reasonCodes: ["image_gen", rawToolName],
                detail: {
                  kind: "image_gen",
                  toolName: rawToolName,
                  modelId,
                  chargedPoints: Math.floor(chargedPoints),
                },
              });
            }
          } catch {
            // 图片扣费失败不阻断工具结果
          }
        }

        // 失败摘要
        if (!ok && !dryRun) {
          const flat = normalizeToolOutputText(output);
          const m = flat.match(/\bTool\s+([A-Za-z0-9_]+)\s+not\s+found\b/i);
          if (m?.[1]) {
            const raw = this._decodeRuntimeToolName(String(m[1]));
            (this.runState as any).lastToolNotFoundName = raw || null;
            await this._writePortableNotificationNotice({
              turn: this.turn,
              kind: "warn",
              title: "ToolNotFound",
              message: `检测到 TOOL_NOT_FOUND：${raw || m[1]}，下一回合将自愈补齐工具池。`,
              detail: { toolName: raw || m[1], rawError: flat.slice(0, 240) },
              source: "runtime.tool_recovery",
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
          // Agent 向用户提问时调用 run.done → 放行，不拦截（让 agent 交还控制权等用户回复）
          const lastTextForRunDone = this._getLastAssistantText();
          const agentIsAskingUser = lastTextForRunDone && this._detectAssistantAskingUser(lastTextForRunDone);

          const styleFollowUp = this._resolveStyleWorkflowFollowUp();
          const budget = Math.max(0, Math.floor(Number((this.runState as any).workflowRetryBudget ?? 0)));
          if (styleFollowUp && budget > 0 && !agentIsAskingUser) {
            try {
              await this._writePortableNotificationNotice({
                turn: this.turn,
                kind: "warn",
                title: "StyleWorkflowRunDoneIntercepted",
                message: `检测到 ${styleFollowUp.skillId} 闭环未完成（phase=${styleFollowUp.phase}），拦截 run.done，下一轮继续推进。`,
                detail: {
                  toolCallId: event.toolCallId,
                  phase: styleFollowUp.phase,
                  remainingBudget: budget,
                },
                source: "runtime.run_done_intercept",
              });
            } catch {
              // 非关键路径，忽略审计异常
            }
            this.toolCallSnapshots.delete(event.toolCallId);
            return;
          }
          await this._activateDeliveryLatch("run_done");
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
        this.turnLocalRawToolResults.clear();
        if (
          this.outcome.status !== "completed" ||
          this.outcome.reason === "run_done" ||
          this.outcome.reason === "approval_waiting"
        ) {
          return;
        }

        // max_tokens 续写：跳过 no-tool guard 和 implicit_completion，让 loop 继续
        if (this.pendingMaxTokensRecovery) {
          this.consecutiveVisibleNoToolTurns = 0;
          this.consecutiveSilentNoToolTurns = 0;
          return;
        }

        const noToolBranch = this.turnEngine.classifyNoToolBranch();
        if (noToolBranch === "with_tool") {
          this.consecutiveVisibleNoToolTurns = 0;
          this.consecutiveSilentNoToolTurns = 0;
        } else if (noToolBranch === "no_tool_with_visible_text") {
          this.consecutiveVisibleNoToolTurns += 1;
          this.consecutiveSilentNoToolTurns = 0;
        } else {
          this.consecutiveVisibleNoToolTurns = 0;
          this.consecutiveSilentNoToolTurns += 1;
          this._setOutcome({
            status: "failed",
            reason: "silent_no_output",
            reasonCodes: ["silent_no_output", "no_tool_branch"],
            detail: {
              turn: this.turn,
              noToolBranch,
            },
          });
          return;
        }

        await this._enforceTurnLevelGuards(ac);
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
    const envelope = isToolResultEnvelope(output)
      ? (output as ToolResultEnvelope)
      : compactToolResultEnvelope(this._decodeRuntimeToolName(message.toolName), output);
    const ok = details?.ok ?? !message.isError;
    const images = normalizeToolResultImages(details?.images);
    const normalizedText = envelope.normalizedText || this._toolResultText(message);
    if (!isToolResultEnvelope(output)) {
      this.turnLocalRawToolResults.set(message.toolCallId, output);
    }

    const item: CanonicalToolResultItem = {
      kind: "tool_result",
      callId: message.toolCallId,
      toolName: this._decodeRuntimeToolName(message.toolName),
      ok,
      output: envelope,
      ...(images.length ? { images } : {}),
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
    const allowToolResultImages = providerApi === "anthropic-messages";
    const recentImageCallIds = allowToolResultImages
      ? collectRecentToolResultImageCallIds(messages)
      : new Set<string>();
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
          const rawForCurrentTurn = this.turnLocalRawToolResults.get(item.callId);
          const inlinePayload =
            rawForCurrentTurn !== undefined
              ? rawForCurrentTurn
              : isToolResultEnvelope(item.output) && item.output.mode === "inline"
                ? item.output.inline
                : undefined;
          out.push({
            role: "toolResult",
            toolCallId: item.callId,
            toolName: this._encodeRuntimeToolName(item.toolName),
            content: buildToolResultContentParts(
              item,
              allowToolResultImages && recentImageCallIds.has(item.callId),
            ),
            ...(inlinePayload !== undefined ? { details: inlinePayload } : {}),
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

    // MCP 工具统计
    if (toolName.startsWith("mcp.")) {
      this.runState.hasMcpToolCall = true;
      this.runState.mcpToolCallCount += 1;
      if (result.ok) this.runState.mcpToolSuccessCount += 1;
      else this.runState.mcpToolFailCount += 1;
    }

    // Tool Discovery：即使失败也算"已尝试"，避免反复卡死在同一步
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

    if (toolName === "spawn_agent") {
      this.runState.hasPlanCommitment = true;
      const agentId = String(toolArgs.agentId ?? toolArgs.agent_type ?? "").trim();
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
      (toolName === "run.todo" && (
        String(toolArgs.action ?? "").trim().toLowerCase() === "upsert" ||
        String(toolArgs.action ?? "").trim().toLowerCase() === "replace"
      ))
    ) {
      this.runState.hasTodoList = true;
      this.runState.hasPlanCommitment = true;
      this._markTodoSatisfied();
      return;
    }

    if (toolName === "kb.listLibraries") {
      const libraries = Array.isArray((result.output as any)?.libraries) ? ((result.output as any).libraries as any[]) : [];
      const styleLibraryIds = libraries
        .filter((lib: any) => String(lib?.purpose ?? "").trim() === "style")
        .map((lib: any) => String(lib?.id ?? "").trim())
        .filter(Boolean);
      (this.runState as any).styleLibraryOptionIds = styleLibraryIds.slice(0, 8);
      if (!this.runState.hasSelectedStyleLibrary && styleLibraryIds.length === 1) {
        this.runState.hasSelectedStyleLibrary = true;
        this.runState.selectedStyleLibraryId = styleLibraryIds[0];
      }
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
        const callLibraryIds = Array.isArray(toolArgs.libraryIds)
          ? (toolArgs.libraryIds as unknown[]).map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
        if (callLibraryIds.length === 1) {
          this.runState.hasSelectedStyleLibrary = true;
          this.runState.selectedStyleLibraryId = callLibraryIds[0];
        }
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
        const topArtifacts = collectTopStyleArtifacts(result.output);
        const query = String(toolArgs.query ?? "").trim();
        const libraryIds = callLibraryIds.length
          ? callLibraryIds
          : (this.config.runCtx.styleLibIds ?? []).map((id: unknown) => String(id ?? "").trim()).filter(Boolean);
        (this.runState as any).styleEvidencePack = {
          query,
          libraryIds,
          groupCount,
          hitCount: topArtifacts.length,
          ...(topArtifacts.length ? { topArtifacts } : {}),
        };
        if (Array.isArray((this.runState as any).styleLibraryOptionIds) && (this.runState as any).styleLibraryOptionIds.length === 0) {
          (this.runState as any).styleLibraryOptionIds = libraryIds.slice(0, 8);
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
      if (passed) {
        this.runState.styleLintFailCount = 0;
      }
      this.runState.styleLintSatisfied = passed || Boolean(this.runState.lintGateDegraded);
      if (!passed) {
        this.runState.styleLintFailCount = Math.max(
          0,
          Math.floor(Number(this.runState.styleLintFailCount ?? 0)),
        ) + 1;
        const lintBudget = Math.max(0, Math.floor(Number((this.runState as any).lintReworkBudget ?? 0)));
        if (!this.runState.lintGateDegraded && lintBudget > 0 && this.runState.styleLintFailCount >= lintBudget) {
          this.runState.lintGateDegraded = true;
          this.runState.styleLintSatisfied = true;
        }
        this.runState.finalWritten = false;
      }
      upsertBestDraftCandidate({
        runState: this.runState,
        text: String(toolArgs.text ?? "").trim(),
        styleScore: parsed.score,
        highIssues: parsed.highIssues,
        copy: (this.runState as any).lastCopyLint ?? null,
      });

      return;
    }

    if (toolName === "lint.copy") {
      const out =
        result.output && typeof result.output === "object"
          ? (result.output as Record<string, unknown>)
          : {};

      const passed = (out as any)?.passed === true;
      this.runState.copyLintPassed = passed;
      this.runState.copyLintSatisfied = passed;

      if (passed) {
        this.runState.copyLintFailCount = 0;
      } else {
        this.runState.copyLintFailCount =
          Math.max(0, Math.floor(Number(this.runState.copyLintFailCount ?? 0))) + 1;
        const lintBudget = Math.max(0, Math.floor(Number((this.runState as any).lintReworkBudget ?? 0)));
        if (!this.runState.copyGateDegraded && lintBudget > 0 && this.runState.copyLintFailCount >= lintBudget) {
          this.runState.copyGateDegraded = true;
          this.runState.copyLintSatisfied = true;
        }
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
      upsertBestDraftCandidate({
        runState: this.runState,
        text: String(toolArgs.text ?? "").trim(),
        styleScore: (this.runState as any).lastStyleLint?.score ?? 0,
        highIssues: (this.runState as any).lastStyleLint?.highIssues ?? 0,
        copy: this.runState.lastCopyLint as any,
      });
      if (!passed && !this.runState.copyGateDegraded) {
        this.runState.finalWritten = false;
      }

      return;
    }

    const isSnapshotRestore =
      toolName === "doc.snapshot" && String(toolArgs.action ?? "").trim().toLowerCase() === "restore";
    if (isWriteLikeTool(toolName) || isSnapshotRestore) {
      this.runState.hasWriteOps = true;
    }
    if (isContentWriteTool(toolName) || isSnapshotRestore || toolName === "Bash") {
      this.runState.hasWriteOps = true;
      this.runState.hasWriteApplied = true;
      this._recordSideEffect(toolName, toolArgs, result);
      this.runState.toolLoopGuardReason = null;

      try {
        const gates: any = this.config.runCtx.gates ?? {};
        const finalDraftText = extractFinalDraftTextFromToolArgs(toolName, toolArgs);
        if (toolName === "write" && result.ok && finalDraftText && gates.styleGateEnabled && gates.lintGateEnabled && this.runState.hasStyleKbSearch) {
          ensureStylePlanCheckpoint(this.runState, {
            topic: String((this.runState as any).styleTopic ?? "").trim() || null,
          });
          upsertBestDraftCandidate({
            runState: this.runState,
            text: finalDraftText,
            styleScore: (this.runState as any).lastStyleLint?.score ?? 0,
            highIssues: (this.runState as any).lastStyleLint?.highIssues ?? 0,
            copy: (this.runState as any).lastCopyLint ?? null,
          });
        }
        const styleClosed = Boolean(
          this.runState.hasStyleKbSearch &&
          (this.runState as any).hasStylePlan &&
          this.runState.hasDraftText &&
          ((this.runState as any).copyLintSatisfied || this.runState.copyLintPassed || this.runState.copyGateDegraded) &&
          ((this.runState as any).styleLintSatisfied || this.runState.styleLintPassed || this.runState.lintGateDegraded),
        );
        if (styleClosed) {
          const finalDraftRef = buildStyleArtifactRef({
            stepId: "closure",
            kind: "draft_text",
            textOrSeed: finalDraftText,
          });
          const bestDraftArtifactId = String((this.runState as any).bestDraft?.artifactId ?? "").trim();
          (this.runState as any).finalWritten = Boolean(bestDraftArtifactId) && bestDraftArtifactId === String(finalDraftRef?.artifactId ?? "").trim();
          if ((this.runState as any).finalWritten) {
            (this.runState as any).finalWrittenPath = String((result.output as any)?.path ?? "").trim() || null;
          }
          if (!(this.runState as any).finalWritten) {
            (this.runState as any).finalWriteMismatch = {
              toolName,
              reason: bestDraftArtifactId ? "best_draft_mismatch" : "best_draft_missing",
              matchedBestDraft: false,
            };
          } else {
            (this.runState as any).finalWriteMismatch = null;
          }
        }
      } catch {
        // 若 runCtx 缺失 gate 信息，不影响主流程
      }
    }
  }

  // ── spawn_agent stub（仅 shadow 模式） ──────

  /**
   * spawn_agent 占位实现（仅 shadow 模式使用）。
   * 记录委派请求和审计事件，但不真正启动子 Agent 循环。
   */
  private _handleDelegateStub(
    toolCallId: string,
    toolArgs: Record<string, unknown>,
    toolName = "spawn_agent",
  ): GatewayToolExecResult {
    const normalized = normalizeSpawnAgentArgs(toolArgs);
    const agentId = normalized.ok ? normalized.value.agentId : "";
    const task = normalized.ok ? normalized.value.task : "";

    // 审计事件：记录委派请求
    this.config.runCtx.writeEvent("tool.call", {
      toolCallId,
      name: toolName,
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

    // 不把用户上传的原始图片发给主 LLM——大图会导致请求体过大、代理报错。
    // 图片数据由 wsTransport.ts 在工具调用时自动注入到 crab-image MCP。
    // 这里只注入文字注释，让模型知道有图可用。
    const n = item.images.length;
    const note = n >= 2
      ? `（用户上传了 ${n} 张图片。多图场景请使用 generate_image（不是 edit_image），所有 ${n} 张图会作为参考图自动注入，无需传 referenceImages 或 last_user_image；直接调用 generate_image 即可）`
      : `（用户上传了 ${n} 张图片，在调用 generate_image / edit_image 时会作为参考图自动注入，无需在 referenceImages 中指定 last_user_image；直接调用工具即可）`;
    return item.text.trim() ? `${item.text}\n\n${note}` : note;
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
      images: normalizeToolResultImages(obj.images),
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
    return truncateText(text.trim() || getToolResultEnvelopeNormalizedText(message.details));
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
    const gates: any = runCtx.gates ?? {};
    const wfDecls: Map<string, WorkflowDeclaration> | undefined = runCtx.activeWorkflowDeclarations;
    const workflowSkills = wfDecls
      ? Array.from(wfDecls.entries()).map(([id, wf]) => {
          const snap = resolvePhase(wf, this.runState as any);
          return { ...snap, id };
        })
      : [];

    // Style_imitate 工作流摘要：保留旧字段，便于兼容既有审计逻辑
    const activeSkillsRaw = Array.isArray(runCtx.activeSkills) ? runCtx.activeSkills : [];
    const styleSkillActive = activeSkillsRaw.some((s: any) => String(s?.id ?? "").trim() === "style_imitate");
    const styleWorkflow = styleSkillActive && runCtx.intent?.isWritingTask
      ? {
          active: true,
          hasSelectedStyleLibrary: Boolean((this.runState as any)?.hasSelectedStyleLibrary),
          selectedStyleLibraryId: String((this.runState as any)?.selectedStyleLibraryId ?? "").trim() || null,
          styleLibraryOptionIds: Array.isArray((this.runState as any)?.styleLibraryOptionIds)
            ? ((this.runState as any).styleLibraryOptionIds as unknown[]).map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 8)
            : [],
          topicConfirmed: Boolean((this.runState as any)?.topicConfirmed),
          styleTopic: String((this.runState as any)?.styleTopic ?? "").trim() || null,
          hasStyleKbSearch: Boolean((this.runState as any)?.hasStyleKbSearch),
          hasStyleKbHit: Boolean((this.runState as any)?.hasStyleKbHit),
          styleEvidencePack: summarizeStyleEvidencePack((this.runState as any)?.styleEvidencePack),
          hasStylePlan: Boolean((this.runState as any)?.hasStylePlan),
          hasToneCard: Boolean((this.runState as any)?.hasToneCard),
          hasStructureOutline: Boolean((this.runState as any)?.hasStructureOutline),
          hasDraftText: Boolean((this.runState as any)?.hasDraftText),
          draftArtifactId: String((this.runState as any)?.bestDraft?.artifactId ?? "").trim() || null,
          draftChars: Number((this.runState as any)?.bestDraft?.charCount ?? 0) || 0,
          copyLintPassed: Boolean((this.runState as any)?.copyLintPassed),
          copyLintSatisfied: Boolean((this.runState as any)?.copyLintSatisfied),
          copyLintFailCount: Number((this.runState as any)?.copyLintFailCount ?? 0) || 0,
          copyGateDegraded: Boolean((this.runState as any)?.copyGateDegraded),
          lastCopyLint:
            (this.runState as any)?.lastCopyLint && typeof (this.runState as any).lastCopyLint === "object"
              ? (this.runState as any).lastCopyLint
              : null,
          styleLintPassed: Boolean((this.runState as any)?.styleLintPassed),
          styleLintSatisfied: Boolean((this.runState as any)?.styleLintSatisfied),
          styleLintFailCount: Number((this.runState as any)?.styleLintFailCount ?? 0) || 0,
          lintGateDegraded: Boolean((this.runState as any)?.lintGateDegraded),
          lastStyleLint:
            (this.runState as any)?.lastStyleLint && typeof (this.runState as any).lastStyleLint === "object"
              ? (this.runState as any).lastStyleLint
              : null,
          bestStyleDraft:
            (this.runState as any)?.bestStyleDraft && typeof (this.runState as any).bestStyleDraft === "object"
              ? (this.runState as any).bestStyleDraft
              : null,
          bestDraft:
            (this.runState as any)?.bestDraft && typeof (this.runState as any).bestDraft === "object"
              ? (this.runState as any).bestDraft
              : null,
          finalWritten: Boolean((this.runState as any)?.finalWritten),
          finalWrittenPath: String((this.runState as any)?.finalWrittenPath ?? "").trim() || null,
          stepArtifactRefs:
            (this.runState as any)?.stepArtifactRefs && typeof (this.runState as any).stepArtifactRefs === "object"
              ? (this.runState as any).stepArtifactRefs
              : null,
        }
      : undefined;
    const portablePolicy = runCtx.portableSkillContext?.allowedToolPolicy ?? null;
    const portableSkillRuntime = runCtx.portableSkillContext
      ? {
          activeSkillIds: Array.isArray(runCtx.portableSkillContext.activeSkillIds)
            ? runCtx.portableSkillContext.activeSkillIds
            : [],
          primarySkillId: runCtx.portableSkillContext.primarySkillId ?? null,
          modelOverride: runCtx.portableSkillContext.modelOverride ?? null,
          executionScope: runCtx.portableSkillContext.executionScope ?? null,
          scopedHighRiskToolNames: Array.isArray(runCtx.portableSkillContext.scopedHighRiskToolNames)
            ? runCtx.portableSkillContext.scopedHighRiskToolNames
            : [],
          hooksSkillIds: Array.isArray(runCtx.portableSkillContext.hooksSkillIds)
            ? runCtx.portableSkillContext.hooksSkillIds
            : [],
          inputStates: Array.isArray(runCtx.portableSkillContext.inputStates)
            ? runCtx.portableSkillContext.inputStates.map((item: any) => ({
                skillId: item.skillId,
                parseMode: item.parseMode,
                schemaSummary: item.schemaSummary ?? null,
                error: item.error ?? null,
              }))
            : [],
          fork: runCtx.portableSkillContext.fork ?? null,
          allowedToolPolicy: portablePolicy
            ? {
                activeSkillIds: portablePolicy.activeSkillIds,
                allowedToolNames: Array.from(portablePolicy.allowedToolNames),
                rules: portablePolicy.rules.map((rule: any) => ({
                  skillId: rule.skillId,
                  raw: rule.raw,
                  aliasName: rule.aliasName,
                  toolName: rule.toolName,
                  kind: rule.kind,
                  specifier: rule.specifier ?? null,
                })),
                unsupportedEntries: portablePolicy.unsupportedEntries,
              }
            : null,
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
      ...(portableSkillRuntime ? { portableSkillRuntime } : {}),
      ...(styleWorkflow ? { styleWorkflow } : {}),
      transcriptSummary: summarizeTranscript(this.transcript),
      runState: summarizeRunStateForExecutionReport(this.runState),
      ...snapshot,
    };
  }
}
