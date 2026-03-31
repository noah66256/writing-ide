# 内置 Image MCP 方案对照调研（2026-03-25）

> 目的：为 Crab 的“对话式图片生成/编辑”落地提供一手源码依据，避免只看 README 做拍脑袋方案。

## 0. 结论先行

结论：

1. **Crab 应该把图片生成/编辑做成系统内置 MCP Server，而不是 Skill、Chat Tool 或页面级外挂能力。**
2. **v0.1 最稳路线是：主对话继续支持多 provider，图像执行层先固定 Gemini / Nano Banana。**
3. **线程上下文必须是 thread-first，而不是 provider-first。**
   - 持久层保留线程图片历史与 artifact 索引；
   - provider 原生会话缓存只做易失加速，不能当唯一事实源。
4. **外部开源实现不是三选一，而是组合吸收：**
   - `Proma`：抄“对话内连续改图 + 结果回流消息流”
   - `gemini-cli-extensions/nanobanana`：抄“精简清晰的工具面”
   - `YCSE/nanobanana-mcp`：抄“conversation_id / history / set_model / set_aspect_ratio 这一层会话显式化思路”
   - `zhongweili/nanobanana-mcp-server`：抄“工程化输出管理、Files API、模型选择器、运维工具”

---

## 1. Crab 当前架构约束

结合本仓库当前实现，Image MCP 必须服从这些边界：

- Desktop 才是 MCP Client / tool executor。
  - 参考：`apps/desktop/electron/mcp-manager.mjs`
- Gateway 只负责编排、选择、审计与 thread 状态。
  - 参考：`apps/gateway/src/agent/runFactory.ts`
- MCP 已经是 server-first。
  - Desktop 内置 bundled server：`playwright` / `bocha-search` / `web-search`
  - 参考：`apps/desktop/electron/mcp-manager.mjs`
- Gateway 已有 MCP family / capability card / tool profile / server selection 这套主线。
  - 参考：`apps/gateway/src/agent/toolCatalog.ts`
  - 参考：`apps/gateway/src/agent/capabilityIndex.ts`
  - 参考：`apps/gateway/src/agent/contextAssembler.ts`
- Desktop 已有图片输入与 transcript 媒体部件能力。
  - 参考：`packages/shared/src/runtime/thread-turn-item.ts`
  - 参考：`apps/desktop/src/agent/transcript.ts`
- Desktop 的 MCP manager 已经能把 MCP 返回的 `image` content block 落盘成 artifact。
  - 参考：`apps/desktop/electron/mcp-manager.mjs`

换句话说，Crab 不缺“图片展示能力”，也不缺“MCP 执行能力”，缺的是：

- 一个系统内置的图片 MCP server
- 一个 thread-first 的图像上下文合同
- 一个把图片 artifact 与会话续跑接起来的运行时协议

---

## 2. Proma：最值得抄的是“线程内连续改图”

仓库：

- `ErlichLiu/Proma`

关键源码：

- `apps/electron/src/main/lib/chat-tools/nano-banana-tool.ts`
- `apps/electron/src/main/lib/chat-tools/nano-banana-mcp.ts`
- `apps/electron/src/main/lib/chat-service.ts`
- `apps/electron/src/main/lib/agent-orchestrator.ts`
- `apps/electron/src/renderer/components/chat/ChatMessageItem.tsx`

源码确认到的事实：

1. Chat 模式和 Agent 模式都接了图像能力。
   - Chat 走内置 chat tool
   - Agent 走内置 MCP server
2. 它把 Gemini 图片 API 的多轮上下文放在内存 Map 里：
   - Chat：`conversationHistory`
   - Agent：`sessionHistory`
3. 它保留 Gemini 响应里的 `thoughtSignature`，用来支持连续编辑。
4. 它会把生成图片保存成附件，并直接回流到消息流里展示。
5. Agent 模式下它还会把图片额外保存到工作目录，方便后续工具引用。

优点：

- 真正做成了“对话里的工具”，不是单独页面
- 连续改图闭环是通的
- 图片结果回到聊天消息里，用户心智顺

缺点：

- 图像连续编辑历史主要是**纯内存态**
- provider 历史与 thread 历史没有明确分层
- 工具面偏 Gemini/Nano Banana 专用，不是 thread-first 抽象

对 Crab 的启发：

- 必须保留“图片结果回流 thread”
- 必须支持“上一轮生成图继续改”
- 但不能把 provider 会话缓存当唯一事实源

---

## 3. gemini-cli-extensions/nanobanana：最值得抄的是“工具面”

仓库：

- `gemini-cli-extensions/nanobanana`

关键源码：

- `mcp-server/src/index.ts`
- `mcp-server/src/imageGenerator.ts`

源码确认到的事实：

1. MCP 工具面非常清楚，主工具就是：
   - `generate_image`
   - `edit_image`
   - `restore_image`
2. 它没有把 conversation/history 做成主轴。
3. 模型选择主要靠环境变量，默认 `gemini-3.1-flash-image-preview`。
4. `edit_image` / `restore_image` 与 `generate_image` 语义分离，对模型比较友好。

优点：

- 工具命名清晰
- 参数面简单
- 适合被 LLM 稳定调用

缺点：

- 连续会话能力弱
- 更像单次命令工具，不像 thread-first 图像系统

对 Crab 的启发：

- v0.1 的 agent-facing 工具面，应该尽量接近它这种“少而清楚”的形态
- 不要一上来把模型选择、文件上传、运维工具都暴露给主模型

---

## 4. YCSE/nanobanana-mcp：最值得抄的是“会话显式化”

仓库：

- `YCSE/nanobanana-mcp`

关键源码：

- `src/index.ts`

源码确认到的事实：

1. 它把会话做成显式参数：
   - `conversation_id`
2. 它把图像历史也显式化：
   - `use_image_history`
   - `get_image_history`
   - `clear_conversation`
3. 它支持会话级设置：
   - `set_aspect_ratio`
   - `set_model`
4. 它支持引用：
   - `last`
   - `history:N`
5. 生成结果会把图片作为 MCP `image` block 返回，同时写入本地文件。

优点：

- 非常接近“线程内图像历史”的思路
- history / defaults / model 切换都有明确接口

缺点：

- 会话 id 直接暴露给模型
- 工具面略重
- 默认把很多 provider/session 细节推给了调用者

对 Crab 的启发：

- `conversation_id` 这层思想值得要
- 但不应暴露给模型，而应由 Crab runtime 自动绑定 `threadId`
- `last` / `history:N` 这类引用语法值得保留一部分

---

## 5. zhongweili/nanobanana-mcp-server：最值得抄的是“工程化”

仓库：

- `zhongweili/nanobanana-mcp-server`

关键源码：

- `nanobanana_mcp_server/tools/generate_image.py`
- `nanobanana_mcp_server/services/model_selector.py`
- `nanobanana_mcp_server/services/files_api_service.py`

源码确认到的事实：

1. 它把 `generate_image` 做成统一入口，同时兼容：
   - 纯生成
   - 单图编辑
   - 多图 conditioning
   - `file_id` 方式编辑
2. 参数非常工程化：
   - `model_tier`
   - `resolution`
   - `thinking_level`
   - `enable_grounding`
   - `aspect_ratio`
   - `output_path`
   - `return_full_image`
3. 它有单独的模型选择器：
   - `flash`
   - `nb2`
   - `pro`
   - 并按 prompt / thinking / image count / conditioning 自动选
4. 它有 Files API 与 fallback/re-upload 机制。
5. 它还有 output stats / maintenance / progress resources 这些工程性配套。

优点：

- 工程化最强
- 适合做底层 provider 执行层
- 输出、存储、恢复、文件 id 这些问题都考虑了

缺点：

- agent-facing 工具面偏重
- 它的核心心智更像“图像服务端”，不是“thread-first 对话应用”

对 Crab 的启发：

- provider 执行层可以吸收它的模型选择器、输出管理与 Files API 适配
- 但不应该把这整套复杂参数直接暴露给主模型

---

## 6. 对 Crab 的最终提炼

Crab 的正确组合应该是：

### 6.1 要抄什么

- 从 `Proma` 抄：
  - 图像结果回流 thread
  - 连续编辑闭环
  - 图片保存到工作目录 / artifact 目录

- 从 `gemini-cli-extensions/nanobanana` 抄：
  - 精简的 agent-facing 工具面
  - `generate_image / edit_image` 语义分离

- 从 `YCSE/nanobanana-mcp` 抄：
  - conversation / history / defaults 的显式会话模型
  - `last` / `history` 这类引用思路

- 从 `zhongweili/nanobanana-mcp-server` 抄：
  - provider 执行层的模型选择
  - output/file/file_id/fallback 工程逻辑

### 6.2 不该抄什么

- 不要把 provider 的 `conversation_id` 直接交给模型管理
- 不要把 `set_model` / `set_aspect_ratio` / `maintenance` 这类重工具直接暴露给主模型
- 不要做成页面级“生图工作台”
- 不要让图像连续编辑只活在内存里

### 6.3 v0.1 应有的形态

- 系统内置 bundled MCP server
- server 展示名固定为 `Crab Image`，server id 固定为 `crab-image`
- family 新增 `image`
- 对主模型只暴露极小工具面：
  - `generate_image`
  - `edit_image`
- thread 级持久化 `imageSession`
- provider 级易失缓存 `providerSessionCache`
- 返回值必须带 `image` content，并在 Crab 内转成结构化 artifact / transcript media

---

## 7. 直接落地建议

最稳妥的实现路线：

1. 先做 **系统内置 `Crab Image` MCP server**（serverId=`crab-image`）
2. 先做 **Gemini 单执行 provider**
3. 先打通 **thread image session + artifact 回流**
4. 再做 **provider session cache**
5. 最后才考虑：
   - `gpt-image`
   - `imagen`
   - 多 image provider 选择

一句话总结：

**Crab 这次不是要“接一个生图工具”，而是要补上一套 thread-first 的图像执行能力。**
