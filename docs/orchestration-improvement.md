# 编排优化：上下文传递 + 记忆召回改进

> 状态：实施中
> 背景：从实际对话日志中发现两大编排问题，经 Claude Code + Codex 联合分析后制定本方案。

---

## 问题概述

### 问题一：主 Agent → 子 Agent 上下文传递不足

子 Agent 通过 `agent.delegate` 委派执行，但只能拿到 mainDoc 和风格库 ID，拿不到：
- L1 全局记忆（用户画像、风格偏好）
- L2 项目记忆（项目决策、约定）
- 对话摘要（dialogueSummaryByMode）

结果：子 Agent "盲写"，不知道用户偏好和项目约定。

### 问题二：摘要 + 记忆召回碎片化

1. **压缩太狠**：200-600 字扁平摘要覆盖 10+ 回合，URL/数字等硬数据丢失
2. **两次有损压缩**：对话 → 摘要（lossy）→ 记忆提取（再 lossy）
3. **提取时机晚**：只在 run.end 触发，摘要已经压掉细节
4. **append-only 合并**：同一决策被多次追加，记忆文档越来越碎
5. **最近原文太少**：RAW_KEEP_TURNS=3，切换压缩点太靠近当前对话

---

## 改进方案（三批）

### 第一批：P2 — 摘要后触发原文记忆提取 + 去重

**核心思路**：把记忆提取时机从"run.end（已压缩摘要）"前移到"摘要滚动完成（delta 原文可用）"。

#### 改动清单

| 文件 | 位置 | 改什么 |
|------|------|--------|
| `apps/desktop/src/state/runStore.ts` | `RunState` 类型 + `setDialogueSummary` | 新增 `memoryExtractTurnCursorByMode`（对齐摘要 cursor），在 `setDialogueSummary` 中不自动推进（由触发方手动推进） |
| `apps/desktop/src/agent/gatewayAgent.ts` | `rollDialogueSummaryIfNeeded` 返回值 | 摘要成功后，在返回值里携带 `delta`（原文回合列表）和新 cursor 值 |
| `apps/desktop/src/agent/wsTransport.ts` | `startGatewayRunWs` 调用 roll 处（L370） | roll 成功后，异步触发 `useMemoryStore.extractMemory({ dialogueSummary: 原文delta格式化文本 })`，并推进 `memoryExtractTurnCursor` |
| `apps/desktop/src/agent/wsTransport.ts` | `event === "run.end"` 分支（L563） | 改为兜底触发：仅当本轮 `memoryExtractTurnCursor < 摘要cursor` 时才提取（防重复） |
| `apps/desktop/src/state/memoryStore.ts` | `extractMemory` | 入口处检查 `_extracting`，若为 true 则放入队列（而非静默丢弃），确保不漏提取 |
| `apps/gateway/src/index.ts` | `/api/agent/memory/extract` prompt（L1549） | "对话内容摘要"改为"摘要或对话原文片段"，让模型对原文也能稳定提取 |

#### 关键设计决策

- **去重用 cursor**（而非 hash 缓存）：复用已有的 `dialogueSummaryTurnCursorByMode` 模式，新增 `memoryExtractTurnCursorByMode`。只提取 `extractCursor` 到当前摘要 cursor 之间的 delta。
- **run.end 改为兜底**：短对话（从未触发滚动摘要）不会漏掉提取。
- **_extracting 防重，但不能丢**：如果滚动提取进行中、run.end 又来了，要放队列而非直接丢。

#### 测试要点

- 发送 6+ 条对话（触发滚动摘要），确认记忆提取在摘要完成后立刻触发
- 确认 run.end 时不会重复提取同一批内容
- 短对话（3 条以内）确认 run.end 兜底提取正常
- 确认 _extracting=true 时的第二次触发不会静默丢失

---

### 第二批：B+A — 子 Agent 注入 L1/L2 + 主 Agent prompt 强化

**核心思路**：在 Gateway 侧解析 contextPack 中的记忆段，传入 RunContext，子 Agent 委派时自动注入。

#### 改动清单

| 文件 | 位置 | 改什么 |
|------|------|--------|
| `apps/gateway/src/agent/runFactory.ts` | `parseRecentDialogueFromContextPack` 附近（L198） | 新增 `parseMemorySegmentsFromContextPack`，利用 CONTEXT_MANIFEST 元数据切出 `L1_GLOBAL_MEMORY`、`L2_PROJECT_MEMORY`、`DIALOGUE_SUMMARY` 三段 |
| `apps/gateway/src/agent/runFactory.ts` | `prepareAgentRun`（L1084） | 解析结果挂到运行上下文 |
| `apps/gateway/src/agent/runFactory.ts` | `runCtx` 构建（L2439） | 把三段字段放进 `RunContext`（optional，安全降级为空） |
| `apps/gateway/src/agent/writingAgentRunner.ts` | `RunContext` 类型定义（L48） | 新增 `l1Memory?: string`、`l2Memory?: string`、`dialogueSummary?: string` |
| `apps/gateway/src/agent/writingAgentRunner.ts` | `buildSubAgentContextHint`（L151） | 注入裁剪后的 L1/L2/摘要（section 过滤 + 1500 字总上限） |
| `apps/gateway/src/agent/writingAgentRunner.ts` | `_executeSubAgent`（L899） | 构建 subCtx 时传入记忆字段 |
| `apps/gateway/src/agent/runFactory.ts` | 主 Agent system prompt 中 agent.delegate 使用指南 | 强化：task 参数必须包含用户偏好/约束/具体要求/验收标准，不要假设子 Agent 知道对话内容 |

#### 关键设计决策

- **用 CONTEXT_MANIFEST 而非正则切字符串**：Desktop 构建 contextPack 时会注入 manifest（`gatewayAgent.ts:857`），Gateway 已有 `parseRecentDialogueFromContextPack` 的解析范式，沿用这个而不是自己写正则。
- **section 裁剪**：L1 只取"用户画像"+"决策偏好"，L2 只取"项目决策"+"重要约定"（跳过"当前进展"，子 Agent 不需要）。
- **1500 字总上限**：防止子 Agent 上下文窗口被撑大。
- **不透传父 systemPrompt**：只注入最小必要上下文，避免角色混乱。

#### 测试要点

- 委派 copywriter 子 Agent 写文章，确认其能看到用户画像和项目约定
- 确认主 Agent task 描述里有具体要求时，子 Agent 产出质量提升
- 记忆为空时（首次使用）确认子 Agent 正常工作（降级为空）
- 确认子 Agent 的 token 消耗没有大幅增加（1500 字上限有效）

---

### 第三批：P1+P3+P5 — 结构化摘要 + section-merge + 保留更多原文

#### P1：结构化摘要 prompt

| 文件 | 位置 | 改什么 |
|------|------|--------|
| `apps/gateway/src/index.ts` | `/api/agent/context/summary` sys prompt（L1486） | 改为固定章节格式：目标与约束 / 关键决定 / 用户偏好 / 当前进展 / 待办 / 关键细节（URL/数字/文件名原样保留） |
| `apps/gateway/src/index.ts` | summary 返回处（L1543） | 对返回做最小规范化：去掉模型可能包裹的 \`\`\`markdown...\`\`\` 代码块 |

字数上限从 600 调到 800 字，"关键细节"section 明确要求不得概括硬数据。

#### P3：section-merge 合并策略

| 文件 | 位置 | 改什么 |
|------|------|--------|
| `apps/desktop/src/state/memoryStore.ts` | `mergeMemoryPatch`（L52） | 从 append-only 改为按已知 section 标题合并（同名 section 内容追加；未知标题回退 append） |
| `apps/desktop/src/state/memoryStore.ts` | `extractMemory` 项目切换分支（L269） | 项目已切换时先读旧文件再 section-merge 后写回，不要直接覆盖 |

已知 section 标题映射：L1（用户画像/决策偏好/跨项目进展），L2（项目概况/项目决策/重要约定/当前进展）。

#### P5：RAW_KEEP_TURNS = 5

| 文件 | 位置 | 改什么 |
|------|------|--------|
| `apps/desktop/src/agent/gatewayAgent.ts` | L1018（buildContextPack）、L1725（buildChatContextPack）、L1805（rollDialogueSummaryIfNeeded） | 三处同步改为 5 |

注意三处必须同步，否则注入和滚动计算不一致。

#### 测试要点

- P1：发送 10 条对话，查看生成的摘要是否有结构化章节，URL 是否被保留
- P3：连续多轮对话后查看记忆文件，确认同名 section 不会重复出现时间戳分隔线
- P5：验证 contextPack 中 RECENT_DIALOGUE 包含最近 5 个回合（而非 3 个）

---

## 涉及文件汇总

| 文件 | 批次 |
|------|:---:|
| `apps/desktop/src/state/runStore.ts` | 1 |
| `apps/desktop/src/agent/gatewayAgent.ts` | 1、3 |
| `apps/desktop/src/agent/wsTransport.ts` | 1 |
| `apps/desktop/src/state/memoryStore.ts` | 1、3 |
| `apps/gateway/src/index.ts` | 1、3 |
| `apps/gateway/src/agent/runFactory.ts` | 2 |
| `apps/gateway/src/agent/writingAgentRunner.ts` | 2 |
