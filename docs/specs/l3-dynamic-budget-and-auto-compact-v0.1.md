# L3（运行上下文）动态预算 + 自动 compact v0.1

> 面向：Desktop（组装 contextPack）+ Gateway（四槽 assembler 二次组装）
>
> 本 spec 只解决一件事：**让 L3（DIALOGUE_SUMMARY / RECENT_DIALOGUE）不再“写死阈值 + 固定裁 4 条”**，而是跟随“当前所选模型”的上下文窗口动态伸缩。

---

## 0. 背景

我们已完成 P0–P2 的四槽注入：

- `coreRules`（能力目录常驻，必须先看到）
- `taskState`（MAIN_DOC / TASK_STATE / PROJECT_MAP 等执行态真相源）
- `memoryRecall`（L1/L2 锚点 + 少量召回）
- `materials`（KB/style/references，永远最后，永远可裁）

但 L3（运行上下文/最近对话）仍有两个问题：

1) Desktop 的滚动摘要触发阈值偏“超大窗口基线”，导致日常几乎不触发 compact；
2) Gateway 端对 `RECENT_DIALOGUE` 仍固定 `slice(-4)`，把 Desktop 侧保留的对话又二次砍掉，无法利用大上下文模型。

结果：
- 大模型（128k/200k/272k）也只看到极少 recent，续跑稳定性下降；
- 但与此同时，我们又不能“无限塞历史”，否则会把能力边界/任务主线挤掉。

---

## 1. 目标与不做什么

### 1.1 目标

- **按模型动态伸缩**：L3 的“保留 raw turns 数量 / compact 触发阈值 / Gateway recent 裁剪”都基于 `contextWindowTokens` 动态计算。
- **高预算但不挤主线**：优先级始终是 `coreRules > taskState > memoryRecall > L3 > materials`。
- **可观测**：run.notice 能看见本轮：`modelId/contextWindowTokens/effectiveBudget` 以及 L3 的 retained/omitted 指标。

### 1.2 不做什么（本轮不碰）

- 不改 P3 协议升级（`contextSegments[]`）的主线路由。
- 不改 L1/L2 的写入/落盘策略。
- 不做 token 级精确预算（v0.1 用“近似 token 估算 + 字符预算”闭环）。

---

## 2. 数据来源：contextWindowTokens

`contextWindowTokens` 来自 B 端 AI 模型配置（字段 `AiModel.contextWindowTokens`）。

- Desktop 通过 `GET /api/llm/selector` 拿到 `models[].contextWindowTokens`（可为空）。
- Gateway 通过 `aiConfig.resolveModel()` 在 run 时拿到本轮 `contextWindowTokens`。

约定：
- `null` 代表未知，走 fallback。

Fallback（v0.1）：
- `DEFAULT_CONTEXT_WINDOW_TOKENS = 131072`（保守但可用）。

---

## 3. Desktop：滚动摘要（auto compact）动态阈值

### 3.1 关键参数（随模型变化）

给定 `ctx = contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS`：

- `rawKeepTurns = clamp(floor(ctx / 8000), 5, 30)`
  - ctx 越大，保留越多“原文回合”；
  - 仍对每条 user/assistant 做字符裁剪（避免单条爆炸）。

- `compactTriggerTokens = floor(ctx * triggerRatio)`
  - `triggerRatio` 建议分段：
    - `ctx >= 100000` → `0.85`
    - `ctx >= 50000` → `0.80`
    - else → `0.75`

触发规则：
- `estimateDialogueTokens(completeTurns, previousSummary) >= compactTriggerTokens` 时尝试滚动摘要。

### 3.2 注入策略（contextPack）

Desktop 仍输出两段：
- `DIALOGUE_SUMMARY(Markdown)`：滚动摘要（可为空）
- `RECENT_DIALOGUE(JSON)`：最近 `rawKeepTurns` 个完整回合原文片段（user/assistant 分开）

---

## 4. Gateway：L3 注入预算（不再固定裁 4 条）

### 4.1 预算口径（v0.1）

Gateway 在四槽组装时引入“近似输入预算”（字符口径）：

- `effectiveInputBudgetChars = floor(ctx * 4 * 0.8)`
  - 说明：约等于把 `ctx` tokens 转为字符后取 80% 作为“可注入上下文预算”（保留 20% 给 system/tool overhead + 输出空间）。

### 4.2 优先级

组装顺序与裁剪策略：

1) `coreRules`（能力目录）常驻，不裁
2) `taskState` 常驻，按既有上限裁
3) `memoryRecall`（L1/L2）常驻，按既有上限裁
4) `L3(context)`：在预算内尽量保留 `DIALOGUE_SUMMARY + RECENT_DIALOGUE`
5) `materials`：最后吃剩余，永远可裁

### 4.3 L3 动态裁剪策略

- `DIALOGUE_SUMMARY` 与 `RECENT_DIALOGUE` 不再使用写死上限（例如 1200/1600），而是使用 `effectiveInputBudgetChars` 的剩余空间动态决定。
- `RECENT_DIALOGUE` 不再固定 `slice(-4)`：根据预算决定保留条数与每条文本上限。

---

## 5. 可观测性（验收）

### 5.1 Gateway run.notice

在 `ContextAssembly` detail 中新增（或新增一条 notice）：
- `modelContextWindowTokens`
- `effectiveInputBudgetChars`
- `l3`：
  - `dialogueSummaryChars`
  - `recentDialogueMsgsRetained`
  - `recentDialogueMsgsOmitted`
  - `recentDialogueBudgetChars`

### 5.2 Desktop 本地日志

`context.summary.roll` / `context.summary.failed` 增加字段：
- `contextWindowTokens`
- `compactTriggerTokens`
- `rawKeepTurns`

---

## 6. 验收清单（Boss 可直接按这个验）

1) 选一个配置了 `contextWindowTokens` 的大窗口模型（例如 200k/272k）。
2) 连续对话 10+ 个完整回合后触发 1 次以上滚动摘要（或至少日志显示阈值动态生效）。
3) `run.notice → ContextAssembly` 中能看到 `modelContextWindowTokens/effectiveInputBudgetChars` 与 L3 retained 指标。
4) 在同一段对话里，`RECENT_DIALOGUE` 不再永远只有 4 条（大窗口下应明显更多）。
5) 即使材料很多，模型仍稳定知道 MCP/工具是否可用（能力目录仍在最前）。

