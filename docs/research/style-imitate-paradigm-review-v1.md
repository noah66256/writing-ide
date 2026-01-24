## 仿写（style_imitate）链路系统性复盘：从“修补”到“范式”（research v1）

> 状态：draft（2026-01-23）  
> 目标：整体检查“仿写/改写/润色”链路，找“范式级问题”（不是补 if/else），并给出可落地的改造路线与验收指标。

---

### 0. 这条链路到底在解决什么

我们要的不是“写得像”这么一句话，而是同时满足三件事：

- **像（style fidelity）**：像某个风格库/写法候选（cluster/facets/anchors）；
- **不贴（anti-regurgitation）**：不能把风格库样例/参考原文的句子段落“近似复述/逐句改写”贴出来；
- **可控（controllability）**：能解释、能自检、能回炉、能降级（不卡死）。

其中，“像”主要靠 **结构化风格契约 + 模板检索 + lint**；“不贴”不能只靠提示词，必须有 **可验证的拦截机制**。

---

### 1. 现状盘点（以文档与代码为准）

项目内已有的关键文档脉络：

- `docs/research/style-skill-gating-v1.md`：核心结论是 **Router/Gate + Progressive Disclosure**；风格库不应常驻注入，只在写作分支启用。
- `style-selector-v1.md`：Selector 在 **Desktop 侧**做“选簇/选卡”，并注入 `KB_STYLE_CLUSTERS/STYLE_SELECTOR/STYLE_FACETS_SELECTED`，保证换模型也稳定。
- `kb-manager-v2-spec.md`：V2 方向明确：**anchors（黄金样本）+ cluster rules + styleContract（短硬可验证）**，并强调“统计口径确定性”。
- `docs/research/context-pack-mechanism-improvements-v1.md`：强调 **Context Budget + Trust Boundary + Retrieval-first**（少塞、多读）。

代码侧（链路落点）：

- Desktop：`apps/desktop/src/agent/gatewayAgent.ts`
  - 只在 `style_imitate` 激活且不被 `web_topic_radar` 抢占时，注入 playbook 与 selector 产物（避免研究/盘点被风格抢跑）。
- Gateway：`apps/gateway/src/index.ts`
  - 对 `style_imitate` 做**阶段门禁（toolCapsPhase）**：`style_need_kb → style_need_lint → style_can_write`。
  - `style_need_kb` 阶段强制把 `kb.search` 纠偏为 **kind=card** 且补默认 `cardTypes=[hook,one_liner,ending,outline,thesis]`，避免把段落当“样例”导致贴原文。
  - lint 闸门支持 `hint/safe/gate`，并有“回炉上限 + keepBest + safe 降级放行”。
- agent-core：`packages/agent-core/src/skills.ts` & `runMachine.ts`
  - `style_imitate` 只在 `{mode∈plan/agent} + {has style library} + {runIntent∈writing/rewrite/polish}` 激活；
  - `detectRunIntent` 里引入“弱 sticky”与 research-only 排除，降低“查一下/全网+GitHub 大搜”误判为写作闭环的概率。

---

### 2. 为什么会“反复修补”：范式级根因

#### 2.1 把“风格样例”当作“可直接复用文本”

当系统允许/鼓励检索段落（paragraph/outline）并把它们作为“写作样例”喂给模型时，“贴原文”几乎不可避免：  
LLM 的最省力路径就是 **就地改写**（最像也最危险）。

范式层面的改法不是继续改提示词，而是：

- **样例检索的默认单位必须是“模板/规则卡（card）”而不是“原文段落”**；
- “原文段落”只能在 **证据位**出现，并且要小范围、可回链、可审计（anchors 或首段/尾段窗口）。

#### 2.2 只有“像”的闸门，没有“不贴”的闸门

当前 `lint.style` 主要衡量“像不像”（句长/节奏/禁用词/手法等），但**没有**对“与参考文本重合度”的确定性约束。  
于是出现一个经典反直觉：**越像，越可能越贴**。

要从范式上闭环，必须把质量拆成两条正交维度：

- style fidelity：像（可软可硬）
- regurgitation risk：不贴（建议更硬、可机检）

#### 2.3 “重资源注入”仍会放大贴原文倾向

当 playbook/样例过长（或段落证据过多）时，模型会偏向“复用最近看见的具体句子”。  
`context-pack-mechanism-improvements-v1.md` 里提到的 **Retrieval-first** 在这里是关键：把重资源变成“索引 + 按需取”，并做预算与 manifest。

---

### 3. 全网/论文的共识（可复用到我们这里的范式）

#### 3.1 风格迁移：把“内容”与“风格模板”解耦

近年的长文本风格迁移工作强调“句子模板 + 段落结构模板”的双层仓库（hierarchical template repository），核心思想就是：  
**让模型学模板，而不是抄句子。**

参考：

- ZeroStylus（句子/段落双层模板仓库，长文本更稳）：`https://arxiv.org/html/2505.07888v1`

#### 3.2 反抄袭/复用检测：n-gram / LCS / alignment 仍然最实用

工程上最稳的是确定性度量：n-gram 重合、最长公共连续片段（LCS/最长公共子串）、局部对齐（Smith–Waterman 变体）等。  
开源工具里也大量用 shingles/minhash/LSH 来做候选筛选与重合段提取（例如 `textreuse`）。

参考：

- R 包 `textreuse`（shingles/minhash/局部对齐）：`https://docs.ropensci.org/textreuse/`

> 注意：我们不需要把“检测 paraphrase 抄袭”做到学术级别；先把“明显贴/逐句改写”的风险压下去，就能显著减少用户主观不满与合规风险。

#### 3.3 “降低逐字复现”更好的根治来自训练（我们当前不可用）

例如 ParaPO（后训练让模型偏好 paraphrase，降低无意复现训练数据）属于“模型层”改造；  
我们当前能做的是“系统层 guardrail + 多阶段生成”。

参考：

- ParaPO：`https://arxiv.org/abs/2504.14452`

---

### 4. 建议的系统性改造（短期/中期/长期）

#### 4.1 短期（1–2 天能落地，立刻减少贴原文）

1) **把“不贴”落成一个确定性 checker（建议命名：`lint.copy` 或并入 `lint.style`）**  
对候选稿分别计算它与以下文本的相似度/复用片段：

- A) 用户要改写/仿写的“原文输入”（选区/指定文件/引用）
- B) 本轮用到的风格样例（建议只取 kb.search top hits / anchors / samples）

建议至少实现 2 个指标（中文用“字符 n-gram”即可）：

- **Char 5-gram Jaccard**：重合率高 → 强烈提示“逐句改写”
- **Longest common substring length（字符）**：出现长连续复用片段 → 直接判定高风险

输出结构建议：

- `riskLevel: low|medium|high`
- `overlapTopSpans[]`：把“复用段”以起止索引/片段文本列出来（便于 UI/Problems 展示与回炉提示）
- `rewriteAdvice`：建议的“改法”（结构重排/换句式/改衔接/改类比）

2) **把 toolCaps 的“样例/证据”分车道（只准走模板车道拿样例）**  
继续坚持：`style_need_kb` 只允许 `kb.search(kind=card)`；证据段落只能在后续阶段、且必须带 anchor 过滤与长度预算。

3) **把“keepBest”从“只按 style 分数”升级为“多目标 best”**  
bestDraft 不应只看 `lint.style.score`，至少应同时看：

- style score（越高越像）
- copy risk（越低越安全）

否则会出现“最像的那版最贴”的反直觉最优。

#### 4.2 中期（1–2 周：从“检索段落”升级为“模板驱动”）

1) **扶正 `styleContractV1`：让它成为“短硬可验证的口味契约”**  
对齐 `kb-manager-v2-spec.md`：contract 里要有 `anchors/evidence/checks/facetPlan`，并且注入位置靠前（Main Doc），长度控制在 1–2 屏。

2) **把 21 维度卡结构化为“规则卡”**  
每张 facet 卡升级到：`must/avoid/templates/evidence/queries/checks`，避免散文化发挥。

3) **把 playbook 从“长文注入”改为“索引注入 + 按需 kb.search”**  
对齐 `context-pack-mechanism-improvements-v1.md` 的 retrieval-first：  
上下文里只保留 selector/contract 摘要，正文靠工具取。

#### 4.3 长期（>1 月：更像原文，但更不贴）

1) **落地 V2 anchors/cluster rules 作为一等公民**（`kb-manager-v2-spec.md`）  
让“像什么”更多来自 anchors 与规则，而不是段落示例。

2) **引入“模板仓库（句子+段落双层）”的抽取与复用**  
对齐 ZeroStylus 这类范式：从 reference text 抽“结构模板”，写作时匹配模板、填充内容，而不是仿句子。

---

### 5. 验收指标（让改造可验证、可回归）

建议把每次 style_imitate run 的关键指标写入 `policy.decision` 或 runAudits：

- `style.selector.selectedClusterId/selectedFacetIds`
- `kb.search`: 命中数、kind 分布（card vs paragraph）、是否 degraded
- `lint.style`: score/highIssues/failCount/是否降级
- `lint.copy`（新增）：riskLevel、topSpanLen、ngramOverlap
- 最终写入是否发生：proposal/apply

最低回归用例（文本可用固定样例，跑 `apps/gateway/scripts/regress-agent-flow.ts`）：

1) 绑定风格库 + 输入“查一下全网和 GitHub…”：不应激活 style_imitate（或不注入重资源），应走 web_topic_radar/研究分支  
2) 绑定风格库 + 明确写作：必须按 `style_need_kb → style_need_lint → can_write` 推进  
3) 人为构造“明显贴原文”的候选稿：`lint.copy` 必须报 high，并触发回炉提示/闸门

---

### 6. 建议的下一步（按最小闭环推进）

- M0：在现有 `lint.style` 工具结果中增加 `copyRisk`（或新增 `lint.copy`），先把“明显贴原文”压下去  
- M1：把 bestDraft 选择改为多目标（style + copyRisk）  
- M2：补齐 `styleContractV1` 的字段与注入策略（短硬、靠前、可验证）  
- M3：推进 `kb-manager-v2-spec.md` 的 anchors/cluster rules，使“像”更稳定且更不依赖段落示例

补充：长期落地路线图（含风险与落地点）见：
- `docs/specs/style-imitate-longterm-roadmap-v0.1.md`

