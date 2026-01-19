# 流式输出空内容（0 delta）根因与工程修复方案 v1

## 背景与现象
- 任务已执行完（含 web.fetch / doc.write），但最终模型输出为空（empty_output）。
- SSE 流结束（finish_reason=STOP 或 [DONE]），**但内容为空**。

## 公开案例与证据
- Vercel AI Gateway/SDK 有“工具调用后无最终文本”的反馈，流式结束但无 content。
  - https://github.com/vercel/ai/issues/10717
- Gemini 2.5 系列存在 `finish_reason=STOP` 但 `response.text` 为空的已知问题讨论。
  - https://discuss.ai.google.dev/t/empty-response-text-from-gemini-2-5-pro-despite-no-safety-and-max-tokens-issues/98010
  - https://discuss.ai.google.dev/t/possible-bug-in-gemini-2-5-pro-behavior-empyty-response/98081
- 官方排障说明提到上下文过大/服务端压力可能导致异常或空响应。
  - https://ai.google.dev/gemini-api/docs/troubleshooting

## 根因范式（工程侧可控部分）
1) **OpenAI-compatible SSE 格式差异**
   - 有的代理不使用 `choices[0].delta.content`，而是 `choices[0].message.content` 或 `choices[0].text`。
   - 解析只认 delta 时会得到 0 delta。
2) **上游成功但空内容**
   - finish_reason=STOP 但 content 空，SDK/代理未报错。
   - 若下游不做兜底，流程会被 AutoRetry 误认为“未完成”。

## 本项目的落地策略
### A. 解析兼容
- 兼容解析 `delta.content` / `message.content` / `text` 三种形态。
### B. 0 delta 兜底一次非流式
- 仅当 **流结束且无任何 delta** 时触发一次非流式请求；
- 避免影响正常流式与性能。

## 验证建议
1) 使用已复现的诊断样本，确认不再出现 `empty_output`。
2) 观察 `openaiCompat.diag` 中 0 delta 的比例是否下降。

