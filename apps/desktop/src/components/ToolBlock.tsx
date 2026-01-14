import { useMemo, useState } from "react";
import { useProjectStore } from "../state/projectStore";
import { useRunStore, type ToolBlockStep } from "../state/runStore";
import type { TopicCandidate, TopicLabOutput } from "../agent/topicLab";

function findDiffInfo(output: any): { path?: string; diff: string; truncated?: boolean; stats?: any; note?: string } | null {
  if (!output || typeof output !== "object") return null;
  if (typeof output.diffUnified === "string") {
    return { diff: output.diffUnified, truncated: output.truncated, stats: output.stats, path: output.path };
  }
  const preview = (output as any).preview;
  if (preview && typeof preview === "object" && typeof preview.diffUnified === "string") {
    return {
      diff: preview.diffUnified,
      truncated: preview.truncated,
      stats: preview.stats,
      path: preview.path ?? output.path,
      note: typeof preview.note === "string" ? preview.note : typeof output.note === "string" ? output.note : undefined,
    };
  }
  return null;
}

function fileKindLabel(p?: string) {
  const path = String(p ?? "");
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "TS",
    tsx: "TSX",
    js: "JS",
    jsx: "JSX",
    json: "JSON",
    md: "MD",
    mdx: "MDX",
    txt: "TXT",
    yml: "YAML",
    yaml: "YAML",
  };
  return map[ext] ?? (ext ? ext.toUpperCase().slice(0, 4) : "FILE");
}

function diffStatus(step: ToolBlockStep): "new" | "modified" {
  if (step.toolName === "doc.write") {
    const out = step.output as any;
    if (out && typeof out.created === "boolean") return out.created ? "new" : "modified";
  }
  return "modified";
}

function statusBadgeText(s: "new" | "modified") {
  return s === "new" ? "NEW" : "MOD";
}

function statusBadgeClass(s: "new" | "modified") {
  return s === "new" ? "diffFileBadge diffBadgeNew" : "diffFileBadge diffBadgeMod";
}

function diffLineClass(line: string) {
  if (line.startsWith("@@")) return "diffLine diffHunk";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "diffLine diffHeader";
  if (line.startsWith("+")) return "diffLine diffAdd";
  if (line.startsWith("-")) return "diffLine diffDel";
  return "diffLine diffCtx";
}

function badgeClass(status: ToolBlockStep["status"]) {
  if (status === "success") return "badge badgeOk";
  if (status === "running") return "badge badgeWarn";
  if (status === "failed") return "badge badgeDanger";
  if (status === "undone") return "badge";
  return "badge";
}

function safeJson(x: unknown) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function buildDraft(candidate: TopicCandidate) {
  const title = candidate.titles[0] ?? candidate.topic;
  return `---\n` +
    `title: ${title}\n` +
    `topic: ${candidate.topic}\n` +
    `angle: ${candidate.angle}\n` +
    `platform_type: feed_preview\n` +
    `---\n\n` +
    `# ${title}\n\n` +
    `> ${candidate.hook}\n\n` +
    `## 大纲\n` +
    candidate.outline.map((x) => `- ${x}`).join("\n") +
    `\n\n` +
    `## 正文\n\n（从这里开始扩写…）\n`;
}

export function ToolBlock(props: { step: ToolBlockStep }) {
  const { step } = props;
  const mode = useRunStore((s) => s.mode);
  const keepStep = useRunStore((s) => s.keepStep);
  const undoStep = useRunStore((s) => s.undoStep);

  const [expanded, setExpanded] = useState(false);
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);

  const topicOutput = useMemo(() => {
    if (step.toolName !== "topic.generate") return null;
    const out = step.output as TopicLabOutput | undefined;
    if (!out?.topics?.length) return null;
    return out;
  }, [step.output, step.toolName]);

  const diffInfo = useMemo(() => findDiffInfo(step.output as any), [step.output]);

  const canApplyPick = mode !== "chat" && step.status === "success" && !!topicOutput;

  const applyPick = (candidate: TopicCandidate, idx: number) => {
    if (!canApplyPick) return;
    setPickedIndex(idx);

    // 1) run.mainDoc.update（low auto-apply）
    const patch = {
      topic: candidate.topic,
      angle: candidate.angle,
      title: candidate.titles[0] ?? candidate.topic,
      platformType: "feed_preview" as const,
    };
    const { undo: undoMainDoc } = useRunStore.getState().updateMainDoc(patch);
    const mainDocStepId = useRunStore.getState().addTool({
      toolName: "run.mainDoc.update",
      status: "success",
      input: patch,
      output: { ok: true },
      applyPolicy: "auto_apply",
      riskLevel: "low",
      undoable: true,
      undo: undoMainDoc,
      kept: true,
      applied: true,
    });

    // 2) doc.write（新建草稿文件，low auto-apply，Undo=回到执行前快照）
    const snap = useProjectStore.getState().snapshot();
    const path = `drafts/run-${Date.now()}.md`;
    useProjectStore.getState().createFile(path, buildDraft(candidate));
    const undoDoc = () => useProjectStore.getState().restore(snap);

    useRunStore.getState().addTool({
      toolName: "doc.write",
      status: "success",
      input: { path },
      output: { path },
      applyPolicy: "auto_apply",
      riskLevel: "low",
      undoable: true,
      undo: undoDoc,
      kept: true,
      applied: true,
    });

    // 3) 选题工具本身标记 Keep（表示采纳其结果进入上下文）
    keepStep(step.id);

    // 避免 TS 抱怨未使用（mainDocStepId 只是示意）
    void mainDocStepId;
  };

  return (
    <div className="toolBlock">
      <div className="toolHeader">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className="toolName">{step.toolName}</div>
          <span className={badgeClass(step.status)}>{step.status}</span>
          <span className="badge">
            {step.riskLevel}/{step.applyPolicy}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => setExpanded((x) => !x)}>
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>

      <div className="toolBody">
        {topicOutput ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ color: "var(--text)" }}>
              候选选题（点击“采用”会写入 Main Doc 并新建草稿，可 Undo）
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {topicOutput.topics.slice(0, 6).map((t, idx) => (
                <div
                  key={`${t.topic}-${idx}`}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    background: "var(--panel)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ color: "var(--text)" }}>{t.topic}</div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>角度：{t.angle}</div>
                      <div style={{ color: "var(--muted)", fontSize: 12 }}>
                        标题：{t.titles[0] ?? "（无）"}
                      </div>
                    </div>
                    <button
                      className="btn btnPrimary"
                      disabled={!canApplyPick || pickedIndex === idx || step.status === "undone"}
                      onClick={() => applyPick(t, idx)}
                    >
                      采用
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>input</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{safeJson(step.input)}</pre>
            </div>
            {diffInfo && (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="diffFileHeader">
                  <div className="diffFileLeft" title={diffInfo.path ?? ""}>
                    <span className="diffFileKind">{fileKindLabel(diffInfo.path)}</span>
                    <span className="diffFilePath">{diffInfo.path ?? "（未知文件）"}</span>
                    <span className={statusBadgeClass(diffStatus(step))}>{statusBadgeText(diffStatus(step))}</span>
                    {diffInfo.truncated ? <span className="diffFileBadge diffBadgeTruncated">TRUNCATED</span> : null}
                  </div>
                  <div className="diffFileRight">
                    {diffInfo.stats ? (
                      <div className="diffStats" aria-label="diff 统计">
                        <span className="diffStat diffStatAdd">+{diffInfo.stats.added ?? 0}</span>
                        <span className="diffStat diffStatDel">-{diffInfo.stats.removed ?? 0}</span>
                      </div>
                    ) : null}
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        const text = diffInfo.diff;
                        const tryCopy = async () => {
                          try {
                            await navigator.clipboard.writeText(text);
                            return;
                          } catch {
                            const api = window.desktop?.clipboard;
                            if (!api?.writeText) return;
                            await api.writeText(text).catch(() => void 0);
                          }
                        };
                        void tryCopy();
                      }}
                      title="复制 unified diff"
                    >
                      复制 diff
                    </button>
                  </div>
                </div>
                {diffInfo.note && <div style={{ color: "var(--muted)", fontSize: 12 }}>{diffInfo.note}</div>}
                <div className="diffBox" aria-label="diff 预览">
                  {(expanded ? diffInfo.diff : diffInfo.diff.split("\n").slice(0, 40).join("\n"))
                    .split("\n")
                    .map((line, i) => (
                      <div key={i} className={diffLineClass(line)}>
                        {line}
                      </div>
                    ))}
                  {!expanded && diffInfo.diff.split("\n").length > 40 && (
                    <div className="diffLine diffCtx">…（展开可看全部）</div>
                  )}
                </div>
              </div>
            )}
            {expanded && (
              <div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>output</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{safeJson(step.output)}</pre>
              </div>
            )}
          </div>
        )}

        <div className="btnRow">
          <button
            className="btn btnDanger"
            onClick={() => undoStep(step.id)}
            disabled={step.status === "running" || step.status === "undone"}
            title={step.undoable ? "撤销该步副作用并从上下文移除" : "从上下文移除（无副作用）"}
          >
            Undo
          </button>
          <button
            className="btn btnPrimary"
            onClick={() => keepStep(step.id)}
            disabled={step.status === "running" || step.status === "undone" || step.kept}
            title="采纳该步产物进入上下文"
          >
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}


