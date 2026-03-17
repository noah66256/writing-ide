---
id: style_imitate_v3
name: 风格仿写管线
description: "绑定风格库后，在写作/改写/润色意图下手动启用：8 步声明式管线（定调 → 骨架 → 开场 → 主体 → 语言风格 → 点睛 → 收束 → Lint）。"
version: "3.0.0"
priority: 120
stageKey: agent.skill.style_imitate_v3
kind: pipeline
activationMode: hybrid
autoEnable: false

triggers:
  - when: mode_in
    args: { modes: ["agent"] }
  - when: has_style_library
    args: { purpose: style }
  - when: run_intent_in
    args: { intents: ["writing", "rewrite", "polish"] }

conflicts: ["style_imitate", "style_imitate_v2"]

toolCaps:
  allowTools: ["write", "edit", "lint.copy", "lint.style"]

policies: ["StyleGatePolicy"]

ui:
  badge: PIPELINE
  color: purple

pipeline:
  configRef: "styleWorkflowPipelineConfigV1"
  executionMode: "pipeline_v1"
  stateKeys:
    - pipelineStepIndex
    - pipelineCompleted
    - hasToneCard
    - hasStructureOutline
    - hasOpeningDraft
    - hasBodyDraft
    - hasStyledDraft
    - hasPolishedDraft
    - hasFinalDraft
    - lintLoopCompleted
    - bestStyleScore
    - bestStyleArtifactId
    - bestCopyScore
    - bestCopyArtifactId
    - pipelineArtifacts
  steps:
    - id: tone_setting
      index: 0
      gate: { allFalse: [hasToneCard] }
      executor: llm_structured
      outputArtifact: toneCard
      hint: "第 0 步：定调。"
    - id: structure
      index: 1
      gate: { allTrue: [hasToneCard], allFalse: [hasStructureOutline] }
      executor: llm_structured
      outputArtifact: structureOutline
      hint: "第 1 步：骨架。"
    - id: opening
      index: 2
      gate: { allTrue: [hasToneCard, hasStructureOutline], allFalse: [hasOpeningDraft] }
      executor: llm_text
      outputArtifact: openingDraft
      hint: "第 2 步：开场。"
    - id: body
      index: 3
      gate: { allTrue: [hasToneCard, hasStructureOutline, hasOpeningDraft], allFalse: [hasBodyDraft] }
      executor: llm_text
      outputArtifact: bodyDraft
      hint: "第 3 步：主体。"
    - id: language_rhythm
      index: 4
      gate: { allTrue: [hasOpeningDraft, hasBodyDraft], allFalse: [hasStyledDraft] }
      executor: llm_text
      outputArtifact: styledDraft
      hint: "第 4 步：语言风格。"
    - id: polish
      index: 5
      gate: { allTrue: [hasStyledDraft], allFalse: [hasPolishedDraft] }
      executor: llm_text
      outputArtifact: polishedDraft
      hint: "第 5 步：点睛。"
    - id: closure
      index: 6
      gate: { allTrue: [hasPolishedDraft], allFalse: [hasFinalDraft] }
      executor: llm_text
      outputArtifact: finalDraft
      hint: "第 6 步：收束。"
    - id: lint_loop
      index: 7
      gate: { allTrue: [hasFinalDraft], allFalse: [lintLoopCompleted] }
      executor: lint_loop
      outputArtifact: lintReport
      hint: "第 7 步：Lint 闭环。"
  lint:
    maxCopyAttempts: 3
    maxStyleAttempts: 3
    pickBestOnExhaust: true
---

当 skill=style_imitate_v3 激活时：

本 Skill 优先走 `pipeline_v1` 执行模式，由系统按 8 步自动驱动。

- 不要自行规划步骤顺序；
- 不要跳过 lint.copy / lint.style；
- 只有在 pipeline payload 缺失或系统显式降级时，才回退为普通 Agent 模式；
- 降级时沿用 style_imitate_v2 的闭环约束：`kb.search → 草稿 → lint.copy → lint.style → write`。
