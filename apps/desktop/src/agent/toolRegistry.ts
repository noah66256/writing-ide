import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode, type ToolApplyPolicy, type ToolRiskLevel } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { useAuthStore } from "../state/authStore";
import { useWritingBatchStore } from "../state/writingBatchStore";
import { getGatewayBaseUrl } from "./gatewayUrl";

function authHeader(): Record<string, string> {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function requireLoginForTool(why: string) {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  if (token) return { ok: true as const };
  try {
    useAuthStore.getState().openLoginModal?.();
    useAuthStore.setState({ error: `请先登录再使用：${why}` });
  } catch {
    // ignore
  }
  return { ok: false as const };
}

export type ToolArgSpec = {
  name: string;
  required?: boolean;
  desc: string;
};

export type ToolExecOk = {
  ok: true;
  output: unknown;
  // 允许运行时覆盖 tool 元数据（用于“同名工具在不同场景下风险/策略不同”）
  riskLevel?: ToolRiskLevel;
  applyPolicy?: ToolApplyPolicy;
  // proposal-first：返回 apply 供 Keep 执行（apply 返回 undo 供 Undo 回滚）
  apply?: () => void | { undo?: () => void };
  undoable: boolean;
  undo?: () => void;
};

export type ToolExecErr = {
  ok: false;
  error: string;
  output?: unknown;
};

export type ToolExecResult = ToolExecOk | ToolExecErr;

export type ToolDefinition = {
  name: string;
  description: string;
  args: ToolArgSpec[];
  riskLevel: ToolRiskLevel;
  applyPolicy: ToolApplyPolicy;
  reversible: boolean;
  run: (args: Record<string, unknown>, ctx: { mode: Mode }) => Promise<ToolExecResult> | ToolExecResult;
};

function gatewayBaseUrl() {
  return getGatewayBaseUrl();
}

function normalizeTextForStats(text: string) {
  return String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

type CopyRiskLevel = "low" | "medium" | "high";
type CopyRiskObserveV1 = {
  mode: "observe";
  v: 1;
  riskLevel: CopyRiskLevel;
  // 整体相似度（字符 5-gram）
  maxChar5gramJaccard: number;
  // “连续复用”的近似最大长度（seeded match；更接近 LCS/最长公共子串的工程近似）
  maxOverlapChars: number;
  sources: { total: number; selectionIncluded: boolean; styleSampleCount: number };
  topOverlaps: Array<{ source: string; overlapChars: number; snippet: string }>;
};

function normalizeTextForCopyCheck(text: string) {
  // 观测阶段：只做轻量归一（不做同义词扩展，避免误伤扩大）
  return String(text ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\s+/g, "")
    .trim();
}

function charNgramSet(text: string, n: number, maxNgrams: number) {
  const t = String(text ?? "");
  const out = new Set<string>();
  if (n <= 0) return out;
  for (let i = 0; i + n <= t.length; i += 1) {
    out.add(t.slice(i, i + n));
    if (out.size >= maxNgrams) break;
  }
  return out;
}

function charNgramJaccard(a: string, b: string, n: number) {
  const A = normalizeTextForCopyCheck(a);
  const B = normalizeTextForCopyCheck(b);
  if (A.length < n || B.length < n) return 0;
  // 控制上限：避免长文 set 爆炸（观测优先稳定）
  const maxNgrams = 12_000;
  const SA = charNgramSet(A, n, maxNgrams);
  const SB = charNgramSet(B, n, maxNgrams);
  if (!SA.size || !SB.size) return 0;
  const [small, big] = SA.size <= SB.size ? [SA, SB] : [SB, SA];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter += 1;
  const union = SA.size + SB.size - inter;
  return union > 0 ? inter / union : 0;
}

function seededMaxOverlap(args: { a: string; b: string; seedLen: number; maxSeeds: number; maxPositionsPerSeed: number }) {
  const A = normalizeTextForCopyCheck(args.a);
  const B = normalizeTextForCopyCheck(args.b);
  const seedLen = Math.max(6, Math.min(32, Math.floor(args.seedLen)));
  if (A.length < seedLen || B.length < seedLen) return { maxLen: 0, snippet: "" };

  const seedMap = new Map<string, number[]>();
  for (let i = 0; i + seedLen <= A.length; i += 1) {
    if (seedMap.size >= args.maxSeeds) break;
    const seed = A.slice(i, i + seedLen);
    const list = seedMap.get(seed);
    if (!list) seedMap.set(seed, [i]);
    else if (list.length < args.maxPositionsPerSeed) list.push(i);
  }
  if (!seedMap.size) return { maxLen: 0, snippet: "" };

  let bestLen = 0;
  let bestSnippet = "";

  for (let j = 0; j + seedLen <= B.length; j += 1) {
    const seed = B.slice(j, j + seedLen);
    const candPositions = seedMap.get(seed);
    if (!candPositions) continue;

    for (const i0 of candPositions) {
      let aL = i0;
      let bL = j;
      let aR = i0 + seedLen;
      let bR = j + seedLen;

      while (aL > 0 && bL > 0 && A.charCodeAt(aL - 1) === B.charCodeAt(bL - 1)) {
        aL -= 1;
        bL -= 1;
      }
      while (aR < A.length && bR < B.length && A.charCodeAt(aR) === B.charCodeAt(bR)) {
        aR += 1;
        bR += 1;
      }
      const len = aR - aL;
      if (len > bestLen) {
        bestLen = len;
        bestSnippet = A.slice(aL, aR);
        if (bestSnippet.length > 120) bestSnippet = bestSnippet.slice(0, 120) + "…";
      }
    }
  }

  return { maxLen: bestLen, snippet: bestSnippet };
}

function computeCopyRiskObserve(args: { draftText: string; styleSamples: Array<{ text: string }>; selectionText?: string }) {
  const draftText = String(args.draftText ?? "");
  const sources: Array<{ id: string; text: string }> = [];

  const selectionText = typeof args.selectionText === "string" ? args.selectionText : "";
  const selectionNorm = selectionText.trim();
  if (selectionNorm) sources.push({ id: "editor_selection", text: selectionNorm.slice(0, 6000) });

  const styleSamples = Array.isArray(args.styleSamples) ? args.styleSamples : [];
  for (const s of styleSamples) {
    const t = String((s as any)?.text ?? "").trim();
    if (!t) continue;
    sources.push({ id: "style_sample", text: t.slice(0, 1200) });
    if (sources.length >= 14) break; // 控量：观测期不追求覆盖所有样例
  }

  const total = sources.length;
  if (!total) {
    return {
      mode: "observe",
      v: 1,
      riskLevel: "low",
      maxChar5gramJaccard: 0,
      maxOverlapChars: 0,
      sources: { total: 0, selectionIncluded: false, styleSampleCount: 0 },
      topOverlaps: [],
    } satisfies CopyRiskObserveV1;
  }

  let maxJ = 0;
  let maxOverlap = 0;
  const overlaps: Array<{ source: string; overlapChars: number; snippet: string; j: number }> = [];

  for (const src of sources) {
    const j = charNgramJaccard(draftText, src.text, 5);
    if (j > maxJ) maxJ = j;
    const ov = seededMaxOverlap({ a: draftText, b: src.text, seedLen: 12, maxSeeds: 8000, maxPositionsPerSeed: 2 });
    if (ov.maxLen > maxOverlap) maxOverlap = ov.maxLen;
    if (ov.maxLen >= 24) overlaps.push({ source: src.id, overlapChars: ov.maxLen, snippet: ov.snippet, j });
  }

  overlaps.sort((a, b) => b.overlapChars - a.overlapChars || b.j - a.j);
  const topOverlaps = overlaps.slice(0, 3).map((x) => ({
    source: x.source,
    overlapChars: x.overlapChars,
    snippet: x.snippet,
  }));

  // 观测阶段：riskLevel 仅用于标注与统计，不做 gate
  const riskLevel: CopyRiskLevel =
    maxOverlap >= 60 ? "high" : maxOverlap >= 40 || maxJ >= 0.18 ? "medium" : "low";

  return {
    mode: "observe",
    v: 1,
    riskLevel,
    maxChar5gramJaccard: Number(maxJ.toFixed(4)),
    maxOverlapChars: Math.floor(maxOverlap),
    sources: {
      total,
      selectionIncluded: Boolean(selectionNorm),
      styleSampleCount: sources.filter((s) => s.id === "style_sample").length,
    },
    topOverlaps,
  } satisfies CopyRiskObserveV1;
}

function splitSentences(text: string) {
  const t = normalizeTextForStats(text);
  const parts = t
    .split(/[\n。！？!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : t.trim() ? [t.trim()] : [];
}

function countRegex(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeDraftStats(text: string) {
  const t = normalizeTextForStats(text);
  const chars = t.length;
  const sentences = splitSentences(t);
  const sentenceCount = sentences.length;

  const avgSentenceLen = sentenceCount ? sentences.reduce((a, s) => a + s.length, 0) / sentenceCount : 0;
  const shortSentenceRate = sentenceCount ? sentences.filter((s) => s.length <= 12).length / sentenceCount : 0;

  const questionSentences = sentenceCount
    ? sentences.filter((s) => /[？?]/.test(s) || /(吗|呢|为什么|怎么|何以|问题来了)/.test(s)).length
    : 0;
  const questionRatePer100Sentences = sentenceCount ? (questionSentences / sentenceCount) * 100 : 0;

  const exclaimSentences = sentenceCount ? sentences.filter((s) => /[！!]/.test(s)).length : 0;
  const exclaimRatePer100Sentences = sentenceCount ? (exclaimSentences / sentenceCount) * 100 : 0;

  const per1k = (n: number) => (chars ? (n / chars) * 1000 : 0);
  const firstPersonPer1kChars = per1k(countRegex(t, /我|咱|咱们|我们/g));
  const secondPersonPer1kChars = per1k(countRegex(t, /你|你们/g));
  const particlePer1kChars = per1k(countRegex(t, /啊|呢|吧|呀|哎|诶|呐/g));
  const digitPer1kChars = per1k(countRegex(t, /\d/g));

  return {
    chars,
    sentences: sentenceCount,
    stats: {
      questionRatePer100Sentences: Number(questionRatePer100Sentences.toFixed(2)),
      exclaimRatePer100Sentences: Number(exclaimRatePer100Sentences.toFixed(2)),
      avgSentenceLen: Number(avgSentenceLen.toFixed(2)),
      shortSentenceRate: Number(clamp01(shortSentenceRate).toFixed(4)),
      firstPersonPer1kChars: Number(firstPersonPer1kChars.toFixed(2)),
      secondPersonPer1kChars: Number(secondPersonPer1kChars.toFixed(2)),
      particlePer1kChars: Number(particlePer1kChars.toFixed(2)),
      digitPer1kChars: Number(digitPer1kChars.toFixed(2)),
    },
  };
}

export async function buildStyleLinterLibrariesSidecar(args?: {
  /** 优先使用显式指定；否则用右侧已关联库 */
  libraryIds?: string[];
  /** 最多携带多少个库（默认 6，与服务端 schema 对齐） */
  maxLibraries?: number;
}) {
  const maxLibraries = typeof args?.maxLibraries === "number" ? Math.max(1, Math.min(6, Math.floor(args!.maxLibraries))) : 6;
  const explicit = Array.isArray(args?.libraryIds) ? args!.libraryIds.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];

  await useKbStore.getState().refreshLibraries().catch(() => void 0);
  const libsMeta = useKbStore.getState().libraries ?? [];
  const metaById = new Map(libsMeta.map((l: any) => [String(l.id ?? ""), l]));

  const candidates = (explicit.length ? explicit : attached).map((x: any) => String(x ?? "").trim()).filter(Boolean);
  const styleLibIds = candidates.filter((id: string) => String(metaById.get(id)?.purpose ?? "") === "style");
  const libraryIds = (styleLibIds.length ? styleLibIds : []).slice(0, maxLibraries);
  if (!libraryIds.length) return { ok: false as const, error: "NO_STYLE_LIBRARY_SELECTED" as const };

  const isPlaybookDoc = (doc: any) => {
    const rel = String(doc?.importedFrom?.kind === "project" ? doc?.importedFrom?.relPath ?? "" : "").trim();
    return rel.startsWith("__kb_playbook__/library/");
  };

  const librariesPayload: any[] = [];
  for (const libId of libraryIds) {
    const meta = metaById.get(libId);
    const name = String(meta?.name ?? libId);

    const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
    const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;

    // 样例：优先取“最近片段”（不走向量，避免成本/超时）
    const sret = await useKbStore
      .getState()
      .searchForAgent({
        query: "__lint_style_samples__",
        kind: "paragraph",
        libraryIds: [libId],
        perDocTopN: 3,
        topDocs: 6,
        useVector: false,
        debug: false,
      } as any)
      .catch(() => ({ ok: false } as any));

    const samples: any[] = [];
    if (sret?.ok && Array.isArray((sret as any).groups)) {
      for (const g of (sret as any).groups) {
        const doc = g?.sourceDoc;
        if (!doc || isPlaybookDoc(doc)) continue;
        for (const h of (g?.hits ?? []) as any[]) {
          const a = h?.artifact;
          const content = String(a?.content ?? "").replace(/\s+/g, " ").trim();
          if (!content) continue;
          samples.push({
            docId: String(doc?.id ?? ""),
            docTitle: String(doc?.title ?? ""),
            paragraphIndex: typeof a?.anchor?.paragraphIndex === "number" ? a.anchor.paragraphIndex : undefined,
            text: content.slice(0, 1200),
          });
          if (samples.length >= 24) break;
        }
        if (samples.length >= 24) break;
      }
    }

    librariesPayload.push({
      id: libId,
      name,
      corpus: snapshot?.corpus ?? undefined,
      stats: snapshot?.stats ?? undefined,
      topNgrams: Array.isArray(snapshot?.topNgrams) ? snapshot.topNgrams.slice(0, 16) : undefined,
      samples: samples.slice(0, 24),
    });
  }

  return { ok: true as const, libraryIds, libraries: librariesPayload };
}

function sanitizeFileName(input: string) {
  let s = String(input ?? "").trim();
  s = s.replace(/\s+/g, " ");
  // Windows 文件名非法字符：<>:"/\|?* 以及控制字符
  s = s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "");
  // 避免结尾是点/空格（Windows 不友好）
  s = s.replace(/[ .]+$/g, "");
  if (!s) return "untitled";

  const upper = s.toUpperCase();
  const reserved = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
  ]);
  if (reserved.has(upper)) s = `${s}_`;

  // 控制长度（避免路径过长）
  const max = 80;
  if (s.length > max) s = s.slice(0, max).trim();
  return s || "untitled";
}

function normalizeRelPath(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\/+/, "");
  return s;
}

function extractTitleFromContent(content: string) {
  const text = String(content ?? "")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (!text) return "";
  const mdTitle = text.match(/^#{1,6}\s+(.+?)\s*$/m);
  if (mdTitle?.[1]) return String(mdTitle[1]).trim();
  const cnTitle = text.match(/^标题\s*[：:]\s*(.+?)\s*$/m);
  if (cnTitle?.[1]) return String(cnTitle[1]).trim();
  const enTitle = text.match(/^title\s*[:：]\s*(.+?)\s*$/im);
  if (enTitle?.[1]) return String(enTitle[1]).trim();
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return firstLine.slice(0, 60);
}

function splitPathParts(path: string) {
  const idx = path.lastIndexOf("/");
  const dir = idx >= 0 ? path.slice(0, idx) : "";
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  const m = name.match(/^(.*?)(\.[^.]+)$/);
  const base = m?.[1] ? String(m[1]) : name;
  const ext = m?.[2] ? String(m[2]) : "";
  return { dir, base, ext };
}

function resolveWritePath(args: {
  path: string;
  content: string;
  suggestedName?: string;
  ifExists: "rename" | "overwrite" | "error";
  existingPaths: Set<string>;
}) {
  const { path, content, suggestedName, ifExists, existingPaths } = args;
  const existed = existingPaths.has(path);
  if (!existed) return { path, existed, renamedFrom: "" };
  if (ifExists === "overwrite") return { path, existed, renamedFrom: "" };
  if (ifExists === "error") return { path, existed, renamedFrom: "", error: "PATH_EXISTS" as const };

  const parts = splitPathParts(path);
  const sugg = String(suggestedName ?? "").trim();
  const baseFromSuggest = sugg ? sanitizeFileName(sugg.replace(/\.[^.]+$/, "")) : "";
  const baseFromContent = sanitizeFileName(extractTitleFromContent(content));
  const base = baseFromSuggest || baseFromContent || parts.base || "untitled";
  let n = 2;
  let candidate = `${parts.dir ? `${parts.dir}/` : ""}${base}${parts.ext}`;
  while (existingPaths.has(candidate)) {
    const nextBase = sanitizeFileName(`${base}_${n++}`);
    candidate = `${parts.dir ? `${parts.dir}/` : ""}${nextBase}${parts.ext}`;
  }
  return { path: candidate, existed, renamedFrom: path, chosenBase: base };
}

function splitTitleBlocks(content: string) {
  const text = String(content ?? "")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");

  const parts = text
    .split(/(?=^标题\s*[：:])/m)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => /^标题\s*[：:]/m.test(x));
  return parts;
}

function extractTitleFromBlock(block: string) {
  const lines = String(block ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^标题\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const rest = String(m[1] ?? "").trim();
    if (rest) return rest;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = (lines[j] ?? "").trim();
      if (!t) continue;
      // 跳过“文案/正文”标签行
      if (/^(文案|正文|内容)\s*[：:]\s*$/.test(t)) continue;
      return t;
    }
  }
  return "";
}

function computeLineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function getOffsetAt(text: string, lineStarts: number[], lineNumber: number, column: number) {
  const ln = Math.max(1, Math.floor(lineNumber));
  const col = Math.max(1, Math.floor(column));
  const lineIdx = ln - 1;
  const lineStart = lineStarts[lineIdx] ?? text.length;
  const nextLineStart = lineStarts[lineIdx + 1] ?? text.length;
  const lineEnd = nextLineStart > 0 ? Math.max(lineStart, nextLineStart - 1) : lineStart;
  const maxCol0 = Math.max(0, lineEnd - lineStart);
  const col0 = Math.min(maxCol0, col - 1);
  return Math.min(text.length, lineStart + col0);
}

function applyTextEdits(args: {
  before: string;
  edits: Array<{
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    text: string;
  }>;
}) {
  const before = args.before;
  const lineStarts = computeLineStarts(before);
  const ranges = args.edits
    .map((e) => {
      const startOffset = getOffsetAt(before, lineStarts, e.startLineNumber, e.startColumn);
      const endOffset = getOffsetAt(before, lineStarts, e.endLineNumber, e.endColumn);
      return { ...e, startOffset, endOffset };
    })
    .sort((a, b) => b.startOffset - a.startOffset);

  let after = before;
  for (const r of ranges) {
    after = after.slice(0, r.startOffset) + r.text + after.slice(r.endOffset);
  }
  return { after };
}

// doc.splitToDir 的“提案态新文件内容”只保存在本地内存，不回传给 Gateway（避免 tool_result 过大）
const splitToDirProposalStore = new Map<string, Array<{ path: string; content: string }>>();
function saveSplitToDirProposal(proposalId: string, files: Array<{ path: string; content: string }>) {
  if (!proposalId) return;
  splitToDirProposalStore.set(proposalId, files);
  // cap，避免内存无限增长（仅保留最近 20 个）
  const max = 20;
  if (splitToDirProposalStore.size > max) {
    const keys = Array.from(splitToDirProposalStore.keys());
    const drop = keys.slice(0, Math.max(0, keys.length - max));
    for (const k of drop) splitToDirProposalStore.delete(k);
  }
}
function getSplitToDirProposalFile(proposalId: string, path: string): { path: string; content: string } | null {
  const id = String(proposalId ?? "").trim();
  const p = normalizeRelPath(path);
  if (!id || !p) return null;
  const list = splitToDirProposalStore.get(id);
  if (!list) return null;
  return list.find((x) => normalizeRelPath(x.path) === p) ?? null;
}

function makeProposalId(prefix: string) {
  const anyCrypto = globalThis as any;
  const uuid = typeof anyCrypto?.crypto?.randomUUID === "function" ? anyCrypto.crypto.randomUUID() : null;
  return `${prefix}_${uuid ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function getVirtualFileContentFromPendingProposals(args: {
  path: string;
  baseExists: boolean;
  baseContent: string;
}): { exists: boolean; content: string; sources: string[] } | null {
  const p = normalizeRelPath(args.path);
  if (!p) return null;
  const proj = useProjectStore.getState();

  let exists = Boolean(args.baseExists);
  let content = String(args.baseContent ?? "");
  const sources: string[] = [];

  const steps = useRunStore.getState().steps ?? [];
  const pending = steps.filter(
    (s: any) =>
      s &&
      typeof s === "object" &&
      s.type === "tool" &&
      s.status === "success" &&
      s.applyPolicy === "proposal" &&
      s.applied !== true &&
      s.status !== "undone" &&
      (s.toolName === "doc.write" || s.toolName === "doc.applyEdits" || s.toolName === "doc.restoreSnapshot" || s.toolName === "doc.splitToDir"),
  ) as any[];

  // 按出现顺序顺推，叠加提案（proposal-first）
  for (const st of pending) {
    if (st.toolName === "doc.restoreSnapshot") {
      const snapshotId = String(st.input?.snapshotId ?? st.output?.snapshotId ?? "").trim();
      if (!snapshotId) continue;
      const rec = proj.getSnapshot(snapshotId);
      if (!rec) continue;
      const snapFile = rec.snap.files.find((f) => normalizeRelPath(f.path) === p) ?? null;
      if (snapFile) {
        exists = true;
        content = String(snapFile.content ?? "");
        sources.push(`doc.restoreSnapshot(proposal):${st.id}`);
      } else {
        // 快照中不存在：视为该文件将被删除（仅在当前本来存在时记录）
        if (exists) sources.push(`doc.restoreSnapshot(delete ${p}):${st.id}`);
        exists = false;
        content = "";
      }
      continue;
    }

    if (st.toolName === "doc.splitToDir") {
      const proposalId = String(st.output?.proposalId ?? "").trim();
      if (!proposalId) continue;
      const f = getSplitToDirProposalFile(proposalId, p);
      if (!f) continue;
      exists = true;
      content = String(f.content ?? "");
      sources.push(`doc.splitToDir(proposal):${st.id}`);
      continue;
    }

    if (st.toolName === "doc.write") {
      const inPath = normalizeRelPath(String(st.input?.path ?? ""));
      if (inPath !== p) continue;
      const next = String(st.input?.content ?? "");
      exists = true;
      content = next;
      sources.push(`doc.write(proposal):${st.id}`);
      continue;
    }

    if (st.toolName === "doc.applyEdits") {
      const inPath = normalizeRelPath(String(st.input?.path ?? proj.activePath ?? ""));
      if (inPath !== p) continue;
      if (!exists) continue;
      const edits = Array.isArray(st.input?.edits) ? st.input.edits : null;
      if (!edits) continue;
      const norm = edits
        .map((e: any) => ({
          startLineNumber: Number(e?.startLineNumber),
          startColumn: Number(e?.startColumn),
          endLineNumber: Number(e?.endLineNumber),
          endColumn: Number(e?.endColumn),
          text: String(e?.text ?? ""),
        }))
        .filter((e: any) => [e.startLineNumber, e.startColumn, e.endLineNumber, e.endColumn].every((n: any) => Number.isFinite(n) && n > 0));
      if (!norm.length) continue;
      content = applyTextEdits({ before: content, edits: norm }).after;
      sources.push(`doc.applyEdits(proposal):${st.id}`);
      continue;
    }
  }

  if (!sources.length) return null;
  return { exists, content, sources };
}

function unifiedDiff(args: { path: string; before: string; after: string; context?: number; maxCells?: number; maxHunkLines?: number }) {
  const beforeLines = args.before.split("\n");
  const afterLines = args.after.split("\n");
  const n = beforeLines.length;
  const m = afterLines.length;

  const maxCells = args.maxCells ?? 900_000; // 约 900k cells（避免大文件卡死）
  if (n * m > maxCells) {
    return {
      truncated: true,
      diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(文件过大：diff 预览已跳过。建议先缩小改动范围或仅显示片段预览)\n`,
    };
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    const ai = beforeLines[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j += 1) {
      if (ai === afterLines[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = Math.max(prev[j], row[j - 1]);
    }
  }

  type Op = { type: " " | "+" | "-"; line: string; oldLine: number | null; newLine: number | null };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  let oldNo = n;
  let newNo = m;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      ops.push({ type: " ", line: beforeLines[i - 1], oldLine: oldNo, newLine: newNo });
      i -= 1;
      j -= 1;
      oldNo -= 1;
      newNo -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
      i -= 1;
      oldNo -= 1;
    } else {
      ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
      j -= 1;
      newNo -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
    i -= 1;
    oldNo -= 1;
  }
  while (j > 0) {
    ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
    j -= 1;
    newNo -= 1;
  }
  ops.reverse();

  // 重新赋正向行号（更易算 hunk 头）
  let o = 1;
  let nn = 1;
  const seq: Op[] = ops.map((x) => {
    const out: Op = { ...x, oldLine: null, newLine: null };
    if (x.type !== "+") out.oldLine = o;
    if (x.type !== "-") out.newLine = nn;
    if (x.type !== "+") o += 1;
    if (x.type !== "-") nn += 1;
    return out;
  });

  const context = args.context ?? 3;
  const changeIdx: number[] = [];
  for (let k = 0; k < seq.length; k += 1) if (seq[k].type !== " ") changeIdx.push(k);
  if (!changeIdx.length) {
    return {
      truncated: false,
      diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(无差异)\n`,
    };
  }

  const hunks: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos < changeIdx.length) {
    const first = changeIdx[pos];
    let start = Math.max(0, first - context);
    let end = Math.min(seq.length, first + context + 1);
    let last = first;
    while (true) {
      pos += 1;
      const next = changeIdx[pos];
      if (next === undefined) break;
      if (next <= end + context) {
        end = Math.min(seq.length, next + context + 1);
        last = next;
        continue;
      }
      // 不合并
      break;
    }
    hunks.push({ start, end });
  }

  let added = 0;
  let removed = 0;
  const maxHunkLines = args.maxHunkLines ?? 320;
  let outLines: string[] = [`--- a/${args.path}`, `+++ b/${args.path}`];
  let emitted = 0;

  for (const h of hunks) {
    const slice = seq.slice(h.start, h.end);
    const oldStart = slice.find((x) => x.oldLine !== null)?.oldLine ?? 1;
    const newStart = slice.find((x) => x.newLine !== null)?.newLine ?? 1;
    const oldCount = slice.filter((x) => x.type !== "+").length;
    const newCount = slice.filter((x) => x.type !== "-").length;
    outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const x of slice) {
      if (emitted >= maxHunkLines) {
        outLines.push("...(diff 已截断)");
        return { truncated: true, diff: outLines.join("\n") + "\n", stats: { added, removed } };
      }
      if (x.type === "+") added += 1;
      if (x.type === "-") removed += 1;
      outLines.push(`${x.type}${x.line}`);
      emitted += 1;
    }
  }

  return { truncated: false, diff: outLines.join("\n") + "\n", stats: { added, removed } };
}

type TodoStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";

function makeTodoId() {
  const anyCrypto = globalThis as any;
  const uuid = typeof anyCrypto?.crypto?.randomUUID === "function" ? anyCrypto.crypto.randomUUID() : null;
  return `todo_${uuid ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function slugifyTodoId(text: string) {
  const s = String(text ?? "").trim().toLowerCase();
  const slug = s
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .slice(0, 40);
  return slug;
}

function normalizeTodoStatus(input: unknown): TodoStatus {
  const s = String(input ?? "").trim().toLowerCase();
  if (s === "todo") return "todo";
  if (
    s === "in_progress" ||
    s === "inprogress" ||
    s === "in-progress" ||
    s === "in progress" ||
    s === "doing" ||
    s === "working" ||
    s === "wip" ||
    s.includes("进行中") ||
    s.includes("在做") ||
    s.includes("处理中")
  )
    return "in_progress";
  if (
    s === "done" ||
    s === "completed" ||
    s === "complete" ||
    s === "finish" ||
    s === "finished" ||
    s === "ok" ||
    s.includes("已完成") ||
    s.includes("完成")
  )
    return "done";
  if (s === "blocked" || s === "block" || s === "stuck" || s.includes("阻塞") || s.includes("卡住")) return "blocked";
  if (s === "skipped" || s === "skip" || s === "ignored" || s.includes("跳过")) return "skipped";
  return "todo";
}

function coerceValue(v: string): unknown {
  const raw = v;
  const s = v.trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 32) return Number(s);
  return raw;
}

function parseArgs(rawArgs: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs)) out[k] = coerceValue(v);
  return out;
}

const tools: ToolDefinition[] = [
  {
    name: "kb.search",
    description:
      "在本地知识库中检索（按库过滤、按 source_doc 分组）。默认只在右侧已关联的库里搜索。用于写作引用素材（套路卡片/段落证据）。提示：kind=outline 仅对含 Markdown 标题(#)的文档有效；想找结构套路更建议 kind=card + cardTypes=[outline]。",
    args: [
      { name: "query", required: true, desc: "搜索关键词/问题" },
      { name: "kind", desc: '可选：artifact kind（"card"|"outline"|"paragraph"），默认 card' },
      { name: "libraryIds", desc: "可选：库 ID 数组；不传则用右侧已关联库" },
      { name: "facetIds", desc: "可选：outlineFacet id 数组（多选）" },
      { name: "cardTypes", desc: "可选：仅 kind=card 时生效；限制 cardType（例如 hook/one_liner/ending/outline/thesis）" },
      { name: "anchorParagraphIndexMax", desc: "可选：只搜前 N 段（开头样例；paragraphIndex < N）" },
      { name: "anchorFromEndMax", desc: "可选：只搜距结尾 N 段内（结尾样例）" },
      { name: "debug", desc: "可选：返回检索诊断信息（默认 true）" },
      { name: "perDocTopN", desc: "每篇文档最多返回多少条命中（默认 3）" },
      { name: "topDocs", desc: "最多返回多少篇文档（默认 12）" },
      { name: "useVector", desc: "可选：是否用向量做重排（默认 true；需要 Gateway 配置 embeddings 代理）" },
      { name: "embeddingModel", desc: '可选：向量模型 ID（例如 "text-embedding-3-large" 或 "Embedding-V1"）；不传则用服务器默认' },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "EMPTY_QUERY" };
      const kindRaw = String(args.kind ?? "card").trim();
      const kind = (kindRaw === "outline" || kindRaw === "paragraph" || kindRaw === "card" ? kindRaw : "card") as any;
      const facetIds = Array.isArray(args.facetIds) ? (args.facetIds as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const cardTypes = Array.isArray(args.cardTypes) ? (args.cardTypes as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const anchorParagraphIndexMax = typeof args.anchorParagraphIndexMax === "number" ? Math.max(0, Math.floor(args.anchorParagraphIndexMax)) : undefined;
      const anchorFromEndMax = typeof args.anchorFromEndMax === "number" ? Math.max(0, Math.floor(args.anchorFromEndMax)) : undefined;
      const debug = args.debug === undefined ? true : Boolean(args.debug);
      const perDocTopN = typeof args.perDocTopN === "number" ? Math.max(1, Math.floor(args.perDocTopN)) : 3;
      const topDocs = typeof args.topDocs === "number" ? Math.max(1, Math.floor(args.topDocs)) : 12;
      const useVector = args.useVector === undefined ? true : Boolean(args.useVector);
      const embeddingModel = String(args.embeddingModel ?? "").trim() || undefined;
      const explicitLibs = Array.isArray(args.libraryIds) ? (args.libraryIds as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
      const libraryIds = explicitLibs.length ? explicitLibs : attached;
      if (!libraryIds.length) return { ok: false, error: "NO_LIBRARY_SELECTED" };

      const ret = await useKbStore.getState().searchForAgent({ query, kind, facetIds, cardTypes, anchorParagraphIndexMax, anchorFromEndMax, debug, libraryIds, perDocTopN, topDocs, useVector, embeddingModel });
      if (!ret.ok) return { ok: false, error: ret.error ?? "SEARCH_FAILED" };

      // 输出精简：按文档分组
      const groups = (ret.groups ?? []).map((g) => ({
        sourceDoc: g.sourceDoc,
        bestScore: g.bestScore,
        hits: g.hits.map((h) => ({
          score: h.score,
          snippet: h.snippet,
          artifact: {
            id: h.artifact.id,
            kind: h.artifact.kind,
            title: h.artifact.title,
            cardType: (h.artifact as any).cardType,
            facetIds: h.artifact.facetIds ?? [],
            anchor: h.artifact.anchor,
            // 注意：不返回全文 content，避免 token 爆炸；需要全文由 doc.read / kb 引用机制后续完善
          },
        })),
      }));

      return { ok: true, output: { ok: true, query, kind, libraryIds, useVector, embeddingModel: embeddingModel ?? null, groups, debug: (ret as any).debug ?? null }, undoable: false };
    },
  },

  {
    name: "kb.cite",
    description:
      "从本地知识库按定位精确取一段原文证据（用于引用/脚注/审计）。通常先 kb.search 拿到候选，再用 kb.cite 拉取命中条目的原文段（避免 kb.search 返回全文导致 token 爆炸）。",
    args: [
      { name: "sourceDocId", required: true, desc: "源文档 ID（kb_doc_*）" },
      {
        name: "anchor",
        required: false,
        desc: '可选：定位锚点（推荐）：{kind:"artifactId",artifactId} | {kind:"paragraph",paragraphIndex} | {kind:"headingPath",headingPath}。与文档开工 spec 对齐。',
      },
      // 兼容旧入参（v0.1 已上车的扁平参数）
      { name: "artifactId", required: false, desc: "兼容：artifact id（优先；从 kb.search 命中里取）" },
      { name: "paragraphIndex", required: false, desc: "兼容：段落索引（仅对 paragraph 有效）" },
      { name: "headingPath", required: false, desc: '兼容：标题路径（数组或 "A > B" 字符串；将返回该标题下第一段）' },
      { name: "maxChars", required: false, desc: "可选：返回内容最大字符数（默认 1000，最大 4000）" },
      { name: "quoteMaxChars", required: false, desc: "可选：quote 预览最大字符数（默认 200）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const sourceDocId = String((args as any).sourceDocId ?? "").trim();
      if (!sourceDocId) return { ok: false, error: "DOC_ID_REQUIRED" };

      const anchorRaw = (args as any).anchor;
      const anchorKind = String(anchorRaw?.kind ?? "").trim();
      const anchorArtifactId =
        anchorKind === "artifactId" ? String(anchorRaw?.artifactId ?? "").trim() : anchorKind === "artifact" ? String(anchorRaw?.id ?? "").trim() : "";
      const anchorParagraphIndexRaw = anchorKind === "paragraph" ? anchorRaw?.paragraphIndex : anchorRaw?.index;
      const anchorHeadingPath = anchorKind === "headingPath" ? anchorRaw?.headingPath : anchorRaw?.path;

      const artifactId =
        (anchorArtifactId ? anchorArtifactId : String((args as any).artifactId ?? "").trim()) || undefined;
      const paragraphIndexRaw = anchorArtifactId ? undefined : anchorParagraphIndexRaw ?? (args as any).paragraphIndex;
      const paragraphIndexNum = Number(paragraphIndexRaw);
      const paragraphIndex = Number.isFinite(paragraphIndexNum) ? Math.max(0, Math.floor(paragraphIndexNum)) : undefined;
      const headingPath = anchorHeadingPath ?? (args as any).headingPath;

      const maxCharsRaw = (args as any).maxChars;
      const quoteMaxCharsRaw = (args as any).quoteMaxChars;
      const maxCharsNum = Number(maxCharsRaw);
      const quoteMaxCharsNum = Number(quoteMaxCharsRaw);
      const maxChars = Number.isFinite(maxCharsNum) ? Math.max(200, Math.min(4000, Math.floor(maxCharsNum))) : undefined;
      const quoteMaxChars = Number.isFinite(quoteMaxCharsNum) ? Math.max(40, Math.min(400, Math.floor(quoteMaxCharsNum))) : undefined;

      const ret = await useKbStore.getState().citeForAgent({ sourceDocId, artifactId, paragraphIndex, headingPath, maxChars, quoteMaxChars });
      if (!ret.ok) return { ok: false, error: ret.error ?? "CITE_FAILED" };
      return { ok: true, output: { ok: true, title: ret.title ?? null, ref: ret.ref ?? null, content: ret.content ?? "" }, undoable: false };
    },
  },

  {
    name: "lint.copy",
    description:
      "Copy Linter：确定性检测“贴原文/复用风险”。用于仿写/改写闭环中的 anti-regurgitation 阶段闸门（本地计算，不调用上游模型）。",
    args: [
      { name: "text", required: false, desc: "要检查的候选稿文本（text/path 二选一必填）" },
      { name: "path", required: false, desc: "要检查的文件路径（text/path 二选一必填；会优先读取提案态内容）" },
      { name: "libraryIds", required: false, desc: "可选：风格库 ID 数组；不传则默认使用右侧已绑定的风格库（purpose=style）" },
      { name: "maxSources", required: false, desc: "可选：最多使用多少条对照源（默认 14；包含编辑器选区 + 少量风格样例）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const textArg = typeof args.text === "string" ? String(args.text) : "";
      const pathArg = typeof args.path === "string" ? String(args.path) : "";
      if (!textArg && !pathArg) return { ok: false, error: "MISSING_TEXT_OR_PATH" };

      const draftText = await (async () => {
        if (textArg) return textArg;
        const p0 = normalizeRelPath(pathArg);
        if (!p0) return "";
        const proj = useProjectStore.getState();
        const file = proj.getFileByPath(p0);
        const disk = file ? await proj.ensureLoaded(file.path).catch(() => file.content ?? "") : "";
        const virt = getVirtualFileContentFromPendingProposals({ path: p0, baseExists: Boolean(file), baseContent: disk ?? "" });
        if (virt && virt.exists) return virt.content;
        return disk ?? "";
      })();
      if (!draftText.trim()) return { ok: false, error: "EMPTY_DRAFT" };

      // 选择风格库（优先 purpose=style；用于取少量样例作为对照源）
      const explicitLibs = Array.isArray(args.libraryIds) ? (args.libraryIds as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const sidecar = await buildStyleLinterLibrariesSidecar({ libraryIds: explicitLibs, maxLibraries: 6 }).catch(() => ({ ok: false } as any));
      if (!sidecar?.ok) return { ok: false, error: "NO_LIBRARY_SELECTED" };
      const libraryIds = sidecar.libraryIds ?? [];

      const librariesPayload: any[] = Array.isArray(sidecar.libraries) ? sidecar.libraries : [];
      const styleSamples = librariesPayload.flatMap((l: any) => (Array.isArray(l?.samples) ? l.samples : [])).slice(0, 24);

      const selectionText = (() => {
        const proj = useProjectStore.getState();
        const ed = proj.editorRef;
        const model = ed?.getModel?.();
        const sel = ed?.getSelection?.();
        if (!ed || !model || !sel) return "";
        const t = String(model.getValueInRange(sel) ?? "");
        return t.trim() ? t : "";
      })();

      const maxSources = typeof args.maxSources === "number" ? Math.max(4, Math.min(24, Math.floor(args.maxSources))) : 14;
      // anchors（优先）：来自 Main Doc 的 styleContractV1（可追溯的小引用，<=200字），比“段落样例池”更贴近 V2 的证据位定义
      const anchorSamples = (() => {
        const main: any = useRunStore.getState().mainDoc ?? {};
        const contract: any = main?.styleContractV1 ?? null;
        const anchors = Array.isArray(contract?.anchors) ? contract.anchors : [];
        const quotes = anchors
          .map((a: any) => String(a?.quote ?? "").trim())
          .filter(Boolean)
          .map((q: string) => (q.length > 200 ? q.slice(0, 200) : q));
        const uniq: string[] = [];
        for (const q of quotes) if (!uniq.includes(q)) uniq.push(q);
        return uniq.slice(0, 8).map((text) => ({ text }));
      })();

      // computeCopyRiskObserve 内部会控量 sources；这里通过裁剪样例进一步避免计算成本膨胀
      const combinedSamples = [...anchorSamples, ...styleSamples].slice(0, 24);
      const samplesForCopy = Array.isArray(combinedSamples) ? combinedSamples.slice(0, Math.max(0, Math.min(24, maxSources))) : [];

      const copyRisk = computeCopyRiskObserve({ draftText, styleSamples: samplesForCopy, selectionText });
      const riskLevel = String((copyRisk as any)?.riskLevel ?? "").trim().toLowerCase();
      const passed = riskLevel === "low";

      return {
        ok: true,
        output: {
          ok: true,
          mode: "gate",
          v: 1,
          passed,
          riskLevel: passed ? "low" : (riskLevel === "high" ? "high" : "medium"),
          maxOverlapChars: (copyRisk as any)?.maxOverlapChars ?? 0,
          maxChar5gramJaccard: (copyRisk as any)?.maxChar5gramJaccard ?? 0,
          sources: (copyRisk as any)?.sources ?? null,
          topOverlaps: Array.isArray((copyRisk as any)?.topOverlaps) ? (copyRisk as any)?.topOverlaps : [],
          libraryIds,
        },
        undoable: false,
      };
    },
  },

  {
    name: "lint.style",
    description:
      "风格 Linter：对照已绑定的风格库（purpose=style）的统计指纹/口癖/样例，找出候选稿“不像点”，并给出 rewritePrompt。",
    args: [
      { name: "text", required: false, desc: "要检查的候选稿文本（text/path 二选一必填）" },
      { name: "path", required: false, desc: "要检查的文件路径（text/path 二选一必填；会优先读取提案态内容）" },
      { name: "libraryIds", required: false, desc: "可选：风格库 ID 数组；不传则默认使用右侧已绑定的风格库（purpose=style）" },
      { name: "model", required: false, desc: "可选：用于 linter 的模型（默认用服务端 LLM_LINTER_MODEL/LLM_CARD_MODEL）" },
      { name: "maxIssues", required: false, desc: "可选：最多返回多少条“不像点”（默认 10）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const textArg = typeof args.text === "string" ? String(args.text) : "";
      const pathArg = typeof args.path === "string" ? String(args.path) : "";
      if (!textArg && !pathArg) return { ok: false, error: "MISSING_TEXT_OR_PATH" };
      if (!requireLoginForTool("风格 Linter（lint.style）").ok) return { ok: false, error: "AUTH_REQUIRED" };

      const draftText = await (async () => {
        if (textArg) return textArg;
        const p0 = normalizeRelPath(pathArg);
        if (!p0) return "";
        const proj = useProjectStore.getState();
        const file = proj.getFileByPath(p0);
        const disk = file ? await proj.ensureLoaded(file.path).catch(() => file.content ?? "") : "";
        const virt = getVirtualFileContentFromPendingProposals({ path: p0, baseExists: Boolean(file), baseContent: disk ?? "" });
        if (virt && virt.exists) return virt.content;
        return disk ?? "";
      })();

      if (!draftText.trim()) return { ok: false, error: "EMPTY_DRAFT" };

      // 选择风格库（优先 purpose=style）
      const explicitLibs = Array.isArray(args.libraryIds) ? (args.libraryIds as any[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      const sidecar = await buildStyleLinterLibrariesSidecar({ libraryIds: explicitLibs, maxLibraries: 6 }).catch(() => ({ ok: false } as any));
      if (!sidecar?.ok) return { ok: false, error: "NO_LIBRARY_SELECTED" };
      const libraryIds = sidecar.libraryIds ?? [];

      const base = gatewayBaseUrl();
      const url = base ? `${base}/api/kb/dev/lint_style` : "/api/kb/dev/lint_style";

      const draftFp = computeDraftStats(draftText);
      const librariesPayload: any[] = Array.isArray(sidecar.libraries) ? sidecar.libraries : [];
      const styleSamples = librariesPayload.flatMap((l: any) => (Array.isArray(l?.samples) ? l.samples : [])).slice(0, 24);
      const selectionText = (() => {
        const proj = useProjectStore.getState();
        const ed = proj.editorRef;
        const model = ed?.getModel?.();
        const sel = ed?.getSelection?.();
        if (!ed || !model || !sel) return "";
        const t = String(model.getValueInRange(sel) ?? "");
        return t.trim() ? t : "";
      })();
      const copyRisk = computeCopyRiskObserve({ draftText, styleSamples, selectionText });

      const model = typeof args.model === "string" ? String(args.model).trim() : "";
      const maxIssues = typeof args.maxIssues === "number" ? Math.max(3, Math.min(24, Math.floor(args.maxIssues))) : 10;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader() },
          body: JSON.stringify({
            model: model || undefined,
            maxIssues,
            draft: { text: draftText, chars: draftFp.chars, sentences: draftFp.sentences, stats: draftFp.stats },
            libraries: librariesPayload,
          }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = json?.error ? String(json.error) : `HTTP_${res.status}`;
          const hint = json?.hint ? String(json.hint) : "";
          const detail = json?.message ? String(json.message) : json?.detail ? String(json.detail) : "";
          return { ok: false, error: hint ? `${msg}: ${hint}` : msg, output: { ok: false, msg, hint, detail, copyRisk } };
        }
        return { ok: true, output: { ok: true, ...(json ?? {}), libraryIds, copyRisk }, undoable: false };
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        return { ok: false, error: `LINTER_FETCH_FAILED:${msg}` };
      }
    },
  },
  {
    name: "project.listFiles",
    description: "列出当前项目内存文件列表（path）。需要知道可用文件时使用。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const files = useProjectStore.getState().files.map((f) => ({ path: f.path }));
      return { ok: true, output: { ok: true, files }, undoable: false };
    },
  },
  {
    name: "project.search",
    description:
      "在当前项目中搜索文本（跨文件）。默认扫描项目内可见的文本文件（如 .md/.mdx/.txt）。可用 paths 限定范围。",
    args: [
      { name: "query", required: true, desc: "搜索关键字（或正则表达式文本）" },
      { name: "useRegex", required: false, desc: "可选：是否按正则搜索（默认 false）" },
      { name: "caseSensitive", required: false, desc: "可选：是否大小写敏感（默认 false）" },
      { name: "paths", required: false, desc: "可选：限制搜索范围（JSON 数组：文件路径或目录前缀）" },
      { name: "maxResults", required: false, desc: "可选：最多返回多少条命中（默认 80，最大 500）" },
      { name: "maxPerFile", required: false, desc: "可选：每个文件最多返回多少条命中（默认 20，最大 200）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "EMPTY_QUERY" };

      const useRegex = Boolean(args.useRegex);
      const caseSensitive = Boolean(args.caseSensitive);
      const maxResults = typeof args.maxResults === "number" ? Math.max(1, Math.min(500, Math.floor(args.maxResults))) : 80;
      const maxPerFile = typeof args.maxPerFile === "number" ? Math.max(1, Math.min(200, Math.floor(args.maxPerFile))) : 20;

      const normalizeP = (p: string) =>
        String(p ?? "")
          .trim()
          .replaceAll("\\", "/")
          .replace(/^\.\//, "")
          .replace(/\/+/g, "/");

      const scopeRaw = Array.isArray(args.paths) ? (args.paths as any[]).map((x) => normalizeP(String(x ?? ""))).filter(Boolean) : [];
      const scope = scopeRaw.slice(0, 50);

      const inScope = (filePath: string) => {
        if (!scope.length) return true;
        const fp = normalizeP(filePath);
        for (const raw of scope) {
          const s = normalizeP(raw);
          if (!s) continue;
          const s0 = s.replace(/\/+$/g, "");
          if (fp === s0) return true; // exact
          if (fp.startsWith(s0 + "/")) return true; // treat as dir prefix
        }
        return false;
      };

      let re: RegExp | null = null;
      if (useRegex) {
        try {
          re = new RegExp(query, caseSensitive ? "g" : "gi");
        } catch (e: any) {
          return { ok: false, error: `INVALID_REGEX:${String(e?.message ?? e)}` };
        }
      }

      const proj = useProjectStore.getState();
      const files = proj.files.filter((f) => inScope(f.path));

      const hits: Array<{ path: string; line: number; col: number; match: string; preview: string }> = [];
      const filesWithHits = new Set<string>();
      let truncated = false;

      for (const f of files) {
        if (hits.length >= maxResults) {
          truncated = true;
          break;
        }
        const content = await proj.ensureLoaded(f.path).catch(() => f.content ?? "");
        const lines = String(content ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
        let perFile = 0;

        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= maxResults) {
            truncated = true;
            break;
          }
          if (perFile >= maxPerFile) break;

          const lineText = lines[i] ?? "";
          if (!lineText) continue;

          if (!useRegex) {
            const hay = caseSensitive ? lineText : lineText.toLowerCase();
            const needle = caseSensitive ? query : query.toLowerCase();
            let idx = hay.indexOf(needle);
            while (idx >= 0) {
              filesWithHits.add(f.path);
              hits.push({
                path: f.path,
                line: i + 1,
                col: idx + 1,
                match: lineText.slice(idx, idx + needle.length),
                preview: lineText.length > 260 ? lineText.slice(0, 260) + "…" : lineText,
              });
              perFile += 1;
              if (hits.length >= maxResults) {
                truncated = true;
                break;
              }
              if (perFile >= maxPerFile) break;
              idx = hay.indexOf(needle, idx + Math.max(1, needle.length));
            }
          } else if (re) {
            // 每行重置 regex 状态，避免跨行污染 lastIndex
            re.lastIndex = 0;
            let m: RegExpExecArray | null = null;
            while ((m = re.exec(lineText)) !== null) {
              const start = typeof m.index === "number" ? m.index : 0;
              const matched = String(m[0] ?? "");
              if (!matched) {
                // 防止 zero-length match 死循环
                re.lastIndex = start + 1;
                continue;
              }
              filesWithHits.add(f.path);
              hits.push({
                path: f.path,
                line: i + 1,
                col: start + 1,
                match: matched,
                preview: lineText.length > 260 ? lineText.slice(0, 260) + "…" : lineText,
              });
              perFile += 1;
              if (hits.length >= maxResults) {
                truncated = true;
                break;
              }
              if (perFile >= maxPerFile) break;
              // continue loop; global regex will advance lastIndex
            }
          }
        }
      }

      return {
        ok: true,
        output: {
          ok: true,
          query,
          useRegex,
          caseSensitive,
          scope,
          hitsCount: hits.length,
          filesCount: filesWithHits.size,
          truncated,
          hits,
        },
        undoable: false,
      };
    },
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。写作风格/禁用项等约束在这里。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const s = useProjectStore.getState();
      const file = s.getFileByPath("doc.rules.md");
      if (!file) return { ok: false, error: "DOC_RULES_NOT_FOUND" };
      const content = await s.ensureLoaded(file.path);
      return { ok: true, output: { ok: true, path: file.path, content }, undoable: false };
    },
  },
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const mainDoc = useRunStore.getState().mainDoc;
      return { ok: true, output: { ok: true, mainDoc }, undoable: false };
    },
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。仅写关键决策/约束，不要塞长文本。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const patch = args.patch;
      if (!patch || typeof patch !== "object") return { ok: false, error: "INVALID_PATCH" };
      const { undo } = useRunStore.getState().updateMainDoc(patch as any);
      const mainDoc = useRunStore.getState().mainDoc;
      return { ok: true, output: { ok: true, mainDoc }, undoable: true, undo };
    },
  },
  {
    name: "run.setTodoList",
    description:
      "设置本次 Run 的 Todo List（用于进度追踪与防跑偏）。建议在澄清后立刻调用一次，并在执行过程中用 run.todo.update（推荐）或 run.updateTodo 更新状态。",
    args: [{ name: "items", required: true, desc: 'JSON 数组：TodoItem[]（{ id?, text, status?, note? }）' }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const items = args.items as any;
      if (!Array.isArray(items)) return { ok: false, error: "INVALID_ITEMS" };

      const used = new Set<string>();
      const norm = items
        .map((x: any, idx: number) => {
          const text = String(x?.text ?? "").trim();
          if (!text) return null;

          let id = String(x?.id ?? "").trim();
          if (!id) id = slugifyTodoId(text) || `t${idx + 1}`;
          id = id.replaceAll(" ", "_");
          const base = id;
          let n = 2;
          while (used.has(id)) id = `${base}_${n++}`;
          used.add(id);

          return {
            id,
            text,
            status: normalizeTodoStatus(x?.status),
            note: x?.note === undefined ? undefined : String(x.note ?? ""),
          };
        })
        .filter(Boolean);

      const { undo } = useRunStore.getState().setTodoList(norm as any);
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.updateTodo",
    description: "更新某一条 Todo 的状态/备注（用于记录进度）。",
    args: [
      { name: "id", required: false, desc: "Todo ID（来自 run.setTodoList 的返回）。若当前仅有 1 条 todo，可省略。" },
      { name: "patch", required: true, desc: "JSON 对象：{ status?, note?, text? }" },
    ],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const patch = args.patch as any;
      if (!patch || typeof patch !== "object") return { ok: false, error: "INVALID_PATCH" };

      const s = useRunStore.getState();
      const cur = s.todoList ?? [];

      let id = String(args.id ?? "").trim();
      if (!id) {
        if (cur.length === 1 && cur[0]?.id) id = String(cur[0].id);
        else {
          return {
            ok: false,
            error: "MISSING_ID",
            output: {
              ok: false,
              error: "MISSING_ID",
              hint: cur.length === 0 ? "当前 todoList 为空，请先 run.setTodoList。" : "请传入 todo.id；或确保 todoList 只有 1 条后再省略 id。",
              available: cur.map((t: any) => ({ id: t.id, text: t.text, status: t.status })),
            },
          };
        }
      }
      const findIdx = (needle: string) =>
        cur.findIndex((t: any) => String(t?.id ?? "") === needle);
      let foundId = id;
      let idx = findIdx(foundId);
      if (idx < 0) {
        const alt = id.replaceAll("-", "_");
        idx = findIdx(alt);
        if (idx >= 0) foundId = alt;
      }
      if (idx < 0) {
        return {
          ok: false,
          error: "TODO_NOT_FOUND",
          output: {
            ok: false,
            error: "TODO_NOT_FOUND",
            hint: "请使用 run.setTodoList 返回的 todo.id；或先重新 setTodoList。",
            available: cur.map((t: any) => ({ id: t.id, text: t.text, status: t.status })),
          },
        };
      }

      const nextPatch: any = {};
      if (patch.text !== undefined) nextPatch.text = String(patch.text ?? "");
      if (patch.status !== undefined) nextPatch.status = normalizeTodoStatus(patch.status);
      if (patch.note !== undefined) nextPatch.note = String(patch.note ?? "");

      const { undo } = s.updateTodo(foundId, nextPatch);
      // 注意：Zustand 的 getState() 返回的是“快照”，上面的 updateTodo 会通过 set 更新 store；
      // 这里必须重新读取一次最新 state，否则返回值可能还是更新前的 todoList，导致 UI 误判“没更新/没跑到”。
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.todo.upsertMany",
    description:
      "批量 upsert Todo（新增或更新）。\n" +
      "- 若 id 命中现有：按提供字段 patch（未提供的不改）。\n" +
      "- 若 id 不命中或未传 id：视为新增（需要 text），自动生成稳定 id 并追加到列表末尾。\n" +
      "用于避免模型反复 run.setTodoList 覆盖进度。",
    args: [
      {
        name: "items",
        required: true,
        desc: 'JSON 数组：Array<{ id?: string; text?: string; status?: "todo"|"in_progress"|"done"|"blocked"|"skipped"; note?: string }>',
      },
    ],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const items = (args as any).items as any;
      if (!Array.isArray(items)) return { ok: false, error: "INVALID_ITEMS" };

      const s = useRunStore.getState();
      const prev = Array.isArray(s.todoList) ? s.todoList : [];
      const used = new Set<string>(prev.map((t: any) => String(t?.id ?? "").trim()).filter(Boolean));
      let next = prev.slice();

      const findIdx = (needle: string) => next.findIndex((t: any) => String(t?.id ?? "") === needle);

      for (const x of items.slice(0, 80)) {
        if (!x || typeof x !== "object") continue;

        const idRaw = String((x as any).id ?? "").trim();
        const textRaw = (x as any).text === undefined ? undefined : String((x as any).text ?? "").trim();
        const statusRaw = (x as any).status === undefined ? undefined : normalizeTodoStatus((x as any).status);
        const noteRaw = (x as any).note === undefined ? undefined : String((x as any).note ?? "");

        if (idRaw) {
          const idx = findIdx(idRaw);
          if (idx >= 0) {
            const cur = next[idx] as any;
            const patched: any = { ...cur, id: cur.id };
            if (textRaw !== undefined && textRaw) patched.text = textRaw;
            if (statusRaw !== undefined) patched.status = statusRaw;
            if (noteRaw !== undefined) patched.note = noteRaw;
            next[idx] = patched;
            continue;
          }

          // 新增：id 不命中
          if (!textRaw) {
            return {
              ok: false,
              error: "MISSING_TEXT_FOR_NEW_TODO",
              output: {
                ok: false,
                error: "MISSING_TEXT_FOR_NEW_TODO",
                hint: "当 id 不命中现有 todo 时，视为新增；请同时提供 text。",
                id: idRaw,
              },
            };
          }
          let id = idRaw.replaceAll(" ", "_");
          const base = id;
          let n = 2;
          while (used.has(id)) id = `${base}_${n++}`;
          used.add(id);
          next.push({ id, text: textRaw, status: statusRaw ?? "todo", note: noteRaw });
          continue;
        }

        // 新增：未传 id
        if (!textRaw) continue;
        let id = slugifyTodoId(textRaw) || `t${next.length + 1}`;
        id = id.replaceAll(" ", "_");
        const base = id;
        let n = 2;
        while (used.has(id)) id = `${base}_${n++}`;
        used.add(id);
        next.push({ id, text: textRaw, status: statusRaw ?? "todo", note: noteRaw });
      }

      // cap：避免 todoList 过长
      const cap = 120;
      if (next.length > cap) next = next.slice(next.length - cap);

      const { undo } = useRunStore.getState().setTodoList(next as any);
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.todo.update",
    description:
      "更新某一条 Todo（扁平参数版，LLM 更不容易漏 patch）。\n" +
      "- 当 todoList 只有 1 条时可省略 id；否则必须传 id。",
    args: [
      { name: "id", required: false, desc: "Todo ID（可省略：仅当当前 todoList 只有 1 条）" },
      { name: "text", required: false, desc: "可选：更新文本" },
      { name: "status", required: false, desc: '可选：状态（"todo"|"in_progress"|"done"|"blocked"|"skipped"）' },
      { name: "note", required: false, desc: "可选：备注/阻塞原因" },
    ],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const s = useRunStore.getState();
      const cur = s.todoList ?? [];

      let id = String((args as any).id ?? "").trim();
      if (!id) {
        if (cur.length === 1 && cur[0]?.id) id = String(cur[0].id);
        else {
          return {
            ok: false,
            error: "MISSING_ID",
            output: {
              ok: false,
              error: "MISSING_ID",
              hint: cur.length === 0 ? "当前 todoList 为空，请先 run.setTodoList。" : "请传入 todo.id；或确保 todoList 只有 1 条后再省略 id。",
              available: cur.map((t: any) => ({ id: t.id, text: t.text, status: t.status })),
            },
          };
        }
      }
      const findIdx = (needle: string) => cur.findIndex((t: any) => String(t?.id ?? "") === needle);
      let foundId = id;
      let idx = findIdx(foundId);
      if (idx < 0) {
        const alt = id.replaceAll("-", "_");
        idx = findIdx(alt);
        if (idx >= 0) foundId = alt;
      }
      if (idx < 0) {
        return {
          ok: false,
          error: "TODO_NOT_FOUND",
          output: {
            ok: false,
            error: "TODO_NOT_FOUND",
            hint: "请使用现有 todo.id；或先 run.setTodoList / run.todo.upsertMany。",
            available: cur.map((t: any) => ({ id: t.id, text: t.text, status: t.status })),
          },
        };
      }

      const nextPatch: any = {};
      if ((args as any).text !== undefined) nextPatch.text = String((args as any).text ?? "");
      if ((args as any).status !== undefined) nextPatch.status = normalizeTodoStatus((args as any).status);
      if ((args as any).note !== undefined) nextPatch.note = String((args as any).note ?? "");

      const { undo } = s.updateTodo(foundId, nextPatch);
      // 同 run.updateTodo：返回最新 todoList（避免返回更新前快照）
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.todo.remove",
    description: "删除一条 Todo（按 id）。",
    args: [{ name: "id", required: true, desc: "Todo ID" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const id = String((args as any).id ?? "").trim();
      if (!id) return { ok: false, error: "MISSING_ID" };
      const s = useRunStore.getState();
      const prev = s.todoList ?? [];
      const next = prev.filter((t: any) => String(t?.id ?? "") !== id);
      const { undo } = s.setTodoList(next as any);
      // 注意：Zustand 的 state 对象不是“可变引用”，不能从旧 state 读新值
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.todo.clear",
    description: "清空本次 Run 的 Todo List。",
    args: [],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async () => {
      const s = useRunStore.getState();
      const { undo } = s.setTodoList([] as any);
      // 注意：Zustand 的 state 对象不是“可变引用”，不能从旧 state 读新值
      const todoList = useRunStore.getState().todoList;
      return { ok: true, output: { ok: true, todoList }, undoable: true, undo };
    },
  },
  {
    name: "run.done",
    description:
      "显式结束本次 Run（让系统立刻停机，而不是继续多跑一轮总结/补充）。\n" +
      "注意：实际终止由 Gateway 执行；本地仅返回 ok 作为兼容（避免旧网关/本地执行分支报错）。",
    args: [{ name: "note", required: false, desc: "可选：完成口径/选取策略的简短备注（<=200字）" }],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const note = String((args as any)?.note ?? "").trim();
      return { ok: true, output: { ok: true, note: note.slice(0, 200) }, undoable: false };
    },
  },
  {
    name: "doc.read",
    description: "读取文件内容（path）。需要基于现有文稿/规则做改写时使用。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）" }],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const path = normalizeRelPath(String(args.path ?? ""));
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const s = useProjectStore.getState();
      const file = s.getFileByPath(path);
      const diskContent = file ? await s.ensureLoaded(file.path) : "";
      const virt = getVirtualFileContentFromPendingProposals({ path, baseExists: Boolean(file), baseContent: diskContent });
      if (!file && (!virt || !virt.exists)) return { ok: false, error: "FILE_NOT_FOUND" };
      if (virt && !virt.exists) return { ok: false, error: "FILE_NOT_FOUND" };
      const content = virt && virt.exists ? virt.content : diskContent;
      return {
        ok: true,
        output: {
          ok: true,
          path,
          content,
          virtualFromProposal: Boolean(virt),
          proposalSources: virt?.sources ?? [],
        },
        undoable: false,
      };
    },
  },
  {
    name: "doc.mkdir",
    description: "创建目录（path）。用于新建文件夹/目录结构。",
    args: [{ name: "path", required: true, desc: "目录路径（如 drafts/ 或 assets/images/）" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const dir = normalizeRelPath(String(args.path ?? ""));
      if (!dir) return { ok: false, error: "MISSING_PATH" };
      const snap = useProjectStore.getState().snapshot();
      const s = useProjectStore.getState();
      await s.mkdir(dir);
      // 目录的“严格 Undo”：回到执行前快照（避免误删到其它同时创建的文件）
      const undo = () => useProjectStore.getState().restore(snap);
      return { ok: true, output: { ok: true, path: dir }, undoable: true, undo };
    },
  },
  {
    name: "doc.renamePath",
    description: "重命名/移动 文件或目录（fromPath → toPath）。默认自动执行（可 Undo 回滚）。",
    args: [
      { name: "fromPath", required: true, desc: "源路径（文件或目录）" },
      { name: "toPath", required: true, desc: "目标路径（文件或目录）" },
    ],
    riskLevel: "medium",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const fromPath = normalizeRelPath(String((args as any).fromPath ?? ""));
      const toPath = normalizeRelPath(String((args as any).toPath ?? ""));
      if (!fromPath) return { ok: false, error: "MISSING_FROM_PATH" };
      if (!toPath) return { ok: false, error: "MISSING_TO_PATH" };

      const proj = useProjectStore.getState();
      const isFile = !!proj.files.find((f) => f.path === fromPath);
      const isDir = proj.dirs.includes(fromPath);
      if (!isFile && !isDir) return { ok: false, error: "PATH_NOT_FOUND" };

      const previewMappings = (() => {
        if (isFile) return [{ from: fromPath, to: toPath }];
        const prefix = `${fromPath}/`;
        const out = proj.files
          .filter((f) => f.path === fromPath || f.path.startsWith(prefix))
          .map((f) => ({ from: f.path, to: toPath + f.path.slice(fromPath.length) }));
        return out.slice(0, 50);
      })();
      const filesCount = (() => {
        if (isFile) return 1;
        const prefix = `${fromPath}/`;
        return proj.files.filter((f) => f.path === fromPath || f.path.startsWith(prefix)).length;
      })();

      const snap = useProjectStore.getState().snapshot();
      const r = await useProjectStore.getState().renamePath(fromPath, toPath);
      if (!r.ok) return { ok: false, error: r.error ?? "RENAME_FAILED", detail: r.detail };
      const undo = () => useProjectStore.getState().restore(snap);
      return {
        ok: true,
        output: {
          ok: true,
          fromPath,
          toPath,
          kind: isFile ? "file" : "dir",
          filesCount,
          previewMappings,
          note: "已执行重命名/移动（可 Undo 回滚）。",
        },
        riskLevel: "medium",
        applyPolicy: "auto_apply",
        undoable: true,
        undo,
      };
    },
  },
  {
    name: "doc.deletePath",
    description: "删除文件或目录（path）。真删磁盘内容；默认自动执行（可 Undo 回滚）。",
    args: [{ name: "path", required: true, desc: "文件或目录路径" }],
    riskLevel: "high",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const path0 = normalizeRelPath(String(args.path ?? ""));
      if (!path0) return { ok: false, error: "MISSING_PATH" };
      const proj = useProjectStore.getState();
      const isFile = !!proj.files.find((f) => f.path === path0);
      const isDir = proj.dirs.includes(path0);
      if (!isFile && !isDir) return { ok: false, error: "PATH_NOT_FOUND" };

      const affectedFiles = (() => {
        if (isFile) return [path0];
        const prefix = `${path0}/`;
        return proj.files.filter((f) => f.path === path0 || f.path.startsWith(prefix)).map((f) => f.path);
      })();
      const filesCount = affectedFiles.length;
      const previewFiles = affectedFiles.slice(0, 30);

      const preview = (() => {
        if (!isFile) return null;
        // 删除文件：用 diff 表达“内容 -> 空”
        return (async () => {
          const f = proj.getFileByPath(path0);
          const before = f ? await proj.ensureLoaded(f.path).catch(() => f.content ?? "") : "";
          const d = unifiedDiff({ path: path0, before, after: "" });
          return { diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null };
        })();
      })();

      const previewResolved = preview ? await preview.catch(() => null) : null;

      const snap = useProjectStore.getState().snapshot();
      await useProjectStore.getState().deletePath(path0);
      const undo = () => useProjectStore.getState().restore(snap);

      return {
        ok: true,
        output: {
          ok: true,
          path: path0,
          kind: isFile ? "file" : "dir",
          filesCount,
          previewFiles,
          ...(previewResolved ? { preview: previewResolved } : {}),
          note: "已执行删除（可 Undo 回滚）。",
        },
        riskLevel: "high",
        applyPolicy: "auto_apply",
        undoable: true,
        undo,
      };
    },
  },
  {
    name: "doc.previewDiff",
    description:
      "生成 diff 预览（无副作用）。可以传入 newContent 或 edits；系统会和当前文件内容比较并返回 unified diff 文本。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "newContent", required: false, desc: "新内容全文（JSON 字符串）" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]（同 doc.applyEdits）" },
      { name: "ifExists", required: false, desc: "当文件已存在时的策略：rename(默认)/overwrite/error" },
      { name: "suggestedName", required: false, desc: "建议的新文件名（仅 ifExists=rename 时使用）" },
    ],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async (args) => {
      const pathRaw = normalizeRelPath(String(args.path ?? ""));
      if (!pathRaw) return { ok: false, error: "MISSING_PATH" };
      const s = useProjectStore.getState();
      const file = s.getFileByPath(pathRaw);
      // 允许预览“新文件写入”（file 不存在时 before 视为空字符串）
      const before = file ? await s.ensureLoaded(file.path) : "";
      const newContent = typeof args.newContent === "string" ? String(args.newContent) : undefined;
      const edits = args.edits as any;
      let after = newContent ?? before;
      if (!newContent && Array.isArray(edits) && edits.length) {
        const norm = edits.map((e: any) => ({
          startLineNumber: Number(e?.startLineNumber),
          startColumn: Number(e?.startColumn),
          endLineNumber: Number(e?.endLineNumber),
          endColumn: Number(e?.endColumn),
          text: String(e?.text ?? ""),
        }));
        after = applyTextEdits({ before, edits: norm }).after;
      }
      const ifExistsRaw = String((args as any).ifExists ?? "").trim().toLowerCase();
      const ifExists = ifExistsRaw === "overwrite" ? "overwrite" : ifExistsRaw === "error" ? "error" : "rename";
      const suggestedName = String((args as any).suggestedName ?? "").trim();
      const existingPaths = new Set(s.files.map((f) => f.path));
      const resolved = resolveWritePath({
        path: pathRaw,
        content: after,
        suggestedName,
        ifExists,
        existingPaths,
      });
      if ((resolved as any).error === "PATH_EXISTS") {
        return { ok: false, error: "PATH_EXISTS", output: { ok: false, path: pathRaw } };
      }
      const finalPath = resolved.path;
      const diffBefore = resolved.renamedFrom ? "" : before;
      // 若既无 newContent 也无 edits，则视为“无变化预览”（避免报错卡住流程）
      const d = unifiedDiff({ path: finalPath, before: diffBefore, after });
      const hasChange = diffBefore !== after;
      const nextContent = after;
      const apply = hasChange
        ? () => {
            const snap = useProjectStore.getState().snapshot();
            const st = useProjectStore.getState();
            const exists = !!st.getFileByPath(finalPath);
            if (!exists) {
              st.createFile(finalPath, nextContent);
            } else if (st.activePath === finalPath && st.editorRef?.getModel()) {
              const model = st.editorRef.getModel()!;
              const full = model.getFullModelRange();
              st.editorRef.executeEdits("agent", [{ range: full, text: nextContent, forceMoveMarkers: true }]);
              const written = st.editorRef.getModel()?.getValue() ?? nextContent;
              st.updateFile(finalPath, written);
            } else {
              st.updateFile(finalPath, nextContent);
            }
            return { undo: () => useProjectStore.getState().restore(snap) };
          }
        : undefined;
      const noteParts = [
        resolved.renamedFrom ? "已自动改名新建，避免覆盖原文件。" : "",
        hasChange ? "这是写入提案，点击 Keep 写入文件；Undo 可回滚。" : "",
      ].filter(Boolean);
      return {
        ok: true,
        output: {
          ok: true,
          path: finalPath,
          diffUnified: d.diff,
          truncated: d.truncated,
          stats: d.stats ?? null,
          ifExists,
          ...(resolved.renamedFrom ? { renamedFrom: resolved.renamedFrom } : {}),
          ...(noteParts.length ? { note: noteParts.join(" ") } : {}),
        },
        apply,
        undoable: false,
      };
    },
  },
  {
    name: "doc.commitSnapshot",
    description: "创建一个项目快照（用于回滚/Undo）。",
    args: [{ name: "label", required: false, desc: "快照备注（可选）" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const label = typeof args.label === "string" ? String(args.label) : undefined;
      const rec = useProjectStore.getState().commitSnapshot(label);
      const undo = () => useProjectStore.getState().deleteSnapshot(rec.id);
      return {
        ok: true,
        output: {
          ok: true,
          snapshotId: rec.id,
          label: rec.label,
          createdAt: rec.createdAt,
          filesCount: rec.snap.files.length,
        },
        undoable: true,
        undo,
      };
    },
  },
  {
    name: "doc.listSnapshots",
    description: "列出当前项目的快照列表（只读）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const snaps = useProjectStore.getState().snapshots.map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.createdAt,
        filesCount: s.snap.files.length,
      }));
      return { ok: true, output: { ok: true, snapshots: snaps }, undoable: false };
    },
  },
  {
    name: "doc.restoreSnapshot",
    description: "恢复到指定快照（proposal-first：Keep 才会真正恢复；Undo 可回滚）。",
    args: [{ name: "snapshotId", required: true, desc: "快照 ID（doc.commitSnapshot 的返回）" }],
    riskLevel: "high",
    applyPolicy: "proposal",
    reversible: true,
    run: async (args) => {
      const snapshotId = String(args.snapshotId ?? "");
      if (!snapshotId) return { ok: false, error: "MISSING_SNAPSHOT_ID" };
      const rec = useProjectStore.getState().getSnapshot(snapshotId);
      if (!rec) return { ok: false, error: "SNAPSHOT_NOT_FOUND" };

      const cur = useProjectStore.getState().snapshot();
      const curMap = new Map(cur.files.map((f) => [f.path, f.content]));
      const snapMap = new Map(rec.snap.files.map((f) => [f.path, f.content]));
      const allPaths = Array.from(new Set([...curMap.keys(), ...snapMap.keys()])).sort();
      const changedFiles = allPaths.filter((p) => (curMap.get(p) ?? "") !== (snapMap.get(p) ?? ""));

      const previewPath =
        changedFiles.includes(useProjectStore.getState().activePath)
          ? useProjectStore.getState().activePath
          : changedFiles[0] ?? useProjectStore.getState().activePath;
      const before = curMap.get(previewPath) ?? "";
      const after = snapMap.get(previewPath) ?? before;
      const d = unifiedDiff({ path: previewPath, before, after, maxCells: 300_000 });

      const apply = () => {
        const snapBefore = useProjectStore.getState().snapshot();
        useProjectStore.getState().restore(rec.snap);
        return { undo: () => useProjectStore.getState().restore(snapBefore) };
      };

      return {
        ok: true,
        output: {
          ok: true,
          snapshotId: rec.id,
          label: rec.label,
          createdAt: rec.createdAt,
          filesCount: rec.snap.files.length,
          note: "这是恢复提案。点击 Keep 才会恢复到该快照；Undo 可回滚。",
          changedFiles,
          preview: {
            path: previewPath,
            diffUnified: d.diff,
            truncated: d.truncated,
            stats: d.stats ?? null,
          },
        },
        riskLevel: "high",
        applyPolicy: "proposal",
        apply,
        undoable: false,
      };
    },
  },
  {
    name: "doc.write",
    description:
      "写入文件（path, content）。新建可自动落盘；覆盖已有文件会走 proposal-first（Keep 才覆盖，Undo 可回滚）。",
    args: [
      { name: "path", required: true, desc: "新文件路径（如 drafts/run-xxx.md）" },
      { name: "content", required: true, desc: "文件全文内容" },
      { name: "ifExists", required: false, desc: "当文件已存在时的策略：rename(默认)/overwrite/error" },
      { name: "suggestedName", required: false, desc: "建议的新文件名（仅 ifExists=rename 时使用）" },
    ],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const pathRaw = normalizeRelPath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      if (!pathRaw) return { ok: false, error: "MISSING_PATH" };
      const ifExistsRaw = String((args as any).ifExists ?? "").trim().toLowerCase();
      const ifExists = ifExistsRaw === "overwrite" ? "overwrite" : ifExistsRaw === "error" ? "error" : "rename";
      const suggestedName = String((args as any).suggestedName ?? "").trim();
      const st0 = useProjectStore.getState();
      const existingPaths = new Set(st0.files.map((f) => f.path));
      const resolved = resolveWritePath({
        path: pathRaw,
        content,
        suggestedName,
        ifExists,
        existingPaths,
      });
      if ((resolved as any).error === "PATH_EXISTS") {
        return { ok: false, error: "PATH_EXISTS", output: { ok: false, path: pathRaw } };
      }
      const path = resolved.path;
      const exists = !!useProjectStore.getState().getFileByPath(path);
      if (!exists) {
        const snap = useProjectStore.getState().snapshot();
        useProjectStore.getState().createFile(path, content);
        const undo = () => useProjectStore.getState().restore(snap);
        const d = unifiedDiff({ path, before: "", after: content, maxCells: 400_000 });
        return {
          ok: true,
          output: {
            ok: true,
            path,
            created: true,
            diffUnified: d.diff,
            truncated: d.truncated,
            stats: d.stats ?? null,
            ifExists,
            ...(resolved.renamedFrom ? { renamedFrom: resolved.renamedFrom, note: "已自动改名新建，避免覆盖原文件。" } : {}),
          },
          applyPolicy: "auto_apply",
          riskLevel: "low",
          undoable: true,
          undo,
        };
      }

      // 覆盖：proposal-first
      const prev = useProjectStore.getState().getFileByPath(path)?.content ?? "";
      const d = unifiedDiff({ path, before: prev, after: content });
      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        const s = useProjectStore.getState();
        if (s.activePath === path && s.editorRef?.getModel()) {
          const model = s.editorRef.getModel()!;
          const full = model.getFullModelRange();
          s.editorRef.executeEdits("agent", [{ range: full, text: content, forceMoveMarkers: true }]);
          const next = s.editorRef.getModel()?.getValue() ?? content;
          useProjectStore.getState().updateFile(path, next);
        } else {
          useProjectStore.getState().updateFile(path, content);
        }
        return { undo: () => useProjectStore.getState().restore(snap) };
      };

      return {
        ok: true,
        output: {
          ok: true,
          path,
          created: false,
          preview: { note: "覆盖写入为提案：点击 Keep 才会覆盖文件；Undo 可回滚。", diffUnified: d.diff, truncated: d.truncated, stats: d.stats ?? null },
        },
        applyPolicy: "proposal",
        riskLevel: "medium",
        apply,
        undoable: false,
      };
    },
  },
  {
    name: "doc.splitToDir",
    description:
      "将一个大文档按“标题/文案(正文)”块分割成多篇，并写入目标文件夹（proposal-first：Keep 才会真正写入；Undo 可回滚）。",
    args: [
      { name: "path", required: true, desc: "源文件路径（如 直男财经.md）" },
      { name: "targetDir", required: true, desc: "目标目录（如 直男财经/）" },
    ],
    riskLevel: "medium",
    applyPolicy: "proposal",
    reversible: true,
    run: async (args) => {
      const srcPath = normalizeRelPath(String(args.path ?? ""));
      const dirRaw = normalizeRelPath(String(args.targetDir ?? ""));
      const targetDir = dirRaw.replace(/\/+$/g, "");
      if (!srcPath) return { ok: false, error: "MISSING_PATH" };
      if (!targetDir) return { ok: false, error: "MISSING_TARGET_DIR" };

      const proj = useProjectStore.getState();
      const file = proj.getFileByPath(srcPath);
      if (!file) return { ok: false, error: "FILE_NOT_FOUND" };

      const content = await proj.ensureLoaded(file.path);
      const blocks = splitTitleBlocks(content);
      if (!blocks.length) return { ok: false, error: "NO_TITLE_BLOCKS" };
      if (blocks.length > 300) return { ok: false, error: "TOO_MANY_BLOCKS" };

      const existing = new Set(proj.files.map((f) => f.path));
      const used = new Set<string>();

      const out = blocks.map((b, idx) => {
        const title = extractTitleFromBlock(b) || `片段_${idx + 1}`;
        let base = sanitizeFileName(title);
        if (!base) base = `片段_${idx + 1}`;
        const base0 = base;
        let n = 2;
        let rel = `${targetDir}/${base}.md`;
        while (existing.has(rel) || used.has(rel)) {
          base = sanitizeFileName(`${base0}_${n++}`);
          rel = `${targetDir}/${base}.md`;
        }
        used.add(rel);
        return { path: rel, title, content: b.trimEnd() + "\n" };
      });

      // 仅保存在本地：用于 doc.read 读取“提案态新文件”（不要求 Keep）
      const proposalId = makeProposalId("splitToDir");
      saveSplitToDirProposal(
        proposalId,
        out.map((f) => ({ path: f.path, content: f.content })),
      );

      const preview = {
        ok: true,
        proposalId,
        sourcePath: srcPath,
        targetDir: `${targetDir}/`,
        count: out.length,
        note: `这是分割提案：点击 Keep 才会写入 ${out.length} 个新文件到 ${targetDir}/；Undo 可回滚。`,
        files: out.map((f) => ({
          path: f.path,
          title: f.title,
          chars: f.content.length,
          head: f.content.slice(0, 120),
        })),
      };

      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        const s = useProjectStore.getState();
        const rootDir = s.rootDir;
        const api = window.desktop?.fs;

        void (async () => {
          try {
            if (rootDir && api) {
              await api.mkdir(rootDir, targetDir).catch(() => ({ ok: false }));
              for (const f of out) {
                await api.writeFile(rootDir, f.path, f.content);
              }
              await s.refreshFromDisk("splitToDir");
            } else {
              // 无落盘能力时：退化为内存写入（可能会打开多个 tab，开发期可接受）
              for (const f of out) {
                const exists = !!s.getFileByPath(f.path);
                if (!exists) s.createFile(f.path, f.content);
                else s.updateFile(f.path, f.content);
              }
            }
            // apply 成功后，可清理对应提案缓存（此时文件已在内存/磁盘可读）
            splitToDirProposalStore.delete(proposalId);
          } catch (e: any) {
            useRunStore.getState().log("error", "splitToDir.failed", { message: String(e?.message ?? e) });
            s.restore(snap as any);
          }
        })();

        return { undo: () => useProjectStore.getState().restore(snap) };
      };

      return {
        ok: true,
        output: preview,
        applyPolicy: "proposal",
        riskLevel: "medium",
        apply,
        undoable: false,
      };
    },
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选中内容（用于段落改写/润色）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "proposal",
    reversible: false,
    run: async () => {
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      if (!ed) return { ok: false, error: "NO_EDITOR" };
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel) return { ok: false, error: "NO_SELECTION" };
      const selectedText = model.getValueInRange(sel);
      return {
        ok: true,
        output: {
          ok: true,
          path: s.activePath,
          selectedText,
          hasSelection: selectedText.length > 0,
          range: {
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: sel.endLineNumber,
            endColumn: sel.endColumn,
          },
        },
        undoable: false,
      };
    },
  },
  {
    name: "doc.replaceSelection",
    description: "用 text 替换当前选区（低风险自动落盘，可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本" }],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async (args) => {
      const text = String(args.text ?? "");
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      if (!ed) return { ok: false, error: "NO_EDITOR" };
      const model = ed.getModel();
      const sel = ed.getSelection();
      if (!model || !sel) return { ok: false, error: "NO_SELECTION" };
      const before = model.getValueInRange(sel);
      if (!before) return { ok: false, error: "EMPTY_SELECTION" };

      const snap = s.snapshot();
      ed.executeEdits("agent", [{ range: sel, text, forceMoveMarkers: true }]);
      // 确保项目 store 与 Monaco 模型一致（避免 onChange 没触发导致回弹）
      const next = ed.getModel()?.getValue() ?? "";
      useProjectStore.getState().updateFile(s.activePath, next);
      const undo = () => useProjectStore.getState().restore(snap);

      return {
        ok: true,
        output: { ok: true, replacedChars: before.length, newChars: text.length },
        undoable: true,
        undo,
      };
    },
  },
  {
    name: "doc.applyEdits",
    description:
      "对当前活动文件应用一组文本编辑（edits）。默认先生成预览（proposal-first），点击 Keep 才真正写入；Undo 可回滚。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath；MVP 仅支持 activePath）" },
      {
        name: "edits",
        required: true,
        desc:
          'JSON 数组：[{ startLineNumber, startColumn, endLineNumber, endColumn, text }...]（基于 Monaco range）',
      },
    ],
    riskLevel: "medium",
    applyPolicy: "proposal",
    reversible: true,
    run: async (args) => {
      const s = useProjectStore.getState();
      const ed = s.editorRef;
      const path = String(args.path ?? s.activePath ?? "");
      if (!path) return { ok: false, error: "MISSING_PATH" };
      const file = s.getFileByPath(path);
      if (!file) return { ok: false, error: "FILE_NOT_FOUND" };

      const edits = args.edits as any;
      if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "EMPTY_EDITS" };

      type One = {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
        text: string;
      };
      const normalized: One[] = [];
      for (const e of edits) {
        const sl0 = Number(e?.startLineNumber);
        const sc0 = Number(e?.startColumn);
        const el0 = Number(e?.endLineNumber);
        const ec0 = Number(e?.endColumn);
        const text = String(e?.text ?? "");
        // Monaco range 是 1-based。部分模型会给 0-based（尤其 column=0）。
        // 为了减少无意义失败：允许 0，并把 0 纠正为 1（其余数字取 floor）。
        if (![sl0, sc0, el0, ec0].every((n) => Number.isFinite(n) && n >= 0)) {
          return {
            ok: false,
            error: "INVALID_RANGE",
            detail: {
              hint: "Monaco range 必须是 1-based（line/column 从 1 开始）。",
              got: { startLineNumber: sl0, startColumn: sc0, endLineNumber: el0, endColumn: ec0 },
            },
          };
        }
        const sl = Math.max(1, Math.floor(sl0 || 1));
        const sc = Math.max(1, Math.floor(sc0 || 1));
        const el = Math.max(1, Math.floor(el0 || 1));
        const ec = Math.max(1, Math.floor(ec0 || 1));
        normalized.push({ startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec, text });
      }

      const before = await s.ensureLoaded(file.path);
      const { after } = applyTextEdits({ before, edits: normalized });
      const d = unifiedDiff({ path, before, after });

      const apply = () => {
        const snap = useProjectStore.getState().snapshot();
        const st = useProjectStore.getState();
        // 如果目标文件正是当前活动文件且 editor 可用，优先用 Monaco 应用（保光标/markers）
        if (st.activePath === path && st.editorRef?.getModel()) {
          st.editorRef.executeEdits(
            "agent",
            normalized.map((e) => ({
              range: {
                startLineNumber: e.startLineNumber,
                startColumn: e.startColumn,
                endLineNumber: e.endLineNumber,
                endColumn: e.endColumn,
              },
              text: e.text,
              forceMoveMarkers: true,
            })),
          );
          const next = st.editorRef.getModel()?.getValue() ?? after;
          useProjectStore.getState().updateFile(path, next);
        } else {
          // 非活动文件：直接更新 store 内容
          useProjectStore.getState().updateFile(path, after);
        }
        return { undo: () => useProjectStore.getState().restore(snap) };
      };

      return {
        ok: true,
        output: {
          ok: true,
          path,
          editsCount: normalized.length,
          preview: {
            note: "这是修改提案。点击 Keep 才会应用到编辑器；Undo 可回滚。",
            diffUnified: d.diff,
            truncated: d.truncated,
            stats: d.stats ?? null,
          },
        },
        apply,
        undoable: false,
      };
    },
  },
  {
    name: "writing.batch.start",
    description:
      "启动批处理写作（长时间运行）：从一个输入文件夹批量生成多篇短视频口播稿，并写入项目输出目录（默认 exports/batch_xxx）。\n" +
      "注意：该工具会启动后台任务并立即返回 job 信息（不会等待全部生成完成）。",
    args: [
      { name: "inputDir", desc: "输入目录（绝对路径；不传则弹出选择目录）" },
      { name: "clipsPerLesson", desc: "每节课生成多少篇（默认 5，范围 1-12）" },
      { name: "outputBaseDir", desc: "输出根目录（相对项目；默认 exports）" },
    ],
    riskLevel: "high",
    applyPolicy: "auto_apply",
    reversible: false,
    run: async (args) => {
      if (!requireLoginForTool("批处理写作").ok) return { ok: false, error: "AUTH_REQUIRED" };

      const store = useWritingBatchStore.getState();
      const inputDir = String((args as any).inputDir ?? "").trim();
      const clipsPerLesson0 = (args as any).clipsPerLesson;
      const clipsPerLesson = typeof clipsPerLesson0 === "number" ? clipsPerLesson0 : undefined;
      const outputBaseDir0 = (args as any).outputBaseDir;
      const outputBaseDir = typeof outputBaseDir0 === "string" ? outputBaseDir0.trim() : undefined;

      const created = inputDir
        ? await store.createJobFromDir({ inputDir, clipsPerLesson, outputBaseDir })
        : await store.createJobInteractive({ clipsPerLesson, outputBaseDir });
      if (!created.ok || !created.jobId) return { ok: false, error: String(created.error ?? "CREATE_JOB_FAILED"), output: created };

      // 关键：批处理是长时间运行，不能 await（否则 tool_call 会卡住整次 run）
      void store.start(created.jobId);

      const job = useWritingBatchStore.getState().jobs.find((j) => j.id === created.jobId) ?? null;
      return { ok: true, output: { ok: true, jobId: created.jobId, job }, undoable: false };
    },
  },
  {
    name: "writing.batch.status",
    description: "查询当前批处理状态与进度（只读）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async () => {
      const s = useWritingBatchStore.getState();
      const active = s.activeJobId ? s.jobs.find((j) => j.id === s.activeJobId) ?? null : s.jobs[0] ?? null;
      return { ok: true, output: { ok: true, status: s.status, error: s.error, activeJobId: s.activeJobId, activeJob: active }, undoable: false };
    },
  },
  {
    name: "writing.batch.pause",
    description: "暂停当前批处理（后台停止推进）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async () => {
      useWritingBatchStore.getState().pause();
      return { ok: true, output: { ok: true }, undoable: false };
    },
  },
  {
    name: "writing.batch.resume",
    description: "继续当前批处理（从 checkpoint 继续推进）。",
    args: [],
    riskLevel: "low",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async () => {
      // 关键：不能 await（长跑），只触发恢复即可
      void useWritingBatchStore.getState().resume();
      return { ok: true, output: { ok: true }, undoable: false };
    },
  },
  {
    name: "writing.batch.cancel",
    description: "取消当前批处理（后台停止推进，已生成文件保留）。",
    args: [],
    riskLevel: "medium",
    applyPolicy: "auto_apply",
    reversible: true,
    run: async () => {
      useWritingBatchStore.getState().cancel();
      return { ok: true, output: { ok: true }, undoable: false };
    },
  },
];

export function listTools() {
  return tools;
}

export function getTool(name: string) {
  return tools.find((t) => t.name === name);
}

export function toolsPrompt() {
  const lines = tools.map((t) => {
    const args = t.args.length
      ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n")
      : "- （无参数）";
    return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
  });
  return lines.join("\n");
}

export async function executeToolCall(args: {
  toolName: string;
  rawArgs: Record<string, string>;
  mode: Mode;
}): Promise<{
  def?: ToolDefinition;
  parsedArgs: Record<string, unknown>;
  result: ToolExecResult;
}> {
  const parsedArgs = parseArgs(args.rawArgs);
  const def = getTool(args.toolName);

  // Chat 模式：纯对话，不允许调用任何工具（双保险；Gateway 侧也会做 allowlist）。
  if (args.mode === "chat") {
    return { def, parsedArgs, result: { ok: false, error: "TOOL_NOT_ALLOWED_IN_CHAT_MODE" } };
  }
  if (!def) {
    return { parsedArgs, result: { ok: false, error: "UNKNOWN_TOOL" } };
  }

  // required check
  for (const a of def.args) {
    if (!a.required) continue;
    if (parsedArgs[a.name] === undefined || parsedArgs[a.name] === null || String(parsedArgs[a.name]).length === 0) {
      return { def, parsedArgs, result: { ok: false, error: `MISSING_ARG:${a.name}` } };
    }
  }

  try {
    const result = await def.run(parsedArgs, { mode: args.mode });
    return { def, parsedArgs, result };
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    return { def, parsedArgs, result: { ok: false, error: msg } };
  }
}


