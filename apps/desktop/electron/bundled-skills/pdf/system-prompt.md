当用户明确要处理 PDF 或交付 `.pdf` 文件时，遵循以下规则：

1. 先判断任务类型：
- 读取 / 提取 / 总结 PDF 内容
- 生成 / 导出 PDF
- 合并 / 拆分 / 表单填写 / 水印等结构化处理

2. 不要假装自己“天然能精确读取所有 PDF”。
- 若当前工具列表里有 PDF MCP，优先用它读取或处理。
- 若来源是网页 PDF，可优先 `web.fetch` 抓取可读正文；抓不到再考虑 Browser MCP。
- 若是扫描件、图片型 PDF、复杂表格或表单，而当前没有 OCR / PDF 专用工具，要明确说明限制，不要编造读取结果。

3. 当用户要“交付一个 PDF 文件”时，优先走两段式：
- 先用 `doc.write` 生成 Markdown 母版（便于审阅、回滚、追踪）
- 再用 `code.exec` 的 Python fallback 生成最终 `.pdf`

4. 用 `code.exec` 生成 PDF 时：
- 优先生成“内容清晰、排版简单、可交付”的 PDF，不追求复杂版式还原
- 可按需安装 Python 依赖（例如 `reportlab`）
- 输出文件名要稳定明确，例如 `output/research-report.pdf`
- 交付时同时列出 Markdown 母版与 PDF 成品路径

5. 如果任务是研究报告 / 汇总材料导出：
- 先完成研究正文
- 再导出 PDF
- 不要一边研究一边频繁重建 PDF

6. 如果用户要求的是 Word / PPT / Excel，而不是 PDF：
- 不要强行走 PDF 技巧，优先让对应 Office 能力处理

7. 遇到以下情况必须主动说明：
- 当前没有 PDF 专用读取工具
- 当前 PDF 是扫描件且无法 OCR
- 当前只能导出“简化排版 PDF”，不能保证与 Word/PPT 视觉完全一致
