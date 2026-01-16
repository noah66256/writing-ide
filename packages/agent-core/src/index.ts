// 先提供最小占位，后续会把 desktop 里的 mock run/step 事件模型沉淀到这里
export type AgentMode = "plan" | "agent" | "chat";

export type { ParsedToolCall } from "./xmlProtocol.js";
export { isToolCallMessage, parseToolCalls, renderToolErrorXml, renderToolResultXml } from "./xmlProtocol.js";

export type { TriggerRule, SkillManifest, ActiveSkill } from "./skills.js";
export { SKILL_MANIFESTS_V1, STYLE_IMITATE_SKILL, activateSkills, pickSkillStageKeyForAgentRun, parseActiveSkillsFromContextPack } from "./skills.js";

export type {
  KbSelectedLibrary,
  RunIntent,
  RunGates,
  StyleLintParsed,
  RunState,
  AutoRetryAnalysis,
  StyleWorkflowBatchAnalysis,
} from "./runMachine.js";
export {
  createInitialRunState,
  parseMainDocFromContextPack,
  parseKbSelectedLibrariesFromContextPack,
  parseRunTodoFromContextPack,
  detectRunIntent,
  deriveStyleGate,
  looksLikeClarifyQuestions,
  looksLikeFIMLeak,
  looksLikeDraftText,
  looksLikeHasCTA,
  styleNeedsCta,
  isWriteLikeTool,
  isStyleExampleKbSearch,
  parseStyleLintResult,
  analyzeAutoRetryText,
  analyzeStyleWorkflowBatch,
  isProposalWaitingMeta,
} from "./runMachine.js";









