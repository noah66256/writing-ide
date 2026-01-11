import { useEffect, useMemo, useRef, useState } from "react";
import { startGatewayRun } from "../agent/gatewayAgent";
import { useRunStore } from "../state/runStore";
import { useProjectStore } from "../state/projectStore";
import { IconAt, IconGlobe, IconImage, IconMic, IconSend, IconStop } from "./Icons";
import { PillSelect } from "./PillSelect";
import { ToolBlock } from "./ToolBlock";
import { RichText } from "./RichText";

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const controllerRef = useRef<RunController | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [submitFromHistory, setSubmitFromHistory] = useState<null | { stepId: string; text: string }>(null);

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
    const text = input.trim();
    startTurn(text);
    setInput("");
  };

  const onStop = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
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
                <div className="msgUserHeader">
                  <div className="msgUserMeta">
                    你 · {new Date(step.ts).toLocaleTimeString()}
                    {step.edited ? "（已编辑）" : ""}
                  </div>
                  <button
                    className="msgEditBtn"
                    type="button"
                    onClick={() => {
                      setEditingId(step.id);
                      setEditingText(step.text);
                    }}
                    title="编辑并从该条继续（可回滚）"
                  >
                    编辑
                  </button>
                </div>
                {isEditing ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <textarea
                      className="msgEditArea"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.isComposing) return;
                        if (e.key !== "Enter") return;
                        if (e.ctrlKey || e.metaKey) return; // 允许换行（默认行为）
                        e.preventDefault();
                        setSubmitFromHistory({ stepId: step.id, text: editingText.trim() });
                      }}
                    />
                    <div className="btnRow">
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingText("");
                        }}
                      >
                        取消
                      </button>
                      <button
                        className="btn btnPrimary"
                        type="button"
                        onClick={() => setSubmitFromHistory({ stepId: step.id, text: editingText.trim() })}
                        disabled={!editingText.trim()}
                      >
                        提交
                      </button>
                    </div>
                  </div>
                ) : (
                  <RichText text={step.text} />
                )}
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
          <textarea
            className="composerTextarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
            ref={textareaRef}
            onKeyDown={(e) => {
              if (e.isComposing) return; // 中文输入法合成中，不触发快捷键
              if (e.key !== "Enter") return;

              // Ctrl/⌘ + Enter：换行（不发送）
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const el = textareaRef.current;
                const start = el?.selectionStart ?? input.length;
                const end = el?.selectionEnd ?? input.length;
                const next = input.slice(0, start) + "\n" + input.slice(end);
                setInput(next);
                requestAnimationFrame(() => {
                  if (!el) return;
                  const pos = start + 1;
                  el.selectionStart = pos;
                  el.selectionEnd = pos;
                });
                return;
              }

              // Enter：发送
              e.preventDefault();
              onSend();
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
                title="@ 引用选择器（占位：先插入 @）"
                onClick={() => setInput((v) => (v.endsWith("@") ? v : v + "@"))}
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
    </>
  );
}


