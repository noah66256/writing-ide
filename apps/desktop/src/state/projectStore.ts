import type { editor } from "monaco-editor";
import { create } from "zustand";

export type ProjectFile = {
  path: string;
  content: string;
};

export type ProjectSnapshot = {
  files: ProjectFile[];
  openPaths: string[];
  activePath: string;
};

type ProjectState = {
  files: ProjectFile[];
  openPaths: string[];
  activePath: string;
  editorRef: editor.IStandaloneCodeEditor | null;

  setEditorRef: (ref: editor.IStandaloneCodeEditor | null) => void;
  setActivePath: (path: string) => void;
  openFile: (path: string) => void;
  updateFile: (path: string, content: string) => void;
  createFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  getFileByPath: (path: string) => ProjectFile | undefined;

  snapshot: () => ProjectSnapshot;
  restore: (snap: ProjectSnapshot) => void;
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  files: [
    {
      path: "drafts/draft.md",
      content: `---\ntitle: 草稿\nplatform_type: feed_preview\n---\n\n# 草稿\n\n在这里开始写作…\n`,
    },
  ],
  openPaths: ["drafts/draft.md"],
  activePath: "drafts/draft.md",
  editorRef: null,

  setEditorRef: (ref) => set({ editorRef: ref }),
  setActivePath: (path) => set({ activePath: path }),
  openFile: (path) =>
    set((s) => ({
      openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
      activePath: path,
    })),
  updateFile: (path, content) =>
    set((s) => ({
      files: s.files.map((f) => (f.path === path ? { ...f, content } : f)),
    })),
  createFile: (path, content) =>
    set((s) => {
      if (s.files.some((f) => f.path === path)) return {};
      return {
        files: [{ path, content }, ...s.files],
        openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
        activePath: path,
      };
    }),
  deleteFile: (path) =>
    set((s) => {
      const files = s.files.filter((f) => f.path !== path);
      const openPaths = s.openPaths.filter((p) => p !== path);
      const activePath =
        s.activePath === path ? openPaths[0] ?? files[0]?.path ?? "" : s.activePath;
      return { files, openPaths, activePath };
    }),
  getFileByPath: (path) => get().files.find((f) => f.path === path),

  snapshot: () => {
    const s = get();
    return {
      files: s.files.map((f) => ({ ...f })),
      openPaths: [...s.openPaths],
      activePath: s.activePath,
    };
  },
  restore: (snap) =>
    set({
      files: snap.files.map((f) => ({ ...f })),
      openPaths: [...snap.openPaths],
      activePath: snap.activePath,
    }),
}));


