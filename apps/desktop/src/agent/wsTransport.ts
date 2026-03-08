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
import { mergeWorkflowStickyFromMcpSuccess } from "./mcpWorkflowSticky";
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
  const runStartStepCount = (rt.getSteps() ?? []).length;
  let runDoneNote = "";
  let sawMaxTurnsExceeded = false;
  const updateWorkflowSticky = (patch: Record<string, unknown>) => {
    try {
      const main = (rt.getMainDoc() ?? {}) as any;
      const prev = main?.workflowV1 && typeof main.workflowV1 === "object" && !Array.isArray(main.workflowV1)
        ? (main.workflowV1 as any)
        : {};
      const nextSelectedServerIds = Array.isArray((patch as any)?.selectedServerIds)
        ? Array.from(new Set(((patch as any).selectedServerIds as any[]).map((id) => String(id ?? "").trim()).filter(Boolean))).slice(0, 8)
        : Array.isArray(prev?.selectedServerIds)
          ? (prev.selectedServerIds as any[]).map((id) => String(id ?? "").trim()).filter(Boolean).slice(0, 8)
          : [];
      const nextPreferredToolNames = Array.isArray((patch as any)?.preferredToolNames)
        ? Array.from(new Set(((patch as any).preferredToolNames as any[]).map((name) => String(name ?? "").trim()).filter(Boolean))).slice(0, 16)
        : Array.isArray(prev?.preferredToolNames)
          ? (prev.preferredToolNames as any[]).map((name) => String(name ?? "").trim()).filter(Boolean).slice(0, 16)
          : [];
      updateMainDoc({
        workflowV1: {
          ...prev,
          ...patch,
          v: 1,
          selectedServerIds: nextSelectedServerIds,
          preferredToolNames: nextPreferredToolNames,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // noop
    }
  };
  const updateCompositeTask = (patch: Record<string, unknown>) => {
    try {
      const main = (rt.getMainDoc() ?? {}) as any;
      const prev = main?.compositeTaskV1 && typeof main.compositeTaskV1 === "object" && !Array.isArray(main.compositeTaskV1)
        ? (main.compositeTaskV1 as any)
        : {};
      updateMainDoc({
        compositeTaskV1: {
          ...prev,
          ...patch,
          v: 1,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // noop
    }
  };
  const markCompositeTaskWaitingOnMaxTurns = () => {
    try {
      const main = (rt.getMainDoc() ?? {}) as any;
      const plan = main?.compositeTaskV1 && typeof main.compositeTaskV1 === "object" && !Array.isArray(main.compositeTaskV1)
        ? (main.compositeTaskV1 as any)
        : null;
      if (!plan) return;
      const phases = Array.isArray(plan?.phases) ? (plan.phases as any[]) : [];
      const currentPhase = phases.find((phase: any) => String(phase?.id ?? "") === String(plan?.currentPhaseId ?? "")) ?? phases[0] ?? null;
      const phaseId = String(currentPhase?.id ?? plan?.currentPhaseId ?? "phase_current").trim() || "phase_current";
      const phaseTitle = String(currentPhase?.title ?? "当前阶段").trim() || "当前阶段";
      updateCompositeTask({
        status: "waiting_user",
        pendingInput: {
          id: `pending_${Date.now()}`,
          phaseId,
          kind: "resume_or_narrow",
          question: `已达到${phaseTitle}的回合上限。请继续、缩小范围，或切换到交付阶段。`,
          replyHint: "continue_or_narrow",
        },
      });
    } catch {
      // noop
    }
  };
  const deriveWaitingWorkflowPatchFromAssistant = () => {
    try {
      const steps = (rt.getSteps() ?? []).slice(runStartStepCount) as any[];
      const lastAssistant = [...steps].reverse().find((step) => step && step.type === "assistant" && String(step.text ?? "").trim());
      const lastText = String(lastAssistant?.text ?? "").trim();
      if (!lastText) return null;
      const main = (rt.getMainDoc() ?? {}) as any;
      const workflow = main?.workflowV1 && typeof main.workflowV1 === "object" ? main.workflowV1 : {};
      const workflowKind = String(workflow?.kind ?? "").trim().toLowerCase();
      const workflowRouteId = String(workflow?.routeId ?? "").trim().toLowerCase();
      const browserLike = workflowRouteId === "web_radar" || workflowKind === "browser_session" || Array.isArray(workflow?.selectedServerIds) && workflow.selectedServerIds.some((id: any) => /playwright|browser/i.test(String(id ?? "")));
      const asksForReply = /(请直接回复|回复我|回复[A-Da-d]|A：|B：|你回复|完成后告诉我|登录完成后告诉我|告诉我你下一步|选一个|请回我)/.test(lastText);
      const asksForLoginFollowUp = /(你先登录|完成登录|登录成功后|已登录|创作中心后台|左侧菜单|数据看板)/.test(lastText);
      if (!browserLike && !asksForReply && !asksForLoginFollowUp) return null;
      if (!asksForReply && !asksForLoginFollowUp) return null;
      return {
        status: "waiting_user",
        waiting: {
          question: lastText.length > 500 ? `${lastText.slice(0, 500).trimEnd()}…` : lastText,
          replyHint: asksForLoginFollowUp ? "login_or_choice" : "choice",
        },
      };
    } catch {
      return null;
    }
  };

  const noteSuccessfulMcpExecution = (serverId: string, toolName: string) => {
    try {
      const main = (rt.getMainDoc() ?? {}) as any;
      const prevWorkflow = main?.workflowV1;
      const nextWorkflow = mergeWorkflowStickyFromMcpSuccess(prevWorkflow, { serverId, toolName });
      updateMainDoc({ workflowV1: nextWorkflow });
      log("info", "workflow.sticky.mcp_success", {
        serverId,
        toolName,
        prev: {
          routeId: String(prevWorkflow?.routeId ?? ""),
          kind: String(prevWorkflow?.kind ?? ""),
          status: String(prevWorkflow?.status ?? ""),
          selectedServerIds: Array.isArray(prevWorkflow?.selectedServerIds) ? prevWorkflow.selectedServerIds : [],
          preferredToolNames: Array.isArray(prevWorkflow?.preferredToolNames) ? prevWorkflow.preferredToolNames : [],
        },
        next: {
          routeId: String(nextWorkflow?.routeId ?? ""),
          kind: String(nextWorkflow?.kind ?? ""),
          status: String(nextWorkflow?.status ?? ""),
          selectedServerIds: Array.isArray(nextWorkflow?.selectedServerIds) ? nextWorkflow.selectedServerIds : [],
          preferredToolNames: Array.isArray(nextWorkflow?.preferredToolNames) ? nextWorkflow.preferredToolNames : [],
        },
      });
    } catch {
      // noop
    }
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
        if (ms < 120_000 || stalledLogged) return;
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
        const att = rt.getKbAttachedLibraryIds() ?? [];
        const sidecarLibraryIds = mentionLibIds.length ? mentionLibIds : att;
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
      try {
        const r = await rollDialogueSummaryIfNeeded({ gatewayUrl: args.gatewayUrl, mode: args.mode, abort, log });
        if (r?.rolled) {
          setActivity("正在构建上下文…", { resetTimer: false });
          // 摘要成功后：用 delta 原文（非压缩后的摘要）触发记忆提取，避免二次有损压缩
          const rolledResult = r as { rolled: true; delta: Array<{ user: string; assistant: string }>; newCursor: number };
          const dialogueText = formatDialogueTurnsForMemoryExtract(rolledResult.delta ?? []);
          enqueueMemoryExtract(dialogueText, rolledResult.newCursor ?? 0);
        }
      } catch (e: any) {
        log("warn", "context.summary.exception", { error: e?.message ? String(e.message) : String(e) });
      }

      // -- context pack ---
      const contextPack =
        args.mode === "chat"
          ? buildChatContextPack({ referencesText, userPrompt: promptForGateway })
          : await buildContextPack({ referencesText, userPrompt: promptForGateway, kbMentionIds: args.kbMentionIds });

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

      const targetAgentIds = args.targetAgentIds?.length
        ? args.targetAgentIds
        : args.targetAgentId ? [args.targetAgentId] : undefined;

      // 外部扩展包 skill manifests（发给 Gateway，使其也能参与激活计算）
      const externalSkills = (await import("../state/skillStore")).useSkillStore.getState().externalSkills;
      const userSkillManifests = externalSkills?.length ? externalSkills : undefined;

      socket.send(JSON.stringify({
        type: "run.request",
        payload: {
          model: args.model,
          mode: args.mode,
          prompt: promptForGateway,
          contextPack,
          toolSidecar,
          ...(args.images?.length ? { images: args.images } : {}),
          ...(targetAgentIds ? { targetAgentIds } : {}),
          ...(args.activeSkillIds?.length ? { activeSkillIds: args.activeSkillIds } : {}),
          ...(userSkillManifests ? { userSkillManifests } : {}),
        },
      }));

      bumpProgress();

      // ====================================================================
      // 4. Event handling
      // ====================================================================

      let runId: string | null = null;
      let assistantId: string | null = null;
      const gatewayToolStepIdsByCallId = new Map<string, string[]>();

      const ensureAssistant = () => {
        if (assistantId) return assistantId;
        assistantId = addAssistant("", true, false);
        currentAssistantId = assistantId;
        return assistantId;
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
        const output = step?.output && typeof step.output === "object" ? (step.output as any) : null;
        const errorCode = String(output?.error ?? "").trim() || "UNKNOWN_ERROR";
        const message = String(output?.message ?? output?.detail ?? "").trim();
        const path = String(output?.path ?? input?.path ?? input?.fromPath ?? "").trim();
        const nextAction = Array.isArray(output?.next_actions)
          ? String(output.next_actions[0] ?? "").trim()
          : "";
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
          (s: any) => s && s.type === "assistant" && !s.hidden && String(s.text ?? "").trim().length > 0,
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
                const base = `${name}: ${error}${path ? ` [path=${path}]` : ""}`;
                return action ? `${base}；建议：${action}` : base;
              })
              .filter(Boolean)
          : [];

        const failures = stepFailures.length ? stepFailures : digestFailures;
        const failedCount = stepFailures.length || Number(runEndData?.failureDigest?.failedCount ?? 0) || 0;
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

        socket.onmessage = (e) => {
          queue.push(e);
          if (!busy) void drainQueue();
        };
        socket.onclose = () => finish();
        socket.onerror = () => finish();

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
        }

        async function handleMessage(e: MessageEvent) {
          if (abort.signal.aborted || ended) return;
          bumpProgress();
          let msg: any;
          try { msg = JSON.parse(String(e.data)); } catch { return; }

          if (msg.type === "error") {
            const errMsg = String(msg.payload?.message ?? msg.payload?.error ?? "unknown");
            log("error", "ws.server_error", msg.payload);
            const id = ensureAssistant();
            patchAssistant(id, { hidden: false });
            appendAssistantDelta(id, `\n\n[服务端错误] ${errMsg}`);
            finishAssistant(id);
            setRunning(false); setActivity(null);
            finish();
            return;
          }

          if (msg.type !== "event" || !msg.payload) return;

          const event: string = msg.payload.event;
          const data: any = msg.payload.data ?? {};

          // ---- run.start ----
          if (event === "run.start") {
            runId = data?.runId ? String(data.runId) : runId;
            log("info", "agent.run.start", data);
          }

          // ---- subagent.start ----
          if (event === "subagent.start") {
            const agName = String(data?.agentName ?? data?.agentId ?? "");
            log("info", "subagent.start", data);
            if (rt.getIsRunning()) {
              setActivity(agName ? `${agName} 正在执行任务…` : "子 Agent 正在执行任务…", { resetTimer: true });
            }
          }

          // ---- subagent.done ----
          if (event === "subagent.done") {
            const doneAgId = data?.agentId ? String(data.agentId) : null;
            if (doneAgId) {
              const bid = subAgentBubbles.get(doneAgId);
              if (bid) { finishAssistant(bid); subAgentBubbles.delete(doneAgId); }
            }
            log("info", "subagent.done", data);
            if (rt.getIsRunning()) setActivity("正在汇总结果…");
          }

          // ---- run.end ----
          if (event === "run.end") {
            log("info", "agent.run.end", data);
            setRunning(false); setActivity(null);
            maybeAppendRunEndFeedback(data);
            const endReason = String(data?.reason ?? "").trim().toLowerCase();
            const endReasonCodes = Array.isArray(data?.reasonCodes)
              ? (data.reasonCodes as any[]).map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
              : [];
            const hitMaxTurns = sawMaxTurnsExceeded || endReason === "max_turns" || endReasonCodes.includes("max_turns");
            syncTodoFailureStateFromRunEnd(data);
            if (hitMaxTurns) {
              updateWorkflowSticky({ status: "waiting_user", lastEndReason: "max_turns" });
              markCompositeTaskWaitingOnMaxTurns();
            } else if (endReason === "clarify_waiting" || endReason === "proposal_waiting") {
              updateWorkflowSticky({ status: "waiting_user", lastEndReason: endReason });
            } else if (endReason) {
              const derivedWaitingPatch = endReason === "completed" ? deriveWaitingWorkflowPatchFromAssistant() : null;
              if (derivedWaitingPatch) {
                updateWorkflowSticky({ ...derivedWaitingPatch, lastEndReason: endReason });
                log("info", "workflow.waiting.derived", derivedWaitingPatch);
              } else {
                updateWorkflowSticky({ lastEndReason: endReason });
              }
            }

            // 兜底记忆提取（异步，不阻塞 UI）：
            // 从 memoryCursor 到对话末尾，提取本轮 run 中尚未被滚动提取覆盖的所有完整回合
            // - 若滚动提取已覆盖所有回合：completeTurns.length <= memoryCursor，跳过
            // - 若本轮从未触发滚动摘要（短对话）：memoryCursor=0，提取全部
            // - 若有尾部 1-2 轮未达滚动触发：summaryCursor < completeTurns.length，提取尾部
            try {
              const mode = (rt.getMode() ?? "chat") as "agent" | "chat";
              const memoryCursor = readMemoryExtractCursor(mode);

              const completeTurns = buildDialogueTurnsFromSteps(rt.getSteps() ?? [])
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
              const routeId = String((detail as any)?.routeDecision?.routeId ?? "").trim().toLowerCase();
              const required = Boolean((detail as any)?.required);
              if (routeId && required) {
                const runIntent = String((rt.getMainDoc() as any)?.runIntent ?? "").trim().toLowerCase();
                updateWorkflowSticky({
                  status: "running",
                  routeId,
                  kind: routeId === "web_radar" ? "browser_session" : "task_workflow",
                  intentHint: ["writing", "rewrite", "polish", "analysis", "ops"].includes(runIntent) ? runIntent : "ops",
                  preferredToolNames: Array.isArray((detail as any)?.preferredToolNames) ? (detail as any).preferredToolNames : [],
                });
              }
            }
            if (title === "McpServerSelection") {
              const selectedServerIds = Array.isArray((detail as any)?.selectedServerIds)
                ? ((detail as any).selectedServerIds as any[]).map((id) => String(id ?? "").trim()).filter(Boolean)
                : [];
              if (selectedServerIds.length > 0) {
                updateWorkflowSticky({ status: "running", selectedServerIds });
              }
            }
            if (title === "CompositeTaskPlan") {
              const plan = detail && typeof detail === "object" ? (detail as any).plan : null;
              if (plan && typeof plan === "object" && !Array.isArray(plan)) {
                updateMainDoc({ compositeTaskV1: plan });
              }
            }
            if (title === "MaxTurnsExceeded") {
              sawMaxTurnsExceeded = true;
              updateWorkflowSticky({ status: "waiting_user", lastEndReason: "max_turns" });
              markCompositeTaskWaitingOnMaxTurns();
            }
            if (rt.getIsRunning() && title) {
              setActivity(`系统：${title}`, { resetTimer: true });
            }
          }

          // ---- run.execution.report ----
          if (event === "run.execution.report") {
            log("info", "run.execution.report", data);
          }

          // ---- assistant.start ----
          if (event === "assistant.start") {
            const evtAgentId = data?.agentId ? String(data.agentId) : null;
            log("info", "assistant.start", data);
            if (evtAgentId) {
              const prev = subAgentBubbles.get(evtAgentId);
              if (prev) { finishAssistant(prev); subAgentBubbles.delete(evtAgentId); }
            } else {
              if (assistantId) finishAssistant(assistantId);
              assistantId = null;
            }
            if (rt.getIsRunning()) setActivity("正在生成…");
          }

          // ---- assistant.delta ----
          if (event === "assistant.delta") {
            const delta = data?.delta;
            const deltaAgentId = data?.agentId ? String(data.agentId) : null;
            const deltaAgentName = data?.agentName ? String(data.agentName) : null;
            if (typeof delta === "string" && delta.length) {
              setActivity("正在生成…");
              if (deltaAgentId) {
                appendAssistantDelta(ensureSubAgentBubble(deltaAgentId, deltaAgentName ?? undefined), delta);
              } else {
                appendAssistantDelta(ensureAssistant(), delta);
              }
            }
          }

          // ---- assistant.done ----
          if (event === "assistant.done") {
            const doneAgentId = data?.agentId ? String(data.agentId) : null;
            if (doneAgentId) {
              const bid = subAgentBubbles.get(doneAgentId);
              if (bid) { finishAssistant(bid); subAgentBubbles.delete(doneAgentId); }
            } else {
              if (assistantId) finishAssistant(assistantId);
              assistantId = null;
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
                  toolName: name, status: "running", input: parsedArgsPreview, output: null,
                  riskLevel: "low", applyPolicy: "auto_apply", undoable: false, kept: true, applied: true,
                  agentId: toolAgentId,
                });
                try {
                  const mcpApi = (window as any).desktop?.mcp;
                  const result = mcpApi
                    ? await mcpApi.callTool(serverId, mcpToolName, rawArgs)
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
                  patchTool(stepId, { status: result.ok ? "success" : "failed", output: result.ok ? result.output : failureOutput });
                  if (result.ok) noteSuccessfulMcpExecution(serverId, name);
                  submitToolResult({
                    toolCallId, name,
                    ok: result.ok,
                    output: result.ok ? result.output : failureOutput,
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
                toolName: name, status: "running", input: parsedArgsPreview, output: null,
                riskLevel: "low", applyPolicy: "auto_apply", undoable: false, kept: true, applied: true,
                agentId: toolAgentId,
              });
              const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
              patchTool(stepId, { status: exec.result.ok ? "success" : "failed", output: exec.result.ok ? exec.result.output : null });
              const failedOutput =
                !exec.result.ok && exec.result.output !== undefined
                  ? exec.result.output
                  : { ok: false, error: (exec.result as any).error };
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
            if (assistantId) { finishAssistant(assistantId); assistantId = null; }

            // -- MCP 工具路由：name 格式 "mcp.<serverId>.<toolName>" --
            if (name.startsWith("mcp.")) {
              const parts = name.split(".");
              const serverId = parts[1] ?? "";
              const mcpToolName = parts.slice(2).join(".");
              log("info", "tool.call.mcp", { toolCallId, serverId, mcpToolName });
              const stepId = addTool({
                toolName: name,
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
                const result = mcpApi
                  ? await mcpApi.callTool(serverId, mcpToolName, rawArgs)
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
                patchTool(stepId, {
                  status: result.ok ? "success" : "failed",
                  output: result.ok ? result.output : failureOutput,
                });
                if (result.ok) noteSuccessfulMcpExecution(serverId, name);
                submitToolResult({
                  toolCallId, name,
                  ok: result.ok,
                  output: result.ok ? result.output : failureOutput,
                  meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false, mcpDiag },
                });
              } catch (e: any) {
                const failureOutput = { ok: false, error: String(e?.message ?? e) };
                patchTool(stepId, { status: "failed", output: failureOutput });
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
                  else if (action === "update") localToolName = "run.todo.update";
                  else if (action === "remove") localToolName = "run.todo.remove";
                  else if (action === "clear") localToolName = "run.todo.clear";
                }
                const def = getTool(localToolName);
                let localResult: any = null;
                try { if (def) localResult = await def.run(parsedArgsPreview, { mode: args.mode }); } catch {}
                const stepId = addTool({
                  toolName: name,
                  status: localResult?.ok ? "success" : "running",
                  input: parsedArgsPreview,
                  output: localResult?.ok ? localResult.output : null,
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
                toolName: name, status: "running", input: parsedArgsPreview, output: null,
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
            const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
            const def = exec.def;
            const stepApplyPolicy = exec.result.ok ? exec.result.applyPolicy ?? def?.applyPolicy ?? "proposal" : def?.applyPolicy ?? "proposal";
            const stepRiskLevel = exec.result.ok ? exec.result.riskLevel ?? def?.riskLevel ?? "high" : def?.riskLevel ?? "high";
            const initialKept = stepApplyPolicy === "auto_apply";
            const failedOutput =
              !exec.result.ok && exec.result.output !== undefined
                ? exec.result.output
                : { ok: false, error: exec.result.error };

            addTool({
              toolName: name,
              status: exec.result.ok ? "success" : "failed",
              input: exec.parsedArgs,
              output: exec.result.ok ? exec.result.output : failedOutput,
              riskLevel: stepRiskLevel, applyPolicy: stepApplyPolicy,
              undoable: exec.result.ok ? exec.result.undoable : false,
              undo: exec.result.ok ? exec.result.undo : undefined,
              apply: exec.result.ok ? exec.result.apply : undefined,
              kept: initialKept, applied: stepApplyPolicy === "auto_apply",
            });

            submitToolResult({
              toolCallId, name,
              ok: exec.result.ok,
              output: exec.result.ok ? exec.result.output : failedOutput,
              meta: {
                applyPolicy: stepApplyPolicy, riskLevel: stepRiskLevel,
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
                  output: out,
                  ...(meta && typeof meta === "object"
                    ? { applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy, riskLevel: (meta as any).riskLevel ?? st.riskLevel }
                    : {}),
                });
                if (ok0 && st.toolName === "run.done" && out && typeof out === "object") {
                  const note = String((out as any).note ?? "").trim();
                  if (note) runDoneNote = note.slice(0, 200);
                  updateWorkflowSticky({ status: "done", lastEndReason: "run_done" });
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
                        note: "lint.style（patch）已生成局部修改提案：点击 Keep 应用 edits；Undo 可回滚。",
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
                        note: `lint.style（patch）已生成"纯文本草稿"的局部修改提案：点击 Keep 会写入新文件 ${outPath}；Undo 可回滚。`,
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
        if (sawMaxTurnsExceeded) {
          updateWorkflowSticky({ status: "waiting_user", lastEndReason: "max_turns" });
          markCompositeTaskWaitingOnMaxTurns();
        }
        cancelInlineFileOpConfirm();
        setRunning(false); setActivity(null);
        if (currentAssistantId) { finishAssistant(currentAssistantId); currentAssistantId = null; }
        for (const [, bid] of subAgentBubbles) finishAssistant(bid);
        subAgentBubbles.clear();
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
      for (const [, bid] of subAgentBubbles) finishAssistant(bid);
      subAgentBubbles.clear();
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
      if (currentAssistantId) { finishAssistant(currentAssistantId); currentAssistantId = null; }
      for (const [, bid] of subAgentBubbles) finishAssistant(bid);
      subAgentBubbles.clear();
    },
  };
  // 注册到每对话取消注册表（用于同一对话发新消息时取消旧 run）
  if (args.convId) setConvRunCancel(args.convId, controller.cancel);
  return controller;
}
