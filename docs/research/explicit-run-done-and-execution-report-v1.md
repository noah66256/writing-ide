## 显式 `run.done`：让 Run “该停必停”的终止协议（research v1）

### 背景：生产环境为什么必须“显式结束”
在写作 IDE 这种 **长链路 + 多工具 + 可能需要人类确认（HITL）** 的系统里，如果依赖“模型最后自然语言总结一下就算结束”，会出现典型不稳定：
- **已完成仍继续生成**：写入已发生、todo 已清空，但模型又多跑一轮“总结/补充”，触发超时/上游错误。
- **工具回合后空输出**：部分模型在 tool_result 后不产生可见文本，UI 看起来“卡住/空白结束”。
- **人类确认语义不清**：模型提问确认，但 Run 仍在 running，用户输入落在不一致上下文导致报错。
- **不同任务形态**：可能只写 1 篇、从 N 篇里挑 K 篇、只做检索不写入……很难用启发式“推测什么时候结束”做到足够稳。

因此需要一个 **显式完成信号**：由模型在完成目标后调用工具 `run.done`，由系统立刻终止本次 run，且生成一份可复盘的执行报告。

### 全网范式对齐（我们借鉴的共同点）
不同框架的表述不同，但核心一致：**终止是状态机/协议的一部分，而不是自然语言的副产品**。
- **LangGraph / 状态机体系**：用明确的 END/interrupt 状态区分“正常结束 vs 中断等待”，并通过 checkpoint/thread 保存状态，支持恢复。
- **AutoGen**：通过 `is_termination_msg` 等机制显式识别终止消息，并在 `human_input_mode` 下把“需要人类输入”作为一种可控的停机点。
- **Langroid**：提供 `DoneTool` / done_sequences，把“完成”变成可声明的事件序列匹配，而不是散落的 if/else。
- **Gemini 工具循环问题**（社区大量反馈）：在工具调用/异步结果场景容易出现重复调用或不产生 final message；工程上常见解法是 **“工具回合结束即停 / 用外层系统分段驱动”**，并用显式终止条件避免无限循环。

### 我们项目的落地目标（v1）
在现有的 `clarify_waiting`（等待用户确认）与 `proposal_waiting`（等待 Keep/Undo）基础上，新增：

#### 1) 工具：`run.done`
- **用途**：显式告诉系统“本次任务已完成，可以终止 run”。
- **特性**：
  - 只读/无副作用（但会触发 run 结束）。
  - 允许携带少量 `note`（可选），用于记录“完成口径/选取策略”等。

#### 2) Gateway：遇到 `run.done` 立即 `run.end(reason="done")`
- **不再拉模型多跑一轮总结**（避免“完成后又生成半天”）。
- 在结束前 **由系统生成执行报告**（不依赖模型发挥）。

#### 3) 执行报告（Execution Report）
由 Gateway 基于 SSE 事件/RunState 生成，包含但不限于：
- 写入类工具次数、写入文件路径（尽量从 tool_result 抽取，最多保留前 N 个）
- web.search/web.fetch 次数与去重摘要（query/domain）
- lint.copy / lint.style 是否执行与通过情况（若有）
- todo 状态概览（总数、done/blocked/todo）
- 总耗时、turn 数、tool.call/tool.result 数
- 最终结束原因：done / clarify_waiting / proposal_waiting / text / upstream_error ...

> UI 展示策略：v1 先写入到 `run.end` 的 payload（或 `run.notice` detail）并在 Logs 可见；后续可将其作为“工作流卡片”折叠展示在消息流里。

### 兜底策略（v1.1 预留）
为进一步稳态，可以加一层系统兜底（只在“明显完成”时触发）：
- 若发生过写入类工具（doc.write/doc.applyEdits/doc.splitToDir 等），并且 todo 被清空（run.todo.clear 或 todo 全 done），则系统可选择自动触发 done（或直接 run.end(done)）。

注意：兜底必须非常保守，避免误杀“写入后还要继续做下一步”的任务（例如写入后还要 lint 或继续扩写）。

### 与 `clarify_waiting` 的关系（关键）
- `clarify_waiting`：**需要你输入**，所以必须 `run.end(reason="clarify_waiting")` 并暂停。
- `run.done`：**任务已完成**，所以必须 `run.end(reason="done")` 并停止。

两者都是“显式状态”，目标是让 UI/用户都能明确知道“现在到底停在哪、下一步需要谁做什么”。

