# InputBar Active Runtime Strips v1

> 日期：2026-03-20
> 状态：实施中
> 目标：在输入框上方补齐 Codex 风格的“活跃运行态条”，稳定展示后台终端与子 Agent，并支持展开查看与手动关闭。

## 1. 背景

当前 Desktop 在输入区附近已经存在两类零散状态提示，但都不满足产品要求：

1. `InputBar.tsx` 内部使用 `runStore.activity` 显示一条“思考中/正在搜索资料”文字。
2. `ChatArea.tsx` 里有一个 `BackgroundProcessSummary`，但它是从历史 `ToolBlockStep` 倒推 `process.run/list/stop` 的结果，重启后不稳定，也无法作为真正的运行时事实源。

这带来 4 个问题：

1. 终端状态与输入框状态分裂，用户会同时看到 `思考中...`、工具卡、状态条，语义重复。
2. 后台终端是否仍在运行，当前 UI 不是看“实时状态”，而是看“历史消息里曾经发生过什么”，容易失真。
3. 子 Agent 已经有 `collabSessions + activeCollabAgents` 事实源，但输入区附近没有统一的常驻可见状态。
4. 用户无法在输入区附近直接展开查看后台运行项，也无法直接停止进程/关闭子 Agent。

## 2. 一手对照

本次实现对照本仓库内置的 Codex 源码：

- `third_party/openai-codex/codex-rs/tui_app_server/src/bottom_pane/footer.rs`
- `third_party/openai-codex/codex-rs/tui_app_server/src/bottom_pane/unified_exec_footer.rs`
- `third_party/openai-codex/codex-rs/tui_app_server/src/multi_agents.rs`

提炼出的可直接借鉴原则：

1. 输入区附近的状态要“低高度、被动呈现、单行可折叠”，不能抢正文。
2. 运行态摘要应来自单一事实源，而不是消息历史重建。
3. 汇总文案应有统一生成逻辑，避免不同地方各说各话。
4. 展开细节是次级视图，默认只显示一行摘要。

## 3. 产品目标

在输入框上方新增一个 `ActiveRuntimeStrips` 区域，最多渲染两条 strip：

1. 终端 strip：显示当前活跃后台终端会话。
2. 子 Agent strip：显示当前活跃子 Agent 会话。

要求：

1. 默认折叠为单行。
2. 支持点击展开详情。
3. 支持用户手动关闭：
   - 终端：停止后台终端进程。
   - 子 Agent：关闭对应 collab session。
4. 与现有 todo/plan 区共存，不改变“打开就是对话”的主范式。

## 4. 布局合同

`ChatArea` 底部区域统一改为三层：

1. 若存在 workflow todo/plan，则先渲染 `WorkflowTodoPanel`
2. 其下渲染 `ActiveRuntimeStrips`
3. 最下方渲染 `InputBar`

顺序不可颠倒，原因：

1. todo/plan 代表任务主线，优先级高于“后台运行态”。
2. 运行态 strip 要贴近输入框，便于边看边继续发指令。
3. strip 不应进入消息流，否则会和对话历史混淆。

视觉要求：

1. strip 与输入框共用同一 `max-width`。
2. strip 高度尽量低，默认一条约 `36-40px`。
3. 用细边框、弱底色、弱阴影，风格贴近现有输入框，不做独立大卡片。
4. 两条 strip 都存在时，按固定顺序渲染：
   - 终端 strip 在上
   - 子 Agent strip 在下

## 5. 事实源合同

### 5.1 终端 strip

终端 strip 不再从 `steps` 历史倒推，而改用桌面端实时事实源：

1. 通过 `window.desktop.process.list()` 读取当前由 Crab 托管的进程表。
2. 只统计 `status in ["running", "stopping"]` 的记录作为活跃终端。
3. 详情展示基于该实时结果，而不是 `ToolBlockStep.output`。

原因：

1. `process.run/list/stop` 历史只说明“曾经做过”，不说明“现在还活着没有”。
2. Electron 主进程的 `processTable` 才是实时事实源。

说明：

1. `shell.exec` 仍继续在消息区保留其工具卡展示。
2. strip 的“终端”定义对齐 Codex 的 background terminal，更接近 `process.run` 托管会话，而不是一次性的 `shell.exec`。

### 5.2 子 Agent strip

子 Agent strip 优先使用运行时事实源：

1. `runStore.collabSessions`
2. `runStore.thread.activeCollabAgents`

聚合规则：

1. 以 `collabSessions` 为主，因为它包含 `id / childThreadId / agentId / status / waitState / updatedAt`。
2. 若 `collabSessions` 中缺失某个运行中的 agent，但 `thread.activeCollabAgents` 里存在，则补一个轻量投影视图。
3. 只展示 `status in ["running", "waiting"]` 的活跃项。

## 6. 交互合同

### 6.1 折叠态

每条 strip 折叠态展示：

1. 左侧状态点或 spinner
2. 中间单行摘要
3. 右侧展开按钮

摘要文案规则：

1. 终端：
   - `1 个后台终端运行中`
   - `3 个后台终端运行中`
2. 子 Agent：
   - `1 个子智能体运行中`
   - `2 个子智能体运行中`
   - 若全部处于 waiting，可显示 `2 个子智能体等待中`

### 6.2 展开态

展开后显示明细列表，每项包含：

1. 名称
2. 次要信息
3. 状态标签
4. 关闭按钮

终端明细字段：

1. `command`
2. `cwd` 的尾段或项目内相对提示
3. `status`
4. `startedAt` 相对时间

子 Agent 明细字段：

1. `agentName` 或 `agentId`
2. `role`
3. `status / waitState.kind`
4. `updatedAt` 相对时间

### 6.3 关闭动作

终端：

1. 点击“停止”后调用 `window.desktop.process.stop(id)`
2. 成功后立即刷新终端 strip 数据

子 Agent：

1. 点击“关闭”后，调用 Gateway 新增轻量接口，直接执行 collab close 动作
2. 成功后依赖 `thread.snapshot / collab.session.updated` 回流刷新 UI
3. 若接口成功但 WS 回流稍慢，前端可先做乐观态：将该 session 临时标记为 `closing`

## 7. 新增 Gateway 接口

为避免 UI 想关闭子 Agent 时必须再发起一次完整模型回合，本 spec 引入显式控制接口：

### 7.1 Route

`POST /api/agent/collab/close`

### 7.2 Request

```json
{
  "threadId": "thread_xxx",
  "sessionId": "collab_xxx"
}
```

### 7.3 Response

```json
{
  "ok": true,
  "sessionId": "collab_xxx"
}
```

### 7.4 行为

1. 从当前 `threadId` 对应 live runtime 找到 `CollabRuntime`
2. 复用 `collabRuntime.closeAgent({ id: sessionId })`
3. 成功后继续经既有 `collab.session.updated` / `thread.snapshot` 通道广播

若 live runtime 不在：

1. 返回 `NOT_AVAILABLE`
2. 前端提示“当前子 Agent 已不在活动编排中，稍后刷新会话状态”

注意：

1. 该接口是显式 UI 控制面，不进入消息流，不新增聊天消息。
2. 不允许通过“伪造一轮模型调用 close_agent 工具”来实现。

## 8. 前端状态模型

新增 `ActiveRuntimeStrips` 组件，内部维护两类状态：

### 8.1 TerminalRuntimeEntry

```ts
type TerminalRuntimeEntry = {
  id: string;
  processId: string;
  command: string;
  cwd?: string;
  status: "running" | "stopping" | "exited" | "error";
  startedAt?: number | null;
};
```

### 8.2 CollabRuntimeEntry

```ts
type CollabRuntimeEntry = {
  id: string;
  agentId: string;
  agentName?: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed" | "closing";
  waitKind?: "join" | "user" | "approval";
  updatedAt?: string;
  childThreadId?: string;
};
```

## 9. 刷新策略

### 9.1 终端

1. 组件挂载后立即调用一次 `process.list`
2. 当页面可见且存在活跃终端时，每 2 秒轮询一次
3. 无活跃终端时停止高频轮询
4. 执行 stop 后立即 refresh 一次

### 9.2 子 Agent

1. 主要依赖 `runStore.collabSessions` / `thread.activeCollabAgents` 响应式更新
2. 不主动轮询 Gateway
3. 关闭动作成功后允许本地短暂乐观更新

## 10. 与现有 UI 的收敛

本次必须同步收敛以下旧行为：

1. 删除 `ChatArea.tsx` 中旧的 `BackgroundProcessSummary`
2. `InputBar.tsx` 仍不在编辑器上方单独显示 `activity` 文案
3. `runStore.activity` 继续保留给 stop 按钮、消息流和后续状态整合使用，但不再直接渲染成独立文本行
4. turn 级 loading 已由 `ChatArea` 的 transcript `status` item 承载，详见
   `docs/specs/desktop-chat-transcript-ordering-and-rich-media-v0.1.md`

原因：

1. 活跃状态入口必须唯一
2. 避免再次出现“一轮回复里同时有 strip、思考中、工具卡”的三重重复

## 11. 文件改动范围

### 11.1 必改

1. `apps/desktop/src/ui/components/ChatArea.tsx`
2. `apps/desktop/src/ui/components/InputBar.tsx`
3. `apps/desktop/src/agent/gatewayUrl.ts`
4. `apps/gateway/src/index.ts`

### 11.2 建议新增

1. `apps/desktop/src/ui/components/ActiveRuntimeStrips.tsx`
2. `apps/desktop/src/lib/activeRuntime.ts`

## 12. 验收 checklist

### 12.1 终端 strip

1. 启动一个 `process.run` 长时进程后，输入框上方出现终端 strip
2. 展开后能看到命令与状态
3. 点击停止后，会话状态刷新并从 strip 消失
4. 重启 Desktop 后，只要主进程进程表里仍有会话，strip 仍正确显示

### 12.2 子 Agent strip

1. `spawn_agent` 后输入框上方出现子 Agent strip
2. 展开后能看到 agent 名称、角色、状态
3. `wait_agent` 导致 waiting 时，strip 正确显示 waiting
4. 点击关闭后，不新增聊天消息，但状态正确回流并消失

### 12.3 共存布局

1. 有 todo panel 且有终端 strip 时，顺序为 `todo -> strip -> input`
2. 同时有终端和子 Agent 时，最多两条 strip，均不挤爆输入区
3. 窄宽度下摘要文案截断但布局不换行炸裂

## 13. 明确不做

本版不做：

1. 子 Agent 之间的会话切换器
2. 终端完整 stdout 面板迁移到 strip
3. 把 strip 合并进消息流
4. 对已结束的终端/子 Agent 做历史归档列表

本版只解决“输入区附近看得到、点得开、关得掉”的主闭环。
