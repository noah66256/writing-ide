export type StyleSceneV1 = "topic_only" | "source_rewrite";
export type StanceSourceV1 = "user" | "values";
export type ValuesConstraintModeV1 = "dominant" | "negative_guardrail";
export type FactBoundaryV1 = "only_from_values" | "preserve_source";

export type ElementCardTypeV1 =
  | "hook"
  | "thesis"
  | "ending"
  | "one_liner"
  | "outline"
  | "other";

export type OneLinerSubtypeV1 = "hook" | "punchline" | "ending" | "generic";

export type PlaybookDimensionV1 =
  | "intro"
  | "opening_design"
  | "narrative_structure"
  | "narrative_perspective"
  | "language_style"
  | "one_liner_crafting"
  | "topic_selection"
  | "resonance"
  | "logic_framework"
  | "reader_interaction"
  | "emotion_mobilization"
  | "question_design"
  | "scene_building"
  | "rhetoric"
  | "voice_rhythm"
  | "persuasion"
  | "values_embedding"
  | "structure_patterns"
  | "psychology_principles"
  | "special_markers"
  | "viral_patterns"
  | "ai_clone_strategy";

export type StyleWorkflowStepIdV1 =
  | "tone_setting"
  | "structure"
  | "opening"
  | "body"
  | "language_rhythm"
  | "polish"
  | "closure"
  | "lint_loop";

export type AnalysisLensV1 = {
  id: string;
  label: string;
  prompt: string;
  priority?: number | null;
};

export type ClusterValuesV1 = {
  scope?: string | null;
  principles: string[];
  preferredFrames: string[];
  forbiddenFrames: string[];
  toneKeywords?: string[];
  tabooClaims?: string[];
};

export type ClusterRulesV1 = {
  version: "cluster_rules_v1";
  clusterId: string;
  values: ClusterValuesV1;
  analysisLenses: AnalysisLensV1[];
};

export type StyleTargetRefV1 = {
  libraryId: string;
  clusterId: string;
  clusterRulesVersion: "cluster_rules_v1";
  styleProfileCardId?: string | null;
};

export type SourceMaterialV1 = {
  title?: string | null;
  text: string;
  url?: string | null;
};

export type TaskSpecV1 = {
  version: "v1";
  taskId: string;
  scene: StyleSceneV1;
  prompt: string;
  outputPath?: string | null;
  platform: string | null;
  audience: string | null;
  wordCount: number | null;
  factBoundary: FactBoundaryV1;
  language?: string | null;
  styleTarget: StyleTargetRefV1;
  clusterRules: ClusterRulesV1;
  sourceMaterial?: SourceMaterialV1 | null;
};

export type SourceProtectionV1 = {
  sourceBrief: string;
  invariantClaims: string[];
};

export type ToneCardV1 = {
  version: "v1";
  scene: StyleSceneV1;
  stance: string;
  stanceSource: StanceSourceV1;
  valuesConstraintMode: ValuesConstraintModeV1;
  activeAnalysisLenses: AnalysisLensV1[];
  readerEffectGoal: string;
  preferredFrames: string[];
  forbiddenFrames: string[];
  mustPreserveClaims: string[];
  step3GuardrailBrief: string;
  step6ClosureBrief: string;
  sourceProtection?: SourceProtectionV1 | null;
};

export type StructureSectionRoleV1 = "opening" | "body" | "turn" | "closing";

export type StructureSectionV1 = {
  id: string;
  role: StructureSectionRoleV1;
  title: string;
  objective: string;
  keyPoints: string[];
  paragraphTarget?: number | null;
  mustReferenceClaims?: string[];
};

export type StructureTransitionV1 = {
  fromSectionId: string;
  toSectionId: string;
  bridge: string;
};

export type StructureOutlineV1 = {
  version: "v1";
  thesis: string;
  argumentPath: {
    openingMove: string;
    supportChain: string[];
    turn?: string | null;
    closingMove: string;
  };
  sections: StructureSectionV1[];
  transitions: StructureTransitionV1[];
};

export type DraftStageV1 = "opening" | "body" | "styled" | "polished" | "final";
export type DraftDocumentCoverageV1 = "partial_document" | "full_document";

export type DraftTextPayloadV1 = {
  stage: DraftStageV1;
  text: string;
  coverage: DraftDocumentCoverageV1;
  charCount: number;
  sectionOrder?: string[];
  continuationHints?: {
    rhythm: string[];
    guardrails: string[];
  };
};

export type LintTypeV1 = "copy" | "style";

export type LintReportPayloadV1 = {
  lintType: LintTypeV1;
  passed: boolean;
  score?: number | null;
  issues: string[];
  rewritePrompt?: string | null;
  degraded?: boolean;
};

export type ArtifactPayloadByKindV1 = {
  tone_card: ToneCardV1;
  structure_outline: StructureOutlineV1;
  draft_text: DraftTextPayloadV1;
  lint_report: LintReportPayloadV1;
};

export type StepArtifactKindV1 = keyof ArtifactPayloadByKindV1;
export type StepArtifactStatusV1 = "succeeded" | "degraded" | "failed" | "skipped";

export type ArtifactRefV1 = {
  artifactId: string;
  stepId: StyleWorkflowStepIdV1;
  kind: StepArtifactKindV1;
  attempt: number;
};

export type StepArtifactV1<K extends StepArtifactKindV1 = StepArtifactKindV1> = {
  version: "v1";
  artifactId: string;
  workflowId: string;
  stepId: StyleWorkflowStepIdV1;
  kind: K;
  status: StepArtifactStatusV1;
  attempt: number;
  createdAt: string;
  inputRefs: ArtifactRefV1[];
  payload: ArtifactPayloadByKindV1[K];
  llm?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  };
  metrics?: {
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  };
  warnings?: string[];
};

export type StepMaterialsV1 = {
  clusterRules?: ClusterRulesV1 | null;
  styleProfileCard?: {
    cardId: string;
    title: string;
    content: string;
  } | null;
  playbookCards?: Array<{
    cardId: string;
    dimension: PlaybookDimensionV1;
    title: string;
    content: string;
  }>;
  elementCards?: Array<{
    cardId: string;
    type: ElementCardTypeV1;
    subtype?: OneLinerSubtypeV1;
    title: string;
    content: string;
  }>;
};

export type StylePipelinePayloadV1 = {
  version: "v1";
  pipelineConfigId: string;
  taskSpec: TaskSpecV1;
  materialsByStep: Partial<Record<StyleWorkflowStepIdV1, StepMaterialsV1>>;
};

export type PipelineArtifactsV1 = {
  toneCard?: ToneCardV1 | null;
  structureOutline?: StructureOutlineV1 | null;
  openingDraft?: string | null;
  bodyDraft?: string | null;
  styledDraft?: string | null;
  polishedDraft?: string | null;
  finalDraft?: string | null;
};

export type StyleExecutionMode = "agent_v1" | "pipeline_v1";
