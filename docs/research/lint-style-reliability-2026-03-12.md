# lint.style 可靠性问题排查 · 2026-03-12

## 现象概述

最近多次 Run 中出现以下模式：

- 工具阶段：`lint.style` 返回 summary：
  - 「lint.style 上游输出不稳定/不可解析，已降级为最小可用结果（建议稍后重试或在 B 端切换 lint.style 模型）」
- 随后 Desktop 端提示：
  - `[模型错误] request ended without sending any chunks`
- 但从 Gateway 日志看：
  - kb.search / draft / doc.write 已正常执行，稿件已落到 `output/*.md`；
  - style_imitate 闭环中，`lint.style` 经常走到 degraded 兜底分支。

该问题在不同 provider（Claude / GPT）下都出现过，说明不是单一模型偶发，而是我们 lint.style 路径和 stage 配置存在系统性薄弱点。

## 代码与机制现状

### 1. lint.style 调用链（Gateway）

入口：`POST /api/kb/dev/lint_style`（`apps/gateway/src/index.ts`）

关键步骤：

1. 通过 `getLinterEnv()` 和 `aiConfig.resolveStage("lint.style")` 确定：
   - baseUrl / endpoint / apiKey / model
   - timeoutMs / upstreamTimeoutMs
2. 构造 system+user prompt，将 draft + libraries + expect 打包成 JSON，交给上游 LLM；
3. 通过 `completionOnceViaProvider` 调用上游模型，并支持多模型 fallback：
   - 候选列表 `candidateModelIds` 来自 `stage.modelId + stage.modelIds`；
   - 最多尝试主模型 + 2 个备选模型（MAX_FALLBACK=2）。
4. 解析输出：
   - `tryParse(JSON)` + 正则抽取 `{...}` 再 parse；
   - 解析失败时调用 `tryRepairLintStyleJson`（小模型修复器）；
   - 输出经 `sanitizeLintParsed` 兜底后再过 zod `outSchema` 校验；
5. 若以上步骤仍失败或上游报错/超时：
   - 记录 `lint_style_degraded` 审计事件；
   - 返回 `buildFallbackOut(...)`：
     - `ok: true, degraded: true, similarityScore: 0, issues=[{id: "lint_style_unstable", severity: "high"}]`；
     - `summary` 固定为“上游输出不稳定/不可解析…”；
     - `rewritePrompt` 为一段通用“按风格库口吻重写”的指令。

### 2. pi runtime 对 lint.style 的使用

在 pi runtime 中，lint.style 的结果通过 `parseStyleLintResult` 规范化（`packages/agent-core/src/runMachine.ts`）：

- 读取 `similarityScore / summary / issues[] / expectedDimensions / coveredDimensions / missingDimensions`；
- 将其中 `severity="high"` 的 issue 数量计入 `highIssues`；
- GatewayRuntime 在 `toolName === "lint.style"` 分支中：
  - 根据 `score >= STYLE_LINT_PASS_SCORE` 且 `highIssues === 0` 且 `missingDimensions.length === 0` 判定 `styleLintPassed`；
  - 未通过时累加 `styleLintFailCount`。

因此，当 lint.style 走到 degraded 分支时：

- `similarityScore = 0`，`issues = [severity="high" 的占位 issue]`；
- `styleLintPassed=false`，被视为“风格校验未通过，需要回炉或 safe 降级”。

### 3. 现有可靠性策略（v1.1 已实现）

- 多模型 fallback：最多切换 2 个备选模型；
- JSON 抽取 + 小模型修复：
  - `tryParse` + 正则抽取 `{...}`；
  - `tryRepairLintStyleJson` 使用 `agent.tool_call_repair` 将任意文本修成合法 JSON；
- fallback 输出：
  - 永不直接 `tool failed`，而是返回最小合法对象，避免 style_gate 卡死。

## 根因分析

通过读代码 + 结合现象，定位到两个关键问题：

### 问题 1：lint.style 阶段配置缺失时会“零调用即降级”

代码片段（修复前）：

```ts
const MAX_FALLBACK = 2; // 最多切换 2 次（主 + 2 备）
for (let attempt = 0; attempt < Math.min(candidateModelIds.length, 1 + MAX_FALLBACK); attempt += 1) {
  const mid = candidateModelIds[attempt] ? String(candidateModelIds[attempt]).trim() : "";
  if (mid) {
    // 通过 modelId 查找具体模型，并覆盖 baseUrl/model
  }
  // 调用 completionOnceViaProvider(...)
}
```

当满足以下条件时：

- `llmOverride` 未提供；
- `explicitRuntime` 为空或未配置；
- `aiConfig.listStages()` 返回的 `lint.style` 阶段 `modelId` 与 `modelIds` 都为空字符串；

则 `candidateModelIds.length === 0`，`for` 循环根本不会执行：

- 不会调用上游 LLM；
- `ret` 仍为 `null`；
- 代码最终落入：

```ts
if (!ret?.ok) {
  const errText = String((ret as any)?.error ?? (lastErr as any)?.error ?? "");
  const isTimeout = /aborted|AbortError|timeout/i.test(errText);
  const out = buildFallbackOut({...});
  return reply.send(out);
}
```

结果是：**只要 lint.style 阶段在 B 端没有配置完整 modelId/modelIds，就会出现“零调用即 degraded”的假阳性**。这可以很好解释你看到的“几乎每次 lint.style 都提示上游输出不稳定”的现象——在这种情况下，根本没打到真正的模型。

### 问题 2：上游 LLM 自身的超时/断流（`request ended without sending any chunks`）

- 该报错字符串不在本仓库中，来自依赖库（pi-ai / provider SDK）；
- 触发条件通常是：
  - 上游 provider 连接中断或 HTTP 级错误（常见于流式接口超时、网络波动、Anthropic/OpenAI 网关异常）；
- 在 lint.style 路径上，我们已经用 `upstreamTimeoutMs` + fallback 做了保护：
  - 超时/AbortError 会被归类为 `LINT_UPSTREAM_TIMEOUT`，进入 degraded 兜底；
- 在主写作路径（style_imitate 的正文生成）上，这类错误会被 pi runtime 直接表面化为 Desktop 上的“模型错误”，用户看到的就是：
  - `[模型错误] request ended without sending any chunks`。

这类错误本质上是 **上游模型/网络的稳定性问题**，而不是我们解析/Schema 的错误。我们能做的是：

- 在 lint.style 这样的工具路径上尽量“吞掉”错误，用 degraded 结果兜底，避免卡死；
- 在写作主路径上，通过多 provider 配置与合理 timeout，降低出现频率。

## 这次代码级修复做了什么

### 修复点：确保 lint.style 至少尝试一次调用默认模型

文件：`apps/gateway/src/index.ts`

原逻辑只在 `candidateModelIds.length > 0` 时才会进入 LLM 调用循环，忽略了这样一种情况：

- `getLinterEnv()` 已经根据 env / card 模型给出了 `baseUrl + model`；
- 但 `aiConfig.listStages()` 中的 `lint.style` 阶段缺失 `modelId/modelIds`；
- 导致 `candidateModelIds=[]`，循环不执行，直接 degraded。

本次修改：

```ts
const MAX_FALLBACK = 2; // 最多切换 2 次（主 + 2 备）
// 总尝试次数：
// - 若 candidateModelIds 非空：按候选列表与 MAX_FALLBACK 取最小值；
// - 若 candidateModelIds 为空：仍至少尝试 1 次，使用 getLinterEnv/resolveStage 得到的默认模型，避免因阶段配置缺失而“零调用即降级”。
const totalCandidates = candidateModelIds.length || 1;
const maxAttempts = Math.min(totalCandidates, 1 + MAX_FALLBACK);
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const mid = candidateModelIds[attempt] ? String(candidateModelIds[attempt]).trim() : "";
  if (mid) {
    // 通过 modelId 查找模型并覆盖 baseUrl/model
  }
  // 无论 mid 是否存在，都会用当前 baseUrl/model 调用 completionOnceViaProvider(...)
}
```

效果：

- 即使 B 端未给 `lint.style` 阶段配 modelId/modelIds，只要 env 或 card 配置了一个可用 LLM：
  - 也会至少真正调用一次 lint.style 的上游模型；
  - 只有在该调用确实失败或超时时，才会进入 degraded 兜底；
- 解决了“零调用即降级”的结构性 bug，大幅降低 lint.style 的假阳性降级频率。

### 没动的部分（但要记住）

- JSON 抽取 / 修复策略：目前已经有 tryParse + 正则 + repair 小模型 + sanitize 的多层兜底；
- 上游超时/断流导致的 degraded：
  - 这种情况仍会触发“上游输出不稳定/不可解析”的提示；
  - 但现在至少可以确认这是“真正打到了模型但失败”，而不是“阶段没配好直接降级”。

## 后续建议（非本次改动）

1. **B 端配置检查**
   - 在 admin-web 里加一条 lint.style 阶段的健康检查：
     - 若 `modelId/modelIds` 都为空，明确标红提示“将退回 env/card 默认模型”；
     - 或直接要求填一个可用模型，不允许保存空配置。
2. **主写作路径的 provider 可靠性**
   - 当 `request ended without sending any chunks` 在主写作路径频繁出现时：
     - 建议在 B 端将对应阶段（例如 `agent.main` 或默认 Chat 模型）切换到更稳定的 provider；
     - 并适当调高相关 timeout（例如 `LLM_AGENT_TIMEOUT_MS`）。
3. **lint.style 的 degraded 文案与 UI 提示**
   - 可以在 Desktop 上针对 `degraded: true` 区分：
     - 配置缺失导致的 degrade（已被本次修复消除大部分）；
     - 上游模型超时/断流导致的 degrade；
   - 给操作者更明确的“是模型问题还是配置问题”的信号。

