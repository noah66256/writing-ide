# 分段播报与流式检查点对齐 Codex（v1）

## 1. 问题定义

当前桌面端虽然已经把内部工具噪音隐藏掉，但用户感知仍然偏“黑盒”：

- 运行时主要看到 Tool 卡片和输入框上的 `思考中…`
- 缺少像 Codex 那样的“阶段播报”
- 一旦进入复合任务（先搜、再看、再写、再交付），用户不容易建立“现在做到哪一步了”的连续感

用户要的不是完整思维链，而是：

- 想一轮 → 说一句人话进展
- 做一轮 → 跑工具 / 浏览器 / 检索
- 看一轮 → 基于结果继续推进

## 2. 对标 Codex 的结论

直接参考 `openai/codex` 可见实现：

- `codex-rs/tui/src/streaming/controller.rs`
- `codex-rs/tui/src/streaming/commit_tick.rs`

核心不是“把底层事件全展示出来”，而是：

- 主文本流有单独 controller
- plan 流有单独 controller
- 通过 commit tick 把输出切成自然的小段
- 用户看到的是“持续推进的结果”，而不是内部事件日志

迁移到我们桌面端，等价做法不是暴露更多 run/tool 细节，而是加一层：

- **阶段播报（progress checkpoint）**：短的人话进展
- **正式回答（final assistant text）**：真正的内容产出
- **工具卡片（tool trace）**：可展开的外部执行证据

## 3. 本轮最小实现

### 3.1 新增 Progress Step

在 `assistant` step 上补一个轻量变体：

- `variant = "progress"`

它的语义不是“正式回答”，而是“阶段播报”。

要求：

- UI 上用更轻的样式显示
- 不进入对话摘要/最近对话注入
- 不作为“已有正式回答”的判定依据
- 不影响对话自动命名

### 3.2 在 WS 事件层加阶段控制器

在 `wsTransport` 中维护一个轻量 phase controller：

- `planning`
- `browser`
- `search`
- `kb`
- `delivery`
- `synthesis`
- `subagent`

触发来源：

- `run.notice`
- `subagent.start`
- `tool.call`
- `assistant.start`（仅在工具阶段之后，用于“开始整理结果”）

输出原则：

- 相同 phase 不重复刷
- 内部 orchestration 不播报
- 只在 phase 切换时补一句短文案
- 文案要像 Codex 的 preamble，而不是系统日志

### 3.3 文案风格

示例：

- `我先梳理一下任务。`
- `我先看一下当前网页状态。`
- `我先补几条资料，再继续。`
- `我先把拿到的信息整理一下。`
- `我在整理交付结果。`

约束：

- 只说“接下来要做什么”
- 不说内部事件名
- 不说 `run.notice / tool.call / setTodoList`
- 单句、短、自然

### 3.4 Todo / Tool 卡片关系

本轮不移除 Tool 卡片；关系变成：

- `progress checkpoint`：人话进展
- `tool group card`：外部执行证据
- `assistant final`：最终结论/交付

这样能同时满足：

- 用户能感知“AI 在推进”
- 又能展开验证它具体做了什么

## 4. 验收用例

### Case A：搜索 → 写作

1. 用户让系统联网搜资料并写稿
2. 先出现：`我先补几条资料，再继续。`
3. 再出现搜索工具卡片
4. 搜索后出现：`我先把拿到的信息整理一下。`
5. 再进入正文流式输出

### Case B：浏览器复合任务

1. 用户让系统打开网页并多步操作
2. 先出现：`我先看一下当前网页状态。`
3. 后面仍有网页任务卡片，但不再只有冷冰冰的工具轨迹
4. 页面读完后出现：`我先把看到的内容整理一下。`

### Case C：阶段播报不污染上下文

1. 同一轮出现多条 progress step
2. 对话摘要 / recent dialogue 注入时不把这些 progress step 当正式 assistant 内容
3. 新一轮任务不会继承上轮 progress 文案
