import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useWorkspaceStore } from "./workspaceStore";
import { useProjectStore } from "./projectStore";
import { useLayoutStore } from "./layoutStore";
import { useRunStore } from "./runStore";
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

type ImportedFrom =
  | { kind: "project"; relPath: string; entryIndex?: number }
  | { kind: "file"; absPath: string; entryIndex?: number };

export type KbLibrary = {
  id: string;
  name: string;
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
  generatedFacets?: number;
  error?: string;
  updatedAt: string;
};

type KbPendingImport = {
  kind: "project";
  paths: string[];
};

type KbDb = {
  version: 3;
  ownerKey: string;
  createdAt: string;
  updatedAt: string;
  libraries: KbLibrary[];
  trash: KbLibraryTrashItem[];
  sourceDocs: KbSourceDoc[];
  artifacts: KbArtifact[];
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
  libraries: Array<{ id: string; name: string; facetPackId: string; docCount: number; updatedAt: string }>;
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
  setLibraryFacetPack: (id: string, facetPackId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteLibraryToTrash: (id: string) => Promise<{ ok: boolean; error?: string }>;
  restoreLibraryFromTrash: (id: string) => Promise<{ ok: boolean; error?: string }>;
  purgeLibrary: (id: string) => Promise<{ ok: boolean; removedDocs: number; removedArtifacts: number; error?: string }>;
  emptyTrash: () => Promise<{ ok: boolean; removedLibraries: number; removedDocs: number; removedArtifacts: number; error?: string }>;
  resetLocalKb: () => Promise<{ ok: boolean; error?: string }>;

  importProjectPaths: (paths: string[]) => Promise<{ imported: number; skipped: number; docIds: string[] }>;
  importExternalFiles: (absPaths: string[]) => Promise<{ imported: number; skipped: number; docIds: string[] }>;
  extractCardsForDocs: (docIds: string[], opts?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    extracted: number;
    skipped: number;
    error?: string;
  }>;
  generateLibraryPlaybook: (libraryId: string, opts?: { signal?: AbortSignal }) => Promise<{ ok: boolean; facets?: number; error?: string }>;
  // 供 Agent 的 Context Pack 注入：读取库级“仿写手册”（StyleProfile + 维度手册）
  getPlaybookTextForLibraries: (libraryIds: string[]) => Promise<string>;

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
    libraryIds: string[];
    perDocTopN?: number;
    topDocs?: number;
    // 向量检索：默认开启；embeddingModel 可用于 A/B（例如 text-embedding-3-large / Embedding-V1）
    useVector?: boolean;
    embeddingModel?: string;
  }) => Promise<{ ok: boolean; groups?: KbSearchGroup[]; error?: string }>;
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

function normalizeText(input: string) {
  return String(input ?? "")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
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

  return [{ entryIndex: 0, text: raw }];
}

function guessTitle(args: { format: KbFormat; relPath?: string; absPath?: string; text: string }) {
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
  const p = args.relPath ?? args.absPath ?? "untitled";
  const parts = p.replaceAll("\\", "/").split("/");
  const base = parts[parts.length - 1] ?? p;
  return base.slice(0, 80);
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

    const libs: KbLibrary[] = rawLibs
      .map((x) => ({
        id: String(x?.id ?? "").trim(),
        name: String(x?.name ?? "").trim(),
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
    const ensuredLibs =
      libs.length > 0
        ? libs
        : rawSourceDocs.length > 0
          ? [{ id: migratedLibId, name: "历史导入", facetPackId: "speech_marketing_v1", createdAt: t, updatedAt: t }]
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
      version: 3,
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
    };
    return db;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // File not exists -> new db
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      const t = nowIso();
      return { version: 3, ownerKey: args.ownerKey, createdAt: t, updatedAt: t, libraries: [], trash: [], sourceDocs: [], artifacts: [] };
    }
    // Bad JSON -> start new db (avoid bricking)
    const t = nowIso();
    return { version: 3, ownerKey: args.ownerKey, createdAt: t, updatedAt: t, libraries: [], trash: [], sourceDocs: [], artifacts: [] };
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
  // 与 AgentPane 的策略一致：优先用 env，缺省走同源 /api（dev 通过 Vite proxy 转发）
  const raw = (import.meta as any).env?.VITE_GATEWAY_URL ?? "";
  return String(raw ?? "").trim();
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
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: args.signal,
      body: JSON.stringify({
        model: args.model,
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
      } catch {
        // ignore
      }
      return { ok: false, error: msg };
    }
    const json = await res.json().catch(() => null);
    if (!json?.ok) return { ok: false, error: "INVALID_RESPONSE" };
    if (!json?.styleProfile || !Array.isArray(json?.playbookFacets)) return { ok: false, error: "INVALID_RESPONSE" };
    return { ok: true, styleProfile: json.styleProfile, playbookFacets: json.playbookFacets };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function scoreArtifactText(args: { haystack: string; query: string }) {
  const q = args.query.trim().toLowerCase();
  if (!q) return { score: 0, idx: -1 };
  const h = args.haystack.toLowerCase();
  const idx = h.indexOf(q);
  if (idx < 0) return { score: 0, idx: -1 };
  // simple: early hit + length
  const score = Math.max(1, 1000 - idx) + Math.min(120, q.length) * 3;
  return { score, idx };
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
  try {
    return String((import.meta as any).env?.VITE_GATEWAY_URL ?? "").trim();
  } catch {
    return "";
  }
}

async function fetchEmbedding(args: { model?: string; input: string }): Promise<{ ok: true; embedding: number[]; modelUsed?: string } | { ok: false; error: string }> {
  const gatewayUrl = getGatewayUrl();
  const url = gatewayUrl ? `${gatewayUrl}/api/llm/embeddings` : "/api/llm/embeddings";
  try {
    const body: any = { input: args.input };
    if (args.model) body.model = args.model;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
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
  const inputs = Array.isArray(args.inputs) ? args.inputs.map((s) => String(s ?? "")) : [];
  if (!inputs.length) return { ok: false, error: "EMBEDDINGS_EMPTY_INPUTS" };
  try {
    const body: any = { input: inputs };
    if (args.model) body.model = args.model;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
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
        const libs = db.libraries
          .map((l) => ({
            id: l.id,
            name: l.name,
            facetPackId: normalizeFacetPackId((l as any).facetPackId),
            docCount: stats.docCountByLib.get(l.id) ?? 0,
            updatedAt: stats.updatedAtByLib.get(l.id) ?? l.updatedAt ?? l.createdAt,
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
        db.libraries.push({ id, name: nm, facetPackId: "speech_marketing_v1", createdAt: t, updatedAt: t });
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
        let alreadyGenerated = false;
        try {
          const db = await loadDb({ baseDir, ownerKey });
          const lib = db.libraries.find((l) => l.id === libId);
          if (!lib) return { ok: false, error: "LIBRARY_NOT_FOUND" };
          libName = lib.name;

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
            alreadyGenerated = hasCards || true;
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
          const yes = window.confirm(
            `库「${libName}」已生成过风格手册（已存在）。\n\n` +
              "是否仍然重跑并覆盖？\n\n" +
              "- 取消：不重跑\n" +
              "- 确认：仍然重跑（将入队，需点击 ▶ 开始）",
          );
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
              generatedFacets: undefined,
              updatedAt: now,
            };
          } else {
            next.push({
              id: makeId("kb_playbook_job"),
              libraryId: libId,
              libraryName: libName,
              status: "pending",
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
        set({ kbManagerOpen: true, kbManagerTab: "jobs", cardJobStatus: "running", cardJobError: null });

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
                const ret = await get().extractCardsForDocs([next.docId], { signal: cardJobsAbort.signal });
                cardJobsAbort = null;
                cardJobsAbortReason = null;

                if (!ret.ok) {
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
            markPlaybookJob(next.id, { status: "running", error: undefined });

            try {
              const libId = String(next.libraryId ?? "").trim();
              if (!libId) {
                markPlaybookJob(next.id, { status: "failed", error: "LIBRARY_ID_REQUIRED" });
                continue;
              }

              cardJobsAbort = new AbortController();
              const ret = await get().generateLibraryPlaybook(libId, { signal: cardJobsAbort.signal });
              cardJobsAbort = null;
              cardJobsAbortReason = null;

              if (!ret.ok) {
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
          if (!endedByControl && get().cardJobStatus === "running") set({ cardJobStatus: "idle" });
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
        set({ cardJobStatus: "paused" });
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
        set((s) => {
          const now = nowIso();
          return {
            cardJobStatus: "idle",
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
              skipped += 1;
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
              skipped += 1;
              continue;
            }
            const entries = splitIntoEntries({ text: clean });
            if (!entries.length) {
              skipped += 1;
              continue;
            }

            for (const entry of entries) {
              const entryIndex = Number.isFinite(entry.entryIndex) ? entry.entryIndex : 0;
              const entryText = normalizeText(entry.text);
              if (!entryText) {
                skipped += 1;
                continue;
              }
              const contentHash = fnv1a32Hex(entryText);

              const existing = db.sourceDocs.find(
                (d) =>
                  d.importedFrom?.kind === "project" &&
                  d.importedFrom.relPath === relPath &&
                  (typeof (d.importedFrom as any).entryIndex === "number" ? (d.importedFrom as any).entryIndex : 0) === entryIndex,
              );
              if (existing && existing.contentHash === contentHash) {
                skipped += 1;
                continue;
              }

              const id = existing?.id ?? makeId("kb_doc");
              const title = String(entry.title ?? "").trim() || guessTitle({ format, relPath, text: entryText });
              const now = nowIso();
              const doc: KbSourceDoc = {
                id,
                libraryId: libId,
                title,
                format,
                importedFrom: { kind: "project", relPath, entryIndex },
                contentHash,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
              };

              // upsert doc
              db.sourceDocs = [...db.sourceDocs.filter((x) => x.id !== id), doc];
              // rebuild artifacts for this doc
              db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== id);
              db.artifacts.push(...buildArtifacts({ format, sourceDocId: id, text: entryText }));

              imported += 1;
              importedDocIds.push(id);
              // 断点续传：每条 entry 都落盘一次
              await saveDb({ baseDir, ownerKey, db });
            }
          }

          set({ lastImportAt: nowIso() });
          await get().refreshLibraries().catch(() => void 0);
          kbLog("info", "kb.import.project.done", { imported, skipped, docIdCount: importedDocIds.length, sample: importedDocIds.slice(0, 6) });
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
          kbLog("error", "kb.import.project.failed", { error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }

        return { imported, skipped, docIds: importedDocIds };
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
        set({ isLoading: true, error: null });

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

          const errors: Array<{ path: string; error: string }> = [];
          const unique = Array.from(new Set((absPaths ?? []).map((p) => String(p ?? "").trim()).filter(Boolean)));
          for (const absPath of unique) {
            const format = extToFormat(absPath);
            const ret = await kbApi.extractTextFromFile(absPath);
            if (!ret?.ok || !ret.text) {
              const err = String(ret?.error ?? "EXTRACT_FAILED");
              errors.push({ path: absPath, error: err });
              skipped += 1;
              continue;
            }
            const clean = normalizeText(String(ret.text));
            if (!clean) {
              skipped += 1;
              continue;
            }
            const entries = splitIntoEntries({ text: clean });
            if (!entries.length) {
              skipped += 1;
              continue;
            }

            for (const entry of entries) {
              const entryIndex = Number.isFinite(entry.entryIndex) ? entry.entryIndex : 0;
              const entryText = normalizeText(entry.text);
              if (!entryText) {
                skipped += 1;
                continue;
              }
              const contentHash = fnv1a32Hex(entryText);

              const existing = db.sourceDocs.find(
                (d) =>
                  d.importedFrom?.kind === "file" &&
                  d.importedFrom.absPath === absPath &&
                  (typeof (d.importedFrom as any).entryIndex === "number" ? (d.importedFrom as any).entryIndex : 0) === entryIndex,
              );
              if (existing && existing.contentHash === contentHash) {
                skipped += 1;
                continue;
              }

              const id = existing?.id ?? makeId("kb_doc");
              const title = String(entry.title ?? "").trim() || guessTitle({ format, absPath, text: entryText });
              const now = nowIso();
              const doc: KbSourceDoc = {
                id,
                libraryId: libId,
                title,
                format,
                importedFrom: { kind: "file", absPath, entryIndex },
                contentHash,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
              };

              db.sourceDocs = [...db.sourceDocs.filter((x) => x.id !== id), doc];
              db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== id);
              db.artifacts.push(...buildArtifacts({ format, sourceDocId: id, text: entryText }));

              imported += 1;
              importedDocIds.push(id);
              await saveDb({ baseDir, ownerKey, db });
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

        return { imported, skipped, docIds: importedDocIds };
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

            const paras = db.artifacts
              .filter((a) => a.sourceDocId === id && a.kind === "paragraph")
              .slice(0, 180) // 控制 prompt 大小（MVP）
              .map((p) => ({
                index: typeof p.anchor?.paragraphIndex === "number" ? p.anchor.paragraphIndex : 0,
                text: p.content,
                headingPath: Array.isArray(p.anchor?.headingPath) ? p.anchor.headingPath : [],
              }));

            if (!paras.length) {
              skipped += 1;
              continue;
            }

            const ret = await postExtractCards({ paragraphs: paras, maxCards: 24, facetIds: packFacetIds, mode: "doc_v2", signal: opts?.signal });
            if (!ret.ok) return { ok: false, extracted, skipped, error: ret.error };

            const newArts: KbArtifact[] = [];
            for (const c of ret.cards) {
              const title = String(c?.title ?? "").trim();
              const content = String(c?.content ?? "").trim();
              const paragraphIndices = Array.isArray(c?.paragraphIndices) ? c.paragraphIndices : [];
              const pi = paragraphIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0);
              if (!title || !content || !pi.length) continue;
              const rawCardType = typeof c?.cardType === "string" ? String(c.cardType).trim() : "";
              const cardType =
                ["hook", "thesis", "ending", "one_liner", "outline", "other"].includes(rawCardType) ? rawCardType : "other";
              const rawFacetIds = Array.isArray(c?.facetIds) ? c.facetIds.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
              const facetIds = rawFacetIds.filter((x) => packFacetIdSet.has(x)).slice(0, 6);
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

          if (!docsPayload.length) return { ok: false, error: "NO_DOC_CARDS_YET（请先对该库文档跑完“抽卡任务”）" };

          const ret = await postBuildLibraryPlaybook({ facetIds: packFacetIds, docs: docsPayload, signal: opts?.signal });
          if (!ret.ok) return { ok: false, error: ret.error };

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
          const sp = ret.styleProfile;
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

          for (const f of ret.playbookFacets) {
            const facetId = String(f?.facetId ?? "").trim();
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
          db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== playbookDocId);
          db.artifacts.push(...newArts);
          await saveDb({ baseDir, ownerKey, db });

          await get().refreshLibraries().catch(() => void 0);
          return { ok: true, facets: newArts.filter((a) => a.cardType === "playbook_facet").length };
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

          stage("正在知识库检索：词法召回…", { resetTimer: true });
          for (const a of db.artifacts) {
            if (kind && a.kind !== kind) continue;
            if (facetIds.length > 0) {
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
                if (facetIds.length > 0) {
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

          // kb.search 完成：把状态留给上层（gatewayAgent 会设置“等待模型继续/生成…”）
          return { ok: true, groups };
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
    }),
    {
      name: "writing-ide.kb.v1",
      // 按产品策略：记忆“当前库选择”（重启后仍保持）；导入时会校验库是否仍存在
      partialize: (s) => ({ baseDir: s.baseDir, ownerKey: s.ownerKey, currentLibraryId: s.currentLibraryId }),
    },
  ),
);


