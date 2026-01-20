## 对话滚动摘要（上下文压缩）v0.1（spec）

### 0. 背景
长对话会导致 Context Pack 膨胀、注意力稀释与调试困难（跑偏/误判/空输出等）。需要在不破坏“可解释、可回滚、工具门禁”的前提下，对历史对话做**滚动压缩**。

本 spec 覆盖：
- **Chat 也携带历史**（用户明确要求）
- 自动“每 3–5 轮摘要”（v0.1 先按 **每 3 轮**触发）
- 摘要 LLM 默认复用 **Agent 的模型**，但 **B 端可独立配置**并热生效

### 1. 目标与不做什么

#### 1.1 目标（v0.1）
- **上下文可控**：Chat/Plan/Agent 都能注入“滚动摘要 + 最近 N 轮原文”，避免无限增长。
- **默认策略符合预期**：摘要模型默认复用 Agent 的模型选择（`agentModel`），Chat 不单独再引入一个默认模型口径。
- **可配置/热生效**：B 端可以为摘要单独指定模型与 allowlist（stage），无需重启。
- **不阻塞写作**：摘要失败时不阻塞本轮 Run（降级为“不带/少带摘要”继续跑）。

#### 1.2 不做什么（留到 v0.2+）
- 不做跨会话/跨项目的“长期记忆库”（只做 run 内滚动摘要）。
- 不做 token 级精确预算（v0.1 用 turn/字符裁剪策略）。

### 2. 机制设计

#### 2.1 Turn 定义（回合）
在 Desktop 的 `steps` 中：
- 以 **user step** 作为 turn 的起点；
- 将其后连续的 **assistant step** 合并为该 turn 的 assistant 内容；
- 仅将 “user+assistant 都非空” 的 turn 视为 **完整回合**。

#### 2.2 注入策略（Context Pack）
- 注入两段（按优先级）：
  - `DIALOGUE_SUMMARY(Markdown)`：滚动摘要（若存在）
  - `RECENT_DIALOGUE(JSON)`：最近 **3 个完整回合**的原文片段（user/assistant 各裁剪）
- Chat/Plan/Agent 都遵循同一策略；Chat 不再是“无历史”。

#### 2.3 触发策略（每 3–5 轮摘要）
v0.1 口径：
- 保留最近 `RAW_KEEP_TURNS = 3` 个完整回合作为原文
- 将更早的回合纳入摘要
- 当“待纳入摘要的新增回合数”达到 `TRIGGER_MIN_TURNS = 3` 时触发一次滚动摘要更新

（说明：v0.2 可改为 3–5 的动态阈值或按字符阈值触发）

### 3. 模型与配置（B 端热生效）

#### 3.1 StageKey
- 新增 stage：`agent.context_summary`
- B 端（`LLM` 页面）可以配置：
  - `modelId`（默认模型）
  - `modelIds`（allowlist：用于“强制/约束”摘要只能用某些模型）
  - `temperature/maxTokens/isEnabled`

#### 3.2 默认用 Agent 模型
Desktop 调用摘要接口时会传 `preferModelId = agentModel`：
- 如果 B 端给 `agent.context_summary` 配了 allowlist，则只有在 allowlist 内才会采用 `preferModelId`，否则 fallback 到 stage 默认值
- 如果 B 端不设 allowlist，则默认采用 `preferModelId`（即“先用 agent 的”）

### 4. 接口（Gateway）

#### 4.1 `POST /api/agent/context/summary`（dev-only 与 run/stream 一致）
请求：
- `preferModelId?: string`
- `previousSummary?: string`
- `deltaTurns: Array<{ user: string; assistant?: string }>`（最多 12）

返回：
- `{ ok: true, summary: string, modelIdUsed: string | null, usage?: any }`
- 或 `{ error: "...", detail?: any }`

容错：
- 摘要失败不阻塞本轮 Run（Desktop 侧降级继续）。

### 5. 可观测性
- Desktop：在 `context.summary.roll/context.summary.failed` 打日志（供 Problems/Runs 面板排查）
- Gateway：可从审计/日志观察 `agent.context_summary` 的选模与错误（v0.1 先最小可用）

### 6. 验收清单
- Chat 模式连续对话 8+ 个完整回合后：
  - `contextPack` 中出现 `DIALOGUE_SUMMARY` 与 `RECENT_DIALOGUE`
  - 继续对话时摘要会每新增 3 个回合滚动更新一次
- 修改 B 端 stage `agent.context_summary` 的默认模型/allowlist 后：
  - 无需重启 Gateway，下一轮摘要调用立即按新配置生效
- 摘要接口故障（返回 500/502）：
  - Chat/Plan/Agent 仍可正常跑（只是不会更新摘要）

### 7. 回滚方案
- Desktop：关闭滚动摘要触发（回退到不注入 `DIALOGUE_SUMMARY` 或仅注入 `RECENT_DIALOGUE`）
- Gateway：移除 `/api/agent/context/summary` 路由与 stage 定义


