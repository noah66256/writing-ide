## Phase Contracts & Retry 范式（research v1）

### 背景：为什么会“卡住/空转/越改越像缝补”
- 现状里，Gateway 的 AutoRetry 主要是基于“写作闭环”的通用判定（need_todo/need_style_kb/need_style_lint/need_length/need_write）。
- 当进入 `writing_batch`（batch_active）这类“启动后台长跑 job 即可”的阶段时，如果仍沿用通用判定，会把“启动任务”误判为“任务未完成”，导致空转重试与重复扣费。
- 典型症状：
  - `toolCalls: []`（模型本轮没产出任何有效工具调用）
  - `AutoRetryPolicy: need_todo/need_style_kb/...`（仍要求通用闭环）
  - `gateway.run.stalled`（空转到超时）

### 外部范式对照（权威来源）
- **Temporal Retry Policy（Workflow vs Activity）**：`https://docs.temporal.io/encyclopedia/retry-policies`
  - 核心点：默认重试的是 **Activities**；Workflow 更偏确定性，通常不建议重试整个 Workflow，而是只重试失败的 Activity。
- **Celery Task（幂等与重试风暴）**：`https://docs.celeryq.dev/en/stable/userguide/tasks.html#retrying`
  - 核心点：任务应尽量 **idempotent**；并警告“持续失败且被反复 redeliver 会形成高频循环拖垮系统”，因此重试应有退避/上限。
- **LangGraph Persistence（checkpoint + thread_id）**：`https://docs.langchain.com/oss/python/langgraph/persistence`
  - 核心点：每步落 checkpoint；用 `thread_id` 作为主键恢复/继续（适合长跑、可中断、可恢复）。

### 映射到写作 IDE（我们该怎么“像工作流引擎那样”做）
- 把一次 Agent Run 看成“Workflow”
- 把 tool call（`kb.search` / `writing.batch.*` / `lint.*` / `doc.*`）看成“Activity/Task”
- 重试应主要作用在 Activity（tool）层：失败可重试、退避、限次；而不是反复重试“整条工作流”赌模型下一次会输出正确工具调用。

### Phase Contract Registry（建议 v0.1）
为每个 phase 定义一份契约（单一真相源）：
- `allowedTools`：允许的工具集合（避免门禁散落在多处）
- `hint`：该 phase 的系统提示（避免提示词与门禁不一致）
- `successCriteria`：该 phase 什么算“已完成/可结束”
- `autoRetry`：该 phase 的专属重试判定与提示（避免通用判定误伤）

### 对 writing_batch 的落地要点
- `batch_active` 的完成态应当是：
  - 已成功 `writing.batch.start`/`resume`（拿到 jobId）或已存在 running job → 建议 `run.done`
- `AutoRetry` 在 batch_active 不应再要求：
  - need_todo / need_style_kb / need_style_lint / need_length / need_write（这些属于后台 job 内部闭环）


