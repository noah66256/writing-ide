import type { editor } from "monaco-editor";
import { create } from "zustand";
import { useRunStore } from "./runStore";

export type ProjectFile = {
  path: string;
  content: string;
  loaded: boolean;
  dirty: boolean;
};

export type ProjectSnapshot = {
  dirs?: string[];
  files: ProjectFile[];
  openPaths: string[];
  activePath: string;
  previewPath: string | null;
};

export type SavedSnapshot = {
  id: string;
  label: string;
  createdAt: string;
  snap: ProjectSnapshot;
};

type ProjectState = {
  rootDir: string | null;
  isLoading: boolean;
  error: string | null;

  dirs: string[]; // 目录列表（相对 rootDir，可包含空目录）
  files: ProjectFile[];
  openPaths: string[];
  activePath: string;
  previewPath: string | null; // 单击预览：复用同一个“预览 tab”
  snapshots: SavedSnapshot[];
  editorRef: editor.IStandaloneCodeEditor | null;
  docOpUndoByPath: Record<string, Array<{ label: string; before: string; after: string; ts: number }>>;
  docOpRedoByPath: Record<string, Array<{ label: string; before: string; after: string; ts: number }>>;

  setEditorRef: (ref: editor.IStandaloneCodeEditor | null) => void;
  setActivePath: (path: string) => void;
  openFilePreview: (path: string) => void; // 单击：预览（替换上一个预览 tab）
  openFilePinned: (path: string) => void; // 双击：固定（新增 tab，不影响预览 tab）
  closeTab: (path: string) => void; // 关闭标签页（不删除文件）
  updateFile: (path: string, content: string) => void;
  writeFileNow: (path: string, content: string) => Promise<void>;
  ensureLoaded: (path: string) => Promise<string>;
  saveActiveNow: () => Promise<void>;
  createFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  deletePath: (path: string) => Promise<void>;
  getFileByPath: (path: string) => ProjectFile | undefined;

  loadProjectFromDisk: (rootDir: string) => Promise<void>;
  refreshFromDisk: (reason?: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  renamePath: (fromPath: string, toPath: string) => Promise<{ ok: boolean; error?: string; detail?: string }>;

  commitSnapshot: (label?: string) => SavedSnapshot;
  deleteSnapshot: (snapshotId: string) => void;
  getSnapshot: (snapshotId: string) => SavedSnapshot | undefined;

  snapshot: () => ProjectSnapshot;
  restore: (snap: ProjectSnapshot) => void;

  // Doc Ops：结构操作（章节移动/升降级等）独立 Undo/Redo（不与 Monaco 文本输入 Undo 混在一起）
  applyDocOp: (path: string, nextContent: string, label: string) => void;
  undoDocOp: (path: string) => void;
  redoDocOp: (path: string) => void;
};

const DEFAULT_DOC_RULES =
  `## Doc Rules（文档规则）\n\n` +
  `> 这是“项目级长期规则”，跨 Run 生效；用于约束写作目标、风格与禁用项，防止越写越跑偏。\n` +
  `> 修改规则必须走“提案→确认→写入”，并保留版本可回滚。\n\n` +
  `### 写作定位\n` +
  `- 本项目是**写作 IDE**：一切以写作产出与编辑体验为中心。\n\n` +
  `### 默认风格与口吻（可按项目改）\n` +
  `- 语气：清晰、直接、结构化。\n` +
  `- 句长：中短句为主，避免拖沓。\n` +
  `- 禁用：空泛口号、无依据的数据/年份、强行营销腔（除非目标明确需要）。\n\n` +
  `### 平台画像优先级\n` +
  `- 默认先明确平台画像（feed 试看型 / 点选搜索型 / 长内容订阅型），再写作与改写。\n\n` +
  `### 引用与事实\n` +
  `- 涉及事实/数据/年份：尽量给来源；不确定就提示风险，不要编造。\n\n` +
  `### 输出格式约束（Plan/Agent）\n` +
  `- 优先输出结构（outline）再展开正文。\n`;

const saveTimers = new Map<string, number>();
let refreshInFlight: Promise<void> | null = null;
let refreshQueuedReason: string | null = null;

const SUPPORTED_TEXT_EXT = new Set([".md", ".mdx", ".txt"]);

function normalizeRel(p: string) {
  let s = String(p ?? "").trim().replaceAll("\\", "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/^\.\//, "");
  s = s.replace(/\/+$/g, "");
  return s;
}

function relBasename(p: string) {
  const s = String(p ?? "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function relDirname(p: string) {
  const s = String(p ?? "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}

function relJoin(dir: string, name: string) {
  const d = String(dir ?? "").replace(/\/+$/g, "");
  const n = String(name ?? "").replace(/^\/+/g, "");
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}

function extnameLower(p: string) {
  const b = relBasename(p);
  const m = b.match(/\.[^./]+$/);
  return (m?.[0] ?? "").toLowerCase();
}

function hasExtInBaseName(p: string) {
  const b = relBasename(p);
  return /\.[^./]+$/.test(b);
}

function mapRecordKeys<T>(rec: Record<string, T>, mapKey: (k: string) => string) {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    const nk = mapKey(String(k));
    out[nk] = v;
  }
  return out;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  rootDir: null,
  isLoading: false,
  error: null,

  dirs: [],
  files: [
    {
      path: "drafts/draft.md",
      content: `---\ntitle: 草稿\nplatform_type: feed_preview\n---\n\n# 草稿\n\n在这里开始写作…\n`,
      loaded: true,
      dirty: false,
    },
    {
      path: "doc.rules.md",
      content: DEFAULT_DOC_RULES,
      loaded: true,
      dirty: false,
    },
  ],
  openPaths: ["drafts/draft.md"],
  activePath: "drafts/draft.md",
  previewPath: "drafts/draft.md",
  snapshots: [],
  editorRef: null,
  docOpUndoByPath: {},
  docOpRedoByPath: {},

  setEditorRef: (ref) => set({ editorRef: ref }),
  setActivePath: (path) => {
    set({ activePath: path });
    void get().ensureLoaded(path);
  },
  openFilePreview: (path) => {
    set((s) => {
      if (!s.files.some((f) => f.path === path)) return {};
      if (s.openPaths.includes(path)) return { activePath: path };

      if (s.previewPath && s.openPaths.includes(s.previewPath)) {
        const idx = s.openPaths.indexOf(s.previewPath);
        const next = s.openPaths.slice();
        next[idx] = path;
        return { openPaths: next, activePath: path, previewPath: path };
      }

      return { openPaths: [...s.openPaths, path], activePath: path, previewPath: path };
    });
    void get().ensureLoaded(path);
  },
  openFilePinned: (path) => {
    set((s) => {
      if (!s.files.some((f) => f.path === path)) return {};
      if (s.openPaths.includes(path)) {
        return { activePath: path, previewPath: s.previewPath === path ? null : s.previewPath };
      }
      return { openPaths: [...s.openPaths, path], activePath: path };
    });
    void get().ensureLoaded(path);
  },
  closeTab: (path) =>
    set((s) => {
      const idx = s.openPaths.indexOf(path);
      if (idx < 0) return {};
      const nextOpen = s.openPaths.filter((p) => p !== path);
      const nextPreview = s.previewPath === path ? null : s.previewPath;
      let nextActive = s.activePath;

      if (s.activePath === path) {
        nextActive = nextOpen[idx - 1] ?? nextOpen[idx] ?? nextOpen[0] ?? "";
      }

      if (!nextOpen.length) {
        const fallback = s.files[0]?.path ?? "";
        if (fallback) {
          return { openPaths: [fallback], activePath: fallback, previewPath: fallback };
        }
      }

      return { openPaths: nextOpen, activePath: nextActive, previewPath: nextPreview };
    }),
  updateFile: (path, content) => {
    const prev = get().getFileByPath(path)?.content ?? "";
    if (prev === content) return;
    set((s) => ({
      files: s.files.map((f) => (f.path === path ? { ...f, content, loaded: true, dirty: true } : f)),
    }));

    const rootDir = get().rootDir;
    const api = window.desktop?.fs;
    if (!rootDir || !api) return;

    const prevTimer = saveTimers.get(path);
    if (prevTimer) window.clearTimeout(prevTimer);

    const t = window.setTimeout(async () => {
      const file = get().getFileByPath(path);
      if (!file) return;
      await api.writeFile(rootDir, path, file.content);
      set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, dirty: false } : f)),
      }));
    }, 500);
    saveTimers.set(path, t);
  },
  writeFileNow: async (path, content) => {
    set((st) => ({
      files: st.files.map((f) => (f.path === path ? { ...f, content, loaded: true, dirty: false } : f)),
    }));
    const timer = saveTimers.get(path);
    if (timer) window.clearTimeout(timer);
    saveTimers.delete(path);

    const rootDir = get().rootDir;
    const api = window.desktop?.fs;
    if (!rootDir || !api) return;
    await api.writeFile(rootDir, path, content);
  },
  ensureLoaded: async (path) => {
    const s = get();
    const file = s.getFileByPath(path);
    if (!file) return "";
    if (file.loaded) return file.content;
    const rootDir = s.rootDir;
    const api = window.desktop?.fs;
    if (!rootDir || !api) return file.content;
    const res = await api.readFile(rootDir, path);
    if (!res.ok) return file.content;
    set((st) => ({
      files: st.files.map((f) => (f.path === path ? { ...f, content: res.content ?? "", loaded: true, dirty: false } : f)),
    }));
    return res.content ?? "";
  },
  saveActiveNow: async () => {
    const s = get();
    const rootDir = s.rootDir;
    const api = window.desktop?.fs;
    if (!rootDir || !api) return;
    const file = s.getFileByPath(s.activePath);
    if (!file) return;
    await api.writeFile(rootDir, file.path, file.content);
    set((st) => ({
      files: st.files.map((f) => (f.path === file.path ? { ...f, dirty: false } : f)),
    }));
  },
  createFile: (path, content) => {
    const s = get();
    if (s.files.some((f) => f.path === path)) return;
    set((st) => ({
      files: [{ path, content, loaded: true, dirty: false }, ...st.files],
      openPaths: st.openPaths.includes(path) ? st.openPaths : [...st.openPaths, path],
      activePath: path,
      previewPath: st.previewPath ?? path,
    }));
    void (async () => {
      await get().writeFileNow(path, content);
      await get().refreshFromDisk("createFile");
    })();
  },
  deleteFile: (path) => {
    const s = get();
    const rootDir = s.rootDir;
    const api = window.desktop?.fs;
    set((st) => {
      const files = st.files.filter((f) => f.path !== path);
      const openPaths = st.openPaths.filter((p) => p !== path);
      const activePath = st.activePath === path ? openPaths[0] ?? files[0]?.path ?? "" : st.activePath;
      const previewPath = st.previewPath === path ? null : st.previewPath;
      return { files, openPaths, activePath, previewPath };
    });
    if (rootDir && api) {
      void api
        .deleteFile(rootDir, path)
        .then(() => get().refreshFromDisk("deleteFile"))
        .catch(() => ({ ok: false }));
    }
  },
  deletePath: async (path) => {
    const rel = normalizeRel(path);
    if (!rel) return;
    const api = window.desktop?.fs;
    const rootDir = get().rootDir;
    if (!api || !rootDir) return;

    const snap = get().snapshot();
    const st0 = get();
    const isDir = st0.dirs.includes(rel);
    const isFile = !!st0.files.find((f) => f.path === rel);
    const prefix = `${rel}/`;
    if (!isDir && !isFile) return;

    // 先更新内存（避免 UI 卡住），失败再回滚
    set((s) => {
      const removedPaths = new Set<string>();
      const nextFiles = isDir
        ? s.files.filter((f) => {
            const drop = f.path === rel || f.path.startsWith(prefix);
            if (drop) removedPaths.add(f.path);
            return !drop;
          })
        : s.files.filter((f) => {
            const drop = f.path === rel;
            if (drop) removedPaths.add(f.path);
            return !drop;
          });

      const nextDirs = isDir ? s.dirs.filter((d) => d !== rel && !d.startsWith(prefix)) : s.dirs;
      const openPaths = s.openPaths.filter((p) => !removedPaths.has(p));
      const activePath = removedPaths.has(s.activePath) ? (openPaths[0] ?? nextFiles[0]?.path ?? "") : s.activePath;
      const previewPath = s.previewPath && removedPaths.has(s.previewPath) ? null : s.previewPath;
      return { dirs: nextDirs, files: nextFiles, openPaths, activePath, previewPath };
    });

    try {
      if (api.deletePath) {
        await api.deletePath(rootDir, rel);
      } else {
        // 兼容旧实现：只能删文件
        if (!isDir) await api.deleteFile(rootDir, rel);
      }
      await get().refreshFromDisk("deletePath");
    } catch (e: any) {
      get().restore(snap as any);
      useRunStore.getState().log("error", "delete.failed", { path: rel, message: String(e?.message ?? e) });
    }
  },
  getFileByPath: (path) => get().files.find((f) => f.path === path),

  loadProjectFromDisk: async (rootDir) => {
    const api = window.desktop?.fs;
    if (!api) {
      set({ error: "NO_DESKTOP_FS", isLoading: false });
      return;
    }

    set({ rootDir, isLoading: true, error: null });
    const list = await (api.listEntries ? api.listEntries(rootDir) : api.listFiles(rootDir));
    const filesList = (list as any).files;
    const dirsList = (list as any).dirs;
    if (!list.ok || !Array.isArray(filesList)) {
      set({ error: (list as any).error ?? "LIST_FILES_FAILED", isLoading: false });
      return;
    }

    let files = filesList.slice();
    let dirs = Array.isArray(dirsList) ? dirsList.slice() : [];
    if (!files.includes("doc.rules.md")) {
      await api.writeFile(rootDir, "doc.rules.md", DEFAULT_DOC_RULES);
      files.unshift("doc.rules.md");
    }

    const projFiles: ProjectFile[] = [];
    for (const p of files) {
      try {
        const r = await api.readFile(rootDir, p);
        projFiles.push({ path: p, content: r.ok ? (r.content ?? "") : "", loaded: true, dirty: false });
      } catch {
        projFiles.push({ path: p, content: "", loaded: true, dirty: false });
      }
    }
    const active = files.includes("README.md") ? "README.md" : files[0] ?? "";
    set({
      dirs,
      files: projFiles,
      openPaths: active ? [active] : [],
      activePath: active,
      previewPath: active || null,
      snapshots: [],
      isLoading: false,
      error: null,
    });

    // 启动文件监听
    try {
      await api.watchStart?.(rootDir);
    } catch {
      // ignore
    }
  },

  refreshFromDisk: async (reason) => {
    if (refreshInFlight) {
      refreshQueuedReason = reason ?? "queued";
      return;
    }
    refreshQueuedReason = null;
    refreshInFlight = (async () => {
    const api = window.desktop?.fs;
    const rootDir = get().rootDir;
    if (!api || !rootDir) return;

    const list = await (api.listEntries ? api.listEntries(rootDir) : api.listFiles(rootDir));
    const diskFiles: string[] = Array.isArray((list as any).files) ? (list as any).files.slice() : [];
    const diskDirs: string[] = Array.isArray((list as any).dirs) ? (list as any).dirs.slice() : [];
    diskFiles.sort((a, b) => a.localeCompare(b));
    diskDirs.sort((a, b) => a.localeCompare(b));

    const prevFiles = get().files;
    const prevMap = new Map(prevFiles.map((f) => [f.path, f]));
    const diskSet = new Set(diskFiles);

    const nextFiles: ProjectFile[] = [];
    for (const p of diskFiles) {
      const prev = prevMap.get(p);
      if (prev?.dirty) {
        // 本地未保存：不覆盖
        nextFiles.push({ ...prev, loaded: true });
        continue;
      }
      try {
        const r = await api.readFile(rootDir, p);
        nextFiles.push({ path: p, content: r.ok ? (r.content ?? "") : "", loaded: true, dirty: false });
      } catch {
        nextFiles.push({ path: p, content: prev?.content ?? "", loaded: true, dirty: false });
      }
    }

    // 处理被外部删除的文件：dirty 的先保留（避免丢内容），否则移除并关闭 tab
    const removed = prevFiles.filter((f) => !diskSet.has(f.path));
    const removedDirty = removed.filter((f) => f.dirty);
    for (const f of removedDirty) nextFiles.push({ ...f, loaded: true });

    set((s) => {
      const removedSet = new Set(removed.filter((x) => !x.dirty).map((x) => x.path));
      const openPaths = s.openPaths.filter((p) => !removedSet.has(p));
      const activePath = removedSet.has(s.activePath) ? (openPaths[0] ?? nextFiles[0]?.path ?? "") : s.activePath;
      const previewPath = s.previewPath && removedSet.has(s.previewPath) ? null : s.previewPath;
      return { dirs: diskDirs, files: nextFiles, openPaths, activePath, previewPath };
    });

    if (removedDirty.length) {
      useRunStore.getState().log("warn", "检测到外部删除，但本地有未保存内容：已保留内存版本（请手动另存）", {
        reason: reason ?? "unknown",
        paths: removedDirty.map((x) => x.path),
      });
    }
    // dirty 文件如被外部修改，这里无法精准判断是否变化；保持“本地优先”，避免覆盖
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
    if (refreshQueuedReason) {
      const nextReason = refreshQueuedReason;
      refreshQueuedReason = null;
      void get().refreshFromDisk(nextReason);
    }
  },

  mkdir: async (dirPath) => {
    const api = window.desktop?.fs;
    const rootDir = get().rootDir;
    if (!api || !rootDir) return;
    const rel = normalizeRel(dirPath);
    if (!rel) return;
    await api.mkdir(rootDir, rel);
    await get().refreshFromDisk("mkdir");
  },

  renamePath: async (fromPath, toPath) => {
    const api = window.desktop?.fs;
    const rootDir = get().rootDir;
    if (!api || !rootDir) return { ok: false, error: "FS_NOT_READY" };
    const fromRel = normalizeRel(fromPath);
    const toRel0 = normalizeRel(toPath);
    if (!fromRel || !toRel0) return { ok: false, error: "INVALID_PATH" };
    if (fromRel === toRel0) return { ok: true };

    const st0 = get();
    const isFile = !!st0.files.find((f) => f.path === fromRel);
    const isDir = st0.dirs.includes(fromRel);
    if (!isFile && !isDir) return { ok: false, error: "PATH_NOT_FOUND" };

    const prefix = `${fromRel}/`;
    let toRel = toRel0;

    // 文件：如果用户没写后缀，自动继承原后缀（否则刷新后会“看起来像丢了”，因为 Explorer 只展示 .md/.mdx/.txt）
    if (isFile) {
      const fromExt = extnameLower(fromRel);
      if (fromExt && !hasExtInBaseName(toRel)) {
        const base = relBasename(toRel);
        toRel = relJoin(relDirname(toRel), `${base}${fromExt}`);
      }
      if (toRel === fromRel) return { ok: true };
      const ext = extnameLower(toRel);
      if (ext && !SUPPORTED_TEXT_EXT.has(ext)) return { ok: false, error: "UNSUPPORTED_EXT", detail: ext };
    }

    // 禁止把目录移动到自身或子目录
    if (!isFile) {
      if (toRel === fromRel || toRel.startsWith(prefix)) {
        useRunStore.getState().log("warn", "rename.blocked", { from: fromRel, to: toRel, reason: "into_self" });
        return { ok: false, error: "INTO_SELF" };
      }
    }

    // 简单冲突检测（避免覆盖/合并导致不可控）
    const hasFileAt = (p: string) => !!st0.files.find((f) => f.path === p);
    const hasDirAt = (p: string) => (p ? st0.dirs.includes(p) : false);
    if (isFile) {
      if (hasFileAt(toRel) || hasDirAt(toRel)) {
        useRunStore.getState().log("warn", "rename.blocked", { from: fromRel, to: toRel, reason: "dest_exists" });
        return { ok: false, error: "DEST_EXISTS" };
      }
    } else {
      const destPrefix = `${toRel}/`;
      const collides = hasDirAt(toRel) || st0.files.some((f) => f.path === toRel || f.path.startsWith(destPrefix));
      if (collides) {
        useRunStore.getState().log("warn", "rename.blocked", { from: fromRel, to: toRel, reason: "dest_exists" });
        return { ok: false, error: "DEST_EXISTS" };
      }
    }

    // 影响范围内：先清理自动保存定时器；再把 dirty 文件写盘。任何写盘失败都直接终止（避免“以为改名了但内容丢了”）。
    const affectedFiles = isFile ? st0.files.filter((f) => f.path === fromRel) : st0.files.filter((f) => f.path.startsWith(prefix));
    for (const f of affectedFiles) {
      const t = saveTimers.get(f.path);
      if (t) window.clearTimeout(t);
      saveTimers.delete(f.path);
    }
    const failedSaves: string[] = [];
    for (const f of affectedFiles) {
      if (!f.dirty) continue;
      try {
        const r = await api.writeFile(rootDir, f.path, f.content);
        if (!r?.ok) failedSaves.push(f.path);
      } catch {
        failedSaves.push(f.path);
      }
    }
    if (failedSaves.length) {
      useRunStore.getState().log("error", "rename.save_dirty_failed", { from: fromRel, to: toRel, failed: failedSaves });
      return { ok: false, error: "SAVE_DIRTY_FAILED", detail: failedSaves.slice(0, 8).join(", ") };
    }

    // 先改磁盘，再更新内存映射（避免磁盘失败时 UI 先变导致“错觉丢文件/不生效”）
    let rr: any = null;
    try {
      rr = await api.renamePath(rootDir, fromRel, toRel);
    } catch (e: any) {
      rr = { ok: false, error: "RENAME_FAILED", detail: String(e?.message ?? e) };
    }
    if (!rr?.ok) {
      useRunStore.getState().log("error", "rename.failed", { from: fromRel, to: toRel, error: rr?.error, detail: rr?.detail });
      return { ok: false, error: String(rr?.error ?? "RENAME_FAILED"), detail: rr?.detail ? String(rr.detail) : undefined };
    }

    const mapPath = (p: string) => {
      if (isFile) return p === fromRel ? toRel : p;
      if (p === fromRel) return toRel;
      if (p.startsWith(prefix)) return toRel + p.slice(fromRel.length);
      return p;
    };

    set((s) => ({
      dirs: s.dirs.map((d) => mapPath(d)),
      files: s.files.map((f) => {
        if (isFile) {
          if (f.path !== fromRel) return f;
          return { ...f, path: toRel, dirty: false };
        }
        if (!f.path.startsWith(prefix)) return f;
        return { ...f, path: toRel + f.path.slice(fromRel.length), dirty: false };
      }),
      openPaths: s.openPaths.map(mapPath),
      activePath: mapPath(s.activePath),
      previewPath: s.previewPath ? mapPath(s.previewPath) : s.previewPath,
      docOpUndoByPath: mapRecordKeys(s.docOpUndoByPath, mapPath),
      docOpRedoByPath: mapRecordKeys(s.docOpRedoByPath, mapPath),
    }));

    try {
      await get().refreshFromDisk("rename");
    } catch {
      // ignore refresh failures; disk rename already succeeded
    }
    return { ok: true };
  },

  commitSnapshot: (label) => {
    const makeId = () => `snap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const snap = get().snapshot();
    const rec: SavedSnapshot = {
      id: makeId(),
      label: String(label ?? "").trim() || `快照 ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      snap,
    };
    set((s) => {
      const next = [rec, ...s.snapshots];
      const capped = next.length > 30 ? next.slice(0, 30) : next;
      return { snapshots: capped };
    });
    return rec;
  },
  deleteSnapshot: (snapshotId) =>
    set((s) => ({ snapshots: s.snapshots.filter((x) => x.id !== snapshotId) })),
  getSnapshot: (snapshotId) => get().snapshots.find((x) => x.id === snapshotId),

  snapshot: () => {
    const s = get();
    return {
      dirs: [...s.dirs],
      files: s.files.map((f) => ({ ...f })),
      openPaths: [...s.openPaths],
      activePath: s.activePath,
      previewPath: s.previewPath,
    };
  },
  restore: (snap) => {
    const prev = get();
    set({
      dirs: Array.isArray((snap as any).dirs) ? ([...(snap as any).dirs] as any) : prev.dirs,
      files: snap.files.map((f) => ({ ...f })),
      openPaths: [...snap.openPaths],
      activePath: snap.activePath,
      previewPath: snap.previewPath,
    });

    const rootDir = prev.rootDir;
    const api = window.desktop?.fs;
    if (!rootDir || !api) return;

    // 同步磁盘：写回快照内文件内容；删除快照外的新文件（仅限 store 中可见文件集合）
    const prevPaths = new Set(prev.files.map((f) => f.path));
    const snapPaths = new Set(snap.files.map((f) => f.path));
    const writeOps = snap.files.map((f) => api.writeFile(rootDir, f.path, f.content));
    const deleteOps = Array.from(prevPaths)
      .filter((p) => !snapPaths.has(p))
      .map((p) => api.deleteFile(rootDir, p).catch(() => ({ ok: false })));
    void Promise.allSettled([...writeOps, ...deleteOps]);
  },

  applyDocOp: (path, nextContent, label) => {
    const p = normalizeRel(path);
    if (!p) return;
    const prev = get().getFileByPath(p)?.content ?? "";
    if (prev === nextContent) return;
    const rec = { label: String(label ?? "op"), before: prev, after: nextContent, ts: Date.now() };
    set((s) => ({
      docOpUndoByPath: { ...s.docOpUndoByPath, [p]: [...(s.docOpUndoByPath[p] ?? []), rec].slice(-200) },
      docOpRedoByPath: { ...s.docOpRedoByPath, [p]: [] },
    }));
    get().updateFile(p, nextContent);
  },
  undoDocOp: (path) => {
    const p = normalizeRel(path);
    if (!p) return;
    const undo = get().docOpUndoByPath[p] ?? [];
    if (!undo.length) return;
    const rec = undo[undo.length - 1]!;
    set((s) => ({
      docOpUndoByPath: { ...s.docOpUndoByPath, [p]: undo.slice(0, -1) },
      docOpRedoByPath: { ...s.docOpRedoByPath, [p]: [...(s.docOpRedoByPath[p] ?? []), rec].slice(-200) },
    }));
    get().updateFile(p, rec.before);
  },
  redoDocOp: (path) => {
    const p = normalizeRel(path);
    if (!p) return;
    const redo = get().docOpRedoByPath[p] ?? [];
    if (!redo.length) return;
    const rec = redo[redo.length - 1]!;
    set((s) => ({
      docOpRedoByPath: { ...s.docOpRedoByPath, [p]: redo.slice(0, -1) },
      docOpUndoByPath: { ...s.docOpUndoByPath, [p]: [...(s.docOpUndoByPath[p] ?? []), rec].slice(-200) },
    }));
    get().updateFile(p, rec.after);
  },
}));


