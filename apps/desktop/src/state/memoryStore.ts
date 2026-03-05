import { create } from "zustand";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { authHeader } from "../agent/gatewayAgent";

type ExtractMemoryArgs = {
  dialogueSummary: string;
  projectName?: string;
  preferModelId?: string;
  rootDir?: string; // 调用时的项目目录，防止异步期间项目切换
};

type MemoryState = {
  globalMemory: string;     // L1 全局记忆内容
  projectMemory: string;    // L2 项目记忆内容
  _projectRootDir: string | null;
  _extracting: boolean;
  _pendingExtract: ExtractMemoryArgs | null; // 最多保留 1 个待处理请求（取最新）

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
  extractMemory: (args: ExtractMemoryArgs) => Promise<void>;
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
 * 所有合法的记忆文件顶级 section 标题（L1 全局 + L2 项目）。
 * 只含记忆文件结构中的标题，不含对话摘要（P1 结构化摘要的 ## 标题不在此列）。
 * patch 含未知 heading 时降级为 append-only，防止摘要段落误写入记忆文件。
 */
const KNOWN_MEMORY_HEADINGS = new Set([
  // 全局记忆 L1
  "用户画像", "决策偏好", "跨项目进展",
  // 项目记忆 L2
  "项目概况", "项目决策", "重要约定", "当前进展",
]);

type TopLevelSection = { heading: string; content: string };
type MemoryExtractOp = {
  action?: "upsert" | "replace" | "ignore" | string;
  section?: string;
  factKey?: string;
  content?: string;
  confidence?: number;
  source?: "user" | "assistant" | "consensus" | string;
  reason?: string;
};
const MEMORY_OP_AUTO_APPLY_CONFIDENCE = 0.5;

/** 解析 `# Heading` 顶级段落，返回 null 表示无法解析（无任何 # 标题） */
function parseTopLevelSections(text: string): TopLevelSection[] | null {
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const sections: TopLevelSection[] = [];
  let current: TopLevelSection | null = null;

  const flush = () => {
    if (current !== null) {
      sections.push({ heading: current.heading, content: current.content.trimEnd() });
      current = null;
    }
  };

  for (const line of lines) {
    const m = line.match(/^# (.+)$/);
    if (m) {
      flush();
      current = { heading: m[1].trim(), content: "" };
    } else if (current !== null) {
      current.content += line + "\n";
    }
  }
  flush();
  return sections.length > 0 ? sections : null;
}

/** 将顶级段落列表渲染为字符串（section 间空一行，末尾单换行） */
function renderTopLevelSections(sections: TopLevelSection[]): string {
  return sections
    .map((s) => `# ${s.heading}\n${s.content}`)
    .join("\n\n")
    .trim() + "\n";
}

function normalizeLooseText(raw: string): string {
  return String(raw ?? "").toLowerCase().replace(/\s+/g, "").replace(/[，。！？、,.!?:：;；'"`~\-_/\\|()[\]{}<>]/g, "");
}

function normalizeFactKey(raw: string): string {
  return normalizeLooseText(String(raw ?? "").trim().replace(/^#+\s*/, "")).slice(0, 64);
}

function normalizeMemoryOps(raw: unknown): Array<{
  action: "upsert" | "replace" | "ignore";
  section: string;
  factKey: string;
  content: string;
  confidence: number;
  source: "user" | "assistant" | "consensus" | "";
  reason: string;
}> {
  const list = Array.isArray(raw) ? raw : [];
  const out: Array<{
    action: "upsert" | "replace" | "ignore";
    section: string;
    factKey: string;
    content: string;
    confidence: number;
    source: "user" | "assistant" | "consensus" | "";
    reason: string;
  }> = [];
  for (const one of list as MemoryExtractOp[]) {
    const actionRaw = String(one?.action ?? "ignore").trim().toLowerCase();
    const action =
      actionRaw === "upsert" || actionRaw === "replace" || actionRaw === "ignore"
        ? (actionRaw as "upsert" | "replace" | "ignore")
        : "ignore";
    const section = String(one?.section ?? "").trim();
    const factKey = String(one?.factKey ?? "").trim();
    const content = String(one?.content ?? "").trim();
    const confidenceRaw = Number(one?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 1;
    const sourceRaw = String(one?.source ?? "").trim();
    const source =
      sourceRaw === "user" || sourceRaw === "assistant" || sourceRaw === "consensus"
        ? (sourceRaw as "user" | "assistant" | "consensus")
        : "";
    const reason = String(one?.reason ?? "").trim();
    if (action !== "ignore" && (!section || !content)) continue;
    if (action !== "ignore" && !KNOWN_MEMORY_HEADINGS.has(section)) continue;
    out.push({ action, section, factKey, content, confidence, source, reason });
  }
  return out;
}

function opsToPatchMarkdown(ops: Array<{ section: string; factKey: string; content: string }>): string {
  const bySection = new Map<string, Array<{ factKey: string; content: string }>>();
  for (const op of ops) {
    const section = String(op.section ?? "").trim();
    const content = String(op.content ?? "").trim();
    if (!section || !content) continue;
    const arr = bySection.get(section) ?? [];
    arr.push({ factKey: String(op.factKey ?? "").trim(), content });
    bySection.set(section, arr);
  }
  const blocks: string[] = [];
  for (const [section, rows] of bySection.entries()) {
    const body = rows
      .map((r) => (r.factKey ? `- [${r.factKey}] ${r.content}` : `- ${r.content}`))
      .join("\n");
    blocks.push(`# ${section}\n${body}`);
  }
  return blocks.join("\n\n");
}

function applyMemoryOpToSectionContent(
  sectionContent: string,
  op: { action: "upsert" | "replace"; factKey: string; content: string },
): string {
  const content = String(op.content ?? "").trim();
  if (!content) return sectionContent;
  const factKey = String(op.factKey ?? "").trim();
  const keyedLine = factKey ? `- [${factKey}] ${content}` : "";
  const lines = String(sectionContent ?? "").split("\n");
  const sectionNorm = normalizeLooseText(sectionContent);
  const contentNorm = normalizeLooseText(content);
  if (!contentNorm) return sectionContent;
  // 无 factKey：按内容去重（避免同义近义重复仍需后续迭代，这里先做轻量守门）
  if (!factKey) {
    if (sectionNorm.includes(contentNorm)) return sectionContent;
    const base = String(sectionContent ?? "").trimEnd();
    return base ? `${base}\n- ${content}\n` : `- ${content}\n`;
  }

  const targetKey = normalizeFactKey(factKey);
  let firstIdx = -1;
  const keepLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[(.+?)\]\s*(.*)$/);
    if (!m) {
      keepLines.push(line);
      continue;
    }
    const lineKey = normalizeFactKey(String(m[1] ?? ""));
    if (lineKey !== targetKey) {
      keepLines.push(line);
      continue;
    }
    if (firstIdx < 0) {
      firstIdx = keepLines.length;
      keepLines.push(line);
    }
    // 同 factKey 的重复行会被丢弃，只保留首条并替换
  }

  if (firstIdx >= 0) {
    const prevNorm = normalizeLooseText(String(keepLines[firstIdx] ?? ""));
    const nextNorm = normalizeLooseText(keyedLine);
    if (prevNorm === nextNorm) return sectionContent;
    keepLines[firstIdx] = keyedLine;
    return keepLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  if (sectionNorm.includes(contentNorm)) return sectionContent;
  const base = String(sectionContent ?? "").trimEnd();
  return base ? `${base}\n${keyedLine}\n` : `${keyedLine}\n`;
}

function mergeMemoryOps(existing: string, rawOps: unknown): string {
  const ops = normalizeMemoryOps(rawOps)
    .filter((op) => op.action !== "ignore")
    .filter((op) => op.confidence >= MEMORY_OP_AUTO_APPLY_CONFIDENCE)
    .map((op) => ({ action: op.action as "upsert" | "replace", section: op.section, factKey: op.factKey, content: op.content }));
  if (!ops.length) return existing;

  const existingSections = parseTopLevelSections(existing);
  if (!existingSections || existingSections.length === 0) {
    const fallbackPatch = opsToPatchMarkdown(ops);
    return appendOnlyMergeMemoryPatch(existing, fallbackPatch);
  }

  const merged = [...existingSections];
  const idxByHeading = new Map<string, number>();
  for (let i = 0; i < merged.length; i += 1) idxByHeading.set(merged[i].heading, i);

  for (const op of ops) {
    const idx = idxByHeading.get(op.section);
    if (idx === undefined) {
      const initial = op.factKey ? `- [${op.factKey}] ${op.content}\n` : `- ${op.content}\n`;
      merged.push({ heading: op.section, content: initial });
      idxByHeading.set(op.section, merged.length - 1);
      continue;
    }
    merged[idx] = {
      heading: merged[idx].heading,
      content: applyMemoryOpToSectionContent(merged[idx].content, {
        action: op.action,
        factKey: op.factKey,
        content: op.content,
      }),
    };
  }
  return renderTopLevelSections(merged);
}

/** 降级策略：无法按 section 合并时，直接追加 */
function appendOnlyMergeMemoryPatch(existing: string, patch: string): string {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  return `${existing.trimEnd()}\n\n---\n_${ts} 自动提取_\n\n${patch.trim()}\n`;
}

/**
 * 将 patch 内容按 section 合并到现有记忆中：
 * - patch / existing 无法解析为 section 结构 → 追加
 * - patch 含未知 heading → 追加（防止错误写入其他文件）
 * - 正常路径：按 heading 匹配，追加到对应 section；新 heading 追加到末尾
 */
function mergeMemoryPatch(existing: string, patch: string): string {
  if (!patch.trim()) return existing;
  if (!existing.trim()) return patch;

  const patchSections = parseTopLevelSections(patch);
  if (!patchSections || patchSections.length === 0) {
    return appendOnlyMergeMemoryPatch(existing, patch);
  }

  // 含未知 heading 时降级，防止错误合并
  const hasUnknown = patchSections.some((s) => !KNOWN_MEMORY_HEADINGS.has(s.heading));
  if (hasUnknown) {
    return appendOnlyMergeMemoryPatch(existing, patch);
  }

  const existingSections = parseTopLevelSections(existing);
  if (!existingSections || existingSections.length === 0) {
    return appendOnlyMergeMemoryPatch(existing, patch);
  }

  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const mergedSections = [...existingSections];

  for (const pSec of patchSections) {
    const newContent = pSec.content.trim();
    if (!newContent) continue;

    const idx = mergedSections.findIndex((s) => s.heading === pSec.heading);
    if (idx >= 0) {
      const existingContent = mergedSections[idx].content.trimEnd();
      mergedSections[idx] = {
        heading: mergedSections[idx].heading,
        content: `${existingContent}\n\n_${ts} 更新_\n${newContent}\n`,
      };
    } else {
      mergedSections.push({ heading: pSec.heading, content: `${newContent}\n` });
    }
  }

  return renderTopLevelSections(mergedSections);
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
  _pendingExtract: null,

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
    if (get()._extracting) {
      // 已有提取进行中：记录为 pending（最新请求覆盖旧请求），完成后自动消费
      set({ _pendingExtract: args as ExtractMemoryArgs });
      return;
    }
    set({ _extracting: true, _pendingExtract: null });

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

      const { globalPatches, projectPatches, globalOps, projectOps } = json;

      // 合并全局记忆
      const normalizedGlobalOps = normalizeMemoryOps(globalOps);
      const normalizedProjectOps = normalizeMemoryOps(projectOps);
      if (normalizedGlobalOps.length > 0) {
        const merged = mergeMemoryOps(get().globalMemory, normalizedGlobalOps);
        await get().saveGlobalMemory(merged);
        console.log("[MemoryStore] L1 global memory updated via ops");
      } else if (globalPatches?.trim()) {
        const merged = mergeMemoryPatch(get().globalMemory, globalPatches);
        await get().saveGlobalMemory(merged);
        console.log("[MemoryStore] L1 global memory updated via patch fallback");
      }

      // 合并项目记忆（使用捕获的 rootDir，而非当前的 _projectRootDir）
      const hasProjectUpdate = normalizedProjectOps.length > 0 || Boolean(projectPatches?.trim());
      if (hasProjectUpdate && capturedRootDir) {
        // 校验：当前项目未切换才写入
        if (get()._projectRootDir === capturedRootDir) {
          const merged = normalizedProjectOps.length > 0
            ? mergeMemoryOps(get().projectMemory, normalizedProjectOps)
            : mergeMemoryPatch(get().projectMemory, projectPatches);
          await get().saveProjectMemory(capturedRootDir, merged);
          console.log(
            `[MemoryStore] L2 project memory updated via ${normalizedProjectOps.length > 0 ? "ops" : "patch fallback"}`,
          );
        } else {
          // 项目已切换：先从磁盘读取旧内容，再合并写入（不更新 store state）
          const oldRes = await window.desktop?.memory?.readProject(capturedRootDir).catch(() => null);
          if (!oldRes?.ok) {
            // 读取失败（IPC 错误），不冒险写入，避免覆盖可能存在的旧内容
            console.warn("[MemoryStore] L2 read failed for switched project, skipping write");
          } else {
            const oldContent = oldRes.content ?? "";
            const merged = normalizedProjectOps.length > 0
              ? mergeMemoryOps(oldContent, normalizedProjectOps)
              : mergeMemoryPatch(oldContent, projectPatches);
            await window.desktop?.memory?.writeProject(
              capturedRootDir,
              merged,
            ).catch(() => void 0);
            console.log("[MemoryStore] L2 project memory written to disk (project switched)");
          }
        }
      }
    } catch (e) {
      console.warn("[MemoryStore] extractMemory error:", e);
    } finally {
      set({ _extracting: false });
      // 消费 pending 请求（使用微任务避免调用栈过深）
      const pending = get()._pendingExtract;
      if (pending) {
        set({ _pendingExtract: null });
        void Promise.resolve().then(() => get().extractMemory(pending));
      }
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
