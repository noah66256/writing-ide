import { useEffect, useMemo, useRef, useState } from "react";
import { startGatewayRun } from "../agent/gatewayAgent";
import { useRunStore } from "../state/runStore";
import { useProjectStore } from "../state/projectStore";
import { IconAt, IconCopy, IconGlobe, IconImage, IconMic, IconRewind, IconSend, IconStop } from "./Icons";
import { PillSelect } from "./PillSelect";
import { ToolBlock } from "./ToolBlock";
import { RichText } from "./RichText";
import { RefComposer, type RefComposerHandle, type RefItem } from "./RefComposer";
import { useKbStore } from "../state/kbStore";
import { useConversationStore, type RunSnapshot, type SerializableStep } from "../state/conversationStore";

type RunController = { cancel: () => void };

function stripToolXml(text: string) {
  if (!text) return "";
  const out = text
    .replace(/<tool_calls[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<tool_call[\s\S]*?<\/tool_call>/g, "");
  return out.replace(/\n{3,}/g, "\n\n");
}

export function AgentPane() {
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const todoList = useRunStore((s) => s.todoList);
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);
  const activity = useRunStore((s) => s.activity);

  const setMode = useRunStore((s) => s.setMode);
  const setModel = useRunStore((s) => s.setModel);

  const [input, setInput] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);
  const [hideToolSteps, setHideToolSteps] = useState(() => {
    try {
      return window.localStorage.getItem("agent.hideToolSteps") === "1";
    } catch {
      return false;
    }
  });

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

  const formatElapsed = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(r).padStart(2, "0");
    return `${mm}:${ss}`;
  };

  // 默认走相对路径（/api），由 Vite dev server 代理到本地 Gateway，避免跨域问题
  const gatewayUrl = (import.meta as any).env?.VITE_GATEWAY_URL ?? "";
  const kbAttached = useRunStore((s) => s.kbAttachedLibraryIds);
  const openKbManager = useKbStore((s) => s.openKbManager);

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

  useEffect(() => {
    // 尽量从 Gateway 拉取模型列表
    fetch(`${gatewayUrl}/api/llm/models`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        const ids = Array.isArray(data?.models) ? data.models.map((m: any) => String(m.id)) : [];
        const next = ids.filter(Boolean);
        setModelOptions(Array.from(new Set(next)));
        if (!next.length) return;
        if (!model || !next.includes(model)) setModel(next[0]);
      })
      .catch(() => {
        // ignore
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const startTurn = (text: string) => {
    if (isRunning) return;
    if (!text) return;
    controllerRef.current?.cancel();
    if (!model) {
      useRunStore.getState().addAssistant("（未选择模型：请先启动 Gateway 并选择一个模型）");
      return;
    }

    // 记录用户消息 + baseline（用于“从历史消息提交/回滚”）
    const baseline = {
      project: useProjectStore.getState().snapshot(),
      mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
      todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
    };
    useRunStore.getState().addUser(text, baseline as any);

    controllerRef.current = startGatewayRun({ gatewayUrl, mode, model, prompt: text });
  };

  const onSend = () => {
    const text = (composerRef.current?.getValue() ?? input).trim();
    startTurn(text);
    setInput("");
    composerRef.current?.setValue("");
  };

  const onStop = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
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
      kbAttachedLibraryIds: JSON.parse(JSON.stringify(state.kbAttachedLibraryIds ?? [])),
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
    // 归档当前对话到历史（若为空则直接清空）
    const hasAny =
      (useRunStore.getState().steps ?? []).length > 0 ||
      Object.values(useRunStore.getState().mainDoc ?? {}).some((v) => String(v ?? "").trim());
    if (hasAny) {
      addConversation({ title: currentConversationTitle(), snapshot: buildSnapshot() });
    }
    useRunStore.getState().resetRun();
  };

  const onDeleteCurrent = () => {
    if (isRunning) return;
    const hasAny = (useRunStore.getState().steps ?? []).length > 0;
    if (!hasAny) return;
    const ok = window.confirm("删除当前对话？（仅清空右侧对话记录，不影响项目文件）");
    if (!ok) return;
    useRunStore.getState().resetRun();
  };

  const onCopyDiagnostics = async () => {
    try {
      const run = useRunStore.getState();
      const kb = useKbStore.getState();
      const libs = run.kbAttachedLibraryIds ?? [];
      const playbook = await kb.getPlaybookTextForLibraries(libs).catch(() => "");
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
        kbAttachedLibraryIds: libs,
        kbAttachedLibraries: (kb.libraries ?? []).filter((l: any) => libs.includes(l.id)),
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
      window.alert(`复制失败：${msg}\n\n提示：请确保窗口处于前台（聚焦），或稍后重试。`);
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
      composerRef.current?.insertRef(item);
      // 同步 state（用于 CTX 估算）
      setInput(composerRef.current?.getValue() ?? input);
      return;
    }
    // history：暂时仍用 textarea（后续再升级为同款 RefComposer）
    const token = `@{${item.kind === "dir" ? `${item.path.replace(/\/+$/g, "")}/` : item.path}}`;
    setEditingText((v) => (v ? v + " " + token + " " : token + " "));
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

    controllerRef.current?.cancel();
    controllerRef.current = null;

    const all = useRunStore.getState().steps;
    const step = all.find((s) => s.id === stepId);
    if (!step || step.type !== "user") return;

    if (opts.revert && step.baseline) {
      // 回滚文件与主文档到该消息提交前，并清除其后消息
      useProjectStore.getState().restore(step.baseline.project);
      useRunStore.getState().setMainDoc(step.baseline.mainDoc);
      useRunStore.getState().setTodoList(step.baseline.todoList ?? []);
      useRunStore.getState().truncateFrom(stepId);

      // 重新添加“编辑后的用户消息”（新 baseline）
      const baseline = {
        project: useProjectStore.getState().snapshot(),
        mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
        todoList: JSON.parse(JSON.stringify(useRunStore.getState().todoList ?? [])),
      };
      useRunStore.getState().addUser(text, baseline as any);
    } else {
      // 不回滚文件：仅清除该消息之后的对话，然后从这里继续
      useRunStore.getState().patchUser(stepId, { text, edited: true });
      useRunStore.getState().truncateAfter(stepId);
    }

    // 继续运行（从该条消息的内容开始）
    controllerRef.current = startGatewayRun({ gatewayUrl, mode, model, prompt: text });
  };

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

  return (
    <>
      <div className="mainDoc">
        <div className="agentTopBar">
          <div className="mainDocSummary" title={mainDocSummary}>
            {mainDocSummary}
          </div>
          <div className="agentTopActions">
            <button className="btn" type="button" onClick={onNewConversation} disabled={isRunning}>
              新对话
            </button>
            <button className="btn" type="button" onClick={() => setHistoryOpen(true)} disabled={isRunning}>
              历史 {conversations.length ? `(${conversations.length})` : ""}
            </button>
            <button className="btn" type="button" onClick={onCopyDiagnostics} disabled={isRunning}>
              复制诊断
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => setHideToolSteps((v) => !v)}
              title={hideToolSteps ? "显示工具步骤（Tool Blocks）" : "隐藏工具步骤（只看正文）"}
            >
              {hideToolSteps ? "显示步骤" : "只看正文"}
            </button>
            <button className="btn btnDanger" type="button" onClick={onDeleteCurrent} disabled={isRunning}>
              删除
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
            return (
              <div
                key={step.id}
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
                              { value: "plan", label: "Plan" },
                              { value: "agent", label: "Agent" },
                              { value: "chat", label: "Chat" },
                            ]}
                            onChange={(v) => setMode(v as typeof mode)}
                            title="模式"
                            minWidth={86}
                            maxWidth={120}
                          />
                          <PillSelect
                            value={model}
                            options={modelOptions.map((m) => ({ value: m, label: m }))}
                            onChange={(v) => setModel(v)}
                            title={model || "未选择模型"}
                            minWidth={120}
                            maxWidth={220}
                          />
                          <div className="ctxPill" title={ctxTitle} aria-label="Context 使用量">
                            CTX {ctxPct}%
                          </div>
                        </div>

                        <div className="composerBarRight">
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
                  ) : (
                    <div className="historyText">
                      <RichText text={step.text} />
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (step.type === "assistant") {
            if (step.hidden) return null;
            const raw = stripToolXml(step.text);
            const text = raw.trim();
            const lineCount = text.split("\n").filter((x) => x.trim()).length;
            const looksLikeDraft = text.length >= 480 || lineCount >= 10;
            return (
              <div key={step.id} className="msgAssistant">
                <div className="assistantMsgHeader">
                  <div className="assistantMsgTitle">输出</div>
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
                          window.alert(`复制失败：${msg}\n\n提示：请确保窗口处于前台（聚焦），或稍后重试。`);
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
              </div>
            );
          }
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
                  { value: "plan", label: "Plan" },
                  { value: "agent", label: "Agent" },
                  { value: "chat", label: "Chat" },
                ]}
                onChange={(v) => setMode(v as typeof mode)}
                title="模式"
                minWidth={86}
                maxWidth={120}
              />
              <PillSelect
                value={model}
                options={modelOptions.map((m) => ({ value: m, label: m }))}
                onChange={(v) => setModel(v)}
                title={model || "未选择模型"}
                minWidth={120}
                maxWidth={220}
              />
              <div className="ctxPill" title={ctxTitle} aria-label="Context 使用量">
                CTX {ctxPct}%
              </div>
              <button
                className="ctxPill"
                type="button"
                title={(kbAttached ?? []).length ? `已关联库：${(kbAttached ?? []).length}` : "未关联任何库"}
                onClick={() => openKbManager("libraries")}
                style={{ cursor: "pointer", border: "none" }}
              >
                KB {(kbAttached ?? []).length || 0}库
              </button>
            </div>

            <div className="composerBarRight">
              <button
                className="iconBtn"
                type="button"
                aria-label="@ 引用"
                title="@ 引用选择器"
                onClick={() => openRefPicker("main")}
              >
                <IconAt />
              </button>
              <button
                className="iconBtn"
                type="button"
                aria-label="联网/网页引用"
                title="联网/网页引用（占位：后续接 webSearch）"
                onClick={() =>
                  useRunStore.getState().addAssistant("（webSearch 按钮占位：后续接入）")
                }
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
                onClick={() =>
                  useRunStore.getState().addAssistant("（语音输入接口已预留，后续接入）")
                }
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

              {isRunning ? (
                <button
                  className="sendBtn"
                  type="button"
                  aria-label="停止"
                  title="停止"
                  onClick={onStop}
                >
                  <IconStop />
                </button>
              ) : (
                <button
                  className="sendBtn"
                  type="button"
                  aria-label="发送"
                  title="发送"
                  onClick={onSend}
                  disabled={!input.trim()}
                >
                  <IconSend />
                </button>
              )}
            </div>
          </div>
        </div>

        {isRunning && activity?.text ? (
          <div className="activityBar" title={activity.text}>
            <div className="activityText">{activity.text}</div>
            <div className="activityTime">已耗时 {formatElapsed(nowTick - activity.startedAt)}</div>
          </div>
        ) : null}

        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          快捷键：Enter 发送；Shift/Ctrl/⌘ + Enter 换行（Chat 模式不会调用写入类工具）。
        </div>
      </div>

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
            <div className="modalTitle">引用文件/文件夹</div>
            <div className="modalDesc">
              选择后会插入 <span className="rtCode">@{"{path}"}</span>，发送时会自动把引用内容注入上下文（文件夹会展开为其下文件）。
            </div>
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


