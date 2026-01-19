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
3) **content 不是 string（content parts：array/object）**
   - 一些 OpenAI-compatible（或中间层兼容适配）会把 `delta.content` / `message.content` 返回为数组/对象（例如 `[{type:"text", text:"..."}]`）。
   - 若解析器只接受 string，会得到 0 delta，进而触发 empty_output。
4) **上游成功但空内容**
   - finish_reason=STOP 但 content 空，SDK/代理未报错。
   - 若下游不做兜底，流程会被 AutoRetry 误认为“未完成”。
5) **门禁预算语义混用导致“该继续时无法继续”**
   - 典型：WebGate/工具阶段门禁依赖 workflow 完成性重试预算；当 workflow budget 被其它环节消耗殆尽后，门禁无法再推进，最终走到空输出兜底并结束。
   - 对策：将“协议/阶段门禁”的推进预算与“完成性重试”分离；至少在 workflow budget 耗尽时允许门禁改用 protocol budget 再推进一次（仍保持上限）。

## 各家/各协议“内容字段形态”速查（便于后续加模型不再踩坑）
> 目的：把“上游可能返回什么样的 content”提前备忘，避免我们只按 string 解析从而出现 0 delta。

### OpenAI Chat Completions（含多数 OpenAI-compatible）
- **非流式**：常见为 `choices[0].message.content`（string），也可能有 `choices[0].text`（旧形态/某些兼容层）
- **流式**：常见为 `choices[0].delta.content`（string），但兼容层也可能：
  - 直接在 chunk 内给 `choices[0].message.content`（累计 string）
  - 返回 `delta/content` 为 **array/object（content parts）**（需要做 coerce）
 - **参考**：
   - OpenAI API Reference：Chat object（`message.content` 可能是 string 或 content parts 数组）`https://platform.openai.com/docs/api-reference/chat/object`

### Anthropic Claude Messages API（官方协议是“content blocks”）
- **非流式**：`content` 通常是数组（content blocks），例如 `[{ type: "text", text: "..." }, ...]`
- **流式**：以事件方式增量返回（按 block/按 delta），需要把 text block 的增量拼起来。
- **工程要点**：不要假设 content 永远是 string；必须支持“数组 + block.type=text + text 字段”的聚合。
 - **参考**：
   - Anthropic API：Messages examples（展示 `content` 为 blocks 数组）`https://docs.anthropic.com/en/api/messages-examples`
   - Claude Citations（text block 可能带 citations 等扩展字段）`https://docs.anthropic.com/en/docs/build-with-claude/citations`

### Gemini generateContent（官方协议也是“parts”）
- **非流式**：`candidates[].content.parts[]`（数组，每个 part 可能是 text、inline_data 等）
- **流式**：增量返回 parts；需要聚合 text parts（以及注意模型可能返回空 text 但 finish_reason=STOP 的边界情况）
 - **参考**：
   - Gemini Troubleshooting（空响应/异常的官方排障）`https://ai.google.dev/gemini-api/docs/troubleshooting`

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

