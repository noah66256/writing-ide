## packages/agent-core（Agent 执行内核）

### 目标
- 提供 LLM 驱动的 Agent Loop：澄清（最多5问）→ 产 todo → 自主选工具执行（非写死流程）→ 可中断/可复盘 Run。
- 统一 tool schema + XML 协议解析、参数校验、工具选择裁剪（只暴露少量相关工具）。

### 主要模块（规划）
- `run`：Run 记录与 step 状态机（可暂停/取消/续跑）
- `planner`：todo 生成与重规划
- `tooling`：Tool Registry + XML 协议 + schema 校验
- `providers`：模型 Provider 抽象（OpenAI/Claude/Gemini/…）


