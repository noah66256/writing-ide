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
    {
      path: "doc.rules.md",
      content:
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
        `- 涉及文件改动必须给可应用 diff；写入前需要用户确认。\n`,
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


