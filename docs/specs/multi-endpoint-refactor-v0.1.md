# 多端点兼容重构方案 v0.1

> 目标：消除 writingAgentRunner.ts 中散落的端点类型判断，统一消息队列和 turn 函数。

## 完成状态

| Phase | 状态 | 提交 |
|-------|------|------|
| A：引入 ModelApiType 枚举 | ✅ 已完成 | `98ffc88` |
| B：收敛分支判断 | ✅ 已完成 | `98ffc88` |
| C：统一消息队列 | ✅ 已完成 | `2859aa1` |
| D：合并 turn 函数 | ✅ 已完成 | `2859aa1` |
| E：Context overflow 自动 compaction | 🔲 未开始 | — |

---

## 1. 背景

项目最初只支持 Anthropic Messages API（`/v1/messages`），后来加入了 OpenAI 兼容端点（`/v1/chat/completions`、`/v1/responses`）和 Gemini。重构前的问题：

- `isAnthropicMessagesEndpoint()` 在 `writingAgentRunner.ts` 中被调用 9 次，散布在主循环、工具结果注入、自动重试等关键路径
- 两个几乎平行的 turn 函数：`_runOneTurn()`（Anthropic 专用，197 行）和 `_runOneTurnViaProvider()`（OpenAI 兼容，294 行）
- 双消息队列并行维护：`this.messages`（Anthropic block 格式）+ `this.providerMessages`（纯文本格式），共 15 处 push
- 每新增一个端点特性都要在多处加 if/else，维护成本线性增长

## 2. 参考：OpenClaw 的设计

OpenClaw 的核心思路：**协议选择前置到模型注册，运行时代码不关心具体 Provider。**

- 每个模型对象带 `api` 字段（`"anthropic-messages" | "openai-completions" | "openai-responses" | ...`）
- 底层 SDK 根据 `model.api` 自动路由到对应协议
- Provider 差异通过 StreamFn wrapper 链修补，每个 wrapper 只处理一个问题
- 运行时 turn 函数只有一个，不做端点判断

## 3. 分阶段路线

### Phase A：引入 model.api 枚举 ✅

**目标**：给每个模型打上协议标签，与现有 `endpoint` 字段并存。

### Phase B：收敛分支判断 ✅

**目标**：消除散落的 `isAnthropicMessagesEndpoint()` 调用，统一为语义化属性判断。

### Phase C：统一消息队列 ✅

**目标**：去掉 `this.providerMessages`，改为单一 canonical 消息格式 + 按需转换。

### Phase D：合并 turn 函数 ✅

**目标**：合并 `_runOneTurn()` 和 `_runOneTurnViaProvider()` 为单一函数。

### Phase E：Context overflow 自动 compaction（未开始）

**目标**：当 LLM 返回 context overflow 错误时，自动压缩历史并重试。

**改动**：
- 在 turn 循环中捕获 overflow 错误
- 调用压缩函数（摘要旧消息、截断大型 tool result）
- 重试当前 turn

---

## 4. Phase A 详细设计与实现

### 4.1 类型定义

```typescript
export type ModelApiType =
  | "anthropic-messages"    // /v1/messages（Anthropic 原生）
  | "openai-completions"    // /v1/chat/completions（OpenAI Chat）
  | "openai-responses"      // /v1/responses（OpenAI Responses）
  | "gemini";               // Gemini generateContent
```

定义在 `writingAgentRunner.ts` 中并 export，同时通过 `RunContext.apiType` 传入。

### 4.2 推导规则

在 runner 内部根据 `endpoint` 自动推导：

```typescript
function inferApiType(endpoint: string): ModelApiType {
  const ep = String(endpoint ?? "").trim().toLowerCase();
  if (ep.endsWith("/messages") || ep === "/messages") return "anthropic-messages";
  if (isGeminiLikeEndpoint(ep)) return "gemini";
  if (ep.endsWith("/responses") || ep === "/responses") return "openai-responses";
  return "openai-completions";
}
```

### 4.3 传播路径

```
models-config（已有 endpoint）
  → RunContext.apiType（可选，显式覆盖）
    → WritingAgentRunner 构造时：this.ctx.apiType ?? inferApiType(this.ctx.endpoint)
```

### 4.4 兼容性

- `apiType` 与 `endpoint` 并存，不删除 `endpoint`
- 允许 models-config 显式设置 `apiType` 覆盖推导

---

## 5. Phase B 详细设计与实现

### 5.1 Runner 属性

构造函数中计算：

```typescript
// 基础属性
private readonly apiType: ModelApiType;

// 派生能力标记
private readonly isAnthropicApi: boolean;
private readonly supportsNativeToolUse: boolean;       // Anthropic 结构化 tool_use
private readonly supportsNativeFunctionCalling: boolean; // OpenAI tools 参数
private readonly preferXmlProtocol: boolean;            // XML 工具协议为主协议
private readonly supportsForcedToolChoice: boolean;     // 端点是否尊重 tool_choice

// 初始化
this.apiType = this.ctx.apiType ?? inferApiType(this.ctx.endpoint);
this.isAnthropicApi = this.apiType === "anthropic-messages";
this.supportsNativeToolUse = this.isAnthropicApi;
this.supportsNativeFunctionCalling =
  this.apiType === "openai-completions" || this.apiType === "openai-responses";
this.preferXmlProtocol =
  this.apiType === "gemini" || (!this.supportsNativeToolUse && !this.supportsNativeFunctionCalling);
this.supportsForcedToolChoice = this.isAnthropicApi;
```

### 5.2 替换结果

原 9 处 `isAnthropicMessagesEndpoint()` 全部替换为语义化属性。`isAnthropicMessagesEndpoint()` 函数已删除。

### 5.3 遗留

`providerAdapter.ts` 中的 `isResponsesEndpoint()` 和 `normalizeEndpointPath()` 仍被其他模块消费，保留未删。

---

## 6. Phase C 详细设计与实现

### 6.1 Canonical 消息类型

```typescript
type CanonicalToolResult = {
  toolUseId: string;
  toolName: string;
  content: string;
  isError?: boolean;
};

type CanonicalHistoryEntry =
  | { role: "user"; text: string; images?: Array<{ mediaType: string; data: string }> }
  | { role: "assistant"; blocks: Array<{ type: "text"; text: string } | ContentBlockToolUse>;
      rawStreamText?: string }
  | { role: "tool_result"; results: CanonicalToolResult[]; noteText?: string }
  | { role: "user_hint"; text: string };
```

4 种角色覆盖所有历史消息场景：
- `user`：用户输入（可带图片）
- `assistant`：模型输出（结构化 blocks + 可选原始文本）
- `tool_result`：工具执行结果（支持批量）
- `user_hint`：系统注入的重试提示

### 6.2 单一队列 + 按需转换

```
写入：this._pushHistory(entry)  →  this.history.push(entry)
读取：this._toAnthropicMessages()  →  转为 AnthropicMessage[]
      this._toProviderMessages()   →  转为 OpenAiChatMessage[]
```

- `_toAnthropicMessages()`：遍历 history，user → content block，assistant → blocks 直出，tool_result → tool_result block
- `_toProviderMessages()`：遍历 history，assistant 中的 tool_use → `buildToolCallsXml()` 转 XML 文本，tool_result → `buildInjectedToolResultMessages()` 注入

### 6.3 删除

- `this.messages: AnthropicMessage[]` — 删除
- `this.providerMessages: OpenAiChatMessage[]` — 删除
- 所有 15 处双队列同步 push — 改为单一 `_pushHistory()`
- `buildToolResultMessage()` import — 删除

---

## 7. Phase D 详细设计与实现

### 7.1 TurnAdapter 接口

```typescript
interface TurnAdapter {
  retryPolicy: { maxRetries: number; baseDelayMs: number; jitterMs: number };
  detectsProtocolViolation: boolean;

  buildToolDefs(effectiveAllowed: Set<string>): {
    defs: unknown[];
    toolNameSet: Set<string>;
  };

  consumeStream(args: {
    toolDefs: unknown[];
    turnSystemPrompt: string;
    effectiveAllowed: Set<string>;
    turnToolChoice: any;
    emitTextDelta: boolean;
    signal: AbortSignal;
  }): Promise<StreamConsumeResult>;

  hasContent(result: StreamConsumeResult): boolean;
  getAutoRetryText(result: StreamConsumeResult): string;

  buildHistoryEntry(args: {
    result: StreamConsumeResult;
    suppressText: boolean;
    hasProtocolViolation: boolean;
  }): { entry: CanonicalHistoryEntry; shouldPush: boolean };
}
```

### 7.2 StreamConsumeResult

```typescript
type StreamConsumeResult = {
  displayText: string;                        // 用户可见文本
  rawStreamText: string | undefined;          // 原始流文本（仅 Provider）
  completedToolUses: ContentBlockToolUse[];
  streamErrored: boolean;
  lastStreamError: string;
  promptTokens: number;
  completionTokens: number;
  hasToolCallMarker: boolean;                 // Provider 特有
  wrapperCount: number;                       // Provider 特有
  presetResults: Map<string, ToolExecResult>; // Provider schema 验证预设
};
```

### 7.3 两个 Adapter 的关键差异

| 方面 | Anthropic Adapter | Provider Adapter |
|------|-------------------|------------------|
| 重试策略 | max=3, base=800ms, jitter=200ms | max=2, base=600ms, jitter=180ms |
| 协议违规检测 | 不检测 | 检测 XML `<tool_calls>` 标记 |
| 工具定义 | `toolMetaToAnthropicDef` | `toOpenAiCompatToolDefs` |
| 流消费 | `streamAnthropicMessages` + 实时 `_handleStreamEvent` | `providerAdapter.streamTurn` → 批量 `toCanonicalEvents` |
| 空响应判断 | `displayText \|\| completedToolUses` | `rawStreamText.trim()` |
| 历史条目 | 仅 blocks 非空时 push | 始终 push（保留 rawStreamText） |
| 工具验证 | Anthropic 原生 schema 校验 | 手动 `normalizeToolCallForValidation` + `validateToolCallArgs` |

### 7.4 统一 _runOneTurn() 骨架

19 个步骤，adapter 调用出现在步骤 2/6/7/8/11/12/13/14/18：

```
[1]  perTurnCaps + effectiveAllowed + turnSystemPrompt
[2]  adapter.buildToolDefs(effectiveAllowed)
[3]  _resolveTurnToolChoice(toolNameSet)
[4]  executionContract + holdAssistantDelta
[5]  writeEvent("assistant.start")
[6]  重试循环: adapter.consumeStream(...)
[7]  空响应检测: adapter.hasContent(result)
[8]  重试退避: adapter.retryPolicy
[9]  writeEvent("error") if streamErrored
[10] onTurnUsage 回调
[11] JSON 工具回退: _trySynthesizeToolUseFromJsonText(adapter.getAutoRetryText)
[12] protocolViolation 检测: adapter.detectsProtocolViolation
[13] 混输压制检测 + 通知文案
[14] adapter.buildHistoryEntry → _pushHistory
[15] writeEvent("assistant.done")
[16] abort/error → _setOutcome → return false
[17] protocolViolation → _pushHistory(user_hint) → return true
[18] 无工具分支: _checkAutoRetry + 延迟 delta 发送 + _setOutcome
[19] totalToolCalls++ → _processCompletedToolUses(presetResults)
```

### 7.5 关键设计决策

**protocolViolation 判断时机**：在 JSON fallback 之前记录 `streamParsedToolCount`，用原始流解析结果判断协议违规，避免 fallback 合成的工具调用掩盖无效 XML。

**延迟 delta 发送**：Anthropic 路径在 `emitTextDelta=true` 时已实时发送，仅 `holdAssistantDelta` 时补发；Provider 路径从不实时发送，在无协议违规且 outcome 完成时补发。

**_checkAutoRetry**：120 行的复杂方法中仅一处端点判断 `canForceToolChoice`，改为 `this.supportsForcedToolChoice` 而非整体移入 adapter。

### 7.6 删除

- `_runOneTurnViaProvider()` — 删除（~280 行）
- 旧 `_runOneTurn()` — 删除（~197 行），由统一版本替代
- 4 处 `this.supportsNativeToolUse ? _runOneTurn() : _runOneTurnViaProvider()` 三目分发 — 改为直接调用 `_runOneTurn()`

---

## 8. 回归测试

`apps/gateway/scripts/test-runner-turn.ts` 覆盖 6 个场景：

| 场景 | 路径 | 测试内容 |
|------|------|---------|
| 1 | Anthropic | 纯文本回复 → assistant.delta + assistant.done |
| 2 | Anthropic | tool_use(run.done) → tool.call 事件 + run_done outcome |
| 3 | OpenAI | 纯文本回复 → assistant.delta |
| 4 | OpenAI | XML 工具调用(run.done) → tool.call 事件 + run_done outcome |
| 5 | OpenAI | 空响应 → 自动重试 → 成功 |
| 6 | — | tool_result 注入格式（preferNativeToolCall 分支） |

运行：`npm -w @writing-ide/gateway run test:runner-turn`

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 | 状态 |
|------|------|------|------|
| inferApiType 推导错误 | 模型走错协议 | RunContext.apiType 显式覆盖 | ✅ 已实现 |
| Phase B 替换遗漏 | 某个分支仍用旧判断 | 全局搜索确认 0 处 isAnthropicMessagesEndpoint | ✅ 已验证 |
| Phase C/D 无测试护栏 | 合并 turn 后回归 | 6 场景回归测试脚本 | ✅ 已补充 |
| 线上回归 | 已部署的 Agent 行为变化 | A+B 不改执行逻辑；C+D 有测试覆盖；部署后观察 | ✅ 已部署 |

---

## 10. 文件索引

| 文件 | Phase A | Phase B | Phase C | Phase D |
|------|---------|---------|---------|---------|
| `apps/gateway/src/agent/writingAgentRunner.ts` | apiType + inferApiType | 替换 9 处分支 | CanonicalHistoryEntry + 单队列 | TurnAdapter + 统一 _runOneTurn |
| `apps/gateway/src/agent/runFactory.ts` | RunContext.apiType 传入 | 替换 isAnthropicLike | — | — |
| `apps/gateway/src/llm/providerAdapter.ts` | — | preferNativeToolCall 语义 | _toProviderMessages 调用 | — |
| `apps/gateway/src/llm/anthropicMessages.ts` | — | — | _toAnthropicMessages 调用 | Anthropic adapter 调用 |
| `apps/gateway/scripts/test-runner-turn.ts` | — | — | — | 6 场景回归测试 |
