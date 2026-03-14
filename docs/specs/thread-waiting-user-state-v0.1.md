## Thread Waiting State v0.1（等待用户/审批的统一状态）

> 目的：把“等待用户回复/审批”的状态从零散 heuristics 提升为**结构化线程状态**，避免助手在澄清问题后继续自问自答或误触自动续跑。

### 1. 设计目标

- **单一事实源**：
  - “当前是否在等用户/等审批”的唯一事实源是线程级状态（Thread Waiting State），而不是某一轮的自然语言问句、`workflowV1` 或 Todo note。
- **端到端可观测**：
  - Gateway / agent-core 在 Run 结束时决定是否进入 `waiting_for = user/approval`；
  - Desktop 只消费这个结构化状态来渲染 UI、决定是否自动续跑；
  - `workflowV1` 只作为跨轮粘合层的镜像，而非事实源。
- **与 Codex 对齐**：
  - 对标 `thread_status.rs` 里的 `ThreadActiveFlag::WaitingOnUserInput / WaitingOnApproval`；
  - 我们不在 UI / Runtime 里读自然语言来猜，而是由运行时代码在合适的时机显式打标。

### 2. 线程等待状态模型

#### 2.1 线程级字段（逻辑模型）

逻辑上我们为每个“对话线程/会话”维护以下状态（实现可分散在 runState + workflowV1）：

```ts
// 逻辑模型（不要求 1:1 映射到单一 TypeScript 类型）
interface ThreadWaitingStateV1 {
  waitingFor: "none" | "user" | "approval";
  // 可选：用于 UI 提示的问题摘要（最近一次澄清/确认问题的截断文本）
  question?: string;
  // 可选：UI 提示用的 hint，如 "choice" | "login_or_choice" 等
  replyHint?: string;
  // 最近更新时刻，用于 TTL/过期判断
  updatedAt?: string; // ISO8601
}
```

- **事实源**：`waitingFor`（none/user/approval）。
- **附加信息**：`question`/`replyHint` 仅用于 UI 渲染，不参与逻辑判断。

#### 2.2 与 `workflowV1` 的关系

- `mainDoc.workflowV1` 继续作为“跨轮粘合层”使用，但它**不再是等待状态的唯一事实源**。
- 等待状态更新协议：
  - Gateway / Desktop 在决定进入等待状态时，**同时**：
    - 更新线程等待状态（内部 runState / 线程表）；
    - 将等价信息镜像到 `workflowV1`：
      ```ts
      mainDoc.workflowV1 = {
        ...,
        status: "waiting_user" | "waiting_approval", // mirror waitingFor
        waiting: {
          question, // 可选
          replyHint, // 可选
        },
        updatedAt: now,
      };
      ```
  - agent-core / Desktop 在判断“是否续跑”时：
    - 优先通过线程等待状态判断（待实现）；
    - 目前过渡期允许继续读取 `workflowV1.status`，但必须视其为**镜像**而非事实源。

### 3. 进入/退出等待状态的触发点

#### 3.1 进入等待用户（waiting_for = user）

**触发条件（满足任一即可）：**

1. **运行时明确决定等待用户**（推荐路径）
   - Gateway 端在结束本轮 Run 时，根据 runState / 工具调用结果判定需要用户输入才能继续：
     - 例如：
       - 需要用户在浏览器/MCP 页面完成登录后继续（“你先登录完成，我再继续”）；
       - 需要用户在多个方案中做选择（“选 A/B/C 哪种写法？”）。
   - 运行时代码调用统一 helper（待实现，如 `noteWaitingForUser(question, replyHint)`），完成：
     - 更新线程等待状态：`waitingFor = "user"`；
     - Patch `workflowV1`：`status = "waiting_user"` + `waiting.{question, replyHint}`。

2. **Desktop 在流式结束时根据事件判定等待用户**（现有 heuristic 的结构化出口）
   - Desktop 已有 `deriveWaitingWorkflowPatchFromAssistant` 用于浏览器/登录类任务：
     - 当检测到最后一条 assistant 输出是在提示“请登录完成后告诉我/请在 X 页面操作后回复”等，并且当前工作流为 `browser_session/web_radar`，会写入：
       ```ts
       mainDoc.workflowV1.status = "waiting_user";
       mainDoc.workflowV1.waiting = { question, replyHint };
       ```
   - 本文档要求：
     - 该 helper 不再直接被业务逻辑当成事实源，而是通过统一封装更新线程等待状态；
     - 任何将来新增的“等用户” heuristic，也必须通过同一 helper 更新等待状态，而不是在各自模块内各写一套。

> 重要：**等待用户的事实源在 Runtime，不在模型文本。** 模型可以被提示“请在澄清后设定 workflowV1.status=waiting_user”，但最终是否进入该状态由运行时代码决定；自然语言问句（例如“你现在是飞书个人版还是企业版？”）只能作为 heuristics 的输入信号。

#### 3.2 退出等待用户

退出等待状态的原则：**“谁设的等待，谁负责清理”**。

- 当下轮 Run 启动时，如果线程处于 `waitingFor = "user"`：
  - 视本轮用户消息为对上一轮澄清/确认的回应；
  - 运行时代码在合适的时机（如 Run 开始时）清理等待状态：
    - `waitingFor = "none"`；
    - `workflowV1.status` 改为 `running`/`done` 等；
  - 是否继续使用 `workflowV1` 的其它 sticky 字段（如 routeId/mcp server 选择）由各路由负责。
- 若用户显式发起了新的任务（见 `detectRunIntent` / “新写作任务边界”逻辑）：
  - 新任务应被视为**打断旧的等待**，直接重置等待状态为 `none`；
  - `workflowV1` 亦应被整体清理或迁移到历史。

### 4. 与现有逻辑的对齐与迁移

#### 4.1 与 `detectRunIntent` / 写作闭环的关系

- 当前 `detectRunIntent` 已经通过 `MainDoc.workflowV1.status === waiting_user` + 最近对话，推断“这轮是不是续跑上一轮的写作任务”。
- 在本 spec 下：
  - `workflowV1.status` 只是一份镜像；
  - `detectRunIntent` 后续应迁移为：
    - 优先参考线程等待状态（`waitingFor` + `kind`）；
    - 再用 `workflowV1` / recent dialogue 作补充证据。

#### 4.2 与 Desktop Streaming / Todo UX 文档的关系

- `docs/research/todo-and-streaming-ux-codex-parity-v1.md` 描述了“等待用户 / 达到回合上限”的 UI 文案；
- 本 spec 规定：
  - **是否处于等待用户状态，以本线程等待状态为准**；
  - 文案只是呈现层实现，不参与逻辑判断。

#### 4.3 与 Context/Resume/Artifact Cache 文档的关系

- `docs/research/context-resume-artifact-cache-codex-parity-v1.md` 中将 `workflowV1.status === waiting_user` 作为 Resume 的触发条件之一；
- 本 spec 之后：
  - Resume 的主要触发信号来自线程等待状态（特别是 pending write resume 场景）；
  - `workflowV1` 仍可被视为 Resume 的 hint，但不能作为唯一事实源。

### 5. 实施分期建议

1. **Phase 1：结构化等待状态 & 单点封装**
   - 在 Desktop `wsTransport` 与 Gateway run 机中：
     - 提取/新增统一 helper（例如 `noteWaitingForUser`）；
     - 所有“等登录/等选择/等用户确认”的分支统一调用该 helper；
     - 同步更新：线程等待状态 + `workflowV1` 镜像。
   - 保持现有 heuristics 不变（例如针对浏览器登录的 regex），先解决“飞书版本澄清后继续自问自答”的问题。

2. **Phase 2：agent-core / Resume 迁移**
   - 将 `detectRunIntent` / Resume 判定改为优先读取线程等待状态；
   - 仅在缺少线程状态时回退到 `workflowV1`/recent dialogue。

3. **Phase 3：工具化等待（可选）**
   - 引入显式工具（如 `run.setWaitingForUser`）用于模型主动标记等待点；
   - 并由运行时代码统一消费该工具，而非直接读模型文本。

> 落地原则：从今天起，**任何新加的“等用户回复/等审批”逻辑都必须通过统一的等待状态 helper 更新线程状态 + `workflowV1` 镜像**，禁止在各个模块自发通过 regex 直接操作 `workflowV1.status` 或仅依赖问句判断是否续跑。
