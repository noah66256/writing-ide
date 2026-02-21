/**
 * Sub-agent 定义与预置角色
 * @see docs/specs/sub-agent-architecture-v0.1.md Section 三
 */

export type SubAgentBudget = {
  /** 最大推理轮数 */
  maxTurns: number;
  /** 最大工具调用次数 */
  maxToolCalls: number;
  /** 超时（毫秒） */
  timeoutMs: number;
};

export interface SubAgentDefinition {
  /** 唯一标识，如 "copywriter"、"seo_specialist" */
  id: string;
  /** 显示名，如 "文案写手" */
  name: string;
  /** 头像（emoji 或图片 URL） */
  avatar?: string;
  /** 一句话职责——负责人/Router 读这个来决定派谁 */
  description: string;
  /** 完整 system prompt */
  systemPrompt: string;
  /** 允许使用的工具 ID 列表 */
  tools: string[];
  /** 允许激活的技能 ID 列表 */
  skills: string[];
  /** 允许使用的 MCP Server ID 列表（v0.1 预留） */
  mcpServers: string[];
  /** 偏好模型 */
  model: string;
  /** 降级模型列表，按优先级排列 */
  fallbackModels?: string[];
  /** 工具权限策略 */
  toolPolicy: "readonly" | "proposal_first" | "auto_apply";
  /** 执行预算——防止子 Agent 失控 */
  budget: SubAgentBudget;
  /** 辅助自动匹配的关键词/意图模式 */
  triggerPatterns?: string[];
  /** 优先级——多个 Agent 匹配时取高优先级 */
  priority?: number;
  /** 是否启用 */
  enabled: boolean;
  /** 版本号——配置变更追踪 */
  version?: string;
}

/** 预置子 Agent 列表 */
export const BUILTIN_SUB_AGENTS: SubAgentDefinition[] = [
  {
    id: "copywriter",
    name: "文案写手",
    avatar: "✍️",
    description: "负责公众号/小红书/口播等内容写作与改写交付。",
    systemPrompt: "[TODO] copywriter system prompt；待从主 Agent prompt 拆分",
    tools: ["kb.search", "doc.write", "doc.applyEdits", "lint.style", "lint.copy"],
    skills: ["style_imitate"],
    mcpServers: [],
    model: "sonnet",
    fallbackModels: ["haiku"],
    toolPolicy: "proposal_first",
    budget: {
      maxTurns: 15,
      maxToolCalls: 30,
      timeoutMs: 120_000,
    },
    triggerPatterns: ["写文案", "改写", "润色", "小红书", "公众号", "口播"],
    priority: 100,
    enabled: true,
    version: "0.1.0",
  },
  {
    id: "topic_planner",
    name: "选题策划",
    avatar: "🔍",
    description: "负责热点追踪、选题日历、竞品分析与内容规划。",
    systemPrompt: "[TODO] topic_planner system prompt；待拆分",
    tools: ["web.search", "web.fetch", "time.now", "kb.search"],
    skills: [],
    mcpServers: [],
    model: "haiku",
    fallbackModels: ["sonnet"],
    toolPolicy: "readonly",
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      timeoutMs: 90_000,
    },
    triggerPatterns: ["选题", "热点", "话题", "竞品", "内容规划"],
    priority: 90,
    enabled: true,
    version: "0.1.0",
  },
  {
    id: "seo_specialist",
    name: "SEO 专员",
    avatar: "📊",
    description: "负责关键词研究、标签优化、标题改写以提升搜索曝光。",
    systemPrompt: "[TODO] seo_specialist system prompt；待拆分",
    tools: ["web.search", "web.fetch", "kb.search"],
    skills: [],
    mcpServers: [],
    model: "haiku",
    fallbackModels: ["sonnet"],
    toolPolicy: "readonly",
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      timeoutMs: 90_000,
    },
    triggerPatterns: ["SEO", "关键词", "标签", "搜索优化", "标题优化"],
    priority: 80,
    enabled: true,
    version: "0.1.0",
  },
];
