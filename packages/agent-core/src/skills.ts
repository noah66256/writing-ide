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

export type PortableSkillContextMode = "inline" | "fork";

export type PortableSkillRuntimeMeta = {
  skillDir?: string;
  manifestPath?: string;
  scanRoot?: string;
};

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
  /** 兼容 Agent Skills / Claude Code 的附加字段 */
  license?: string;
  argumentHint?: string;
  effort?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  model?: string;
  context?: PortableSkillContextMode | string;
  agent?: string;
  hooks?: unknown;
  inputSchema?: unknown;
  compatibility?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  vendorMetadata?: Record<string, unknown>;
  portable?: boolean;
  portableRuntime?: PortableSkillRuntimeMeta;
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

export type SkillActivationEvaluation = {
  candidateSkills: ActiveSkill[];
  activeSkills: ActiveSkill[];
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
    if (!pattern) return { ok: false, reasonCodes: ["trigger:text_regex:missing_pattern"], detail: {} };
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

// ── Skill 注册表 ──────────────────────────────────────────────

const BUILTIN_MANIFESTS: SkillManifest[] = [];

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

function isWorkflowSkillManifest(manifest: SkillManifest | undefined | null) {
  if (!manifest || typeof manifest !== "object") return false;
  return manifest.kind === "workflow" || (!!manifest.workflow && typeof manifest.workflow === "object");
}

function canModelAutoActivateSkill(manifest: SkillManifest | undefined | null) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.disableModelInvocation === true) return false;
  const activationMode = normLower(manifest.activationMode || "auto");
  if (activationMode === "explicit") return false;
  if (manifest.portable === true) {
    return activationMode === "auto" && Array.isArray(manifest.triggers) && manifest.triggers.length > 0;
  }
  return true;
}

function canSelectSkill(args: {
  manifest: SkillManifest;
  selectedIds: Set<string>;
  blockedByConflict: Set<string>;
}) {
  const skillId = normStr(args.manifest.id);
  if (!skillId) return false;
  if (args.blockedByConflict.has(skillId)) return false;
  const conflicts = normalizeStringArray(args.manifest.conflicts);
  if (conflicts.some((id) => args.selectedIds.has(id))) return false;
  const requires = normalizeStringArray(args.manifest.requires);
  if (requires.length && !requires.every((id) => args.selectedIds.has(id))) return false;
  return true;
}

function markSkillSelected(args: {
  manifest: SkillManifest;
  selectedIds: Set<string>;
  blockedByConflict: Set<string>;
}) {
  const skillId = normStr(args.manifest.id);
  if (!skillId) return;
  args.selectedIds.add(skillId);
  for (const cid of normalizeStringArray(args.manifest.conflicts)) args.blockedByConflict.add(cid);
}

export function evaluateSkillActivation(args: {
  mode: AgentMode;
  userPrompt?: string;
  mainDocRunIntent?: unknown;
  kbSelected?: KbSelectedLibrary[];
  intent?: RunIntent;
  manifests?: SkillManifest[];
  explicitSkillIds?: string[];
}): SkillActivationEvaluation {
  const mode = args.mode;
  const userPrompt = normStr(args.userPrompt);
  const kbSelected = Array.isArray(args.kbSelected) ? (args.kbSelected as any[]) : [];
  const intent = args.intent ?? detectRunIntent({ mode, userPrompt, mainDocRunIntent: args.mainDocRunIntent });
  const manifests = args.manifests?.length ? args.manifests : listRegisteredSkills();
  const explicitSkillIds = new Set(normalizeStringArray(args.explicitSkillIds));

  // 按 priority 降序排序后再迭代，确保高优先级 Skill 优先激活（影响 conflicts 裁决）
  const sorted = [...manifests].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)),
  );

  const candidates: Array<{ m: SkillManifest; s: ActiveSkill; explicit: boolean }> = [];
  for (const m of sorted) {
    const skillId = normStr(m.id);
    if (!skillId) continue;
    const isExplicit = explicitSkillIds.has(skillId);
    if (!m?.autoEnable && !isExplicit) continue;
    if (!isExplicit && !canModelAutoActivateSkill(m)) continue;

    const reasonCodes: string[] = [`skill:${m.id}`];
    const detail: Record<string, unknown> = { stageKey: m.stageKey };
    let ok = true;
    if (isExplicit) {
      reasonCodes.push("explicit_skill_ref");
      detail.activation = "explicit";
    } else {
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
    }
    if (!ok) continue;
    candidates.push({
      m,
      s: {
        id: m.id,
        name: m.name,
        stageKey: m.stageKey,
        badge: m.ui?.badge || m.id.toUpperCase(),
        activatedBy: { reasonCodes: reasonCodes.slice(0, 32), detail },
      },
      explicit: isExplicit,
    });
  }

  const active: Array<{ m: SkillManifest; s: ActiveSkill; explicit: boolean }> = [];
  const selectedIds = new Set<string>();
  const blockedByConflict = new Set<string>();

  for (const item of candidates.filter((entry) => entry.explicit)) {
    if (!canSelectSkill({ manifest: item.m, selectedIds, blockedByConflict })) continue;
    active.push(item);
    markSkillSelected({ manifest: item.m, selectedIds, blockedByConflict });
  }

  let autoWorkflowSelected = false;
  for (const item of candidates.filter((entry) => !entry.explicit && isWorkflowSkillManifest(entry.m))) {
    if (autoWorkflowSelected) continue;
    if (!canSelectSkill({ manifest: item.m, selectedIds, blockedByConflict })) continue;
    active.push(item);
    markSkillSelected({ manifest: item.m, selectedIds, blockedByConflict });
    autoWorkflowSelected = true;
  }

  for (const item of candidates.filter((entry) => !entry.explicit && !isWorkflowSkillManifest(entry.m))) {
    if (item.m.portable === true && normLower(item.m.activationMode || "auto") !== "auto") continue;
    if (!canSelectSkill({ manifest: item.m, selectedIds, blockedByConflict })) continue;
    active.push(item);
    markSkillSelected({ manifest: item.m, selectedIds, blockedByConflict });
  }

  return {
    candidateSkills: candidates.map((x) => x.s),
    activeSkills: active.map((x) => x.s),
  };
}

export function activateSkills(args: {
  mode: AgentMode;
  userPrompt?: string;
  mainDocRunIntent?: unknown;
  kbSelected?: KbSelectedLibrary[];
  intent?: RunIntent;
  manifests?: SkillManifest[];
  explicitSkillIds?: string[];
}): ActiveSkill[] {
  return evaluateSkillActivation(args).activeSkills;
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
  // 1) builtin 基座（浅拷贝）+ bundled builtin skills（来自 SKILL.md，builtin=true）
  const builtinMap = new Map<string, SkillManifest>();
  for (const m of SKILL_MANIFESTS_V1) {
    const id = normStr(m?.id);
    if (!id) continue;
    builtinMap.set(id, { ...m, source: m.source ?? "builtin", builtin: true });
  }
  for (const m of config?.userSkills ?? []) {
    const id = normStr(m?.id);
    if (!id || !normStr(m?.name) || m?.builtin !== true) continue;
    builtinMap.set(id, { ...m, source: "builtin", builtin: true });
  }
  const builtin = [...builtinMap.values()];
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
    if (!id || builtinIds.has(id) || !normStr(m?.name) || m?.builtin === true) continue;
    userMap.set(id, { ...m, source: "user" });
  }

  // standard 去掉被 user 覆盖的
  for (const id of userMap.keys()) {
    standardMap.delete(id);
  }

  // 5) 合并返回
  return [...builtin, ...standardMap.values(), ...userMap.values()];
}
