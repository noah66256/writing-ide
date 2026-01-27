import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useWorkspaceStore } from "./workspaceStore";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { useProjectStore } from "./projectStore";
import { useLayoutStore } from "./layoutStore";
import { useRunStore } from "./runStore";
import { useAuthStore } from "./authStore";
import { useDialogStore } from "./dialogStore";
import { FACET_PACKS, getFacetPack } from "../kb/facets";

function kbLog(level: "info" | "warn" | "error", message: string, data?: unknown) {
  try {
    useRunStore.getState().log(level, message, data);
  } catch {
    // ignore
  }
}

type KbFormat = "md" | "mdx" | "txt" | "docx" | "pdf" | "unknown";
type KbArtifactKind = "outline" | "paragraph" | "card";

export type ImportedFrom =
  | { kind: "project"; relPath: string; entryIndex?: number }
  | { kind: "file"; absPath: string; entryIndex?: number }
  | { kind: "url"; url: string; finalUrl?: string; fetchedAt?: string; entryIndex?: number };

export type KbTextSpanRefV1 = {
  v: 1;
  libraryId: string;
  sourceDocId: string;
  importedFrom?: ImportedFrom;
  segmentId: string;
  paragraphIndexStart: number | null;
  headingPath?: string[];
  quote: string; // <= 200 字；UI 预览与审计用（正文仍以回链读取为准）
};

export type KbLibraryStylePrefsV1 = {
  updatedAt: string;
  // M2+：用于“默认写法仅对本库生效”，M1 先占位
  defaultClusterId?: string;
  // M2：子簇改名（仅本库生效）
  clusterLabelsV1?: Record<string, string>;
  // V2：子簇规则卡（仅本库生效；用于写作期注入 styleContractV1）
  // - key: clusterId（例如 cluster_0/cluster_1/cluster_2）
  // - value: 规则卡 JSON（建议包含 values / analysisLenses 等；由 UI/工具写入）
  clusterRulesV1?: Record<string, any>;
  // M1：用户采纳的黄金样本（段级）
  anchorsV1?: KbTextSpanRefV1[];
};

export type KbLibraryPrefsV1 = {
  style?: KbLibraryStylePrefsV1;
};

export type KbLibrary = {
  id: string;
  name: string;
  /**
   * 库用途（决定默认策略/界面引导）：
   * - material: 素材库（默认）
   * - style: 风格库（绑定后写作类任务默认先 kb.search 拉样例）
   * - product: 产品库（偏产品/需求/PRD/规范等资料）
   */
  purpose?: "material" | "style" | "product";
  facetPackId: string; // FacetPackId；序列化时用 string，读取时兜底到 speech_marketing_v1
  createdAt: string;
  updatedAt: string;
};

export type KbLibraryTrashItem = {
  library: KbLibrary;
  deletedAt: string;
};

export type KbSourceDoc = {
  id: string;
  libraryId: string;
  title: string;
  format: KbFormat;
  importedFrom: ImportedFrom;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};

export type KbAnchor = {
  headingPath?: string[];
  paragraphIndex?: number;
};

export type KbArtifact = {
  id: string;
  sourceDocId: string;
  kind: KbArtifactKind;
  title?: string;
  cardType?: string;
  content: string;
  facetIds?: string[];
  // 向量缓存：key=embeddingModel，value=embedding vector
  embeddings?: Record<string, number[]>;
  // doc_v2：保留模型返回的完整引用段落索引（用于库级手册聚合时做证据）
  evidenceParagraphIndices?: number[];
  anchor: KbAnchor;
};

export type KbFingerprintStabilityLevel = "high" | "medium" | "low";

export type KbFingerprintGenre = {
  label: string; // 开集：允许 unknown_*
  confidence: number; // 0~1
  why: string;
  evidence?: Array<{ docId: string; paragraphIndex: number | null; quote: string }>;
};

export type KbLibraryFingerprintSnapshot = {
  id: string;
  libraryId: string;
  computedAt: string;
  version: 1;
  // 用于 UI 的“傻瓜徽章”
  badge?: { primaryLabel: string; confidence: number; stability: KbFingerprintStabilityLevel };
  // 样本概况（用于“稳不稳”）
  // - docs：源文档数（sourceDocs；可能一篇源文档包含多篇稿件）
  // - segments：样本段数（对源文档做规则切分后的“近似文章单元”，用于稳定性/覆盖率统计）
  corpus: { docs: number; segments?: number; chars: number; sentences: number };
  // 确定性统计（核心：每100句/每1000字）
  stats: Record<string, any>;
  // 开集体裁/声音标签（LLM 生成或兜底 unknown）
  genres: { primary: KbFingerprintGenre; candidates: KbFingerprintGenre[] };
  // 稳定性（库内一致性）
  stability: { level: KbFingerprintStabilityLevel; note?: string; outlierDocIds?: string[] };
  // 高频短语（n-gram）
  // - docCoverage：覆盖率（0~1；相对“样本段”或旧版相对“源文档”）
  // - docCoverageCount：覆盖样本数（样本段/源文档数量；旧版快照可能缺失该字段）
  topNgrams: Array<{ n: number; text: string; per1kChars: number; docCoverage: number; docCoverageCount?: number }>;
  // 文档级（用于找离群）
  perDoc: Array<{
    docId: string;
    docTitle: string;
    chars: number;
    sentences: number;
    badge?: { primaryLabel: string; confidence: number };
    stats: Record<string, any>;
  }>;
  // 样本段级（用于解决“多篇稿件塞到一个源文档”导致的稳定性/离群判断失真）
  perSegment?: Array<{
    segmentId: string;
    sourceDocId: string;
    sourceDocTitle: string;
    // 便于 UI 展示“文件名/路径”（旧快照可能没有）
    sourceDocPath?: string;
    // 便于 anchors/回链定位（旧快照可能没有）
    paragraphIndexStart?: number | null;
    // 段落预览（单行截断；旧快照可能没有）
    preview?: string;
    // M2：聚类结果（cluster_0/1/2；旧快照可能没有）
    clusterId?: string;
    chars: number;
    sentences: number;
    stats: Record<string, any>;
  }>;
  // M2：写法候选（子簇规则卡；旧快照可能没有）
  clustersV1?: Array<{
    v: 1;
    id: string; // cluster_0/1/2
    label: string; // 默认 写法A/B/C，可被本库 prefs 覆盖
    segmentCount: number;
    docCoverageCount: number;
    docCoverageRate: number; // 0~1（相对库内 docs）
    stability: KbFingerprintStabilityLevel;
    statsMean: Record<string, number>;
    softRanges: Record<string, [number, number]>;
    evidence: KbTextSpanRefV1[]; // 3~5 段代表样例（可回链）
    anchors: KbTextSpanRefV1[]; // 本簇已采纳 anchors
    facetPlan: Array<{ facetId: string; why?: string; kbQueries?: string[] }>;
    queries: string[];
  }>;
  // 证据覆盖率：帮助判断“手册会不会胡”
  evidence: { cardsWithEvidenceRate: number; playbookCardsWithEvidenceRate: number };
};

export type KbCardJobStatus = "pending" | "running" | "success" | "skipped" | "failed" | "cancelled";

export type KbCardJob = {
  id: string;
  docId: string;
  docTitle: string;
  libraryId?: string;
  libraryName?: string;
  status: KbCardJobStatus;
  extractedCards?: number;
  error?: string;
  updatedAt: string;
};

export type KbPlaybookJob = {
  id: string;
  libraryId: string;
  libraryName?: string;
  status: KbCardJobStatus;
  // 进度（估算用）：Style Profile 1 + facets N
  totalFacets?: number;
  generatedFacets?: number; // 运行中会实时增长；成功时通常等于 totalFacets
  generatedStyleProfile?: boolean;
  phase?: "style_profile" | "facets";
  error?: string;
  updatedAt: string;
};

type KbPendingImport = {
  kind: "project";
  paths: string[];
};

type KbDb = {
  version: 4;
  ownerKey: string;
  createdAt: string;
  updatedAt: string;
  libraries: KbLibrary[];
  trash: KbLibraryTrashItem[];
  sourceDocs: KbSourceDoc[];
  artifacts: KbArtifact[];
  // M1：库级偏好（例如风格库 anchors、后续默认写法等）
  libraryPrefs?: Record<string, KbLibraryPrefsV1>;
  fingerprints?: KbLibraryFingerprintSnapshot[];
};

export type KbSearchGroup = {
  sourceDoc: KbSourceDoc;
  bestScore: number;
  hits: Array<{ artifact: KbArtifact; score: number; snippet: string }>;
};

type KbState = {
  baseDir: string | null;
  ownerKey: string; // MVP: 没有真实登录态时先用 local_anonymous；后续替换为 userId/email

  isLoading: boolean;
  error: string | null;
  lastImportAt: string | null;

  query: string;
  groups: KbSearchGroup[];

  // 库（Library）
  currentLibraryId: string | null; // 强制用户选择库；不默认选中
  libraries: Array<{
    id: string;
    name: string;
    purpose: "material" | "style" | "product";
    facetPackId: string;
    docCount: number;
    updatedAt: string;
    fingerprint?: { primaryLabel: string; confidence: number; stability: KbFingerprintStabilityLevel; computedAt: string };
  }>;
  trashLibraries: Array<{ id: string; name: string; docCount: number; deletedAt: string }>;

  // 库管理弹窗（包含抽卡队列）
  kbManagerOpen: boolean;
  kbManagerTab: "libraries" | "jobs" | "trash";
  kbManagerNotice: string | null;

  // 任务队列（抽卡 + 风格手册）
  cardJobStatus: "idle" | "running" | "paused";
  cardJobError: string | null;
  cardJobs: KbCardJob[];
  playbookJobs: KbPlaybookJob[];
  cardJobRunStartedAtMs: number | null;
  cardJobRunElapsedMs: number;

  // 导入：未选库时先暂存，待用户选择库后自动继续
  pendingImport: KbPendingImport | null;
  setPendingImport: (pending: KbPendingImport | null) => void;

  setQuery: (q: string) => void;
  setBaseDir: (dir: string | null) => void;
  pickBaseDir: () => Promise<void>;
  ensureReady: () => Promise<boolean>;

  refreshLibraries: () => Promise<void>;
  setCurrentLibrary: (libraryId: string | null) => void;
  createLibrary: (name: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  renameLibrary: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  setLibraryPurpose: (id: string, purpose: "material" | "style" | "product") => Promise<{ ok: boolean; error?: string }>;
  setLibraryFacetPack: (id: string, facetPackId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteLibraryToTrash: (id: string) => Promise<{ ok: boolean; error?: string }>;
  restoreLibraryFromTrash: (id: string) => Promise<{ ok: boolean; error?: string }>;
  purgeLibrary: (id: string) => Promise<{ ok: boolean; removedDocs: number; removedArtifacts: number; error?: string }>;
  emptyTrash: () => Promise<{ ok: boolean; removedLibraries: number; removedDocs: number; removedArtifacts: number; error?: string }>;
  resetLocalKb: () => Promise<{ ok: boolean; error?: string }>;

  importProjectPaths: (paths: string[]) => Promise<{
    imported: number;
    skipped: number;
    docIds: string[];
    skippedByReason?: Record<string, number>;
    skippedSample?: Array<{ path: string; reason: string }>;
  }>;
  importExternalFiles: (absPaths: string[]) => Promise<{
    imported: number;
    skipped: number;
    docIds: string[];
    skippedByReason?: Record<string, number>;
    skippedSample?: Array<{ path: string; reason: string }>;
    errors?: Array<{ path: string; error: string }>;
  }>;
  importUrls: (
    urls: string[],
    opts?: { timeoutMs?: number; maxChars?: number; split?: "auto" | "single" | "md_headings" | "dash" },
  ) => Promise<{
    imported: number;
    skipped: number;
    docIds: string[];
    skippedByReason?: Record<string, number>;
    skippedSample?: Array<{ path: string; reason: string }>;
    errors?: Array<{ url: string; error: string }>;
  }>;
  extractCardsForDocs: (docIds: string[], opts?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    extracted: number;
    skipped: number;
    error?: string;
  }>;
  generateLibraryPlaybook: (
    libraryId: string,
    opts?: { signal?: AbortSignal; jobId?: string },
  ) => Promise<{ ok: boolean; facets?: number; error?: string }>;
  // 库体检（Fingerprint）：统计“声音指纹”（率/分布）+ 开集体裁识别（可用 LLM）
  getLatestLibraryFingerprint: (libraryId: string) => Promise<{ ok: boolean; snapshot?: KbLibraryFingerprintSnapshot; error?: string }>;
  computeLibraryFingerprint: (args: {
    libraryId: string;
    useLlm?: boolean;
    model?: string;
  }) => Promise<{ ok: boolean; snapshot?: KbLibraryFingerprintSnapshot; error?: string }>;
  getLibraryFingerprintHistory: (libraryId: string, limit?: number) => Promise<{ ok: boolean; items: KbLibraryFingerprintSnapshot[]; error?: string }>;
  compareLatestLibraryFingerprints: (libraryId: string) => Promise<
    | { ok: true; newer: KbLibraryFingerprintSnapshot; older: KbLibraryFingerprintSnapshot; diff: Record<string, any> }
    | { ok: false; error: string }
  >;

  // M1：风格库 anchors（黄金样本，段级；仅对该库生效）
  getLibraryStyleAnchors: (libraryId: string) => Promise<{ ok: boolean; anchors: KbTextSpanRefV1[]; error?: string }>;
  saveLibraryStyleAnchorsFromSegments: (args: {
    libraryId: string;
    segments: Array<{ segmentId: string; sourceDocId: string; paragraphIndexStart: number | null; quote: string }>;
  }) => Promise<{ ok: boolean; anchors?: KbTextSpanRefV1[]; error?: string }>;
  clearLibraryStyleAnchors: (libraryId: string) => Promise<{ ok: boolean; anchors?: KbTextSpanRefV1[]; error?: string }>;
  // M2：写法候选（子簇）配置（仅本库生效）
  getLibraryStyleConfig: (libraryId: string) => Promise<{
    ok: boolean;
    anchors: KbTextSpanRefV1[];
    defaultClusterId?: string;
    clusterLabelsV1?: Record<string, string>;
    clusterRulesV1?: Record<string, any>;
    error?: string;
  }>;
  setLibraryStyleClusterLabel: (args: { libraryId: string; clusterId: string; label: string }) => Promise<{ ok: boolean; error?: string }>;
  setLibraryStyleDefaultCluster: (args: { libraryId: string; clusterId: string | null }) => Promise<{ ok: boolean; error?: string }>;
  setLibraryStyleClusterRules: (args: { libraryId: string; clusterId: string; rules: any }) => Promise<{ ok: boolean; error?: string }>;
  // V2/P3：自动生成写法簇规则卡（values/lens/templates），并保存到 prefs（可选：写入 playbook 虚拟文档便于 kb.search）
  generateLibraryClusterRulesV1: (args: { libraryId: string; clusterId?: string | null; model?: string }) => Promise<{
    ok: boolean;
    updated?: number;
    error?: string;
  }>;
  // 供 Agent 的 Context Pack 注入：读取库级“仿写手册”（StyleProfile + 维度手册）
  getPlaybookTextForLibraries: (libraryIds: string[]) => Promise<string>;
  // Selector v1：读取 playbook_facet 维度卡（按 facetIds）供 Context Pack 注入（避免模型看不见/不执行）
  getPlaybookFacetCardsForLibrary: (args: {
    libraryId: string;
    facetIds: string[];
    maxCharsPerCard?: number;
    maxTotalChars?: number;
  }) => Promise<{ ok: boolean; cards: Array<{ facetId: string; title: string; content: string }>; error?: string }>;

  openKbManager: (tab?: KbState["kbManagerTab"], notice?: string | null) => void;
  closeKbManager: () => void;
  enqueueCardJobs: (docIds: string[], opts?: { open?: boolean; autoStart?: boolean }) => Promise<void>;
  enqueuePlaybookJob: (libraryId: string, opts?: { open?: boolean }) => Promise<{ ok: boolean; enqueued?: boolean; error?: string }>;
  startCardJobs: () => Promise<void>;
  pauseCardJobs: () => void;
  resumeCardJobs: () => Promise<void>;
  cancelCardJobs: () => void;
  clearFinishedCardJobs: () => void;
  retryFailedCardJobs: () => void;

  // UI：查看某个库下的卡片（用于库管理里浏览）
  listCardsForLibrary: (args: {
    libraryId: string;
    cardTypes?: string[];
    limit?: number;
    includeContent?: boolean;
    query?: string;
  }) => Promise<
    | { ok: true; cards: Array<{ artifact: KbArtifact; sourceDoc: KbSourceDoc }>; total: number }
    | { ok: false; error: string }
  >;

  search: (q?: string, options?: { kind?: KbArtifactKind; facetIds?: string[]; perDocTopN?: number; topDocs?: number }) => Promise<void>;
  // 供 Agent 工具使用：纯函数式检索（不更新 UI state）
  searchForAgent: (args: {
    query: string;
    kind?: KbArtifactKind;
    facetIds?: string[];
    cardTypes?: string[];
    anchorParagraphIndexMax?: number;
    anchorFromEndMax?: number;
    debug?: boolean;
    libraryIds: string[];
    perDocTopN?: number;
    topDocs?: number;
    // 向量检索：默认开启；embeddingModel 可用于 A/B（例如 text-embedding-3-large / Embedding-V1）
    useVector?: boolean;
    embeddingModel?: string;
  }) => Promise<{ ok: boolean; groups?: KbSearchGroup[]; error?: string; debug?: any }>;

  // 供 Agent 工具使用：按 sourceDoc/anchor 精确取证据段（用于引用/审计）
  citeForAgent: (args: {
    sourceDocId: string;
    artifactId?: string;
    paragraphIndex?: number;
    headingPath?: string[] | string;
    maxChars?: number;
    quoteMaxChars?: number;
  }) => Promise<{ ok: boolean; ref?: KbTextSpanRefV1; content?: string; title?: string; error?: string }>;
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  const anyCrypto = globalThis as any;
  const uuid = typeof anyCrypto?.crypto?.randomUUID === "function" ? anyCrypto.crypto.randomUUID() : null;
  return `${prefix}_${uuid ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function fnv1a32Hex(input: string) {
  let hash = 0x811c9dc5;
  const s = String(input ?? "");
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    // hash *= 16777619 (with overflow)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function sha256Hex(input: string): Promise<string | null> {
  try {
    const anyCrypto = globalThis as any;
    const subtle = anyCrypto?.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== "function") return null;
    const enc = new TextEncoder();
    const data = enc.encode(String(input ?? ""));
    const buf = await subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(buf);
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
  } catch {
    return null;
  }
}

function normalizeText(input: string) {
  return String(input ?? "")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function canonicalizeUrlForDedup(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";

    // normalize host/protocol
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();

    // drop default ports
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";

    // normalize pathname (trim trailing slash for non-root)
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");

    // strip common tracking params + sort
    const drop = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "gclid",
      "fbclid",
      "igshid",
      "spm",
      "scid",
      "mc_cid",
      "mc_eid",
      "_hsenc",
      "_hsmi",
      "mkt_tok",
      "ref",
      "ref_src",
      "source",
    ]);
    const kept: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) {
      const key = String(k ?? "").trim();
      if (!key) continue;
      if (drop.has(key.toLowerCase())) continue;
      kept.push([key, String(v ?? "")]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    u.search = "";
    for (const [k, v] of kept) u.searchParams.append(k, v);

    return u.toString();
  } catch {
    // not a valid URL -> keep original (best-effort)
    return raw;
  }
}

function normalizeFacetPackId(input?: string | null) {
  const raw = String(input ?? "").trim();
  const ok = FACET_PACKS.some((p) => p.id === raw);
  return ok ? raw : "speech_marketing_v1";
}

type KbEntry = {
  entryIndex: number;
  title?: string;
  text: string;
};

function splitIntoEntries(args: { text: string }): KbEntry[] {
  const raw = normalizeText(args.text);
  if (!raw) return [];
  const lines = raw.split("\n");

  // Strategy A: 标题：... + 文案：... (+ --- 分隔)
  const titleIdxs: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]?.match(/^\s*标题：\s*(.+?)\s*$/);
    if (m?.[1]) titleIdxs.push({ line: i, title: String(m[1]).trim() });
  }
  if (titleIdxs.length >= 2) {
    const out: KbEntry[] = [];
    for (let k = 0; k < titleIdxs.length; k += 1) {
      const startLine = titleIdxs[k]!.line;
      const endLine = (titleIdxs[k + 1]?.line ?? lines.length) - 1;
      const title = titleIdxs[k]!.title;

      // find 文案： between startLine..endLine
      let bodyStart = startLine + 1;
      for (let j = startLine + 1; j <= endLine; j += 1) {
        if (/^\s*文案：\s*$/.test(lines[j] ?? "")) {
          bodyStart = j + 1;
          break;
        }
      }
      const bodyLines = lines.slice(bodyStart, endLine + 1);
      const body = normalizeText(bodyLines.join("\n"));
      if (!body) continue;
      const md = `# ${title}\n\n${body}\n`;
      out.push({ entryIndex: out.length, title, text: md });
    }
    if (out.length >= 2) return out;
  }

  // Strategy B: Markdown #/## headings
  const headingIdxs: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]?.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (m?.[2]) headingIdxs.push({ line: i, title: String(m[2]).trim() });
  }
  if (headingIdxs.length >= 2) {
    const out: KbEntry[] = [];
    for (let k = 0; k < headingIdxs.length; k += 1) {
      const startLine = headingIdxs[k]!.line;
      const endLine = (headingIdxs[k + 1]?.line ?? lines.length) - 1;
      const title = headingIdxs[k]!.title;
      const part = normalizeText(lines.slice(startLine, endLine + 1).join("\n"));
      if (!part) continue;
      out.push({ entryIndex: out.length, title, text: part });
    }
    if (out.length >= 2) return out;
  }

  // Strategy C: --- 分隔（避免把 YAML frontmatter 当分隔）
  const isSep = (s: string) => /^\s*---\s*$/.test(s);
  let start = 0;
  if (lines[0] && isSep(lines[0])) {
    // YAML frontmatter: --- ... ---
    for (let i = 1; i < lines.length; i += 1) {
      if (isSep(lines[i] ?? "")) {
        start = i + 1;
        break;
      }
    }
  }
  const sepIdxs: number[] = [];
  for (let i = start; i < lines.length; i += 1) if (isSep(lines[i] ?? "")) sepIdxs.push(i);
  if (sepIdxs.length >= 1) {
    const out: KbEntry[] = [];
    let from = start;
    const cuts = [...sepIdxs, lines.length];
    for (const cut of cuts) {
      const chunk = normalizeText(lines.slice(from, cut).join("\n"));
      from = cut + 1;
      if (!chunk) continue;
      // title: first heading or first line
      const m = chunk.match(/^#{1,3}\s+(.+)$/m);
      const title = m?.[1] ? String(m[1]).trim().slice(0, 80) : String(chunk.split("\n").find((x) => x.trim()) ?? "").trim().slice(0, 80);
      out.push({ entryIndex: out.length, ...(title ? { title } : {}), text: chunk });
    }
    if (out.length >= 2) return out;
  }

  return [{ entryIndex: 0, text: raw }];
}

function guessTitle(args: { format: KbFormat; relPath?: string; absPath?: string; url?: string; text: string }) {
  const text = args.text;
  // Markdown: first heading
  if (args.format === "md" || args.format === "mdx") {
    const m = text.match(/^#{1,3}\s+(.+)$/m);
    if (m?.[1]) return String(m[1]).trim().slice(0, 80);
  }
  // First non-empty line
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (first) return first.slice(0, 80);
  // Fallback: filename
  const p = args.relPath ?? args.absPath ?? args.url ?? "untitled";
  const parts = p.replaceAll("\\", "/").split("/");
  const base = parts[parts.length - 1] ?? p;
  return base.slice(0, 80);
}

function normalizeEntryIndex(entryIndex: any): number {
  const n = Number(entryIndex);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function entryIndexFromImportedFrom(src: ImportedFrom): number {
  return normalizeEntryIndex((src as any)?.entryIndex);
}

function sameImportedFrom(a: ImportedFrom, b: ImportedFrom): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  const ai = entryIndexFromImportedFrom(a);
  const bi = entryIndexFromImportedFrom(b);
  if (ai !== bi) return false;
  if (a.kind === "project") return String((a as any).relPath ?? "") === String((b as any).relPath ?? "");
  if (a.kind === "file") return String((a as any).absPath ?? "") === String((b as any).absPath ?? "");
  if (a.kind === "url") {
    const au = canonicalizeUrlForDedup(String((a as any).url ?? ""));
    const bu = canonicalizeUrlForDedup(String((b as any).url ?? ""));
    return au && bu ? au === bu : String((a as any).url ?? "") === String((b as any).url ?? "");
  }
  return false;
}

function guessTitleFromImportedFrom(args: { format: KbFormat; importedFrom: ImportedFrom; text: string }) {
  const src = args.importedFrom;
  return guessTitle({
    format: args.format,
    ...(src.kind === "project" ? { relPath: src.relPath } : {}),
    ...(src.kind === "file" ? { absPath: src.absPath } : {}),
    ...(src.kind === "url" ? { url: src.url } : {}),
    text: args.text,
  });
}

function findExistingSourceDocByImportedFrom(args: { db: KbDb; libId: string; importedFrom: ImportedFrom }): KbSourceDoc | undefined {
  const libId = String(args.libId ?? "").trim();
  if (!libId) return undefined;
  const importedFrom = args.importedFrom;
  return args.db.sourceDocs.find((d) => String(d.libraryId ?? "").trim() === libId && sameImportedFrom(d.importedFrom as any, importedFrom));
}

async function ingestEntryToDb(args: {
  baseDir: string;
  ownerKey: string;
  db: KbDb;
  libId: string;
  format: KbFormat;
  importedFrom: ImportedFrom;
  entryText: string;
  contentHash: string;
  titleHint?: string;
  entryTitle?: string;
}): Promise<{ docId: string; imported: boolean; skippedReason?: string }> {
  const baseDir = args.baseDir;
  const ownerKey = args.ownerKey;
  const db = args.db;
  const libId = String(args.libId ?? "").trim();
  const format = args.format;
  const entryText = normalizeText(args.entryText);
  const contentHash = String(args.contentHash ?? "").trim();

  const existing = findExistingSourceDocByImportedFrom({ db, libId, importedFrom: args.importedFrom });
  if (existing && String(existing.contentHash ?? "") === contentHash) {
    return { docId: existing.id, imported: false, skippedReason: "duplicate_same_hash" };
  }

  const id = existing?.id ?? makeId("kb_doc");
  const now = nowIso();
  const title =
    String(args.entryTitle ?? "").trim() ||
    String(args.titleHint ?? "").trim() ||
    guessTitleFromImportedFrom({ format, importedFrom: args.importedFrom, text: entryText });

  const doc: KbSourceDoc = {
    id,
    libraryId: libId,
    title,
    format,
    importedFrom: args.importedFrom,
    contentHash,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // upsert doc
  db.sourceDocs = [...db.sourceDocs.filter((x) => x.id !== id), doc];
  // rebuild artifacts for this doc
  db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== id);
  db.artifacts.push(...buildArtifacts({ format, sourceDocId: id, text: entryText }));

  // 断点续传：每条 entry 都落盘一次
  await saveDb({ baseDir, ownerKey, db });

  return { docId: id, imported: true };
}

function extToFormat(pathLike: string): KbFormat {
  const p = String(pathLike ?? "").toLowerCase();
  if (p.endsWith(".md")) return "md";
  if (p.endsWith(".mdx")) return "mdx";
  if (p.endsWith(".txt")) return "txt";
  if (p.endsWith(".docx")) return "docx";
  if (p.endsWith(".pdf")) return "pdf";
  return "unknown";
}

function sanitizeOwnerKey(ownerKey: string) {
  const s = String(ownerKey ?? "").trim();
  if (!s) return "local_anonymous";
  // Windows-friendly
  return s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 80) || "local_anonymous";
}

function normalizeLibraryPurpose(purpose: any): "material" | "style" | "product" {
  const s = String(purpose ?? "").trim();
  if (s === "style") return "style";
  if (s === "product") return "product";
  return "material";
}

function libraryMissingError(db: KbDb, libId: string) {
  const id = String(libId ?? "").trim();
  if (!id) return "LIBRARY_NOT_FOUND";
  const inTrash = Array.isArray((db as any)?.trash) && (db.trash ?? []).some((x: any) => String(x?.library?.id ?? "").trim() === id);
  return inTrash ? "LIBRARY_IN_TRASH" : "LIBRARY_NOT_FOUND";
}

function dbRelPath(ownerKey: string) {
  const key = sanitizeOwnerKey(ownerKey);
  return `writing-ide-kb/owners/${key}/kb.v1.json`;
}

async function loadDb(args: { baseDir: string; ownerKey: string }): Promise<KbDb> {
  const api = window.desktop?.fs;
  if (!api) throw new Error("NO_FS_API");
  const rel = dbRelPath(args.ownerKey);
  try {
    const res = await api.readFile(args.baseDir, rel);
    if (!res?.ok) throw new Error(res?.error ?? "READ_FAILED");
    const raw = String(res.content ?? "");
    const parsed = JSON.parse(raw);
    // Minimal validation + forwards compatibility + migration(v1 -> v2: libraries/trash/libraryId)
    const t = nowIso();
    const rawSourceDocs: any[] = Array.isArray(parsed?.sourceDocs) ? parsed.sourceDocs : [];
    const rawArtifacts: any[] = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
    const rawLibs: any[] = Array.isArray(parsed?.libraries) ? parsed.libraries : [];
    const rawTrash: any[] = Array.isArray(parsed?.trash) ? parsed.trash : [];
    const rawFingerprints: any[] = Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : [];
    const rawLibraryPrefs = (parsed as any)?.libraryPrefs;
    const libraryPrefs =
      rawLibraryPrefs && typeof rawLibraryPrefs === "object" && !Array.isArray(rawLibraryPrefs) ? (rawLibraryPrefs as any) : {};

    const libs: KbLibrary[] = rawLibs
      .map((x) => ({
        id: String(x?.id ?? "").trim(),
        name: String(x?.name ?? "").trim(),
        purpose: normalizeLibraryPurpose(x?.purpose),
        facetPackId: normalizeFacetPackId(x?.facetPackId),
        createdAt: String(x?.createdAt ?? t),
        updatedAt: String(x?.updatedAt ?? t),
      }))
      .filter((x) => x.id && x.name);

    const trash: KbLibraryTrashItem[] = rawTrash
      .map((x) => {
        const lib = x?.library ?? x;
        const library: KbLibrary = {
          id: String(lib?.id ?? "").trim(),
          name: String(lib?.name ?? "").trim(),
          purpose: normalizeLibraryPurpose(lib?.purpose),
          facetPackId: normalizeFacetPackId(lib?.facetPackId),
          createdAt: String(lib?.createdAt ?? t),
          updatedAt: String(lib?.updatedAt ?? t),
        };
        const deletedAt = String(x?.deletedAt ?? t);
        if (!library.id || !library.name) return null;
        return { library, deletedAt } as KbLibraryTrashItem;
      })
      .filter(Boolean) as any;

    // migration: if no libraries provided, create a migrated library to hold existing docs
    const migratedLibId = "kb_lib_migrated";
    const ensuredLibs: KbLibrary[] =
      libs.length > 0
        ? (libs as KbLibrary[])
        : rawSourceDocs.length > 0
          ? ([
              {
                id: migratedLibId,
                name: "历史导入",
                purpose: "material" as const,
                facetPackId: "speech_marketing_v1",
                createdAt: t,
                updatedAt: t,
              },
            ] as KbLibrary[])
          : [];

    const sourceDocs: KbSourceDoc[] = rawSourceDocs.map((d) => {
      const id = String(d?.id ?? "").trim() || makeId("kb_doc");
      const libraryId = String(d?.libraryId ?? "").trim() || (ensuredLibs[0]?.id ?? "");
      return {
        id,
        libraryId,
        title: String(d?.title ?? "").trim() || id,
        format: (String(d?.format ?? "unknown") as any) || "unknown",
        importedFrom: d?.importedFrom as any,
        contentHash: String(d?.contentHash ?? ""),
        createdAt: String(d?.createdAt ?? t),
        updatedAt: String(d?.updatedAt ?? t),
      };
    });

    const db: KbDb = {
      version: 4,
      ownerKey: String(parsed?.ownerKey ?? args.ownerKey),
      createdAt: String(parsed?.createdAt ?? t),
      updatedAt: String(parsed?.updatedAt ?? t),
      libraries: ensuredLibs,
      trash,
      sourceDocs,
      artifacts: (rawArtifacts as any[]).map((a: any) => {
        const embeddingsRaw = a?.embeddings;
        const embeddings =
          embeddingsRaw && typeof embeddingsRaw === "object" && !Array.isArray(embeddingsRaw) ? (embeddingsRaw as any) : undefined;
        return { ...a, embeddings } as KbArtifact;
      }) as any,
      libraryPrefs,
      fingerprints: rawFingerprints
        .map((x: any) => {
          const id = String(x?.id ?? "").trim();
          const libraryId = String(x?.libraryId ?? "").trim();
          if (!id || !libraryId) return null;
          return x as KbLibraryFingerprintSnapshot;
        })
        .filter(Boolean) as any,
    };
    return db;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // File not exists -> new db
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      const t = nowIso();
      return {
        version: 4,
        ownerKey: args.ownerKey,
        createdAt: t,
        updatedAt: t,
        libraries: [],
        trash: [],
        sourceDocs: [],
        artifacts: [],
        libraryPrefs: {},
        fingerprints: [],
      };
    }
    // Bad JSON -> start new db (avoid bricking)
    const t = nowIso();
    return {
      version: 4,
      ownerKey: args.ownerKey,
      createdAt: t,
      updatedAt: t,
      libraries: [],
      trash: [],
      sourceDocs: [],
      artifacts: [],
      libraryPrefs: {},
      fingerprints: [],
    };
  }
}

async function saveDb(args: { baseDir: string; ownerKey: string; db: KbDb }): Promise<void> {
  const api = window.desktop?.fs;
  if (!api) throw new Error("NO_FS_API");
  const rel = dbRelPath(args.ownerKey);
  const next: KbDb = { ...args.db, updatedAt: nowIso() };
  const json = JSON.stringify(next, null, 2);
  const res = await api.writeFile(args.baseDir, rel, json);
  if (!res?.ok) throw new Error(res?.error ?? "WRITE_FAILED");
}

function computeLibraryStats(db: KbDb) {
  const activeIds = new Set(db.libraries.map((l) => l.id));
  const docCountByLib = new Map<string, number>();
  const updatedAtByLib = new Map<string, string>();
  for (const d of db.sourceDocs) {
    const id = String(d.libraryId ?? "").trim();
    if (!id) continue;
    if (!activeIds.has(id)) continue;
    docCountByLib.set(id, (docCountByLib.get(id) ?? 0) + 1);
    const prev = updatedAtByLib.get(id) ?? "";
    const cur = String(d.updatedAt ?? "");
    if (cur && cur > prev) updatedAtByLib.set(id, cur);
  }

  const trashIds = new Set(db.trash.map((x) => x.library.id));
  const docCountByTrash = new Map<string, number>();
  for (const d of db.sourceDocs) {
    const id = String(d.libraryId ?? "").trim();
    if (!id) continue;
    if (!trashIds.has(id)) continue;
    docCountByTrash.set(id, (docCountByTrash.get(id) ?? 0) + 1);
  }

  return { docCountByLib, updatedAtByLib, docCountByTrash };
}

function latestFingerprintByLib(db: KbDb) {
  const map = new Map<string, KbLibraryFingerprintSnapshot>();
  for (const fp of db.fingerprints ?? []) {
    const libId = String((fp as any)?.libraryId ?? "").trim();
    if (!libId) continue;
    const prev = map.get(libId);
    if (!prev || String((fp as any)?.computedAt ?? "") > String((prev as any)?.computedAt ?? "")) {
      map.set(libId, fp as any);
    }
  }
  return map;
}

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function isPlaybookDoc(d: KbSourceDoc) {
  const rel = String(d.importedFrom?.kind === "project" ? (d.importedFrom as any).relPath ?? "" : "").trim();
  return rel.startsWith("__kb_playbook__/library/");
}

function normalizeTextForStats(text: string) {
  return String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitSentences(text: string) {
  const t = normalizeTextForStats(text);
  const parts = t
    .split(/[\n。！？!?]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : t.trim() ? [t.trim()] : [];
}

function countCharsBySet(text: string, set: Set<string>) {
  let n = 0;
  for (const ch of text) if (set.has(ch)) n += 1;
  return n;
}

function countRegex(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function computeTextFingerprintStats(text: string) {
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
      // “每100句”
      questionRatePer100Sentences: Number(questionRatePer100Sentences.toFixed(2)),
      exclaimRatePer100Sentences: Number(exclaimRatePer100Sentences.toFixed(2)),
      avgSentenceLen: Number(avgSentenceLen.toFixed(2)),
      shortSentenceRate: Number(clamp01(shortSentenceRate).toFixed(4)),
      // “每1000字”
      firstPersonPer1kChars: Number(firstPersonPer1kChars.toFixed(2)),
      secondPersonPer1kChars: Number(secondPersonPer1kChars.toFixed(2)),
      particlePer1kChars: Number(particlePer1kChars.toFixed(2)),
      digitPer1kChars: Number(digitPer1kChars.toFixed(2)),
    },
  };
}

function buildDocTextFromParagraphArtifacts(args: { docId: string; artifacts: KbArtifact[] }) {
  const normalizePara = (raw: string) => {
    let s = normalizeTextForStats(raw).trim();
    if (!s) return "";
    // 常见拼接稿格式的元信息/分隔符：不纳入“声音指纹”
    if (/^-{3,}$/.test(s)) return "";
    if (/^标题[:：]/.test(s)) return "";
    if (/^文案[:：]/.test(s)) {
      s = s.replace(/^文案[:：]\s*/, "").trim();
      if (!s) return "";
    }
    return s;
  };

  const paras = args.artifacts
    .filter((a) => a.sourceDocId === args.docId && a.kind === "paragraph")
    .sort((a, b) => (Number(a.anchor?.paragraphIndex ?? 0) || 0) - (Number(b.anchor?.paragraphIndex ?? 0) || 0))
    .map((a) => normalizePara(String(a.content ?? "")))
    .filter(Boolean);
  return paras.join("\n");
}

function buildDocSegmentsFromParagraphArtifacts(args: {
  sourceDocId: string;
  sourceDocTitle: string;
  paragraphs: KbArtifact[];
  maxSegments?: number;
  maxCharsPerSegment?: number;
}): Array<{ segmentId: string; sourceDocId: string; sourceDocTitle: string; paragraphIndexStart: number | null; text: string }> {
  const maxSegments = Math.max(1, Math.min(200, Number(args.maxSegments ?? 80)));
  const maxChars = Math.max(800, Math.min(20_000, Number(args.maxCharsPerSegment ?? 8000)));

  const norm = (raw: string) => normalizeTextForStats(raw).trim();
  const isSep = (s: string) => /^-{3,}$/.test(s);
  const isTitle = (s: string) => /^标题[:：]/.test(s);
  const isScript = (s: string) => /^文案[:：]/.test(s);
  const stripScript = (s: string) => s.replace(/^文案[:：]\s*/, "").trim();

  const segments: Array<{ segmentId: string; sourceDocId: string; sourceDocTitle: string; paragraphIndexStart: number | null; text: string }> = [];
  let segIdx = 0;
  let buf: string[] = [];
  let bufChars = 0;
  let startPi: number | null = null;

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    bufChars = 0;
    const pi0 = startPi;
    startPi = null;
    if (!text) return;
    segments.push({
      segmentId: `${args.sourceDocId}#seg${segIdx++}`,
      sourceDocId: args.sourceDocId,
      sourceDocTitle: args.sourceDocTitle,
      paragraphIndexStart: pi0,
      text,
    });
  };

  for (const a of args.paragraphs.slice()) {
    if (a.kind !== "paragraph") continue;
    const raw = norm(String(a.content ?? ""));
    if (!raw) continue;

    const pi = typeof (a.anchor as any)?.paragraphIndex === "number" ? Number((a.anchor as any).paragraphIndex) : null;

    // 分隔符/标题：视为边界，但不纳入文本
    if (isSep(raw) || isTitle(raw)) {
      flush();
      continue;
    }

    // “文案：”前缀：剥离标签，保留正文；同时视为“新稿开始”的强信号（若前面已有内容则先切段）
    if (isScript(raw)) {
      if (buf.length) flush();
      const t = stripScript(raw);
      if (!t) continue;
      if (startPi === null && pi !== null) startPi = pi;
      buf.push(t);
      bufChars += t.length + 1;
    } else {
      if (startPi === null && pi !== null) startPi = pi;
      buf.push(raw);
      bufChars += raw.length + 1;
    }

    // 超长兜底切分：避免单段过大导致“样本单元=1”
    if (bufChars >= maxChars) flush();
    if (segments.length >= maxSegments) break;
  }
  flush();

  return segments;
}

function computeTopNgrams(args: { docs: Array<{ docId: string; text: string }>; maxItems?: number }) {
  const maxItems = Math.max(6, Math.min(32, Number(args.maxItems ?? 12)));
  const totalChars = args.docs.reduce((a, d) => a + (d.text?.length ?? 0), 0) || 0;
  const totalDocs = args.docs.length || 0;

  const totalCounts = new Map<string, { n: number; count: number; docs: Set<string> }>();
  const segRe = /[0-9A-Za-z\u4e00-\u9fff]+/g;

  for (const d of args.docs) {
    const text = normalizeTextForStats(d.text);
    const seenInDoc = new Set<string>();
    const segs = text.match(segRe) ?? [];
    for (const seg of segs) {
      const s = seg.trim();
      if (s.length < 2) continue;
      const L = s.length;
      for (let n = 2; n <= 6; n += 1) {
        if (L < n) continue;
        for (let i = 0; i <= L - n; i += 1) {
          const g = s.slice(i, i + n);
          // 过滤纯数字 ngram，噪声太大
          if (/^\d+$/.test(g)) continue;
          const key = `${n}:${g}`;
          const rec = totalCounts.get(key) ?? { n, count: 0, docs: new Set<string>() };
          rec.count += 1;
          totalCounts.set(key, rec);
          seenInDoc.add(key);
        }
      }
    }
    for (const key of seenInDoc) {
      const rec = totalCounts.get(key);
      if (rec) rec.docs.add(d.docId);
    }
  }

  const items = Array.from(totalCounts.entries())
    .map(([key, v]) => {
      const text = key.split(":").slice(1).join(":");
      const per1kChars = totalChars ? (v.count / totalChars) * 1000 : 0;
      const docCoverageCount = v.docs.size;
      const docCoverage = totalDocs ? docCoverageCount / totalDocs : 0;
      return { n: v.n, text, per1kChars, docCoverage: Number(docCoverage.toFixed(3)), docCoverageCount };
    })
    .sort((a, b) => b.per1kChars - a.per1kChars)
    .slice(0, maxItems)
    .map((x) => ({ ...x, per1kChars: Number(x.per1kChars.toFixed(3)) }));

  return items;
}

function computeStability(args: { perDoc: Array<{ docId: string; stats: any; chars: number; sentences: number }> }): {
  level: KbFingerprintStabilityLevel;
  note?: string;
  outlierDocIds?: string[];
} {
  const docs = args.perDoc;
  if (docs.length <= 1) {
    return { level: "medium", note: "样本不足：仅 1 个样本单元，稳定性无法评估；建议增加样本或先做切分后再体检" };
  }

  const keys = ["questionRatePer100Sentences", "avgSentenceLen", "particlePer1kChars"];
  const valuesByKey = new Map<string, number[]>();
  for (const k of keys) valuesByKey.set(k, []);
  for (const d of docs) {
    for (const k of keys) valuesByKey.get(k)!.push(Number(d.stats?.[k] ?? 0));
  }
  const cv = (arr: number[]) => {
    const n = arr.length || 1;
    const mean = arr.reduce((a, x) => a + x, 0) / n;
    const var0 = arr.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
    const sd = Math.sqrt(var0);
    if (!mean) return sd;
    return sd / Math.abs(mean);
  };
  const cvs = keys.map((k) => cv(valuesByKey.get(k) ?? []));
  const score = cvs.reduce((a, x) => a + Math.min(2, x), 0) / cvs.length;

  const level: KbFingerprintStabilityLevel = score < 0.25 ? "high" : score < 0.55 ? "medium" : "low";
  const note =
    level === "high"
      ? "库内写法较一致（节奏/问句/口头语波动小）"
      : level === "medium"
        ? "有一定混合体裁/写法波动（建议关注离群文档或分库）"
        : "明显混合体裁/写法（建议分库或先修离群文档）";

  // outliers（粗略）：任意关键指标偏离均值 2σ
  const outliers = new Set<string>();
  for (const k of keys) {
    const arr = valuesByKey.get(k) ?? [];
    const n = arr.length || 1;
    const mean = arr.reduce((a, x) => a + x, 0) / n;
    const var0 = arr.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
    const sd = Math.sqrt(var0);
    if (!sd) continue;
    docs.forEach((d, i) => {
      const v = Number(d.stats?.[k] ?? 0);
      if (Math.abs(v - mean) >= 2 * sd) outliers.add(d.docId);
    });
  }

  return { level, note, outlierDocIds: Array.from(outliers) };
}

function meanStd(arr: number[]) {
  const n = arr.length || 1;
  const mean = arr.reduce((a, x) => a + x, 0) / n;
  const var0 = arr.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
  const sd = Math.sqrt(var0) || 1;
  return { mean, sd };
}

function quantile(arr: number[], q: number) {
  const xs = arr.slice().sort((a, b) => a - b);
  if (!xs.length) return 0;
  const t = Math.max(0, Math.min(1, q));
  const pos = (xs.length - 1) * t;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  const w = pos - lo;
  return xs[lo] * (1 - w) + xs[hi] * w;
}

function dist2(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function kmeansDeterministic(vectors: number[][], k: 2 | 3): { ok: true; assign: number[]; centroids: number[][] } | { ok: false } {
  if (vectors.length < k) return { ok: false };
  const dim = vectors[0]?.length ?? 0;
  if (dim <= 0) return { ok: false };

  // init by min/max on dim0 (avgSentenceLen after z-score)
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < vectors.length; i += 1) {
    if (vectors[i][0] < vectors[minI][0]) minI = i;
    if (vectors[i][0] > vectors[maxI][0]) maxI = i;
  }
  const centroids: number[][] = [vectors[minI].slice(), vectors[maxI].slice()];
  if (k === 3) {
    let bestI = 0;
    let best = -Infinity;
    for (let i = 0; i < vectors.length; i += 1) {
      if (i === minI || i === maxI) continue;
      const v = vectors[i];
      const d = Math.min(dist2(v, centroids[0]), dist2(v, centroids[1]));
      if (d > best) {
        best = d;
        bestI = i;
      }
    }
    centroids.push(vectors[bestI].slice());
  }

  const assign = new Array(vectors.length).fill(0);
  for (let iter = 0; iter < 30; iter += 1) {
    let changed = 0;
    for (let i = 0; i < vectors.length; i += 1) {
      const v = vectors[i];
      let bestK = 0;
      let bestD = dist2(v, centroids[0]);
      for (let j = 1; j < k; j += 1) {
        const d = dist2(v, centroids[j]);
        if (d < bestD) {
          bestD = d;
          bestK = j;
        }
      }
      if (assign[i] !== bestK) {
        assign[i] = bestK;
        changed += 1;
      }
    }

    const sums: number[][] = new Array(k).fill(0).map(() => new Array(dim).fill(0));
    const counts: number[] = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i += 1) {
      const a = assign[i];
      counts[a] += 1;
      const v = vectors[i];
      for (let d = 0; d < dim; d += 1) sums[a][d] += v[d];
    }
    if (counts.some((c) => c === 0)) return { ok: false };
    for (let j = 0; j < k; j += 1) centroids[j] = sums[j].map((x) => x / counts[j]);
    if (changed === 0) break;
  }

  return { ok: true, assign, centroids };
}

function stableJson(x: any) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x ?? "");
  }
}

function chunkParagraphsForExtraction(args: {
  paragraphs: Array<{ index: number; text: string; headingPath?: string[] }>;
  // 质量模式：尽量覆盖全文但控制请求规模
  maxChunks: number;
  maxParasPerChunk: number;
  maxCharsPerChunk: number;
  overlapParas: number;
}): Array<Array<{ index: number; text: string; headingPath?: string[] }>> {
  const paras = Array.isArray(args.paragraphs) ? args.paragraphs.slice(0) : [];
  if (!paras.length) return [];

  const normText = (s: string) => String(s ?? "").trim();
  const cleaned = paras
    .map((p) => ({ ...p, text: normText(p.text) }))
    .filter((p) => p.text);
  if (!cleaned.length) return [];

  // 先按 headingPath（章节）聚合连续段落
  type Section = { key: string; items: Array<{ index: number; text: string; headingPath?: string[] }>; chars: number };
  const sections: Section[] = [];
  for (const p of cleaned) {
    const key = Array.isArray(p.headingPath) && p.headingPath.length ? p.headingPath.join(" > ") : "";
    const chars = p.text.length;
    const last = sections[sections.length - 1];
    if (last && last.key === key) {
      last.items.push(p);
      last.chars += chars;
    } else {
      sections.push({ key, items: [p], chars });
    }
  }

  const chunks: Array<Array<{ index: number; text: string; headingPath?: string[] }>> = [];
  const pushChunk = (items: Array<{ index: number; text: string; headingPath?: string[] }>) => {
    const uniq: Array<{ index: number; text: string; headingPath?: string[] }> = [];
    const seen = new Set<number>();
    for (const it of items) {
      const idx = Number(it.index);
      if (!Number.isFinite(idx)) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      uniq.push(it);
    }
    if (uniq.length) chunks.push(uniq);
  };

  // 顺序装箱：尽量保持章节完整；超限则拆分章节
  let buf: Array<{ index: number; text: string; headingPath?: string[] }> = [];
  let bufChars = 0;
  const flush = () => {
    if (!buf.length) return;
    pushChunk(buf);
    buf = [];
    bufChars = 0;
  };

  for (const sec of sections) {
    if (!sec.items.length) continue;
    // 如果单个 section 就过大：按段落拆
    const secTooBig = sec.items.length > args.maxParasPerChunk || sec.chars > args.maxCharsPerChunk;
    if (!secTooBig) {
      const wouldParas = buf.length + sec.items.length;
      const wouldChars = bufChars + sec.chars;
      if (buf.length && (wouldParas > args.maxParasPerChunk || wouldChars > args.maxCharsPerChunk)) flush();
      buf.push(...sec.items);
      bufChars += sec.chars;
      continue;
    }

    // flush existing buffer first
    if (buf.length) flush();

    let sub: Array<{ index: number; text: string; headingPath?: string[] }> = [];
    let subChars = 0;
    for (const p of sec.items) {
      const wouldParas = sub.length + 1;
      const wouldChars = subChars + p.text.length;
      if (sub.length && (wouldParas > args.maxParasPerChunk || wouldChars > args.maxCharsPerChunk)) {
        pushChunk(sub);
        sub = [];
        subChars = 0;
      }
      sub.push(p);
      subChars += p.text.length;
    }
    if (sub.length) pushChunk(sub);
  }
  if (buf.length) flush();

  if (!chunks.length) return [];

  // 加 overlap：每块前面附带前一块末尾若干段（保持语境连续）
  const overlapped = chunks.map((c, i) => {
    if (i === 0 || args.overlapParas <= 0) return c;
    const prev = chunks[i - 1]!;
    const tail = prev.slice(Math.max(0, prev.length - args.overlapParas));
    return [...tail, ...c];
  });

  // 太多块时：保留首尾覆盖 + 采样中间
  if (overlapped.length <= args.maxChunks) return overlapped;
  const max = Math.max(2, args.maxChunks);
  const keep = new Set<number>();
  keep.add(0);
  keep.add(overlapped.length - 1);
  if (max >= 4) {
    keep.add(1);
    keep.add(overlapped.length - 2);
  }
  while (keep.size < max) {
    const need = max - keep.size;
    const candidates: number[] = [];
    for (let i = 2; i <= overlapped.length - 3; i += 1) if (!keep.has(i)) candidates.push(i);
    if (!candidates.length) break;
    // 均匀取样
    for (let k = 0; k < need; k += 1) {
      const idx = Math.floor((k * candidates.length) / Math.max(1, need));
      keep.add(candidates[Math.min(candidates.length - 1, idx)]!);
      if (keep.size >= max) break;
    }
    break;
  }
  return Array.from(keep)
    .sort((a, b) => a - b)
    .map((i) => overlapped[i]!)
    .filter(Boolean);
}

function scoreDocV2CardForPick(c: any) {
  const t = String(c?.cardType ?? "").trim();
  const title = String(c?.title ?? "").trim();
  const content = String(c?.content ?? "").trim();
  const pi = Array.isArray(c?.paragraphIndices) ? c.paragraphIndices.length : 0;
  const base =
    t === "outline"
      ? 5000
      : t === "hook"
        ? 4200
        : t === "thesis"
          ? 3800
          : t === "ending"
            ? 3600
            : t === "one_liner"
              ? 2000
              : 1000;
  return base + Math.min(200, title.length) + Math.min(800, content.length) + Math.min(200, pi * 20);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  const s = Math.max(1, Math.floor(size));
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

function parseMarkdownToArtifacts(args: { sourceDocId: string; text: string }): KbArtifact[] {
  const text = args.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = text.split("\n");

  type Heading = { level: number; text: string };
  const headingStack: Heading[] = [];
  const artifacts: KbArtifact[] = [];

  let paragraphIndex = 0;
  let buffer: string[] = [];

  const flushParagraph = () => {
    const raw = buffer.join("\n").trim();
    buffer = [];
    if (!raw) return;
    const anchor: KbAnchor = {
      headingPath: headingStack.map((h) => h.text),
      paragraphIndex,
    };
    paragraphIndex += 1;
    artifacts.push({
      id: makeId("kb_art"),
      sourceDocId: args.sourceDocId,
      kind: "paragraph",
      content: raw,
      facetIds: [],
      anchor,
    });
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      flushParagraph();
      const level = m[1].length;
      const ht = String(m[2] ?? "").trim();
      // maintain stack
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: ht });
      artifacts.push({
        id: makeId("kb_art"),
        sourceDocId: args.sourceDocId,
        kind: "outline",
        content: headingStack.map((h) => h.text).join(" > "),
        facetIds: [],
        anchor: { headingPath: headingStack.map((h) => h.text) },
      });
      continue;
    }

    // blank line: paragraph boundary
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    buffer.push(line);
  }
  flushParagraph();
  return artifacts;
}

function parsePlainTextToArtifacts(args: { sourceDocId: string; text: string }): KbArtifact[] {
  const parts = args.text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.map((p, idx) => ({
    id: makeId("kb_art"),
    sourceDocId: args.sourceDocId,
    kind: "paragraph" as const,
    content: p,
    facetIds: [],
    anchor: { paragraphIndex: idx },
  }));
}

function buildArtifacts(args: { format: KbFormat; sourceDocId: string; text: string }): KbArtifact[] {
  if (args.format === "md" || args.format === "mdx") return parseMarkdownToArtifacts({ sourceDocId: args.sourceDocId, text: args.text });
  return parsePlainTextToArtifacts({ sourceDocId: args.sourceDocId, text: args.text });
}

function gatewayBaseUrl() {
  // 与 AgentPane 的策略一致：
  // - dev：返回 ""，让 fetch 走相对 /api（Vite proxy）
  // - packaged(app://)：必须走绝对地址，否则会变成 app://-/api/... → net::ERR_FILE_NOT_FOUND
  // - 支持 localStorage 覆盖（writing-ide.gatewayUrl）
  return getGatewayBaseUrl();
}

async function postExtractCards(args: {
  model?: string;
  maxCards?: number;
  mode?: "generic" | "doc_v2";
  paragraphs: Array<{ index: number; text: string; headingPath?: string[] }>;
  facetIds?: string[];
  signal?: AbortSignal;
}): Promise<{ ok: true; cards: any[] } | { ok: false; error: string }> {
  const base = gatewayBaseUrl();
  const url = base ? `${base}/api/kb/dev/extract_cards` : "/api/kb/dev/extract_cards";
  if (!ensureLoginForKbLlm("生成风格手册/抽卡")) return { ok: false, error: "AUTH_REQUIRED" };
  const auth = authHeader();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      signal: args.signal,
      body: JSON.stringify({
        model: args.model,
        maxCards: args.maxCards,
        mode: args.mode,
        facetIds: Array.isArray(args.facetIds) ? args.facetIds : undefined,
        paragraphs: args.paragraphs,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text || `HTTP_${res.status}`;
      try {
        const j = JSON.parse(text);
        if (typeof j?.message === "string") msg = j.message;
        else if (typeof j?.error?.message === "string") msg = j.error.message;
      } catch {
        // ignore
      }
      return { ok: false, error: msg };
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok || !Array.isArray(json?.cards)) return { ok: false, error: "INVALID_RESPONSE" };
    return { ok: true, cards: json.cards };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function postBuildLibraryPlaybook(args: {
  model?: string;
  mode?: "lite" | "full";
  part?: "full" | "facets";
  facetIds: string[];
  docs: Array<{
    id: string;
    title: string;
    items: Array<{ cardType: string; title?: string; content: string; paragraphIndices: number[]; facetIds?: string[] }>;
  }>;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; styleProfile: any; playbookFacets: any[] }
  | { ok: false; error: string }
> {
  const base = gatewayBaseUrl();
  const url = base ? `${base}/api/kb/dev/build_library_playbook` : "/api/kb/dev/build_library_playbook";
  if (!ensureLoginForKbLlm("生成风格手册/仿写手册")) return { ok: false, error: "AUTH_REQUIRED" };
  const auth = authHeader();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      signal: args.signal,
      body: JSON.stringify({
        model: args.model,
        mode: args.mode,
        part: args.part,
        facetIds: args.facetIds,
        docs: args.docs,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text || `HTTP_${res.status}`;
      try {
        const j = JSON.parse(text);
        if (typeof j?.message === "string") msg = j.message;
        else if (typeof j?.error?.message === "string") msg = j.error.message;
        else if (typeof j?.error === "string") {
          const hint = typeof j?.hint === "string" ? String(j.hint) : "";
          const detail = typeof j?.detail === "string" ? String(j.detail) : "";
          msg = hint ? `${j.error}: ${hint}` : String(j.error);
          if (detail && detail !== hint) msg += `\n${detail}`;
        }
      } catch {
        // ignore
      }
      const baseHint = base ? `gateway=${base}` : "gateway=同源(/api)";
      return { ok: false, error: `${msg}\n(${baseHint}, url=${url}, status=${res.status})` };
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok) return { ok: false, error: "INVALID_RESPONSE" };
    if (!json?.styleProfile || !Array.isArray(json?.playbookFacets)) return { ok: false, error: "INVALID_RESPONSE" };
    return { ok: true, styleProfile: json.styleProfile, playbookFacets: json.playbookFacets };
  } catch (e: any) {
    const baseHint = base ? `gateway=${base}` : "gateway=同源(/api)";
    const msg = String(e?.message ?? e);
    const cause = e?.cause ? String(e.cause?.message ?? e.cause) : "";
    const msgLower = msg.toLowerCase();
    const hint =
      msgLower === "fetch failed" || msgLower.includes("failed to fetch")
        ? "提示：这通常是网路/代理/证书/服务不可达导致。请确认 Gateway 可访问；若你在 dev 模式，确认本地 gateway 正在运行；若你连接远端，确认 VITE_GATEWAY_URL 正确。"
        : "";
    return { ok: false, error: `${msg}${cause ? `\nCAUSE: ${cause}` : ""}\n(${baseHint}, url=${url})${hint ? `\n${hint}` : ""}` };
  }
}

async function postFetchUrlForIngest(args: {
  url: string;
  timeoutMs?: number;
  maxChars?: number;
  format?: "markdown" | "text";
}): Promise<
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string | null;
      title: string | null;
      extractedBy: "fallback" | "not_html";
      fetchedAt: string;
      contentHash: string;
      extractedText?: string;
      extractedMarkdown?: string;
    }
  | { ok: false; error: string }
> {
  const base = gatewayBaseUrl();
  const endpoint = base ? `${base}/api/kb/dev/fetch_url_for_ingest` : "/api/kb/dev/fetch_url_for_ingest";
  if (!ensureLoginForKbLlm("导入 URL")) return { ok: false, error: "AUTH_REQUIRED" };
  const auth = authHeader();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        url: args.url,
        format: args.format ?? "text",
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = typeof json?.error === "string" ? String(json.error) : `HTTP_${res.status}`;
      return { ok: false, error: msg };
    }
    if (!json?.ok) return { ok: false, error: "INVALID_RESPONSE" };
    return json as any;
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function postBuildClusterRules(args: {
  model?: string;
  libraryName?: string;
  clusters: Array<{ clusterId: string; label?: string; evidence: Array<{ segmentId: string; quote: string }> }>;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; clusters: Array<{ clusterId: string; rules: any }>; upstream?: any }
  | { ok: false; error: string }
> {
  const base = gatewayBaseUrl();
  const url = base ? `${base}/api/kb/dev/build_cluster_rules` : "/api/kb/dev/build_cluster_rules";
  if (!ensureLoginForKbLlm("生成写法簇规则卡（values/lens）")) return { ok: false, error: "AUTH_REQUIRED" };
  const auth = authHeader();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      signal: args.signal,
      body: JSON.stringify({
        model: args.model,
        libraryName: args.libraryName,
        clusters: (args.clusters ?? []).slice(0, 3),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text || `HTTP_${res.status}`;
      try {
        const j = JSON.parse(text);
        if (typeof j?.message === "string") msg = j.message;
        else if (typeof j?.error?.message === "string") msg = j.error.message;
        else if (typeof j?.error === "string") {
          const hint = typeof j?.hint === "string" ? String(j.hint) : "";
          const detail = typeof j?.detail === "string" ? String(j.detail) : "";
          msg = hint ? `${j.error}: ${hint}` : String(j.error);
          if (detail && detail !== hint) msg += `\n${detail}`;
        }
      } catch {
        // ignore
      }
      const baseHint = base ? `gateway=${base}` : "gateway=同源(/api)";
      return { ok: false, error: `${msg}\n(${baseHint}, url=${url}, status=${res.status})` };
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok || !Array.isArray(json?.clusters)) return { ok: false, error: "INVALID_RESPONSE" };
    return { ok: true, clusters: json.clusters, upstream: json.upstream ?? undefined };
  } catch (e: any) {
    const baseHint = base ? `gateway=${base}` : "gateway=同源(/api)";
    const msg = String(e?.message ?? e);
    const cause = e?.cause ? String(e.cause?.message ?? e.cause) : "";
    const msgLower = msg.toLowerCase();
    const hint =
      msgLower === "fetch failed" || msgLower.includes("failed to fetch")
        ? "提示：这通常是网路/代理/证书/服务不可达导致。请确认 Gateway 可访问；若你在 dev 模式，确认本地 gateway 正在运行；若你连接远端，确认 VITE_GATEWAY_URL 正确。"
        : "";
    return { ok: false, error: `${msg}${cause ? `\nCAUSE: ${cause}` : ""}\n(${baseHint}, url=${url})${hint ? `\n${hint}` : ""}` };
  }
}

async function postClassifyGenre(args: {
  model?: string;
  stats?: Record<string, any>;
  samples: Array<{ docId: string; docTitle?: string; paragraphIndex?: number | null; text: string }>;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; primary: KbFingerprintGenre; candidates: KbFingerprintGenre[] }
  | { ok: false; error: string }
> {
  const base = gatewayBaseUrl();
  const url = base ? `${base}/api/kb/dev/classify_genre` : "/api/kb/dev/classify_genre";
  if (!ensureLoginForKbLlm("库体检/体裁识别")) return { ok: false, error: "AUTH_REQUIRED" };
  const auth = authHeader();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      signal: args.signal,
      body: JSON.stringify({
        model: args.model,
        stats: args.stats ?? null,
        samples: (args.samples ?? []).slice(0, 24),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text || `HTTP_${res.status}`;
      try {
        const j = JSON.parse(text);
        if (typeof j?.message === "string") msg = j.message;
        else if (typeof j?.error?.message === "string") msg = j.error.message;
        else if (typeof j?.error === "string") {
          const hint = typeof j?.hint === "string" ? String(j.hint) : "";
          const detail = typeof j?.detail === "string" ? String(j.detail) : "";
          msg = hint ? `${j.error}: ${hint}` : String(j.error);
          if (detail && detail !== hint) msg += `\n${detail}`;
        }
      } catch {
        // ignore
      }
      return { ok: false, error: msg };
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok || !json?.primary || !Array.isArray(json?.candidates)) return { ok: false, error: "INVALID_RESPONSE" };
    const primary: KbFingerprintGenre = {
      label: String(json.primary.label ?? "unknown"),
      confidence: Number(json.primary.confidence ?? 0),
      why: String(json.primary.why ?? ""),
      evidence: Array.isArray(json.primary.evidence) ? json.primary.evidence : undefined,
    };
    const candidates: KbFingerprintGenre[] = (json.candidates as any[])
      .map((c) => ({
        label: String(c?.label ?? "unknown"),
        confidence: Number(c?.confidence ?? 0),
        why: String(c?.why ?? ""),
        evidence: Array.isArray(c?.evidence) ? c.evidence : undefined,
      }))
      .filter((x) => x.label && Number.isFinite(x.confidence) && x.why);
    return { ok: true, primary, candidates: candidates.slice(0, 8) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function scoreArtifactText(args: { haystack: string; query: string }) {
  const q = String(args.query ?? "").trim().toLowerCase();
  if (!q) return { score: 0, idx: -1 };
  const h = String(args.haystack ?? "").toLowerCase();
  if (!h) return { score: 0, idx: -1 };

  // 兼容“多关键词/空格分隔”的 query：否则像 "中国 反制 日本 稀土" 在中文正文里几乎必然 0 命中
  // 性能：同一个 query 会在一次检索里被反复用于 N 个 artifact，做一个小缓存避免重复分词
  const queryPartsCache = (scoreArtifactText as any)._qCache as Map<string, string[]> | undefined;
  const cache: Map<string, string[]> =
    queryPartsCache ?? (((scoreArtifactText as any)._qCache = new Map<string, string[]>()) as Map<string, string[]>);
  let parts = cache.get(q);
  if (!parts) {
    const rawTokens = q.match(/[0-9a-z\u4e00-\u9fff]+/gi) ?? [];
    const tokens = rawTokens
      .map((s) => String(s ?? "").trim().toLowerCase())
      .filter(Boolean)
      .filter((s) => s.length >= 2); // 过滤过短 token（噪声大）
    parts = tokens.length ? Array.from(new Set(tokens)) : [q];
    cache.set(q, parts);
    // 简单限额：避免无限增长
    if (cache.size > 64) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
  }

  let score = 0;
  let bestIdx = -1;
  let hitCount = 0;
  for (const t of parts) {
    const idx = h.indexOf(t);
    if (idx < 0) continue;
    hitCount += 1;
    if (bestIdx < 0 || idx < bestIdx) bestIdx = idx;
    // 简单启发式：更早出现 + token 更长 => 更相关
    const early = Math.max(1, 900 - idx);
    const len = Math.min(120, t.length) * 6;
    score += early + len;
  }
  if (!hitCount) return { score: 0, idx: -1 };

  // 覆盖率加成：命中 token 越多越靠前
  const coverage = hitCount / Math.max(1, parts.length);
  score += Math.round(Math.min(1, coverage) * 800);
  return { score, idx: bestIdx };
}

function cosineSim(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  if (!den) return 0;
  return dot / den;
}

function getGatewayUrl() {
  return getGatewayBaseUrl();
}

function authHeader(): Record<string, string> {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function ensureLoginForKbLlm(why: string): boolean {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  if (token) return true;
  try {
    useAuthStore.getState().openLoginModal?.();
    useAuthStore.setState({ error: `请先登录再使用：${why}` });
  } catch {
    // ignore
  }
  return false;
}

async function fetchEmbedding(args: { model?: string; input: string }): Promise<{ ok: true; embedding: number[]; modelUsed?: string } | { ok: false; error: string }> {
  const gatewayUrl = getGatewayUrl();
  const url = gatewayUrl ? `${gatewayUrl}/api/llm/embeddings` : "/api/llm/embeddings";
  const auth = authHeader();
  if (!auth.Authorization) {
    try {
      useAuthStore.getState().openLoginModal?.();
      useAuthStore.setState({ error: "请先登录再使用 AI/知识库向量能力" });
    } catch {
      // ignore
    }
    return { ok: false, error: "AUTH_REQUIRED" };
  }
  try {
    const body: any = { input: args.input };
    if (args.model) body.model = args.model;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const code = json?.error ? String(json.error) : "";
      // 只处理真实的登录失效；避免把上游模型/代理 401（如 API key 无效）误判成“用户未登录”
      if (res.status === 401 && code === "UNAUTHORIZED") {
        try {
          useAuthStore.getState().logout?.();
          useAuthStore.getState().openLoginModal?.();
          useAuthStore.setState({ error: "请先登录再使用 AI/知识库向量能力" });
        } catch {
          // ignore
        }
      }
      const detail = json?.detail ? JSON.stringify(json.detail).slice(0, 300) : JSON.stringify(json).slice(0, 300);
      return { ok: false, error: `EMBEDDINGS_HTTP_${res.status}:${detail}` };
    }
    const emb = json?.data?.[0]?.embedding;
    if (!Array.isArray(emb)) return { ok: false, error: "EMBEDDINGS_INVALID_RESPONSE" };
    return { ok: true, embedding: emb.map((x: any) => Number(x)).filter((x: any) => Number.isFinite(x)), modelUsed: json?.modelUsed };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function fetchEmbeddingsBatch(args: {
  model?: string;
  inputs: string[];
}): Promise<{ ok: true; embeddings: number[][]; modelUsed?: string } | { ok: false; error: string }> {
  const gatewayUrl = getGatewayUrl();
  const url = gatewayUrl ? `${gatewayUrl}/api/llm/embeddings` : "/api/llm/embeddings";
  const auth = authHeader();
  if (!auth.Authorization) {
    try {
      useAuthStore.getState().openLoginModal?.();
      useAuthStore.setState({ error: "请先登录再使用 AI/知识库向量能力" });
    } catch {
      // ignore
    }
    return { ok: false, error: "AUTH_REQUIRED" };
  }
  const inputs = Array.isArray(args.inputs) ? args.inputs.map((s) => String(s ?? "")) : [];
  if (!inputs.length) return { ok: false, error: "EMBEDDINGS_EMPTY_INPUTS" };
  try {
    const body: any = { input: inputs };
    if (args.model) body.model = args.model;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const code = json?.error ? String(json.error) : "";
      if (res.status === 401 && code === "UNAUTHORIZED") {
        try {
          useAuthStore.getState().logout?.();
          useAuthStore.getState().openLoginModal?.();
          useAuthStore.setState({ error: "请先登录再使用 AI/知识库向量能力" });
        } catch {
          // ignore
        }
      }
      const detail = json?.detail ? JSON.stringify(json.detail).slice(0, 300) : JSON.stringify(json).slice(0, 300);
      return { ok: false, error: `EMBEDDINGS_HTTP_${res.status}:${detail}` };
    }
    const data = Array.isArray(json?.data) ? json.data : null;
    if (!data) return { ok: false, error: "EMBEDDINGS_INVALID_RESPONSE" };
    const embeddings = data
      .map((row: any) => (Array.isArray(row?.embedding) ? row.embedding : null))
      .map((emb: any) => (Array.isArray(emb) ? emb.map((x: any) => Number(x)).filter((x: any) => Number.isFinite(x)) : []));
    if (!embeddings.length) return { ok: false, error: "EMBEDDINGS_INVALID_RESPONSE" };
    return { ok: true, embeddings, modelUsed: json?.modelUsed };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function makeSnippet(args: { text: string; matchIndex: number; queryLen: number }) {
  const raw = args.text.replaceAll("\n", " ").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (args.matchIndex < 0) return raw.slice(0, 160);
  const start = Math.max(0, args.matchIndex - 40);
  const end = Math.min(raw.length, args.matchIndex + Math.max(80, args.queryLen + 40));
  const head = start > 0 ? "…" : "";
  const tail = end < raw.length ? "…" : "";
  return head + raw.slice(start, end) + tail;
}

let cardJobsRunner: Promise<void> | null = null;
let cardJobsAbort: AbortController | null = null;
let cardJobsAbortReason: null | "pause" | "cancel" = null;

export const useKbStore = create<KbState>()(
  persist(
    (set, get) => ({
      baseDir: useWorkspaceStore.getState().kbBaseDir,
      ownerKey: "local_anonymous",
      isLoading: false,
      error: null,
      lastImportAt: null,
      query: "",
      groups: [],
      currentLibraryId: null,
      libraries: [],
      trashLibraries: [],
      kbManagerOpen: false,
      kbManagerTab: "libraries",
      kbManagerNotice: null,
      cardJobStatus: "idle",
      cardJobError: null,
      cardJobs: [],
      playbookJobs: [],
      cardJobRunStartedAtMs: null,
      cardJobRunElapsedMs: 0,
      pendingImport: null,

      setQuery: (query) => set({ query }),
      setPendingImport: (pending) => {
        kbLog("info", "kb.pending_import.set", {
          kind: pending?.kind ?? null,
          count: Array.isArray(pending?.paths) ? pending!.paths.length : 0,
        });
        set({ pendingImport: pending });
      },
      setBaseDir: (dir) => {
        const prev = get().baseDir;
        const clean = dir ? String(dir).trim() : null;
        set({ baseDir: clean });
        useWorkspaceStore.getState().setKbBaseDir(clean);
        // 切换 KB 目录：清空当前库选择/待导入/右侧关联，避免“旧库 id 写入新目录”
        if (prev !== clean) {
          set({ currentLibraryId: null, pendingImport: null });
          useRunStore.getState().clearKbAttachedLibraries();
        }
      },

      pickBaseDir: async () => {
        const api = window.desktop?.fs;
        if (!api) return;
        const res = await api.pickDirectory();
        if (!res?.ok || !res.dir) return;
        get().setBaseDir(res.dir);
        // 展开左侧 KB，给用户反馈
        useLayoutStore.getState().openSection("kb");
        await get().refreshLibraries().catch(() => void 0);
      },

      ensureReady: async () => {
        const dir = get().baseDir;
        if (dir) return true;
        // 引导用户选择目录
        useLayoutStore.getState().openSection("kb");
        return false;
      },

      refreshLibraries: async () => {
        const ok = await get().ensureReady();
        if (!ok) return;
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const db = await loadDb({ baseDir, ownerKey });
        const stats = computeLibraryStats(db);
        const fpMap = latestFingerprintByLib(db);
        const libs = db.libraries
          .map((l) => ({
            id: l.id,
            name: l.name,
            purpose: normalizeLibraryPurpose((l as any).purpose),
            facetPackId: normalizeFacetPackId((l as any).facetPackId),
            docCount: stats.docCountByLib.get(l.id) ?? 0,
            updatedAt: stats.updatedAtByLib.get(l.id) ?? l.updatedAt ?? l.createdAt,
            fingerprint: (() => {
              const fp = fpMap.get(l.id);
              const b = fp?.badge;
              if (!fp || !b) return undefined;
              return { primaryLabel: b.primaryLabel, confidence: b.confidence, stability: b.stability, computedAt: fp.computedAt };
            })(),
          }))
          .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
        const trash = db.trash
          .map((x) => ({
            id: x.library.id,
            name: x.library.name,
            docCount: stats.docCountByTrash.get(x.library.id) ?? 0,
            deletedAt: x.deletedAt,
          }))
          .sort((a, b) => String(b.deletedAt ?? "").localeCompare(String(a.deletedAt ?? "")));
        set({ libraries: libs, trashLibraries: trash });

        // 兜底：清理失效的“当前库/右侧关联库”（删除库/切目录后避免残留）
        const cur = get().currentLibraryId;
        if (cur && !libs.some((l) => l.id === cur)) set({ currentLibraryId: null });
        const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
        const keep = attached.filter((id) => libs.some((l) => l.id === id));
        if (keep.length !== attached.length) useRunStore.getState().setKbAttachedLibraries(keep);
      },

      setCurrentLibrary: (libraryId) => {
        const clean = libraryId ? String(libraryId).trim() : null;
        kbLog("info", "kb.current_library.set", { id: clean });
        set({ currentLibraryId: clean });

        // 若存在“未选库时触发的待导入”，在用户选库后自动继续导入并入队抽卡
        if (!clean) return;
        const pending = get().pendingImport;
        if (!pending || !Array.isArray(pending.paths) || pending.paths.length === 0) return;

        void (async () => {
          kbLog("info", "kb.pending_import.run", { kind: pending.kind, count: pending.paths.length });
          const ok = await get().ensureReady();
          if (!ok) return;
          const baseDir = get().baseDir!;
          const ownerKey = get().ownerKey;
          const db = await loadDb({ baseDir, ownerKey });
          const exists = db.libraries.some((l) => l.id === clean);
          if (!exists) {
            set({ currentLibraryId: null });
            get().openKbManager("libraries", "所选库已不存在，请重新选择库后再导入。");
            set({ error: "所选库不存在：请重新选择库后再导入。" });
            return;
          }

          // 清空暂存，避免重复触发
          set({ pendingImport: null });

          if (pending.kind === "project") {
            const ret = await get().importProjectPaths(pending.paths);
            kbLog("info", "kb.pending_import.import_done", { ...ret, docIdCount: ret.docIds.length });
            await get().enqueueCardJobs(ret.docIds, { open: true, autoStart: false });
          }
        })().catch(() => void 0);
      },

      createLibrary: async (name) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const nm = String(name ?? "").trim();
        if (!nm) return { ok: false, error: "EMPTY_NAME" };
        const db = await loadDb({ baseDir, ownerKey });
        const id = makeId("kb_lib");
        const t = nowIso();
        db.libraries.push({ id, name: nm, purpose: "material", facetPackId: "speech_marketing_v1", createdAt: t, updatedAt: t });
        await saveDb({ baseDir, ownerKey, db });
        set({ currentLibraryId: id });
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true, id };
      },

      renameLibrary: async (id, name) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        const nm = String(name ?? "").trim();
        if (!libId) return { ok: false, error: "INVALID_ID" };
        if (!nm) return { ok: false, error: "EMPTY_NAME" };
        const db = await loadDb({ baseDir, ownerKey });
        const idx = db.libraries.findIndex((l) => l.id === libId);
        if (idx < 0) return { ok: false, error: "NOT_FOUND" };
        db.libraries[idx] = { ...db.libraries[idx], name: nm, updatedAt: nowIso() };
        await saveDb({ baseDir, ownerKey, db });
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true };
      },

      setLibraryPurpose: async (id, purpose) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        const pur = normalizeLibraryPurpose(purpose);
        if (!libId) return { ok: false, error: "INVALID_ID" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const idx = db.libraries.findIndex((l) => l.id === libId);
          if (idx < 0) return { ok: false, error: "NOT_FOUND" };
          db.libraries[idx] = { ...db.libraries[idx], purpose: pur, updatedAt: nowIso() };
          await saveDb({ baseDir, ownerKey, db });
          await get().refreshLibraries().catch(() => void 0);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      setLibraryFacetPack: async (id, facetPackId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        const packId = normalizeFacetPackId(facetPackId);
        if (!libId) return { ok: false, error: "INVALID_ID" };
        const db = await loadDb({ baseDir, ownerKey });
        const idx = db.libraries.findIndex((l) => l.id === libId);
        if (idx < 0) return { ok: false, error: "NOT_FOUND" };
        db.libraries[idx] = { ...db.libraries[idx], facetPackId: packId, updatedAt: nowIso() };
        await saveDb({ baseDir, ownerKey, db });
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true };
      },

      resetLocalKb: async () => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const api = window.desktop?.fs;
        if (!api) return { ok: false, error: "NO_FS_API" };
        // 停止抽卡 runner，避免“边跑边删”
        try {
          cardJobsAbortReason = "cancel";
          cardJobsAbort?.abort();
        } catch {
          // ignore
        }
        cardJobsAbort = null;
        cardJobsRunner = null;
        const rel = dbRelPath(ownerKey);
        const res = await api.deleteFile(baseDir, rel);
        if (!res?.ok) return { ok: false, error: res?.error ?? "DELETE_FAILED" };
        set({
          query: "",
          groups: [],
          currentLibraryId: null,
          pendingImport: null,
          libraries: [],
          trashLibraries: [],
          kbManagerNotice: null,
          cardJobStatus: "idle",
          cardJobError: null,
          cardJobs: [],
          playbookJobs: [],
          error: null,
          lastImportAt: null,
        });
        // KB 全清：清空右侧关联库，避免残留无效 id
        useRunStore.getState().clearKbAttachedLibraries();
        return { ok: true };
      },

      deleteLibraryToTrash: async (id) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        if (!libId) return { ok: false, error: "INVALID_ID" };
        const db = await loadDb({ baseDir, ownerKey });
        const idx = db.libraries.findIndex((l) => l.id === libId);
        if (idx < 0) return { ok: false, error: "NOT_FOUND" };
        const lib = db.libraries[idx];
        db.libraries = db.libraries.filter((l) => l.id !== libId);
        db.trash = [{ library: { ...lib, updatedAt: nowIso() }, deletedAt: nowIso() }, ...db.trash.filter((x) => x.library.id !== libId)];
        await saveDb({ baseDir, ownerKey, db });
        if (get().currentLibraryId === libId) set({ currentLibraryId: null });
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true };
      },

      restoreLibraryFromTrash: async (id) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        if (!libId) return { ok: false, error: "INVALID_ID" };
        const db = await loadDb({ baseDir, ownerKey });
        const item = db.trash.find((x) => x.library.id === libId);
        if (!item) return { ok: false, error: "NOT_FOUND" };
        db.trash = db.trash.filter((x) => x.library.id !== libId);
        // avoid duplicates
        db.libraries = [...db.libraries.filter((l) => l.id !== libId), { ...item.library, updatedAt: nowIso() }];
        await saveDb({ baseDir, ownerKey, db });
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true };
      },

      purgeLibrary: async (id) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, removedDocs: 0, removedArtifacts: 0, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(id ?? "").trim();
        if (!libId) return { ok: false, removedDocs: 0, removedArtifacts: 0, error: "INVALID_ID" };
        const db = await loadDb({ baseDir, ownerKey });
        db.libraries = db.libraries.filter((l) => l.id !== libId);
        db.trash = db.trash.filter((x) => x.library.id !== libId);
        const docIds = new Set(db.sourceDocs.filter((d) => d.libraryId === libId).map((d) => d.id));
        const removedDocs = docIds.size;
        const beforeArts = db.artifacts.length;
        db.sourceDocs = db.sourceDocs.filter((d) => d.libraryId !== libId);
        db.artifacts = db.artifacts.filter((a) => !docIds.has(a.sourceDocId));
        const removedArtifacts = beforeArts - db.artifacts.length;
        await saveDb({ baseDir, ownerKey, db });
        if (get().currentLibraryId === libId) set({ currentLibraryId: null });
        // 清理队列中属于该库的任务
        set((s) => ({
          cardJobs: s.cardJobs.filter((j) => j.libraryId !== libId),
          playbookJobs: s.playbookJobs.filter((j) => j.libraryId !== libId),
        }));
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true, removedDocs, removedArtifacts };
      },

      emptyTrash: async () => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, removedLibraries: 0, removedDocs: 0, removedArtifacts: 0, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const db = await loadDb({ baseDir, ownerKey });
        const ids = db.trash.map((x) => x.library.id);
        let removedLibraries = 0;
        let removedDocs = 0;
        let removedArtifacts = 0;
        for (const id of ids) {
          const r = await get().purgeLibrary(id);
          if (r.ok) {
            removedLibraries += 1;
            removedDocs += r.removedDocs;
            removedArtifacts += r.removedArtifacts;
          }
        }
        await get().refreshLibraries().catch(() => void 0);
        return { ok: true, removedLibraries, removedDocs, removedArtifacts };
      },

      openKbManager: (tab, notice) =>
        set({
          kbManagerOpen: true,
          kbManagerTab: tab ?? "libraries",
          kbManagerNotice: notice ?? null,
        }),
      closeKbManager: () => set({ kbManagerOpen: false, kbManagerNotice: null }),

      enqueueCardJobs: async (docIds, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return;
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const unique = Array.from(new Set((docIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        if (!unique.length) return;

        let titleById = new Map<string, string>();
        let libByDocId = new Map<string, { libraryId: string; libraryName: string }>();
        try {
          const db = await loadDb({ baseDir, ownerKey });
          titleById = new Map(db.sourceDocs.map((d) => [d.id, d.title]));
          const libMap = new Map(db.libraries.map((l) => [l.id, l.name]));
          const trashMap = new Map(db.trash.map((x) => [x.library.id, x.library.name]));
          libByDocId = new Map(
            db.sourceDocs.map((d) => {
              const lid = String(d.libraryId ?? "").trim();
              const lname = libMap.get(lid) ?? trashMap.get(lid) ?? lid;
              return [d.id, { libraryId: lid, libraryName: lname }];
            }),
          );
        } catch {
          // ignore
        }

        set((s) => {
          const exists = new Set(s.cardJobs.map((j) => j.docId));
          const now = nowIso();
          const nextJobs = [...s.cardJobs];
          for (const id of unique) {
            if (exists.has(id)) continue;
            const lib = libByDocId.get(id);
            nextJobs.push({
              id: makeId("kb_card_job"),
              docId: id,
              docTitle: titleById.get(id) ?? id,
              libraryId: lib?.libraryId,
              libraryName: lib?.libraryName,
              status: "pending",
              updatedAt: now,
            });
          }
          return {
            cardJobs: nextJobs,
            kbManagerOpen: opts?.open ?? s.kbManagerOpen,
            kbManagerTab: opts?.open ? "jobs" : s.kbManagerTab,
            cardJobError: null,
          };
        });

        if (opts?.autoStart) void get().startCardJobs();
      },

      enqueuePlaybookJob: async (libraryId, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };

        let libName = libId;
        let totalFacets: number | undefined = undefined;
        let alreadyGenerated = false;
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: "LIBRARY_NOT_FOUND" };
          libName = lib.name;
          totalFacets = getFacetPack(lib.facetPackId ?? "speech_marketing_v1").facets.length;

          const playbookRel = `__kb_playbook__/library/${libId}.md`;
          const existingPlaybookDoc = db.sourceDocs.find(
            (d) => d.libraryId === libId && d.importedFrom?.kind === "project" && d.importedFrom?.relPath === playbookRel,
          );
          if (existingPlaybookDoc) {
            const hasCards = db.artifacts.some(
              (a) =>
                a.sourceDocId === existingPlaybookDoc.id &&
                a.kind === "card" &&
                ["style_profile", "playbook_facet"].includes(String(a.cardType ?? "")),
            );
            alreadyGenerated = hasCards;
          }
        } catch {
          // ignore
        }

        const existing = get().playbookJobs.find((j) => j.libraryId === libId);

        // 若已在队列中（pending/running），不重复入队，直接打开任务页
        if (existing && (existing.status === "pending" || existing.status === "running")) {
          if (opts?.open) set({ kbManagerOpen: true, kbManagerTab: "jobs" });
          return { ok: true, enqueued: false };
        }

        // 已跑过：提示“取消 / 仍然重跑”
        const alreadyRun = alreadyGenerated || existing?.status === "success";
        if (alreadyRun) {
          const yes = await useDialogStore.getState().openConfirm({
            title: "确认重跑？",
            message:
              `库「${libName}」已生成过风格手册（已存在）。\n\n` +
              "是否仍然重跑并覆盖？\n\n" +
              "- 取消：不重跑\n" +
              "- 确认：仍然重跑（将入队，需点击 ▶ 开始）",
            confirmText: "仍然重跑",
            cancelText: "取消",
            danger: true,
          });
          if (!yes) {
            if (opts?.open) set({ kbManagerOpen: true, kbManagerTab: "jobs" });
            return { ok: true, enqueued: false };
          }
        }

        set((s) => {
          const now = nowIso();
          const next = [...s.playbookJobs];
          const idx = next.findIndex((j) => j.libraryId === libId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              libraryName: libName,
              status: "pending",
              error: undefined,
              totalFacets: totalFacets ?? next[idx]?.totalFacets,
              generatedFacets: 0,
              generatedStyleProfile: false,
              phase: "style_profile",
              updatedAt: now,
            };
          } else {
            next.push({
              id: makeId("kb_playbook_job"),
              libraryId: libId,
              libraryName: libName,
              status: "pending",
              totalFacets: totalFacets,
              generatedFacets: 0,
              generatedStyleProfile: false,
              phase: "style_profile",
              updatedAt: now,
            });
          }
          return {
            playbookJobs: next,
            kbManagerOpen: opts?.open ?? s.kbManagerOpen,
            kbManagerTab: opts?.open ? "jobs" : s.kbManagerTab,
            cardJobError: null,
          };
        });

        return { ok: true, enqueued: true };
      },

      startCardJobs: async () => {
        const ok = await get().ensureReady();
        if (!ok) return;
        const prevStatus = get().cardJobStatus;
        const nowMs = Date.now();
        set((s) => ({
          kbManagerOpen: true,
          kbManagerTab: "jobs",
          cardJobStatus: "running",
          cardJobError: null,
          cardJobRunStartedAtMs: prevStatus === "running" && s.cardJobRunStartedAtMs != null ? s.cardJobRunStartedAtMs : nowMs,
          cardJobRunElapsedMs: prevStatus === "idle" ? 0 : s.cardJobRunElapsedMs,
        }));

        if (cardJobsRunner) {
          // 可能存在：用户“暂停”后很快点击“继续”，旧 runner 还没退出。
          // 这里等待旧 runner 退出后，如仍处于 running 状态则自动拉起新的 runner。
          return cardJobsRunner.then(async () => {
            if (get().cardJobStatus === "running") await get().startCardJobs();
          });
        }

        const markCardJob = (jobId: string, patch: Partial<KbCardJob>) => {
          const now = nowIso();
          set((s) => ({
            cardJobs: s.cardJobs.map((j) => (j.id === jobId ? { ...j, ...patch, updatedAt: now } : j)),
          }));
        };

        const markPlaybookJob = (jobId: string, patch: Partial<KbPlaybookJob>) => {
          const now = nowIso();
          set((s) => ({
            playbookJobs: s.playbookJobs.map((j) => (j.id === jobId ? { ...j, ...patch, updatedAt: now } : j)),
          }));
        };

        const run = async () => {
          let endedByControl = false;
          while (true) {
            if (get().cardJobStatus !== "running") break;

            const nextCard = get().cardJobs.find((j) => j.status === "pending");
            const nextPlaybook = nextCard ? null : get().playbookJobs.find((j) => j.status === "pending");
            if (!nextCard && !nextPlaybook) break;

            if (nextCard) {
              const next = nextCard;
              markCardJob(next.id, { status: "running", error: undefined });

              try {
                const baseDir = get().baseDir!;
                const ownerKey = get().ownerKey;
                const db = await loadDb({ baseDir, ownerKey });
                const hasCard = db.artifacts.some((a) => {
                  if (a.sourceDocId !== next.docId) return false;
                  if (a.kind !== "card") return false;
                  const t = String(a.cardType ?? "");
                  // 只要已有 doc_v2（或历史遗留的泛 card），就跳过；库级 playbook 不影响单篇抽卡
                  if (["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(t)) return true;
                  if (["style_profile", "playbook_facet"].includes(t)) return false;
                  return true;
                });
                if (hasCard) {
                  markCardJob(next.id, { status: "skipped" });
                  continue;
                }

                cardJobsAbort = new AbortController();
                const signal = cardJobsAbort.signal;
                const ret = await get().extractCardsForDocs([next.docId], { signal });
                const aborted = Boolean(signal.aborted);
                const reason = cardJobsAbortReason;
                cardJobsAbort = null;
                cardJobsAbortReason = null;

                if (!ret.ok) {
                  if (aborted && reason === "pause") {
                    // 暂停：把当前 job 退回 pending，等待继续
                    endedByControl = true;
                    markCardJob(next.id, { status: "pending" });
                    break;
                  }

                  if (aborted && reason === "cancel") {
                    endedByControl = true;
                    markCardJob(next.id, { status: "cancelled" });
                    break;
                  }
                  markCardJob(next.id, { status: "failed", error: ret.error ?? "EXTRACT_FAILED" });
                  continue;
                }

                if (ret.extracted > 0) {
                  markCardJob(next.id, { status: "success", extractedCards: ret.extracted });
                  continue;
                }

                if (ret.skipped > 0) {
                  markCardJob(next.id, { status: "skipped", extractedCards: 0 });
                  continue;
                }

                markCardJob(next.id, { status: "success", extractedCards: 0 });
              } catch (e: any) {
                const aborted = Boolean(cardJobsAbort?.signal.aborted);
                const reason = cardJobsAbortReason;
                cardJobsAbort = null;
                cardJobsAbortReason = null;

                if (aborted && reason === "pause") {
                  // 暂停：把当前 job 退回 pending，等待继续
                  endedByControl = true;
                  markCardJob(next.id, { status: "pending" });
                  break;
                }

                if (aborted && reason === "cancel") {
                  endedByControl = true;
                  markCardJob(next.id, { status: "cancelled" });
                  break;
                }

                markCardJob(next.id, { status: "failed", error: String(e?.message ?? e) });
              }

              continue;
            }

            // 风格手册任务：复用同一套 ▶/⏸/■ 控制（AbortSignal 可中断）
            const next = nextPlaybook!;
            markPlaybookJob(next.id, { status: "running", error: undefined, generatedFacets: 0, generatedStyleProfile: false, phase: "style_profile" });

            try {
              const libId = String(next.libraryId ?? "").trim();
              if (!libId) {
                markPlaybookJob(next.id, { status: "failed", error: "LIBRARY_ID_REQUIRED" });
                continue;
              }

              cardJobsAbort = new AbortController();
              const signal = cardJobsAbort.signal;
              const ret = await get().generateLibraryPlaybook(libId, { signal, jobId: next.id });
              const aborted = Boolean(signal.aborted);
              const reason = cardJobsAbortReason;
              cardJobsAbort = null;
              cardJobsAbortReason = null;

              if (!ret.ok) {
                if (aborted && reason === "pause") {
                  endedByControl = true;
                  markPlaybookJob(next.id, { status: "pending" });
                  break;
                }

                if (aborted && reason === "cancel") {
                  endedByControl = true;
                  markPlaybookJob(next.id, { status: "cancelled" });
                  break;
                }
                markPlaybookJob(next.id, { status: "failed", error: ret.error ?? "PLAYBOOK_FAILED" });
                continue;
              }

              markPlaybookJob(next.id, { status: "success", generatedFacets: ret.facets ?? 0 });
            } catch (e: any) {
              const aborted = Boolean(cardJobsAbort?.signal.aborted);
              const reason = cardJobsAbortReason;
              cardJobsAbort = null;
              cardJobsAbortReason = null;

              if (aborted && reason === "pause") {
                endedByControl = true;
                markPlaybookJob(next.id, { status: "pending" });
                break;
              }

              if (aborted && reason === "cancel") {
                endedByControl = true;
                markPlaybookJob(next.id, { status: "cancelled" });
                break;
              }

              markPlaybookJob(next.id, { status: "failed", error: String(e?.message ?? e) });
            }
          }

          // 正常跑完：自动回到 idle（暂停时保持 paused）
          if (!endedByControl && get().cardJobStatus === "running") {
            const nowMs = Date.now();
            set((s) => {
              const startedAt = s.cardJobRunStartedAtMs;
              const add = typeof startedAt === "number" ? Math.max(0, nowMs - startedAt) : 0;
              return { cardJobStatus: "idle", cardJobRunStartedAtMs: null, cardJobRunElapsedMs: s.cardJobRunElapsedMs + add };
            });
          }
        };

        cardJobsRunner = run().finally(() => {
          cardJobsRunner = null;
          cardJobsAbort = null;
          cardJobsAbortReason = null;
        });
        return cardJobsRunner;
      },

      pauseCardJobs: () => {
        if (get().cardJobStatus !== "running") return;
        const nowMs = Date.now();
        set((s) => {
          const startedAt = s.cardJobRunStartedAtMs;
          const add = typeof startedAt === "number" ? Math.max(0, nowMs - startedAt) : 0;
          return { cardJobStatus: "paused", cardJobRunStartedAtMs: null, cardJobRunElapsedMs: s.cardJobRunElapsedMs + add };
        });
        cardJobsAbortReason = "pause";
        try {
          cardJobsAbort?.abort();
        } catch {
          // ignore
        }
      },

      resumeCardJobs: async () => {
        if (get().cardJobStatus !== "paused") return;
        set({ cardJobStatus: "running", cardJobError: null, kbManagerOpen: true, kbManagerTab: "jobs" });
        return await get().startCardJobs();
      },

      cancelCardJobs: () => {
        const nowMs = Date.now();
        set((s) => {
          const now = nowIso();
          const startedAt = s.cardJobRunStartedAtMs;
          const add = typeof startedAt === "number" ? Math.max(0, nowMs - startedAt) : 0;
          return {
            cardJobStatus: "idle",
            cardJobRunStartedAtMs: null,
            cardJobRunElapsedMs: s.cardJobRunElapsedMs + add,
            cardJobs: s.cardJobs.map((j) => {
              if (j.status !== "pending" && j.status !== "running") return j;
              return { ...j, status: "cancelled", updatedAt: now };
            }),
            playbookJobs: s.playbookJobs.map((j) => {
              if (j.status !== "pending" && j.status !== "running") return j;
              return { ...j, status: "cancelled", updatedAt: now };
            }),
          };
        });
        cardJobsAbortReason = "cancel";
        try {
          cardJobsAbort?.abort();
        } catch {
          // ignore
        }
      },

      clearFinishedCardJobs: () => {
        set((s) => ({
          cardJobs: s.cardJobs.filter((j) => j.status === "pending" || j.status === "running" || j.status === "failed"),
          playbookJobs: s.playbookJobs.filter((j) => j.status === "pending" || j.status === "running" || j.status === "failed"),
        }));
      },

      retryFailedCardJobs: () => {
        set((s) => {
          const now = nowIso();
          return {
            cardJobs: s.cardJobs.map((j) => (j.status === "failed" ? { ...j, status: "pending", error: undefined, updatedAt: now } : j)),
            playbookJobs: s.playbookJobs.map((j) => (j.status === "failed" ? { ...j, status: "pending", error: undefined, updatedAt: now } : j)),
          };
        });
      },

      listCardsForLibrary: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        const limit = typeof args?.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 200;
        const includeContent = args?.includeContent !== false;
        const q = String(args?.query ?? "").trim().toLowerCase();
        const wantedTypes = Array.isArray(args?.cardTypes)
          ? (args.cardTypes as any[]).map((x) => String(x ?? "").trim()).filter(Boolean)
          : [];
        const typeSet = wantedTypes.length ? new Set(wantedTypes) : null;

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const docs = db.sourceDocs.filter((d) => String(d.libraryId ?? "").trim() === libId);
          const docById = new Map(docs.map((d) => [d.id, d]));
          const docIdSet = new Set(docs.map((d) => d.id));
          const cards = db.artifacts
            .filter((a) => a.kind === "card" && docIdSet.has(a.sourceDocId))
            .filter((a) => (typeSet ? typeSet.has(String((a as any).cardType ?? "").trim()) : true))
            .map((a) => {
              const doc = docById.get(a.sourceDocId);
              if (!doc) return null;
              const art: KbArtifact = includeContent ? a : { ...a, content: "" };
              return { artifact: art, sourceDoc: doc };
            })
            .filter(Boolean) as Array<{ artifact: KbArtifact; sourceDoc: KbSourceDoc }>;

          const filtered = q
            ? cards.filter((it) => {
                const title = String(it.artifact.title ?? "").toLowerCase();
                const type = String((it.artifact as any).cardType ?? "").toLowerCase();
                const content = String(it.artifact.content ?? "").toLowerCase();
                return title.includes(q) || type.includes(q) || content.includes(q) || String(it.sourceDoc.title ?? "").toLowerCase().includes(q);
              })
            : cards;

          // 简单排序：先 playbook/style_profile 再 doc_v2，再按标题
          const pri = (t: string) => {
            if (t === "style_profile") return 0;
            if (t === "final_polish_checklist") return 1;
            if (t === "playbook_facet") return 1;
            if (t === "outline") return 2;
            if (t === "hook") return 3;
            if (t === "thesis") return 4;
            if (t === "one_liner") return 5;
            if (t === "ending") return 6;
            return 9;
          };
          filtered.sort((a, b) => {
            const ta = String((a.artifact as any).cardType ?? "");
            const tb = String((b.artifact as any).cardType ?? "");
            const pa = pri(ta);
            const pb = pri(tb);
            if (pa !== pb) return pa - pb;
            return String(a.artifact.title ?? "").localeCompare(String(b.artifact.title ?? ""));
          });

          return { ok: true, cards: filtered.slice(0, limit), total: filtered.length };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      importProjectPaths: async (paths) => {
        const ok = await get().ensureReady();
        if (!ok) return { imported: 0, skipped: 0, docIds: [] };
        const libId = get().currentLibraryId;
        if (!libId) {
          get().openKbManager("libraries", "请先选择一个库，再导入语料。");
          set({ error: "未选择库：请先在“库管理”里创建/选择一个库。" });
          kbLog("warn", "kb.import.project.no_library", { pathsCount: Array.isArray(paths) ? paths.length : 0 });
          return { imported: 0, skipped: 0, docIds: [] };
        }
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const proj = useProjectStore.getState();

        let imported = 0;
        let skipped = 0;
        const importedDocIds: string[] = [];
        const docIdSet = new Set<string>();
        const addDocId = (id: string) => {
          const clean = String(id ?? "").trim();
          if (!clean) return;
          if (docIdSet.has(clean)) return;
          docIdSet.add(clean);
          importedDocIds.push(clean);
        };
        const skippedByReason: Record<string, number> = {};
        const skippedSample: Array<{ path: string; reason: string }> = [];
        const bumpSkip = (reason: string, path: string) => {
          skipped += 1;
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
          if (skippedSample.length < 8) skippedSample.push({ path, reason });
        };
        set({ isLoading: true, error: null });
        kbLog("info", "kb.import.project.start", { libId, pathsCount: Array.isArray(paths) ? paths.length : 0 });

        try {
          const db = await loadDb({ baseDir, ownerKey });
          if (!db.libraries.some((l) => l.id === libId)) {
            set({ currentLibraryId: null });
            get().openKbManager("libraries", "当前库已不存在，请重新选择库后再导入。");
            set({ error: "当前库不存在：请重新选择库后再导入。" });
            kbLog("warn", "kb.import.project.library_missing", { libId });
            return { imported: 0, skipped: 0, docIds: [] };
          }

          const unique = Array.from(new Set((paths ?? []).map((p) => String(p ?? "").replaceAll("\\", "/")).filter(Boolean)));
          for (const relPath of unique) {
            const format = extToFormat(relPath);
            if (format !== "md" && format !== "mdx" && format !== "txt") {
              bumpSkip("unsupported_format", relPath);
              continue;
            }
            let text = "";
            try {
              text = await proj.ensureLoaded(relPath);
            } catch {
              const file = proj.getFileByPath(relPath);
              text = String(file?.content ?? "");
            }
            const clean = normalizeText(text);
            if (!clean) {
              bumpSkip("empty_file", relPath);
              continue;
            }
            const entries = splitIntoEntries({ text: clean });
            if (!entries.length) {
              bumpSkip("no_entries", relPath);
              continue;
            }

            for (const entry of entries) {
              const entryIndex = Number.isFinite(entry.entryIndex) ? entry.entryIndex : 0;
              const entryText = normalizeText(entry.text);
              if (!entryText) {
                bumpSkip("empty_entry", `${relPath}#${entryIndex}`);
                continue;
              }
              const contentHash = fnv1a32Hex(entryText);
              const importedFrom: ImportedFrom = { kind: "project", relPath, entryIndex };
              const ret = await ingestEntryToDb({
                baseDir,
                ownerKey,
                db,
                libId,
                format,
                importedFrom,
                entryText,
                contentHash,
                entryTitle: String(entry.title ?? "").trim() || undefined,
              });
              if (!ret.imported) {
                bumpSkip(ret.skippedReason ?? "duplicate_same_hash", `${relPath}#${entryIndex}`);
                // 关键：重复也返回 docId，便于后续“入队抽卡/重新生成手册”等动作继续执行
                addDocId(ret.docId);
                continue;
              }
              imported += 1;
              addDocId(ret.docId);
            }
          }

          set({ lastImportAt: nowIso() });
          await get().refreshLibraries().catch(() => void 0);
          kbLog("info", "kb.import.project.done", {
            imported,
            skipped,
            skippedByReason,
            skippedSample,
            docIdCount: importedDocIds.length,
            sample: importedDocIds.slice(0, 6),
          });
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
          kbLog("error", "kb.import.project.failed", { error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }

        return { imported, skipped, docIds: importedDocIds, skippedByReason, skippedSample };
      },

      importExternalFiles: async (absPaths) => {
        const ok = await get().ensureReady();
        if (!ok) return { imported: 0, skipped: 0, docIds: [] };
        const libId = get().currentLibraryId;
        if (!libId) {
          get().openKbManager("libraries", "请先选择一个库，再导入语料。");
          set({ error: "未选择库：请先在“库管理”里创建/选择一个库。" });
          return { imported: 0, skipped: 0, docIds: [] };
        }
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        let imported = 0;
        let skipped = 0;
        const importedDocIds: string[] = [];
        const docIdSet = new Set<string>();
        const addDocId = (id: string) => {
          const clean = String(id ?? "").trim();
          if (!clean) return;
          if (docIdSet.has(clean)) return;
          docIdSet.add(clean);
          importedDocIds.push(clean);
        };
        const skippedByReason: Record<string, number> = {};
        const skippedSample: Array<{ path: string; reason: string }> = [];
        const bumpSkip = (reason: string, path: string) => {
          skipped += 1;
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
          if (skippedSample.length < 8) skippedSample.push({ path, reason });
        };
        set({ isLoading: true, error: null });

        const errors: Array<{ path: string; error: string }> = [];

        try {
          const db = await loadDb({ baseDir, ownerKey });
          if (!db.libraries.some((l) => l.id === libId)) {
            set({ currentLibraryId: null });
            get().openKbManager("libraries", "当前库已不存在，请重新选择库后再导入。");
            set({ error: "当前库不存在：请重新选择库后再导入。" });
            return { imported: 0, skipped: 0, docIds: [] };
          }
          const kbApi = window.desktop?.kb;
          if (!kbApi) throw new Error("NO_KB_API");

          const unique = Array.from(new Set((absPaths ?? []).map((p) => String(p ?? "").trim()).filter(Boolean)));
          for (const absPath of unique) {
            const format = extToFormat(absPath);
            const ret = await kbApi.extractTextFromFile(absPath);
            if (!ret?.ok || !ret.text) {
              const err = String(ret?.error ?? "EXTRACT_FAILED");
              errors.push({ path: absPath, error: err });
              bumpSkip("extract_failed", absPath);
              continue;
            }
            const clean = normalizeText(String(ret.text));
            if (!clean) {
              bumpSkip("empty_file", absPath);
              continue;
            }
            const entries = splitIntoEntries({ text: clean });
            if (!entries.length) {
              bumpSkip("no_entries", absPath);
              continue;
            }

            for (const entry of entries) {
              const entryIndex = Number.isFinite(entry.entryIndex) ? entry.entryIndex : 0;
              const entryText = normalizeText(entry.text);
              if (!entryText) {
                bumpSkip("empty_entry", `${absPath}#${entryIndex}`);
                continue;
              }
              const contentHash = fnv1a32Hex(entryText);
              const importedFrom: ImportedFrom = { kind: "file", absPath, entryIndex };
              const ret = await ingestEntryToDb({
                baseDir,
                ownerKey,
                db,
                libId,
                format,
                importedFrom,
                entryText,
                contentHash,
                entryTitle: String(entry.title ?? "").trim() || undefined,
              });
              if (!ret.imported) {
                bumpSkip(ret.skippedReason ?? "duplicate_same_hash", `${absPath}#${entryIndex}`);
                addDocId(ret.docId);
                continue;
              }
              imported += 1;
              addDocId(ret.docId);
            }
          }

          set({ lastImportAt: nowIso() });
          if (errors.length) {
            const shown = errors.slice(0, 3).map((e) => `${e.error} — ${e.path}`);
            const more = errors.length > shown.length ? `（以及另外 ${errors.length - shown.length} 项）` : "";
            set({
              error:
                `部分文件导入失败：\n` +
                shown.join("\n") +
                (more ? `\n${more}` : "") +
                `\n\n提示：若报 DEPENDENCY_NOT_AVAILABLE，说明未安装 DOCX/PDF 解析依赖。`,
            });
          }
          await get().refreshLibraries().catch(() => void 0);
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }

        return { imported, skipped, docIds: importedDocIds, skippedByReason, skippedSample, errors };
      },

      importUrls: async (urls, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return { imported: 0, skipped: 0, docIds: [] };
        const libId = get().currentLibraryId;
        if (!libId) {
          get().openKbManager("libraries", "请先选择一个库，再导入语料。");
          set({ error: "未选择库：请先在“库管理”里创建/选择一个库。" });
          return { imported: 0, skipped: 0, docIds: [] };
        }
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        let imported = 0;
        let skipped = 0;
        const importedDocIds: string[] = [];
        const docIdSet = new Set<string>();
        const addDocId = (id: string) => {
          const clean = String(id ?? "").trim();
          if (!clean) return;
          if (docIdSet.has(clean)) return;
          docIdSet.add(clean);
          importedDocIds.push(clean);
        };
        const skippedByReason: Record<string, number> = {};
        const skippedSample: Array<{ path: string; reason: string }> = [];
        const bumpSkip = (reason: string, path: string) => {
          skipped += 1;
          skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
          if (skippedSample.length < 8) skippedSample.push({ path, reason });
        };
        const errors: Array<{ url: string; error: string }> = [];

        set({ isLoading: true, error: null });
        kbLog("info", "kb.import.url.start", { libId, urlsCount: Array.isArray(urls) ? urls.length : 0 });

        try {
          const db = await loadDb({ baseDir, ownerKey });
          if (!db.libraries.some((l) => l.id === libId)) {
            set({ currentLibraryId: null });
            get().openKbManager("libraries", "当前库已不存在，请重新选择库后再导入。");
            set({ error: "当前库不存在：请重新选择库后再导入。" });
            return { imported: 0, skipped: 0, docIds: [] };
          }

          const uniqueRaw = Array.from(new Set((urls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean)));
          const canonMap = new Map<string, string>(); // canonical -> raw(first)
          for (const raw of uniqueRaw) {
            if (!/^https?:\/\//i.test(raw)) {
              bumpSkip("invalid_url", raw);
              continue;
            }
            const canon = canonicalizeUrlForDedup(raw);
            if (!canon) {
              bumpSkip("invalid_url", raw);
              continue;
            }
            if (!canonMap.has(canon)) canonMap.set(canon, raw);
          }

          for (const [canonUrl, rawUrl] of canonMap.entries()) {
            const fetched = await postFetchUrlForIngest({
              url: rawUrl,
              format: "text",
              timeoutMs: typeof opts?.timeoutMs === "number" ? opts!.timeoutMs : undefined,
              maxChars: typeof opts?.maxChars === "number" ? opts!.maxChars : undefined,
            });
            if (!fetched.ok) {
              const err = String(fetched.error ?? "FETCH_FAILED");
              errors.push({ url: canonUrl, error: err });
              bumpSkip("fetch_failed", canonUrl);
              continue;
            }

            const text = normalizeText(String((fetched as any).extractedText ?? (fetched as any).extractedMarkdown ?? ""));
            if (!text) {
              bumpSkip("empty_fetch", canonUrl);
              continue;
            }

            const split = String((opts as any)?.split ?? "auto").trim();
            const entries =
              split === "single"
                ? [{ entryIndex: 0, text }]
                : // auto / md_headings / dash（策略内部会自行判断是否可分割）
                  splitIntoEntries({ text });
            if (!entries.length) {
              bumpSkip("no_entries", canonUrl);
              continue;
            }

            const titleHint = String((fetched as any).title ?? "").trim() || undefined;
            const finalUrlRaw = String((fetched as any).finalUrl ?? "").trim() || canonUrl;
            const finalUrl = canonicalizeUrlForDedup(finalUrlRaw) || finalUrlRaw;
            const fetchedAt = String((fetched as any).fetchedAt ?? "").trim() || undefined;
            const baseHash = String((fetched as any).contentHash ?? "").trim();

            for (const entry of entries) {
              const entryIndex = Number.isFinite(entry.entryIndex) ? entry.entryIndex : 0;
              const entryText = normalizeText(entry.text);
              if (!entryText) {
                bumpSkip("empty_entry", `${canonUrl}#${entryIndex}`);
                continue;
              }
              // URL hash：优先复用网关 sha256（单 entry）；多 entry 则对每个 entryText 计算 sha256（若 crypto 不可用再回退 fnv1a32）
              const contentHash =
                entries.length === 1 && baseHash
                  ? baseHash
                  : (await sha256Hex(entryText)) ?? fnv1a32Hex(entryText);
              const importedFrom: ImportedFrom = {
                kind: "url",
                url: canonUrl,
                finalUrl,
                ...(fetchedAt ? { fetchedAt } : {}),
                entryIndex,
              };

              const ret = await ingestEntryToDb({
                baseDir,
                ownerKey,
                db,
                libId,
                format: "md",
                importedFrom,
                entryText,
                contentHash,
                titleHint,
                entryTitle: String(entry.title ?? "").trim() || undefined,
              });
              if (!ret.imported) {
                bumpSkip(ret.skippedReason ?? "duplicate_same_hash", `${canonUrl}#${entryIndex}`);
                addDocId(ret.docId);
                continue;
              }
              imported += 1;
              addDocId(ret.docId);
            }
          }

          set({ lastImportAt: nowIso() });
          if (errors.length) {
            const shown = errors.slice(0, 3).map((e) => `${e.error} — ${e.url}`);
            const more = errors.length > shown.length ? `（以及另外 ${errors.length - shown.length} 项）` : "";
            set({
              error: `部分 URL 导入失败：\n` + shown.join("\n") + (more ? `\n${more}` : ""),
            });
          }
          await get().refreshLibraries().catch(() => void 0);
          kbLog("info", "kb.import.url.done", {
            imported,
            skipped,
            skippedByReason,
            skippedSample,
            errorCount: errors.length,
            docIdCount: importedDocIds.length,
            sample: importedDocIds.slice(0, 6),
          });
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
          kbLog("error", "kb.import.url.failed", { error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }

        return { imported, skipped, docIds: importedDocIds, skippedByReason, skippedSample, errors };
      },

      extractCardsForDocs: async (docIds, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, extracted: 0, skipped: 0, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const ids = Array.from(new Set((docIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        if (!ids.length) return { ok: true, extracted: 0, skipped: 0 };

        let extracted = 0;
        let skipped = 0;

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const docById = new Map(db.sourceDocs.map((d) => [d.id, d]));
          const libById = new Map(db.libraries.map((l) => [l.id, l]));

          const isDocV2Card = (a: KbArtifact) =>
            a.kind === "card" &&
            ["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(String(a.cardType ?? ""));
          const isPlaybookCard = (a: KbArtifact) =>
            a.kind === "card" && ["style_profile", "playbook_facet"].includes(String(a.cardType ?? ""));

          for (const id of ids) {
            const hasCard = db.artifacts.some((a) => a.sourceDocId === id && (isDocV2Card(a) || (a.kind === "card" && !isPlaybookCard(a))));
            if (hasCard) {
              skipped += 1;
              continue;
            }

            const doc = docById.get(id);
            const lib = doc ? libById.get(String(doc.libraryId ?? "")) : undefined;
            const pack = getFacetPack(lib?.facetPackId ?? "speech_marketing_v1");
            const packFacetIds = pack.facets.map((f) => f.id);
            const packFacetIdSet = new Set(packFacetIds);
            const fallbackFacetId = packFacetIds[0] ?? "logic_framework";

            const isStyleLib = normalizeLibraryPurpose((lib as any)?.purpose) === "style";

            const allParas = db.artifacts
              .filter((a) => a.sourceDocId === id && a.kind === "paragraph")
              .slice(0, 1200) // 防止极端文档导致内存/耗时爆炸；质量模式会分块覆盖首尾
              .map((p) => ({
                index: typeof p.anchor?.paragraphIndex === "number" ? p.anchor.paragraphIndex : 0,
                text: p.content,
                headingPath: Array.isArray(p.anchor?.headingPath) ? p.anchor.headingPath : [],
              }));

            if (!allParas.length) {
              skipped += 1;
              continue;
            }

            // 质量模式（风格库）：智能切割 → 分段抽卡 → 全局合并（保证覆盖，不靠截断）
            const chunks = isStyleLib
              ? chunkParagraphsForExtraction({
                  paragraphs: allParas,
                  maxChunks: 6,
                  maxParasPerChunk: 60,
                  maxCharsPerChunk: 12000,
                  overlapParas: 2,
                })
              : [allParas.slice(0, 180)]; // 非风格库：保持原策略（速度优先）

            const merged: any[] = [];
            const seen = new Set<string>();
            const addCard = (c: any) => {
              const t = String(c?.cardType ?? "").trim();
              const title = String(c?.title ?? "").trim();
              const content = String(c?.content ?? "").trim();
              if (!t || !title || !content) return;
              const key = `${t}::${title}::${fnv1a32Hex(content)}`;
              if (seen.has(key)) return;
              seen.add(key);
              merged.push(c);
            };

            for (let ci = 0; ci < chunks.length; ci += 1) {
              const chunk = chunks[ci]!;
              const maxCards = isStyleLib ? (ci === 0 ? 16 : 12) : 24;
              const ret = await postExtractCards({ paragraphs: chunk, maxCards, facetIds: packFacetIds, mode: "doc_v2", signal: opts?.signal });
              if (!ret.ok) return { ok: false, extracted, skipped, error: ret.error };
              for (const c of ret.cards) addCard(c);
            }

            if (!merged.length) {
              skipped += 1;
              continue;
            }

            // 配额收敛：保证“每类都有”，避免被 one_liner 淹没
            const normalizeType = (raw: any) => {
              const s = String(raw ?? "").trim();
              return ["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(s) ? s : "other";
            };
            const picked: any[] = [];
            const take = (type: string, limit: number) => {
              const list = merged
                .filter((c) => normalizeType(c?.cardType) === type)
                .slice()
                .sort((a, b) => scoreDocV2CardForPick(b) - scoreDocV2CardForPick(a));
              for (const c of list.slice(0, limit)) picked.push(c);
            };
            take("outline", 1);
            take("hook", 3);
            take("thesis", 3);
            take("ending", 3);
            take("one_liner", 12);
            take("other", 6);

            // 去重（合并时已去重，这里再保守一遍）
            const finalCards: any[] = [];
            const seen2 = new Set<string>();
            for (const c of picked) {
              const t = normalizeType(c?.cardType);
              const title = String(c?.title ?? "").trim();
              const content = String(c?.content ?? "").trim();
              const key = `${t}::${title}::${fnv1a32Hex(content)}`;
              if (seen2.has(key)) continue;
              seen2.add(key);
              finalCards.push({ ...c, cardType: t });
            }

            const newArts: KbArtifact[] = [];
            for (const c of finalCards) {
              const title = String(c?.title ?? "").trim();
              const content = String(c?.content ?? "").trim();
              const paragraphIndices = Array.isArray(c?.paragraphIndices) ? c.paragraphIndices : [];
              const pi = paragraphIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0);
              if (!title || !content || !pi.length) continue;
              const rawCardType = typeof c?.cardType === "string" ? String(c.cardType).trim() : "";
              const cardType =
                ["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(rawCardType) ? rawCardType : "other";
              const rawFacetIds: string[] = Array.isArray(c?.facetIds) ? c.facetIds.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
              const facetIds: string[] = rawFacetIds.filter((x: string) => packFacetIdSet.has(x)).slice(0, 6);
              const safeFacetIds = facetIds.length ? facetIds : [fallbackFacetId];

              newArts.push({
                id: makeId("kb_card"),
                sourceDocId: id,
                kind: "card",
                title,
                cardType,
                content: `### ${title}\n\n${content}\n`,
                facetIds: safeFacetIds,
                evidenceParagraphIndices: pi,
                anchor: { paragraphIndex: pi[0] ?? 0 },
              });
            }

            if (!newArts.length) {
              skipped += 1;
              continue;
            }

            db.artifacts.push(...newArts);
            await saveDb({ baseDir, ownerKey, db });
            extracted += newArts.length;
          }

          return { ok: true, extracted, skipped };
        } catch (e: any) {
          return { ok: false, extracted, skipped, error: String(e?.message ?? e) };
        }
      },

      generateLibraryPlaybook: async (libraryId, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: "LIBRARY_NOT_FOUND" };

          const pack = getFacetPack(lib.facetPackId ?? "speech_marketing_v1");
          const packFacetIds = pack.facets.map((f) => f.id);
          const jobId = String((opts as any)?.jobId ?? "").trim();
          const report = (patch: Partial<KbPlaybookJob>) => {
            if (!jobId) return;
            const now = nowIso();
            set((s) => ({
              playbookJobs: s.playbookJobs.map((j) => (j.id === jobId ? { ...j, ...patch, updatedAt: now } : j)),
            }));
          };
          report({ totalFacets: packFacetIds.length, generatedFacets: 0, generatedStyleProfile: false, phase: "style_profile" });

          const playbookRel = `__kb_playbook__/library/${libId}.md`;
          const existingPlaybookDoc = db.sourceDocs.find((d) => d.libraryId === libId && d.importedFrom?.kind === "project" && d.importedFrom.relPath === playbookRel);
          const playbookDocId = existingPlaybookDoc?.id ?? makeId("kb_doc_playbook");
          const now = nowIso();
          const playbookDoc: KbSourceDoc = {
            id: playbookDocId,
            libraryId: libId,
            title: `【仿写手册】${lib.name}`,
            format: "md",
            importedFrom: { kind: "project", relPath: playbookRel, entryIndex: 0 },
            contentHash: fnv1a32Hex(`${libId}:${now}`),
            createdAt: existingPlaybookDoc?.createdAt ?? now,
            updatedAt: now,
          };

          // 汇总 doc_v2 卡（只取该库真实文档，不包含 playbook 自己）
          const docs = db.sourceDocs.filter((d) => d.libraryId === libId && d.id !== playbookDocId);
          const docById = new Map(docs.map((d) => [d.id, d]));

          const isDocV2Type = (t: string) => ["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(t);
          const docCards = db.artifacts
            .filter((a) => a.kind === "card" && docById.has(a.sourceDocId) && isDocV2Type(String(a.cardType ?? "")))
            .slice(0);

          // 组装给 Gateway 的 payload（控量：每篇最多 14 条要素卡）
          const grouped = new Map<string, Array<{
            cardType: string;
            title?: string;
            content: string;
            paragraphIndices: number[];
            facetIds?: string[];
          }>>();
          for (const a of docCards) {
            const docId = a.sourceDocId;
            const list = grouped.get(docId) ?? [];
            if (list.length >= 14) continue;
            const para = Array.isArray(a.evidenceParagraphIndices) && a.evidenceParagraphIndices.length
              ? a.evidenceParagraphIndices
              : [typeof a.anchor?.paragraphIndex === "number" ? a.anchor.paragraphIndex : 0];
            const cardType = String(a.cardType ?? "").trim();
            list.push({
              cardType: isDocV2Type(cardType) ? cardType : "other",
              title: a.title,
              content: a.content,
              paragraphIndices: para.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 24),
              facetIds: Array.isArray(a.facetIds) ? a.facetIds.slice(0, 6) : undefined,
            });
            grouped.set(docId, list);
          }

          const docsPayload = Array.from(grouped.entries())
            .map(([docId, items]) => ({
              id: docId,
              title: docById.get(docId)?.title ?? docId,
              items,
            }))
            .filter((d) => d.items.length > 0)
            .slice(0, 200);

          if (!docsPayload.length) {
            const docCount = docs.length;
            const docWithCards = grouped.size;
            kbLog("warn", "kb.playbook.no_doc_cards_yet", { libId, docCount, docWithCards });
            return {
              ok: false,
              error:
                "NO_DOC_CARDS_YET（请先对该库文档跑完“抽卡任务”）\n" +
                `- 库内文档：${docCount} 篇\n` +
                `- 已有要素卡的文档：${docWithCards} 篇`,
            };
          }

          // =========================
          // 0) 画像（styleProfile）：优先用“本地确定性统计版”秒出，避免上游慢/超时导致整个手册无法生成
          // =========================
          const docIdSet = new Set(docs.map((d) => d.id));

          // 预分组 paragraph artifacts（避免重复 filter 全量数组）
          const parasByDoc = new Map<string, KbArtifact[]>();
          for (const a of db.artifacts) {
            if (a.kind !== "paragraph") continue;
            if (!docIdSet.has(a.sourceDocId)) continue;
            const arr = parasByDoc.get(a.sourceDocId) ?? [];
            arr.push(a);
            parasByDoc.set(a.sourceDocId, arr);
          }

          const docTexts = docs
            .map((d) => {
              const paras = parasByDoc.get(d.id) ?? [];
              const text = buildDocTextFromParagraphArtifacts({ docId: d.id, artifacts: paras.length ? paras : db.artifacts });
              return { docId: d.id, docTitle: d.title, text };
            })
            .filter((x) => x.text.trim());

          // 样本段（segments）：解决“多篇稿件塞进一个源文档”导致的“样本=1篇”失真
          const segTexts: Array<{ docId: string; docTitle: string; text: string }> = [];
          for (const d of docs) {
            const paras = (parasByDoc.get(d.id) ?? [])
              .slice()
              .sort((a, b) => (Number((a.anchor as any)?.paragraphIndex ?? 0) || 0) - (Number((b.anchor as any)?.paragraphIndex ?? 0) || 0));
            if (!paras.length) continue;
            const segs = buildDocSegmentsFromParagraphArtifacts({
              sourceDocId: d.id,
              sourceDocTitle: d.title,
              paragraphs: paras,
              maxSegments: 120,
              maxCharsPerSegment: 8000,
            });
            for (const s of segs) segTexts.push({ docId: s.segmentId, docTitle: d.title, text: s.text });
          }

          const unitTexts = segTexts.length ? segTexts : docTexts;
          const unitLabel = segTexts.length ? "段" : "篇";
          const unitTotal = unitTexts.length;

          const allText = unitTexts.map((d) => d.text).join("\n\n");
          const fp = computeTextFingerprintStats(allText);
          const ngrams = computeTopNgrams({ docs: unitTexts.map((d) => ({ docId: d.docId, text: d.text })), maxItems: 10 });

          const pickEvidence = () => {
            for (const a of docCards) {
              const pi =
                Array.isArray((a as any).evidenceParagraphIndices) && (a as any).evidenceParagraphIndices.length
                  ? Number((a as any).evidenceParagraphIndices[0])
                  : typeof a.anchor?.paragraphIndex === "number"
                    ? Number(a.anchor.paragraphIndex)
                    : 0;
              const quote = String(a.content ?? "")
                .replaceAll("\r\n", "\n")
                .replaceAll("\r", "\n")
                .replace(/```[\s\S]*?```/g, " ")
                .replace(/^#{1,6}\s+/gm, "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 60);
              if (!quote) continue;
              const docTitle = docById.get(a.sourceDocId)?.title ?? a.sourceDocId;
              return [{ docId: a.sourceDocId, docTitle, paragraphIndex: Number.isFinite(pi) ? pi : 0, quote }];
            }
            const d0 = docsPayload[0];
            if (!d0) return [];
            const it0 = d0.items?.[0];
            if (!it0) return [];
            const pi = Number((it0.paragraphIndices ?? [0])[0] ?? 0);
            const quote = String(it0.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
            return quote ? [{ docId: d0.id, docTitle: d0.title, paragraphIndex: Number.isFinite(pi) ? pi : 0, quote }] : [];
          };

          const pct = (x: number) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(1)}%`;
          const stats = fp.stats as any;
          const styleProfile: any = {
            title: "写法画像（统计版）",
            content:
              [
                `> 说明：该卡由本地确定性统计生成（不依赖上游模型），用于保证“生成风格手册”永远可用。`,
                ``,
                `- 样本：${docs.length} 篇${segTexts.length ? ` · ${segTexts.length} 段` : ""} · ${fp.chars} 字符 · ${fp.sentences} 句`,
                `- 问句率（每100句）：${stats.questionRatePer100Sentences ?? 0}；感叹率（每100句）：${stats.exclaimRatePer100Sentences ?? 0}`,
                `- 平均句长：${stats.avgSentenceLen ?? 0}；短句率（<=12字）：${pct(stats.shortSentenceRate ?? 0)}`,
                `- 我/我们密度（每1000字）：${stats.firstPersonPer1kChars ?? 0}；你/你们密度：${stats.secondPersonPer1kChars ?? 0}`,
                `- 语气词密度（每1000字）：${stats.particlePer1kChars ?? 0}；数字密度：${stats.digitPer1kChars ?? 0}`,
                ``,
                `#### 高频口癖 Top（n-gram）`,
                ...(ngrams.length
                  ? ngrams
                      .slice(0, 8)
                      .map(
                        (g) =>
                          `- ${g.text}（${g.per1kChars.toFixed(2)}/1k · 覆盖${Number((g as any).docCoverageCount ?? 0)}/${unitTotal}${unitLabel} · ${Math.round(g.docCoverage * 100)}%）`,
                      )
                  : [`- （样本不足，暂无稳定高频短语）`]),
              ].join("\n") + "\n",
            evidence: pickEvidence(),
          };

          kbLog("info", "kb.playbook.request", {
            libId,
            facetCount: packFacetIds.length,
            docs: docsPayload.length,
            itemsTotal: docsPayload.reduce((s, d) => s + (d.items?.length ?? 0), 0),
          });
          // 分批生成（稳定性优先）：
          // - 其余 facets 用 part=facets 分批生成；若超时则对该批次二分递归（避免“7→4→2 全量重跑”造成 20min 等待）
          const facetById = new Map<string, any>();
          // styleProfile 已由本地统计生成（可后续重跑覆盖）

          const isTimeoutErr = (msg: string) => /UPSTREAM_TIMEOUT|timeout|504/.test(String(msg ?? ""));
          const isAbortErr = (msg: string) => /aborted|AbortError|signal is aborted/i.test(String(msg ?? ""));

          const mode: "lite" | "full" = docsPayload.length <= 2 && docsPayload.reduce((s, d) => s + (d.items?.length ?? 0), 0) <= 40 ? "lite" : "full";

          const merge = (ret: { styleProfile: any; playbookFacets: any[] }) => {
            // styleProfile 已由本地统计生成，稳定可用；不再用上游返回覆盖，避免不确定性与潜在报错
            for (const f of ret.playbookFacets ?? []) {
              const fid = String(f?.facetId ?? "").trim();
              if (!fid) continue;
              facetById.set(fid, f);
            }
          };

          const requestBatch = async (facetIds: string[], part: "full" | "facets", meta?: Record<string, any>) => {
            const t0 = Date.now();
            const facetCount = facetIds.length;
            const metaSafe = meta ?? {};
            const facetIdsPreview = facetIds.slice(0, 6);
            kbLog("info", "kb.playbook.request.batch", {
              libId,
              part,
              mode,
              facetCount,
              facetIdsPreview,
              ...(metaSafe ?? {}),
            });
            const ret = await postBuildLibraryPlaybook({ facetIds, docs: docsPayload, mode, part, signal: opts?.signal });
            const elapsedMs = Date.now() - t0;

            if (ret.ok) {
              kbLog("info", "kb.playbook.response.batch", {
                libId,
                part,
                mode,
                ok: true,
                facetCount,
                facetIdsPreview,
                elapsedMs,
                receivedFacets: Array.isArray((ret as any)?.playbookFacets) ? (ret as any).playbookFacets.length : undefined,
                ...(metaSafe ?? {}),
              });
              return ret;
            }

            const err = String((ret as any)?.error ?? "");
            const errorKind =
              err.includes("AUTH_REQUIRED")
                ? "AUTH_REQUIRED"
                : /UPSTREAM_TIMEOUT/.test(err)
                  ? "UPSTREAM_TIMEOUT"
                  : /\bHTTP_504\b/.test(err) || /\bstatus=504\b/.test(err) || /\b504\b/.test(err)
                    ? "GATEWAY_HTTP_504"
                    : /fetch failed|failed to fetch/i.test(err)
                      ? "FETCH_FAILED"
                      : /INVALID_RESPONSE/.test(err)
                        ? "INVALID_RESPONSE"
                        : opts?.signal?.aborted
                          ? "ABORTED"
                          : "ERROR";

            kbLog("error", "kb.playbook.response.batch", {
              libId,
              part,
              mode,
              ok: false,
              facetCount,
              facetIdsPreview,
              elapsedMs,
              errorKind,
              error: err,
              ...(metaSafe ?? {}),
            });
            if (isTimeoutErr(err)) {
              kbLog("warn", "kb.playbook.timeout.batch", {
                libId,
                part,
                mode,
                facetCount,
                facetIdsPreview,
                elapsedMs,
                errorKind,
                error: err,
                ...(metaSafe ?? {}),
              });
            }
            return ret;
          };

          const ensureFacetsChunk = async (facetIds: string[]): Promise<{ ok: true } | { ok: false; error: string }> => {
            if (!facetIds.length) return { ok: true };
            const ret = await requestBatch(facetIds, "facets");
            if (ret.ok) {
              merge(ret);
              report({ generatedFacets: facetById.size, phase: "facets" });
              return { ok: true };
            }
            const err = String(ret.error ?? "");
            // 用户点了停止：上层 runner 会按 AbortReason 把 job 置为 cancelled / pending
            if (opts?.signal?.aborted) return { ok: false, error: err || "ABORTED" };
            if (isTimeoutErr(err) && facetIds.length > 1) {
              const mid = Math.ceil(facetIds.length / 2);
              const left = await ensureFacetsChunk(facetIds.slice(0, mid));
              if (!left.ok) return left;
              return await ensureFacetsChunk(facetIds.slice(mid));
            }
            // 兜底：如果已经拆到最小仍失败（尤其是上游慢/504），就给“骨架版维度卡”并继续，保证不失败
            if (facetIds.length === 1) {
              const fid = String(facetIds[0] ?? "").trim();
              if (fid && !facetById.has(fid)) {
                const label = pack.facets.find((f) => f.id === fid)?.label ?? fid;
                const candidates = docCards
                  .filter((c) => Array.isArray((c as any).facetIds) && (c as any).facetIds.includes(fid))
                  .slice(0, 6);
                const typeCount: Record<string, number> = {};
                for (const c of candidates) {
                  const t = String((c as any).cardType ?? "other");
                  typeCount[t] = (typeCount[t] ?? 0) + 1;
                }
                const examples = candidates.slice(0, 3).map((c) => {
                  const t = String((c as any).cardType ?? "other");
                  const title = String(c.title ?? "").trim() || "（无标题）";
                  const snippet = String(c.content ?? "")
                    .replaceAll("\r\n", "\n")
                    .replaceAll("\r", "\n")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 80);
                  return `- [${t}] ${title}：${snippet}`;
                });
                const ev = pickEvidence();
                facetById.set(fid, {
                  facetId: fid,
                  title: `（骨架版）${label}`,
                  content:
                    [
                      `> 提示：上游生成超时/失败（${err.split("\n")[0] || "unknown"}），该维度已用“样本驱动骨架版”生成。可稍后重跑覆盖。`,
                      ``,
                      `#### 样本概况`,
                      `- 命中要素卡：${candidates.length} 条`,
                      `- 卡片类型分布：${Object.keys(typeCount).length ? Object.entries(typeCount).map(([k, v]) => `${k}×${v}`).join("，") : "（无）"}`,
                      ``,
                      `#### 代表例子（来自已抽要素卡）`,
                      ...(examples.length ? examples : [`- （该维度样本不足）`]),
                      ``,
                      `#### 自检（通用）`,
                      `- 这一段/这一节是否能用 1 句“硬结论句”概括？`,
                      `- 是否有对应的证据/推演链支撑，而不是空判断？`,
                    ].join("\n") + "\n",
                  evidence: ev,
                });
                report({ generatedFacets: facetById.size, phase: "facets" });
              }
              if (!isAbortErr(err)) kbLog("warn", "kb.playbook.fallback_facet", { libId, facetId: fid, error: err });
              return { ok: true };
            }
            if (!isAbortErr(err)) kbLog("error", "kb.playbook.failed.batch", { libId, part: "facets", facetCount: facetIds.length, error: err });
            return { ok: false, error: err || "PLAYBOOK_FAILED" };
          };

          report({ generatedStyleProfile: true, generatedFacets: facetById.size, phase: "facets" });

          // 2) 其余 facets：初始每批 4 个；该批超时则二分递归
          const remaining = packFacetIds.filter((id) => !facetById.has(id));
          const batches = chunkArray(remaining, 4);
          for (let bi = 0; bi < batches.length; bi += 1) {
            const ids = batches[bi]!;
            const r = await ensureFacetsChunk(ids);
            if (!r.ok) {
              kbLog("error", "kb.playbook.failed", { libId, error: r.error });
              return { ok: false, error: r.error };
            }
          }

          // 校验：必须覆盖全部 facetId（否则提示缺失）
          const missing = packFacetIds.filter((id) => !facetById.has(id));
          if (!styleProfile || missing.length) {
            // 兜底：缺失 facet 也不再失败，统一补成骨架卡（避免“永远生成不了手册”）
            for (const fid of missing) {
              if (!facetById.has(fid)) facetById.set(fid, { facetId: fid, title: `（待补齐）${fid}`, content: `- （待补齐：该维度暂无足够样本或上游不可用）\n`, evidence: pickEvidence() });
            }
          }

          const facetLabel = (id: string) => pack.facets.find((f) => f.id === id)?.label ?? id;

          const renderEvidence = (ev: any[]) => {
            const list = Array.isArray(ev) ? ev : [];
            if (!list.length) return "";
            return (
              `\n\n---\n\n#### 证据（可追溯）\n` +
              list
                .slice(0, 24)
                .map((e: any) => {
                  const docTitle = String(e?.docTitle ?? e?.docId ?? "").trim();
                  const pi = Number(e?.paragraphIndex);
                  const quote = String(e?.quote ?? "").trim();
                  return `- ${docTitle} · 段落 #${Number.isFinite(pi) ? pi : 0}${quote ? `：${quote}` : ""}`;
                })
                .join("\n")
            );
          };

          const newArts: KbArtifact[] = [];
          const sp = styleProfile;
          newArts.push({
            id: makeId("kb_card"),
            sourceDocId: playbookDocId,
            kind: "card",
            title: String(sp?.title ?? "Style Profile").trim(),
            cardType: "style_profile",
            content: `### ${String(sp?.title ?? "写法画像").trim()}\n\n${String(sp?.content ?? "").trim()}` + renderEvidence(sp?.evidence),
            facetIds: undefined,
            anchor: { paragraphIndex: 0 },
          });

          for (const facetId of packFacetIds) {
            const f = facetById.get(facetId);
            if (!f) continue;
            if (!facetId) continue;
            const title = String(f?.title ?? "").trim() || `${facetLabel(facetId)}（${facetId}）`;
            const body = String(f?.content ?? "").trim();
            newArts.push({
              id: makeId("kb_card"),
              sourceDocId: playbookDocId,
              kind: "card",
              title,
              cardType: "playbook_facet",
              content: `### ${facetLabel(facetId)}（${facetId}）\n\n${body}` + renderEvidence(f?.evidence),
              facetIds: [facetId],
              anchor: { paragraphIndex: 0 },
            });
          }

          // 终稿润色清单（独立卡）：用于“最后一遍把文章改得更像本人写的”
          // 说明：这里先做可执行 checklist（不额外发 LLM 请求），后续可在 Gateway 侧增强为模型生成的更细清单。
          const styleTitle = String(sp?.title ?? "写法画像").trim();
          const styleBody = String(sp?.content ?? "").trim();
          const polish = [
            `### 终稿润色清单（final polish）`,
            ``,
            `> 目标：把稿子从“写得像”推进到“像本人写的”。先按顺序过一遍，再做第二遍小修。`,
            ``,
            `#### 0. 先锁定“本人声音”（从 Style Profile 抄规则，不要自作主张）`,
            `- 口吻/人设：按「${styleTitle}」执行（硬核、结论先行、战场感、少废话）`,
            `- 禁用：避免空泛解释/教学口吻（如“总的来说/我们可以看到/简单来说”）`,
            `- 句式：多短句+硬转折；少长解释段`,
            ``,
            `#### 1. 开头 3 段：必须“钩子→结论→战场坐标”`,
            `- 第 1 段就给冲突/博弈点（别铺垫）`,
            `- 第 2 段直接给结论/判断（别卖关子）`,
            `- 第 3 段给坐标：谁在反制、代价是什么、读者该怎么理解`,
            ``,
            `#### 2. 结构收束：用“要点编号/五环”把逻辑拎起来`,
            `- 每个小节开头先抛一句“结论句”（再解释证据）`,
            `- 结尾必须回扣：这盘棋下一步可能怎么走 + 对普通人/产业的影响`,
            ``,
            `#### 3. 语言层：把 AI 腔擦干净（逐段扫）`,
            `- 删除解释型过渡句：例如“因此/此外/同时”改成“关键是/问题在于/说白了”`,
            `- 把“中性陈述”改成“带判断的硬句”`,
            `- 一段一重点：每段只留一个主句，其余是证据/推演`,
            ``,
            `#### 4. 金句与节奏（可选加分）`,
            `- 每 3–5 段至少有 1 句“硬金句”（不必押韵，但要有判断和力量）`,
            `- 节奏：长段拆短；关键句单独成段`,
            ``,
            `#### 5. 自检（最后 2 分钟）`,
            `- 读一遍：像不像“本人”？如果像“新闻通稿/百科”，立刻重写开头与转折`,
            `- 读一遍：有没有“空结论”？每个判断都要有证据或推演链`,
            ``,
            `---`,
            ``,
            `#### Style Profile 摘要（供对照）`,
            styleBody ? styleBody.slice(0, 1200) + (styleBody.length > 1200 ? "\n…(truncated)\n" : "") : "（空）",
          ].join("\n");

          newArts.push({
            id: makeId("kb_card"),
            sourceDocId: playbookDocId,
            kind: "card",
            title: "终稿润色清单",
            cardType: "final_polish_checklist",
            content: polish,
            facetIds: undefined,
            anchor: { paragraphIndex: 0 },
          });

          // 写回：upsert playbook doc + 替换其卡片
          db.sourceDocs = [...db.sourceDocs.filter((d) => d.id !== playbookDocId), playbookDoc];
          // 仅替换手册生成的卡，避免误删其它附加卡（例如 cluster_rules_v1）
          const replacedTypes = new Set(["style_profile", "playbook_facet", "final_polish_checklist"]);
          db.artifacts = db.artifacts.filter((a) => {
            if (a.sourceDocId !== playbookDocId) return true;
            if (a.kind !== "card") return false;
            const t = String((a as any).cardType ?? "");
            return !replacedTypes.has(t);
          });
          db.artifacts.push(...newArts);
          await saveDb({ baseDir, ownerKey, db });

          await get().refreshLibraries().catch(() => void 0);
          return { ok: true, facets: newArts.filter((a) => a.cardType === "playbook_facet").length };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      getLatestLibraryFingerprint: async (libraryId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const list = (db.fingerprints ?? []).filter((x) => String((x as any)?.libraryId ?? "") === libId);
          const sorted = list.sort((a, b) => String((b as any)?.computedAt ?? "").localeCompare(String((a as any)?.computedAt ?? "")));
          const snapshot = sorted[0] as any;
          // overlay：对子簇 label 应用本库 prefs（不改历史快照，只改读出表现）
          const style = (db.libraryPrefs as any)?.[libId]?.style ?? null;
          const labels = style?.clusterLabelsV1 && typeof style.clusterLabelsV1 === "object" ? style.clusterLabelsV1 : null;
          if (snapshot?.clustersV1 && Array.isArray(snapshot.clustersV1) && labels) {
            snapshot.clustersV1 = snapshot.clustersV1.map((c: any) => ({
              ...c,
              label: String(labels?.[c.id] ?? c.label ?? ""),
            }));
          }
          return { ok: true, snapshot };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      getLibraryStyleAnchors: async (libraryId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, anchors: [], error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, anchors: [], error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, anchors: [], error: libraryMissingError(db, libId) };
          // 仅风格库生效；非风格库返回空（避免 UI 误用导致报错）
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: true, anchors: [] };
          const raw = (db.libraryPrefs as any)?.[libId]?.style?.anchorsV1;
          const anchors = Array.isArray(raw) ? (raw as KbTextSpanRefV1[]).filter(Boolean) : [];
          return { ok: true, anchors };
        } catch (e: any) {
          return { ok: false, anchors: [], error: String(e?.message ?? e) };
        }
      },

      saveLibraryStyleAnchorsFromSegments: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        const segs = Array.isArray(args?.segments) ? args.segments : [];
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };

          const docById = new Map(db.sourceDocs.map((d) => [d.id, d]));
          const normQuote = (raw: string) =>
            String(raw ?? "")
              .replaceAll("\r\n", "\n")
              .replaceAll("\r", "\n")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200);

          const out: KbTextSpanRefV1[] = [];
          const usedSeg = new Set<string>();
          const perDoc = new Map<string, number>();

          // 约束：最多 8 段；同一 sourceDoc 最多 2 段（兜底，避免 UI/数据异常）
          for (const s of segs) {
            if (out.length >= 8) break;
            const segmentId = String((s as any)?.segmentId ?? "").trim();
            const sourceDocId = String((s as any)?.sourceDocId ?? "").trim();
            if (!segmentId || !sourceDocId) continue;
            if (usedSeg.has(segmentId)) continue;

            const doc = docById.get(sourceDocId);
            if (!doc) continue;
            if (String((doc as any)?.libraryId ?? "").trim() !== libId) continue;

            const cnt = perDoc.get(sourceDocId) ?? 0;
            if (cnt >= 2) continue;

            const piRaw = (s as any)?.paragraphIndexStart;
            const paragraphIndexStart = typeof piRaw === "number" && Number.isFinite(piRaw) ? Number(piRaw) : null;
            const quote = normQuote(String((s as any)?.quote ?? ""));
            out.push({
              v: 1,
              libraryId: libId,
              sourceDocId,
              importedFrom: (doc as any)?.importedFrom,
              segmentId,
              paragraphIndexStart,
              quote: quote || "（空）",
            });
            usedSeg.add(segmentId);
            perDoc.set(sourceDocId, cnt + 1);
          }

          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...(prevPrefs.style ?? {}),
              updatedAt: nowIso(),
              anchorsV1: out,
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };
          await saveDb({ baseDir, ownerKey, db });
          return { ok: true, anchors: out };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      clearLibraryStyleAnchors: async (libraryId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };
          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...(prevPrefs.style ?? {}),
              updatedAt: nowIso(),
              anchorsV1: [],
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };
          await saveDb({ baseDir, ownerKey, db });
          return { ok: true, anchors: [] };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      getLibraryStyleConfig: async (libraryId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, anchors: [], error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, anchors: [], error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, anchors: [], error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: true, anchors: [] };
          const style = (db.libraryPrefs as any)?.[libId]?.style ?? {};
          const rawAnchors = style?.anchorsV1;
          const anchors = Array.isArray(rawAnchors) ? (rawAnchors as KbTextSpanRefV1[]).filter(Boolean) : [];
          const defaultClusterId = String(style?.defaultClusterId ?? "").trim() || undefined;
          const clusterLabelsV1 =
            style?.clusterLabelsV1 && typeof style.clusterLabelsV1 === "object" && !Array.isArray(style.clusterLabelsV1)
              ? (style.clusterLabelsV1 as any)
              : undefined;
          const clusterRulesV1 =
            style?.clusterRulesV1 && typeof style.clusterRulesV1 === "object" && !Array.isArray(style.clusterRulesV1)
              ? (style.clusterRulesV1 as any)
              : undefined;
          return { ok: true, anchors, defaultClusterId, clusterLabelsV1, clusterRulesV1 };
        } catch (e: any) {
          return { ok: false, anchors: [], error: String(e?.message ?? e) };
        }
      },

      setLibraryStyleClusterLabel: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        const clusterId = String(args?.clusterId ?? "").trim();
        const label = String(args?.label ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        if (!clusterId) return { ok: false, error: "CLUSTER_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };

          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const prevStyle = (prevPrefs.style ?? {}) as KbLibraryStylePrefsV1;
          const prevLabels =
            prevStyle.clusterLabelsV1 && typeof prevStyle.clusterLabelsV1 === "object" && !Array.isArray(prevStyle.clusterLabelsV1)
              ? { ...(prevStyle.clusterLabelsV1 as any) }
              : ({} as Record<string, string>);
          if (label) prevLabels[clusterId] = label;
          else delete prevLabels[clusterId];

          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...prevStyle,
              updatedAt: nowIso(),
              clusterLabelsV1: prevLabels,
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };
          await saveDb({ baseDir, ownerKey, db });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      setLibraryStyleDefaultCluster: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        const clusterIdRaw = args?.clusterId;
        const clusterId = clusterIdRaw === null ? null : String(clusterIdRaw ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        if (clusterId !== null && !clusterId) return { ok: false, error: "CLUSTER_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };

          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const prevStyle = (prevPrefs.style ?? {}) as KbLibraryStylePrefsV1;
          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...prevStyle,
              updatedAt: nowIso(),
              defaultClusterId: clusterId === null ? undefined : clusterId,
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };
          await saveDb({ baseDir, ownerKey, db });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      setLibraryStyleClusterRules: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        const clusterId = String(args?.clusterId ?? "").trim();
        const rules = (args as any)?.rules;
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        if (!clusterId) return { ok: false, error: "CLUSTER_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };

          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const prevStyle = (prevPrefs.style ?? {}) as KbLibraryStylePrefsV1;
          const prevRules =
            prevStyle.clusterRulesV1 && typeof prevStyle.clusterRulesV1 === "object" && !Array.isArray(prevStyle.clusterRulesV1)
              ? { ...(prevStyle.clusterRulesV1 as any) }
              : ({} as Record<string, any>);

          // 允许 clear：传 null / 空对象 / 空字符串 => delete
          const shouldDelete =
            rules === null ||
            rules === undefined ||
            (typeof rules === "string" && !String(rules).trim()) ||
            (typeof rules === "object" && rules && !Array.isArray(rules) && Object.keys(rules).length === 0);
          if (shouldDelete) delete prevRules[clusterId];
          else prevRules[clusterId] = rules;

          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...prevStyle,
              updatedAt: nowIso(),
              clusterRulesV1: prevRules,
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };
          await saveDb({ baseDir, ownerKey, db });
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      generateLibraryClusterRulesV1: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        const onlyClusterId = String(args?.clusterId ?? "").trim() || null;
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };
          if (normalizeLibraryPurpose((lib as any)?.purpose) !== "style") return { ok: false, error: "NOT_STYLE_LIBRARY" };

          // 需要指纹快照：用于拿 clustersV1 + perSegment.clusterId（证据位绑定）
          const fpRet = await get().getLatestLibraryFingerprint(libId);
          const fp = fpRet.ok ? (fpRet.snapshot as any) : null;
          const clusters = Array.isArray(fp?.clustersV1) ? (fp.clustersV1 as any[]) : [];
          const perSeg = Array.isArray(fp?.perSegment) ? (fp.perSegment as any[]) : [];
          if (!clusters.length || !perSeg.length) {
            return { ok: false, error: "NO_FINGERPRINT_CLUSTERS（请先生成：声音指纹（数字版））" };
          }

          const clusterBySegId = new Map<string, string>();
          for (const s of perSeg) {
            const sid = String((s as any)?.segmentId ?? "").trim();
            const cid = String((s as any)?.clusterId ?? "").trim();
            if (sid && cid) clusterBySegId.set(sid, cid);
          }

          const stylePrefs = ((db.libraryPrefs as any)?.[libId]?.style ?? {}) as KbLibraryStylePrefsV1;
          const anchorsInPrefs = Array.isArray(stylePrefs?.anchorsV1) ? (stylePrefs.anchorsV1 as KbTextSpanRefV1[]) : [];
          const clusterRulesPrev =
            stylePrefs?.clusterRulesV1 && typeof stylePrefs.clusterRulesV1 === "object" && !Array.isArray(stylePrefs.clusterRulesV1)
              ? ({ ...(stylePrefs.clusterRulesV1 as any) } as Record<string, any>)
              : ({} as Record<string, any>);

          const pickPoolForCluster = (cid: string) => {
            const pool: Array<KbTextSpanRefV1> = [];
            const seen = new Set<string>();
            const push = (r: KbTextSpanRefV1) => {
              const sid = String((r as any)?.segmentId ?? "").trim();
              if (!sid) return;
              if (seen.has(sid)) return;
              seen.add(sid);
              pool.push(r);
            };
            // 1) anchors（优先：更像“可追溯黄金样本”）
            for (const a of anchorsInPrefs) {
              const sid = String((a as any)?.segmentId ?? "").trim();
              if (!sid) continue;
              if (clusterBySegId.get(sid) !== cid) continue;
              push(a);
              if (pool.length >= 6) break;
            }
            // 2) cluster evidence（体检代表样例）
            const c = clusters.find((x) => String((x as any)?.id ?? "").trim() === cid);
            const ev = Array.isArray((c as any)?.evidence) ? ((c as any).evidence as any[]) : [];
            for (const e of ev) {
              if (!e || typeof e !== "object") continue;
              // clustersV1.evidence 理论上也是 KbTextSpanRefV1[]
              const r = e as KbTextSpanRefV1;
              push(r);
              if (pool.length >= 10) break;
            }
            return pool.slice(0, 10);
          };

          const targets = clusters
            .map((c) => ({
              clusterId: String((c as any)?.id ?? "").trim(),
              label: String((c as any)?.label ?? "").trim(),
            }))
            .filter((x) => x.clusterId)
            .filter((x) => (onlyClusterId ? x.clusterId === onlyClusterId : true))
            .slice(0, 3);
          if (!targets.length) return { ok: false, error: "CLUSTER_NOT_FOUND" };

          const payloadClusters = targets
            .map((t) => {
              const pool = pickPoolForCluster(t.clusterId);
              const evidence = pool
                .map((r) => ({
                  segmentId: String((r as any)?.segmentId ?? "").trim(),
                  quote: String((r as any)?.quote ?? "").trim().slice(0, 240),
                }))
                .filter((x) => x.segmentId && x.quote);
              return { clusterId: t.clusterId, label: t.label, evidence };
            })
            .filter((c) => c.evidence.length >= 2);
          if (!payloadClusters.length) return { ok: false, error: "NOT_ENOUGH_EVIDENCE（请先采纳 anchors 或确保该簇有代表样例）" };

          const libName = String((lib as any)?.name ?? libId).trim() || libId;
          const ret = await postBuildClusterRules({ model: args?.model, libraryName: libName, clusters: payloadClusters });
          if (!ret.ok) return { ok: false, error: ret.error };

          // segmentId -> KbTextSpanRefV1（来自 pool）
          const refBySegId = new Map<string, KbTextSpanRefV1>();
          for (const t of targets) {
            for (const r of pickPoolForCluster(t.clusterId)) {
              const sid = String((r as any)?.segmentId ?? "").trim();
              if (sid && !refBySegId.has(sid)) refBySegId.set(sid, r);
            }
          }

          const mapEvidence = (ids: any[]) => {
            const out: KbTextSpanRefV1[] = [];
            const seen = new Set<string>();
            for (const raw of Array.isArray(ids) ? ids : []) {
              const sid = String(raw ?? "").trim();
              if (!sid || seen.has(sid)) continue;
              const ref = refBySegId.get(sid);
              if (!ref) continue;
              out.push(ref);
              seen.add(sid);
              if (out.length >= 6) break;
            }
            return out;
          };

          let updated = 0;
          for (const c of ret.clusters as any[]) {
            const cid = String(c?.clusterId ?? "").trim();
            const rules = c?.rules ?? null;
            if (!cid || !rules || typeof rules !== "object" || Array.isArray(rules)) continue;
            const next = { ...rules, updatedAt: nowIso() } as any;
            const v = next.values ?? {};
            const mapValueList = (k: string) => {
              const arr = Array.isArray(v?.[k]) ? v[k] : [];
              v[k] = arr
                .map((it: any) => ({
                  text: String(it?.text ?? "").trim(),
                  evidence: mapEvidence(it?.evidenceSegmentIds),
                }))
                .filter((it: any) => it.text);
            };
            mapValueList("principles");
            mapValueList("priorities");
            mapValueList("moralAccounting");
            mapValueList("tabooFrames");
            mapValueList("epistemicNorms");
            mapValueList("templates");
            next.values = { ...(v as any), scope: String(v?.scope ?? "author") || "author" };

            const lenses = Array.isArray(next.analysisLenses) ? next.analysisLenses : [];
            next.analysisLenses = lenses
              .map((l: any) => ({
                label: String(l?.label ?? "").trim(),
                whenToUse: String(l?.whenToUse ?? "").trim(),
                questions: Array.isArray(l?.questions) ? l.questions.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [],
                templates: Array.isArray(l?.templates) ? l.templates.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [],
                checks: Array.isArray(l?.checks) ? l.checks.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [],
                evidence: mapEvidence(l?.evidenceSegmentIds),
              }))
              .filter((l: any) => l.label);

            clusterRulesPrev[cid] = next;
            updated += 1;
          }

          const prevPrefs = ((db.libraryPrefs as any)?.[libId] ?? {}) as KbLibraryPrefsV1;
          const prevStyle = (prevPrefs.style ?? {}) as KbLibraryStylePrefsV1;
          const nextPrefs: KbLibraryPrefsV1 = {
            ...prevPrefs,
            style: {
              ...prevStyle,
              updatedAt: nowIso(),
              clusterRulesV1: clusterRulesPrev,
            },
          };
          db.libraryPrefs = { ...(db.libraryPrefs ?? {}), [libId]: nextPrefs };

          // 同步落到 playbook 虚拟文档下：cardType=cluster_rules_v1（便于 templates 阶段 kb.search）
          const playbookRel = `__kb_playbook__/library/${libId}.md`;
          const existingPlaybookDoc = db.sourceDocs.find((d) => d.libraryId === libId && d.importedFrom?.kind === "project" && (d.importedFrom as any).relPath === playbookRel);
          const playbookDocId = existingPlaybookDoc?.id ?? makeId("kb_doc_playbook");
          const now = nowIso();
          const playbookDoc: KbSourceDoc = {
            id: playbookDocId,
            libraryId: libId,
            title: existingPlaybookDoc?.title ?? `【仿写手册】${lib.name}`,
            format: "md",
            importedFrom: { kind: "project", relPath: playbookRel, entryIndex: 0 },
            contentHash: existingPlaybookDoc?.contentHash ?? fnv1a32Hex(`${libId}:${now}`),
            createdAt: existingPlaybookDoc?.createdAt ?? now,
            updatedAt: now,
          };

          // 删除旧 cluster_rules_v1（避免重复堆积）
          db.artifacts = db.artifacts.filter((a) => !(a.sourceDocId === playbookDocId && a.kind === "card" && String(a.cardType ?? "") === "cluster_rules_v1"));

          const renderSpanEvidence = (ev: any[]) => {
            const list = Array.isArray(ev) ? ev : [];
            if (!list.length) return "";
            return (
              `\n\n---\n\n#### 证据（segments/anchors，可追溯）\n` +
              list
                .slice(0, 16)
                .map((e: any) => {
                  const sid = String(e?.segmentId ?? "").trim();
                  const quote = String(e?.quote ?? "").trim();
                  const doc = String(e?.sourceDocId ?? "").trim();
                  return `- ${sid || "seg"}${doc ? ` · ${doc}` : ""}${quote ? `：${quote}` : ""}`;
                })
                .join("\n")
            );
          };

          const byId = new Map(targets.map((t) => [t.clusterId, t]));
          for (const [cid, rule] of Object.entries(clusterRulesPrev)) {
            if (onlyClusterId && cid !== onlyClusterId) continue;
            const meta = byId.get(cid);
            const title = `【写法簇规则】${meta?.label || cid}`;
            const values = (rule as any)?.values ?? {};
            const lenses = Array.isArray((rule as any)?.analysisLenses) ? (rule as any).analysisLenses : [];
            const evAll: any[] = [];
            const takeEv = (arr: any[]) => {
              for (const it of Array.isArray(arr) ? arr : []) {
                for (const e of Array.isArray(it?.evidence) ? it.evidence : []) evAll.push(e);
              }
            };
            takeEv(values?.principles);
            takeEv(values?.priorities);
            takeEv(values?.moralAccounting);
            takeEv(values?.tabooFrames);
            takeEv(values?.epistemicNorms);
            takeEv(values?.templates);
            for (const l of lenses) for (const e of Array.isArray((l as any)?.evidence) ? (l as any).evidence : []) evAll.push(e);
            const content =
              `### 写法簇规则（${meta?.label || cid}）\n\n` +
              `- clusterId: ${cid}\n` +
              `- values.scope: ${String(values?.scope ?? "author")}\n` +
              `- values.principles: ${Array.isArray(values?.principles) ? values.principles.length : 0}\n` +
              `- analysisLenses: ${lenses.length}\n\n` +
              "```json\n" +
              JSON.stringify(rule, null, 2) +
              "\n```\n" +
              renderSpanEvidence(evAll);
            db.artifacts.push({
              id: makeId("kb_card"),
              sourceDocId: playbookDocId,
              kind: "card",
              title,
              cardType: "cluster_rules_v1",
              content,
              facetIds: undefined,
              anchor: { paragraphIndex: 0 },
            });
          }

          db.sourceDocs = [...db.sourceDocs.filter((d) => d.id !== playbookDocId), playbookDoc];
          await saveDb({ baseDir, ownerKey, db });
          await get().refreshLibraries().catch(() => void 0);
          return { ok: true, updated };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      getLibraryFingerprintHistory: async (libraryId, limit) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, items: [], error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, items: [], error: "LIBRARY_ID_REQUIRED" };
        const lim = Math.max(1, Math.min(20, Number(limit ?? 5)));
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const list = (db.fingerprints ?? []).filter((x) => String((x as any)?.libraryId ?? "") === libId);
          const sorted = list
            .sort((a, b) => String((b as any)?.computedAt ?? "").localeCompare(String((a as any)?.computedAt ?? "")))
            .slice(0, lim);
          return { ok: true, items: sorted as any };
        } catch (e: any) {
          return { ok: false, items: [], error: String(e?.message ?? e) };
        }
      },

      compareLatestLibraryFingerprints: async (libraryId) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const list = (db.fingerprints ?? [])
            .filter((x) => String((x as any)?.libraryId ?? "") === libId)
            .sort((a, b) => String((b as any)?.computedAt ?? "").localeCompare(String((a as any)?.computedAt ?? "")));
          if (list.length < 2) return { ok: false, error: "NOT_ENOUGH_HISTORY" };
          const newer = list[0] as any as KbLibraryFingerprintSnapshot;
          const older = list[1] as any as KbLibraryFingerprintSnapshot;
          const pick = (s: KbLibraryFingerprintSnapshot, k: string) => Number((s.stats as any)?.[k] ?? 0);
          const keys = [
            "questionRatePer100Sentences",
            "exclaimRatePer100Sentences",
            "avgSentenceLen",
            "shortSentenceRate",
            "firstPersonPer1kChars",
            "secondPersonPer1kChars",
            "particlePer1kChars",
            "digitPer1kChars",
          ];
          const diff: Record<string, any> = {};
          for (const k of keys) diff[k] = { older: pick(older, k), newer: pick(newer, k), delta: Number((pick(newer, k) - pick(older, k)).toFixed(3)) };
          diff.primaryLabel = { older: older.genres?.primary?.label ?? "", newer: newer.genres?.primary?.label ?? "" };
          diff.stability = { older: older.stability?.level ?? "", newer: newer.stability?.level ?? "" };
          return { ok: true, newer, older, diff };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      computeLibraryFingerprint: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const libId = String(args?.libraryId ?? "").trim();
        if (!libId) return { ok: false, error: "LIBRARY_ID_REQUIRED" };

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: libraryMissingError(db, libId) };

          const docs = db.sourceDocs.filter((d) => d.libraryId === libId && !isPlaybookDoc(d));
          if (!docs.length) return { ok: false, error: "NO_DOCS_IN_LIBRARY" };

          const docIdSet = new Set(docs.map((d) => d.id));
          const docById = new Map(docs.map((d) => [d.id, d]));

          // 预分组 paragraph artifacts（避免每篇 doc 反复 filter 全量数组）
          const parasByDoc = new Map<string, KbArtifact[]>();
          for (const a of db.artifacts) {
            if (a.kind !== "paragraph") continue;
            if (!docIdSet.has(a.sourceDocId)) continue;
            const arr = parasByDoc.get(a.sourceDocId) ?? [];
            arr.push(a);
            parasByDoc.set(a.sourceDocId, arr);
          }

          // 1) 样本段级（segment）：用于解决“一篇大文档塞多篇稿”导致的稳定性/覆盖率失真
          const segmentUnits: Array<{
            segmentId: string;
            sourceDocId: string;
            sourceDocTitle: string;
            paragraphIndexStart: number | null;
            text: string;
            chars: number;
            sentences: number;
            stats: Record<string, any>;
          }> = [];

          for (const d of docs) {
            const paras = (parasByDoc.get(d.id) ?? [])
              .slice()
              .sort((a, b) => (Number((a.anchor as any)?.paragraphIndex ?? 0) || 0) - (Number((b.anchor as any)?.paragraphIndex ?? 0) || 0));
            if (!paras.length) continue;
            const segs = buildDocSegmentsFromParagraphArtifacts({
              sourceDocId: d.id,
              sourceDocTitle: d.title,
              paragraphs: paras,
              maxSegments: 120,
              maxCharsPerSegment: 8000,
            });
            for (const s of segs) {
              const fp = computeTextFingerprintStats(s.text);
              segmentUnits.push({
                segmentId: s.segmentId,
                sourceDocId: s.sourceDocId,
                sourceDocTitle: s.sourceDocTitle,
                paragraphIndexStart: s.paragraphIndexStart ?? null,
                text: s.text,
                chars: fp.chars,
                sentences: fp.sentences,
                stats: fp.stats,
              });
            }
          }

          // 2) 源文档级（doc）：仍保留，便于 UI 对照与回溯
          const perDoc = docs.map((d) => {
            const paras = parasByDoc.get(d.id) ?? [];
            const text = buildDocTextFromParagraphArtifacts({ docId: d.id, artifacts: paras.length ? paras : db.artifacts });
            const fp = computeTextFingerprintStats(text);
            return { docId: d.id, docTitle: d.title, text, chars: fp.chars, sentences: fp.sentences, stats: fp.stats };
          });

          // 3) 库级 stats：按“全文拼接”口径统计（避免均值误导）
          const allText =
            segmentUnits.length > 0 ? segmentUnits.map((s) => s.text).join("\n\n") : perDoc.map((d) => d.text).join("\n\n");
          const libFp = computeTextFingerprintStats(allText);

          const corpus = {
            docs: docs.length,
            segments: segmentUnits.length,
            chars: libFp.chars,
            sentences: libFp.sentences,
          };

          const topNgrams = computeTopNgrams({
            docs: (segmentUnits.length ? segmentUnits : perDoc).map((d: any) => ({ docId: String(d.segmentId ?? d.docId), text: String(d.text ?? "") })),
            maxItems: 12,
          });
          const stability = computeStability({
            perDoc: (segmentUnits.length ? segmentUnits : perDoc).map((d: any) => ({
              docId: String(d.segmentId ?? d.docId),
              stats: d.stats,
              chars: d.chars,
              sentences: d.sentences,
            })),
          });

          // 证据覆盖率：doc_v2 卡（有 evidenceParagraphIndices）与 playbook 卡（有证据段落索引列表）
          const docCards = db.artifacts.filter((a) => a.kind === "card" && docIdSet.has(a.sourceDocId));
          const docCardsWithEvidence = docCards.filter((a) => Array.isArray(a.evidenceParagraphIndices) && a.evidenceParagraphIndices.length > 0);

          const playbookDoc = db.sourceDocs.find((d) => d.libraryId === libId && isPlaybookDoc(d));
          const playbookCards = playbookDoc ? db.artifacts.filter((a) => a.kind === "card" && a.sourceDocId === playbookDoc.id) : [];
          const playbookCardsWithEvidence = playbookCards.filter((a) => {
            const content = String(a.content ?? "");
            // playbook content 里有“证据（可追溯）”块时认为可回溯
            return content.includes("#### 证据（可追溯）") || content.includes("段落 #");
          });

          const evidence = {
            cardsWithEvidenceRate: docCards.length ? docCardsWithEvidence.length / docCards.length : 0,
            playbookCardsWithEvidenceRate: playbookCards.length ? playbookCardsWithEvidence.length / playbookCards.length : 0,
          };

          // 开集体裁识别：优先让 Gateway LLM 做归纳（带置信度与证据）；失败则退化为 unknown
          const samples = (segmentUnits.length ? segmentUnits : perDoc)
            .slice(0, 18)
            .map((s: any) => ({
              docId: String(s.sourceDocId ?? s.docId ?? ""),
              docTitle: String(s.sourceDocTitle ?? s.docTitle ?? docById.get(String(s.sourceDocId ?? s.docId ?? ""))?.title ?? ""),
              paragraphIndex: typeof s.paragraphIndexStart === "number" ? s.paragraphIndexStart : null,
              text: String(s.text ?? "").trim().slice(0, 360),
            }))
            .filter((x) => x.docId && x.text);

          let genres: { primary: KbFingerprintGenre; candidates: KbFingerprintGenre[] } = {
            primary: { label: "unknown", confidence: 0, why: "（未识别：未启用或不可用）" },
            candidates: [{ label: "unknown", confidence: 0, why: "（未识别：未启用或不可用）" }],
          };

          const useLlm = args?.useLlm === undefined ? true : Boolean(args.useLlm);
          if (useLlm && samples.length) {
            const ret = await postClassifyGenre({ model: args?.model, stats: { ...libFp.stats, corpus }, samples });
            if (ret.ok) genres = { primary: ret.primary, candidates: ret.candidates };
            else genres = { ...genres, primary: { ...genres.primary, why: `（未识别：${ret.error}）` } };
          }

          // M2：对子簇做确定性聚类（默认 k=3；降级 k=2/不分簇），产出 clustersV1 + perSegment.clusterId
          const stylePrefs = ((db.libraryPrefs as any)?.[libId]?.style ?? {}) as KbLibraryStylePrefsV1;
          const anchorsInPrefs = Array.isArray(stylePrefs?.anchorsV1) ? (stylePrefs.anchorsV1 as KbTextSpanRefV1[]) : [];
          const clusterLabelsV1 =
            stylePrefs?.clusterLabelsV1 && typeof stylePrefs.clusterLabelsV1 === "object" && !Array.isArray(stylePrefs.clusterLabelsV1)
              ? (stylePrefs.clusterLabelsV1 as any as Record<string, string>)
              : {};

          const CLUSTER_FEATURES = ["avgSentenceLen", "digitPer1kChars", "questionRatePer100Sentences", "particlePer1kChars", "shortSentenceRate"] as const;
          const eligible = segmentUnits
            .filter((s) => Number(s.chars ?? 0) >= 400 && Number(s.sentences ?? 0) >= 2)
            .slice()
            .sort((a, b) => String(a.segmentId).localeCompare(String(b.segmentId)))
            .slice(0, 1200);

          const clusterResult = (() => {
            const empty = {
              clustersV1: undefined as KbLibraryFingerprintSnapshot["clustersV1"],
              clusterBySegId: new Map<string, string>(),
            };
            if (eligible.length < 2) return empty;

            const cols = CLUSTER_FEATURES.map((k) => eligible.map((x) => Number((x.stats as any)?.[k] ?? 0)));
            const norms = cols.map((arr) => {
              const { mean, sd } = meanStd(arr);
              return { mean, sd: sd || 1 };
            });
            const vecOf = (stats: any) =>
              CLUSTER_FEATURES.map((k, i) => {
                const v = Number(stats?.[k] ?? 0);
                const { mean, sd } = norms[i];
                return (v - mean) / (sd || 1);
              });

            const vectors = eligible.map((x) => vecOf(x.stats));

            const tryK = (k: 2 | 3) => {
              const ret = kmeansDeterministic(vectors, k);
              if (!ret.ok) return null;
              // order clusters by avgSentenceLen ascending (convert from z-score to original unit)
              const avgNorm = norms[0];
              const order = ret.centroids
                .map((c, idx) => ({ idx, avg: avgNorm.mean + c[0] * avgNorm.sd }))
                .sort((a, b) => a.avg - b.avg)
                .map((x) => x.idx);
              const oldToNew = new Map<number, number>();
              order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));
              return { ...ret, oldToNew };
            };

            let km = eligible.length >= 10 ? tryK(3) : null;
            // 若 k=3 产生极小簇（例如只有 1 段），对“规则卡生成/采纳 anchors”价值很低且容易误导；
            // 这里做一次确定性降级：任意簇样本 < 2 则退回 k=2。
            if (km && km.centroids.length === 3) {
              const counts = new Map<number, number>();
              for (let i = 0; i < eligible.length; i += 1) {
                const oldIdx = km.assign[i];
                const newIdx = km.oldToNew.get(oldIdx) ?? 0;
                counts.set(newIdx, (counts.get(newIdx) ?? 0) + 1);
              }
              const minSize = Math.min(counts.get(0) ?? 0, counts.get(1) ?? 0, counts.get(2) ?? 0);
              if (minSize < 2) km = null;
            }
            if (!km) km = tryK(2);
            if (!km) return empty;
            const kFinal = km.centroids.length as 2 | 3;

            const vecBySegId = new Map<string, number[]>();
            const clusterBySegId = new Map<string, string>();
            for (let i = 0; i < eligible.length; i += 1) {
              const segId = String(eligible[i].segmentId);
              vecBySegId.set(segId, vectors[i]);
              const oldIdx = km.assign[i];
              const newIdx = km.oldToNew.get(oldIdx) ?? 0;
              clusterBySegId.set(segId, `cluster_${newIdx}`);
            }

            // group items by clusterId
            const clusters: Array<{ id: string; items: typeof eligible; centroid: number[] }> = [];
            for (let j = 0; j < kFinal; j += 1) {
              const oldIdx = km.oldToNew.size ? Array.from(km.oldToNew.entries()).find(([, v]) => v === j)?.[0] ?? j : j;
              const centroid = km.centroids[oldIdx] ?? km.centroids[j];
              clusters.push({ id: `cluster_${j}`, items: [] as any, centroid });
            }
            const byId = new Map(clusters.map((c) => [c.id, c]));
            for (const s of eligible) {
              const cid = clusterBySegId.get(String(s.segmentId));
              if (!cid) continue;
              byId.get(cid)?.items.push(s as any);
            }

            const anchorsByCluster = new Map<string, KbTextSpanRefV1[]>();
            for (const a of anchorsInPrefs) {
              const cid = clusterBySegId.get(String((a as any)?.segmentId ?? ""));
              if (!cid) continue;
              const arr = anchorsByCluster.get(cid) ?? [];
              arr.push(a);
              anchorsByCluster.set(cid, arr);
            }

            const makeLabel = (cid: string) => {
              const raw = String(clusterLabelsV1?.[cid] ?? "").trim();
              if (raw) return raw;
              const idx = Number(String(cid).replace("cluster_", ""));
              const letter = Number.isFinite(idx) ? String.fromCharCode(65 + Math.max(0, Math.min(25, idx))) : "A";
              return `写法${letter}`;
            };

            const keysForRanges = [
              "avgSentenceLen",
              "shortSentenceRate",
              "questionRatePer100Sentences",
              "exclaimRatePer100Sentences",
              "particlePer1kChars",
              "digitPer1kChars",
              "firstPersonPer1kChars",
              "secondPersonPer1kChars",
            ];
            const rangeOf = (vals: number[], key: string): [number, number] => {
              const xs = vals.filter((x) => Number.isFinite(x));
              if (!xs.length) return [0, 0];
              let lo = xs.length >= 5 ? quantile(xs, 0.1) : Math.min(...xs);
              let hi = xs.length >= 5 ? quantile(xs, 0.9) : Math.max(...xs);
              if (key === "shortSentenceRate") {
                lo = clamp01(lo);
                hi = clamp01(hi);
              } else {
                lo = Math.max(0, lo);
                hi = Math.max(lo, hi);
              }
              return [Number(lo.toFixed(3)), Number(hi.toFixed(3))];
            };
            const meanOf = (vals: number[]) => {
              const xs = vals.filter((x) => Number.isFinite(x));
              if (!xs.length) return 0;
              return xs.reduce((a, x) => a + x, 0) / xs.length;
            };

            const defaultFacetPlan = [
              { facetId: "opening_design", why: "开头钩子/破题" },
              { facetId: "logic_framework", why: "机制拆解/算账链条" },
              { facetId: "language_style", why: "口语化/标志性语块" },
              { facetId: "one_liner_crafting", why: "金句/节奏锤" },
              { facetId: "question_design", why: "问题链脚手架" },
            ];

            const clustersV1 = clusters
              .filter((c) => c.items.length > 0)
              .map((c) => {
                const segCount = c.items.length;
                const docSet = new Set(c.items.map((x) => String(x.sourceDocId)));
                const docCoverageCount = docSet.size;
                const docCoverageRate = docs.length ? docCoverageCount / docs.length : 0;

                const st = computeStability({
                  perDoc: c.items.map((x) => ({ docId: String(x.segmentId), stats: x.stats, chars: x.chars, sentences: x.sentences })),
                }).level;

                const statsMean: Record<string, number> = {};
                const softRanges: Record<string, [number, number]> = {};
                for (const k of keysForRanges) {
                  const vals = c.items.map((x) => Number((x.stats as any)?.[k] ?? 0));
                  statsMean[k] = Number(meanOf(vals).toFixed(3));
                  softRanges[k] = rangeOf(vals, k);
                }

                const withD = c.items
                  .map((x) => {
                    const vec = vecBySegId.get(String(x.segmentId)) ?? [];
                    return { x, d: vec.length ? Math.sqrt(dist2(vec, c.centroid)) : 0 };
                  })
                  .sort((a, b) => a.d - b.d);
                const evidenceItems = withD.slice(0, Math.max(3, Math.min(5, Math.ceil(segCount / 6))));
                const evidenceRefs: KbTextSpanRefV1[] = evidenceItems
                  .map(({ x }) => {
                    const doc = docById.get(x.sourceDocId);
                    const quote = String(x.text ?? "")
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 200);
                    return {
                      v: 1 as const,
                      libraryId: libId,
                      sourceDocId: x.sourceDocId,
                      importedFrom: (doc as any)?.importedFrom,
                      segmentId: x.segmentId,
                      paragraphIndexStart: x.paragraphIndexStart ?? null,
                      quote: quote || String((x as any)?.segmentId ?? "").slice(0, 200),
                    };
                  })
                  .filter(Boolean);

                const ngrams = computeTopNgrams({
                  docs: c.items.slice(0, 800).map((x) => ({ docId: String(x.segmentId), text: String(x.text ?? "") })),
                  maxItems: 8,
                });
                const queries = ngrams
                  .slice(0, 6)
                  .map((g) => String((g as any)?.text ?? "").trim())
                  .filter(Boolean);

                const anchors = anchorsByCluster.get(c.id) ?? [];

                return {
                  v: 1 as const,
                  id: c.id,
                  label: makeLabel(c.id),
                  segmentCount: segCount,
                  docCoverageCount,
                  docCoverageRate: clamp01(docCoverageRate),
                  stability: st,
                  statsMean,
                  softRanges,
                  evidence: evidenceRefs,
                  anchors,
                  facetPlan: defaultFacetPlan.map((f) => ({ ...f, kbQueries: queries.slice(0, 3) })),
                  queries,
                };
              });

            return { clustersV1, clusterBySegId };
          })();

          const clustersV1 = clusterResult.clustersV1;
          const clusterBySegId = clusterResult.clusterBySegId;

          // perSegment（供 UI）：仅展示前 600
          const perSegmentWithClusterId = segmentUnits.slice(0, 600).map((s) => {
            const doc = docById.get(s.sourceDocId);
            const imp: any = (doc as any)?.importedFrom;
            const sourceDocPath = imp?.kind === "project" ? String(imp.relPath ?? "") : imp?.kind === "file" ? String(imp.absPath ?? "") : undefined;
            const preview = String((s as any)?.text ?? "")
              .trim()
              .replaceAll("\r\n", "\n")
              .replaceAll("\r", "\n")
              .replace(/\s+/g, " ")
              .slice(0, 140);
            const clusterId = clusterBySegId.get(String(s.segmentId));
            return {
              segmentId: s.segmentId,
              sourceDocId: s.sourceDocId,
              sourceDocTitle: s.sourceDocTitle,
              sourceDocPath: sourceDocPath || undefined,
              paragraphIndexStart: typeof (s as any)?.paragraphIndexStart === "number" ? Number((s as any).paragraphIndexStart) : null,
              preview: preview || undefined,
              clusterId: clusterId || undefined,
              chars: s.chars,
              sentences: s.sentences,
              stats: s.stats,
            };
          });

          const snapshot: KbLibraryFingerprintSnapshot = {
            id: makeId("kb_fp"),
            libraryId: libId,
            computedAt: nowIso(),
            version: 1,
            badge: {
              primaryLabel: String(genres.primary.label ?? "unknown") || "unknown",
              confidence: clamp01(Number(genres.primary.confidence ?? 0)),
              stability: stability.level,
            },
            corpus,
            stats: libFp.stats,
            genres,
            stability,
            topNgrams,
            perDoc: perDoc.map((d) => ({
              docId: d.docId,
              docTitle: d.docTitle,
              chars: d.chars,
              sentences: d.sentences,
              stats: d.stats,
            })),
            perSegment: perSegmentWithClusterId,
            clustersV1,
            evidence: {
              cardsWithEvidenceRate: clamp01(evidence.cardsWithEvidenceRate),
              playbookCardsWithEvidenceRate: clamp01(evidence.playbookCardsWithEvidenceRate),
            },
          };

          // 同步（轻量、不触发上游模型）：如果该库已经有「仿写手册」文档，则把其中的“写法画像（统计版）/终稿润色清单”卡更新到最新指纹口径。
          // 目的：避免用户在“库体检”里看到新指纹，但“卡片预览”仍显示旧版统计卡（造成困惑）。
          try {
            const playbookRel = `__kb_playbook__/library/${libId}.md`;
            const playbookDoc = db.sourceDocs.find(
              (d) => d.libraryId === libId && d.importedFrom?.kind === "project" && d.importedFrom.relPath === playbookRel,
            );
            if (playbookDoc) {
              const stats = snapshot.stats as any;
              const ngrams = Array.isArray(snapshot.topNgrams) ? snapshot.topNgrams : [];
              const docsN = Number(snapshot.corpus?.docs ?? 0) || docs.length;
              const segsN = Number((snapshot.corpus as any)?.segments ?? 0) || 0;
              const unitTotal = segsN > 0 ? segsN : docsN;
              const unitLabel = segsN > 0 ? "段" : "篇";
              const pct = (x: number) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(1)}%`;

              const styleTitle = "写法画像（统计版）";
              const styleBody =
                [
                  `> 说明：该卡由本地确定性统计生成（不依赖上游模型），用于保证“生成风格手册”永远可用。`,
                  ``,
                  `- 样本：${docsN} 篇${segsN > 0 ? ` · ${segsN} 段` : ""} · ${Number(snapshot.corpus?.chars ?? 0) || 0} 字符 · ${Number(snapshot.corpus?.sentences ?? 0) || 0} 句`,
                  `- 问句率（每100句）：${stats.questionRatePer100Sentences ?? 0}；感叹率（每100句）：${stats.exclaimRatePer100Sentences ?? 0}`,
                  `- 平均句长：${stats.avgSentenceLen ?? 0}；短句率（<=12字）：${pct(stats.shortSentenceRate ?? 0)}`,
                  `- 我/我们密度（每1000字）：${stats.firstPersonPer1kChars ?? 0}；你/你们密度：${stats.secondPersonPer1kChars ?? 0}`,
                  `- 语气词密度（每1000字）：${stats.particlePer1kChars ?? 0}；数字密度：${stats.digitPer1kChars ?? 0}`,
                  ``,
                  `#### 高频口癖 Top（n-gram）`,
                  ...(ngrams.length
                    ? ngrams.slice(0, 8).map((g: any) => {
                        const per1k = Number(g?.per1kChars ?? 0);
                        const covCount = typeof g?.docCoverageCount === "number" ? Number(g.docCoverageCount) : Number(g?.docCoverage ?? 0);
                        const covRate =
                          typeof g?.docCoverageCount === "number"
                            ? Number(g?.docCoverage ?? 0)
                            : unitTotal
                              ? covCount / unitTotal
                              : 0;
                        return `- ${String(g?.text ?? "").trim()}（${per1k.toFixed(2)}/1k · 覆盖${covCount}/${unitTotal}${unitLabel} · ${Math.round(covRate * 100)}%）`;
                      })
                    : [`- （样本不足，暂无稳定高频短语）`]),
                ].join("\n") + "\n";

              const marker = `\n\n---\n\n#### 证据（可追溯）\n`;
              const spCard = db.artifacts.find((a: any) => a.kind === "card" && a.sourceDocId === playbookDoc.id && a.cardType === "style_profile") as any;
              const keepEvidence = (oldContent: string) => {
                const idx = String(oldContent ?? "").indexOf(marker);
                return idx >= 0 ? String(oldContent).slice(idx) : "";
              };
              const nextSpContent = `### ${styleTitle}\n\n${styleBody.trim()}` + (spCard ? keepEvidence(spCard.content) : "");

              if (spCard) {
                spCard.title = styleTitle;
                spCard.content = nextSpContent;
              } else {
                db.artifacts.push({
                  id: makeId("kb_card"),
                  sourceDocId: playbookDoc.id,
                  kind: "card",
                  title: styleTitle,
                  cardType: "style_profile",
                  content: nextSpContent,
                  facetIds: undefined,
                  anchor: { paragraphIndex: 0 },
                } as any);
              }

              // 终稿润色清单：引用 styleBody 摘要，属于确定性产物，也一并同步
              const polish = [
                `### 终稿润色清单（final polish）`,
                ``,
                `> 目标：把稿子从“写得像”推进到“像本人写的”。先按顺序过一遍，再做第二遍小修。`,
                ``,
                `#### 0. 先锁定“本人声音”（从 Style Profile 抄规则，不要自作主张）`,
                `- 口吻/人设：按「${styleTitle}」执行（硬核、结论先行、战场感、少废话）`,
                `- 禁用：避免空泛解释/教学口吻（如“总的来说/我们可以看到/简单来说”）`,
                `- 句式：多短句+硬转折；少长解释段`,
                ``,
                `#### 1. 开头 3 段：必须“钩子→结论→战场坐标”`,
                `- 第 1 段就给冲突/博弈点（别铺垫）`,
                `- 第 2 段直接给结论/判断（别卖关子）`,
                `- 第 3 段给坐标：谁在反制、代价是什么、读者该怎么理解`,
                ``,
                `#### 2. 结构收束：用“要点编号/五环”把逻辑拎起来`,
                `- 每个小节开头先抛一句“结论句”（再解释证据）`,
                `- 结尾必须回扣：这盘棋下一步可能怎么走 + 对普通人/产业的影响`,
                ``,
                `#### 3. 语言层：把 AI 腔擦干净（逐段扫）`,
                `- 删除解释型过渡句：例如“因此/此外/同时”改成“关键是/问题在于/说白了”`,
                `- 把“中性陈述”改成“带判断的硬句”`,
                `- 一段一重点：每段只留一个主句，其余是证据/推演`,
                ``,
                `#### 4. 金句与节奏（可选加分）`,
                `- 每 3–5 段至少有 1 句“硬金句”（不必押韵，但要有判断和力量）`,
                `- 节奏：长段拆短；关键句单独成段`,
                ``,
                `#### 5. 自检（最后 2 分钟）`,
                `- 读一遍：像不像“本人”？如果像“新闻通稿/百科”，立刻重写开头与转折`,
                `- 读一遍：有没有“空结论”？每个判断都要有证据或推演链`,
                ``,
                `---`,
                ``,
                `#### Style Profile 摘要（供对照）`,
                styleBody ? styleBody.slice(0, 1200) + (styleBody.length > 1200 ? "\n…(truncated)\n" : "") : "（空）",
              ].join("\n");
              const polishCard = db.artifacts.find(
                (a: any) => a.kind === "card" && a.sourceDocId === playbookDoc.id && a.cardType === "final_polish_checklist",
              ) as any;
              if (polishCard) {
                polishCard.title = "终稿润色清单";
                polishCard.content = polish;
              }
            }
          } catch (e: any) {
            kbLog("warn", "kb.fingerprint.sync_playbook_failed", { libId, error: String(e?.message ?? e) });
          }

          // 写回：每库保留最近 5 份快照
          const all = Array.isArray(db.fingerprints) ? db.fingerprints.slice(0) : [];
          const keptOther = all.filter((x) => String((x as any)?.libraryId ?? "") !== libId);
          const inLib = all.filter((x) => String((x as any)?.libraryId ?? "") === libId);
          const nextInLib = [snapshot, ...inLib].sort((a, b) => String((b as any)?.computedAt ?? "").localeCompare(String((a as any)?.computedAt ?? ""))).slice(0, 5);
          db.fingerprints = [...keptOther, ...nextInLib];
          await saveDb({ baseDir, ownerKey, db });

          await get().refreshLibraries().catch(() => void 0);
          return { ok: true, snapshot };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      search: async (q, options) => {
        const ok = await get().ensureReady();
        if (!ok) return;
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const query = String(q ?? get().query ?? "").trim();
        set({ query });

        const kind = options?.kind;
        const facetIds = Array.isArray(options?.facetIds) ? options!.facetIds!.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
        const perDocTopN = options?.perDocTopN ?? 3;
        const topDocs = options?.topDocs ?? 12;

        set({ isLoading: true, error: null });
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const docsById = new Map(db.sourceDocs.map((d) => [d.id, d]));
          const hitsByDoc = new Map<string, KbSearchGroup>();

          // 仅展示“当前库”的内容；如未选择库，则不展示（强制用户先选库）
          const curLibId = get().currentLibraryId;
          if (!curLibId) {
            set({ groups: [] });
            return;
          }
          const activeLibIds = new Set(db.libraries.map((l) => l.id));
          if (!activeLibIds.has(curLibId)) {
            set({ groups: [] });
            return;
          }

          // 空查询：展示最近文档的若干片段（按 kind/facet 过滤），用于“导入后立刻能看到卡片”
          if (!query) {
            const docs = db.sourceDocs
              .filter((d) => d.libraryId === curLibId)
              .slice()
              .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
            for (const doc of docs) {
              const docId = doc.id;
              const arts = db.artifacts.filter((a) => {
                if (a.sourceDocId !== docId) return false;
                if (kind && a.kind !== kind) return false;
                if (facetIds.length > 0) {
                  const setIds = new Set(a.facetIds ?? []);
                  const any = facetIds.some((f) => setIds.has(f));
                  if (!any) return false;
                }
                return true;
              });
              if (!arts.length) continue;
              const hits = arts.slice(0, perDocTopN).map((a) => ({
                artifact: a,
                score: 0,
                snippet: makeSnippet({ text: a.content, matchIndex: -1, queryLen: 0 }),
              }));
              hitsByDoc.set(docId, { sourceDoc: doc, bestScore: 0, hits });
              if (hitsByDoc.size >= topDocs) break;
            }
            set({ groups: Array.from(hitsByDoc.values()) });
            return;
          }

          for (const a of db.artifacts) {
            if (kind && a.kind !== kind) continue;
            if (facetIds.length > 0) {
              const setIds = new Set(a.facetIds ?? []);
              const any = facetIds.some((f) => setIds.has(f));
              if (!any) continue;
            }
            const { score, idx } = scoreArtifactText({ haystack: a.content, query });
            if (score <= 0) continue;
            const doc = docsById.get(a.sourceDocId);
            if (!doc) continue;
            if (doc.libraryId !== curLibId) continue;
            const snippet = makeSnippet({ text: a.content, matchIndex: idx, queryLen: query.length });
            const g = hitsByDoc.get(doc.id) ?? { sourceDoc: doc, bestScore: 0, hits: [] };
            g.hits.push({ artifact: a, score, snippet });
            if (score > g.bestScore) g.bestScore = score;
            hitsByDoc.set(doc.id, g);
          }

          const groups = Array.from(hitsByDoc.values())
            .map((g) => ({
              ...g,
              hits: g.hits.sort((a, b) => b.score - a.score).slice(0, perDocTopN),
            }))
            .sort((a, b) => b.bestScore - a.bestScore)
            .slice(0, topDocs);

          set({ groups });
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }
      },

      searchForAgent: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, error: "EMPTY_QUERY" };
        const kind = args.kind;
        const facetIds = Array.isArray(args.facetIds) ? args.facetIds.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
        const cardTypes = Array.isArray(args.cardTypes) ? args.cardTypes.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
        const anchorParagraphIndexMax = typeof args.anchorParagraphIndexMax === "number" ? Math.max(0, Math.floor(args.anchorParagraphIndexMax)) : undefined;
        const anchorFromEndMax = typeof args.anchorFromEndMax === "number" ? Math.max(0, Math.floor(args.anchorFromEndMax)) : undefined;
        const debugEnabled = args.debug === undefined ? true : Boolean(args.debug);
        const perDocTopN = args.perDocTopN ?? 3;
        const topDocs = args.topDocs ?? 12;
        const libraryIds = Array.from(new Set((args.libraryIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        if (!libraryIds.length) return { ok: false, error: "NO_LIBRARY_SELECTED" };
        const useVector = args.useVector === undefined ? true : Boolean(args.useVector);
        const embeddingModel = String(args.embeddingModel ?? "").trim() || undefined;

        try {
          // 运行态提示：避免用户以为“卡死”（仅在 Run 进行时提示）
          const run = useRunStore.getState();
          const setActivity = (text: string, opts?: { resetTimer?: boolean }) => {
            try {
              if (run.isRunning) run.setActivity(text, opts);
            } catch {
              // ignore
            }
          };

          let lastStageAt = 0;
          const stage = (text: string, opts?: { resetTimer?: boolean }) => {
            const now = Date.now();
            // 节流，避免高频更新导致 UI 抖动
            if (!opts?.resetTimer && now - lastStageAt < 180) return;
            lastStageAt = now;
            setActivity(text, opts);
          };

          const db = await loadDb({ baseDir, ownerKey });
          const activeLibIds = new Set(db.libraries.map((l) => l.id));
          const allowLibs = new Set(libraryIds.filter((id) => activeLibIds.has(id)));
          if (!allowLibs.size) return { ok: false, error: "LIBRARY_NOT_ACTIVE" };

          const docsById = new Map(db.sourceDocs.map((d) => [d.id, d]));
          const hitsByDoc = new Map<string, KbSearchGroup>();

          const debugOut: any = debugEnabled
            ? {
                query,
                kind: kind ?? null,
                facetIds: facetIds.slice(0, 16),
                cardTypes: cardTypes.slice(0, 16),
                anchorParagraphIndexMax: anchorParagraphIndexMax ?? null,
                anchorFromEndMax: anchorFromEndMax ?? null,
                useVector,
                stages: { lex: { docs: 0, hits: 0 }, vector: { enabled: useVector, mode: null as null | 'rerank' | 'fallback' }, recentFallback: false },
              }
            : null;

          const docMaxParaIndex = new Map<string, number>();
          if (anchorFromEndMax !== undefined) {
            for (const a of db.artifacts) {
              if (a.kind !== 'paragraph') continue;
              const doc = docsById.get(a.sourceDocId);
              if (!doc) continue;
              if (!allowLibs.has(String(doc.libraryId ?? ''))) continue;
              const pi = Number(a.anchor?.paragraphIndex);
              if (!Number.isFinite(pi)) continue;
              const prev = docMaxParaIndex.get(doc.id);
              if (prev === undefined || pi > prev) docMaxParaIndex.set(doc.id, pi);
            }
          }

          const passesExtra = (a: KbArtifact) => {
            if (cardTypes.length > 0 && a.kind === 'card') {
              const t = String((a as any).cardType ?? '');
              if (!cardTypes.includes(t)) return false;
            }
            if (anchorParagraphIndexMax !== undefined) {
              const pi = Number(a.anchor?.paragraphIndex);
              if (!Number.isFinite(pi) || pi >= anchorParagraphIndexMax) return false;
            }
            if (anchorFromEndMax !== undefined) {
              const pi = Number(a.anchor?.paragraphIndex);
              const maxPi = docMaxParaIndex.get(a.sourceDocId);
              if (!Number.isFinite(pi) || maxPi === undefined) return false;
              if (maxPi - pi >= anchorFromEndMax) return false;
            }
            return true;
          };

          stage("正在知识库检索：词法召回…", { resetTimer: true });
          for (const a of db.artifacts) {
            if (kind && a.kind !== kind) continue;
            // facetIds 目前主要用于 card（playbook_facet / style_profile 等）。paragraph/outline 默认没有 facetIds。
            // 若对 paragraph/outline 也做硬过滤，会导致“段落检索永远为空”（影响风格证据段拉取与强闭环判断）。
            if (facetIds.length > 0 && a.kind === "card") {
              const setIds = new Set(a.facetIds ?? []);
              const any = facetIds.some((f) => setIds.has(f));
              if (!any) continue;
            }
            const doc = docsById.get(a.sourceDocId);
            if (!doc) continue;
            if (!allowLibs.has(String(doc.libraryId ?? ""))) continue;
            const { score, idx } = scoreArtifactText({ haystack: a.content, query });
            if (score <= 0) continue;
            const snippet = makeSnippet({ text: a.content, matchIndex: idx, queryLen: query.length });
            const g = hitsByDoc.get(doc.id) ?? { sourceDoc: doc, bestScore: 0, hits: [] };
            g.hits.push({ artifact: a, score, snippet });
            if (score > g.bestScore) g.bestScore = score;
            hitsByDoc.set(doc.id, g);
          }


          if (debugOut) {
            debugOut.stages.lex.docs = hitsByDoc.size;
            debugOut.stages.lex.hits = Array.from(hitsByDoc.values()).reduce((n, g) => n + (g.hits?.length ?? 0), 0);
          }

          let groups = Array.from(hitsByDoc.values())
            .map((g) => ({
              ...g,
              hits: g.hits.sort((a, b) => b.score - a.score).slice(0, perDocTopN * 3),
            }))
            .sort((a, b) => b.bestScore - a.bestScore)
            .slice(0, topDocs);

          const vectorBudgetMs = 90_000;
          const vectorBudgetStart = Date.now();
          const budgetExceeded = () => Date.now() - vectorBudgetStart > vectorBudgetMs;

          // 可选：向量重排（先词法召回，再对候选集做 embedding cosine similarity）
          if (useVector && groups.length > 0) {
            if (debugOut) debugOut.stages.vector.mode = 'rerank';
            stage("正在知识库检索：向量检索（重排）…", { resetTimer: true });
            const q = query.slice(0, 800); // 控制 query 长度
            const qEmb = await fetchEmbedding({ model: embeddingModel, input: q });
            if (qEmb.ok && qEmb.embedding.length > 0 && !budgetExceeded()) {
              const modelUsed = embeddingModel ?? qEmb.modelUsed ?? "";
              const key = modelUsed || "default";
              const maxCandidates = Math.min(120, groups.reduce((sum, g) => sum + g.hits.length, 0));

              // 先收集候选（稳定顺序：按当前 groups/hits 顺序）
              const candidates: Array<{ hit: { artifact: KbArtifact; score: number; snippet: string } }> = [];
              for (const g of groups) {
                for (const h of g.hits) {
                  if (candidates.length >= maxCandidates) break;
                  candidates.push({ hit: h });
                }
                if (candidates.length >= maxCandidates) break;
              }

              // 批量补齐缺失向量（分片，避免一次 body 过大）
              const missing: Array<{ art: KbArtifact; text: string }> = [];
              for (const c of candidates) {
                const a = c.hit.artifact;
                if (a.embeddings?.[key]?.length) continue;
                missing.push({ art: a, text: String(a.content ?? "").slice(0, 1200) });
              }

              let mutated = false;
              const chunkSize = 32;
              for (let i = 0; i < missing.length; i += chunkSize) {
                if (budgetExceeded()) break;
                const chunk = missing.slice(i, i + chunkSize);
                const totalChunks = Math.max(1, Math.ceil(missing.length / chunkSize));
                const chunkNo = Math.floor(i / chunkSize) + 1;
                stage(`正在知识库检索：向量检索（重排 ${chunkNo}/${totalChunks}）…`);
                const ret = await fetchEmbeddingsBatch({ model: embeddingModel, inputs: chunk.map((x) => x.text) });
                if (!ret.ok) break;
                for (let j = 0; j < chunk.length; j += 1) {
                  const vec = ret.embeddings[j] ?? [];
                  if (vec.length) {
                    const a = chunk[j]!.art;
                    a.embeddings = { ...(a.embeddings ?? {}), [key]: vec };
                    mutated = true;
                  }
                }
              }

              // 计算相似度并重排
              for (const g of groups) {
                for (const h of g.hits) {
                  if (budgetExceeded()) break;
                  const a = h.artifact;
                  const vec = a.embeddings?.[key];
                  if (vec && vec.length > 0) {
                    const sim = cosineSim(qEmb.embedding, vec);
                    const lex = Number(h.score) || 0;
                    h.score = sim * 1000 + Math.min(100, lex);
                  }
                }
                g.hits = g.hits.sort((a, b) => b.score - a.score).slice(0, perDocTopN);
                g.bestScore = g.hits.length ? g.hits[0]!.score : 0;
              }
              groups = groups.sort((a, b) => b.bestScore - a.bestScore).slice(0, topDocs);

              if (mutated) {
                try {
                  await saveDb({ baseDir, ownerKey, db });
                } catch {
                  // ignore cache write failures
                }
              }
            }
          } else if (!useVector) {
            // no vector：回到每篇 topN
            groups = groups
              .map((g) => ({ ...g, hits: g.hits.slice(0, perDocTopN) }))
              .sort((a, b) => b.bestScore - a.bestScore)
              .slice(0, topDocs);
          } else if (useVector && groups.length === 0) {
            if (debugOut) debugOut.stages.vector.mode = 'fallback';
            // 向量兜底召回：当词法召回为 0 时，仍可通过 embedding 从库内候选集中找相似内容
            stage("正在知识库检索：向量检索（兜底召回）…", { resetTimer: true });
            const q = query.slice(0, 800);
            const qEmb = await fetchEmbedding({ model: embeddingModel, input: q });
            if (qEmb.ok && qEmb.embedding.length > 0 && !budgetExceeded()) {
              const modelUsed = embeddingModel ?? qEmb.modelUsed ?? "";
              const key = modelUsed || "default";

              // 候选集：按库 + kind + facet 过滤，按“最近文档优先”收集（稳定且更贴近当前库）
              const docsInLib = db.sourceDocs
                .filter((d) => allowLibs.has(String(d.libraryId ?? "")))
                .slice()
                .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
              const docIdSet = new Set(docsInLib.map((d) => d.id));
              const artsByDoc = new Map<string, KbArtifact[]>();
              for (const a of db.artifacts) {
                if (kind && a.kind !== kind) continue;
                    if (!docIdSet.has(a.sourceDocId)) continue;
                if (facetIds.length > 0 && a.kind === "card") {
                  const setIds = new Set(a.facetIds ?? []);
                  const any = facetIds.some((f) => setIds.has(f));
                  if (!any) continue;
                }
                const list = artsByDoc.get(a.sourceDocId) ?? [];
                list.push(a);
                artsByDoc.set(a.sourceDocId, list);
              }

              const maxCandidates = 220; // 控制成本/时间：兜底召回只要够覆盖 topDocs 即可
              const candidates: Array<{ art: KbArtifact; doc: KbSourceDoc }> = [];
              for (const d of docsInLib) {
                const list = artsByDoc.get(d.id) ?? [];
                for (const a of list) {
                  candidates.push({ art: a, doc: d });
                  if (candidates.length >= maxCandidates) break;
                }
                if (candidates.length >= maxCandidates) break;
              }

              // 批量补齐缺失向量
              const missing: Array<{ art: KbArtifact; text: string }> = [];
              for (const c of candidates) {
                if (c.art.embeddings?.[key]?.length) continue;
                missing.push({ art: c.art, text: String(c.art.content ?? "").slice(0, 1200) });
              }
              let mutated = false;
              const chunkSize = 32;
              for (let i = 0; i < missing.length; i += chunkSize) {
                if (budgetExceeded()) break;
                const chunk = missing.slice(i, i + chunkSize);
                const totalChunks = Math.max(1, Math.ceil(missing.length / chunkSize));
                const chunkNo = Math.floor(i / chunkSize) + 1;
                stage(`正在知识库检索：向量检索（兜底 ${chunkNo}/${totalChunks}）…`);
                const ret = await fetchEmbeddingsBatch({ model: embeddingModel, inputs: chunk.map((x) => x.text) });
                if (!ret.ok) break;
                for (let j = 0; j < chunk.length; j += 1) {
                  const vec = ret.embeddings[j] ?? [];
                  if (vec.length) {
                    const a = chunk[j]!.art;
                    a.embeddings = { ...(a.embeddings ?? {}), [key]: vec };
                    mutated = true;
                  }
                }
              }

              const scored: Array<{ artifact: KbArtifact; doc: KbSourceDoc; score: number; snippet: string }> = [];
              for (const c of candidates) {
                if (budgetExceeded()) break;
                const vec = c.art.embeddings?.[key];
                if (!vec || !vec.length) continue;
                const sim = cosineSim(qEmb.embedding, vec);
                const snippet = makeSnippet({ text: c.art.content, matchIndex: -1, queryLen: 0 });
                scored.push({ artifact: c.art, doc: c.doc, score: sim, snippet });
              }

              // 分组：按 doc 聚合，每篇取 topN
              const byDoc = new Map<string, KbSearchGroup>();
              for (const s of scored.sort((a, b) => b.score - a.score)) {
                const g = byDoc.get(s.doc.id) ?? { sourceDoc: s.doc, bestScore: 0, hits: [] };
                if (g.hits.length < perDocTopN) {
                  g.hits.push({ artifact: s.artifact, score: s.score, snippet: s.snippet });
                  if (s.score > g.bestScore) g.bestScore = s.score;
                  byDoc.set(s.doc.id, g);
                }
                if (byDoc.size >= topDocs && g.hits.length >= perDocTopN) {
                  // 轻量提前结束：已覆盖足够多文档时可不再扩
                }
              }

              groups = Array.from(byDoc.values())
                .sort((a, b) => b.bestScore - a.bestScore)
                .slice(0, topDocs);

              if (mutated) {
                try {
                  await saveDb({ baseDir, ownerKey, db });
                } catch {
                  // ignore cache write failures
                }
              }
            }
          }

          // 兜底：如果仍无命中（例如 query 主题与库无关，且 embeddings 不可用），返回“最近片段”作为风格样例
          // 目的：仿写时“宁可给一些可抄样例”，也不要空结果导致 Agent 直接放弃检索。
          if (groups.length === 0) {
            stage("正在知识库检索：兜底（最近片段）…", { resetTimer: true });
            if (debugOut) debugOut.stages.recentFallback = true;
            const docsInLib = db.sourceDocs
              .filter((d) => allowLibs.has(String(d.libraryId ?? "")))
              .slice()
              .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
            const fallbackGroups: KbSearchGroup[] = [];
            for (const doc of docsInLib) {
              const hits = db.artifacts
                .filter((a) => {
                  if (a.sourceDocId !== doc.id) return false;
                  if (kind && a.kind !== kind) return false;
                  if (!passesExtra(a)) return false;
                  if (facetIds.length > 0 && a.kind === "card") {
                    const setIds = new Set(a.facetIds ?? []);
                    const any = facetIds.some((f) => setIds.has(f));
                    if (!any) return false;
                  }
                  return true;
                })
                .slice()
                .sort((a, b) => (Number(a.anchor?.paragraphIndex ?? 0) || 0) - (Number(b.anchor?.paragraphIndex ?? 0) || 0))
                .slice(0, perDocTopN)
                .map((a) => ({ artifact: a, score: 0, snippet: makeSnippet({ text: a.content, matchIndex: -1, queryLen: 0 }) }));
              if (!hits.length) continue;
              fallbackGroups.push({ sourceDoc: doc, bestScore: 0, hits });
              if (fallbackGroups.length >= topDocs) break;
            }
            groups = fallbackGroups;
          }

          // kb.search 完成：把状态留给上层（gatewayAgent 会设置“等待模型继续/生成…”）
          return debugOut ? { ok: true, groups, debug: debugOut } : { ok: true, groups };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      citeForAgent: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const sourceDocId = String(args?.sourceDocId ?? "").trim();
        if (!sourceDocId) return { ok: false, error: "DOC_ID_REQUIRED" };

        const artifactId = String(args?.artifactId ?? "").trim();
        const paragraphIndexRaw = (args as any)?.paragraphIndex;
        const paragraphIndex = Number(paragraphIndexRaw);
        const maxCharsRaw = Number((args as any)?.maxChars);
        const quoteMaxCharsRaw = Number((args as any)?.quoteMaxChars);
        const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(200, Math.min(4000, Math.floor(maxCharsRaw))) : 1000;
        const quoteMaxChars = Number.isFinite(quoteMaxCharsRaw) ? Math.max(40, Math.min(400, Math.floor(quoteMaxCharsRaw))) : 200;

        const normalizeHeadingPath = (hp: any): string[] => {
          if (Array.isArray(hp)) return hp.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 16);
          const s = String(hp ?? "").trim();
          if (!s) return [];
          // allow: "A > B > C"
          if (s.includes(">")) return s.split(">").map((x) => x.trim()).filter(Boolean).slice(0, 16);
          return [s].filter(Boolean).slice(0, 16);
        };

        const startsWith = (full: string[], prefix: string[]) => {
          if (!prefix.length) return false;
          if (full.length < prefix.length) return false;
          for (let i = 0; i < prefix.length; i += 1) if (String(full[i] ?? "") !== String(prefix[i] ?? "")) return false;
          return true;
        };

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const doc = db.sourceDocs.find((d) => String(d.id ?? "").trim() === sourceDocId);
          if (!doc) return { ok: false, error: "DOC_NOT_FOUND" };

          let picked: KbArtifact | null = null;
          if (artifactId) {
            picked = db.artifacts.find((a) => String(a.id ?? "").trim() === artifactId && a.sourceDocId === doc.id) ?? null;
          } else if (Number.isFinite(paragraphIndex) && paragraphIndex >= 0) {
            const pi = Math.floor(paragraphIndex);
            picked =
              db.artifacts.find(
                (a) => a.sourceDocId === doc.id && a.kind === "paragraph" && Number(a.anchor?.paragraphIndex) === pi,
              ) ?? null;
          } else {
            const headingPath = normalizeHeadingPath((args as any)?.headingPath);
            if (headingPath.length) {
              const candidates = db.artifacts
                .filter((a) => a.sourceDocId === doc.id && a.kind === "paragraph")
                .filter((a) => {
                  const hp = Array.isArray(a.anchor?.headingPath) ? a.anchor.headingPath : [];
                  return startsWith(hp, headingPath);
                })
                .slice()
                .sort((a, b) => (Number(a.anchor?.paragraphIndex ?? 0) || 0) - (Number(b.anchor?.paragraphIndex ?? 0) || 0));
              picked = candidates[0] ?? null;
            }
          }

          if (!picked) return { ok: false, error: "ANCHOR_NOT_FOUND" };

          const raw = String(picked.content ?? "").trim();
          if (!raw) return { ok: false, error: "EMPTY_CONTENT" };

          const content = raw.length > maxChars ? raw.slice(0, maxChars) + "\n…(truncated)\n" : raw;
          const quote = raw.replace(/\s+/g, " ").trim().slice(0, quoteMaxChars);

          const pi = Number(picked.anchor?.paragraphIndex);
          const paragraphIndexStart = Number.isFinite(pi) ? Math.max(0, Math.floor(pi)) : null;
          const headingPath = Array.isArray(picked.anchor?.headingPath) ? picked.anchor.headingPath.map((x) => String(x ?? "").trim()).filter(Boolean) : undefined;

          const ref: KbTextSpanRefV1 = {
            v: 1,
            libraryId: String(doc.libraryId ?? "").trim(),
            sourceDocId: doc.id,
            importedFrom: doc.importedFrom as any,
            segmentId: String(picked.id ?? "").trim() || `${doc.id}:p:${paragraphIndexStart ?? 0}`,
            paragraphIndexStart,
            ...(headingPath && headingPath.length ? { headingPath } : {}),
            quote: quote.slice(0, 200),
          };

          return { ok: true, ref, content, title: String(doc.title ?? "").trim() || undefined };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },

      getPlaybookTextForLibraries: async (libraryIds) => {
        const ok = await get().ensureReady();
        if (!ok) return "";
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const ids = Array.from(new Set((libraryIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        if (!ids.length) return "";

        const maxTotal = 12_000;
        let used = 0;
        const parts: string[] = [];
        const push = (s: string) => {
          if (!s) return;
          if (used >= maxTotal) return;
          const left = maxTotal - used;
          const chunk = s.length > left ? s.slice(0, left) + "\n…(playbook truncated)\n" : s;
          parts.push(chunk);
          used += chunk.length;
        };

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const libById = new Map(db.libraries.map((l) => [l.id, l]));
          const docs = db.sourceDocs;
          const arts = db.artifacts;

          for (const libId of ids) {
            const lib = libById.get(libId);
            if (!lib) continue;
            const pack = getFacetPack(lib.facetPackId ?? "speech_marketing_v1");
            const facetOrder = new Map(pack.facets.map((f, i) => [f.id, i]));

            const playbookRel = `__kb_playbook__/library/${libId}.md`;
            const playbookDoc = docs.find((d) => d.libraryId === libId && d.importedFrom?.kind === "project" && d.importedFrom.relPath === playbookRel);
            if (!playbookDoc) continue;

            const a = arts.filter((x) => x.sourceDocId === playbookDoc.id && x.kind === "card");
            const style = a.find((x) => x.cardType === "style_profile");
            const facets = a
              .filter((x) => x.cardType === "playbook_facet")
              .sort((x, y) => (facetOrder.get(String(x.facetIds?.[0] ?? "")) ?? 999) - (facetOrder.get(String(y.facetIds?.[0] ?? "")) ?? 999));
            const polish = a.find((x) => x.cardType === "final_polish_checklist");

            push(`【库级仿写手册】${lib.name}\n`);
            if (style?.content) {
              push(`\n${style.content}\n`);
            }
            if (facets.length) {
              push(`\n---\n\n【写法维度手册】\n`);
              for (const f of facets) {
                if (used >= maxTotal) break;
                push(`\n${f.content}\n`);
              }
            }
            if (polish?.content) {
              push(`\n---\n\n【终稿润色清单】\n`);
              push(`\n${polish.content}\n`);
            }
            push(`\n\n====\n\n`);
          }

          return parts.join("");
        } catch {
          return "";
        }
      },

      getPlaybookFacetCardsForLibrary: async (args) => {
        const ok = await get().ensureReady();
        if (!ok) return { ok: false, cards: [], error: "KB_DIR_NOT_SET" };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const libId = String(args?.libraryId ?? "").trim();
        const facetIds = Array.from(new Set((args?.facetIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        const maxCharsPerCard = typeof args?.maxCharsPerCard === "number" ? Math.max(200, Math.floor(args.maxCharsPerCard)) : 1200;
        const maxTotalChars = typeof args?.maxTotalChars === "number" ? Math.max(800, Math.floor(args.maxTotalChars)) : 9000;
        if (!libId || !facetIds.length) return { ok: true, cards: [] };

        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, cards: [], error: libraryMissingError(db, libId) };

          const pack = getFacetPack(lib.facetPackId ?? "speech_marketing_v1");
          const facetOrder = new Map(pack.facets.map((f, i) => [f.id, i]));
          const wanted = new Set(facetIds);

          const playbookRel = `__kb_playbook__/library/${libId}.md`;
          const playbookDoc = db.sourceDocs.find(
            (d) => d.libraryId === libId && d.importedFrom?.kind === "project" && d.importedFrom.relPath === playbookRel,
          );
          if (!playbookDoc) return { ok: true, cards: [] };

          const raw = db.artifacts
            .filter((a: any) => {
              if (a.kind !== "card") return false;
              if (a.sourceDocId !== playbookDoc.id) return false;
              if (String(a.cardType ?? "") !== "playbook_facet") return false;
              const fid = String(a.facetIds?.[0] ?? "").trim();
              if (!fid) return false;
              return wanted.has(fid);
            })
            .slice()
            .sort(
              (a: any, b: any) =>
                (facetOrder.get(String(a.facetIds?.[0] ?? "")) ?? 999) - (facetOrder.get(String(b.facetIds?.[0] ?? "")) ?? 999),
            );

          let used = 0;
          const cards: Array<{ facetId: string; title: string; content: string }> = [];
          for (const a of raw) {
            if (used >= maxTotalChars) break;
            const facetId = String(a.facetIds?.[0] ?? "").trim();
            if (!facetId) continue;
            const title = String(a.title ?? facetId).trim() || facetId;
            const contentRaw = String(a.content ?? "");
            const truncated = contentRaw.length > maxCharsPerCard;
            const content = truncated ? contentRaw.slice(0, maxCharsPerCard) + "\n…(facet card truncated)\n" : contentRaw;
            const left = maxTotalChars - used;
            const chunk = content.length > left ? content.slice(0, left) + "\n…(selected facets truncated)\n" : content;
            cards.push({ facetId, title, content: chunk });
            used += chunk.length;
          }

          return { ok: true, cards };
        } catch (e: any) {
          return { ok: false, cards: [], error: String(e?.message ?? e) };
        }
      },
    }),
    {
      name: "writing-ide.kb.v1",
      // 按产品策略：记忆“当前库选择”（重启后仍保持）；导入时会校验库是否仍存在
      partialize: (s) => ({ baseDir: s.baseDir, ownerKey: s.ownerKey, currentLibraryId: s.currentLibraryId }),
    },
  ),
);


