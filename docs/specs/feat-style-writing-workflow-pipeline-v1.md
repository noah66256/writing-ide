# 风格仿写管线化——从 Agent 自由编排到声明式 Workflow Pipeline

状态：待实施 | 优先级：P0 | 日期：2026-03-17

---

## 0. 背景与动机

### 当前架构的问题

现有风格仿写（`style_imitate` / `style_imitate_v2`）采用 **Agent 自由编排**模式：

1. Agent 拿到全部工具（kb.search, write, edit, lint.copy, lint.style）
2. 系统用 2000+ 行门控代码约束 Agent 的调用顺序
3. Agent 仍可能绕过约束（文本输出代替 write、跳过 lint 步骤）

核心矛盾：**给了 LLM 自由，又花 80% 的代码把自由收回来**。

门控代码散布在 6+ 个文件中：
- `styleOrchestrator.ts`：`computeStyleTurnCaps` / `buildStyleSnapshot` / `buildHint`（~200 行）
- `workflowSkills.ts`：`computeStylePhaseAndMissing` / `styleImitateWorkflowContract`（~150 行）
- `runMachine.ts`：`analyzeStyleWorkflowBatch`（~100 行）
- `workflowPhaseInterpreter.ts`：通用阶段解释器（~200 行）
- `GatewayRuntime.ts`：violation 拦截、follow-up 注入、状态更新（~400 行）
- `runFactory.ts`：per-turn 工具白名单计算（~150 行）

### 用户反馈

- "太死板了，好像定死了就那些"——输出模式固化
- "风格库其实太多维度了，它不会选"——维度选择失效
- "写出来同质性太多了"——多次写作产出趋同
- "如何在第一步就写得像，但不是抄"——核心诉求

### 根本原因

风格仿写本质是 **确定性工作流**——步骤顺序是固定的，"智能"在于每一步的文本生成质量，而不在于工具选择决策。Agent 模式是错误的抽象层次。

### 设计目标

将风格仿写从"Agent + 门控"改为"声明式 Workflow Pipeline"：
- **代码控制序列**：步骤顺序由代码确定，不依赖 LLM 决策
- **LLM 聚焦生成**：每步只做文本生成，输入/输出合同明确
- **逐步积累上下文**：每一步带着上一步的结果 + 本步检索到的维度卡内容
- **可审计可回放**：每步产出都有 artifact 记录

---

## 1. 三层卡片系统

管线的输入来自三层卡片：

### Layer 1: Element Cards（per-document）

从风格库中每篇文章提取的元素卡片：

| cardType | 说明 | 每篇上限 |
|----------|------|----------|
| hook | 开头钩子 | 3 |
| thesis | 核心论点 | 3 |
| ending | 结尾收束 | 3 |
| one_liner | 金句 | 12 |
| outline | 结构骨架 | 1 |
| other | 其他特色片段 | 6 |

### Layer 2: Playbook Cards（per-library，22 维度）

| 维度 ID | 中文标签 | 说明 |
|---------|---------|------|
| intro | 内容导引 | 文章整体引导方式 |
| opening_design | 开篇设计 | 开场策略与破题技巧 |
| narrative_structure | 叙事结构 | 段落组织与推进方式 |
| narrative_perspective | 叙事视角 | 人称与视角切换 |
| language_style | 语言风格 | 用词、句式、语体 |
| one_liner_crafting | 金句构造 | 金句类型与植入策略 |
| topic_selection | 选题策略 | 话题选择与切入角度 |
| resonance | 共鸣触发 | 引发读者共情的手法 |
| logic_framework | 逻辑框架 | 论证结构与说服路径 |
| reader_interaction | 读者互动 | 提问、设问、反问节奏 |
| emotion_mobilization | 情绪调动 | 情感曲线与情绪节拍 |
| question_design | 问题设计 | 设问策略与问题链 |
| scene_building | 场景构建 | 场景描写与画面感 |
| rhetoric | 修辞手法 | 比喻、排比、递进等 |
| voice_rhythm | 声音节奏 | 句长交替、停顿、韵律 |
| persuasion | 说服策略 | 权威、从众、互惠等 |
| values_embedding | 价值观嵌入 | 价值判断的植入与收束 |
| structure_patterns | 结构模板 | 可复用的段落结构 |
| psychology_principles | 心理学原理 | 认知偏差、框架效应等 |
| special_markers | 特殊标记 | 口头禅、标志性表达 |
| viral_patterns | 传播模式 | 标题钩子、转发触发点 |
| ai_clone_strategy | AI 克隆策略 | 风格克隆评估标准 |

### Layer 3: Cluster Rules（per-cluster）

每个风格簇的高层规则卡（`cluster_rules_v1`），包含：

**values（价值观体系）**：
- `scope`：价值观适用范围
- `principles`：核心原则列表
- `preferredFrames`：偏好的分析框架
- `forbiddenFrames`：禁止的分析框架
- `toneKeywords`：语气关键词
- `tabooClaims`：禁忌论断

**analysisLenses（分析视角）**：
- `id` / `label`：视角标识
- `prompt`：视角引导提示
- `priority`：使用优先级

> **当前问题**：cluster_rules_v1 已生成并存储，但**未注入 Agent 的 Context Pack**。`wsTransport.ts:678-680` 写入 mainDoc，但 `gatewayAgent.ts` 的 4 个 context section（KB_STYLE_CLUSTERS、STYLE_SELECTOR、STYLE_FACETS_SELECTED、STYLE_DIMENSIONS）均不包含 values 和 analysisLenses。管线化方案将解决这一"最后一公里"问题。

---

## 2. 两种写作场景

| 场景 | 触发条件 | values 角色 | analysisLenses 角色 |
|------|---------|------------|-------------------|
| **Scene A**（只给话题） | 用户只给话题，不给明确观点 | **主导**：从 values 推导 stance | **主导**：决定分析切入角度 |
| **Scene B**（给定观点/改写） | 用户给了明确观点或原稿 | **负面约束**：不违反底线即可 | **主导**：仍决定分析角度 |

关键设计：
- `stanceSource: "user" | "values"` —— 观点来源
- `valuesConstraintMode: "dominant" | "negative_guardrail"` —— 价值观约束模式
- 不做 `hybrid`（判断"观点是否模糊"需要额外 LLM 调用，边界不清）

---

## 3. 八步管线设计

### 总览

```
Step 0: 定调（Tone Setting）
    ↓
Step 1: 骨架（Structure）
    ↓
Step 2: 开场（Opening）
    ↓
Step 3: 主体（Body）
    ↓
Step 4: 语言风格（Language & Rhythm）
    ↓
Step 5: 点睛（Polish）
    ↓
Step 6: 收束（Closure）
    ↓
Step 7: Lint Loop
    7a: lint.copy → [不通过 → edit → 7a（最多 2 次）]
    7b: lint.style → [不通过 → edit → 7b（最多 3 版）]
    7c: lint.style 3 版取最高分通过
```

### Step 0: 定调（Tone Setting）

**输入**：
- 用户 prompt（原始写作请求）
- TaskSpecV1（代码预组装：platform, audience, wordCount, factBoundary）
- cluster_rules_v1（values + analysisLenses）

**LLM 任务**：
- Scene A：从 values 推导 stance，选择 analysisLenses，确定 `readerEffectGoal`
- Scene B：提取用户观点作为 stance，values 降为负面约束；提取 sourceBrief + invariantClaims

**输出**：ToneCardV1
- `stance`：文章立场
- `stanceSource`：`"user"` | `"values"`
- `valuesConstraintMode`：`"dominant"` | `"negative_guardrail"`
- `activeAnalysisLenses`：选中的分析视角
- `readerEffectGoal`：文章希望对读者造成的认知/情绪/行动结果
- `preferredFrames` / `forbiddenFrames`：允许/禁止的论证框架
- `mustPreserveClaims`：不可篡改的事实主张（Scene B）
- `step3GuardrailBrief`：预编译给 Step 3 的轻量价值观守卫
- `step6ClosureBrief`：预编译给 Step 6 的收束价值观指引
- `sourceProtection?`：原稿保护层（Scene B）

**LLM 参数**：temperature=0.3, maxOutputTokens=1200, responseFormat=json_schema

### Step 1: 骨架（Structure）

**输入**：
- TaskSpec（normalized）+ ToneCard
- 维度卡：`topic_selection` + `logic_framework` + `narrative_structure` + `structure_patterns`

**LLM 任务**：确定论证路径、段落骨架、转折点

**输出**：StructureOutlineV1
- `thesis`：核心论点
- `argumentPath`：`{ openingMove, supportChain[], turn?, closingMove }`
- `sections[]`：段落定义（id, role, title, objective, keyPoints, paragraphTarget）
- `transitions[]`：段落间衔接（fromSectionId, toSectionId, bridge）

**LLM 参数**：temperature=0.35, maxOutputTokens=1600, responseFormat=json_schema

### Step 2: 开场（Opening）

**输入**：
- ToneCard + StructureOutline
- 维度卡：`opening_design` + `intro` + `question_design` + `viral_patterns`（hook 部分）
- 元素卡：hook + one_liner（hook 子类型）

**LLM 任务**：写开场 2-3 段（标题 + 钩子 + 破题）

**输出**：DraftTextPayloadV1（stage="opening", coverage="partial_document"）

**LLM 参数**：temperature=0.7, maxOutputTokens=1800, responseFormat=plain_text

### Step 3: 主体（Body）

**输入**：
- ToneCard（含 `step3GuardrailBrief`）+ StructureOutline + Step 2 的 opening draft
- 维度卡：`scene_building` + `emotion_mobilization` + `resonance` + `persuasion` + `psychology_principles` + `reader_interaction` + `narrative_perspective`

**LLM 任务**：按骨架展开主体论证段落

**输出**：DraftTextPayloadV1（stage="body", coverage="partial_document"）

**LLM 参数**：temperature=0.65, maxOutputTokens=3200, responseFormat=plain_text

### Step 4: 语言风格（Language & Rhythm）

**输入**：
- ToneCard + StructureOutline + Step 3 的累计全文（opening + body）
- 维度卡：`voice_rhythm` + `language_style`
- style_profile 卡（全局风格指纹）

**LLM 任务**：全文语言风格调整（句式、节奏、用词），不改结构和论点

**输出**：DraftTextPayloadV1（stage="styled", coverage="full_document"）+ `continuationHints.rhythm`

**LLM 参数**：temperature=0.35, maxOutputTokens=3600, responseFormat=plain_text

**特殊处理**：当输入 token 超过 `fullPassMaxInputRatio`（0.45）时，按 StructureOutline.sections 分块处理，块间保留 300 token overlap，分块后需额外 lint.style 检查拼缝。

### Step 5: 点睛（Polish）

**输入**：
- ToneCard + StructureOutline + Step 4 的 styled draft
- 维度卡：`rhetoric` + `special_markers` + `viral_patterns`（传播钩子）+ `one_liner_crafting`
- 元素卡：one_liner（punchline 子类型）
- RhythmContinuationBrief（来自 Step 4 的 continuationHints）

**LLM 任务**：在关键位置植入金句、修辞、特殊标记

**输出**：DraftTextPayloadV1（stage="polished", coverage="full_document"）

**LLM 参数**：temperature=0.55, maxOutputTokens=2200, responseFormat=plain_text

### Step 6: 收束（Closure）

**输入**：
- ToneCard（含 `step6ClosureBrief`）+ Step 5 的 polished draft
- 维度卡：`values_embedding`（完整规则卡）
- 元素卡：one_liner（ending 子类型）+ ending
- cluster_rules_v1（values 部分，用于回扣价值观）

**LLM 任务**：写结尾段，回扣价值观，植入结尾金句

**输出**：DraftTextPayloadV1（stage="final", coverage="full_document"）

**LLM 参数**：temperature=0.45, maxOutputTokens=1200, responseFormat=plain_text

### Step 7: Lint Loop

**输入**：当前全文 draft + ToneCard + StructureOutline

**执行逻辑**：
```
7a: lint.copy(全文) → 通过 → 7b
                     → 不通过 → LLM edit(按 rewritePrompt) → 回到 7a（最多 2 次改稿）
                     → 连续 2 次不通过 → 取最高分版本，继续进入 7b

7b: lint.style(全文) → 通过 → 交付
                      → 不通过 → LLM edit(按 rewritePrompt) → 回到 7b（不回 7a）
                      → 3 版（1 初稿 + 2 次改稿）中取最高分版本作为终稿交付
```

**关键设计**：

1. **lint.style 不存在"降级"**：最多产出 3 个版本（初稿 + 2 次改稿），取 `score` 最高的版本作为终稿。总有一个"最好的版本"——不需要 `lintDegraded` 标记。

2. **lint.style 改稿后不回查 lint.copy**：lint.copy 检查的是对**原文**的复述风险。lint.style 的改稿 prompt 不包含原文全文，LLM 无从"抄"原文。小概率的凭空复现原文不值得增加一轮 lint.copy 的延迟。

3. **lint.copy 仍有降级**：lint.copy 连续 2 次不通过时，取最高分版本继续进入 lint.style，不阻断流程。

**ai_clone_strategy 处理**：从内容管线移出，作为 lint.style 的评分维度之一——评估"写出来像不像这个人"。

---

## 4. 每步上下文组成

### Context 携带规则

| 上下文项 | Step 0 | Step 1 | Step 2 | Step 3 | Step 4 | Step 5 | Step 6 | Step 7 |
|---------|--------|--------|--------|--------|--------|--------|--------|--------|
| TaskSpec | ✅ 完整 | ✅ normalized | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ToneCard | ❌ (产出) | ✅ | ✅ | ✅ (含 guardrail) | ✅ | ✅ | ✅ (含 closure) | ✅ |
| StructureOutline | ❌ | ❌ (产出) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 上一步 DraftText | ❌ | ❌ | ❌ | ✅ opening | ✅ 全文 | ✅ 全文 | ✅ 全文 | ✅ 全文 |
| 本步维度卡 | cluster_rules | 4 维度 | 4 维度 + 元素卡 | 7 维度 | 2 维度 + profile | 4 维度 + 元素卡 | 1 维度 + 元素卡 + rules | lint 结果 |
| RhythmBrief | ❌ | ❌ | ❌ | ❌ | ❌ (产出) | ✅ | ✅ | ❌ |

### 不携带

- 原始检索结果（只带编译后的规则卡内容）
- 历史步骤的 Meta（只有 DraftText 和 StructureOutline 前传）
- 更早步骤的 DraftText（只带上一步的累计快照）

---

## 5. 数据结构定义

### 核心类型（`packages/agent-core/src/styleWorkflowTypes.ts`）

```typescript
// ── 场景与模式 ──────────────────────────────────────

export type StyleSceneV1 = "topic_only" | "source_rewrite";
export type StanceSourceV1 = "user" | "values";
export type ValuesConstraintModeV1 = "dominant" | "negative_guardrail";
export type FactBoundaryV1 = "only_from_values" | "preserve_source";

// ── 卡片类型 ──────────────────────────────────────

export type ElementCardTypeV1 =
  | "hook" | "thesis" | "ending" | "one_liner" | "outline" | "other";

export type OneLinerSubtypeV1 = "hook" | "punchline" | "ending" | "generic";

export type PlaybookDimensionV1 =
  | "intro" | "opening_design" | "narrative_structure" | "narrative_perspective"
  | "language_style" | "one_liner_crafting" | "topic_selection" | "resonance"
  | "logic_framework" | "reader_interaction" | "emotion_mobilization"
  | "question_design" | "scene_building" | "rhetoric" | "voice_rhythm"
  | "persuasion" | "values_embedding" | "structure_patterns"
  | "psychology_principles" | "special_markers" | "viral_patterns"
  | "ai_clone_strategy";

// ── 步骤标识 ──────────────────────────────────────

export type StyleWorkflowStepIdV1 =
  | "tone_setting" | "structure" | "opening" | "body"
  | "language_rhythm" | "polish" | "closure" | "lint_loop";

// ── Cluster Rules ──────────────────────────────────

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

// ── 风格目标引用 ──────────────────────────────────

export type StyleTargetRefV1 = {
  libraryId: string;
  clusterId: string;
  clusterRulesVersion: "cluster_rules_v1";
  styleProfileCardId?: string | null;
};

// ── 原稿材料（Scene B）──────────────────────────────

export type SourceMaterialV1 = {
  title?: string | null;
  text: string;
  url?: string | null;
};

// ── TaskSpec：Step 0 之前由代码预组装 ─────────────────

export type TaskSpecV1 = {
  version: "v1";
  taskId: string;
  scene: StyleSceneV1;
  prompt: string;
  platform: string | null;
  audience: string | null;
  wordCount: number | null;
  factBoundary: FactBoundaryV1;
  language?: string | null;
  styleTarget: StyleTargetRefV1;
  clusterRules: ClusterRulesV1;
  sourceMaterial?: SourceMaterialV1 | null;
};

// ── 原稿保护（Scene B）──────────────────────────────

export type SourceProtectionV1 = {
  sourceBrief: string;
  invariantClaims: string[];
};

// ── ToneCard：Step 0 输出 ───────────────────────────

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

// ── StructureOutline：Step 1 输出 ────────────────────

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

// ── DraftText：Step 2-6 输出 ─────────────────────────

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

// ── LintReport：Step 7 输出 ──────────────────────────

export type LintTypeV1 = "copy" | "style";

export type LintReportPayloadV1 = {
  lintType: LintTypeV1;
  passed: boolean;
  score?: number | null;
  issues: string[];
  rewritePrompt?: string | null;
  degraded?: boolean;
};

// ── StepArtifact：通用步骤产出 ───────────────────────

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

// ── Workflow State：整个管线的状态机 ──────────────────

export type StepRunStatusV1 =
  | "pending" | "running" | "succeeded" | "failed" | "degraded" | "skipped";

export type StepRunStateV1 = {
  stepId: StyleWorkflowStepIdV1;
  status: StepRunStatusV1;
  attempts: number;
  currentArtifactId?: string | null;
};

export type StyleWorkflowStateV1 = {
  version: "v1";
  workflowId: string;
  status: "running" | "waiting_user" | "completed" | "failed";
  currentStepId: StyleWorkflowStepIdV1 | null;
  nextStepId: StyleWorkflowStepIdV1 | null;
  taskSpec: TaskSpecV1;
  pipelineConfigId: string;
  pipelineVersion: "v1";
  stepStates: Record<StyleWorkflowStepIdV1, StepRunStateV1>;
  toneCard?: ToneCardV1 | null;
  structureOutline?: StructureOutlineV1 | null;
  currentDraftArtifactId?: string | null;
  bestDraftArtifactId?: string | null;
  // 审计日志：保留全局时序
  artifactLog: StepArtifactV1[];
  // 按步索引：快速查找
  artifactIdsByStep: Partial<Record<StyleWorkflowStepIdV1, string[]>>;
  // 最新版本索引：O(1) 取当前版本
  latestArtifactIdByStep: Partial<Record<StyleWorkflowStepIdV1, string>>;
  lint: {
    activePhase: "copy" | "style" | null;
    copyPass: boolean;
    stylePass: boolean;
    copyFailCount: number;
    styleFailCount: number;
    // lint.style 取最高分：3 版（初稿+2改稿）中 score 最高的版本
    bestStyleScore: number | null;
    bestStyleArtifactId?: string | null;
    // lint.copy 降级：连续 2 次不通过时取最高分版本继续
    bestCopyScore: number | null;
    bestCopyArtifactId?: string | null;
    lastCopyArtifactId?: string | null;
    lastStyleArtifactId?: string | null;
  };
  contextCache: {
    facetCardIdsByStep: Partial<Record<StyleWorkflowStepIdV1, string[]>>;
    styleProfileCardId?: string | null;
  };
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  lastError?: {
    code: string;
    message: string;
    stepId?: StyleWorkflowStepIdV1 | null;
  } | null;
};

// ── 执行模式 ──────────────────────────────────────

export type StyleExecutionMode = "agent_v1" | "pipeline_v1";
```

### Pipeline 配置（`packages/agent-core/src/styleWorkflowConfig.ts`）

```typescript
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
    maxCopyAttempts: number;          // lint.copy 最大尝试次数（含初次）
    maxStyleAttempts: number;          // lint.style 最大尝试次数（含初次）
    pickBestOnExhaust: boolean;        // 尝试耗尽后取最高分版本通过
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
```

### Desktop → Gateway 传输结构

```typescript
// Desktop 预打包的按步材料（随 run.request 一次性发送）
export type StylePipelinePayloadV1 = {
  version: "v1";
  pipelineConfigId: string;
  taskSpec: TaskSpecV1;
  materialsByStep: Partial<Record<StyleWorkflowStepIdV1, {
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
  }>>;
};
```

---

## 6. Desktop ↔ Gateway 数据流

### 方案：Desktop 预打包 + Gateway 管线执行

```
Desktop                                    Gateway
  │                                          │
  ├─ buildStylePipelinePayload()             │
  │   ├─ 读 PipelineConfigV1                 │
  │   ├─ 按每步 cards 配置本地检索           │
  │   ├─ 按 step 分组为 materialsByStep      │
  │   └─ 组装 TaskSpecV1                     │
  │                                          │
  ├─ run.request ──────────────────────────→  │
  │   styleExecutionMode: "pipeline_v1"      │
  │   stylePipelinePayload: {...}            │
  │                                          │
  │                                ← events  ├─ StyleWorkflowExecutor.run()
  │   run.execution.report                   │   ├─ Step 0: LLM call → ToneCard
  │   (step 进度, artifact id)               │   ├─ Step 1: LLM call → StructureOutline
  │                                          │   ├─ Step 2: LLM call → DraftText(opening)
  │                                          │   ├─ Step 3: LLM call → DraftText(body)
  │                                          │   ├─ Step 4: LLM call → DraftText(styled)
  │                                          │   ├─ Step 5: LLM call → DraftText(polished)
  │                                          │   ├─ Step 6: LLM call → DraftText(final)
  │                                          │   └─ Step 7: lint.copy / lint.style loop
  │                                          │
  │                               ← write    ├─ 最终 DraftText 通过 write 工具落盘
  ├─ doc.applyEdits (proposal-first)         │
  │   Keep/Undo 语义                         │
  └──────────────────────────────────────────┘
```

### 关键设计决策

1. **检索全在 Desktop 本地**：KB 数据不离开本地，满足 CLAUDE.md 的架构约束
2. **Gateway 管线执行不依赖中间 ws 往返**：所有卡片内容在 pipeline trigger 时一次性传入
3. **PipelineConfigV1 驱动两端**：同一份配置决定 Desktop 取什么卡 + Gateway 怎么跑
4. **中间态通过 `run.execution.report` 回传**：UI 可展示管线进度
5. **最终交付通过现有 write/doc.applyEdits**：保持 Keep/Undo 语义

### 管线触发条件

```typescript
// 判断是否走管线
const usePipeline =
  styleExecutionMode === "pipeline_v1"
  && styleGateEnabled
  && isWritingTask
  && (activeSkillIds.includes("style_imitate") || activeSkillIds.includes("style_imitate_v2"));
```

- `styleExecutionMode` 作为 transport 级字段（在 run.request 中传递），不仅靠 skill id 推断
- 现有 v2 gate 挂点：`runFactory.ts:3615` 和 `GatewayRuntime.ts:988` 可顺势扩展

### 用户交互

- 管线执行期间**不接受并发消息**——新消息取消当前 run 并启动新 run
- v1 不做 `waiting_user` 暂停——lint 连续失败 2 次自动降级交付
- 符合现有 Desktop 单会话单运行约束（`wsTransport.ts:189`）

---

## 7. 每步 LLM 调用方式

### 不复用 agentLoop

管线内每步使用**直接结构化 LLM call**，复用 Gateway 的 provider adapter（模型适配、超时、审计、失败记账），但不走 agentLoop 的工具选择循环。

原因：
- 8 步是强合同、无开放式工具探索的流程
- agentLoop 的自由度太高，反而破坏稳定性
- Step 0/1 输出 JSON schema，Step 2-6 输出 plain text——都是单次 LLM 调用

### lint.copy / lint.style

继续走现有工具执行路径（Desktop 本地执行或 sidecar），不改变。

### Step 4 分块策略

默认全文处理。当输入 token 超过 `fullPassMaxInputRatio`（0.45 × context window）时：
1. 按 StructureOutline.sections 分块
2. 块间保留 300 token overlap
3. 每块带 style_profile + RhythmGuide + ToneCard guardrail
4. 分块后必须额外 lint.style 检查拼缝（`seamLintRequired: true`）

---

## 8. PipelineConfigV1 默认实例

```typescript
export const STYLE_PIPELINE_CONFIG_V1: PipelineConfigV1 = {
  version: "v1",
  id: "style_imitate_pipeline_v1",
  stepOrder: [
    "tone_setting", "structure", "opening", "body",
    "language_rhythm", "polish", "closure", "lint_loop",
  ],
  global: {
    effectiveInputBudgetRatio: 0.8,
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
      llm: {
        stage: "style.workflow.tone",
        temperature: 0.3,
        maxOutputTokens: 1200,
        responseFormat: "json_schema",
      },
      lint: null,
      output: { kind: "tone_card", schemaName: "ToneCardV1" },
    },

    structure: {
      id: "structure",
      title: "骨架",
      executor: "llm",
      dependsOn: ["tone_setting"],
      cards: {
        playbookDimensions: [
          "topic_selection", "logic_framework",
          "narrative_structure", "structure_patterns",
        ],
      },
      retrieval: {
        topDocs: 4, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: false,
      },
      context: {
        includeTaskSpec: true,
        includeToneCard: true,
        includeStructureOutline: false,
        includePreviousDraft: "none",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.12,
      },
      llm: {
        stage: "style.workflow.structure",
        temperature: 0.35,
        maxOutputTokens: 1600,
        responseFormat: "json_schema",
      },
      lint: null,
      output: { kind: "structure_outline", schemaName: "StructureOutlineV1" },
    },

    opening: {
      id: "opening",
      title: "开场",
      executor: "llm",
      dependsOn: ["structure"],
      cards: {
        playbookDimensions: [
          "opening_design", "intro", "question_design", "viral_patterns",
        ],
        elementCardTypes: ["hook", "one_liner"],
        oneLinerSubtypes: ["hook"],
      },
      retrieval: {
        topDocs: 6, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: true,
      },
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "none",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.12,
      },
      llm: {
        stage: "style.workflow.opening",
        temperature: 0.7,
        maxOutputTokens: 1800,
        responseFormat: "plain_text",
      },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },

    body: {
      id: "body",
      title: "主体",
      executor: "llm",
      dependsOn: ["opening"],
      cards: {
        playbookDimensions: [
          "scene_building", "emotion_mobilization", "resonance",
          "persuasion", "psychology_principles",
          "reader_interaction", "narrative_perspective",
        ],
      },
      retrieval: {
        topDocs: 8, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: true,
      },
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.2,
      },
      llm: {
        stage: "style.workflow.body",
        temperature: 0.65,
        maxOutputTokens: 3200,
        responseFormat: "plain_text",
      },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },

    language_rhythm: {
      id: "language_rhythm",
      title: "语言风格",
      executor: "llm",
      dependsOn: ["body"],
      cards: {
        playbookDimensions: ["language_style", "voice_rhythm"],
        includeStyleProfile: true,
      },
      retrieval: {
        topDocs: 4, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: true,
      },
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.45,
      },
      llm: {
        stage: "style.workflow.language_rhythm",
        temperature: 0.35,
        maxOutputTokens: 3600,
        responseFormat: "plain_text",
      },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },

    polish: {
      id: "polish",
      title: "点睛",
      executor: "llm",
      dependsOn: ["language_rhythm"],
      cards: {
        playbookDimensions: [
          "rhetoric", "special_markers",
          "viral_patterns", "one_liner_crafting",
        ],
        elementCardTypes: ["one_liner", "other"],
        oneLinerSubtypes: ["punchline"],
      },
      retrieval: {
        topDocs: 6, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: true,
      },
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.25,
      },
      llm: {
        stage: "style.workflow.polish",
        temperature: 0.55,
        maxOutputTokens: 2200,
        responseFormat: "plain_text",
      },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },

    closure: {
      id: "closure",
      title: "收束",
      executor: "llm",
      dependsOn: ["polish"],
      cards: {
        playbookDimensions: ["values_embedding"],
        elementCardTypes: ["one_liner", "ending"],
        oneLinerSubtypes: ["ending"],
        includeClusterRules: true,
      },
      retrieval: {
        topDocs: 4, perDocTopN: 2,
        groupBy: "source_doc", dedupeBy: "card_id",
        allowEmpty: true,
      },
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: false,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.18,
      },
      llm: {
        stage: "style.workflow.closure",
        temperature: 0.45,
        maxOutputTokens: 1200,
        responseFormat: "plain_text",
      },
      lint: null,
      output: { kind: "draft_text", schemaName: "DraftTextPayloadV1" },
    },

    lint_loop: {
      id: "lint_loop",
      title: "Lint Loop",
      executor: "lint_loop",
      dependsOn: ["closure"],
      cards: {},
      retrieval: null,
      context: {
        includeTaskSpec: false,
        includeToneCard: true,
        includeStructureOutline: true,
        includePreviousDraft: "previous_full",
        includeBestDraft: true,
        rawPromptMode: "normalized_only",
        maxInputTokensRatio: 0.3,
      },
      llm: null,
      lint: {
        maxCopyAttempts: 3,
        maxStyleAttempts: 3,
        pickBestOnExhaust: true,
      },
      output: { kind: "lint_report", schemaName: "LintReportPayloadV1" },
    },
  },
};
```

---

## 9. 迁移路径

### Phase 0：类型定义

**新增文件**：
- `packages/agent-core/src/styleWorkflowTypes.ts` — 所有 V1 类型 + `StylePipelinePayloadV1` + `StyleExecutionMode`
- `packages/agent-core/src/index.ts` — 导出新类型

**改动文件**：无

### Phase 1：Pipeline 配置

**新增文件**：
- `packages/agent-core/src/styleWorkflowConfig.ts` — `PipelineConfigV1` 默认实例 + step-materials 映射规则

**改动文件**：
- `packages/agent-core/src/index.ts` — 导出新配置

### Phase 2：数据通道打通

**改动文件**：
- `apps/desktop/src/agent/gatewayAgent.ts` — 新增 `buildStylePipelinePayload()` 函数，根据 PipelineConfigV1 预检索并按步分组卡片
- `apps/desktop/src/agent/wsTransport.ts` — `run.request` 增加 `styleExecutionMode` + `stylePipelinePayload` 字段
- `apps/gateway/src/agent/runFactory.ts` — schema 接收 `styleExecutionMode` + `stylePipelinePayload`，透传到 `runCtx`

**目的**：先把数据通道打通，Gateway 暂时不处理 pipeline payload。

### Phase 3：Workflow Executor

**新增文件**：
- `apps/gateway/src/agent/styleWorkflowExecutor.ts` — 按 PipelineConfigV1 顺序执行的主循环

**改动文件**：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts` — `run()` 内新增 pipeline 分支：`styleExecutionMode === "pipeline_v1"` 时走 `StyleWorkflowExecutor`
- `apps/gateway/src/agent/runFactory.ts` — 补充 runCtx 组装逻辑

**核心逻辑**：
```typescript
// GatewayRuntime.run()
if (runCtx.styleExecutionMode === "pipeline_v1" && runCtx.stylePipelinePayload) {
  return await StyleWorkflowExecutor.run(runCtx);
}
// else: 走现有 agentLoop / v2 workflow gate
```

### Phase 4：切换 + UI 适配

**改动文件**：
- 默认 `styleExecutionMode = "pipeline_v1"`
- 保留 `agent_v1` fallback
- `apps/desktop/src/state/runStore.ts` — 消费 `run.execution.report` 中的 pipeline 进度
- `apps/desktop/src/components/...` — UI 展示管线步骤进度、degraded 状态

**可选清理**（验证稳定后）：
- 删除 `styleOrchestrator.ts` 中的 `computeStyleTurnCaps` / `buildStyleSnapshot` / `buildHint`
- 删除 `workflowSkills.ts` 中的 `computeStylePhaseAndMissing` / `styleImitateWorkflowContract`
- 删除 `runMachine.ts` 中的 `analyzeStyleWorkflowBatch`
- 精简 `GatewayRuntime._updateRunState` / `_getFollowUpMessages` 中的 v1 分支
- 删除 `workflowPhaseInterpreter.ts`

---

## 10. 可删除的门控代码清单

管线化后以下代码可完全删除：

| 文件 | 函数/模块 | 行数估计 | 说明 |
|------|----------|---------|------|
| `styleOrchestrator.ts` | `computeStyleTurnCaps` | ~50 行 | per-turn 工具白名单计算 |
| `styleOrchestrator.ts` | `buildStyleSnapshot` | ~30 行 | 阶段快照 |
| `styleOrchestrator.ts` | `buildHint` | ~40 行 | 阶段提示生成 |
| `workflowSkills.ts` | `computeStylePhaseAndMissing` | ~60 行 | 阶段+缺失步骤计算 |
| `workflowSkills.ts` | `styleImitateWorkflowContract` | ~90 行 | workflow 合同定义 |
| `runMachine.ts` | `analyzeStyleWorkflowBatch` | ~100 行 | 批量工具违规检查 |
| `workflowPhaseInterpreter.ts` | 整个文件 | ~200 行 | 通用阶段解释器 |
| `GatewayRuntime.ts` | violation 拦截逻辑 | ~80 行 | L1831-1910 |
| `GatewayRuntime.ts` | follow-up 注入 style 分支 | ~60 行 | L981-1036 |
| `GatewayRuntime.ts` | `_updateRunState` style 部分 | ~140 行 | L2311-2451 |
| `runFactory.ts` | `computePerTurnAllowed` style 分支 | ~80 行 | L3518-3655 |
| **合计** | | **~930 行** | 不含注释和空行 |

---

## 11. 架构隐患

### S 级：cluster_rules_v1 当前未注入 Context Pack

`wsTransport.ts:678-680` 写入 mainDoc，但 `gatewayAgent.ts` 的 4 个 context section 均不包含 values 和 analysisLenses。管线化方案通过 `StylePipelinePayloadV1.materialsByStep` 直接传递，绕过了这个问题。但如果管线未上线前仍使用 Agent 模式，这个断点持续存在。

### A 级：one_liner 卡缺乏 subtype 分类

当前 one_liner 元素卡没有 `hook` / `punchline` / `ending` 的 subtype 区分。管线 Step 2（hook 类）、Step 5（punchline 类）、Step 6（ending 类）需要按 subtype 过滤。需要在 element card 提取阶段增加 subtype 分类逻辑。

### A 级：style_profile 卡独立于 22 个 playbook 维度

`style_profile` 是 `playbook_facet` 之外的独立卡类型（`cardType="style_profile"`），不在 22 维度之列。Step 4 需要专门处理其注入。PipelineConfig 中已通过 `includeStyleProfile: true` 声明。

### B 级："宝贝"过度表征问题未解决

单文档口头禅被放大为库级特征的根因（playbook 生成时所有文章的 element cards 无 per-document normalization 送入 LLM）仍需独立修复，不在管线化范围内。

---

## 12. 验证 Checklist

### Phase 2 验证（数据通道）

- [ ] Desktop `buildStylePipelinePayload()` 能正确按步分组 22 维度的规则卡
- [ ] `run.request` 成功携带 `stylePipelinePayload` 到 Gateway
- [ ] Gateway `runFactory` 能正确解析并透传到 `runCtx`
- [ ] 现有 Agent 模式不受影响（`styleExecutionMode` 为空或 `"agent_v1"` 时走原路径）

### Phase 3 验证（Executor）

- [ ] **正常路径**：话题写作 → Step 0-6 顺序执行 → Step 7 lint.copy 通过 → lint.style 通过 → write 交付
- [ ] **Scene A**：只给话题 → ToneCard.stanceSource="values"、valuesConstraintMode="dominant"
- [ ] **Scene B**：给定观点 → ToneCard.stanceSource="user"、valuesConstraintMode="negative_guardrail"、sourceProtection 有值
- [ ] **lint.copy 不通过**：edit 改稿 → 回到 7a → 最多 3 次尝试
- [ ] **lint.style 不通过**：edit 改稿 → 回到 7b（不回 7a）→ 最多 3 版
- [ ] **lint.style 取最高分**：3 版中 score 最高的版本作为终稿交付
- [ ] **lint.style 改稿后不回查 copy**：确认 lint.style edit 不触发 lint.copy
- [ ] **Step 4 分块 fallback**：长文超预算 → 按 sections 分块 → 分块后 lint 拼缝
- [ ] **artifact 审计**：每步 artifactLog 正确记录，artifactIdsByStep 索引正确

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 13. 涉及文件清单

### 新增文件

| 文件 | Phase | 说明 |
|------|-------|------|
| `packages/agent-core/src/styleWorkflowTypes.ts` | 0 | 所有 V1 类型定义 |
| `packages/agent-core/src/styleWorkflowConfig.ts` | 1 | PipelineConfigV1 默认实例 + 配置工具函数 |
| `apps/gateway/src/agent/styleWorkflowExecutor.ts` | 3 | 管线执行器 |

### 改动文件

| 文件 | Phase | 改动范围 |
|------|-------|---------|
| `packages/agent-core/src/index.ts` | 0-1 | 导出新类型和配置 |
| `apps/desktop/src/agent/gatewayAgent.ts` | 2 | 新增 `buildStylePipelinePayload()` |
| `apps/desktop/src/agent/wsTransport.ts` | 2 | `run.request` 增加 pipeline 字段 |
| `apps/gateway/src/agent/runFactory.ts` | 2-3 | schema + runCtx 组装 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 3 | pipeline 分支路由 |

### 可删除文件/代码（Phase 4 后）

| 文件 | 说明 |
|------|------|
| `apps/gateway/src/agent/styleOrchestrator.ts` | 大部分函数可删 |
| `packages/agent-core/src/workflowPhaseInterpreter.ts` | 整个文件可删 |
| `packages/agent-core/src/workflowSkills.ts` | style 相关函数可删 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` 中的 style 门控 | ~280 行可删 |
| `apps/gateway/src/agent/runFactory.ts` 中的 style 门控 | ~80 行可删 |

---

## 14. 与现有方案的关系

| 现有方案 | 关系 | 处理 |
|---------|------|------|
| `style_imitate` (v1) | 被替代 | Phase 4 后 autoEnable=false |
| `style_imitate_v2` (SKILL.md) | 被替代 | Phase 4 后 autoEnable=false |
| `fix-style-writing-homogeneity-v1.md` | Fix 1（sanitize 拆分）仍有价值 | 管线化不解决 sanitize 问题，需独立修 |
| `fix-style-writing-homogeneity-v1.md` | Fix 2（prompt 增强）被管线替代 | 每步有专用 prompt，不再依赖通用 skill prompt |
| `workflow-skills-runtime-v0.2` | 方向一致 | 管线化是 v0.2 的完整实现 |

---

以上是风格仿写管线化的完整实施规格。核心改变：从"给 LLM 自由 → 用 2000 行代码约束"变为"代码控制序列 → LLM 只做每步的文本生成"。预计可删除 ~930 行门控代码，新增 ~300 行执行器代码 + ~200 行类型定义 + ~150 行配置。
