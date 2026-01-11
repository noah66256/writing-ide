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
      <div className="agentHeader">
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
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入写作任务（例如：帮我写一条小红书爆款选题）…"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSend();
          }}
        />

        <div className="btnRow">
          <button className="btn" onClick={onStop} disabled={!isRunning}>
            停止
          </button>
          <button className="btn btnPrimary" onClick={onSend} disabled={isRunning}>
            发送
          </button>
        </div>
      </div>
    </>
  );
}


