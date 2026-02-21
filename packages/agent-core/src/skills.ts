import type { AgentMode } from "./index.js";
import { detectRunIntent, type KbSelectedLibrary, type RunIntent } from "./runMachine.js";

export type TriggerWhen = "has_style_library" | "run_intent_in" | "mode_in" | "text_regex";

export type TriggerRule = {
  when: TriggerWhen;
  args: Record<string, unknown>;
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
  name: "全网热点/素材雷达",
  description:
    "面向“热点/新闻/找素材/盘点选题/全网+GitHub 调研”：以广度优先收集候选话题/资料与证据链接，避免过早收敛到 Top 3。",
  priority: 110,
  stageKey: "agent.skill.web_topic_radar",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    {
      when: "text_regex",
      args: {
        // 仅在“明显是热点/新闻/素材盘点（偏广度）”时触发：
        // - 允许用户不写“搜索”二字（例如“今天AI圈财经圈热点盘点”）
        // - 但尽量避免“整理这篇新闻/写一篇新闻评论”这类编辑任务误触发
        pattern:
          // A) 显式“去搜/联网” + 热点/新闻
          "(?:搜索|检索|搜一下|查找|上网|全网|联网|web\\.search|web\\.fetch)[\\s\\S]{0,80}(?:热点|新闻|时事|实时|最新|今日|今天|快讯|资讯|盘点|汇总|整理|选题|话题|方向|素材|雷达)|" +
          // B) 热点/新闻 + 显式“去搜/联网”
          "(?:热点|新闻|时事|实时|最新|今日|今天|快讯|资讯|盘点|汇总|整理|选题|话题|方向|素材|雷达)[\\s\\S]{0,80}(?:搜索|检索|搜一下|查找|上网|全网|联网|web\\.search|web\\.fetch)|" +
          // C) “盘点/选题/素材/雷达” + 时间敏感/热点信号（不要求出现“搜索”）
          "(?:盘点|汇总|整理|列表|清单|选题|话题|方向|素材|雷达)[\\s\\S]{0,80}(?:今天|今日|最新|最近|实时|快讯|资讯|热点|新闻|时事)|" +
          // D) 时间敏感/热点信号 + “盘点/选题/素材/雷达”
          "(?:今天|今日|最新|最近|实时|快讯|资讯|热点|新闻|时事)[\\s\\S]{0,80}(?:盘点|汇总|整理|列表|清单|选题|话题|方向|素材|雷达)|" +
          // E) “全网/GitHub 大搜/查资料/调研”类（不要求热点词）
          "(?:全网|上网|联网|github|web\\.search|web\\.fetch)[\\s\\S]{0,80}(?:大搜|搜索|检索|搜一下|查找|查一下|调研|研究|最佳实践|方案|怎么解决|如何解决)|" +
          // F) 反向：研究动词 + “全网/GitHub”
          "(?:大搜|搜索|检索|搜一下|查找|查一下|调研|研究|最佳实践|方案|怎么解决|如何解决)[\\s\\S]{0,80}(?:全网|上网|联网|github|web\\.search|web\\.fetch)",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=web_topic_radar 激活时（全网热点/素材盘点）：\n" +
      "- 目标是“广度优先”：先把候选话题池铺开，不要默认只选 Top 3 就开始写成稿。\n" +
      "- 若用户未指定条数：默认给出 >=15 条候选话题（可更多），并去重（同一事件/同一来源不重复）。\n" +
      "- 工具策略（默认配额）：至少 3 轮 web.search（不同关键词/角度），并至少 5 次 web.fetch 抓正文证据；引用必须带 url。\n" +
      "- 输出形态：优先产出“热点/选题盘点报告”（多条话题 + 观点角度 + 证据链接），必要时再给“下一步深挖建议”。\n" +
      "- 若同时绑定风格库：在完成素材/话题盘点前，不要用风格库的写作套路抢跑成稿；等用户明确要写/定稿再进入风格闭环。",
    context: "ACTIVE_SKILLS: web_topic_radar（广度优先：热点/新闻/素材盘点）",
  },
  policies: [],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "WEB", color: "purple" },
};

export const WRITING_BATCH_SKILL: SkillManifest = {
  id: "writing_batch",
  name: "批量写作长跑",
  description:
    "当用户明确要大规模批量生成（>=10 篇、按文件夹/目录、长期运行）时自动启用：强制走 writing.batch.* 工具启动后台队列，避免单次 Run 中断。",
  priority: 130,
  stageKey: "agent.skill.writing_batch",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    { when: "run_intent_in", args: { intents: ["writing", "rewrite", "polish"] } },
    {
      when: "text_regex",
      args: {
        // 仅在"明确大规模批量"时触发（避免误伤小规模拆分/单篇写作）
        // - 移除 "多篇/多条"（太宽泛，容易误触发）
        // - 数字门槛从 5 提到 10（避免"拆成 4 篇"这类小规模场景）
        // - 收紧“文件夹/目录”触发：避免用户说“新建文件夹/放进文件夹”就误触发批处理
        pattern:
          "(?:批处理|批量|整包|一键生成|长期运行|长时间运行|50\\s*节|250\\s*篇)|" +
          // 文件夹/目录：必须出现“批量语义”或“目录下全部/所有”才触发（避免“新建文件夹”）
          "(?:(?:按|遍历|扫描|处理|批量处理|批量生成|批量改写|批量润色)[\\s\\S]{0,6}(?:文件夹|目录))|" +
          "(?:(?:文件夹|目录)[\\s\\S]{0,12}(?:下|内|里|中的)[\\s\\S]{0,6}(?:全部|所有))|" +
          "(?:\\b(?:[1-9]\\d+)\\b\\s*(?:篇|条|篇文章|条稿|条口播|篇口播))",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=writing_batch 激活时（硬路由）：\n" +
      "1) 你不得在单次对话里直接输出 N 篇完整正文；必须用 writing.batch.start 启动批处理。\n" +
      "2) inputDir 若缺失：直接调用 writing.batch.start（会弹出选择文件夹）。\n" +
      "3) 启动后：建议立刻调用 writing.batch.status 获取 jobId/outputDir，然后用 run.done 结束本次 run（批处理会在后台继续）。\n" +
      "4) 需要控制：writing.batch.pause/resume/cancel。\n",
    context: "ACTIVE_SKILLS: writing_batch（硬路由：批量任务走批处理工具）",
  },
  policies: ["SkillToolCapsPolicy"],
  version: "1.0.0",
  conflicts: ["writing_multi"],
  source: "builtin",
  ui: { badge: "BATCH", color: "orange" },
};

export const WRITING_MULTI_SKILL: SkillManifest = {
  id: "writing_multi",
  name: "小规模多篇写作（逐篇闭环）",
  description:
    "当用户要小规模多篇（2–9 篇/条）时启用：要求逐篇独立生成与落盘，禁止“先合并再 splitToDir”造成同质化与门禁误伤。",
  priority: 120,
  stageKey: "agent.skill.writing_multi",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    { when: "run_intent_in", args: { intents: ["writing", "rewrite", "polish"] } },
    {
      when: "text_regex",
      args: {
        // 触发信号：2–9 篇/条/个；或“多篇/几篇/若干” + “每篇/每条/分别/各写”等分配语义
        // 注意：>=10 交给 writing_batch（后台队列）
        pattern:
          "(?:\\b[2-9]\\b\\s*(?:篇|条|个)(?:\\s*(?:文章|文案|口播|脚本|稿))?)|" +
          "(?:(?:两|二|三|四|五|六|七|八|九)\\s*(?:篇|条|个)(?:\\s*(?:文章|文案|口播|脚本|稿))?)|" +
          "(?:(?:多篇|几篇|若干篇|多条|几条|若干条)[\\s\\S]{0,24}(?:每篇|每条|分别|各写|各自|逐篇|逐条))|" +
          "(?:(?:每篇|每条)[\\s\\S]{0,16}\\d{2,5}(?:\\s*字)?)",
      },
    },
  ],
  promptFragments: {
    system:
      "当 skill=writing_multi 激活时（小规模多篇，逐篇闭环）：\n" +
      "1) 目标：在一次 Run 内，按“逐篇独立闭环”生成并写入多篇（2–9）。每篇必须有自己的开头/结构/收束与金句，不要批量同质化。\n" +
      "2) 禁止：不要把多篇正文合并成一个大文档再调用 doc.splitToDir；不要先产出 N 篇完整正文再一次性写入。\n" +
      "3) 允许：逐篇循环执行：写前 kb.search（结构/开头/结尾模板）→ 产初稿 → 初稿后二次 kb.search（one_liner/ending）→（若开启）lint.copy →（若开启）lint.style → doc.write 单篇落盘。\n" +
      "4) 写入建议：每篇用一个新文件（doc.write ifExists=rename），默认写入到同一输出目录；文件名建议包含序号与标题。",
    context: "ACTIVE_SKILLS: writing_multi（小规模多篇：逐篇闭环，禁止 splitToDir）",
  },
  policies: ["SkillToolCapsPolicy"],
  toolCaps: {
    // 关键：禁用“合并后再分割”的捷径（这会导致同质化、并且在门禁阶段经常触发 denied）
    denyTools: ["doc.splitToDir"],
  },
  version: "1.0.0",
  conflicts: ["writing_batch"],
  source: "builtin",
  ui: { badge: "MULTI", color: "teal" },
};

export const CORPUS_INGEST_SKILL: SkillManifest = {
  id: "corpus_ingest",
  name: "语料导入与抽卡",
  description:
    "当用户给出文本/文件/URL 并要求抽卡、学风格或分析文风时，自动完成导入语料→抽卡入库→可选生成手册→自动挂载库。",
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
      "1) 你的首要任务是帮用户把语料导入知识库并完成抽卡。\n" +
      "2) 调用 kb.ingest 工具：\n" +
      "   - 若用户提供了文本，用 text 参数。\n" +
      "   - 若用户提供了文件路径，用 path 参数。\n" +
      "   - 若用户提供了 URL，用 url 参数。\n" +
      "3) 默认创建 purpose=style 的库（除非用户明确说是素材/产品库）。\n" +
      "4) 抽卡完成后，向用户报告：\n" +
      "   - 抽到了多少张卡（按 cardType 分类：hook/thesis/ending/one_liner/outline）\n" +
      "   - 库已自动 attach，后续写作可直接使用\n" +
      "5) 若用户在同一 run 里接着要求写作：直接进入写作流程（kb.search 已可命中新卡）。\n" +
      "6) 不要在未调用 kb.ingest 前就尝试 kb.search 搜索未导入的内容。",
    context: "ACTIVE_SKILLS: corpus_ingest（语料导入与抽卡）",
  },
  policies: [],
  toolCaps: {
    allowTools: [
      "kb.ingest",
      "kb.listLibraries",
      "kb.search",
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

export const SKILL_MANIFESTS_V1: SkillManifest[] = [CORPUS_INGEST_SKILL, WRITING_BATCH_SKILL, WRITING_MULTI_SKILL, WEB_TOPIC_RADAR_SKILL, STYLE_IMITATE_SKILL];

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
  const manifests = args.manifests?.length ? args.manifests : SKILL_MANIFESTS_V1;

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
