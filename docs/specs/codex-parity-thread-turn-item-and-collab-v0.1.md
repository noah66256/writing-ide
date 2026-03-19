# Codex Parity：Thread / Turn / Item + Collab + Skills 实施规范 v0.1

> 状态：completed
> 更新时间：2026-03-19
> 前置：
> - `docs/research/codex-subagent-skills-stateflow-parity-2026-03-19.md`
> - `docs/specs/sub-agent-architecture-v0.2.md`
> - `docs/specs/thread-waiting-user-state-v0.1.md`
> - `docs/research/thread-first-task-state-resume-parity-v1.md`
> - `docs/research/single-core-adapter-playbook-chat-responses-v1.md`
> 说明：
> - 本文档已按 2026-03-19 最终实现状态回填
> - 其中部分“Phase / 迁移顺序 / 风险”章节保留为历史归档
> - 当前 authoritative cutover 结论以 `docs/specs/codex-parity-legacy-cutover-and-runtime-hardening-v0.1.md` 为准

## 0. 结论先行

本 spec 的目标不是“给 Crab 再补一个 sub-agent 功能”，而是把现有运行时收敛成接近 Codex 的单一骨架：

1. `Thread` 负责跨轮事实
2. `Turn` 负责单轮执行事实
3. `Item` 负责最小渲染/审计/恢复单元
4. `Collab` 直接对齐 Codex 的协作工具面
5. `SkillRef` 直接进入请求体、线程态和上下文注入链路

本次明确做三件事：

1. 把 `workflowV1 / compositeTaskV1 / stickyActiveSkillIds / run.end 补丁` 背后的真实状态，收敛到 `ThreadRecord / TurnRecord / ItemRecord / TaskStateV2`
2. 把协作工具面直接切到 Codex 风格：`spawn_agent / send_input / resume_agent / wait_agent / close_agent`
3. 把 skills 从“Desktop 算一份、Gateway 再算一份”改成显式 `skillRefs + thread.activeSkillRefs`

本次明确不做三件事：

1. 不抄 Codex 的桌面 UI 皮肤
2. 不切 Codex app-server / JSON-RPC
3. 不重做 Codex 桌面壳层之外的全部产品语义

但本次也明确不再保守：

1. `agent.delegate` 已从主路径移除，协作工具面统一为 `spawn_agent / send_input / resume_agent / wait_agent / close_agent`
2. 新 prompt / tool exposure / capability 链，默认直接围绕 Codex 协作工具族设计
3. 旧读点、旧镜像、旧 compat patch 已在本轮收口到新事实源

一句话：

> 抄 Codex 的协议骨架、状态模型、协作工具面；不抄它的桌面外壳。

## 1. 范围、成功标准与非目标

### 1.1 成功标准

做到以下 6 点，才算本 spec 落地成功：

1. Gateway 和 Desktop 在运行时都能拿到稳定的 `ThreadRecord / TurnRecord / ItemRecord`
2. 新协作工具族可以直接暴露给模型，旧 `agent.delegate` 不再参与主路径
3. 子 agent 不再只是 `subagent.start/done` 文本流，而是有 `CollabItem + activeCollabAgents + child thread`
4. `skillRefs` 可以显式进入请求体，Gateway 返回的 `thread.snapshot.activeSkillRefs` 成为唯一裁决结果
5. waiting / proposal / approval 的最终事实只能通过 thread/item reducer 写入
6. 重启桌面、切换对话、后台 run 续跑后，Thread/Turn/Item 状态不丢

### 1.2 非目标

本轮不做：

1. 大规模重写已有 workflow/pipeline 业务语义
2. 重做 ChatArea / ToolBlock / Sidebar 的视觉层
3. 替换现有 WebSocket 基建
4. 删除历史审计中所有 `agent.delegate` / `run.end` 记录

### 1.3 截至 2026-03-19 的实现回填

这一节用于防止 spec 和代码进度再次脱节。

#### 已完成

1. Desktop 已能持久化并恢复 `thread / turns / items / collabSessions / activeItemIds`
2. Desktop 已新增 `threadProjection.ts`，`ChatArea / conversationStore / runTarget / gatewayAgent` 已优先消费 `items -> steps` 投影
3. waiting heuristic 已降级为 candidate-only，不再直接 patch 主状态
4. proposal-first 已切到 item owner：
   - `FileChangeItem / ApprovalItem + ItemActionSpec`
   - `ToolBlock` 优先 dispatch item action
   - 历史 reload 后若 `canReplayAfterReload=false`，UI 会明确展示“仅可查看，不可继续操作”
5. `runMachine / kbSelection / gatewayAgent` 已完成 thread-first：
   - 优先读 `taskStateV2.workflow`
   - 优先读 `thread.activeSkillRefs`
   - 旧 `workflowV1 / activeSkillIds` 已不再作为主路径 fallback
6. Collab runtime/session 核心链路已接通：
   - `spawn_agent / send_input / resume_agent / wait_agent / close_agent`
   - 执行桥已统一收敛到新协作工具族

#### 截至 2026-03-19 本轮收尾后的状态

1. Gateway 集中事实源已形成可用主链：
   - `threadState.ts / itemEmitter.ts` 已进入 `runFactory` 主路径
   - `thread.snapshot / turn.* / item.*` 已作为主同步链被 Desktop 消费
2. 新协作工具族已进入真实暴露链：
   - `runFactory / GatewayRuntime / writingAgentRunner` 已以 `spawn_agent` 为主语义
   - 旧 `agent.delegate` 已从主工具面与主执行链删除
3. Skills 已完成一等公民化：
   - 请求体主入口已切到 `skillRefs`
   - `thread.activeSkillRefs` 已成为 Gateway 返回的唯一裁决结果
4. proposal-first 产品语义已收口：
   - UI 主按钮文案已切成 `应用更改 / 放弃提案 / 回滚更改 / 批准 / 驳回 / 采纳 / 放弃`
   - `Keep / Undo` 仅保留内部 action 名
5. `run.end` 已不再直接承担 waiting 世界状态推断：
   - waiting 主状态由 Gateway `thread.waiting.updated / thread.snapshot` 驱动
   - Desktop 的 `run.end` 仅保留日志与非 authoritative 收尾逻辑

## 2. 文档边界

从这里往后的“问题分析 / Phase 顺序 / 风险 / 迁移步骤”主要保留为实施归档。

需要以当前代码行为为准时，请优先看：

1. 4.x 的协议/schema 章节
2. 11 的完成度回填
3. `docs/specs/codex-parity-legacy-cutover-and-runtime-hardening-v0.1.md`
## 3. 迁移前问题与必须纳入迁移面的真实代码路径

这部分保留为迁移前问题归档，不代表 2026-03-19 的当前代码状态。

它的作用是解释这轮改造为什么必须覆盖这些真实主路径。

### 2.1 Sub-agent 真实执行主路径不只在 `GatewayRuntime`

当前子 agent 并不只是 `GatewayRuntime -> LegacySubAgentBridge` 两个点。

真实执行路径里，`apps/gateway/src/agent/writingAgentRunner.ts` 仍然承担了关键职责：

1. 子 agent 工具裁剪与 MCP capability 过滤
2. budget / abort / tool call 次数控制
3. style_imitate skill 继承与 system prompt 注入
4. 原始用户消息 + 负责人指令 + context hint 的拼装
5. `subagent.start` / `subagent.done` 事件发射
6. 子 agent usage 计费事件发射

因此：

1. `LegacySubAgentBridge.ts` 不能单独被视为“唯一迁移点”
2. `writingAgentRunner.ts` 必须纳入主迁移路径
3. 后续 `collabRuntime` 或 `SubAgentExecutionPort` 设计，必须先接住这里的真实执行责任

### 2.2 协作工具面的真实暴露链不只在 `packages/tools`

迁移前，协作相关工具是否会暴露给模型、是否 server-side 执行，不只由 `packages/tools/src/index.ts` 决定。

必须一起改的链路包括：

1. `packages/tools/src/index.ts`
2. `apps/gateway/src/agent/toolCatalog.ts`
3. `apps/gateway/src/agent/serverToolRunner.ts`
4. 与 tool retrieval / allowlist / capability routing 相邻的调用点

迁移前问题：

1. `toolCatalog.ts` 仍以 `delegate` 能力关键词和 `agent.delegate` 为中心
2. `serverToolRunner.ts` 默认 allowlist 仍包含 `agent.delegate`
3. 协作工具的 server-side 执行理由、风险级别、能力标签都还没切到新工具族

因此本 spec 的要求是：

1. 新工具族先进入工具总表
2. 再进入 capability 分类、tool catalog、allowlist、执行决策链
3. 最后 `agent.delegate` 才降成 compat alias

### 2.3 旧事实源读点不能拖到最后再清

迁移前，这些地方直接依赖旧字段：

1. `packages/agent-core/src/runMachine.ts`
2. `apps/desktop/src/agent/gatewayAgent.ts`
3. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`

如果只“先建新类型、新事件”，但不让这些读点尽早读到新事实源，会出现：

1. 新状态已生成，但续跑逻辑仍按旧字段判断
2. waiting / workflow / active skills 继续被旧 heuristics 主导
3. runtime 双轨长期并存，越修越乱

因此本 spec 明确：

1. Phase 1 就要加 adapter
2. 旧读点优先从 `ThreadRecord / TaskStateV2 / ItemRecord` 取值
3. 旧字段只作为 fallback，不允许反过来覆盖新事实源

### 2.4 会话持久化和后台 run 投影层也必须 Phase 1 接入

迁移前，历史快照和后台 run buffer 仍主要围绕旧模型：

1. `apps/desktop/src/state/conversationStore.ts`
2. `apps/desktop/src/agent/runTarget.ts`

如果不在 Phase 1 就把 Thread/Turn/Item 投影进这两层，会导致：

1. 重启后 thread state 丢失
2. 切会话后 waiting/proposal/sub-agent 状态错乱
3. 后台 run 完成后只落旧 steps，不落 thread/item

因此：

1. `RunSnapshot` 必须扩展为可持久化 thread/turn/item 视图
2. `runTarget` 的 buffer 必须镜像这些字段
3. 背景 run flush 回 snapshot 时，不能只 merge steps/logs

### 2.5 Proposal-first 目前还不是 item owner

迁移前，Keep/Undo 仍主要绑在：

1. `apps/desktop/src/components/ToolBlock.tsx`
2. `apps/desktop/src/state/conversationStore.ts`
3. `apps/desktop/src/state/runStore.ts` 的 step 语义

这意味着：

1. Step 还在充当事实源
2. ToolBlock 直接持有可执行动作
3. UI state 和业务 state 容易双写

本 spec 要求：

1. Step 只能是 Item 投影视图
2. Keep/Undo 的唯一 action owner 必须是 item reducer / item action
3. ToolBlock 只能 dispatch item action，不能继续直接维护业务真相

补充说明：

1. `keep / undo` 是迁移期内部动作名，不再等同于最终用户可见术语
2. 产品层要保留的是“提案采纳 / 回滚撤销”能力，不是保留 `Keep/Undo` 这两个英文按钮

### 2.6 Skills 当前仍是 run body + sticky 补丁混合裁决

迁移前，skill 激活仍主要沿这条路径走：

1. `apps/desktop/src/ui/components/ChatArea.tsx` 从 mention 里抽 `mentionedSkillIds`
2. `stickyActiveSkillIds` 写进本地 store
3. `apps/desktop/src/agent/gatewayAgent.ts` 构上下文时再算一遍 `ACTIVE_SKILLS(JSON)`
4. Gateway / agent-core 再次 detect / activate

这导致：

1. 显式 skill 输入不够一等公民
2. sticky 和 activeSkills 的双写时机不清晰
3. skill 续跑依赖旧镜像和启发式

因此本 spec 要补足：

1. `startGatewayRun` 请求体 schema
2. `thread.snapshot` / `RunSnapshot` 中的 skill schema
3. `skillRefs` 与 `stickyActiveSkillIds` 的双写时机

### 2.7 Waiting heuristic 只能产出 candidate，不能直写主状态

迁移前，`apps/desktop/src/agent/wsTransport.ts` 中：

1. `deriveWaitingWorkflowPatchFromAssistant` 会从 assistant 文本推断 waiting
2. `run.end` 分支会直接把这个 patch 写回 workflow/main state

这条链必须被收紧。

本 spec 明确边界：

1. heuristic 只能产出 `waitingCandidate`
2. `waitingCandidate` 只能用于日志、提示、debug
3. 只有 `thread.waiting.updated` 或 `thread.snapshot` 可以写 Thread 主状态
4. Phase 1 起，任何新代码不得再从 assistant 文本直接 patch 主状态

## 3. 目标模型

### 3.1 核心原则

#### 原则 A：Thread 是会话事实源

Thread 负责跨 turn 状态：

1. 当前是否 waiting
2. 当前有哪些 thread-level skills
3. 当前有哪些活跃 collab agent
4. 当前有哪些 pending proposal / approval
5. 当前有哪些 pending artifacts / workflow 恢复点

#### 原则 B：Turn 是单轮执行事实源

Turn 只回答三件事：

1. 这一轮何时开始
2. 这一轮产生了哪些 item
3. 这一轮为何结束

#### 原则 C：Item 是最小可渲染/可恢复/可审计单位

任何需要被 UI 展示、历史持久化、审计回放、恢复续跑的实体，都必须先落到 Item。

#### 原则 D：新协作工具族是一等公民

协作工具面直接对齐 Codex：

1. `spawn_agent`
2. `send_input`
3. `resume_agent`
4. `wait_agent`
5. `close_agent`

`agent.delegate` 只保留 compat alias，不再作为目标模型的一部分。

#### 原则 E：旧字段只做镜像，不再做裁决

以下字段可以保留，但只允许由新事实源镜像生成：

1. `mainDoc.workflowV1`
2. `mainDoc.compositeTaskV1`
3. `stickyActiveSkillIds`
4. `run.end.executionReport.runState`

#### 原则 F：Phase 1 就先打 adapter

任何仍依赖旧字段的调用点，Phase 1 就要接到新事实源上。

不允许：

1. 先建新状态
2. 再让旧逻辑继续各玩各的
3. 最后再统一清理

### 3.2 迁移后的事实源矩阵

| 语义 | 新事实源 | 旧镜像/兼容层 |
|---|---|---|
| 当前会话是否等待用户 | `ThreadRecord.waitingFor / waiting` | `mainDoc.workflowV1.status` |
| 当前 turn 是否完成 | `TurnRecord.status / reason / reasonCodes` | `run.end` |
| 本轮发生了哪些动作 | `ItemRecord[]` | `tool.call / tool.result / subagent.start / subagent.done` |
| 当前激活 skill | `ThreadRecord.activeSkillRefs + TurnStart.skillRefs` | `activeSkillIds / stickyActiveSkillIds` |
| 当前存在 proposal | `FileChangeItem / ApprovalItem` | `ToolBlockStep.applyPolicy` |
| 当前存在 collab agent | `ThreadRecord.activeCollabAgents + CollabItem` | `subagent.start / subagent.done` |
| 当前续跑任务态 | `TaskStateV2` | `workflowV1 + compositeTaskV1 + runStatePatch` |

### 3.3 目标共享类型

建议新增：

1. `packages/shared/src/runtime/thread-turn-item.ts`

#### 3.3.1 ThreadRecord

```ts
export type ThreadWaitingFor = "none" | "user" | "approval";

export type ThreadRecord = {
  id: string;
  convId?: string | null;
  status: "idle" | "running" | "waiting" | "completed" | "failed";
  waitingFor: ThreadWaitingFor;
  waiting?: {
    kind: "clarify" | "proposal" | "approval" | "resume_or_narrow" | "login_or_choice";
    question?: string;
    replyHint?: string;
    sourceTurnId?: string;
    updatedAt: string;
  } | null;
  activeSkillRefs: SkillRef[];
  activeCollabAgents: CollabAgentRef[];
  pendingProposalIds: string[];
  pendingApprovalIds: string[];
  taskState?: TaskStateV2 | null;
  createdAt: string;
  updatedAt: string;
};
```

#### 3.3.2 TurnRecord

```ts
export type TurnRecord = {
  id: string;
  threadId: string;
  seq: number;
  status: "in_progress" | "completed" | "failed" | "aborted" | "interrupted";
  startedAt: string;
  completedAt?: string;
  reason?: string;
  reasonCodes: string[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  } | null;
  itemIds: string[];
  executionReport?: Record<string, unknown> | null;
};
```

#### 3.3.3 ItemRecord

```ts
export type ItemRecord =
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | FileChangeItem
  | ApprovalItem
  | CollabItem
  | ProgressItem;

export type ItemBase = {
  id: string;
  threadId: string;
  turnId: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  createdAt: string;
  updatedAt: string;
};
```

#### 3.3.4 SkillRef

```ts
export type SkillRef = {
  id: string;
  source: "builtin" | "user" | "admin";
  activation: "explicit" | "auto" | "sticky";
  scope: "thread" | "turn";
  configPath?: string | null;
  enabled: boolean;
};
```

#### 3.3.5 CollabAgentRef / CollabCallKind

```ts
export type CollabAgentRef = {
  threadId: string;
  agentId: string;
  agentName?: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed";
};

export type CollabCallKind =
  | "spawn_agent"
  | "send_input"
  | "resume_agent"
  | "wait_agent"
  | "close_agent";
```

#### 3.3.6 CollabAgentSessionRecord

迁移前的 `agent.delegate -> LegacySubAgentBridge.execute(...)` 本质上还是一次性子 run。

为了真正接住 `send_input / resume_agent / wait_agent / close_agent`，必须补一个可持久化 session 模型：

```ts
export type CollabAgentSessionRecord = {
  id: string;
  parentThreadId: string;
  childThreadId: string;
  agentId: string;
  role?: string;
  status: "running" | "waiting" | "completed" | "failed" | "closed";
  inbox: Array<{
    id: string;
    createdAt: string;
    kind: "user_message" | "system_message" | "tool_result";
    payload: Record<string, unknown>;
  }>;
  lastDeliveredInboxItemId?: string;
  waitState?: {
    kind: "join" | "user" | "approval";
    updatedAt: string;
  } | null;
  closeReason?: string | null;
  createdAt: string;
  updatedAt: string;
};
```

#### 3.3.7 TaskStateV2

```ts
export type TaskStateV2 = {
  runIntent?: "auto" | "writing" | "rewrite" | "polish" | "analysis" | "ops";
  workflow?: {
    kind?: string;
    status?: "running" | "waiting_user" | "waiting_approval" | "done" | "failed";
    updatedAt?: string;
  } | null;
  compositeTask?: Record<string, unknown> | null;
  pendingArtifacts?: Array<{
    id: string;
    kind: string;
    status: "pending" | "used" | "discarded";
    pathHint?: string;
    updatedAt?: string;
  }>;
};
```

## 4. 协议与 Schema

当前不切 JSON-RPC，继续用现有 WS/SSE 事件总线，但协议层新增结构化实体和固定 payload schema。

### 4.1 `startGatewayRun` 请求体 schema

Desktop 发给 Gateway 的请求体要从“散装字段”收敛成如下结构。

```ts
export type StartGatewayRunPayloadV2 = {
  convId?: string;
  threadId?: string;
  mode: "agent" | "chat";
  model: string;
  opMode?: "creative" | "assistant";
  prompt: string;
  images?: Array<{
    id?: string;
    mimeType?: string;
    path?: string;
    base64DataUrl?: string;
  }>;
  targetAgentIds?: string[];
  kbMentionIds?: string[];

  skillRefs?: SkillRef[];

  builtinOverrides?: Record<string, { enabled?: boolean }>;
  userSkillManifests?: SkillManifest[];

  threadSnapshotHint?: {
    threadId?: string;
    activeSkillRefs?: SkillRef[];
    waitingFor?: "none" | "user" | "approval";
    pendingArtifactIds?: string[];
    collabSessionIds?: string[];
    collabSessions?: CollabAgentSessionRecord[];
  };
};
```

规则：

1. `ChatArea.tsx` 在解析 `@skill` 后必须优先构造 `skillRefs`
2. `skillRefs + threadSnapshotHint.activeSkillRefs` 是当前唯一 skill 输入契约
3. Gateway 最终要返回标准化 `thread.snapshot`
4. 上下文构建以 `thread.activeSkillRefs` 为准，不再依赖 `activeSkillIds`

### 4.2 `thread.snapshot` schema

Gateway 每次 turn 开始、turn 结束、skills 变化、waiting 变化、collab 状态变化时，都可以发 `thread.snapshot`。

```ts
export type ThreadSnapshotEvent = {
  thread: ThreadRecord;
  currentTurn?: TurnRecord | null;
  items?: ItemRecord[];
  collabSessions?: CollabAgentSessionRecord[];
  activeItemIds?: string[];
  stream?: {
    snapshotSeq: number;
    cursor: string;
    replaceStrategy: "replace";
  };
  emittedAt: string;
};
```

规则：

1. Desktop 端的 thread 主状态只能从 `thread.snapshot` 或 `thread.waiting.updated` / `skills.updated` reducer 更新
2. `items` 为 authoritative replace 语义，不再使用 `recentItems + legacyProjection`
3. `conversationStore` 与 `runTarget` 必须持久化 `thread / turns / items / collabSessions`

### 4.3 事件生成、补发与 reducer 链

光有新事件名不够，必须把“谁产出、何时补发、断线后如何恢复”写清楚。

#### 4.3.1 生成时机

1. `runFactory.ts`
   - 发 `turn.started`
   - 在 turn 结束时发 `turn.completed`
   - 在 run 开始/结束及关键状态变化时发 `thread.snapshot`
2. `itemEmitter.ts`
   - 发 `item.started / item.delta / item.completed`
3. `threadState.ts`
   - 在 waiting / skills / collab / pending proposal 变化时触发 `thread.snapshot`

#### 4.3.2 Desktop reducer 链

Desktop 不能继续只围绕 `steps[]` 收消息。

必须形成：

1. `wsTransport.ts` 只负责解析和分发事件
2. `threadProjection.ts` 负责 entity reducer
3. `runStore.ts` 保存 `thread / turns / items`
4. `Step[]` 由 `items[]` 投影生成

#### 4.3.3 断线与重连补发

Phase 1 就定义恢复契约：

```ts
type StreamResumeCursor = {
  threadId: string;
  lastSnapshotSeq: number;
  lastCursor?: string;
};
```

规则：

1. Desktop 每次应用 `thread.snapshot` 后都更新 `lastSnapshotSeq`
2. WS 重连时，Desktop 带上 `StreamResumeCursor`
3. Gateway 若能增量补发则补发 `thread.snapshot + missed item/turn events`
4. Gateway 若无法增量补发，则至少重发最新完整 `thread.snapshot`
5. Desktop 收到 `replacePending=true` 的 snapshot 后，必须用实体 reducer 做幂等覆盖

### 4.4 新事件与旧事件并存规则

#### 4.4.1 新事件

新增：

1. `thread.snapshot`
2. `turn.started`
3. `turn.completed`
4. `item.started`
5. `item.delta`
6. `item.completed`
7. `thread.waiting.updated`
8. `skills.updated`

#### 4.4.2 旧事件兼容

Phase 1 继续保留：

1. `run.start`
2. `run.end`
3. `tool.call`
4. `tool.result`
5. `subagent.start`
6. `subagent.done`

兼容原则：

1. Gateway 先产出新实体，再桥接旧事件
2. Desktop 优先消费新事件
3. 旧事件只用于旧组件 fallback 和历史兼容

### 4.5 Collab 工具合同

#### 4.5.1 目标工具面

协作工具总表统一为：

1. `spawn_agent`
2. `send_input`
3. `resume_agent`
4. `wait_agent`
5. `close_agent`

#### 4.5.2 子 agent session/thread 持久化前置

在当前代码里，`LegacySubAgentBridge` 直接启动子 runtime、过滤 `run.end`、把事件塞回父流，还没有：

1. 可恢复的 child thread 句柄
2. inbox
3. wait / close 语义
4. 可靠的并行 waiter key

所以本 spec 明确把 `CollabAgentSessionRecord` 作为前置。

没有它，就不允许宣称 `wait_agent / close_agent` 已落地。

authoritative split：

1. Gateway 负责 live session 状态
2. Desktop `RunSnapshotV2` 负责 durable snapshot
3. 恢复 run 时，Desktop 通过 `threadId + threadSnapshotHint.collabSessionIds` 提示 Gateway 重建 live session 视图

#### 4.5.3 `spawn_agent`

```ts
type SpawnAgentArgs = {
  agent_type?: string;
  message?: string;
  items?: Array<{ type?: string; text?: string; path?: string; image_url?: string; name?: string }>;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  fork_context?: boolean;
};
```

执行要求：

1. 创建 child thread / child turn
2. 创建 `CollabAgentSessionRecord`
3. 创建 `CollabItem(status=in_progress, tool="spawn_agent")`
4. 将 child agent 写入 `ThreadRecord.activeCollabAgents`
5. 发 `thread.snapshot`
6. 再桥接 `subagent.start`

#### 4.5.4 其余协作工具

```ts
type SendInputArgs = { id: string; message?: string; items?: unknown[]; interrupt?: boolean };
type ResumeAgentArgs = { id: string };
type WaitAgentArgs = { ids: string[]; timeout_ms?: number };
type CloseAgentArgs = { id: string };
```

统一规则：

1. 所有协作工具调用都必须形成 `CollabItem`
2. 所有状态变化都必须更新 `ThreadRecord.activeCollabAgents`
3. `wait_agent` 结果必须体现在 child thread/turn/item 状态里，而不是只回一段文本
4. `send_input` 必须写入 `CollabAgentSessionRecord.inbox`
5. `resume_agent` 必须从 session/inbox 恢复，而不是重新伪造一次 `spawn_agent`
6. `close_agent` 必须落 `closeReason` 并清理 active session

#### 4.5.5 `agent.delegate` compat alias

`agent.delegate` 只允许做参数翻译：

```ts
agent.delegate({ agentId, task, context, inputArtifacts, acceptanceCriteria })
  -> spawn_agent({ agent_type, message, items, fork_context: true })
```

约束：

1. 不得继续给 `agent.delegate` 增加独有语义
2. prompt / router / tool exposure 不再默认暴露它
3. 只保留给历史对话回放、旧 prompt、审计兼容使用

### 4.6 Skills 合同

#### 4.6.1 输入与裁决

规则：

1. Desktop 只负责声明显式输入 `skillRefs`
2. Gateway 负责合并 `skillRefs + auto activation + sticky shadow`
3. Gateway 返回的 `thread.activeSkillRefs` 是唯一裁决结果

#### 4.6.2 Skill 清单来源与 `SkillRef -> Manifest` 绑定

当前 Gateway 真实依赖的是：

1. Desktop 上传 `userSkillManifests`
2. Desktop 上传 `builtinOverrides`
3. Gateway 本地内置 manifests

而 `activateSkills()` 当前消费的也是 `SkillManifest[]`，不是 `SkillRef[]`。

因此本次不是“用 SkillRef 替掉 manifest”，而是：

1. `SkillManifest` 继续代表“技能定义与触发规则”
2. `SkillRef` 代表“某个线程/某轮已激活的技能引用”
3. `SkillRef.id` 必须与 `SkillManifest.id` 一一对应

原始设计建议新增：

```ts
type SkillCatalogSnapshot = {
  version: string;
  manifests: SkillManifest[];
  builtinOverrides?: Record<string, { enabled?: boolean }>;
};
```

规则：

1. Phase 1-3 期间，Desktop 仍继续上传 `userSkillManifests + builtinOverrides`
2. Gateway 基于这份 catalog 做 activation
3. Thread 只持久化 `SkillRef[]`，不持久化整份 manifest
4. manifest 变化后，Gateway 重新计算 active skillRefs，并发 `skills.updated`

#### 4.6.3 `skills.updated` schema

```ts
type SkillsUpdatedEvent = {
  threadId: string;
  activeSkillRefs: SkillRef[];
  catalogVersion?: string;
  reasonCodes: string[];
  emittedAt: string;
};
```

#### 4.6.4 `skillRefs` 与 sticky 的双写时机

Phase 1-2 双写规则必须固定，否则越迁越乱：

1. 用户显式 `@skill` 时：
   - `ChatArea.tsx` 构造 `skillRefs`
   - 同时只把非 workflow skill 写入 `stickyActiveSkillIds` shadow
2. Gateway 返回 `thread.snapshot.activeSkillRefs` 后：
   - Desktop 以它为准回填 shadow
3. workflow 类型 skill：
   - 可以出现在 `skillRefs`
   - 不写入 sticky shadow
4. 非显式提及的 auto skill：
   - 只由 Gateway 决定
   - Desktop 不得自行写 sticky

### 4.7 Waiting 合同

#### 4.7.1 唯一可写入口

Thread waiting 主状态只能由以下两类事件更新：

1. `thread.snapshot`
2. `thread.waiting.updated`

#### 4.7.2 heuristic 边界

`wsTransport.ts` 中的 assistant 文本判定逻辑必须改造成：

```ts
type WaitingCandidate = {
  source: "assistant_heuristic";
  question?: string;
  replyHint?: string;
  confidence?: number;
};
```

规则：

1. heuristic 只能写 candidate log / debug info
2. heuristic 不得直接 patch 主状态镜像或 thread state
3. heuristic 不得直接 patch `ThreadRecord`
4. 只有 server 发来的 thread reducer 事件才可写主状态

兼容边界：

1. 若本轮收到了任意 `thread.*` 新事件，则禁止 heuristic fallback 写主状态
2. 若是纯旧流且没有任何新事件，heuristic 也只能生成 candidate，不得再更新主 store

#### 4.7.3 Gateway 与 prompt contract 同步清理

waiting 不是只改 Desktop。

必须同步清理：

1. `GatewayRuntime.ts` 中直接读 `workflowV1` / waiting heuristic 的逻辑
2. `runFactory.ts` system prompt 中“由模型自己写 workflowV1=waiting_user”的契约

新契约应改为：

1. 模型通过结构化工具或 `run.done(reason=clarify_waiting/proposal_waiting)` 表达等待意图
2. Gateway 将其收敛成 `thread.waiting.updated`
3. Desktop 不再从 assistant 文本推断并写回 `workflowV1`

### 4.8 Proposal-first / Item Action 合同

Keep / Undo / Approve / Decline 的 action owner 必须统一。

```ts
type ItemAction =
  | { itemId: string; action: "keep"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "undo"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "approve"; actor: "user" | "system"; at: string }
  | { itemId: string; action: "decline"; actor: "user" | "system"; at: string };
```

规则：

1. `FileChangeItem` / `ApprovalItem` 持有业务真相
2. `Step` 只是 `ItemRecord` 投影
3. `ToolBlock.tsx` 只能 dispatch `ItemAction`
4. `conversationStore` 不能单独保存一套可执行 `apply/undo` 逻辑

#### 4.8.2 可执行动作协议

当前 `ToolBlockStep` 的 `apply/undo` 是内存闭包，历史快照加载后会被清掉。

所以 item 化后，必须把“可执行动作”也变成可序列化协议：

```ts
type ItemActionSpec = {
  executor: "desktop.fs" | "desktop.mcp" | "gateway.noop";
  applyOp?: Record<string, unknown>;
  undoOp?: Record<string, unknown>;
  canReplayAfterReload: boolean;
};
```

规则：

1. `FileChangeItem` / `ApprovalItem` 持久化的是 `ItemActionSpec`
2. 运行时闭包只能作为 `ItemActionSpec -> handler` 的临时 adapter
3. reload 后由 executor registry 根据 `ItemActionSpec` 重建可执行动作
4. 若 `canReplayAfterReload=false`，UI 必须显式展示“仅可查看，不可继续 Keep/Undo”

#### 4.8.3 产品语义收敛（并入的新 spec）

`Keep/Undo` 不是产品需求，只是迁移期内部 action 术语。

真正必须保留的是两层能力：

1. proposal-first：高风险改动先提案，再采纳
2. rollback：已应用改动可回滚

因此 UI 语义改为：

| Item 类型 | 内部 action | 用户可见文案 |
|---|---|---|
| `FileChangeItem`（未应用） | `keep` / `decline` | `应用更改` / `放弃提案` |
| `FileChangeItem`（已应用） | `undo` | `回滚更改` |
| `ApprovalItem` | `approve` / `decline` | `批准` / `驳回` |
| 内容类提案（非文件） | `keep` / `decline` | `采纳` / `放弃` |
| 低风险自动应用动作 | 无 | 默认不展示按钮 |

规则：

1. `ToolBlock` 可以在迁移期继续承载这些动作，但它只是过渡容器，不应成为长期主交互入口
2. 最终产品不应在主界面继续暴露通用英文 `Keep / Undo`
3. 内部 reducer / protocol 仍可继续使用 `keep / undo / approve / decline` 作为稳定动作名
4. 后续若进入“内容团队”主界面，应把这些动作投放到更贴近业务的提案卡、审批卡、差异卡，而不是裸工具日志

## 5. 迁移设计

### 5.1 Adapter 层优先

Phase 1 必须先做 adapter，让旧读点先读新事实源。

建议新增：

1. `apps/gateway/src/agent/runtime/threadState.ts`
2. `apps/gateway/src/agent/runtime/itemEmitter.ts`
3. `apps/desktop/src/agent/threadProjection.ts`

实现回填：

1. `threadState.ts / itemEmitter.ts / threadProjection.ts` 已落地
2. 独立的 `legacyProjection.ts` 方案已被放弃，当前实现直接以新事实源驱动 Desktop/Gateway reducer 与 snapshot

职责：

1. `threadState.ts`
   - 管理 `ThreadRecord`
   - 提供 `createThreadState / updateThreadWaiting / updateActiveSkills / upsertCollabAgent`
2. `itemEmitter.ts`
   - 负责 `item.started / item.delta / item.completed`
   - 同步桥接 `tool.call / tool.result / subagent.start / subagent.done`
3. `threadProjection.ts`
   - Desktop 统一应用 `thread.snapshot / thread.waiting.updated / skills.updated`

### 5.2 旧读点改造原则

以下文件 Phase 1 就要改为“优先读新、旧字段 fallback”：

1. `packages/agent-core/src/runMachine.ts`
2. `apps/desktop/src/agent/gatewayAgent.ts`
3. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`

具体要求：

1. 续跑/intent 判定先看 `TaskStateV2.workflow`
2. waiting 判定先看 `ThreadRecord.waitingFor`
3. active skill 判定先看 `ThreadRecord.activeSkillRefs`
4. `workflowV1` 只作为 fallback

### 5.3 会话持久化与后台 run 投影

#### 5.3.1 `RunSnapshot` 扩展

`apps/desktop/src/state/conversationStore.ts` 中的 `RunSnapshot` 需要新增：

```ts
type RunSnapshotV2 = RunSnapshot & {
  thread?: ThreadRecord | null;
  turns?: TurnRecord[];
  items?: ItemRecord[];
  collabSessions?: CollabAgentSessionRecord[];
  activeItemIds?: string[];
};
```

规则：

1. 历史快照可裁剪 `items`，但必须保留 thread 主态
2. 不允许只保留 steps/logs 而丢掉 thread.waiting / activeSkillRefs / activeCollabAgents
3. 对支持 `wait_agent / close_agent` 的会话，必须同步持久化 `collabSessions`
4. Gateway live state 丢失后，应以 Desktop snapshot 中的 `collabSessions` 作为恢复线索

#### 5.3.2 `runTarget.ts`

后台 run buffer 需要同步扩展：

1. `RunBuffer.thread`
2. `RunBuffer.turns`
3. `RunBuffer.items`
4. `RunBuffer.collabSessions`

flush 时：

1. 先 merge thread/turn/item
2. 再 merge collabSessions
3. 再从 items 投影 steps
4. 不允许只把 steps 回写到 snapshot

### 5.4 Collab 内部执行迁移

这部分不能只写“引入 collabRuntime”，必须接住现有真实路径。

#### 5.4.1 新增 `collabRuntime.ts`

建议新增：

1. `apps/gateway/src/agent/runtime/collabRuntime.ts`

职责：

1. 管理协作工具调用生命周期
2. 创建 child thread / turn
3. 生成 `CollabItem`
4. 更新 `ThreadRecord.activeCollabAgents`
5. 桥接旧 `subagent.start/done`

#### 5.4.2 `writingAgentRunner.ts` 的迁移要求

`apps/gateway/src/agent/writingAgentRunner.ts` 不能被绕开，必须收敛为 `collabRuntime` 的真实执行 port。

最低要求：

1. 把其中的工具裁剪、MCP capability scope、budget/abort 逻辑抽成可复用执行器
2. 把 style_imitate skill 继承与 context hint 注入抽成独立 helper
3. 把 `subagent.start/done` 改成由 `CollabItem + thread snapshot` 驱动，再向旧事件桥接
4. 继续保留原始用户消息注入和 acceptance criteria 传递能力

#### 5.4.3 `LegacySubAgentBridge.ts`

迁移后它只做 compat adapter：

1. 收到 `agent.delegate`
2. 翻译参数
3. 调 `collabRuntime.spawnCompat`
4. 不再自己直接维护 UI 语义

### 5.5 Prompt / Router / Tool Exposure 收敛前置

这一步是硬前置，不是“顺手改一下”。

当前运行时存在明显自相矛盾：

1. `GatewayRuntime` 仍会用 soft guidance 引导 orchestrator 调 `agent.delegate`
2. `runFactory` 启动阶段又会删掉 `agent.delegate`
3. `packages/tools` 里还把它标成已移除

所以 Phase 1 必须同步做三件事：

1. `runFactory` 的 system prompt 改成优先使用新 collab 工具族
2. `GatewayRuntime` 的 steering / soft guidance 改成引用 `spawn_agent`
3. tool exposure / allowlist 与 prompt 保持一致

没做完这三件事前，不允许切默认工具面。

### 5.6 Tool Exposure / Allowlist / Capability 链改造

Phase 1 就要把新协作工具族接进真实工具暴露链。

必须修改：

1. `packages/tools/src/index.ts`
2. `apps/gateway/src/agent/toolCatalog.ts`
3. `apps/gateway/src/agent/serverToolRunner.ts`

具体要求：

1. 新增 `spawn_agent / send_input / resume_agent / wait_agent / close_agent`
2. `toolCatalog.ts` 的 capability 识别从 `delegate` 收敛为 `collab`
3. `serverToolRunner.ts` 默认 allowlist 改为新工具族
4. `agent.delegate` 从默认主暴露面移出，仅保留 alias decode

### 5.7 Skills 运行时改造

必须修改：

1. `apps/desktop/electron/skill-loader.mjs`
2. `apps/desktop/src/ui/components/ChatArea.tsx`
3. `apps/desktop/src/agent/gatewayAgent.ts`
4. `apps/gateway/src/agent/runFactory.ts`
5. `packages/agent-core/src/skills.ts`

具体要求：

1. `ChatArea.tsx` 发 `skillRefs`
2. `wsTransport.ts` 继续发 `userSkillManifests + builtinOverrides`，直到 Gateway 有独立 catalog 源
3. `gatewayAgent.ts` 上下文 pack 优先读 `thread.activeSkillRefs`
4. `runFactory.ts` 合并显式、auto、sticky shadow，并回发 `skills.updated`
5. `skills.ts` 的激活裁决函数接受 `SkillRef[] + SkillManifest[]`

### 5.8 Waiting / Proposal / Approval 收敛

必须修改：

1. `apps/desktop/src/agent/wsTransport.ts`
2. `apps/desktop/src/components/ToolBlock.tsx`
3. `apps/desktop/src/state/runStore.ts`
4. `apps/desktop/src/state/conversationStore.ts`

具体要求：

1. waiting heuristic 改成 candidate-only
2. Keep/Undo 改成 item action
3. Step 改成由 item 投影生成
4. snapshot 持久化 item 状态，而不是只持久化 tool step status
5. Gateway waiting heuristics 与 prompt contract 同步切换到 thread reducer

## 6. Phase 计划

本次 phase 顺序按“先让全链路读到新事实源，再逐步消除旧桥”的原则排。

### Phase 1：共享类型 + adapter + 持久化 + 新协作工具暴露

目标：

1. 建立 `Thread/Turn/Item` 类型骨架
2. 让旧读点开始读新事实源
3. 让新协作工具族进入真实 tool exposure / allowlist / server execution 链
4. 让 conversation/runTarget 能持久化 thread
5. 把 prompt/router 与工具面先对齐，消除 `agent.delegate` 自相矛盾

新增文件：

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/gateway/src/agent/runtime/threadState.ts`
3. `apps/gateway/src/agent/runtime/itemEmitter.ts`
4. `apps/gateway/src/agent/runtime/legacyProjection.ts`
5. `apps/desktop/src/agent/threadProjection.ts`

必须修改：

1. `apps/gateway/src/agent/runFactory.ts`
2. `apps/gateway/src/agent/turnEngine.ts`
3. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
4. `packages/agent-core/src/runMachine.ts`
5. `apps/desktop/src/agent/gatewayAgent.ts`
6. `apps/desktop/src/state/runStore.ts`
7. `apps/desktop/src/state/conversationStore.ts`
8. `apps/desktop/src/agent/runTarget.ts`
9. `apps/desktop/src/agent/wsTransport.ts`
10. `packages/tools/src/index.ts`
11. `apps/gateway/src/agent/toolCatalog.ts`
12. `apps/gateway/src/agent/serverToolRunner.ts`
13. `apps/gateway/src/agent/runFactory.ts` 中的 system prompt / workflow 契约

Phase 1 还必须定义：

1. `thread.snapshot` 生成时机
2. 断线重连补发策略
3. Desktop entity reducer
4. `CollabAgentSessionRecord` 持久化位置

Phase 1 验收：

1. `thread.snapshot` 能被存储和恢复
2. 旧 intent/续跑逻辑已优先读取新事实源
3. 新工具族已能进入 tool catalog / allowlist
4. 旧事件还可继续跑
5. prompt / router / tool exposure 不再互相打架

### Phase 2：Collab 一等公民

目标：

1. 协作工具调用直接形成 `CollabItem`
2. 子 agent 有 child thread / child turn / activeCollabAgents
3. `writingAgentRunner.ts` 的真实子 agent 执行逻辑被吸纳进 collab 主路径
4. session/inbox/wait/close 语义真实存在，不再是一轮性子 run

新增文件：

1. `apps/gateway/src/agent/runtime/collabRuntime.ts`

必须修改：

1. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
2. `apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts`
3. `apps/gateway/src/agent/writingAgentRunner.ts`
4. `apps/desktop/src/agent/wsTransport.ts`
5. `apps/desktop/src/state/runStore.ts`

Phase 2 验收：

1. `spawn_agent` 直接可用
2. `agent.delegate` 仍能通过 shim 兼容
3. UI / 审计看到的是 `CollabItem`，不是裸 `subagent.start/done`
4. 并行子 agent 不串泡
5. `wait_agent / close_agent` 已由 session 模型支撑

### Phase 3：Skills 一等公民

目标：

1. `skillRefs` 成为显式输入
2. `thread.activeSkillRefs` 成为唯一裁决结果
3. sticky 只剩影子，不再参与主裁决

必须修改：

1. `apps/desktop/electron/skill-loader.mjs`
2. `apps/desktop/src/ui/components/ChatArea.tsx`
3. `apps/desktop/src/agent/gatewayAgent.ts`
4. `apps/gateway/src/agent/runFactory.ts`
5. `packages/agent-core/src/skills.ts`

Phase 3 验收：

1. `@style_imitate` 显式唤起可用
2. 下一轮不 mention 时，thread-level sticky skill 仍正常续跑
3. workflow skill 不被误写入 sticky
4. context pack 已以 `thread.activeSkillRefs` 为准
5. 请求体过渡期仍兼容 `userSkillManifests + builtinOverrides`

### Phase 4：Waiting / Proposal / Approval 收敛

目标：

1. `run.end` 不再承担“推断世界状态”的职责
2. waiting 只能经 thread reducer 写入
3. Keep/Undo 只能经 item reducer 写入
4. 产品层不再把 `Keep / Undo` 当成最终用户术语

必须修改：

1. `apps/desktop/src/agent/wsTransport.ts`
2. `apps/desktop/src/components/ToolBlock.tsx`
3. `apps/desktop/src/state/runStore.ts`
4. `apps/desktop/src/state/conversationStore.ts`
5. `docs/specs/thread-waiting-user-state-v0.1.md`

Phase 4 验收：

1. `run.end` 不再直接 patch workflow/main state
2. proposal-first 以 `FileChangeItem / ApprovalItem` 为准
3. 历史恢复后 Keep/Undo 状态一致
4. UI 侧 proposal action 已收敛为业务文案：`应用更改 / 回滚更改 / 批准 / 驳回 / 采纳 / 放弃`

## 7. 文件级落地清单

### 7.1 必改文件

#### Gateway

1. `apps/gateway/src/agent/runFactory.ts`
2. `apps/gateway/src/agent/turnEngine.ts`
3. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
4. `apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts`
5. `apps/gateway/src/agent/writingAgentRunner.ts`
6. `apps/gateway/src/agent/toolCatalog.ts`
7. `apps/gateway/src/agent/serverToolRunner.ts`
8. `packages/agent-core/src/runMachine.ts`
9. `packages/agent-core/src/skills.ts`
10. `packages/tools/src/index.ts`

#### Desktop

1. `apps/desktop/src/agent/wsTransport.ts`
2. `apps/desktop/src/agent/gatewayAgent.ts`
3. `apps/desktop/src/agent/runTarget.ts`
4. `apps/desktop/src/state/runStore.ts`
5. `apps/desktop/src/state/conversationStore.ts`
6. `apps/desktop/src/ui/components/ChatArea.tsx`
7. `apps/desktop/src/components/ToolBlock.tsx`
8. `apps/desktop/electron/skill-loader.mjs`

### 7.2 新增文件

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/gateway/src/agent/runtime/threadState.ts`
3. `apps/gateway/src/agent/runtime/itemEmitter.ts`
4. `apps/gateway/src/agent/runtime/legacyProjection.ts`
5. `apps/desktop/src/agent/threadProjection.ts`
6. `apps/gateway/src/agent/runtime/collabRuntime.ts`

## 8. 验证清单

### 8.1 Sub-agent / Collab

1. `spawn_agent` 单 agent 执行时：
   - 生成 child thread
   - 生成 `CollabItem`
   - `thread.activeCollabAgents` 正确更新
2. 并行两个子 agent 时：
   - UI 不串泡
   - 状态不只靠 `agentId` 文本路由
3. 子 agent 失败时：
   - child turn / collab item / parent thread 状态一致

### 8.2 Skills

1. `@style_imitate` 发起后请求体里能看到 `skillRefs`
2. 请求体过渡期里仍能看到 `userSkillManifests + builtinOverrides`
3. Gateway 返回 `thread.snapshot.activeSkillRefs`
4. workflow skill 不写 sticky shadow
5. context pack 续跑时不再依赖 `ACTIVE_SKILLS(JSON)` 单独兜底

### 8.3 Waiting / Proposal

1. 浏览器登录类任务结束后：
   - Thread 进入 `waitingFor=user`
   - Desktop 未从 assistant 文本直接 patch 主状态
2. proposal-first 文件提案：
   - 形成 `FileChangeItem`
   - Keep/Undo 通过 item action + action spec 生效
3. 重启桌面后：
   - waiting / proposal / collab / active skills 仍可恢复

### 8.4 兼容

1. 老对话里的 `agent.delegate` 仍能跑
2. 纯旧事件流仍能显示
3. 但所有新流程都优先消费新实体

## 9. 风险与防护

### 风险 1：新旧事件双写导致 UI 重复渲染

防护：

1. Item 必须有稳定 id
2. Desktop 先做 item 去重，再做 step 投影

### 风险 2：`workflowV1` 与 `ThreadRecord` 镜像不同步

防护：

1. 所有 legacy 字段只能通过 projection helper 写入
2. 禁止散写 `workflowV1.status`

### 风险 3：proposal-first 迁移期出现 Keep/Undo 双写

防护：

1. item reducer 是唯一 action owner
2. ToolBlock 只 dispatch，不持有业务状态

### 风险 4：只改 `GatewayRuntime`，漏掉 `writingAgentRunner.ts`

防护：

1. Phase 2 验收必须覆盖子 agent skill 继承、context 注入、budget 逻辑
2. 这些能力未迁完前，不允许宣称 collab 已完成

### 风险 5：waiting heuristic 偷偷继续写主状态

防护：

1. 代码层新增 helper 限制
2. `wsTransport.ts` 中 heuristic 只能返回 candidate

### 风险 6：SkillRef 方案与 manifest 源脱节

防护：

1. Phase 1-3 保留 `userSkillManifests + builtinOverrides`
2. `SkillRef.id` 与 `SkillManifest.id` 强制一一对应

### 风险 7：Keep/Undo 在 reload 后失去可执行能力

防护：

1. 引入 `ItemActionSpec`
2. 由 executor registry 在 reload 后重建 handler

## 10. 立即执行顺序

严格按这个顺序：

1. 新增共享 runtime 类型：`ThreadRecord / TurnRecord / ItemRecord / SkillRef / TaskStateV2`
2. Gateway 落 `threadState + itemEmitter`
3. Desktop `runStore / conversationStore / runTarget` 能持久化 thread/turn/item
4. `runMachine / gatewayAgent / GatewayRuntime` 先接 adapter，旧读点优先读新事实源
5. 先改 `runFactory` prompt 与 `GatewayRuntime` soft guidance，统一改讲 `spawn_agent`
6. `packages/tools / toolCatalog / serverToolRunner` 再接入新协作工具族
7. Gateway/WS 切到 `thread.snapshot / turn.* / item.*` 主链
8. 落 `collabRuntime`，并把 `writingAgentRunner.ts` 纳入主迁移链
9. 删除 `agent.delegate` 主路径
10. `ChatArea / wsTransport / gatewayAgent / skills.ts` 切到 `skillRefs + thread.activeSkillRefs + manifest catalog`
11. `wsTransport / ToolBlock / runStore` 把 waiting/proposal 收口到 thread/item reducer
12. 最后再清理 `workflowV1` 直读和 `run.end` 补丁职责

## 11. 完成度回填

- [x] Phase 1：共享类型 + adapter + 持久化 + 新协作工具暴露
  说明：Gateway/ Desktop 已完成 thread-turn-item 主链、旧读点 adapter、持久化，以及新协作工具族默认暴露
- [x] Phase 2：Collab 一等公民
  说明：`spawn_agent / send_input / resume_agent / wait_agent / close_agent` 已进入 collab 分类；`agent.delegate` 已从主路径删除
- [x] Phase 3：Skills 一等公民
  说明：`ChatArea -> startGatewayRun -> wsTransport -> runFactory -> activateSkills -> thread.activeSkillRefs` 已以 `skillRefs` 为主路径
- [x] Phase 4：Waiting / Proposal / Approval 收敛
  说明：candidate-only waiting、item action owner 与产品文案收口已落地；`Keep/Undo` 仅保留内部动作名
- [x] Gateway/Desktop 冒烟
- [x] 老事件兼容验证
  说明：`npm run -w @ohmycrab/gateway smoke:runtime-parity` 已覆盖 `spawn_agent` 主路径、waiting 收口、线程快照 replace 与协作主链
