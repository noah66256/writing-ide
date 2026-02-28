## Style Selector v1（自动选簇 + 自动选 21 卡，按题材/话题适配）

> 状态：已落地（2026-01-17）。Selector 在 **Desktop 侧**计算并注入 Context Pack，确保“换生成模型不影响选簇/选卡”。  
> 运行态注入：`KB_STYLE_CLUSTERS(JSON)` + `STYLE_SELECTOR(JSON)` + `STYLE_FACETS_SELECTED(Markdown)`（仅写作类任务/`style_imitate` 激活时）。

### 0. 目标（对应诉求）
- **R1 自动选**：写作任务默认自动选簇（cluster），不再强制用户先手选；但必须可解释、可改口。
- **R2 按话题适配**：同一风格库混题材时，系统要能按“当前选题/话题”选到更合适的簇，并选到更合适的 21 维度子集（TopK）。
- **R3 与生成模型解耦**：Desktop 端切换 Claude/DeepSeek/Gemini…只影响“写的质量”，不应影响“选簇/选卡”。
- **R4 可观测**：每次选择都要有 why/trace，且在日志/审计可追溯。

### 1. 非目标（v1 不做）
- 不做跨库自动匹配（仅在已绑定的 style 库内选择）。
- 不在写作 Run 内重聚类（聚类/规则在“库体检”生成并落盘，Run 只读快照）。
- 不依赖 LLM“临场选簇/选卡”（避免换模型导致漂移）。

### 2. Selector 的定位：一个可测的“选择器”，不是提示词玄学
Selector 是一个近似纯函数：
- **输入**：库快照（clustersV1 + cluster rules）+ 话题信号 + 写作阶段（stage）+ 用户显式覆盖
- **输出**：selectedClusterId + selectedFacets(TopK) + why/trace

### 3. 输入 / 输出（当前实现口径）

#### 3.1 输入
- **已绑定 style 库**：`KB_SELECTED_LIBRARIES` 中 `purpose=style` 的库（v1 先按“当前主库/第一库”处理）。
- **库体检快照**：
  - `fingerprint.clustersV1`（簇列表：label/stability/coverage/anchors/evidence/queries/facetPlan…）
- **话题信号**：
  - `mainDoc.goal`
  - `userPrompt`
- **写作阶段 stage（启发式）**：从 `RUN_TODO` 当前未完成项 + prompt 关键词判断：`opening/outline/draft/ending/polish`。

#### 3.2 输出（Context Pack）
- **`STYLE_SELECTOR(JSON)`（v=2）**：
  - `selectedClusterId`
  - `stage`：`{id,label,by,evidence?}`
  - `selectedFacetIds`：TopK（4–8）
  - `selectedFacets[]`：`{facetId,label,why,kbQueries,score}`
  - `why[]` + `trace{ cluster..., facets... }`
- **`STYLE_FACETS_SELECTED(Markdown)`**：把入选 facet 对应的 `playbook_facet` 卡正文注入（控量/截断），让生成模型“看得见就必须执行”。

### 4. v1 核心策略（当前实现）

#### 4.1 自动选簇（cluster）：按优先级，不用公式硬套
优先级（从高到低）：
1) **anchors 优先**：若某簇已采纳 anchors，则优先选 anchors 多的簇（更像原文）。
2) **topicFit（词法命中）**：用 `mainDoc.goal + userPrompt` 对簇的 `label/queries/evidence.quote` 做命中打分，取最高分簇（同分用稳定性/覆盖率/段数打破）。
3) **defaultClusterId**（仅本库）：若库设置了默认写法则优先（但优先级低于 anchors 与 topicFit；并且默认可随时取消）。
4) **兜底排序**：`stability` > `docCoverageRate` > `segmentCount`。

> 说明：文档草案里提到的“向量兜底统计命中簇”在 v1 **未启用**（后续可增量）。

#### 4.2 自动选 21 卡（facet）：全量候选 + stage/话题重排 + TopK
候选集合：
- **facetPack 全量 facets**（默认 21）
- + **该簇 facetPlan**（避免 cluster rules 的默认卡丢失）

stage 必备/辅助卡（speech_marketing_v1，摘要）：
- **opening**：opening_design/intro/question_design/emotion_mobilization/voice_rhythm/one_liner_crafting…
- **outline**：narrative_structure/logic_framework/structure_patterns…
- **draft**：logic_framework/narrative_structure/persuasion/voice_rhythm/emotion_mobilization…
- **ending**：values_embedding/resonance/structure_patterns…
- **polish**：language_style/voice_rhythm/special_markers/ai_clone_strategy…

评分（当前实现）：
- `topicFit`：词法命中归一化
- `stageFit`：必备=1，辅助=0.6，其它=0
- `basePlan`：来自 cluster.facetPlan=1，否则=0
- **`score = 0.55*topicFit + 0.30*stageFit + 0.15*basePlan`**

选择规则：
- 先强制纳入 stage 必备卡（存在才纳入）
- 再按 score 补齐到 TopK（4–8，随 stage 变化）

每张入选 facet 会生成 1–2 条 `kbQueries`（供后续 `kb.search` 用）：
- `q1 = <topicBrief + facetLabel>`
- `q2 = q1 + <cluster/plan hint>`（可选）

### 5. 注入与消费：保证换生成模型也能用
- **Main Doc**：继续使用 `styleContractV1` 固化“选簇/anchors/默认 facetPlan”等长期约束（不塞长文）。
- **Context Pack（运行态）**：
  - `KB_STYLE_CLUSTERS(JSON)`：候选簇摘要（含 recommended/default）
  - `STYLE_SELECTOR(JSON)`：本次选簇/选卡（TopK）结果
  - `STYLE_FACETS_SELECTED(Markdown)`：本次入选维度卡正文

### 6. 可改口（Override）规则
- 用户显式输入：`写法A/B/C`、`cluster_0/1/2`、或“换成写法X”
  - 立即覆盖并写入 `mainDoc.styleContractV1`（后续回合固定沿用，除非再次改口）。

### 7. 与 Skills / Gateway 的对齐
- `style_imitate` skill 仍负责写作闭环纪律：`kb.search →（可选）lint.style → write`。
- Selector 只负责“选簇/选卡”，并把结果结构化注入，供任何生成模型稳定消费。

### 8. 稳定性补丁（跨模型）
- Gateway 在 Schema 校验后，会对 `run.updateTodo` 常见参数错误做兼容修复（缺 `patch` 自动封装；缺 `id` 自动分配），并通过 `policy.decision(ToolArgNormalizationPolicy)` 可观测。


