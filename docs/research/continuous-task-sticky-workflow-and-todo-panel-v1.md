# 连续任务 Sticky Workflow + 底部 Todo 面板改造方案 v1

## 结论

本轮不做“大而全”的状态机重写，只做两个最小闭环：

1. **连续任务 sticky**：把当前 run 的 `routeId / MCP server 选择 / 执行约束` 收敛进 `mainDoc.workflowV1`，下一轮遇到“继续/我登好了/下一步/看看数据/写吧”这类续跑输入时，优先继承上轮工作流，而不是重新从 0 路由。
2. **Todo 面板一等公民化**：`todoList` 不再只显示成“更新待办事项 · 已完成：N 项待办”的工具摘要，而是作为独立工作流面板，常驻在输入框上方，逐项展示状态，直到本轮 run 结束。

这两个改动对齐了 `openai/codex` 的成熟做法：
- 连续任务靠 **thread / turn / item / plan** 这种结构化状态维持，而不是靠模型“自己记住”。
- plan / todo 是 **独立 UI 状态**，不是普通消息文本。

## 问题复盘

### 1. 连续任务会失忆

现象：
- 第一轮已经进入浏览器 / MCP / 写作闭环；
- 第二轮用户只说“我登好了”“继续”“写吧”“看看数据”，路由又退回普通 `task_execution` 或讨论；
- 导致 Playwright、`lint.copy`、写作闭环、执行约束都可能被工具 top-N 挤掉。

根因：
- 当前 `runTodo` 有一部分 weak sticky；
- `workflowV1` 在 `agent-core` 的写作判断里已经被部分消费；
- 但 **网关路由层和 MCP server-first 选择层还没有把 workflow sticky 当成显式输入**；
- 同时桌面端也没有把 run 过程中的 `routeId / selectedServerIds / executionContract` 持久化回 `mainDoc.workflowV1`。

### 2. Todo 被错误地降级成工具摘要

现象：
- UI 里只看到一条 “更新待办事项 · 已完成：5 项待办”；
- 用户无法在对话底部持续看到当前任务清单；
- 完全违背“对话驱动的执行面板”定位。

根因：
- `runStore.todoList` 和样式都已经存在；
- 但 `ChatArea` 没有渲染独立 Todo 面板，只有工具卡片摘要。

## 设计原则

### A. 不新造全局状态中心

优先复用已存在的数据结构：
- 跨轮持久化载体：`mainDoc.workflowV1`
- 当前任务清单：`todoList`
- 运行时审计来源：`run.notice`

### B. sticky 只对“短续跑”生效

不能把所有下一轮都强行继承上轮工作流。

仅在以下条件同时满足时启用：
- `workflowV1` 存在且足够新鲜；
- 用户输入属于短续跑 / 承接动作，而不是新主题；
- 用户没有明确说“只讨论 / 不要执行 / 查资料 / 调研 / 为什么”。

### C. Todo 面板不进消息滚动区

布局采用：
- 上方：消息滚动区
- 中间：`WorkflowTodoPanel`
- 下方：`InputBar`

这样 Todo 会“贴着输入框”，不会被滚动历史冲走，也不会污染流式输出。

## 具体改造

### 1. `workflowV1` 作为连续任务契约

建议结构：

```ts
{
  v: 1,
  status: "running" | "waiting_user" | "done",
  routeId: "web_radar" | "task_execution" | "file_ops" | ...,
  intentHint: "ops" | "writing" | "rewrite" | "analysis",
  kind: "browser_session" | "task_workflow",
  selectedServerIds: string[],
  preferredToolNames: string[],
  updatedAt: string,
  lastEndReason?: string,
}
```

来源：
- `ExecutionContract` notice：写入 `routeId / preferredToolNames / status=running`
- `McpServerSelection` notice：写入 `selectedServerIds`
- `run.end`：写入 `lastEndReason`；若是 `clarify_waiting/proposal_waiting`，状态改为 `waiting_user`

### 2. 网关路由层补 workflow sticky

在 `computeIntentRouteDecisionPhase0()` 中新增：
- 从 `mainDoc.workflowV1` 读取上一轮工作流；
- 判断是否是“短续跑/承接动作”；
- 若上一轮是 `web_radar`，则优先继承 `web_radar`；
- 若上一轮是 `task_execution/file_ops/...`，则优先继承对应执行路由；
- 只有在用户显式转成讨论/调研时才打断 sticky。

### 3. MCP server-first 补 sticky 回退

在 server-first 选择后新增一层回退：
- 若本轮 `selectedServerIds` 为空；
- 且 `workflowV1.selectedServerIds` 非空；
- 且当前 prompt 属于续跑；
- 则保留这些上轮 server（前提是它们仍在本轮 sidecar 里连接着）。

这一步是为了解决“第一轮选中了 Playwright，第二轮 short follow-up 又被 30/136 工具 top-N 挤掉”的问题。

### 4. Todo 面板独立渲染

新增 `WorkflowTodoPanel`，数据直接来自 `useRunStore().todoList`。

展示规则：
- 默认展开，不折叠成摘要；
- 每项独立一行，已完成显示打勾；
- `in_progress` 高亮；
- `blocked` 标红；
- `note` 单独显示为次级说明；
- 当 `todoList.length > 0` 且 `(isRunning || 仍有未完成项)` 时显示；
- 若全部完成但 run 仍未结束，面板继续保留，直到 `run.end`。

### 5. 工具摘要保留，但降级为审计

`run.setTodoList` / `run.todo.*` 的工具卡片仍保留，作为审计日志；
但它们不再承担主展示职责。

## 验收标准

### 连续任务

1. 第一轮打开网站并选中 `playwright` 后，第二轮用户回复“我登好了，继续看数据”时，仍应优先进入浏览器工作流。
2. 第一轮写作任务进入 Todo / 终稿闭环后，第二轮用户回复“写吧 / 继续 / 按这个来”时，不应掉出执行链路。
3. 用户若明确说“先别执行，只分析原因”，sticky 必须失效。

### Todo 面板

1. `run.setTodoList` 后，输入框上方出现展开式任务清单。
2. 后续 `run.todo.update` 会逐项更新状态，不再只出现“5 项待办”的摘要。
3. 流式消息继续在上方滚动输出，Todo 面板位置稳定。
4. 所有项完成后，若 run 仍在继续，面板仍保留；run 结束后可消失。

## 冒烟策略

### 网关

做一组纯逻辑 smoke：
- `workflowV1=web_radar + 我登好了继续` → `routeId=web_radar`
- `workflowV1=task_execution + 写吧` → `routeId=task_execution`
- `workflowV1=web_radar + 先讨论原因` → sticky 失效
- `selectedServerIds=[] + workflow.selectedServerIds=[playwright]` → 回退保留 `playwright`

### 桌面端

做构建级 smoke：
- `apps/desktop` build 通过；
- Todo 面板渲染不报 TS / JSX 错误；
- 输入框、消息列表、Todo 面板三段布局可正常编译。

## 不在本轮范围

- 不做完整 thread/turn/item 协议重构；
- 不把所有 workflow 都提升成统一状态机；
- 不做 Todo 面板拖拽、排序、人工编辑；
- 不清理所有历史工具摘要样式，仅修正主展示层级。
