## packages/agent-core（Agent 执行内核）

### 目标
- 提供 LLM 驱动的 Agent Loop：澄清（最多5问）→ 产 todo → 自主选工具执行（非写死流程）→ 可中断/可复盘 Run。
- 统一 tool schema + XML 协议解析、参数校验、工具选择裁剪（只暴露少量相关工具）。
- 输出形态对齐 UI：流式输出 + 工具卡片（Tool Blocks），并支持对每步 **Keep/Undo**（撤销副作用并从上下文移除）。

### 主要模块（规划）
- `run`：Run 记录与 step 状态机（可暂停/取消/续跑）
- `planner`：todo 生成与重规划
- `tooling`：Tool Registry + XML 协议 + schema 校验
- `providers`：模型 Provider 抽象（OpenAI/Claude/Gemini/…）

### UI 事件模型（规划）
- `assistant.delta`：流式文本增量
- `tool.call` / `tool.result`：工具调用与结果（用于渲染工具卡片）
- `step.keep` / `step.undo`：用户对该步骤的 Keep/Undo 操作（Undo 需调用工具的撤销策略）


