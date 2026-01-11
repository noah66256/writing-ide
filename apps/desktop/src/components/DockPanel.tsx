import { useMemo, useState } from "react";
import { useRunStore } from "../state/runStore";

type TabKey = "outline" | "graph" | "problems" | "runs";

export function DockPanel() {
  const [tab, setTab] = useState<TabKey>("runs");
  const steps = useRunStore((s) => s.steps);
  const mainDoc = useRunStore((s) => s.mainDoc);

  const toolSteps = useMemo(
    () => steps.filter((s) => s.type === "tool").map((s) => s),
    [steps],
  );

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div className="dockTabs">
        <div
          className={`dockTab ${tab === "outline" ? "dockTabActive" : ""}`}
          onClick={() => setTab("outline")}
        >
          Outline
        </div>
        <div
          className={`dockTab ${tab === "graph" ? "dockTabActive" : ""}`}
          onClick={() => setTab("graph")}
        >
          Graph
        </div>
        <div
          className={`dockTab ${tab === "problems" ? "dockTabActive" : ""}`}
          onClick={() => setTab("problems")}
        >
          Problems
        </div>
        <div
          className={`dockTab ${tab === "runs" ? "dockTabActive" : ""}`}
          onClick={() => setTab("runs")}
        >
          Runs
        </div>
      </div>

      <div className="dockContent">
        {tab === "outline" && <div>（占位）后续从 Markdown 标题树生成 Outline。</div>}
        {tab === "graph" && <div>（占位）后续显示文章结构图（思维导图）。</div>}
        {tab === "problems" && <div>（占位）后续接入 lint.style / lint.platform / lint.facts。</div>}
        {tab === "runs" && (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ color: "#e7e9ee" }}>Main Doc（当前 Run）</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {JSON.stringify(mainDoc, null, 2)}
            </pre>
            <div style={{ color: "#e7e9ee" }}>Tool Blocks</div>
            {toolSteps.length === 0 ? (
              <div>暂无工具步骤。你可以在右侧发起一次 Plan/Agent。</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {toolSteps.map((t) => (
                  <div key={t.id}>
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        color: "#e7e9ee",
                      }}
                    >
                      {t.toolName}
                    </span>{" "}
                    <span style={{ color: "#9aa3b2" }}>· {t.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


