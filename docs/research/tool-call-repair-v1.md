## Tool Call Repair v1（小模型协议修复器）

### 背景
在 Plan/Agent 模式中，模型需要输出 `<tool_calls>...</tool_calls>` XML 来调用工具。但实际运行中常见两类“非恶意失败”：

- **XML 不可解析**：`tool_xml_parse_failed`（例如缺少闭合标签、夹杂代码块 fence、属性引号错误等）
- **参数不符合 schema**：`tool_args_invalid`（例如漏传必填参数、JSON 字符串不合法、布尔/数字字段传了自然语言）

传统做法是让主模型重试，稳定性依赖主模型且会消耗 `protocolRetryBudget`。

### 目标
引入一个“**小模型作为工具**”的修复器：

- 只做 **格式/参数修复**（repair），不做任务决策
- 输出仍必须通过：**工具白名单 + 参数 schema 校验**；不通过则丢弃并回退到主模型重试
- 以更低成本减少 protocol 重试次数，提高闭环稳定性

### 实现（Gateway 内部）
- Stage：`agent.tool_call_repair`
- Feature flag：`TOOL_CALL_REPAIR_ENABLED=1`
- 触发点：
  - `tool_xml_parse_failed`：看起来像工具调用但解析失败时，先尝试修复
  - `tool_args_invalid`：工具参数校验失败时，先尝试修复

### 安全边界
- 修复器输出的 XML 会再次经过：
  - **allowedToolNames（本回合允许工具集合）**校验
  - `validateToolCallArgs`（JSON/number/boolean 最小校验）
- 修复器被要求 **只输出 XML 或 FAIL**，并只能使用允许的工具名列表

### 配置
在 `.env` 中配置：

- `TOOL_CALL_REPAIR_ENABLED=1`
- （可选）独立配置小模型：
  - `LLM_TOOL_REPAIR_BASE_URL=...`（OpenAI-compatible）
  - `LLM_TOOL_REPAIR_MODEL=...`（建议 1.5B~3B 指令模型）
  - `LLM_TOOL_REPAIR_API_KEY=...`（若你的服务不需要可留空）

如果不配置 `LLM_TOOL_REPAIR_*`，将回退复用默认 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`（不推荐）。

