import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAuthStore } from "./authStore";
import { useDialogStore } from "./dialogStore";
import { useKbStore } from "./kbStore";
import { useProjectStore } from "./projectStore";
import { useRunStore } from "./runStore";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { executeToolCall } from "../agent/toolRegistry";

type BatchStatus = "idle" | "running" | "paused";

type BatchProgress = {
  fileIndex: number;
  clipIndex: number;
  done: number;
  failed: number;
  lastError?: string;
};

export type WritingBatchJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "running" | "paused" | "done" | "cancelled" | "failed";

  /** 输入文件夹（绝对路径；可以不在项目内） */
  inputDir: string;
  /** 输入文件（相对 inputDir；由 window.desktop.fs.listFiles 返回） */
  inputFiles: string[];

  /** 输出目录（相对项目 rootDir） */
  outputDir: string;
  /** 每节课拆成多少篇（默认 5） */
  clipsPerLesson: number;
  /** 绑定风格库（purpose=style） */
  styleLibraryId: string;
  /** 批处理固定使用的工作模型（避免中途切换导致风格不一致） */
  model: string;

  /** 运行进度 */
  progress: BatchProgress;
  /** 失败记录（只存摘要，避免状态过大） */
  failures: Array<{ at: string; file: string; clipIndex: number; error: string }>;
};

type WritingBatchState = {
  status: BatchStatus;
  error: string | null;
  jobs: WritingBatchJob[];
  activeJobId: string | null;
  runStartedAtMs: number | null;
  runElapsedMs: number;

  createJobInteractive: (args?: { clipsPerLesson?: number; outputBaseDir?: string }) => Promise<{ ok: boolean; jobId?: string; error?: string; detail?: any }>;
  createJobFromDir: (args: {
    inputDir: string;
    clipsPerLesson?: number;
    outputBaseDir?: string;
  }) => Promise<{ ok: boolean; jobId?: string; error?: string; detail?: any }>;
  start: (jobId?: string) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  cancel: () => void;
  clearFinished: () => void;
};

let runner: Promise<void> | null = null;
let abort: AbortController | null = null;
let abortReason: "pause" | "cancel" | null = null;

function nowIso() {
  return new Date().toISOString();
}

function pad2(n: number) {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}

function sanitizeFileName(name: string) {
  const s0 = String(name ?? "").trim();
  if (!s0) return "";
  // Windows/macOS 通用：去掉控制字符与常见非法字符
  return s0
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function ensureRelDir(dir: string) {
  const s = String(dir ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "");
  return s;
}

function joinRel(dir: string, name: string) {
  const d = ensureRelDir(dir);
  const n = String(name ?? "").replaceAll("\\", "/").replace(/^\/+/g, "");
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}

function extLower(p: string) {
  const s = String(p ?? "").replaceAll("\\", "/");
  const b = s.split("/").pop() ?? "";
  const m = b.match(/\.[^./]+$/);
  return (m?.[0] ?? "").toLowerCase();
}

function isTextRelPath(p: string) {
  const ext = extLower(p);
  return ext === ".md" || ext === ".mdx" || ext === ".txt";
}

function dirnameRel(p: string) {
  const s = String(p ?? "").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/+$/g, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}

function basenameAny(p: string) {
  const s = String(p ?? "").replaceAll("\\", "/");
  return s.split("/").filter(Boolean).pop() ?? "";
}

function looksLikeAbsPath(p: string) {
  const s = String(p ?? "").trim();
  if (!s) return false;
  // Windows drive / UNC / POSIX
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.startsWith("\\\\")) return true;
  if (s.startsWith("/")) return true;
  return false;
}

function joinAbs(rootDir: string, rel: string) {
  const root = String(rootDir ?? "").trim().replace(/[/\\]+$/g, "");
  const r = String(rel ?? "").trim().replaceAll("\\", "/").replace(/^\/+/g, "");
  if (!root) return r;
  if (!r) return root;
  return `${root}/${r}`;
}

function requireLoginForBatch(args?: { why?: string }) {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  if (token) return { ok: true as const };
  try {
    useAuthStore.getState().openLoginModal?.();
    useAuthStore.setState({ error: args?.why ? `请先登录再使用：${args.why}` : "请先登录再使用 AI 功能" });
  } catch {
    // ignore
  }
  return { ok: false as const };
}

function authHeader(): Record<string, string> {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function ensureDirOnDisk(rootDir: string, relDir: string) {
  const api = window.desktop?.fs;
  if (!api) return { ok: false as const, error: "NO_FS_API" };
  const dir = ensureRelDir(relDir);
  if (!dir) return { ok: true as const };
  // 逐级 mkdir（主进程的 doc.mkdir 需要相对项目 rootDir）
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    // eslint-disable-next-line no-await-in-loop
    const r = await api.mkdir(rootDir, cur);
    if (!r?.ok && String(r?.error ?? "") !== "EEXIST") {
      // 部分平台返回 EEXIST；其它错误才视为失败
      return { ok: false as const, error: String(r?.error ?? "MKDIR_FAILED") };
    }
  }
  return { ok: true as const };
}

async function readTextFileFromDir(inputDir: string, relPath: string) {
  const api = window.desktop?.fs;
  if (!api) return { ok: false as const, error: "NO_FS_API" };
  const ret = await api.readFile(inputDir, relPath);
  if (!ret?.ok) return { ok: false as const, error: String(ret?.error ?? "READ_FAILED") };
  return { ok: true as const, content: String(ret?.content ?? "") };
}

async function writeTextFileToProject(rootDir: string, relPath: string, content: string) {
  const api = window.desktop?.fs;
  if (!api) return { ok: false as const, error: "NO_FS_API" };
  const p = String(relPath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  const dir = p.includes("/") ? p.split("/").slice(0, -1).join("/") : "";
  const okDir = await ensureDirOnDisk(rootDir, dir);
  if (!okDir.ok) return okDir;
  const ret = await api.writeFile(rootDir, p, content);
  if (!ret?.ok) return { ok: false as const, error: String(ret?.error ?? "WRITE_FAILED") };
  return { ok: true as const };
}

async function appendTextFileToProject(rootDir: string, relPath: string, content: string) {
  const api = window.desktop?.fs;
  if (!api || typeof api.appendFile !== "function") return { ok: false as const, error: "NO_APPEND_API" };
  const p = String(relPath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  const dir = p.includes("/") ? p.split("/").slice(0, -1).join("/") : "";
  const okDir = await ensureDirOnDisk(rootDir, dir);
  if (!okDir.ok) return okDir;
  const ret = await api.appendFile(rootDir, p, content);
  if (!ret?.ok) return { ok: false as const, error: String(ret?.error ?? "APPEND_FAILED") };
  return { ok: true as const };
}

async function fileExistsInProject(rootDir: string, relPath: string) {
  const api = window.desktop?.fs;
  if (!api) return false;
  try {
    const r = await api.readFile(rootDir, relPath);
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

function uniqueMdName(base: string, used: Set<string>) {
  const b0 = sanitizeFileName(base) || "untitled";
  let name = b0;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    name = `${b0}_${n++}`;
  }
  used.add(name.toLowerCase());
  return `${name}.md`;
}

function resolveDefaultDraftModel() {
  const run: any = useRunStore.getState();
  const v = String(run?.model ?? run?.agentModel ?? "").trim();
  return v || "deepseek-v3.2";
}

async function callLlmTextOnce(args: { model: string; system: string; user: string; abort: AbortController }) {
  const base = getGatewayBaseUrl();
  const url = base ? `${base}/api/llm/chat/stream` : "/api/llm/chat/stream";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      model: args.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
    }),
    signal: args.abort.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { ok: false as const, error: text || `HTTP_${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const mEvt = block.match(/^event:\s*(.+)$/m);
      const mData = block.match(/^data:\s*(.+)$/m);
      const evt = mEvt?.[1] ? String(mEvt[1]).trim() : "";
      const data = mData?.[1] ? String(mData[1]).trim() : "";
      if (evt === "assistant.delta") {
        try {
          const payload = JSON.parse(data);
          const delta = payload?.delta;
          if (typeof delta === "string") out += delta;
        } catch {
          // ignore
        }
      }
      if (evt === "assistant.done") {
        return { ok: true as const, text: out };
      }
      if (evt === "error") {
        try {
          const payload = JSON.parse(data);
          const msg = payload?.error ? String(payload.error) : "unknown";
          return { ok: false as const, error: msg };
        } catch {
          return { ok: false as const, error: data || "unknown" };
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  return { ok: true as const, text: out };
}

function extractFirstHeading(content: string) {
  const lines = String(content ?? "").split(/\r?\n/);
  for (const line of lines.slice(0, 50)) {
    const m = line.match(/^\s*#{1,3}\s+(.+?)\s*$/);
    if (m?.[1]) return String(m[1]).trim();
  }
  return "";
}

function jsonParseLoose<T = any>(raw: string): { ok: true; value: T } | { ok: false; error: string } {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "EMPTY" };
  // 允许模型前后夹杂：只截取第一个 JSON 对象/数组
  const firstObj = s.match(/\{[\s\S]*\}/);
  const firstArr = s.match(/\[[\s\S]*\]/);
  const pick = (() => {
    const a = firstArr?.[0] ?? "";
    const b = firstObj?.[0] ?? "";
    if (a && b) return a.length >= b.length ? a : b;
    return a || b || s;
  })();
  try {
    return { ok: true, value: JSON.parse(pick) as T };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function writeJobCheckpoint(args: { rootDir: string; job: WritingBatchJob }) {
  const p = joinRel(args.job.outputDir, ".batch-meta/job.json");
  const payload = {
    v: 1,
    id: args.job.id,
    createdAt: args.job.createdAt,
    updatedAt: args.job.updatedAt,
    status: args.job.status,
    inputDir: args.job.inputDir,
    inputFilesCount: args.job.inputFiles.length,
    outputDir: args.job.outputDir,
    clipsPerLesson: args.job.clipsPerLesson,
    styleLibraryId: args.job.styleLibraryId,
    model: args.job.model,
    progress: args.job.progress,
    lastFailure: args.job.failures[0] ?? null,
  };
  return await writeTextFileToProject(args.rootDir, p, JSON.stringify(payload, null, 2) + "\n");
}

async function runOneClip(args: {
  model: string;
  styleLibraryId: string;
  lessonTitle: string;
  lessonText: string;
  clipIndex: number;
  clipTitle: string;
  abort: AbortController;
}) {
  const kb = useKbStore.getState();
  const playbook = await kb.getPlaybookTextForLibraries([args.styleLibraryId]).catch(() => "");
  const styleCtx = String(playbook ?? "").slice(0, 14_000);
  const lesson = String(args.lessonText ?? "").slice(0, 18_000);

  const sys =
    "你是写作 IDE 的批处理生成器。\n" +
    "你将严格按风格库口吻输出短视频口播稿。\n" +
    "硬约束：不要新增事实/数据；只基于输入课程内容重组表达。\n" +
    "输出必须是 Markdown 纯文本（不要 JSON）。\n";

  const user =
    `【风格库手册（节选）】\n${styleCtx}\n\n` +
    `【课程内容】\n${lesson}\n\n` +
    `请生成第 ${args.clipIndex + 1} 篇（共 5 篇）短视频口播稿。\n` +
    `- 本篇标题：${args.clipTitle}\n` +
    `- 目标：短、狠、节奏快，有“法官宣判”感（按风格库）\n` +
    `- 结构：开场钩子→反直觉断言→3段论证→收尾一句金句\n` +
    `- 长度：约 900~1300 字\n` +
    `只输出正文 Markdown，不要解释。\n`;

  const draftRet = await callLlmTextOnce({ model: args.model, system: sys, user, abort: args.abort });
  if (!draftRet.ok) return { ok: false as const, error: draftRet.error };
  let bestText = String(draftRet.text ?? "").trim();
  if (!bestText) return { ok: false as const, error: "EMPTY_DRAFT" };

  // 1) lint.copy（最多 2 次回炉）
  for (let k = 0; k < 2; k += 1) {
    const lint = await executeToolCall({
      toolName: "lint.copy",
      rawArgs: { text: bestText, libraryIds: JSON.stringify([args.styleLibraryId]) },
      mode: "agent",
    });
    const out: any = (lint.result as any)?.output ?? null;
    const passed = Boolean(out?.passed);
    if (passed) break;

    const overlaps = Array.isArray(out?.topOverlaps) ? out.topOverlaps.slice(0, 6) : [];
    const overlapHint = overlaps.length ? JSON.stringify(overlaps, null, 2).slice(0, 2400) : "";
    const reworkUser =
      `你刚刚的候选稿 lint.copy 未通过（疑似复用过高）。\n` +
      `你必须在不改变核心观点的前提下局部改写，重点处理这些重合片段：\n${overlapHint}\n\n` +
      `【上一版候选稿】\n${bestText.slice(0, 8000)}\n\n` +
      `要求：只改动必要句子；保留风格节奏；输出修订后的全文。\n`;
    const rr = await callLlmTextOnce({ model: args.model, system: sys, user: reworkUser, abort: args.abort });
    if (!rr.ok) break;
    const next = String(rr.text ?? "").trim();
    if (next) bestText = next;
  }

  // 2) lint.style（最多 2 次回炉；通过阈值默认 80）
  let bestScore = -1;
  for (let k = 0; k < 2; k += 1) {
    const lint = await executeToolCall({
      toolName: "lint.style",
      rawArgs: { text: bestText, libraryIds: JSON.stringify([args.styleLibraryId]) },
      mode: "agent",
    });
    const out: any = (lint.result as any)?.output ?? null;
    const score = Number(out?.similarityScore ?? -1);
    if (Number.isFinite(score) && score > bestScore) bestScore = score;
    if (score >= 80) return { ok: true as const, text: bestText, similarityScore: score };

    const rewritePrompt = String(out?.rewritePrompt ?? "").trim();
    if (!rewritePrompt) break;
    const reworkUser =
      `你刚刚的候选稿 lint.style 未通过（当前 similarityScore=${score}）。\n` +
      `你必须严格按下列 rewritePrompt 做局部改写（不要推倒重写；不要新增事实/数据）：\n` +
      `---\n${rewritePrompt}\n---\n\n` +
      `【上一版候选稿】\n${bestText.slice(0, 8000)}\n\n` +
      `输出修订后的全文（Markdown 纯文本）。\n`;
    const rr = await callLlmTextOnce({ model: args.model, system: sys, user: reworkUser, abort: args.abort });
    if (!rr.ok) break;
    const next = String(rr.text ?? "").trim();
    if (next) bestText = next;
  }

  // 未达阈值：仍返回当前最佳文本（由批处理记录并继续）
  return { ok: true as const, text: bestText, similarityScore: bestScore };
}

export const useWritingBatchStore = create<WritingBatchState>()(
  persist(
    (set, get) => ({
      status: "idle",
      error: null,
      jobs: [],
      activeJobId: null,
      runStartedAtMs: null,
      runElapsedMs: 0,

      // 默认行为（关键体验）：
      // - 不弹系统“选目录”对话框
      // - inputDir 缺省时：以“当前项目 rootDir”为根，只处理“当前活动文件（activePath）”
      //   这样用户在打开一篇课件时，直接一句“批处理拆成 N 篇”即可跑起来。
      createJobInteractive: async (args) => {
        if (!requireLoginForBatch({ why: "批量生成短视频稿" }).ok) return { ok: false, error: "AUTH_REQUIRED" };
        const api = window.desktop?.fs;
        if (!api) return { ok: false, error: "NO_FS_API" };
        const proj = useProjectStore.getState();
        const rootDir = String(proj.rootDir ?? "").trim();
        if (!rootDir) return { ok: false, error: "NO_PROJECT" };

        const styleLibId = (() => {
          const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
          const libs = useKbStore.getState().libraries ?? [];
          const style = libs.filter((l) => l.purpose === "style").map((l) => l.id);
          const pick = attached.find((id) => style.includes(id)) ?? style[0] ?? "";
          return String(pick ?? "").trim();
        })();
        if (!styleLibId) return { ok: false, error: "NO_STYLE_LIBRARY" };

        const activeRel = String(proj.activePath ?? "").trim();
        const activeOk = activeRel && isTextRelPath(activeRel) && proj.files.some((f) => f.path === activeRel);
        if (!activeOk) {
          return {
            ok: false,
            error: "NO_ACTIVE_TEXT_FILE",
            detail: {
              hint: "请先在编辑器中打开一个 .md/.mdx/.txt 文件（作为本次批处理输入），再启动批处理。",
              activePath: activeRel,
            },
          };
        }
        // 为避免“读到旧磁盘内容”：如果当前文件有未保存改动，先自动保存再跑批处理
        try {
          const f = proj.files.find((x) => x.path === activeRel);
          if (f?.dirty) await proj.saveActiveNow?.();
        } catch {
          // ignore autosave failures; fallback to disk content
        }
        const inputDir = rootDir; // 关键：输入根固定为项目 rootDir（绝对路径）
        const inputFiles = [activeRel]; // 关键：只处理当前活动文件

        const clipsPerLesson = typeof args?.clipsPerLesson === "number" ? Math.max(1, Math.min(12, Math.floor(args.clipsPerLesson))) : 5;
        // 默认输出：在“当前活动文件”同级目录生成单层 batch_xxx/（避免 exports/.../batch_xxx 过深）
        const outputBaseDefault = ensureRelDir(dirnameRel(activeRel));
        const outputBase = ensureRelDir(String(args?.outputBaseDir ?? outputBaseDefault));

        const jobId = `batch_${Date.now()}`;
        const outputDir = joinRel(outputBase, jobId);
        const job: WritingBatchJob = {
          id: jobId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          status: "pending",
          inputDir,
          inputFiles,
          outputDir,
          clipsPerLesson,
          styleLibraryId: styleLibId,
          model: resolveDefaultDraftModel(),
          progress: { fileIndex: 0, clipIndex: 0, done: 0, failed: 0 },
          failures: [],
        };
        set((s) => ({ jobs: [job, ...s.jobs].slice(0, 30), activeJobId: jobId, error: null }));

        // 创建输出目录与 meta
        await ensureDirOnDisk(rootDir, joinRel(outputDir, ".batch-meta"));
        await writeTextFileToProject(
          rootDir,
          joinRel(outputDir, ".batch-meta/metadata.json"),
          JSON.stringify(
            {
              v: 1,
              createdAt: job.createdAt,
              inputDir,
              inputFilesCount: inputFiles.length,
              clipsPerLesson,
              styleLibraryId: styleLibId,
            },
            null,
            2,
          ) + "\n",
        );
        await writeJobCheckpoint({ rootDir, job });
        return { ok: true, jobId };
      },

      createJobFromDir: async (args) => {
        if (!requireLoginForBatch({ why: "批量生成短视频稿" }).ok) return { ok: false, error: "AUTH_REQUIRED" };
        const api = window.desktop?.fs;
        if (!api) return { ok: false, error: "NO_FS_API" };
        const proj = useProjectStore.getState();
        const rootDir = String(proj.rootDir ?? "").trim();
        if (!rootDir) return { ok: false, error: "NO_PROJECT" };

        const rawInput = String(args?.inputDir ?? "").trim();
        if (!rawInput) return { ok: false, error: "EMPTY_INPUT_DIR" };
        // 兼容：允许传项目内相对路径（例如 "drafts/course_14_split/" 或 "第14课...md"）
        const inputAbs = looksLikeAbsPath(rawInput) ? rawInput : joinAbs(rootDir, rawInput);

        const styleLibId = (() => {
          const attached = useRunStore.getState().kbAttachedLibraryIds ?? [];
          const libs = useKbStore.getState().libraries ?? [];
          const style = libs.filter((l) => l.purpose === "style").map((l) => l.id);
          const pick = attached.find((id) => style.includes(id)) ?? style[0] ?? "";
          return String(pick ?? "").trim();
        })();
        if (!styleLibId) return { ok: false, error: "NO_STYLE_LIBRARY" };

        // 若传入的是“单文件路径”，则只处理这一篇（而不是扫全目录）
        if (isTextRelPath(rawInput) || isTextRelPath(inputAbs)) {
          const fileAbs = inputAbs;
          const fileName = basenameAny(fileAbs);
          const dirAbs = fileAbs.slice(0, Math.max(0, fileAbs.length - fileName.length)).replace(/[/\\]+$/g, "");
          if (!fileName || !dirAbs) return { ok: false, error: "INVALID_INPUT_PATH", detail: { input: rawInput } };
          const readOne = await api.readFile(dirAbs, fileName);
          if (!readOne?.ok) {
            return { ok: false, error: "INPUT_FILE_NOT_FOUND", detail: { input: rawInput, resolved: fileAbs, hint: "请确认文件存在且为 .md/.mdx/.txt" } };
          }

          const clipsPerLesson = typeof args?.clipsPerLesson === "number" ? Math.max(1, Math.min(12, Math.floor(args.clipsPerLesson))) : 5;
          const activeRel = String(proj.activePath ?? "").trim();
          const outputBaseDefault =
            activeRel && isTextRelPath(activeRel) && proj.files.some((f) => f.path === activeRel) ? ensureRelDir(dirnameRel(activeRel)) : "exports";
          const outputBase = ensureRelDir(String(args?.outputBaseDir ?? outputBaseDefault));
          const jobId = `batch_${Date.now()}`;
          const outputDir = joinRel(outputBase, jobId);
          const job: WritingBatchJob = {
            id: jobId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            status: "pending",
            inputDir: dirAbs,
            inputFiles: [fileName],
            outputDir,
            clipsPerLesson,
            styleLibraryId: styleLibId,
            model: resolveDefaultDraftModel(),
            progress: { fileIndex: 0, clipIndex: 0, done: 0, failed: 0 },
            failures: [],
          };
          set((s) => ({ jobs: [job, ...s.jobs].slice(0, 30), activeJobId: jobId, error: null }));
          await ensureDirOnDisk(rootDir, joinRel(outputDir, ".batch-meta"));
          await writeTextFileToProject(
            rootDir,
            joinRel(outputDir, ".batch-meta/metadata.json"),
            JSON.stringify(
              {
                v: 1,
                createdAt: job.createdAt,
                inputDir: job.inputDir,
                inputFilesCount: job.inputFiles.length,
                clipsPerLesson,
                styleLibraryId: styleLibId,
                model: job.model,
                inputResolvedFrom: rawInput,
              },
              null,
              2,
            ) + "\n",
          );
          await writeJobCheckpoint({ rootDir, job });
          return { ok: true, jobId };
        }

        const listed = await api.listFiles(inputAbs);
        if (!listed?.ok) return { ok: false, error: String(listed?.error ?? "LIST_FAILED"), detail: { input: rawInput, resolved: inputAbs } };
        const files = Array.isArray(listed.files) ? listed.files.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
        const inputFiles = files.slice().sort();
        if (!inputFiles.length) {
          return {
            ok: false,
            error: "NO_TEXT_FILES",
            detail: {
              input: rawInput,
              resolved: inputAbs,
              hint:
                "该目录下没有可处理的 .md/.mdx/.txt 文件。\n" +
                "- 如果你传的是项目内相对路径：请确认路径相对项目根目录。\n" +
                "- 如果你刚生成了 doc.previewDiff 提案：请先点 Keep 写入文件后再启动批处理。\n",
            },
          };
        }

        const clipsPerLesson = typeof args?.clipsPerLesson === "number" ? Math.max(1, Math.min(12, Math.floor(args.clipsPerLesson))) : 5;
        const activeRel = String(proj.activePath ?? "").trim();
        const outputBaseDefault =
          activeRel && isTextRelPath(activeRel) && proj.files.some((f) => f.path === activeRel) ? ensureRelDir(dirnameRel(activeRel)) : "exports";
        const outputBase = ensureRelDir(String(args?.outputBaseDir ?? outputBaseDefault));

        const jobId = `batch_${Date.now()}`;
        const outputDir = joinRel(outputBase, jobId);
        const job: WritingBatchJob = {
          id: jobId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          status: "pending",
          inputDir: inputAbs,
          inputFiles,
          outputDir,
          clipsPerLesson,
          styleLibraryId: styleLibId,
          model: resolveDefaultDraftModel(),
          progress: { fileIndex: 0, clipIndex: 0, done: 0, failed: 0 },
          failures: [],
        };

        set((s) => ({ jobs: [job, ...s.jobs].slice(0, 30), activeJobId: jobId, error: null }));
        await ensureDirOnDisk(rootDir, joinRel(outputDir, ".batch-meta"));
        await writeTextFileToProject(
          rootDir,
          joinRel(outputDir, ".batch-meta/metadata.json"),
          JSON.stringify(
            {
              v: 1,
              createdAt: job.createdAt,
              inputDir,
              inputFilesCount: inputFiles.length,
              clipsPerLesson,
              styleLibraryId: styleLibId,
              model: job.model,
            },
            null,
            2,
          ) + "\n",
        );
        await writeJobCheckpoint({ rootDir, job });
        return { ok: true, jobId };
      },

      start: async (jobId) => {
        const id = String(jobId ?? get().activeJobId ?? "").trim();
        if (!id) return;
        if (get().status === "running") return;
        set({ status: "running", error: null, activeJobId: id, runStartedAtMs: Date.now() });

        if (runner) return runner;
        abortReason = null;
        abort = new AbortController();
        runner = (async () => {
          try {
            const proj = useProjectStore.getState();
            const rootDir = String(proj.rootDir ?? "").trim();
            if (!rootDir) throw new Error("NO_PROJECT");

            const job = get().jobs.find((j) => j.id === id);
            if (!job) throw new Error("JOB_NOT_FOUND");

            // 标记 running
            set((s) => ({
              jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: "running", updatedAt: nowIso() } : j)),
            }));
            await writeJobCheckpoint({ rootDir, job: { ...job, status: "running", updatedAt: nowIso() } });

            const model = String(job.model ?? "").trim() || resolveDefaultDraftModel();

            for (let fi = job.progress.fileIndex; fi < job.inputFiles.length; fi += 1) {
              if (abort?.signal.aborted) break;
              const fileRel = job.inputFiles[fi];

              // 读取课程内容
              // eslint-disable-next-line no-await-in-loop
              const rf = await readTextFileFromDir(job.inputDir, fileRel);
              if (!rf.ok) {
                set((s) => ({
                  jobs: s.jobs.map((j) => {
                    if (j.id !== id) return j;
                    const failures = [{ at: nowIso(), file: fileRel, clipIndex: -1, error: rf.error }, ...j.failures].slice(0, 200);
                    return {
                      ...j,
                      status: j.status,
                      updatedAt: nowIso(),
                      progress: { ...j.progress, fileIndex: fi, clipIndex: 0, failed: j.progress.failed + 1, lastError: rf.error },
                      failures,
                    };
                  }),
                }));
                continue;
              }

              const lessonText = rf.content;
              const lessonTitle = extractFirstHeading(lessonText) || sanitizeFileName(fileRel.split("/").pop() || fileRel) || `第${fi + 1}课`;

              // 每节课先生成 5 个标题（一次调用）
              const planKey = sanitizeFileName(lessonTitle) || `lesson_${fi + 1}`;
              const planPath = joinRel(job.outputDir, `.batch-meta/plans/${planKey}.json`);
              let planTitles: string[] = [];
              {
                const api = window.desktop?.fs;
                const exists = await (async () => {
                  if (!api) return false;
                  const r = await api.readFile(rootDir, planPath);
                  return Boolean(r?.ok && r.content);
                })();
                if (exists) {
                  const r = await window.desktop!.fs!.readFile(rootDir, planPath);
                  const parsed = jsonParseLoose<any>(String(r?.content ?? ""));
                  if (parsed.ok && Array.isArray((parsed.value as any)?.titles)) {
                    planTitles = (parsed.value as any).titles.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, job.clipsPerLesson);
                  }
                } else {
                  const sys =
                    "你是写作 IDE 的批处理规划器。\n" +
                    "任务：给定一节课程内容，拆成若干条短视频口播稿标题。\n" +
                    "输出必须是 JSON：{ \"titles\": string[] }，不要代码块。\n";
                  const user =
                    `课程标题：${lessonTitle}\n` +
                    `要求：生成 ${job.clipsPerLesson} 个短视频标题（每个标题 10~20 字，风格库口吻：硬核、断言、反常识）。\n` +
                    `课程内容：\n${String(lessonText ?? "").slice(0, 12_000)}\n`;
                  // eslint-disable-next-line no-await-in-loop
                  const rr = await callLlmTextOnce({ model, system: sys, user, abort: abort! });
                  const parsed = rr.ok ? jsonParseLoose<any>(rr.text) : { ok: false as const, error: rr.error };
                  planTitles = parsed.ok && Array.isArray((parsed.value as any)?.titles)
                    ? (parsed.value as any).titles.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, job.clipsPerLesson)
                    : [];
                  if (!planTitles.length) {
                    // 兜底：用通用标题
                    planTitles = Array.from({ length: job.clipsPerLesson }).map((_, i) => `${lessonTitle}（第${i + 1}条）`);
                  }
                  await ensureDirOnDisk(rootDir, joinRel(job.outputDir, ".batch-meta/plans"));
                  await writeTextFileToProject(rootDir, planPath, JSON.stringify({ v: 1, lessonTitle, titles: planTitles }, null, 2) + "\n");
                }
              }

              // 输出目录：每节课一个子目录
              const lessonDirName = `${pad2(fi + 1)}_${sanitizeFileName(lessonTitle) || `lesson_${fi + 1}`}`;
              const lessonOutDir = joinRel(job.outputDir, lessonDirName);
              // eslint-disable-next-line no-await-in-loop
              await ensureDirOnDisk(rootDir, lessonOutDir);
              const usedNames = new Set<string>();

              // 逐条生成
              for (let ci = fi === job.progress.fileIndex ? job.progress.clipIndex : 0; ci < job.clipsPerLesson; ci += 1) {
                if (abort?.signal.aborted) break;
                const clipTitle = planTitles[ci] || `${lessonTitle}（第${ci + 1}条）`;

                const outFile = uniqueMdName(`${pad2(ci + 1)}_${clipTitle}`, usedNames);
                const outPath = joinRel(lessonOutDir, outFile);

                // 若已存在输出文件：跳过（支持断点续跑/二次运行不重复消耗）
                // eslint-disable-next-line no-await-in-loop
                const exists = await fileExistsInProject(rootDir, outPath);
                if (exists) {
                  // eslint-disable-next-line no-await-in-loop
                  await appendTextFileToProject(
                    rootDir,
                    joinRel(job.outputDir, ".batch-meta/progress.jsonl"),
                    JSON.stringify({ at: nowIso(), file: fileRel, clipIndex: ci, outPath, ok: true, skipped: true }) + "\n",
                  );
                  set((s) => ({
                    jobs: s.jobs.map((j) =>
                      j.id === id
                        ? { ...j, updatedAt: nowIso(), progress: { ...j.progress, fileIndex: fi, clipIndex: ci + 1, done: j.progress.done + 1 } }
                        : j,
                    ),
                  }));
                  const nextJob = get().jobs.find((j) => j.id === id);
                  if (nextJob) await writeJobCheckpoint({ rootDir, job: nextJob });
                  // eslint-disable-next-line no-await-in-loop
                  await new Promise((r) => setTimeout(r, 10));
                  continue;
                }

                // eslint-disable-next-line no-await-in-loop
                const gen = await runOneClip({
                  model,
                  styleLibraryId: job.styleLibraryId,
                  lessonTitle,
                  lessonText,
                  clipIndex: ci,
                  clipTitle,
                  abort: abort!,
                });
                const ok = gen.ok;
                const outText = ok ? String((gen as any).text ?? "").trim() : "";
                const score = ok ? Number((gen as any).similarityScore ?? -1) : -1;
                const err = ok ? "" : String((gen as any).error ?? "GEN_FAILED");

                if (ok && outText) {
                  const meta =
                    `---\n` +
                    `title: ${clipTitle}\n` +
                    `source_file: ${fileRel}\n` +
                    `style_library_id: ${job.styleLibraryId}\n` +
                    `similarity_score: ${Number.isFinite(score) ? score : ""}\n` +
                    `batch_job_id: ${job.id}\n` +
                    `batch_item: ${fi + 1}.${ci + 1}\n` +
                    `---\n\n`;
                  // eslint-disable-next-line no-await-in-loop
                  await writeTextFileToProject(rootDir, outPath, meta + outText.trimEnd() + "\n");
                  // eslint-disable-next-line no-await-in-loop
                  await appendTextFileToProject(
                    rootDir,
                    joinRel(job.outputDir, ".batch-meta/progress.jsonl"),
                    JSON.stringify({ at: nowIso(), file: fileRel, clipIndex: ci, outPath, ok: true, score }) + "\n",
                  );
                } else {
                  // eslint-disable-next-line no-await-in-loop
                  await appendTextFileToProject(
                    rootDir,
                    joinRel(job.outputDir, ".batch-meta/failures.jsonl"),
                    JSON.stringify({ at: nowIso(), file: fileRel, clipIndex: ci, ok: false, error: err }) + "\n",
                  );
                }

                // 更新状态
                set((s) => ({
                  jobs: s.jobs.map((j) => {
                    if (j.id !== id) return j;
                    const failures = ok ? j.failures : [{ at: nowIso(), file: fileRel, clipIndex: ci, error: err }, ...j.failures].slice(0, 200);
                    return {
                      ...j,
                      updatedAt: nowIso(),
                      progress: {
                        fileIndex: fi,
                        clipIndex: ci + 1,
                        done: j.progress.done + (ok ? 1 : 0),
                        failed: j.progress.failed + (ok ? 0 : 1),
                        ...(ok ? {} : { lastError: err }),
                      },
                      failures,
                    };
                  }),
                }));
                const nextJob = get().jobs.find((j) => j.id === id);
                if (nextJob) await writeJobCheckpoint({ rootDir, job: nextJob });

                // 让 UI 有机会刷新（避免长任务“像卡死”）
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 20));
              }

              // 下一节课：clipIndex 归零
              set((s) => ({
                jobs: s.jobs.map((j) => (j.id === id ? { ...j, updatedAt: nowIso(), progress: { ...j.progress, fileIndex: fi + 1, clipIndex: 0 } } : j)),
              }));
              const nextJob = get().jobs.find((j) => j.id === id);
              if (nextJob) await writeJobCheckpoint({ rootDir, job: nextJob });
            }

            const endedByAbort = abort?.signal.aborted;
            const status = abortReason === "pause" ? "paused" : abortReason === "cancel" ? "cancelled" : "done";
            set((s) => ({
              status: "idle",
              runStartedAtMs: null,
              runElapsedMs:
                s.runElapsedMs + (typeof s.runStartedAtMs === "number" ? Math.max(0, Date.now() - s.runStartedAtMs) : 0),
              jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: endedByAbort ? status : "done", updatedAt: nowIso() } : j)),
            }));
            const ended = get().jobs.find((j) => j.id === id);
            if (ended) await writeJobCheckpoint({ rootDir, job: ended });

            if (abortReason === "cancel") {
              useDialogStore.getState().openAlert?.("已取消批处理：已停止执行（已生成的文件保留在输出目录）。");
            }
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : String(e);
            set((s) => ({
              status: "idle",
              error: msg,
              runStartedAtMs: null,
              runElapsedMs:
                s.runElapsedMs + (typeof s.runStartedAtMs === "number" ? Math.max(0, Date.now() - s.runStartedAtMs) : 0),
              jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: "failed", updatedAt: nowIso() } : j)),
            }));
          } finally {
            runner = null;
            abort = null;
            abortReason = null;
          }
        })();
        return runner;
      },

      pause: () => {
        if (get().status !== "running") return;
        const nowMs = Date.now();
        set((s) => ({
          status: "paused",
          runStartedAtMs: null,
          runElapsedMs: s.runElapsedMs + (typeof s.runStartedAtMs === "number" ? Math.max(0, nowMs - s.runStartedAtMs) : 0),
        }));
        abortReason = "pause";
        try {
          abort?.abort();
        } catch {
          // ignore
        }
      },

      resume: async () => {
        if (get().status !== "paused") return;
        set({ status: "running", error: null, runStartedAtMs: Date.now() });
        return await get().start(get().activeJobId ?? undefined);
      },

      cancel: () => {
        const nowMs = Date.now();
        set((s) => ({
          status: "idle",
          runStartedAtMs: null,
          runElapsedMs: s.runElapsedMs + (typeof s.runStartedAtMs === "number" ? Math.max(0, nowMs - s.runStartedAtMs) : 0),
        }));
        abortReason = "cancel";
        try {
          abort?.abort();
        } catch {
          // ignore
        }
      },

      clearFinished: () => {
        set((s) => ({
          jobs: s.jobs.filter((j) => !["done", "failed", "cancelled"].includes(j.status)),
          activeJobId: null,
        }));
      },
    }),
    { name: "writing-batch.v1", version: 1 },
  ),
);


