import { useEffect, useRef, useState } from "react";
import { startGatewayRun } from "../agent/gatewayAgent";
import { startMockRun } from "../agent/mockAgent";
import { useRunStore } from "../state/runStore";
import { IconAt, IconGlobe, IconImage, IconMic, IconSend, IconStop } from "./Icons";
import { ToolBlock } from "./ToolBlock";

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
  const [modelOptions, setModelOptions] = useState<string[]>(["mock"]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<RunController | null>(null);

  const gatewayUrl = (import.meta as any).env?.VITE_GATEWAY_URL ?? "http://localhost:8000";

  useEffect(() => {
    // 尽量从 Gateway 拉取模型列表；失败则保留 mock
    fetch(`${gatewayUrl}/api/llm/models`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        const ids = Array.isArray(data?.models) ? data.models.map((m: any) => String(m.id)) : [];
        const next = ["mock", ...ids.filter(Boolean)];
        setModelOptions(Array.from(new Set(next)));
        if (model === "mock") return;
        if (!next.includes(model)) setModel(next[1] ?? "mock");
      })
      .catch(() => {
        // ignore
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSend = () => {
    const text = input.trim();
    if (!text) return;
    controllerRef.current?.cancel();
    controllerRef.current =
      model === "mock"
        ? startMockRun(text)
        : startGatewayRun({ gatewayUrl, mode, model, prompt: text });
  };

  const onStop = () => {
    controllerRef.current?.cancel();
    controllerRef.current = null;
  };

  return (
    <>
      <div className="mainDoc">
        <div className="sectionTitle" style={{ padding: 0, marginBottom: 6 }}>
          MAIN DOC
        </div>
        <pre>{JSON.stringify(mainDoc, null, 2)}</pre>
      </div>

      <div className="messages">
        {steps.map((step) => {
          if (step.type === "assistant") {
            return (
              <div key={step.id} className="msgAssistant">
                {step.text}
              </div>
            );
          }
          return <ToolBlock key={step.id} step={step} />;
        })}
      </div>

      <div className="composer">
        <div className="composerBox">
          <textarea
            className="composerTextarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSend();
            }}
          />

          <div className="composerBar">
            <div className="composerBarLeft">
              <select
                className="select selectCompact"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                title="模式"
              >
                <option value="plan">Plan</option>
                <option value="agent">Agent</option>
                <option value="chat">Chat</option>
              </select>
              <select
                className="select selectCompact"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                title="模型"
              >
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
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
          快捷键：Ctrl/⌘ + Enter 发送（Chat 模式不会调用写入类工具）。
        </div>
      </div>
    </>
  );
}


