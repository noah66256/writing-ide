// 先提供最小占位，后续会把 desktop 里的 mock run/step 事件模型沉淀到这里
export type AgentMode = "agent" | "chat";

export type { ParsedToolCall } from "./runMachine.js";

export type { TriggerRule, SkillManifest, ActiveSkill, SkillConfigOverride, SkillConfig, RegisterSkillOptions } from "./skills.js";
export {
  SkillRegistry, skillRegistry, listRegisteredSkills,
  SKILL_MANIFESTS_V1, STYLE_IMITATE_SKILL,
  activateSkills, pickSkillStageKeyForAgentRun, parseActiveSkillsFromContextPack, mergeSkillManifests,
} from "./skills.js";

export type {
  KbSelectedLibrary,
  RunIntent,
  RunGates,
  StyleLintParsed,
  RunState,
  AutoRetryAnalysis,
  StyleWorkflowBatchAnalysis,
  SideEffectRecordV1,
} from "./runMachine.js";

export type { WorkflowSkillPhaseSnapshot, WorkflowSkillContract } from "./workflowSkills.js";
export { getWorkflowSkillContracts, getActiveWorkflowSkills, planStyleNextStep } from "./workflowSkills.js";
export {
  createInitialRunState,
  parseMainDocFromContextPack,
  parseKbSelectedLibrariesFromContextPack,
  parseRunTodoFromContextPack,
  detectRunIntent,
  looksLikeFreshWritingTaskPrompt,
  deriveStyleGate,
  looksLikeClarifyQuestions,
  looksLikeFIMLeak,
  looksLikeDraftText,
  looksLikeHasCTA,
  styleNeedsCta,
  isWriteLikeTool,
  isContentWriteTool,
  isStyleExampleKbSearch,
  parseStyleLintResult,
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  isProposalWaitingMeta,
} from "./runMachine.js";

export type { SubAgentDefinition, SubAgentBudget } from "./subAgent.js";
export { BUILTIN_SUB_AGENTS } from "./subAgent.js";









