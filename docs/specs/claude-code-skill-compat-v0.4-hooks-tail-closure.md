# Claude Code Skill Compatibility v0.4 Hooks Tail Closure

> 状态：Implemented（代码已收口；Desktop live 手工验收待补）  
> 日期：2026-03-21  
> 基线 HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`  
> 前置文档：
> - `docs/specs/claude-code-skill-compat-v0.3-gap-closure.md`
> - `docs/specs/claude-code-skill-compat-v0.2.md`
> - `docs/research/claude-code-skill-native-compat-plan-2026-03-20.md`
> - `docs/specs/thread-waiting-user-state-v0.1.md`

## 实施状态（2026-03-21）

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Fix 1（P0）hooks 结果消费语义与 Notification 覆盖 | `apps/gateway/src/agent/runtime/GatewayRuntime.ts` / `_transformContext`、`_writePortableNotificationNotice`、`_selectPortableHookMatchers`、`_buildPortableHookInput`、`_runPortableHookEvent` | 已实现 | `npm run -w @ohmycrab/gateway build`；`npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts` | 已补 `SessionStart/UserPromptSubmit` immediate context、`Notification` matcher/覆盖、compact 输入字段；`SessionStart.source` 现已 best-effort 覆盖 `startup/resume/compact`；`Stop/SubagentStop` 的 `decision=block` 已改为 follow-up continuation，并带 3 次重试 guard |
| Fix 2（P1）command hook 下沉到 Desktop 本地执行桥 | `apps/gateway/src/agent/runtime/GatewayRuntime.ts`、`apps/desktop/src/agent/toolRegistry.ts`、`apps/desktop/electron/main.cjs` | 已实现 | `npm run -w @ohmycrab/gateway build`；`npm run -w @ohmycrab/desktop build`；`npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts` | Gateway 不再直接 `spawn(shell)`；统一走 `portable.hook.command` + waiter 回包；`shell.exec` 已支持可选 `stdin` |
| Fix 3（P1）PermissionRequest 接入 approval / waiting 状态机 | `apps/gateway/src/agent/runtime/GatewayRuntime.ts`、`apps/gateway/src/agent/runFactory.ts`、`apps/gateway/src/agent/writingAgentRunner.ts`、`packages/shared/src/runtime/thread-turn-item.ts`、`apps/desktop/src/agent/wsTransport.ts` | 已实现 | `npm run -w @ohmycrab/gateway build`；`npm run -w @ohmycrab/desktop build`；`npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts` | 已补 `PermissionRequest -> allow`、`approval_waiting`、`ApprovalItem`、`pendingApprovalIds`、`thread.waiting.updated`；resume 继续复用既有“下一条用户消息开新 run”链路，未单独新增 approve/decline RPC |
| Fix 4（P2）PreCompact / PostCompact 覆盖真实 dialogue summary compact | `apps/desktop/src/agent/gatewayAgent.ts`、`apps/desktop/src/agent/wsTransport.ts`、`apps/gateway/src/agent/writingAgentRunner.ts`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts`、`packages/shared/src/runtime/thread-turn-item.ts` | 已实现（按现有架构落地） | `npm run -w @ohmycrab/gateway build`；`npm run -w @ohmycrab/desktop build`；`npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts` | 没有新增独立 WS 逆向桥；原因是 `context.summary.roll` 真实发生在 `run.request` 前。当前实现为 Desktop 在启动 run 前把 compact 元数据带给 Gateway，并在同一启动轮触发 `PreCompact/PostCompact` |
| Fix 5（P2）live smoke 与官方样本验证矩阵 | `apps/gateway/scripts/smoke-claude-hook-parity.ts`、`docs/research/claude-code-skill-hooks-live-validation-2026-03-21.md` | 已实现（代码/脚本） | `npm run -w @ohmycrab/gateway build`；`npm run -w @ohmycrab/desktop build`；`npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts` | 脚本级 smoke 已覆盖 `allow / approval_waiting / notification / dialogue_summary compact / Stop block / SubagentStop block`；真实桌面态手工 checklist 明确保留为后续人工验收项 |

## 一、需求概述

### 需求卡片

- 场景：`v0.3` 已把 Claude Code skill 主链兼容收口，但 hooks 仍是 subset，用户要继续对照官方文档，把剩余关键缺口落成下一份实施 spec。
- 目标：把“Claude Code skill 拿过来直接用”最后仍会踩到的运行时差异收成一份 `v0.4` 文档，重点覆盖 hooks、approval、compact 和 live validation。
- 对标：
  - Anthropic Claude Code Hooks 文档
  - Anthropic Claude Code Skills 文档
  - 现有 `v0.3` 实现代码
- 约束：
  - 不推翻 `portableRuntime + runFactory + GatewayRuntime` 主线
  - 不让 hooks 绕过创作模式硬门禁、proposal-first、delivery latch
  - 必须遵守“工具执行全在本地，Gateway 负责编排，Desktop 负责执行工具”
- 不做什么：
  - 不做 Anthropic bundled skills parity
  - 不做 async/background hooks daemon
  - 不重写整个 runtime 状态机
  - 不把所有 Claude hooks 事件一次性全吞下

### 结论先行

`v0.3` 可以视为“Claude Code skill 主链兼容已完成”，但还不能说“hooks parity 已完成”。剩余真正影响开箱即用的尾巴只剩 5 类：

1. hooks 事件虽已扩到 `Notification / PermissionRequest / PreCompact / PostCompact`，但结果语义仍主要只在 `PreToolUse` 生效。
2. `Notification` 还没覆盖 `GatewayRuntime` 内全部 `run.notice` 路径，导致部分官方 notification hook 实际观测不到。
3. `command` hook 仍在 Gateway 侧 `spawn(shell)` 执行，违反本仓库“本地执行”边界。
4. `PermissionRequest` 还没真正桥接到 thread waiting / approval 状态，既没对齐官方 `allow / deny` 决策，也没有把“未决权限请求”接到 Crab 的 approval 流程。
5. `PreCompact / PostCompact` 目前只包住工具结果 envelope 压缩，没有覆盖 Desktop 侧真实的对话摘要 compact。

因此，`v0.4` 不再写“大而全兼容”，而是专门做 hooks tail closure：把现有 subset 从“能跑”收口到“语义尽量不偏、边界不跑偏、能做 live 验证”。

---

## 二、已有上下文索引

- 已收口主链：
  - `v0.3` 已完成 `allowed-tools` 字符串兼容、`${CLAUDE_*}` 变量、`!` 预处理、真实 `context: fork`、外部 `.claude/agents`、hooks subset 扩展。
- 已知剩余边界：
  - `v0.3` 顶部已明确写出“hooks 仍保留 subset 边界”。
- 已有可复用设施：
  - `portable.skill.preprocess` 已证明“Gateway 发内部工具请求 -> Desktop 本地 shell 执行 -> 回写结果”这条链路可复用。
  - `thread.waiting.updated`、`waitingFor=approval`、`ApprovalItem`、`pendingApprovalIds` 已有类型和事件基础。
  - Desktop 已有 `context.summary.roll` 的真实 compact 触发点。

---

## 三、现状地图

### 3.1 相关文件

| 文件 | 职责 | 与本次需求关系 |
|------|------|----------------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | portable hooks 事件选择、输入构建、handler 执行、tool runtime | 本次主改动面；当前 hooks 结果消费、通知覆盖、command 执行都在这里 |
| `apps/gateway/src/agent/runFactory.ts` | run 生命周期、thread snapshot / waiting state、内部工具桥接 | approval 状态回写、hook command 本地桥、smoke 桥接都要经过这里 |
| `apps/desktop/src/agent/toolRegistry.ts` | Desktop 工具注册与本地执行 | 可复用 `portable.skill.preprocess` 的本地 shell 能力，承接 command hook 下沉 |
| `apps/desktop/src/agent/gatewayAgent.ts` | 对话摘要 compact 与 store 写回 | 真实 `PreCompact/PostCompact` 应覆盖这里的 `context.summary.roll` |
| `apps/desktop/src/agent/wsTransport.ts` | run / thread / notice 事件消费 | live validation 观测点，也是 approval/waiting 的 UI 入口 |
| `apps/gateway/src/agent/runtime/threadState.ts` | 线程 waiting 状态事实源 | `PermissionRequest -> waiting_approval` 的结构化落点 |
| `packages/shared/src/runtime/thread-turn-item.ts` | thread / item / approval 共享类型 | 若补 approval payload，需要在这里显式扩合同 |

### 3.2 当前实现事实

#### A. hooks 事件表已扩，但消费语义仍偏 `PreToolUse`

- `PortableHookEventName` 当前已包含：
  - `SessionStart`
  - `SessionEnd`
  - `UserPromptSubmit`
  - `Notification`
  - `PermissionRequest`
  - `PreToolUse`
  - `PostToolUse`
  - `PostToolUseFailure`
  - `PreCompact`
  - `PostCompact`
  - `Stop`
  - `SubagentStart`
  - `SubagentStop`
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`PortableHookEventName`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`144-157`

但 `_runPortableHookEvent()` 当前真正消费 block / update 语义的，仍基本只有 `PreToolUse`：

- `PermissionRequest` 只收集 `hookMessage`
- `UserPromptSubmit / SessionStart` 的 `additionalContext` 只是进入 `pendingFollowUpItems`
- `PostToolUse / PostToolUseFailure / Stop / SubagentStop` 没有按官方语义消费顶层 `decision` / `reason`
- `command` hook exit code `0` 的普通 `stdout` 当前基本被忽略，`UserPromptSubmit / SessionStart` 没有按官方语义把 stdout 注入本轮上下文
- `_buildPortableHookInput()` 对 `SessionStart / Notification / PreCompact / PostCompact` 仍偏 Crab 私有字段，缺少官方常见的 `source / notification_type / trigger / compact_summary` 这类语义字段
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`_buildPortableHookInput`、`_runPortableHookEvent`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`1964-2040`、`2217-2300`

#### B. Notification 不是全量覆盖

- 已有统一 helper：`_writePortableNotificationNotice()`
- 它会同时发 `run.notice` 和 `Notification` hook
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`_writePortableNotificationNotice`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`976-999`

但 `GatewayRuntime` 内仍存在多处直接 `writeEvent("run.notice", ...)`，例如：

- 当前行号：`1210`、`1361`、`1395`、`1439`、`1746`、`2116`、`2158`、`2170`、`2709`、`3147`、`3203`、`3233`

这意味着：skill-scoped `Notification` hooks 只能看到一部分通知，不是官方“所有通知类型都能匹配”的效果。

#### C. UserPromptSubmit / SessionStart 的 additional context 注入时机不对

- 当前 `additionalContext` 会被 `_queueRuntimeHint()` 推到 `pendingFollowUpItems`
- 下一轮 `_getFollowUpMessages()` 才会作为 follow-up message 注入
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`_queueRuntimeHint`、`_getFollowUpMessages`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`966-974`、`1722-1731`

这和官方 hooks 文档里“在本轮 Claude 处理前追加上下文”的预期不一致。

#### D. command hook 仍在 Gateway 直接执行 shell

- `_executePortableHookHandler()` 的 `command` 分支直接 `spawn(shell, ["-lc", command])`
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`_executePortableHookHandler`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`2062-2127`

这与仓库总约束冲突：

- Gateway 应只做编排
- 本机命令执行必须在 Desktop

同时，仓库里已经有现成可复用桥：

- 文件：`apps/gateway/src/agent/runFactory.ts`
  - 符号：`PORTABLE_PROMPT_PREPROCESS_TOOL_NAME`
  - 当前行号：`527-528`
- 文件：`apps/desktop/src/agent/toolRegistry.ts`
  - 符号：`portable.skill.preprocess`
  - 当前行号：`3931-4015`

#### E. PermissionRequest 还没接 thread waiting / approval

- 线程状态事实源已支持 `waitingFor: "approval"`
- `ApprovalItem` / `pendingApprovalIds` / `thread.waiting.updated` 已存在
- 代码锚点：
  - `apps/gateway/src/agent/runtime/threadState.ts#updateThreadWaiting`，当前行号：`80-98`
  - `packages/shared/src/runtime/thread-turn-item.ts#ThreadRecord`，当前行号：`86-106`
  - `packages/shared/src/runtime/thread-turn-item.ts#ApprovalItem`，当前行号：`183-194`
  - `apps/gateway/src/agent/runFactory.ts#emitThreadWaitingUpdated`，当前行号：`5273-5288`
  - `apps/desktop/src/agent/wsTransport.ts#thread.waiting.updated`，当前行号：`1198-1208`

但当前 portable `PermissionRequest` 只是在 hook 里拿一段 `hookMessage`，并没有：

- 官方 `allow / deny` 决策桥接
- “hook 未决 -> 走本产品 approval” 的结构化桥接
- `waitingFor=approval`
- 结构化 approval item
- 用户确认后的 resume 路径

#### F. PreCompact / PostCompact 没覆盖真实 compact

- `GatewayRuntime` 目前只在 `compactToolResultEnvelope()` 前后触发 compact hooks
- 代码锚点：
  - 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - 符号：`_compactToolResultWithPortableHooks`
  - HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
  - 当前行号：`1026-1062`

而真实对话摘要 compact 发生在 Desktop：

- 文件：`apps/desktop/src/agent/gatewayAgent.ts`
- 符号：`rollDialogueSummaryIfNeeded`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`
- 当前行号：`2687-2753`
- 真实触发日志：`context.summary.roll`（`2720-2733`）

---

## 四、外部调研摘要

### 4.1 Anthropic 官方 hooks 文档结论

来源：

- Claude Code Hooks 参考：
  - <https://docs.anthropic.com/en/docs/claude-code/hooks>

关键结论：

1. `SessionStart` matcher 不是工具名，而是 session source，官方列出 `startup / resume / clear / compact`。
2. `UserPromptSubmit` hooks 可以直接为本轮处理追加上下文，而不是排到下一轮 follow-up。
3. `PermissionRequest` 不只是观测事件，官方允许 hook 返回结构化 `allow / deny` 决策。
4. `Stop` 与 `SubagentStop` 可以通过顶层 `decision=block` + `reason` 阻止 Claude 停止。
5. `PreCompact / PostCompact` 的 matcher 针对 `manual / auto`，且 `PostCompact` 有 `compact_summary`。
6. `Notification` hooks 不可阻断通知，但能追加上下文；匹配对象是 notification type。
7. 官方当前 hooks 事件面已经显著大于我们 `v0.3` subset，还新增了 `InstructionsLoaded`、`StopFailure`、`Elicitation`、`ConfigChange` 等。
8. 官方对 command hook 的简单返回语义有特殊约定：exit code `0` 时，`UserPromptSubmit / SessionStart` 的 `stdout` 直接加入本轮上下文；其他事件的 `stdout` 则主要面向 transcript/debug。

### 4.2 对本次 spec 的影响

- `v0.4` 不需要一次性追齐全部新事件，但必须把已经声明支持的事件语义做完整，否则“事件名兼容”会制造误判。
- 当前最需要补的不是“再加 10 个 eventName”，而是把已经支持的这几个事件从“可触发”补到“按官方语义消费结果”。
- `command` hook 不能继续在 Gateway 深化；官方 docs 允许本地命令 hook，但我们的架构要求它必须走 Desktop。

### 4.3 明确不做

- 本轮不做：
  - `InstructionsLoaded`
  - `StopFailure`
  - `ConfigChange`
  - `WorktreeCreate / WorktreeRemove`
  - `Elicitation / ElicitationResult`
  - `TeammateIdle / TaskCompleted`
- 原因：
  - 这些事件要么涉及新的 runtime 设施，要么与“Claude Code skill 拿来直接用”的主阻塞相关性较低。

---

## 五、方案收敛

### 5.1 推荐方案

按 3 个 phase 收口：

1. `P0`：补齐已经宣称支持的 hooks 结果语义与通知覆盖。
2. `P1`：把 `command` hook 下沉到 Desktop，并把 `PermissionRequest` 接入 approval/waiting 状态机。
3. `P2`：把 `PreCompact / PostCompact` 扩到真实 dialogue summary compact，并补 live smoke / 官方样本验证矩阵。

### 5.2 备选方案

只做文档澄清，不继续补代码：

- 优点：成本低，不动运行时。
- 缺点：用户继续会遇到“文档看起来支持，实际行为差一截”的问题。
- 结论：不推荐。

### 5.3 设计原则

1. 只补已经露出的兼容面，不凭空扩大战场。
2. hooks 只能提供补充决策，不能绕过 Crab 自身硬门禁。
3. 所有命令执行都走 Desktop。
4. approval/waiting 以 thread state 为事实源，`workflow` 只做镜像。

---

## 六、改动点清单

## Fix 1（P0）：补齐 hooks 结果消费语义与 Notification 覆盖

- 优先级：`P0`
- 文件：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号 / 当前锚点：
  - `PortableHookEventName`，`144-157`
  - `_writePortableNotificationNotice`，`976-999`
  - `_queueRuntimeHint`，`966-974`
  - `_getFollowUpMessages`，`1722-1731`
  - `_runPortableHookEvent`，`2217-2300`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`

### 问题

当前“事件枚举兼容”和“事件语义兼容”不一致：

- `UserPromptSubmit / SessionStart` 的额外上下文进入了下一轮，而不是本轮模型调用前。
- `PostToolUse / PostToolUseFailure / Stop / SubagentStop` 没有消费 block / reason / additionalContext。
- `Notification` 还漏掉大量 `run.notice` 直写路径。

### 方案

1. 把 hooks 结果统一拆成三类消费：
   - `prependContext`：进入本轮模型调用前上下文
   - `runtimeHint`：进入下一轮 follow-up
   - `decision/block`：在当前事件立即生效
2. 新增 `_consumePortableHookContext()` / `_consumePortableHookDecision()` 一类 helper，按事件决定落点。
3. `_buildPortableHookInput()` 对已支持事件补齐官方语义字段：
   - `SessionStart.source`
   - `Notification.notification_type`
   - `PreCompact / PostCompact.trigger`
   - `PostCompact.compact_summary`
4. `UserPromptSubmit / SessionStart` 的 `additionalContext` 改成进入“本轮 prepared messages 前置上下文”。
5. `command` hook 在这两个事件上若 exit code=`0` 且 stdout 非空，也按官方语义进入 immediate context，而不是丢弃。
6. `PostToolUse / PostToolUseFailure` 支持追加当前轮上下文，不支持修改既有工具结果。
7. `Stop / SubagentStop` 若返回 `decision=block`，则注入 runtime hint 并阻止当前回合以 `completed` 自然收口。
8. `GatewayRuntime` 内部全部 `run.notice` 路径收口到 `_writePortableNotificationNotice()`。

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-  private pendingFollowUpItems: CanonicalTranscriptItem[] = [];
+  private pendingHookImmediateItems: CanonicalTranscriptItem[] = [];
+  private pendingFollowUpItems: CanonicalTranscriptItem[] = [];
@@
-  private _queueRuntimeHint(text: string, reasonCodes: string[]) {
+  private _queueHookImmediateContext(text: string, reasonCodes: string[]) {
+    const content = String(text ?? "").trim();
+    if (!content) return;
+    this.pendingHookImmediateItems.push({
+      kind: "runtime_hint",
+      text: content,
+      reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.filter(Boolean) : [],
+    });
+  }
+
+  private _queueRuntimeHint(text: string, reasonCodes: string[]) {
@@
-    this.config.runCtx.writeEvent("run.notice", notice);
+    this.config.runCtx.writeEvent("run.notice", notice);
     await this._runPortableHookEvent({
@@
-        const additionalContext = String(hookOutput?.additionalContext ?? "").trim();
-        if (additionalContext) {
-          this._queueRuntimeHint(
+        const additionalContext = String(hookOutput?.additionalContext ?? "").trim();
+        if (additionalContext) {
+          const immediateEvents = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]);
+          const enqueue = immediateEvents.has(args.eventName) ? this._queueHookImmediateContext.bind(this) : this._queueRuntimeHint.bind(this);
+          enqueue(
             `[Portable Hook Context:${entry.skillId}/${args.eventName}]\n${additionalContext}`,
             ["portable_hook_context", `skill:${entry.skillId}`],
           );
         }
+        if (args.eventName === "Stop" || args.eventName === "SubagentStop") {
+          if (String(result.decision?.decision ?? "").trim().toLowerCase() === "block") {
+            return {
+              blocked: true,
+              blockMessage: String(result.decision?.reason ?? "").trim() || result.systemMessage || "Portable hook requested continue.",
+              updatedArgs,
+            };
+          }
+        }
```

### 边界情况

- `Notification` 仍不允许 hook 阻断通知本身，只允许补上下文。
- `Stop / SubagentStop` 的 `decision=block` 只影响“是否继续当前 run”，不能改写已落地的 proposal/approval 状态。
- `UserPromptSubmit / SessionStart` 的 immediate context 必须有 token 上限，防止 hook 文本无限膨胀。

### 验证方式

- 单测 / smoke：
  - `UserPromptSubmit` hook 返回 `additionalContext`，确认同一轮模型输入可见。
  - `SessionStart` / `UserPromptSubmit` command hook 仅返回 stdout，确认同一轮模型输入可见。
  - `Stop` hook 返回 `decision=block`，确认 run 不以 `completed` 结束。
  - `SubagentStop` hook 返回 `decision=block`，确认父 run 会继续。
  - `GatewayRuntime` 内任一 `run.notice` 路径都能触发 `Notification` hook。

---

## Fix 2（P1）：把 command hook 下沉到 Desktop 本地执行桥

- 优先级：`P1`
- 文件：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/desktop/src/agent/toolRegistry.ts`
- 符号 / 当前锚点：
  - `GatewayRuntime._executePortableHookHandler`，`2042-2215`
  - `PORTABLE_PROMPT_PREPROCESS_TOOL_NAME`，`527-528`
  - `portable.skill.preprocess`，`3931-4015`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`

### 问题

当前 hook command 是 Gateway 直接执行 shell：

- 偏离“本地执行”总约束
- 不经过 Desktop 审计 / 权限边界
- 后续若要支持 `CLAUDE_PROJECT_DIR`、stdin JSON、timeout 统一，也会在 Gateway 继续堆特例

### 方案

1. 新增一个内部 Desktop 工具，例如 `portable.hook.command`。
2. 输入合同对齐当前 hook command 需要的信息：
   - `skillId`
   - `eventName`
   - `projectDir`
   - `command`
   - `stdinJson`
   - `timeoutMs`
3. Gateway 不再 `spawn(shell)`，改成像 `portable.skill.preprocess` 一样下发内部工具并等待回包。
4. Desktop 侧复用现有 `window.desktop.shell.exec` 能力执行命令，并按官方 hook 约定回传：
   - `exitCode`
   - `stdout`
   - `stderr`
   - `timedOut`
   - `parsedJson`（best-effort）
5. Gateway 继续消费 exit code 2 / JSON decision 语义，但执行地点改到 Desktop。

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-    if (args.handler.type === "command") {
-      const command = String(args.handler.command ?? "").trim();
-      if (!command) return {};
-      const shell = process.env.SHELL || "/bin/sh";
-      const env = {
-        ...process.env,
-        CLAUDE_PROJECT_DIR: this._portableHookProjectDir(),
-        CLAUDE_HOOK_EVENT_NAME: args.eventName,
-      };
-      const child = spawn(shell, ["-lc", command], {
-        cwd: this._portableHookProjectDir(),
-        env,
-        stdio: ["pipe", "pipe", "pipe"],
-      });
+    if (args.handler.type === "command") {
+      const command = String(args.handler.command ?? "").trim();
+      if (!command) return {};
+      const execResult = await this.config.runCtx.executeInternalDesktopTool?.("portable.hook.command", {
+        skillId: args.skillId,
+        eventName: args.eventName,
+        command,
+        projectDir: this._portableHookProjectDir(),
+        stdinJson: args.input,
+        timeoutMs: args.handler.timeoutMs ?? 20_000,
+      });
+      const stdout = String(execResult?.stdout ?? "");
+      const stderr = String(execResult?.stderr ?? "");
+      const exitCode = typeof execResult?.exitCode === "number" ? execResult.exitCode : null;
```

```diff
*** Update File: apps/desktop/src/agent/toolRegistry.ts
@@
+  {
+    name: "portable.hook.command",
+    description: "内部工具：在本地执行 portable hook command，并返回 stdout/stderr/exitCode。",
+    ...
+  },
```

### 边界情况

- 只迁移 `command` hook；`http/prompt/agent` handler 保持现状。
- `command` hook 仍受 opMode / projectDir / Desktop shell 能力约束。
- 影子模式下可沿用 dry-run 或直接返回 `SHADOW_DRY_RUN`，但行为必须明确。

### 验证方式

- smoke：
  - `command` hook 在 Desktop 环境执行成功，Gateway 不再直接 `spawn`
  - exit code `2` 仍会阻断事件
  - JSON stdout 仍可解析 `permissionDecision / additionalContext`
  - Desktop 不可用时，返回结构化错误且不中断整个 run

---

## Fix 3（P1）：把 PermissionRequest 接进 approval / waiting 状态机

- 优先级：`P1`
- 文件：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/gateway/src/agent/runtime/threadState.ts`
  - `packages/shared/src/runtime/thread-turn-item.ts`
  - `apps/desktop/src/agent/wsTransport.ts`
- 符号 / 当前锚点：
  - `GatewayRuntime._emitPortablePermissionRequest`，`1001-1024`
  - `GatewayRuntime._runPortableHookEvent`，`2217-2300`
  - `updateThreadWaiting`，`80-98`
  - `ThreadRecord / ApprovalItem`，`86-106`、`183-194`
  - `emitThreadWaitingUpdated`，`5273-5288`
  - `thread.waiting.updated` 消费，`1198-1208`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`

### 问题

当前 `PermissionRequest` 最多只能让 hook 补一句 deny 原因，缺少两层关键能力：

- 官方语义里的 `allow / deny`
- 当 hook 没有决定、需要落回用户确认时，桥到 Crab 自己的 approval / waiting 流程

同时，Crab 自己已有线程等待/审批设施，却没有被 portable permission hook 复用。

### 方案

1. 扩展 `_runPortableHookEvent()` 的返回结构，增加：
   - `permissionBehavior?: "allow" | "deny"`
   - `approvalRequest?: { question?: string; detail?: unknown; updatedArgs?: Record<string, unknown> }`
2. `PermissionRequest` 事件消费逻辑：
   - `allow`：允许通过，并可用 `updatedInput` 覆盖本次 tool args
   - `deny`：沿用当前 denied path
   - 无显式决策但 runtime 仍需要用户确认：进入线程 `waitingFor=approval`
3. unresolved approval 分支要做 4 件事：
   - 写 `ApprovalItem`
   - 追加 `pendingApprovalIds`
   - `updateThreadWaiting({ waitingFor: "approval" })`
   - `run.end reason=approval_waiting`
4. 用户审批后的 resume 继续复用既有 thread waiting 恢复链路，不单独造第二套机制。
5. 明确优先级：
   - Crab 硬门禁优先
   - Portable hook 只能在硬门禁允许继续判定时做 allow/deny
   - 不允许 hook 用 `allow` 绕过 creative mode / proposal-first / delivery latch

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-  }): Promise<{ blocked?: boolean; blockMessage?: string; updatedArgs?: Record<string, unknown>; hookMessage?: string }> {
+  }): Promise<{
+    blocked?: boolean;
+    blockMessage?: string;
+    updatedArgs?: Record<string, unknown>;
+    hookMessage?: string;
+    permissionBehavior?: "allow" | "deny";
+    approvalRequest?: Record<string, unknown>;
+  }> {
@@
-        if (args.eventName === "PermissionRequest" && hookMessageCandidate) {
-          hookMessage = hookMessageCandidate;
-        }
+        if (args.eventName === "PermissionRequest") {
+          const behavior = String(hookOutput?.decision?.behavior ?? hookOutput?.permissionDecision ?? "").trim().toLowerCase();
+          if (behavior === "allow" || behavior === "deny") {
+            return {
+              updatedArgs,
+              hookMessage: hookMessageCandidate || undefined,
+              permissionBehavior: behavior as "allow" | "deny",
+              approvalRequest: hookOutput?.decision && typeof hookOutput.decision === "object" ? hookOutput.decision as Record<string, unknown> : undefined,
+            };
+          }
+          if (hookMessageCandidate) hookMessage = hookMessageCandidate;
+        }
```

```diff
*** Update File: apps/gateway/src/agent/runFactory.ts
@@
-      if (reason === "clarify_waiting" || reason === "proposal_waiting") {
+      if (reason === "clarify_waiting" || reason === "proposal_waiting" || reason === "approval_waiting") {
@@
-            kind: reason === "proposal_waiting" ? "proposal" : "clarify",
+            kind: reason === "approval_waiting" ? "approval" : reason === "proposal_waiting" ? "proposal" : "clarify",
```

### 边界情况

- approval 只在需要用户确认才能继续时触发，不能被滥用于“向用户闲聊确认”。
- `approval_waiting` 与 `proposal_waiting` 要明确区分；两者 UI 表现可以相近，但状态语义不能混。
- 若 hook 返回 `allow + updatedInput`，仍必须重新跑现有 tool policy / opMode / delivery latch 校验。

### 验证方式

- smoke：
  - `PermissionRequest -> allow`：工具继续执行，且 `updatedInput` 生效
  - `PermissionRequest -> deny`：返回 denied message
  - `PermissionRequest` 未显式 allow/deny 但 runtime 仍需审批：thread 进入 `waitingFor=approval`，Desktop 收到 `thread.waiting.updated`
  - 用户确认后能 resume，不残留脏 `pendingApprovalIds`

---

## Fix 4（P2）：让 PreCompact / PostCompact 覆盖真实 dialogue summary compact

- 优先级：`P2`
- 文件：
  - `apps/desktop/src/agent/gatewayAgent.ts`
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号 / 当前锚点：
  - `GatewayRuntime._compactToolResultWithPortableHooks`，`1026-1062`
  - `rollDialogueSummaryIfNeeded`，`2687-2753`
  - `context.summary.roll`，`2720-2733`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`

### 问题

当前 compact hooks 只覆盖工具结果 envelope 压缩，但 Claude 官方的 `PreCompact / PostCompact` 针对的是真正会话 compact。

因此官方 skill 若依赖：

- `trigger=manual/auto`
- `compact_summary`

在 Crab 里仍观测不到真实 compact 点。

### 方案

1. 保留现有“工具结果 envelope 压缩”的 hook，不回退。
2. 新增一条轻量 bridge，让 Desktop 在执行 `context.summary.roll` 前后通知 Gateway runtime。
3. 新增 compact scope：
   - `tool_result_envelope`
   - `dialogue_summary`
4. 真实 dialogue summary compact 输入对齐官方字段：
   - `trigger: "auto"`（本轮先只做自动 compact）
   - `custom_instructions: ""`
   - `compact_summary`（PostCompact）
5. hook 返回值仍只支持附加上下文 / 记录，不允许篡改 summary 内容。

### unified diff（草案）

```diff
*** Update File: apps/desktop/src/agent/gatewayAgent.ts
@@
-  args.log("info", "context.summary.roll", {
+  args.log("info", "context.summary.roll", {
     mode: args.mode,
@@
+  args.transport?.writeEvent?.("portable.compact.lifecycle", {
+    phase: "pre",
+    scope: "dialogue_summary",
+    trigger: "auto",
+    mode: args.mode,
+    deltaTurns: delta.length,
+  });
   const ret = await fetchContextSummaryOnce({
@@
+  args.transport?.writeEvent?.("portable.compact.lifecycle", {
+    phase: "post",
+    scope: "dialogue_summary",
+    trigger: "auto",
+    mode: args.mode,
+    compactSummary: ret.ok ? ret.summary : "",
+  });
```

```diff
*** Update File: apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
+    if (event === "portable.compact.lifecycle") {
+      // map pre/post dialogue summary compaction into portable hook events
+    }
```

### 边界情况

- 先只覆盖 `auto`；`manual /compact` 不在本轮范围。
- 不引入后台 async compact worker。
- `compact_summary` 只传摘要文本，不额外暴露完整历史。

### 验证方式

- smoke：
  - 触发 `context.summary.roll` 时，能看到 `PreCompact -> PostCompact`
  - `compact.trigger=auto`
  - `compact.scope=dialogue_summary`
  - `PostCompact` 可拿到 `compact_summary`

---

## Fix 5（P2）：补 live smoke 与官方样本验证矩阵

- 优先级：`P2`
- 文件：
  - 新增 `apps/gateway/scripts/smoke-claude-hook-parity.ts`
  - 新增或补充 `docs/research/claude-code-skill-hooks-live-validation-2026-03-21.md`
- HEAD：`274025dd4936acc05d28d1c846ccf25b21b82ab7`

### 问题

`v0.3` 已完成 build + code smoke，但剩下这些差异高度依赖真实运行态：

- `thread.waiting.updated`
- `run.notice`
- Desktop 本地 hook command
- `context.summary.roll`

如果没有 live 验证矩阵，后面极容易出现“代码看起来通了，但桌面态仍断链”。

### 方案

1. 增加脚本级 smoke：
   - mock `GatewayRuntime` hooks matrix
   - 验证 allow / deny / approval-bridge / stop-block / notification / compact
2. 增加 Desktop live checklist：
   - 本地 `command` hook
   - `PermissionRequest -> approval`
   - `Notification` 实时到 UI log
   - `context.summary.roll` 前后 hook
3. 增加官方样本矩阵：
   - 最少选 3 类场景
   - 样本优先级：
     1. 有源码且依赖 hooks 的官方/社区 skill
     2. `.claude/settings.json` 级 hook 样例
     3. 当前仓库自制最小 hook sample

### 样本矩阵建议

| 样本 | 覆盖点 | 通过标准 |
|------|--------|---------|
| 最小 `UserPromptSubmit + SessionStart` sample | immediate context | 同轮可见上下文 |
| 最小 `PermissionRequest unresolved` sample | approval wait | `waitingFor=approval` |
| 最小 `Stop block` sample | stop continue | run 不自然结束 |
| 最小 `Notification` sample | run.notice 覆盖 | UI log 可见 |
| 最小 `PreCompact/PostCompact` sample | dialogue summary compact | `compact_summary` 可见 |

### 边界情况

- 本轮 smoke 优先覆盖“我们已宣称支持的 subset”。
- 不用 bundled skill 当验收门槛。

### 验证方式

- `gateway build`
- `desktop build`
- script smoke
- Desktop live smoke
- 样本矩阵手工记录落盘

---

## 七、风险与连锁反应

### 7.1 兼容性风险

- `Notification` 覆盖扩大后，部分现有 portable hooks 可能比以前更频繁触发。
- `Stop / SubagentStop` 若支持 block，可能让某些 run 比之前多走一轮，需要 guard 防无限循环。

### 7.2 架构风险

- 若 `command` hook 迁移不彻底，可能同时存在 Gateway/Desktop 双执行路径，造成语义漂移。
- `PermissionRequest -> approval` 若直接在 GatewayRuntime 里写 thread state，容易破坏 runFactory 作为线程事件事实源的职责边界。

### 7.3 性能风险

- immediate context 注入若不做长度限制，会明显增加 prompt 体积。
- compact hook 若把完整摘要/历史多次回灌，可能触发 token 膨胀。

### 7.4 防跑偏原则

- hooks 只能补充 Claude-style 行为，不得成为绕开产品 gate 的旁路。
- 真实本地执行边界比“Claude 官方怎么做”优先级更高。

---

## 八、实施顺序

1. 先做 `Fix 1`
2. 再做 `Fix 2`
3. 再做 `Fix 3`
4. 最后做 `Fix 4 + Fix 5`

原因：

- `Fix 1` 是当前宣称兼容但语义未闭环的核心缺口
- `Fix 2 / Fix 3` 分别修执行边界和审批状态，是 P1 主风险
- `Fix 4 / Fix 5` 属于收口与验收，不宜先做

---

## 九、验证 Checklist

- 代码级
  - `npm run -w @ohmycrab/gateway build`
  - `npm run -w @ohmycrab/desktop build`
- hooks 语义
  - `UserPromptSubmit` 的 `additionalContext` 同轮可见
  - `SessionStart` 可按 `startup/resume/clear/compact` 匹配
  - `PostToolUse` 可追加上下文
  - `Stop / SubagentStop` 可阻止自然结束
- notification
  - `GatewayRuntime` 内所有 `run.notice` 都能触发 `Notification`
- approval
  - `PermissionRequest allow`
  - `PermissionRequest deny`
  - `PermissionRequest unresolved -> waitingFor=approval`
- compact
  - `tool_result_envelope` 仍保留
  - `dialogue_summary` 新增可观测
- live
  - Desktop 本地 command hook 实际执行
  - `thread.waiting.updated` UI 状态正确
  - `run.notice` 在前端日志中可见

---

## 十、回滚与兼容说明

- 若 `Fix 1` 引入 run 行为抖动，可先保留事件枚举，回退新的 decision 消费逻辑。
- 若 `Fix 2` 出现 Desktop 执行不稳，可临时保留 feature flag：
  - `portableHookCommandExecution=desktop|gateway`
  - 默认切到 `desktop`
  - smoke 稳定后再删掉 `gateway`
- 若 `Fix 3` 的 approval 闭环不稳定，可先只保留 `allow/deny`，把 unresolved->approval bridge behind flag。
- 若 `Fix 4` 出现 compact 链路噪音，可先只做日志桥，不触发真正 portable hook handler。

---

## 十一、涉及文件清单

- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/desktop/src/agent/toolRegistry.ts`
- `apps/desktop/src/agent/gatewayAgent.ts`
- `apps/desktop/src/agent/wsTransport.ts`
- `apps/gateway/src/agent/runtime/threadState.ts`
- `packages/shared/src/runtime/thread-turn-item.ts`
- `apps/gateway/scripts/smoke-claude-hook-parity.ts`
- `docs/research/claude-code-skill-hooks-live-validation-2026-03-21.md`

---

## 十二、本轮明确不做

- 不把 `InstructionsLoaded / StopFailure / ConfigChange / Elicitation / Worktree*` 一起并入 `v0.4`
- 不做 hooks async/background runtime
- 不支持 hook 修改已生成的 compact summary 内容
- 不允许 portable hook 绕过：
  - creative mode 高风险工具门禁
  - proposal-first
  - delivery latch
  - 现有 allowed-tools policy

这份 `v0.4` 的目标不是“Claude hooks 全量原生等价”，而是把已经露出来的 hooks 兼容面从 subset 收到稳定可用，并且不破坏 Crab 当前架构边界。
