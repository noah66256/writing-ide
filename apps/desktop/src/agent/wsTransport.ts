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
import { useRunStore, type Mode } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { useAuthStore } from "../state/authStore";
import { activateSkills } from "@writing-ide/agent-core";
import { buildStyleLinterLibrariesSidecar, executeToolCall, getTool } from "./toolRegistry";
import {
  type GatewayRunController,
  type GatewayRunArgs,
  type Ref,
  parseRefsFromPrompt,
  buildReferencesTextFromRefs,
  buildContextPack,
  buildChatContextPack,
  rollDialogueSummaryIfNeeded,
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
// Main
// ---------------------------------------------------------------------------

export function startGatewayRunWs(args: GatewayRunArgs): GatewayRunController {
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
    log,
  } = useRunStore.getState();

  setRunning(true);
  setActivity("正在构建上下文…", { resetTimer: true });

  // Main Doc goal 初始化
  const cur = useRunStore.getState().mainDoc;
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
        if (ended || abort.signal.aborted || !useRunStore.getState().isRunning) return;
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
      const pinned = (useRunStore.getState().ctxRefs ?? []).map((r: any) => ({
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
        for (const r of promptRefs) useRunStore.getState().addCtxRef({ kind: r.kind, path: r.path } as any);
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
        const run = useRunStore.getState();
        const main: any = run.mainDoc ?? {};
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

        const att = useRunStore.getState().kbAttachedLibraryIds ?? [];
        let styleLinterLibraries: any[] | undefined;
        if (Array.isArray(att) && att.length) {
          const ret = await buildStyleLinterLibrariesSidecar({ maxLibraries: 6 }).catch(() => ({ ok: false } as any));
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
            const connectedWithTools = serverList.filter((s: any) => s.status === "connected" && Array.isArray(s.tools) && s.tools.length);
            const mcpTools = connectedWithTools
              .flatMap((s: any) => s.tools.map((t: any) => ({
                name: `mcp.${s.id}.${t.name}`,
                description: `[MCP:${s.name}] ${t.description ?? ""}`,
                inputSchema: t.inputSchema ?? null,
                serverId: s.id,
                serverName: s.name,
                originalName: t.name,
              })));
            if (mcpTools.length) out.mcpTools = mcpTools;
            log("info", "sidecar.mcp", {
              mcpApiAvailable: true,
              servers: serverList.length,
              connected: connectedWithTools.length,
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
        if (r?.rolled) setActivity("正在构建上下文…", { resetTimer: false });
      } catch (e: any) {
        log("warn", "context.summary.exception", { error: e?.message ? String(e.message) : String(e) });
      }

      // -- context pack ---
      const contextPack =
        args.mode === "chat"
          ? buildChatContextPack({ referencesText })
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
            if (useRunStore.getState().isRunning) {
              setActivity(agName ? `${agName} 正在处理…` : "子 Agent 正在处理…", { resetTimer: true });
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
            if (useRunStore.getState().isRunning) setActivity("正在继续…");
          }

          // ---- run.end ----
          if (event === "run.end") {
            log("info", "agent.run.end", data);
            setRunning(false); setActivity(null);

            // 触发记忆提取（异步，不阻塞 UI）
            try {
              const runState = useRunStore.getState();
              const mode = runState.mode ?? "chat";
              const summary = runState.dialogueSummaryByMode?.[mode] ?? "";
              if (summary.trim()) {
                const projStore = useProjectStore.getState();
                const rootDir = projStore.rootDir ?? "";
                const projectName = rootDir ? (rootDir.split(/[/\\]/).pop() ?? "") : "";
                import("../state/memoryStore").then(({ useMemoryStore }) => {
                  void useMemoryStore.getState().extractMemory({
                    dialogueSummary: summary,
                    projectName,
                    rootDir,  // 捕获当前 rootDir，防止项目切换后串写
                  });
                }).catch(() => void 0);
              }
            } catch {
              // ignore memory extraction errors
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
            if (useRunStore.getState().isRunning && title) {
              setActivity(`系统：${title}`, { resetTimer: true });
            }
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
            if (useRunStore.getState().isRunning) setActivity("正在生成…");
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
            if (useRunStore.getState().isRunning) setActivity("正在继续…");
          }

          // ---- tool.call ----
          if (event === "tool.call") {
            const toolCallId = String(data?.toolCallId ?? "");
            const name = String(data?.name ?? "");
            const rawArgs = (data?.args ?? {}) as Record<string, unknown>;
            const executedBy = String(data?.executedBy ?? "desktop");
            const parsedArgsPreview = parseSseToolArgs(rawArgs);

            log("info", "tool.call", { toolCallId, name });

            // Sub-agent tool calls: skip UI but still execute Desktop-side tools
            const toolAgentId = data?.agentId ? String(data.agentId) : null;
            if (toolAgentId) {
              if (executedBy === "gateway") {
                // Gateway already handled this tool — nothing to do on Desktop
                log("info", "tool.call.subagent.skip", { toolCallId, name, agentId: toolAgentId });
                return;
              }
              // MCP 工具路由（子 Agent 也走 MCP 通道）
              if (name.startsWith("mcp.")) {
                const parts = name.split(".");
                const serverId = parts[1] ?? "";
                const mcpToolName = parts.slice(2).join(".");
                log("info", "tool.call.subagent.mcp", { toolCallId, serverId, mcpToolName, agentId: toolAgentId });
                try {
                  const mcpApi = (window as any).desktop?.mcp;
                  const result = mcpApi
                    ? await mcpApi.callTool(serverId, mcpToolName, rawArgs)
                    : { ok: false, error: "MCP_API_NOT_AVAILABLE" };
                  submitToolResult({
                    toolCallId, name,
                    ok: result.ok,
                    output: result.ok ? result.output : { ok: false, error: result.error },
                    meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                  });
                } catch (e: any) {
                  submitToolResult({
                    toolCallId, name,
                    ok: false,
                    output: { ok: false, error: String(e?.message ?? e) },
                    meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                  });
                }
                return;
              }
              // Desktop-executed tool for sub-agent: run & send result, skip UI
              log("info", "tool.call.subagent.exec", { toolCallId, name, agentId: toolAgentId });
              const exec = await executeToolCall({ toolName: name, rawArgs, mode: args.mode });
              submitToolResult({
                toolCallId, name,
                ok: exec.result.ok,
                output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
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
              try {
                const mcpApi = (window as any).desktop?.mcp;
                const result = mcpApi
                  ? await mcpApi.callTool(serverId, mcpToolName, rawArgs)
                  : { ok: false, error: "MCP_API_NOT_AVAILABLE" };
                submitToolResult({
                  toolCallId, name,
                  ok: result.ok,
                  output: result.ok ? result.output : { ok: false, error: result.error },
                  meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                });
              } catch (e: any) {
                submitToolResult({
                  toolCallId, name,
                  ok: false,
                  output: { ok: false, error: String(e?.message ?? e) },
                  meta: { applyPolicy: "auto", riskLevel: "low", hasApply: false },
                });
              }
              return;
            }

            // -- Gateway-executed tools --
            if (executedBy === "gateway") {
              if (name.startsWith("run.") && name !== "run.done") {
                const def = getTool(name);
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

            addTool({
              toolName: name,
              status: exec.result.ok ? "success" : "failed",
              input: exec.parsedArgs,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              riskLevel: stepRiskLevel, applyPolicy: stepApplyPolicy,
              undoable: exec.result.ok ? exec.result.undoable : false,
              undo: exec.result.ok ? exec.result.undo : undefined,
              apply: exec.result.ok ? exec.result.apply : undefined,
              kept: initialKept, applied: stepApplyPolicy === "auto_apply",
            });

            submitToolResult({
              toolCallId, name,
              ok: exec.result.ok,
              output: exec.result.ok ? exec.result.output : { ok: false, error: exec.result.error },
              meta: {
                applyPolicy: stepApplyPolicy, riskLevel: stepRiskLevel,
                hasApply: exec.result.ok ? typeof exec.result.apply === "function" : false,
              },
            });
            if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
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
              const st = stepId ? (useRunStore.getState().steps ?? []).find((s: any) => s && s.type === "tool" && s.id === stepId) : null;

              if (st && st.type === "tool" && st.status === "running") {
                patchTool(stepId, {
                  status: ok0 ? "success" : "failed",
                  output: out,
                  ...(meta && typeof meta === "object"
                    ? { applyPolicy: (meta as any).applyPolicy ?? st.applyPolicy, riskLevel: (meta as any).riskLevel ?? st.riskLevel }
                    : {}),
                });

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

                    const stepNow = (useRunStore.getState().steps ?? []).find((x: any) => x && x.type === "tool" && x.id === stepId) as any;
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
                if (useRunStore.getState().isRunning) setActivity("正在等待模型继续…", { resetTimer: true });
              }
            }
            log("info", "tool.result", data);
          }

          // ---- error (inside event envelope) ----
          if (event === "error") {
            const errMsg = data?.error ? String(data.error) : "unknown";
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
      if (useRunStore.getState().isRunning) {
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
        log("info", "ws.run.aborted", { message: msg, cancelReason });
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
      if (socketRef) { try { socketRef.close(); } catch {} socketRef = null; }
      resolveDoneOnce();
    }
  })();

  return {
    done,
    cancel: (reason?: string) => {
      if (ended) return;
      const r = String(reason ?? "unknown").trim() || "unknown";
      cancelReason = r;
      log("warn", "ws.run.cancel", { reason: r });
      try { (abort as any).abort(r); } catch { abort.abort(); }
      setRunning(false); setActivity(null);
      if (currentAssistantId) { finishAssistant(currentAssistantId); currentAssistantId = null; }
      for (const [, bid] of subAgentBubbles) finishAssistant(bid);
      subAgentBubbles.clear();
    },
  };
}
