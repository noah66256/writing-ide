import { useMemo, useState } from "react";
import { useRunStore, type TodoItem, type TodoStatus } from "../state/runStore";
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

  const todoStats = useMemo(() => {
    const list = Array.isArray(todoList) ? todoList : [];
    const done = list.filter((t) => t.status === "done").length;
    const blocked = list.filter((t) => t.status === "blocked").length;
    const doing = list.filter((t) => t.status === "in_progress").length;
    return { total: list.length, done, blocked, doing };
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
            <TodoPanel todoList={Array.isArray(todoList) ? todoList : []} stats={todoStats} />
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

function TodoPanel(args: { todoList: TodoItem[]; stats: { total: number; done: number; blocked: number; doing: number } }) {
  const { todoList, stats } = args;
  const [filter, setFilter] = useState<"open" | "all" | "blocked" | "done">("open");
  const [newText, setNewText] = useState("");

  const filtered = useMemo(() => {
    const list = Array.isArray(todoList) ? todoList : [];
    if (filter === "all") return list;
    if (filter === "done") return list.filter((t) => t.status === "done");
    if (filter === "blocked") return list.filter((t) => t.status === "blocked");
    return list.filter((t) => t.status !== "done" && t.status !== "skipped");
  }, [filter, todoList]);

  const statusLabel = (s: TodoStatus) => {
    if (s === "done") return "已完成";
    if (s === "in_progress") return "进行中";
    if (s === "blocked") return "阻塞";
    if (s === "skipped") return "跳过";
    return "待办";
  };

  const statusStyle = (s: TodoStatus) => {
    const base: any = {
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      border: "1px solid var(--border)",
      color: "var(--text)",
      background: "transparent",
      cursor: "pointer",
      userSelect: "none",
      whiteSpace: "nowrap",
    };
    if (s === "done") return { ...base, color: "var(--ok)", borderColor: "rgba(22,163,74,0.35)" };
    if (s === "in_progress") return { ...base, color: "var(--accent)", borderColor: "rgba(37,99,235,0.35)" };
    if (s === "blocked") return { ...base, color: "var(--danger)", borderColor: "rgba(220,38,38,0.35)" };
    if (s === "skipped") return { ...base, color: "var(--muted)" };
    return base;
  };

  const cycleStatus = (s: TodoStatus): TodoStatus => {
    if (s === "todo") return "in_progress";
    if (s === "in_progress") return "blocked";
    if (s === "blocked") return "done";
    if (s === "done") return "todo";
    return "todo";
  };

  const slugifyTodoId = (text: string) => {
    const s = String(text ?? "").trim().toLowerCase();
    const slug = s
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+/, "")
      .replace(/_+$/, "")
      .slice(0, 40);
    return slug;
  };

  const ensureUniqueId = (id0: string) => {
    const used = new Set(todoList.map((t) => String(t.id ?? "")));
    let id = id0;
    const base = id;
    let n = 2;
    while (used.has(id)) id = `${base}_${n++}`;
    return id;
  };

  const updateOne = (id: string, patch: Partial<TodoItem>) => {
    useRunStore.getState().updateTodo(id, patch);
  };

  const removeOne = (id: string) => {
    useRunStore.getState().setTodoList(todoList.filter((t) => t.id !== id));
  };

  const addOne = () => {
    const text = newText.trim().replace(/\s+/g, " ");
    if (!text) return;
    const idBase = slugifyTodoId(text) || `t${Date.now()}`;
    const id = ensureUniqueId(idBase);
    useRunStore.getState().setTodoList([...todoList, { id, text, status: "todo" }]);
    setNewText("");
  };

  const clearDone = () => {
    const next = todoList.filter((t) => t.status !== "done");
    useRunStore.getState().setTodoList(next);
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ color: "var(--text)" }}>
          Todo（{stats.done}/{stats.total}）
          {stats.doing ? <span style={{ color: "var(--muted)" }}> · 进行中 {stats.doing}</span> : null}
          {stats.blocked ? <span style={{ color: "var(--muted)" }}> · 阻塞 {stats.blocked}</span> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="btn" type="button" onClick={() => setFilter("open")} disabled={filter === "open"}>
            未完成
          </button>
          <button className="btn" type="button" onClick={() => setFilter("blocked")} disabled={filter === "blocked"}>
            阻塞
          </button>
          <button className="btn" type="button" onClick={() => setFilter("done")} disabled={filter === "done"}>
            已完成
          </button>
          <button className="btn" type="button" onClick={() => setFilter("all")} disabled={filter === "all"}>
            全部
          </button>
          <button className="btn" type="button" onClick={clearDone} disabled={stats.done === 0}>
            清空已完成
          </button>
        </div>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--panel)",
          padding: 10,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addOne();
            }}
            placeholder="新增一条 Todo（回车添加）"
            style={{
              flex: 1,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "8px 10px",
              color: "var(--text)",
              outline: "none",
            }}
          />
          <button className="btn" type="button" onClick={addOne} disabled={!newText.trim()}>
            添加
          </button>
        </div>

        {filtered.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>暂无 Todo（你也可以让 Agent 先生成 Todo List）。</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {filtered.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto auto 1fr auto",
                  alignItems: "start",
                  gap: 10,
                  padding: "6px 8px",
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid rgba(255,255,255,0.04)",
                }}
              >
                <input
                  type="checkbox"
                  checked={t.status === "done"}
                  onChange={() => updateOne(t.id, { status: t.status === "done" ? "todo" : "done" })}
                  style={{ marginTop: 3 }}
                />
                <span
                  style={statusStyle(t.status)}
                  title="点击切换状态（todo → 进行中 → 阻塞 → 完成 → todo）"
                  onClick={() => updateOne(t.id, { status: cycleStatus(t.status) })}
                >
                  {statusLabel(t.status)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text)", wordBreak: "break-word" }}>{t.text}</div>
                  {t.note ? <div style={{ color: "var(--muted)", marginTop: 2, wordBreak: "break-word" }}>{t.note}</div> : null}
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => updateOne(t.id, { status: "in_progress" })}
                      disabled={t.status === "in_progress"}
                    >
                      设为进行中
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        const cur = t.note ?? "";
                        const next = window.prompt("备注/阻塞原因（可留空）", cur);
                        if (next === null) return;
                        updateOne(t.id, { note: next.trim() ? next : undefined });
                      }}
                    >
                      备注…
                    </button>
                  </div>
                </div>
                <button className="btn" type="button" onClick={() => removeOne(t.id)} title="删除">
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


