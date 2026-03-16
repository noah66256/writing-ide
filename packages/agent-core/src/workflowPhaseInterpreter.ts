/**
 * 通用 Workflow Phase 解释器
 *
 * 读取 SkillManifest 中的 `workflow` 声明，替代硬编码的
 * computeStyleTurnCaps / buildStyleSnapshot / analyzeStyleWorkflowBatch。
 */

import type { WorkflowSkillPhaseSnapshot } from "./workflowSkills.js";

// ── 类型定义 ──────────────────────────────────────────

/** phase gate：三种集合操作的组合，全部满足才匹配 */
export type PhaseGate = {
  /** 这些 stateKey 必须全为 true */
  allTrue?: string[];
  /** 这些 stateKey 必须全为 false */
  allFalse?: string[];
  /** 这些 stateKey 至少一个为 true */
  anyTrue?: string[];
};

/** 单个 workflow 阶段声明 */
export type WorkflowPhaseDecl = {
  id: string;
  gate: PhaseGate;
  /** 该阶段允许的工具名 */
  tools: string[];
  /** 注入给 Agent 的阶段提示 */
  hint: string;
};

/** workflow 完成后的 follow-up 配置 */
export type WorkflowFollowUp = {
  message: string;
};

/** 完整的 Workflow 声明（对应 SKILL.md 的 workflow 字段） */
export type WorkflowDeclaration = {
  /** 该 workflow 依赖的 RunState 布尔字段名 */
  stateKeys: string[];
  /** 阶段列表，按声明顺序求值（第一个 gate 匹配的即为当前阶段） */
  phases: WorkflowPhaseDecl[];
  /** 不能同轮出现的工具对/组 */
  exclusions?: string[][];
  /** 闭环未完成时注入的 follow-up 消息 */
  followUp?: WorkflowFollowUp;
};

// ── gate 求值 ──────────────────────────────────────────

function toBool(v: unknown): boolean {
  return Boolean(v);
}

/**
 * 检查 gate 是否匹配当前 state。
 * gate 中未声明的字段视为"不限制"。
 */
export function matchGate(gate: PhaseGate | null | undefined, state: Record<string, unknown>): boolean {
  if (!gate) return true;
  if (gate.allTrue?.length) {
    for (const k of gate.allTrue) {
      if (!toBool(state[k])) return false;
    }
  }
  if (gate.allFalse?.length) {
    for (const k of gate.allFalse) {
      if (toBool(state[k])) return false;
    }
  }
  if (gate.anyTrue?.length) {
    let found = false;
    for (const k of gate.anyTrue) {
      if (toBool(state[k])) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

// ── 核心方法 ──────────────────────────────────────────

/**
 * 计算当前阶段（替代 buildStyleSnapshot / computeStylePhaseAndMissing）。
 * phases 按声明顺序遍历，第一个 gate 匹配的即为当前阶段。
 * 都不匹配则落入最后一个阶段（通常是 completed）。
 */
export function resolvePhase(
  workflow: WorkflowDeclaration,
  state: Record<string, unknown>,
): WorkflowSkillPhaseSnapshot {
  const phases = workflow.phases ?? [];
  if (phases.length === 0) {
    return { id: "", active: false, phases: [], currentPhase: "completed", missingSteps: [] };
  }

  const phaseIds = phases.map((p) => p.id);
  let matched: WorkflowPhaseDecl | null = null;
  for (const p of phases) {
    if (matchGate(p.gate, state)) {
      matched = p;
      break;
    }
  }

  // 都不匹配时取最后一个
  if (!matched) matched = phases[phases.length - 1];

  const currentPhase = matched.id;
  const isCompleted = currentPhase === "completed" || currentPhase === phases[phases.length - 1].id;

  // missingSteps：从头遍历到当前阶段（不含 completed），收集未满足 gate 的阶段的首个工具
  const missingSteps: string[] = [];
  if (!isCompleted) {
    for (const p of phases) {
      if (p.id === "completed") continue;
      if (!matchGate(p.gate, state)) continue; // gate 匹配 = 当前阶段停在这里
      // 只收集当前阶段之前（含当前）的 missing
      break;
    }
    // 更简单的逻辑：未完成时把所有未满足的阶段的首个工具收集
    for (const p of phases) {
      if (p.id === "completed") continue;
      // 如果 gate 中有 allFalse 且这些 key 不全为 false，说明该阶段已完成
      // 如果 gate 匹配，说明卡在这个阶段
      if (matchGate(p.gate, state)) {
        // 当前阶段及后续未完成阶段都算 missing
        missingSteps.push(p.tools[0] ?? p.id);
      }
    }
  }

  return {
    id: phases[0]?.id ? "workflow" : "",
    active: true,
    phases: phaseIds,
    currentPhase,
    missingSteps: isCompleted ? [] : missingSteps,
  };
}

/**
 * 计算本轮允许的工具 + hint（替代 computeStyleTurnCaps）。
 * 返回 null 表示 workflow 不干预工具选择。
 */
export function resolveAllowedTools(
  workflow: WorkflowDeclaration,
  state: Record<string, unknown>,
  baseAllowed: Set<string>,
): { allowed: Set<string>; hint: string; orchestratorMode: boolean; snapshot: WorkflowSkillPhaseSnapshot } | null {
  const phases = workflow.phases ?? [];
  if (phases.length === 0) return null;

  const snapshot = resolvePhase(workflow, state);
  const currentPhase = phases.find((p) => p.id === snapshot.currentPhase);
  if (!currentPhase) return null;

  const allowed = new Set<string>();
  // 当前阶段声明的工具，取交集（只放行 baseAllowed 中存在的）
  for (const tool of currentPhase.tools) {
    if (baseAllowed.has(tool)) allowed.add(tool);
  }

  return {
    allowed,
    hint: currentPhase.hint ?? "",
    orchestratorMode: true,
    snapshot,
  };
}

/**
 * 检查一批工具调用是否违反 exclusions 规则（替代 analyzeStyleWorkflowBatch 中的违规检测）。
 * 返回违规描述字符串，无违规返回 null。
 */
export function checkExclusions(
  workflow: WorkflowDeclaration,
  toolNames: string[],
): string | null {
  const exclusions = workflow.exclusions ?? [];
  if (exclusions.length === 0 || toolNames.length <= 1) return null;

  const nameSet = new Set(toolNames);
  for (const group of exclusions) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const matched = group.filter((t) => nameSet.has(t));
    if (matched.length >= 2) {
      return `EXCLUSION:${matched.join("+")}`;
    }
  }
  return null;
}

/**
 * 获取 follow-up 消息（替代 _getFollowUpMessages 中的 style 部分）。
 * 闭环未完成时返回消息文本，已完成返回 null。
 */
export function resolveFollowUp(
  workflow: WorkflowDeclaration,
  state: Record<string, unknown>,
): string | null {
  if (!workflow.followUp?.message) return null;
  const snapshot = resolvePhase(workflow, state);
  if (snapshot.currentPhase === "completed") return null;
  // 最后一个阶段也视为 completed
  const phases = workflow.phases ?? [];
  if (phases.length > 0 && snapshot.currentPhase === phases[phases.length - 1].id) return null;
  return workflow.followUp.message;
}

// ── 校验 ──────────────────────────────────────────

/**
 * 校验 WorkflowDeclaration 的基本合法性。
 * 返回错误列表，空数组表示合法。
 */
export function validateWorkflow(workflow: unknown): string[] {
  const errors: string[] = [];
  if (!workflow || typeof workflow !== "object") {
    errors.push("workflow 必须是对象");
    return errors;
  }
  const w = workflow as Record<string, unknown>;

  if (!Array.isArray(w.phases) || w.phases.length === 0) {
    errors.push("workflow.phases 必须是非空数组");
  } else {
    const ids = new Set<string>();
    for (let i = 0; i < (w.phases as any[]).length; i++) {
      const p = (w.phases as any[])[i];
      if (!p?.id) errors.push(`workflow.phases[${i}] 缺少 id`);
      else if (ids.has(p.id)) errors.push(`workflow.phases[${i}] id "${p.id}" 重复`);
      else ids.add(p.id);
      if (!Array.isArray(p?.tools)) errors.push(`workflow.phases[${i}] 缺少 tools 数组`);
    }
  }

  if (w.stateKeys !== undefined && !Array.isArray(w.stateKeys)) {
    errors.push("workflow.stateKeys 必须是数组");
  }

  if (w.exclusions !== undefined) {
    if (!Array.isArray(w.exclusions)) {
      errors.push("workflow.exclusions 必须是数组");
    } else {
      for (let i = 0; i < (w.exclusions as any[]).length; i++) {
        const g = (w.exclusions as any[])[i];
        if (!Array.isArray(g) || g.length < 2) {
          errors.push(`workflow.exclusions[${i}] 必须是长度 ≥ 2 的数组`);
        }
      }
    }
  }

  return errors;
}

/**
 * 将原始 YAML 解析结果规范化为 WorkflowDeclaration。
 * 容忍 camelCase 和 kebab-case。
 */
export function normalizeWorkflow(raw: unknown): WorkflowDeclaration | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const stateKeys = Array.isArray(r.stateKeys ?? r["state-keys"])
    ? ((r.stateKeys ?? r["state-keys"]) as any[]).map((k: any) => String(k ?? "").trim()).filter(Boolean)
    : [];

  const rawPhases = Array.isArray(r.phases) ? r.phases : [];
  const phases: WorkflowPhaseDecl[] = rawPhases.map((p: any) => ({
    id: String(p?.id ?? "").trim(),
    gate: normalizeGate(p?.gate),
    tools: Array.isArray(p?.tools) ? p.tools.map((t: any) => String(t ?? "").trim()).filter(Boolean) : [],
    hint: String(p?.hint ?? "").trim(),
  })).filter((p: WorkflowPhaseDecl) => p.id);

  const rawExclusions = Array.isArray(r.exclusions) ? r.exclusions : [];
  const exclusions = rawExclusions
    .filter((g: any) => Array.isArray(g) && g.length >= 2)
    .map((g: any) => g.map((t: any) => String(t ?? "").trim()).filter(Boolean));

  const rawFollowUp = r.followUp ?? r["follow-up"] ?? r["followUp"];
  const followUp = rawFollowUp && typeof rawFollowUp === "object"
    ? { message: String((rawFollowUp as any).message ?? "").trim() }
    : undefined;

  if (phases.length === 0) return null;

  return { stateKeys, phases, exclusions, followUp: followUp?.message ? followUp : undefined };
}

function normalizeGate(raw: unknown): PhaseGate {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const toArr = (v: unknown) =>
    Array.isArray(v) ? v.map((k: any) => String(k ?? "").trim()).filter(Boolean) : undefined;
  return {
    allTrue: toArr(r.allTrue ?? r["all-true"]),
    allFalse: toArr(r.allFalse ?? r["all-false"]),
    anyTrue: toArr(r.anyTrue ?? r["any-true"]),
  };
}
