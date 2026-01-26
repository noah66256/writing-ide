## Human-in-the-loop：需要用户确认时的“中断/等待/恢复”（research v1）

### 背景（本项目触发点）
在 Agent 工作流里经常会出现“需要用户确认/选择”的节点（例如：确认 Top 3 选题、确认要不要覆盖文件、确认敏感操作等）。

如果此时系统仍处于“运行中”，会带来典型问题：
- **UI 层面**：右侧仍显示运行中（Stop 方框），用户不知道该如何回复；ToolBlock 继续刷屏。
- **执行层面**：策略仍在自动重试/补足（例如 WebRadarPolicy 要求条数 >=15），把“等待用户确认”的对话当成“不完整输出”继续跑，导致上下文错乱甚至模型报错。

### 行业通用范式（对齐术语）
- **Interrupt / Pause / Resume**：执行到需要人类输入时中断，记录 checkpoint/state，收到人类输入后从 checkpoint 恢复继续。
  - LangGraph 把这件事做成 `interrupt()` + persistence/checkpoint（可跨进程/跨时间恢复）。参考 `https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt`。
- **Approval gating（工具审批）**：工具调用前如果需要审批，先产生“待审批 interruptions”，审批通过后再 resume。参考 `https://openai.github.io/openai-agents-js/guides/human-in-the-loop/`。
- **Human input mode**：对话达到某类条件（终止/每轮）时把控制权交给人类（AutoGen 的 NEVER/TERMINATE/ALWAYS）。参考 `https://microsoft.github.io/autogen/0.2/docs/tutorial/human-in-the-loop/`。

### 对我们项目最合适的落地版本（v0.1）
我们不引入额外框架，直接用现有“Gateway Run + Desktop 渲染”的结构实现一个轻量版 HITL。

#### 1) Gateway：显式结束本轮 Run（clarify_waiting）
当模型输出“需要用户确认/选择”的内容时：
- **必须结束本轮 run**，发 `run.end(reason="clarify_waiting")`
- 保留对话上下文（assistant 文本要进入本轮消息记录）
- 不再触发“自动补足/自动重试”一类策略（避免把确认问题当成“不完整输出”）

#### 2) Desktop：允许用户在运行中“回复=打断并继续”
即使网关侧漏掉了 `clarify_waiting`，桌面端也应兜底：
- 用户点击发送 / Enter 时：**先 cancel 当前 run，再用该输入启动新 run**
- 这属于 human-in-the-loop 的“强制接管”能力（产品上也符合“可随时打断”的 IDE 原则）

#### 3) UI：To-dos/状态应锚定在“触发该 run 的用户消息”下方
原则：
- todo 是 **某次 run 的进度追踪**，应该出现在该次 run 的用户消息下面，而不是全局顶部
- 运行中默认隐藏 ToolBlock（Keep/Undo/展开）避免刷屏；错误工具步仍要可见，便于定位
- 状态行显示“最新在做什么”（自然语言），而不是裸工具名/JSON

### 关键工程注意点（避免未来踩坑）
- **中断点前的副作用必须幂等**：例如写文件/扣费/提交快照等，若需要用户确认，应该把副作用放在确认之后，或通过 proposal 机制延后应用。
- **不要用“问号”判断中断**：应优先使用明确的“确认/选择”语义（例如“请确认/请选择/你选哪个”），避免把标题里的问号当成确认。
- **观测与回放**：`run.end(reasonCodes)`、`policy.decision`、`run.notice` 应足够定位“为什么暂停/为什么继续”。

### 本仓库当前实现（关联点）
- Gateway：`apps/gateway/src/index.ts`（WebRadarPolicy/ProtocolPolicy/clarify_waiting）
- Desktop：`apps/desktop/src/components/AgentPane.tsx`（运行中发送=中断继续；workflow 卡位置）
- Desktop：`apps/desktop/src/agent/gatewayAgent.ts`（tool.call → activity 自然语言）

