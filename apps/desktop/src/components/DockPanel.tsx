import { useMemo } from "react";
import { useRunStore } from "../state/runStore";
import { useUiStore } from "../state/uiStore";
import { RichText } from "./RichText";

export function DockPanel() {
  const tab = useUiStore((s) => s.dockTab);
  const setTab = useUiStore((s) => s.setDockTab);
  const steps = useRunStore((s) => s.steps);
  const mainDoc = useRunStore((s) => s.mainDoc);
  const todoList = useRunStore((s) => s.todoList);
  const logs = useRunStore((s) => s.logs);
  const clearLogs = useRunStore((s) => s.clearLogs);

  const toolSteps = useMemo(
    () => steps.filter((s) => s.type === "tool").map((s) => s),
    [steps],
  );

  const mainDocMd = useMemo(() => {
    const lines: string[] = [];
    const platformLabel =
      mainDoc.platformType === "feed_preview"
        ? "Feed 试看型"
        : mainDoc.platformType === "search_click"
          ? "点选/搜索型"
          : mainDoc.platformType === "long_subscription"
            ? "长内容订阅型"
            : "";
    if (mainDoc.goal) lines.push(`- **目标**：${String(mainDoc.goal)}`);
    if (platformLabel) lines.push(`- **平台画像**：${platformLabel}`);
    if (mainDoc.audience) lines.push(`- **受众**：${String(mainDoc.audience)}`);
    if (mainDoc.persona) lines.push(`- **人设**：${String(mainDoc.persona)}`);
    if (mainDoc.tone) lines.push(`- **口吻**：${String(mainDoc.tone)}`);
    if (mainDoc.sourcesPolicy) lines.push(`- **素材来源**：${String(mainDoc.sourcesPolicy)}`);
    if (mainDoc.topic) lines.push(`- **选题**：${String(mainDoc.topic)}`);
    if (mainDoc.angle) lines.push(`- **角度**：${String(mainDoc.angle)}`);
    if (mainDoc.title) lines.push(`- **标题**：${String(mainDoc.title)}`);
    if (mainDoc.outline) lines.push(`\n---\n\n### 当前大纲（摘要）\n\n${String(mainDoc.outline)}`);
    return lines.join("\n");
  }, [mainDoc]);

  const todoMd = useMemo(() => {
    if (!todoList.length) return "";
    const done = todoList.filter((t) => t.status === "done").length;
    const total = todoList.length;
    const lines: string[] = [];
    lines.push(`### Todo（${done}/${total}）`);
    for (const t of todoList) {
      const mark = t.status === "done" ? "x" : " ";
      const note = t.note ? ` — ${t.note}` : "";
      lines.push(`- [${mark}] ${t.text}${note}`);
    }
    return lines.join("\n");
  }, [todoList]);

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
        <div
          className={`dockTab ${tab === "logs" ? "dockTabActive" : ""}`}
          onClick={() => setTab("logs")}
        >
          Logs
        </div>
      </div>

      <div className="dockContent">
        {tab === "outline" && <div>（占位）后续从 Markdown 标题树生成 Outline。</div>}
        {tab === "graph" && <div>（占位）后续显示文章结构图（思维导图）。</div>}
        {tab === "problems" && <div>（占位）后续接入 lint.style / lint.platform / lint.facts。</div>}
        {tab === "runs" && (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ color: "var(--text)" }}>Main Doc（当前 Run）</div>
            {mainDocMd ? <RichText text={mainDocMd} /> : <div>暂无 Main Doc。你可以在右侧开始一次 Plan/Agent。</div>}
            {todoMd ? <RichText text={todoMd} /> : <div style={{ color: "var(--muted)" }}>暂无 Todo（建议让 Agent 先生成 Todo List）。</div>}
            <div style={{ color: "var(--text)" }}>Tool Blocks</div>
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
                        color: "var(--text)",
                      }}
                    >
                      {t.toolName}
                    </span>{" "}
                    <span style={{ color: "var(--muted)" }}>· {t.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "logs" && (
          <div style={{ display: "grid", gap: 10, height: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ color: "var(--text)" }}>运行日志（测试用）</div>
              <button className="btn" type="button" onClick={clearLogs}>
                清空
              </button>
            </div>
            {logs.length === 0 ? (
              <div>暂无日志。发送一次对话/调用工具后会在这里出现。</div>
            ) : (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  background: "var(--panel)",
                  padding: 10,
                  overflow: "auto",
                  minHeight: 0,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                  lineHeight: 1.5
                }}
              >
                {logs
                  .slice()
                  .reverse()
                  .map((l) => (
                    <div key={l.id} style={{ marginBottom: 8 }}>
                      <div style={{ color: "var(--muted)" }}>
                        [{new Date(l.ts).toLocaleTimeString()}] {l.level.toUpperCase()} {l.message}
                      </div>
                      {l.data !== undefined && (
                        <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                          {JSON.stringify(l.data, null, 2)}
                        </pre>
                      )}
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


