import type { OpenAiChatMessage } from "../llm/openaiCompat.js";
import {
  buildBridgeSkillCards,
  type BridgeSkillDescriptor,
  type SkillCard,
} from "./capabilityIndex.js";
import { buildSkillCapabilitySummary } from "./contextAssembler.js";

function trim(v: unknown): string {
  return String(v ?? "").trim();
}

export type ClaudeCliBridgeSelectionInput = {
  query: string;
  installedSkills?: BridgeSkillDescriptor[];
  syntheticSkills?: BridgeSkillDescriptor[];
};

export type ClaudeCliBridgeSelectionContext = {
  installedCards: SkillCard[];
  syntheticCards: SkillCard[];
  mergedCards: SkillCard[];
  summaryText: string;
  messages: OpenAiChatMessage[];
};

export function buildClaudeCliBridgeSelectionContext(
  args: ClaudeCliBridgeSelectionInput,
): ClaudeCliBridgeSelectionContext {
  const installedCards = buildBridgeSkillCards({
    skills: Array.isArray(args.installedSkills) ? args.installedSkills : [],
    defaultSource: "user",
    synthetic: false,
  });
  const syntheticCards = buildBridgeSkillCards({
    skills: Array.isArray(args.syntheticSkills) ? args.syntheticSkills : [],
    defaultSource: "user",
    synthetic: true,
  });
  const mergedCards = [...installedCards, ...syntheticCards];
  const summaryText = buildSkillCapabilitySummary({
    skillCapabilityCards: installedCards,
    syntheticSkillCapabilityCards: syntheticCards,
  });
  const query = trim(args.query);
  const userContent = [
    "请根据下面的 skill 能力摘要，判断用户 query 是否应该触发其中某一个 skill。",
    summaryText || "【Skill 候选摘要】\n- 当前没有可用 skill。",
    `【用户 Query】\n${query}`,
  ].join("\n\n");
  const messages: OpenAiChatMessage[] = [
    {
      role: "system",
      content:
        "你在 Crab 中模拟 Claude Code 的 skill 触发选择器。目标是保守且准确地判断：用户 query 是否明显需要某个 skill。\n" +
        "规则：\n" +
        "- 只能选择一个最匹配的 skill，或返回 none。\n" +
        "- 只有当 skill 描述明显覆盖用户意图时才选择；不要因为关键词轻微重合就误触发。\n" +
        "- synthetic 临时 skills 只在当前 bridge 调用可见，选择逻辑与普通 skill 相同。\n" +
        '只返回 JSON，不要输出解释文本。格式：{"decision":"skill"|"none","skill":"skill-id 或空串","reason":"一句短理由"}',
    },
    {
      role: "user",
      content: userContent,
    },
  ];
  return {
    installedCards,
    syntheticCards,
    mergedCards,
    summaryText,
    messages,
  };
}
