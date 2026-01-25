## 仿写（style_imitate）V2（Clean）方案：状态机前置 + 模板/规则驱动（v0.1）

> 状态：draft（2026-01-24）  
> 目标：把“像/不贴/可控”做成**前置状态机**与**可审计产物**，避免被旧链路（段落样例+后验纠偏）干扰。  
> 范围：仅定义 V2 的目标形态与接口契约，不绑定旧实现细节。
>
> 开工前整理（现状清单）：[`docs/specs/style-imitate-v2-ui-api-inventory-v0.1.md`](style-imitate-v2-ui-api-inventory-v0.1.md)

---

### 0. 北极星与不变量

- **像（style fidelity）**：像某个风格库里被选定的“写法簇”（cluster）与其模板/规则体系。
- **不贴（anti-regurgitation）**：不依赖“看长段原文→就地改写”获得像；对明显复用有确定性约束与可解释证据。
- **可控（controllability）**：能解释、能自检、能回炉、能降级不卡死；最终落盘必可追溯“用的哪版稿”。

不变量：
- 写作 IDE 定位不变；写入仍遵守 proposal-first（中高风险）。
- 写作与 research/ops 必须路由分流（style 仅在写作分支启用）。
- 工具协议仍为 Schema + XML 独占消息（避免解析/时序混乱）。

---

### 1. 概念：把“像”拆成两层

V2 的“像”不再主要来自“复用句子”，而来自两层抽象：

- **A) 语言外形（surface style）**：句长/节奏/人称/问句/口头禅/数字密度等，可被 `lint.style` 评估。
- **B) 认知外形（cognitive style）**：价值观与分析视角（你提的两个维度），决定“作者会怎么站队/怎么下结论/怎么选战场”。

V2 通过“模板/规则卡 + 短硬契约”把 A/B 两层都变成可复用的约束，而不是靠原文段落临场带跑。

---

### 2. 关键产物（写作前准备好；写作时只读）

V2 把库的产物分为 5 类（写作 Run 只消费，不做重计算）：

- **segments**：把长文拆成“可控语料单元”
- **clusters（k=2~3）**：同一库里的不同写法大类
- **anchors**：每簇 5–8 个“黄金样本”（小引用 + 回链定位）
- **cluster rules**：每簇一张“大规则卡”（must/avoid/templates/evidence/checks/queries）
- **styleContractV1**：写作时注入 Main Doc 的短硬契约（1–2 屏）

> 注：segments/clusters/anchors/rules/contract 的生成时机应为“库体检/更新体检”，而非写作 Run（保证性能与一致性）。

---

### 3. 大段原文（未切割）的处理策略

V2 面对“未切割的大段原文”，不会在写作时整段喂给模型，而是在库侧先做结构化处理：

- **切分（segments）**：
  - 优先：Markdown 标题/分隔线
  - 次优：`标题:` / `文案:` 等拼稿标记
  - 兜底：超长切分（防止单段过大造成统计/检索/抽取失真）
- **anchors**：
  - 从 segments 中挑 5–8 段作为“证据位/黄金样本”
  - 每条 anchor 只保留短 quote（建议 <=200 字）+ 回链定位（sourceDoc/段落范围/headingPath 等）
- **写作时使用**：
  - 原文段落只作为**证据位**出现（控量、可回链、可审计）
  - 模板/规则来自 cards/templates，不从原文段落直接学句子

---

### 4. 写作状态机（前置门禁，允许动作确定）

V2 把“写作闭环”显式前置成状态机（每个阶段只允许一类动作）：

```
style_need_templates   // 只能取模板/规则卡（kb.search kind=card/template）
  -> style_need_draft  // 生成候选稿（纯文本，不写入）
  -> style_need_copy   // lint.copy：不贴（确定性检测 + 可解释 overlap）
  -> style_need_style  // lint.style：像不像（风格对齐）
  -> style_can_write   // 允许 doc.* 写入（最终稿强制来自 bestDraft）
```

强约束：
- **templates 阶段禁止段落样例当写作样例**（只允许模板/规则卡）。
- **draft 阶段禁止写入**（只产候选稿）。
- **copy/style 任何一个不通过都必须回炉**（除非 safe 降级）。
- **write 阶段写入必须使用 bestDraft**（见第 7 节）。

### 4.1 通俗工作流程（用户视角）

把它当成“写作流水线”就行：先锁定写法与规则，再写草稿，再过两道检查（不贴/够像），最后才允许落盘。

- **路由**：先判定这是写作/改写/润色任务（否则不进入 style_imitate，避免风格误伤 research/ops）。
- **选写法**：锁定风格库 + 写法簇（cluster）。同库多写法先选定一个，后面才不会来回飘。
- **装载契约**：生成/加载 `styleContractV1`（短硬、1–2 屏）与该簇的 `cluster rules`（更全的规则卡）。
- **templates（只拿模板/规则）**：只允许检索/读取模板卡与规则卡（不把原文段落当“样例”喂给模型）。
- **draft（先写候选，不写入）**：产出候选稿（纯文本）。
- **copy（不贴）**：运行 `lint.copy`（或等价能力）检查“明显复用/连续重合”；不通过就按 overlap 证据回炉改写。
- **style（够像）**：运行 `lint.style` 检查“句子外形/节奏/人称/问句/口头禅/数字密度”等；不通过就按 issues+rewritePrompt 回炉。
- **write（才允许写入）**：通过（或 safe 降级）后才允许 `doc.*` 写入，并且写入必须使用 bestDraft（避免最后一版更差反而落盘）。

### 4.2 “各种意义上的像原作者”分别靠什么

- **像句子/语气/节奏（surface style）**：`lint.style` 的统计对齐 + 模板卡（句式、短句/长句、问句密度、人称密度、语气词、数字密度等）。
- **像结构套路（段落推进方式）**：templates/cluster rules 里的“段落模板/转折模板/收束模板”。
- **像怎么分析与归因（分析角度）**：`analysisLenses[]`（默认战场/因果框架/关键问题清单/段落模板）。
- **像价值取向与责任归属（价值观）**：`values.*`（principles/priorities/moralAccounting/tabooFrames/epistemicNorms/templates）。
- **像但不贴（避免逐句同款）**：templates 阶段不喂长段原文 + copy 阶段的确定性检测（重合片段可解释）。
- **最终稿不乱飘**：bestDraft 选择与“写入强制 bestDraft”（safe 降级时也遵守）。

### 4.3 你最常用的 3 个“旋钮”（其余尽量自动）

- **选写法簇（cluster）**：决定“像”的大方向（写法A/B/C）。
- **选 Values 的 scope（作者/叙述者/角色）**：尤其对小说很关键（同一本书可能多角色多立场）。
- **选 Analysis Lens 的优先级**：决定“用哪个战场解释问题”（也决定段落骨架与问题清单）。

### 4.4 状态机的工作顺序（系统视角）

目标不是“先写一坨→靠 lint 救回来”，而是把顺序改成：**先把写法约束装好、把结构模板选好，再开始写**。因此每一阶段只允许做“该阶段该做的事”：

- **route（路由）**：判定是否写作任务。  
  - 通过：进入 style_imitate 闭环  
  - 否则：走 research/ops，不启用风格闭环

- **style_need_templates（先拿写法）**：只允许拿“模板/规则/契约”，禁止写正文。  
  - 输入：风格库 + clusterId（或默认簇）  
  - 输出：`styleContractV1` + `cluster rules` + 本轮会用到的 templates（开头/转折/收束等）  
  - 禁止：把原文段落当样例、直接产正文、写入 doc.*

- **style_need_draft（按模板写草稿）**：允许产候选稿，但仍禁止写入。  
  - 输入：上一步的 contract/rules/templates + 用户主题/素材  
  - 输出：候选稿（纯文本），并记录“用了哪些模板/规则”（用于审计/回归）  
  - 禁止：写入 doc.*（避免“先落盘再回炉”）

- **style_need_copy（先查不贴）**：先把“明显贴原文”这条风险路径堵掉。  
  - 输入：候选稿 + sources（选区/原文 + anchors/少量证据）  
  - 输出：copy 风险与 overlap 证据；不通过则回到 draft 回炉

- **style_need_style（再查够像）**：最后做风格验收（语言外形层）。  
  - 输入：候选稿 + 风格库指纹/样例/模板规则  
  - 输出：style 分数+issues+rewritePrompt；不通过则回到 draft 回炉

- **style_can_write（才允许写入）**：允许 doc.* 写入。  
  - 强约束：写入必须使用 bestDraft（避免“最后一版更差反而落盘”）

### 4.5 怎样“从开头就改好”，而不是依靠 lint 才纠偏

核心做法是把“像”前移到 **写之前**，让 draft 阶段就按模板与规则把形状写对；lint 只做“验收/兜底”，而不是“方向盘”。

具体策略（从开头就收敛）：

- **先定结构，不先写句子**
  - 在 draft 阶段先产一个“骨架计划”（可很短）：用哪个 `analysisLens`、Values 的 `scope` 是谁、开头/中段/结尾各用哪个模板、每段的功能是什么（钩子/立论/推演/反证/收束）。

- **逐段选模板、填槽位（模板驱动写作）**
  - 每段正文都对应一个模板（例如“开头：钩子→结论→战场坐标”“中段：机制→效应→对策”“收束：落点→代价→行动指令”）。
  - 写作时不是自由发挥，而是“按模板把槽位填满”：槽位填的是内容，不是抄句子。

- **把 Values / Lens 当作“每段的检查清单”**
  - Values 主要约束：责任归属怎么落、冲突怎么权衡、哪些叙事框架不走、证据口径偏好。
  - Lens 主要约束：本段回答哪些关键问题、因果链怎么走、默认战场是什么。
  - 这样“像”的认知外形会从第一段就开始体现，而不是最后靠润色补救。

- **在写作过程中做“轻量即时体检”（不依赖 lint.style）**
  - 这里说的体检可以是确定性的：例如统计问句率/短句率/人称密度是否明显跑偏；或者检查 must/avoid token 是否完全缺失。
  - 即时体检的目的：在写完全文前就发现“形状跑偏”，立刻在 draft 阶段修正。

- **lint 的定位：验收与兜底**
  - 当上面这些前置约束做得好时，`lint.style` 理想状态是一轮就过；过不了也只是“微调”，不是“方向大翻修”。

---

### 5. 两个新增维度：价值观与分析角度（认知外形）

你提的两个维度建议纳入 V2，但有两个原则：

1) **必须可追溯到 anchors/segments 的证据**（避免“凭空编价值观/角度”）。
2) **要以“可执行约束”的形式进入 contract/rules**（而不是长篇描述）。

#### 5.1 维度一：原作者价值观（Values）

目标：让稿件在“站队/判断标准/道德秩序/偏好解法”上更像原作者。

建议结构（写入 `cluster rules` 与 `styleContractV1`）：把“价值观”拆成 6 块，避免只剩几句口号：
- **values.principles[]**：3–6 条“原则句”（每条必须附 evidence 引用）。例如“优先机制解释而不是道德谴责”“先谈代价再谈愿景”等。
- **values.priorities[]**：2–5 条“冲突排序/权衡规则”（当 A 与 B 冲突时作者通常选谁）。例如“效率 vs 公平”“短期情绪 vs 长期能力”之类的固定排序。
- **values.moralAccounting[]**：作者常用的“责任归属/称赞与批评对象”模式（谁该背锅、谁是受害者、谁在套利），每条附 evidence。
- **values.tabooFrames[] / values.avoid[]**：作者明显反感/回避的表达框架（不是词汇黑名单，而是“叙事框架禁区”），每条附 evidence。
- **values.epistemicNorms[]**：作者的“证据观/认识论习惯”（什么算证据、对口径/统计/激励的偏好、对情绪化叙事的警惕），每条附 evidence。
- **values.templates[]**：价值判断常用句式模板（槽位化，用于生成时复用；可引用 anchors 的短句作证据）。

检查项（尽量可执行且不过度黑箱）：
- **values.checks[]**：可机检的弱检查（例如 mustContainAny/avoidAny/ratioRange），定位为“提示/审计”，不建议直接卡死写入。

> 备注：FacetPack 里本来就有 `values_embedding` 维度；V2 做法是把它“扶正成可验证的 contract 字段”，并与 anchors 绑定证据。

**跨体裁落地（不止口播/观点文）**：Values 不是“观点类文章专用”，它更像一套“立场与道德/责任框架”。要覆盖小说/朋友圈等场景，需要补两个概念：
- **values.scope（作用域）**：把“价值观”分清是 **作者/叙述者的世界观**，还是 **角色的偏见/立场**。小说里经常是“角色价值观很多、作者价值观不明说”，因此必须支持 `scope="character"` 的多套 values（按角色或阵营）。
- **values.expression（表达方式）**：不同体裁的 Values 不一定以“论点句”出现，更多以“谁被称赞/谁被惩罚/冲突如何收束/叙事禁区”体现（对应 moralAccounting/tabooFrames/priorities）。

落地建议（按体裁）：
- **小说**：优先用 `moralAccounting/tabooFrames/priorities/templates`（通过情节惩奖与叙事禁区体现价值观）；并允许按角色建 `valuesProfiles[]`（每个角色/阵营一套）。
- **朋友圈/短文**：优先用 `principles/priorities/moralAccounting`（自我定位、态度、指责对象与收束方式），模板更短更口语。
- **口播/观点文**：`principles + epistemicNorms + priorities` 占比更高（解释框架 + 证据观 + 权衡顺序），再用 templates 固化句式。

#### 5.2 维度二：分析事件的角度（Analysis Lens）

目标：让作者“默认把事件放进哪个战场/用什么因果框架/从谁的激励结构解释”成为可复用规则。

建议结构：
- `analysisLenses[]`：2–4 个常用视角（按优先级排序），每个 lens 包含：
  - `label`：例如“机制论/激励结构/风险定价/叙事战/供需空白→补位”
  - `whenToUse`：触发条件（主题/事件类型）
  - `questions[]`：作者常问的“关键问题清单”（用于结构驱动）
  - `templates[]`：常用段落模板（开头钩子/转折/归因/落点）
  - `evidence[]`：来自 anchors 的证据句（可回链）
  - `checks[]`：提示型检查（例如是否覆盖“机制→效应→对策”的骨架）

> 这维度不建议直接等同于“topic”；它更像“解释框架/归因风格/战场选择”，能显著提升“像”的一致性。

---

### 6. lint 的角色（从“后验修补”变成“阶段闸门”）

- **lint.copy（不贴）**：
  - 输入：候选稿 + sources（用户原文/选区 + anchors/少量证据样本）
  - 输出：riskLevel + overlap spans（可解释：哪段复用了哪段）
  - 语义：优先保证“不贴”；必要时可 safe 降级但必须记录审计原因

- **lint.style（像不像）**：
  - 输入：候选稿 + 风格库的统计指纹/样例（模板/规则为主）
  - 输出：score + issues + rewritePrompt
  - 语义：衡量 surface style；不承担 anti-copy 职责

---

### 7. bestDraft 选择（多目标最优）

V2 的 bestDraft 不应只看 style 分数。最低要求是多目标：
- **styleScore 越高越好**
- **copyRisk 越低越好**

推荐实现为“可解释的排序规则”（先不做黑箱加权）：
1) 过滤掉 copyRisk=high（除非已 safe 降级并明确记录）
2) 在剩余候选中按 styleScore 取最大
3) 若 styleScore 接近（例如差 < 3 分），优先 copyRisk 更低者

写入强约束：
- 进入 write 阶段时，**写入内容必须来自 bestDraft**（避免“最后一版更差但被写入”）。

---

### 8. 验收指标（“像”与“可控”的可回归）

建议每次 run 记录并可审计：
- selectedClusterId / selectedFacetIds
- templates 命中情况（用到了哪些模板卡/规则卡）
- lint.copy：riskLevel、top overlap spans（至少 3 条）
- lint.style：score/highIssues/failCount/是否降级
- 最终写入：是否强制 bestDraft、bestDraft 的 (styleScore, copyRisk)

最低回归用例：
- 同一库同一写法下，连续跑 10 次：styleScore 方差下降、copyRisk 高风险显著下降。
- 构造“明显贴原文”的候选：必须被 lint.copy 识别并阻止进入 write（或给出降级审计）。

---

### 9. 回滚与渐进落地（避免一次性推倒重来）

推荐分阶段落地（每阶段可独立上线/回滚）：
- **P0**：只落“状态机前置 + bestDraft 强制写入”（不改 KB 抽法）
- **P1**：引入 anchors（证据位控量）+ lint.copy（先 hint/observe）
- **P2**：模板/规则卡（sentence/paragraph templates 或 rules.templates）成为 templates 阶段主输入
- **P3**：values + analysisLens 两个维度进入 cluster rules/styleContract，并与 anchors 绑定证据

---

### 10. 可选项（后续迭代；不影响闭环正确性）

以下属于“体验/可观测性/可调参”增强，先不挡本轮收尾：

- **Runs/Logs 展示增强**：把 `topArtifacts / topOverlaps / bestDraft` 做成更易读的 UI（折叠、复制、定位到对应 Tool Block）。
- **可配置化**：bestDraft 的排序阈值（例如 styleScore 近似阈值=3、过滤 high 的策略）做成 env 或后台配置。
- **可视化复盘**：提供“一键导出本次 run 的审计摘要”（JSON/Markdown）便于分享与回归。
- **对齐建议更可操作**：在 copy 未通过时，UI 直接把 `topOverlaps.snippet` 高亮展示，提示优先改哪些句式/结构而不是同义词替换。

