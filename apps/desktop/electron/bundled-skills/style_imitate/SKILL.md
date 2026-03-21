---
id: style_imitate
name: style_imitate
display-name: "风格仿写"
description: "绑定风格库后，@风格库+写作任务时自动唤起，或 /风格仿写 显式唤起：Agent 自驱动闭环（风格检索 → 定调骨架 → 写作 → lint.copy → lint.style → 终稿落盘）。"
version: "3.1.0"
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
    - "style_imitate.run"
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
        - "style_imitate.run"
        - "lint.copy"
        - "edit"
        - "write"
      hint: "Spec 4.4：草稿已完成，优先调用 style_imitate.run（传 task + draft）让 runtime 接管 kb.search/lint.copy/lint.style。若返回 copy 风险问题，再用 edit/write 改稿后重跑。"
    - id: need_style_lint
      gate:
        allTrue:
          - hasDraftText
          - copyLintSatisfied
        allFalse:
          - styleLintSatisfied
      tools:
        - "style_imitate.run"
        - "lint.style"
        - "edit"
        - "write"
      hint: "Spec 4.5：copy lint 已满足，优先调用 style_imitate.run（传 task + draft）让 runtime 接管 style lint。若返回风格问题，再用 edit/write 改稿后重跑。"
    - id: need_final_write
      gate:
        allTrue:
          - hasDraftText
          - copyLintSatisfied
          - styleLintSatisfied
        allFalse:
          - finalWritten
      tools:
        - "write"
        - "edit"
        - "run.mainDoc.update"
      hint: "Spec 4.6：lint 已满足，但终稿还没落盘。现在只做最终 write/edit，随后 run.done 收口。"
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

## Runtime Contract

- 本 skill 的执行真相以 `workflow` 阶段声明 + Gateway runtime 为准。
- `SKILL.md` 只负责：激活条件、等待用户、阶段顺序、lint 必跑、终稿门禁、follow-up 文案。
- `styleWorkflowConfig` / `styleWorkflowTypes` 负责：step 顺序、budget、artifact/ref 口径、draft 覆盖范围。
- 当需要用户回答问题时，输出一个最小必要问题后立即 `run.done`，不要在同一轮反复追问。
- 当已有候选稿时，优先调用 `style_imitate.run(task, draft, outputPath?)`，让 runtime 接管 `kb.search → lint.copy → lint.style → 可选 write`。
- `lint.copy` 与 `lint.style` 都必须跑；任一未满足时，不得把结果视为完成。
- `finalWritten=true` 前，不得把风格仿写标记为 `completed`。
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
