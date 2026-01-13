import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useWorkspaceStore } from "./workspaceStore";
import { useProjectStore } from "./projectStore";
import { useLayoutStore } from "./layoutStore";
import { OUTLINE_FACETS } from "../kb/facets";

type KbFormat = "md" | "mdx" | "txt" | "docx" | "pdf" | "unknown";
type KbArtifactKind = "outline" | "paragraph" | "card";

const OUTLINE_FACET_ID_SET = new Set(OUTLINE_FACETS.map((x) => x.id));

type ImportedFrom =
  | { kind: "project"; relPath: string }
  | { kind: "file"; absPath: string };

export type KbSourceDoc = {
  id: string;
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
  anchor: KbAnchor;
};

export type KbCardJobStatus = "pending" | "running" | "success" | "skipped" | "failed" | "cancelled";

export type KbCardJob = {
  id: string;
  docId: string;
  docTitle: string;
  status: KbCardJobStatus;
  extractedCards?: number;
  error?: string;
  updatedAt: string;
};

type KbDb = {
  version: 1;
  ownerKey: string;
  createdAt: string;
  updatedAt: string;
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

  // 抽卡任务（弹窗队列）
  cardModalOpen: boolean;
  cardJobStatus: "idle" | "running" | "paused";
  cardJobError: string | null;
  cardJobs: KbCardJob[];

  setQuery: (q: string) => void;
  setBaseDir: (dir: string | null) => void;
  pickBaseDir: () => Promise<void>;
  ensureReady: () => Promise<boolean>;

  importProjectPaths: (paths: string[]) => Promise<{ imported: number; skipped: number; docIds: string[] }>;
  importExternalFiles: (absPaths: string[]) => Promise<{ imported: number; skipped: number; docIds: string[] }>;
  extractCardsForDocs: (docIds: string[], opts?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    extracted: number;
    skipped: number;
    error?: string;
  }>;

  openCardJobsModal: () => void;
  closeCardJobsModal: () => void;
  enqueueCardJobs: (docIds: string[], opts?: { open?: boolean; autoStart?: boolean }) => Promise<void>;
  startCardJobs: () => Promise<void>;
  pauseCardJobs: () => void;
  resumeCardJobs: () => Promise<void>;
  cancelCardJobs: () => void;
  clearFinishedCardJobs: () => void;
  retryFailedCardJobs: () => void;

  search: (q?: string, options?: { kind?: KbArtifactKind; facetIds?: string[]; perDocTopN?: number; topDocs?: number }) => Promise<void>;
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
    // Minimal validation + forwards compatibility
    const db: KbDb = {
      version: 1,
      ownerKey: String(parsed?.ownerKey ?? args.ownerKey),
      createdAt: String(parsed?.createdAt ?? nowIso()),
      updatedAt: String(parsed?.updatedAt ?? nowIso()),
      sourceDocs: Array.isArray(parsed?.sourceDocs) ? parsed.sourceDocs : [],
      artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
    };
    return db;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // File not exists -> new db
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      const t = nowIso();
      return { version: 1, ownerKey: args.ownerKey, createdAt: t, updatedAt: t, sourceDocs: [], artifacts: [] };
    }
    // Bad JSON -> start new db (avoid bricking)
    const t = nowIso();
    return { version: 1, ownerKey: args.ownerKey, createdAt: t, updatedAt: t, sourceDocs: [], artifacts: [] };
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
  paragraphs: Array<{ index: number; text: string; headingPath?: string[] }>;
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
      cardModalOpen: false,
      cardJobStatus: "idle",
      cardJobError: null,
      cardJobs: [],

      setQuery: (query) => set({ query }),
      setBaseDir: (dir) => {
        const clean = dir ? String(dir).trim() : null;
        set({ baseDir: clean });
        useWorkspaceStore.getState().setKbBaseDir(clean);
      },

      pickBaseDir: async () => {
        const api = window.desktop?.fs;
        if (!api) return;
        const res = await api.pickDirectory();
        if (!res?.ok || !res.dir) return;
        get().setBaseDir(res.dir);
        // 展开左侧 KB，给用户反馈
        useLayoutStore.getState().openSection("kb");
      },

      ensureReady: async () => {
        const dir = get().baseDir;
        if (dir) return true;
        // 引导用户选择目录
        useLayoutStore.getState().openSection("kb");
        return false;
      },

      openCardJobsModal: () => set({ cardModalOpen: true }),
      closeCardJobsModal: () => set({ cardModalOpen: false }),

      enqueueCardJobs: async (docIds, opts) => {
        const ok = await get().ensureReady();
        if (!ok) return;
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        const unique = Array.from(new Set((docIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)));
        if (!unique.length) return;

        let titleById = new Map<string, string>();
        try {
          const db = await loadDb({ baseDir, ownerKey });
          titleById = new Map(db.sourceDocs.map((d) => [d.id, d.title]));
        } catch {
          // ignore
        }

        set((s) => {
          const exists = new Set(s.cardJobs.map((j) => j.docId));
          const now = nowIso();
          const nextJobs = [...s.cardJobs];
          for (const id of unique) {
            if (exists.has(id)) continue;
            nextJobs.push({
              id: makeId("kb_card_job"),
              docId: id,
              docTitle: titleById.get(id) ?? id,
              status: "pending",
              updatedAt: now,
            });
          }
          return {
            cardJobs: nextJobs,
            cardModalOpen: opts?.open ?? s.cardModalOpen,
            cardJobError: null,
          };
        });

        if (opts?.autoStart) void get().startCardJobs();
      },

      startCardJobs: async () => {
        const ok = await get().ensureReady();
        if (!ok) return;
        set({ cardModalOpen: true, cardJobStatus: "running", cardJobError: null });

        if (cardJobsRunner) {
          // 可能存在：用户“暂停”后很快点击“继续”，旧 runner 还没退出。
          // 这里等待旧 runner 退出后，如仍处于 running 状态则自动拉起新的 runner。
          return cardJobsRunner.then(async () => {
            if (get().cardJobStatus === "running") await get().startCardJobs();
          });
        }

        const markJob = (jobId: string, patch: Partial<KbCardJob>) => {
          const now = nowIso();
          set((s) => ({
            cardJobs: s.cardJobs.map((j) => (j.id === jobId ? { ...j, ...patch, updatedAt: now } : j)),
          }));
        };

        const run = async () => {
          let endedByControl = false;
          while (true) {
            if (get().cardJobStatus !== "running") break;
            const next = get().cardJobs.find((j) => j.status === "pending");
            if (!next) break;

            markJob(next.id, { status: "running", error: undefined });

            try {
              const baseDir = get().baseDir!;
              const ownerKey = get().ownerKey;
              const db = await loadDb({ baseDir, ownerKey });
              const hasCard = db.artifacts.some((a) => a.sourceDocId === next.docId && a.kind === "card");
              if (hasCard) {
                markJob(next.id, { status: "skipped" });
                continue;
              }

              cardJobsAbort = new AbortController();
              const ret = await get().extractCardsForDocs([next.docId], { signal: cardJobsAbort.signal });
              cardJobsAbort = null;
              cardJobsAbortReason = null;

              if (!ret.ok) {
                markJob(next.id, { status: "failed", error: ret.error ?? "EXTRACT_FAILED" });
                continue;
              }

              if (ret.extracted > 0) {
                markJob(next.id, { status: "success", extractedCards: ret.extracted });
                continue;
              }

              if (ret.skipped > 0) {
                markJob(next.id, { status: "skipped", extractedCards: 0 });
                continue;
              }

              markJob(next.id, { status: "success", extractedCards: 0 });
            } catch (e: any) {
              const aborted = Boolean(cardJobsAbort?.signal.aborted);
              const reason = cardJobsAbortReason;
              cardJobsAbort = null;
              cardJobsAbortReason = null;

              if (aborted && reason === "pause") {
                // 暂停：把当前 job 退回 pending，等待继续
                endedByControl = true;
                markJob(next.id, { status: "pending" });
                break;
              }

              if (aborted && reason === "cancel") {
                endedByControl = true;
                markJob(next.id, { status: "cancelled" });
                break;
              }

              markJob(next.id, { status: "failed", error: String(e?.message ?? e) });
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
        set({ cardJobStatus: "running", cardJobError: null, cardModalOpen: true });
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
        set((s) => ({ cardJobs: s.cardJobs.filter((j) => j.status === "pending" || j.status === "running" || j.status === "failed") }));
      },

      retryFailedCardJobs: () => {
        set((s) => {
          const now = nowIso();
          return {
            cardJobs: s.cardJobs.map((j) => (j.status === "failed" ? { ...j, status: "pending", error: undefined, updatedAt: now } : j)),
          };
        });
      },

      importProjectPaths: async (paths) => {
        const ok = await get().ensureReady();
        if (!ok) return { imported: 0, skipped: 0, docIds: [] };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;
        const proj = useProjectStore.getState();

        let imported = 0;
        let skipped = 0;
        const importedDocIds: string[] = [];
        set({ isLoading: true, error: null });

        try {
          const db = await loadDb({ baseDir, ownerKey });

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
            const contentHash = fnv1a32Hex(clean);

            const existing = db.sourceDocs.find((d) => d.importedFrom?.kind === "project" && d.importedFrom.relPath === relPath);
            if (existing && existing.contentHash === contentHash) {
              skipped += 1;
              continue;
            }

            const id = existing?.id ?? makeId("kb_doc");
            const title = guessTitle({ format, relPath, text: clean });
            const now = nowIso();
            const doc: KbSourceDoc = {
              id,
              title,
              format,
              importedFrom: { kind: "project", relPath },
              contentHash,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            };

            // upsert doc
            db.sourceDocs = [...db.sourceDocs.filter((x) => x.id !== id), doc];
            // rebuild artifacts for this doc
            db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== id);
            db.artifacts.push(...buildArtifacts({ format, sourceDocId: id, text: clean }));

            imported += 1;
            importedDocIds.push(id);
            // 断点续传：每个文件都落盘一次
            await saveDb({ baseDir, ownerKey, db });
          }

          set({ lastImportAt: nowIso() });
        } catch (e: any) {
          set({ error: String(e?.message ?? e) });
        } finally {
          set({ isLoading: false });
        }

        return { imported, skipped, docIds: importedDocIds };
      },

      importExternalFiles: async (absPaths) => {
        const ok = await get().ensureReady();
        if (!ok) return { imported: 0, skipped: 0, docIds: [] };
        const baseDir = get().baseDir!;
        const ownerKey = get().ownerKey;

        let imported = 0;
        let skipped = 0;
        const importedDocIds: string[] = [];
        set({ isLoading: true, error: null });

        try {
          const db = await loadDb({ baseDir, ownerKey });
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
            const contentHash = fnv1a32Hex(clean);

            const existing = db.sourceDocs.find((d) => d.importedFrom?.kind === "file" && d.importedFrom.absPath === absPath);
            if (existing && existing.contentHash === contentHash) {
              skipped += 1;
              continue;
            }

            const id = existing?.id ?? makeId("kb_doc");
            const title = guessTitle({ format, absPath, text: clean });
            const now = nowIso();
            const doc: KbSourceDoc = {
              id,
              title,
              format,
              importedFrom: { kind: "file", absPath },
              contentHash,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            };

            db.sourceDocs = [...db.sourceDocs.filter((x) => x.id !== id), doc];
            db.artifacts = db.artifacts.filter((a) => a.sourceDocId !== id);
            db.artifacts.push(...buildArtifacts({ format, sourceDocId: id, text: clean }));

            imported += 1;
            importedDocIds.push(id);
            await saveDb({ baseDir, ownerKey, db });
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

          for (const id of ids) {
            const hasCard = db.artifacts.some((a) => a.sourceDocId === id && a.kind === "card");
            if (hasCard) {
              skipped += 1;
              continue;
            }

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

            const ret = await postExtractCards({ paragraphs: paras, maxCards: 18, signal: opts?.signal });
            if (!ret.ok) return { ok: false, extracted, skipped, error: ret.error };

            const newArts: KbArtifact[] = [];
            for (const c of ret.cards) {
              const title = String(c?.title ?? "").trim();
              const content = String(c?.content ?? "").trim();
              const paragraphIndices = Array.isArray(c?.paragraphIndices) ? c.paragraphIndices : [];
              const pi = paragraphIndices.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n) && n >= 0);
              if (!title || !content || !pi.length) continue;
              const cardType = typeof c?.type === "string" ? String(c.type).trim() : "";
              const rawFacetIds = Array.isArray(c?.facetIds) ? c.facetIds.map((x: any) => String(x ?? "").trim()).filter(Boolean) : [];
              const facetIds = rawFacetIds
                .filter((x) => OUTLINE_FACET_ID_SET.has(x))
                .slice(0, 6);
              const safeFacetIds = facetIds.length ? facetIds : ["logic_framework"];

              newArts.push({
                id: makeId("kb_card"),
                sourceDocId: id,
                kind: "card",
                title,
                cardType: cardType || undefined,
                content: `### ${title}\n\n${content}\n`,
                facetIds: safeFacetIds,
                anchor: { paragraphIndex: pi[0] ?? 0 },
              });
            }

            if (!newArts.length) {
              skipped += 1;
              continue;
            }

            db.artifacts.push(...newArts);
            await saveDb({ baseDir, ownerKey, db });
            extracted += 1;
          }

          return { ok: true, extracted, skipped };
        } catch (e: any) {
          return { ok: false, extracted, skipped, error: String(e?.message ?? e) };
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

          // 空查询：展示最近文档的若干片段（按 kind/facet 过滤），用于“导入后立刻能看到卡片”
          if (!query) {
            const docs = db.sourceDocs
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
    }),
    {
      name: "writing-ide.kb.v1",
      partialize: (s) => ({ baseDir: s.baseDir, ownerKey: s.ownerKey }),
    },
  ),
);


