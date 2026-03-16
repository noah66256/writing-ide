---
id: style_imitate_v2
name: 风格仿写闭环
description: "绑定风格库后，在写作/改写/润色意图下自动启用：检索样例 → 草稿 → lint.copy → lint.style → 终稿。"
version: "2.0.0"
priority: 110
stageKey: agent.skill.style_imitate_v2
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
  allowTools: ["kb.search", "write", "edit", "lint.copy", "lint.style"]

policies: ["StyleGatePolicy", "AutoRetryPolicy"]

ui:
  badge: STYLE
  color: blue

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
      tools: [kb.search]
      hint: "style_imitate 编排阶段：当前先做风格样例检索。只调用 kb.search，限定在 purpose=style 的风格库中检索写法模板/规则卡。不要先写草稿，不要先跑 lint。"

    - id: need_draft
      gate: { allTrue: [hasStyleKbSearch], allFalse: [hasDraftText] }
      tools: [write]
      hint: "style_imitate 编排阶段：风格样例已具备，现在先产出候选草稿。只调用 write 生成候选稿（draft），不要直接宣称终稿完成。草稿应服务于后续 lint.copy / lint.style，不要跳过审计。"

    - id: need_copy_lint
      gate: { allTrue: [hasStyleKbSearch, hasDraftText], allFalse: [copyLintPassed] }
      tools: [lint.copy, edit, write]
      hint: "style_imitate 编排阶段：已有草稿，现在先做复述风险检查。优先调用 lint.copy，对候选稿做复述/重合风险审计。若不通过，使用 edit/write 根据 lint.copy 的 rewritePrompt 改稿后复检。"

    - id: need_style_lint
      gate: { allTrue: [hasStyleKbSearch, hasDraftText, copyLintPassed], allFalse: [styleLintPassed, lintGateDegraded] }
      tools: [lint.style, edit, write]
      hint: "style_imitate 编排阶段：copy lint 已通过，现在做风格校验。优先调用 lint.style，确认结构/节奏/语气已贴合目标风格。未通过时按 issues/rewritePrompt 改稿后复检。"

    - id: completed
      gate: { allTrue: [hasStyleKbSearch, hasDraftText, copyLintPassed], anyTrue: [styleLintPassed, lintGateDegraded] }
      tools: [write, edit]
      hint: "style_imitate 编排阶段：闭环已完成，可以进入交付。允许调用 write/edit 落盘终稿，并最终 run.done。"

  exclusions:
    - [kb.search, write]
    - [kb.search, lint.copy]
    - [kb.search, lint.style]
    - [lint.copy, lint.style]
    - [lint.copy, write]

  followUp:
    message: "style_imitate 风格仿写尚未完成闭环，请按 kb.search → 草稿 → lint.copy → lint.style → write 顺序补齐当前阶段。"
---

当 skill=style_imitate_v2 激活时：

**workflow 阶段由系统自动管控工具白名单，你只需按当前阶段的 hint 指引操作即可。**

0) 若 Context Pack 提供 KB_STYLE_CLUSTERS(JSON)（写法候选/子簇）或 STYLE_SELECTOR(JSON)：默认按推荐/已选写法继续写作；用户可随时改口切换。不要在正文前或单独消息里输出"已选用写法X/备选写法Y"这类说明，除非用户明确要求比较写法。
1) 若 Main Doc 尚未写入 styleContractV1（或用户改口要求切写法），再调用 run.mainDoc.update 写入/更新 mainDoc.styleContractV1（短 JSON：{v,libraryId,selectedCluster{id,label},anchors,evidence,softRanges,facetPlan,updatedAt}）。若 Main Doc 已有且用户未要求变更，则不要重复写入。
2) 若提供 STYLE_DIMENSIONS(JSON)：
- mustApply.facetIds 为 MUST，必须覆盖（每个至少落地一次），不要自行扩展到全部维度；
- shouldApply.softRanges 为 SHOULD，尽量贴近统计指纹（句长/问句率/人称密度等）；
- mayApply.cardTypesHint 仅用于检索素材（可选）。
3) 若提供 STYLE_SELECTOR(JSON)：必须把 selectedFacetIds/selectedFacets 当作本次要执行的"维度卡子集"（只执行这些卡，不要自行扩展到全部维度）。若同时提供 STYLE_DIMENSIONS(JSON)，以 mustApply.facetIds 为准；若同时提供 STYLE_FACETS_SELECTED(Markdown)，优先按其卡片内容执行；并对每张入选 facet 结合 kbQueries（或 facetId+话题）用 kb.search 拉样例/证据再落笔。
4) 单篇写作建议走"两段式检索"：
- 第一段（写前）：kb.search 拉规则卡/结构骨架/开头钩子/结尾收束（kind=card + 显式 cardTypes）。
- 第二段（初稿后）：再 kb.search 拉金句/收束模板（one_liner/ending），把 punchline 与收尾补齐后再进入 lint。
5) 写作时必须先 kb.search（只搜风格库）拉样例/模板：优先 kind=card（hook/one_liner/outline/thesis/ending 等），不要一上来就用 kind=paragraph 大范围捞原文段落当样例。
6) 反贴原文要求（必须遵守）：
- 不要复制原文的句子/段落；任何明显的逐句改写/近似复述都视为失败。
- 在"不新增事实"的前提下，必须做结构与表达的再创作：重排段落、改句式、换衔接、换比喻/类比、把数字堆砌改成叙事化解释。
- 如需引用原文中的专有名词/关键结论：只保留"必要短语"，不要出现长串连续复用。
7) lint.style 用于"提示/审计/问题清单"：未通过时必须按 rewritePrompt 回炉改写并复检；不要把分数当成唯一门禁导致卡死。
8) 检索/重试/超时/降级等执行状态不要用自然语言逐条播报给用户；例如不要输出'同步启动资料搜索和风格检索'、'kb.search超时'、'改用较轻查询重试'、'跳过检索直接写稿'。这些状态由系统进度 UI 展示；除非需要用户决策，否则直接继续执行并给最终结果。
