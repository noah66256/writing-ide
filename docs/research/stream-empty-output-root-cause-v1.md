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
- Google ADK（Python）也有“tool call 后最终 message 为空”的 issue。
  - https://github.com/google/adk-python/issues/3525
- Gemini CLI 有“API returned an empty response”的反馈（升级后/特定请求下返回空响应）。
  - https://github.com/google-gemini/gemini-cli/issues/6306
- 官方排障说明提到上下文过大/服务端压力可能导致异常或空响应。
  - https://ai.google.dev/gemini-api/docs/troubleshooting

## 根因范式（工程侧可控部分）
1) **OpenAI-compatible SSE 格式差异**
   - 有的代理不使用 `choices[0].delta.content`，而是 `choices[0].message.content` 或 `choices[0].text`。
   - 解析只认 delta 时会得到 0 delta。
2) **“看似流式，但并非严格 SSE data: 行”**
   - 一些代理/网关会返回：
     - `text/event-stream` 但逐行直接输出 JSON（不带 `data:` 前缀）；
     - 或直接返回 `application/x-ndjson` / `application/ndjson`；
     - 或者**忽略 `stream=true`，直接返回 `application/json` 的一次性响应**。
   - 若解析器只接受 `data:` 行，会导致**虽然上游有输出，但下游累计到 0 delta**，最终触发 `empty_output`。
2) **上游成功但空内容**
   - finish_reason=STOP 但 content 空，SDK/代理未报错。
   - 若下游不做兜底，流程会被 AutoRetry 误认为“未完成”。
3) **门禁预算语义混用导致“该继续时无法继续”**
   - 典型：WebGate/工具阶段门禁依赖 workflow 完成性重试预算；当 workflow budget 被其它环节消耗殆尽后，门禁无法再推进，最终走到空输出兜底并结束。
   - 对策：将“协议/阶段门禁”的推进预算与“完成性重试”分离；至少在 workflow budget 耗尽时允许门禁改用 protocol budget 再推进一次（仍保持上限）。

## 本项目的落地策略
### A. 解析兼容
- 兼容解析 `delta.content` / `message.content` / `text` 三种形态。
### A2. 行格式兼容（data: 与非 data:）
- SSE 逐行读取时，除 `data:` 外，也接受“直接 JSON 行”（并跳过 `event:/id:/retry:` 等元信息行）。
### A3. content-type 兼容（application/json）
- 当 content-type 为 `application/json`（且非 event-stream/ndjson）时，按一次性 JSON 解析并产出 delta。
### B. 0 delta 兜底一次非流式
- 仅当 **流结束且无任何 delta** 时触发一次非流式请求；
- 避免影响正常流式与性能。

## 验证建议
1) 使用已复现的诊断样本，确认不再出现 `empty_output`。
2) 观察 `openaiCompat.diag` 中 0 delta 的比例是否下降。

