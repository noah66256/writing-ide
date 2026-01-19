import type { AgentMode } from "./index.js";
import type { ParsedToolCall } from "./xmlProtocol.js";

export type KbSelectedLibrary = {
  id: string;
  name?: string;
  purpose?: string;
  facetPackId?: string;
  fingerprint?: { primaryLabel?: string } | null;
};

export type RunIntent = {
  forceProceed: boolean;
  wantsWrite: boolean;
  wantsOkOnly: boolean;
  isWritingTask: boolean;
  skipLint: boolean;
  skipCta: boolean;
};

export type StyleGateDerived = {
  hasStyleLibrary: boolean;
  hasNonStyleLibraries: boolean;
  styleLibIds: string[];
  nonStyleLibIds: string[];
  styleLibIdSet: Set<string>;
};

export type RunGates = StyleGateDerived & {
  styleGateEnabled: boolean; // activeSkillIds includes "style_imitate"（通常等价于 hasStyleLibrary && isWritingTask）
  lintGateEnabled: boolean; // styleGateEnabled && !skipLint
};

export type StyleLintParsed = {
  score: number | null;
  highIssues: number;
  summary: string;
  rewritePrompt: string;
  modelUsed: string;
  usedHeuristic: boolean;
};

export type RunState = {
  hasTodoList: boolean;
  hasWriteOps: boolean;
  hasAnyToolCall: boolean;
  hasKbSearch: boolean;
  hasWebSearch: boolean;
  hasWebFetch: boolean;
  // Web Gate（配额型）：用于“热点/素材盘点”等广度优先场景
  webSearchCount: number;
  webFetchCount: number;
  // 为了可观测/可解释：只保留少量 unique（避免无限增长）
  webSearchUniqueQueries: string[];
  webFetchUniqueDomains: string[];
  hasStyleKbSearch: boolean; // 风格库样例检索是否已完成（以“已尝试检索”为准；0 命中也算完成，避免卡死）
  hasStyleKbHit: boolean; // 风格库样例检索是否曾命中（groups>0）；用于避免“后续某次 0 命中”误触发降级提示
  styleKbDegraded: boolean; // 风格样例检索 0 命中降级（仅警告，不再卡死）
  styleLintPassed: boolean;
  styleLintFailCount: number;
  lintGateDegraded: boolean;
  bestStyleDraft: null | { score: number; highIssues: number; text: string };
  lastStyleLint: null | StyleLintParsed;
  // 预算拆分：避免一个 budget 同时承担“协议修复/完成性重试/风格门禁”等多重语义
  protocolRetryBudget: number;
  workflowRetryBudget: number;
  lintReworkBudget: number;

  // proposal/write 语义：区分“已提案但未 Keep”与“已落盘/已应用”
  hasWriteProposed: boolean;
  hasWriteApplied: boolean;
};

export function createInitialRunState(args?: { protocolRetryBudget?: number; workflowRetryBudget?: number; lintReworkBudget?: number }): RunState {
  return {
    hasTodoList: false,
    hasWriteOps: false,
    hasAnyToolCall: false,
    hasKbSearch: false,
    hasWebSearch: false,
    hasWebFetch: false,
    webSearchCount: 0,
    webFetchCount: 0,
    webSearchUniqueQueries: [],
    webFetchUniqueDomains: [],
    hasStyleKbSearch: false,
    hasStyleKbHit: false,
    styleKbDegraded: false,
    styleLintPassed: false,
    styleLintFailCount: 0,
    lintGateDegraded: false,
    bestStyleDraft: null,
    lastStyleLint: null,
    protocolRetryBudget: Number.isFinite(args?.protocolRetryBudget as any) ? Math.max(0, Math.floor(Number(args?.protocolRetryBudget))) : 2,
    workflowRetryBudget: Number.isFinite(args?.workflowRetryBudget as any) ? Math.max(0, Math.floor(Number(args?.workflowRetryBudget))) : 3,
    lintReworkBudget: Number.isFinite(args?.lintReworkBudget as any) ? Math.max(0, Math.floor(Number(args?.lintReworkBudget))) : 2,
    hasWriteProposed: false,
    hasWriteApplied: false,
  };
}

export function parseMainDocFromContextPack(ctx?: string): any | null {
  const text = String(ctx ?? "");
  if (!text) return null;
  const m = text.match(/MAIN_DOC\(JSON\):\n([\s\S]*?)\n\n/);
  const raw = m?.[1] ? String(m[1]).trim() : "";
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

export function parseKbSelectedLibrariesFromContextPack(ctx?: string): KbSelectedLibrary[] {
  const text = String(ctx ?? "");
  if (!text) return [];
  const m = text.match(/KB_SELECTED_LIBRARIES\(JSON\):\n([\s\S]*?)\n\n/);
  const raw = m?.[1] ? String(m[1]).trim() : "";
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as any[]) : [];
  } catch {
    return [];
  }
}

export function parseRunTodoFromContextPack(ctx?: string): any[] {
  const text = String(ctx ?? "");
  if (!text) return [];
  const m = text.match(/RUN_TODO\(JSON\):\n([\s\S]*?)\n\n/);
  const raw = m?.[1] ? String(m[1]).trim() : "";
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as any[]) : [];
  } catch {
    return [];
  }
}

export function detectRunIntent(args: {
  mode: AgentMode;
  userPrompt: string;
  mainDocRunIntent?: unknown;
  runTodo?: any[];
}): RunIntent {
  const { mode } = args;
  const userPrompt = String(args.userPrompt ?? "");
  const forceProceed =
    mode !== "chat" &&
    /(先(直接)?(开始|写|仿写|给一版|给版本|产出|干活)|不要(再)?问|别问了|先做|直接写|继续)/.test(userPrompt);
  const wantsWrite =
    mode !== "chat" &&
    (/@\{[^}]+\/\}/.test(userPrompt) || // 目录引用（@{dir/}）通常意味着要写入/落盘到该目录
      /(分割|拆分|切分|写入|保存|生成|放到|移动到|导出|新建|删除|删|重命名)/.test(userPrompt) ||
      /(写|仿写|改写|润色|续写|扩写)\s*@\{[^}]+\}/.test(userPrompt)); // 写@{file}：目标文件写作/改写
  const wantsOkOnly =
    mode !== "chat" &&
    /(回(个|我)?\s*ok|回复\s*ok|回\s*ok|只要\s*ok|给我\s*ok)/i.test(userPrompt) &&
    /(不用回别的|别回别的|不要回别的|就行)/.test(userPrompt);
  const isWritingTask =
    mode !== "chat" &&
    (/(仿写|改写|润色|续写|扩写|写(一篇|一段|一条|稿|文|文章|脚本|文案)|写.{0,8}\d{2,5}字|生成(文章|稿|文案)|按.+风格)/.test(userPrompt) ||
      /(写|仿写|改写|润色|续写|扩写)\s*@\{[^}]+\}/.test(userPrompt) || // 写@{示例.md}
      /\bcluster[_-]\d+\b/i.test(userPrompt) || // 选簇续跑：用户仅回复 cluster_1 等，也应视为写作流程的一部分
      /写法\s*[ABC]\b/i.test(userPrompt)); // 选簇续跑：用户仅回复“写法B/写法C”也应保持写作闭环
  const skipLint = /(跳过|不用|不要).{0,12}(linter|风格检查|风格对齐|风格校验|像不像检查)/i.test(userPrompt);
  const skipCta = /(跳过|不用|不要).{0,12}(cta|点赞|关注|评论|转发|收藏|三连|一键三连)/i.test(userPrompt);

  // 结构化意图（优先级高于正则启发式）：来自 Main Doc/UI（例如 Desktop 选择“意图：分析/操作”避免误触写作强闭环）
  const mainDocIntentRaw = String(args.mainDocRunIntent ?? "").trim().toLowerCase();
  const mainDocIntent = mainDocIntentRaw === "auto" ? "" : mainDocIntentRaw;
  let isWritingTaskFinal =
    mainDocIntent === "writing" || mainDocIntent === "rewrite" || mainDocIntent === "polish"
      ? true
      : mainDocIntent === "analysis" || mainDocIntent === "ops"
        ? false
        : isWritingTask;

  // 文件/目录操作：不应被“写作闭环 sticky”误判为写作任务。
  // 典型误伤：绑定风格库 + 旧 todo（写作）+ 用户短句“删那 4 篇旧稿” -> 不应触发 style gate 禁用 doc.deletePath。
  const looksLikeFileOpsTask = (() => {
    const t = String(userPrompt ?? "");
    if (!t.trim()) return false;
    // “删减/精简”通常指改文案字数，不是文件系统操作
    if (/(删减|精简|压缩|删到\d{2,6}字|删成\d{2,6}字)/.test(t)) return false;
    const hasVerb = /(删除|删掉|删|移除|清理|清空|重命名|改名|移动|迁移|挪到|放到|mkdir|rename|move|rm\b|del\b|delete\b)/i.test(t);
    if (!hasVerb) return false;
    const hasTargetHint =
      /@\{[^}]+\}/.test(t) ||
      /(文件|目录|文件夹|路径|path|旧稿|草稿|文稿|稿子|文档)/.test(t) ||
      /\.(md|mdx|txt)\b/i.test(t) ||
      /[\\/]/.test(t);
    return hasTargetHint;
  })();

  // 关键增强：当用户在回答“澄清问题/等待确认”的续跑对话时，userPrompt 往往非常短（例如“继续/视频脚本/按这个来”），
  // 仅靠正则会误判为非写作任务，导致 style_imitate/写作闭环不激活。
  // 这里在 mainDocIntent=auto 且当前未判为写作任务时，参考 RUN_TODO 来判断是否应继承“写作闭环”意图。
  if (!mainDocIntent && !isWritingTaskFinal) {
    const todoRaw = Array.isArray(args.runTodo) ? args.runTodo : [];
    const todo = todoRaw.slice(0, 50);
    const shortOrContinue = userPrompt.length <= 60 || /^(继续|好|可以|行|没问题|确认|按这个来|就这样|ok|OK)\b/.test(userPrompt);
    const hasWaiting = todo.some((t: any) => {
      const status = String(t?.status ?? "").trim().toLowerCase();
      const note = String(t?.note ?? "").trim();
      if (status === "blocked") return true;
      if (/^blocked\b/i.test(note)) return true;
      if (/(等待用户|等待你|待确认|等你确认|需要你确认|请确认)/.test(note)) return true;
      return false;
    });
    const todoLooksWriting = todo.some((t: any) => /(写|仿写|改写|润色|脚本|文案|终稿|写入|lint\.style)/.test(String(t?.text ?? "")));
    const looksNonWriting =
      /(分析|排查|报错|bug|为什么|怎么修|白屏|崩溃|日志|报错栈)/.test(userPrompt) &&
      !/(写|仿写|改写|润色|脚本|文案|终稿|写入)/.test(userPrompt);
    if (!looksNonWriting && !looksLikeFileOpsTask && todoLooksWriting && (hasWaiting || shortOrContinue)) {
      isWritingTaskFinal = true;
    }
  }

  return { forceProceed, wantsWrite, wantsOkOnly, isWritingTask: isWritingTaskFinal, skipLint, skipCta };
}

export function deriveStyleGate(args: {
  mode: AgentMode;
  kbSelected: KbSelectedLibrary[];
  intent: RunIntent;
  activeSkillIds?: string[];
}): RunGates {
  const kbSelected = Array.isArray(args.kbSelected) ? args.kbSelected : [];
  const styleLibIds = kbSelected
    .filter((l: any) => String(l?.purpose ?? "").trim() === "style")
    .map((l: any) => String(l?.id ?? "").trim())
    .filter(Boolean);
  const nonStyleLibIds = kbSelected
    .filter((l: any) => String(l?.purpose ?? "").trim() !== "style")
    .map((l: any) => String(l?.id ?? "").trim())
    .filter(Boolean);
  const hasStyleLibrary = args.mode !== "chat" && styleLibIds.length > 0;
  const hasNonStyleLibraries = args.mode !== "chat" && nonStyleLibIds.length > 0;
  const skillIds = Array.isArray(args.activeSkillIds) ? args.activeSkillIds.map((x) => String(x ?? "").trim()).filter(Boolean) : null;
  const styleSkillActive = skillIds ? new Set(skillIds).has("style_imitate") : false;
  const styleGateEnabled = hasStyleLibrary && (skillIds ? styleSkillActive : args.intent.isWritingTask);
  const lintGateEnabled = styleGateEnabled && !args.intent.skipLint;
  return {
    hasStyleLibrary,
    hasNonStyleLibraries,
    styleLibIds,
    nonStyleLibIds,
    styleLibIdSet: new Set(styleLibIds),
    styleGateEnabled,
    lintGateEnabled,
  };
}

export function looksLikeClarifyQuestions(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  return (
    /[?？]/.test(t) ||
    /(请问|是否|能否|方便|要不要|需要你|请确认|确认一下|需要确认|待确认|请选择|请选|你选|你更偏好|更偏好|偏好哪|更偏向|选哪个|选哪种|用哪个)/.test(t)
  );
}

export function looksLikeFIMLeak(text: string) {
  const t = String(text ?? "").trimStart();
  if (!t) return false;
  if (!t.startsWith("<|")) return false;
  return /<\|fim_begin\|>|<\|begin_of_sentence\|>/i.test(t);
}

export function looksLikeDraftText(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const len = t.length;
  const paras = t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const paraCount = paras.length;
  const hasManyPunct = /[。！？]/.test(t) && (t.match(/[。！？]/g)?.length ?? 0) >= 8;
  const hasBulletHeavy = /^[\s>*-]*\d+\.|^[\s>*-]*[-*]\s+/m.test(t);
  const hasOnlyOutlineSignals = /(大纲|提纲|结构|目录|outline)/i.test(t) && paraCount <= 10 && hasBulletHeavy && len < 1200;
  if (hasOnlyOutlineSignals) return false;
  if (len >= 1200) return true;
  if (paraCount >= 6 && hasManyPunct) return true;
  return false;
}

export function looksLikeHasCTA(text: string) {
  const t = String(text ?? "");
  return /(点赞|点个赞|关注|加关注|评论区|评论|留言|转发|收藏|三连|一键三连|点一点|安排上|走一波)/.test(t);
}

export function styleNeedsCta(args: { styleGateEnabled: boolean; skipCta: boolean; kbSelected: KbSelectedLibrary[] }) {
  if (!args.styleGateEnabled || args.skipCta) return false;
  const styleLibs = (args.kbSelected ?? []).filter((l) => String((l as any)?.purpose ?? "").trim() === "style");
  for (const l of styleLibs as any[]) {
    const facet = String(l?.facetPackId ?? "").trim();
    const label = String(l?.fingerprint?.primaryLabel ?? "").trim();
    if (/speech_marketing/i.test(facet)) return true;
    if (/(口播|短视频|直播|带货|营销)/.test(label)) return true;
  }
  return false;
}

export function isWriteLikeTool(name: string) {
  return (
    name === "doc.write" ||
    name === "doc.applyEdits" ||
    name === "doc.replaceSelection" ||
    name === "doc.mkdir" ||
    name === "doc.renamePath" ||
    name === "doc.deletePath" ||
    name === "doc.restoreSnapshot" ||
    name === "doc.splitToDir"
  );
}

// “正文写入”类工具：用于风格闭环门禁（StyleGate）。
// 说明：doc.deletePath/doc.renamePath/doc.mkdir 也会改动项目，但它们不是“写正文”，不应被 style gate 当成 WRITE_BEFORE_KB/LINT。
export function isContentWriteTool(name: string) {
  return (
    name === "doc.write" ||
    name === "doc.applyEdits" ||
    name === "doc.replaceSelection" ||
    name === "doc.restoreSnapshot" ||
    name === "doc.splitToDir"
  );
}

function normalizeIdList(v: any): string[] {
  if (Array.isArray(v)) return v.map((x: any) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  // 兼容：tool_calls 的 <arg> 值通常是字符串；数组会以 JSON 字符串形式出现（例如 '["a","b"]'）
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j.map((x: any) => String(x ?? "").trim()).filter(Boolean);
    } catch {
      // fallthrough
    }
  }
  // 兜底：允许逗号分隔（例如 "a,b,c"）
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  // 单值
  return [s];
}

export function isStyleExampleKbSearch(args: {
  call: ParsedToolCall;
  styleLibIdSet: Set<string>;
  hasNonStyleLibraries: boolean;
}) {
  const call = args.call;
  if (!call || String(call?.name ?? "") !== "kb.search") return false;
  const a = call?.args ?? {};
  const kind = String((a as any)?.kind ?? "card").trim().toLowerCase();
  if (kind !== "paragraph" && kind !== "outline" && kind !== "card") return false;

  // 风格/手法样例：允许用 card，也允许 paragraph/outline
  if (kind === "card") {
    const cardTypes = normalizeIdList((a as any)?.cardTypes);
    // 同时绑定了非风格库时：必须显式限制 cardTypes，避免“样例被素材库污染”。
    // 仅绑定风格库时：允许省略（减少强闭环误伤/不必要重试）。
    if (!cardTypes.length && args.hasNonStyleLibraries) return false;
  }

  const libs = normalizeIdList((a as any)?.libraryIds);
  // 同时绑定了非风格库时：要求显式限制到风格库，避免“样例被素材库污染”
  if (!libs.length) return !args.hasNonStyleLibraries;
  if (!libs.some((id) => args.styleLibIdSet.has(id))) return false;
  return libs.every((id) => args.styleLibIdSet.has(id));
}

export function parseStyleLintResult(output: any): StyleLintParsed {
  const o: any = output && typeof output === "object" ? output : {};
  const modelUsed = String(o?.modelUsed ?? "").trim();
  const usedHeuristic = /^local_heuristic\(/.test(modelUsed);
  const scoreRaw = Number(o?.similarityScore);
  const score = Number.isFinite(scoreRaw) ? scoreRaw : null;
  const issues = Array.isArray(o?.issues) ? o.issues : [];
  const highIssues = issues.filter((x: any) => String(x?.severity ?? "").toLowerCase() === "high").length;
  const summary = String(o?.summary ?? "").trim();
  const rewritePrompt = String(o?.rewritePrompt ?? "").trim();
  return { score, highIssues, summary, rewritePrompt, modelUsed, usedHeuristic };
}

export type AutoRetryAnalysis = {
  shouldRetry: boolean;
  isEmpty: boolean;
  isFIMLeak: boolean;
  isClarify: boolean;
  needTodo: boolean;
  needWrite: boolean;
  needKb: boolean;
  needLint: boolean;
  needLength: boolean;
  needFinalText: boolean;
  reasons: string[];
};

export function analyzeAutoRetryText(args: {
  assistantText: string;
  intent: RunIntent;
  gates: RunGates;
  state: RunState;
  lintMaxRework: number;
  targetChars?: number | null;
  // Intent Router（Policy-0）：只有当 todoPolicy=required 时才强制 need_todo。
  // - required：沿用现状（没有 todo 就会触发 need_todo 自动重试）
  // - optional/skip：不再强制 todo（避免“讨论/解释类”被误伤进入闭环）
  todoPolicy?: "skip" | "optional" | "required";
}) : AutoRetryAnalysis {
  const t = String(args.assistantText ?? "").trim();
  const isEmpty = t.length === 0;
  const isFIMLeak = looksLikeFIMLeak(args.assistantText);
  // 关键修正：口播正文里会大量出现“问题来了/是不是？”等问句，不能误判为“向用户澄清”。
  // 若看起来像正文稿，则一律不视为澄清（否则会导致 needLint/needWrite 被关闭，Run 提前结束）。
  const isClarify = looksLikeClarifyQuestions(t) && !args.intent.forceProceed && !looksLikeDraftText(t);

  const todoPolicy: "skip" | "optional" | "required" = args.todoPolicy ?? "required";
  const needTodo = todoPolicy === "required" && !args.state.hasTodoList && !args.intent.wantsOkOnly;
  const needWrite = args.intent.wantsWrite && !args.state.hasWriteOps && !isClarify;
  const needKb = args.gates.styleGateEnabled && !args.state.hasStyleKbSearch && !isClarify;
  const needLint =
    args.gates.lintGateEnabled && !args.state.styleLintPassed && args.state.styleLintFailCount <= args.lintMaxRework && !isClarify;
  const target = Number.isFinite(Number(args.targetChars as any)) ? Math.max(0, Number(args.targetChars)) : 0;
  const looksDraft =
    looksLikeDraftText(t) || (t.length >= 400 && /[。！？]/.test(t) && t.split(/\n{2,}/).filter(Boolean).length >= 3);
  const needLength =
    !isClarify &&
    target >= 200 &&
    looksDraft &&
    args.intent.isWritingTask &&
    // 只做“明显偏离”提醒（避免卡在细微误差）
    (t.length < target * 0.72 || t.length > target * 1.35);
  const needFinalText = isEmpty && !needTodo && !needWrite && !needKb && !needLint;

  const reasons: string[] = [];
  if (isFIMLeak) reasons.push("模型输出异常(FIM token)");
  else if (isEmpty) reasons.push("输出为空");
  if (needFinalText) reasons.push("缺少最终回复");
  if (needTodo) reasons.push("Todo 未设置");
  if (needKb) reasons.push("风格样例未检索");
  if (needLint) reasons.push("未进行风格对齐(lint.style)");
  if (needLength) reasons.push("字数与目标偏离较大");
  if (needWrite) reasons.push("写入未执行");

  const shouldRetry = isFIMLeak || isEmpty || needTodo || needWrite || needKb || needLint || needLength;
  return { shouldRetry, isEmpty, isFIMLeak, isClarify, needTodo, needWrite, needKb, needLint, needLength, needFinalText, reasons };
}

export type StyleWorkflowBatchAnalysis = {
  shouldEnforce: boolean;
  violation: string | null;
  batchHasWrite: boolean;
  batchHasKb: boolean;
  batchHasLint: boolean;
  batchHasStyleKb: boolean;
  needStyleKb: boolean;
  enforceLint: boolean;
  lintExhausted: boolean;
  needStyleLint: boolean;
};

export function analyzeStyleWorkflowBatch(args: {
  mode: AgentMode;
  intent: RunIntent;
  gates: RunGates;
  state: RunState;
  lintMaxRework: number;
  toolCalls: ParsedToolCall[];
}) : StyleWorkflowBatchAnalysis {
  const toolCalls = Array.isArray(args.toolCalls) ? args.toolCalls : [];
  const batchHasWrite = toolCalls.some((c: any) => isContentWriteTool(String(c?.name ?? "")));
  const batchHasKb = toolCalls.some((c: any) => String(c?.name ?? "") === "kb.search");
  const batchHasLint = toolCalls.some((c: any) => String(c?.name ?? "") === "lint.style");
  const batchHasStyleKb = toolCalls.some((c: any) =>
    isStyleExampleKbSearch({ call: c, styleLibIdSet: args.gates.styleLibIdSet, hasNonStyleLibraries: args.gates.hasNonStyleLibraries }),
  );

  const shouldEnforce = args.intent.isWritingTask || batchHasWrite || batchHasLint;
  const needStyleKb = !args.state.hasStyleKbSearch;
  // 是否“强制要求 lint”：由 gates.lintGateEnabled 统一控制（Gateway 可根据产品策略选择 hint/gate）
  const enforceLint = args.gates.lintGateEnabled === true;
  const lintExhausted = enforceLint && !args.state.styleLintPassed && args.state.styleLintFailCount > args.lintMaxRework;
  const needStyleLint = enforceLint && !args.state.styleLintPassed;

  let violation: string | null = null;
  if (batchHasKb && batchHasLint) violation = "KB_AND_LINT_SAME_TURN";
  else if (batchHasKb && batchHasWrite) violation = "KB_AND_WRITE_SAME_TURN";
  else if (batchHasLint && batchHasWrite) violation = "LINT_AND_WRITE_SAME_TURN";
  else if (batchHasLint && needStyleKb) violation = "LINT_BEFORE_KB";
  else if (batchHasWrite && needStyleKb) violation = "WRITE_BEFORE_KB";
  else if (batchHasWrite && needStyleLint) violation = lintExhausted ? "WRITE_BLOCKED_LINT_EXHAUSTED" : "WRITE_BEFORE_LINT_PASS";
  else if (batchHasKb && needStyleKb && !batchHasStyleKb) violation = "KB_NOT_STYLE_EXAMPLES";

  return { shouldEnforce, violation, batchHasWrite, batchHasKb, batchHasLint, batchHasStyleKb, needStyleKb, enforceLint, lintExhausted, needStyleLint };
}

export function isProposalWaitingMeta(meta: any): boolean {
  const m: any = meta && typeof meta === "object" ? meta : null;
  return Boolean(m && String(m.applyPolicy ?? "") === "proposal" && m.hasApply === true);
}


