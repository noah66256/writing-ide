/**
 * WebSocket transport for Desktop ↔ Gateway agent runs.
 * Phase 3 of SSE→WS migration. Mirrors the SSE path in gatewayAgent.ts
 * but uses a per-run WebSocket instead of SSE + HTTP POST.
 *
 * Phase 4 will extract shared logic (payload prep, event dispatch) into
 * a common module; for now we accept some duplication for safety.
 */

import { useProjectStore } from "../state/projectStore";
import { useProjectIndexStore } from "../state/projectIndexStore";
import { useKbStore } from "../state/kbStore";
import { useAuthStore } from "../state/authStore";
import { useRunStore } from "../state/runStore";
import { cancelInlineFileOpConfirm } from "../state/inlineFileOpConfirm";
import { activateSkills } from "@ohmycrab/agent-core";
import { buildStyleLinterLibrariesSidecar, executeToolCall, getTool } from "./toolRegistry";
import { createRunTarget } from "./runTarget";
import { cancelConvRun, setConvRunCancel } from "../state/runRegistry";
import {
  buildContextManifestV1,
  compactToolResultEnvelope,
  getToolResultEnvelopePayload,
  isToolResultEnvelope,
  renderContextPackV1,
  type ContextSegmentV1,
  type ThreadImageArtifactRef,
  type ThreadImageSessionV1,
} from "@ohmycrab/shared";
import { buildProjectMapSegmentV2, buildProjectSummarySegmentsV1 } from "../lib/projectIndexing";
import {
  type GatewayRunController,
  type GatewayRunArgs,
  type Ref,
  parseRefsFromPrompt,
  buildReferencesTextFromRefs,
  buildContextPack,
  buildChatContextPack,
  rollDialogueSummaryIfNeeded,
  buildDialogueTurnsFromSteps,
  pickClusterSelectorV1,
  buildTopicTextForSelectorV1,
  summarizeQuoteAsFeatureV1,
  parseSseToolArgs,
  humanizeToolActivity,
  applyTextEdits,
  unifiedDiff,
} from "./gatewayAgent";
import { isStyleWorkflowRequestedForRun, resolveImplicitStyleLibraryIds, shouldAllowHistoricalStyleFallback } from "./kbSelection";
import { getProjectedStepsFromRuntime } from "./threadProjection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an HTTP(S) base URL to a WS(S) URL. Empty string → use current host (dev/Vite proxy). */
function toWsBase(baseUrl: string): string {
  if (!baseUrl) {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc.host}`;
  }
  return baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

// ---------------------------------------------------------------------------
// Memory extraction helpers
// ---------------------------------------------------------------------------

/** 把对话回合列表格式化为供记忆提取的原文文字 */
function formatDialogueTurnsForMemoryExtract(turns: Array<{ user: string; assistant: string }>): string {
  return (Array.isArray(turns) ? turns : [])
    .map((t, i) => {
      const u = String(t?.user ?? "").trim();
      const a = String(t?.assistant ?? "").trim();
      return u && a ? `第 ${i + 1} 轮\n用户：${u}\n助手：${a}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** 读取 memoryExtractTurnCursorByMode 中的 cursor 值 */
function readMemoryExtractCursor(mode: "agent" | "chat"): number {
  const m = useRunStore.getState().memoryExtractTurnCursorByMode;
  const n = Number((m as any)?.[mode]);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function summarizeThreadSnapshotForLog(payload: any) {
  const thread = payload?.thread && typeof payload.thread === "object" ? payload.thread : null;
  const currentTurn = payload?.currentTurn && typeof payload.currentTurn === "object" ? payload.currentTurn : null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const activeItemIds = Array.isArray(payload?.activeItemIds) ? payload.activeItemIds : [];
  const collabSessions = Array.isArray(payload?.collabSessions) ? payload.collabSessions : [];
  const itemTypeCounts = items.reduce((acc: Record<string, number>, item: any) => {
    const type = String(item?.type ?? "unknown").trim() || "unknown";
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  return {
    threadId: String(thread?.id ?? "").trim() || null,
    currentTurnId: String(currentTurn?.id ?? "").trim() || null,
    waitingFor: thread?.waitingFor ?? null,
    activeSkillIds: Array.isArray(thread?.activeSkillRefs)
      ? thread.activeSkillRefs.map((item: any) => String(item?.id ?? "").trim()).filter(Boolean)
      : [],
    itemCount: items.length,
    itemTypeCounts,
    activeItemCount: activeItemIds.length,
    collabSessionCount: collabSessions.length,
    replaceStrategy: String(payload?.stream?.replaceStrategy ?? "").trim() || null,
  };
}

function summarizeExecutionReportForLog(payload: any) {
  const workflowSkills = Array.isArray(payload?.workflowSkills) ? payload.workflowSkills : [];
  const styleWorkflow = payload?.styleWorkflow && typeof payload.styleWorkflow === "object" ? payload.styleWorkflow : null;
  return {
    runId: String(payload?.runId ?? "").trim() || null,
    threadId: String(payload?.threadId ?? "").trim() || null,
    status: String(payload?.status ?? "").trim() || null,
    endReason: String(payload?.endReason ?? "").trim() || null,
    toolCallCount: Number(payload?.toolCallCount ?? 0) || 0,
    toolSuccessCount: Number(payload?.toolSuccessCount ?? 0) || 0,
    toolFailureCount: Number(payload?.toolFailureCount ?? 0) || 0,
    workflowSkills: workflowSkills.map((item: any) => ({
      id: String(item?.id ?? "").trim(),
      currentPhase: String(item?.currentPhase ?? "").trim(),
      completed: Boolean(item?.completed),
      degraded: Boolean(item?.degraded),
      waitingForUser: Boolean(item?.waitingForUser),
      missingSteps: Array.isArray(item?.missingSteps)
        ? item.missingSteps.map((x: any) => String(x ?? "").trim()).filter(Boolean)
        : [],
    })).filter((item: any) => item.id),
    styleWorkflow: styleWorkflow ? {
      currentPhase: String(styleWorkflow?.currentPhase ?? "").trim() || null,
      hasStyleKbHit: Boolean(styleWorkflow?.hasStyleKbHit),
      hasBestDraft: Boolean(styleWorkflow?.bestDraft?.artifactId),
      hasBestStyleDraft: Boolean(styleWorkflow?.bestStyleDraft?.artifactId),
      copyLintFailCount: Number(styleWorkflow?.copyLintFailCount ?? 0) || 0,
      styleLintFailCount: Number(styleWorkflow?.styleLintFailCount ?? 0) || 0,
      copyGateDegraded: Boolean(styleWorkflow?.copyGateDegraded),
      lintGateDegraded: Boolean(styleWorkflow?.lintGateDegraded),
      finalWrittenPath: String(styleWorkflow?.finalWrittenPath ?? "").trim() || null,
      stepArtifactRefCount: styleWorkflow?.stepArtifactRefs && typeof styleWorkflow.stepArtifactRefs === "object"
        ? Object.keys(styleWorkflow.stepArtifactRefs).length
        : 0,
    } : null,
  };
}

function isCrabImageTool(toolName: string): boolean {
  return toolName === "mcp.crab-image.generate_image" || toolName === "mcp.crab-image.edit_image";
}

// ── Run 级图像 artifact 热缓存 ──
// thread.imageSession 的 getThread/setThread 可能在同一 run 内断链，
// 这里维护一个进程级热缓存作为 fallback。
const _imageArtifactCache = {
  lastGeneratedPath: null as string | null,
  lastEditedPath: null as string | null,
  recentPaths: [] as string[],
  updatedAt: 0,
};

function _cacheImageArtifact(absPath: string, source: "generated" | "edited") {
  if (!absPath) return;
  _imageArtifactCache.recentPaths = [
    absPath,
    ..._imageArtifactCache.recentPaths.filter((p) => p !== absPath),
  ].slice(0, 24);
  if (source === "generated") _imageArtifactCache.lastGeneratedPath = absPath;
  if (source === "edited") _imageArtifactCache.lastEditedPath = absPath;
  _imageArtifactCache.updatedAt = Date.now();
}

function _getCachedImagePath(token: string): string | null {
  if (token === "last") return _imageArtifactCache.lastEditedPath ?? _imageArtifactCache.lastGeneratedPath ?? _imageArtifactCache.recentPaths[0] ?? null;
  if (token === "last_generated") return _imageArtifactCache.lastGeneratedPath;
  return null;
}

function isAbsolutePathLike(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
}

function makeImageArtifactId(seed: string): string {
  const text = String(seed ?? "").trim();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `img_${Math.abs(hash).toString(36)}`;
}

function normalizeThreadImageSession(session: unknown): ThreadImageSessionV1 | null {
  if (!session || typeof session !== "object") return null;
  const recentArtifacts = Array.isArray((session as any).recentArtifacts)
    ? ((session as any).recentArtifacts as any[])
        .filter((item) => item && typeof item === "object" && String(item?.artifactId ?? "").trim())
        .map<ThreadImageArtifactRef>((item) => {
          const source: ThreadImageArtifactRef["source"] =
            item?.source === "user_upload" ? "user_upload" : item?.source === "edited" ? "edited" : "generated";
          return {
            artifactId: String(item?.artifactId ?? "").trim(),
            ...(String(item?.path ?? "").trim() ? { path: String(item.path).trim() } : {}),
            source,
            createdAt: String(item?.createdAt ?? "").trim() || new Date().toISOString(),
            ...(String(item?.prompt ?? "").trim() ? { prompt: String(item.prompt).trim() } : {}),
            ...(String(item?.aspectRatio ?? "").trim() ? { aspectRatio: String(item.aspectRatio).trim() } : {}),
            ...(String(item?.mimeType ?? "").trim() ? { mimeType: String(item.mimeType).trim() } : {}),
          };
        })
        .slice(-24)
    : [];
  return {
    v: 1,
    recentArtifacts,
    lastGeneratedArtifactId: String((session as any)?.lastGeneratedArtifactId ?? "").trim() || null,
    lastEditedArtifactId: String((session as any)?.lastEditedArtifactId ?? "").trim() || null,
    defaultAspectRatio: String((session as any)?.defaultAspectRatio ?? "").trim() || null,
    preferredProvider: "gemini_nb",
    updatedAt: String((session as any)?.updatedAt ?? "").trim() || new Date().toISOString(),
  };
}

function findLatestUserImageSource(rt: ReturnType<typeof createRunTarget>): { kind: "data"; dataUrl: string } | null {
  const steps = Array.isArray(rt.getSteps?.()) ? rt.getSteps() : [];
  for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const step = steps[stepIndex] as any;
    if (!step || step.type !== "user" || !Array.isArray(step.images) || step.images.length === 0) continue;
    for (let imageIndex = step.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      const image = step.images[imageIndex];
      const mediaType = String(image?.mediaType ?? "").trim() || "image/png";
      const data = String(image?.data ?? "").trim();
      if (!data) continue;
      return { kind: "data", dataUrl: `data:${mediaType};base64,${data}` };
    }
  }
  return null;
}

function resolveImageToken(args: {
  token: unknown;
  rt: ReturnType<typeof createRunTarget>;
  imageSession: ThreadImageSessionV1 | null;
}): { kind: "path"; path: string } | { kind: "data"; dataUrl: string } | null {
  const token = String(args.token ?? "").trim();
  if (!token) return null;
  const imageSession = args.imageSession;
  const recentArtifacts = Array.isArray(imageSession?.recentArtifacts) ? imageSession!.recentArtifacts : [];
  const findArtifactById = (artifactId: string) =>
    recentArtifacts.find((item) => String(item?.artifactId ?? "").trim() === artifactId && String(item?.path ?? "").trim());
  const findLastArtifact = () => {
    const preferredId = String(imageSession?.lastEditedArtifactId ?? "").trim() || String(imageSession?.lastGeneratedArtifactId ?? "").trim();
    if (preferredId) {
      const matched = findArtifactById(preferredId);
      if (matched?.path) return matched;
    }
    return [...recentArtifacts].reverse().find((item) => String(item?.path ?? "").trim());
  };
  if (token === "last") {
    const matched = findLastArtifact();
    if (matched?.path) return { kind: "path", path: matched.path };
    // fallback: 热缓存
    const cached = _getCachedImagePath("last");
    if (cached) return { kind: "path", path: cached };
    return findLatestUserImageSource(args.rt);
  }
  if (token === "last_generated") {
    const matched = findArtifactById(String(imageSession?.lastGeneratedArtifactId ?? "").trim());
    if (matched?.path) return { kind: "path", path: matched.path };
    const cached = _getCachedImagePath("last_generated");
    if (cached) return { kind: "path", path: cached };
    return null;
  }
  if (token === "last_user_image") {
    return findLatestUserImageSource(args.rt);
  }
  if (token.startsWith("artifact:")) {
    const matched = findArtifactById(token.slice("artifact:".length).trim());
    return matched?.path ? { kind: "path", path: matched.path } : null;
  }
  if (/^data:image\//i.test(token)) {
    return { kind: "data", dataUrl: token };
  }
  if (isAbsolutePathLike(token)) {
    return { kind: "path", path: token.replaceAll("\\", "/") };
  }
  return null;
}

function buildCrabImageToolArgs(args: {
  toolName: string;
  rawArgs: Record<string, unknown>;
  rt: ReturnType<typeof createRunTarget>;
}): Record<string, unknown> {
  const nextArgs: Record<string, unknown> = { ...(args.rawArgs ?? {}) };
  const thread = args.rt.getThread?.() as any;
  const imageSession = normalizeThreadImageSession(thread?.imageSession);
  const threadId = String(thread?.id ?? "").trim();
  if (threadId) nextArgs.threadId = threadId;

  const rawReferenceImages = Array.isArray(args.rawArgs?.referenceImages)
    ? (args.rawArgs.referenceImages as unknown[])
    : [];
  const resolvedReferenceImages = rawReferenceImages
    .map((item) => resolveImageToken({ token: item, rt: args.rt, imageSession }))
    .filter(Boolean);

  if (args.toolName === "mcp.crab-image.generate_image") {
    // 自动注入用户上传图作为参考图：
    // 如果本轮用户消息包含图片，且模型没有显式传 referenceImages，自动注入
    if (resolvedReferenceImages.length === 0) {
      const userImage = findLatestUserImageSource(args.rt);
      if (userImage) resolvedReferenceImages.push(userImage);
    }
    const useThreadHistory = Boolean((args.rawArgs as any)?.useThreadHistory);
    if (useThreadHistory && resolvedReferenceImages.length === 0) {
      const fallback = resolveImageToken({ token: "last", rt: args.rt, imageSession });
      if (fallback) resolvedReferenceImages.push(fallback);
    }
  }

  if (args.toolName === "mcp.crab-image.edit_image") {
    const targetToken = String((args.rawArgs as any)?.target ?? "").trim() || "last";
    let resolvedTargetImage = resolveImageToken({ token: targetToken, rt: args.rt, imageSession });
    // 如果 target 解析失败，且本轮用户上传了图片，用上传图作为 target
    if (!resolvedTargetImage) {
      const userImage = findLatestUserImageSource(args.rt);
      if (userImage) resolvedTargetImage = userImage;
    }
    if (resolvedTargetImage) nextArgs.resolvedTargetImage = resolvedTargetImage;
    if (!Array.isArray(nextArgs.referenceImages) || nextArgs.referenceImages.length === 0) {
      delete nextArgs.referenceImages;
    }
  }

  if (resolvedReferenceImages.length > 0) {
    nextArgs.resolvedReferenceImages = resolvedReferenceImages;
  }
  return nextArgs;
}

function applyCrabImageToolResultToThread(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  output: unknown;
  rt: ReturnType<typeof createRunTarget>;
}) {
  const thread = (args.rt.getThread?.() ?? null) as any;
  const payload = args.output && typeof args.output === "object" ? (args.output as any) : null;
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  const source = args.toolName === "mcp.crab-image.edit_image" ? "edited" : "generated";
  // 无论 thread 是否可用，先写热缓存
  for (const artifact of artifacts) {
    const absPath = String(artifact?.absPath ?? "").trim();
    if (absPath) _cacheImageArtifact(absPath, source as "generated" | "edited");
  }
  if (!thread || typeof thread !== "object") {
    console.warn("[CrabImage] applyCrabImageToolResult: thread is null/invalid, imageSession skipped but cache updated");
    return;
  }
  if (artifacts.length === 0) return;
  const session = normalizeThreadImageSession(thread?.imageSession) ?? {
    v: 1,
    recentArtifacts: [],
    lastGeneratedArtifactId: null,
    lastEditedArtifactId: null,
    defaultAspectRatio: null,
    preferredProvider: "gemini_nb",
    updatedAt: new Date().toISOString(),
  };
  const createdAt = new Date().toISOString();
  const promptKey = args.toolName === "mcp.crab-image.edit_image" ? "editPrompt" : "prompt";
  const prompt = String((args.toolArgs as any)?.[promptKey] ?? "").trim();
  const aspectRatio = String((args.toolArgs as any)?.aspectRatio ?? "").trim() || null;
  const nextRecent = [...session.recentArtifacts];
  let lastArtifactId = source === "edited" ? session.lastEditedArtifactId ?? null : session.lastGeneratedArtifactId ?? null;

  for (const artifact of artifacts) {
    const absPath = String(artifact?.absPath ?? "").trim();
    if (!absPath) continue;
    const artifactId = makeImageArtifactId(absPath);
    lastArtifactId = artifactId;
    const nextItem = {
      artifactId,
      path: absPath,
      source,
      createdAt,
      ...(prompt ? { prompt } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(String(artifact?.mimeType ?? "").trim() ? { mimeType: String(artifact.mimeType).trim() } : {}),
    } as const;
    const existingIndex = nextRecent.findIndex((item) => String(item?.artifactId ?? "").trim() === artifactId || String(item?.path ?? "").trim() === absPath);
    if (existingIndex >= 0) nextRecent.splice(existingIndex, 1);
    nextRecent.push(nextItem as any);
  }

  const nextThread = {
    ...thread,
    imageSession: {
      ...session,
      recentArtifacts: nextRecent.slice(-24),
      ...(source === "generated" ? { lastGeneratedArtifactId: lastArtifactId } : {}),
      ...(source === "edited" ? { lastEditedArtifactId: lastArtifactId } : {}),
      ...(aspectRatio ? { defaultAspectRatio: aspectRatio } : {}),
      preferredProvider: "gemini_nb",
      updatedAt: createdAt,
    },
  };
  args.rt.setThread?.(nextThread);
}

function buildCrabImageTranscriptEntry(args: {
  toolCallId: string;
  toolName: string;
  output: unknown;
  agentId?: string | null;
  agentName?: string | null;
}) {
  const payload = args.output && typeof args.output === "object" ? (args.output as any) : null;
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  if (artifacts.length === 0) return null;
  const parts = artifacts
    .map((artifact: any, index: number) => {
      const absPath = String(artifact?.absPath ?? "").trim();
      if (!absPath) return null;
      const label = String(artifact?.name ?? "").trim() || `image-${index + 1}`;
      return {
        type: "image",
        id: `${args.toolCallId || args.toolName}_image_${index}`,
        source: { kind: "local", path: absPath },
        alt: label,
        caption: label,
      };
    })
    .filter(Boolean);
  const summary = String(payload?.summary ?? payload?.text ?? "").trim();
  if (summary) {
    parts.push({
      type: "markdown",
      id: `${args.toolCallId || args.toolName}_image_summary`,
      text: summary,
    });
  }
  if (parts.length === 0) return null;
  return {
    kind: "assistant_message",
    id: `${args.toolCallId || args.toolName}:image`,
    turnId: undefined,
    order: { turnSeq: 0, itemSeq: 0, subSeq: 0 },
    author: args.agentId ? "subagent" : "main",
    ...(args.agentId ? { agentId: args.agentId, agentName: args.agentName ?? undefined } : {}),
    parts,
    streaming: false,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function startGatewayRunWs(args: GatewayRunArgs): GatewayRunController {
  // 取消该对话已有的 run（同一对话不允许并发）
  if (args.convId) cancelConvRun(args.convId, "replaced_by_new_run");

  const rt = createRunTarget(args.convId ?? "");
  const {
    setRunning,
    setActivity,
    addAssistant,
    appendAssistantDelta,
    finishAssistant,
    patchAssistant,
    addTool,
    patchTool,
    updateMainDoc,
    updateTodo,
    log,
  } = rt;

  const getProjectedRtSteps = () =>
    getProjectedStepsFromRuntime({
      steps: rt.getSteps() ?? [],
      items: rt.getItems() ?? [],
      activeItemIds: rt.getActiveItemIds() ?? [],
      collabSessions: rt.getCollabSessions() ?? [],
    });

  const preferNonEmptyString = (incoming: unknown, previous: unknown) => {
    const next = typeof incoming === "string" ? incoming : "";
    if (next.trim()) return next;
    const prev = typeof previous === "string" ? previous : "";
    return prev;
  };

  const mergeRuntimeItem = (previous: any, incoming: any) => {
    if (!previous || typeof previous !== "object") return incoming;
    if (!incoming || typeof incoming !== "object") return previous;
    return {
      ...previous,
      ...incoming,
      text: preferNonEmptyString(incoming?.text, previous?.text),
      message: preferNonEmptyString(incoming?.message, previous?.message),
      summary: preferNonEmptyString(incoming?.summary, previous?.summary),
      content: preferNonEmptyString(incoming?.content, previous?.content),
    };
  };

  const normalizeIncomingToolOutput = (toolName: string, output: unknown) => {
    if (output === undefined) return output;
    return isToolResultEnvelope(output) ? output : compactToolResultEnvelope(toolName, output);
  };

  const normalizeIncomingRuntimeItem = (item: any) => {
    if (!item || typeof item !== "object") return item;
    if (String(item?.type ?? "").trim() !== "toolCall") return item;
    const toolName = String(item?.name ?? "").trim();
    if (!toolName || item?.result === undefined) return item;
    return {
      ...item,
      result: normalizeIncomingToolOutput(toolName, item.result),
    };
  };

  const upsertRuntimeItemByLogicalKey = (items: any[], incomingItem: any) => {
    const normalizedIncoming = normalizeIncomingRuntimeItem(incomingItem);
    const nextItems = Array.isArray(items) ? items.slice() : [];
    const logicalToolCallId =
      String(normalizedIncoming?.type ?? "").trim() === "toolCall"
        ? String(normalizedIncoming?.toolCallId ?? "").trim()
        : "";
    const existingIndex = logicalToolCallId
      ? nextItems.findIndex((entry) => String((entry as any)?.toolCallId ?? "").trim() === logicalToolCallId)
      : nextItems.findIndex((entry) => String((entry as any)?.id ?? "").trim() === String(normalizedIncoming?.id ?? "").trim());
    if (existingIndex < 0) {
      nextItems.push(normalizedIncoming);
      return { items: nextItems, replacedId: null as string | null, itemId: String(normalizedIncoming?.id ?? "").trim() };
    }
    const existing = nextItems[existingIndex];
    const merged = mergeRuntimeItem(existing, normalizedIncoming);
    const replacedId = String((existing as any)?.id ?? "").trim();
    nextItems.splice(existingIndex, 1);
    const deduped = nextItems.filter((entry) => String((entry as any)?.id ?? "").trim() !== String((merged as any)?.id ?? "").trim());
    deduped.push(merged);
    return { items: deduped, replacedId: replacedId || null, itemId: String((merged as any)?.id ?? "").trim() };
  };

  const mergeRuntimeItems = (previousItems: any[], incomingItems: any[]) => {
    const prev = Array.isArray(previousItems) ? previousItems : [];
    const incoming = Array.isArray(incomingItems) ? incomingItems : [];
    if (!prev.length) return incoming.map((item) => normalizeIncomingRuntimeItem(item));
    if (!incoming.length) return prev;
    let merged = prev.slice();
    for (const item of incoming) {
      merged = upsertRuntimeItemByLogicalKey(merged, item).items;
    }
    return merged;
  };

  const applyThreadSnapshot = (payload: any) => {
    const thread = payload?.thread && typeof payload.thread === "object" ? payload.thread : null;
    const currentTurn = payload?.currentTurn && typeof payload.currentTurn === "object" ? payload.currentTurn : null;
    const snapshotItems = Array.isArray(payload?.items) ? payload.items : [];
    const collabSessions = Array.isArray(payload?.collabSessions) ? payload.collabSessions : null;
    const activeItemIds = Array.isArray(payload?.activeItemIds) ? payload.activeItemIds : null;
    const replaceStrategy = String(payload?.stream?.replaceStrategy ?? "").trim();
    const currentRootThreadId = String(rt.getThread()?.id ?? "").trim();
    const incomingThreadId = String(thread?.id ?? "").trim();
    const isRootSnapshot = Boolean(thread && (!currentRootThreadId || !incomingThreadId || currentRootThreadId === incomingThreadId));
    if (isRootSnapshot) {
      rt.setThread(thread);
    }
    if (currentTurn?.id) rt.upsertTurn(currentTurn);
    rt.setItems(
      replaceStrategy === "replace" && isRootSnapshot
        ? snapshotItems.map((item: any) => normalizeIncomingRuntimeItem(item))
        : mergeRuntimeItems(rt.getItems() ?? [], snapshotItems),
    );
    if (collabSessions) rt.setCollabSessions(collabSessions);
    if (activeItemIds) rt.setActiveItemIds(activeItemIds);
  };

  const applyTurnRecord = (turn: any) => {
    if (!turn?.id) return;
    rt.upsertTurn(turn);
  };

  const applyItemEvent = (kind: "started" | "completed" | "delta", payload: any) => {
    const items = rt.getItems();
    const activeItemIds = rt.getActiveItemIds();
    if (kind === "delta") {
      const itemId = String(payload?.itemId ?? "").trim();
      if (!itemId) return;
      const idx = items.findIndex((item: any) => String(item?.id ?? "") === itemId);
      if (idx >= 0) {
        const current = items[idx];
        rt.upsertItem({
          ...current,
          text: `${String(current?.text ?? "")}${String(payload?.delta ?? "")}`,
        });
      }
      return;
    }
    const item = payload?.item && typeof payload.item === "object" ? payload.item : null;
    if (!item?.id) return;
    const upserted = upsertRuntimeItemByLogicalKey(items, item);
    rt.setItems(upserted.items);
    const itemId = upserted.itemId;
    const replacedId = upserted.replacedId;
    if (kind === "started") {
      rt.setActiveItemIds(Array.from(new Set(
        [...activeItemIds.filter((id) => id !== replacedId), itemId].filter(Boolean),
      )));
    } else if (kind === "completed") {
      rt.setActiveItemIds(activeItemIds.filter((id) => id !== itemId && id !== replacedId));
    }
  };

  const getSubAgentStreamKey = (payload: any) => {
    const threadId = String(payload?.threadId ?? payload?.runId ?? payload?.childThreadId ?? "").trim();
    if (threadId) return threadId;
    const agentId = String(payload?.agentId ?? "").trim();
    return agentId || null;
  };

  setRunning(true);
  setActivity("正在构建上下文…", { resetTimer: true });

  // Main Doc goal 初始化
  const cur = rt.getMainDoc();
  if (!cur.goal) {
    const raw = String(args.prompt ?? "").trim();
    const ol = raw.replace(/\s+/g, " ");
    const max = 180;
    const short = ol.length > max ? ol.slice(0, max) + "…（已截断；原始输入见置顶回合/历史）" : ol;
    updateMainDoc({ goal: short });
  }

  // styleLintFailPolicy
  const wantsKeepBest =
    /(lint|linter|风格(对齐|校验|检查)).{0,30}(不过|不通过).{0,30}(保留|留下|用).{0,30}(最高分|最好|最佳)/i.test(
      String(args.prompt ?? ""),
    );
  if (wantsKeepBest) updateMainDoc({ styleLintFailPolicy: "keep_best" });

  // -- Abort / Done / State ------------------------------------------------

  const abort = new AbortController();
  let cancelReason: string | null = null;
  let ended = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const resolveDoneOnce = () => { if (resolveDone) { const r = resolveDone; resolveDone = null; r(); } };

  let currentAssistantId: string | null = null;
  const subAgentBubbles = new Map<string, string>();
  const finishAssistantBubble = (stepId?: string | null) => {
    const id = String(stepId ?? "").trim();
    if (!id) return;
    finishAssistant(id);
    if (currentAssistantId === id) currentAssistantId = null;
  };
  const finishOpenAssistantBubbles = () => {
    finishAssistantBubble(currentAssistantId);
    for (const [, bid] of subAgentBubbles) finishAssistantBubble(bid);
    subAgentBubbles.clear();
  };
  const runStartStepCount = (rt.getSteps() ?? []).length;
  let runDoneNote = "";
  let sawMaxTurnsExceeded = false;
  let lastProgressPhase: string | null = null;
  let lastProgressText = "";
  let lastProgressCheckpointAt = 0;
  let sawExternalToolPhase = false;

  const isInternalToolName = (name: string) => {
    const tool = String(name ?? "").trim();
    return !tool || tool === "time.now" || tool === "run.setTodoList" || tool === "run.done" || tool === "run.mainDoc.get" || tool === "run.mainDoc.update" || tool === "run.todo" || tool.startsWith("run.todo.");
  };

  const emitProgressCheckpoint = (phase: string, text: string, opts?: { force?: boolean }) => {
    const now = Date.now();
    const label = String(text ?? "").trim();
    if (!rt.getIsRunning() || !label) return;
    if (!opts?.force) {
      if (phase && lastProgressPhase === phase && now - lastProgressCheckpointAt < 1200) return;
      if (label === lastProgressText && now - lastProgressCheckpointAt < 2500) return;
    }
    setActivity(label, { resetTimer: true });
    lastProgressPhase = phase || null;
    lastProgressText = label;
    lastProgressCheckpointAt = now;
  };

  const isBenignInterruptedFailure = (value: unknown) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    return /queued user message|skipped due to queued user message|request was aborted|\baborted\b|cancelled|canceled|stalled_timeout/.test(text);
  };

  const clearSettledTodoListIfNeeded = (opts?: { force?: boolean }) => {
    try {
      const todos = Array.isArray((rt as any).getTodoList?.()) ? ((rt as any).getTodoList() as any[]) : [];
      if (!todos.length) return;
      const hasPending = todos.some((item: any) => {
        const status = String(item?.status ?? "").trim();
        return status !== "done" && status !== "skipped";
      });
      if (hasPending && !opts?.force) return;
      useRunStore.getState().setTodoList([] as any);
    } catch {
      // noop
    }
  };

  const classifyNarrationDelta = (raw: string): { mode: "drop" | "progress"; phase?: string; text?: string } | null => {
    const t = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (/^已选用「.+」风格的.+开始创作。?如需切换写法，直接回复即可。?$/.test(t)) {
      return { mode: "drop" };
    }
    if (/^同步启动资料搜索和风格检索[：:]?$/.test(t)) {
      return { mode: "progress", phase: "search", text: "先补几条资料，再继续。" };
    }
    if (/^kb\.search.*超时.*重试.*[：:]?$/.test(t)) {
      return { mode: "progress", phase: "search", text: "知识库检索有点慢，先换轻量方式继续。" };
    }
    if (/^kb\.search.*(?:持续超时|连续超时).*(?:跳过检索|直接写稿|直接落笔|输出文件).*$/.test(t)) {
      return { mode: "progress", phase: "synthesis", text: "知识库检索较慢，先基于现有资料继续。" };
    }
    if (/^OpenClaw 核心信息来自.+直接落笔。?$/.test(t)) {
      return { mode: "progress", phase: "synthesis", text: "先基于现有资料继续整理。" };
    }
    return null;
  };

  const progressTextForTool = (name: string, args: Record<string, unknown>) => {
    const tool = String(name ?? "").trim();
    if (isInternalToolName(tool)) return null;
    if (tool === "kb.search") return { phase: "kb", text: "先翻一下知识库里的相关资料。" };
    if (tool === "web.search" || tool === "web.fetch") return { phase: "search", text: "先补几条资料，再继续。" };
    if (tool === "write" || tool === "doc.previewDiff" || tool === "doc.splitToDir") return { phase: "delivery", text: "正在整理结果，准备交付。" };
    if (tool.startsWith("mcp.")) {
      const lower = tool.toLowerCase();
      if (/(browser_|navigate|goto|snapshot|click|fill|type|wait_for|run_code)/.test(lower)) return { phase: "browser", text: "先看一下当前网页状态。" };
      if (/(search|web_search|fetch|get_page)/.test(lower)) return { phase: "search", text: "先补几条资料，再继续。" };
      if (/(create_document|docx|word|create_workbook|sheet|excel)/.test(lower)) return { phase: "delivery", text: "正在整理结果，准备交付。" };
      return { phase: "tool", text: humanizeToolActivity(tool, args).includes("网页") ? "先处理网页任务。" : "先处理这一步。" };
    }
    return null;
  };
  const syncTodoFailureStateFromRunEnd = (runEndData?: any) => {
    try {
      const failedCount = Number(runEndData?.failureDigest?.failedCount ?? 0) || 0;
      if (failedCount <= 0) return;
      const todos = Array.isArray((rt as any).getTodoList?.()) ? ((rt as any).getTodoList() as any[]) : [];
      const runningTodo = todos.find((item: any) => String(item?.status ?? "") === "in_progress");
      if (!runningTodo?.id) return;
      const firstFailure = Array.isArray(runEndData?.failureDigest?.failedTools) ? runEndData.failureDigest.failedTools[0] : null;
      const toolName = String(firstFailure?.name ?? "步骤").trim() || "步骤";
      const error = String(firstFailure?.error ?? "执行失败").replace(/\s+/g, " ").trim() || "执行失败";
      if (isBenignInterruptedFailure(`${toolName} ${error}`)) return;
      const note = `失败：${toolName} - ${error}`;
      updateTodo(String(runningTodo.id), {
        status: "blocked" as any,
        note: note.length > 220 ? `${note.slice(0, 220).trimEnd()}…` : note,
      });
      log("warn", "workflow.todo.blocked_on_run_failure", {
        todoId: String(runningTodo.id),
        failedCount,
        toolName,
      });
    } catch {
      // noop
    }
  };

  // Watchdog
  let lastProgressAt = Date.now();
  let stalledLogged = false;
  let watchdogId: number | null = null;
  const bumpProgress = () => { lastProgressAt = Date.now(); stalledLogged = false; };
  const clearWatchdog = () => {
    if (watchdogId !== null) { try { window.clearInterval(watchdogId); } catch {} watchdogId = null; }
  };
  try {
    watchdogId = window.setInterval(() => {
      try {
        if (ended || abort.signal.aborted || !rt.getIsRunning()) return;
        const ms = Date.now() - lastProgressAt;
        if (ms >= 660_000) {
          log("error", "ws.run.stalled_timeout", { idleMs: ms, cancelReason });
          cancelReason = cancelReason || "stalled_timeout";
          try { (abort as any).abort("stalled_timeout"); } catch { abort.abort(); }
          setActivity(`连接已中断（已 ${Math.floor(ms / 1000)}s 无新事件）`, { resetTimer: false });
          return;
        }
        if (ms < 540_000 || stalledLogged) return;
        stalledLogged = true;
        log("warn", "ws.run.stalled", { idleMs: ms, cancelReason });
        setActivity(`连接可能中断…（已 ${Math.floor(ms / 1000)}s 无新事件，可尝试停止/重试）`, { resetTimer: false });
      } catch {}
    }, 2000);
  } catch {}

  // Keep a reference so cancel() can close the socket
  let socketRef: WebSocket | null = null;
  // 防止旧 run 的 finally 清除新 run 的 cancel 句柄
  let cancelledExternally = false;

  /**
   * 触发一次记忆提取：把 [memoryCursor, nextCursor) 区间的原文传给 extractMemory。
   * 先做游标去重——若 nextCursor <= 当前 memoryCursor 则跳过。
   */
  const enqueueMemoryExtract = (dialogueText: string, nextCursor: number) => {
    const mode = (args.mode === "chat" ? "chat" : "agent") as "agent" | "chat";
    const memoryCursor = readMemoryExtractCursor(mode);
    if (!dialogueText.trim() || nextCursor <= memoryCursor) return;

    const projStore = useProjectStore.getState();
    const rootDir = projStore.rootDir ?? "";
    const projectName = rootDir ? (rootDir.split(/[/\\]/).pop() ?? "") : "";

    // 先推进游标，防止并发触发时重复提交
    try {
      useRunStore.getState().setMemoryExtractTurnCursor(mode, nextCursor);
    } catch {
      // ignore
    }

    import("../state/memoryStore")
      .then(({ useMemoryStore }) => {
        void useMemoryStore.getState().extractMemory({ dialogueSummary: dialogueText, projectName, rootDir });
      })
      .catch(() => void 0);
  };

  // -- Async run -----------------------------------------------------------

  (async () => {
    log("info", "ws.run.start", { gatewayUrl: args.gatewayUrl, model: args.model, mode: args.mode });
    try {
      bumpProgress();

      // ====================================================================
      // 1. Pre-request preparation (mirrors SSE path in startGatewayRun)
      // ====================================================================

      let promptForGateway = String(args.prompt ?? "");

      // -- refs ---
      const promptRefs = parseRefsFromPrompt(args.prompt);
      const pinned = (rt.getCtxRefs() ?? []).map((r: any) => ({
        kind: r?.kind === "dir" ? ("dir" as const) : ("file" as const),
        path: String(r?.path ?? "").trim(),
      }));
      const effectiveRefs = (() => {
        const seen = new Set<string>();
        const out: Ref[] = [];
        const push = (r: Ref) => {
          const kind = r.kind === "dir" ? "dir" : "file";
          let p = String(r.path ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
          p = p.replace(/\/+/g, "/");
          if (!p) return;
          p = p.replace(/\/+$/g, "");
          const key = `${kind}:${p}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push({ kind, path: p });
        };
        for (const r of pinned) push(r);
        for (const r of promptRefs) push(r);
        return out;
      })();
      if (promptRefs.length) {
        for (const r of promptRefs) rt.addCtxRef({ kind: r.kind, path: r.path } as any);
      }
      const referencesText = await buildReferencesTextFromRefs(effectiveRefs).catch(() => "");
      setActivity("正在构建上下文…");
      bumpProgress();

      // -- ensure loaded ---
      const proj = useProjectStore.getState();
      if (proj.activePath) await proj.ensureLoaded(proj.activePath).catch(() => void 0);

      // -- KB refresh ---
      await useKbStore.getState().refreshLibraries().catch(() => void 0);

      // -- Selector V1 ---
      // 绑定机制已废弃，styleContractV1 不再基于 kbAttachedLibraryIds 自动选择
      // 风格库的选择由 @ 提及或 agent 主动触发
      try {
        const main: any = rt.getMainDoc() ?? {};
        const existing = main?.styleContractV1;
        const libsMeta = useKbStore.getState().libraries ?? [];
        const metaById = new Map(libsMeta.map((l: any) => [String(l?.id ?? "").trim(), l]));
        // 不再自动从绑定中获取风格库 — 用户通过 @ 提及
        const libId = "";
        const existingLibId = String(existing?.libraryId ?? "").trim();
        const existingClusterId = String(existing?.selectedCluster?.id ?? "").trim();
        const shouldConsider = libId && (!existing || existingLibId !== libId || !existingClusterId);

        if (shouldConsider) {
          const activeForThisRun = activateSkills({
            mode: args.mode as any, userPrompt: String(args.prompt ?? ""),
            mainDocRunIntent: main?.runIntent, kbSelected: [] as any,
          });
          const hasStyleSkill = activeForThisRun.some((s: any) => String(s?.id ?? "") === "style_imitate");
          if (hasStyleSkill) {
            const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
            const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
            const clusters = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
            const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
            const defaultClusterId = cfg?.ok ? String((cfg as any).defaultClusterId ?? "").trim() : "";
            const rulesByCluster =
              cfg?.ok && (cfg as any)?.clusterRulesV1 && typeof (cfg as any).clusterRulesV1 === "object"
                ? (cfg as any).clusterRulesV1 : null;

            if (clusters.length) {
              const prompt = String(args.prompt ?? "").trim();
              const topicText = buildTopicTextForSelectorV1({ userPrompt: prompt, mainDoc: main });
              const pickedByPrompt = (() => {
                const m = prompt.match(/\b(cluster[_-]\d+)\b/i);
                if (m?.[1]) {
                  const cid = String(m[1]).replace("-", "_");
                  const cById = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
                  if (cById.get(cid)) return cById.get(cid);
                }
                const m2 = prompt.match(/写法\s*([ABC])\b/i);
                if (m2?.[1]) {
                  const label = `写法${String(m2[1]).toUpperCase()}`;
                  const hit = clusters.find((c: any) => String(c?.label ?? "").includes(label));
                  if (hit) return hit;
                }
                if (/^(继续|按推荐|用推荐|就用推荐|默认就行)$/i.test(prompt)) return "__USE_RECOMMENDED__" as any;
                return null;
              })();

              const cById = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
              let picked: any = null;
              if (pickedByPrompt && pickedByPrompt !== "__USE_RECOMMENDED__") picked = pickedByPrompt;
              if (!picked) {
                const auto = pickClusterSelectorV1({ clusters, defaultClusterId, topicText });
                if (auto?.selectedId && cById.get(String(auto.selectedId).trim())) picked = cById.get(String(auto.selectedId).trim());
              }

              if (picked) {
                const meta = metaById.get(libId) as any;
                const pickedId = String(picked?.id ?? "").trim();
                if (pickedId) {
                  const raw = String(args.prompt ?? "").trim();
                  const looksLikePureChoice =
                    raw.length <= 16 &&
                    (/^(写法\s*[ABC]\b|cluster[_-]\d+\b|继续|按推荐|用推荐|就用推荐|默认就行)[\s。！？!]*$/i.test(raw) ||
                      /^就用写法\s*[ABC]\b[\s。！？!]*$/i.test(raw));
                  if (looksLikePureChoice) promptForGateway = `继续（已选 ${pickedId}）`;
                }
                const pickedRules = (() => {
                  if (!pickedId || !rulesByCluster) return null;
                  try { const r = (rulesByCluster as any)[pickedId]; return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; }
                })();
                updateMainDoc({
                  styleContractV1: {
                    v: 1, updatedAt: new Date().toISOString(),
                    libraryId: libId, libraryName: String(meta?.name ?? libId),
                    selectedCluster: { id: String(picked?.id ?? "").trim(), label: String(picked?.label ?? "").trim() },
                    clusterRulesV1: pickedRules,
                    values: pickedRules?.values ?? null,
                    analysisLenses: pickedRules?.analysisLenses ?? null,
                    anchorsCount: Array.isArray(picked?.anchors) ? picked.anchors.length : 0,
                    anchorsFeatures: Array.isArray(picked?.anchors)
                      ? picked.anchors.slice(0, 5).map((a: any) => summarizeQuoteAsFeatureV1(typeof a === "string" ? a : String(a?.text ?? a?.content ?? a?.quote ?? ""))).filter(Boolean) : [],
                    evidenceFeatures: Array.isArray(picked?.evidence)
                      ? picked.evidence.slice(0, 5).map((e: any) => summarizeQuoteAsFeatureV1(String(e?.quote ?? ""))).filter(Boolean) : [],
                    softRanges: picked?.softRanges ?? {},
                    facetPlan: Array.isArray(picked?.facetPlan) ? picked.facetPlan.slice(0, 8) : [],
                    queries: Array.isArray(picked?.queries) ? picked.queries.slice(0, 8) : [],
                  },
                } as any);
              }
            }
          }
        }
      } catch {
        // ignore: selector V1 failure doesn't block the run
      }

      // -- Login check ---
      // 直接读 authStore，避免循环依赖 gatewayAgent → wsTransport → gatewayAgent
      const _isDev = (import.meta as any).env?.DEV === true || String((import.meta as any).env?.MODE ?? "") !== "production";
      if (!_isDev) {
        const _token = String(useAuthStore.getState().accessToken ?? "").trim();
        if (!_token) {
          try {
            useAuthStore.getState().openLoginModal?.();
            useAuthStore.setState({ error: "请先登录再使用 AI 功能" });
          } catch {}
          const a = addAssistant("", false, false);
          patchAssistant(a, { hidden: false });
          appendAssistantDelta(a, "\n\n[需要登录] 未登录无法使用 AI 功能，请先登录后再试。");
          finishAssistant(a);
          setRunning(false); setActivity(null);
          return;
        }
      }

      // -- toolSidecar ---
      setActivity("正在请求模型…", { resetTimer: true });
      bumpProgress();

      const toolSidecar = await (async () => {
        const p = useProjectStore.getState();
        // 优先用全量索引（含所有文件类型），回退到 projectStore（仅 .md/.mdx/.txt）
        const idxFiles = useProjectIndexStore.getState().index?.files;
        const projectFiles = idxFiles?.length
          ? idxFiles.map((f) => ({ path: f.path, type: f.type })).slice(0, 5000)
          : (p.files ?? [])
              .map((f: any) => ({ path: String(f?.path ?? "").trim() }))
              .filter((f: any) => f.path).slice(0, 5000);

        const mentionLibIds = Array.isArray(args.kbMentionIds)
          ? Array.from(new Set(args.kbMentionIds.map((x) => String(x ?? "").trim()).filter(Boolean)))
          : [];
        const threadSkillIds = Array.isArray(rt.getThread()?.activeSkillRefs)
          ? (rt.getThread()!.activeSkillRefs as any[]).map((item: any) => String(item?.id ?? "").trim()).filter(Boolean)
          : [];
        const requestedSkillIds = Array.from(new Set([
          ...(Array.isArray(args.skillRefs) && args.skillRefs.length > 0
            ? args.skillRefs.map((item) => String(item?.id ?? "").trim()).filter(Boolean)
            : []),
          ...threadSkillIds,
        ]));
        const att = rt.getKbAttachedLibraryIds() ?? [];
        const styleWorkflowRequested = Boolean((args as any)?.styleWorkflowRequested) || isStyleWorkflowRequestedForRun({
          activeSkillIds: requestedSkillIds,
          mentionedLibraryIds: mentionLibIds,
          libraries: useKbStore.getState().libraries ?? [],
          mainDoc: rt.getMainDoc() as any,
          thread: rt.getThread() as any,
          workflowSkills: (rt as any).getWorkflowSkills?.() ?? (useRunStore.getState() as any).workflowSkills ?? {},
        });
        const sidecarLibraryIds = styleWorkflowRequested
          ? resolveImplicitStyleLibraryIds({
              mentionedLibraryIds: mentionLibIds,
              attachedLibraryIds: att,
              libraries: useKbStore.getState().libraries ?? [],
              mainDoc: rt.getMainDoc() as any,
              allowHistoricalFallback: shouldAllowHistoricalStyleFallback({
                activeSkillIds: requestedSkillIds,
                mentionedLibraryIds: mentionLibIds,
              }),
            })
          : [];
        let styleLinterLibraries: any[] | undefined;
        if (Array.isArray(sidecarLibraryIds) && sidecarLibraryIds.length) {
          const ret = await buildStyleLinterLibrariesSidecar({ libraryIds: sidecarLibraryIds, maxLibraries: 6 }).catch(() => ({ ok: false } as any));
          if (ret?.ok && Array.isArray(ret.libraries) && ret.libraries.length) styleLinterLibraries = ret.libraries;
        }

        const ed = p.editorRef;
        const { hasSelection, selectionChars } = (() => {
          const model = ed?.getModel(); const sel = ed?.getSelection();
          if (!ed || !model || !sel) return { hasSelection: false, selectionChars: 0 };
          const n = model.getValueInRange(sel).length;
          return { hasSelection: n > 0, selectionChars: n };
        })();
        const ideSummary = {
          projectDir: p.rootDir ?? null,
          activePath: p.activePath ?? null,
          openPaths: p.openPaths?.length ?? 0,
          fileCount: p.files?.length ?? 0,
          hasSelection, selectionChars,
        };
        const out: any = { projectFiles, ideSummary };
        if (styleLinterLibraries) out.styleLinterLibraries = styleLinterLibraries;

        // MCP 工具快照：将已连接的 MCP Server 工具注入 sidecar
        try {
          const mcpApi = (window as any).desktop?.mcp;
          if (mcpApi) {
            const servers = await mcpApi.getServers();
            const serverList = Array.isArray(servers) ? servers : [];
            const connectedWithTools = serverList.filter((s: any) => s.status === "connected" && Array.isArray((s.agentTools ?? s.tools)) && (s.agentTools ?? s.tools).length);
            const mcpServers = connectedWithTools.map((s: any) => {
              const agentTools = Array.isArray(s.agentTools) ? s.agentTools : (Array.isArray(s.tools) ? s.tools : []);
              return {
                serverId: s.id,
                serverName: s.name,
                status: s.status,
                toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
                agentToolCount: Array.isArray(agentTools) ? agentTools.length : 0,
                familyHint: String(s.resolvedFamily ?? s.config?.familyHint ?? ""),
                toolProfile: String(s.resolvedToolProfile ?? s.config?.toolProfile ?? ""),
                toolNamesSample: Array.isArray(agentTools) ? agentTools.slice(0, 12).map((t: any) => String(t?.name ?? "")).filter(Boolean) : [],
              };
            });
            const mcpTools = connectedWithTools
              .flatMap((s: any) => {
                const agentTools = Array.isArray(s.agentTools) ? s.agentTools : (Array.isArray(s.tools) ? s.tools : []);
                return agentTools.map((t: any) => ({
                  name: `mcp.${s.id}.${t.name}`,
                  description: `[MCP:${s.name}] ${t.description ?? ""}`,
                  inputSchema: t.inputSchema ?? null,
                  serverId: s.id,
                  serverName: s.name,
                  originalName: t.name,
                }));
              });
            if (mcpServers.length) out.mcpServers = mcpServers;
            if (mcpTools.length) out.mcpTools = mcpTools;
            log("info", "sidecar.mcp", {
              mcpApiAvailable: true,
              servers: serverList.length,
              connected: connectedWithTools.length,
              selectedServers: mcpServers.map((s: any) => s.serverId),
              tools: mcpTools.length,
            });
          } else {
            log("info", "sidecar.mcp", { mcpApiAvailable: false });
          }
        } catch (e: any) {
          log("warn", "sidecar.mcp.error", { error: String(e?.message ?? e) });
        }

        return out;
      })();

      // -- dialogue summary ---
      let portablePreRunCompact: Record<string, unknown> | null = null;
      try {
        const r = await rollDialogueSummaryIfNeeded({ gatewayUrl: args.gatewayUrl, mode: args.mode, abort, log });
        if (r?.rolled) {
          setActivity("正在构建上下文…", { resetTimer: false });
          // 摘要成功后：用 delta 原文（非压缩后的摘要）触发记忆提取，避免二次有损压缩
          const rolledResult = r as { rolled: true; delta: Array<{ user: string; assistant: string }>; newCursor: number };
          const dialogueText = formatDialogueTurnsForMemoryExtract(rolledResult.delta ?? []);
          enqueueMemoryExtract(dialogueText, rolledResult.newCursor ?? 0);
          portablePreRunCompact =
            r?.portablePreRunCompact && typeof r.portablePreRunCompact === "object" && !Array.isArray(r.portablePreRunCompact)
              ? (r.portablePreRunCompact as Record<string, unknown>)
              : null;
        }
      } catch (e: any) {
        log("warn", "context.summary.exception", { error: e?.message ? String(e.message) : String(e) });
      }

      // -- context pack ---
      const contextPack =
        args.mode === "chat"
          ? buildChatContextPack({ referencesText, userPrompt: promptForGateway })
          : await buildContextPack({
              referencesText,
              userPrompt: promptForGateway,
              kbMentionIds: args.kbMentionIds,
              skillRefs: args.skillRefs,
            });

      // P3：结构化 contextSegments（优先）+ contextPack 兼容（fallback）。
      // 当前 buildContextPack 返回的大字符串内部已是段落结构（NAME(JSON/Markdown):\n...），
      // 这里先走“从字符串提取 segment”的过渡方案，后续可直接改为 buildContextSegmentsV1()。
      const contextSegments: ContextSegmentV1[] = (() => {
        const extractFirstJsonValue = (raw: string) => {
          const text = String(raw ?? "").trim();
          if (!text) return "";
          if (!text.startsWith("{") && !text.startsWith("[")) return text;
          // 尝试从“前缀 JSON + 追加提示文本”的结构中，截出第一段可解析 JSON。
          for (let i = text.length; i >= 2; i--) {
            const ch = text[i - 1];
            if (ch !== "}" && ch !== "]") continue;
            const cand = text.slice(0, i);
            try {
              JSON.parse(cand);
              return cand;
            } catch {
              // continue
            }
          }
          return text;
        };

        const text = String(contextPack ?? "");
        const re = /(?:^|\n)([A-Z0-9_]+)\((JSON|Markdown)\):\n([\s\S]*?)(?=\n[A-Z0-9_]+\((?:JSON|Markdown)\):\n|$)/g;
        const out: ContextSegmentV1[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const name = String(m[1] ?? "").trim();
          const format = String(m[2] ?? "").trim() === "Markdown" ? "Markdown" : "JSON";
          const contentRaw = String(m[3] ?? "").trim();
          const content = format === "JSON" ? extractFirstJsonValue(contentRaw) : contentRaw;
          if (!name || !content) continue;
          const trusted = !/^(REFERENCES|KB_LIBRARY_PLAYBOOK|STYLE_SELECTOR|KB_STYLE_CLUSTERS|STYLE_DIMENSIONS|STYLE_CATALOG)$/.test(name);
          out.push({
            id: name,
            name,
            kind: name === "MAIN_DOC" || name === "RUN_TODO" || name === "TASK_STATE" ? "taskState" : trusted ? "meta" : "materials",
            priority: name === "MAIN_DOC" || name === "RUN_TODO" || name === "TASK_STATE" ? "p0" : "p1",
            trusted,
            format: format as any,
            content,
            meta: { source: "desktop" },
          });
        }
        return out.slice(0, 200);
      })();

      // Project Map v2：先给结构地图，再决定是否定点读文件
      try {
        const p = useProjectStore.getState();
        const idxState = useProjectIndexStore.getState();
        const idx = idxState.index;
        const seg = buildProjectMapSegmentV2({
          rootDir: p.rootDir ?? null,
          index: idx?.rootDir && p.rootDir && idx.rootDir === p.rootDir ? idx : null,
        });
        if (seg) contextSegments.push(seg);
        const summarySegs = buildProjectSummarySegmentsV1({
          rootDir: p.rootDir ?? null,
          summaries: idx?.rootDir && p.rootDir && idx.rootDir === p.rootDir
            ? {
                version: 1,
                rootDir: idx.rootDir,
                updatedAt: idx.updatedAt,
                projectKind: idxState.projectKind ?? "content",
                dirs: idxState.dirSummaries ?? [],
                files: idxState.fileSummaries ?? [],
              }
            : null,
          userPrompt: String(args.prompt ?? ""),
        });
        if (summarySegs.length) contextSegments.push(...summarySegs);
      } catch {
        // ignore
      }

      const contextManifest = buildContextManifestV1({ mode: args.mode, segments: contextSegments });
      const contextPackCompat = renderContextPackV1({ mode: args.mode, segments: contextSegments, manifest: contextManifest });

      // ====================================================================
      // 2. WebSocket connection
      // ====================================================================

      const token = String(useAuthStore.getState().accessToken ?? "").trim();
      const wsBase = toWsBase(args.gatewayUrl);
      const wsUrl = `${wsBase}/ws/agent/run?token=${encodeURIComponent(token)}`;

      if (_isDev) {
        console.group("[ws-run] connect");
        console.log("url:", wsUrl.replace(/token=[^&]+/, "token=***"));
        console.log("mode:", args.mode, "model:", args.model);
        console.log("prompt:", promptForGateway.slice(0, 200));
        console.log("contextPack length:", contextPack.length);
        console.groupEnd();
      }

      const socket = new WebSocket(wsUrl);
      socketRef = socket;

      // Wait for open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error("WS_CONNECT_TIMEOUT")); }, 15_000);
        socket.onopen = () => { clearTimeout(timeout); resolve(); };
        socket.onerror = () => { clearTimeout(timeout); reject(new Error("WS_CONNECT_FAILED")); };
      });

      if (abort.signal.aborted) {
        try { socket.close(1000, "CANCELLED"); } catch {}
        return;
      }

      // ====================================================================
      // 3. Send run.request
      // ====================================================================

      // 外部扩展包 skill manifests（发给 Gateway，使其也能参与激活计算）
      const { externalSkills, skillOverrides } = (await import("../state/skillStore")).useSkillStore.getState();
      const userSkillManifests = externalSkills?.length
        ? externalSkills.map((manifest) => {
            const override = skillOverrides[String(manifest?.id ?? "").trim()];
            if (typeof override?.enabled === "boolean") return { ...manifest, autoEnable: override.enabled };
            return manifest;
          })
        : undefined;
      const projectRootForAgents = String(useProjectStore.getState().rootDir ?? "").trim();
      const userAgentDefinitions = window.desktop?.agents?.list
        ? await window.desktop.agents.list({
            projectRoots: projectRootForAgents ? [projectRootForAgents] : [],
          }).catch(() => [])
        : undefined;
      const builtinOverrides = Object.fromEntries(
        Object.entries(skillOverrides ?? {})
          .filter(([, override]) => typeof override?.enabled === "boolean")
          .map(([id, override]) => [id, { enabled: override!.enabled }]),
      );
      const hasBuiltinOverrides = Object.keys(builtinOverrides).length > 0;

      const runStateAny: any = useRunStore.getState();
      const threadState = runStateAny?.thread && typeof runStateAny.thread === "object" ? runStateAny.thread : null;
      const skillRefSource = [
        ...(Array.isArray(threadState?.activeSkillRefs) ? threadState.activeSkillRefs : []),
        ...(Array.isArray(args.skillRefs) ? args.skillRefs : []),
      ];
      const derivedSkillRefs = Array.from(
        new Map(
          skillRefSource
            .map((item: any) => ({
              id: String(item?.id ?? "").trim(),
              source: item?.source === "admin" ? "admin" : item?.source === "user" ? "user" : "builtin",
              activation: item?.activation === "auto" ? "auto" : item?.activation === "sticky" ? "sticky" : "explicit",
              scope: item?.scope === "turn" ? "turn" : "thread",
              configPath: typeof item?.configPath === "string" ? item.configPath : null,
              enabled: item?.enabled !== false,
            }))
            .filter((item) => item.id)
            .map((item) => [item.id, item] as const),
        ).values(),
      );

      socket.send(JSON.stringify({
        type: "run.request",
        payload: {
          ...(args.convId ? { convId: args.convId } : {}),
          ...(threadState?.id ? { threadId: threadState.id } : {}),
          model: args.model,
          mode: args.mode,
          opMode: args.opMode ?? "creative",
          prompt: promptForGateway,
          contextPack: contextPackCompat,
          contextSegments,
          contextManifest,
          toolSidecar,
          ...(args.images?.length ? { images: args.images } : {}),
          ...(derivedSkillRefs.length ? { skillRefs: derivedSkillRefs } : {}),
          ...(Array.isArray(args.skillInvocations) && args.skillInvocations.length ? { skillInvocations: args.skillInvocations } : {}),
          ...(threadState
            ? {
                threadSnapshotHint: {
                  threadId: threadState.id,
                  activeSkillRefs: Array.isArray(threadState.activeSkillRefs)
                    ? threadState.activeSkillRefs
                    : undefined,
                  capabilityState: threadState.capabilityState ?? undefined,
                  waitingFor: typeof threadState.waitingFor === "string" ? threadState.waitingFor : undefined,
                  pendingApprovalIds: Array.isArray(threadState.pendingApprovalIds)
                    ? threadState.pendingApprovalIds.map((item: any) => String(item ?? "").trim()).filter(Boolean)
                    : undefined,
                  pendingArtifactIds: Array.isArray((runStateAny as any)?.pendingArtifacts)
                    ? (runStateAny as any).pendingArtifacts
                        .map((item: any) => String(item?.id ?? "").trim())
                        .filter(Boolean)
                    : undefined,
                  collabSessionIds: Array.isArray(runStateAny?.collabSessions)
                    ? runStateAny.collabSessions.map((item: any) => String(item?.id ?? "").trim()).filter(Boolean)
                    : undefined,
                  collabSessions: Array.isArray(runStateAny?.collabSessions)
                    ? runStateAny.collabSessions
                    : undefined,
                  imageSession: threadState.imageSession ?? undefined,
                },
              }
            : {}),
          ...(portablePreRunCompact ? { portablePreRunCompact } : {}),
          ...(typeof (args as any).styleWorkflowRequested === "boolean" ? { styleWorkflowRequested: Boolean((args as any).styleWorkflowRequested) } : {}),
          ...(args.styleExecutionMode ? { styleExecutionMode: args.styleExecutionMode } : {}),
          ...(args.stylePipelinePayload ? { stylePipelinePayload: args.stylePipelinePayload } : {}),
          ...(hasBuiltinOverrides ? { builtinOverrides } : {}),
          ...(userSkillManifests ? { userSkillManifests } : {}),
          ...(Array.isArray(userAgentDefinitions) && userAgentDefinitions.length ? { userAgentDefinitions } : {}),
        },
      }));

      bumpProgress();

      // ====================================================================
      // 4. Event handling
      // ====================================================================

      let runId: string | null = null;
      const gatewayToolStepIdsByCallId = new Map<string, string[]>();

      const ensureAssistant = () => {
        if (currentAssistantId) return currentAssistantId;
        currentAssistantId = addAssistant("", true, false);
        return currentAssistantId;
      };

      const finishAssistantBubble = (stepId?: string | null) => {
        const id = String(stepId ?? "").trim();
        if (!id) return;
        finishAssistant(id);
        if (currentAssistantId === id) currentAssistantId = null;
      };

      const finishOpenAssistantBubbles = () => {
        finishAssistantBubble(currentAssistantId);
        for (const [, bid] of subAgentBubbles) finishAssistantBubble(bid);
        subAgentBubbles.clear();
      };

      const ensureSubAgentBubble = (agentId: string, agentName?: string) => {
        const existing = subAgentBubbles.get(agentId);
        if (existing) return existing;
        const id = addAssistant("", true, false, { agentId, agentName });
        subAgentBubbles.set(agentId, id);
        return id;
      };

      const summarizeStepFailure = (step: any) => {
        const toolName = String(step?.toolName ?? "unknown");
        const input = step?.input && typeof step.input === "object" ? (step.input as any) : null;
        const outputRaw = getToolResultEnvelopePayload(step?.output);
        const output = outputRaw && typeof outputRaw === "object" ? (outputRaw as any) : null;
        const errorCode = String(output?.error ?? "").trim() || "UNKNOWN_ERROR";
        const message = String(output?.message ?? output?.detail ?? "").trim();
        const path = String(output?.path ?? input?.path ?? input?.fromPath ?? "").trim();
        const nextAction = Array.isArray(output?.next_actions)
          ? String(output.next_actions[0] ?? "").trim()
          : "";
        if (isBenignInterruptedFailure(`${errorCode} ${message} ${nextAction}`)) return "";
        const core = `${toolName}: ${errorCode}`;
        const msgPart = message ? `（${message.slice(0, 80)}）` : "";
        const pathPart = path ? ` [path=${path}]` : "";
        const actionPart = nextAction ? `；建议：${nextAction}` : "";
        return `${core}${msgPart}${pathPart}${actionPart}`;
      };

      const maybeAppendRunEndFeedback = (runEndData?: any) => {
        const stepsNow = rt.getSteps() ?? [];
        const runSteps = stepsNow.slice(runStartStepCount);
        const hasAssistantText = runSteps.some(
          (s: any) => s && s.type === "assistant" && s.variant !== "progress" && !s.hidden && String(s.text ?? "").trim().length > 0,
        );
        if (hasAssistantText) return;
        const failedToolSteps = runSteps.filter((s: any) => s && s.type === "tool" && s.status === "failed");
        const stepFailures = failedToolSteps.map((s: any) => summarizeStepFailure(s)).filter(Boolean);
        const digestFailures = Array.isArray(runEndData?.failureDigest?.failedTools)
          ? (runEndData.failureDigest.failedTools as any[])
              .map((x: any) => {
                const name = String(x?.name ?? "").trim() || "unknown";
                const error = String(x?.error ?? "").trim() || "UNKNOWN_ERROR";
                const path = String(x?.path ?? "").trim();
                const action = Array.isArray(x?.next_actions) ? String(x.next_actions[0] ?? "").trim() : "";
                if (isBenignInterruptedFailure(`${error} ${action}`)) return "";
                const base = `${name}: ${error}${path ? ` [path=${path}]` : ""}`;
                return action ? `${base}；建议：${action}` : base;
              })
              .filter(Boolean)
          : [];

        const failures = stepFailures.length ? stepFailures : digestFailures;
        const failedCount = failures.length;
        if (failedCount > 0) {
          const lines = failures.slice(0, 3).map((x) => `- ${x}`);
          const more = failedCount > 3 ? `\n还有 ${failedCount - 3} 项失败，可展开工具步骤查看完整原因。` : "";
          const body = lines.length
            ? `本轮已结束，但有 ${failedCount} 个步骤失败：\n${lines.join("\n")}${more}`
            : `本轮已结束，但有 ${failedCount} 个步骤失败。请展开失败项查看原因。`;
          addAssistant(body, false, false);
          return;
        }
        const note = String(runDoneNote ?? "").trim();
        addAssistant(note ? `本轮已结束。\n${note}` : "本轮已结束。", false, false);
      };

      const submitToolResult = (payload: any) => {
        if (socket.readyState !== WebSocket.OPEN) {
          log("warn", "ws.tool_result.not_open", { readyState: socket.readyState });
          return;
        }
        try {
          socket.send(JSON.stringify({ type: "tool_result", payload }));
        } catch (e: any) {
          log("error", "ws.tool_result.send_failed", { error: String(e?.message ?? e) });
        }
      };

      // Promise that resolves when the run completes (run.end / error / close)
      await new Promise<void>((resolveRun) => {
        let runEnded = false;
        const finish = () => { if (!runEnded) { runEnded = true; resolveRun(); } };

        // Sequential message queue (tool execution is async)
        const queue: MessageEvent[] = [];
        let busy = false;
        let transportSettled = false;

        const finishWhenIdle = () => {
          if (!transportSettled) return;
          if (busy || queue.length > 0) return;
          finish();
        };

        socket.onmessage = (e) => {
          queue.push(e);
          if (!busy) void drainQueue();
        };
        socket.onclose = () => {
          transportSettled = true;
          finishWhenIdle();
        };
        socket.onerror = () => {
          transportSettled = true;
          finishWhenIdle();
        };

        // If user cancels while waiting
        abort.signal.addEventListener("abort", () => {
          try { socket.send(JSON.stringify({ type: "cancel", payload: { reason: cancelReason } })); } catch {}
          try { socket.close(1000, "CANCELLED"); } catch {}
        }, { once: true });

        async function drainQueue() {
          busy = true;
          while (queue.length) {
            if (abort.signal.aborted || ended) { queue.length = 0; break; }
            const e = queue.shift()!;
            try { await handleMessage(e); } catch (err: any) {
              log("error", "ws.message.handler_error", { error: String(err?.message ?? err) });
            }
          }
          busy = false;
          finishWhenIdle();
        }

        async function handleMessage(e: MessageEvent) {
          if (abort.signal.aborted || ended) return;
          bumpProgress();
          let msg: any;
          try { msg = JSON.parse(String(e.data)); } catch { return; }

          if (msg.type === "error") {
            const errCode = String(msg.payload?.error ?? "").trim();
            const errDetail = String(msg.payload?.detail ?? msg.payload?.message ?? "").trim();
            const errMsg = errDetail || errCode || "unknown";
            log("error", "ws.server_error", msg.payload);
            const id = ensureAssistant();
            patchAssistant(id, { hidden: false });
            appendAssistantDelta(
              id,
              `\n\n[服务端错误] ${errMsg}${errCode && errDetail ? `\n错误码：${errCode}` : ""}`,
            );
            finishAssistant(id);
            setRunning(false); setActivity(null);
            finish();
            return;
          }

          if (msg.type !== "event" || !msg.payload) return;

          const event: string = msg.payload.event;
          const data: any = msg.payload.data ?? {};

          if (event === "thread.snapshot") {
            log("info", "thread.snapshot", summarizeThreadSnapshotForLog(data));
            applyThreadSnapshot(data);
            return;
          }

          if (event === "turn.started" || event === "turn.completed") {
            log("info", event, data);
            applyTurnRecord(data?.turn ?? null);
            return;
          }

          if (event === "item.started") {
            applyItemEvent("started", data);
            return;
          }

          if (event === "item.delta") {
            applyItemEvent("delta", data);
            return;
          }

          if (event === "item.completed") {
            applyItemEvent("completed", data);
            return;
          }

          if (event === "thread.waiting.updated") {
            const rootThreadId = String(rt.getThread()?.id ?? "").trim();
            const eventThreadId = String(data?.threadId ?? "").trim();
            if (rootThreadId && eventThreadId && rootThreadId !== eventThreadId) return;
            const prev = rt.getThread() ?? {};
            rt.setThread({
              ...prev,
              waitingFor: data?.waitingFor,
              waiting: data?.waiting ?? null,
            } as any);
            return;
          }

          if (event === "skills.updated") {
            const rootThreadId = String(rt.getThread()?.id ?? "").trim();
            const eventThreadId = String(data?.threadId ?? "").trim();
            if (rootThreadId && eventThreadId && rootThreadId !== eventThreadId) return;
            const activeSkillRefs = Array.isArray(data?.activeSkillRefs) ? data.activeSkillRefs : [];
            const prev = rt.getThread() ?? {};
            rt.setThread({
              ...prev,
              activeSkillRefs,
            } as any);
            return;
          }

          if (event === "collab.session.updated") {
            const session = data?.session && typeof data.session === "object" ? data.session : null;
            if (session?.id) rt.upsertCollabSession(session);
            return;
          }

          // ---- run.start ----
          if (event === "run.start") {
            runId = data?.runId ? String(data.runId) : runId;
            log("info", "agent.run.start", data);
            emitProgressCheckpoint("planning", "先梳理一下这轮任务。", { force: true });
          }

          // ---- run.end ----
          if (event === "run.end") {
            log("info", "agent.run.end", data);
            setRunning(false); setActivity(null);
            finishOpenAssistantBubbles();
            maybeAppendRunEndFeedback(data);
            const endReason = String(data?.reason ?? "").trim().toLowerCase();
            const endReasonCodes = Array.isArray(data?.reasonCodes)
              ? (data.reasonCodes as any[]).map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
              : [];
            const hitMaxTurns = sawMaxTurnsExceeded || endReason === "max_turns" || endReasonCodes.includes("max_turns");
            syncTodoFailureStateFromRunEnd(data);
            const failedCount = Number(data?.failureDigest?.failedCount ?? 0) || 0;
            const shouldForceClearTodo = endReason === "completed" && !hitMaxTurns && failedCount <= 0;
            clearSettledTodoListIfNeeded({ force: shouldForceClearTodo });

            // 兜底记忆提取（异步，不阻塞 UI）：
            // 从 memoryCursor 到对话末尾，提取本轮 run 中尚未被滚动提取覆盖的所有完整回合
            // - 若滚动提取已覆盖所有回合：completeTurns.length <= memoryCursor，跳过
            // - 若本轮从未触发滚动摘要（短对话）：memoryCursor=0，提取全部
            // - 若有尾部 1-2 轮未达滚动触发：summaryCursor < completeTurns.length，提取尾部
            try {
              const mode = (rt.getMode() ?? "chat") as "agent" | "chat";
              const memoryCursor = readMemoryExtractCursor(mode);

              const completeTurns = buildDialogueTurnsFromSteps(getProjectedRtSteps())
                .filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());

              if (completeTurns.length > memoryCursor) {
                const turnsToExtract = completeTurns.slice(memoryCursor);
                const dialogueText = formatDialogueTurnsForMemoryExtract(turnsToExtract);
                enqueueMemoryExtract(dialogueText, completeTurns.length);
              }
            } catch {
              // ignore memory fallback errors
            }

            finish();
          }

          // ---- policy.decision ----
          if (event === "policy.decision") {
            log("info", "policy.decision", data);
          }

          // ---- billing.charge ----
          if (event === "billing.charge") {
            const ok = data?.ok === undefined ? true : Boolean(data.ok);
            const nb = Number(data?.newBalance);
            if (ok && Number.isFinite(nb)) {
              const u = useAuthStore.getState().user;
              if (u) useAuthStore.setState({ user: { ...u, pointsBalance: Math.max(0, Math.floor(nb)) } });
            }
            log("info", "billing.charge", data);
          }

          // ---- run.notice ----
          if (event === "run.notice") {
            const kind0 = String(data?.kind ?? "info").trim().toLowerCase();
            const level = kind0 === "error" ? "error" : kind0 === "warn" ? "warn" : "info";
            log(level as any, "run.notice", data);
            const title = String(data?.title ?? "").trim();
            const detail = data?.detail ?? null;
            if (title === "ExecutionContract") {
              emitProgressCheckpoint("planning", "先把执行路径梳理一下。");
            }
            if (title === "CompositeTaskPlan") {
              emitProgressCheckpoint("planning", "先把执行路径梳理一下。");
            }
            if (title === "McpServerSelection") {
              emitProgressCheckpoint("planning", "先把执行路径梳理一下。");
            }
            if (title === "MaxTurnsExceeded") {
              sawMaxTurnsExceeded = true;
            }
            if (rt.getIsRunning() && title) {
              setActivity(`系统：${title}`, { resetTimer: true });
            }
          }

          // ---- run.execution.report ----
          if (event === "run.execution.report") {
            log("info", "run.execution.report", summarizeExecutionReportForLog(data));
            try {
              const skills = Array.isArray((data as any)?.workflowSkills) ? (data as any).workflowSkills : [];
              const map: Record<string, { status: string; missingSteps?: string[] }> = {};
              for (const s of skills) {
                if (!s || typeof s !== "object") continue;
                const id = String((s as any).id ?? "").trim();
                if (!id) continue;
                const key = id;
                const phase = String((s as any).currentPhase ?? "").trim();
                let status: string = "not_started";
                if (phase === "completed") status = "completed";
                else if (phase) status = "in_progress";
                const missing = Array.isArray((s as any).missingSteps)
                  ? (s as any).missingSteps.map((x: any) => String(x ?? "").trim()).filter(Boolean)
                  : [];
                map[key] = missing.length ? { status, missingSteps: missing } : { status };
              }
              if (Object.keys(map).length) {
                (useRunStore.getState() as any).setWorkflowSkills(map);
              }
            } catch {
              // ignore bad workflowSkills payload
            }
          }

          // ---- assistant.start ----
          if (event === "assistant.start") {
            const streamKey = getSubAgentStreamKey(data);
            log("info", "assistant.start", data);
            if (!streamKey && sawExternalToolPhase) {
              emitProgressCheckpoint("synthesis", "先把拿到的信息整理一下。");
              sawExternalToolPhase = false;
            }
            if (streamKey) {
              const prev = subAgentBubbles.get(streamKey);
              if (prev) {
                finishAssistantBubble(prev);
                subAgentBubbles.delete(streamKey);
              }
            } else {
              finishAssistantBubble(currentAssistantId);
            }
            if (rt.getIsRunning()) setActivity("正在生成…");
          }

          // ---- assistant.delta ----
          if (event === "assistant.delta") {
            const delta = data?.delta;
            const streamKey = getSubAgentStreamKey(data);
            const deltaAgentName = data?.agentName ? String(data.agentName) : null;
            if (typeof delta === "string" && delta.length) {
              if (!streamKey) {
                const narration = classifyNarrationDelta(delta);
                if (narration) {
                  if (narration.mode === "progress" && narration.text) {
                    emitProgressCheckpoint(String(narration.phase ?? "planning"), narration.text);
                  }
                  return;
                }
              }
              setActivity("正在生成…");
              if (streamKey) {
                appendAssistantDelta(ensureSubAgentBubble(streamKey, deltaAgentName ?? undefined), delta);
              } else {
                appendAssistantDelta(ensureAssistant(), delta);
              }
            }
          }

          // ---- assistant.done ----
          if (event === "assistant.done") {
            const streamKey = getSubAgentStreamKey(data);
            if (streamKey) {
              const bid = subAgentBubbles.get(streamKey);
              if (bid) {
                finishAssistantBubble(bid);
                subAgentBubbles.delete(streamKey);
              }
            } else {
              finishAssistantBubble(currentAssistantId);
            }
            if (rt.getIsRunning()) setActivity("正在汇总结果…");
          }

          // ---- tool.call ----
          if (event === "tool.call") {
            const toolCallId = String(data?.toolCallId ?? "");
            const name = String(data?.name ?? "");
            const rawArgs = (data?.args ?? {}) as Record<string, unknown>;
            const executedBy = String(data?.executedBy ?? "desktop");
            const parsedArgsPreview = parseSseToolArgs(rawArgs);
            const progressHint = progressTextForTool(name, parsedArgsPreview);
            if (progressHint) {
              emitProgressCheckpoint(progressHint.phase, progressHint.text);
              sawExternalToolPhase = true;
            }

            log("info", "tool.call", { toolCallId, name });

            // Sub-agent tool calls: execute + show ToolCallCard in UI for progress visibility
            const toolAgentId = data?.agentId ? String(data.agentId) : null;
            if (toolAgentId) {
              // 更新 activity 文本，让用户看到子 Agent 正在做什么
              setActivity(humanizeToolActivity(name, parsedArgsPreview), { resetTimer: true });

              if (executedBy === "gateway") {
                // Gateway already handled this tool — show completed card
                log("info", "tool.call.subagent.skip", { toolCallId, name, agentId: toolAgentId });
                addTool({
                  toolName: name, status: "success", input: parsedArgsPreview, output: null,
                  riskLevel: "low", applyPolicy: "auto_apply", undoable: false, kept: true, applied: true,
                  agentId: toolAgentId,
                });
                return;
              }
              // MCP 工具路由（子 Agent 也走 MCP 通道）
              if (name.startsWith("mcp.")) {
                const parts = name.split(".");
                const serverId = parts[1] ?? "";
                const mcpToolName = parts.slice(2).join(".");
                log("info", "tool.call.subagent.mcp", { toolCallId, serverId, mcpToolName, agentId: toolAgentId });
                const stepId = addTool({
                  toolName: name, toolCallId, status: "running", input: parsedArgsPreview, output: null,
                  riskLevel: "low", applyPolicy: "auto_apply", undoable: false, kept: true, applied: true,
                  agentId: toolAgentId,
                });
                try {
                  const mcpApi = (window as any).desktop?.mcp;
                  const callArgsToUse = isCrabImageTool(name)
                    ? buildCrabImageToolArgs({ toolName: name, rawArgs, rt })
                    : rawArgs;
                  const result = mcpApi
                    ? await mcpApi.callTool(serverId, mcpToolName, callArgsToUse)
                    : { ok: false, error: "MCP_API_NOT_AVAILABLE" };
                  const mcpDiag = {
                    retried: Boolean((result as any)?.retried),
                    retryCount: Number((result as any)?.retryCount ?? 0),
                    retrySignals: (result as any)?.retrySignals ?? null,
                    normalizedArgs: Array.isArray((result as any)?.normalizedArgs) ? (result as any).normalizedArgs : [],
                    diag: (result as any)?.diag ?? null,
                  };
                  if (mcpDiag.retryCount > 0 || mcpDiag.normalizedArgs.length > 0) {
                    log("info", "tool.result.subagent.mcp.diag", {
                      toolCallId, serverId, mcpToolName,
                      retryCount: mcpDiag.retryCount,
                      normalizedArgs: mcpDiag.normalizedArgs.slice(0, 8),
                    });
                  }
                  const failureOutput =
                    result?.output !== undefined
                      ? result.output
                      : { ok: false, error: result?.error ?? "MCP_TOOL_FAILED" };
                  const successOutput = result.ok ? result.output : failureOutput;
                  if (result.ok && isCrabImageTool(name)) {
                    applyCrabImageToolResultToThread({
                      toolName: name,
                      toolArgs: callArgsToUse,
                      output: successOutput,
                      rt,
                    });
                    const imageEntry = buildCrabImageTranscriptEntry({
                      toolCallId,
                      toolName: name,
                      output: successOutput,
                      agentId: toolAgentId,
                      agentName: data?.agentName ? String(data.agentName) : null,
                    });
                    if (imageEntry) {
                      rt.appendTranscriptEntry(imageEntry as any);
                    }
                  }
                  patchTool(stepId, {
                    status: result.ok ? "success" : "failed",
                    output: normalizeIncomingToolOutput(name, successOutput),
                  });
                  submitToolResult({
                    toolCallId, name,
                    ok: result.ok,
                    output: successOutput,
                    meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false, mcpDiag },
                  });
                } catch (e: any) {
                  patchTool(stepId, { status: "failed" });
                  submitToolResult({
                    toolCallId, name,
                    ok: false,
                    output: { ok: false, error: String(e?.message ?? e) },
                    meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                  });
                }
                return;
              }
              // Desktop-executed tool for sub-agent
              log("info", "tool.call.subagent.exec", { toolCallId, name, agentId: toolAgentId });
              const stepId = addTool({
                toolName: name, toolCallId, status: "running", input: parsedArgsPreview, output: null,
                riskLevel: "low", applyPolicy: "auto_apply", undoable: false, kept: true, applied: true,
                agentId: toolAgentId,
              });
              const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
              const failedOutput =
                !exec.result.ok && exec.result.output !== undefined
                  ? exec.result.output
                  : { ok: false, error: (exec.result as any).error };
              patchTool(stepId, {
                status: exec.result.ok ? "success" : "failed",
                toolCallId,
                output: normalizeIncomingToolOutput(name, exec.result.ok ? exec.result.output : failedOutput),
              });
              submitToolResult({
                toolCallId, name,
                ok: exec.result.ok,
                output: exec.result.ok ? exec.result.output : failedOutput,
                meta: {
                  applyPolicy: exec.result.ok ? exec.result.applyPolicy ?? exec.def?.applyPolicy ?? "proposal" : exec.def?.applyPolicy ?? "proposal",
                  riskLevel: exec.result.ok ? exec.result.riskLevel ?? exec.def?.riskLevel ?? "high" : exec.def?.riskLevel ?? "high",
                  hasApply: exec.result.ok ? typeof exec.result.apply === "function" : false,
                },
              });
              return;
            }

            setActivity(humanizeToolActivity(name, parsedArgsPreview), { resetTimer: true });
            finishAssistantBubble(currentAssistantId);

            // -- MCP 工具路由：name 格式 "mcp.<serverId>.<toolName>" --
            if (name.startsWith("mcp.")) {
              const parts = name.split(".");
              const serverId = parts[1] ?? "";
              const mcpToolName = parts.slice(2).join(".");
              log("info", "tool.call.mcp", { toolCallId, serverId, mcpToolName });
              const stepId = addTool({
                toolName: name,
                toolCallId,
                status: "running",
                input: parsedArgsPreview,
                output: null,
                riskLevel: "low",
                applyPolicy: "auto_apply",
                undoable: false,
                kept: true,
                applied: true,
              });
              try {
                const mcpApi = (window as any).desktop?.mcp;
                const callArgsToUse = isCrabImageTool(name)
                  ? buildCrabImageToolArgs({ toolName: name, rawArgs, rt })
                  : rawArgs;
                const result = mcpApi
                  ? await mcpApi.callTool(serverId, mcpToolName, callArgsToUse)
                  : { ok: false, error: "MCP_API_NOT_AVAILABLE" };
                const mcpDiag = {
                  retried: Boolean((result as any)?.retried),
                  retryCount: Number((result as any)?.retryCount ?? 0),
                  retrySignals: (result as any)?.retrySignals ?? null,
                  normalizedArgs: Array.isArray((result as any)?.normalizedArgs) ? (result as any).normalizedArgs : [],
                  diag: (result as any)?.diag ?? null,
                };
                if (mcpDiag.retryCount > 0 || mcpDiag.normalizedArgs.length > 0 || (mcpDiag.diag && ((mcpDiag.diag as any).recoveryAttempted || (mcpDiag.diag as any).recoverySucceeded))) {
                  log("info", "tool.result.mcp.diag", {
                    toolCallId, serverId, mcpToolName,
                    retryCount: mcpDiag.retryCount,
                    normalizedArgs: mcpDiag.normalizedArgs.slice(0, 8),
                    recoveryAttempted: Boolean((mcpDiag.diag as any)?.recoveryAttempted),
                    recoverySucceeded: Boolean((mcpDiag.diag as any)?.recoverySucceeded),
                    recoveryStrategy: String((mcpDiag.diag as any)?.recoveryStrategy ?? ""),
                    recoveryDurationMs: Number((mcpDiag.diag as any)?.recoveryDurationMs ?? 0),
                  });
                }
                const failureOutput =
                  result?.output !== undefined
                    ? result.output
                    : { ok: false, error: result?.error ?? "MCP_TOOL_FAILED" };
                const successOutput = result.ok ? result.output : failureOutput;
                if (result.ok && isCrabImageTool(name)) {
                  applyCrabImageToolResultToThread({
                    toolName: name,
                    toolArgs: callArgsToUse,
                    output: successOutput,
                    rt,
                  });
                  const imageEntry = buildCrabImageTranscriptEntry({
                    toolCallId,
                    toolName: name,
                    output: successOutput,
                  });
                  if (imageEntry) {
                    rt.appendTranscriptEntry(imageEntry as any);
                  }
                }
                patchTool(stepId, {
                  status: result.ok ? "success" : "failed",
                  toolCallId,
                  output: normalizeIncomingToolOutput(name, successOutput),
                });
                submitToolResult({
                  toolCallId, name,
                  ok: result.ok,
                  output: successOutput,
                  meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false, mcpDiag },
                });
              } catch (e: any) {
                const failureOutput = { ok: false, error: String(e?.message ?? e) };
                patchTool(stepId, {
                  status: "failed",
                  toolCallId,
                  output: normalizeIncomingToolOutput(name, failureOutput),
                });
                submitToolResult({
                  toolCallId, name,
                  ok: false,
                  output: failureOutput,
                  meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                });
              }
              return;
            }

            // -- Gateway-executed tools --
            if (executedBy === "gateway") {
              if (name.startsWith("run.") && name !== "run.done") {
                // 合并工具 run.todo：展开为原始工具名以匹配 Desktop 工具注册
                let localToolName = name;
                if (name === "run.todo") {
                  const action = String(parsedArgsPreview?.action ?? "").trim().toLowerCase();
                  if (action === "upsert") localToolName = "run.todo.upsertMany";
                  else if (action === "replace") localToolName = "run.setTodoList";
                  else if (action === "update") localToolName = "run.todo.update";
                  else if (action === "remove") localToolName = "run.todo.remove";
                  else if (action === "clear") localToolName = "run.todo.clear";
                }
                const def = getTool(localToolName);
                let localResult: any = null;
                try { if (def) localResult = await def.run(parsedArgsPreview, { mode: args.mode }); } catch {}
                const stepId = addTool({
                  toolName: name,
                  toolCallId,
                  status: localResult?.ok ? "success" : "running",
                  input: parsedArgsPreview,
                  output: localResult?.ok ? normalizeIncomingToolOutput(name, localResult.output) : null,
                  riskLevel: def?.riskLevel ?? "low",
                  applyPolicy: def?.applyPolicy ?? "auto_apply",
                  undoable: localResult?.ok ? localResult.undoable ?? false : false,
                  kept: def?.applyPolicy === "auto_apply",
                  applied: false,
                });
                if (toolCallId) {
                  const q = gatewayToolStepIdsByCallId.get(toolCallId) ?? [];
                  q.push(stepId);
                  gatewayToolStepIdsByCallId.set(toolCallId, q);
                }
                return;
              }
              // Other gateway-executed: placeholder
              const def = getTool(name);
              const stepId = addTool({
                toolName: name, toolCallId, status: "running", input: parsedArgsPreview, output: null,
                riskLevel: def?.riskLevel ?? "high",
                applyPolicy: def?.applyPolicy ?? "proposal",
                undoable: false, kept: false, applied: false,
              });
              if (toolCallId) {
                const q = gatewayToolStepIdsByCallId.get(toolCallId) ?? [];
                q.push(stepId);
                gatewayToolStepIdsByCallId.set(toolCallId, q);
              }
              return;
            }

            // -- Desktop-executed tools --
            // 先在对话区插入“运行中”工具卡（便于观测），再在执行完成后补充结果。
            const def0 = getTool(name);
            const stepId = addTool({
              toolName: name,
              toolCallId,
              status: "running",
              input: parsedArgsPreview,
              output: null,
              riskLevel: def0?.riskLevel ?? "high",
              applyPolicy: def0?.applyPolicy ?? "proposal",
              undoable: false,
              kept: def0?.applyPolicy === "auto_apply",
              applied: def0?.applyPolicy === "auto_apply",
            });

            const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
            const def = exec.def ?? def0;
            const stepApplyPolicy = exec.result.ok
              ? exec.result.applyPolicy ?? def?.applyPolicy ?? "proposal"
              : def?.applyPolicy ?? "proposal";
            const stepRiskLevel = exec.result.ok
              ? exec.result.riskLevel ?? def?.riskLevel ?? "high"
              : def?.riskLevel ?? "high";
            const initialKept = stepApplyPolicy === "auto_apply";
            const failedOutput =
              !exec.result.ok && exec.result.output !== undefined
                ? exec.result.output
                : { ok: false, error: "error" in exec.result ? exec.result.error : "TOOL_EXEC_FAILED" };

            patchTool(stepId, {
              status: exec.result.ok ? "success" : "failed",
              toolCallId,
              input: exec.parsedArgs,
              output: normalizeIncomingToolOutput(name, exec.result.ok ? exec.result.output : failedOutput),
              riskLevel: stepRiskLevel,
              applyPolicy: stepApplyPolicy,
              undoable: exec.result.ok ? exec.result.undoable : false,
              undo: exec.result.ok ? exec.result.undo : undefined,
              apply: exec.result.ok ? exec.result.apply : undefined,
              kept: initialKept,
              applied: stepApplyPolicy === "auto_apply",
            });

            submitToolResult({
              toolCallId,
              name,
              ok: exec.result.ok,
              output: exec.result.ok ? exec.result.output : failedOutput,
              meta: {
                applyPolicy: stepApplyPolicy,
                riskLevel: stepRiskLevel,
                hasApply: exec.result.ok ? typeof exec.result.apply === "function" : false,
              },
            });
            if (rt.getIsRunning()) setActivity("正在等待模型继续…", { resetTimer: true });
          }

          // ---- tool.result (server-side tools backfill) ----
          if (event === "tool.result") {
            // Sub-agent tool results: skip
            if (data?.agentId) {
              log("info", "tool.result.subagent.skip", { toolCallId: data?.toolCallId, agentId: data.agentId });
              return;
            }
            const toolCallId = String(data?.toolCallId ?? "");
            const ok0 = Boolean(data?.ok);
            const out = data?.output;
            const meta = data?.meta ?? null;
            if (toolCallId) {
              const q = gatewayToolStepIdsByCallId.get(toolCallId) ?? [];
              const stepId = q.length ? q[0] : "";
              const st = stepId ? (rt.getSteps() ?? []).find((s: any) => s && s.type === "tool" && s.id === stepId) : null;

              if (st && st.type === "tool" && st.status === "running") {
                patchTool(stepId, {
                  status: ok0 ? "success" : "failed",
                  toolCallId,
                  output: normalizeIncomingToolOutput(st.toolName, out),
                  ...(meta && typeof meta === "object"
                    ? { applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy, riskLevel: (meta as any).riskLevel ?? st.riskLevel }
                    : {}),
                });
                if (ok0 && st.toolName === "run.done" && out && typeof out === "object") {
                  const note = String((out as any).note ?? "").trim();
                  if (note) runDoneNote = note.slice(0, 200);
                }

                // lint.style patch 增强
                try {
                  if (ok0 && st.toolName === "lint.style" && out && typeof out === "object") {
                    const edits0 = Array.isArray((out as any).edits) ? ((out as any).edits as any[]) : [];
                    const normEdits = edits0
                      .map((e: any) => ({
                        startLineNumber: Math.max(1, Math.floor(Number(e?.startLineNumber ?? NaN))),
                        startColumn: Math.max(1, Math.floor(Number(e?.startColumn ?? 1))),
                        endLineNumber: Math.max(1, Math.floor(Number(e?.endLineNumber ?? NaN))),
                        endColumn: Math.max(1, Math.floor(Number(e?.endColumn ?? 9999))),
                        text: String(e?.text ?? ""),
                      }))
                      .filter((e: any) => [e.startLineNumber, e.startColumn, e.endLineNumber, e.endColumn].every((n: any) => Number.isFinite(n) && n > 0))
                      .slice(0, 24);

                    const stepNow = (rt.getSteps() ?? []).find((x: any) => x && x.type === "tool" && x.id === stepId) as any;
                    const inPathRaw = stepNow?.input && typeof stepNow.input === "object" ? String((stepNow.input as any)?.path ?? "").trim() : "";
                    const inputText = stepNow?.input && typeof stepNow.input === "object" ? String((stepNow.input as any)?.text ?? "").trim() : "";
                    const targetPath = (inPathRaw || useProjectStore.getState().activePath || "").replaceAll("\\", "/");
                    const p2 = useProjectStore.getState();
                    const file = targetPath ? p2.getFileByPath(targetPath) : null;

                    if (file && normEdits.length) {
                      const before = await p2.ensureLoaded(file.path).catch(() => file.content ?? "");
                      const after = applyTextEdits({ before, edits: normEdits }).after;
                      const d = unifiedDiff({ path: targetPath, before, after });
                      const preview = {
                        diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null, path: targetPath,
                        note: "lint.style（patch）已生成局部修改提案：点击“应用更改”执行 edits；之后可“回滚更改”。",
                      };
                      const apply = () => {
                        const snap = useProjectStore.getState().snapshot();
                        const st2 = useProjectStore.getState();
                        if (!st2.getFileByPath(targetPath)) return { undo: () => useProjectStore.getState().restore(snap) };
                        if (st2.activePath === targetPath && st2.editorRef?.getModel()) {
                          const model = st2.editorRef.getModel()!;
                          const full = model.getFullModelRange();
                          st2.editorRef.executeEdits("agent", [{ range: full, text: after, forceMoveMarkers: true }]);
                          st2.updateFile(targetPath, st2.editorRef.getModel()?.getValue() ?? after);
                        } else {
                          st2.updateFile(targetPath, after);
                        }
                        return { undo: () => useProjectStore.getState().restore(snap) };
                      };
                      patchTool(stepId, { output: { ...(out as any), preview }, applyPolicy: "proposal", riskLevel: "low", apply, undoable: false } as any);
                    } else if (inputText && normEdits.length) {
                      const before = inputText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                      const after = applyTextEdits({ before, edits: normEdits }).after;
                      const pseudoPath = "__draft__/lint.style";
                      const d = unifiedDiff({ path: pseudoPath, before, after });
                      const outPath = `drafts/lint-style-${Date.now()}.md`;
                      const preview = {
                        diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null, path: pseudoPath,
                        note: `lint.style（patch）已生成"纯文本草稿"的局部修改提案：点击“应用更改”会写入新文件 ${outPath}；之后可“回滚更改”。`,
                      };
                      const apply = () => {
                        const snap = useProjectStore.getState().snapshot();
                        const st2 = useProjectStore.getState();
                        const exists = !!st2.getFileByPath(outPath);
                        const finalPath = exists ? `drafts/lint-style-${Date.now()}-2.md` : outPath;
                        st2.createFile(finalPath, after);
                        return { undo: () => useProjectStore.getState().restore(snap) };
                      };
                      patchTool(stepId, { output: { ...(out as any), preview, patchTarget: { kind: "new_file", path: outPath } }, applyPolicy: "proposal", riskLevel: "low", apply, undoable: false } as any);
                    }
                  }
                } catch {}

                if (q.length) q.shift();
                if (q.length) gatewayToolStepIdsByCallId.set(toolCallId, q);
                else gatewayToolStepIdsByCallId.delete(toolCallId);
                if (rt.getIsRunning()) setActivity("正在等待模型继续…", { resetTimer: true });
              }
            }
            log("info", "tool.result", data);
          }

          // ---- error (inside event envelope) ----
          if (event === "error") {
            const errMsg = data?.error ? String(data.error) : "unknown";
            if (sawMaxTurnsExceeded && /\baborted\b/i.test(errMsg)) {
              log("info", "ws.run.max_turns.error_suppressed", { error: errMsg });
              if (rt.getIsRunning()) setActivity("达到回合上限，等待你的下一步…", { resetTimer: true });
              return;
            }
            const id = ensureAssistant();
            patchAssistant(id, { hidden: false });
            appendAssistantDelta(id, `\n\n[模型错误] ${errMsg}`);
            finishAssistant(id);
            setRunning(false); setActivity(null);
            finish();
          }
        }
      });

      // If we get here without run.end having set running=false, clean up
      finishOpenAssistantBubbles();
      if (rt.getIsRunning()) {
        setRunning(false);
        setActivity(null);
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      const aborted =
        abort.signal.aborted ||
        String(e?.name ?? "") === "AbortError" ||
        /\baborted\b/i.test(msg);

      if (aborted) {
        log("info", "ws.run.aborted", { message: msg, cancelReason, sawMaxTurnsExceeded });
        if (cancelReason === "stalled_timeout") {
          const a = currentAssistantId ?? addAssistant("", false, false);
          patchAssistant(a, { hidden: false });
          appendAssistantDelta(a, `\n\n[连接中断] 长时间未收到新事件，本轮已停止。请重试一次；若仍复现，再看工具调用审计。\n`);
          finishAssistant(a);
        }
        cancelInlineFileOpConfirm();
        setRunning(false); setActivity(null);
        finishOpenAssistantBubbles();
        return;
      }

      log("error", "ws.network_error", { message: msg });
      if (String((import.meta as any).env?.MODE ?? "") !== "production") {
        console.error("[ws-run] catch:", msg);
      }
      const a = currentAssistantId ?? addAssistant("", false, false);
      patchAssistant(a, { hidden: false });
      appendAssistantDelta(a, `\n\n[网络错误] ${msg}`);
      finishAssistant(a);
      currentAssistantId = null;
      finishOpenAssistantBubbles();
      setRunning(false); setActivity(null);
    } finally {
      ended = true;
      clearWatchdog();
      // 仅当 cancel 未被外部提前调用时才清除句柄
      // （防止新 run 注册句柄后被旧 run 的 finally 误清）
      if (args.convId && !cancelledExternally) setConvRunCancel(args.convId, null);
      if (socketRef) { try { socketRef.close(); } catch {} socketRef = null; }
      resolveDoneOnce();
    }
  })();

  const controller: GatewayRunController = {
    done,
    cancel: (reason?: string) => {
      if (ended) return;
      cancelledExternally = true;
      const r = String(reason ?? "unknown").trim() || "unknown";
      cancelReason = r;
      if (args.convId) setConvRunCancel(args.convId, null);
      log("warn", "ws.run.cancel", { reason: r });
      cancelInlineFileOpConfirm();
      try { (abort as any).abort(r); } catch { abort.abort(); }
      setRunning(false); setActivity(null);
      finishOpenAssistantBubbles();
    },
  };
  // 注册到每对话取消注册表（用于同一对话发新消息时取消旧 run）
  if (args.convId) setConvRunCancel(args.convId, controller.cancel);
  return controller;
}
