import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { activateSkills, listRegisteredSkills, type ActiveSkill, BUILTIN_SUB_AGENTS } from "@ohmycrab/agent-core";
import { startGatewayRun } from "../agent/gatewayAgent";
import { useRunStore, type MainDoc } from "../state/runStore";
import { useProjectStore } from "../state/projectStore";
import { IconAt, IconChevronDown, IconClock, IconCopy, IconEye, IconGlobe, IconImage, IconList, IconMic, IconPlus, IconRewind, IconSend, IconStop, IconTrash } from "./Icons";
import { PillSelect } from "./PillSelect";
import { ToolBlock } from "./ToolBlock";
import { RichText } from "./RichText";
import { RefComposer, type RefComposerHandle, type RefItem } from "./RefComposer";
import { useKbStore } from "../state/kbStore";
import { useConversationStore, type RunSnapshot, type SerializableStep } from "../state/conversationStore";
import { ModelPickerModal, type ModelPickerItem } from "./ModelPickerModal";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { useAuthStore } from "../state/authStore";
import { useSkillStore } from "../state/skillStore";
import { useDialogStore } from "../state/dialogStore";
import { resolveInlineFileOpConfirm } from "../state/inlineFileOpConfirm";

type RunController = { cancel: (reason?: string) => void; done: Promise<void> };

type LlmSelectorDto = {
  ok: boolean;
  updatedAt: string;
  models: Array<{
    id: string;
    model: string;
    providerId: string | null;
    providerName: string | null;
    endpoint: string;
  }>;
  stages: {
    chat: { modelIds: string[]; defaultModelId: string };
    agent: { modelIds: string[]; defaultModelId: string };
  };
};

function normalizeRefPath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  return s;
}

function tokenForRef(item: RefItem) {
  const p = normalizeRefPath(item.path);
  const path = item.kind === "dir" && p && !p.endsWith("/") ? `${p}/` : p;
  return `@{${path}}`;
}

function parseRefsFromText(prompt: string): RefItem[] {
  const out: RefItem[] = [];
  const re = /@\{([^}]+)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(String(prompt ?? ""))) !== null) {
    const raw = String(m[1] ?? "").trim();
    if (!raw) continue;
    let p = normalizeRefPath(raw);
    const isDir = p.endsWith("/");
    if (isDir) p = p.replace(/\/+$/g, "");
    if (!p) continue;
    out.push({ kind: isDir ? "dir" : "file", path: p });
  }
  // 去重（保持顺序）
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeOneRefTokenFromText(text: string, item: RefItem) {
  const tok = tokenForRef(item);
  const re = new RegExp(`\\s*${escapeRegExp(tok)}\\s*`, "g");
  const next = String(text ?? "").replace(re, " ").replace(/\s{2,}/g, " ").trim();
  return next;
}

function looksLikeKbPanelOnlyIntent(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const hasKbOpVerb =
    /(抽卡|入库|导入语料|导入素材|学.{0,4}风格|学.{0,4}写法|学习.{0,4}风格|分析.{0,4}文风|生成.{0,4}手册|风格手册)/.test(t);
  if (!hasKbOpVerb) return false;
  const looksLikeDebug = /(问题|bug|报错|失败|修复|检查|日志|代码|实现|排查|原因|为什么)/i.test(t);
  if (looksLikeDebug) return false;
  return true;
}

export function AgentPane() {
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const updateMainDoc = useRunStore((s) => s.updateMainDoc);
  const todoList = useRunStore((s) => s.todoList);
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);
  const activity = useRunStore((s) => s.activity);

  const setMode = useRunStore((s) => s.setMode);
  const setModel = useRunStore((s) => s.setModel);
  const setModelForMode = useRunStore((s) => s.setModelForMode);

  const [input, setInput] = useState("");
  const [llmSelector, setLlmSelector] = useState<LlmSelectorDto | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [ctxStripOpen, setCtxStripOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<RefComposerHandle | null>(null);
  const historyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const controllerRef = useRef<RunController | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [submitFromHistory, setSubmitFromHistory] = useState<null | { stepId: string; text: string }>(null);
  const historyEditRef = useRef<HTMLDivElement | null>(null);

  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refPickerQuery, setRefPickerQuery] = useState("");
  const [refPickerTarget, setRefPickerTarget] = useState<"main" | "history">("main");
  const refPickerInputRef = useRef<HTMLInputElement | null>(null);

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // Cursor-like：按“用户消息起点”作为回合锚点，滚动时动态置顶
  const userNodeByIdRef = useRef<Record<string, HTMLDivElement | null>>({});
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null);

  // 会话历史（最小版）：新建/历史/删除
  const conversations = useConversationStore((s) => s.conversations);
  const addConversation = useConversationStore((s) => s.addConversation);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const hydrateConversationsFromDisk = useConversationStore((s) => s.hydrateFromDisk);
  const draftSnapshot = useConversationStore((s) => s.draftSnapshot);
  const setDraftSnapshot = useConversationStore((s) => s.setDraftSnapshot);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);
  const [hideToolSteps, setHideToolSteps] = useState(() => {
    try {
      return window.localStorage.getItem("agent.hideToolSteps") === "1";
    } catch {
      return false;
    }
  });

  const uiConfirm = useDialogStore((s) => s.openConfirm);
  const uiAlert = useDialogStore((s) => s.openAlert);

  useEffect(() => {
    try {
      window.localStorage.setItem("agent.hideToolSteps", hideToolSteps ? "1" : "0");
    } catch {
      // ignore
    }
  }, [hideToolSteps]);

  // 运行状态耗时刷新（0.5s）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning || !activity) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [isRunning, activity?.text, activity?.startedAt]);

  // 统一处理：关闭遮罩类 overlay，并把焦点还给输入框
  const focusComposerSoon = (opts?: { reason?: string }) => {
    const tryFocus = () => {
      try {
        composerRef.current?.focus();
      } catch {
        // ignore
      }
    };
    // 经验：删除对话/关闭遮罩时会触发多次重渲染，单次 raf 容易被抢焦点
    requestAnimationFrame(() => {
      tryFocus();
      requestAnimationFrame(() => tryFocus());
      window.setTimeout(() => tryFocus(), 0);
      window.setTimeout(() => tryFocus(), 50);
      window.setTimeout(() => tryFocus(), 120);
    });

    // 仅在显式传入 reason 时写日志（用于定位“谁在抢焦点/遮罩残留”）
    if (opts?.reason) {
      try {
        const el = document.activeElement as HTMLElement | null;
        const ae = el
          ? {
              tag: String(el.tagName ?? ""),
              id: String((el as any).id ?? ""),
              ariaLabel: String(el.getAttribute?.("aria-label") ?? ""),
              className: String((el as any).className ?? "").slice(0, 120),
            }
          : null;
        useRunStore.getState().log("info", "ui.focusComposerSoon", { reason: opts.reason, activeElement: ae });
      } catch {
        // ignore
      }
    }
  };

  const closeAllOverlays = (opts?: { keepHistoryOpen?: boolean }) => {
    setModelPickerOpen(false);
    setRefPickerOpen(false);
    setSubmitFromHistory(null);
    setEditingId(null);
    setEditingText("");
    setRefPickerQuery("");
    setCtxStripOpen(false);
    setCopiedHint(null);
    if (!opts?.keepHistoryOpen) setHistoryOpen(false);
  };

  // 任意 overlay 关闭后自动 focus：避免出现“遮罩关闭了但输入框无光标/无法打字”的错觉
  const anyOverlayOpen = historyOpen || refPickerOpen || modelPickerOpen || Boolean(submitFromHistory);
  const prevOverlayOpenRef = useRef(false);
  useEffect(() => {
    const prev = prevOverlayOpenRef.current;
    prevOverlayOpenRef.current = anyOverlayOpen;
    if (prev && !anyOverlayOpen) focusComposerSoon();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyOverlayOpen]);

  const formatElapsed = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(r).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const todoStatsInline = useMemo(() => {
    const list = Array.isArray(todoList) ? todoList : [];
    const done = list.filter((t) => t.status === "done").length;
    const blocked = list.filter((t) => t.status === "blocked").length;
    const doing = list.filter((t) => t.status === "in_progress").length;
    return { total: list.length, done, blocked, doing };
  }, [todoList]);

  // dev：留空 => 走 /api（Vite proxy）；packaged(file://)：默认回落到 DEFAULT_GATEWAY_URL
  const gatewayUrl = getGatewayBaseUrl();
  const openKbManager = useKbStore((s) => s.openKbManager);
  const kbLibraries = useKbStore((s) => s.libraries);
  const ctxRefs = useRunStore((s) => s.ctxRefs);
  const addCtxRef = useRunStore((s) => s.addCtxRef);
  const removeCtxRef = useRunStore((s) => s.removeCtxRef);

  type RunIntentValue = NonNullable<MainDoc["runIntent"]>;
  const runIntentValue = (mainDoc?.runIntent ?? "auto") as RunIntentValue;
  const runIntentLabel =
    runIntentValue === "writing"
      ? "写作"
      : runIntentValue === "rewrite"
        ? "改写"
        : runIntentValue === "polish"
          ? "润色"
          : runIntentValue === "analysis"
            ? "分析"
            : runIntentValue === "ops"
              ? "操作"
              : "自动";

  const skillPrompt = useMemo(() => {
    const typed = String(input ?? "").trim();
    if (typed) return typed;
    const all = steps ?? [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const s: any = all[i];
      if (s && s.type === "user" && typeof s.text === "string" && String(s.text).trim()) return String(s.text);
    }
    return "";
  }, [input, steps]);

  const externalSkills = useSkillStore((s) => s.externalSkills);

  const activeSkills = useMemo((): ActiveSkill[] => {
    const allManifests = [...listRegisteredSkills(), ...externalSkills];
    return activateSkills({ mode: mode as any, userPrompt: skillPrompt, mainDocRunIntent: runIntentValue, kbSelected: [] as any, manifests: allManifests as any });
  }, [mode, runIntentValue, skillPrompt, externalSkills]);

  const skillsLabel =
    activeSkills.length === 0
      ? "SKILLS 0"
      : activeSkills.length === 1
        ? `SKILL ${activeSkills[0].badge}`
        : `SKILLS ${activeSkills[0].badge}+${activeSkills.length - 1}`;
  const skillsTitle =
    activeSkills.length === 0
      ? "Active Skills：无"
      : `Active Skills（按优先级）：\n` +
        activeSkills
          .map(
            (s) =>
              `- ${s.badge} ${s.id} (${s.stageKey})\n  reasonCodes: ${(s.activatedBy?.reasonCodes ?? []).join(", ")}`,
          )
          .join("\n");

  const writeClipboard = async (text: string) => {
    // Electron/浏览器剪贴板在窗口未聚焦时可能失败：优先尝试浏览器剪贴板，失败则走原生 clipboard IPC
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      const api = window.desktop?.clipboard;
      if (!api?.writeText) throw new Error("CLIPBOARD_NOT_AVAILABLE");
      const r = await api.writeText(text);
      if (!r?.ok) throw new Error(r?.error ?? "CLIPBOARD_WRITE_FAILED");
    }
  };

  const refreshLlmSelector = async () => {
    const doFetch = async (base: string) => {
      const url = base ? `${base}/api/llm/selector` : "/api/llm/selector";
      return fetch(url, { cache: "no-store" });
    };

    try {
      let res: Response;
      try {
        res = await doFetch(gatewayUrl);
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        if (msg.includes("Failed to fetch") && String(gatewayUrl).includes("localhost")) {
          const fallback = String(gatewayUrl).replace("localhost", "127.0.0.1");
          res = await doFetch(fallback);
        } else {
          throw e;
        }
      }
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as LlmSelectorDto | null;
      if (!data?.ok) return;
      setLlmSelector(data);

      const chatIds = Array.isArray(data?.stages?.chat?.modelIds) ? data.stages.chat.modelIds.filter(Boolean) : [];
      const agentIds = Array.isArray(data?.stages?.agent?.modelIds) ? data.stages.agent.modelIds.filter(Boolean) : [];
      const chatDefault = String(data?.stages?.chat?.defaultModelId ?? "").trim() || chatIds[0] || "";
      const agentDefault = String(data?.stages?.agent?.defaultModelId ?? "").trim() || agentIds[0] || "";

      const st = useRunStore.getState();
      if (chatDefault && (!st.chatModel || (chatIds.length && !chatIds.includes(st.chatModel)))) {
        st.setModelForMode("chat", chatDefault);
      }
      if (agentDefault && (!st.agentModel || (agentIds.length && !agentIds.includes(st.agentModel)))) {
        st.setModelForMode("agent", agentDefault);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshLlmSelector();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modelPickerItems = useMemo((): ModelPickerItem[] => {
    const data = llmSelector;
    if (!data?.ok) return [];
    const stageKey = mode === "chat" ? "chat" : "agent";
    const ids = stageKey === "chat" ? data.stages.chat.modelIds : data.stages.agent.modelIds;
    const map = new Map((data.models ?? []).map((m) => [m.id, m]));
    return (ids ?? [])
      .map((id) => {
        const m = map.get(id);
        return {
          id,
          label: m?.model || id,
          providerId: m?.providerId ?? null,
          providerName: m?.providerName ?? null,
        };
      })
      .filter((x) => Boolean(x.id));
  }, [llmSelector, mode]);

  const modelLabel = useMemo(() => {
    const data = llmSelector;
    const found = (data?.models ?? []).find((m) => m.id === model) || null;
    return found?.model || model || "选择模型";
  }, [llmSelector, model]);

  // Context 使用量（估算）：Main Doc + 最近消息 + 当前输入
  const mainDocChars = JSON.stringify(mainDoc).length;
  const recentTextChars = steps
    .slice(-6)
    .filter((s) => s.type === "assistant" || s.type === "user")
    .reduce((sum, s) => sum + ("text" in s ? String((s as any).text ?? "").length : 0), 0);
  const inputChars = input.length;
  const approxTokens = Math.ceil((mainDocChars + recentTextChars + inputChars) / 4);
  const approxLimit = 32000;
  const ctxPct = Math.min(100, Math.round((approxTokens / approxLimit) * 100));
  const ctxTitle =
    `Context 估算：${approxTokens}/${approxLimit} tokens（${ctxPct}%）\n` +
    `- Main Doc: ~${Math.ceil(mainDocChars / 4)}\n` +
    `- Recent: ~${Math.ceil(recentTextChars / 4)}\n` +
    `- Input: ~${Math.ceil(inputChars / 4)}\n` +
    `（提示：后续接入真实 usage 后会用真实 token 计数替代）`;

/** Parse @agentName mention from input text. Returns { agentId, cleanText } or null. */
  function parseAtMention(text: string): { agentId: string; agentName: string; cleanText: string } | null {
    const m = text.match(/^@(\S+)\s+/);
    if (!m) return null;
    const mention = m[1];
    const agent = BUILTIN_SUB_AGENTS.find(
      (a) => a.enabled && (a.id === mention || a.name === mention),
    );
    if (!agent) return null;
    return { agentId: agent.id, agentName: agent.name, cleanText: text.slice(m[0].length) };
  }

  const appendUserStepWithBaseline = (text: string) => {
    const baseline = {
      project: useProjectStore.getState().snapshot(),
      mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
      todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
      ctxRefs: JSON.parse(JSON.stringify(useRunStore.getState().ctxRefs ?? [])),
    };
    useRunStore.getState().addUser(text, baseline as any);
  };

  const startTurn = (text: string, opts?: { bypassKbGuide?: boolean }) => {
    if (!text) return;
    // 允许“运行中发送”：先中断当前 run，再启动新一轮（human-in-the-loop / 用户确认用）
    if (controllerRef.current) {
      controllerRef.current.cancel("start_new_turn_or_user_interrupt");
      controllerRef.current = null;
    }
    if (!model) {
      useRunStore.getState().addAssistant("（未选择模型：请先启动 Gateway 并选择一个模型）");
      return;
    }

    if (!opts?.bypassKbGuide && mode === "agent" && looksLikeKbPanelOnlyIntent(text)) {
      appendUserStepWithBaseline(text);
      useRunStore.getState().addAssistant(
        "抽卡/语料学习已改为面板操作：请到知识库里选择目标库后执行抽卡。完成后点击下方“我已完成抽卡”，我再继续后续写作或分析。",
        false,
        false,
        { quickActions: ["open_kb_manager", "kb_done_continue"] },
      );
      return;
    }

    // 真实积分：要求先登录再使用 AI（离线写作不受影响）
    const me = useAuthStore.getState().user;
    if (!me) {
      useRunStore.getState().addAssistant("（未登录：请先点左下角【设置】用手机号验证码登录；登录后会启用真实积分扣费与余额展示。）");
      return;
    }

    // 记录用户消息 + baseline（用于“从历史消息提交/回滚”）
    appendUserStepWithBaseline(text);

    const atMention = parseAtMention(text);
    const c = startGatewayRun({ gatewayUrl, mode, model, prompt: atMention ? atMention.cleanText : text, ...(atMention ? { targetAgentId: atMention.agentId } : {}) });
    controllerRef.current = c;
    void c.done.finally(() => {
      if (controllerRef.current === c) controllerRef.current = null;
    });
  };

  const onSend = () => {
    const text = (composerRef.current?.getValue() ?? input).trim();
    startTurn(text);
    setInput("");
    composerRef.current?.setValue("");
  };

  const onStop = () => {
    if (controllerRef.current) {
      controllerRef.current.cancel("stop_button");
      controllerRef.current = null;
    }
  };

  function truncateStr(s: string, max = 8000) {
    const t = String(s ?? "");
    if (t.length <= max) return t;
    return t.slice(0, max) + "\n…（已截断）";
  }

  function buildSnapshot(): RunSnapshot {
    const state = useRunStore.getState();
    const safeMainDoc = { ...(state.mainDoc ?? {}) } as any;
    for (const k of Object.keys(safeMainDoc)) {
      const v = safeMainDoc[k];
      if (typeof v === "string") safeMainDoc[k] = truncateStr(v, 8000);
    }

    const rawSteps = (state.steps ?? []).slice(-260);
    const serial: SerializableStep[] = rawSteps.map((st: any) => {
      if (!st || typeof st !== "object") return st as any;
      if (st.type === "assistant") return { ...st, text: truncateStr(String(st.text ?? ""), 12000) };
      if (st.type === "user") return { ...st, text: truncateStr(String(st.text ?? ""), 12000) };
      if (st.type === "tool") {
        const t = st as any;
        return { ...t, apply: undefined, undo: undefined, undoable: false } as any;
      }
      return st as any;
    });

    return {
      mode: state.mode,
      model: state.model,
      mainDoc: safeMainDoc,
      todoList: JSON.parse(JSON.stringify(state.todoList ?? [])),
      steps: serial,
      logs: JSON.parse(JSON.stringify(state.logs ?? [])),
      kbAttachedLibraryIds: [],
      ctxRefs: JSON.parse(JSON.stringify(state.ctxRefs ?? [])),
    };
  }

  function currentConversationTitle(): string {
    const all = useRunStore.getState().steps ?? [];
    const lastUser = [...all].reverse().find((s) => s.type === "user") as any;
    const t = String(lastUser?.text ?? "").trim();
    return t ? t.split("\n")[0] : "未命名对话";
  }

  const onNewConversation = () => {
    if (isRunning) return;
    // 防止“新对话后遮罩残留挡住输入框”
    closeAllOverlays();
    if (controllerRef.current) {
      controllerRef.current.cancel("new_conversation");
      controllerRef.current = null;
    }
    // 归档当前对话到历史（若为空则直接清空）
    const hasAny =
      (useRunStore.getState().steps ?? []).length > 0 ||
      Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim());
    if (hasAny) {
      addConversation({ title: currentConversationTitle(), snapshot: buildSnapshot() });
    }
    useRunStore.getState().resetRun();
    // 新对话：清掉 pinned（否则按钮可能“看起来可点但无效”）
    setPinnedUserId(null);
    setInput("");
    composerRef.current?.setValue("");
    focusComposerSoon({ reason: "new_conversation" });
  };

  const onDeleteCurrent = () => {
    if (isRunning) return;
    const hasAny = (useRunStore.getState().steps ?? []).length > 0;
    if (!hasAny) return;
    void (async () => {
      const ok = await uiConfirm({
        title: "确认删除当前对话？",
        message: "仅清空右侧对话记录（步骤/工具卡片）。会保留 Main Doc 与 Todo，不影响项目文件。",
        confirmText: "删除",
        cancelText: "取消",
        danger: true,
      });
      if (!ok) return;
      try {
        useRunStore.getState().log("info", "ui.delete_current", {
          phase: "before_reset",
          overlays: { historyOpen, refPickerOpen, modelPickerOpen, submitFromHistory: Boolean(submitFromHistory) },
        });
      } catch {
        // ignore
      }
      closeAllOverlays();
      if (controllerRef.current) {
        controllerRef.current.cancel("delete_conversation");
        controllerRef.current = null;
      }
      useRunStore.getState().clearConversationSteps();
      setPinnedUserId(null);
      setInput("");
      composerRef.current?.setValue("");
      focusComposerSoon({ reason: "delete_conversation" });
    })();
  };

  const onCopyDiagnostics = async () => {
    try {
      const run = useRunStore.getState();
      const kb = useKbStore.getState();
      const playbook = "";
      const toolCalls = (run.steps ?? [])
        .filter((s: any) => s && typeof s === "object" && s.type === "tool")
        .map((t: any) => ({ toolName: t.toolName, status: t.status }));

      const mainDocLens: Record<string, number> = {};
      for (const [k, v] of Object.entries(run.mainDoc ?? {})) {
        if (typeof v === "string") mainDocLens[k] = v.length;
      }

      const diag = {
        ts: new Date().toISOString(),
        mode: run.mode,
        model: run.model,
        kbAttachedLibraryIds: [],
        kbAttachedLibraries: [],
        playbookChars: playbook.length,
        mainDocLens,
        todo: {
          total: (run.todoList ?? []).length,
          done: (run.todoList ?? []).filter((t: any) => t.status === "done").length,
        },
        steps: {
          total: (run.steps ?? []).length,
          user: (run.steps ?? []).filter((s: any) => s.type === "user").length,
          assistant: (run.steps ?? []).filter((s: any) => s.type === "assistant").length,
          tool: toolCalls.length,
        },
        toolCalls,
        logsTail: (run.logs ?? []).slice(-80),
      };

      const text = JSON.stringify(diag, null, 2);
      await writeClipboard(text);
      setCopiedHint(`已复制诊断信息（${text.length} chars）`);
      setTimeout(() => setCopiedHint(null), 1600);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      void uiAlert({ title: "复制失败", message: `复制失败：${msg}\n\n提示：请确保窗口处于前台（聚焦），或稍后重试。` });
    }
  };

  const openRefPicker = (target: "main" | "history") => {
    setRefPickerTarget(target);
    setRefPickerQuery("");
    setRefPickerOpen(true);
    requestAnimationFrame(() => refPickerInputRef.current?.focus());
  };

  const projectFiles = useProjectStore((s) => s.files);
  const projectDirs = useProjectStore((s) => s.dirs);
  const refOptions = useMemo(() => {
    const q = refPickerQuery.trim().toLowerCase();
    const hit = (p: string) => (q ? String(p).toLowerCase().includes(q) : true);
    const out: RefItem[] = [];
    for (const d of projectDirs ?? []) if (hit(d)) out.push({ kind: "dir", path: d });
    for (const f of projectFiles ?? []) if (hit(f.path)) out.push({ kind: "file", path: f.path });
    return out.slice(0, 80);
  }, [projectDirs, projectFiles, refPickerQuery]);

  const applyRef = (item: RefItem) => {
    if (refPickerTarget === "main") {
      addCtxRef(item);
      composerRef.current?.insertRef(item);
      // 同步 state（用于 CTX 估算）
      setInput(composerRef.current?.getValue() ?? input);
      return;
    }
    // history：暂时仍用 textarea（后续再升级为同款 RefComposer）
    const token = `@{${item.kind === "dir" ? `${item.path.replace(/\/+$/g, "")}/` : item.path}}`;
    addCtxRef(item);
    setEditingText((v) => (v ? v + " " + token + " " : token + " "));
  };

  const applyAgentMention = (agentId: string, agentName: string) => {
    const cur = composerRef.current?.getValue() ?? input;
    const stripped = cur.replace(/^@\S+\s+/, "");
    const next = "@" + agentName + " " + stripped;
    setInput(next);
    composerRef.current?.setValue(next);
    setRefPickerOpen(false);
    focusComposerSoon();
  };

  // 把输入框里出现的 @{} 自动”钉”到 ctxRefs（只增不减），避免发送后 input 被清空导致上下文丢失。
  useEffect(() => {
    const refs = parseRefsFromText(input);
    if (!refs.length) return;
    for (const r of refs) addCtxRef(r);
  }, [addCtxRef, input]);

  const removeCtxRefAndInput = (item: RefItem) => {
    removeCtxRef(item);
    // 同时尽量从输入框里移除 token（若还存在），避免视觉与实际 scope 不一致
    const cur = composerRef.current?.getValue() ?? input;
    const next = removeOneRefTokenFromText(cur, item);
    setInput(next);
    composerRef.current?.setValue(next);
  };

  const mainDocSummary = useMemo(() => {
    const parts: string[] = [];
    if (mainDoc.title) parts.push(`标题：${String(mainDoc.title)}`);
    if (mainDoc.topic) parts.push(`选题：${String(mainDoc.topic)}`);
    if (mainDoc.goal) parts.push(`目标：${String(mainDoc.goal).trim().replace(/\s+/g, " ").slice(0, 80)}`);
    if (!parts.length) return "MAIN DOC：暂无（建议仅保留摘要/约束，不要把整篇原文塞进 Main Doc）";
    return "MAIN DOC：" + parts.join(" · ");
  }, [mainDoc.goal, mainDoc.title, mainDoc.topic]);

  const userSteps = useMemo(() => steps.filter((s) => s.type === "user") as any[], [steps]);
  const lastUserStepId = userSteps.length ? String(userSteps[userSteps.length - 1].id) : null;

  // 默认置顶：最后一条 user（最近一回合）
  useEffect(() => {
    const last = userSteps.length ? String(userSteps[userSteps.length - 1].id) : null;
    setPinnedUserId((prev) => prev ?? last);
  }, [userSteps]);

  const submitHistory = (opts: { revert: boolean }) => {
    const payload = submitFromHistory;
    if (!payload) return;
    const { stepId, text } = payload;
    setSubmitFromHistory(null);
    setEditingId(null);
    setEditingText("");

    if (controllerRef.current) {
      controllerRef.current.cancel("submit_history");
      controllerRef.current = null;
    }

    const all = useRunStore.getState().steps;
    const step = all.find((s) => s.id === stepId);
    if (!step || step.type !== "user") return;

    if (opts.revert && step.baseline) {
      // 回滚文件与主文档到该消息提交前，并清除其后消息
      useProjectStore.getState().restore(step.baseline.project);
      useRunStore.getState().setMainDoc(step.baseline.mainDoc);
      useRunStore.getState().setTodoList(step.baseline.todoList ?? []);
      useRunStore.getState().setCtxRefs(step.baseline.ctxRefs ?? []);
      useRunStore.getState().truncateFrom(stepId);

      // 重新添加“编辑后的用户消息”（新 baseline）
      const baseline = {
        project: useProjectStore.getState().snapshot(),
        mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
        todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
        ctxRefs: JSON.parse(JSON.stringify(useRunStore.getState().ctxRefs ?? [])),
      };
      useRunStore.getState().addUser(text, baseline as any);
    } else {
      // 不回滚文件：仅清除该消息之后的对话，然后从这里继续
      useRunStore.getState().patchUser(stepId, { text, edited: true });
      useRunStore.getState().truncateAfter(stepId);
    }

    // 继续运行（从该条消息的内容开始）
    const c = startGatewayRun({ gatewayUrl, mode, model, prompt: text });
    controllerRef.current = c;
    void c.done.finally(() => {
      if (controllerRef.current === c) controllerRef.current = null;
    });
  };

  // 组件卸载时：明确标记来源，避免日志里看起来像“用户没点停止但 cancel 了”
  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        controllerRef.current.cancel("unmount");
        controllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点击空白处取消“选定历史框”（回到显示态）
  useEffect(() => {
    if (!editingId) return;
    const onDown = (e: MouseEvent) => {
      const root = historyEditRef.current;
      const target = e.target as Node;
      if (!root) return;
      if (root.contains(target)) return;
      setEditingId(null);
      setEditingText("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editingId]);

  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    const threshold = 80;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    stickToBottomRef.current = atBottom;

    // 动态置顶：根据当前滚动位置选中“最靠上的回合锚点”（用户消息）
    const top = el.scrollTop + 12;
    let best: string | null = null;
    for (const u of userSteps) {
      const id = String(u.id);
      const node = userNodeByIdRef.current[id];
      if (!node) continue;
      if (node.offsetTop <= top) best = id;
      else break;
    }
    if (best && best !== pinnedUserId) setPinnedUserId(best);
  };

  // 自动滚动：仅在用户没有上滑浏览历史时跟随到底部
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
  }, [steps, isRunning]);

  // 历史对话：优先从磁盘加载（packaged 默认安装目录；dev 默认 userData），再由 localStorage 兜底
  useEffect(() => {
    void hydrateConversationsFromDisk().catch(() => void 0);
  }, [hydrateConversationsFromDisk]);

  // Draft：自动保存当前对话（避免“重启后右侧空白”）
  useEffect(() => {
    // 空状态就清掉草稿，避免“新对话”也被恢复
    const hasAny =
      (steps ?? []).length > 0 ||
      Object.values(mainDoc ?? {}).some((v) => String(v ?? "").trim()) ||
      (todoList ?? []).length > 0 ||
      (ctxRefs ?? []).length > 0;
    if (!hasAny) {
      setDraftSnapshot(null);
      return;
    }
    // 复用现有的“安全快照”（裁剪 steps/移除 apply/undo）
    setDraftSnapshot(buildSnapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, mainDoc, todoList, ctxRefs, mode, model, setDraftSnapshot]);

  // 启动自动恢复：若当前 run 为空，则加载 draftSnapshot
  const restoredDraftRef = useRef(false);
  useEffect(() => {
    if (restoredDraftRef.current) return;
    if (isRunning) return;
    if (!draftSnapshot) return;
    const curSteps = useRunStore.getState().steps ?? [];
    const curHasAny =
      curSteps.length > 0 || Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim());
    if (curHasAny) {
      restoredDraftRef.current = true;
      return;
    }
    useRunStore.getState().loadSnapshot(draftSnapshot as any);
    restoredDraftRef.current = true;
  }, [draftSnapshot, isRunning]);

  return (
    <>
      <div className="mainDoc">
        <div className="agentTopBar">
          <div className="mainDocSummary" title={mainDocSummary}>
            {mainDocSummary}
          </div>
          <div className="agentTopActions">
            <button className="iconBtn" type="button" onClick={onNewConversation} disabled={isRunning} title="新对话" aria-label="新对话">
              <IconPlus />
            </button>
            <button
              className="iconBtn"
              type="button"
              onClick={() => setHistoryOpen(true)}
              disabled={isRunning}
              title={conversations.length ? `历史（${conversations.length}）` : "历史"}
              aria-label="历史"
              style={{ position: "relative" }}
            >
              <IconClock />
              {conversations.length ? <span className="iconBadge">{Math.min(99, conversations.length)}</span> : null}
            </button>
            <button className="iconBtn" type="button" onClick={onCopyDiagnostics} title="复制诊断" aria-label="复制诊断">
              <IconCopy />
            </button>
            <button
              className="iconBtn"
              type="button"
              onClick={() => setHideToolSteps((v) => !v)}
              title={hideToolSteps ? "显示工具步骤（Tool Blocks）" : "隐藏工具步骤（只看正文）"}
              aria-label={hideToolSteps ? "显示步骤" : "只看正文"}
            >
              {hideToolSteps ? <IconList /> : <IconEye />}
            </button>
            <button
              className="iconBtn iconBtnDanger"
              type="button"
              onClick={onDeleteCurrent}
              disabled={isRunning}
              title="删除当前对话"
              aria-label="删除当前对话"
            >
              <IconTrash />
            </button>
          </div>
        </div>
        {copiedHint && <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 12 }}>{copiedHint}</div>}

        <div className="pinnedTurnBar">
          <div className="pinnedTurnHeader">
            <div className="pinnedTurnTitle">PINNED TURN</div>
            <div className="pinnedTurnActions">
              <button
                className="btn btnIcon"
                type="button"
                title="从该回合继续（可选择是否回滚）"
                onClick={() => {
                  const id = pinnedUserId ?? userSteps[userSteps.length - 1]?.id;
                  const u = userSteps.find((x) => x.id === id);
                  if (!id || !u) return;
                  setSubmitFromHistory({ stepId: String(id), text: String(u.text ?? "") });
                }}
                disabled={!pinnedUserId}
              >
                <IconRewind />
              </button>
            </div>
          </div>
          <div className="pinnedTurnText clamp4">
            {(() => {
              const id = pinnedUserId ?? userSteps[userSteps.length - 1]?.id;
              const u = userSteps.find((x) => x.id === id);
              return u ? String(u.text ?? "") : "（暂无对话）";
            })()}
          </div>
        </div>
      </div>

      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {steps.map((step) => {
          if (step.type === "user") {
            const isEditing = editingId === step.id;
            const showWorkflowHere =
              Boolean(lastUserStepId) &&
              String(step.id) === lastUserStepId &&
              ((isRunning && activity?.text) || (todoList?.length ?? 0) > 0);
            return (
              <Fragment key={step.id}>
                <div
                  className="msgUser"
                  ref={(el) => {
                    userNodeByIdRef.current[step.id] = el;
                  }}
                >
                  <div
                    className={`composerBox historyBox ${isEditing ? "historyBoxActive" : "historyBoxIdle"}`}
                    onClick={() => {
                      if (isEditing) return;
                      setEditingId(step.id);
                      setEditingText(step.text);
                    }}
                  >
                  {!isEditing && (
                    <div className="historyHeader">
                      <div className="msgUserMeta">
                        你 · {new Date(step.ts).toLocaleTimeString()}
                        {step.edited ? "（已编辑）" : ""}
                      </div>
                      <button
                        className="iconBtn"
                        type="button"
                        aria-label="从此处继续（可回滚）"
                        title="从此处继续（可回滚）"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSubmitFromHistory({ stepId: step.id, text: step.text });
                        }}
                      >
                        <IconRewind />
                      </button>
                    </div>
                  )}

                  {isEditing ? (
                    <div ref={historyEditRef}>
                      <textarea
                        className="composerTextarea"
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        rows={3}
                        placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
                        ref={historyTextareaRef}
                        onKeyDown={(e) => {
                          if ((e.nativeEvent as any)?.isComposing) return;
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                            setEditingText("");
                            return;
                          }
                          if (e.key !== "Enter") return;

                          // Shift/Ctrl/⌘ + Enter：换行（不提交）
                          if (e.shiftKey || e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            const el = e.currentTarget;
                            const start = el.selectionStart ?? editingText.length;
                            const end = el.selectionEnd ?? editingText.length;
                            const next = editingText.slice(0, start) + "\n" + editingText.slice(end);
                            setEditingText(next);
                            requestAnimationFrame(() => {
                              const pos = start + 1;
                              el.selectionStart = pos;
                              el.selectionEnd = pos;
                            });
                            return;
                          }

                          // Enter：提交（触发确认弹窗）
                          e.preventDefault();
                          const t = editingText.trim();
                          if (!t) return;
                          setSubmitFromHistory({ stepId: step.id, text: t });
                        }}
                      />

                      <div className="composerBar">
                        <div className="composerBarLeft">
                          <PillSelect
                            value={mode}
                            options={[
                              { value: "agent", label: "Agent" },
                              { value: "chat", label: "Chat" },
                            ]}
                            onChange={(v) => setMode(v as typeof mode)}
                            title="模式"
                          />
                          <PillSelect
                            value={runIntentValue}
                            options={[
                              { value: "auto", label: "意图：自动" },
                              { value: "writing", label: "意图：写作" },
                              { value: "rewrite", label: "意图：改写" },
                              { value: "polish", label: "意图：润色" },
                              { value: "analysis", label: "意图：分析" },
                              { value: "ops", label: "意图：操作" },
                            ]}
                            onChange={(v) => updateMainDoc({ runIntent: v as RunIntentValue })}
                            title={`意图（结构化）：${runIntentLabel}\n- 自动：后端启发式判断\n- 写作/改写/润色：会更倾向启用写作闭环门禁\n- 分析/操作：尽量避免误触写作强闭环`}
                          />
                          <div
                            className="pillSelect"
                            style={{ minWidth: 0, maxWidth: 220 }}
                            title={model ? `模型：${model}` : "未选择模型"}
                          >
                            <button
                              className="pillBtn"
                              type="button"
                              onClick={() => {
                                setModelPickerOpen(true);
                                void refreshLlmSelector();
                              }}
                            >
                              <span className="pillLabel">{modelLabel}</span>
                              <span className={`pillChevron ${modelPickerOpen ? "pillChevronOpen" : ""}`}>
                                <IconChevronDown />
                              </span>
                            </button>
                          </div>
                          <div className="ctxPill" title={ctxTitle} aria-label="Context 使用量">
                            CTX {ctxPct}%
                          </div>
                        </div>

                        <div className="composerBarRight">
                          <div className="composerBarRightMain">
                            <button
                              className="iconBtn"
                              type="button"
                              aria-label="@ 引用"
                              title="@ 引用选择器"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRefPicker("history");
                              }}
                            >
                              <IconAt />
                            </button>
                            <button
                              className="iconBtn"
                              type="button"
                              aria-label="联网/网页引用"
                              title="联网/网页引用（占位：后续接 webSearch）"
                              onClick={(e) => {
                                e.stopPropagation();
                                useRunStore.getState().addAssistant("（webSearch 按钮占位：后续接入）");
                              }}
                            >
                              <IconGlobe />
                            </button>
                            <button
                              className="iconBtn"
                              type="button"
                              aria-label="图片"
                              title="图片输入（占位：后续接入上传/解析/OCR）"
                              onClick={(e) => {
                                e.stopPropagation();
                                fileInputRef.current?.click();
                              }}
                            >
                              <IconImage />
                            </button>
                            <button
                              className="iconBtn"
                              type="button"
                              aria-label="语音"
                              title="语音输入（占位：后续接入 start/stop）"
                              onClick={(e) => {
                                e.stopPropagation();
                                useRunStore.getState().addAssistant("（语音输入接口已预留，后续接入）");
                              }}
                            >
                              <IconMic />
                            </button>
                          </div>

                          <div className="composerBarRightSend">
                            {isRunning ? (
                              <button
                                className="sendBtn"
                                type="button"
                                aria-label="停止"
                                title="停止"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onStop();
                                }}
                              >
                                <IconStop />
                              </button>
                            ) : (
                              <button
                                className="sendBtn"
                                type="button"
                                aria-label="提交"
                                title="提交"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const t = editingText.trim();
                                  if (!t) return;
                                  setSubmitFromHistory({ stepId: step.id, text: t });
                                }}
                                disabled={!editingText.trim() || !model}
                              >
                                <IconSend />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="historyText">
                      <RichText text={step.text} />
                    </div>
                  )}
                  </div>
                </div>

                {showWorkflowHere ? (
                  <div className="workflowCard">
                    {isRunning && activity?.text ? (
                      <div className="workflowStatusRow" title={activity.text}>
                        <div className="workflowStatusText">{activity.text}</div>
                        <div className="workflowStatusTime">已耗时 {formatElapsed(nowTick - activity.startedAt)}</div>
                      </div>
                    ) : null}

                    {(todoList?.length ?? 0) > 0 ? (
                      <div className="workflowTodoBox" role="group" aria-label="To-dos">
                        <div className="workflowTodoHeader">
                          <div className="workflowTodoTitle">
                            To-dos {todoStatsInline.total}
                            <span className="workflowTodoMeta">
                              {todoStatsInline.done ? ` · ✓${todoStatsInline.done}` : ""}
                              {todoStatsInline.doing ? ` · …${todoStatsInline.doing}` : ""}
                              {todoStatsInline.blocked ? ` · !${todoStatsInline.blocked}` : ""}
                            </span>
                          </div>
                        </div>
                        <div className="workflowTodoList">
                          {(todoList ?? []).slice(0, 12).map((t) => {
                            const status = String(t.status ?? "todo");
                            const isDone = status === "done";
                            const icon = isDone ? "✓" : status === "in_progress" ? "…" : status === "blocked" ? "!" : "○";
                            return (
                              <div key={t.id} className={`workflowTodoItem ${isDone ? "workflowTodoDone" : ""}`}>
                                <span className={`workflowTodoIcon workflowTodoIcon_${status}`}>{icon}</span>
                                <span className="workflowTodoText">{t.text}</span>
                              </div>
                            );
                          })}
                          {(todoList ?? []).length > 12 ? <div className="workflowTodoMore">…（更多 todo 请到 Dock/Runs 查看）</div> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Fragment>
            );
          }
          if (step.type === "assistant") {
            if (step.hidden) return null;
            const raw = step.text;
            const text = raw.trim();
            const lineCount = text.split("\n").filter((x) => x.trim()).length;
            const looksLikeDraft = text.length >= 480 || lineCount >= 10;
            const isSubAgent = !!step.agentId;
            const agentLabel = step.agentName || step.agentId || "";
            const quickActions = Array.isArray(step.quickActions) ? step.quickActions : [];
            return (
              <div key={step.id} className={`msgAssistant${isSubAgent ? " msgSubAgent" : ""}`}>
                <div className="assistantMsgHeader">
                  <div className="assistantMsgTitle">
                    {isSubAgent ? (
                      <span className="subAgentTag" title={`Sub-agent: ${step.agentId}`}>
                        {agentLabel}
                      </span>
                    ) : (
                      "输出"
                    )}
                  </div>
                  <button
                    className="btn btnIcon"
                    type="button"
                    title="复制该段输出"
                    onClick={() => {
                      if (!text) return;
                      const tryCopy = async () => {
                        try {
                          await writeClipboard(text);
                          setCopiedHint(`已复制输出（${text.length} chars）`);
                          setTimeout(() => setCopiedHint(null), 1200);
                        } catch (e: any) {
                          const msg = e?.message ? String(e.message) : String(e);
                          void uiAlert({ title: "复制失败", message: `复制失败：${msg}\n\n提示：请确保窗口处于前台（聚焦），或稍后重试。` });
                        }
                      };
                      void tryCopy();
                    }}
                  >
                    <IconCopy />
                  </button>
                </div>
                {looksLikeDraft ? (
                  <textarea className="assistantTextArea" readOnly spellCheck={false} value={text} />
                ) : (
                  <RichText text={raw} />
                )}
                {quickActions.length ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    {quickActions.includes("open_kb_manager") ? (
                      <button className="btn" type="button" onClick={() => openKbManager()} disabled={isRunning}>
                        打开知识库
                      </button>
                    ) : null}
                    {quickActions.includes("kb_done_continue") ? (
                      <button
                        className="btn btnPrimary"
                        type="button"
                        onClick={() => startTurn("我已完成抽卡，请继续刚才的任务。", { bypassKbGuide: true })}
                        disabled={isRunning}
                      >
                        我已完成抽卡
                      </button>
                    ) : null}
                    {quickActions.includes("file_op_deny") ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => resolveInlineFileOpConfirm("deny")}
                        disabled={isRunning}
                      >
                        拒绝
                      </button>
                    ) : null}
                    {quickActions.includes("file_op_allow_once") ? (
                      <button
                        className="btn btnPrimary"
                        type="button"
                        onClick={() => resolveInlineFileOpConfirm("allow_once")}
                        disabled={isRunning}
                      >
                        允许
                      </button>
                    ) : null}
                    {quickActions.includes("file_op_always_allow") ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => resolveInlineFileOpConfirm("always_allow")}
                        disabled={isRunning}
                      >
                        总是允许
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }
          // 运行中：默认不把 ToolBlock（Keep/Undo/展开）刷屏出来；失败的工具步仍然展示，便于定位错误
          if (isRunning && step.type === "tool" && step.status !== "failed") return null;
          if (hideToolSteps) return null;
          return <ToolBlock key={step.id} step={step} />;
        })}
        <div ref={bottomRef} />
      </div>

      {historyOpen && (
        <div
          className="modalMask"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setHistoryOpen(false);
          }}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">对话历史</div>
            <div className="modalDesc">点击一条历史对话即可载入到右侧（工具步会变成只读展示）。</div>
            <div style={{ display: "grid", gap: 8, maxHeight: 380, overflow: "auto" }}>
              {conversations.length ? (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 10,
                      alignItems: "center",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      padding: 10,
                      background: "var(--panel)",
                    }}
                  >
                    <button
                      type="button"
                      className="btn"
                      style={{ textAlign: "left", width: "100%" }}
                      onClick={() => {
                        useRunStore.getState().loadSnapshot(c.snapshot as any);
                        setHistoryOpen(false);
                      }}
                    >
                      <div style={{ color: "var(--text)" }}>{c.title}</div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        {new Date(c.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      className="btn btnDanger"
                      type="button"
                      title="从历史中删除"
                      onClick={() => deleteConversation(c.id)}
                    >
                      删除
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ color: "var(--muted)", fontSize: 12 }}>（暂无历史）</div>
              )}
            </div>
            <div className="modalBtns" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => setHistoryOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {submitFromHistory && (
        <div className="modalMask" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalTitle">从历史消息提交？</div>
            <div className="modalDesc">
              从历史消息继续会<strong>清除该消息之后的对话</strong>并重新运行。
              <br />
              你希望同时回滚到该消息提交前的文件与主文档状态吗？
            </div>
            <div className="modalBtns">
              <button className="btn" type="button" onClick={() => setSubmitFromHistory(null)}>
                取消
              </button>
              <button className="btn" type="button" onClick={() => submitHistory({ revert: false })}>
                继续（不回滚）
              </button>
              <button className="btn btnPrimary" type="button" onClick={() => submitHistory({ revert: true })}>
                继续并回滚
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="composer">
        <div className="composerBox">
          <div className="composerCtxStrip">
            <button
              className="ctxPill"
              type="button"
              onClick={() => setCtxStripOpen((v) => !v)}
              title={
                "上下文范围（默认折叠）\n" +
                "- 只有这里列出的“引用文件/目录（@{...}）”与“已关联 KB 库”会作为主要上下文\n" +
                "- 不会因为光标所在文件就默认读它\n" +
                "- 若需要全项目遍历/查找，再调用 project.listFiles"
              }
              style={{ cursor: "pointer", border: "none" }}
            >
              上下文 {ctxStripOpen ? "▾" : "▸"} · 引用 {ctxRefs.length}
            </button>
            <div className="composerCtxStripRight">
              <div className="ctxPill" title={ctxTitle} aria-label="Context 使用量">
                CTX {ctxPct}%
              </div>
              <div className="ctxPill" title={skillsTitle} aria-label="Active Skills">
                {skillsLabel}
              </div>
              <button className="ctxPill" type="button" title="@ 引用选择器" onClick={() => openRefPicker("main")} style={{ cursor: "pointer", border: "none" }}>
                @{ctxRefs.length || 0}
              </button>
            </div>
          </div>

          {ctxStripOpen ? (
            <div className="composerCtxPanel">
              <div className="composerCtxSection">
                <div className="composerCtxTitle">引用文件/目录（{ctxRefs.length}）</div>
                <div className="composerCtxItems">
                  {ctxRefs.length ? (
                    ctxRefs.map((r) => (
                      <span key={`${r.kind}:${r.path}`} className="refChip" title={r.kind === "dir" ? `${r.path}/` : r.path}>
                        <span className="refChipLabel">{r.kind === "dir" ? `${r.path}/` : r.path}</span>
                        <span className="refChipClose" onClick={() => removeCtxRefAndInput(r)}>
                          ×
                        </span>
                      </span>
                    ))
                  ) : (
                    <div className="explorerHint">未引用任何文件。用右侧「@」或上面的「@」按钮添加。</div>
                  )}
                </div>
              </div>

              <div className="explorerHint">
                提示：只会优先使用上述”引用文件/目录”作为上下文；找不到再考虑全项目遍历（project.listFiles）。用 @ 提及知识库可在对话中引用。
              </div>
            </div>
          ) : null}

          <RefComposer
            ref={composerRef}
            value={input}
            onChange={setInput}
            placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
            onEnterSend={onSend}
            aria-label="输入写作任务"
          />

          <div className="composerBar">
            <div className="composerBarLeft">
              <PillSelect
                value={mode}
                options={[
                  { value: "agent", label: "Agent" },
                  { value: "chat", label: "Chat" },
                ]}
                onChange={(v) => setMode(v as typeof mode)}
                title="模式"
              />
              <PillSelect
                value={runIntentValue}
                options={[
                  { value: "auto", label: "意图：自动" },
                  { value: "writing", label: "意图：写作" },
                  { value: "rewrite", label: "意图：改写" },
                  { value: "polish", label: "意图：润色" },
                  { value: "analysis", label: "意图：分析" },
                  { value: "ops", label: "意图：操作" },
                ]}
                onChange={(v) => updateMainDoc({ runIntent: v as RunIntentValue })}
                title={`意图（结构化）：${runIntentLabel}\n- 自动：后端启发式判断\n- 写作/改写/润色：会更倾向启用写作闭环门禁\n- 分析/操作：尽量避免误触写作强闭环`}
              />
              <div className="pillSelect" style={{ minWidth: 0, maxWidth: 220 }} title={model ? `模型：${model}` : "未选择模型"}>
                <button
                  className="pillBtn"
                  type="button"
                  onClick={() => {
                    setModelPickerOpen(true);
                    void refreshLlmSelector();
                  }}
                >
                  <span className="pillLabel">{modelLabel}</span>
                  <span className={`pillChevron ${modelPickerOpen ? "pillChevronOpen" : ""}`}>
                    <IconChevronDown />
                  </span>
                </button>
              </div>
            </div>

            <div className="composerBarRight">
              <div className="composerBarRightMain">
                <button className="iconBtn" type="button" aria-label="@ 引用" title="@ 引用选择器" onClick={() => openRefPicker("main")}>
                  <IconAt />
                </button>
                <button
                  className="iconBtn"
                  type="button"
                  aria-label="联网/网页引用"
                  title="联网/网页引用（占位：后续接 webSearch）"
                  onClick={() => useRunStore.getState().addAssistant("（webSearch 按钮占位：后续接入）")}
                >
                  <IconGlobe />
                </button>
                <button
                  className="iconBtn"
                  type="button"
                  aria-label="图片"
                  title="图片输入（占位：后续接入上传/解析/OCR）"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconImage />
                </button>
                <button
                  className="iconBtn"
                  type="button"
                  aria-label="语音"
                  title="语音输入（占位：后续接入 start/stop）"
                  onClick={() => useRunStore.getState().addAssistant("（语音输入接口已预留，后续接入）")}
                >
                  <IconMic />
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    useRunStore.getState().addTool({
                      toolName: "media.attachImage",
                      status: "success",
                      input: { name: f.name, size: f.size, type: f.type },
                      output: { ok: true },
                      riskLevel: "low",
                      applyPolicy: "proposal",
                      undoable: false
                    });
                    e.currentTarget.value = "";
                  }}
                />
              </div>

              <div className="composerBarRightSend">
                {(() => {
                  const pending = (steps ?? [])
                    .filter((s: any) => s && s.type === "tool")
                    .filter((s: any) => s.applyPolicy === "proposal" && s.status === "success" && !s.kept)
                    .filter((s: any) => typeof s.apply === "function");
                  const n = pending.length;
                  if (!n) return null;
                  if (isRunning) return null;
                  return (
                    <button
                      className="iconBtn"
                      type="button"
                      aria-label="KeepAll"
                      title={`KeepAll：一键应用全部提案（${n}）`}
                      onClick={() => useRunStore.getState().keepAllProposals()}
                      style={{ marginRight: 6, fontSize: 11, fontWeight: 700 }}
                    >
                      K{n}
                    </button>
                  );
                })()}
                {isRunning ? (
                  <button
                    className="sendBtn"
                    type="button"
                    aria-label={input.trim() ? "发送（将中断当前运行）" : "停止"}
                    title={input.trim() ? "发送（将中断当前运行）" : "停止"}
                    onClick={input.trim() ? onSend : onStop}
                  >
                    {input.trim() ? <IconSend /> : <IconStop />}
                  </button>
                ) : (
                  <button className="sendBtn" type="button" aria-label="发送" title="发送" onClick={onSend} disabled={!input.trim()}>
                    <IconSend />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* activityBar 已移入消息流（workflowCard），避免底部重复占位 */}

        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          快捷键：Enter 发送；Shift/Ctrl/⌘ + Enter 换行（Chat 模式不会调用写入类工具）。
        </div>
      </div>

      <ModelPickerModal
        open={modelPickerOpen}
        title={mode === "chat" ? "选择 Chat 模型" : "选择 Agent 模型"}
        items={modelPickerItems}
        value={model}
        onChange={(id) => setModel(id)}
        onClose={() => setModelPickerOpen(false)}
      />

      {refPickerOpen && (
        <div
          className="modalMask"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            // 仅点击遮罩空白处关闭，避免误关（与 KB 管理弹窗一致）
            if (e.target === e.currentTarget) setRefPickerOpen(false);
          }}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">@ 引用</div>
            <div className="modalDesc">
              指派团队成员或引用文件/文件夹。
            </div>

            {/* 团队成员 */}
            <div className="refSectionLabel">团队成员</div>
            <div className="refList refListAgents" role="list">
              {BUILTIN_SUB_AGENTS.filter(a => a.enabled).map(agent => (
                <button
                  key={agent.id}
                  className="refItem refItemAgent"
                  type="button"
                  onClick={() => applyAgentMention(agent.id, agent.name)}
                  title={agent.description}
                >
                  <span className="refAgentAvatar">{agent.avatar ?? "🤖"}</span>
                  <span className="refAgentName">{agent.name}</span>
                  <span className="refAgentDesc">{agent.description}</span>
                </button>
              ))}
            </div>

            {/* 文件引用 */}
            <div className="refSectionLabel" style={{ marginTop: 12 }}>文件 / 文件夹</div>
            <input
              ref={refPickerInputRef}
              className="modalInput"
              placeholder="搜索路径…（支持文件与文件夹）"
              value={refPickerQuery}
              onChange={(e) => setRefPickerQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setRefPickerOpen(false);
                }
              }}
            />
            <div className="refList" role="list">
              {refOptions.length ? (
                refOptions.map((it) => (
                  <button
                    key={`${it.kind}:${it.path}`}
                    className="refItem"
                    type="button"
                    onClick={() => {
                      applyRef(it);
                      setRefPickerOpen(false);
                    }}
                    title={it.path}
                  >
                    <span className={`refKind ${it.kind === "dir" ? "refKindDir" : "refKindFile"}`}>
                      {it.kind === "dir" ? "DIR" : "FILE"}
                    </span>
                    <span className="refPath">{it.path}</span>
                  </button>
                ))
              ) : (
                <div className="explorerHint" style={{ padding: "8px 2px 0" }}>
                  无匹配结果
                </div>
              )}
            </div>
            <div className="modalBtns" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => setRefPickerOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
