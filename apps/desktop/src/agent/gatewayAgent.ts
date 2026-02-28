import { useProjectStore } from "../state/projectStore";
import { useRunStore, type Mode } from "../state/runStore";
import { useKbStore } from "../state/kbStore";
import { useAuthStore } from "../state/authStore";
import { facetLabel, getFacetPack } from "../kb/facets";
import { activateSkills, detectRunIntent, listRegisteredSkills, BUILTIN_SUB_AGENTS } from "@writing-ide/agent-core";
import { usePersonaStore } from "../state/personaStore";
import { useTeamStore, getEffectiveAgents } from "../state/teamStore";
import { useSkillStore } from "../state/skillStore";
import { useMemoryStore } from "../state/memoryStore";
import { startGatewayRunWs } from "./wsTransport";

export function authHeader(): Record<string, string> {
  const token = String(useAuthStore.getState().accessToken ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function requireLoginForLlm(args?: { why?: string }) {
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

export type GatewayRunController = {
  cancel: (reason?: string) => void;
  done: Promise<void>;
};

export type GatewayRunArgs = {
  gatewayUrl: string;
  mode: Mode;
  model: string;
  prompt: string;
  targetAgentId?: string;
  targetAgentIds?: string[];
  activeSkillIds?: string[];
  kbMentionIds?: string[];
};


function coerceSseArgValue(v: unknown): unknown {
  // WS JSON 已解析后值可能已是对象/数组/数字等，无需再 String() 转换
  if (v !== null && v !== undefined && typeof v !== "string") return v;
  const raw = String(v ?? "");
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 32) return Number(s);
  return raw;
}

export function parseSseToolArgs(rawArgs: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs ?? {})) out[k] = coerceSseArgValue(v);
  return out;
}

// ======== patch-style edits（用于 lint.style -> TextEdit[] -> diff 预览 -> Keep/Undo 应用） ========
function computeLineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function getOffsetAt(text: string, lineStarts: number[], lineNumber: number, column: number) {
  const ln = Math.max(1, Math.floor(lineNumber));
  const col = Math.max(1, Math.floor(column));
  const lineIdx = ln - 1;
  const lineStart = lineStarts[lineIdx] ?? text.length;
  const nextLineStart = lineStarts[lineIdx + 1] ?? text.length;
  const lineEnd = nextLineStart > 0 ? Math.max(lineStart, nextLineStart - 1) : lineStart;
  const maxCol0 = Math.max(0, lineEnd - lineStart);
  const col0 = Math.min(maxCol0, col - 1);
  return Math.min(text.length, lineStart + col0);
}

export function applyTextEdits(args: {
  before: string;
  edits: Array<{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; text: string }>;
}) {
  const before = args.before;
  const lineStarts = computeLineStarts(before);
  const ranges = args.edits
    .map((e) => {
      const startOffset = getOffsetAt(before, lineStarts, e.startLineNumber, e.startColumn);
      const endOffset = getOffsetAt(before, lineStarts, e.endLineNumber, e.endColumn);
      return { ...e, startOffset, endOffset };
    })
    .sort((a, b) => b.startOffset - a.startOffset);
  let after = before;
  for (const r of ranges) after = after.slice(0, r.startOffset) + r.text + after.slice(r.endOffset);
  return { after };
}

export function unifiedDiff(args: { path: string; before: string; after: string; context?: number; maxCells?: number; maxHunkLines?: number }) {
  const beforeLines = args.before.split("\n");
  const afterLines = args.after.split("\n");
  const n = beforeLines.length;
  const m = afterLines.length;

  const maxCells = args.maxCells ?? 900_000;
  if (n * m > maxCells) {
    return {
      truncated: true,
      diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(文件过大：diff 预览已跳过。建议先缩小改动范围或仅显示片段预览)\n`,
      stats: null as any,
    };
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    const ai = beforeLines[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j += 1) {
      if (ai === afterLines[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = Math.max(prev[j], row[j - 1]);
    }
  }

  type Op = { type: " " | "+" | "-"; line: string; oldLine: number | null; newLine: number | null };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  let oldNo = n;
  let newNo = m;
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      ops.push({ type: " ", line: beforeLines[i - 1], oldLine: oldNo, newLine: newNo });
      i -= 1;
      j -= 1;
      oldNo -= 1;
      newNo -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
      i -= 1;
      oldNo -= 1;
    } else {
      ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
      j -= 1;
      newNo -= 1;
    }
  }
  while (i > 0) {
    ops.push({ type: "-", line: beforeLines[i - 1], oldLine: oldNo, newLine: null });
    i -= 1;
    oldNo -= 1;
  }
  while (j > 0) {
    ops.push({ type: "+", line: afterLines[j - 1], oldLine: null, newLine: newNo });
    j -= 1;
    newNo -= 1;
  }
  ops.reverse();

  let o = 1;
  let nn = 1;
  const seq: Op[] = ops.map((x) => {
    const out: Op = { ...x, oldLine: null, newLine: null };
    if (x.type !== "+") out.oldLine = o;
    if (x.type !== "-") out.newLine = nn;
    if (x.type !== "+") o += 1;
    if (x.type !== "-") nn += 1;
    return out;
  });

  const context = args.context ?? 3;
  const changeIdx: number[] = [];
  for (let k = 0; k < seq.length; k += 1) if (seq[k].type !== " ") changeIdx.push(k);
  if (!changeIdx.length) {
    return { truncated: false, diff: `--- a/${args.path}\n+++ b/${args.path}\n@@\n(无差异)\n`, stats: { added: 0, removed: 0 } };
  }

  const hunks: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos < changeIdx.length) {
    const first = changeIdx[pos];
    let start = Math.max(0, first - context);
    let end = Math.min(seq.length, first + context + 1);
    while (true) {
      pos += 1;
      const next = changeIdx[pos];
      if (next === undefined) break;
      if (next <= end + context) {
        end = Math.min(seq.length, next + context + 1);
        continue;
      }
      break;
    }
    hunks.push({ start, end });
  }

  let added = 0;
  let removed = 0;
  const maxHunkLines = args.maxHunkLines ?? 320;
  let outLines: string[] = [`--- a/${args.path}`, `+++ b/${args.path}`];
  let emitted = 0;
  for (const h of hunks) {
    const slice = seq.slice(h.start, h.end);
    const oldStart = slice.find((x) => x.oldLine !== null)?.oldLine ?? 1;
    const newStart = slice.find((x) => x.newLine !== null)?.newLine ?? 1;
    const oldCount = slice.filter((x) => x.type !== "+").length;
    const newCount = slice.filter((x) => x.type !== "-").length;
    outLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const x of slice) {
      if (emitted >= maxHunkLines) {
        outLines.push("...(diff 已截断)");
        return { truncated: true, diff: outLines.join("\n") + "\n", stats: { added, removed } };
      }
      if (x.type === "+") added += 1;
      if (x.type === "-") removed += 1;
      outLines.push(`${x.type}${x.line}`);
      emitted += 1;
    }
  }
  return { truncated: false, diff: outLines.join("\n") + "\n", stats: { added, removed } };
}

function oneLine(s: unknown, max = 48) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : t.slice(0, max) + "…";
}

export function humanizeToolActivity(name: string, args: Record<string, unknown>) {
  const tool = String(name ?? "");
  if (!tool) return "正在执行工具…";
  if (tool === "time.now") return "正在读取时间…";
  if (tool === "run.setTodoList" || tool.startsWith("run.todo.")) return "正在更新 To-dos…";
  if (tool === "run.done") return "正在结束本次运行…";
  if (tool === "kb.search") return "正在检索知识库…";
  if (tool === "doc.read") return "正在读取文件…";
  if (tool === "doc.write" || tool === "doc.previewDiff" || tool === "doc.splitToDir") return "正在写入文件…";
  if (tool === "web.search") {
    const q = oneLine((args as any)?.query ?? (args as any)?.q ?? (args as any)?.keyword, 36);
    return q ? `正在全网搜索：${q}` : "正在全网搜索…";
  }
  if (tool === "web.fetch") {
    const url = String((args as any)?.url ?? "");
    if (!url) return "正在抓取网页正文…";
    try {
      const u = new URL(url);
      return `正在抓取网页正文：${u.hostname}`;
    } catch {
      return "正在抓取网页正文…";
    }
  }
  if (tool === "lint.style") return "正在做风格校验…";
  if (tool === "lint.copy") return "正在做抄袭/复述风险检查…";
  if (tool === "agent.delegate") {
    const agentId = String((args as any)?.agentId ?? "");
    return agentId ? `正在委托给：${agentId}…` : "正在委托子 Agent…";
  }
  if (tool === "agent.config.create") return "正在创建团队成员…";
  if (tool === "agent.config.list") return "正在查看团队配置…";
  if (tool === "agent.config.update") return "正在更新团队成员…";
  if (tool === "agent.config.remove") return "正在移除团队成员…";
  return `正在执行：${tool}…`;
}

export type Ref = { kind: "file" | "dir"; path: string };

export function parseRefsFromPrompt(prompt: string): Ref[] {
  const out: Ref[] = [];
  const re = /@\{([^}]+)\}/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(prompt)) !== null) {
    const raw = String(m[1] ?? "").trim();
    if (!raw) continue;
    let p = raw.replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (!p) continue;
    let kind: Ref["kind"] = p.endsWith("/") ? "dir" : "file";
    if (kind === "dir") p = p.replace(/\/+$/g, "");
    out.push({ kind, path: p });
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function buildReferencesTextFromRefs(refs: Ref[]) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return "";
  const proj = useProjectStore.getState();

  const maxTotal = 60_000;
  const maxPerFile = 8_000;
  const maxFilesInDir = 12;
  let used = 0;

  const pushLimited = (s: string, parts: string[]) => {
    if (!s) return;
    if (used >= maxTotal) return;
    const left = maxTotal - used;
    const chunk = s.length > left ? s.slice(0, left) + "\n…(references truncated)\n" : s;
    parts.push(chunk);
    used += chunk.length;
  };

  const parts: string[] = [];
  pushLimited(
    `REFERENCES（来自用户输入中的 @{} 引用；已提供正文，无需再调用 doc.read）：\n`,
    parts,
  );

  for (const ref of list) {
    if (used >= maxTotal) break;
    const path = ref.path;
    if (!path) continue;

    const looksDir =
      ref.kind === "dir" ||
      (Array.isArray((proj as any).dirs) && (proj as any).dirs.includes(path)) ||
      proj.files.some((f) => f.path.startsWith(`${path}/`));

    if (looksDir) {
      const children = proj.files
        .map((f) => f.path)
        .filter((p) => p.startsWith(`${path}/`))
        .sort((a, b) => a.localeCompare(b));
      const listed = children.slice(0, maxFilesInDir);
      pushLimited(`\n- DIR: ${path}/ (files=${children.length}${children.length > maxFilesInDir ? `, showing=${maxFilesInDir}` : ""})\n`, parts);
      if (!listed.length) {
        pushLimited(`  (no text files)\n`, parts);
        continue;
      }
      for (const fp of listed) {
        if (used >= maxTotal) break;
        let content = "";
        try {
          content = await proj.ensureLoaded(fp);
        } catch {
          content = proj.getFileByPath(fp)?.content ?? "";
        }
        const truncated = content.length > maxPerFile;
        const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
        pushLimited(`  - FILE: ${fp} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
        pushLimited(`-----BEGIN ${fp}-----\n${body}\n-----END ${fp}-----\n`, parts);
      }
      continue;
    }

    const file = proj.getFileByPath(path);
    if (!file) {
      pushLimited(`\n- FILE: ${path} (not found)\n`, parts);
      continue;
    }
    let content = "";
    try {
      content = await proj.ensureLoaded(path);
    } catch {
      content = file.content ?? "";
    }
    const truncated = content.length > maxPerFile;
    const body = truncated ? content.slice(0, maxPerFile) + "\n…(file truncated)\n" : content;
    pushLimited(`\n- FILE: ${path} (chars=${content.length}${truncated ? ", truncated" : ""})\n`, parts);
    pushLimited(`-----BEGIN ${path}-----\n${body}\n-----END ${path}-----\n`, parts);
  }

  return parts.join("");
}

function rankStabilityForSelectorV1(stability: string): number {
  const s = String(stability ?? "").trim().toLowerCase();
  return s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
}

export function buildTopicTextForSelectorV1(args: { userPrompt: string; mainDoc: any }): string {
  const g = String(args?.mainDoc?.goal ?? "").trim();
  const p = String(args?.userPrompt ?? "").trim();
  return [g, p].filter(Boolean).join("\n");
}

function extractTopicTokensV1(topicTextRaw: string): string[] {
  const text = String(topicTextRaw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const v = String(t ?? "").trim();
    if (!v) return;
    if (v.length < 2) return;
    if (v.length > 12) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };

  // English words / numbers
  {
    const words = text.match(/[a-zA-Z]{3,}/g) ?? [];
    for (const w of words.slice(0, 60)) push(w);
    const nums = text.match(/\d{2,}/g) ?? [];
    for (const n of nums.slice(0, 40)) push(n);
  }

  // Chinese char ngrams（2~4）
  {
    const segs = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    let budget = 220;
    for (const seg0 of segs) {
      if (budget <= 0) break;
      const seg = String(seg0 ?? "").trim();
      if (!seg) continue;
      // 太长的片段用 ngram 覆盖即可，不保留整段
      const maxLen = Math.min(seg.length, 28);
      const s = seg.slice(0, maxLen);
      for (const n of [4, 3, 2]) {
        for (let i = 0; i + n <= s.length; i += 1) {
          if (budget <= 0) break;
          push(s.slice(i, i + n));
          budget -= 1;
        }
      }
    }
  }

  return out.slice(0, 260);
}

function computeTopicFitV1(topicText: string, clusterText: string): { score: number; hits: string[] } {
  const tokens = extractTopicTokensV1(topicText);
  if (!tokens.length) return { score: 0, hits: [] };
  const hay = String(clusterText ?? "").toLowerCase();
  let score = 0;
  const hits: string[] = [];
  const seenHit = new Set<string>();
  for (const raw of tokens) {
    const t = String(raw ?? "");
    const key = t.toLowerCase();
    if (!key) continue;
    if (!hay.includes(key)) continue;
    const w = Math.min(16, key.length);
    score += w * w;
    if (!seenHit.has(key)) {
      seenHit.add(key);
      hits.push(t);
    }
  }
  return { score, hits: hits.slice(0, 8) };
}

type SelectorStageIdV1 = "opening" | "outline" | "draft" | "ending" | "polish" | "unknown";

function detectWritingStageV1(args: {
  userPrompt: string;
  todoList: any[];
}): { id: SelectorStageIdV1; label: string; by: string; evidence?: string } {
  const prompt = String(args?.userPrompt ?? "").trim();
  const todoList = Array.isArray(args?.todoList) ? args.todoList : [];
  const activeTodo = todoList.find((t: any) => {
    const s = String(t?.status ?? "").trim().toLowerCase();
    return s && s !== "done" && s !== "skipped";
  });
  const todoHint = activeTodo ? `${String(activeTodo?.text ?? "").trim()}\n${String(activeTodo?.note ?? "").trim()}`.trim() : "";
  const hay = `${prompt}\n${todoHint}`.trim();
  const by = todoHint ? "todo+prompt" : "prompt";

  const hit = (re: RegExp) => re.test(hay);
  if (hit(/润色|终稿|定稿|校对|自检|lint|polish/i)) return { id: "polish", label: "润色/终稿", by, evidence: todoHint || prompt };
  if (hit(/结尾|收尾|结论|总结|升华|CTA|call\s*to\s*action/i)) return { id: "ending", label: "收尾/结尾", by, evidence: todoHint || prompt };
  if (hit(/开头|开场|破题|钩子|hook|标题/i)) return { id: "opening", label: "开头/开场", by, evidence: todoHint || prompt };
  if (hit(/大纲|提纲|outline|结构|框架/i)) return { id: "outline", label: "大纲/结构", by, evidence: todoHint || prompt };
  if (hit(/改写|仿写|续写|扩写|写一篇|写\s*\d{2,5}\s*字/i)) return { id: "draft", label: "撰写/正文", by, evidence: todoHint || prompt };

  // 写作任务默认视为正文阶段（Selector v1：避免 unknown 导致选卡过于保守）
  return { id: "draft", label: "撰写/正文", by: "default", evidence: todoHint || prompt };
}

function topicBriefForKbQueryV1(args: { userPrompt: string; mainDoc: any }): string {
  const g = String(args?.mainDoc?.goal ?? "").trim();
  const p = String(args?.userPrompt ?? "").trim();
  const base = g || p;
  return base.replace(/\s+/g, " ").trim().slice(0, 80);
}

function stageFacetWeightsV1(
  packId: string,
  stageId: SelectorStageIdV1,
): { essential: string[]; supportive: string[]; k: number } {
  const pid = String(packId ?? "").trim() || "speech_marketing_v1";
  // 口播/营销（v1）
  if (pid === "speech_marketing_v1") {
    if (stageId === "opening")
      return {
        essential: ["opening_design", "intro", "question_design", "emotion_mobilization", "voice_rhythm", "one_liner_crafting"],
        supportive: ["reader_interaction", "scene_building", "rhetoric", "values_embedding", "narrative_perspective"],
        k: 6,
      };
    if (stageId === "outline")
      return {
        essential: ["narrative_structure", "narrative_perspective", "logic_framework", "structure_patterns"],
        supportive: ["topic_selection", "persuasion", "reader_interaction", "values_embedding"],
        k: 5,
      };
    if (stageId === "ending")
      return {
        essential: ["values_embedding", "resonance", "structure_patterns"],
        supportive: ["one_liner_crafting", "reader_interaction", "emotion_mobilization", "narrative_perspective"],
        k: 5,
      };
    if (stageId === "polish")
      return {
        essential: ["language_style", "voice_rhythm", "special_markers", "ai_clone_strategy"],
        supportive: ["one_liner_crafting", "rhetoric"],
        k: 4,
      };
    // draft / unknown
    return {
      essential: ["logic_framework", "narrative_structure", "narrative_perspective", "persuasion", "voice_rhythm", "emotion_mobilization", "values_embedding"],
      supportive: ["reader_interaction", "scene_building", "one_liner_crafting", "rhetoric"],
      k: 8,
    };
  }

  // 小说（v1，占位）
  if (pid === "novel_v1") {
    if (stageId === "opening") return { essential: ["viewpoint_voice", "pacing_tension", "world_setting"], supportive: ["foreshadowing_payoff"], k: 4 };
    if (stageId === "outline") return { essential: ["plot_structure", "character_arc"], supportive: ["world_setting"], k: 4 };
    if (stageId === "ending") return { essential: ["foreshadowing_payoff", "pacing_tension"], supportive: ["character_arc"], k: 4 };
    if (stageId === "polish") return { essential: ["viewpoint_voice", "dialogue"], supportive: ["pacing_tension"], k: 4 };
    return { essential: ["plot_structure", "character_arc", "scene_goal_conflict"], supportive: ["dialogue", "pacing_tension"], k: 5 };
  }

  return { essential: [], supportive: [], k: 6 };
}

type SelectedFacetV1 = {
  facetId: string;
  label: string;
  score: number;
  topicFit: number;
  stageFit: number;
  basePlan: boolean;
  why: string;
  kbQueries: string[];
  topicHits?: string[];
};

function pickFacetsSelectorV1(args: {
  facetPackId: string;
  cluster: any;
  topicText: string;
  topicBrief: string;
  stageId: SelectorStageIdV1;
}): { selected: SelectedFacetV1[]; trace: any } {
  const pack = getFacetPack(args.facetPackId);
  const packFacetIds = pack.facets.map((f) => f.id);
  const order = new Map(pack.facets.map((f, i) => [f.id, i]));

  const planItems = Array.isArray(args.cluster?.facetPlan) ? (args.cluster.facetPlan as any[]) : [];
  const planById = new Map<string, { why: string; kbQueries: string[] }>(
    planItems
      .map((x) => {
        const facetId = String(x?.facetId ?? "").trim();
        const why = String(x?.why ?? "").trim();
        const kbQueries = Array.isArray(x?.kbQueries) ? x.kbQueries.map((q: any) => String(q ?? "").trim()).filter(Boolean) : [];
        return [facetId, { why, kbQueries }] as const;
      })
      .filter(([facetId]) => Boolean(facetId)),
  );

  const candidateIds = Array.from(
    new Set([
      ...packFacetIds,
      ...planItems.map((x: any) => String(x?.facetId ?? "").trim()).filter(Boolean), // 兜底：允许 pack 外的 facetId
    ]),
  );

  const stage = stageFacetWeightsV1(pack.id, args.stageId);
  const essential = new Set(stage.essential);
  const supportive = new Set(stage.supportive);

  const scored: Array<{
    facetId: string;
    label: string;
    basePlan: boolean;
    stageFit: number;
    rawTopicScore: number;
    topicHits: string[];
    planWhy: string;
    planKbQueries: string[];
  }> = [];

  for (const facetId of candidateIds) {
    const label = facetLabel(facetId);
    const plan = planById.get(facetId);
    const planWhy = plan?.why ?? "";
    const planKbQueries = plan?.kbQueries ?? [];
    const basePlan = planById.has(facetId);
    const stageFit = essential.has(facetId) ? 1 : supportive.has(facetId) ? 0.6 : 0;
    const facetText = [label, facetId, planWhy, planKbQueries.join(" ")].filter(Boolean).join("\n");
    const tf = computeTopicFitV1(args.topicText, facetText);
    scored.push({
      facetId,
      label,
      basePlan,
      stageFit,
      rawTopicScore: tf.score,
      topicHits: tf.hits,
      planWhy,
      planKbQueries,
    });
  }

  const maxRaw = scored.reduce((m, x) => Math.max(m, x.rawTopicScore), 0);
  const withFinal = scored.map((x) => {
    const topicFit = maxRaw > 0 ? x.rawTopicScore / maxRaw : 0;
    const basePlanScore = x.basePlan ? 1 : 0;
    const score = 0.55 * topicFit + 0.30 * x.stageFit + 0.15 * basePlanScore;
    return { ...x, topicFit, score };
  });

  // 先强制纳入 essential，再按总分补齐
  const k = Math.max(4, Math.min(8, stage.k || 6));
  const selectedIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const k = String(id ?? "").trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    selectedIds.push(k);
  };

  // essential（按 facet pack 顺序）
  for (const fid of stage.essential) {
    if (selectedIds.length >= k) break;
    if (!candidateIds.includes(fid)) continue;
    push(fid);
  }

  const sorted = withFinal
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.basePlan) !== Number(a.basePlan)) return Number(b.basePlan) - Number(a.basePlan);
      if (b.stageFit !== a.stageFit) return b.stageFit - a.stageFit;
      const oa = order.get(a.facetId) ?? 999;
      const ob = order.get(b.facetId) ?? 999;
      if (oa !== ob) return oa - ob;
      return String(a.facetId).localeCompare(String(b.facetId));
    });

  for (const it of sorted) {
    if (selectedIds.length >= k) break;
    push(it.facetId);
  }

  const selected = selectedIds
    .map((fid) => withFinal.find((x) => x.facetId === fid))
    .filter(Boolean)
    .map((x: any) => {
      const q0 = String(args.topicBrief ?? "").trim();
      const base = q0 ? `${q0} ${x.label}`.trim() : x.label;
      const hint = String((x.planKbQueries?.[0] ?? (Array.isArray(args.cluster?.queries) ? args.cluster.queries[0] : "") ?? "") as any).trim();
      const q1 = base.slice(0, 96);
      const q2 = hint ? `${base} ${hint}`.trim().slice(0, 110) : "";
      const kbQueries = Array.from(new Set([q1, q2].map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, 2);
      const whyParts = [
        x.planWhy ? `plan:${x.planWhy}` : "",
        x.stageFit > 0.8 ? "stage:必备" : x.stageFit > 0.3 ? "stage:辅助" : "",
        x.topicHits?.length ? `topic:${x.topicHits.slice(0, 3).join("、")}` : "",
      ].filter(Boolean);
      return {
        facetId: x.facetId,
        label: x.label,
        score: Number(x.score.toFixed(4)),
        topicFit: Number(x.topicFit.toFixed(4)),
        stageFit: Number(x.stageFit.toFixed(2)),
        basePlan: Boolean(x.basePlan),
        why: whyParts.join("；").slice(0, 220),
        kbQueries,
        topicHits: Array.isArray(x.topicHits) ? x.topicHits.slice(0, 5) : undefined,
      } as SelectedFacetV1;
    });

  return {
    selected,
    trace: {
      method: "selector_v1_facets",
      stage: args.stageId,
      k,
      maxRawTopic: maxRaw,
      top: sorted.slice(0, 6).map((x) => ({ facetId: x.facetId, score: Number(x.score.toFixed(4)) })),
    },
  };
}

export function pickClusterSelectorV1(args: {
  clusters: any[];
  defaultClusterId?: string;
  topicText?: string;
}): { selectedId: string; trace: any; topicHits: string[] } {
  const clusters = Array.isArray(args.clusters) ? args.clusters : [];
  const byId = new Map(clusters.map((c: any) => [String(c?.id ?? "").trim(), c]));
  const d = String(args.defaultClusterId ?? "").trim();
  const hasDefault = Boolean(d && byId.get(d));
  const topicText = String(args.topicText ?? "").trim();

  // 1) anchors 优先（更像原文）
  let maxAnchors = 0;
  for (const c of clusters) {
    const n = Array.isArray(c?.anchors) ? c.anchors.length : 0;
    if (n > maxAnchors) maxAnchors = n;
  }
  if (maxAnchors > 0) {
    const picked = clusters
      .slice()
      .sort((a: any, b: any) => {
        const na = Array.isArray(a?.anchors) ? a.anchors.length : 0;
        const nb = Array.isArray(b?.anchors) ? b.anchors.length : 0;
        if (nb !== na) return nb - na;
        const sa = rankStabilityForSelectorV1(String(a?.stability ?? ""));
        const sb = rankStabilityForSelectorV1(String(b?.stability ?? ""));
        if (sb !== sa) return sb - sa;
        const ca = Number(a?.docCoverageRate ?? 0) || 0;
        const cb = Number(b?.docCoverageRate ?? 0) || 0;
        if (cb !== ca) return cb - ca;
        const sega = Number(a?.segmentCount ?? 0) || 0;
        const segb = Number(b?.segmentCount ?? 0) || 0;
        return segb - sega;
      })[0];
    const selectedId = String(picked?.id ?? "").trim() || (hasDefault ? d : String(clusters?.[0]?.id ?? "").trim());
    return {
      selectedId,
      topicHits: [],
      trace: { method: "selector_v1", pickedBy: "anchors", maxAnchors, defaultClusterId: hasDefault ? d : null },
    };
  }

  // 2) topicFit（同库混题材时优先按话题匹配）
  const topicScores: Array<{ id: string; score: number; hits: string[] }> = [];
  for (const c of clusters) {
    const id = String(c?.id ?? "").trim();
    if (!id) continue;
    const quotes = Array.isArray(c?.evidence) ? c.evidence.map((e: any) => String(e?.quote ?? "").trim()).filter(Boolean) : [];
    const queries = Array.isArray(c?.queries) ? c.queries.map((q: any) => String(q ?? "").trim()).filter(Boolean) : [];
    const label = String(c?.label ?? "").trim();
    const clusterText = [label, ...queries.slice(0, 8), ...quotes.slice(0, 5)].filter(Boolean).join("\n");
    const fit = topicText ? computeTopicFitV1(topicText, clusterText) : { score: 0, hits: [] };
    topicScores.push({ id, score: fit.score, hits: fit.hits });
  }
  const maxTopic = topicScores.reduce((m, x) => Math.max(m, x.score), 0);
  if (maxTopic > 0) {
    const best = topicScores
      .slice()
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ca = byId.get(a.id);
        const cb = byId.get(b.id);
        const sa = rankStabilityForSelectorV1(String(ca?.stability ?? ""));
        const sb = rankStabilityForSelectorV1(String(cb?.stability ?? ""));
        if (sb !== sa) return sb - sa;
        const cova = Number(ca?.docCoverageRate ?? 0) || 0;
        const covb = Number(cb?.docCoverageRate ?? 0) || 0;
        if (covb !== cova) return covb - cova;
        const sega = Number(ca?.segmentCount ?? 0) || 0;
        const segb = Number(cb?.segmentCount ?? 0) || 0;
        return segb - sega;
      })[0];
    const selectedId = best?.id || (hasDefault ? d : String(clusters?.[0]?.id ?? "").trim());
    const hits = best?.hits ?? [];
    return {
      selectedId,
      topicHits: hits,
      trace: {
        method: "selector_v1",
        pickedBy: "topicFit",
        maxTopicScore: maxTopic,
        defaultClusterId: hasDefault ? d : null,
        top: topicScores
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((x) => ({ id: x.id, score: x.score })),
      },
    };
  }

  // 3) 无话题信号：默认写法（仅本库）优先，否则稳定性/覆盖率/段数
  if (hasDefault) {
    return { selectedId: d, topicHits: [], trace: { method: "selector_v1", pickedBy: "defaultCluster", defaultClusterId: d } };
  }
  const picked = clusters
    .slice()
    .sort((a: any, b: any) => {
      const sa = rankStabilityForSelectorV1(String(a?.stability ?? ""));
      const sb = rankStabilityForSelectorV1(String(b?.stability ?? ""));
      if (sb !== sa) return sb - sa;
      const ca = Number(a?.docCoverageRate ?? 0) || 0;
      const cb = Number(b?.docCoverageRate ?? 0) || 0;
      if (cb !== ca) return cb - ca;
      const sega = Number(a?.segmentCount ?? 0) || 0;
      const segb = Number(b?.segmentCount ?? 0) || 0;
      return segb - sega;
    })[0];
  const selectedId = String(picked?.id ?? "").trim() || String(clusters?.[0]?.id ?? "").trim() || "";
  return { selectedId, topicHits: [], trace: { method: "selector_v1", pickedBy: "stability", defaultClusterId: null } };
}

function pickFacetIdsV1(cluster: any, max = 8): string[] {
  const plan = Array.isArray(cluster?.facetPlan) ? (cluster.facetPlan as any[]) : [];
  const all = plan.map((f: any) => String(f?.facetId ?? "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    const k = String(id ?? "").trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  // 先把"常见关键卡"放前面（存在才加入）
  for (const id of ["opening_design", "narrative_structure", "narrative_perspective", "one_liner_crafting", "emotion_mobilization", "logic_framework", "voice_rhythm", "values_embedding"]) {
    if (all.includes(id)) push(id);
  }
  for (const id of all) {
    if (out.length >= max) break;
    push(id);
  }
  return out.slice(0, max);
}

type ContextManifestPriorityV1 = "p0" | "p1" | "p2" | "p3";
type ContextManifestSegmentV1 = {
  name: string;
  chars: number;
  priority: ContextManifestPriorityV1;
  trusted: boolean;
  truncated: boolean;
  source: "desktop" | "gateway";
  note?: string;
};

function renderContextManifestV1(args: { mode: Mode; segments: ContextManifestSegmentV1[] }) {
  const payload = {
    v: 1,
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    segments: args.segments,
  };
  return `CONTEXT_MANIFEST(JSON):\n${JSON.stringify(payload, null, 2)}\n\n`;
}

/** 将证据原文/anchor 降级为"句式特征描述"，防止模型照抄原文。 */
export function summarizeQuoteAsFeatureV1(quote: string): string {
  const t = String(quote ?? "").trim();
  if (!t) return "";
  const chars = t.length;
  const sentences = t.split(/[。！？\n]+/).filter((s) => s.trim());
  const avgLen = sentences.length ? Math.round(sentences.reduce((a, s) => a + s.trim().length, 0) / sentences.length) : chars;
  const features: string[] = [];
  features.push(`均句${avgLen}字`);
  if (/[？?]/.test(t)) features.push("含反问/设问");
  if (/\d+[%％万亿千百]|\d+\.\d/.test(t)) features.push("含数据论证");
  if (/比如|例如|举个例子|就像/.test(t)) features.push("含举例");
  if (/但是|然而|不过|其实|反而/.test(t)) features.push("含转折");
  if (/——/.test(t)) features.push("含破折号修辞");
  if (/……/.test(t)) features.push("含省略号");
  if (/你|我们|咱|大家/.test(t)) features.push("口语化/对话感");
  if (avgLen <= 12) features.push("短句为主");
  else if (avgLen >= 35) features.push("长句为主");
  return `[${features.join(";")}](${chars}字/${sentences.length}句)`;
}

type DialogueTurn = { user: string; assistant: string };

function buildDialogueTurnsFromSteps(steps: any[]): DialogueTurn[] {
  const all = Array.isArray(steps) ? steps : [];
  const turns: DialogueTurn[] = [];
  let curUser = "";
  let curAssistant = "";
  const flush = () => {
    const u = String(curUser ?? "").trim();
    const a = String(curAssistant ?? "").trim();
    if (u) turns.push({ user: u, assistant: a });
    curUser = "";
    curAssistant = "";
  };

  for (const st of all) {
    if (!st || typeof st !== "object") continue;
    if (st.type === "user") {
      if (curUser) flush();
      curUser = String(st.text ?? "").trim();
      curAssistant = "";
      continue;
    }
    if (st.type === "assistant") {
      if (st.hidden) continue;
      if (!curUser) continue;
      const t = String(st.text ?? "").trim();
      if (!t) continue;
      curAssistant = curAssistant ? `${curAssistant}\n${t}` : t;
    }
  }
  if (curUser) flush();
  return turns;
}

function buildRecentDialogueJsonFromTurns(turns: DialogueTurn[], maxTurns: number) {
  const t = Array.isArray(turns) ? turns : [];
  const n = Number.isFinite(Number(maxTurns)) ? Math.max(0, Math.floor(Number(maxTurns))) : 0;
  if (n <= 0) return "";
  const recentTurns = t.slice(-n);
  const clip = (s: string, max: number) => {
    const v = String(s ?? "").trim();
    if (!v) return "";
    return v.length > max ? v.slice(0, max).trimEnd() + "…" : v;
  };
  const msgs: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const one of recentTurns) {
    const u = clip(one.user, 800);
    const a = clip(one.assistant, 800);
    if (u) msgs.push({ role: "user", text: u });
    if (a) msgs.push({ role: "assistant", text: a });
  }
  return msgs.length ? `RECENT_DIALOGUE(JSON):\n${JSON.stringify(msgs, null, 2)}\n\n` : "";
}

export async function buildContextPack(extra?: { referencesText?: string; userPrompt?: string; kbMentionIds?: string[] }) {
  const mainDoc = useRunStore.getState().mainDoc;
  const todoList = useRunStore.getState().todoList;
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const kbLibraries = useKbStore.getState().libraries ?? [];
  const userPrompt = String(extra?.userPrompt ?? "");
  // 仅使用本次消息 @提及的库（绑定机制已废弃）
  const kbMentionIds = Array.isArray(extra?.kbMentionIds) ? extra!.kbMentionIds : [];
  const kbSelectedIds = Array.from(new Set(kbMentionIds));
  // PROJECT_STATE：只提供最小信息（避免"光标文件/全量文件列表"对模型产生过强暗示）
  const state = {
    fileCount: proj.files.length,
    // 说明：activePath/openPaths 仍存在于 Desktop 内部（工具默认路径等会用到），但不默认注入给模型
  };

  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    // 无选区时不要携带 path/range（避免模型把"光标文件"当作默认上下文）
    if (!fullText.length) return { ok: true, hasSelection: false, reason: "EMPTY_SELECTION" as const };
    return {
      ok: true,
      hasSelection: true,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();

  // RUN_TODO：注入给模型的 todo 要做裁剪（避免上下文膨胀）；UI 仍保留全量 todoList。
  const runTodoForPack = (() => {
    const normalizeOne = (t: any) => {
      const id = String(t?.id ?? "").trim();
      const text0 = String(t?.text ?? "").replace(/\s+/g, " ").trim();
      const status0 = String(t?.status ?? "").trim().toLowerCase();
      const status =
        status0 === "done" || status0 === "todo" || status0 === "in_progress" || status0 === "blocked" || status0 === "skipped"
          ? (status0 as any)
          : ("todo" as const);
      const note0 = t?.note === undefined ? undefined : String(t.note ?? "").replace(/\s+/g, " ").trim();
      if (!id || !text0) return null;
      const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() + "…" : s);
      return {
        id,
        text: clip(text0, 120),
        status,
        ...(note0 ? { note: clip(note0, 220) } : {}),
      };
    };

    const norm = (Array.isArray(todoList) ? todoList : []).map(normalizeOne).filter(Boolean) as any[];
    const open = norm.filter((t) => t.status === "todo" || t.status === "in_progress" || t.status === "blocked").slice(0, 24);
    const doneAll = norm.filter((t) => t.status === "done");
    const done = doneAll.slice(Math.max(0, doneAll.length - 6));

    // 兜底：如果 open 为空但存在其它状态（例如全 done），至少带一点最近 done
    const merged = [...open, ...done];
    return merged.slice(0, 32);
  })();

  // 最近对话片段（只注入少量：最后 3 个完整回合；关键决策仍应写入 Main Doc/Run Todo）
  const recentDialogue = (() => {
    const turnsAll = buildDialogueTurnsFromSteps(useRunStore.getState().steps ?? []);
    const completeTurns = turnsAll.filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());
    return buildRecentDialogueJsonFromTurns(completeTurns, 3);
  })();

  const dialogueSummary = (() => {
    const mode = useRunStore.getState().mode as Mode;
    const byMode: any = (useRunStore.getState() as any).dialogueSummaryByMode ?? {};
    const s = String(byMode?.[mode] ?? "").trim();
    return s ? `DIALOGUE_SUMMARY(Markdown):\n${s}\n\n` : "";
  })();

  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const kbSelected = (() => {
    const ids = kbSelectedIds;
    const map = new Map(
      kbLibraries.map((l: any) => [
        l.id,
        {
          id: l.id,
          name: l.name,
          purpose: l.purpose ?? "material",
          facetPackId: l.facetPackId,
          docCount: l.docCount,
          updatedAt: l.updatedAt,
        },
      ]),
    );
    return ids.map((id: string) => map.get(id) ?? { id, name: id });
  })();

  // recentDialogue（仅用于本地意图/skills 的"续跑判定"，不注入模型 messages）
  const recentDialogueForIntent = (() => {
    const turnsAll = buildDialogueTurnsFromSteps(useRunStore.getState().steps ?? []);
    const completeTurns = turnsAll.filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());
    const tail = completeTurns.slice(-3);
    const out: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const t of tail) {
      const u = String((t as any).user ?? "").trim();
      const a = String((t as any).assistant ?? "").trim();
      if (u) out.push({ role: "user", text: u });
      if (a) out.push({ role: "assistant", text: a });
    }
    return out.length ? out : undefined;
  })();

  // 合并内置 + 外部扩展包的 skill manifests
  const allManifests = [...listRegisteredSkills(), ...useSkillStore.getState().externalSkills];

  const activeSkillsRaw = activateSkills({
    mode: useRunStore.getState().mode as any,
    userPrompt,
    mainDocRunIntent: (mainDoc as any)?.runIntent,
    kbSelected: kbSelected as any,
    manifests: allManifests as any,
    // 关键：与 Gateway 对齐（detectRunIntent 会参考 RUN_TODO 做"续跑/短句"意图继承）
    intent: detectRunIntent({
      mode: useRunStore.getState().mode as any,
      userPrompt,
      mainDocRunIntent: (mainDoc as any)?.runIntent,
      mainDoc: mainDoc as any,
      runTodo: runTodoForPack,
      recentDialogue: recentDialogueForIntent as any,
    }),
  });
  const idSetRaw = new Set((activeSkillsRaw ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean));

  const activeSkills = activeSkillsRaw;

  const skillsText = `ACTIVE_SKILLS(JSON):\n${JSON.stringify(activeSkills, null, 2)}\n\n`;

  const activeSkillIdSet = new Set((activeSkills ?? []).map((s: any) => String(s?.id ?? "").trim()).filter(Boolean));
  const styleSkillActive = activeSkillIdSet.has("style_imitate");

  const kbHint = `提示：如需引用知识库内容，请调用工具 kb.search（默认只在已关联库中检索）。\n\n`;
  const kbText = `KB_SELECTED_LIBRARIES(JSON):\n${JSON.stringify(kbSelected, null, 2)}\n\n` + kbHint;

  // 关键：风格 playbook/写法候选等"强引导"上下文，只在写作闭环真正激活时注入。
  const allowInjectStyleContext = styleSkillActive;

  // v0.1：目录先挑（只给规则不给原文）。默认不再把 KB_LIBRARY_PLAYBOOK 全文注入模型上下文（容易导致贴原文）。
  // 可通过环境变量临时回滚：DESKTOP_STYLE_INJECT_PLAYBOOK=1
  const injectPlaybook = String((import.meta as any)?.env?.DESKTOP_STYLE_INJECT_PLAYBOOK ?? "").trim() === "1";
  const playbookSection = await (async () => {
    if (!allowInjectStyleContext) return "";
    if (!injectPlaybook) return "";
    const ids = kbSelectedIds;
    const playbookText = await useKbStore.getState().getPlaybookTextForLibraries(ids).catch(() => "");
    if (!playbookText) return "";
    return (
      `KB_LIBRARY_PLAYBOOK(Markdown):\n${playbookText}\n\n` +
      `提示：上面已注入库级"仿写手册"（风险：可能导致贴原文）。默认已关闭；仅用于回滚排查。\n\n`
    );
  })();

  const styleClustersSection = await (async () => {
    // M3：从最新声音指纹快照提取"写法候选（子簇）"，用于写作前选定写法并写入 Main Doc
    if (!allowInjectStyleContext) return "";
    const styleLibs = kbSelected.filter((l: any) => String(l?.purpose ?? "").trim() === "style").slice(0, 4);
    if (!styleLibs.length) return "";
    const topicText = buildTopicTextForSelectorV1({ userPrompt, mainDoc });

    const payload: any[] = [];
    for (const lib of styleLibs) {
      const libId = String(lib?.id ?? "").trim();
      if (!libId) continue;
      const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
      const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
      const clustersRaw = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
      const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
      const defaultClusterId = cfg?.ok ? (cfg as any).defaultClusterId : undefined;
      const recommendedClusterId = clustersRaw.length ? pickClusterSelectorV1({ clusters: clustersRaw, defaultClusterId, topicText }).selectedId : "";

      const clusters = clustersRaw
        .slice(0, 6)
        .map((c: any) => ({
          id: String(c?.id ?? "").trim(),
          label: String(c?.label ?? "").trim(),
          stability: String(c?.stability ?? "").trim(),
          segmentCount: Number(c?.segmentCount ?? 0) || 0,
          docCoverageCount: Number(c?.docCoverageCount ?? 0) || 0,
          docCoverageRate: Number(c?.docCoverageRate ?? 0) || 0,
          anchorsCount: Array.isArray(c?.anchors) ? c.anchors.length : 0,
          softRanges: {
            avgSentenceLen: (c?.softRanges as any)?.avgSentenceLen,
            questionRatePer100Sentences: (c?.softRanges as any)?.questionRatePer100Sentences,
            digitPer1kChars: (c?.softRanges as any)?.digitPer1kChars,
          },
          // v2: 不注入原文 quote（防抄），改为注入句式特征描述
          evidenceFeatures: Array.isArray(c?.evidence)
            ? c.evidence.slice(0, 3).map((e: any) => summarizeQuoteAsFeatureV1(String(e?.quote ?? ""))).filter(Boolean)
            : [],
          facetIds: Array.isArray(c?.facetPlan) ? c.facetPlan.map((f: any) => String(f?.facetId ?? "").trim()).filter(Boolean).slice(0, 8) : [],
        }))
        .filter((c: any) => c.id);

      payload.push({
        id: libId,
        name: String(lib?.name ?? libId),
        defaultClusterId: defaultClusterId ? String(defaultClusterId) : undefined,
        recommendedClusterId: recommendedClusterId || undefined,
        clusters,
      });
    }
    if (!payload.length) return "";
    return (
      `KB_STYLE_CLUSTERS(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` +
      `提示：这是"写法候选（子簇）"摘要。系统可能已默认选定推荐写法继续写作；你也可随时改口切换（回复 clusterId 或 "写法A/写法B/写法C"）。\n\n`
    );
  })();

  let styleSelectorPayload: any = null;
  let styleSelectorSelectedFacets: SelectedFacetV1[] = [];
  let styleSelectorSelectedFacetIds: string[] = [];
  const STYLE_PLAN_TOPK_V1 = { must: 6, should: 6, may: 4 };

  const sanitizeRuleTextV1 = (md: string) => {
    // 去掉明显"证据段/原文示例"形态，保留规则/套路/清单类文本
    const raw = String(md ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = raw.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      // 大段引用块：高风险（容易被直接复制）
      if (t.startsWith(">")) continue;
      // 含长引号句：高风险（像原文）
      if ((t.includes("\u201c") && t.includes("\u201d") && t.length >= 24) || (t.includes("\"") && t.length >= 28)) continue;
      // v2: 连续长自然语句（>=40字，不以列表/标题标记开头）极可能是原文段落
      if (!/^[-*#\d]/.test(t) && t.length >= 40 && !/[:：=｜|]/.test(t)) continue;
      out.push(line);
    }
    return out.join("\n").trim();
  };

  const extractFacetOptionsV1 = (args: { facetId: string; content: string }) => {
    const max = 5;
    const src = sanitizeRuleTextV1(args.content);
    const lines = src.split("\n").map((x) => x.trim());
    const cand: string[] = [];
    let inTrick = false;
    for (const l of lines) {
      if (!l) continue;
      // 粗粒度：遇到 "套路/模板/清单" 开始收集 bullet/编号项
      if (/^#{2,6}\s*(套路|模板|检查清单|写法|步骤|做法)/.test(l) || /^(套路|模板|检查清单|写法|步骤|做法)[:：]/.test(l)) {
        inTrick = true;
        continue;
      }
      if (/^#{2,6}\s+/.test(l) && inTrick) {
        // 新小节：停
        inTrick = false;
      }
      if (!inTrick) continue;
      const m1 = l.match(/^[-*]\s+(.+)$/);
      const m2 = l.match(/^\d+\.\s+(.+)$/);
      const item = (m1?.[1] ?? m2?.[1] ?? "").trim();
      if (!item) continue;
      if (item.length < 6) continue;
      // 脱敏：去掉引号段落
      if ((item.includes("\u201c") && item.includes("\u201d")) || item.includes("【证据")) continue;
      cand.push(item.replace(/\s+/g, " ").trim());
      if (cand.length >= 18) break;
    }
    const uniq: string[] = [];
    for (const c of cand) if (!uniq.includes(c)) uniq.push(c);
    const picked = uniq.slice(0, max);
    // 兜底：如果没抓到套路段，退化为从任意 bullet 抓 3 条
    if (!picked.length) {
      const anyBullets: string[] = [];
      for (const l of lines) {
        const m = l.match(/^[-*]\s+(.+)$/);
        const item = (m?.[1] ?? "").trim();
        if (!item || item.length < 8) continue;
        if ((item.includes("\u201c") && item.includes("\u201d")) || item.includes("【证据")) continue;
        anyBullets.push(item.replace(/\s+/g, " ").trim());
        if (anyBullets.length >= 8) break;
      }
      const u2: string[] = [];
      for (const c of anyBullets) if (!u2.includes(c)) u2.push(c);
      picked.push(...u2.slice(0, max));
    }
    return picked.map((label, idx) => ({
      optionId: `${args.facetId}:o${idx + 1}`,
      label: label.length > 26 ? label.slice(0, 26) + "…" : label,
      signals: [] as string[],
      do: [label],
      dont: ["不要引用原文句子/长 quote；只复刻规则与结构。"],
    }));
  };

  const styleCatalogSection = await (async () => {
    // v0.1：注入目录（21维度+每维度3-5子套路），让模型先挑，再写入 mainDoc.stylePlanV1
    if (!allowInjectStyleContext) return "";
    const styleLibs = kbSelected.filter((l: any) => String(l?.purpose ?? "").trim() === "style").slice(0, 1);
    if (!styleLibs.length) return "";
    const lib = styleLibs[0];
    const libId = String(lib?.id ?? "").trim();
    if (!libId) return "";
    const facetPackId = String((lib as any)?.facetPackId ?? "speech_marketing_v1").trim() || "speech_marketing_v1";
    const pack = getFacetPack(facetPackId);
    const facetIdsAll = pack.facets.map((f) => f.id);
    const ret = await useKbStore
      .getState()
      .getPlaybookFacetCardsForLibrary({ libraryId: libId, facetIds: facetIdsAll, maxCharsPerCard: 1200, maxTotalChars: 28_000 })
      .catch(() => ({ ok: false, cards: [] } as any));
    const cards = ret?.ok && Array.isArray(ret.cards) ? ret.cards : [];
    const cardByFacet = new Map<string, any>();
    for (const c of cards) {
      const fid = String((c as any)?.facetId ?? "").trim();
      if (!fid) continue;
      if (!cardByFacet.has(fid)) cardByFacet.set(fid, c);
    }
    const facets = pack.facets.map((f) => {
      const card = cardByFacet.get(f.id);
      const content = card ? String(card.content ?? "") : "";
      const options = content ? extractFacetOptionsV1({ facetId: f.id, content }) : [];
      return { facetId: f.id, label: f.label, options };
    });
    const payload = {
      v: 1,
      libraryId: libId,
      libraryName: String(lib?.name ?? libId),
      facetPackId,
      topK: STYLE_PLAN_TOPK_V1,
      facets,
    };
    return (
      `STYLE_CATALOG(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` +
      `提示：这是"仿写工业化目录"（只给规则不给原文）。你必须先基于此目录选择 MUST/SHOULD/MAY 并写入 mainDoc.stylePlanV1（run.mainDoc.update），再进入后续写作闭环。\n\n`
    );
  })();
  const styleSelectorSection = await (async () => {
    // Selector v1：为"自动选簇/选卡"提供结构化输出，保证换生成模型也稳定可用
    if (!allowInjectStyleContext) return "";
    const styleSkillActive = Array.isArray(activeSkills) && activeSkills.some((s: any) => String(s?.id ?? "") === "style_imitate");
    if (!styleSkillActive) return "";
    const styleLibs = kbSelected.filter((l: any) => String(l?.purpose ?? "").trim() === "style").slice(0, 1);
    if (!styleLibs.length) return "";
    const lib = styleLibs[0];
    const libId = String(lib?.id ?? "").trim();
    if (!libId) return "";

    const fpRet = await useKbStore.getState().getLatestLibraryFingerprint(libId).catch(() => ({ ok: false } as any));
    const snapshot = fpRet?.ok ? (fpRet as any).snapshot : null;
    const clustersRaw = Array.isArray(snapshot?.clustersV1) ? snapshot.clustersV1 : [];
    if (!clustersRaw.length) return "";

    const cfg = await useKbStore.getState().getLibraryStyleConfig(libId).catch(() => ({ ok: false, anchors: [] } as any));
    const defaultClusterId = cfg?.ok ? String((cfg as any).defaultClusterId ?? "").trim() : "";

    const topicText = buildTopicTextForSelectorV1({ userPrompt, mainDoc });
    const topicBrief = topicBriefForKbQueryV1({ userPrompt, mainDoc });
    const autoPick = pickClusterSelectorV1({ clusters: clustersRaw, defaultClusterId, topicText });

    const existing: any = (mainDoc as any)?.styleContractV1 ?? null;
    const selectedByMainDoc =
      existing &&
      String(existing?.libraryId ?? "").trim() === libId &&
      String(existing?.selectedCluster?.id ?? "").trim().length > 0
        ? String(existing.selectedCluster.id).trim()
        : "";

    const selectedClusterId = selectedByMainDoc || String(autoPick.selectedId ?? "").trim();
    const byId = new Map(clustersRaw.map((c: any) => [String(c?.id ?? "").trim(), c]));
    const selected = selectedClusterId ? (byId.get(selectedClusterId) as any) : null;
    const stage = detectWritingStageV1({ userPrompt, todoList });
    const facetPackId = String((lib as any)?.facetPackId ?? "speech_marketing_v1").trim() || "speech_marketing_v1";
    const facetPick = selected
      ? pickFacetsSelectorV1({
          facetPackId,
          cluster: selected,
          topicText,
          topicBrief,
          stageId: stage.id,
        })
      : { selected: [] as SelectedFacetV1[], trace: { method: "selector_v1_facets", stage: stage.id, k: 0, maxRawTopic: 0 } };
    const selectedFacets = facetPick.selected;
    const selectedFacetIds = selectedFacets.map((x) => x.facetId).filter(Boolean);

    const why: string[] = [];
    if (selectedByMainDoc) why.push("已按 Main Doc 锁定写法（用户可改口覆盖）。");
    const anchorsCount = selected && Array.isArray(selected?.anchors) ? selected.anchors.length : 0;
    if (anchorsCount > 0) why.push(`本簇已采纳 anchors：${anchorsCount} 段（优先"更像原文"）。`);
    if (autoPick.topicHits?.length) why.push(`话题命中关键词：${autoPick.topicHits.slice(0, 4).join("、")}`);
    why.push(`写作阶段：${stage.label}（${stage.by}）`);
    if (selectedFacetIds.length) why.push(`本次维度子集：${selectedFacetIds.length} 张（TopK，选出来就必须执行）`);
    const st = String(selected?.stability ?? "").trim();
    const cov = Number(selected?.docCoverageRate ?? 0) || 0;
    const seg = Number(selected?.segmentCount ?? 0) || 0;
    if (st || cov || seg) why.push(`稳定性=${st || "unknown"}；覆盖率=${Math.round(cov * 100)}%；段数=${seg}`);
    if (defaultClusterId && selectedClusterId === defaultClusterId) why.push("命中本库默认写法。");

    const facetCardsSection = await (async () => {
      if (!selectedFacetIds.length) return "";
      const ret = await useKbStore
        .getState()
        .getPlaybookFacetCardsForLibrary({ libraryId: libId, facetIds: selectedFacetIds, maxCharsPerCard: 900, maxTotalChars: 6500 })
        .catch(() => ({ ok: false, cards: [] } as any));
      const cards = ret?.ok && Array.isArray(ret.cards) ? ret.cards : [];
      const body = cards
        .map((c: any) => sanitizeRuleTextV1(String(c?.content ?? "")))
        .filter(Boolean)
        .join("\n\n");
      if (!body) return "";
      return (
        `STYLE_FACETS_SELECTED(Markdown):\n${body}\n\n` +
        `提示：以上为本次选中的"规则卡子集"（已脱敏：不含原文证据段/长 quote）。只执行这些卡；不要自行扩展到 21 张。\n\n`
      );
    })();

    const payload = {
      v: 2,
      libraryId: libId,
      libraryName: String(lib?.name ?? libId),
      facetPackId,
      selectedClusterId: selectedClusterId || null,
      selectedFacetIds,
      selectedFacets: selectedFacets.map((f) => ({
        facetId: f.facetId,
        label: f.label,
        why: f.why,
        kbQueries: f.kbQueries,
        score: f.score,
      })),
      stage,
      why: why.slice(0, 6),
      trace: {
        ...autoPick.trace,
        facets: facetPick.trace,
        selectedBy: selectedByMainDoc ? "mainDoc" : "auto",
        selectedClusterId: selectedClusterId || null,
      },
    };

    styleSelectorPayload = payload;
    styleSelectorSelectedFacets = selectedFacets.slice(0, 12);
    styleSelectorSelectedFacetIds = selectedFacetIds.slice(0, 12);
    return `STYLE_SELECTOR(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` + facetCardsSection;
  })();

  const styleDimensionsSection = (() => {
    if (!allowInjectStyleContext) return "";
    const contract: any = (mainDoc as any)?.styleContractV1 ?? null;
    const libId = String(styleSelectorPayload?.libraryId ?? contract?.libraryId ?? "").trim();
    if (!libId) return "";
    const libName = String(styleSelectorPayload?.libraryName ?? contract?.libraryName ?? libId).trim();
    const selectedClusterId = String(styleSelectorPayload?.selectedClusterId ?? contract?.selectedCluster?.id ?? "").trim();
    const facetPlan = Array.isArray(contract?.facetPlan) ? contract.facetPlan : [];
    const planFacetIds = facetPlan
      .map((f: any) => String(f?.facetId ?? "").trim())
      .filter(Boolean);
    const mustFacetIdsRaw = styleSelectorSelectedFacetIds.length ? styleSelectorSelectedFacetIds : planFacetIds;
    const uniq = (arr: string[]) => {
      const out: string[] = [];
      for (const x of arr) if (x && !out.includes(x)) out.push(x);
      return out;
    };
    const mustFacetIds = uniq(mustFacetIdsRaw).slice(0, 10);
    const mustFacets =
      styleSelectorSelectedFacets.length
        ? styleSelectorSelectedFacets.slice(0, 10).map((f) => ({
            facetId: f.facetId,
            label: f.label,
            why: f.why,
            kbQueries: f.kbQueries,
          }))
        : facetPlan
            .map((f: any) => ({
              facetId: String(f?.facetId ?? "").trim(),
              label: String(f?.label ?? f?.title ?? "").trim(),
              why: String(f?.why ?? "").trim(),
              kbQueries: Array.isArray(f?.kbQueries) ? f.kbQueries.map((q: any) => String(q ?? "").trim()).filter(Boolean) : [],
            }))
            .filter((f: any) => Boolean((f as any).facetId))
            .slice(0, 10);
    const shouldFacetIds = planFacetIds.filter((id: string) => !mustFacetIds.includes(id)).slice(0, 8);
    const softRanges = (() => {
      const s = contract?.softRanges;
      if (!s || typeof s !== "object" || Array.isArray(s)) return null;
      return Object.keys(s).length ? s : null;
    })();
    if (!mustFacetIds.length && !softRanges) return "";
    const payload = {
      v: 1,
      libraryId: libId,
      libraryName: libName,
      selectedClusterId: selectedClusterId || null,
      mustApply: {
        facetIds: mustFacetIds,
        facets: mustFacets,
      },
      shouldApply: {
        facetIds: shouldFacetIds,
        softRanges,
      },
      mayApply: {
        cardTypesHint: ["hook", "one_liner", "outline", "thesis", "ending"],
      },
    };
    return (
      `STYLE_DIMENSIONS(JSON):\n${JSON.stringify(payload, null, 2)}\n\n` +
      "提示：以上为结构化维度约束。MUST 必须覆盖；SHOULD 尽量贴合统计指纹；MAY 作为备选素材。\n\n"
    );
  })();

  // Pending proposals：用于"proposal-first 不落盘"但仍可继续下一步（避免下一轮说‘没有初稿’）
  const pendingProposals = (() => {
    const steps = useRunStore.getState().steps ?? [];
    const out: Array<{ toolName: string; path?: string; note?: string }> = [];
    for (const st of steps as any[]) {
      if (!st || typeof st !== "object") continue;
      if (st.type !== "tool") continue;
      if (st.status !== "success") continue;
      if (st.applyPolicy !== "proposal") continue;
      if (st.applied === true) continue;
      if (st.status === "undone") continue;
      if (st.toolName === "doc.write") {
        out.push({
          toolName: "doc.write",
          path: typeof st.input?.path === "string" ? st.input.path : typeof st.output?.path === "string" ? st.output.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.applyEdits") {
        out.push({
          toolName: "doc.applyEdits",
          path: typeof st.output?.path === "string" ? st.output.path : typeof st.input?.path === "string" ? st.input.path : undefined,
          note: typeof st.output?.preview?.note === "string" ? st.output.preview.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.splitToDir") {
        out.push({
          toolName: "doc.splitToDir",
          path: typeof st.output?.targetDir === "string" ? st.output.targetDir : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
      if (st.toolName === "doc.restoreSnapshot") {
        out.push({
          toolName: "doc.restoreSnapshot",
          path: typeof st.output?.preview?.path === "string" ? st.output.preview.path : undefined,
          note: typeof st.output?.note === "string" ? st.output.note : undefined,
        });
        continue;
      }
    }
    return out.slice(-20);
  })();
  const pendingSection = pendingProposals.length
    ? `PENDING_FILE_PROPOSALS(JSON):\n${JSON.stringify(pendingProposals, null, 2)}\n\n` +
      `提示：存在未 Keep 的"文件提案"。后续若调用 doc.read 读取对应文件，系统会优先返回"提案态最新内容"（不要求先 Keep）。\n\n`
    : "";

  const segments: ContextManifestSegmentV1[] = [];
  const parts: string[] = [];
  const pushSeg = (seg: {
    name: string;
    content: string;
    priority: ContextManifestPriorityV1;
    trusted: boolean;
    source: "desktop" | "gateway";
    truncated?: boolean;
    note?: string;
  }) => {
    const content = String(seg.content ?? "");
    parts.push(content);
    segments.push({
      name: seg.name,
      chars: content.length,
      priority: seg.priority,
      trusted: seg.trusted,
      truncated: Boolean(seg.truncated),
      source: seg.source,
      ...(seg.note ? { note: seg.note } : {}),
    });
  };

  // p0: Agent 身份与团队花名册（可信）
  const agentPersona = (() => {
    const persona = usePersonaStore.getState();
    const agents = getEffectiveAgents().filter((a) => a.effectiveEnabled);
    const teamRoster = agents.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      description: a.description,
    }));
    // Full definitions for custom agents — gateway needs them for agent.delegate
    const customAgentDefinitions = Object.values(useTeamStore.getState().customAgents);
    return {
      agentName: persona.agentName || "",
      personaPrompt: persona.personaPrompt || "",
      teamRoster,
      customAgentDefinitions,
    };
  })();
  pushSeg({
    name: "AGENT_PERSONA",
    content: `AGENT_PERSONA(JSON):\n${JSON.stringify(agentPersona, null, 2)}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });

  // L1: 全局记忆（跨项目持久化）
  const globalMemory = useMemoryStore.getState().globalMemory;
  if (globalMemory.trim()) {
    pushSeg({
      name: "L1_GLOBAL_MEMORY",
      content: `L1_GLOBAL_MEMORY(Markdown):\n${globalMemory}\n\n`,
      priority: "p0",
      trusted: true,
      source: "desktop",
      note: "全局记忆（跨项目持久化）",
    });
  }

  // L2: 项目记忆（跟随项目目录持久化）
  const projectMemory = useMemoryStore.getState().projectMemory;
  if (projectMemory.trim()) {
    pushSeg({
      name: "L2_PROJECT_MEMORY",
      content: `L2_PROJECT_MEMORY(Markdown):\n${projectMemory}\n\n`,
      priority: "p0",
      trusted: true,
      source: "desktop",
      note: "项目级长期记忆（跟随项目目录持久化）",
    });
  }

  // p0: 任务主线/约束（可信）
  pushSeg({
    name: "MAIN_DOC",
    content: `MAIN_DOC(JSON):\n${JSON.stringify(mainDoc, null, 2)}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "RUN_TODO",
    content: `RUN_TODO(JSON):\n${JSON.stringify(runTodoForPack, null, 2)}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "DOC_RULES",
    content: `DOC_RULES(Markdown):\n${docRules}\n\n`,
    priority: "p0",
    trusted: true,
    source: "desktop",
  });

  // p1: 滚动摘要/最近对话/引用（引用视为不可信数据）
  if (dialogueSummary) {
    pushSeg({ name: "DIALOGUE_SUMMARY", content: dialogueSummary, priority: "p1", trusted: true, source: "desktop" });
  }
  if (recentDialogue) {
    pushSeg({ name: "RECENT_DIALOGUE", content: recentDialogue, priority: "p1", trusted: true, source: "desktop" });
  }
  if (refs) {
    pushSeg({ name: "REFERENCES", content: refs, priority: "p1", trusted: false, source: "desktop" });
  }

  // p1: KB 元信息（可信）；KB 正文（手册/卡片/样例）视为不可信数据（仅供参考，不可覆盖系统规则）
  pushSeg({ name: "KB_SELECTED_LIBRARIES", content: kbText, priority: "p1", trusted: true, source: "desktop" });
  pushSeg({ name: "ACTIVE_SKILLS", content: skillsText, priority: "p1", trusted: true, source: "desktop" });
  if (playbookSection) pushSeg({ name: "KB_LIBRARY_PLAYBOOK", content: playbookSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleCatalogSection) pushSeg({ name: "STYLE_CATALOG", content: styleCatalogSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleClustersSection) pushSeg({ name: "KB_STYLE_CLUSTERS", content: styleClustersSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleSelectorSection) pushSeg({ name: "STYLE_SELECTOR", content: styleSelectorSection, priority: "p2", trusted: false, source: "desktop" });
  if (styleDimensionsSection) pushSeg({ name: "STYLE_DIMENSIONS", content: styleDimensionsSection, priority: "p2", trusted: false, source: "desktop" });

  // p2: 提案态提示（可信）
  if (pendingSection) pushSeg({ name: "PENDING_FILE_PROPOSALS", content: pendingSection, priority: "p2", trusted: true, source: "desktop" });

  // p2: 选区（可信，但可能截断）
  pushSeg({
    name: "EDITOR_SELECTION",
    content: `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n\n`,
    priority: "p2",
    trusted: true,
    source: "desktop",
    truncated: Boolean((selection as any)?.truncated),
  });

  // p3: 项目状态最小信息（可信）
  pushSeg({
    name: "PROJECT_STATE",
    content: `PROJECT_STATE(JSON):\n${JSON.stringify(state, null, 2)}\n\n`,
    priority: "p3",
    trusted: true,
    source: "desktop",
  });
  pushSeg({
    name: "NOTES",
    content:
      `注意：\n` +
      `- 已提供当前编辑器选区（EDITOR_SELECTION）。若用户说"改写我选中的这段"，优先用该选区。\n` +
      `- 如需文件正文请调用 doc.read；如需刷新选区也可调用 doc.getSelection。\n` +
      `- 本次 Context Pack 仅注入少量最近对话片段（RECENT_DIALOGUE），不是完整历史；关键决策请写入 Main Doc（run.mainDoc.update），历史素材请用 @{} 显式引用。\n\n`,
    priority: "p3",
    trusted: true,
    source: "desktop",
  });

  const manifest = renderContextManifestV1({ mode: useRunStore.getState().mode as Mode, segments });
  return manifest + parts.join("");
}

export function buildChatContextPack(extra?: { referencesText?: string }) {
  const proj = useProjectStore.getState();
  const docRules = proj.getFileByPath("doc.rules.md")?.content ?? "";
  const selection = (() => {
    const ed = proj.editorRef;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !model || !sel) {
      return { ok: false, hasSelection: false, reason: "NO_EDITOR" as const };
    }
    const fullText = model.getValueInRange(sel);
    const maxChars = 4000;
    const truncated = fullText.length > maxChars;
    const selectedText = truncated ? fullText.slice(0, maxChars) : fullText;
    if (!fullText.length) return { ok: true, hasSelection: false, reason: "EMPTY_SELECTION" as const };
    return {
      ok: true,
      hasSelection: true,
      path: proj.activePath,
      selectedChars: fullText.length,
      truncated,
      range: {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      },
      selectedText,
    };
  })();
  const refs = extra?.referencesText ? `${extra.referencesText}\n\n` : "";
  const segments: ContextManifestSegmentV1[] = [];
  const parts: string[] = [];
  const pushSeg = (seg: {
    name: string;
    content: string;
    priority: ContextManifestPriorityV1;
    trusted: boolean;
    source: "desktop" | "gateway";
    truncated?: boolean;
    note?: string;
  }) => {
    const content = String(seg.content ?? "");
    parts.push(content);
    segments.push({
      name: seg.name,
      chars: content.length,
      priority: seg.priority,
      trusted: seg.trusted,
      truncated: Boolean(seg.truncated),
      source: seg.source,
      ...(seg.note ? { note: seg.note } : {}),
    });
  };

  pushSeg({ name: "DOC_RULES", content: `DOC_RULES(Markdown):\n${docRules}\n\n`, priority: "p0", trusted: true, source: "desktop" });

  // Chat：也携带"滚动摘要 + 最近 3 个完整回合"（用户要求：Chat 带历史，但仍保持上下文可控）
  const chatSummary = (() => {
    const byMode: any = (useRunStore.getState() as any).dialogueSummaryByMode ?? {};
    const s = String(byMode?.chat ?? "").trim();
    return s ? `DIALOGUE_SUMMARY(Markdown):\n${s}\n\n` : "";
  })();
  const chatRecentDialogue = (() => {
    const turnsAll = buildDialogueTurnsFromSteps(useRunStore.getState().steps ?? []);
    const completeTurns = turnsAll.filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());
    return buildRecentDialogueJsonFromTurns(completeTurns, 3);
  })();
  if (chatSummary) pushSeg({ name: "DIALOGUE_SUMMARY", content: chatSummary, priority: "p1", trusted: true, source: "desktop" });
  if (chatRecentDialogue)
    pushSeg({ name: "RECENT_DIALOGUE", content: chatRecentDialogue, priority: "p1", trusted: true, source: "desktop" });

  if (refs) pushSeg({ name: "REFERENCES", content: refs, priority: "p1", trusted: false, source: "desktop" });
  pushSeg({
    name: "EDITOR_SELECTION",
    content: `EDITOR_SELECTION(JSON):\n${JSON.stringify(selection, null, 2)}\n`,
    priority: "p1",
    trusted: true,
    source: "desktop",
    truncated: Boolean((selection as any)?.truncated),
  });

  const manifest = renderContextManifestV1({ mode: "chat", segments });
  return manifest + parts.join("");
}

async function fetchContextSummaryOnce(args: {
  gatewayUrl: string;
  preferModelId: string;
  previousSummary: string;
  deltaTurns: Array<{ user: string; assistant?: string }>;
  abort: AbortController;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
}) {
  const doFetch = async (baseUrl: string) => {
    const url = baseUrl ? `${baseUrl}/api/agent/context/summary` : "/api/agent/context/summary";
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        preferModelId: args.preferModelId,
        previousSummary: args.previousSummary,
        deltaTurns: args.deltaTurns,
      }),
      signal: args.abort.signal,
    });
  };

  let res: Response | null = null;
  try {
    res = await doFetch(args.gatewayUrl);
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    if (msg.includes("Failed to fetch") && args.gatewayUrl.includes("localhost")) {
      const fallback = args.gatewayUrl.replace("localhost", "127.0.0.1");
      args.log("warn", "gateway.fetch_retry", { from: args.gatewayUrl, to: fallback });
      res = await doFetch(fallback);
    } else {
      throw e;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false as const, error: text || `HTTP_${res.status}` };
  }
  const json = await res.json().catch(() => null);
  const ok = Boolean(json?.ok);
  const summary = ok ? String(json?.summary ?? "") : "";
  if (!ok || !summary.trim()) return { ok: false as const, error: String(json?.error ?? "SUMMARY_FAILED") };
  return { ok: true as const, summary, modelIdUsed: json?.modelIdUsed ?? null };
}

export async function rollDialogueSummaryIfNeeded(args: {
  gatewayUrl: string;
  mode: Mode;
  abort: AbortController;
  log: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
}) {
  const run: any = useRunStore.getState();
  const turnsAll = buildDialogueTurnsFromSteps(run.steps ?? []);
  const completeTurns = turnsAll.filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());

  const RAW_KEEP_TURNS = 3; // Chat/Plan/Agent：都保留最近 3 个完整回合原文
  const TRIGGER_MIN_TURNS = 3; // 每累计 3 个新回合就滚动一次摘要（"3–5轮摘要"先用 3）

  const turnsToSummarize = Math.max(0, completeTurns.length - RAW_KEEP_TURNS);
  const cursorByMode: any = run.dialogueSummaryTurnCursorByMode ?? {};
  const cursor = Number.isFinite(Number(cursorByMode?.[args.mode])) ? Math.max(0, Math.floor(Number(cursorByMode[args.mode]))) : 0;
  if (turnsToSummarize <= cursor) return { ok: true as const, rolled: false as const };

  const delta = completeTurns.slice(cursor, turnsToSummarize).slice(0, 12);
  if (delta.length < TRIGGER_MIN_TURNS) return { ok: true as const, rolled: false as const };

  const summaryByMode: any = run.dialogueSummaryByMode ?? {};
  const previousSummary = String(summaryByMode?.[args.mode] ?? "");
  // 用户要求：摘要模型默认复用"agentModel"（即使在 chat 模式），后续可在 B 端单独配置 stage 覆盖/约束
  const preferModelId = String(run.agentModel || "").trim() || String(run.model || "").trim();
  if (!preferModelId) return { ok: true as const, rolled: false as const };

  args.log("info", "context.summary.roll", { mode: args.mode, cursor, turnsToSummarize, deltaTurns: delta.length });
  const ret = await fetchContextSummaryOnce({
    gatewayUrl: args.gatewayUrl,
    preferModelId,
    previousSummary,
    deltaTurns: delta.map((t) => ({ user: t.user, assistant: t.assistant })),
    abort: args.abort,
    log: args.log,
  });
  if (!ret.ok) {
    args.log("warn", "context.summary.failed", { mode: args.mode, error: ret.error });
    return { ok: false as const, error: ret.error };
  }

  // 写回 store（持久化），并推进 cursor 到 "已摘要覆盖的 turn 数"
  try {
    (useRunStore.getState() as any).setDialogueSummary(args.mode, ret.summary, turnsToSummarize);
  } catch {
    // ignore
  }
  return { ok: true as const, rolled: true as const };
}

export function startGatewayRun(args: {
  gatewayUrl: string;
  mode: Mode;
  model: string;
  prompt: string;
  targetAgentId?: string;
  targetAgentIds?: string[];
  activeSkillIds?: string[];
  kbMentionIds?: string[];
}): GatewayRunController {
  return startGatewayRunWs(args as GatewayRunArgs);
}

