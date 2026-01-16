## packages/agent-core（Agent 执行内核）

### 目标
- 提供 LLM 驱动的 Agent Loop：**先产 Todo（硬约束）** →（可选澄清≤5问，作为 todo 条目）→ 自主选工具执行（非写死流程）→ 可中断/可复盘 Run。
- 统一 tool schema + XML 协议解析、参数校验、工具选择裁剪（只暴露少量相关工具）。
- 输出形态对齐 UI：流式输出 + 工具卡片（Tool Blocks），并支持对每步 **Keep/Undo**（撤销副作用并从上下文移除）。

### 关键约束（与产品一致）
- **Tool = 能力边界**：只允许调用当轮暴露的工具；未暴露的能力不得声称具备（例如未提供 web.search 时不得声称已联网）。
- **KB = 工具**：引用知识库必须通过 `kb.search/kb.cite`（可追溯到 sourceDoc/段落），禁止凭空“KB 里有”。
- **proposal-first 写入**：写入默认先提案，用户 Keep 才 apply，Undo 必须可回撤。

### 主要模块（规划）
- `xmlProtocol`（已实现）：统一解析/渲染 `<tool_calls>/<tool_call>/<tool_result>`（Desktop/Gateway 复用）。
- `runMachine`（已实现）：最小 RunState + Policy 函数（结构化意图 runIntent、预算拆分、StyleGate/AutoRetry/Proposal 判定等），用于把 Gateway 的“散落 if”收敛为可复用的纯函数。
- `providers`（规划）：模型 Provider 抽象（OpenAI/Claude/Gemini/…）
- `planner`（规划）：todo 生成与重规划

### UI 事件模型（规划）
- `run.start` / `run.end`：一次 Run 的开始/结束（`run.end` 会携带 reasonCodes）
- `assistant.start` / `assistant.delta` / `assistant.done`：assistant 气泡边界 + 流式增量（`assistant.*` 会携带 turn，用于稳定切分回合）
- `tool.call` / `tool.result`：工具调用与结果（用于渲染工具卡片）
- `policy.decision`：结构化策略决策记录（policy/decision/reasonCodes/state），用于排查“为什么重试/为什么拦截/为什么扣费”
- `step.keep` / `step.undo`：用户对该步骤的 Keep/Undo 操作（Undo 需调用工具的撤销策略）


