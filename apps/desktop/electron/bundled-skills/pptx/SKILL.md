---
name: pptx
display-name: "PPT 演示文稿"
description: "创建、读取、编辑 .pptx 演示文稿。触发词：PPT、slides、演示文稿、幻灯片、deck"
version: "1.0.0"
priority: 50
auto-enable: true
builtin: true
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.pptx|ppt|演示文稿|幻灯片|slides|slide\\s*deck|pitch\\s*deck|做.*PPT|创建.*演示)"
ui:
  badge: "PPTX"
  color: "orange"
---

# PPTX presentation skill

## When to use

在以下情况下启用 PPTX 技能：

- 用户要做「PPT、slides、deck、演示文稿、路演 / pitch deck」
- 需要从现有 `.pptx` 中读取内容、提炼大纲、总结要点
- 需要基于模版或参考稿重排 / 重写一份新的演示文稿

## Workflow hints

- 对**从零开始**的场景，优先先在对话中确定结构（章节、页数、每页信息密度），再落到每页文案
- 对**模版/现有 PPT**，先阅读并总结风格与版式，再按风格要求补充或替换内容
- 对需要代码/脚本配合的复杂制图或批量操作，可以结合项目里的 `editing.md`、`pptxgenjs.md` 中的脚本约定

## Design principles

- 减少「白底+黑字+三行 bullet」的机械风格，多用版式变化承载信息层级
- 一个 deck 内色板、字体、元素风格要统一，不要每页换一套体感
- 标题负责一句话说清结论，正文只放支撑这个结论的最关键信息

