---
id: style_imitate
name: style_imitate
display-name: "风格仿写"
description: "绑定风格库后，@风格库+写作任务时自动唤起，或 /风格仿写 显式唤起：Agent 自驱动闭环（风格检索 → 定调骨架 → 写作 → lint.copy → lint.style → 终稿落盘）。"
version: "3.0.0"
priority: 120
stage-key: agent.skill.style_imitate
kind: workflow
activation-mode: hybrid
auto-enable: true
builtin: true
triggers:
  - when: has_style_library
    args:
      purpose: style
tool-caps:
  allow-tools:
    - "kb.search"
    - "kb.listLibraries"
    - "write"
    - "edit"
    - "lint.copy"
    - "lint.style"
prompt-fragments:
  context: "ACTIVE_SKILLS: style_imitate（原因见 reasonCodes；UI 需可见）"
policies:
  - "StyleGatePolicy"
workflow:
  state-keys:
    - hasSelectedStyleLibrary
    - topicConfirmed
    - hasStyleKbSearch
    - hasStylePlan
    - hasDraftText
    - copyLintSatisfied
    - styleLintSatisfied
    - finalWritten
  phases:
    - id: need_style_library
      gate:
        allFalse:
          - hasSelectedStyleLibrary
      tools:
        - "kb.listLibraries"
      hint: "Spec 4.0A：当前先确认唯一风格库。若只有一个 style 库可直接使用；若有多个，先列库并等待用户确认，不要默认取第一个。"
    - id: need_topic
      gate:
        allTrue:
          - hasSelectedStyleLibrary
        allFalse:
          - topicConfirmed
      tools:
        - "run.done"
      hint: "Spec 4.0B：当前缺少写作主题或关键题面。先向用户提一个最小必要问题，然后 run.done 等待回复。"
    - id: need_style_kb
      gate:
        allTrue:
          - hasSelectedStyleLibrary
          - topicConfirmed
        allFalse:
          - hasStyleKbSearch
      tools:
        - "kb.search"
      hint: "Spec 4.1：当前先做风格规则卡检索。只查已选 style 库，优先 hook/outline/ending 等 card，不要直接捞 paragraph。"
    - id: need_tone_outline
      gate:
        allTrue:
          - hasSelectedStyleLibrary
          - topicConfirmed
          - hasStyleKbSearch
        allFalse:
          - hasStylePlan
      tools:
        - "write"
      hint: "Spec 4.2：检索后先完成定调与骨架，再进入正文写作。toneCard 和 structureOutline 必须在 runtime state 中可见。"
    - id: need_draft
      gate:
        allTrue:
          - hasSelectedStyleLibrary
          - topicConfirmed
          - hasStyleKbSearch
          - hasStylePlan
        allFalse:
          - hasDraftText
      tools:
        - "write"
      hint: "Spec 4.3：风格样例与骨架已具备，产出候选草稿。文件名需反映主题，不要用无意义时间戳路径。"
    - id: need_copy_lint
      gate:
        allTrue:
          - hasDraftText
          - hasStylePlan
        allFalse:
          - copyLintSatisfied
      tools:
        - "lint.copy"
        - "edit"
        - "write"
      hint: "Spec 4.4：草稿已完成，必须先过 lint.copy。未通过就 edit/write 改稿后复检，最多 3 次。"
    - id: need_style_lint
      gate:
        allTrue:
          - hasDraftText
          - copyLintSatisfied
        allFalse:
          - styleLintSatisfied
      tools:
        - "lint.style"
        - "edit"
        - "write"
      hint: "Spec 4.5：copy lint 已满足，必须做 lint.style。重点对齐结构、节奏、价值落点，不要只加口头禅。"
    - id: completed
      gate:
        allTrue:
          - hasSelectedStyleLibrary
          - topicConfirmed
          - hasStyleKbSearch
          - hasStylePlan
          - hasDraftText
          - copyLintSatisfied
          - styleLintSatisfied
          - finalWritten
      tools:
        - "write"
        - "edit"
        - "run.mainDoc.update"
      hint: "闭环完成，落盘终稿。"
  exclusions:
    - ["kb.search", "write"]
    - ["kb.search", "lint.copy"]
    - ["kb.search", "lint.style"]
    - ["lint.copy", "lint.style"]
  follow-up:
    message: "风格仿写尚未完成闭环，请按 选库 → 题面确认 → kb.search → 定调骨架 → 草稿 → lint.copy → lint.style → write 顺序补齐。"
ui:
  badge: "STYLE"
  color: "purple"
---

当 skill=style_imitate 激活时：

**严格按以下阶段顺序执行。不得跳过 lint.copy 和 lint.style。**

**强制规则：Phase 0A/0B 必须先完成选库和题面确认，再进入检索。**

**当需要用户回答问题时**（确认主题、选择风格库等）：输出问题后立即调用 `run.done` 结束当前轮次，等待用户回复。**不要在同一轮中反复询问。**

---

## Phase 0A: 选库

**目的**：确定唯一风格库。

1. 如果只有 1 个 style 库，直接使用
2. 如果有多个：
   - 先看用户消息里有没有明确库名
   - 无法唯一确定时，先问用户选哪个库，然后 `run.done`
3. **不要默认使用系统自动注入的第一个库**

---

## Phase 0B: 题面确认

**目的**：确认主题与最低写作约束。

1. 如果用户只说了“@风格仿写”或只给了库名，没有主题：
   - 先问主题，然后 `run.done`
2. 如果主题已给出但体裁/篇幅缺得太厉害，导致无法开写：
   - 只追问一个最小必要问题，然后 `run.done`

---

## Phase 1: 风格样例检索

**目的**：从风格库中获取写法规则卡和样例，建立风格基准。

**执行步骤**：

1. 如果 Context Pack 已提供 STYLE_FACETS_SELECTED(Markdown)：
   - 已有规则卡全文，可直接按规则卡开写
   - `kb.search` 仅用于补充当前话题下的结构骨架、开头钩子、结尾收束
2. 调用 `kb.search`：
   - 限定 `purpose=style` 的风格库
   - 优先 `kind=card`（hook / one_liner / outline / thesis / ending 等规则卡）
   - 不要一上来就用 `kind=paragraph` 大范围捞原文段落
   - query 同时包含：风格标识 + 结构词 + 当前题面
4. 如果 Context Pack 提供了 STYLE_DIMENSIONS(JSON)：
   - `mustApply.facetIds` 为 MUST，每个 facet 的核心写法都要在正文中至少体现一次
   - `shouldApply.softRanges` 为 SHOULD，尽量贴近统计指纹
   - `mayApply.cardTypesHint` 仅用于检索素材
5. 如果提供了 STYLE_SELECTOR(JSON)：
   - `selectedFacetIds` / `selectedFacets` 是本次执行的维度卡子集
   - 若提供 `searchPlan`，优先按 `searchPlan` 检索

**退出条件**：至少获得 3 条风格样例或规则卡，并覆盖 hook / outline / ending 中至少 2 类。然后进入 Phase 2。

---

## Phase 2: 定调与骨架（可写入 runtime state，不需输出给用户）

**目的**：基于风格样例确定基调和文章结构。写作前的内部思考，不需要调用工具。

1. 提炼目标风格的核心特征：
   - 人设 / 视角（第几人称、什么立场）
   - 语气节奏（短句频率、问句密度、口头禅使用规律）
   - 论证路径（先破后立？数据说话？故事引入？算账链条？）
2. 根据用户主题规划文章骨架：
   - 开头钩子类型（反常识 / 提问 / 场景描写 / 数据冲击）
   - 主体段落推进逻辑（论点顺序、转折点、视角切换）
   - 收束方式（金句 / 行动号召 / 余韵 / 回扣开头）

**退出条件**：`toneCard + structureOutline` 已形成。进入 Phase 3。

---

## Phase 3: 写作

**目的**：一次性产出完整草稿。

1. 调用 `write` 工具，写入完整草稿
2. **文件名必须反映用户主题**（如 `output/金价上涨_口播稿.md`），不要用系统生成的无意义路径
3. 写作时贯彻 Phase 1 的定调和骨架
4. 反贴原文规则（必须遵守）：
   - 不要复制原文的句子或段落；任何明显的逐句改写或近似复述都视为失败
   - 必须做结构与表达的再创作：重排段落、改句式、换衔接、换比喻 / 类比
   - 只保留“必要短语”，不要出现长串连续复用
5. 不要只模仿表层标记（问号、破折号、短句、口头禅）；必须复刻段落推进、转折、视角、论证路径与声音节奏

**退出条件**：完整草稿已写入文件。进入 Phase 3。**不要跳过 Phase 3-4 直接交付。**

---

## Phase 4: lint.copy 复述风险检查

**目的**：确保草稿没有复述原文的风险。

1. 调用 `lint.copy`，传入草稿文本
2. 如果通过（`passed=true`）：直接进入 Phase 4
3. 如果未通过（`passed=false`）：
   - 阅读 `issues` 和 `rewritePrompt`
   - 用 `edit` 工具根据建议改稿（按段落或句子 patch，不要整篇重写）
   - 再次调用 `lint.copy` 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 4
4. **不要跳过 `lint.copy` 直接去跑 `lint.style`**

**退出条件**：`lint.copy` 通过，或 3 次重试用尽。

---

## Phase 5: lint.style 风格校验

**目的**：确保草稿在结构、节奏、语气上贴合目标风格。

1. 调用 `lint.style`，传入草稿文本
2. 如果通过（`passed=true` 或 `score >= 70`）：直接进入 Phase 5
3. 如果未通过：
   - 阅读 `issues` 和 `rewritePrompt`
   - 用 `edit` 工具按维度修改（结构调整、节奏优化、语气校正）
   - 再次调用 `lint.style` 复检
   - **最多重试 3 次**
   - 3 次后仍未通过：记录降级，继续进入 Phase 5
4. `lint.style` 用于“提示 / 审计”，不要把分数当唯一门禁导致卡死

**退出条件**：`lint.style` 通过，或 3 次重试用尽。

---

## Phase 6: 终稿落盘

1. 如果 Phase 4-5 中有改稿，用 `write` 更新终稿文件
2. 最终落盘优先使用 best draft，不要把更差的最后一版覆盖进去
2. 完成后调用 `run.done`

---

## 执行纪律

- 检索、重试、超时、降级等执行状态**不要**用自然语言逐条播报给用户
- 不要输出“同步启动资料搜索”、“kb.search 超时”、“改用较轻查询重试”之类的状态文本
- 直接继续执行并给最终结果
- 如果 KB_STYLE_CLUSTERS(JSON) 提供了写法候选或子簇：默认按推荐或已选写法继续写作；不要单独输出“已选用写法 X”的说明
- 如果 Main Doc 已有 `styleContractV1` 且用户未要求变更，不要重复写入
