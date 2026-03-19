// 先提供最小占位，后续会把 desktop 里的 mock run/step 事件模型沉淀到这里
export type AgentMode = "agent" | "chat";

export type { ParsedToolCall } from "./runMachine.js";

export type { TriggerRule, SkillManifest, ActiveSkill, SkillConfigOverride, SkillConfig, RegisterSkillOptions } from "./skills.js";
export type {
  PipelineDeclaration,
  PipelineLintConfig,
  PipelineStepDecl,
} from "./skills.js";
export {
  SkillRegistry, skillRegistry, listRegisteredSkills,
  SKILL_MANIFESTS_V1,
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

export type {
  WorkflowSkillPhaseSnapshot,
  PhaseGate,
  WorkflowPhaseDecl,
  WorkflowFollowUp,
  WorkflowDeclaration,
} from "./workflowPhaseInterpreter.js";
export {
  matchGate,
  resolvePhase,
  resolveAllowedTools,
  checkExclusions,
  resolveFollowUp,
  validateWorkflow,
  normalizeWorkflow,
} from "./workflowPhaseInterpreter.js";

export type {
  StyleSceneV1,
  StanceSourceV1,
  ValuesConstraintModeV1,
  FactBoundaryV1,
  ElementCardTypeV1,
  OneLinerSubtypeV1,
  PlaybookDimensionV1,
  StyleWorkflowStepIdV1,
  AnalysisLensV1,
  ClusterValuesV1,
  ClusterRulesV1,
  StyleTargetRefV1,
  SourceMaterialV1,
  TaskSpecV1,
  SourceProtectionV1,
  ToneCardV1,
  StructureSectionRoleV1,
  StructureSectionV1,
  StructureTransitionV1,
  StructureOutlineV1,
  DraftStageV1,
  DraftDocumentCoverageV1,
  DraftTextPayloadV1,
  LintTypeV1,
  LintReportPayloadV1,
  StepArtifactKindV1,
  StepArtifactStatusV1,
  ArtifactRefV1,
  StepArtifactV1,
  StepMaterialsV1,
  StylePipelinePayloadV1,
  PipelineArtifactsV1,
  StyleExecutionMode,
} from "./styleWorkflowTypes.js";
export type {
  StepContextPolicyV1,
  CardRetrievalConfigV1,
  WorkflowStepConfig,
  PipelineConfigV1,
} from "./styleWorkflowConfig.js";
export { STYLE_WORKFLOW_PIPELINE_CONFIG_V1 } from "./styleWorkflowConfig.js";
