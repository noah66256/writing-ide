---
name: xlsx
display-name: "Excel 电子表格"
description: "创建、读取、编辑 .xlsx 电子表格。触发词：Excel、xlsx、表格、spreadsheet、数据表"
version: "1.0.0"
priority: 50
auto-enable: true
builtin: true
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.xlsx|excel|电子表格|spreadsheet|数据表|工作表|表格.*导出|导出.*excel|做.*表格)"
ui:
  badge: "XLSX"
  color: "green"
---

# Excel spreadsheet skill

## When to use

在以下场景优先启用本技能：

- 用户明确提到「Excel、xlsx、电子表格、spreadsheet、数据表」
- 需要创建新的分析表 / 报表 / 财务模型
- 需要对现有 Excel 文件做结构调整、公式修复或格式美化
- 需要把 CSV / TSV 等原始数据整理成可用的 Excel 模板

## Core principles

1. **以表为中心**：把任务视为「构建或修复一个电子表格」，而不是一次性算出结果硬编码进去
2. **尽量保留公式**：能用公式表达的逻辑不要直接写死数值，便于用户之后在 Excel 里调整
3. **结构清晰**：区分「输入区域」「计算区域」「汇总/展示区域」，使用清楚的表头和说明
4. **错误为零**：交付前要避免常见错误（`#REF!`、`#DIV/0!`、`#VALUE!` 等），必要时通过脚本重新计算校验

## Typical tasks

- 设计预算表、流水表、看板型数据表格
- 清洗杂乱的导出数据，并整理成结构化工作表
- 为已有表格增加新的计算列、图表或透视视图
- 帮用户从头搭一个「可复用、可调参」的小型模型（例如 ROI 计算、排班表、库存表）

