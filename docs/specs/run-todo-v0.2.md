## Run Todo v0.2（spec）

### 目标
- **写作 IDE 视角的 Todo**：用于“当前 Run 的进度追踪与防跑偏”，并服务于 Agent 闭环（不是通用 GTD/协作平台）。
- **LLM 友好**：减少 “反复 set 覆盖” 与 “update 忘传 id/patch” 的失败模式，支持批量更新。
- **用户友好**：Dock Panel 的 Todo 可交互（看得懂、点得动、能筛选、可快速新增）。
- **上下文可控**：Context Pack 注入 todo 要有体积上限与裁剪策略。

### 不做（v0.2 明确不做）
- 提醒/日历/周期任务/习惯追踪
- 团队协作：指派、评论、权限、依赖
- 跨 Run 的全局任务系统（项目级 todo 留到 v0.3+）

---

### 数据结构（兼容 v0.1）
继续沿用并允许扩展字段（v0.2 不强依赖扩展字段）：

```ts
type TodoStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";

type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
};
```

#### 约束（避免上下文爆炸）
- `text`：建议 ≤ 120 chars（超出在注入时截断）
- `note`：建议 ≤ 220 chars（超出在注入时截断）
- todo 总数：UI 可持有更多，但注入 Context Pack 时要裁剪（见下）

---

### Context Pack 注入策略（v0.2 必做）
注入 `RUN_TODO(JSON)` 时执行裁剪：
- **默认注入**：
  - 全部 `status ∈ {todo, in_progress, blocked}`（最多 24 条）
  - 追加最近 `done`（最多 6 条，用于“进度感”）
- 丢弃 `skipped`（除非总数很少）
- 对每条 `text/note` 截断并去除多余空白

目的：让模型关注“未完成/阻塞原因”，而不是被历史 done 任务淹没。

---

### 工具契约（v0.2 新增，v0.1 兼容保留）

#### 保留（v0.1）
- `run.setTodoList(items[])`：整表替换（高风险误用，但保留兼容）
- `run.updateTodo(id?, patch)`：单条更新（保留兼容）

#### 新增（v0.2）
1) `run.todo.upsertMany`
- 输入：`items: Array<{ id?: string; text?: string; status?: TodoStatus; note?: string }>`
- 语义：
  - `id` 命中现有：按提供字段 patch（未提供的不改）
  - `id` 不命中：作为新任务 append（需要 `text`）
  - `id` 缺省：用 `text` 生成稳定 id（slug），避免重复
- 输出：`todoList`

2) `run.todo.update`
- 输入：`{ id?: string; text?: string; status?: TodoStatus; note?: string }`
- 语义：扁平更新；当 `id` 缺省且 todo 只有 1 条时自动补齐；否则返回可用 id 列表

3) `run.todo.remove`
- 输入：`{ id: string }`
- 输出：`todoList`

4) `run.todo.clear`
- 输入：空
- 输出：`todoList=[]`

---

### UI（Dock Panel / Runs Tab）
Todo 区块目标交互：
- **状态可视化**：显示 todo/in_progress/blocked/done/skipped
- **筛选**：全部 / 未完成 / 阻塞 / 已完成
- **快速操作**
  - 点击勾选：done ↔ todo
  - 一键置为进行中（in_progress）
  - 快速新增一条 todo（最少字段：text）
  - 可选：编辑 note（内联）

---

### 验收标准
1. Agent 能用新工具批量更新 todo（不再频繁 set 覆盖）
2. Dock Panel Todo 可交互：可改状态、可筛选、可新增
3. Context Pack 的 RUN_TODO 注入体积明显降低（大量 done 时也不会爆）

---

### 回滚
- 工具层面：保留 v0.1 工具；v0.2 新工具可从 allowlist 移除
- UI 层面：保留旧 markdown 渲染分支（feature flag 或快速回退 commit）



