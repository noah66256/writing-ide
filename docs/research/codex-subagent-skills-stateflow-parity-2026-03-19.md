# Codex Sub-Agent / Skills / 状态流 对齐研究（2026-03-19）

> 目的：在不纠结 Codex 桌面 UI 皮肤的前提下，评估 Crab 是否应该直接对标 `openai/codex` 的三块核心机制：
> 1. sub-agent
> 2. skills
> 3. 线程/回合/等待态状态流

## 0. 本次基线

### 0.1 Codex 参考源码已同步到最新

2026-03-19 已将本地参考仓库 `third_party/openai-codex` 从：

- `f41b1638c98deddd0d8f89d821999d30f73de599`

fast-forward 到：

- `334164a6f714c171bb9f6440c7d3cd04ec04d295`

同步命令：

```bash
git -C third_party/openai-codex fetch origin
git -C third_party/openai-codex pull --ff-only origin main
```

### 0.2 对这次研究最相关的 Codex 更新信号

从 `f41b163..334164a` 的增量里，和本文最相关的不是 UI 小修，而是这些方向仍在持续演进：

- `db89b73 Move TUI on top of app server (parallel code)`
- `347c6b1 Removed remaining core events from tui_app_server`
- `84f4e7b fix(subagents) share execpolicy by default`
- `33acc1e fix: sub-agent role when using profiles`
- `c04a0a7 fix: tui freeze when sub-agents are present`
- `18ad675 feat: improve skills cache key to take into account config layering`
- `1a9555e Cleanup skills/remote/xxx endpoints`

结论：Codex 的真实重心不是“桌面 UI 特效”，而是 **app-server 协议 + thread/turn/item 生命周期 + sub-agent / skills / approvals 的单核心收敛**。

## 1. 结论先行

结论：Crab **值得直接对标** Codex 的这三块，而且不只是“借灵感”，而是建议按协议层和运行时层去收敛。

但不是“整套照抄桌面端”。

更准确地说：

- **可以直接抄范式/合同**：
  - sub-agent 协议
  - skills 的显式注入/发现/配置/热更新协议
  - thread / turn / item 状态流
- **不能直接抄产品外壳**：
  - Codex 的桌面端 UI 交互只是 coding agent 视角，不等于 Crab 的“内容团队负责人”
- **最需要立刻改的不是 UI，而是事实源**
  - 现在 Crab 这三块都“有了”，但仍有双轨/镜像/heuristic 参与裁决的问题

一句话版：

> Crab 可以抄 Codex 的“骨架”，不该抄它的“皮肤”。

## 2. Codex 是否全开源

### 2.1 不是“桌面端整套壳都开源”

`openai/codex` 仓库主页把自己定义为 **Codex CLI**，并把 desktop app 当成一个“体验入口”：

- [README.md](/Users/noah/writing-ide/third_party/openai-codex/README.md#L1)
- [README.md](/Users/noah/writing-ide/third_party/openai-codex/README.md#L8)

本地参考仓库里明确能看到：

- `codex-rs/app-server`
- `codex-rs/tui`
- `codex-cli`

但看不到一个完整的 Electron/Swift 桌面壳源码目录。

因此，**不能下结论说“Codex 桌面端全开源”**。

### 2.2 但对 Crab 最重要的那层已经足够开源

Codex 对外公开的核心不是桌面壳，而是：

- app-server 协议
- thread / turn / item 生命周期
- skills 协议
- sub-agent / collab tools 协议

而 Crab 真正需要对标的，也正是这一层。

另外，许可是 Apache-2.0：

- [LICENSE](/Users/noah/writing-ide/third_party/openai-codex/LICENSE#L191)

因此：

- **思路、协议、结构都可以直接借**
- 如果真的拷贝源码实现，需要保留许可证与 NOTICE，并标注改动

## 3. Codex 的关键范式

### 3.1 Thread / Turn / Item 是第一事实源

Codex app-server 的生命周期非常清楚：

- `thread/start`
- `thread/resume`
- `thread/fork`
- `turn/start`
- 流式 `item/started` / `item/completed` / delta
- `turn/completed`

参考：

- [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L67)

它把“这一轮发生了什么”拆成结构化 item，而不是让 UI 去猜。

### 3.2 Skills 是显式输入项，不只是 prompt 里藏规则

Codex 的 skills 不是“系统 prompt 里塞一句话”，而是有完整协议：

- `skills/list`
- `skills/changed`
- `skills/config/write`
- turn 输入里显式加入 `skill` item

参考：

- [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L154)
- [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L442)

### 3.3 Sub-agent 也是显式协作工具，不是隐式递归 run

Codex 的多代理不是靠“内部偷偷再开一轮 run”，而是把协作动作本身显式化：

- `spawn_agent`
- `send_input`
- `resume_agent`
- `wait`
- `close_agent`

并在流式 item 中用 `collabToolCall` 表示。

参考：

- [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L773)

## 4. Crab 当前现状

## 4.1 Sub-agent：已经有能力，但仍是“桥接态”

Crab 不是没有 sub-agent。

现状证据：

- 内置子 Agent 定义已经很完整，有角色、system prompt、工具白名单、预算、触发词：
  - [subAgent.ts](/Users/noah/writing-ide/packages/agent-core/src/subAgent.ts#L15)
  - [subAgent.ts](/Users/noah/writing-ide/packages/agent-core/src/subAgent.ts#L53)
- `GatewayRuntime` 遇到 `agent.delegate` 时，会走 `LegacySubAgentBridge`：
  - [GatewayRuntime.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/GatewayRuntime.ts#L1501)
- `LegacySubAgentBridge` 会：
  - 建 sub-run id
  - 继承父 RunContext
  - 预算/超时控制
  - 发 `subagent.start` / `subagent.done`
  - 把子 agent 的 tool/assistant 事件注入父流
  - 复用父 waiters map
  - 最终返回 artifact
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L200)
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L308)
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L374)
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L432)

但它仍然是“桥接态”，不是 first-class 协议态：

- 文件名就叫 `LegacySubAgentBridge`
- 内部是“父 runtime 再包一个子 runtime”
- 注释明确写了 waiters 复用当前仅在“父子串行 + toolCallId 唯一”下安全，未来并行要改复合键
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L345)
- 工具总表里还写着“`agent.delegate` 已移除”，而运行时其实还在走
  - [index.ts](/Users/noah/writing-ide/packages/tools/src/index.ts#L1168)

这说明：

> Crab 的 sub-agent 已经“能跑”，但还没有被收敛成统一协议事实源。

## 4.2 Skills：已经不少，但激活与续跑还不是单一事实源

Crab 也不是没有 skills。

现状证据：

- `packages/agent-core/src/skills.ts` 已经有完整 SkillManifest、trigger、workflow、pipeline 声明：
  - [skills.ts](/Users/noah/writing-ide/packages/agent-core/src/skills.ts#L1)
  - [skills.ts](/Users/noah/writing-ide/packages/agent-core/src/skills.ts#L53)
  - [skills.ts](/Users/noah/writing-ide/packages/agent-core/src/skills.ts#L205)
- Desktop 在发起 run 前，会从用户 mention 中抽取 `mentionedSkillIds`
- 并把“非 workflow skill”写入 `stickyActiveSkillIds`，后续 run 自动带上
  - [ChatArea.tsx](/Users/noah/writing-ide/apps/desktop/src/ui/components/ChatArea.tsx#L1004)
  - [ChatArea.tsx](/Users/noah/writing-ide/apps/desktop/src/ui/components/ChatArea.tsx#L1024)

这说明 Crab 已经意识到一个关键问题：

> skill 不能只是“本轮一次性触发”，否则跨轮会断。

但当前实现仍有三个结构性问题：

1. **激活事实源分散**
   - Desktop 侧会算 `activeSkillIds`
   - Gateway / agent-core 侧也会再判一轮
   - 文档里已经多次提到这会导致丢 skill / 续跑断裂

2. **显式 skill item 不够一等公民**
   - 现在更像“mention → 提取 id → 随 run 参数带过去”
   - 还不是 Codex 那种“输入里显式有 `skill` item + 服务器负责解析/热更新/配置”

3. **workflow skill 续跑仍靠补丁策略**
   - 你们已经发明了 sticky、workflowV1、runStatePatch 等多层粘合
   - 这说明产品需求是真的存在
   - 也说明当前技能系统还没完全收敛成 session/thread 级事实源

## 4.3 状态流：已经开始抽象，但 Desktop 仍然在补 heuristic

Crab 这块的进展其实不小：

- Gateway 已经有简化版 `TurnEngine`
  - [turnEngine.ts](/Users/noah/writing-ide/apps/gateway/src/agent/turnEngine.ts#L1)
- 你们也已经写了 `Thread Waiting State v0.1`，明确提出“等待用户”应该是线程级事实源，不该靠自然语言猜
  - [thread-waiting-user-state-v0.1.md](/Users/noah/writing-ide/docs/specs/thread-waiting-user-state-v0.1.md#L1)

但当前 Desktop 仍然保留了明显的 heuristic 补位：

- `wsTransport` 在 `run.end` 时会根据最后一条 assistant 文本去推导 waiting patch
- 条件里直接用了 regex：
  - “请直接回复”
  - “登录完成后告诉我”
  - “选一个”
  - `looksLikeClarifyQuestions`
  - [wsTransport.ts](/Users/noah/writing-ide/apps/desktop/src/agent/wsTransport.ts#L397)
- Desktop 的主要事件面仍是：
  - `run.start`
  - `subagent.start`
  - `subagent.done`
  - `tool.call`
  - `tool.result`
  - `run.end`
  - [wsTransport.ts](/Users/noah/writing-ide/apps/desktop/src/agent/wsTransport.ts#L1151)

这和 Codex 的差距在于：

- Codex 是 `thread / turn / item`
- Crab 现在更像“run 级事件总线 + 一些 sticky 镜像 + heuristic 收口”

## 5. 对比判断

## 5.1 Sub-agent：建议直接对标 Codex，且优先级最高

原因：

- Crab 的产品定位本来就是“负责人 + 子 Agent”
- 你们现在已经有角色定义、budget、SSE、artifact、并行思路
- 但还缺一个真正稳定的协作协议层

建议直接借 Codex 的不是 UI，而是这些合同：

- `spawn_agent`
- `send_input`
- `resume_agent`
- `wait`
- `close_agent`
- `collabToolCall`
- parent thread / child thread / agent metadata

不建议继续扩大 `agent.delegate(task)` 这个单点工具的职责。

因为继续往里塞：

- inputArtifacts
- acceptanceCriteria
- 预算
- 角色切换
- 等待/恢复

最后只会变成一个越来越大的万能黑盒。

更好的方向是：

- 保留“负责人决定派谁”
- 但把**协作动作本身拆成 first-class tool / event**

## 5.2 Skills：建议直接对标 Codex，但要保留 Crab 的 workflow/pipeline 特性

Codex 的 skill 更偏“能力包 / 指令包”。
Crab 的 skill 还有一层更重的“写作闭环合同 / workflow / pipeline”。

所以这里不是简单照抄，而是“下层学 Codex，上层保留 Crab”：

- **下层对齐 Codex**
  - `skills/list`
  - `skills/changed`
  - `skills/config/write`
  - 显式 `skill` input item
  - 文件系统 watch / cache / 配置启停
- **上层保留 Crab**
  - `workflow` / `pipeline`
  - style contract
  - KB 绑定
  - 写作闭环 gate

换句话说：

> Codex 解决“skill 如何成为一等公民”；Crab 解决“skill 激活后怎么跑内容工作流”。

## 5.3 状态流：必须对标 Codex，不建议继续靠 run.end 补丁堆高

Codex 在这里最值得抄的不是具体字段名，而是分层：

- Thread：会话事实源
- Turn：本轮运行
- Item：本轮中发生的结构化事件/产物

Crab 当前的问题不是“没有状态”，而是：

- 事实源太多
  - run event
  - workflowV1
  - compositeTaskV1
  - sticky skills
  - waiting heuristics
  - todo / mainDoc
- 这些状态中，有些是事实源，有些是镜像，有些是临时补丁

建议对标 Codex 收敛为：

1. **Thread State**
   - 当前线程是否 waiting_user / waiting_approval
   - 当前激活的 sticky skills / active agents / selected MCP
2. **Turn State**
   - 本轮是否 running / completed / interrupted / failed
3. **Item Stream**
   - assistantMessage
   - reasoning
   - toolCall
   - fileChange
   - approvalRequest
   - subAgent / collab
   - progress checkpoint

然后：

- `workflowV1` 继续存在，但降为镜像/业务态
- `run.end` 不再承担“推断世界状态”的职责，只做 turn 收口

## 6. 推荐的落地路线

## Phase 1：先收 sub-agent 协议

目标：把 `agent.delegate` 从“黑盒工具”升级成“协作协议入口”。

建议：

- 新增显式协作工具族：
  - `agent.spawn`
  - `agent.message`
  - `agent.wait`
  - `agent.close`
- 为每个子 agent 建立 first-class run/thread 记录
- Desktop 不再只认 `subagent.start/done`
  - 改为渲染结构化 collab item

预期收益：

- 后续并行、安全、恢复、审计都会简单很多
- 负责人 + 子 Agent 的产品心智更稳定

## Phase 2：把 skills 收成“显式输入 + 服务器裁决”

目标：结束“Desktop 算一份 activeSkillIds，Gateway 再算一份”的双轨。

建议：

- 引入显式 `skill` input item
- Gateway 统一负责：
  - resolve
  - watch
  - list
  - enable/disable
  - cache invalidation
- Desktop 只负责：
  - mention / picker / 显示 badge
  - 展示 active skills

预期收益：

- sticky、workflow、pipeline 的续跑会更稳
- 外部 skill / marketplace skill 的接入边界更清楚

## Phase 3：把 run 事件流升级成 thread / turn / item

目标：让等待态、proposal-first、approval、resume 都有统一事实源。

建议：

- Thread：会话级结构化状态
- Turn：一次运行
- Item：结构化事件
- `waiting_user` / `waiting_approval` 进入 thread state
- `proposal-first` / `Keep` / `Undo` 进入 item 类型而非散落在 UI 逻辑里

预期收益：

- 不再需要在 `run.end` 里靠 assistant 文本猜 waiting
- proposal-first、resume、todo、workflow 可以真正挂到统一状态机上

## 7. 对 Crab 的最终建议

### 7.1 可以抄，而且应该抄

优先抄这三层：

- sub-agent 协议层
- skills 协议层
- thread/turn/item 状态层

### 7.2 不建议抄的部分

- Codex 的 TUI/桌面 UI 细节
- coding-agent 语境下的默认文案
- 它对文件/终端/审批的具体交互文案

Crab 是内容团队产品，不是终端 coding agent。

### 7.3 最关键的一条

> 你们现在最大的收益，不是“再加一个 sub-agent 功能”，而是把已经做出来的 sub-agent / skills / waiting / workflow / todo / proposal-first 收到一套统一运行时合同里。

Codex 最近这一大段演进，本质上也在做这件事。

## 8. 建议下一步

建议直接开一个对标 spec，而不是先改零散代码。

推荐文档名：

- `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`

建议范围：

1. 定义 Crab 的 `Thread / Turn / Item / WaitingState / CollabCall / SkillRef`
2. 明确哪些字段是事实源，哪些只是镜像
3. 规划如何从现有：
   - `agent.delegate`
   - `activeSkillIds`
   - `workflowV1`
   - `run.end`
   迁移过去

---

## 附：本次研究中直接使用的一手参考

- Codex 仓库主页与许可：
  - [README.md](/Users/noah/writing-ide/third_party/openai-codex/README.md#L1)
  - [LICENSE](/Users/noah/writing-ide/third_party/openai-codex/LICENSE#L191)
- Codex app-server 协议：
  - [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L67)
  - [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L154)
  - [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L442)
  - [app-server/README.md](/Users/noah/writing-ide/third_party/openai-codex/codex-rs/app-server/README.md#L773)
- Crab 现状：
  - [subAgent.ts](/Users/noah/writing-ide/packages/agent-core/src/subAgent.ts#L15)
  - [LegacySubAgentBridge.ts](/Users/noah/writing-ide/apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts#L200)
  - [turnEngine.ts](/Users/noah/writing-ide/apps/gateway/src/agent/turnEngine.ts#L1)
  - [ChatArea.tsx](/Users/noah/writing-ide/apps/desktop/src/ui/components/ChatArea.tsx#L1004)
  - [wsTransport.ts](/Users/noah/writing-ide/apps/desktop/src/agent/wsTransport.ts#L397)
  - [thread-waiting-user-state-v0.1.md](/Users/noah/writing-ide/docs/specs/thread-waiting-user-state-v0.1.md#L1)
