import type { AgentMode } from "./index.js";
import { detectRunIntent, type KbSelectedLibrary, type RunIntent } from "./runMachine.js";
import type { StyleWorkflowStepIdV1 } from "./styleWorkflowTypes.js";

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

export type PipelineStepDecl = {
  id: StyleWorkflowStepIdV1;
  index: number;
  gate: import("./workflowPhaseInterpreter.js").PhaseGate;
  executor: "llm_structured" | "llm_text" | "lint_loop";
  outputArtifact?: string;
  hint?: string;
};

export type PipelineLintConfig = {
  maxCopyAttempts: number;
  maxStyleAttempts: number;
  pickBestOnExhaust: boolean;
};

export type PipelineDeclaration = {
  configRef: string;
  executionMode: string;
  stateKeys: string[];
  steps: PipelineStepDecl[];
  lint: PipelineLintConfig;
};

export type SkillKind = "workflow" | "hint" | "service" | "pipeline";

export type SkillActivationMode = "auto" | "explicit" | "hybrid";

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  priority: number;
  stageKey: string;
  autoEnable: boolean;
  /** Skill 类型：workflow（有闭环合同）/hint（纯提示）/service（服务类能力） */
  kind?: SkillKind;
  /** 激活模式：auto（完全按 triggers）、explicit（仅 @skill/显式激活）、hybrid（二者皆可） */
  activationMode?: SkillActivationMode;
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
  /** 是否为内置（随 app 捆绑），即使从文件系统加载也视为内置 */
  builtin?: boolean;
  /** 可选：声明式 Workflow 配置（phases / exclusions / followUp） */
  workflow?: import("./workflowPhaseInterpreter.js").WorkflowDeclaration;
  /** 可选：Pipeline 配置（kind=pipeline 使用） */
  pipeline?: PipelineDeclaration;
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

  // MainDoc=auto：回退到启发式（detectRunIntent 里已做了"analysis/ops 强制关写作意图"的修正）
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
  name: "风格仿写",
  description:
    "绑定风格库后，@风格库+写作任务时自动唤起，或 /风格仿写 显式唤起：Agent 自驱动闭环（风格检索 → 定调骨架 → 写作 → lint.copy → lint.style → 终稿落盘）。",
  priority: 120,
  stageKey: "agent.skill.style_imitate",
  kind: "workflow",
  activationMode: "hybrid",
  toolCaps: {
    allowTools: [
      "kb.search",
      "kb.listLibraries",
      "write",
      "edit",
      "lint.copy",
      "lint.style",
    ],
  },
  autoEnable: false,
  triggers: [
    { when: "has_style_library", args: { purpose: "style" } },
  ],
  conflicts: [],
  promptFragments: {
    system:
      `当 skill=style_imitate 激活时：

**严格按以下阶段顺序执行。不得跳过 lint.copy 和 lint.style。**

**强制规则：Phase 0 必须先完成风格样例检索，再进入写作阶段。不要直接开始写稿。**

**当需要用户回答问题时**（确认主题、选择风格库等）：输出问题后立即调用 \`run.done\` 结束当前轮次，等待用户回复。**不要在同一轮中反复询问。**

---

## Phase 0: 风格样例检索

**目的**：从风格库中获取写法规则卡和样例，建立风格基准。

**执行步骤**：

0. **前置检查——用户消息中是否包含写作主题**：
   - 如果用户只说了"@风格仿写"而没有给出主题，先询问主题，然后 \`run.done\`，等用户回复后再继续
   - 不要在没有主题的情况下启动检索和写作
1. 如果 Context Pack 已提供 STYLE_FACETS_SELECTED(Markdown)：
   - 已有规则卡全文，可直接按规则卡开写
   - kb.search 仅用于补充当前话题下的结构骨架/开头钩子/结尾收束
2. **风格库选择**（即使 STYLE_CATALOG 已自动注入也要检查）：
   - 调用 kb.listLibraries 查看可用风格库
   - 如果只有 1 个 style 库，直接使用
   - 如果有多个：先看用户消息中是否提及库名；无法确定时询问用户选哪个库，然后 \`run.done\` 等待回复
   - **不要默认使用系统自动注入的第一个库而跳过确认**
3. 调用 kb.search：
   - 限定 purpose=style 的风格库
   - 优先 kind=card（hook/one_liner/outline/thesis/ending 等规则卡）
   - 不要一上来就用 kind=paragraph 大范围捞原文段落
4. 如果 Context Pack 提供了 STYLE_DIMENSIONS(JSON)：
   - mustApply.facetIds 为 MUST，每个 facet 的核心写法都要在正文中至少体现一次
   - shouldApply.softRanges 为 SHOULD，尽量贴近统计指纹
   - mayApply.cardTypesHint 仅用于检索素材
5. 如果提供了 STYLE_SELECTOR(JSON)：
   - selectedFacetIds/selectedFacets 是本次执行的维度卡子集
   - 若提供 searchPlan，优先按 searchPlan 检索

**退出条件**：至少获得 3 条风格样例/规则卡。然后进入 Phase 1。

---

## Phase 1: 定调与骨架（心中规划，不需输出给用户）

**目的**：基于风格样例确定基调和文章结构。写作前的内部思考，不需要调用工具。

1. 提炼目标风格的核心特征：
   - 人设/视角（第几人称、什么立场）
   - 语气节奏（短句频率、问句密度、口头禅使用规律）
   - 论证路径（先破后立？数据说话？故事引入？算账链条？）
2. 根据用户主题规划文章骨架：
   - 开头钩子类型（反常识/提问/场景描写/数据冲击）
   - 主体段落推进逻辑（论点顺序、转折点、视角切换）
   - 收束方式（金句/行动号召/余韵/回扣开头）

**退出条件**：心中有明确的基调和结构方案。进入 Phase 2。

---

## Phase 2: 写作

**目的**：一次性产出完整草稿。

1. 调用 write 工具，写入完整草稿
2. **文件名必须反映用户主题**（如 \`output/金价上涨_口播稿.md\`），不要用系统生成的无意义路径
3. 写作时贯彻 Phase 1 的定调和骨架
4. 反贴原文规则（必须遵守）：
   - 不要复制原文的句子/段落；任何明显的逐句改写/近似复述都视为失败
   - 必须做结构与表达的再创作：重排段落、改句式、换衔接、换比喻/类比
   - 只保留"必要短语"，不要出现长串连续复用
5. 不要只模仿表层标记（问号、破折号、短句、口头禅）；必须复刻段落推进、转折、视角、论证路径与声音节奏

**退出条件**：完整草稿已写入文件。进入 Phase 3。**不要跳过 Phase 3-4 直接交付。**

---

## Phase 3: lint.copy 复述风险检查

**目的**：确保草稿没有复述原文的风险。

1. 调用 lint.copy，传入草稿文本
2. 如果通过（passed=true）：直接进入 Phase 4
3. 如果未通过（passed=false）：
   - 阅读 issues 和 rewritePrompt
   - 用 edit 工具根据建议改稿（按段落/句子 patch，不要整篇重写）
   - 再次调用 lint.copy 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 4
4. **不要跳过 lint.copy 直接去跑 lint.style**

**退出条件**：lint.copy 通过，或 3 次重试用尽。

---

## Phase 4: lint.style 风格校验

**目的**：确保草稿在结构/节奏/语气上贴合目标风格。

1. 调用 lint.style，传入草稿文本
2. 如果通过（passed=true 或 score >= 70）：直接进入 Phase 5
3. 如果未通过：
   - 阅读 issues 和 rewritePrompt
   - 用 edit 工具按维度修改（结构调整、节奏优化、语气校正）
   - 再次调用 lint.style 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 5
4. lint.style 用于"提示/审计"，不要把分数当唯一门禁导致卡死

**退出条件**：lint.style 通过，或 3 次重试用尽。

---

## Phase 5: 终稿落盘

1. 如果 Phase 3-4 中有改稿，用 write 更新终稿文件
2. 完成后调用 run.done

---

## 执行纪律

- 检索/重试/超时/降级等执行状态**不要**用自然语言逐条播报给用户
- 不要输出"同步启动资料搜索"、"kb.search超时"、"改用较轻查询重试"之类的状态文本
- 直接继续执行并给最终结果
- 如果 KB_STYLE_CLUSTERS(JSON) 提供了写法候选/子簇：默认按推荐/已选写法继续写作；不要单独输出"已选用写法X"的说明
- 如果 Main Doc 已有 styleContractV1 且用户未要求变更，不要重复写入
`,
    context: "ACTIVE_SKILLS: style_imitate\uFF08\u539F\u56E0\u89C1 reasonCodes\uFF1BUI \u9700\u53EF\u89C1\uFF09",
  },
  policies: ["StyleGatePolicy"],
  workflow: {
    stateKeys: [
      "hasStyleKbSearch",
      "hasDraftText",
      "copyLintPassed",
      "styleLintPassed",
      "lintGateDegraded",
    ],
    phases: [
      {
        id: "need_style_kb",
        gate: { allFalse: ["hasStyleKbSearch"] },
        tools: ["kb.search", "kb.listLibraries"],
        hint: "当前先做风格样例检索。调用 kb.search 检索写法模板/规则卡。",
      },
      {
        id: "need_draft",
        gate: { allTrue: ["hasStyleKbSearch"], allFalse: ["hasDraftText"] },
        tools: ["write"],
        hint: "风格样例已具备，产出候选草稿。",
      },
      {
        id: "need_copy_lint",
        gate: { allTrue: ["hasStyleKbSearch", "hasDraftText"], allFalse: ["copyLintPassed"] },
        tools: ["lint.copy", "edit", "write"],
        hint: "草稿已完成，做复述风险检查。lint.copy 不通过则改稿后复检。",
      },
      {
        id: "need_style_lint",
        gate: {
          allTrue: ["hasStyleKbSearch", "hasDraftText", "copyLintPassed"],
          allFalse: ["styleLintPassed", "lintGateDegraded"],
        },
        tools: ["lint.style", "edit", "write"],
        hint: "copy lint 已通过，做风格校验。lint.style 不通过则改稿后复检。",
      },
      {
        id: "completed",
        gate: {
          allTrue: ["hasStyleKbSearch", "hasDraftText", "copyLintPassed"],
          anyTrue: ["styleLintPassed", "lintGateDegraded"],
        },
        tools: ["write", "edit"],
        hint: "闭环完成，落盘终稿。",
      },
    ],
    exclusions: [
      ["kb.search", "write"],
      ["kb.search", "lint.copy"],
      ["kb.search", "lint.style"],
      ["lint.copy", "lint.style"],
    ],
    followUp: {
      message: "风格仿写尚未完成闭环，请按 kb.search → 草稿 → lint.copy → lint.style → write 顺序补齐。",
    },
  },
  version: "3.0.0",
  source: "builtin",
  ui: { badge: "STYLE", color: "purple" },
};

// ── Skill 注册表 ──────────────────────────────────────────────

const BUILTIN_MANIFESTS: SkillManifest[] = [
  STYLE_IMITATE_SKILL,
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
