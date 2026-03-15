---
name: docx
display-name: "Word 文档生成"
description: "创建、读取、编辑 .docx 文件。触发词：Word、docx、文档、报告、备忘录、信函、模板"
version: "1.0.0"
priority: 50
auto-enable: true
builtin: true
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.docx|word文档|word\\s*doc|生成.*文档|创建.*文档|写.*报告|备忘录|信函|文档模板|导出.*word)"
ui:
  badge: "DOCX"
  color: "blue"
---

# DOCX creation, editing, and analysis

## Overview

Use this skill whenever the user wants to创建、读取、编辑或导出 Word 文档（`.docx`）。典型触发场景：

- 明确提到「Word 文档」「word doc」「.docx」
- 要求生成「报告、备忘录、信函、合同、方案、模版」等正式文档
- 需要在 Word 中处理复杂排版：目录、页眉页脚、页码、标题层级、表格、图片等

`.docx` 本质上是一个 ZIP 容器，内部包含一系列 XML 文件。生成或修改文档时，要保证输出文件结构合法、可被 Word / WPS / Google Docs 正常打开。

## Quick reference

- 生成新文档：优先使用专门的 `.docx` 库（如 `docx` for Node.js），按「文档结构 → 内容 → 样式」三步构建
- 读取内容：必要时可以借助辅助脚本/工具（如 `pandoc` 或自带的解包脚本）提取纯文本或段落结构，再在对话里分析
- 验证文档：复杂场景建议调用校验脚本（如 `validate.py`），发现结构错误时要先修复再交付

## Authoring guidelines

在为用户生成 Word 文档时，请遵守以下原则：

1. **结构优先**：先想清楚文档的大纲（章节、标题层级），再填充段落内容
2. **语气匹配**：根据用户要求选择正式 / 半正式 / 口语化文风，不要混用
3. **模板友好**：尽量使用标准段落与样式，而不是依赖手工空格、回车或特殊符号撑布局
4. **可编辑性**：不要把整页内容塞进一个段落；列表用真正的列表，标题用真正的标题

## Typical uses

- 写一份正式的项目汇报 / 复盘 / 年度总结，并以 `.docx` 形式交付
- 将用户给出的提纲或要点，整理成排版合理的 Word 文档
- 对现有 Word 文档做结构重组、内容润色或版式调整

