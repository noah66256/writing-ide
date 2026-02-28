import { create } from "zustand";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { authHeader } from "../agent/gatewayAgent";

type MemoryState = {
  globalMemory: string;     // L1 全局记忆内容
  projectMemory: string;    // L2 项目记忆内容
  _projectRootDir: string | null;
  _extracting: boolean;

  /** 加载项目记忆 */
  loadProjectMemory: (rootDir: string) => Promise<void>;
  /** 保存项目记忆 */
  saveProjectMemory: (rootDir: string, content: string) => Promise<void>;
  /** 加载全局记忆 */
  loadGlobalMemory: () => Promise<void>;
  /** 保存全局记忆 */
  saveGlobalMemory: (content: string) => Promise<void>;
  /** 清空项目记忆（项目切换时调用） */
  clearProjectMemory: () => void;
  /** 从对话中提取记忆（对话结束/切换时调用） */
  extractMemory: (args: {
    dialogueSummary: string;
    projectName?: string;
    preferModelId?: string;
    rootDir?: string;  // 调用时的项目目录，防止异步期间项目切换
  }) => Promise<void>;
  /** 将项目摘要写入全局记忆的"跨项目进展"section */
  updateProjectSummaryInGlobal: (args: {
    projectName: string;
    rootDir: string;
    fileStats: Record<string, number>; // ext → count
    totalFiles: number;
  }) => Promise<void>;
};

const DEFAULT_PROJECT_MEMORY =
  `# 项目概况\n（项目基本信息）\n\n` +
  `# 项目决策\n（对话中提取的架构/风格/方向决策）\n\n` +
  `# 重要约定\n（命名规则、结构约定等）\n\n` +
  `# 当前进展\n（正在做什么、下一步是什么）\n`;

const DEFAULT_GLOBAL_MEMORY =
  `# 用户画像\n（身份、创作领域、常用平台）\n\n` +
  `# 决策偏好\n（语气偏好、工作流习惯、工具使用倾向）\n\n` +
  `# 跨项目进展\n（各项目最近状态摘要）\n`;

/**
 * 将 patch 内容按 section 合并到现有记忆中。
 * patch 格式：以 # 标题开头的 section，内容 append 到对应 section 末尾。
 */
function mergeMemoryPatch(existing: string, patch: string): string {
  if (!patch.trim()) return existing;
  if (!existing.trim()) return patch;

  // 简单合并策略：直接追加分隔线 + patch 内容
  // 后续可改为按 section 标题精确 merge
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return `${existing.trimEnd()}\n\n---\n_${ts} 自动提取_\n\n${patch.trim()}\n`;
}

/* ─── 跨项目进展 section 解析/渲染 ─── */

type ProjectSummaryEntry = {
  name: string;
  rootDir: string;
  fileStats: string; // 如 "42 个（md:15, txt:8, 其他:19）"
  recentOpen: string; // 如 "2026-02-28 14:30"
  recentOpenTs: number; // 用于排序
};

const CROSS_PROJECT_HEADING = "# 跨项目进展";
const MAX_PROJECT_ENTRIES = 10;

/** 将全局记忆拆为 { before, section, after }，section 是"跨项目进展"段的纯文本 */
function splitCrossProjectSection(globalMemory: string): { before: string; section: string; after: string } {
  const lines = globalMemory.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === CROSS_PROJECT_HEADING || t === "# 跨项目进展") {
      sectionStart = i;
      continue;
    }
    // 遇到下一个 h1 标题，结束 section
    if (sectionStart >= 0 && /^# [^#]/.test(t)) {
      sectionEnd = i;
      break;
    }
  }
  if (sectionStart < 0) {
    // section 不存在，追加到末尾
    return { before: globalMemory.trimEnd(), section: "", after: "" };
  }
  const before = lines.slice(0, sectionStart).join("\n");
  const section = lines.slice(sectionStart + 1, sectionEnd).join("\n");
  const after = lines.slice(sectionEnd).join("\n");
  return { before, section, after };
}

/** 解析 section 内的 ### 项目条目 */
function parseProjectSummaryEntries(sectionText: string): ProjectSummaryEntry[] {
  const entries: ProjectSummaryEntry[] = [];
  const lines = sectionText.split("\n");
  let current: Partial<ProjectSummaryEntry> | null = null;

  const flush = () => {
    if (current?.name) {
      entries.push({
        name: current.name,
        rootDir: current.rootDir ?? "",
        fileStats: current.fileStats ?? "",
        recentOpen: current.recentOpen ?? "",
        recentOpenTs: current.recentOpenTs ?? 0,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const headingMatch = line.match(/^### (.+)$/);
    if (headingMatch) {
      flush();
      current = { name: headingMatch[1].trim() };
      continue;
    }
    if (!current) continue;
    const dirMatch = line.match(/^- 目录[：:]\s*(.+)$/);
    if (dirMatch) { current.rootDir = dirMatch[1].trim(); continue; }
    const fileMatch = line.match(/^- 文件[：:]\s*(.+)$/);
    if (fileMatch) { current.fileStats = fileMatch[1].trim(); continue; }
    const openMatch = line.match(/^- 最近打开[：:]\s*(.+)$/);
    if (openMatch) {
      current.recentOpen = openMatch[1].trim();
      // 尝试解析时间戳
      try { current.recentOpenTs = new Date(current.recentOpen).getTime() || 0; } catch { current.recentOpenTs = 0; }
      continue;
    }
  }
  flush();
  return entries;
}

/** 将条目列表渲染为 section 文本（不含 heading） */
function renderProjectEntries(entries: ProjectSummaryEntry[]): string {
  return entries
    .map((e) => `### ${e.name}\n- 目录：${e.rootDir}\n- 文件：${e.fileStats}\n- 最近打开：${e.recentOpen}`)
    .join("\n\n");
}

/** 简单异步互斥锁，防止并发读-改-写覆盖 */
let _projectSummaryMutex: Promise<void> = Promise.resolve();

export const useMemoryStore = create<MemoryState>((set, get) => ({
  globalMemory: "",
  projectMemory: "",
  _projectRootDir: null,
  _extracting: false,

  async loadProjectMemory(rootDir: string) {
    if (!rootDir || !window.desktop?.memory) return;
    set({ _projectRootDir: rootDir });
    try {
      const res = await window.desktop.memory.readProject(rootDir);
      if (res?.ok) {
        const content = res.content ?? "";
        if (content.trim()) {
          set({ projectMemory: content });
        } else {
          // 首次：写入默认模板
          set({ projectMemory: DEFAULT_PROJECT_MEMORY });
          await window.desktop.memory.writeProject(rootDir, DEFAULT_PROJECT_MEMORY).catch(() => void 0);
        }
      }
    } catch (e) {
      console.warn("[MemoryStore] loadProjectMemory error:", e);
    }
  },

  async saveProjectMemory(rootDir: string, content: string) {
    if (!rootDir || !window.desktop?.memory) return;
    set({ projectMemory: content });
    try {
      await window.desktop.memory.writeProject(rootDir, content);
    } catch (e) {
      console.warn("[MemoryStore] saveProjectMemory error:", e);
    }
  },

  async loadGlobalMemory() {
    if (!window.desktop?.memory) return;
    try {
      const res = await window.desktop.memory.readGlobal();
      if (res?.ok) {
        const content = res.content ?? "";
        if (content.trim()) {
          set({ globalMemory: content });
        } else {
          // 首次：写入默认模板
          set({ globalMemory: DEFAULT_GLOBAL_MEMORY });
          await window.desktop.memory.writeGlobal(DEFAULT_GLOBAL_MEMORY).catch(() => void 0);
        }
      }
    } catch (e) {
      console.warn("[MemoryStore] loadGlobalMemory error:", e);
    }
  },

  async saveGlobalMemory(content: string) {
    if (!window.desktop?.memory) return;
    set({ globalMemory: content });
    try {
      await window.desktop.memory.writeGlobal(content);
    } catch (e) {
      console.warn("[MemoryStore] saveGlobalMemory error:", e);
    }
  },

  clearProjectMemory() {
    set({ projectMemory: "", _projectRootDir: null });
  },

  async extractMemory(args) {
    const { dialogueSummary, projectName, preferModelId } = args;
    // 捕获调用时的 rootDir，防止异步期间项目切换后串写
    const capturedRootDir = (args as any).rootDir || get()._projectRootDir || "";
    if (!dialogueSummary?.trim()) return;
    if (get()._extracting) return; // 防止并发提取
    set({ _extracting: true });

    try {
      const baseUrl = getGatewayBaseUrl();
      const url = baseUrl ? `${baseUrl}/api/agent/memory/extract` : "/api/agent/memory/extract";

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          preferModelId,
          dialogueSummary,
          existingGlobal: get().globalMemory,
          existingProject: get().projectMemory,
          projectName,
        }),
      });

      if (!res.ok) {
        console.warn("[MemoryStore] extractMemory HTTP error:", res.status);
        return;
      }

      const json = await res.json().catch(() => null);
      if (!json?.ok) {
        console.warn("[MemoryStore] extractMemory failed:", json?.error);
        return;
      }

      const { globalPatches, projectPatches } = json;

      // 合并全局记忆
      if (globalPatches?.trim()) {
        const merged = mergeMemoryPatch(get().globalMemory, globalPatches);
        await get().saveGlobalMemory(merged);
        console.log("[MemoryStore] L1 global memory updated");
      }

      // 合并项目记忆（使用捕获的 rootDir，而非当前的 _projectRootDir）
      if (projectPatches?.trim() && capturedRootDir) {
        // 校验：当前项目未切换才写入
        if (get()._projectRootDir === capturedRootDir) {
          const merged = mergeMemoryPatch(get().projectMemory, projectPatches);
          await get().saveProjectMemory(capturedRootDir, merged);
          console.log("[MemoryStore] L2 project memory updated");
        } else {
          // 项目已切换，直接通过 IPC 写入文件（不更新 store state）
          await window.desktop?.memory?.writeProject(
            capturedRootDir,
            mergeMemoryPatch("", projectPatches),
          ).catch(() => void 0);
          console.log("[MemoryStore] L2 project memory written to disk (project switched)");
        }
      }
    } catch (e) {
      console.warn("[MemoryStore] extractMemory error:", e);
    } finally {
      set({ _extracting: false });
    }
  },

  async updateProjectSummaryInGlobal(args) {
    const { projectName, rootDir, fileStats, totalFiles } = args;
    if (!projectName || !rootDir) return;

    // 串行化：等前一次写入完成后再执行
    const prev = _projectSummaryMutex;
    let release: () => void;
    _projectSummaryMutex = new Promise<void>((r) => { release = r; });
    await prev;

    try {
      // 确保全局记忆已加载
      if (!get().globalMemory.trim()) {
        await get().loadGlobalMemory();
      }

      const globalMemory = get().globalMemory || DEFAULT_GLOBAL_MEMORY;

      // 构建文件统计字符串
      const statParts: string[] = [];
      const sorted = Object.entries(fileStats).sort((a, b) => b[1] - a[1]);
      for (const [ext, count] of sorted.slice(0, 5)) {
        statParts.push(`${ext.replace(/^\./, "")}:${count}`);
      }
      const otherCount = sorted.slice(5).reduce((s, [, c]) => s + c, 0);
      if (otherCount > 0) statParts.push(`其他:${otherCount}`);
      const fileStatsStr = statParts.length
        ? `${totalFiles} 个（${statParts.join(", ")}）`
        : `${totalFiles} 个`;

      const now = new Date();
      const recentOpen = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const recentOpenTs = now.getTime();

      const newEntry: ProjectSummaryEntry = {
        name: projectName,
        rootDir,
        fileStats: fileStatsStr,
        recentOpen,
        recentOpenTs,
      };

      // 解析现有 section
      const { before, section, after } = splitCrossProjectSection(globalMemory);
      const entries = parseProjectSummaryEntries(section);

      // 替换同名或同目录条目，优先按 rootDir 匹配
      const idx = entries.findIndex((e) => e.rootDir === rootDir);
      if (idx >= 0) {
        entries[idx] = newEntry;
      } else {
        entries.push(newEntry);
      }

      // 按最近打开时间降序排序，保留前 N 条
      entries.sort((a, b) => b.recentOpenTs - a.recentOpenTs);
      const kept = entries.slice(0, MAX_PROJECT_ENTRIES);

      // 重组全局记忆
      const sectionBody = renderProjectEntries(kept);
      const parts = [before.trimEnd(), `\n\n${CROSS_PROJECT_HEADING}\n${sectionBody}\n`];
      if (after.trim()) parts.push(after.trimStart());
      const merged = parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";

      await get().saveGlobalMemory(merged);
      console.log("[MemoryStore] 项目摘要已注入全局记忆：", projectName);
    } catch (e) {
      console.warn("[MemoryStore] updateProjectSummaryInGlobal error:", e);
    } finally {
      release!();
    }
  },
}));
