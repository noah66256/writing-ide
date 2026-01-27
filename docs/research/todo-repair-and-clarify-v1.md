## Todo Repair & ClarifyPolicy：从“模板兜底”到“可执行任务”（research v1）

### 背景：为什么会出现“笼统 todo + 需要你确认”
我们在 Gateway 侧为 `run.setTodoList` 做了一个兜底：当模型漏传必填字段 `items` 时，系统会自动补出三条通用 todo（例如“澄清目标/约束（如需要）/执行核心步骤/输出最终结果”）。

这个兜底本来用于“让 UI 至少有锚点”，但在当前策略组合下会造成两个副作用：

- **todo 质量退化**：变成模板废话，无法指导执行。
- **触发 ClarifyPolicy 硬等待**：兜底里出现“澄清/确认”字样，`ClarifyPolicy` 会判定本轮需要用户确认，直接以 `clarify_waiting` 结束 run，UI 显示“需要你确认”，用户感知为“卡住/不全/看不见问题”。

### 现象复盘（与代码对应）
- **触发条件**：模型调用 `run.setTodoList` 时漏传 `items`（必填）。
- **系统行为**：`ToolArgNormalizationPolicy` 发现 `missing_required:items` → 走兜底模板 todo。
- **结果**：`ClarifyPolicy` 看到 todo1 含“澄清/确认” → `decision=wait_user` → run 被中断等待。

代码位置（当前实现）：
- `apps/gateway/src/index.ts`：`ToolArgNormalizationPolicy` 对 `run.setTodoList` 的兜底（生成 t1/t2/t3 模板）。
- `apps/gateway/src/index.ts`：`ClarifyPolicy` 对“待澄清/待确认”类 todo 的阻塞判定（导致 `clarify_waiting`）。

### 外部范式对照：为什么“静默补模板”不是最佳解

#### 1) Schema-first 的工具调用契约（Tool Contract）
业界对 tool/function calling 的共同点是：**工具调用是结构化契约**（name + args/inputs），宿主侧应当做 schema 校验，不合规则要求“修复/重试”，而不是用无信息的模板文本顶上去。

- Anthropic：工具使用流程是 `tool_use` → 宿主执行 → `tool_result` 回传；client tools 需定义 input schema。  
  参考：`https://docs.anthropic.com/en/docs/build-with-claude/tool-use`
- OpenAI Cookbook（function calling 示例）：模型在 `tool_calls` 中给出 function name 与 `arguments`（JSON），宿主侧解析并执行，再把结果回传。  
  参考：`https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/How_to_call_functions_with_chat_models.ipynb`

**映射到我们这里**：`run.setTodoList` 的 `items` 是“工具参数”，漏传时更像“参数不合规”，应优先走“修复而不是模板兜底”。

#### 2) Human-in-the-loop 更像 interrupt/resume（而非“看见澄清就硬停”）
LangGraph 对 interrupts 的描述更贴近我们想要的体验：**暂停并保存状态，等待外部输入后 resume**，并强调：

- **checkpointing** 保存执行游标，恢复后继续；
- 用 **`thread_id`** 作为恢复指针；
- interrupt 前的 side effects 需幂等（避免重复执行造成副作用）。

参考：`https://docs.langchain.com/oss/python/langgraph/interrupts`

**映射到我们这里**：ClarifyPolicy 的“等待用户”本质是 interrupt，但它不应该被“无意间生成的一条模板 todo”触发；应当只在“确实缺关键参数且无法安全默认”时才进入硬等待。

### 我们项目的推荐落地（v0.1，最小闭环）

#### A. `run.setTodoList` 缺参：从“模板兜底”改为“修复优先”
当 `items` 缺失时，优先策略应是：

1. **修复重试（preferred）**：要求模型重新发起 `run.setTodoList`，补齐 `items`（并给出最小可执行粒度的要求，例如每条 todo 必须是“动词 + 对象 + 产物/工具提示”）。
2. **可执行兜底（fallback）**：若重试仍失败（到达 retry budget），再生成兜底 todo，但兜底必须是“可执行动作”，且避免触发硬澄清：
   - 例：`读取当前文档/选区 → 生成大纲 → 写入新文件 draft_x.md → 运行 lint.style → 输出执行报告`（按当前 runIntent/工具可用性裁剪）
3. **可观测性**：在日志里打 `todo.repair` 事件（包含：缺失字段、修复方式、是否降级兜底、生成的 items 摘要）。

#### B. ClarifyPolicy：从“硬等待”改为“软澄清优先”
建议把澄清分两类：

- **软澄清（default）**：不阻塞执行。Agent 先按安全默认推进，同时在输出/主文档写明假设，并给出 1 个关键问题让用户可随时纠偏。
- **硬等待（only when necessary）**：只有在“继续执行会造成不可逆副作用”或“目标文件/覆盖策略不明确且无法安全默认”时才阻塞。

并且 ClarifyPolicy 不应依赖“todo 文本里是否含‘澄清/确认’”这种脆弱信号；应读取更结构化的条件（例如：缺失哪些关键参数、是否存在写入/覆盖、是否允许默认行为等）。

#### C. Todo 质量守门（避免“执行核心步骤”再出现）
对 `run.setTodoList.items` 加一个轻量的质量 gate（不引入模型也能做的确定性检查）：

- 每条 todo 至少包含一个可执行动词（如：读取/检索/生成/改写/写入/验证/部署/回滚）；
- 严禁出现纯模板项（如：“执行核心步骤/输出最终结果/澄清目标约束”）作为唯一信息；
- 若命中模板项且缺少其它高信息项：触发 **repair**（回到 A-1）。

### 验收清单（Definition of Done）
- **缺 items 时**：不会再生成“澄清目标/执行核心步骤”这种模板 todo；系统会优先让模型补齐；最差兜底也能指导执行。
- **不该停时不停**：明确写作/改写指令下，不会因为 todo 模板触发 `clarify_waiting`。
- **该停时能停**：当确实缺关键参数且无法安全默认时，仍能进入等待确认，并且 UI 能清楚说明“缺什么/怎么补”。
- **日志可排查**：出现 todo 修复/澄清等待时，能在 `pm2 out.log` 看到结构化原因码与摘要。

### 风险与回滚
- **风险**：软澄清可能在少数场景下“按默认执行”与用户意图不一致。
- **缓解**：只对“低风险/可回滚”动作默认推进；写入/覆盖仍走 proposal-first；并把默认假设写入主文档（可追溯）。
- **回滚**：保留旧逻辑开关（例如 env `TODO_REPAIR_MODE=legacy` 或 feature flag），可在生产快速回退到原“模板兜底 + 硬等待”行为（不推荐长期）。

### 相关文档（本仓库）
- `docs/research/todo-tools-v1.md`
- `docs/research/tool-call-repair-v1.md`
- `docs/research/hitl-interrupt-clarify-waiting-v1.md`
- `docs/research/phase-contracts-and-retry-paradigm-v1.md`


