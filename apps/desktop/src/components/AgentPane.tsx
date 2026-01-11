import { useEffect, useMemo, useRef, useState } from "react";
import { startGatewayRun } from "../agent/gatewayAgent";
import { useRunStore } from "../state/runStore";
import { useProjectStore } from "../state/projectStore";
import { IconAt, IconGlobe, IconImage, IconMic, IconRewind, IconSend, IconStop } from "./Icons";
import { PillSelect } from "./PillSelect";
import { ToolBlock } from "./ToolBlock";
import { RichText } from "./RichText";
import { RefComposer, type RefComposerHandle, type RefItem } from "./RefComposer";

type RunController = { cancel: () => void };

export function AgentPane() {
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);

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

  // 默认走相对路径（/api），由 Vite dev server 代理到本地 Gateway，避免跨域问题
  const gatewayUrl = (import.meta as any).env?.VITE_GATEWAY_URL ?? "";

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

  const mainDocRows = useMemo(() => {
    const platformLabel =
      mainDoc.platformType === "feed_preview"
        ? "Feed 试看型"
        : mainDoc.platformType === "search_click"
          ? "点选/搜索型"
          : mainDoc.platformType === "long_subscription"
            ? "长内容订阅型"
            : "";
    const rows: Array<{ k: string; v: string }> = [];
    if (mainDoc.goal) rows.push({ k: "目标", v: String(mainDoc.goal) });
    if (platformLabel) rows.push({ k: "平台画像", v: platformLabel });
    if (mainDoc.topic) rows.push({ k: "选题", v: String(mainDoc.topic) });
    if (mainDoc.angle) rows.push({ k: "角度", v: String(mainDoc.angle) });
    if (mainDoc.title) rows.push({ k: "标题", v: String(mainDoc.title) });
    return rows;
  }, [mainDoc]);

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
      useRunStore.getState().truncateFrom(stepId);

      // 重新添加“编辑后的用户消息”（新 baseline）
      const baseline = {
        project: useProjectStore.getState().snapshot(),
        mainDoc: JSON.parse(JSON.stringify(useRunStore.getState().mainDoc ?? {})),
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

  return (
    <>
      <div className="mainDoc">
        <div className="sectionTitle" style={{ padding: 0, marginBottom: 6 }}>
          MAIN DOC
        </div>
        {mainDocRows.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>（暂无主线内容）</div>
        ) : (
          <div className="mainDocRich">
            {mainDocRows.map((r) => (
              <div key={r.k} className="mainDocRow">
                <div className="mainDocKey">{r.k}</div>
                <div className="mainDocVal">{r.v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="messages">
        {steps.map((step) => {
          if (step.type === "user") {
            const isEditing = editingId === step.id;
            return (
              <div key={step.id} className="msgUser">
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
                          if (e.isComposing) return;
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                            setEditingText("");
                            return;
                          }
                          if (e.key !== "Enter") return;

                          // Ctrl/⌘ + Enter：换行（不提交）
                          if (e.ctrlKey || e.metaKey) {
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
            return (
              <div key={step.id} className="msgAssistant">
                <RichText text={step.text} />
              </div>
            );
          }
          return <ToolBlock key={step.id} step={step} />;
        })}
      </div>

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

        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          快捷键：Enter 发送；Ctrl/⌘ + Enter 换行（Chat 模式不会调用写入类工具）。
        </div>
      </div>

      {refPickerOpen && (
        <div className="modalMask" role="dialog" aria-modal="true" onMouseDown={() => setRefPickerOpen(false)}>
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


