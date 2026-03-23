import { useMemo, useState } from "react";
import { getToolResultEnvelopeNormalizedText, getToolResultEnvelopePayload } from "@ohmycrab/shared";
import { useProjectStore } from "../state/projectStore";
import { getItemActionRuntime, useRunStore, type ToolBlockStep } from "../state/runStore";
import type { TopicCandidate, TopicLabOutput } from "../agent/topicLab";
import { parseFileRefHref, resolveOpenableFileRef } from "../utils/fileRefLink";

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|ogg|mkv|avi)$/i;

type ToolArtifactPreviewKind = "image" | "audio" | "video";

type ToolArtifactCard = {
  id: string;
  absPath: string;
  relPath: string;
  name: string;
  label?: string;
  ext: string;
  sizeBytes?: number;
  previewKind?: ToolArtifactPreviewKind;
};

function findDiffInfo(output: any): { path?: string; diff: string; truncated?: boolean; stats?: any; note?: string } | null {
  const rawOutput = getToolResultEnvelopePayload(output);
  if (!rawOutput || typeof rawOutput !== "object") return null;
  if (typeof (rawOutput as any).diffUnified === "string") {
    return { diff: (rawOutput as any).diffUnified, truncated: (rawOutput as any).truncated, stats: (rawOutput as any).stats, path: (rawOutput as any).path };
  }
  const preview = (rawOutput as any).preview;
  if (preview && typeof preview === "object" && typeof preview.diffUnified === "string") {
    return {
      diff: preview.diffUnified,
      truncated: preview.truncated,
      stats: preview.stats,
      path: preview.path ?? (rawOutput as any).path,
      note: typeof preview.note === "string" ? preview.note : typeof (rawOutput as any).note === "string" ? (rawOutput as any).note : undefined,
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
  if (step.toolName === "write") {
    const out = getToolResultEnvelopePayload(step.output) as any;
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

function formatBytes(bytes?: number) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactExtBadge(name?: string, ext?: string) {
  const e = String(ext ?? "").trim().toLowerCase();
  if (e) return e.toUpperCase().slice(0, 4);
  const n = String(name ?? "").trim();
  if (!n.includes(".")) return "FILE";
  return String(n.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4);
}

function toLocalFileUrl(absPath: string): string | null {
  const raw = String(absPath ?? "").trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) return encodeURI(`file:///${normalized}`);
  if (normalized.startsWith("//")) return encodeURI(`file:${normalized}`);
  if (normalized.startsWith("/")) return encodeURI(`file://${normalized}`);
  return null;
}

function detectPreviewKind(pathOrExt?: string): ToolArtifactPreviewKind | undefined {
  const value = String(pathOrExt ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (IMAGE_EXT_RE.test(value)) return "image";
  if (AUDIO_EXT_RE.test(value)) return "audio";
  if (VIDEO_EXT_RE.test(value)) return "video";
  return undefined;
}

function detectPreviewKindFromArtifact(ext?: string, name?: string): ToolArtifactPreviewKind | undefined {
  const normalizedExt = String(ext ?? "").trim().replace(/^\./, "");
  if (normalizedExt) return detectPreviewKind(`.${normalizedExt}`);
  return detectPreviewKind(name);
}

function decodeMarkdownTarget(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

function extractLinkedArtifacts(output: unknown, rootDir: string | null | undefined): ToolArtifactCard[] {
  const texts = new Set<string>();
  const payload = getToolResultEnvelopePayload(output);
  if (typeof payload === "string" && payload.trim()) texts.add(payload);
  const normalizedText = getToolResultEnvelopeNormalizedText(output);
  if (normalizedText.trim()) texts.add(normalizedText);
  const artifacts: ToolArtifactCard[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    let match: RegExpExecArray | null = null;
    const re = new RegExp(MARKDOWN_LINK_RE.source, MARKDOWN_LINK_RE.flags);
    while ((match = re.exec(text)) !== null) {
      const label = String(match[1] ?? "").trim();
      const href = decodeMarkdownTarget(String(match[2] ?? ""));
      if (!href || /^(https?:|data:|blob:|mailto:|chrome:|about:|javascript:)/i.test(href)) continue;
      const fileRefPath = parseFileRefHref(href);
      const absPath = fileRefPath
        ? resolveOpenableFileRef(rootDir, fileRefPath)
        : resolveOpenableFileRef(rootDir, href);
      if (!absPath || seen.has(absPath)) continue;
      seen.add(absPath);
      const normalizedAbsPath = absPath.replaceAll("\\", "/");
      const fileName = normalizedAbsPath.split("/").pop() ?? normalizedAbsPath;
      const ext = fileName.includes(".") ? String(fileName.split(".").pop() ?? "").trim().toLowerCase() : "";
      if (!ext) continue;
      artifacts.push({
        id: `linked:${normalizedAbsPath}`,
        absPath: normalizedAbsPath,
        relPath: href,
        name: fileName,
        label: label || undefined,
        ext,
        previewKind: detectPreviewKind(`.${ext}`),
      });
    }
  }
  return artifacts;
}

function openFileFromToolBlock(args: { path: string; pinned?: boolean }) {
  const p = String(args.path ?? "").trim().replaceAll("\\", "/");
  if (!p) return;
  const proj = useProjectStore.getState();
  const exists = Boolean(proj.getFileByPath(p));
  if (!exists) return;
  if (args.pinned) proj.openFilePinned(p);
  else proj.openFilePreview(p);
  // focus editor after state updates
  requestAnimationFrame(() => {
    try {
      useProjectStore.getState().editorRef?.focus?.();
    } catch {
      // ignore
    }
  });
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
  const items = useRunStore((s) => s.items);
  const dispatchItemAction = useRunStore((s) => s.dispatchItemAction);
  const keepStep = useRunStore((s) => s.keepStep);
  const undoStep = useRunStore((s) => s.undoStep);
  const rootDir = useProjectStore((s) => s.rootDir);

  const [expanded, setExpanded] = useState(false);
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);

  const topicOutput = useMemo(() => {
    if (step.toolName !== "topic.generate") return null;
    const out = getToolResultEnvelopePayload(step.output) as TopicLabOutput | undefined;
    if (!out?.topics?.length) return null;
    return out;
  }, [step.output, step.toolName]);

  const diffInfo = useMemo(() => findDiffInfo(step.output as any), [step.output]);

  const codeExecInfo = useMemo(() => {
    if (step.toolName !== "code.exec") return null;
    const out = getToolResultEnvelopePayload(step.output) as any;
    if (!out || typeof out !== "object") return null;
    const artifacts = (Array.isArray(out.artifacts) ? out.artifacts : [])
      .map((a: any, idx: number) => ({
        id: String(a?.absPath ?? a?.relPath ?? `artifact_${idx}`),
        absPath: String(a?.absPath ?? "").trim(),
        relPath: String(a?.relPath ?? "").trim(),
        name: String(a?.name ?? "").trim() || String(a?.relPath ?? "").split("/").pop() || "",
        ext: String(a?.ext ?? "").trim(),
        sizeBytes: Number(a?.sizeBytes ?? 0),
      }))
      .filter((a: any) => Boolean(a.absPath));

    return {
      artifacts,
      stdout: typeof out.stdout === "string" ? out.stdout : "",
      stderr: typeof out.stderr === "string" ? out.stderr : "",
      stdoutTruncated: Boolean(out.stdoutTruncated),
      stderrTruncated: Boolean(out.stderrTruncated),
      exitCode: Number.isFinite(Number(out.exitCode)) ? Number(out.exitCode) : null,
      timedOut: Boolean(out.timedOut),
      durationMs: Number.isFinite(Number(out.durationMs)) ? Number(out.durationMs) : null,
    };
  }, [step.output, step.toolName]);

  // 统一提取产出文件（code.exec + write）
  const toolArtifacts = useMemo<ToolArtifactCard[]>(() => {
    const out = getToolResultEnvelopePayload(step.output) as any;
    const linkedArtifacts = extractLinkedArtifacts(step.output, rootDir);
    if (!out || typeof out !== "object") return linkedArtifacts;
    const structuredArtifacts: ToolArtifactCard[] = [];
    if (step.toolName === "code.exec" && Array.isArray(out.artifacts)) {
      structuredArtifacts.push(...out.artifacts
        .map((a: any, idx: number) => ({
          id: String(a?.absPath ?? a?.relPath ?? `artifact_${idx}`),
          absPath: String(a?.absPath ?? "").trim(),
          relPath: String(a?.relPath ?? "").trim(),
          name: String(a?.name ?? "").trim() || String(a?.relPath ?? "").split("/").pop() || "",
          ext: String(a?.ext ?? "").trim(),
          sizeBytes: Number(a?.sizeBytes ?? 0),
          previewKind: detectPreviewKindFromArtifact(String(a?.ext ?? "").trim(), String(a?.name ?? "").trim()),
        }))
        .filter((a: any) => Boolean(a.absPath)));
    }
    if (step.toolName === "write" && out.artifact && typeof out.artifact === "object") {
      const a = out.artifact;
      const absPath = String(a.absPath ?? "").trim();
      if (absPath) structuredArtifacts.push({
        id: absPath,
        absPath,
        relPath: String(a.relPath ?? "").trim(),
        name: String(a.name ?? "").trim() || String(a.relPath ?? "").split("/").pop() || "",
        ext: String(a.ext ?? "").trim(),
        sizeBytes: Number(a.sizeBytes ?? 0),
        previewKind: detectPreviewKindFromArtifact(String(a.ext ?? "").trim(), String(a.name ?? "").trim()),
      });
    }
    const merged = [...structuredArtifacts, ...linkedArtifacts];
    const seen = new Set<string>();
    return merged.filter((artifact) => {
      const key = String(artifact.absPath ?? "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [rootDir, step.output, step.toolName]);

  const canApplyPick = mode !== "chat" && step.status === "success" && !!topicOutput;
  const isMac = (window as any).desktop?.platform === "darwin";
  const boundItem = useMemo(
    () => items.find((item) => String((item as any)?.id ?? "") === String(step.id ?? "")) ?? null,
    [items, step.id],
  );
  const runtimeAction = getItemActionRuntime(step.id);
  const itemOwnsAction = Boolean(boundItem && ((boundItem as any).type === "fileChange" || (boundItem as any).type === "approval"));
  const actionUnavailableAfterReload =
    itemOwnsAction &&
    (boundItem as any)?.actionSpec?.canReplayAfterReload === false &&
    !runtimeAction;
  const itemType = String((boundItem as any)?.type ?? "").trim();
  const itemStatus = String((boundItem as any)?.status ?? "").trim();
  const primaryCompleted = itemOwnsAction
    ? Boolean((boundItem as any)?.applied ?? (boundItem as any)?.kept)
    : Boolean(step.kept);
  const secondaryCompleted = itemOwnsAction ? itemStatus === "declined" : step.status === "undone";
  const actionRunning = itemOwnsAction ? itemStatus === "in_progress" : step.status === "running";
  const actionLabels = useMemo(() => {
    const itemType = String((boundItem as any)?.type ?? "").trim();
    const applied = Boolean((boundItem as any)?.applied ?? step.applied);
    if (itemType === "approval") {
      return {
        primary: "批准",
        secondary: "驳回",
        primaryTitle: "批准该请求",
        secondaryTitle: "驳回该请求",
      };
    }
    if (itemType === "fileChange") {
      return applied
        ? {
            primary: "应用更改",
            secondary: "回滚更改",
            primaryTitle: "应用这份更改提案",
            secondaryTitle: "回滚已应用的更改",
          }
        : {
            primary: "应用更改",
            secondary: "放弃提案",
            primaryTitle: "应用这份更改提案",
            secondaryTitle: "放弃这份更改提案",
          };
    }
    if (step.applyPolicy === "proposal") {
      return {
        primary: "采纳",
        secondary: "放弃",
        primaryTitle: "采纳该步产物进入上下文",
        secondaryTitle: "放弃该步提案",
      };
    }
    return {
      primary: "采纳",
      secondary: step.undoable ? "回滚更改" : "放弃",
      primaryTitle: "采纳该步产物进入上下文",
      secondaryTitle: step.undoable ? "回滚该步副作用并从上下文移除" : "从上下文移除（无副作用）",
    };
  }, [boundItem, step.applied, step.applyPolicy, step.undoable]);

  const handleUndo = () => {
    if (itemOwnsAction) {
      dispatchItemAction(step.id, itemType === "approval" ? "decline" : "undo");
      return;
    }
    undoStep(step.id);
  };

  const handleKeep = () => {
    if (itemOwnsAction) {
      dispatchItemAction(step.id, itemType === "approval" ? "approve" : "keep");
      return;
    }
    keepStep(step.id);
  };

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

    // 2) write（新建草稿文件，low auto-apply，回滚=回到执行前快照）
    const snap = useProjectStore.getState().snapshot();
    const path = `drafts/run-${Date.now()}.md`;
    useProjectStore.getState().createFile(path, buildDraft(candidate));
    const undoDoc = () => useProjectStore.getState().restore(snap);

    useRunStore.getState().addTool({
      toolName: "write",
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

    // 3) 选题工具本身标记为已采纳（表示其结果进入上下文）
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
              候选选题（点击“采用”会写入 Main Doc 并新建草稿，之后可回滚更改）
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
            {expanded ? (
              <div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>input</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{safeJson(step.input)}</pre>
              </div>
            ) : null}
            {diffInfo && (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="diffFileHeader">
                  <div
                    className="diffFileLeft diffFileLeftClickable"
                    title={diffInfo.path ? `打开：${diffInfo.path}` : ""}
                    role={diffInfo.path ? "button" : undefined}
                    tabIndex={diffInfo.path ? 0 : undefined}
                    onClick={(e) => {
                      const p = diffInfo.path;
                      if (!p) return;
                      openFileFromToolBlock({ path: p, pinned: Boolean((e as any)?.metaKey || (e as any)?.ctrlKey) });
                    }}
                    onKeyDown={(e) => {
                      if (!diffInfo.path) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openFileFromToolBlock({ path: diffInfo.path, pinned: Boolean((e as any)?.metaKey || (e as any)?.ctrlKey) });
                      }
                    }}
                  >
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
                    <button className="diffLine diffCtx diffMoreBtn" type="button" onClick={() => setExpanded(true)}>
                      …（点击看更多）
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* ── 产出文件 Artifact 卡片 ── */}
            {toolArtifacts.length > 0 && (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ color: "var(--text)" }}>
                    产出文件（{toolArtifacts.length} 个）
                  </div>
                  {codeExecInfo && (
                    <div style={{ color: "var(--muted)", fontSize: 12 }}>
                      {codeExecInfo.timedOut
                        ? "超时"
                        : codeExecInfo.durationMs != null
                          ? `${(codeExecInfo.durationMs / 1000).toFixed(1)}s`
                          : ""}
                      {codeExecInfo.exitCode != null && codeExecInfo.exitCode !== 0
                        ? ` · exit=${codeExecInfo.exitCode}`
                        : ""}
                    </div>
                  )}
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {toolArtifacts.map((a: any) => (
                    <div
                      key={a.id}
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 10,
                        background: "var(--panel)",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ display: "flex", gap: 8, minWidth: 0, alignItems: "center" }}>
                          <span className="diffFileKind">{artifactExtBadge(a.name, a.ext)}</span>
                          <span
                            style={{
                              color: "var(--text)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {a.label || a.name || a.relPath}
                          </span>
                        </div>
                        {Number.isFinite(Number(a.sizeBytes)) && Number(a.sizeBytes) > 0 ? (
                          <span style={{ color: "var(--muted)", fontSize: 12, flexShrink: 0 }}>
                            {formatBytes(a.sizeBytes)}
                          </span>
                        ) : null}
                      </div>
                      {a.previewKind === "image" && toLocalFileUrl(a.absPath) ? (
                        <div
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            overflow: "hidden",
                            background: "var(--surface)",
                          }}
                        >
                          <img
                            src={toLocalFileUrl(a.absPath) ?? undefined}
                            alt={a.label || a.name}
                            style={{ display: "block", width: "100%", maxHeight: 320, objectFit: "contain", background: "var(--surface)" }}
                          />
                        </div>
                      ) : null}
                      {a.previewKind === "audio" && toLocalFileUrl(a.absPath) ? (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", padding: 10 }}>
                          <audio controls className="w-full" src={toLocalFileUrl(a.absPath) ?? undefined} />
                        </div>
                      ) : null}
                      {a.previewKind === "video" && toLocalFileUrl(a.absPath) ? (
                        <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", padding: 10 }}>
                          <video
                            controls
                            src={toLocalFileUrl(a.absPath) ?? undefined}
                            style={{ display: "block", width: "100%", maxHeight: 320, borderRadius: 8, background: "black" }}
                          />
                        </div>
                      ) : null}
                      <div style={{ color: "var(--muted)", fontSize: 12, overflowWrap: "anywhere" }}>
                        {a.relPath || a.absPath}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn"
                          type="button"
                          onClick={async () => {
                            const res = await window.desktop?.exec?.openFile?.(a.absPath);
                            if (res && !res.ok) {
                              alert(res.detail || res.error === "INVALID_ARTIFACT_PATH" ? "文件路径无效" : "无法打开文件，可能已被删除或移动");
                            }
                          }}
                        >
                          打开
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            void window.desktop?.exec?.showInFolder?.(a.absPath);
                          }}
                        >
                          {isMac ? "在 Finder 显示" : "打开文件位置"}
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            void window.desktop?.exec?.saveArtifact?.({
                              absPath: a.absPath,
                              defaultName: a.name || undefined,
                            });
                          }}
                        >
                          另存为
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* ── code.exec stdout/stderr 折叠 ── */}
            {codeExecInfo && (codeExecInfo.stdout.trim() || codeExecInfo.stderr.trim()) && (
              <div style={{ display: "grid", gap: 6 }}>
                {codeExecInfo.stdout.trim() && (
                  <details>
                    <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 13 }}>
                      stdout{codeExecInfo.stdoutTruncated ? "（已截断）" : ""}
                    </summary>
                    <pre
                      style={{
                        margin: "6px 0 0",
                        whiteSpace: "pre-wrap",
                        color: "var(--muted)",
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: 8,
                        fontSize: 12,
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      {codeExecInfo.stdout}
                    </pre>
                  </details>
                )}
                {codeExecInfo.stderr.trim() && (
                  <details>
                    <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 13 }}>
                      stderr{codeExecInfo.stderrTruncated ? "（已截断）" : ""}
                    </summary>
                    <pre
                      style={{
                        margin: "6px 0 0",
                        whiteSpace: "pre-wrap",
                        color: "var(--muted)",
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: 8,
                        fontSize: 12,
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      {codeExecInfo.stderr}
                    </pre>
                  </details>
                )}
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
          {actionUnavailableAfterReload ? (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>
              该提案来自历史快照，当前仅可查看，不能继续执行提案动作。
            </div>
          ) : null}
          <button
            className="btn btnDanger"
            onClick={handleUndo}
            disabled={actionUnavailableAfterReload || actionRunning || secondaryCompleted}
            title={actionLabels.secondaryTitle}
          >
            {actionLabels.secondary}
          </button>
          <button
            className="btn btnPrimary"
            onClick={handleKeep}
            disabled={actionUnavailableAfterReload || actionRunning || secondaryCompleted || primaryCompleted}
            title={actionLabels.primaryTitle}
          >
            {actionLabels.primary}
          </button>
        </div>
      </div>
    </div>
  );
}
