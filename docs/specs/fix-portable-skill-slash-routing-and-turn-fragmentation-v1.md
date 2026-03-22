# fix-portable-skill-slash-routing-and-turn-fragmentation-v1

`/skill-creator` 首轮 slash-only 唤起被误判为空 prompt + explicit portable invocation 重复暴露 `skills.activate`

状态：Implemented | 优先级：P0 | 日期：2026-03-22  
当前 HEAD：`2930809983a1911ece8ec66bff71f95d05ff5bd7`

关联文档：
- `docs/specs/fix-skill-creator-selftalk-and-path-v1.md`
- `docs/specs/fix-lint-tool-disappearance-and-skill-continuation-v1.md`
- `docs/specs/skill-activation-and-progressive-hydration-v0.1.md`
- `docs/specs/claude-code-skill-compat-v0.5-github-install-and-cli-bridge.md`

## 实施状态（2026-03-22）

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Change 1 / P0 slash-only 显式 skill invocation 优先于 `empty_prompt` | `apps/gateway/src/agent/runFactory.ts` / `classifyDirectiveIntent` | 已实现 | `npm run -w @ohmycrab/gateway smoke:workflow-sticky` | 把 `hasExplicitSkillMention()` 提前到空 prompt 判断之前 |
| Change 2 / P0 explicit portable invocation 下移除 `skills.activate` | `apps/gateway/src/agent/runFactory.ts` / `selectedAllowedToolNames` 收口段 | 已实现 | `npm run -w @ohmycrab/gateway smoke:mcp-server-first` | 仅在 `portableExecutionScope === "explicit_portable_invocation"` 时删除 |
| Change 3 / P0 routing smoke | `apps/gateway/scripts/smoke-workflow-sticky.ts` | 已实现 | `npm run -w @ohmycrab/gateway smoke:workflow-sticky` | 新增 `" "` + `mentionedSkillIds` 回归用例 |
| Change 4 / P1 final tool set smoke | `apps/gateway/scripts/smoke-mcp-server-first.ts` | 已实现 | `npm run -w @ohmycrab/gateway smoke:mcp-server-first` | 增加 `bodyOverrides`，新增 explicit portable invocation 用例 |

### 验证记录

- `npm run -w @ohmycrab/gateway smoke:workflow-sticky` 通过
- `npm run -w @ohmycrab/gateway smoke:mcp-server-first` 通过
- `npm run -w @ohmycrab/gateway build` 通过

### 实现偏差

- 为了让 `smoke-mcp-server-first.ts` 在当前 assistant-only `code.exec` 边界下继续可用，本轮顺手把现有 `scenarioExplicitCodeExec` 补成 `opMode: "assistant"`。
- 这只是验证夹具对齐，不是产品逻辑扩权，也不改变本 spec 的两个主修复点。

---

## 0. 结论先行

这次问题不是“`skill-creator` 没激活”，也不是“Gateway 又额外发了一轮请求”。

已经核实的事实：
- 第一轮 `gpt-5.2` run 里，`skill-creator` 实际已经激活，但路由仍被判成 `empty_prompt`，导致首轮没有按“显式 skill 执行”进入任务闭环。
- 第二轮 `claude-sonnet-4-6` run 里，不是多发了一次 run，而是同一个 run 内先尝试再次调用 `skills.activate`，被 portable policy 拒绝后，被切成了多个 turn，前端再把多个 `assistant.start` 渲染成多段气泡。

本 spec 只做两刀根因修复：
1. 修正 slash-only 显式 skill invocation 的路由判定顺序。
2. 在 explicit portable invocation 作用域下，不再向模型暴露 `skills.activate`。

本轮明确不做：
- 不做前端气泡合并来遮住症状。
- 不扩 run audit schema。
- 不把重复 `skills.activate` 改成 no-op 掩盖问题。
- 不引入新的 runtime helper 层、新状态机或新编排分支。

一句话：这不是重构题，是一个应该收口在 `runFactory.ts` 的顺序错误 + 作用域泄漏问题。

## 1. 需求卡片

- 场景：用户在桌面端通过 `/skill-creator` 这类 slash-only skill invocation 直接唤起 portable skill，期望第一轮就进入正确任务闭环，且一次 run 只形成一次正常主回复。
- 目标：
  - slash-only 显式 skill invocation 不再被误判为 `empty_prompt` / discussion。
  - explicit portable invocation 场景下不再重复向模型暴露 `skills.activate`。
  - 修掉根因后，UI 不再因多 turn 被动分裂出多段“欢迎页/多回一轮”气泡。
- 对标：
  - Claude Code 显式 skill/slash invocation 语义
  - Crab 现有 portable skill execution scope 设计
- 约束：
  - 最小改动，优先在 `apps/gateway/src/agent/runFactory.ts` 收口。
  - 不改 Desktop transcript 语义，不重写 Gateway runtime turn 协议。
  - 复用已有 smoke，不额外造新测试框架。
- 不做什么：
  - 不顺手改 skill-creator 文案、SKILL.md 或创作/助手模式大路由。
  - 不顺手收敛整个 progressive hydration spec 的剩余 phase。
  - 不把“多回一轮”问题上升为前端消息系统重写。

## 2. 已有上下文索引

### 2.1 已有 spec / research

- `docs/specs/fix-lint-tool-disappearance-and-skill-continuation-v1.md`
  - 已经引入 `hasExplicitSkillMention(mentionedSkillIds?)`，但当前 `classifyDirectiveIntent()` 仍先判断 `!t`，导致 slash-only 显式 invocation 继续掉进 `empty_prompt`。
- `docs/specs/skill-activation-and-progressive-hydration-v0.1.md`
  - 已经把 skill 生命周期拆层；本次属于其 P0 收口，不是新范式。
- `docs/specs/claude-code-skill-compat-v0.5-github-install-and-cli-bridge.md`
  - 已经把 portable / Claude skill runtime 接进来；本次是对 explicit portable invocation 边界的一处补洞。

### 2.2 近期相关提交

- `a9f16d2 fix(desktop): allow skill-only runs`
  - Desktop 允许纯 skill 唤起，并在空 prompt 时用 `" "` 占位。
- `8776f69 fix(agent): preserve lint tools for explicit skill runs`
  - 引入了 `hasExplicitSkillMention()` 相关逻辑，但没有把它放到 `empty_prompt` 判断之前。
- `77183a4 feat: land desktop runtime hardening and portable skill support`
  - 引入 portable skill runtime 与 `PORTABLE_SKILL_TOOL_POLICY_DENIED` 路径。
- `ca8b99b fix(gateway): tighten writing runtime boundaries`
  - 加强了 portable execution scope 边界，也让本次重复 `skills.activate` 的拒绝症状更清晰暴露出来。

### 2.3 本轮约束说明

- 本轮按用户要求只落 spec，不直接改代码。
- 按当前协作约束，本次未启用子 agent 复核；实施前保留一次人工复核即可，不必为此扩机制。

## 3. 线上证据与复现时间线

### 3.1 关联会话

- conversation id：`conv_1772446872819_202caffdaa093`

### 3.2 第一轮：不是“没激活 skill”

- runId：`a68fc48b-8c8f-42ca-a529-e73e6121d3ef`
- 模型：`gpt-5.2`
- 服务端审计事实：
  - `promptPreview: " "`
  - `promptChars: 1`
  - `SkillPolicy` 包含：
    - `skills_activated`
    - `skill:skill-creator`
  - `IntentPolicy` 仍是：
    - `intent:discussion`
    - `intent_reason:empty_prompt`

结论：
- `skill-creator` 已激活。
- 首轮异常并不是 skill 没拉起，而是路由仍被 `empty_prompt` 抢先吃掉。

### 3.3 第二轮：不是“Gateway 多发一次”

- runId：`0f20161c-a288-4456-815e-02ac82765847`
- 模型：`claude-sonnet-4-6`
- 同一 run 内发生：
  - `assistant.start` turn 1
  - 模型调用 `skills.activate`
  - 被 `PortableSkillToolDenied` 拒绝
  - `assistant.start` turn 2 输出第一段文本
  - `assistant.start` turn 3 输出第二段文本

结论：
- 这是同一个 run 被切成多个 turn，不是多发了一次 gateway 请求。
- 前端之所以看起来像“又回了一轮”，是因为 Desktop 目前每收到一次 `assistant.start` 都会结算前一个气泡并新开一个。

## 4. 现状地图

### 4.1 相关文件

| 文件 | 当前职责 | 与本次问题关系 |
|------|----------|----------------|
| `apps/desktop/src/ui/components/ChatArea.tsx` | 发送消息；纯 skill 唤起时用空格占位 | slash-only invocation 的 prompt 进入 Gateway 时实际是 `" "` |
| `apps/desktop/src/agent/wsTransport.ts` | 把 `skillRefs` / `skillInvocations` 发到 Gateway；处理 `assistant.start` | 多 turn 会被渲染成多个主气泡 |
| `apps/gateway/src/agent/runFactory.ts` | 路由判定、skill refs 合并、portable scope 计算、最终工具池收口 | 两个根因都在这里 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 执行 tool policy；`turn_start` 写 `assistant.start` | 第二轮的多气泡是这里的真实 turn 行为放大出来的 |

### 4.2 当前调用链

#### A. slash-only skill invocation 路径

`ChatArea.tsx`：纯 skill 唤起时把空 prompt 填成 `" "`  
→ `wsTransport.ts`：发送 `skillRefs` / `skillInvocations`  
→ `runFactory.ts`：`explicitSkillIds -> mentionedSkillIds -> classifyDirectiveIntent()`  
→ 现在被 `if (!t)` 提前返回成 `empty_prompt`

#### B. explicit portable invocation 多 turn 路径

显式 portable skill 已处于 invocation scope  
→ `runFactory.ts` 最终工具集合仍含 `skills.activate`  
→ 模型再次调用 `skills.activate`  
→ `GatewayRuntime.ts` 命中 `PORTABLE_SKILL_TOOL_POLICY_DENIED`  
→ kernel 继续推进下一 turn  
→ `turn_start` 每次写 `assistant.start`  
→ `wsTransport.ts` 每次 `assistant.start` 都新开一个主气泡

### 4.3 最自然的修复点

- 两个根因都可以在 `runFactory.ts` 解决。
- `GatewayRuntime.ts` 和 `wsTransport.ts` 只是症状放大器，不是本轮最自然的扩展点。

### 4.4 不该轻易动的区域

- `apps/gateway/src/agent/runtime/GatewayRuntime.ts` 的 turn 协议。
- `apps/desktop/src/agent/wsTransport.ts` 的 transcript / bubble 结算语义。
- run audit schema 与 Dashboard 解析链路。

## 5. 根因分析

### 根因 1：`classifyDirectiveIntent()` 的判断顺序错了

文件：
- `apps/gateway/src/agent/runFactory.ts`

符号：
- `classifyDirectiveIntent`

当前 HEAD 行号：
- `1487-1498`

当前实现：

```ts
const t = String(text ?? "").trim();
if (!t) return { kind: "inquiry", reason: "empty_prompt" };
if (hasExplicitSkillMention(mentionedSkillIds)) {
  return { kind: "directive", reason: "explicit_skill_invocation" };
}
```

问题本质：
- Desktop 为了满足 Gateway schema，把纯 skill 唤起发成 `" "`。
- 到 Gateway 后 `trim()` 变成空串。
- 由于 `!t` 早于 `hasExplicitSkillMention()`，slash-only 显式 skill invocation 稳定走成 `empty_prompt`。

这说明：
- `hasExplicitSkillMention()` 已经存在，但还没有真正拿到“比空 prompt 更高的优先级”。

### 根因 2：explicit portable invocation 作用域里还把 `skills.activate` 暴露给模型

文件：
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`

相关符号与行号：
- `portableExecutionScope`：`apps/gateway/src/agent/runFactory.ts:3124-3129`
- `selectedAllowedToolNames` 收口：`apps/gateway/src/agent/runFactory.ts:4119-4301`
- portable denied 写 notice：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:3064-3094`

问题本质：
- 当本轮已经是 `explicit_portable_invocation` 时，当前 skill 已经被用户显式选中了。
- 但最终工具集合里仍能看见 `skills.activate`，Claude 就会再次尝试激活当前 skill。
- 这次重复激活并不在 portable skill 的 `allowed-tools` 内，于是被判 `PortableSkillToolDenied`。
- runtime 没有挂死，而是进入下一 turn；Desktop 再把多个 `assistant.start` 渲染成多个气泡。

这说明：
- 真问题不是“Claude 多说了一轮”，而是我们给了一个当前作用域下本不该可见的内部工具。

## 6. 方案收敛

### 6.1 推荐方案：两处 runFactory 手术式修复

方案内容：
- Fix 1：把 `hasExplicitSkillMention()` 提前到 `!t` 之前。
- Fix 2：在 `portableExecutionScope === "explicit_portable_invocation"` 时，从 `selectedAllowedToolNames` 删除 `skills.activate`。

为什么契合当前框架：
- 不改 Desktop / Runtime 协议，只修真正的前置判定与最终工具池收口。
- 不引入新状态，不需要为这两个洞再多做一层 helper。
- 与现有 `explicit_skill_invocation`、`portableExecutionScope` 语义完全一致，只是把它们真正落实。

### 6.2 放弃方案

#### 放弃方案 A：前端合并多个 `assistant.start`

不选原因：
- 这是 UI 遮羞布，只会掩盖 runtime 真行为。
- 根因未修时，日志与审计仍会继续脏。

#### 放弃方案 B：对重复 `skills.activate` 做 no-op

不选原因：
- 会把“内部工具暴露错误”掩盖成“看起来没报错”。
- 后续别的内部工具若也泄漏，会继续复现同类问题。

#### 放弃方案 C：扩 run audit schema / 新状态机

不选原因：
- 信息已经足够定位问题。
- 本轮是明确的 P0 收口，不值得把系统再推向更复杂的管道。

## 7. 改动点清单

### Change 1 / P0：slash-only 显式 skill invocation 优先于 `empty_prompt`

文件：
- `apps/gateway/src/agent/runFactory.ts`

符号：
- `classifyDirectiveIntent`

当前 HEAD：
- `2930809983a1911ece8ec66bff71f95d05ff5bd7`

当前行号：
- `1487-1498`

改动原理：
- 只要本轮带了显式 `mentionedSkillIds`，就应优先视作 directive。
- `empty_prompt` 应只处理“真的什么都没传”的情况，而不是 slash-only invocation 这种结构化显式请求。

建议 diff：

```diff
diff --git a/apps/gateway/src/agent/runFactory.ts b/apps/gateway/src/agent/runFactory.ts
@@
 export function classifyDirectiveIntent(text: string, mentionedSkillIds?: string[]): {
   kind: "directive" | "inquiry" | "continuation";
   reason: string;
 } {
   const t = String(text ?? "").trim();
-  if (!t) return { kind: "inquiry", reason: "empty_prompt" };
   if (hasExplicitSkillMention(mentionedSkillIds)) {
     return { kind: "directive", reason: "explicit_skill_invocation" };
   }
+  if (!t) return { kind: "inquiry", reason: "empty_prompt" };
   if (looksLikeWorkflowContinuationPrompt(t, mentionedSkillIds)) {
     return { kind: "continuation", reason: "workflow_continuation" };
   }
```

边界情况：
- `mentionedSkillIds=[]` 或 `undefined`：行为与现在一致，空 prompt 仍走 `empty_prompt`。
- 用户只发空白，没有 skill：仍走 inquiry，不会误进任务闭环。
- 旧的 continuation / explicit_non_task / visibility 分支都不需要改。

验证方式：
- 新增 smoke case 覆盖 `" "` + `mentionedSkillIds=["skill-creator"]`。
- 手动在桌面端发送纯 `/skill-creator`，确认首轮不再被审计成 `intent_reason:empty_prompt`。

### Change 2 / P0：explicit portable invocation 作用域下移除 `skills.activate`

文件：
- `apps/gateway/src/agent/runFactory.ts`

符号：
- `selectedAllowedToolNames` 最终收口段

当前 HEAD：
- `2930809983a1911ece8ec66bff71f95d05ff5bd7`

当前行号：
- `4119-4132` 为插入点

改动原理：
- `skills.activate` 只该用于“还没进入显式 portable invocation 作用域”的阶段。
- 当前 skill 已经由用户显式唤起时，再把 `skills.activate` 暴露给模型，只会制造重复激活和 denied turn。

建议插入点：
- 放在 `ensureCoreToolsSelected()` 之后、`toolRetrievalNotice` 之前。
- 原因：既能保证它不被检索或 preserve 再次塞回，又能让后续审计看到的 final tool set 就是正确的。

建议 diff：

```diff
diff --git a/apps/gateway/src/agent/runFactory.ts b/apps/gateway/src/agent/runFactory.ts
@@
   // 兜底：确保 CORE_TOOLS 不被 B2 裁剪掉，只要它们在 baseAllowedToolNames 中。
   ensureCoreToolsSelected({ baseAllowedToolNames, selectedAllowedToolNames });
+
+  // 当前 run 已经处于显式 portable skill invocation 作用域时，
+  // 不应再向模型暴露内部激活工具，避免重复自激活把同一 run 切成多个 turn。
+  if (portableExecutionScope === "explicit_portable_invocation") {
+    selectedAllowedToolNames.delete("skills.activate");
+  }
 
   // MCP Server 粒度补齐：如果 selectToolSubset 选中了某个 MCP Server 的任一工具，
   // 就把该 Server 的全部工具补入 selectedAllowedToolNames。
```

边界情况：
- 仅限 `portableExecutionScope === "explicit_portable_invocation"`。
- `skill_activation` 作用域不改，避免误伤当前真正需要激活 portable skill 的路径。
- 只删 `selectedAllowedToolNames`，不动 `baseAllowedToolNames`，减少连锁影响。

验证方式：
- `prepareAgentRun()` 层面断言 final `selectedAllowedToolNames` 在 explicit portable invocation 场景下不含 `skills.activate`。
- 本地桌面手动 smoke：`/skill-creator` 首轮不再出现 `PortableSkillToolDenied`，同一 run 不再平白多出 turn 2 / turn 3。

### Change 3 / P0：为 Fix 1 加一条路由 smoke

文件：
- `apps/gateway/scripts/smoke-workflow-sticky.ts`

当前 HEAD：
- `2930809983a1911ece8ec66bff71f95d05ff5bd7`

当前行号：
- 建议插在 `107` 之后、`todo` 相关用例之前

改动原理：
- 这个 bug 的根是 phase0 route classification，因此最轻量、最稳定的回归保护就在已有 routing smoke 里补一条 case。

建议 diff：

```diff
diff --git a/apps/gateway/scripts/smoke-workflow-sticky.ts b/apps/gateway/scripts/smoke-workflow-sticky.ts
@@
 assert.equal(
   looksLikeExplicitNewTaskPrompt("我的意思是拿我们卖智能体这个项目和李一舟的对比md，以及spec"),
   true,
 );
 ok("routing.correction_prompt_breaks_sticky");
+
+const slashOnlySkillInvocationRoute = computeIntentRouteDecisionPhase0({
+  mode: "agent",
+  userPrompt: " ",
+  mentionedSkillIds: ["skill-creator"],
+  mainDocRunIntent: "auto",
+  mainDoc: {},
+  runTodo: [],
+  intent: { wantsWrite: false, isWritingTask: false, wantsOkOnly: false },
+  ideSummary: null,
+});
+assert.equal(slashOnlySkillInvocationRoute.routeId, "task_execution");
+assert.equal(
+  slashOnlySkillInvocationRoute.derivedFrom.includes("intent_reason:explicit_skill_invocation"),
+  true,
+);
+ok("routing.skill_only_invocation_is_task");
 
 const todoShouldNotForceContinuation = computeIntentRouteDecisionPhase0({
```

边界情况：
- 用 `" "` 而不是 `""`，直接对齐 Desktop 真实发包形态。
- 断言 `derivedFrom`，避免将来 routeId 侥幸对了、reason 又退回 `empty_prompt`。

验证方式：
- 运行 `apps/gateway/scripts/smoke-workflow-sticky.ts`

### Change 4 / P1：为 Fix 2 加一条 `prepareAgentRun()` final tool set smoke

文件：
- `apps/gateway/scripts/smoke-mcp-server-first.ts`

当前 HEAD：
- `2930809983a1911ece8ec66bff71f95d05ff5bd7`

当前行号：
- `65-87` 需要把 `prepareResult()` / `prepare()` 轻微扩成支持 `bodyOverrides`
- `281-301` 之后新增一个 scenario 并在 `main()` 调用

改动原理：
- `skills.activate` 泄漏发生在 `prepareAgentRun()` 的 final tool set 收口阶段。
- 仓库里现成能稳定拿到 `prepared.selectedAllowedToolNames` 的 smoke harness 就是这里，没必要为这一条断言再造第三套 mock。

建议 diff：

```diff
diff --git a/apps/gateway/scripts/smoke-mcp-server-first.ts b/apps/gateway/scripts/smoke-mcp-server-first.ts
@@
-async function prepareResult(prompt: string, toolSidecar: any) {
+async function prepareResult(prompt: string, toolSidecar: any, bodyOverrides?: Record<string, unknown>) {
   const prevRouterMode = process.env.INTENT_ROUTER_MODE;
   process.env.INTENT_ROUTER_MODE = "heuristic";
   try {
     return await prepareAgentRun({
       request: { headers: {} },
       body: {
         mode: "agent",
         prompt,
         toolSidecar,
+        ...(bodyOverrides ?? {}),
       },
       services: createServices(),
     });
   } finally {
@@
-async function prepare(prompt: string, toolSidecar: any) {
-  const result = await prepareResult(prompt, toolSidecar);
+async function prepare(prompt: string, toolSidecar: any, bodyOverrides?: Record<string, unknown>) {
+  const result = await prepareResult(prompt, toolSidecar, bodyOverrides);
   assert.equal(!!result.error, false, `prepareAgentRun should succeed: ${JSON.stringify(result.error)}`);
   return result.prepared!;
 }
@@
 async function scenarioExplicitCodeExec() {
   const prepared = await prepare(
     "写一个 Python 脚本扫描项目里的 Markdown 文件并输出统计结果",
@@
   assert.equal(prepared.selectedAllowedToolNames.has("code.exec"), true, "explicit code scenario should keep code.exec");
   ok("explicit code scenario");
 }
+
+async function scenarioExplicitPortableInvocationDoesNotExposeSkillsActivate() {
+  const prepared = await prepare(
+    " ",
+    makeSidecar(),
+    {
+      skillRefs: [{ id: "skill-creator" }],
+      skillInvocations: [{ id: "skill-creator", arguments: "" }],
+      userSkillManifests: [
+        {
+          id: "skill-creator",
+          name: "skill-creator",
+          description: "portable smoke skill",
+          portable: true,
+          allowedTools: ["Read", "Write", "Task"],
+        },
+      ],
+    },
+  );
+  assert.equal(prepared.portableSkillContext?.executionScope, "explicit_portable_invocation");
+  assert.equal(prepared.selectedAllowedToolNames.has("skills.activate"), false);
+  ok("explicit portable invocation hides skills.activate");
+}
 
 async function main() {
   await scenarioShellIntentDoesNotBackdoorCodeExec();
   await scenarioBrowserOpen();
@@
   await scenarioWordDeliveryFailFast();
   await scenarioExplicitCodeExec();
+  await scenarioExplicitPortableInvocationDoesNotExposeSkillsActivate();
   console.log("[smoke-mcp-server-first] all scenarios passed");
 }
```

边界情况：
- 只验证 final tool set，不去模拟整段 runtime turn；这样更稳，也更符合“最小验证面”原则。
- 若实现时发现 `userSkillManifests` 还需要最小 `inputSchema` 才能被 portable parser 接受，可在 smoke 里补一个空 object schema；不要因此改主实现。

验证方式：
- 运行 `apps/gateway/scripts/smoke-mcp-server-first.ts`

## 8. 风险与连锁反应

### 风险 1：slash-only 空 prompt 的语义变窄

影响：
- 只有带显式 skill ref/invocation 的空 prompt 才会变成 directive。

判断：
- 这是预期收敛，不会误伤普通空白消息。

### 风险 2：显式 portable invocation 少了一个“自救工具”

影响：
- 模型不能在 explicit portable invocation 作用域里再次调用 `skills.activate`。

判断：
- 这不是能力损失，而是去掉本不该存在的内部工具。
- 真需要 `skills.activate` 的是 `skill_activation` 路径，不是已经显式 invocation 的路径。

### 风险 3：如果后续别的路径又把 `skills.activate` 塞回 `selectedAllowedToolNames`

影响：
- 同类问题可能再次出现。

判断：
- 这正是 Change 4 需要做 final tool set smoke 的原因。

## 9. 验证 Checklist

### 9.1 自动验证

- 运行 `apps/gateway/scripts/smoke-workflow-sticky.ts`
  - 期望看到 `routing.skill_only_invocation_is_task`
- 运行 `apps/gateway/scripts/smoke-mcp-server-first.ts`
  - 期望看到 `explicit portable invocation hides skills.activate`

### 9.2 手动 smoke

在本地桌面端分别用 `gpt-5.2` 和 `claude-sonnet-4-6` 做一次纯 `/skill-creator` 发送：

- 期望 1：Gateway 审计不再出现 `intent_reason:empty_prompt`
- 期望 2：同一 run 不再出现 `PortableSkillToolDenied`
- 期望 3：同一 run 不再平白多出 turn 2 / turn 3
- 期望 4：前端不再看到“欢迎页 + 又来一轮”的拆裂现象

## 10. 回滚说明

如果上线后出现意外回归，回滚顺序应当是：

1. 先回滚 Change 2
   - 这是最局部的工具可见性收口，回滚成本最低。
2. 再回滚 Change 1
   - 仅当发现显式 skill 空 prompt 被误进任务闭环时才需要。

不应回滚的内容：
- 不要为回滚这两个点去顺手改 `GatewayRuntime.ts`
- 不要通过改 `wsTransport.ts` 合并气泡来“兜住”问题

## 11. 实施备注

这份 spec 的目标不是“让 slash skill 路径更聪明”，而是“别再让已有明确信号被顺序错误和内部工具泄漏吃掉”。

实施时请坚持两个原则：
- 只改根因，不补 UI 遮羞布。
- 只加回归保护，不借机抽象出第三层工具/skill/runtime helper。
