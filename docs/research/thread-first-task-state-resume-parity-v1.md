# Thread First / Task State / Resume Cache 对标 Codex + Gemini CLI 实施方案（v1）

## 1. 目标

本轮不是继续做零散补丁，而是基于本地缓存的两套真实实现：

- `third_party/openai-codex`
- `third_party/google-gemini-cli`

对现有 Agent 运行链路做一次“线程优先、状态优先”的收束，解决以下核心问题：

1. `mode=agent` 下把闲聊/短问候误判成 `task_execution`
2. 会话上下文、任务状态、阻塞恢复混在一起，容易“上一轮没收干净”或“下一轮忘了接着干”
3. 已生成但未交付/未落盘的中间产物，恢复能力不稳定

## 2. 对标结论

### 2.1 Codex

- 核心范式是 **Thread first**：同一线程多回合连续执行，而不是先把每轮粗暴分成“聊天/执行”两个世界
- `update_plan` 是运行时工具，不是前置意图分类器
- 跨会话历史与当前会话富状态分层：
  - persistent history：轻量文本
  - local/session state：富状态、可恢复 draft

### 2.2 Gemini CLI

- 核心范式是 **session persistence + resume**
- 恢复依赖结构化 `ConversationRecord / ResumedSessionData`，不是靠 prompt 猜
- Prompt 明确区分：
  - `Directive`：明确要求执行
  - `Inquiry`：分析/解释/建议
- 默认把请求当 Inquiry，只有明确执行指令才进入实施

## 3. 对我们当前实现的判断

### 已有基础（保留并收束）

- `pendingArtifacts` 已存在
- `doc.write` 的 `NO_PROJECT -> 缓存 artifact + workflowV1.resumeAction` 已存在
- `PENDING_ARTIFACTS(JSON)` 注入已存在
- `shouldPreferPendingWriteResume(...)` 与恢复写入系统提示已存在
- `runStore / conversation snapshot / runRegistry buffer` 对 pendingArtifacts 已有镜像

### 当前真正缺口

#### P0：任务边界

现状：
- `apps/gateway/src/agent/runFactory.ts` 在 `mode=agent` 时默认兜底进入 `task_execution`
- 结果：`hi` / `测试，打个招呼` 也会被拉进 Todo、CompositeTaskPlan、ToolSelection

目标：
- 改成 **Directive / Inquiry / ContinueExistingTask** 三类优先
- `mode=agent` 不再作为“必定执行”的充分条件
- 只有明确执行指令、已有任务续跑证据、或显式工具型动作，才进入 `task_execution`

#### P1：任务状态与模型上下文分层

现状：
- MainDoc / Todo / Workflow / PendingArtifacts 虽已存在，但注入仍偏“散装”
- Gateway 为了做状态判断，需要从多个 pack 段落分散解析

目标：
- 新增统一的 `TASK_STATE(JSON)` 片段
- 让程序优先读取结构化任务状态，而不是从自然语言/散落段落猜
- 保留旧段落兼容，但路由与恢复逻辑优先消费 `TASK_STATE`

建议结构：

```json
{
  "v": 1,
  "runIntent": "auto|analysis|writing|ops",
  "workflow": { "kind": "", "status": "", "updatedAt": "" },
  "todo": { "total": 0, "done": 0, "hasWaiting": false },
  "pendingArtifacts": [
    {
      "id": "artifact_xxx",
      "kind": "doc_write",
      "status": "pending",
      "pathHint": "drafts/a.md",
      "format": "md",
      "updatedAt": 0
    }
  ],
  "resume": {
    "canResumePendingWrite": false,
    "artifactId": "",
    "pathHint": ""
  }
}
```

#### P2：恢复缓存闭环

现状：
- `doc.write` 恢复写入链路基本存在
- 但缺少“任务状态优先”的统一入口，导致续跑仍可能被新任务理解抢走

目标：
- 以 `TASK_STATE.resume` 作为恢复入口
- 在路由、Prompt 注入、后续清理中统一引用
- 保持“恢复优先于重生成”的强约束

## 4. 本轮改动清单

### 文档
- [x] 新增本方案文档并落盘到 `docs/research/`
- [x] 文档内包含对标结论、实现边界、验收项、完成度回填

### 实现
- [x] 移除 `mode=agent => task_execution` 默认兜底
- [x] 新增 `Directive / Inquiry / ContinueExistingTask` 判定辅助函数
- [x] 在 Desktop context pack 中新增 `TASK_STATE(JSON)`
- [x] 在 Gateway 中新增 `parseTaskStateFromContextPack()`
- [x] 路由逻辑优先消费 `TASK_STATE.resume / workflow / todo`
- [x] 系统提示加入 Directive / Inquiry 原则，减少 provider 漂移

### 验证
- [x] `hi` / `测试，打个招呼` 在 `agent` 模式下不再进入 task_execution
- [x] `打开小红书页面，等我登录后告诉你下一步` 仍进入任务执行
- [x] `未开项目 -> doc.write 失败 -> 打开项目 -> 保存吧` 优先恢复写入，不重生成
- [x] Gateway 回归脚本通过

## 5. 不做

- 不做全量 thread/session 存储后端改造
- 不做新的数据库表
- 不做 UI debug 面板
- 不做跨 provider 的完整 planner 重写

## 6. 完成度回填

- [x] P0 完成
- [x] P1 完成
- [x] P2 完成
- [x] 冒烟完成
- [ ] 已 commit / push / deploy
