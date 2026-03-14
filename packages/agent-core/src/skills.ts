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

export type SkillKind = "workflow" | "hint" | "service";

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
  name: "\u98CE\u683C\u4EFF\u5199\u95ED\u73AF",
  description: "\u7ED1\u5B9A\u98CE\u683C\u5E93\u540E\uFF0C\u4EC5\u5728\u5199\u4F5C/\u6539\u5199/\u6DA6\u8272\u610F\u56FE\u4E0B\u81EA\u52A8\u542F\u7528\uFF1A\u5148\u68C0\u7D22\u6837\u4F8B\u2192\u518D lint.style\u2192\u6700\u540E\u5141\u8BB8\u5199\u5165\uFF08\u652F\u6301\u964D\u7EA7/\u8DF3\u8FC7\uFF09\u3002",
  priority: 100,
  stageKey: "agent.skill.style_imitate",
  kind: "workflow",
  activationMode: "hybrid",
  toolCaps: {
    allowTools: [
      "kb.search",
      "write",
      "edit",
      "lint.copy",
      "lint.style",
    ],
  },
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    { when: "has_style_library", args: { purpose: "style" } },
    { when: "run_intent_in", args: { intents: ["writing", "rewrite", "polish"] } },
  ],
  promptFragments: {
    system:
      "\u5F53 skill=style_imitate \u6FC0\u6D3B\u65F6\uFF1A\n" +
      "0) \u82E5 Context Pack \u63D0\u4F9B KB_STYLE_CLUSTERS(JSON)\uFF08\u5199\u6CD5\u5019\u9009/\u5B50\u7C07\uFF09\u6216 STYLE_SELECTOR(JSON)\uFF1A\u9ED8\u8BA4\u6309\u63A8\u8350/\u5DF2\u9009\u5199\u6CD5\u7EE7\u7EED\u5199\u4F5C\uFF1B\u7528\u6237\u53EF\u968F\u65F6\u6539\u53E3\u5207\u6362\u3002\u4E0D\u8981\u5728\u6B63\u6587\u524D\u6216\u5355\u72EC\u6D88\u606F\u91CC\u8F93\u51FA\u201C\u5DF2\u9009\u7528\u5199\u6CD5X/\u5907\u9009\u5199\u6CD5Y\u201D\u8FD9\u7C7B\u8BF4\u660E\uFF0C\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\u6BD4\u8F83\u5199\u6CD5\u3002\n" +
      "1) \u82E5 Main Doc \u5C1A\u672A\u5199\u5165 styleContractV1\uFF08\u6216\u7528\u6237\u6539\u53E3\u8981\u6C42\u5207\u5199\u6CD5\uFF09\uFF0C\u518D\u8C03\u7528 run.mainDoc.update \u5199\u5165/\u66F4\u65B0 mainDoc.styleContractV1\uFF08\u77ED JSON\uFF1A{v,libraryId,selectedCluster{id,label},anchors,evidence,softRanges,facetPlan,updatedAt}\uFF09\u3002\u82E5 Main Doc \u5DF2\u6709\u4E14\u7528\u6237\u672A\u8981\u6C42\u53D8\u66F4\uFF0C\u5219\u4E0D\u8981\u91CD\u590D\u5199\u5165\u3002\n" +
      "2) \u82E5\u63D0\u4F9B STYLE_DIMENSIONS(JSON)\uFF1A\n" +
      "- mustApply.facetIds \u4E3A MUST\uFF0C\u5FC5\u987B\u8986\u76D6\uFF08\u6BCF\u4E2A\u81F3\u5C11\u843D\u5730\u4E00\u6B21\uFF09\uFF0C\u4E0D\u8981\u81EA\u884C\u6269\u5C55\u5230\u5168\u90E8\u7EF4\u5EA6\uFF1B\n" +
      "- shouldApply.softRanges \u4E3A SHOULD\uFF0C\u5C3D\u91CF\u8D34\u8FD1\u7EDF\u8BA1\u6307\u7EB9\uFF08\u53E5\u957F/\u95EE\u53E5\u7387/\u4EBA\u79F0\u5BC6\u5EA6\u7B49\uFF09\uFF1B\n" +
      "- mayApply.cardTypesHint \u4EC5\u7528\u4E8E\u68C0\u7D22\u7D20\u6750\uFF08\u53EF\u9009\uFF09\u3002\n" +
      "3) \u82E5\u63D0\u4F9B STYLE_SELECTOR(JSON)\uFF1A\u5FC5\u987B\u628A selectedFacetIds/selectedFacets \u5F53\u4F5C\u672C\u6B21\u8981\u6267\u884C\u7684\u201C\u7EF4\u5EA6\u5361\u5B50\u96C6\u201D\uFF08\u53EA\u6267\u884C\u8FD9\u4E9B\u5361\uFF0C\u4E0D\u8981\u81EA\u884C\u6269\u5C55\u5230\u5168\u90E8\u7EF4\u5EA6\uFF09\u3002\u82E5\u540C\u65F6\u63D0\u4F9B STYLE_DIMENSIONS(JSON)\uFF0C\u4EE5 mustApply.facetIds \u4E3A\u51C6\uFF1B\u82E5\u540C\u65F6\u63D0\u4F9B STYLE_FACETS_SELECTED(Markdown)\uFF0C\u4F18\u5148\u6309\u5176\u5361\u7247\u5185\u5BB9\u6267\u884C\uFF1B\u5E76\u5BF9\u6BCF\u5F20\u5165\u9009 facet \u7ED3\u5408 kbQueries\uFF08\u6216 facetId+\u8BDD\u9898\uFF09\u7528 kb.search \u62C9\u6837\u4F8B/\u8BC1\u636E\u518D\u843D\u7B14\u3002\n" +
      "4) \u5355\u7BC7\u5199\u4F5C\u5EFA\u8BAE\u8D70\u201C\u4E24\u6BB5\u5F0F\u68C0\u7D22\u201D\uFF1A\n" +
      "- \u7B2C\u4E00\u6BB5\uFF08\u5199\u524D\uFF09\uFF1Akb.search \u62C9\u89C4\u5219\u5361/\u7ED3\u6784\u9AA8\u67B6/\u5F00\u5934\u94A9\u5B50/\u7ED3\u5C3E\u6536\u675F\uFF08kind=card + \u663E\u5F0F cardTypes\uFF09\u3002\n" +
      "- \u7B2C\u4E8C\u6BB5\uFF08\u521D\u7A3F\u540E\uFF09\uFF1A\u518D kb.search \u62C9\u91D1\u53E5/\u6536\u675F\u6A21\u677F\uFF08one_liner/ending\uFF09\uFF0C\u628A punchline \u4E0E\u6536\u5C3E\u8865\u9F50\u540E\u518D\u8FDB\u5165 lint\u3002\n" +
      "5) \u5199\u4F5C\u65F6\u5FC5\u987B\u5148 kb.search\uFF08\u53EA\u641C\u98CE\u683C\u5E93\uFF09\u62C9\u6837\u4F8B/\u6A21\u677F\uFF1A\u4F18\u5148 kind=card\uFF08hook/one_liner/outline/thesis/ending \u7B49\uFF09\uFF0C\u4E0D\u8981\u4E00\u4E0A\u6765\u5C31\u7528 kind=paragraph \u5927\u8303\u56F4\u635E\u539F\u6587\u6BB5\u843D\u5F53\u6837\u4F8B\u3002\n" +
      "6) \u53CD\u8D34\u539F\u6587\u8981\u6C42\uFF08\u5FC5\u987B\u9075\u5B88\uFF09\uFF1A\n" +
      "- \u4E0D\u8981\u590D\u5236\u539F\u6587\u7684\u53E5\u5B50/\u6BB5\u843D\uFF1B\u4EFB\u4F55\u660E\u663E\u7684\u9010\u53E5\u6539\u5199/\u8FD1\u4F3C\u590D\u8FF0\u90FD\u89C6\u4E3A\u5931\u8D25\u3002\n" +
      "- \u5728\u201C\u4E0D\u65B0\u589E\u4E8B\u5B9E\u201D\u7684\u524D\u63D0\u4E0B\uFF0C\u5FC5\u987B\u505A\u7ED3\u6784\u4E0E\u8868\u8FBE\u7684\u518D\u521B\u4F5C\uFF1A\u91CD\u6392\u6BB5\u843D\u3001\u6539\u53E5\u5F0F\u3001\u6362\u8854\u63A5\u3001\u6362\u6BD4\u55BB/\u7C7B\u6BD4\u3001\u628A\u6570\u5B57\u5806\u780C\u6539\u6210\u53D9\u4E8B\u5316\u89E3\u91CA\u3002\n" +
      "- \u5982\u9700\u5F15\u7528\u539F\u6587\u4E2D\u7684\u4E13\u6709\u540D\u8BCD/\u5173\u952E\u7ED3\u8BBA\uFF1A\u53EA\u4FDD\u7559\u201C\u5FC5\u8981\u77ED\u8BED\u201D\uFF0C\u4E0D\u8981\u51FA\u73B0\u957F\u4E32\u8FDE\u7EED\u590D\u7528\u3002\n" +
      "7) lint.style \u7528\u4E8E\u201C\u63D0\u793A/\u5BA1\u8BA1/\u95EE\u9898\u6E05\u5355\u201D\uFF1A\u672A\u901A\u8FC7\u65F6\u5FC5\u987B\u6309 rewritePrompt \u56DE\u7089\u6539\u5199\u5E76\u590D\u68C0\uFF1B\u4E0D\u8981\u628A\u5206\u6570\u5F53\u6210\u552F\u4E00\u95E8\u7981\u5BFC\u81F4\u5361\u6B7B\u3002\n" +
      "8) \u68C0\u7D22/\u91CD\u8BD5/\u8D85\u65F6/\u964D\u7EA7\u7B49\u6267\u884C\u72B6\u6001\u4E0D\u8981\u7528\u81EA\u7136\u8BED\u8A00\u9010\u6761\u64AD\u62A5\u7ED9\u7528\u6237\uFF1B\u4F8B\u5982\u4E0D\u8981\u8F93\u51FA\u2018\u540C\u6B65\u542F\u52A8\u8D44\u6599\u641C\u7D22\u548C\u98CE\u683C\u68C0\u7D22\u2019\u3001\u2018kb.search\u8D85\u65F6\u2019\u3001\u2018\u6539\u7528\u8F83\u8F7B\u67E5\u8BE2\u91CD\u8BD5\u2019\u3001\u2018\u8DF3\u8FC7\u68C0\u7D22\u76F4\u63A5\u5199\u7A3F\u2019\u3002\u8FD9\u4E9B\u72B6\u6001\u7531\u7CFB\u7EDF\u8FDB\u5EA6 UI \u5C55\u793A\uFF1B\u9664\u975E\u9700\u8981\u7528\u6237\u51B3\u7B56\uFF0C\u5426\u5219\u76F4\u63A5\u7EE7\u7EED\u6267\u884C\u5E76\u7ED9\u6700\u7EC8\u7ED3\u679C\u3002",
    context: "ACTIVE_SKILLS: style_imitate\uFF08\u539F\u56E0\u89C1 reasonCodes\uFF1BUI \u9700\u53EF\u89C1\uFF09",
  },
  policies: ["StyleGatePolicy", "AutoRetryPolicy"],
  version: "1.0.0",
  source: "builtin",
  ui: { badge: "STYLE", color: "blue" },
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
