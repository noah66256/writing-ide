export type OutlineFacetId =
  | "intro"
  | "opening_design"
  | "narrative_structure"
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

export const OUTLINE_FACETS: Array<{ id: OutlineFacetId; label: string }> = [
  { id: "intro", label: "引言" },
  { id: "opening_design", label: "开场设计" },
  { id: "narrative_structure", label: "叙事结构" },
  { id: "language_style", label: "语言风格" },
  { id: "one_liner_crafting", label: "金句制造" },
  { id: "topic_selection", label: "话题选择" },
  { id: "resonance", label: "引人共鸣" },
  { id: "logic_framework", label: "逻辑架构" },
  { id: "reader_interaction", label: "读者互动设计" },
  { id: "emotion_mobilization", label: "情感调动" },
  { id: "question_design", label: "问题设置" },
  { id: "scene_building", label: "场景营造" },
  { id: "rhetoric", label: "修辞手法" },
  { id: "voice_rhythm", label: "声音节奏" },
  { id: "persuasion", label: "说服力构建" },
  { id: "values_embedding", label: "价值观植入" },
  { id: "structure_patterns", label: "结构反复模式" },
  { id: "psychology_principles", label: "心理学原理应用" },
  { id: "special_markers", label: "特殊文本标记/结构" },
  { id: "viral_patterns", label: "爆款模式归纳" },
  { id: "ai_clone_strategy", label: "AI 复刻策略" },
];

export const OUTLINE_FACET_LABEL: Record<string, string> = Object.fromEntries(OUTLINE_FACETS.map((x) => [x.id, x.label]));

export function facetLabel(id: string) {
  return OUTLINE_FACET_LABEL[String(id ?? "").trim()] ?? String(id ?? "").trim();
}



