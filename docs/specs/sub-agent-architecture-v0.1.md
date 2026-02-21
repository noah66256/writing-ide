# Sub-agent 架构规范 v0.1

> **状态**：draft（2026-02-21）
> **前置**：[产品定位与角色覆盖 v0.1](product-positioning-v0.1.md)
> **目标**：定义子 Agent（员工）的标准化接口、两种通信模式、群聊 UI、设置机制，为主 Agent 单体向多 Agent 协作平滑过渡提供工程蓝图。

---

## 一、背景与动机

### 当前状态

主 Agent 以"负责人"身份运行，prompt 中声明 11 个角色，所有任务由同一个推理循环处理。

### 问题

| 问题 | 表现 |
|------|------|
| **角色稀释** | 11 个角色挤一个 prompt，模型注意力被分散，专业度不够 |
| **工具膨胀** | 所有工具对所有任务暴露（20+），降低工具调用准确率 |
| **成本浪费** | 简单检索任务也用 Sonnet/Opus，该用 Haiku 的场景没法区分 |
| **不可扩展** | 新增角色只能往 prompt 里加段落，prompt 越来越长 |

### 目标

- 标准化 `SubAgentDefinition` 接口——每个角色一份配置
- 支持**中转模式**（默认）和**广播模式**（脑暴场景）两种通信机制
- 前端变**群聊 UI**——普通消息发给负责人，@ 指派特定员工
- 设置页可配置团队成员——增删改 Sub-agent，调整 prompt/工具/模型

---

## 二、分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 · 用户界面层（群聊 UI）                              │
│                                                               │
│  普通消息 → 负责人          @文案写手 → 直接调起子Agent       │
│  @写手 @SEO → 负责人协调多Agent     拖拽文件/图片 → 附件     │
│  @ 浮层分类：团队成员 / 文件 / 知识库                         │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2 · Agent 调度层                                       │
│                                                               │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │ 负责人 Agent      │    │ Sub-agent 池                  │   │
│  │ (主 Agent)        │───→│ ├ 文案写手      model=sonnet  │   │
│  │                   │    │ ├ 选题策划      model=haiku   │   │
│  │ · 理解意图        │←───│ ├ SEO 专员      model=haiku   │   │
│  │ · 自己处理 or 派发│    │ ├ 数据分析师    model=sonnet  │   │
│  │ · 汇总交付        │    │ ├ 投流顾问      model=sonnet  │   │
│  │ · 质量闸门        │    │ ├ ...                         │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 共享上下文                                             │   │
│  │ ├ mainDoc（项目主线）  ├ 向量记忆库（历史决策/素材）   │   │
│  │ ├ KB 知识库（按权限）  └ 项目文件（按权限）            │   │
│  └──────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3 · 能力层（Agent 内部使用，用户不直接接触）            │
│                                                               │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────────┐       │
│  │  Tools    │  │  Skills       │  │  MCP Servers     │       │
│  │ kb.search │  │ style_imitate │  │ 聚光投放 API     │       │
│  │ doc.write │  │ corpus_ingest │  │ 小红书开放平台   │       │
│  │ web.fetch │  │ web_topic     │  │ 企微 API         │       │
│  │ bash.exec │  │ excel_gen     │  │ ...              │       │
│  │ lint.style│  │ ...           │  │                  │       │
│  └──────────┘  └──────────────┘  └─────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**：

- 用户只与**人（Agent）**交互，不与工具/技能/MCP 直接交互
- Skills 和 MCP 是 Agent 内部的能力，被 Agent 配置引用
- 负责人是面向用户的调度员；子 Agent 通过负责人委托或 @ 语法被调起
- **@ 直达的本质**：用户 `@写手` 在 UI 层是直达，但服务端仍包装为负责人的 `agent.delegate` 调用（保持职责链完整、确保闸门不被绕过）

---

## 三、SubAgentDefinition 标准接口

```typescript
interface SubAgentDefinition {
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

  /** 允许激活的技能 ID 列表（Skill prompt 片段会注入 systemPrompt） */
  skills: string[];

  /** 允许使用的 MCP Server ID 列表（v0.1 预留，当前 MCP 尚未接入 Gateway） */
  mcpServers: string[];

  /** 偏好模型（可降级到 fallbackModels） */
  model: string;

  /** 降级模型列表，按优先级排列 */
  fallbackModels?: string[];

  /** 工具权限策略 */
  toolPolicy: "readonly" | "proposal_first" | "auto_apply";

  /** 执行预算——防止子 Agent 失控 */
  budget: {
    maxTurns: number;       // 最大推理轮数，如 15
    maxToolCalls: number;   // 最大工具调用次数，如 30
    timeoutMs: number;      // 超时（毫秒），如 120000
  };

  /** 辅助自动匹配的关键词/意图模式（可选） */
  triggerPatterns?: string[];

  /** 优先级——多个 Agent 匹配时取高优先级 */
  priority?: number;

  /** 是否启用 */
  enabled: boolean;

  /** 版本号——配置变更追踪 */
  version?: string;
}
```

### 与现有概念的关系

| 概念 | 本质 | 有无独立推理循环 | 用户是否可见 |
|------|------|-----------------|-------------|
| **Tool** | 原子操作（`kb.search`） | 无 | 不可见 |
| **Skill** | prompt 片段 + 工具组合，注入当前 Agent | 无（增强宿主 Agent） | 不可见 |
| **MCP Server** | 外部服务能力模块 | 无 | 不可见 |
| **Sub-agent** | 独立推理循环的 Agent 实例 | **有** | **可见（群聊中有身份）** |

类比：Skill 是员工**学会的技能**（会 Excel、会 PS）；Sub-agent 是一个**人**（文案写手、SEO 专员）。

### 与 Anthropic Agent SDK 的映射

| 本项目 | Agent SDK |
|--------|-----------|
| `SubAgentDefinition` | `AgentDefinition` |
| `agent.delegate` 工具 | `Task` 工具 |
| `description` | `description`（SDK 用此字段让主 Agent 决定何时调起） |
| `tools` + `skills` | `tools`（SDK 只有工具维度，Skills 是我们的扩展层） |
| `model` | `model: "sonnet" \| "opus" \| "haiku" \| "inherit"` |

**约束**：子 Agent **不可再委托**其他子 Agent（单层限制，防止无限嵌套）。若任务需要多 Agent 串联，由负责人编排。

---

## 四、通信模型 — 两种模式

### 模式 A：中转模式（Relay）— 默认

```
用户 ──消息──→ 负责人
                 │
                 ├─ 简单任务 → 自己回复
                 │
                 ├─ 专业任务 → agent.delegate(copywriter, 任务摘要)
                 │                  ↓
                 │              文案写手 Agent
                 │              ├ 拿到：systemPrompt + 任务摘要 + 共享上下文
                 │              ├ 独立推理 + 调工具
                 │              └ 返回：结构化产物（artifact）
                 │                  ↓
                 ├─ 需要串联 → agent.delegate(seo, 基于写手产物优化)
                 │                  ↓
                 │              SEO Agent (拿到写手产物作为输入)
                 │                  ↓
                 └─ 汇总所有产物 → 回复用户
```

**委托协议**：

```typescript
// 负责人调用 agent.delegate 工具
{
  name: "agent.delegate",
  input: {
    agentId: "copywriter",           // 目标子 Agent
    task: "写一篇小红书种草文...",     // 任务描述
    inputArtifacts?: ["draft.v1"],    // 上游产物引用（串联场景）
    acceptanceCriteria?: "...",       // 验收标准
    budget?: { maxTurns: 10 }        // 可覆盖默认预算
  }
}
```

**特点**：
- 子 Agent 之间**不直接通信**——通过负责人中转，或通过共享上下文（mainDoc/KB）间接协作
- 负责人可按 **DAG** 调度：可并行的任务并行（选题+竞品检索），串行的按依赖（写稿→SEO→质检）
- 子 Agent 产出**结构化 artifact**（如 `{ type: "draft", content, metadata }`），不是纯文本消息
- **省 token**：每次只有负责人 + 当前子 Agent 的上下文在内存

**适用场景**：日常任务执行（写稿、查数据、SEO 优化、批量生成等）

---

### 模式 B：广播模式（Broadcast）— 设置可选，实验性

```
用户 ──消息──→ [广播总线]
                 │
                 ├──→ 负责人（moderator：控制发言顺序、决定何时结束）
                 ├──→ 文案写手（按相关性决定是否发言）
                 ├──→ SEO 专员（按相关性决定是否发言）
                 ├──→ 品牌策划（按相关性决定是否发言）
                 └──→ ...
```

**关键设计——选择性广播**（不是全量广播原文）：

1. 每个 Agent 收到的是**结构化摘要**（public summary），不是其他 Agent 的完整推理过程和工具调用细节
2. 采用**回合制屏障（barrier）**：
   - 每轮先收集所有活跃 Agent 的观点/建议
   - 由负责人（moderator）统一裁决、合并或要求补充
   - 进入下一轮
3. **写入权限收敛**：广播模式下子 Agent 仍为**提案态**（proposal-first），只有负责人可执行最终写入
4. **发言控制**：负责人可指定本轮由哪些 Agent 发言，避免所有人都说一遍

**为什么选择性广播而非全量广播**：

| | 全量广播 | 选择性广播 |
|---|---------|-----------|
| Token 消耗 | N×完整上下文 | N×摘要（约 1/5~1/10） |
| 信息泄露风险 | 高（工具结果/推理暴露） | 低（只暴露 public summary） |
| 可控性 | 低（容易吵成一锅粥） | 高（barrier + moderator） |
| 创意碰撞 | 充分但混乱 | 充分且有序 |

**适用场景**：脑暴、方案评审、多角色对辩、复杂议题需多视角审视

---

### 两种模式对比

| 维度 | 中转模式（Relay） | 广播模式（Broadcast） |
|------|------------------|---------------------|
| **Token 成本** | 低（负责人+当前子Agent） | 中高（N×摘要+barrier开销） |
| **信息完整性** | 负责人摘要可能丢细节 | 结构化摘要共享 |
| **协作深度** | 串行/并行派活 | 平行讨论 + 互相挑战 |
| **可控性** | 高（负责人完全控制） | 中（需 moderator + barrier） |
| **适用场景** | 日常任务执行 | 脑暴/对辩/评审 |
| **默认** | ✅ 默认启用 | 设置可开，标注"实验性" |

**切换机制**：用户在设置中切换；或在对话中用指令触发（如"开个脑暴会"→自动切广播模式）。

---

## 五、共享上下文与记忆

### 共享层（所有 Agent 可读）

| 数据 | 说明 | 读写权限 |
|------|------|---------|
| **mainDoc** | 项目主线（目标/受众/人设/决策） | 全员可读，负责人可写 |
| **向量记忆库** | 历史决策、爆文记录、素材积累、用户偏好 | 全员可读，负责人统一写入 |
| **KB 知识库** | 风格库、素材库、产品库 | 按 Agent 配置的 tools 权限 |
| **项目文件** | 草稿、成品、资源文件 | 按 Agent 的 toolPolicy |
| **当前对话摘要** | 滚动压缩的对话历史 | 全员可读 |

### 私有层（每个 Agent 各自持有）

| 数据 | 说明 |
|------|------|
| **推理上下文** | 当前任务的思维链、工具调用中间结果 |
| **任务产物** | 本次 delegate 的输出 artifact |

### 记忆写入规则

- **中转模式**：子 Agent 产出 artifact → 负责人审阅 → 选择性写入记忆库
- **广播模式**：各 Agent 产出观点 → 负责人汇总决策 → 统一写入记忆库
- **记忆分层**：`run 级`（临时，run 结束可清理）/ `project 级`（长期）/ `global 级`（跨项目），有 TTL 策略

---

## 六、前端群聊 UI

### 消息展示

```
┌─────────────────────────────────────────────────┐
│                                                   │
│  🧑 你                                 14:32     │
│  帮我写一篇小红书种草文，关于夏季防晒            │
│                                                   │
│  👔 负责人                              14:32     │
│  收到，让写手来处理。                             │
│                                                   │
│  ✍️ 文案写手                            14:33     │
│  好的，我先看看风格库里的调性...                  │
│  ┌────────────────────────────────────┐          │
│  │ ⚙ kb.search — 检索防晒类素材 ✓     │          │
│  │ ⚙ style_imitate — 应用风格模板 ✓   │          │
│  └────────────────────────────────────┘          │
│  稿件完成：                                       │
│  📄 小红书种草文-夏季防晒.md                      │
│  > 油皮夏天不做这3步，贵妇面霜也白搭...          │
│                                                   │
│  👔 负责人                              14:34     │
│  写手已交稿。需要 SEO 优化标题/标签吗？          │
│                                                   │
└─────────────────────────────────────────────────┘
```

### 关键 UI 规则

- 每条消息带 `agentId`，按角色**头像 + 名字 + 主题色**区分
- 子 Agent 的**工具卡片**（Tool Block）内联在该 Agent 消息中
- 负责人的**派发/汇总**消息用系统样式（如灰底），区别于普通对话
- 消息流按**时间线**排列，不分栏

### @ 浮层

```
@ 触发后弹出浮层，分三个 Tab/分组：

┌─ 团队成员 ─────────────────────────┐
│  👔 负责人                           │  ← 一般不需要 @
│  ✍️ 文案写手                         │
│  🔍 选题策划                         │
│  📊 SEO 专员                         │
│  📈 数据分析师                       │
│  💰 投流顾问                         │
│  🛒 电商文案                         │
│  🎬 编导/脚本                        │
│  🏷️ 品牌策划                         │
│  🎉 活动策划                         │
│  📱 新媒体运营                       │
│  💬 社群运营                         │
├─ 文件 ─────────────────────────────┤
│  📄 draft.md                         │
│  📁 素材/                            │
├─ 知识库 ───────────────────────────┤
│  📚 风格库A                          │
│  📚 素材库B                          │
└──────────────────────────────────────┘

注意：Skills 和 MCP 不出现在 @ 列表。
它们是 Agent 内部的能力，用户不需要知道。
```

### @ 行为

| 输入 | 行为 |
|------|------|
| 无 @ | 消息发给负责人，由其决定自己处理或派发 |
| `@文案写手` | UI 直达语义，服务端包装为负责人 → `agent.delegate(copywriter)`。负责人仍可见结果 |
| `@文案写手 @SEO专员` | 服务端包装为负责人协调的多步委托（串联或并行，由负责人决定） |
| `@文件` / `@KB` | 附件引用（现有行为，不变） |

---

## 七、设置 UI — 团队管理

### 列表页

```
设置 → 我的团队                              [+ 新增角色]

┌─────────────────────────────────────────────────────┐
│  ✍️ 文案写手           sonnet    6 工具  1 技能  ✅ │
│  🔍 选题策划           haiku     3 工具  1 技能  ✅ │
│  📊 SEO 专员           haiku     4 工具  0 技能  ✅ │
│  📈 数据分析师         sonnet    5 工具  0 技能  ✅ │
│  💰 投流顾问           sonnet    4 工具  0 技能  ☐ │  ← 未启用
│  ...                                                 │
└─────────────────────────────────────────────────────┘

通信模式：
  ● 中转模式（推荐）  ○ 广播模式（实验性，token 消耗较高）
```

### 编辑页

```
┌─────────────────────────────────────────────────────┐
│  角色名称    [文案写手                             ] │
│  头像        [✍️ ▼]                                  │
│  模型        [claude-sonnet-4-6       ▼]             │
│  降级模型    [deepseek-v3             ▼] [+ 添加]   │
│                                                       │
│  职责描述（负责人用于判断是否派发）：                  │
│  ┌───────────────────────────────────────────────┐   │
│  │ 写公众号/小红书/口播稿/种草文，擅长风格仿写     │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  System Prompt：                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │ 你是专业文案写手，专注内容创作。                  │   │
│  │ 你的产出标准：...                                │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  工具权限    ☑ kb.search  ☑ kb.cite  ☑ doc.write    │
│              ☑ doc.applyEdits  ☑ lint.style  ☐ bash  │
│  技能        ☑ style_imitate  ☐ corpus_ingest        │
│  MCP         ☐ 聚光 API  ☐ 小红书 API                │
│  工具策略    ● 提案优先  ○ 只读  ○ 自动执行          │
│                                                       │
│  执行预算                                             │
│  最大轮数 [15]  最大工具调用 [30]  超时 [120] 秒     │
│                                                       │
│                          [恢复默认]  [保存]          │
└─────────────────────────────────────────────────────┘
```

---

## 八、Gateway 调度协议

### 请求扩展

```typescript
// POST /api/agent/run/stream — 扩展字段
{
  // ...现有字段
  targetAgentId?: string;    // @ 直达某个子 Agent（可选）
  targetAgentIds?: string[]; // @ 多个子 Agent（可选）
}
```

### agent.delegate 工具定义

```typescript
{
  name: "agent.delegate",
  description: "将任务委托给团队中的某个子 Agent。仅负责人可使用。",
  inputSchema: {
    agentId: { type: "string", description: "目标子 Agent ID" },
    task: { type: "string", description: "任务描述" },
    inputArtifacts: { type: "array", items: { type: "string" }, description: "上游产物引用" },
    acceptanceCriteria: { type: "string", description: "验收标准（可选）" },
    budget: {
      type: "object",
      properties: {
        maxTurns: { type: "number" },
        maxToolCalls: { type: "number" },
        timeoutMs: { type: "number" }
      },
      description: "覆盖子 Agent 默认预算（可选，与 SubAgentDefinition.budget 合并，调用值优先）"
    }
  }
}
```

### 子 Agent 执行流程

```
负责人调用 agent.delegate
  ↓
Gateway 读取 SubAgentDefinition(agentId)
  ↓
组装 SubAgentRunContext（见下文）
  ↓
创建独立 WritingAgentRunner 实例
  ↓
注入共享上下文（mainDoc + 相关 KB + 记忆检索结果）
  ↓
子 Agent 独立推理（流式输出到前端，标记 agentId）
  ↓
产出 artifact → 返回给负责人上下文
  ↓
负责人决定：
  ├ 直接交付用户
  ├ 串联下一个子 Agent
  └ 要求修改/重做
```

### SubAgentRunContext 组装契约

子 Agent 不是"拿到 prompt 和 tools 就跑"——需要走与主 Agent 相同的门禁体系。组装规则：

```typescript
// 伪代码：Gateway 内部组装 SubAgentRunContext
function buildSubAgentRunContext(def: SubAgentDefinition, delegateInput) {
  // 1. System Prompt = 子 Agent prompt + 活跃 Skills 的 promptFragments
  const activeSkills = activateSkills({
    mode: "agent",
    manifests: filterBySkillIds(def.skills),
    ...delegateInput
  });
  const systemPrompt = def.systemPrompt
    + activeSkills.map(s => s.promptFragments.system).join("\n");

  // 2. 工具权限优先级链（从严到宽，每层只能收窄不能放宽）
  //    全局可用工具 ∩ SubAgentDefinition.tools ∩ Skill.toolCaps ∩ toolPolicy
  const globalTools = toolNamesForMode("agent");
  const agentTools = new Set(def.tools).intersection(globalTools);
  const skillCaps = mergeSkillToolCaps(activeSkills);  // allowTools/denyTools
  const effectiveTools = applyToolCaps(agentTools, skillCaps);
  const finalTools = applyToolPolicy(effectiveTools, def.toolPolicy);
  // readonly → 过滤掉 isWriteLikeTool
  // proposal_first → 保留但标记 proposal
  // auto_apply → 全部保留

  // 3. 模型 = def.model，失败按 fallbackModels 降级
  // 4. 预算 = delegateInput.budget 与 def.budget 合并（调用值优先）
  // 5. 共享上下文 = mainDoc + KB检索 + 记忆检索 + delegateInput.inputArtifacts

  return {
    systemPrompt,
    allowedToolNames: finalTools,
    model: def.model,
    fallbackModels: def.fallbackModels,
    budget: { ...def.budget, ...delegateInput.budget },
    activeSkills,
    // 注意：子 Agent 不继承负责人的 Intent/Gate，
    // 但 toolPolicy 和 budget 起到等效约束作用
  };
}
```

**工具权限优先级链**（从严到宽，每层只收窄）：

```
全局工具注册表（TOOL_LIST）
  ∩ mode 过滤（agent/chat）
  ∩ capabilities 配置（B 端禁用的工具）
  ∩ SubAgentDefinition.tools（角色允许的工具）
  ∩ Skill.toolCaps（技能的 allowTools/denyTools）
  ∩ toolPolicy（readonly/proposal_first/auto_apply）
  = 最终可用工具集
```

### SSE 事件扩展

现有事件保持不变，新增 `agentId` 字段标记来源。

```typescript
// 现有字段不动（如 assistant.delta 仍用 delta 字段），仅追加 agentId
{ event: "assistant.delta", data: { delta, agentId: "copywriter" } }
{ event: "tool.call",       data: { ..., agentId: "copywriter" } }
{ event: "tool.result",     data: { ..., agentId: "copywriter" } }

// 新增事件（子 Agent 生命周期）
{ event: "agent.delegate",  data: { from: "lead", to: "copywriter", task } }
{ event: "agent.complete",  data: { agentId: "copywriter", artifact } }
```

> **兼容性**：前端消费 `assistant.delta` 时只认 `delta` 字段（见 `gatewayAgent.ts`），新增的 `agentId` 字段不影响现有解析。前端在 Phase 2 群聊改造时才开始使用 `agentId` 区分消息来源。

### 广播模式协议

```
用户消息
  ↓
Gateway 判断当前通信模式
  ├ Relay → 走 agent.delegate 流程
  └ Broadcast →
      ↓
    构建本轮 public summary（上一轮各 Agent 输出的结构化摘要）
      ↓
    负责人（moderator）先发言：确定本轮议题 + 指定发言 Agent 列表
      ↓
    并行调起指定 Agent（各自独立推理，输入含 public summary）
      ↓
    收集所有 Agent 回复
      ↓
    负责人汇总裁决 → 回复用户 / 进入下一轮
```

---

## 九、预置角色清单

> **工具 ID 说明**：下表中的工具 ID 分为已注册（`packages/tools` 中已定义）和待注册（计划中）。
> 已注册：`kb.search`, `kb.ingest`, `kb.listLibraries`, `doc.read`, `doc.write`, `doc.applyEdits`, `web.search`, `web.fetch`, `time.now`, `lint.style`, `lint.copy` 等。
> 待注册（v0.1 不可用）：`kb.cite`（引用回链）、`bash.exec`（沙箱脚本）。配置时应校验工具 ID 是否已注册。

| id | name | model | tools | skills | 典型任务 |
|----|------|-------|-------|--------|---------|
| `copywriter` | 文案写手 | sonnet | kb.search, doc.write, doc.applyEdits, lint.style, lint.copy | style_imitate | 公众号/小红书/口播稿 |
| `topic_planner` | 选题策划 | haiku | web.search, web.fetch, time.now, kb.search | web_topic_radar | 热点追踪、选题日历 |
| `seo_specialist` | SEO 专员 | haiku | web.search, web.fetch, kb.search | — | 关键词研究、标签优化 |
| `data_analyst` | 数据分析师 | sonnet | web.fetch, kb.search, doc.write | — | 数据解读、报告生成 |
| `ad_consultant` | 投流顾问 | sonnet | web.search, kb.search, doc.write | — | 投放素材文案、策略 |
| `ecom_copywriter` | 电商文案 | sonnet | kb.search, doc.write, lint.style | style_imitate | 详情页、标题优化 |
| `video_director` | 编导/脚本 | sonnet | kb.search, doc.write | style_imitate | 短视频脚本、分镜 |
| `brand_planner` | 品牌策划 | sonnet | web.search, kb.search, doc.write | — | 人设定位、品牌故事 |
| `event_planner` | 活动策划 | sonnet | kb.search, doc.write | — | 活动方案、SOP |
| `social_ops` | 新媒体运营 | haiku | web.search, kb.search, doc.write | — | 排期、话术、分发 |
| `community_ops` | 社群运营 | haiku | kb.search, doc.write | — | 社群内容、话术模板 |

> 以上为预置默认值，用户可在设置中自定义。

---

## 十、质量保障 — Style Oracle 闸门

多 Agent 协作的核心风险：**风格漂移**——不同子 Agent 产出的内容调性不一致。

解决方案：**负责人内置 Style Oracle 职责**：

1. 子 Agent 产出 artifact 后，负责人检查是否符合项目风格（mainDoc 中的品牌调性/人设规则）
2. 若不符，要求子 Agent 修改，或自己做最终润色
3. 广播模式下，负责人在裁决时统一调性

这不是新增一个 Agent，而是负责人 prompt 中强调的职责：

```
你作为负责人，对所有交付内容的品牌调性负最终责任。
子 Agent 交稿后，你必须检查是否符合项目风格（参见 mainDoc 中的品牌调性定义）。
不符合的，要求修改或自行润色后再交付用户。
```

---

## 十一、与现有系统的集成

| 现有系统 | 变化 | 说明 |
|---------|------|------|
| **Skills** | 需改造（见下文） | 当前硬编码注册，需配置化后才能被子 Agent 灵活引用 |
| **MCP** | 待建 | 当前代码库零 MCP 实现，`mcpServers` 为预留字段 |
| **Tools** | 需补全 | 子 Agent 通过 `tools[]` 获取工具子集，但需补 outputSchema 和标准错误码 |
| **Intent Router** | 保留在负责人级别 | 快速分流用，子 Agent 内部不需要 Router |
| **ToolCaps** | 复用模式 | 现有 `toolCaps: { allowTools, denyTools }` 模式可复用到子 Agent 的 `tools[]` |
| **Billing** | 阶段式改进 | Phase 1：子 Agent 调用走 `agent.run` stageKey + `meta.agentId` 归因（复用现有 stage 白名单）；Phase 3：B 端支持动态 stage 注册后，改为 `agent.subagent.{id}` 独立 stageKey |
| **WritingAgentRunner** | 复用 | 子 Agent 复用同一个 Runner 类，只是传入不同的 systemPrompt/tools/model |

### 前置改造：Skill / Tool / MCP 接口标准化

Sub-agent 架构对现有 Skill 和 Tool 接口提出了新要求。以下改造是 Phase 1 的前置条件。

#### A. Skill 接口现状与改造

**当前 SkillManifest**（`packages/agent-core/src/skills.ts`）：

```typescript
// 现状：结构完整但注册硬编码、policy 分裂、trigger 局限
type SkillManifest = {
  id: string;
  name: string;
  description: string;
  priority: number;
  stageKey: string;
  autoEnable: boolean;
  triggers: TriggerRule[];               // 4 种类型，仅支持 AND
  promptFragments: { system?, context? };
  policies: string[];                    // 声明在 manifest，实现在 gateway PHASE_CONTRACTS_V1
  toolCaps?: { allowTools?, denyTools? };
  ui: { badge, color? };
};
```

**问题与改造计划**：

| 问题 | 当前 | 改造目标 | 优先级 |
|------|------|---------|--------|
| 硬编码注册 | 新增 skill 改 `SKILL_MANIFESTS_V1` 数组 | 三层配置化（见下文） | P0→P2 渐进 |
| Policy 分裂 | manifest 声明 → gateway PHASE_CONTRACTS 实现 | 统一：policy 实现跟随 manifest 或用工厂函数 | P1 |
| Trigger 只有 AND | 4 种规则全 AND，无 OR | 支持 `{ any: [...] }` / `{ all: [...] }` 组合 | P1 |
| 无版本号 | 配置变更无追踪 | 加 `version: string` | ✅ 已完成 |
| 无互斥/依赖 | 多 skill 同时激活无冲突检测 | 加 `conflicts?: string[]`、`requires?: string[]` + activateSkills 检查 | ✅ 已完成 |
| 正则地狱 | `text_regex` 有 200+ 行硬编码 | 后续改为意图分类器（LLM-based），正则作为 fallback | P2 |

**改造后的 SkillManifest（目标态）**：

```typescript
type SkillManifest = {
  // --- 现有字段保留 ---
  id: string;
  name: string;
  description: string;
  priority: number;
  stageKey: string;
  autoEnable: boolean;
  triggers: TriggerRule[];
  promptFragments: { system?, context? };
  policies: string[];
  toolCaps?: { allowTools?, denyTools? };
  ui: { badge, color? };

  // --- 新增字段 ---
  version: string;                       // 配置版本追踪
  conflicts?: string[];                  // 互斥的 skill ID
  requires?: string[];                   // 依赖的 skill ID
  source: "builtin" | "standard" | "user" | "admin";
  //  builtin  — 代码内置，设置页只读（可禁用）
  //  standard — 从标准 Skill 包加载，设置页可禁用但不可改 prompt
  //  user     — 用户在设置页创建，完全可编辑，热生效
  //  admin    — 管理员下发（B 端场景），设置页只读
};
```

#### A-2. Skill 三层配置化方案

**核心思路**：内置 Skill 仍在代码中维护（跟随版本发布），但允许本地配置覆盖其 `enabled` 状态，并支持用户自建 Skill 热生效。

##### 三层来源

| 层级 | source | 存储位置 | 设置页行为 | 热生效 |
|------|--------|---------|-----------|--------|
| 内置 | `"builtin"` | 代码硬编码 `SKILL_MANIFESTS_V1` | 可见、**不可改**（prompt/tools/triggers 灰色）、可禁用 | 否（随版本更新） |
| 标准 | `"standard"` | 标准 Skill 包 JSON 文件 | 可见、可禁用、不可改 prompt | 是（文件变更触发重载） |
| 用户 | `"user"` | 本地配置文件 | 完全可编辑（prompt/tools/triggers/priority） | 是（保存即生效） |

##### 配置文件格式

Desktop 端维护一个本地配置文件 `~/.writing-ide/skills.json`：

```jsonc
{
  "version": "1.0.0",
  // 内置 Skill 的覆盖配置（只能改 enabled）
  "builtinOverrides": {
    "style_imitate": { "enabled": true },
    "writing_batch": { "enabled": false }   // 用户禁用了批量写作
  },
  // 标准 Skill 包路径（JSON 文件或目录）
  "standardSkillPaths": [
    "~/.writing-ide/skills.d/"              // 标准 Skill 包目录
  ],
  // 用户自建 Skill
  "userSkills": [
    {
      "id": "my_xiaohongshu_style",
      "name": "小红书爆款体",
      "description": "按小红书爆款笔记结构生成：钩子标题 + emoji 开头 + 分段 + CTA",
      "priority": 95,
      "stageKey": "agent.skill.user.my_xiaohongshu_style",
      "autoEnable": true,
      "triggers": [
        { "when": "text_regex", "args": { "pattern": "小红书|种草|爆款" } }
      ],
      "promptFragments": {
        "system": "当 skill=my_xiaohongshu_style 激活时：..."
      },
      "policies": [],
      "toolCaps": { "allowTools": ["kb.search", "doc.write", "lint.style"] },
      "version": "1.0.0",
      "source": "user"
    }
  ]
}
```

##### 标准 Skill 包格式

标准 Skill 包是一个 JSON 文件，包含一个或多个 `SkillManifest`：

```jsonc
// ~/.writing-ide/skills.d/ecommerce-skills.json
{
  "name": "电商文案技能包",
  "version": "1.0.0",
  "skills": [
    {
      "id": "ecommerce_title_optimizer",
      "name": "电商标题优化",
      "description": "优化商品标题的关键词布局、点击率预估",
      "source": "standard",
      // ... 完整 SkillManifest
    }
  ]
}
```

##### 合并加载逻辑

```
┌──────────────────────────────────────────────────┐
│              Skill 加载优先级链                     │
│                                                    │
│  1. 代码内置 SKILL_MANIFESTS_V1                    │
│     ↓ 合并                                        │
│  2. builtinOverrides（仅覆盖 enabled）             │
│     ↓ 追加                                        │
│  3. standardSkillPaths → 扫描 JSON → 追加          │
│     ↓ 追加                                        │
│  4. userSkills → 追加                              │
│     ↓                                             │
│  5. 去重（id 冲突时后者覆盖前者，但 builtin 不可被覆盖）│
│     ↓                                             │
│  6. 送入 activateSkills()（按 priority 排序 + conflicts/requires 检查）│
│     ↓                                             │
│  7. ActiveSkill[]                                  │
└──────────────────────────────────────────────────┘
```

**去重规则**：
- `builtin` Skill 的 id 被保护——用户/标准包不能声明同 id 的 Skill 来覆盖内置
- 同 id 的 `user` 覆盖 `standard`（用户定制优先）
- 加载失败（JSON 解析错误、必填字段缺失）的 Skill 跳过并记录警告日志

##### 热生效机制

| 阶段 | 触发方式 | 生效范围 |
|------|---------|---------|
| Phase 1（轻量） | Desktop 启动时加载 + 手动"重载 Skill"按钮 | 下一次 Agent Run 生效 |
| Phase 2（完整） | 设置页保存时自动重载 + 文件 watcher 监听 `skills.d/` | 立即生效（当前 Run 不中断，下一轮 activateSkills 刷新） |

##### 实现路径

| 阶段 | 内容 | 改动范围 |
|------|------|---------|
| **Phase 1** | `loadSkillManifests()` 函数：合并 builtin + config overlay + user skills | `packages/agent-core/src/skills.ts` |
| **Phase 1** | Desktop 读取 `~/.writing-ide/skills.json` 并传入 Gateway | `apps/desktop/src/` |
| **Phase 1** | Gateway `activateSkills` 接受外部 manifests 参数（✅ 已支持） | 无需改动 |
| **Phase 2** | 设置页 Skill 列表 + 编辑 UI | `apps/desktop/src/ui/` |
| **Phase 2** | 标准 Skill 包扫描 + 文件 watcher | `apps/desktop/src/` |
| **Phase 2** | Skill 导入/导出（分享 JSON） | `apps/desktop/src/` |

#### B. Tool 接口现状与改造

**当前 ToolMeta**（`packages/tools/src/index.ts`）：

```typescript
// 现状：参数验证可用，但 outputSchema 废弃、无版本、无标准错误码
type ToolMeta = {
  name: string;
  description: string;
  args: ToolArgSpec[];
  modes?: ToolMode[];
  inputSchema?: ToolJsonSchema;
  outputSchema?: unknown;              // 声明了但 0 处使用
};
```

**问题与改造计划**：

| 问题 | 当前 | 改造目标 | 优先级 |
|------|------|---------|--------|
| outputSchema 废弃 | 声明了但未实现 | 补全，子 Agent 产物流水线需要 | ✅ 已完成（9 个工具） |
| 无标准错误码 | `{ ok: false, error: "随意文本" }` | 标准化错误类型 + retryable 标记 | ✅ 已完成 |
| 无版本号 | 工具 API 变更无感知 | 加 `version: string` | P1 |
| 全量硬编码 | 42 个工具在一个数组 | 分模块注册，支持动态加载 | P2 |

**标准错误类型**：

```typescript
type ToolErrorCode =
  | "VALIDATION_ERROR"    // 参数校验失败
  | "NOT_FOUND"           // 资源不存在
  | "PERMISSION_DENIED"   // 权限不足
  | "EXECUTION_ERROR"     // 执行异常
  | "TIMEOUT"             // 超时
  | "RATE_LIMIT";         // 频率限制

type ToolError = {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

// 工具统一返回格式
type ToolResult<T = unknown> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: ToolError;
};
```

#### C. MCP 接入路径

**现状**：代码库中零 MCP 实现。产品定位文档中规划的 MCP 能力（聚光 API、小红书、企微）全部待建。

**路径**：

| 阶段 | 目标 | 说明 |
|------|------|------|
| Phase 1 | 不做 MCP | 先用现有 Tool 接口满足内置能力需求 |
| Phase 2 | MCP 兼容层设计 | 定义 MCP Server 注册协议，使外部工具可以 MCP 标准接入 |
| Phase 3 | 首个 MCP Server | 如聚光投放 API 或小红书开放平台，验证协议 |

**MCP Server 目标接口**（Phase 2 设计，Phase 3 实现）：

```typescript
type McpServerDefinition = {
  id: string;                          // "jiguang_ads"
  name: string;                        // "聚光投放"
  description: string;
  version: string;
  transport: "stdio" | "http";         // 通信方式
  endpoint?: string;                   // HTTP 模式的 URL
  command?: string;                    // stdio 模式的启动命令
  tools: McpToolDefinition[];          // 该 Server 暴露的工具列表
  auth?: {
    type: "api_key" | "oauth2";
    configFields: string[];            // 用户需要填的配置项
  };
  enabled: boolean;
};
```

> MCP 接入不阻塞 Sub-agent Phase 1/2。子 Agent 的 `mcpServers[]` 字段预留，待 MCP 兼容层就绪后激活。

---

## 十二、工程化路径

### Phase 0（当前）— 主 Agent 单体 + 接口标准化

- 主 Agent 已改为"负责人"prompt ✅
- Skills 框架已有（style_imitate, corpus_ingest, web_topic_radar）✅
- 仿写/抽卡由主 Agent 内部 Skill 完成
- **前置改造**（不改架构，只补接口）：
  - [x] Tool 错误码标准化（`ToolErrorCode` + `ToolError` + `ToolHandlerResult<T>` + `toolOk`/`toolErr`）
  - [x] Tool 补全 `outputSchema`（9 个 Sub-agent 常用工具：time.now / web.search / web.fetch / kb.listLibraries / kb.search / lint.copy / lint.style / doc.read / doc.write）
  - [x] Skill 加 `version`、`conflicts`、`requires`、`source` 字段 + `activateSkills` conflicts/requires/priority 检查
  - [ ] Skill 配置化 Phase 1（`loadSkillManifests()` 合并 builtin + config overlay + user skills）→ 见 Section 11-A-2

### Phase 1 — 定义接口 + 后端调度

### Phase 1A — 接口定义 + 单角色 POC

- 定义 `SubAgentDefinition` TypeScript 接口（`packages/agent-core`）
- Gateway 新增 `agent.delegate` 工具
- 子 Agent 配置存储（Gateway DB 或配置文件）
- 预置 1 个子 Agent（文案写手），从主 Agent prompt 拆出
- 仿写链路迁移：主 Agent 遇仿写 → 委托文案写手 Agent
- SSE 事件加 `agentId` 标记
- 观测：日志/审计中记录 delegate 链路和 artifact 产出
- **Skill 配置化**：实现 `loadSkillManifests()`（合并 builtin + `~/.writing-ide/skills.json`）

### Phase 1B — 多角色串联

- 新增 2-3 个子 Agent（选题策划、SEO 专员）
- 实现串联调度：写手产出 → SEO 优化 → 负责人汇总
- 并行调度 POC（多个独立任务并行 delegate）
- 计费归因：`agent.run` + `meta.agentId` 区分子 Agent 消耗

### Phase 2 — 前端群聊 UI

- ChatArea 从单人对话 → 群聊（消息带 agentId，按角色头像/名字/颜色区分）
- @ 浮层改造：增加"团队成员"分类（兼容期：现有 skill/file/kb 分类保留）
- InputBar 支持 `@agentName` 语法
- 消息渲染组件适配多 Agent（不同气泡样式/颜色）
- **Skill 设置 UI**：设置页 Skill 列表（builtin 只读可禁用 / user 可编辑）+ 标准 Skill 包加载

### Phase 3 — 设置 + 广播模式

- 设置页：团队管理 UI（列表/编辑/新增/启用禁用）
- 通信模式切换（中转 ↔ 广播）
- 广播模式实现（选择性广播 + barrier + moderator）
- 自定义角色（用户基于模板创建新角色）
- **Skill 导入/导出**：分享 JSON 格式的 Skill 包

### Feature Flags

所有阶段通过 feature flag 控制，支持灰度和回滚：

| Flag | 默认 | 说明 |
|------|------|------|
| `subagent.enabled` | false | 总开关：是否启用子 Agent 调度 |
| `subagent.delegate.maxDepth` | 1 | 委托深度限制（1 = 单层，不可嵌套） |
| `broadcast.enabled` | false | 广播模式开关 |
| `subagent.ui.groupChat` | false | 前端群聊 UI 开关（Phase 2 启用） |

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-21 | v0.1 | 初稿：分层架构、SubAgentDefinition 接口、两种通信模式、群聊 UI、设置、工程路径 |
| 2026-02-21 | v0.1.1 | Review 修正：SSE 协议兼容、SubAgentRunContext 组装契约、工具权限优先级链、@ 直达语义澄清、feature flags、MCP 标注预留、工具 ID 校验说明 |
| 2026-02-21 | v0.1.2 | 新增 Section 11 前置改造：Skill/Tool/MCP 接口标准化审计与改造计划（SkillManifest 配置化、ToolError 标准、MCP 路径） |
| 2026-02-21 | v0.1.3 | P0 进度更新 + Skill 三层配置化方案（builtin/standard/user 分层、配置文件格式、合并逻辑、热生效机制、实现路径） |
