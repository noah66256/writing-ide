## Style Selector v1（自动选簇 + 自动选 21 卡，按题材/话题适配）方案草案

### 0. 目标（对应诉求）
- **R1 自动选**：Agent 在写作任务中默认自动选簇（cluster），不再要求用户先手选；但必须可解释、可改口。
- **R2 按话题适配**：同一风格库可能混杂题材/写法；系统要能根据“当前选题/话题”选到更合适的簇，以及更合适的结构/金句/情绪调动（21维度子集）。
- **R3 与生成模型解耦**：无论 Desktop 端选择哪个生成模型（Claude/DeepSeek/Gemini/...），Selector 的选择结果应稳定一致；生成模型只负责“写”，不负责“选”。
- **R4 可观测**：每次自动选择都要能在日志/审计里说明“为什么选它”（reasonCodes + 证据）。

### 1. 非目标（v1 不做）
- 不做跨库自动匹配（只在“已绑定的 style 库”内做选择）。
- 不在写作 Run 内做重计算/重聚类（沿用库体检产出的快照）。
- 不强依赖 LLM 做路由（避免换模型导致选簇漂移）。

### 2. Selector 的定位：一个可测的“选择器”，而不是提示词玄学
Selector 是一个“纯函数（或近似纯函数）”：
- 输入：库快照 + 当前任务话题信号 + 写作阶段（粗粒度） + 用户显式覆盖
- 输出：selectedClusterId + selectedFacetIds + why/trace

### 3. 输入 / 输出

#### 3.1 输入
- **已绑定 style 库**：`KB_SELECTED_LIBRARIES` 中 `purpose=style` 的库（可多库，v1 先按“当前主库/第一库”处理）。
- **库体检快照**：
  - `fingerprint.clustersV1`
  - `perSegment.clusterId`
  - `cluster rules`（含 facetPlan/queries/evidence/anchors/checks/softRanges）
- **话题信号**（尽量结构化）：
  - `mainDoc.goal`
  - `userPrompt`
  - 可选：显式引用 `@{...}` 的文件名/标题（只当弱信号）
- **写作阶段（stage）**：开头/正文/收尾/润色（v1 先启发式：按 todo 当前项/或 prompt 关键词判定）。

#### 3.2 输出
- **selectedClusterId**：例如 `cluster_0/cluster_1/cluster_2`
- **selectedFacetIds[]**：从 21 维度中选出本次要“真正执行”的 4–8 张（随阶段变化）
- **why[]**：给人看的 2–4 条理由（必须带证据引用句/命中点）
- **trace**：给系统审计用的分数字段（topicFit/stability/anchorBonus/defaultBonus 等）

### 4. v1 核心策略：不靠模型“临场选”，靠“快照 + 检索信号”选

#### 4.1 自动选簇（cluster）评分：Topic-aware + Stability-aware
对每个 cluster 计算总分（示意）：
- `score = 0.55*topicFit + 0.25*stability + 0.15*anchorBonus + 0.05*defaultBonus`

其中：
- **topicFit（话题契合度）**：推荐“先词法后向量（可开关）”
  - 词法：用 `userPrompt/mainDoc.goal` 与 cluster 的 `queries/evidence/topNgrams` 做重叠命中
  - 向量兜底（可选开关）：用 `kb.search(useVector=true)` 召回后，统计命中段落分属哪个 cluster 更多
- **stability**：直接使用库体检的稳定性（high/medium/low → 1/0.6/0.3）
- **anchorBonus**：该簇已采纳 anchors → 加权提升（优先“更像原文”）
- **defaultBonus**：库配置里设为默认写法 → 小幅加权

#### 4.2 自动选 21 卡：只选“本次要用的”，选出来就必须执行
目标不是“覆盖21”，而是“选出来就必须执行”，避免 21 卡沦为噪音。

步骤：
- 从 `cluster rules.facetPlan` 取候选集合（优先来源）
- 按 stage（开头/正文/收尾/润色）补 1–2 张“阶段必备卡”
- 对候选卡做话题排序（词法优先，必要时向量兜底），取 TopK（建议 4–8）
- 对每张入选 facet：用 facet 的 `kbQueries` 再拉 1–2 段“同题材/近题材”的原文段落作为执行锚点（evidence/anchors 级别的短引用）

### 5. 注入与消费：保证换生成模型也能用
- **Main Doc（最靠前）**：写入/更新 `styleContractV1`（selectedCluster + hardRules + anchors + softRanges）
- **Context Pack（短 JSON）**：新增 `STYLE_SELECTOR(JSON)`：
  - `{ selectedClusterId, selectedFacetIds, why[], trace{} }`
- **可见但不强制手选**：仍展示 2–3 个候选写法（证据句+理由），但默认自动选择推荐并继续写；用户改口则覆盖并固化。

### 6. 可改口（Override）规则
- 用户显式输入：`写法A/B/C` 或 `cluster_0/1/2` 或 “换成写法X”
  - 立即把选择写入 `mainDoc.styleContractV1`
  - 后续回合固定，不再漂移（除非用户再次改口）

### 7. 与 Skills / Gateway 现有流程的对齐
- `style_imitate` skill 仍负责“写作闭环门禁”（kb.search → lint.style → write），不改变其核心纪律。
- Selector 只负责“选簇/选卡”，并把结果放进 Main Doc/Context Pack，供任何模型稳定消费。

### 8. 实施步骤（下一步要改哪些）

#### 8.1 文档层（已落盘）
- `plan.md` 增加导航入口
- `kb-manager-v2-spec.md`：写法候选口径改为“默认自动选推荐并继续；可改口”

#### 8.2 代码层（下一步开工，单独 PR）
- **Gateway**：
  - 将 `StyleClusterSelectPolicy` 从“强制 clarify_waiting”调整为“默认自动选并继续”（仍输出候选+理由+可改口指令）。
  - 将每次选择结果写入审计：policy.decision 增加 Selector 的 trace。
- **Desktop**：
  - 让选择结果持久化到 `mainDoc.styleContractV1`，保证换模型/续跑不丢。
- **agent-core**：
  - 增加 `StyleClusterAutoSelectPolicy/FacetSelectPolicy` 的 reasonCodes 与回归用例。

### 9. 验收标准（可一句话判断对不对）
- 同一风格库混题材：输入不同话题，自动选的 cluster 会合理变化（并能解释“为什么”）。
- Desktop 换生成模型：选簇/选卡不变；只是“写出来的质量”随模型变化。
- 用户说“用写法B”：立刻切换并持续沿用，不再被后续短回复（继续/好的）带偏。


