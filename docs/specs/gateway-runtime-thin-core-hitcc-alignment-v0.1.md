# Gateway Runtime Thin-Core / HitCC 对齐重构 v0.1

状态：Implemented（本地验证完成，待真实 provider 手测） | 优先级：P0 | 日期：2026-03-30  
HEAD：`d7a392bad387b796c1053343ce04567dc847e4f1`

> 实施备注（2026-03-30）：
> - P0/P1 主链代码已落地。
> - 已通过：`smoke:runtime-parity`、`build(@ohmycrab/gateway)`、`build(@ohmycrab/desktop)`、`smoke:style-orchestrator`
> - 未通过但判定为存量问题：
>   - `smoke:workflow-sticky`：脚本仍断言旧 routeId=`web_radar`，当前实际为 `task_execution`
>   - `test:runner-turn`：脚本仍引用已删除的 `writingAgentRunner.js`
> - 尚未做真实在线 provider 手测（如 `gpt-5.4` 实跑）

> 本 spec 的设计依据只使用两类材料：
> 1. 当前仓库源码与近期 commit
> 2. 本地 `HitCC` 文档库：`/tmp/HitCC`
>
> 仓库内旧 spec / research 仅作为失败历史与上下文索引，不作为本次方案的架构依据。

---

## 0. 结论先行

这次不再继续给 `GatewayRuntime` 补白名单，也不做 “如果是 reasoning model 就再加一条 prompt” 这种小修。

明确结论：

1. 当前 `reasoning mode 不说话 / 本轮已结束` 的核心根因，不是 provider 本身，而是我们把 **`no-tool` 回合误判成 completed**。
2. `GatewayRuntime` 已经从“运行时壳”长成了“产品策略总控器”，`implicit_completion` 只是它变胖后的一个症状。
3. 对齐 HitCC，正确方向不是继续堆 guard，而是把 runtime 收成：
   - `loop / transcript / tool routing / stop hook`
   - 明确的 `no-tool branch`
   - 明确的 `workflow continuation`
   - 明确的 UI fallback
4. 本次推荐方案是 **精减 + 重构**：
   - 删除 `implicit_completion + abort + 白名单后处理` 这条补丁链
   - 用显式 `no-tool branch decision` 替代
   - 让 “有可见正文的无工具回合” 自然结束
   - 让 “无可见正文的无工具回合” 显式失败为 `silent_no_output`
   - 把 style 专属 follow-up 从 runtime 硬编码 fallback 收回到声明式 workflow

一句话：

> 不再把“没调工具”翻译成“已经完成”，而是把它还原成一个需要显式判定的 runtime 分支。

---

## 1. 已有上下文索引

### 1.1 当前相关代码锚点

| 文件 | 当前职责 | 现状问题 |
|------|----------|----------|
| `apps/gateway/src/agent/runtime/RuntimeFactory.ts` | 统一创建 `GatewayRuntime` | runtime 入口单一，但所有职责都压进了 `GatewayRuntime` |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | loop orchestration / transcript / tool routing / follow-up / outcome | 已混入 no-tool 完成判定、style follow-up、todo nag、delivery nag、run.done 拦截 |
| `apps/gateway/src/agent/runtime/kernel/PiLoopKernel.ts` | `pi-agent-core` 薄包装层 | 本身很薄，不是主问题 |
| `apps/gateway/src/agent/turnEngine.ts` | canonical event / tool pair / run outcome snapshot | 已有 turn engine，但还没接管 no-tool branch |
| `apps/desktop/src/agent/wsTransport.ts` | run 结束兜底展示 | 当前把“无正文结束”统一补成“本轮已结束” |

### 1.2 近期相关 commit

| Commit | 含义 | 这次 spec 的判断 |
|--------|------|------------------|
| `b393546` | 首次引入 `implicit_completion` 硬停 | 问题起点；把 HitCC/Claude Code 语义翻译粗了 |
| `5322404` | 给 `implicit_completion` 加 outcome 白名单 | 二次补丁；说明补丁链已经开始自我缠绕 |
| `3e15aea` | 删除 intent router / per-turn gating 核心逻辑 | 说明主链已经在做“减层”，但 runtime 终止语义未同步收口 |
| `b640372` | 工具管理架构瘦身 | 工具层在减，runtime 终止层反而继续加 |
| `ca8b99b` | tighten writing runtime boundaries | 说明“运行边界”已经是主矛盾，不是孤立 bug |

### 1.3 旧 spec / 旧修复记录（仅作失败历史）

| 文档 | 价值 | 本次如何使用 |
|------|------|-------------|
| `docs/specs/fix-agent-self-talk-v1.md` | 第一次修自言自语 | 只用于确认 `consecutiveTextOnlyTurns` 已被多轮修补 |
| `docs/specs/fix-agent-selftalk-mcp-failure-v4.md` | 后续给 follow-up 加限流和问句检测 | 只用于确认 follow-up 补丁链已经很长 |
| `docs/specs/pi-agent-core-migration-v0.1.md` | 当初的 pi 迁移方向 | 只用于确认 kernel 本应薄 |
| `docs/specs/fix-style-imitate-contract-runtime-convergence-v1.md` | 曾经试图把 style 从 runtime 收口 | 只用于确认 runtime 已经有“把产品逻辑塞回 executor”的前科 |

### 1.4 当前最关键的代码事实

- `GatewayRuntime` 里 `turn_end` 只要 `currentTurnToolCalls === 0` 就累计 `consecutiveTextOnlyTurns`，到第 2 次直接 `implicit_completion` 并 `abort()`：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:4067`
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:4080`
- `GatewayRuntime` 其实已经有“是否存在用户可见正文”的判断函数 `_assistantHasVisibleText()`，但只拿去激活 delivery latch：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:1762`
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:3847`
- `pi-agent-core` 自己在 “no tool calls” 时只是停下来检查 follow-up，不会自动把 “无工具” 等价成 “完成”：
  - `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:110`
  - `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:124`
- Desktop 的兜底是在“本轮没有 assistant 正文”时补一句“本轮已结束”：
  - `apps/desktop/src/agent/wsTransport.ts:1553`

---

## 2. 需求卡片

- 场景：`gpt-5.4` 等 reasoning model 在部分 run 中没有输出用户可见正文，Gateway 仍把 run 结束为 `completed`，Desktop 再补成“本轮已结束”；同时 `GatewayRuntime` 在多轮修补后越来越胖。
- 目标：基于 HitCC，把 runtime 收成“薄核心 + 明确 no-tool 分支 + 明确 continuation 边界”，用重构替代补丁链。
- 对标：只对标本地 `HitCC`，不以仓库内旧 docs 作为架构依据。
- 约束：
  - 不做 prompt 小补丁
  - 不做 provider / model 特判
  - 不继续为 `implicit_completion` 增加更多白名单
  - 不重写整个工具系统或 Desktop/Gateway 执行边界
- 不做什么：
  - 不顺手改 tool exposure 主链
  - 不顺手重写 MCP / skill / collab
  - 不把本次 spec 扩成全量 runtime 再造

---

## 3. 现状地图

### 3.1 当前调用链

```text
RuntimeFactory.createRuntime()
  -> GatewayRuntime.run()
    -> PiLoopKernel.run()
      -> pi-agent-core agentLoop()
        -> GatewayRuntime._handleKernelEvent()
          -> GatewayRuntime._getFollowUpMessages()
          -> GatewayRuntime turn_end outcome / abort
    -> run.end
      -> Desktop wsTransport maybeAppendRunEndFeedback()
```

### 3.2 相关文件

| 文件 | 符号/入口 | 当前 HEAD 行号 | 与需求关系 |
|------|-----------|---------------|------------|
| `apps/gateway/src/agent/runtime/RuntimeFactory.ts` | `createRuntime` | `23-41` | 当前所有 runtime 都汇聚到 `GatewayRuntime` |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | `run` | `1056-1105` | outcome 后处理仍带 `implicit_completion` 白名单 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | `_assistantHasVisibleText` | `1762-1770` | 已有“可见正文”能力，可复用 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | `_resolveStyleWorkflowFollowUp` | `1958-2043` | 同时存在 workflow declaration 和 runtime fallback 两套真相 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | `_getFollowUpMessages` | `2099-2208` | 已混入 stop hook、style follow-up、implicit_completion、防自言自语、todo nag、delivery nag |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | `_handleKernelEvent("turn_end")` | `4067-4088` | 当前 bug 主触发点 |
| `apps/gateway/src/agent/turnEngine.ts` | `TurnEngine` | `35-116` | 已是自然扩展点，但目前只记 canonical 事件，不做 no-tool 判定 |
| `apps/gateway/src/agent/runtime/kernel/PiLoopKernel.ts` | `run` | `147-174` | HitCC 对齐后应继续保持薄 |
| `apps/gateway/src/agent/runFactory.ts` | `activeWorkflowDeclarations` 构建 | `2563-2570` | 已有声明式 workflow 真相，可承接 style continuation |
| `apps/gateway/src/agent/runFactory.ts` | `runCtx.activeWorkflowDeclarations` 注入 | `5350-5362` | runtime 已经能拿到声明，不需要再补 fallback |
| `apps/desktop/src/agent/wsTransport.ts` | `maybeAppendRunEndFeedback` | `1553-1589` | 当前把 silent run 误渲染成 normal completion |

### 3.3 可复用设施

- `TurnEngine` 已有 canonical 事件、pending tool call、tool_result 配对信息，可扩成显式 no-tool branch 事实源。
- `sanitizeAssistantUserFacingText()` 已能判定“用户可见正文 vs 纯 JSON / 工具痕迹”：
  - `apps/gateway/src/agent/userFacingText.ts:36-64`
- `runFactory` 已构建 `activeWorkflowDeclarations`，style follow-up 已经有声明式路径，不需要 runtime 继续手写 phase 文案：
  - `apps/gateway/src/agent/runFactory.ts:2563-2570`
  - `apps/gateway/src/agent/runFactory.ts:5360-5361`

### 3.4 约束点

- `PiLoopKernel` 已经很薄，不能把本次问题误判成 kernel 问题再往里塞逻辑。
- `run.end` 线程状态收口已经能区分 `completed / failed / waiting_user / waiting_approval`：
  - `apps/gateway/src/agent/runFactory.ts:4612-4728`
- style workflow 已经有声明式配置来源；如果继续让 runtime 手写 fallback，就会继续维持双真相。

### 3.5 现状结论

#### A. 当前 bug 是“沉默回合被误判成完成”

- `turn_end` 只看 `currentTurnToolCalls`，不看 `hasVisibleAssistantText`。
- `implicit_completion` 通过 `abort()` 强行结束。
- 后处理再给 `implicit_completion` 加白名单。
- Desktop 再把无正文 run 兜底成“本轮已结束”。

这是一条典型的补丁链，而不是一个干净的状态机。

#### B. `GatewayRuntime` 当前太像“产品逻辑总控”

当前一个方法 `_getFollowUpMessages()` 已经同时承接：

- stop hook
- style workflow continuation
- implicit completion belt-and-suspenders
- tool failure repair 抑制
- todo nag
- delivery nag
- plan no execution nag

这已经不是 runtime 壳，而是 runtime + workflow + UX 规则的混合体。

#### C. style continuation 仍有双真相

`_resolveStyleWorkflowFollowUp()` 先走声明式 `activeWorkflowDeclarations`，没命中再回退到 runtime 硬编码 phase 推导：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:1976-2043`

这和本次“不要再补”目标直接冲突。

---

## 4. HitCC 调研摘要

### 4.1 命中的一手证据

| HitCC 文档 | 结论 |
|-----------|------|
| `/tmp/HitCC/README_zh.md` | HitCC 的重点是“职责边界与重写骨架”，不是机械模仿 bundle 文件树 |
| `/tmp/HitCC/docs/01-runtime/04-agent-loop-and-compaction/03-no-tool-branch-recovery-stop-and-reactive-compact.md` | no-tool branch 是 `recovery -> stop hook -> completed` 的尾部分支，不是 “no tool = done” 的粗暴翻译 |
| `/tmp/HitCC/docs/01-runtime/04-agent-loop-and-compaction/04-tool-round-next-turn-and-terminal-reasons.md` | completed / aborted / model_error / hook_stopped 等终止原因都是显式 reason，不靠 UI 猜 |
| `/tmp/HitCC/docs/01-runtime/05-model-adapter-provider-and-auth.md` | `callModel` 这一层本身很薄，provider/retry/fallback 应收在适配层 |
| `/tmp/HitCC/docs/02-execution/03-prompt-assembly-and-context-layering/04-request-level-injection-layers-and-local-server-boundary.md` | prompt-text、schema/request-options、transport 必须拆开 |
| `/tmp/HitCC/docs/04-rewrite/01-rewrite-architecture.md` | engine / prompt / tools / hooks / agents / ui 应分层，不应回流成一个全能 runtime |

### 4.2 可借鉴

1. **no-tool branch 是 runtime 的正式分支，不是一个临时 guard。**
2. **callModel / kernel 应保持薄。**
3. **workflow / hook / tool / prompt / ui 的边界要清楚。**
4. **终止 reason 必须显式，不靠前端文案兜底猜。**

### 4.3 要规避

1. 把 HitCC 的 “无工具尾分支” 简化成 “无工具 = 完成”。
2. 把 provider 输出形态变化误当成核心 bug。
3. 继续让 `GatewayRuntime` 同时承担 engine、workflow、UX nag、产品规则四层职责。

### 4.4 外部结论

- 推荐模式：**thin runtime core + explicit no-tool branch + declaration-first continuation**
- 放弃模式：
  - `implicit_completion + abort + 后处理白名单`
  - `if (reasoningModel) ...` 之类 provider/model 特判
  - UI 只改文案，不改 runtime 事实

---

## 5. 方案收敛

### 5.1 推荐方案

推荐做 **薄核心重构**，分两步落地：

#### P0：先把 no-tool 分支做对

- 不再通过 `implicit_completion` + `abort()` 强行终止。
- `GatewayRuntime` 改为在 turn 结束时生成显式 turn observation。
- `TurnEngine` 扩展为：
  - 区分 `with_tool`
  - 区分 `no_tool_with_visible_text`
  - 区分 `no_tool_without_visible_text`
- 规则改成：
  - `no_tool_with_visible_text`：不注入额外完成补丁，让 `pi-agent-core` 自然结束
  - `no_tool_without_visible_text`：显式失败 `silent_no_output`

#### P1：把 runtime 瘦回 engine 边界

- `_resolveStyleWorkflowFollowUp()` 只消费 `activeWorkflowDeclarations`，不再手写 fallback phase。
- `runFactory` 在 skill 激活阶段保证 declaration 存在；缺失时 fail-close，而不是让 runtime 现编。
- Desktop run-end fallback 改为 reason-aware，不再把 silent run 渲染成 normal completion。

### 5.2 备选方案（不推荐）

#### 备选 A：在现有 `implicit_completion` 上再补 visible-text 判断

做法：
- 保留 `consecutiveTextOnlyTurns`
- turn_end 时改成 “无工具且无可见正文才不算完成”

不推荐原因：
- 仍然延续 `abort + 后处理白名单` 这条补丁链
- 仍然把 completed 建立在 heuristic 上，而不是 no-tool branch 正式语义上
- 下一次再出 silent/provider 变体，还会继续长补丁

#### 备选 B：只在 prompt 上限制 reasoning model

做法：
- 对 `gpt-5.4` 加更强“必须输出最终答案”提示
- 或加 provider-specific reasoning 配置

不推荐原因：
- 掩盖 runtime 真问题
- 会把模型形态差异继续反向渗入 runtime
- 不能解决 Desktop 把 silent run 渲染成 normal completion 的问题

---

## 6. 改动点清单

## Fix 1（P0）：让 `TurnEngine` 正式接管 no-tool branch 分类

- 优先级：P0
- 文件：`apps/gateway/src/agent/turnEngine.ts`
- 符号：`TurnEngine`
- 当前 HEAD：`d7a392bad387b796c1053343ce04567dc847e4f1`
- 当前行号：`35-116`
- 改动原理：
  - 现有 `TurnEngine` 已经掌握 canonical event、tool pairing、model_text_delta。
  - 这里是最自然的落点，不需要再新造一层全能 runtime helper。
  - 扩展它去承接 `turnObservation` 和 `no-tool branch classification`，比继续在 `GatewayRuntime` 上堆 `consecutiveTextOnlyTurns` 更符合 HitCC 的 “main loop state / no-tool branch” 分层。

### 统一 diff

```diff
--- a/apps/gateway/src/agent/turnEngine.ts
+++ b/apps/gateway/src/agent/turnEngine.ts
@@
-export type RunOutcome = {
+export type RunOutcome = {
   status: "completed" | "failed" | "aborted";
   reason: string;
   reasonCodes: string[];
   detail?: Record<string, unknown> | null;
 };
+
+export type TurnObservation = {
+  hasAssistantMessage: boolean;
+  hasVisibleAssistantText: boolean;
+  askedUser: boolean;
+  toolCallCount: number;
+};
+
+export type NoToolBranchKind =
+  | "with_tool"
+  | "no_tool_with_visible_text"
+  | "no_tool_without_visible_text";
@@
 export class TurnEngine {
@@
+  private lastTurnObservation: TurnObservation = {
+    hasAssistantMessage: false,
+    hasVisibleAssistantText: false,
+    askedUser: false,
+    toolCallCount: 0,
+  };
+
+  beginTurn(): void {
+    this.lastTurnObservation = {
+      hasAssistantMessage: false,
+      hasVisibleAssistantText: false,
+      askedUser: false,
+      toolCallCount: 0,
+    };
+  }
+
+  noteAssistantTurn(args: { hasVisibleAssistantText: boolean; askedUser: boolean }): void {
+    this.lastTurnObservation.hasAssistantMessage = true;
+    this.lastTurnObservation.hasVisibleAssistantText ||= args.hasVisibleAssistantText;
+    this.lastTurnObservation.askedUser ||= args.askedUser;
+  }
+
+  noteToolCall(): void {
+    this.lastTurnObservation.toolCallCount += 1;
+  }
+
+  classifyNoToolBranch(): NoToolBranchKind {
+    if (this.lastTurnObservation.toolCallCount > 0) return "with_tool";
+    if (this.lastTurnObservation.hasVisibleAssistantText) return "no_tool_with_visible_text";
+    return "no_tool_without_visible_text";
+  }
 }
```

### 边界情况

- 纯问答任务：`no_tool_with_visible_text`，自然完成。
- reasoning 模型返回思考但无用户可见正文：`no_tool_without_visible_text`，不再伪装成 completed。
- 工具回合：`with_tool`，不参与 no-tool 终止判定。

### 验证方式

- `TurnEngine` 新增单测或脚本断言：
  - visible text / no tool -> `no_tool_with_visible_text`
  - no visible text / no tool -> `no_tool_without_visible_text`
  - with tool -> `with_tool`

---

## Fix 2（P0）：删除 `implicit_completion` 补丁链，改为 natural stop + `silent_no_output`

- 优先级：P0
- 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：
  - `run`
  - `_handleKernelEvent`
  - `_getFollowUpMessages`
- 当前 HEAD：`d7a392bad387b796c1053343ce04567dc847e4f1`
- 当前行号：
  - 状态字段：`860-876`
  - outcome 后处理：`1079-1105`
  - follow-up：`2099-2188`
  - turn_end：`4067-4088`
- 改动原理：
  - `pi-agent-core` 已经天然支持 “无工具且无 follow-up -> 结束”。
  - 因此 `GatewayRuntime` 不应再通过 `implicit_completion + abort()` 人工模拟这个行为。
  - 真正需要被硬判的不是 “无工具”，而是 “无工具且无可见正文”。

### 统一 diff

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-  /** 连续纯文本回合计数——用于隐式完成检测（参考 Codex 模式） */
-  private consecutiveTextOnlyTurns = 0;
+  /** 连续“有可见正文但无工具”回合，仅用于 follow-up 抑制，不再驱动 completed */
+  private consecutiveVisibleNoToolTurns = 0;
+  /** 连续“无可见正文且无工具”回合，用于 silent output 诊断 */
+  private consecutiveSilentNoToolTurns = 0;
@@
       case "turn_start":
         this.turn += 1;
         this.currentTurnToolCalls = 0;
+        this.turnEngine.beginTurn();
         this.turnEngine.setTurn(this.turn);
@@
         if (isAssistantMsg(msg)) {
+          const hasVisibleText = this._assistantHasVisibleText(msg);
+          const lastText = hasVisibleText ? this._getLastAssistantText() : "";
+          const askedUser = Boolean(lastText && this._detectAssistantAskingUser(lastText));
+          this.turnEngine.noteAssistantTurn({ hasVisibleAssistantText: hasVisibleText, askedUser });
           this._pushAssistantToTranscript(msg);
-          if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && this._assistantHasVisibleText(msg)) {
+          if (msg.stopReason !== "error" && msg.stopReason !== "aborted" && hasVisibleText) {
             await this._activateDeliveryLatch("assistant_text", { stopReason: msg.stopReason ?? null });
           }
@@
       case "tool_execution_start": {
         const rawToolName = this._decodeRuntimeToolName(event.toolName);
         this.totalToolCalls += 1;
         this.currentTurnToolCalls += 1;
+        this.turnEngine.noteToolCall();
@@
-      // 最终 outcome（run.done / implicit_completion 在 turn_end 中已设置 outcome，此处不覆盖）
-      if (this.outcome.reason === "run_done" || this.outcome.reason === "approval_waiting" || this.outcome.reason === "implicit_completion") {
+      // 最终 outcome（run.done / waiting / silent_no_output 在事件处理中已设置 outcome，此处不覆盖）
+      if (this.outcome.reason === "run_done" || this.outcome.reason === "approval_waiting" || this.outcome.reason === "silent_no_output") {
         // 已由对应处理器设置，保持不变
@@
       case "turn_end":
         this.turnLocalRawToolResults.clear();
-        if (this.currentTurnToolCalls === 0) {
-          this.consecutiveTextOnlyTurns += 1;
-        } else {
-          this.consecutiveTextOnlyTurns = 0;
-        }
-        if (this.consecutiveTextOnlyTurns >= 2) {
-          this._setOutcome({
-            status: "completed",
-            reason: "implicit_completion",
-            reasonCodes: ["implicit_completion", "consecutive_text_only"],
-          });
-          ac.abort();
-          return;
-        }
+        switch (this.turnEngine.classifyNoToolBranch()) {
+          case "with_tool":
+            this.consecutiveVisibleNoToolTurns = 0;
+            this.consecutiveSilentNoToolTurns = 0;
+            break;
+          case "no_tool_with_visible_text":
+            this.consecutiveVisibleNoToolTurns += 1;
+            this.consecutiveSilentNoToolTurns = 0;
+            break;
+          case "no_tool_without_visible_text":
+            this.consecutiveVisibleNoToolTurns = 0;
+            this.consecutiveSilentNoToolTurns += 1;
+            this._setOutcome({
+              status: "failed",
+              reason: "silent_no_output",
+              reasonCodes: ["silent_no_output", "no_tool_branch"],
+            });
+            return;
+        }
         await this._enforceTurnLevelGuards(ac);
         return;
@@
-    if (this.consecutiveTextOnlyTurns >= 2) {
-      const item: CanonicalTranscriptItem = {
-        kind: "runtime_hint",
-        text: "你已连续两轮没有调用任何工具。请立即调用 run.done 结束。",
-        reasonCodes: ["implicit_completion_force_done"],
-      };
-      return [item as unknown as AgentMessage];
-    }
-
     if (
-      this.consecutiveTextOnlyTurns >= 1 &&
+      this.consecutiveVisibleNoToolTurns >= 1 &&
       this.failureDigest.failedCount > this.lastSteeringFailureCount
     ) {
       this.lastSteeringFailureCount = this.failureDigest.failedCount;
     }
```

### 边界情况

- 有可见正文但未 `run.done`：runtime 不再强行插 “请立即 run.done”，而是让 kernel 走 natural stop。
- 无正文 silent turn：直接 `failed/silent_no_output`，不再假装成功。
- `run.done` / `approval_waiting` 保持原语义。

### 验证方式

- `npm run -w @ohmycrab/gateway test:runner-turn`
- `npm run -w @ohmycrab/gateway smoke:runtime-parity`
- 手工复现：
  - `gpt-5.4` reasoning run 无正文 -> `run.end.reason=silent_no_output`
  - `claude/gpt/gemini` 正常 text-only answer -> 正常 completed

---

## Fix 3（P1）：style continuation 收回声明式 workflow，删除 runtime fallback phase 文案

- 优先级：P1
- 文件：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - `apps/gateway/src/agent/runFactory.ts`
- 符号：
  - `_resolveStyleWorkflowFollowUp`
  - `activeWorkflowDeclarations`
- 当前 HEAD：`d7a392bad387b796c1053343ce04567dc847e4f1`
- 当前行号：
  - `runFactory.ts:2563-2570`
  - `runFactory.ts:5350-5362`
  - `GatewayRuntime.ts:1958-2043`
- 改动原理：
  - 既然 `runFactory` 已经构建并注入 `activeWorkflowDeclarations`，runtime 不应再在 declaration 缺席时手写另一套 style phase 推导。
  - 继续保留 fallback，只会让 runtime 继续成为产品逻辑二号真相源。

### 统一 diff

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
   private _resolveStyleWorkflowFollowUp():
     | { item: CanonicalTranscriptItem; phase: string; skillId: "style_imitate" }
     | null {
@@
     const st: any = this.runState as any;
     const wfDecls: Map<string, WorkflowDeclaration> | undefined = runCtx.activeWorkflowDeclarations;
     const wfWorkflow = wfDecls?.get("style_imitate");
-    if (wfWorkflow) {
-      const followUpMsg = resolveFollowUp(wfWorkflow, st);
-      if (!followUpMsg) return null;
-      const snapshot = resolvePhase(wfWorkflow, st);
-      return {
-        skillId: "style_imitate",
-        phase: String(snapshot.currentPhase ?? "unknown").trim() || "unknown",
-        item: {
-          kind: "runtime_hint",
-          text: followUpMsg,
-          reasonCodes: ["style_workflow_followup", "phase:" + String(snapshot.currentPhase ?? "unknown").trim()],
-        },
-      };
-    }
-
-    const lintGateDegraded = Boolean(st.lintGateDegraded);
-    const styleLintAccepted = Boolean(st.styleLintSatisfied || st.styleLintPassed || lintGateDegraded);
-    const copyLintAccepted = Boolean(st.copyLintSatisfied || st.copyLintPassed || st.copyGateDegraded);
-    ...
-    return {
-      skillId: "style_imitate",
-      phase: currentPhase,
-      item: { kind: "runtime_hint", text: followUpText, ... }
-    };
+    if (!wfWorkflow) return null;
+    const followUpMsg = resolveFollowUp(wfWorkflow, st);
+    if (!followUpMsg) return null;
+    const snapshot = resolvePhase(wfWorkflow, st);
+    return {
+      skillId: "style_imitate",
+      phase: String(snapshot.currentPhase ?? "unknown").trim() || "unknown",
+      item: {
+        kind: "runtime_hint",
+        text: followUpMsg,
+        reasonCodes: ["style_workflow_followup", "phase:" + String(snapshot.currentPhase ?? "unknown").trim()],
+      },
+    };
   }
```

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
   const activeWorkflowDeclarations = new Map<string, WorkflowDeclaration>();
   for (const sid of activeSkillIds) {
     const manifest = skillManifestById.get(sid) as any;
     if (manifest?.workflow) {
       const wf = normalizeWorkflow(manifest.workflow);
       if (wf) activeWorkflowDeclarations.set(sid, wf);
     }
   }
+  if (activeSkillIds.includes("style_imitate") && !activeWorkflowDeclarations.has("style_imitate")) {
+    throw new Error("STYLE_WORKFLOW_DECLARATION_MISSING");
+  }
```

### 边界情况

- `style_imitate` 激活但 declaration 缺失：直接 fail-close，避免 runtime 继续现编阶段语义。
- 非 style workflow：不受影响。

### 验证方式

- `npm run -w @ohmycrab/gateway smoke:workflow-sticky`
- `npm run -w @ohmycrab/gateway smoke:style-orchestrator`
- 手工验证：
  - style follow-up 仍然发生
  - runtime 中不再存在 declaration missing 时的硬编码 phase 推导

---

## Fix 4（P0）：Desktop run-end fallback 按 outcome reason 区分 silent run

- 优先级：P0
- 文件：`apps/desktop/src/agent/wsTransport.ts`
- 符号：`maybeAppendRunEndFeedback`
- 当前 HEAD：`d7a392bad387b796c1053343ce04567dc847e4f1`
- 当前行号：`1553-1589`
- 改动原理：
  - 当前 UI 把 “无 assistant 正文的正常结束” 和 “silent_no_output 的异常结束” 混成同一句 “本轮已结束”。
  - runtime 重构后，前端必须尊重新的 outcome reason，不能继续遮盖事实。

### 统一 diff

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
       const maybeAppendRunEndFeedback = (runEndData?: any) => {
         const stepsNow = rt.getSteps() ?? [];
         const runSteps = stepsNow.slice(runStartStepCount);
         const hasAssistantText = runSteps.some(
           (s: any) => s && s.type === "assistant" && s.variant !== "progress" && !s.hidden && String(s.text ?? "").trim().length > 0,
         );
         if (hasAssistantText) return;
+        const outcomeReason = String(runEndData?.reason ?? runEndData?.outcome?.reason ?? "").trim().toLowerCase();
         const failedToolSteps = runSteps.filter((s: any) => s && s.type === "tool" && s.status === "failed");
@@
         if (failedCount > 0) {
           ...
           return;
         }
+        if (outcomeReason === "silent_no_output") {
+          addAssistant("这轮没有收到模型的可见回复，已停止续跑。请直接重试，或切换模型后再试。", false, false);
+          return;
+        }
         const note = String(runDoneNote ?? "").trim();
         addAssistant(note ? `本轮已结束。\n${note}` : "本轮已结束。", false, false);
       };
```

### 边界情况

- 失败工具已有 digest：仍优先展示失败摘要。
- `silent_no_output`：不再显示 normal completion。
- 真正的无正文但 completed 场景，应随着 P0 重构显著减少。

### 验证方式

- 手工复现无正文 reasoning run，确认 UI 不再显示“本轮已结束”。
- 普通 completed 且已有正文的 run，不受影响。

---

## 7. 风险与连锁反应

### 7.1 行为风险

- 从 `implicit_completion` 改成 natural stop 后，部分原本依赖“第二轮强行 run.done 提醒”的路径可能少掉一次 nag。
- 这是有意变化，不视为回归；否则补丁链永远拆不掉。

### 7.2 兼容性风险

- `run.end.reason` 新增 `silent_no_output` 后，任何直接硬编码只认 `completed/failed/aborted` 的展示层都要过一遍。
- 当前已知关键点是 `wsTransport.ts`，其余若只消费 `status` 基本无碍。

### 7.3 workflow 风险

- 删除 style fallback 后，如果某些 skill 激活路径漏掉 workflow declaration，会 fail-close 暴露问题。
- 这是好事；否则 runtime 会继续悄悄补造真相。

### 7.4 proposal-first / rollback 影响

- 本次只改 runtime 终止判定和 UI fallback，不涉及用户文档写入的 proposal-first 合同。
- 回滚也应按 phase 回滚，不要把 `implicit_completion` 白名单整条补丁链一起复活。

---

## 8. 验证 Checklist

### 8.1 P0 必验

- [ ] `gpt-5.4` / reasoning model 出现 silent turn 时，`run.end.reason = silent_no_output`
- [ ] silent turn 不再显示 “本轮已结束”
- [ ] 有正文但无工具的正常问答，run 能自然结束
- [ ] `run.done` 仍即时结束
- [ ] `approval_waiting` / `clarify_waiting` 不受影响

### 8.2 P1 必验

- [ ] `style_imitate` follow-up 只来自 declaration
- [ ] declaration 缺失时 fail-close，而不是 runtime 补 phase 文案
- [ ] `smoke:workflow-sticky` / `smoke:style-orchestrator` 通过

### 8.3 推荐冒烟

- [ ] `npm run -w @ohmycrab/gateway test:runner-turn`
  当前为存量失败：脚本仍引用已删除的 `apps/gateway/src/agent/writingAgentRunner.js`
- [x] `npm run -w @ohmycrab/gateway smoke:runtime-parity`
- [ ] `npm run -w @ohmycrab/gateway smoke:workflow-sticky`
  当前为存量失败：脚本仍断言旧 routeId=`web_radar`，实际返回 `task_execution`
- [x] `npm run -w @ohmycrab/gateway smoke:style-orchestrator`

---

## 9. 回滚与兼容说明

- 若 P0 新语义导致大面积异常，优先只回滚 `silent_no_output` fail-fast 的决策，不回滚整个 thin-core 方向。
- 明确不建议回滚到：
  - `implicit_completion + abort()`
  - `implicit_completion` outcome 白名单
  - “无正文统一渲染为本轮已结束”

---

## 10. 涉及文件清单

### 必改

- `apps/gateway/src/agent/turnEngine.ts`
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/desktop/src/agent/wsTransport.ts`

### 条件改

- `apps/gateway/src/agent/runFactory.ts`

### 本期明确不改

- `apps/gateway/src/agent/runtime/kernel/PiLoopKernel.ts`
- `apps/gateway/src/agent/runtime/provider/providerCapabilities.ts`
- `apps/gateway/src/agent/portableSkillCompat.ts`
- `packages/tools/**`
- Desktop / Gateway 工具执行边界

---

## 11. 本期明确不做什么

1. 不再给 `implicit_completion` 增加 visible-text 白名单补丁。
2. 不做 `gpt-5.4` / `sonnet` / `gemini` 的 provider 特判。
3. 不通过 prompt 限制来“修复” runtime 状态机。
4. 不顺手重写整个 `GatewayRuntime`，只收主链：`no-tool / completed / continuation / UI fallback`。
5. 不把 style 之外的所有 workflow 一次性改造成声明式 executor。
