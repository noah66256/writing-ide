---
id: style_imitate_v3
name: 风格仿写管线
description: "绑定风格库后，在写作/改写/润色意图下手动启用：Agent 自驱动闭环（风格检索 → 定调骨架 → 写作 → lint.copy → lint.style → 终稿落盘）。"
version: "3.0.0"
priority: 120
stageKey: agent.skill.style_imitate_v3
kind: workflow
activationMode: hybrid
autoEnable: false

triggers:
  - when: mode_in
    args: { modes: ["agent"] }
  - when: has_style_library
    args: { purpose: style }
  - when: run_intent_in
    args: { intents: ["writing", "rewrite", "polish"] }

conflicts: ["style_imitate"]

toolCaps:
  allowTools: ["kb.search", "kb.listLibraries", "write", "edit", "lint.copy", "lint.style"]

policies: ["StyleGatePolicy"]

ui:
  badge: STYLE-V3
  color: purple

workflow:
  stateKeys:
    - hasStyleKbSearch
    - hasDraftText
    - copyLintPassed
    - styleLintPassed
    - lintGateDegraded

  phases:
    - id: need_style_kb
      gate: { allFalse: [hasStyleKbSearch] }
      tools: [kb.search, kb.listLibraries]
      hint: "当前先做风格样例检索。调用 kb.search 检索写法模板/规则卡。"

    - id: need_draft
      gate: { allTrue: [hasStyleKbSearch], allFalse: [hasDraftText] }
      tools: [write]
      hint: "风格样例已具备，产出候选草稿。"

    - id: need_copy_lint
      gate: { allTrue: [hasStyleKbSearch, hasDraftText], allFalse: [copyLintPassed] }
      tools: [lint.copy, edit, write]
      hint: "草稿已完成，做复述风险检查。lint.copy 不通过则改稿后复检。"

    - id: need_style_lint
      gate: { allTrue: [hasStyleKbSearch, hasDraftText, copyLintPassed], allFalse: [styleLintPassed, lintGateDegraded] }
      tools: [lint.style, edit, write]
      hint: "copy lint 已通过，做风格校验。lint.style 不通过则改稿后复检。"

    - id: completed
      gate: { allTrue: [hasStyleKbSearch, hasDraftText, copyLintPassed], anyTrue: [styleLintPassed, lintGateDegraded] }
      tools: [write, edit]
      hint: "闭环完成，落盘终稿。"

  exclusions:
    - [kb.search, write]
    - [kb.search, lint.copy]
    - [kb.search, lint.style]
    - [lint.copy, lint.style]

  followUp:
    message: "风格仿写尚未完成闭环，请按 kb.search → 草稿 → lint.copy → lint.style → write 顺序补齐。"
---

当 skill=style_imitate_v3 激活时：

**严格按以下阶段顺序执行。不得跳过 lint.copy 和 lint.style。**

**强制规则：Phase 0 必须先完成风格样例检索，再进入写作阶段。不要直接开始写稿。**

**当需要用户回答问题时**（确认主题、选择风格库等）：输出问题后立即调用 `run.done` 结束当前轮次，等待用户回复。**不要在同一轮中反复询问。**

---

## Phase 0: 风格样例检索

**目的**：从风格库中获取写法规则卡和样例，建立风格基准。

**执行步骤**：

0. **前置检查——用户消息中是否包含写作主题**：
   - 如果用户只说了"@风格仿写管线"而没有给出主题，先询问主题，然后 `run.done`，等用户回复后再继续
   - 不要在没有主题的情况下启动检索和写作
1. 如果 Context Pack 已提供 STYLE_FACETS_SELECTED(Markdown)：
   - 已有规则卡全文，可直接按规则卡开写
   - kb.search 仅用于补充当前话题下的结构骨架/开头钩子/结尾收束
2. **风格库选择**（即使 STYLE_CATALOG 已自动注入也要检查）：
   - 调用 kb.listLibraries 查看可用风格库
   - 如果只有 1 个 style 库，直接使用
   - 如果有多个：先看用户消息中是否提及库名；无法确定时询问用户选哪个库，然后 `run.done` 等待回复
   - **不要默认使用系统自动注入的第一个库而跳过确认**
3. 调用 kb.search：
   - 限定 purpose=style 的风格库
   - 优先 kind=card（hook/one_liner/outline/thesis/ending 等规则卡）
   - 不要一上来就用 kind=paragraph 大范围捞原文段落
4. 如果 Context Pack 提供了 STYLE_DIMENSIONS(JSON)：
   - mustApply.facetIds 为 MUST，每个 facet 的核心写法都要在正文中至少体现一次
   - shouldApply.softRanges 为 SHOULD，尽量贴近统计指纹
   - mayApply.cardTypesHint 仅用于检索素材
5. 如果提供了 STYLE_SELECTOR(JSON)：
   - selectedFacetIds/selectedFacets 是本次执行的维度卡子集
   - 若提供 searchPlan，优先按 searchPlan 检索

**退出条件**：至少获得 3 条风格样例/规则卡。然后进入 Phase 1。

---

## Phase 1: 定调与骨架（心中规划，不需输出给用户）

**目的**：基于风格样例确定基调和文章结构。写作前的内部思考，不需要调用工具。

1. 提炼目标风格的核心特征：
   - 人设/视角（第几人称、什么立场）
   - 语气节奏（短句频率、问句密度、口头禅使用规律）
   - 论证路径（先破后立？数据说话？故事引入？算账链条？）
2. 根据用户主题规划文章骨架：
   - 开头钩子类型（反常识/提问/场景描写/数据冲击）
   - 主体段落推进逻辑（论点顺序、转折点、视角切换）
   - 收束方式（金句/行动号召/余韵/回扣开头）

**退出条件**：心中有明确的基调和结构方案。进入 Phase 2。

---

## Phase 2: 写作

**目的**：一次性产出完整草稿。

1. 调用 write 工具，写入完整草稿
2. **文件名必须反映用户主题**（如 `output/金价上涨_口播稿.md`），不要用系统生成的无意义路径
3. 写作时贯彻 Phase 1 的定调和骨架
4. 反贴原文规则（必须遵守）：
   - 不要复制原文的句子/段落；任何明显的逐句改写/近似复述都视为失败
   - 必须做结构与表达的再创作：重排段落、改句式、换衔接、换比喻/类比
   - 只保留"必要短语"，不要出现长串连续复用
5. 不要只模仿表层标记（问号、破折号、短句、口头禅）；必须复刻段落推进、转折、视角、论证路径与声音节奏

**退出条件**：完整草稿已写入文件。进入 Phase 3。**不要跳过 Phase 3-4 直接交付。**

---

## Phase 3: lint.copy 复述风险检查

**目的**：确保草稿没有复述原文的风险。

1. 调用 lint.copy，传入草稿文本
2. 如果通过（passed=true）：直接进入 Phase 4
3. 如果未通过（passed=false）：
   - 阅读 issues 和 rewritePrompt
   - 用 edit 工具根据建议改稿（按段落/句子 patch，不要整篇重写）
   - 再次调用 lint.copy 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 4
4. **不要跳过 lint.copy 直接去跑 lint.style**

**退出条件**：lint.copy 通过，或 3 次重试用尽。

---

## Phase 4: lint.style 风格校验

**目的**：确保草稿在结构/节奏/语气上贴合目标风格。

1. 调用 lint.style，传入草稿文本
2. 如果通过（passed=true 或 score >= 70）：直接进入 Phase 5
3. 如果未通过：
   - 阅读 issues 和 rewritePrompt
   - 用 edit 工具按维度修改（结构调整、节奏优化、语气校正）
   - 再次调用 lint.style 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 5
4. lint.style 用于"提示/审计"，不要把分数当唯一门禁导致卡死

**退出条件**：lint.style 通过，或 3 次重试用尽。

---

## Phase 5: 终稿落盘

1. 如果 Phase 3-4 中有改稿，用 write 更新终稿文件
2. 完成后调用 run.done

---

## 执行纪律

- 检索/重试/超时/降级等执行状态**不要**用自然语言逐条播报给用户
- 不要输出"同步启动资料搜索"、"kb.search超时"、"改用较轻查询重试"之类的状态文本
- 直接继续执行并给最终结果
- 如果 KB_STYLE_CLUSTERS(JSON) 提供了写法候选/子簇：默认按推荐/已选写法继续写作；不要单独输出"已选用写法X"的说明
- 如果 Main Doc 已有 styleContractV1 且用户未要求变更，不要重复写入
