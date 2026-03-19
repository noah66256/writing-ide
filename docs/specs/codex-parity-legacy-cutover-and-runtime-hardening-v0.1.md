# Codex Parity：Legacy Cutover + Runtime Hardening v0.1

> 状态：completed（Phase A/B/C/D/E 全部完成）
> 更新时间：2026-03-19
> 前置：
> - `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`
> - `docs/specs/thread-waiting-user-state-v0.1.md`
> - `docs/research/thread-first-task-state-resume-parity-v1.md`

## 0. 结论先行

上一份 Codex parity 文档里的主链已经完成：

1. `Thread / Turn / Item`
2. `spawn_agent / send_input / resume_agent / wait_agent / close_agent`
3. `skillRefs -> thread.activeSkillRefs`
4. waiting/proposal/action item 化

截至 2026-03-19，这条 parity 主线已经完成从“双轨兼容”到“单一事实源”的硬切。

已被移除的旧兼容面：

1. 旧状态镜像：`workflowV1 / compositeTaskV1 / runStatePatch`
2. 旧协作别名与旧事件：`agent.delegate / subagent.start / subagent.done`
3. 旧 skill 影子输入：`activeSkillIds`
4. 旧 Desktop sticky/compat patch 逻辑与 `mcpWorkflowSticky`

这份文档的目标不是“再补功能”，而是做一次硬切：

1. 全量以新模型为准
2. 把旧 compat 面从主路径移出
3. 顺手完成剩余 runtime hardening

一句话：

> 不是再做 parity，而是把 parity 的兼容层拆掉，只保留新骨架。

## 1. 本次目标

### 1.1 必须完成

1. 移除运行主路径对 `workflowV1 / activeSkillIds / agent.delegate / subagent.start-done` 的依赖
2. `thread.snapshot / turn.* / item.* / skills.updated / thread.waiting.updated` 成为唯一 authoritative runtime 协议
3. Desktop/Gateway 只消费 `ThreadRecord / TurnRecord / ItemRecord / SkillRef / CollabSession`
4. `recentItems` 从“最近窗口补丁”收敛为明确契约的 authoritative snapshot 组成部分
5. 文档、脚本、类型、校验、UI 一起切换，不允许“代码切了，schema 还留旧口子”

### 1.2 同步纳入的优化

这次不只删旧代码，也把剩余优化一并做掉：

1. `recentItems` replace contract
2. 子 agent / collab 事件与 session 的最终单一事实源
3. waiting / workflow 彻底 thread-first
4. context pack 对 `ACTIVE_SKILLS(JSON)` 的最终去影子化
5. 旧 compat 字段删除后的类型瘦身与 store 瘦身

## 1.3 截至 2026-03-19 本轮回填

### 已完成

1. `thread.snapshot` 已按 authoritative replace contract 落地：
   - Gateway 发 `items`
   - Desktop 收到 snapshot 后直接 `setItems(...)`
   - `legacyProjection` 已删除
2. Skill 输入硬切已完成：
   - shared/runtime 请求类型不再暴露 `activeSkillIds`
   - Gateway schema 不再接受 `activeSkillIds`
   - Desktop 请求体只发 `skillRefs + threadSnapshotHint.activeSkillRefs`
3. 协作 alias 主路径已删除：
   - `packages/tools` 不再导出 `agent.delegate`
   - `toolCatalog / serverToolRunner / GatewayRuntime` 不再处理 `agent.delegate`
   - smoke 不再验证 `agent.delegate`
4. `subagent.start / subagent.done` 已从主协议与主实现移出：
   - Desktop 不再消费
   - Gateway item bridge 不再桥接
   - 执行器主链已不再发出这两个事件
5. `apps/gateway/scripts/smoke-runtime-parity.ts` 已收敛到新主路径，并通过
6. Workflow/Waiting hard cutover 已完成：
   - `runMachine / GatewayRuntime / runFactory / gatewayAgent / wsTransport / toolRegistry` 不再读写 `workflowV1 / compositeTaskV1 / runStatePatch`
   - `waiting / workflow / resume / route sticky` 全部收敛到 `ThreadRecord + TaskStateV2 + PENDING_ARTIFACTS`
7. Compat field deletion + type slimming 已完成：
   - shared/runtime 已删除 `runStatePatch`
   - Desktop 已删除 `mcpWorkflowSticky.ts`
   - `runStore / gatewayAgent / compositeTask.ts / smoke` 已不再保留旧字段 fallback

### 收口结论

1. 运行主路径已不再依赖 `workflowV1 / compositeTaskV1 / runStatePatch`
2. 子 agent 主路径已统一为 `spawn_agent / send_input / resume_agent / wait_agent / close_agent`
3. `activeSkillIds` 仅可能作为局部变量名残留，不再是协议、请求体或主状态字段

## 2. 当前仍存在的旧兼容面

以下兼容面已按“协议 / 主路径 / 执行器内部”完成清理；保留本节作为收尾记录。

### 2.1 状态兼容收口

1. `packages/agent-core/src/runMachine.ts`
   - 续跑判定已切到 `taskStateV2 + threadWaitingFor`
2. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
   - `_isStyleWorkflowWaitingForUser()` 已只读 `taskStateV2`
3. `apps/gateway/src/agent/runFactory.ts`
   - resume/sticky/waiting 已只读 `TaskStateV2 + PENDING_ARTIFACTS`
4. `apps/desktop/src/agent/gatewayAgent.ts`
   - `projectMainDocFromThreadState()` 已只投影 `taskStateV2 + threadWaitingFor`

### 2.2 协作兼容收口

1. `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
   - 保留为当前子线程执行桥，但已不再承担任何 legacy alias 兼容
2. `apps/gateway/src/agent/runtime/collabRuntime.ts`
   - 主路径已统一收敛到 thread/item/session 协议

### 2.3 Skills 兼容残留

1. 协议字段已清掉，但 `activeSkillIds` 命名仍作为内部派生变量存在
2. `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`
   - 仍保留“compat alias / shadow”阶段描述，需要在最终收尾时同步收敛

### 2.4 Snapshot / Item 契约收口

1. `thread.snapshot -> items -> Desktop setItems(...)` 已完成
2. 文档中的 `recentItems` 心智已收敛为 `items`

## 3. 目标终态

### 3.1 运行时协议只保留这一套

Gateway -> Desktop 只保留：

1. `thread.snapshot`
2. `turn.started`
3. `turn.completed`
4. `item.started`
5. `item.delta`
6. `item.completed`
7. `skills.updated`
8. `thread.waiting.updated`
9. `collab.session.updated`

不再作为主协议的事件：

1. `run.end`
2. `subagent.start`
3. `subagent.done`
4. 任何基于 `workflowV1.status` 的等待态写入

### 3.2 状态只保留这一套

1. waiting：`ThreadRecord.waitingFor / waiting`
2. workflow/task：`TaskStateV2`
3. skill：`ThreadRecord.activeSkillRefs`
4. collab：`activeCollabAgents + CollabItem + CollabSession`
5. proposal/approval：`FileChangeItem / ApprovalItem`

已删除的旧主写入：

1. `mainDoc.workflowV1`
2. `mainDoc.compositeTaskV1`
3. `stickyActiveSkillIds`
4. `runStatePatch`

### 3.3 Desktop 请求只保留这一套

1. `skillRefs`
2. `threadId`
3. `threadSnapshotHint`

删除旧影子输入：

1. `activeSkillIds`
2. `targetAgentIds -> synthetic agent.delegate` 旧 bootstrap 语义

## 4. 硬切原则

### 4.1 不允许“主路径新、schema 还双写旧”

只要某条 compat 面被判定切除：

1. 类型删
2. schema 删
3. runtime 分支删
4. UI fallback 删
5. smoke/update docs 一起改

### 4.2 不允许“旧字段只读不写，但还被拿来兜底”

凡是以下字段：

1. `workflowV1`
2. `activeSkillIds`
3. `agent.delegate`
4. `subagent.start / subagent.done`

一旦进入 cutover phase，就不允许再参与主路径 fallback。

### 4.3 兼容切除必须先有迁移验证

删 compat 前，必须先证明：

1. 新协议能覆盖原场景
2. 历史会话能迁到新态
3. 重启/续跑不丢状态

## 5. 分阶段方案

### Phase A：Authoritative Snapshot Hardening

目标：

1. `thread.snapshot` 变成真正 authoritative
2. `recentItems` 契约明确
3. Desktop 按 snapshot replace，而不是 append-only upsert

必须修改：

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/gateway/src/agent/runFactory.ts`
3. `apps/desktop/src/agent/wsTransport.ts`
4. `apps/desktop/src/agent/runTarget.ts`
5. `apps/desktop/src/state/runStore.ts`

建议方案：

1. 明确 `thread.snapshot.itemsMode = "replace_recent"` 或直接改名为 `snapshotItems`
2. Desktop 收到 snapshot 时，对 snapshot 域内 item 做 replace，而不是单纯 upsert
3. `activeItemIds / collabSessions / currentTurn` 也必须与 snapshot cursor 一起形成一个原子视图

验收：

1. reload 前后不会积累 stale item
2. proposal/collab/completed item 不会因为重复 snapshot 越积越多
3. snapshot 重放后 UI 与 Gateway 同步

### Phase B：Skill Hard Cutover

目标：

1. 删除 `activeSkillIds`
2. `skillRefs` 成为唯一输入
3. sticky 只保留 thread.activeSkillRefs 内部语义，不再保留旧 shadow 名称

必须修改：

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/desktop/src/ui/components/ChatArea.tsx`
3. `apps/desktop/src/agent/gatewayAgent.ts`
4. `apps/desktop/src/agent/wsTransport.ts`
5. `apps/desktop/src/state/runStore.ts`
6. `apps/gateway/src/agent/runFactory.ts`
7. `packages/agent-core/src/runMachine.ts`

删除项：

1. `activeSkillIds`
2. `threadSnapshotHint.activeSkillIds`
3. `stickyActiveSkillIds` 旧命名对外暴露
4. `ACTIVE_SKILLS(JSON)` 的兜底心智

验收：

1. 请求体只出现 `skillRefs`
2. context pack 只看 `thread.activeSkillRefs`
3. workflow skill / turn-scope skill / thread-scope skill 都能恢复

### Phase C：Collab Hard Cutover

目标：

1. `spawn_agent` 成为唯一对外协作工具
2. 删除 `agent.delegate` alias
3. 删除 `subagent.start / subagent.done` 旧桥接

必须修改：

1. `packages/tools/src/index.ts`
2. `apps/gateway/src/agent/toolCatalog.ts`
3. `apps/gateway/src/agent/serverToolRunner.ts`
4. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
5. `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
6. `apps/gateway/src/agent/writingAgentRunner.ts`
7. `apps/desktop/src/agent/wsTransport.ts`
8. `apps/gateway/scripts/smoke-runtime-parity.ts`

删除项：

1. `agent.delegate`
2. `delegate` capability alias
3. `LegacySubAgentBridge`
4. `subagent.start`
5. `subagent.done`

验收：

1. 所有子 agent 都经 `CollabItem + collab.session.updated + child thread/item` 呈现
2. Desktop 不再监听 `subagent.start / subagent.done`
3. smoke 不再验证 `agent.delegate`

### Phase D：Workflow/Waiting Hard Cutover

目标：

1. 删除 `workflowV1` 主路径 fallback
2. 删除 `run.end` 的 compat sticky patch
3. waiting / workflow 全量 thread-first

必须修改：

1. `packages/agent-core/src/runMachine.ts`
2. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
3. `apps/gateway/src/agent/runFactory.ts`
4. `apps/desktop/src/agent/wsTransport.ts`
5. `apps/desktop/src/agent/gatewayAgent.ts`
6. `apps/desktop/src/state/conversationStore.ts`

删除项：

1. 直接读 `mainDoc.workflowV1` 判断 waiting/续跑
2. `updateWorkflowSticky()` 里的 authoritative 状态写入
3. `deriveWaitingWorkflowPatchFromAssistant()` 对主状态的任何影响
4. `run.end.executionReport.runState -> workflowV1.runStatePatch` 主路径

验收：

1. waiting 仅由 `thread.waiting.updated / thread.snapshot` 驱动
2. 续跑判断仅由 `ThreadRecord / TaskStateV2` 驱动
3. `workflowV1` 只剩只读镜像，或可彻底删除

### Phase E：Compat Field Deletion + Type Slimming

目标：

1. 删除 shared/runtime 里所有旧字段
2. 删除 legacy projection 或将其降到独立迁移层
3. 清理 store / snapshot 的旧冗余字段

必须修改：

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/desktop/src/state/runStore.ts`
3. `apps/desktop/src/state/conversationStore.ts`
4. `apps/desktop/src/agent/threadProjection.ts`
5. `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`

删除候选：

1. `legacyProjection`
2. `workflowV1` mirror
3. `stickyActiveSkillIds`
4. `activeSkillIds`
5. compat-only schema 字段

## 6. 文件级清理清单

### 6.1 高优先文件

1. `packages/shared/src/runtime/thread-turn-item.ts`
2. `apps/gateway/src/agent/runFactory.ts`
3. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
4. `apps/gateway/src/agent/writingAgentRunner.ts`
5. `apps/gateway/src/agent/runtime/LegacySubAgentBridge.ts`
6. `apps/desktop/src/agent/wsTransport.ts`
7. `packages/agent-core/src/runMachine.ts`

### 6.2 次级清理文件

1. `apps/gateway/src/agent/toolCatalog.ts`
2. `apps/gateway/src/agent/serverToolRunner.ts`
3. `packages/tools/src/index.ts`
4. `apps/desktop/src/agent/gatewayAgent.ts`
5. `apps/desktop/src/state/runStore.ts`
6. `apps/desktop/src/state/conversationStore.ts`
7. `apps/gateway/scripts/smoke-runtime-parity.ts`

## 7. 验证方案

### 7.1 编译与现有 smoke

1. `npm run -w @ohmycrab/agent-core build`
2. `npm run -w @ohmycrab/shared build`
3. `npm exec -- tsc -p apps/gateway/tsconfig.json --noEmit`
4. `npm exec -- tsc -p apps/desktop/tsconfig.json --noEmit`
5. `npm run -w @ohmycrab/gateway smoke:runtime-parity`
6. `npm run -w @ohmycrab/gateway smoke:workflow-sticky`
7. `npm run -w @ohmycrab/gateway smoke:mcp-session-reliability`

### 7.2 新增 cutover smoke

需要补以下断言：

1. 请求体不再出现 `activeSkillIds`
2. 协作工具面不再出现 `agent.delegate`
3. Desktop 不再消费 `subagent.start / subagent.done`
4. `workflowV1` 不再作为 waiting 主判断
5. `thread.snapshot` 对 item 为 replace 语义
6. `no_project -> pending resume -> resumed_write_done` 全链路只经 `TaskStateV2 + PENDING_ARTIFACTS`

### 7.3 历史迁移验证

需要显式验证：

1. 老对话加载时能迁成新 snapshot
2. 历史 proposal / waiting / collab 状态不会丢
3. 老会话若含 `agent.delegate` 审计记录，展示层不崩

## 8. 风险与防护

### 风险 1：一次删太多，老会话直接打不开

防护：

1. 先做“读取迁移”，再删 runtime 写入
2. 历史快照迁移器要有版本号

### 风险 2：删 `workflowV1` 后续跑误判

防护：

1. 先把 `runMachine` 和 `GatewayRuntime` 全部切到 `ThreadRecord / TaskStateV2`
2. smoke 增加“无 workflowV1 仍正确续跑”

### 风险 3：删 `agent.delegate` 后老脚本/老 prompt 全挂

防护：

1. 先替换脚本、测试、prompt
2. 再删除工具定义与 allowlist

### 风险 4：snapshot replace 语义改错导致 UI 丢 item

防护：

1. 给 snapshot 加明确 mode/revision 语义
2. Desktop 端先只 replace snapshot 域内 item，不影响非 snapshot buffer

## 9. 立即执行顺序

严格按这个顺序：

1. Phase A：已完成
2. Phase B：已完成
3. Phase C：已完成
4. Phase D：已完成
5. Phase E：已完成
6. 文档已更新为“已切新协议”

## 10. 完成定义

以下 6 条已全部满足：

1. 代码主路径不再读写 `agent.delegate / activeSkillIds / workflowV1.status / subagent.start-done`
2. `thread.snapshot` 成为可 replace 的 authoritative state
3. `skillRefs` 是唯一 skill 输入
4. `spawn_agent` 是唯一协作工具入口
5. `run.end` 不再承担主状态同步职责
6. cutover smoke 与历史迁移验证都通过
