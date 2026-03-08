# MCP 会话可靠性与线程记账修复方案 v1（按 Codex 范式回调）

## 结论

这轮方案需要从“补 sticky / 补 Todo”回调到更底层的会话原语。

参考 `openai/codex` 当前成熟范式后，结论是：

1. **真正的事实源不是 Todo，也不是单份 `workflowV1`，而是 Thread / Turn / Item。**
2. **MCP 连续任务的根因，不是 prompt，也不只是 Playwright，而是：真实执行、会话 session、线程记账三者没有完全对齐。**
3. **Todo 面板应该是派生 UI，不应该先于线程原语成为主结构。**
4. **sticky 仍然有用，但应该降级为桥接层：在当前架构没完全 item 化前，用来承接连续任务；一旦 item/turn/thread 打稳，sticky 只负责快捷继承，不再当唯一事实源。**

因此，本轮修复顺序调整为：

- **P0：把真实 MCP 执行稳定落成线程条目（item-like records）**
- **P1：把 stateful MCP 的 session 生命周期做成统一恢复机制**
- **P2：把 sticky / 调试面板 / Todo 面板都改成“基于事实层派生”**

## 外部参考（只摘对我们有用的点）

### 1. OpenAI App Server / Codex harness 文章

来源：
- OpenAI, *Unlocking the Codex harness: how we built the App Server*（2026-02-04）
- https://openai.com/index/unlocking-the-codex-harness/

关键点：

- Codex 的会话基础是 **Thread / Turn / Item** 三层。
- **Item** 是原子单元，带明确生命周期：
  - `item/started`
  - 可选 `item/*/delta`
  - `item/completed`
- **Turn** 是一次用户输入触发的一段 agent 工作。
- **Thread** 是持久化容器，能被创建、恢复、分叉、归档；客户端重连时靠 thread history 重建一致时间线。
- 服务器协议是 **双向 JSON-RPC**，而不是“客户端发请求、服务端只回日志”。
- 服务器可以主动请求客户端输入（如审批），并暂停当前 turn，等待客户端回应后继续。

对我们的直接启发：

- 工具调用不是“附属日志”，而是会话原语的一部分；
- 如果工具调用不能稳定回放，连续任务就必然脆弱；
- 如果 session 能发生副作用，但线程里没有 item，客户端就只能靠猜。

### 2. GitHub issue：恢复会话时看不到历史工具调用

来源：
- https://github.com/openai/codex/issues/4790

关键点：

- 该 issue 明确指出：恢复会话后，如果看不到之前的工具调用历史，操作者就无法审计“已经做过什么”。
- 期望行为是：恢复后应包含和中断前相同的工具调用记录（包括 exec、patch、MCP 等）。

对我们的启发：

- 我们现在遇到的“浏览器明明打开了，但线程像没做过”本质上是同类问题；
- 这不是 UI 小问题，而是会话一致性问题；
- 没有工具历史，就无法稳定续跑，也无法安全审批或排障。

### 3. GitHub issue：中断后要求 agent 改做别的，但它不知道你在指哪次工具调用

来源：
- https://github.com/openai/codex/issues/5253

关键点：

- 如果中断/拒绝某次工具调用后，对话里没有带回那次工具调用上下文，agent 就不知道用户在说哪一步。

对我们的启发：

- “连续任务失忆”不只是记忆问题，而是最近一次工具 item 没进入下一次 turn 的上下文；
- 所以续跑必须保留最近关键工具 item 的事实层，而不只是 assistant 文本摘要。

### 4. GitHub issue：stateful MCP 需要长寿命 session，而不是每次 tool call 重启

来源：
- https://github.com/openai/codex/issues/6128

关键点：

- 该 issue 的根因不是工具选错，而是 **stateful MCP 每次调用都被重新启动**，导致缓存/模型/连接无法复用；
- 对比实现里，另一个产品会在 session 启动时拉起 MCP，一直保持存活。

对我们的启发：

- 我们不能只把浏览器 MCP 当成“普通无状态工具”；
- 需要明确区分：
  - `stateful`：browser / word / excel / pdf / ssh / app-server 等
  - `stateless`：search / fetch / 单次 lint / 单次 query
- 同样的 session closing / transport closed 问题，会影响所有 stateful MCP，不止 Playwright。

### 5. GitHub issue：Todo 是能力诉求，但不是底层会话原语

来源：
- https://github.com/openai/codex/issues/2966

关键点：

- 社区对长任务 Todo 的诉求很强；
- 但这个需求本身也说明：Todo 更像上层任务组织能力，而不是会话最底层事实源。

对我们的启发：

- Todo 面板应继续做，但只能建立在 thread/turn/item 足够可信之后；
- 否则 Todo 会变成“看起来有计划，实际会话事实不完整”的假稳定层。

## 问题复盘（按新范式重述）

### 现象 A：浏览器副作用发生了，但线程里不稳定可见

已确认：

- 小红书页面确实被打开；
- 新对话里 agent 也能读取并描述页面；
- 说明 Playwright 至少在部分场景下可正常执行。

但历史上又出现：

- assistant 声称“已打开小红书网页版”；
- 线程里只有 `run.mainDoc.update`；
- 对应的 `mcp.playwright.*` 步骤不稳定出现。

这说明：

- **副作用层成功了，但会话条目层不稳定。**

### 现象 B：第二轮续跑时报 `Another browser context is being closed.`

这说明：

- 问题不只是“线程没记账”；
- 还存在 **stateful session 生命周期不稳**。

### 现象 C：连续任务靠 `workflowV1` 撑住，但它不是底层真相

当前 sticky 可以缓解：

- “我登好了”
- “继续”
- “下一步”

但如果第一轮真实执行没有落成稳定条目：

- `workflowV1` 就只能是猜测 / 补丁；
- 一旦某轮回写漏掉，第二轮就断。

## 根因（按优先级）

## 根因 1：主 Agent 的 MCP 调用没有和其他工具一样稳定地 item 化

当前系统里：

- 普通工具、写文件、lint 等，都比较像“线程中的条目”；
- 但主 Agent 直接走 `mcp.*` 时，曾出现“副作用有了，线程里没有稳定条目”的现象。

这意味着：

- MCP 还没有完全成为一等会话原语；
- 它更像“执行层能力”，还没完全被“线程层”接住。

**这是本轮最优先要修的。**

## 根因 2：sticky 目前承担了过多“事实恢复”职责

`workflowV1` 现在既承担：

- 路由续跑
- MCP server sticky
- 执行偏好继承

如果把这些全压在 `workflowV1` 上，就会出现：

- 一旦它没被正确写回，整个连续任务都断；
- 但真正的事实其实应该来自 item 历史，而不是摘要对象。

所以：

- `workflowV1` 应该保留；
- 但它应当是 **thread facts 的索引/桥接层**，而不是唯一真相。

## 根因 3：stateful MCP 缺少统一 session 恢复语义

当前这类错误：

- `Another browser context is being closed`
- `context has been closed`
- `browser has been closed`
- `transport closed`

都属于：

- 会话态已损坏，但系统还按“单次调用失败”处理。

对于 stateful MCP，这显然不够。

## 根因 4：Todo / 调试面板过早承担“解释系统状态”的职责

如果底层事实不完整：

- Todo 面板再漂亮，也只是表面连续；
- 调试面板也可能只展示推断，而不展示真实 item 流。

因此这类 UI 必须后置。

## 修复原则

### 原则 A：先修会话事实层，再修体验层

优先级：

1. 工具调用必须进入线程条目
2. stateful MCP 会话要有统一恢复语义
3. sticky / Todo / notice 基于事实层派生

### 原则 B：stateful / stateless 必须分流

不能再把所有 MCP 一视同仁。

### 原则 C：不重写整套协议，但朝 Codex 范式渐进收敛

本轮不做：

- 完整 App Server JSON-RPC 重构
- 完整 thread/turn/item 协议替换

本轮做的是：

- 在现有 WS 协议上，把工具调用尽量变成 item-like 记录；
- 把 sticky 降级为桥接层；
- 把 stateful MCP 恢复机制补齐。

## 本轮实现范围（修订后）

## P0：让 MCP 先成为稳定的线程条目

### 目标

- 主 Agent 的 `mcp.*` 与其他工具一样，在当前线程中有明确开始/结束记录；
- 失败也要有可见条目，不再只剩 assistant 口头解释；
- 成功的 `mcp.*` 执行会反向喂给 `workflowV1`，但这一步只是桥接，不是唯一事实层。

### 本轮落地

- 在 Desktop 侧主 Agent `mcp.*` 路径补 `addTool(...running)` + `patchTool(...success/failed)`；
- 成功后再把 server/tool 信息合并回 `workflowV1`；
- 这样至少做到：**先有条目，再有 sticky**。

> 这是对 Codex `item/started → item/completed` 思路的最小对齐，而不是单独再造一套 UI 逻辑。

## P1：给 stateful MCP 加统一恢复语义

### 目标

- 不再把 session closing 当成普通调用失败；
- 对 stateful MCP 统一识别并尝试恢复；
- 恢复结果进入 diag / 审计，而不是静默发生。

### 本轮落地

- 给 MCP server 增加 `sessionMode = stateful | stateless | unknown`；
- 对浏览器/文档/表格/PDF/SSH/app-server 等归为 stateful；
- 命中 session closing 类错误时，执行一次受控的 `disconnect → connect → retry once`；
- recovery 信息写进 diag。

> 这一步不是只修 Playwright，而是给全体 stateful MCP 打底。

## P2：把 sticky 明确定义为桥接层，而非事实层

### 目标

- `workflowV1` 继续服务连续任务；
- 但在文档和实现语义上，明确它来源于已发生的工具事实，而不是模型猜测。

### 本轮落地

- `workflowV1` 的更新优先来自：
  - `ExecutionContract`
  - `McpServerSelection`
  - **真实成功的 `mcp.*` 执行**
- 文档层明确：
  - 未来如果线程 item/replay 更完整，sticky 可以进一步瘦身。

## P3：Todo / 调试面板继续保留，但不再作为根方案中心

### 目标

- 不回退已经有价值的 UI；
- 但明确这些 UI 是消费线程事实，而不是替代事实层。

### 本轮落地

- Todo 继续保留；
- 调试面板继续展示 `McpServerSelection`；
- 但方案文档不再把它们作为根因修复中心。

## 已实现 / 应保留的改动（按新方案复核）

以下改动与 Codex 范式并不冲突，应该保留：

1. **主 Agent 的 MCP 工具步骤可见化**
   - 这是把 MCP 向 item-like 记录靠拢，而不是重复造轮子。
2. **真实 MCP 成功后回写 sticky**
   - 作为桥接层合理，前提是它从事实层派生。
3. **`sessionMode` 分类与 stateful 恢复判定**
   - 这能把“是不是只影响 Playwright”变成结构化答案。
4. **新增 smoke 脚本**
   - 把机制验证脚本化，是必要投入。

## 当前不应该扩张的方向

以下方向本轮不继续扩张：

1. **不要再把更多语义塞进 Todo 面板**
2. **不要再新造一套独立 workflow 状态机**
3. **不要把所有连续任务都塞给 sticky 解决**
4. **不要把“浏览器成功打开”继续当作 Playwright 单点 bug 分析**

## 验收标准（修订后）

### A. 条目可见

当主 Agent 调 `mcp.playwright.browser_navigate`：
- 对话线程中能看到该工具步骤；
- 成功/失败都可见；
- 不再只剩 assistant 文本解释。

### B. sticky 来源正确

当真实 `mcp.*` 成功后：
- `workflowV1.selectedServerIds` 与 `preferredToolNames` 被更新；
- 但它是从事实条目派生，而不是凭空写入。

### C. stateful 恢复有效

当命中 session closing 类错误：
- 只对 stateful MCP 尝试恢复；
- 恢复信息进入 diag；
- search 类 stateless MCP 不误触发这套逻辑。

### D. 全局解释能力增强

面对“这个 MCP 的问题会不会影响别的 MCP”时，系统能明确回答：
- 它属于 stateful 还是 stateless；
- 是否共享同类 session 问题；
- 是否会进入同一套恢复链路。

## 实际变更清单（本轮）

- `docs/research/mcp-session-reliability-and-thread-accounting-repair-v1.md`
- `apps/desktop/src/agent/wsTransport.ts`
- `apps/desktop/src/agent/mcpWorkflowSticky.ts`
- `apps/desktop/electron/mcp-manager.mjs`
- `apps/desktop/electron/mcp-session-recovery.mjs`
- `apps/gateway/src/agent/toolCatalog.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/scripts/smoke-mcp-session-reliability.ts`
- `apps/gateway/package.json`

## 验证命令（本轮）

- `npm run -w @ohmycrab/gateway smoke:mcp-session-reliability`
- `npm run -w @ohmycrab/gateway smoke:workflow-sticky`
- `npm run -w @ohmycrab/gateway smoke:mcp-server-first`
- `npm run -w @ohmycrab/gateway build`
- `npm run -w @ohmycrab/desktop build`
