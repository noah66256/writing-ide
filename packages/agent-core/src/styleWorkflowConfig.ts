import type {
  ElementCardTypeV1,
  OneLinerSubtypeV1,
  PlaybookDimensionV1,
  StepArtifactKindV1,
  StyleWorkflowStepIdV1,
} from "./styleWorkflowTypes.js";

export type StepContextPolicyV1 = {
  includeTaskSpec: boolean;
  includeToneCard: boolean;
  includeStructureOutline: boolean;
  includePreviousDraft: "none" | "previous_full";
  includeBestDraft: boolean;
  rawPromptMode: "full" | "normalized_only";
  maxInputTokensRatio?: number;
};

export type CardRetrievalConfigV1 = {
  topDocs?: number;
  perDocTopN?: number;
  groupBy?: "source_doc";
  dedupeBy?: "source_doc" | "card_id";
  allowEmpty?: boolean;
};

export type WorkflowStepConfig = {
  id: StyleWorkflowStepIdV1;
  title: string;
  executor: "llm" | "lint_loop";
  dependsOn: StyleWorkflowStepIdV1[];
  cards: {
    playbookDimensions?: PlaybookDimensionV1[];
    elementCardTypes?: ElementCardTypeV1[];
    oneLinerSubtypes?: OneLinerSubtypeV1[];
    includeClusterRules?: boolean;
    includeStyleProfile?: boolean;
  };
  retrieval: CardRetrievalConfigV1 | null;
  context: StepContextPolicyV1;
  llm: {
    stage: string;
    temperature: number;
    maxOutputTokens: number;
    responseFormat: "json_schema" | "plain_text";
  } | null;
  lint: {
    maxCopyAttempts: number;
    maxStyleAttempts: number;
    pickBestOnExhaust: boolean;
  } | null;
  output: {
    kind: StepArtifactKindV1;
    schemaName: string;
    cumulativeDraft?: boolean;
  };
};

export type PipelineConfigV1 = {
  version: "v1";
  id: string;
  stepOrder: StyleWorkflowStepIdV1[];
  steps: Record<StyleWorkflowStepIdV1, WorkflowStepConfig>;
  global: {
    effectiveInputBudgetRatio: number;
    artifactMode?: "ref_first";
    draftStorage?: "item_payload_only";
    stylePass: {
      mode: "full_then_chunked_fallback";
      fullPassMaxInputRatio: number;
      chunkTargetTokens: number;
      chunkOverlapTokens: number;
      seamLintRequired: boolean;
    };
    lint: {
      maxCopyAttempts: number;
      maxStyleAttempts: number;
      pickBestOnExhaust: boolean;
    };
  };
};

export const STYLE_WORKFLOW_PIPELINE_CONFIG_V1: PipelineConfigV1 = {
  version: "v1",
  id: "styleWorkflowPipelineConfigV1",
  stepOrder: [
    "tone_setting",
    "structure",
    "opening",
    "body",
    "language_rhythm",
    "polish",
    "closure",
    "lint_loop",
  ],
  global: {
    effectiveInputBudgetRatio: 0.8,
    artifactMode: "ref_first",
    draftStorage: "item_payload_only",
    stylePass: {
      mode: "full_then_chunked_fallback",
      fullPassMaxInputRatio: 0.45,
      chunkTargetTokens: 4000,
      chunkOverlapTokens: 300,
      seamLintRequired: true,
    },
    lint: {
      maxCopyAttempts: 3,
      maxStyleAttempts: 3,
      pickBestOnExhaust: true,
    },
  },
  steps: {
    tone_setting: {
      id: "tone_setting",
      title: "定调",
      executor: "llm",
      dependsOn: [],
      cards: { includeClusterRules: true },
      retrieval: null,
      context: {
        includeTaskSpec: true,
        includeToneCard: false,
        includeStructureOutline: false,
        includePreviousDraft: "none",
        includeBestDraft: false,
        rawPromptMode: "full",
        maxInputTokensRatio: 0.1,
      },
      llm: { stage: "style.workflow.tone", temperature: 0.3, maxOutputTokens: 1200, responseFormat: "json_schema" },
      lint: null,
      output: { kind: "tone_card", schemaName: "ToneCardV1" },
    },
    structure: {
      id: "structure",
      title: "骨架",
      executor: "llm",
      dependsOn: ["tone_setting"],
      cards: {
        playbookDimensions: ["topic_selection", "logic_framework", "narrative_structure", "structure_patterns"],
        elementCardTypes: ["outline", "thesis"],
      },
      retrieval: { topDocs: 6, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: false,
        includePreviousDraft: "none",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.16,
      },
      llm: { stage: "style.workflow.structure", temperature: 0.35, maxOutputTokens: 1600, responseFormat: "json_schema" },
      lint: null,
      output: { kind: "structure_outline", schemaName: "StructureOutlineV1" },
    },
    opening: {
      id: "opening",
      title: "开场",
      executor: "llm",
      dependsOn: ["tone_setting", "structure"],
      cards: {
        playbookDimensions: ["opening_design", "intro", "question_design", "viral_patterns"],
        elementCardTypes: ["hook", "one_liner"],
        oneLinerSubtypes: ["hook"],
      },
      retrieval: { topDocs: 6, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "none",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.2,
      },
      llm: { stage: "style.workflow.opening", temperature: 0.7, maxOutputTokens: 1800, responseFormat: "plain_text" },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },
    body: {
      id: "body",
      title: "主体",
      executor: "llm",
      dependsOn: ["tone_setting", "structure", "opening"],
      cards: {
        playbookDimensions: ["scene_building", "emotion_mobilization", "resonance", "persuasion", "psychology_principles", "reader_interaction", "narrative_perspective"],
        elementCardTypes: ["thesis", "outline", "other"],
      },
      retrieval: { topDocs: 8, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.32,
      },
      llm: { stage: "style.workflow.body", temperature: 0.65, maxOutputTokens: 3200, responseFormat: "plain_text" },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },
    language_rhythm: {
      id: "language_rhythm",
      title: "语言风格",
      executor: "llm",
      dependsOn: ["opening", "body"],
      cards: {
        playbookDimensions: ["voice_rhythm", "language_style"],
        elementCardTypes: ["one_liner", "other"],
        includeStyleProfile: true,
      },
      retrieval: { topDocs: 8, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.4,
      },
      llm: { stage: "style.workflow.language", temperature: 0.35, maxOutputTokens: 3600, responseFormat: "plain_text" },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1", cumulativeDraft: true },
    },
    polish: {
      id: "polish",
      title: "点睛",
      executor: "llm",
      dependsOn: ["language_rhythm"],
      cards: {
        playbookDimensions: ["rhetoric", "special_markers", "viral_patterns", "one_liner_crafting"],
        elementCardTypes: ["one_liner", "other"],
        oneLinerSubtypes: ["punchline"],
      },
      retrieval: { topDocs: 8, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.4,
      },
      llm: { stage: "style.workflow.polish", temperature: 0.55, maxOutputTokens: 2200, responseFormat: "plain_text" },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1", cumulativeDraft: true },
    },
    closure: {
      id: "closure",
      title: "收束",
      executor: "llm",
      dependsOn: ["polish"],
      cards: {
        playbookDimensions: ["values_embedding"],
        elementCardTypes: ["ending", "one_liner"],
        oneLinerSubtypes: ["ending"],
      },
      retrieval: { topDocs: 6, perDocTopN: 2, groupBy: "source_doc", dedupeBy: "card_id", allowEmpty: true },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.25,
      },
      llm: { stage: "style.workflow.closure", temperature: 0.45, maxOutputTokens: 1200, responseFormat: "plain_text" },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1", cumulativeDraft: true },
    },
    lint_loop: {
      id: "lint_loop",
      title: "Lint 闭环",
      executor: "lint_loop",
      dependsOn: ["closure"],
      cards: {},
      retrieval: null,
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: true,
        rawPromptMode: "normalized_only",
      },
      llm: null,
      lint: { maxCopyAttempts: 3, maxStyleAttempts: 3, pickBestOnExhaust: true },
      output: { kind: "lint_report", schemaName: "LintReportPayloadV1" },
    },
  },
};
