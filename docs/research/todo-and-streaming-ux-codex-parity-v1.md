# Todo 与流式输出交互对齐 Codex（v1）

## 1. 问题定义

当前 UI 在两个地方容易给用户“怪怪的”感觉：

1. **任务清单像日志，不像运行态**
   - `run.setTodoList / run.todo / run.mainDoc.update / time.now` 这类内部 orchestration 工具会直接显示在消息流里
   - 用户看到的是“更新待办事项 / 更新主文档 / 读取时间”这类系统内部动作，而不是“AI 正在思考 / 正在推进任务”
2. **连续写作缺少任务边界**
   - 用户开始第二篇明确的新写作任务时，上一轮的 `todo / workflow / recent dialogue / old goal` 仍可能继续注入
   - 观感上会像“上一轮没收干净”

## 2. 对标 Codex 的结论

参考 `openai/codex` 可直接看到的实现：

- `codex-rs/tui/src/streaming/controller.rs`
- `codex-rs/tui/src/streaming/commit_tick.rs`

关键不是把所有内部动作都直接给用户看，而是：

- **文本流有专门的 stream controller**
- **计划流有单独的 plan stream controller**
- **chunking / commit tick 控制的是“看起来连续而自然”**
- 用户看到的是“阶段性进展”和“结构化计划”，不是内部 orchestrator 的每个小动作

所以对我们更合适的不是“暴露更多底层事件”，而是：

- 隐藏内部 orchestration 工具卡片
- 把输入框附近的 loading 文案收敛成少数人话状态
- 显式切断新写作任务与旧任务态

## 3. 本轮最小实现

### 3.1 新写作任务边界

当用户发起**明确的新写作请求**时：

- 清空上一轮的：
  - `todoList`
  - `workflowV1`
  - `compositeTaskV1`
  - `pendingArtifacts`
  - `ctxRefs`
  - 对话摘要游标 / 摘要文本
- `buildContextPack` 不再注入上一轮的：
  - `RUN_TODO`
  - `RECENT_DIALOGUE`
  - 旧的写作目标字段（goal/topic/title/outline/angle/styleContract）

目标：第二篇写作看起来就是一个新任务，而不是上一轮的延续。

### 3.2 Loading 文案收敛

- 输入框上方只显示少数人话状态：
  - 默认：`思考中…`
  - 特例：网页任务 / 等待用户 / 达到回合上限
- 不再把 `run.setTodoList / run.mainDoc.update / time.now` 这类内部动作直接暴露为主 loading 文案

### 3.3 隐藏内部工具卡片

对用户价值低的内部工具步骤默认不显示：

- `run.setTodoList`
- `run.todo*`
- `run.mainDoc.get`
- `run.mainDoc.update`
- `run.done`
- `time.now`

用户保留感知的是：

- AI 在思考
- 计划正在变化
- 外部工具正在工作（搜索 / 浏览器 / 文档 / KB）

### 3.4 Todo 面板保留当前策略

本轮**不改**这条：

- 全部 done 后，任务清单仍然自动消失

因为当前产品目标不是让用户复盘，而是让用户看到“AI 正在聪明地列计划并推进”。

## 4. 验收用例

### Case A：连续写作切边界

1. 用户写完第一篇
2. 再发：`用@李叔风格写一篇关于 OpenClaw 的口播稿`
3. 系统应把这轮视为**新写作任务**
4. 不继承上一轮 `todo / workflow / recent dialogue / old goal`

### Case B：内部 run 工具不再刷屏

1. agent 运行时调用 `run.setTodoList / run.mainDoc.update`
2. 聊天流中不再出现“更新待办事项 / 更新主文档”这类碎卡片
3. 输入框附近统一显示 `思考中…`

### Case C：外部工具仍可见

1. agent 调用 `web.search / kb.search / mcp.playwright.*`
2. 用户仍能看到与任务相关的可解释动作
3. 不会把所有过程都黑盒化
