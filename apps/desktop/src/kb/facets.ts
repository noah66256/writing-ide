export type FacetPackId = "speech_marketing_v1" | "novel_v1";

export type FacetDef = {
  id: string;
  label: string;
};

export type FacetPack = {
  id: FacetPackId;
  label: string;
  facets: FacetDef[];
};

export const FACET_PACKS: FacetPack[] = [
  {
    id: "speech_marketing_v1",
    label: "口播/营销（v1）",
    facets: [
      { id: "intro", label: "引言" },
      { id: "opening_design", label: "开场设计" },
      { id: "narrative_structure", label: "叙事结构" },
      { id: "narrative_perspective", label: "叙事视角" },
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
    ],
  },
  {
    id: "novel_v1",
    label: "小说（v1，占位）",
    facets: [
      { id: "world_setting", label: "世界观/设定" },
      { id: "character_arc", label: "人物弧光" },
      { id: "plot_structure", label: "情节结构" },
      { id: "pacing_tension", label: "节奏/张力" },
      { id: "dialogue", label: "对白" },
      { id: "scene_goal_conflict", label: "场景目标/冲突" },
      { id: "viewpoint_voice", label: "视角/叙述声音" },
      { id: "foreshadowing_payoff", label: "伏笔/回收" },
    ],
  },
];

export function getFacetPack(id?: string | null): FacetPack {
  const key = String(id ?? "").trim();
  const found = FACET_PACKS.find((p) => p.id === key);
  return found ?? FACET_PACKS[0]!;
}

export function facetPackLabel(id?: string | null) {
  return getFacetPack(id).label;
}

const FACET_LABEL: Record<string, string> = Object.fromEntries(
  FACET_PACKS.flatMap((p) => p.facets.map((f) => [f.id, f.label] as const)),
);

export function facetLabel(id: string) {
  const k = String(id ?? "").trim();
  return FACET_LABEL[k] ?? k;
}



