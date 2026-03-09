# Gemini PI Runtime Stall 排查纪要（2026-03-09）

## 结论

本次 `gemini-3.1-flash-lite-preview` 在 Agent 任务里 `assistant.start` 后长时间无输出，**不是旧 `.env` / 旧模型端点残留**，而是 **PI runtime 下的 Gemini 能力声明与真实执行链路错位**，叠加 **执行型首轮把过宽工具集暴露给模型**，导致 Gemini 在 Todo Gate 阶段更容易产出不完整的 function-call 参数，表现为：

- Desktop 侧看到 `assistant.start`
- 随后长时间无 `assistant.delta`
- 最终可能落到 `Incomplete JSON segment at the end` / stalled timeout

## 已验证事实

1. `.env`、`apps/gateway/data/db.json`、`aiConfig` 中的 Gemini base URL / endpoint 已是新值。
2. `curl` 直连 `https://api.vectorengine.ai` 的 Gemini `generateContent` / `streamGenerateContent` 正常。
3. `pi-ai + google provider` 最小调用正常。
4. `GatewayRuntime + Gemini + 简单 prompt` 正常。
5. 当进入“执行型 + Todo Gate + 写作任务”时，旧实现更容易在首轮失败。
6. 使用“首轮仅暴露收敛后的 boot tools + toolChoice=any”后，Gemini 能稳定先打出 `run.setTodoList`，随后继续进入 `web.search`。

## 根因拆解

### 1. PI runtime 的 Gemini 实际支持 native function calling

`@mariozechner/pi-ai` 的 Google provider 能产出 tool-call 事件；但我们在 `apps/gateway/src/agent/runtime/provider/providerCapabilities.ts` 中把 Gemini 视为：

- `supportsNativeToolCalls=false`
- `supportsNativeFunctionCalling=false`
- `continuationMode=prompt_fallback`

这与 PI runtime 的真实能力不一致。

### 2. 首轮模型可见工具集过宽

虽然 `runFactory.computePerTurnAllowed()` 会在执行启动阶段收敛工具，但旧的 `GatewayRuntime` 只把它用于**执行侧拦截**，并没有用于 **模型侧 tool definitions 暴露**。

结果是：

- 模型首轮仍看到完整工具集
- Gemini 在 Todo Gate 阶段需要先建 Todo，但面对过宽工具面板更容易跑偏/输出半截参数
- 最终形成“看起来没真正开始，但实际上卡在首轮 function calling”的假象

## 本次修复

1. 修正 **PI runtime 专用** 的 Gemini capability snapshot：
   - `supportsNativeToolCalls=true`
   - `supportsNativeFunctionCalling=true`
   - `continuationMode=native`
   - `preferXmlProtocol=false`
2. 给 `PiLoopKernel` / `GatewayRuntime` 增加 `toolChoice` 透传能力。
3. `GatewayRuntime` 在 kernel 启动前，使用 `computePerTurnAllowed(initialRunState)` 计算**首轮可见工具集**，并只把这一子集暴露给模型。
4. `task_execution` 首轮 boot tools 进一步收敛到：
   - `run.setTodoList`
   - `run.todo`
   - `run.mainDoc.get`
   - `run.mainDoc.update`
   - `kb.search`
   - `web.search`
   - `web.fetch`
   - `doc.write`
5. 增加 `KernelInputProfile` 诊断事件，记录：
   - `systemPromptChars`
   - `userPromptChars`
   - `visibleToolCount`
   - `selectedToolCount`
   - `toolChoice`

## 冒烟结果

在本地定向复现中：

- 修复前：首轮容易停在 `assistant.start`，随后报 `Incomplete JSON segment at the end`
- 修复后：Gemini 首轮能稳定产出 `run.setTodoList`，第二轮继续进入 `web.search`
- 当前复现里的后续失败来自 `BOCHA_API_KEY_NOT_CONFIGURED`，属于搜索后端未配置，不再是 Gemini 首轮卡死问题

## 后续建议

1. 把“模型可见工具集”和“执行可用工具集”彻底统一成同一真相源，不只在首轮收敛。
2. 区分：
   - `legacy/providerAdapter` 的 Gemini 能力
   - `pi-runtime/pi-ai` 的 Gemini 能力
   避免共用一份 capability 语义。
3. 对 `run.setTodoList` / `run.todo` 这类控制工具做 provider-adaptive schema 简化，进一步降低函数参数失败率。
