import type { AgentMode } from "./index.js";
import { detectRunIntent, type KbSelectedLibrary, type RunIntent } from "./runMachine.js";

export type TriggerWhen = "has_style_library" | "run_intent_in" | "mode_in" | "text_regex";

export type TriggerRule = {
  when: TriggerWhen;
  args: Record<string, unknown>;
};

/**
 * Skill 级 MCP Server 声明（外部扩展包热加载用）。
 * - stdio: `entry` 为相对 skill 目录的入口脚本（.mjs/.cjs）
 * - streamable-http / sse: `endpoint` 为服务地址
 * - 运行时由 Desktop 主进程映射为 McpManager 的 server 配置
 */
export type SkillMcpConfig = {
  serverId: string;
  name?: string;
  transport: "stdio" | "streamable-http" | "sse";
  /** stdio 专用：相对 skill 目录的入口脚本路径 */
  entry?: string;
  /** http/sse 专用：服务端点 URL */
  endpoint?: string;
  /** 可选环境变量 */
  env?: Record<string, string>;
};

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  priority: number;
  stageKey: string;
  autoEnable: boolean;
  triggers: TriggerRule[];
  promptFragments: { system?: string; context?: string };
  policies: string[];
  toolCaps?: { allowTools?: string[]; denyTools?: string[] };
  /** 语义化版本号（如 "1.0.0"），用于后续配置化加载时的版本管理 */
  version?: string;
  /** 与本 Skill 冲突的 Skill ID 列表（互斥，不能同时激活） */
  conflicts?: string[];
  /** 本 Skill 依赖的前置 Skill ID 列表（须先激活） */
  requires?: string[];
  /** 来源标记 */
  source?: "builtin" | "standard" | "user" | "admin";
  /** 可选：该 Skill 自带的 MCP Server 声明 */
  mcp?: SkillMcpConfig;
  ui: { badge: string; color?: string };
};

export type ActiveSkill = {
  id: string;
  name: string;
  stageKey: string;
  badge: string;
  activatedBy: { reasonCodes: string[]; detail?: Record<string, unknown> };
};

function normStr(v: unknown) {
  return String(v ?? "").trim();
}

function normLower(v: unknown) {
  return normStr(v).toLowerCase();
}

function normalizeStringArray(v: unknown) {
  if (Array.isArray(v)) return v.map(normStr).filter(Boolean);
  return [];
}

function computeStyleLibIds(kbSelected: KbSelectedLibrary[]) {
  return (kbSelected ?? [])
    .filter((l: any) => normStr(l?.purpose) === "style")
    .map((l: any) => normStr(l?.id))
    .filter(Boolean);
}

function matchRunIntentRule(args: { intents: string[]; mainDocRunIntent?: unknown; intent: RunIntent }) {
  const intents = args.intents.map(normLower).filter(Boolean);
  const set = new Set(intents);
  const raw = normLower(args.mainDocRunIntent);
  const main = raw === "auto" ? "" : raw;
  const wantsWriting = ["writing", "rewrite", "polish"].some((x) => set.has(x));
  const wantsNonWriting = ["analysis", "ops"].some((x) => set.has(x));

  // MainDoc/UI 显式意图：优先级最高
  if (main && set.has(main)) {
    return { ok: true, reasonCodes: [`trigger:run_intent_in:${main}`], detail: { mainDocRunIntent: main } };
  }

  // MainDoc=auto：回退到启发式（detectRunIntent 里已做了“analysis/ops 强制关写作意图”的修正）
  if (!main) {
    if (wantsWriting && args.intent.isWritingTask) {
      return {
        ok: true,
        reasonCodes: ["trigger:run_intent_in:auto->writing_task"],
        detail: { mainDocRunIntent: "auto", isWritingTask: true },
      };
    }
    if (wantsNonWriting && !args.intent.isWritingTask) {
      return {
        ok: true,
        reasonCodes: ["trigger:run_intent_in:auto->non_writing_task"],
        detail: { mainDocRunIntent: "auto", isWritingTask: false },
      };
    }
  }

  return { ok: false, reasonCodes: ["trigger:run_intent_in:not_match"], detail: { mainDocRunIntent: main || "auto" } };
}

function matchTrigger(args: {
  rule: TriggerRule;
  mode: AgentMode;
  userPrompt: string;
  mainDocRunIntent?: unknown;
  intent: RunIntent;
  kbSelected: KbSelectedLibrary[];
}) {
  const when = args.rule.when;
  const a = (args.rule.args ?? {}) as any;

  if (when === "mode_in") {
    const modes = normalizeStringArray(a?.modes).map(normLower);
    const ok = modes.length ? modes.includes(args.mode) : true;
    return { ok, reasonCodes: ok ? [`trigger:mode_in:${args.mode}`] : ["trigger:mode_in:not_match"], detail: { modes } };
  }

  if (when === "text_regex") {
    const pattern = normStr(a?.pattern);
    if (!pattern) return { ok: true, reasonCodes: ["trigger:text_regex:empty"], detail: {} };
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    if (!re) return { ok: false, reasonCodes: ["trigger:text_regex:invalid"], detail: { pattern } };
    const ok = re.test(normStr(args.userPrompt));
    return { ok, reasonCodes: ok ? ["trigger:text_regex:match"] : ["trigger:text_regex:not_match"], detail: { pattern } };
  }

  if (when === "has_style_library") {
    const purpose = normStr(a?.purpose) || "style";
    const styleLibIds = computeStyleLibIds(args.kbSelected);
    const ok = purpose === "style" ? styleLibIds.length > 0 : false;
    return {
      ok,
      reasonCodes: ok ? ["trigger:has_style_library"] : ["trigger:has_style_library:false"],
      detail: { purpose, styleLibIds, styleLibCount: styleLibIds.length },
    };
  }

  if (when === "run_intent_in") {
    const intents = normalizeStringArray(a?.intents);
    const r = matchRunIntentRule({ intents, mainDocRunIntent: args.mainDocRunIntent, intent: args.intent });
    return { ok: r.ok, reasonCodes: r.reasonCodes, detail: { ...r.detail, intents } };
  }

  return { ok: false, reasonCodes: ["trigger:unknown"], detail: { when } };
}

export const STYLE_IMITATE_SKILL: SkillManifest = {
  id: "style_imitate",
  name: "风格仿写闭环",
  description: "绑定风格库后，仅在写作/改写/润色意图下自动启用：先检索样例→再 lint.style→最后允许写入（支持降级/跳过）。",
  priority: 100,
  stageKey: "agent.skill.style_imitate",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    { when: "has_style_library", args: { purpose: "style" } },
    { when: "run_intent_in", args: { intents: ["writing", "rewrite", "polish"] } },
  ],
  promptFragments: {
    system:
      "当 skill=style_imitate 激活时：\n" +
      "0) 若 Context Pack 提供 KB_STYLE_CLUSTERS(JSON)（写法候选/子簇）或 STYLE_SELECTOR(JSON)：请在输出开头用 1–2 句说明“本次默认采用的写法”（selectedClusterId/label），并列出另外 1–2 个备选写法（带 clusterId/label + 1 句代表证据 + 2~3 个关键数字口径）。不要停下来等用户确认：默认按推荐/已选写法继续写作；用户可随时改口切换。\n" +
      "1) 若 Main Doc 尚未写入 styleContractV1（或用户改口要求切写法），再调用 run.mainDoc.update 写入/更新 mainDoc.styleContractV1（短 JSON：{v,libraryId,selectedCluster{id,label},anchors,evidence,softRanges,facetPlan,updatedAt}）。若 Main Doc 已有且用户未要求变更，则不要重复写入。\n" +
      "2) 若提供 STYLE_DIMENSIONS(JSON)：\n" +
      "- mustApply.facetIds 为 MUST，必须覆盖（每个至少落地一次），不要自行扩展到全部维度；\n" +
      "- shouldApply.softRanges 为 SHOULD，尽量贴近统计指纹（句长/问句率/人称密度等）；\n" +
      "- mayApply.cardTypesHint 仅用于检索素材（可选）。\n" +
      "3) 若提供 STYLE_SELECTOR(JSON)：必须把 selectedFacetIds/selectedFacets 当作本次要执行的”维度卡子集”（只执行这些卡，不要自行扩展到全部维度）。若同时提供 STYLE_DIMENSIONS(JSON)，以 mustApply.facetIds 为准；若同时提供 STYLE_FACETS_SELECTED(Markdown)，优先按其卡片内容执行；并对每张入选 facet 结合 kbQueries（或 facetId+话题）用 kb.search 拉样例/证据再落笔。\n" +
      "4) 单篇写作建议走“两段式检索”：\n" +
      "- 第一段（写前）：kb.search 拉规则卡/结构骨架/开头钩子/结尾收束（kind=card + 显式 cardTypes）。\n" +
      "- 第二段（初稿后）：再 kb.search 拉金句/收束模板（one_liner/ending），把 punchline 与收尾补齐后再进入 lint。\n" +
      "5) 写作时必须先 kb.search（只搜风格库）拉样例/模板：优先 kind=card（hook/one_liner/outline/thesis/ending 等），不要一上来就用 kind=paragraph 大范围捞原文段落当样例。\n" +
      "6) 反贴原文要求（必须遵守）：\n" +
      "- 不要复制原文的句子/段落；任何明显的逐句改写/近似复述都视为失败。\n" +
      "- 在“不新增事实”的前提下，必须做结构与表达的再创作：重排段落、改句式、换衔接、换比喻/类比、把数字堆砌改成叙事化解释。\n" +
      "- 如需引用原文中的专有名词/关键结论：只保留“必要短语”，不要出现长串连续复用。\n" +
      "7) lint.style 用于”提示/审计/问题清单”：未通过时必须按 rewritePrompt 回炉改写并复检；不要把分数当成唯一门禁导致卡死。",
    context: "ACTIVE_SKILLS: style_imitate（原因见 reasonCodes；UI 需可见）",
  },
  policies: ["StyleGatePolicy", "AutoRetryPolicy"],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "STYLE", color: "blue" },
};

export const WEB_TOPIC_RADAR_SKILL: SkillManifest = {
  id: "web_topic_radar",
  name: "全网热点雷达",
  description: "全网热点/新闻/选题调研：强调多轮搜索、多域抓取和话题广度，收集阶段不注入风格，避免风格抢跑。",
  priority: 110,
  stageKey: "agent.skill.web_topic_radar",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    {
      when: "text_regex",
      args: {
        pattern:
          // A) 直接关键词
          "(?:热点|新闻|雷达|选题|找素材|盘点)|" +
          // B) "全网" + 搜索/检索/调研/大搜
          "(?:全网[\\s\\S]{0,4}(?:搜索|检索|调研|大搜|搜))|" +
          // C) 调研/查资料/搜资料
          "(?:调研|查资料|搜资料|大搜)|" +
          // D) GitHub 调研（不区分大小写的中文语境匹配）
          "(?:github|GitHub)[\\s\\S]{0,8}(?:搜|查|调研|找)",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=web_topic_radar 激活时（全网热点雷达）：\n" +
      "1) 本任务是「先收集后结论」，收集阶段不要写成稿，不注入风格化表达。\n" +
      "2) 必须进行多轮搜索：web.search >= 3 次，且 query 需要有明显差异（主题/时间窗/角度）。\n" +
      "3) 必须进行多域抓取：web.fetch >= 5 次，且尽量覆盖 >= 5 个不同域名。\n" +
      "4) 最终盘点话题广度 >= 15 条；每条至少包含：话题名、1 句判断、URL 证据。\n" +
      "5) Todo 必须完整可追踪：搜索轮次、抓取覆盖、话题去重、最终盘点四类步骤都要有。\n" +
      "6) 搜索前必须先调用 time.now 获取当前时间，query 以当年为准。",
    context: "ACTIVE_SKILLS: web_topic_radar（全网热点雷达/选题调研）",
  },
  policies: ["WebRadarPolicy", "WebGatePolicy"],
  conflicts: ["style_imitate"],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "RADAR", color: "purple" },
};

export const WRITING_MULTI_SKILL: SkillManifest = {
  id: "writing_multi",
  name: "小规模多篇",
  description: "2-9 篇的小规模多篇写作：按篇拆解、逐篇完成、每篇走完整写作闭环。",
  priority: 120,
  stageKey: "agent.skill.writing_multi",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    {
      when: "text_regex",
      args: {
        pattern:
          // A) 阿拉伯数字 2-9 + 篇
          "(?:^|\\D)(?:[2-9])\\s*篇|" +
          // B) 中文数字 + 篇
          "(?:[二三四五六七八九两])\\s*篇|" +
          // C) 直接关键词
          "(?:多篇|几篇)",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=writing_multi 激活时（2-9 篇多篇写作）：\n" +
      "1) 按「每篇一个子任务」执行，不要一次性混写多篇。\n" +
      "2) 每篇都要有独立 Todo 条目，并在完成后单独勾选/更新进度。\n" +
      "3) 单篇必须走完整写作闭环：需求确认→资料/结构→初稿→润色→交付。\n" +
      "4) 完成一篇再进入下一篇，保持可回溯与可验收。\n" +
      "5) 若绑定了风格库，每篇独立走 kb.search + lint.style 闭环。",
    context: "ACTIVE_SKILLS: writing_multi（小规模多篇 2-9 篇）",
  },
  policies: [],
  conflicts: ["writing_batch"],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "MULTI", color: "orange" },
};

export const WRITING_BATCH_SKILL: SkillManifest = {
  id: "writing_batch",
  name: "批量写作长跑",
  description: ">=10 篇批量写作：通过 writing.batch.* 工具族分片执行并持续追踪进度。",
  priority: 130,
  stageKey: "agent.skill.writing_batch",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    {
      when: "text_regex",
      args: {
        pattern:
          // A) 阿拉伯数字 >=10 + 篇
          "(?:[1-9]\\d+)\\s*篇|" +
          // B) 中文数字十以上 + 篇
          "(?:十|[二三四五六七八九]十[\\s\\S]?)\\s*篇|" +
          // C) 直接关键词
          "(?:批量|大批|大量)[\\s\\S]{0,6}(?:写|生成|产出|创作)",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=writing_batch 激活时（>=10 篇批量写作）：\n" +
      "1) 优先使用 writing.batch.* 工具族（create/status/pause/resume/cancel），不在单次 run 内硬写全部。\n" +
      "2) 采用分片执行（按主题/文件夹/批次），每片可独立重试与恢复。\n" +
      "3) 持续做进度追踪：汇报 jobId、完成数/失败数/跳过数、下一步动作。\n" +
      "4) 每片内的单篇仍走写作闭环，但简化交互（无需逐篇确认）。\n" +
      "5) 若绑定风格库，批量写作共用同一个 styleContract，不必每篇重新选写法。",
    context: "ACTIVE_SKILLS: writing_batch（批量写作长跑 >=10 篇）",
  },
  policies: [],
  conflicts: ["writing_multi"],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "BATCH", color: "red" },
};

export const CORPUS_INGEST_SKILL: SkillManifest = {
  id: "corpus_ingest",
  name: "语料导入与抽卡",
  description:
    "当用户给出文本/文件/URL 并要求抽卡、学风格或分析文风时，自动完成导入语料→抽卡入库→可选生成手册。",
  priority: 90,
  stageKey: "agent.skill.corpus_ingest",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    {
      when: "text_regex",
      args: {
        pattern:
          // A) 直接关键词
          "(?:抽卡)|" +
          // B) "学/分析/提取/模仿" + 风格/写法/文风/语气
          "(?:学|分析|提取|模仿|研究|拆解)[\\s\\S]{0,12}(?:风格|写法|文风|语气|笔法)|" +
          // C) 风格/写法 + "学/分析"（反序）
          "(?:风格|写法|文风|语气|笔法)[\\s\\S]{0,12}(?:学习|分析|提取|模仿|研究|拆解)|" +
          // D) "导入" + 语料/素材/风格库/知识库
          "(?:导入|上传|添加)[\\s\\S]{0,12}(?:语料|素材|风格库|知识库|样本)|" +
          // E) "学习这篇/这段/他的/她的" + 风格/写法
          "(?:学习|分析)[\\s\\S]{0,6}(?:这篇|这段|这个|他的|她的|它的)[\\s\\S]{0,12}(?:风格|写法|文风|语气)|" +
          // F) "语料/素材" + "入库/建库"
          "(?:语料|素材|风格)[\\s\\S]{0,6}(?:入库|建库)|" +
          // G) "新建" + 风格库/知识库
          "新建[\\s\\S]{0,6}(?:风格库|知识库|素材库)|" +
          // H) 显式工具调用
          "kb\\.ingest",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=corpus_ingest 激活时（语料导入与抽卡）：\n" +
      "1) 你的团队中有「学习专员」(learning_specialist)，所有语料导入和抽卡任务都委派给它。\n" +
      "2) 使用 agent.delegate 委派：\n" +
      "   - agentId: \"learning_specialist\"\n" +
      "   - task: 包含用户原始请求及语料来源信息（文本/文件/URL）\n" +
      "   - 如用户指定了库名，在 task 中说明\n" +
      "   - 如用户提供了大段文本，直接在 task 中完整传递，不要截断\n" +
      "3) 学习专员返回结果后，向用户汇报：\n" +
      "   - 导入了多少文档、抽卡已在后台进行\n" +
      "   - 用户可在输入框 @ 提及库名来在写作时使用\n" +
      "4) 若用户在同一 run 里接着要求写作：直接进入写作流程。",
    context: "ACTIVE_SKILLS: corpus_ingest（语料导入与抽卡 → 委派学习专员）",
  },
  policies: [],
  toolCaps: {
    allowTools: [
      "agent.delegate",
      "run.setTodoList",
      "run.todo.upsertMany",
      "run.todo.update",
      "run.done",
    ],
  },
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "INGEST", color: "green" },
};

// ── Skill 注册表 ──────────────────────────────────────────────

const BUILTIN_MANIFESTS: SkillManifest[] = [
  WRITING_BATCH_SKILL,
  WRITING_MULTI_SKILL,
  WEB_TOPIC_RADAR_SKILL,
  STYLE_IMITATE_SKILL,
  CORPUS_INGEST_SKILL,
];

export type RegisterSkillOptions = { replace?: boolean };

export class SkillRegistry {
  private readonly map = new Map<string, SkillManifest>();

  register(manifest: SkillManifest, opts?: RegisterSkillOptions): void {
    const id = normStr(manifest?.id);
    if (!id) throw new Error("SKILL_ID_REQUIRED");
    if (!normStr(manifest?.name)) throw new Error(`SKILL_NAME_REQUIRED:${id}`);
    if (this.map.has(id) && !opts?.replace) throw new Error(`SKILL_ALREADY_REGISTERED:${id}`);
    // 浅拷贝存储，防止外部修改
    this.map.set(id, { ...manifest, id });
  }

  unregister(id: string): boolean {
    return this.map.delete(normStr(id));
  }

  get(id: string): SkillManifest | undefined {
    return this.map.get(normStr(id));
  }

  /** 获取所有已注册 Skill（按 priority 降序） */
  getAll(): SkillManifest[] {
    return [...this.map.values()].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)),
    );
  }

  /** 获取所有 autoEnable=true 的 Skill */
  getEnabled(): SkillManifest[] {
    return this.getAll().filter((m) => m.autoEnable);
  }
}

/** 全局唯一 Skill 注册表实例 */
export const skillRegistry = new SkillRegistry();

// 内置 Skill 自动注册
for (const m of BUILTIN_MANIFESTS) {
  skillRegistry.register({ ...m, source: m.source ?? "builtin" }, { replace: true });
}

/** 获取所有已注册 Skill（兼容旧调用方） */
export function listRegisteredSkills(): SkillManifest[] {
  return skillRegistry.getAll();
}

// 兼容旧引用
export const SKILL_MANIFESTS_V1: SkillManifest[] = BUILTIN_MANIFESTS.map((m) => ({ ...m }));

export function activateSkills(args: {
  mode: AgentMode;
  userPrompt?: string;
  mainDocRunIntent?: unknown;
  kbSelected?: KbSelectedLibrary[];
  intent?: RunIntent;
  manifests?: SkillManifest[];
}): ActiveSkill[] {
  const mode = args.mode;
  const userPrompt = normStr(args.userPrompt);
  const kbSelected = Array.isArray(args.kbSelected) ? (args.kbSelected as any[]) : [];
  const intent = args.intent ?? detectRunIntent({ mode, userPrompt, mainDocRunIntent: args.mainDocRunIntent });
  const manifests = args.manifests?.length ? args.manifests : listRegisteredSkills();

  // 按 priority 降序排序后再迭代，确保高优先级 Skill 优先激活（影响 conflicts 裁决）
  const sorted = [...manifests].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)),
  );

  const out: Array<{ m: SkillManifest; s: ActiveSkill }> = [];
  const activeSkillIds = new Set<string>();
  const blockedByConflict = new Set<string>();
  for (const m of sorted) {
    if (!m?.autoEnable) continue;
    const skillId = normStr(m.id);
    if (!skillId) continue;
    // conflicts 互斥：被已激活 Skill 声明为冲突的，或自身声明与已激活 Skill 冲突的，跳过
    if (blockedByConflict.has(skillId)) continue;
    const conflicts = normalizeStringArray(m.conflicts);
    if (conflicts.some((id) => activeSkillIds.has(id))) continue;
    // requires 依赖：前置 Skill 必须已激活
    const requires = normalizeStringArray(m.requires);
    if (requires.length && !requires.every((id) => activeSkillIds.has(id))) continue;

    const reasonCodes: string[] = [`skill:${m.id}`];
    const detail: Record<string, unknown> = { stageKey: m.stageKey };
    let ok = true;
    for (const rule of m.triggers ?? []) {
      const r = matchTrigger({
        rule,
        mode,
        userPrompt,
        mainDocRunIntent: args.mainDocRunIntent,
        intent,
        kbSelected: kbSelected as any,
      });
      if (r.reasonCodes?.length) reasonCodes.push(...r.reasonCodes);
      if (r.detail && Object.keys(r.detail).length) detail[`trigger:${rule.when}`] = r.detail;
      if (!r.ok) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    activeSkillIds.add(skillId);
    for (const cid of conflicts) blockedByConflict.add(cid);
    out.push({
      m,
      s: {
        id: m.id,
        name: m.name,
        stageKey: m.stageKey,
        badge: m.ui?.badge || m.id.toUpperCase(),
        activatedBy: { reasonCodes: reasonCodes.slice(0, 32), detail },
      },
    });
  }
  // 迭代前已按 priority 排序，无需再排
  return out.map((x) => x.s);
}

export function pickSkillStageKeyForAgentRun(activeSkills: ActiveSkill[], fallback = "agent.run") {
  const first = Array.isArray(activeSkills) && activeSkills.length ? activeSkills[0] : null;
  const k = first?.stageKey ? normStr(first.stageKey) : "";
  return k || fallback;
}

export function parseActiveSkillsFromContextPack(ctx?: string): ActiveSkill[] {
  const text = String(ctx ?? "");
  if (!text) return [];
  const m = text.match(/ACTIVE_SKILLS\(JSON\):\n([\s\S]*?)\n\n/);
  const raw = m?.[1] ? String(m[1]).trim() : "";
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? (j as any[]) : [];
  } catch {
    return [];
  }
}

export type SkillConfigOverride = {
  /** 仅 enabled 可覆盖（映射到 autoEnable） */
  enabled?: boolean;
};

export type SkillConfig = {
  /** 对内置 Skill 的覆盖（key=skillId） */
  builtinOverrides?: Record<string, SkillConfigOverride>;
  /** 标准 Skill 包（已由调用方解析好的 SkillManifest 数组列表） */
  standardPacks?: SkillManifest[][];
  /** 用户自定义 Skill */
  userSkills?: SkillManifest[];
};

export function mergeSkillManifests(config?: SkillConfig): SkillManifest[] {
  // 1) builtin 基座（浅拷贝）
  const builtin = SKILL_MANIFESTS_V1.map((m) => ({ ...m }));
  const builtinIds = new Set(builtin.map((m) => normStr(m.id)).filter(Boolean));

  // 2) builtinOverrides：只改 autoEnable
  const overrides = config?.builtinOverrides ?? {};
  for (const m of builtin) {
    const o = overrides[normStr(m.id)];
    if (typeof o?.enabled === "boolean") {
      m.autoEnable = o.enabled;
    }
  }

  // 3) standardPacks：flat -> 过滤 builtin 同 id -> 标记 source="standard" -> 同 id 后入覆盖先入
  const standardMap = new Map<string, SkillManifest>();
  for (const pack of config?.standardPacks ?? []) {
    if (!Array.isArray(pack)) continue;
    for (const m of pack) {
      const id = normStr(m?.id);
      if (!id || builtinIds.has(id) || !normStr(m?.name)) continue;
      standardMap.set(id, { ...m, source: "standard" });
    }
  }

  // 4) userSkills：过滤 builtin 同 id -> 标记 source="user" -> 同 id 覆盖 standard
  const userMap = new Map<string, SkillManifest>();
  for (const m of config?.userSkills ?? []) {
    const id = normStr(m?.id);
    if (!id || builtinIds.has(id) || !normStr(m?.name)) continue;
    userMap.set(id, { ...m, source: "user" });
  }

  // standard 去掉被 user 覆盖的
  for (const id of userMap.keys()) {
    standardMap.delete(id);
  }

  // 5) 合并返回
  return [...builtin, ...standardMap.values(), ...userMap.values()];
}
