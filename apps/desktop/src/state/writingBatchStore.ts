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
  /** 文件级并行度（A 路由：不同输入文件可并行；同一文件内 clips 串行） */
  filesConcurrency: number;
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

  createJobInteractive: (args?: {
    clipsPerLesson?: number;
    outputBaseDir?: string;
    filesConcurrency?: number;
  }) => Promise<{ ok: boolean; jobId?: string; error?: string; detail?: any }>;
  createJobFromDir: (args: {
    inputDir: string;
    clipsPerLesson?: number;
    outputBaseDir?: string;
    filesConcurrency?: number;
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

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
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
  // 逐级 mkdir（主进程的 mkdir 需要相对项目 rootDir）
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

// 并发写入互斥锁（同一进程内）：避免并行 worker 交错写坏 .jsonl / job.json
const lockTails = new Map<string, Promise<void>>();
async function withLock<T>(key: string, fn: () => Promise<T>) {
  const prev = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  lockTails.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function isRetryableLlmError(err: string) {
  const e = String(err ?? "");
  return (
    e.includes("HTTP_429") ||
    e.includes("HTTP_502") ||
    e.includes("HTTP_503") ||
    e.includes("HTTP_504") ||
    e.includes("Too Many Requests") ||
    e.includes("429") ||
    e.includes("503") ||
    e.includes("502") ||
    e.includes("504")
  );
}

async function sleepMs(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("ABORTED"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }).catch(() => {
    // swallow (abort)
  });
}

async function callLlmTextWithRetry(args: { model: string; system: string; user: string; abort: AbortController; maxAttempts?: number }) {
  const maxAttempts = clampInt(args.maxAttempts ?? 4, 1, 8, 4);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (args.abort.signal.aborted) return { ok: false as const, error: "ABORTED" };
    // eslint-disable-next-line no-await-in-loop
    const r = await callLlmTextOnce({ model: args.model, system: args.system, user: args.user, abort: args.abort });
    if (r.ok) return r;
    const retryable = isRetryableLlmError(r.error);
    if (!retryable || attempt >= maxAttempts - 1) return r;
    const base = 800 * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 250);
    // eslint-disable-next-line no-await-in-loop
    await sleepMs(base + jitter, args.abort.signal);
  }
  return { ok: false as const, error: "RETRY_EXHAUSTED" };
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
  return v || "claude-sonnet-4-6";
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
    filesConcurrency: args.job.filesConcurrency,
    styleLibraryId: args.job.styleLibraryId,
    model: args.job.model,
    progress: args.job.progress,
    lastFailure: args.job.failures[0] ?? null,
  };
  return await writeTextFileToProject(args.rootDir, p, JSON.stringify(payload, null, 2) + "\n");
}

function clipChars(s: string, maxChars: number) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars));
}

function stripFrontmatter(md: string) {
  const s = String(md ?? "");
  if (!s.startsWith("---")) return s;
  const i = s.indexOf("\n---");
  if (i < 0) return s;
  const j = s.indexOf("\n", i + 4);
  return j >= 0 ? s.slice(j + 1) : "";
}

function pickFirstContentLine(md: string) {
  const s = stripFrontmatter(md);
  const lines = s.split(/\r?\n/).map((x) => x.trim());
  for (const line of lines.slice(0, 80)) {
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (line === "---") continue;
    return line.slice(0, 80);
  }
  return "";
}

function pickLastPunchLine(md: string) {
  const s = stripFrontmatter(md);
  const lines = s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    const line = lines[k]!;
    if (line.length < 6) continue;
    if (line.length > 80) continue;
    if (/^[-*]\s+/.test(line)) continue;
    return line.slice(0, 80);
  }
  return "";
}

function pushUniqCapped(list: string[], v: string, cap: number) {
  const s = String(v ?? "").trim();
  if (!s) return;
  if (list.includes(s)) return;
  list.push(s);
  while (list.length > cap) list.shift();
}

async function kbSearchCardSnippets(args: { libraryId: string; query: string; cardTypes: string[] }) {
  try {
    const r = await executeToolCall({
      toolName: "kb.search",
      mode: "agent",
      rawArgs: {
        query: args.query,
        kind: "card",
        libraryIds: JSON.stringify([args.libraryId]),
        cardTypes: JSON.stringify(args.cardTypes),
        perDocTopN: "1",
        topDocs: "10",
        debug: "false",
      },
    });
    if (!(r.result as any)?.ok) return "- （检索失败）";
    const out: any = (r.result as any)?.output ?? null;
    const groups = Array.isArray(out?.groups) ? out.groups : [];
    const lines: string[] = [];
    for (const g of groups) {
      const docTitle = String(g?.sourceDoc?.title ?? g?.sourceDoc?.name ?? "").trim();
      const hits = Array.isArray(g?.hits) ? g.hits : [];
      for (const h of hits) {
        const ct = String(h?.artifact?.cardType ?? "").trim();
        const snip = String(h?.snippet ?? "").replace(/\s+/g, " ").trim();
        if (!snip) continue;
        const head = docTitle ? `【${docTitle}】` : "";
        lines.push(`- ${head}${ct ? `(${ct}) ` : ""}${clipChars(snip, 160)}`);
        if (lines.length >= 10) break;
      }
      if (lines.length >= 10) break;
    }
    return lines.length ? lines.join("\n") : "- （无命中）";
  } catch {
    return "- （检索失败）";
  }
}

function replaceLastPlaceholder(text: string, placeholder: string, replacement: string) {
  const t = String(text ?? "");
  const p = String(placeholder ?? "");
  const r = String(replacement ?? "").trim();
  if (!t.trim()) return r;
  if (!p) return t;
  const idx = t.lastIndexOf(p);
  if (idx < 0) {
    return t.trimEnd() + "\n\n" + r + "\n";
  }
  return t.slice(0, idx) + r + t.slice(idx + p.length);
}

async function runOneClip(args: {
  model: string;
  styleLibraryId: string;
  lessonTitle: string;
  lessonText: string;
  clipIndex: number;
  totalClips?: number;
  clipTitle: string;
  abort: AbortController;
  avoidOpenings?: string[];
  avoidOneLiners?: string[];
}) {
  const kb = useKbStore.getState();
  const playbook = await kb.getPlaybookTextForLibraries([args.styleLibraryId]).catch(() => "");
  const styleCtx = String(playbook ?? "").slice(0, 14_000);
  const lesson = String(args.lessonText ?? "").slice(0, 18_000);

  // 每篇独立检索（不共享）：开头/结尾/金句/结构
  const hookHint = (() => {
    const types = ["反直觉断言", "尖锐提问", "反差对照", "一句话宣判", "场景切入"];
    return types[Math.max(0, args.clipIndex) % types.length]!;
  })();
  const [hookCards, endingCards, oneLinerCards, outlineCards] = await Promise.all([
    kbSearchCardSnippets({
      libraryId: args.styleLibraryId,
      query: `${args.lessonTitle}｜${args.clipTitle} 开头 钩子 ${hookHint} 断言 反直觉`,
      cardTypes: ["hook"],
    }),
    kbSearchCardSnippets({
      libraryId: args.styleLibraryId,
      query: `${args.lessonTitle}｜${args.clipTitle} 结尾 收束 落点 行动 建议`,
      cardTypes: ["ending"],
    }),
    kbSearchCardSnippets({
      libraryId: args.styleLibraryId,
      query: `${args.lessonTitle}｜${args.clipTitle} 金句 一句话 断言 反常识`,
      cardTypes: ["one_liner"],
    }),
    kbSearchCardSnippets({
      libraryId: args.styleLibraryId,
      query: `${args.lessonTitle}｜${args.clipTitle} 结构 骨架 三段论 论证 推进`,
      cardTypes: ["outline", "thesis"],
    }),
  ]);

  const sys =
    "你是写作 IDE 的批处理生成器。\n" +
    "你将严格按风格库口吻输出短视频口播稿。\n" +
    "硬约束：不要新增事实/数据；只基于输入课程内容重组表达。\n" +
    "风格要求：允许借鉴“模板/句式形状”，但禁止复述风格库原句。\n" +
    "输出必须是 Markdown 纯文本（不要 JSON）。\n";

  const avoidBlock = (() => {
    const opens = Array.isArray(args.avoidOpenings) ? args.avoidOpenings : [];
    const ones = Array.isArray(args.avoidOneLiners) ? args.avoidOneLiners : [];
    if (!opens.length && !ones.length) return "";
    return (
      `【本节课已用过的开头/金句（必须避开，不能同义替换）】\n` +
      (opens.length ? `开头：\n${opens.slice(0, 8).map((x) => `- ${x}`).join("\n")}\n` : "") +
      (ones.length ? `金句：\n${ones.slice(0, 8).map((x) => `- ${x}`).join("\n")}\n` : "") +
      "\n"
    );
  })();

  const total = typeof args.totalClips === "number" ? Math.max(1, Math.floor(args.totalClips)) : 5;
  const user =
    `【风格库手册（节选）】\n${styleCtx}\n\n` +
    `【风格库检索：开头钩子（hook）】\n${hookCards}\n\n` +
    `【风格库检索：结尾收束（ending）】\n${endingCards}\n\n` +
    `【风格库检索：金句形状（one_liner）】\n${oneLinerCards}\n\n` +
    `【风格库检索：结构骨架（outline/thesis）】\n${outlineCards}\n\n` +
    avoidBlock +
    `【课程内容】\n${lesson}\n\n` +
    `请生成第 ${args.clipIndex + 1} 篇（共 ${total} 篇）短视频口播稿。\n` +
    `- 本篇标题：${args.clipTitle}\n` +
    `- 目标：短、狠、节奏快，有“法官宣判”感（按风格库）\n` +
    `- 结构：开场钩子→反直觉断言→3段论证→收尾一句金句\n` +
    `- 长度：约 900~1300 字\n` +
    `- 输出要求：最后一行必须是“【金句】”（占位符），不要自己写金句；其余正文照常写。\n` +
    `只输出正文 Markdown，不要解释。\n`;

  const draftRet = await callLlmTextWithRetry({ model: args.model, system: sys, user, abort: args.abort });
  if (!draftRet.ok) return { ok: false as const, error: draftRet.error };
  let bestText = String(draftRet.text ?? "").trim();
  if (!bestText) return { ok: false as const, error: "EMPTY_DRAFT" };

  // 0) 金句二段式：先出候选稿，再根据 one_liner “形状卡”生成金句并填回占位符
  {
    const oneSys =
      "你是写作 IDE 的金句生成器。\n" +
      "任务：参考风格库的金句“形状”，为本篇候选稿生成更像风格库、但不贴原句的金句。\n" +
      "输出必须是严格 JSON：{ \"candidates\": string[] }，不要代码块。\n";
    const oneUser =
      `【金句形状卡（one_liner）】\n${oneLinerCards}\n\n` +
      (Array.isArray(args.avoidOneLiners) && args.avoidOneLiners.length
        ? `【本节课已用过的金句（必须避开，不能同义替换）】\n${args.avoidOneLiners.slice(0, 8).map((x) => `- ${x}`).join("\n")}\n\n`
        : "") +
      `【本篇候选稿（节选）】\n${clipChars(bestText, 9000)}\n\n` +
      `请生成 10 条“收尾金句”候选（每条 12~28 字；短、硬、带断言/反常识；不要新增事实/数据）。\n`;
    const rr = await callLlmTextWithRetry({ model: args.model, system: oneSys, user: oneUser, abort: args.abort });
    if (rr.ok) {
      const parsed = jsonParseLoose<any>(rr.text);
      const cands = parsed.ok && Array.isArray((parsed.value as any)?.candidates) ? (parsed.value as any).candidates : [];
      const cleaned = (cands as any[])
        .map((x) => String(x ?? "").trim())
        .filter(Boolean)
        .map((x) => x.replace(/\s+/g, " "))
        .slice(0, 10);
      const avoid = new Set((Array.isArray(args.avoidOneLiners) ? args.avoidOneLiners : []).map((x) => String(x ?? "").trim()).filter(Boolean));
      const picked = cleaned.find((x) => !avoid.has(x)) ?? cleaned[0] ?? "";
      if (picked) bestText = replaceLastPlaceholder(bestText, "【金句】", picked).trim();
      // 如果模型没按要求给占位符：兜底追加
      if (!picked && !bestText.includes("【金句】")) {
        bestText = bestText.trimEnd() + "\n\n" + "【金句】" + "\n";
      }
      if (picked && bestText.includes("【金句】")) {
        bestText = bestText.replace(/【金句】/g, picked);
      }
    }
  }

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
    const rr = await callLlmTextWithRetry({ model: args.model, system: sys, user: reworkUser, abort: args.abort });
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
    const rr = await callLlmTextWithRetry({ model: args.model, system: sys, user: reworkUser, abort: args.abort });
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
        const filesConcurrency = clampInt(args?.filesConcurrency ?? 2, 1, 4, 2);
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
          filesConcurrency,
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
              filesConcurrency,
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
          const filesConcurrency = clampInt(args?.filesConcurrency ?? 2, 1, 4, 2);
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
            filesConcurrency,
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
                filesConcurrency,
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
        const filesConcurrency = clampInt(args?.filesConcurrency ?? 2, 1, 4, 2);
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
          filesConcurrency,
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
              inputDir: inputAbs,
              inputFilesCount: inputFiles.length,
              clipsPerLesson,
              filesConcurrency,
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
            const filesConcurrency = clampInt(job.filesConcurrency ?? 2, 1, 4, 2);
            const totalFiles = job.inputFiles.length;
            const progressPath = joinRel(job.outputDir, ".batch-meta/progress.jsonl");
            const failuresPath = joinRel(job.outputDir, ".batch-meta/failures.jsonl");
            const checkpointKey = `job_checkpoint:${job.id}`;

            const writeCheckpointLocked = async () => {
              const nextJob = get().jobs.find((j) => j.id === id);
              if (!nextJob) return;
              await withLock(checkpointKey, async () => {
                await writeJobCheckpoint({ rootDir, job: nextJob });
              });
            };

            const appendProgressLocked = async (line: any) => {
              await withLock(`append:${progressPath}`, async () => {
                await appendTextFileToProject(rootDir, progressPath, JSON.stringify(line) + "\n");
              });
            };

            const appendFailureLocked = async (line: any) => {
              await withLock(`append:${failuresPath}`, async () => {
                await appendTextFileToProject(rootDir, failuresPath, JSON.stringify(line) + "\n");
              });
            };

            const processOneFile = async (fi: number) => {
              if (abort?.signal.aborted) return;
              const fileRel = job.inputFiles[fi];

              const rf = await readTextFileFromDir(job.inputDir, fileRel);
              if (!rf.ok) {
                await appendFailureLocked({ at: nowIso(), file: fileRel, clipIndex: -1, ok: false, error: rf.error });
                set((s) => ({
                  jobs: s.jobs.map((j) => {
                    if (j.id !== id) return j;
                    const failures = [{ at: nowIso(), file: fileRel, clipIndex: -1, error: rf.error }, ...j.failures].slice(0, 200);
                    return {
                      ...j,
                      updatedAt: nowIso(),
                      progress: { ...j.progress, fileIndex: Math.max(j.progress.fileIndex, fi), clipIndex: 0, failed: j.progress.failed + 1, lastError: rf.error },
                      failures,
                    };
                  }),
                }));
                await writeCheckpointLocked();
                return;
              }

              const lessonText = rf.content;
              const lessonTitle = extractFirstHeading(lessonText) || sanitizeFileName(basenameAny(fileRel) || fileRel) || `第${fi + 1}课`;

              // 每节课先生成 N 个标题（一次调用）；planKey 必须“文件级唯一”，避免不同文件同名覆盖
              const planKey = `${pad2(fi + 1)}_${sanitizeFileName(lessonTitle) || `lesson_${fi + 1}`}`;
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
                  const rr = await callLlmTextWithRetry({ model, system: sys, user, abort: abort! });
                  const parsed = rr.ok ? jsonParseLoose<any>(rr.text) : { ok: false as const, error: rr.error };
                  planTitles = parsed.ok && Array.isArray((parsed.value as any)?.titles)
                    ? (parsed.value as any).titles.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, job.clipsPerLesson)
                    : [];
                  if (!planTitles.length) {
                    planTitles = Array.from({ length: job.clipsPerLesson }).map((_, i) => `${lessonTitle}（第${i + 1}条）`);
                  }
                  await ensureDirOnDisk(rootDir, joinRel(job.outputDir, ".batch-meta/plans"));
                  await writeTextFileToProject(rootDir, planPath, JSON.stringify({ v: 1, lessonTitle, titles: planTitles }, null, 2) + "\n");
                }
              }

              const lessonDirName = `${pad2(fi + 1)}_${sanitizeFileName(lessonTitle) || `lesson_${fi + 1}`}`;
              const lessonOutDir = joinRel(job.outputDir, lessonDirName);
              await ensureDirOnDisk(rootDir, lessonOutDir);

              const usedNames = new Set<string>();
              const usedOpenings: string[] = [];
              const usedOneLiners: string[] = [];

              for (let ci = 0; ci < job.clipsPerLesson; ci += 1) {
                if (abort?.signal.aborted) break;
                const clipTitle = planTitles[ci] || `${lessonTitle}（第${ci + 1}条）`;

                const outFile = uniqueMdName(`${pad2(ci + 1)}_${clipTitle}`, usedNames);
                const outPath = joinRel(lessonOutDir, outFile);

                const exists = await fileExistsInProject(rootDir, outPath);
                if (exists) {
                  try {
                    const r = await window.desktop!.fs!.readFile(rootDir, outPath);
                    const prev = String(r?.content ?? "");
                    pushUniqCapped(usedOpenings, pickFirstContentLine(prev), 8);
                    pushUniqCapped(usedOneLiners, pickLastPunchLine(prev), 8);
                  } catch {
                    // ignore
                  }
                  await appendProgressLocked({ at: nowIso(), file: fileRel, clipIndex: ci, outPath, ok: true, skipped: true });
                  set((s) => ({
                    jobs: s.jobs.map((j) =>
                      j.id === id
                        ? { ...j, updatedAt: nowIso(), progress: { ...j.progress, fileIndex: Math.max(j.progress.fileIndex, fi), clipIndex: ci + 1, done: j.progress.done + 1 } }
                        : j,
                    ),
                  }));
                  await writeCheckpointLocked();
                  // eslint-disable-next-line no-await-in-loop
                  await new Promise((r) => setTimeout(r, 10));
                  continue;
                }

                const gen = await runOneClip({
                  model,
                  styleLibraryId: job.styleLibraryId,
                  lessonTitle,
                  lessonText,
                  clipIndex: ci,
                  totalClips: job.clipsPerLesson,
                  clipTitle,
                  abort: abort!,
                  avoidOpenings: usedOpenings,
                  avoidOneLiners: usedOneLiners,
                });
                const ok = gen.ok;
                const outText = ok ? String((gen as any).text ?? "").trim() : "";
                const score = ok ? Number((gen as any).similarityScore ?? -1) : -1;
                const err = ok ? "" : String((gen as any).error ?? "GEN_FAILED");

                if (ok && outText) {
                  pushUniqCapped(usedOpenings, pickFirstContentLine(outText), 8);
                  pushUniqCapped(usedOneLiners, pickLastPunchLine(outText), 8);
                  const meta =
                    `---\n` +
                    `title: ${clipTitle}\n` +
                    `source_file: ${fileRel}\n` +
                    `style_library_id: ${job.styleLibraryId}\n` +
                    `similarity_score: ${Number.isFinite(score) ? score : ""}\n` +
                    `batch_job_id: ${job.id}\n` +
                    `batch_item: ${fi + 1}.${ci + 1}\n` +
                    `---\n\n`;
                  await writeTextFileToProject(rootDir, outPath, meta + outText.trimEnd() + "\n");
                  await appendProgressLocked({ at: nowIso(), file: fileRel, clipIndex: ci, outPath, ok: true, score });
                } else {
                  await appendFailureLocked({ at: nowIso(), file: fileRel, clipIndex: ci, ok: false, error: err });
                }

                set((s) => ({
                  jobs: s.jobs.map((j) => {
                    if (j.id !== id) return j;
                    const failures = ok ? j.failures : [{ at: nowIso(), file: fileRel, clipIndex: ci, error: err }, ...j.failures].slice(0, 200);
                    return {
                      ...j,
                      updatedAt: nowIso(),
                      progress: {
                        fileIndex: Math.max(j.progress.fileIndex, fi),
                        clipIndex: ci + 1,
                        done: j.progress.done + (ok ? 1 : 0),
                        failed: j.progress.failed + (ok ? 0 : 1),
                        ...(ok ? {} : { lastError: err }),
                      },
                      failures,
                    };
                  }),
                }));
                await writeCheckpointLocked();

                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 20));
              }

              // 完成一个文件：fileIndex 单调递增（用于 UI 展示，不用于恢复游标）
              set((s) => ({
                jobs: s.jobs.map((j) =>
                  j.id === id
                    ? { ...j, updatedAt: nowIso(), progress: { ...j.progress, fileIndex: Math.max(j.progress.fileIndex, fi + 1), clipIndex: 0 } }
                    : j,
                ),
              }));
              await writeCheckpointLocked();
            };

            let nextFi = 0;
            const workers = Array.from({ length: Math.min(filesConcurrency, Math.max(1, totalFiles)) }).map(async () => {
              while (true) {
                if (abort?.signal.aborted) break;
                const fi = nextFi;
                nextFi += 1;
                if (fi >= totalFiles) break;
                // eslint-disable-next-line no-await-in-loop
                await processOneFile(fi);
              }
            });

            await Promise.all(workers);

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
              useDialogStore.getState().openAlert?.({ message: "已取消批处理：已停止执行（已生成的文件保留在输出目录）。" });
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


