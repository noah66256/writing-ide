import type { editor } from "monaco-editor";
import { create } from "zustand";

export type ProjectFile = {
  path: string;
  content: string;
  loaded: boolean;
  dirty: boolean;
};

export type ProjectSnapshot = {
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

  files: ProjectFile[];
  openPaths: string[];
  activePath: string;
  previewPath: string | null; // 单击预览：复用同一个“预览 tab”
  snapshots: SavedSnapshot[];
  editorRef: editor.IStandaloneCodeEditor | null;

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
  getFileByPath: (path: string) => ProjectFile | undefined;

  loadProjectFromDisk: (rootDir: string) => Promise<void>;

  commitSnapshot: (label?: string) => SavedSnapshot;
  deleteSnapshot: (snapshotId: string) => void;
  getSnapshot: (snapshotId: string) => SavedSnapshot | undefined;

  snapshot: () => ProjectSnapshot;
  restore: (snap: ProjectSnapshot) => void;
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
  `- 优先输出结构（outline）再展开正文。\n` +
  `- 涉及文件改动必须给可应用 diff；写入前需要用户确认。\n`;

const saveTimers = new Map<string, number>();

export const useProjectStore = create<ProjectState>((set, get) => ({
  rootDir: null,
  isLoading: false,
  error: null,

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
    void get().writeFileNow(path, content);
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
    if (rootDir && api) void api.deleteFile(rootDir, path).catch(() => ({ ok: false }));
  },
  getFileByPath: (path) => get().files.find((f) => f.path === path),

  loadProjectFromDisk: async (rootDir) => {
    const api = window.desktop?.fs;
    if (!api) {
      set({ error: "NO_DESKTOP_FS", isLoading: false });
      return;
    }

    set({ rootDir, isLoading: true, error: null });
    const list = await api.listFiles(rootDir);
    if (!list.ok || !Array.isArray(list.files)) {
      set({ error: list.error ?? "LIST_FILES_FAILED", isLoading: false });
      return;
    }

    let files = list.files.slice();
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
      files: projFiles,
      openPaths: active ? [active] : [],
      activePath: active,
      previewPath: active || null,
      snapshots: [],
      isLoading: false,
      error: null,
    });
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
      files: s.files.map((f) => ({ ...f })),
      openPaths: [...s.openPaths],
      activePath: s.activePath,
      previewPath: s.previewPath,
    };
  },
  restore: (snap) => {
    const prev = get();
    set({
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
}));


