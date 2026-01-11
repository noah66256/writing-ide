import { useRef, useState } from "react";
import { startMockRun, type MockRunController } from "../agent/mockAgent";
import { useRunStore } from "../state/runStore";
import { ToolBlock } from "./ToolBlock";

export function AgentPane() {
  const mode = useRunStore((s) => s.mode);
  const model = useRunStore((s) => s.model);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const steps = useRunStore((s) => s.steps);
  const isRunning = useRunStore((s) => s.isRunning);

  const setMode = useRunStore((s) => s.setMode);
  const setModel = useRunStore((s) => s.setModel);

  const [input, setInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<MockRunController | null>(null);

  const onSend = () => {
    const text = input.trim();
    if (!text) return;
    controllerRef.current?.cancel();
    controllerRef.current = startMockRun(text);
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
        {/* 对齐约定：模式/模型选择应在 Composer 内（底部输入区） */}
        <div className="composerTop">
          <select
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="plan">Plan</option>
            <option value="agent">Agent</option>
            <option value="chat">Chat</option>
          </select>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="mock">mock</option>
          </select>
        </div>

        {/* 多模态按钮占位：@引用/图片/语音（后续接入真实能力） */}
        <div className="composerTools">
          <div className="composerLeft">
            <button
              className="btn btnIcon"
              type="button"
              title="@ 引用选择器（占位：当前先插入 @）"
              onClick={() => setInput((v) => (v.endsWith("@") ? v : v + "@"))}
            >
              @
            </button>
            <button
              className="btn btnIcon"
              type="button"
              title="图片输入（占位：后续接入上传/解析/OCR）"
              onClick={() => fileInputRef.current?.click()}
            >
              图片
            </button>
            <button
              className="btn btnIcon"
              type="button"
              title="语音输入（占位：后续接入 start/stop）"
              onClick={() =>
                useRunStore.getState().addAssistant("（语音输入接口已预留，后续接入）")
              }
            >
              语音
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                // 仅占位：把“收到图片”以一条工具卡/消息展示出来（后续会换成真实上传与多模态输入）
                useRunStore.getState().addTool({
                  toolName: "media.attachImage",
                  status: "success",
                  input: { name: f.name, size: f.size, type: f.type },
                  output: { ok: true },
                  riskLevel: "low",
                  applyPolicy: "proposal",
                  undoable: false,
                });
                // 允许再次选择同一张
                e.currentTarget.value = "";
              }}
            />
          </div>
          <div className="btnRow" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={onStop} disabled={!isRunning}>
              停止
            </button>
            <button className="btn btnPrimary" onClick={onSend} disabled={isRunning}>
              发送
            </button>
          </div>
        </div>

        <textarea
          className="input textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSend();
          }}
        />

        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          快捷键：Ctrl/⌘ + Enter 发送（Chat 模式不会调用写入类工具）。
        </div>
      </div>
    </>
  );
}


