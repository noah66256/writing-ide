import { create } from "zustand";
import {
  buildProjectIndexV2,
  buildProjectSummaryIndexesV1,
  coerceProjectIndexV2,
  type DirSummaryV1,
  type FileSummaryV1,
  type ProjectIndexV2,
  type ProjectKind,
  type ProjectSummaryIndexesV1,
} from "../lib/projectIndexing";

// ── 类型 ──
export type ProjectIndex = ProjectIndexV2;

type ProjectIndexState = {
  index: ProjectIndex | null;
  projectKind: ProjectKind | null;
  dirSummaries: DirSummaryV1[];
  fileSummaries: FileSummaryV1[];
  isIndexing: boolean;

  /** 全量构建索引（扫描磁盘 + 持久化） */
  buildIndex: (rootDir: string) => Promise<void>;

  /** 刷新索引（去抖 + 先尝试读磁盘缓存，否则重建） */
  refreshIfStale: (rootDir: string) => Promise<void>;

  /** 获取所有文件路径（供 MentionPopover / toolSidecar 使用） */
  allFilePaths: () => string[];

  /** 获取所有目录路径 */
  allDirs: () => string[];

  /** 清空索引 */
  clear: () => void;
};

// ── 去抖控制 ──

let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _refreshResolvers: Array<() => void> = [];
const DEBOUNCE_MS = 500;

function scheduleDebounce(rootDir: string): Promise<string> {
  return new Promise<string>((resolve) => {
    // 清除前一轮计时器，但让前一轮 resolvers 也正常 resolve（指向新 rootDir）
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshResolvers.push(() => resolve(rootDir));
    _refreshTimer = setTimeout(() => {
      _refreshTimer = null;
      const resolvers = _refreshResolvers;
      _refreshResolvers = [];
      for (const r of resolvers) r();
    }, DEBOUNCE_MS);
  });
}

// ── Store ──

export const useProjectIndexStore = create<ProjectIndexState>((set, get) => ({
  index: null,
  projectKind: null,
  dirSummaries: [],
  fileSummaries: [],
  isIndexing: false,

  async buildIndex(rootDir: string) {
    if (!rootDir || !window.desktop?.fs) return;
    set({ isIndexing: true });
    try {
      const res = await window.desktop.fs.listAllEntries(rootDir);
      if (!res?.ok || !res.files) {
        console.warn("[ProjectIndex] listAllEntries failed:", res?.error);
        return;
      }
      const now = Date.now();
      const idx: ProjectIndex = buildProjectIndexV2({
        rootDir,
        files: res.files,
        dirs: res.dirs ?? [],
        updatedAt: now,
      });
      const summaries = buildProjectSummaryIndexesV1({ index: idx });
      // 写入前校验：当前项目可能已切换
      const currentIdx = get().index;
      if (currentIdx && currentIdx.rootDir !== rootDir) return;
      set({
        index: idx,
        projectKind: summaries?.projectKind ?? null,
        dirSummaries: summaries?.dirs ?? [],
        fileSummaries: summaries?.files ?? [],
      });
      // 持久化到磁盘（异步，不阻塞）
      window.desktop.fs.writeIndex(rootDir, idx).catch((e) => {
        console.warn("[ProjectIndex] writeIndex failed:", e);
      });
      if (summaries) {
        persistProjectSummaries(rootDir, summaries).catch((e) => {
          console.warn("[ProjectIndex] write summaries failed:", e);
        });
      }
    } catch (e) {
      console.warn("[ProjectIndex] buildIndex error:", e);
    } finally {
      set({ isIndexing: false });
    }
  },

  async refreshIfStale(rootDir: string) {
    if (!rootDir || !window.desktop?.fs) return;

    // 去抖：500ms 内多次 fs.watch 事件合并为一次
    const debouncedRoot = await scheduleDebounce(rootDir);
    // 去抖结束后，使用最新的 rootDir（最后一次调用的值）
    const effectiveRoot = debouncedRoot;

    const current = get().index;
    // 当前索引匹配，直接重建（fsEvent 意味着有变化）
    // 但如果 < 2s 内已经刷新过，跳过（防止高频触发）
    if (current && current.rootDir === effectiveRoot && Date.now() - current.updatedAt < 2_000) {
      return;
    }

    // 尝试读磁盘缓存（可能是另一个对话写入的）
    try {
      const cached = await window.desktop.fs.readIndex(effectiveRoot);
      const cachedIndex = cached?.ok ? coerceProjectIndexV2(cached.data, effectiveRoot) : null;
      if (cachedIndex) {
        const age = Date.now() - (cachedIndex.updatedAt ?? 0);
        const summaries = buildProjectSummaryIndexesV1({ index: cachedIndex });
        if (age < 30_000) {
          set({
            index: cachedIndex,
            projectKind: summaries?.projectKind ?? null,
            dirSummaries: summaries?.dirs ?? [],
            fileSummaries: summaries?.files ?? [],
          });
          return;
        }
      }
    } catch {
      // ignore
    }

    // 缓存过期或不存在，重建
    await get().buildIndex(effectiveRoot);
  },

  allFilePaths() {
    return get().index?.files?.map((f) => f.path) ?? [];
  },

  allDirs() {
    return get().index?.dirs?.map((d) => d.path) ?? [];
  },

  clear() {
    set({ index: null, projectKind: null, dirSummaries: [], fileSummaries: [], isIndexing: false });
    if (_refreshTimer) {
      clearTimeout(_refreshTimer);
      _refreshTimer = null;
    }
    // resolve 所有等待中的 debounce
    const resolvers = _refreshResolvers;
    _refreshResolvers = [];
    for (const r of resolvers) r();
  },
}));

async function persistProjectSummaries(rootDir: string, summaries: ProjectSummaryIndexesV1) {
  const api = window.desktop?.fs;
  if (!rootDir || !api) return;
  await Promise.all([
    api.writeFile(
      rootDir,
      ".ohmycrab/dir-summaries.v1.json",
      JSON.stringify({
        version: 1,
        rootDir: summaries.rootDir,
        updatedAt: summaries.updatedAt,
        projectKind: summaries.projectKind,
        dirs: summaries.dirs,
      }, null, 2),
    ),
    api.writeFile(
      rootDir,
      ".ohmycrab/file-summaries.v1.json",
      JSON.stringify({
        version: 1,
        rootDir: summaries.rootDir,
        updatedAt: summaries.updatedAt,
        projectKind: summaries.projectKind,
        files: summaries.files,
      }, null, 2),
    ),
  ]);
}
