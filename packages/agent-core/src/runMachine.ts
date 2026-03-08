import type { AgentMode } from "./index.js";

export type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

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
  copyGateEnabled: boolean; // lintGateEnabled（V2：anti-regurgitation 阶段闸门；与 lint 总开关同进退）
};

export type StyleLintParsed = {
  score: number | null;
  highIssues: number;
  summary: string;
  rewritePrompt: string;
  expectedDimensions: string[];
  coveredDimensions: string[];
  missingDimensions: string[];
  modelUsed: string;
  usedHeuristic: boolean;
};

export type CopyOverlapV1 = { source: string; overlapChars: number; snippet: string };
export type CopyRiskLevelV1 = "low" | "medium" | "high";
export type CopyLintMetaV1 = {
  riskLevel: CopyRiskLevelV1;
  maxOverlapChars: number;
  maxChar5gramJaccard: number;
  topOverlaps?: CopyOverlapV1[];
  sources?: { total: number; selectionIncluded: boolean; styleSampleCount: number } | null;
};
export type DraftCandidateV1 = {
  text: string;
  styleScore: number;
  highIssues: number;
  copy: CopyLintMetaV1 | null;
};

export type RunState = {
  hasTodoList: boolean;
  hasPlanCommitment: boolean;
  hasWriteOps: boolean;
  hasAnyToolCall: boolean;
  hasMcpToolCall: boolean;
  mcpToolCallCount: number;
  mcpToolSuccessCount: number;
  mcpToolFailCount: number;
  hasKbSearch: boolean;
  // 时间上下文：用于”时间敏感”工具调用前的门禁（避免模型用错年份/日期）
  hasTimeNow: boolean;
  lastTimeNowIso: string | null;
  hasWebSearch: boolean;
  hasWebFetch: boolean;
  // Web Gate（配额型）：用于“热点/素材盘点”等广度优先场景
  webSearchCount: number;
  webFetchCount: number;
  // 为了可观测/可解释：只保留少量 unique（避免无限增长）
  webSearchUniqueQueries: string[];
  webFetchUniqueDomains: string[];
  // 编排者对各子 Agent 的委派次数（用于重复委派预警）
  delegationCounts: Record<string, number>;
  hasStyleKbSearch: boolean; // 风格库样例检索是否已完成（以”已尝试检索”为准；0 命中也算完成，避免卡死）
  hasStyleKbHit: boolean; // 风格库样例检索是否曾命中（groups>0）；用于避免“后续某次 0 命中”误触发降级提示
  styleKbDegraded: boolean; // 风格样例检索 0 命中降级（仅警告，不再卡死）
  // V2：draft 阶段是否已产出“候选正文”（纯文本，不是 tool_calls）
  // 说明：用于让闭环严格走 templates -> draft -> copy -> style -> write
  hasDraftText: boolean;
  // V2.1：初稿后“二次检索”（金句/收束等）是否已完成
  // - 目的：对齐批处理的“两段式检索”：先定结构/开头/结尾，再出初稿，再补金句/收束
  hasPostDraftStyleKbSearch: boolean;
  // V2：templates 阶段最近一次“风格样例检索（card+cardTypes）”摘要（用于审计/回归）
  lastStyleKbSearch:
    | null
    | {
        kind: "card";
        query: string;
        cardTypes: string[];
        libraryIds: string[];
        groups: number;
        hits: number;
        // V2：templates 命中清单（用于复盘“本轮到底取了哪些模板/规则卡”）
        topArtifacts?: Array<{ id: string; title: string; cardType: string }>;
      };
  styleLintPassed: boolean;
  styleLintFailCount: number;
  lintGateDegraded: boolean;
  bestStyleDraft: null | { score: number; highIssues: number; text: string };
  // V2：bestDraft（多目标）：在候选集中做“styleScore+copyRisk”选择，write 阶段强制使用它
  draftCandidatesV1: DraftCandidateV1[];
  bestDraft: DraftCandidateV1 | null;
  lastStyleLint: null | StyleLintParsed;
  // copy lint（gate）：用于“防贴原文”阶段闸门
  copyLintPassed: boolean;
  copyLintFailCount: number;
  copyGateDegraded: boolean;
  lastCopyLint:
    | null
    | {
        riskLevel: CopyRiskLevelV1;
        maxOverlapChars: number;
        maxChar5gramJaccard: number;
        topOverlaps?: CopyOverlapV1[];
        sources?: { total: number; selectionIncluded: boolean; styleSampleCount: number } | null;
      };
  // copy lint（观测阶段）：用于记录“可能贴原文”的风险指标（不做 gate）
  copyLintObservedCount: number;
  lastCopyRisk:
    | null
    | {
        riskLevel: CopyRiskLevelV1;
        maxOverlapChars: number;
        maxChar5gramJaccard: number;
        topOverlaps?: CopyOverlapV1[];
        sources?: { total: number; selectionIncluded: boolean; styleSampleCount: number } | null;
      };
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
    hasPlanCommitment: false,
    hasWriteOps: false,
    hasAnyToolCall: false,
    hasMcpToolCall: false,
    mcpToolCallCount: 0,
    mcpToolSuccessCount: 0,
    mcpToolFailCount: 0,
    hasKbSearch: false,
    hasTimeNow: false,
    lastTimeNowIso: null,
    hasWebSearch: false,
    hasWebFetch: false,
    webSearchCount: 0,
    webFetchCount: 0,
    webSearchUniqueQueries: [],
    webFetchUniqueDomains: [],
    delegationCounts: {},
    hasStyleKbSearch: false,
    hasStyleKbHit: false,
    styleKbDegraded: false,
    hasDraftText: false,
    hasPostDraftStyleKbSearch: false,
    lastStyleKbSearch: null,
    styleLintPassed: false,
    styleLintFailCount: 0,
    lintGateDegraded: false,
    bestStyleDraft: null,
    draftCandidatesV1: [],
    bestDraft: null,
    lastStyleLint: null,
    copyLintPassed: false,
    copyLintFailCount: 0,
    copyGateDegraded: false,
    lastCopyLint: null,
    copyLintObservedCount: 0,
    lastCopyRisk: null,
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

export function looksLikeFreshWritingTaskPrompt(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length < 10) return false;
  if (/^(继续|存吧|保存吧|写吧|开始吧|按这个来|照这个来|我打开了|打开了|好了|可以了|A|B|C|D|\d+)$/i.test(t)) return false;
  if (/(别存了|不要存了|不存了|取消保存|先别保存)/.test(t)) return false;
  const explicitWriting =
    /(用@?[^\s]{1,20}风格写|按@?[^\s]{1,20}风格写|写一篇|再写一篇|重新写一篇|另写一篇|来一篇|给我一篇|帮我写一篇|写一条|写一段|写个口播稿|写口播稿|写脚本|写文案|写公众号|主题是|关于.+(?:写|口播稿|文章|文案|脚本)|生成一篇|生成一条)/.test(t);
  const notFileOps = !/(删除|删掉|移除|重命名|改名|移动|迁移|mkdir|rename|move|rm\b|del\b|delete\b)/i.test(t);
  return explicitWriting && notFileOps;
}

export function detectRunIntent(args: {
  mode: AgentMode;
  userPrompt: string;
  mainDocRunIntent?: unknown;
  /** 可选：完整 Main Doc（用于读取 goal/workflowV1 等续跑契约；保持向后兼容） */
  mainDoc?: unknown;
  runTodo?: any[];
  /** 可选：最近对话（用于“无 RUN_TODO 的续跑/编号回答”意图继承；保持向后兼容） */
  recentDialogue?: Array<{ role?: string; text?: string }>;
}): RunIntent {
  const { mode } = args;
  const userPrompt = String(args.userPrompt ?? "");
  const forceProceed =
    mode !== "chat" &&
    /(先(直接)?(开始|写|仿写|给一版|给版本|产出|干活)|不要(再)?问|别问了|先做|直接写|继续)/.test(userPrompt);
  // wantsWrite：仅表示“用户明确要把结果写入项目/文件系统”，不要把“生成一篇/生成一份内容”误判为写入意图。
  // 误判会导致 AutoRetryPolicy 以 need_write 卡住，甚至在 allow_readonly 路由里反复触发重试。
  const wantsWrite = (() => {
    if (mode === "chat") return false;
    const t = String(userPrompt ?? "");
    // 目录引用（@{dir/}）通常意味着要写入/落盘到该目录
    if (/@\{[^}]+\/\}/.test(t)) return true;

    const hasWriteTargetHint =
      /@\{[^}]+\}/.test(t) || // 显式引用文件/目录
      /\.(md|mdx|txt)\b/i.test(t) || // 显式文件名
      /(文件|目录|文件夹|路径|path)/i.test(t); // 明确提到“文件/路径”等

    // 明确文件系统动作（需要结合 target hint，避免“生成/删除=删减字数”等误伤）
    const hasFileOpVerb = /(写入|保存|落盘|导出|放到|移动到|迁移到|新建|创建|删除|删掉|移除|重命名|改名)/.test(t);
    if (hasFileOpVerb && hasWriteTargetHint) return true;

    // “生成/输出 到 …”：只有当同时出现明确 target hint 才视为写入意图
    const looksLikeGenerateTo = /(生成|输出).{0,12}(到|至)/.test(t);
    if (looksLikeGenerateTo && hasWriteTargetHint) return true;

    // “生成 md 文件/生成文件”：用户明确在说“落盘成文件”，即便没写“到/至”
    const looksLikeGenerateFile =
      /(生成|输出|导出).{0,16}(?:md|markdown)\s*文件/i.test(t) || /(生成|输出|导出).{0,10}(?:文件|目录|文件夹)/i.test(t);
    if (looksLikeGenerateFile && hasWriteTargetHint) return true;

    // 写@{file}：目标文件写作/改写（最稳）
    if (/(写|仿写|改写|润色|续写|扩写)\s*@\{[^}]+\}/.test(t)) return true;

    return false;
  })();
  const wantsOkOnly =
    mode !== "chat" &&
    /(回(个|我)?\s*ok|回复\s*ok|回\s*ok|只要\s*ok|给我\s*ok)/i.test(userPrompt) &&
    /(不用回别的|别回别的|不要回别的|就行)/.test(userPrompt);
  const isWritingTask =
    mode !== "chat" &&
    (/(仿写|改写|润色|续写|扩写|写(一篇|一段|一条|稿|文|文章|脚本|文案)|写.{0,10}\d{2,5}字|生成(文章|稿|文案)|写.{0,20}(脚本|文案|文章|稿子?|口播|短文)|按.+风格)/.test(userPrompt) ||
      // “写5篇/写3条口播/写10条稿子”等（避免因为不写“一篇”导致误判为非写作）
      /写\s*\d{1,3}\s*(?:篇|条|个|份)\s*(?:[^。！？\n]{0,16})?(?:稿|文稿|稿子|文章|文案|口播|脚本)/.test(userPrompt) ||
      // “生成/输出 md 文件”也应视为写作任务（往往伴随写入）
      /(生成|输出|导出)\s*(?:[^。！？\n]{0,20})?(?:md|markdown)\s*文件/i.test(userPrompt) ||
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
  // 这里在 mainDocIntent=auto 且当前未判为写作任务时，参考 RUN_TODO / MainDoc.workflowV1 / 最近对话 来判断是否应继承“写作闭环”意图。
  if (!mainDocIntent && !isWritingTaskFinal) {
    const todoRaw = Array.isArray(args.runTodo) ? args.runTodo : [];
    const todo = todoRaw.slice(0, 50);
    const promptTrim = String(userPrompt ?? "").trim();
    // 注意：这里的“弱 sticky”只用于承接“写作闭环”的续跑（避免用户回一句“继续/视频脚本”导致写作闭环掉线）。
    // 但不能把“查一下/搜一下/全网+GitHub 大搜”这类研究/检索请求误判为写作（否则会触发 style_imitate 抢跑，污染检索阶段）。
    const looksLikeExplicitContinue = /^(继续|好|可以|行|没问题|确认|按这个来|就这样|ok|OK)\b/i.test(promptTrim);
    // “把稿子放这里/直接输出文稿/贴出来”等：通常是“继续把结果给我”的续跑指令
    const looksLikeDeliverDraft =
      /(直接|就)\s*(生成|输出|给我|发我|贴出|贴出来|放这|放在这|放在这里|发出来|把(?:生成的)?(?:文稿|稿子|文章|文案|口播稿|脚本).{0,6}(?:放在这|放在这里|贴出来|发出来))/i.test(
        promptTrim,
      ) && promptTrim.length <= 80;
    const looksLikeFormatSwitch =
      promptTrim.length <= 24 && /(视频脚本|脚本|文案|口播|小红书|公众号|B站|抖音|标题|大纲|提纲|终稿)/.test(promptTrim);
    const looksLikeResearchOnly =
      /(查(一下)?|查询|搜索|检索|全网|上网|联网|web\.search|web\.fetch|github|资料|来源|链接|引用|证据|大搜|调研|研究)/i.test(promptTrim) &&
      !/(写|仿写|改写|润色|续写|扩写|脚本|文案|终稿|写入)/.test(promptTrim);
    const looksLikeChoice =
      /^写法\s*[ABC]\b/i.test(promptTrim) ||
      /\bcluster[_-]\d+\b/i.test(promptTrim) ||
      /^(?:话题|主题|选项|方案|topic)\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:[号个条项])?\s*(?:吧|呢)?$/i.test(promptTrim) ||
      /^(?:我选|选|就|要)\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:[号个条项])?\s*(?:吧|呢)?$/.test(promptTrim) ||
      /^第?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:个|条|项)\s*(?:吧|呢)?$/.test(promptTrim) ||
      /^(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:号|#)\s*(?:吧|呢)?$/.test(promptTrim) ||
      /^(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:吧|呢)$/.test(promptTrim);
    // 编号回答：典型“1...；2...；3...”用于回复上一轮澄清/确认问题
    const looksLikeNumberedAnswers = (() => {
      if (promptTrim.length > 160) return false;
      // e.g. "1按建议来；2OK；3可以" / "1. A\n2. B"
      const hits = promptTrim.match(/(?:^|[;；\n\r\t ]+)\d{1,2}(?=[^\d\s])/g) ?? [];
      return hits.length >= 2;
    })();
    const shortFollowUpLike =
      (looksLikeExplicitContinue || looksLikeDeliverDraft || looksLikeFormatSwitch || looksLikeChoice || looksLikeNumberedAnswers) &&
      promptTrim.length <= 160 &&
      !looksLikeResearchOnly;
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
      ((/(分析|排查|报错|bug|为什么|怎么修|怎么解决|白屏|崩溃|日志|报错栈)/.test(promptTrim) &&
        !/(写|仿写|改写|润色|脚本|文案|终稿|写入)/.test(promptTrim)) ||
        looksLikeResearchOnly);

    // 续跑证据 A：MainDoc.workflowV1（通用工作流契约）
    const mainDoc = args.mainDoc && typeof args.mainDoc === "object" ? (args.mainDoc as any) : null;
    const wf = mainDoc && (mainDoc as any).workflowV1 && typeof (mainDoc as any).workflowV1 === "object" ? (mainDoc as any).workflowV1 : null;
    const wfStatus = wf ? String((wf as any).status ?? "").trim().toLowerCase() : "";
    const wfIntentHint = wf ? String((wf as any).intentHint ?? (wf as any).stickyIntent ?? "").trim().toLowerCase() : "";
    const wfKind = wf ? String((wf as any).kind ?? "").trim().toLowerCase() : "";
    const wfWaiting = wfStatus === "waiting_user" || wfStatus === "waiting" || wfStatus === "clarify_waiting";
    const wfLooksWriting = ["writing", "rewrite", "polish"].includes(wfIntentHint) || /(style|imitate|writing|rewrite|polish)/.test(wfKind);
    const wfEvidence = wfWaiting && wfLooksWriting;

    // 续跑证据 B：最近对话（上一轮 assistant 明显在问“请选择/请确认”，且语境是写作/仿写）
    const recent = Array.isArray(args.recentDialogue) ? args.recentDialogue : [];
    const lastAssistant = [...recent].reverse().find((m: any) => String(m?.role ?? "") === "assistant" && String(m?.text ?? "").trim());
    const lastAssistantText = lastAssistant ? String((lastAssistant as any).text ?? "").trim() : "";
    const lastAssistantAsking =
      looksLikeClarifyQuestions(lastAssistantText) || /(请选择|请确认|选(一|1)个|从.*选|你选|您选|选哪个|选哪种)/.test(lastAssistantText);
    const lastAssistantLooksWriting =
      /(写|仿写|改写|润色|续写|扩写|文案|脚本|稿|文章|终稿|风格|开头|结尾|金句|收束)/.test(lastAssistantText);
    const dialogueEvidence = lastAssistantAsking && lastAssistantLooksWriting;

    const hasContinuationEvidence = wfEvidence || dialogueEvidence;

    // 1) RUN_TODO 续跑（原逻辑）：todo 明确属于写作闭环
    if (!looksNonWriting && !looksLikeFileOpsTask && todoLooksWriting && (hasWaiting || shortFollowUpLike)) {
      isWritingTaskFinal = true;
    }
    // 2) 无 RUN_TODO 的续跑（新逻辑）：靠 workflowV1 或 recent dialogue 保持写作闭环连续性
    if (!isWritingTaskFinal && !looksNonWriting && !looksLikeFileOpsTask && shortFollowUpLike && hasContinuationEvidence) {
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
  const copyGateEnabled = lintGateEnabled;
  return {
    hasStyleLibrary,
    hasNonStyleLibraries,
    styleLibIds,
    nonStyleLibIds,
    styleLibIdSet: new Set(styleLibIds),
    styleGateEnabled,
    lintGateEnabled,
    copyGateEnabled,
  };
}

export function looksLikeClarifyQuestions(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  // 关键：避免把“叙述性反问/自问自答”（常见于口播文案）误判为“需要用户确认”。
  // 我们只在“明显指向用户的询问/确认/选择”场景下返回 true。
  const directAsk =
    /(请问|是否|能否|方便|要不要|需要你|请确认|确认一下|需要确认|待确认|请选择|请选|你选|您选|你更偏好|更偏好|偏好哪|更偏向|选哪个|选哪种|用哪个)/.test(
      t,
    );
  if (directAsk) return true;

  // 仅有问号：只有在“短句 + 指向你/您 + 以问号结尾”时才视为澄清（避免口播里的“你说对不对？”之类）。
  const hasQ = /[?？]/.test(t);
  if (!hasQ) return false;
  const endsQ = /[?？]\s*$/.test(t);
  const hasYou = /(你|您)/.test(t);
  const isShort = t.length <= 120;
  return Boolean(endsQ && hasYou && isShort);
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
  // V2：templates 阶段只认 “模板/规则卡”（card），不把原文段落当“样例”喂给模型
  if (kind !== "card") return false;

  const cardTypes = normalizeIdList((a as any)?.cardTypes);
  // V2：必须显式限制 cardTypes，确保拿到的是“模板/规则卡”，避免误把其它卡当风格样例
  if (!cardTypes.length) return false;

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
  const normIds = (v: any) => (Array.isArray(v) ? v.map((x: any) => String(x ?? "").trim()).filter(Boolean).slice(0, 16) : []);
  const expectedDimensions = normIds(o?.expectedDimensions);
  const coveredDimensions = normIds(o?.coveredDimensions);
  const missingDimensions = normIds(o?.missingDimensions);
  return { score, highIssues, summary, rewritePrompt, expectedDimensions, coveredDimensions, missingDimensions, modelUsed, usedHeuristic };
}

export type AutoRetryAnalysis = {
  shouldRetry: boolean;
  isEmpty: boolean;
  isFIMLeak: boolean;
  isClarify: boolean;
  needTodo: boolean;
  needFinalText: boolean;
  reasons: string[];
};

/**
 * AutoRetry — error recovery only.
 *
 * Checks for genuine errors (empty output, FIM leak) and optional todo enforcement.
 * Workflow enforcement (kb → draft → lint → write) is removed — that guidance
 * now lives in skill-level promptFragments (e.g. STYLE_IMITATE_SKILL).
 */
export function analyzeAutoRetryText(args: {
  assistantText: string;
  intent: RunIntent;
  gates: RunGates;
  state: RunState;
  lintMaxRework: number;
  targetChars?: number | null;
  todoPolicy?: "skip" | "optional" | "required";
}) : AutoRetryAnalysis {
  const t = String(args.assistantText ?? "").trim();
  const isEmpty = t.length === 0;
  const isFIMLeak = looksLikeFIMLeak(args.assistantText);
  const isClarify = looksLikeClarifyQuestions(t) && !args.intent.forceProceed && !looksLikeDraftText(t);

  const todoPolicy: "skip" | "optional" | "required" = args.todoPolicy ?? "required";
  const needTodo = todoPolicy === "required" && !args.state.hasTodoList && !args.intent.wantsOkOnly;
  const needFinalText = isEmpty && !needTodo;

  const reasons: string[] = [];
  if (isFIMLeak) reasons.push("模型输出异常(FIM token)");
  else if (isEmpty) reasons.push("输出为空");
  if (needFinalText) reasons.push("缺少最终回复");
  if (needTodo) reasons.push("Todo 未设置");

  const shouldRetry = isFIMLeak || isEmpty || needTodo;
  return {
    shouldRetry,
    isEmpty,
    isFIMLeak,
    isClarify,
    needTodo,
    needFinalText,
    reasons,
  };
}

export type StyleWorkflowBatchAnalysis = {
  shouldEnforce: boolean;
  violation: string | null;
  batchHasWrite: boolean;
  batchHasKb: boolean;
  batchHasCopyLint: boolean;
  batchHasLint: boolean;
  batchHasStyleKb: boolean;
  needStyleKb: boolean;
  needDraftText: boolean;
  enforceCopy: boolean;
  copyExhausted: boolean;
  needCopyLint: boolean;
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
  const batchHasCopyLint = toolCalls.some((c: any) => String(c?.name ?? "") === "lint.copy");
  const batchHasLint = toolCalls.some((c: any) => String(c?.name ?? "") === "lint.style");
  const batchHasStyleKb = toolCalls.some((c: any) =>
    isStyleExampleKbSearch({ call: c, styleLibIdSet: args.gates.styleLibIdSet, hasNonStyleLibraries: args.gates.hasNonStyleLibraries }),
  );

  const shouldEnforce = args.intent.isWritingTask || batchHasWrite || batchHasLint || batchHasCopyLint;
  const needStyleKb = !args.state.hasStyleKbSearch;
  const needDraftText =
    args.gates.styleGateEnabled &&
    args.gates.lintGateEnabled &&
    args.state.hasStyleKbSearch &&
    !args.state.hasDraftText &&
    args.intent.isWritingTask;
  const enforceCopy = args.gates.copyGateEnabled === true;
  const copyExhausted = enforceCopy && !args.state.copyLintPassed && args.state.copyLintFailCount > args.lintMaxRework;
  const needCopyLint = enforceCopy && !args.state.copyLintPassed;
  // 是否“强制要求 lint”：由 gates.lintGateEnabled 统一控制（Gateway 可根据产品策略选择 hint/gate）
  const enforceLint = args.gates.lintGateEnabled === true;
  const lintExhausted = enforceLint && !args.state.styleLintPassed && args.state.styleLintFailCount > args.lintMaxRework;
  const needStyleLint = enforceLint && !args.state.styleLintPassed;

  let violation: string | null = null;
  // 关键约束：
  // - kb.search 的 tool_result 必须先回传给模型后，后续写入/对齐才可能“真正用上样例”，因此仍禁止与 write/lint 同回合混用
  // - lint.style 在 lintMode=hint 时只是“提示”，不应作为硬闸门阻止写入；因此仅当 enforceLint=true（gate 模式）才禁止 lint+write 同回合
  if (batchHasKb && batchHasCopyLint) violation = "KB_AND_COPY_SAME_TURN";
  else if (batchHasKb && batchHasLint) violation = "KB_AND_LINT_SAME_TURN";
  else if (batchHasKb && batchHasWrite) violation = "KB_AND_WRITE_SAME_TURN";
  else if (batchHasCopyLint && batchHasLint) violation = "COPY_AND_LINT_SAME_TURN";
  else if (batchHasCopyLint && batchHasWrite) violation = "COPY_AND_WRITE_SAME_TURN";
  else if (batchHasLint && batchHasWrite && enforceLint) violation = "LINT_AND_WRITE_SAME_TURN";
  else if (batchHasCopyLint && needStyleKb) violation = "COPY_BEFORE_KB";
  else if (batchHasLint && needStyleKb) violation = "LINT_BEFORE_KB";
  else if (batchHasWrite && needStyleKb) violation = "WRITE_BEFORE_KB";
  else if (batchHasCopyLint && needDraftText) violation = "COPY_BEFORE_DRAFT";
  else if (batchHasLint && needDraftText) violation = "LINT_BEFORE_DRAFT";
  else if (batchHasWrite && needDraftText) violation = "WRITE_BEFORE_DRAFT";
  else if (batchHasLint && needCopyLint) violation = copyExhausted ? "LINT_BLOCKED_COPY_EXHAUSTED" : "LINT_BEFORE_COPY_PASS";
  else if (batchHasWrite && needCopyLint) violation = copyExhausted ? "WRITE_BLOCKED_COPY_EXHAUSTED" : "WRITE_BEFORE_COPY_PASS";
  else if (batchHasWrite && needStyleLint) violation = lintExhausted ? "WRITE_BLOCKED_LINT_EXHAUSTED" : "WRITE_BEFORE_LINT_PASS";
  else if (batchHasKb && needStyleKb && !batchHasStyleKb) violation = "KB_NOT_STYLE_EXAMPLES";

  return {
    shouldEnforce,
    violation,
    batchHasWrite,
    batchHasKb,
    batchHasCopyLint,
    batchHasLint,
    batchHasStyleKb,
    needStyleKb,
    needDraftText,
    enforceCopy,
    copyExhausted,
    needCopyLint,
    enforceLint,
    lintExhausted,
    needStyleLint,
  };
}

export function isProposalWaitingMeta(meta: any): boolean {
  const m: any = meta && typeof meta === "object" ? meta : null;
  return Boolean(m && String(m.applyPolicy ?? "") === "proposal" && m.hasApply === true);
}

