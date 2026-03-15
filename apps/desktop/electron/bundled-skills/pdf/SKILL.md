---
name: pdf
display-name: "PDF 处理与导出"
description: "处理 PDF 阅读、信息抽取、扫描件/OCR 判断与 PDF 导出。触发词：PDF、.pdf、扫描件、导出 PDF、合并 PDF、拆分 PDF。"
version: "1.0.0"
priority: 55
auto-enable: true
builtin: true
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.pdf|pdf|扫描件|扫描版|ocr|导出\\s*pdf|生成\\s*pdf|合并\\s*pdf|拆分\\s*pdf|表单\\s*pdf|水印\\s*pdf)"
tool-caps:
  allow-tools:
    - "write"
    - "code.exec"
    - "web.fetch"
    - "project.listFiles"
ui:
  badge: "PDF"
  color: "red"
---

# PDF handling and export

当用户明确要处理 PDF 或交付 `.pdf` 文件时，使用本技能，并遵循以下原则：

1. 先判断任务类型：读取/抽取/总结、生成/导出、合并/拆分/表单/水印等结构化处理。
2. 不夸大能力：如果当前没有 PDF / OCR 专用工具，要说明限制，不编造「看到了」扫描件里的内容。
3. 交付型任务优先走两段式：
   - 先用 `write` 生成 Markdown 母版，便于审阅与回滚；
   - 再用 `code.exec` 生成最终 `.pdf` 文件，并给出稳定、清晰的输出路径。
4. 对研究报告 / 汇总材料类需求，先把内容写好，再导出 PDF，不要频繁重建。
5. 当用户真实需求是 Word / PPT / Excel，而不是 PDF 时，不要强行走 PDF 链路，应交给对应 Office 技能。

