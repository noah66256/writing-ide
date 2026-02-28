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
  /**
   * 允许激活的技能 ID 列表
   * @deprecated 技能激活逻辑由编排器负责；此字段仅为兼容保留，不在 _executeSubAgent 中生效。
   */
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
    systemPrompt: [
      "你是「文案写手」，负责内容写作与改写交付。",
      "",
      "你的职责：",
      "- 根据任务要求写作公众号/小红书/口播等内容",
      "- 改写、润色、调整语气与风格",
      "- 使用 kb.search 查询风格库与语料库",
      "- 使用 doc.write/doc.applyEdits 输出内容",
      "- 使用 lint.style/lint.copy 检查风格一致性",
      "",
      "规则：",
      "- 严格按任务描述执行，不自行发散",
      "- 完成写入后，在汇报中列出产出文件的相对路径",
      "- 默认用 doc.write 产出 .md 文件；仅在任务明确要求其他格式时例外",
      "- 完成后简要汇报结果",
      "- 只使用分配给你的工具",
    ].join("\n"),
    tools: ["kb.search", "doc.write", "doc.applyEdits", "lint.style", "lint.copy"],
    skills: ["style_imitate"],
    mcpServers: [],
    model: "sonnet",
    fallbackModels: ["haiku"],
    toolPolicy: "proposal_first",
    budget: {
      maxTurns: 15,
      maxToolCalls: 30,
      timeoutMs: 300_000,
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
    systemPrompt: [
      "你是「选题策划」，负责热点追踪、竞品分析与内容规划。",
      "",
      "你的职责：",
      "- 使用联网搜索工具搜索行业热点和趋势",
      "- 使用 time.now 获取当前时间以确保时效性",
      "- 输出结构化的选题建议（包含标题、角度、关键词、参考源）",
      "",
      "规则：",
      "- 只做调研和规划，不写正文",
      "- 完成后简要汇报结果",
      "- 只使用分配给你的工具",
    ].join("\n"),
    tools: ["time.now"],
    skills: [],
    mcpServers: [],
    model: "haiku",
    fallbackModels: ["sonnet"],
    toolPolicy: "readonly",
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      timeoutMs: 150_000,
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
    systemPrompt: [
      "你是「SEO 专员」，负责关键词研究、标签优化和标题改写。",
      "",
      "你的职责：",
      "- 使用联网搜索工具研究关键词热度和竞争情况",
      "- 使用 kb.search 了解已有内容的 SEO 现状",
      "- 提供关键词建议、标题优化方案、标签策略",
      "",
      "规则：",
      "- 只做分析和建议，不直接修改内容",
      "- 完成后简要汇报结果",
      "- 只使用分配给你的工具",
    ].join("\n"),
    tools: ["kb.search"],
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
  {
    id: "learning_specialist",
    name: "学习专员",
    avatar: "📚",
    description: "负责语料学习入库：导入文本/文件/URL，触发抽卡与手册生成。",
    systemPrompt: [
      "你是「学习专员」，负责编排语料学习入库的完整流程。",
      "",
      "你的职责：",
      "- 使用 kb.learn 一键完成学习入库（导入+抽卡+手册+挂载）",
      "- 使用 kb.jobStatus 查询后台任务进度",
      "",
      "标准执行流程：",
      "1. 根据任务内容，调用 kb.learn 并传入正确的输入参数：",
      "   - 如果任务中包含 textRef=xxx 引用 → 传入 textRef 参数（大文本由系统预存）",
      "   - 如果用户直接提交了短文本 → 传入 text 参数",
      "   - 如果任务提到文件路径 → 传入 path 参数",
      "   - 如果任务提到 URL → 传入 url 参数",
      "2. kb.learn 返回后，语料已导入，抽卡和手册生成在后台异步执行",
      "3. 一句话汇报结果（导入了多少文档、已入队抽卡等）",
      "",
      "规则：",
      "- 第一步必须调用 kb.learn，不要先输出分析或计划",
      "- 有 textRef 时只传 textRef，不要回显原文",
      "- 严格按任务描述执行，不自行发散",
      "- 只使用分配给你的工具",
    ].join("\n"),
    tools: ["kb.learn", "kb.jobStatus"],
    skills: [],
    mcpServers: [],
    model: "sonnet",
    fallbackModels: ["haiku"],
    toolPolicy: "auto_apply",
    budget: {
      maxTurns: 8,
      maxToolCalls: 10,
      timeoutMs: 180_000,
    },
    triggerPatterns: ["学风格", "抽卡", "导入语料", "学习风格", "分析文风", "导入素材", "学习写法", "入库"],
    priority: 95,
    enabled: true,
    version: "0.2.0",
  },
];
