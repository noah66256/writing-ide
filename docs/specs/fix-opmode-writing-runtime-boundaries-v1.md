# fix-opmode-writing-runtime-boundaries-v1

> 写作任务里的 opMode / runtime / portable skill / proposal 合同收敛

> 状态：已实现（待更大回归） | 优先级：P0-P1 | 日期：2026-03-22

## 0. 需求卡片

- 场景：
  写作/风格仿写任务里，创作模式与助手模式的权限边界不够清晰；模型会在 `write/edit/doc.previewDiff`、`code.exec`、`shell.exec` 之间来回找旁路，尤其在 style workflow / portable skill / `allowed-tools` 叠加时更明显。
- 目标：
  1. 助手模式只是权限上限，不等于本轮默认全暴露。
  2. 纯写作任务默认只看到写作闭环工具，不应被 runtime 高危工具污染。
  3. `code.exec` / `shell.exec` / `process.*` / `cron.*` 不能绕过 style workflow 和文本写入合同。
  4. portable / Claude skill 的 `allowed-tools` 不能把这条边界打穿。
- 对标：
  以仓库内既有文档与现状实现为准：
  `tools-fs-and-runtime-refactor-v0.1`、
  `core-tools-exposure-refactor-2026-03-13`、
  `fix-style-workflow-bypass-and-fileop-nag-v1`、
  `fix-style-imitate-contract-runtime-convergence-v1`、
  `claude-code-skill-compat-v0.2`，
  外加用户提供的 run 日志异常行为。
- 约束：
  不重写整套工具系统；不破坏 portable skill / Claude skill compat 主链；不放松 assistant-only 高危门禁；不把 proposal-first / style workflow 再做成双真相。
- 不做什么：
  不直接改代码；不重新设计全部 `write/edit/proposal` UI；不把所有 skill 都改成新的 phase gate 语义；不把所有文本写入都升级成“强制审批后才能 apply”。

---

## 1. 现状地图

### 1.1 相关文件

| 文件 | 职责 | 与本问题关系 |
|------|------|--------------|
| `apps/gateway/src/agent/coreTools.ts` | 维护 CORE / HIGH_RISK 工具集合与 opMode 基线裁剪 | `HIGH_RISK_TOOL_NAMES` 已包含 `code.exec`，但后续消费不对称 |
| `apps/gateway/src/agent/runFactory.ts` | 组装 system prompt、构建 `baseAllowedToolNames` / `selectedAllowedToolNames` / per-turn allowed | 是本次边界漂移的主入口 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 执行前 runtime 二次门禁、portable skill allowed-tools 硬校验 | 目前 creative runtime deny 未覆盖 `code.exec` |
| `apps/gateway/src/agent/styleOrchestrator.ts` | style_imitate 阶段白名单与 hint | 当前 workflow 白名单很干净，但没有把“禁止高危旁路”说透 |
| `packages/agent-core/src/workflowPhaseInterpreter.ts` | 声明式 workflow phase -> allowed tools | 只做阶段工具交集，不处理 runtime fallback |
| `apps/gateway/src/agent/portableSkillCompat.ts` | Claude/portable skill `allowed-tools` 解析与 runtime policy notice | 文案已经说“仅限 explicit portable scope”，但执行语义仍有外溢 |
| `apps/gateway/src/agent/serverToolRunner.ts` | `skills.activate` / portable skill 激活结果回传 | 激活响应已透出 `allowedToolPolicy` |
| `apps/desktop/src/agent/toolRegistry.ts` | `doc.previewDiff` / `write` / `edit` 真正 applyPolicy | 当前真实合同与 Gateway prompt 描述不一致 |

### 1.2 当前调用链

1. `runFactory` 先基于 route / tool policy / opMode / active skills 算出 `baseAllowedToolNames`。
2. portable skill 显式调用时，`allowed-tools` 会在 `runFactory` 里把对应工具重新并回 `baseAllowedToolNames`。
3. `selectedAllowedToolNames` 再做一轮裁剪；`code.exec` 这里单独走 `shouldAllowCodeExecForRun()` heuristic。
4. `computePerTurnAllowed()` 再做 workflow / sticky / heal / boot / opMode 裁剪。
5. `GatewayRuntime` 执行工具前，还会做一次 portable policy 校验和 creative 高危 deny。
6. Desktop `toolRegistry` 决定工具实际是 proposal 还是 auto_apply。

### 1.3 已有设施

- 已有统一的高危集合：`HIGH_RISK_TOOL_NAMES` 已把 `code.exec` 列为 assistant-only。
- 已有 style workflow phase gate：`style_imitate` 可把本轮工具收敛到 `kb.search / write / lint.copy / lint.style / edit / run.done`。
- 已有 portable skill runtime guard：`GatewayRuntime` 在执行前会按 `allowed-tools` 规则做 specifier 级 deny。
- 已有 proposal 工具：`doc.previewDiff` 已是 `applyPolicy: "proposal"`。
- 已有 desktop 确认/回滚：`write` / `edit` 已有高风险确认和 undo 能力，不是完全裸写。

### 1.4 约束点

- `claude-code-skill-compat-v0.2` 已承诺：显式 `Bash(...)` 等 portable high-risk alias 可绕过 Crab creative 默认高危裁剪。
- `style_imitate` 当前的阶段工具本身没问题，问题出在 workflow 之后还有 run-global / runtime fallback 能力。
- `toolRegistry` 已经把 `doc.previewDiff`、`write`、`edit` 做成三种不同 applyPolicy；本次不应反向把 Desktop 工具重做一遍。

### 1.5 当前已确认的问题

1. `coreTools.ts` 把 `code.exec` 定义成高危，但 `runFactory` 的 creative per-turn 裁剪和 `GatewayRuntime` 的 runtime deny 都漏掉了它。
2. 助手模式在实现上更像“默认全暴露”，而不是“权限上限后再按任务收窄”。
3. portable `allowed-tools` 的文案说“explicit portable scope only”，但 `runFactory` 仍会把高危工具并进 run-global allowed 集合。
4. `style_imitate` workflow 白名单很干净，但 `runFactory` 明确声明“不再收紧 per-turn 工具白名单，只靠提示引导”，导致旁路一旦进入 allowed 集就能钻空子。
5. Gateway prompt 声称“写入类操作遵守 proposal-first，先给提案”，但 Desktop 实际上是：
   - `doc.previewDiff` = proposal
   - `write` = auto_apply
   - `edit` = auto_apply
6. 用户提供的 run 日志已经出现：
   - 同一条写作任务里先声称“先 preview diff 等你应用”，随后又直接“写入文件已完成”
   - 把 `code.exec` / `shell` 当成覆写终稿的兜底路径

---

## 2. 调研摘要

### 2.1 本地规格与源码

- `docs/specs/tools-fs-and-runtime-refactor-v0.1.md`
  - 明确了“助手模式允许本机操作，但仍受 proposal-first 与高危拦截约束”。
  - 也明确了 FS 主面应该收敛到 `read/write/edit/...`，而不是让 shell/code 成为默认主路径。
- `docs/research/core-tools-exposure-refactor-2026-03-13.md`
  - 已把 CORE / HIGH_RISK / opMode 显式化，但当前实现仍存在多处硬编码子集。
- `docs/specs/fix-style-workflow-bypass-and-fileop-nag-v1.md`
  - 已识别“workflow 只约束工具，不约束文本/旁路”的结构性问题。
- `docs/specs/fix-style-imitate-contract-runtime-convergence-v1.md`
  - 已明确“proposal / patch / partial edit 不能等价于完整草稿完成”。
- `docs/specs/claude-code-skill-compat-v0.2.md`
  - 已明确 portable `allowed-tools`、`context: fork`、hooks 等兼容承诺，其中高危 `Bash(...)` 放权是当前主链兼容的一部分。

### 2.2 近期 commit 脉络

- `398717d feat(core-tools): stabilize core tool exposure and assistant mode runtime`
- `77183a4 feat: land desktop runtime hardening and portable skill support`
- `fafaf4f fix(style): converge style imitate runtime contract`

这些 commit 的方向本身是正确的：分别在收敛 core tool 暴露、portable compat、style contract。但它们组合后留下了一个新的缝：高危工具“声明上是 assistant-only，实际消费上却分裂成多套真相”。

### 2.3 用户日志证据

- 写作任务里出现“`code.exec` 覆写终稿”“`shell` 直接写入终稿”的行为，说明写作闭环外仍有高危兜底路径。
- 同一 run 里同时出现“`doc.previewDiff` 已生成，等用户应用”和“写入文件已完成”，说明 proposal 文案与真实 apply 行为没有统一。

### 2.4 结论

- 本轮不需要额外外网调研；本地 spec、commit、源码和用户日志已经足够支撑方案判断。
- 推荐做“单一真相收敛”，而不是继续加一层特殊 case：
  1. opMode 决定权限上限；
  2. 任务类型决定本轮默认暴露；
  3. portable high-risk grant 只在 explicit portable skill scope 内生效；
  4. proposal 合同以 Desktop 真实 `applyPolicy` 为准，Gateway prompt 追平。

### 2.5 子 Agent 复核补充

独立 explorer 复核后，额外确认了 3 个容易被 spec 写漏的点：

1. “纯文本长稿直接输出”仍是 workflow 之外的一条结构性旁路；本 spec 主要收 runtime 高危旁路与合同真相，不把它误写成“本轮已经根治”。
2. “写作 sticky 续跑”不能误吞 file-op 场景；写作任务收窄只应作用于当前明确的写作/风格闭环，不应靠历史写作态把 `delete/rename` 这类任务一起拦进去。
3. Gateway / Runtime / Desktop 当前确实存在多层权限名单漂移；Fix 1 必须先把高危 runtime 工具口径收成单一事实源。

---

## 3. 方案收敛

### 3.1 推荐方案

采用“权限上限 × 任务收窄 × portable 作用域 × proposal 真相”四段式收敛：

1. `opMode` 只定义“这轮理论上最高能做什么”，不直接等价于“这轮默认全暴露什么”。
2. 对写作/风格仿写任务，默认只暴露写作闭环工具；即便在 assistant 模式，也默认不暴露 `code.exec` / `shell.exec` / `process.*` / `cron.*`。
3. portable / Claude skill 的高危 `allowed-tools` 只在 explicit portable execution scope 内放权，不得外溢到普通写作 run 或 skill 激活后的自由发挥阶段。
4. proposal-first 文案追平 Desktop 真实 apply contract：`doc.previewDiff` 才是 proposal，`write/edit` 是真实写入；只有当用户明确要求“先看 diff / 不要直接改”时才必须先走 preview。

### 3.2 为什么契合当前框架

- 不推翻 `HIGH_RISK_TOOL_NAMES`，只把它真正用成单一事实源。
- 不重写 style workflow，只把高危 runtime 旁路从写作任务里拿掉，并把提示写清楚。
- 不打破 portable compat 主链，只把高危 grant 从“run-global 外溢”收回到“explicit skill scope”。
- 不重做 Desktop 文件工具，只把 Gateway prompt 和实际 `applyPolicy` 对齐。

### 3.3 备选方案

备选：把所有 `write/edit` 一律改成 proposal-only，所有写入都必须先 diff、再 Keep、再 apply。

放弃原因：

- 这会把 Desktop 文件交互、undo、inline confirm、workflow 节奏一起重做，明显超出本轮范围。
- 它不能解决 portable `allowed-tools` 的高危外溢，也不能自动修复 `code.exec` creative 漏门禁。
- 用户现在要的是“边界清晰且不再乱钻旁路”，不是“整套文件写入 UX 重做”。

---

## 4. 改动点清单

### Fix 1（P0）：把 `code.exec` 纳入 creative 双门禁，并改成共享高危集合

- 文件：`apps/gateway/src/agent/coreTools.ts`
- 符号：`HIGH_RISK_TOOL_NAMES`、`HIGH_RISK_TOOL_NAME_SET`、`applyOpModeToBaseAllowedTools()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`45-74`

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：`opModeLine`、`computePerTurnAllowed()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`1225-1242`、`4590-4970`、`4952-4967`

- 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：tool execution 前的 opMode high-risk deny
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`3104-3138`

- 改动原理：
  - `code.exec` 在定义层已被视为高危，但 creative 的 per-turn gate 和 runtime gate 都没把它算进去。
  - 本次要求把高危集合改成单一事实源，不再在 `runFactory` / `GatewayRuntime` 里各写一份“漏掉 `code.exec` 的硬编码列表”。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-    // 基于创作/助手模式裁剪高风险 runtime 工具（shell.exec / process.* / cron.* / skill.install）
+    // 基于创作/助手模式裁剪高风险 runtime 工具（统一使用 HIGH_RISK_TOOL_NAME_SET，包含 code.exec）
     if (opModeForTurn !== "assistant") {
-      const runtimeHighRiskTools = ["shell.exec", "process.run", "process.list", "process.stop", "cron.create", "cron.list", "skill.install"];
+      const runtimeHighRiskTools = Array.from(HIGH_RISK_TOOL_NAME_SET);
       for (const name of runtimeHighRiskTools) {
         ...
       }
     }
@@
-            `- 你可以自由使用写作/检索/KB/风格相关工具，但禁止执行任何本机命令或全局技能安装（如 shell.exec / process.* / cron.* / skill.install）。\n` +
+            `- 你可以自由使用写作/检索/KB/风格相关工具，但禁止执行任何高风险本机运行时工具或全局技能安装（如 code.exec / shell.exec / process.* / cron.* / skill.install）。\n` +
```

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-    const runtimeHighRiskTools = new Set<string>(["shell.exec", "process.run", "process.list", "process.stop", "cron.create", "cron.list", "skill.install"]);
+    const runtimeHighRiskTools = HIGH_RISK_TOOL_NAME_SET;
     const portableHighRiskOverride =
       runtimeHighRiskTools.has(toolName) &&
       Boolean(portableToolPolicy?.allowedToolNames?.has(toolName));
```

- 边界情况：
  - creative 模式下，即便用户提到“写个 python 脚本”，也不能通过 `code.exec` 绕过模式边界；需要用户先切 assistant。
  - assistant 模式下，`code.exec` 仍可在显式 code task 中继续工作，不是彻底删除。
- 验证方式：
  - creative + 写作任务：`code.exec` 不再出现在 per-turn allowed，runtime 也会 deny。
  - creative + 明确“写 Python 脚本”请求：仍提示需要切助手模式，而不是悄悄放开。
  - assistant + 明确 code task：`code.exec` 正常可见并可执行。

### Fix 2（P0）：把助手模式收敛为“权限上限”，写作任务默认收窄 runtime 高危工具

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：`shouldAllowCodeExecForRun()`、`selectedAllowedToolNames` 裁剪、`computePerTurnAllowed()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`1944-1961`、`4227-4239`、`4590-4970`

- 文件：`apps/gateway/src/agent/styleOrchestrator.ts`
- 符号：`buildHint()`、`computeStyleTurnCaps()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`124-207`、`246-308`

- 改动原理：
  - 当前 assistant 模式接近“默认全开放”，这对编码任务有用，但对写作任务会把 `code.exec` / `shell.exec` 变成天然旁路。
  - 本次要求新增“任务级 runtime exposure policy”：
    - creative：始终不开放高危 runtime 工具；
    - assistant + 写作任务：默认不开放；
    - assistant + 显式 shell/code 意图：可以开放；
    - assistant + style workflow / 写作闭环：默认只给写作闭环工具。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
+function shouldExposeRuntimeHighRiskToolsForRun(args: {
+  opMode: "creative" | "assistant";
+  userPrompt: string;
+  intentIsWritingTask: boolean;
+  styleWorkflowActive: boolean;
+  hasPortableScopedHighRiskGrant: boolean;
+}): boolean {
+  if (args.opMode !== "assistant") return false;
+  if (args.hasPortableScopedHighRiskGrant) return true;
+  if (args.intentIsWritingTask || args.styleWorkflowActive) {
+    return looksLikeExplicitShellExecIntent(args.userPrompt) || looksLikeExplicitCodeExecIntent(args.userPrompt);
+  }
+  return true;
+}
@@
-  if (baseAllowedToolNames.has("code.exec")) {
-    if (allowCodeExecForRun) selectedAllowedToolNames.add("code.exec");
-    else selectedAllowedToolNames.delete("code.exec");
-  }
+  if (!shouldExposeRuntimeHighRiskToolsForRun(...)) {
+    for (const name of HIGH_RISK_TOOL_NAME_SET) selectedAllowedToolNames.delete(name);
+  } else if (baseAllowedToolNames.has("code.exec")) {
+    if (allowCodeExecForRun) selectedAllowedToolNames.add("code.exec");
+    else selectedAllowedToolNames.delete("code.exec");
+  }
```

- 边界情况：
  - assistant + 纯写稿：`code.exec` / `shell.exec` 不出现，避免模型把它们当“更直接的写文件方式”。
  - assistant + “请写一个 `python-docx` 脚本生成 docx”：允许 `code.exec`，因为这是明确 code task。
  - assistant + 浏览器自动化 / MCP 文档工具场景：不受影响，仍优先专用 MCP。
  - 任务级收窄不能只靠 sticky 写作态触发；若当前回合已被识别为 `delete/rename/清理/文件操作`，不得继续套用写作闭环收窄。
- 验证方式：
  - assistant + 写作任务：看不到 runtime 高危工具，只剩写作闭环工具。
  - assistant + 编码任务：高危 runtime 工具仍能按意图出现。
  - `style_imitate` 激活时，hint 明确提醒“不要改用 `code.exec/shell.exec/process.*` 绕过 lint 与落盘合同”。
  - 从一个写作线程切到“删除/重命名文件”任务时，不会因为 sticky 写作态而错误保留 style/writing gate。

### Fix 3（P0）：portable / Claude skill 的高危 `allowed-tools` 只在 explicit skill scope 内生效

- 文件：`apps/gateway/src/agent/portableSkillCompat.ts`
- 符号：`parsePortableAllowedToolPolicy()`、`buildPortableAllowedToolPolicyNotice()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`478-533`

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：portable allowed-tools 注入、per-turn creative gate
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`3070-3077`、`3813-3827`、`4952-4967`

- 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：portable policy 校验、creative high-risk deny
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`3053-3088`、`3104-3138`

- 文件：`apps/gateway/src/agent/serverToolRunner.ts`
- 符号：portable skill activation payload
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`1047-1113`

- 改动原理：
  - 当前 notice 文案已经写着“applies inside explicit portable skill execution scope only”，但 `runFactory` 仍把这些工具直接并进 `baseAllowedToolNames`，导致高危 grant 外溢成 run-global 权限。
  - 本次要求把 portable policy 拆成两层：
    - 低风险 allowed-tools：继续并入普通 allowed 集；
    - 高风险 allowed-tools：只记录为 `portableScopedHighRiskToolNames`，仅在 explicit portable execution scope 内允许通过。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-  if (portableAllowedToolPolicy?.allowedToolNames.size) {
-    for (const name of portableAllowedToolPolicy.allowedToolNames) {
-      if (allToolNamesForMode.has(name)) {
-        baseAllowedToolNames.add(name);
-        skillPinnedToolNames.add(name);
-      }
-    }
-  }
+  const portableScopedHighRiskToolNames = new Set<string>();
+  if (portableAllowedToolPolicy?.allowedToolNames.size) {
+    for (const name of portableAllowedToolPolicy.allowedToolNames) {
+      if (!allToolNamesForMode.has(name)) continue;
+      if (HIGH_RISK_TOOL_NAME_SET.has(name)) {
+        portableScopedHighRiskToolNames.add(name);
+        continue;
+      }
+      baseAllowedToolNames.add(name);
+      skillPinnedToolNames.add(name);
+    }
+  }
```

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-    const portableHighRiskOverride =
-      runtimeHighRiskTools.has(toolName) &&
-      Boolean(portableToolPolicy?.allowedToolNames?.has(toolName));
+    const portableHighRiskOverride =
+      runtimeHighRiskTools.has(toolName) &&
+      Boolean(this.config.runCtx.portableSkillContext?.executionScope === "explicit_portable_invocation") &&
+      Boolean(this.config.runCtx.portableSkillContext?.scopedHighRiskToolNames?.has(toolName));
```

- 边界情况：
  - 不能打破 `claude-code-skill-compat-v0.2` 已经承诺的 `/skill ...` 显式 portable 执行能力。
  - 只收紧“高危 grant 的 run-global 外溢”，不收紧普通 `Read/Write/Edit/WebFetch/Grep/Glob/Task` 映射。
  - `skills.activate` 后的普通聊天/写作回合，不应因为某个 skill 里写了 `Bash(...)` 就默认开放 shell/code。
- 验证方式：
  - 直接显式调用一个 `allowed-tools: Bash(...)` 的 portable skill：skill 内部高危工具仍可用。
  - 激活同一个 skill 后转去做普通写作：`shell.exec` / `code.exec` 不应继续挂在 allowed 集里。
  - 非高危 portable tool alias（如 `Read` / `Edit` / `WebFetch`）保持现有兼容。

### Fix 4（P1）：把 style workflow 的 anti-bypass 文案写清，并让 runtime hint 与之对齐

- 文件：`apps/gateway/src/agent/styleOrchestrator.ts`
- 符号：`buildHint()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`124-207`

- 文件：`packages/agent-core/src/workflowPhaseInterpreter.ts`
- 符号：`resolveAllowedTools()`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`153-177`

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：workflow per-turn branch
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`4686-4708`

- 改动原理：
  - style workflow 现在“工具白名单干净、文案不够硬”，导致模型一旦在其他层看到高危工具，就会把它理解为允许的替代手段。
  - 本次要求在每个写作 phase hint 里明确加入：
    - 不要用 `code.exec/shell.exec/process.*` 落正文；
    - 不要绕过 `lint.copy / lint.style`；
    - 不要把 `doc.previewDiff` 说成“已写入完成”。

```diff
--- a/apps/gateway/src/agent/styleOrchestrator.ts
+++ b/apps/gateway/src/agent/styleOrchestrator.ts
@@
-      "- 只调用 write 生成候选稿（draft），不要直接宣称终稿完成。",
+      "- 只调用 write 生成候选稿（draft），不要直接宣称终稿完成。",
+      "- 不要改用 code.exec / shell.exec / process.* 生成或覆写正文，它们不是 style 闭环的合法捷径。",
@@
-      "- copy lint 通过前，不要做终稿写入。",
+      "- copy lint 通过前，不要做终稿写入，也不要改走 shell/code 旁路。",
```

- 边界情况：
  - 这条修复是“再强调合同”，不是替代 runtime gate；真正兜底仍是 Fix 1/2/3。
  - 只修改 style / writing workflow hint，不泛化到所有 skill。
- 验证方式：
  - 激活 `style_imitate` 后，phase hint 中清楚出现 anti-bypass 约束。
  - 结合 Fix 2 后，实际 allowed 集与提示内容不再互相打脸。

### Fix 5（P0）：把 proposal-first 文案改成与 Desktop 真实 `applyPolicy` 一致

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：Agent system prompt 输出约束
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`1299-1304`

- 文件：`apps/desktop/src/agent/toolRegistry.ts`
- 符号：`doc.previewDiff`、`write`、`edit`
- 当前 HEAD：`2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 当前行号：`3110-3122`、`3327-3338`、`3648-3662`

- 改动原理：
  - Desktop 真相已经很明确：
    - `doc.previewDiff` = `proposal`
    - `write` = `auto_apply`
    - `edit` = `auto_apply`
  - 问题不是 Desktop 行为错，而是 Gateway prompt 对模型说了另一套话，导致模型以为“只要生成 diff 就等于已经遵守了所有写入合同”，从而出现先说“等你应用”又继续“已写入”的混乱。
  - 本次不改工具 applyPolicy，而是把 prompt 和 hint 改成真实语义。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-        `- 写入类操作遵守系统的 proposal-first 机制：先给出提案，再由用户决定是否应用或回滚。\n` +
+        `- 文本写入合同以工具真实 applyPolicy 为准：doc.previewDiff 只生成提案/diff，不会写盘；write/edit 才会真实修改文件，并按各自风险策略申请确认或提供回滚。\n` +
+        `- 当用户明确要求“先看 diff / 不要直接覆盖 / 先讨论方案”时，必须先调用 doc.previewDiff；在收到用户确认前，不要继续 write/edit。\n` +
+        `- 在收到 write/edit 的成功结果前，不得声称“已写入/已落盘/已保存完成”。\n` +
```

- 边界情况：
  - 不把所有 `write/edit` 改成 proposal-only；当前 undo / confirm / auto_apply 行为保持不变。
  - `doc.previewDiff` 继续承担“提案”语义，避免再出现双真相。
- 验证方式：
  - 用户说“先给我看看 diff”：模型先用 `doc.previewDiff`，不提前宣称落盘。
  - 用户直接说“覆写成终稿”：模型可直接 `write/edit`，并且只在成功后宣称已完成。
  - 用户 run 日志里不再同时出现“待你应用 diff”和“已写入完成”两套叙事。

---

## 5. 风险与连锁反应

### 5.1 兼容性风险

1. 过度收紧 assistant 写作任务，可能误伤真正需要 `python-docx/openpyxl` 的“写作但本质是代码生成文档”场景。
   - 缓解：保留显式 shell/code 意图放行。
2. 过度收紧 portable skill，可能打破 `claude-code-skill-compat-v0.2` 已承诺的 `Bash(...)` 直接执行。
   - 缓解：只收回“高危 grant 外溢”，不收回“explicit portable invocation 内有效”。
3. 只改 prompt 不改 runtime，会继续留后门。
   - 缓解：本 spec 的主轴是 runtime gate 先收口，prompt/hint 只是同步对齐。
4. 仅收 runtime 高危旁路，并不等于彻底解决“纯文本 assistant_text 直接交付长稿”的结构性绕过。
   - 缓解：继续沿用 `fix-style-workflow-bypass-and-fileop-nag-v1` / `fix-style-imitate-contract-runtime-convergence-v1` 那条主链，把文本旁路问题作为独立收口项，不在本 spec 里假装已根治。

### 5.2 性能与复杂度风险

1. 如果再新加一套“写作专用 allowed 列表”，会把工具暴露逻辑变得更碎。
   - 缓解：尽量做成 `shouldExposeRuntimeHighRiskToolsForRun()` 这种任务级 overlay，而不是平行维护第二套白名单。
2. 如果把 portable scope 状态塞得太细，会增加 thread state 复杂度。
   - 缓解：只新增最小字段：`executionScope` + `scopedHighRiskToolNames`。

### 5.3 proposal / rollback 风险

1. 若继续把“preview 完成”说成“写入完成”，用户对 proposal-first 的理解会继续混乱。
2. 若这轮误把 `write/edit` 改成了 proposal-only，会影响大量既有桌面交互和回滚逻辑。

---

## 6. 验证 Checklist

### 6.1 P0 验证

- [ ] creative + 普通写稿：`code.exec` / `shell.exec` / `process.*` / `cron.*` 不出现在 per-turn allowed，runtime 调用也被 deny。
- [ ] creative + 用户明确要 Python 脚本：仍提示需要切助手模式，而不是放开 `code.exec`。
- [ ] assistant + 普通写稿：默认仍只给写作闭环工具，不给高危 runtime。
- [ ] assistant + 明确 code task（如“写一个 `python-docx` 生成器”）：`code.exec` 可按显式意图出现。
- [ ] `style_imitate` 激活后：hint 中明确写出不要走 `code.exec/shell.exec` 旁路。
- [ ] 直接显式调用带 `Bash(...)` 的 portable skill：skill 内高危工具仍可用。
- [ ] 激活同一个 portable skill 后转去做普通写作：高危工具不会继续挂在 allowed 集里。

### 6.2 proposal 合同验证

- [ ] 用户说“先给 diff”：先 `doc.previewDiff`，未确认前不执行 `write/edit`。
- [ ] 用户说“直接改掉”：允许直接 `write/edit`，并在成功后再宣称已写入。
- [ ] 最终 run 文本不再同时出现“等你应用 diff”和“已写入完成”的自相矛盾叙事。

### 6.3 回归验证

- [ ] Claude/portable skill 的 `Read/Write/Edit/WebFetch/Grep/Glob/Task` 等非高危 alias 保持现有兼容。
- [ ] assistant 编码任务的 `shell.exec` / `process.run` 不被误伤。
- [ ] `style_imitate` 的 phase gate、`lint.copy`、`lint.style` 主链不回退。
- [ ] 从写作线程切到 `delete/rename/文件清理` 类任务时，不会因为 sticky 写作态而错误套用写作 runtime 收窄。
- [ ] 这轮收口后，已知“纯文本长稿直接输出”的问题仍被明确留在独立 spec 主线里，没有被误记为已解决。

---

## 7. 回滚与兼容说明

- 若 Fix 2 的任务级收窄误伤某些边缘任务，可先只保留 Fix 1 + Fix 3，回到“assistant 可见高危工具，但 creative 不再漏 `code.exec`”的中间状态。
- 若 Fix 3 的 portable scope 收得过紧，可临时只对高危工具做 scoped 化，普通 allowed-tools 继续沿用当前 run-global 合并逻辑。
- 本 spec 不涉及 Desktop 数据结构迁移，不影响用户既有对话历史、memory、skills 扫描根目录。

---

## 8. 涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `apps/gateway/src/agent/coreTools.ts` | P0 | 高危工具集合统一事实源 |
| `apps/gateway/src/agent/runFactory.ts` | P0 | assistant/creative prompt、task-level runtime exposure、portable high-risk scope、proposal 文案 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | P0 | runtime deny 对齐高危集合与 portable scoped override |
| `apps/gateway/src/agent/portableSkillCompat.ts` | P0 | portable allowed-tools notice / scope 语义对齐 |
| `apps/gateway/src/agent/serverToolRunner.ts` | P0 | portable activation payload 增补 scoped 高危元数据 |
| `apps/gateway/src/agent/styleOrchestrator.ts` | P1 | style workflow anti-bypass hint |
| `packages/agent-core/src/workflowPhaseInterpreter.ts` | P1 | 如需 phase hint 透传或约束补充时的最小配套 |
| `apps/desktop/src/agent/toolRegistry.ts` | P0 | 作为 proposal / auto_apply 真相源，必要时补一句描述避免歧义 |
| `apps/gateway/scripts/smoke-opmode-writing-boundaries.ts` | 验证 | 新增写作权限边界 smoke |
| `apps/gateway/package.json` | 验证 | 注册 smoke 命令 |

---

## 9. 本版结论

这不是单一 bug，而是四层边界各说各话：

1. `HIGH_RISK_TOOL_NAMES` 已经把 `code.exec` 算高危，但后续消费漏了。
2. assistant 模式现在像“默认全开”，而不是“可开的上限”。
3. portable `allowed-tools` 的高危 grant 文案和实际作用域不一致。
4. Gateway prompt 把 proposal-first 说成了 Desktop 并不存在的另一套合同。

因此本轮应该优先做 P0 收口：

1. 补齐 `code.exec` creative 双门禁。
2. 给写作任务加任务级 runtime 收窄。
3. 把 portable 高危 grant 收回 explicit skill scope。
4. 把 proposal 文案改成与 `doc.previewDiff / write / edit` 的真实 applyPolicy 一致。

P1 再补 style workflow anti-bypass hint，即可把这条线收干净。

---

## 10. 实施卡片

- spec：`docs/specs/fix-opmode-writing-runtime-boundaries-v1.md`
- 目标：
  收紧写作任务里的 runtime 高危工具暴露，补齐 `code.exec` creative 门禁，限制 portable/Claude skill 高危 grant 的作用域，并把 proposal 文案追平 Desktop 真实 applyPolicy。
- 范围：
  `apps/gateway/src/agent/runFactory.ts`、
  `apps/gateway/src/agent/runtime/GatewayRuntime.ts`、
  `apps/gateway/src/agent/portableSkillCompat.ts`、
  `apps/gateway/src/agent/serverToolRunner.ts`、
  `apps/gateway/src/agent/styleOrchestrator.ts`、
  `apps/gateway/scripts/smoke-opmode-writing-boundaries.ts`、
  `apps/gateway/package.json`
- 不做什么：
  不改 Desktop `write/edit/doc.previewDiff` 的 applyPolicy；不重写 workflowPhaseInterpreter；不解决“纯文本长稿直接输出”这条独立结构性旁路。
- 当前 HEAD：
  `2e3c6a4b626598a55f90bfbd211dcd89c1d0cd5d`
- 主要风险：
  工具暴露规则分散、portable runtime 上下文继承、以及写作 sticky/file-op 边界误伤。

## 11. 实现切片

| Slice | 对应 spec | Owner | 文件范围 | 风险 | 验证 |
|------|-----------|-------|---------|------|------|
| Slice A | Fix 1 | 主 agent | `runFactory.ts` / `GatewayRuntime.ts` / `portableSkillCompat.ts` | 高 | `build` + `smoke:opmode-writing-boundaries` |
| Slice B | Fix 2 + Fix 3 | 主 agent | `runFactory.ts` / `GatewayRuntime.ts` / `serverToolRunner.ts` / `portableSkillCompat.ts` | 高 | `smoke:opmode-writing-boundaries` + `smoke:runtime-parity` + `smoke-claude-hook-parity.ts` |
| Slice C | Fix 4 + Fix 5 | 主 agent | `styleOrchestrator.ts` / `runFactory.ts` | 中 | `smoke:style-orchestrator` + `build` |
| Slice D | Doc Sync + Validation | 主 agent | 本 spec + 新 smoke 脚本 + `package.json` | 中 | 文档回填 + 命令实跑 |

## 12. 实施状态

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Fix 1：`code.exec` creative 双门禁 | `runFactory.ts` `shouldExposeRuntimeHighRiskToolsForRun()` / high-risk per-turn 裁剪；`GatewayRuntime.ts` creative deny；`portableSkillCompat.ts` 高危集合复用 | 已完成 | `build`；`smoke:opmode-writing-boundaries` 场景 1/4/6/7 | 额外把 `toolCaps.allowTools` 这条高危旁路一起收口 |
| Fix 2：assistant 作为权限上限，写作任务默认收窄 | `runFactory.ts` selected/per-turn high-risk gating | 已完成 | `smoke:opmode-writing-boundaries` 场景 4；`build` | 对 `file_ops/file_delete_only` 加了排除，避免 sticky 写作态误伤 |
| Fix 3：portable 高危 grant scoped 化 | `runFactory.ts` `portableExecutionScope` / `scopedHighRiskToolNames`；`GatewayRuntime.ts` runtime override；`serverToolRunner.ts` activation payload；`portableSkillCompat.ts` activation tool 过滤 | 已完成 | `smoke:opmode-writing-boundaries` 场景 2/3/7；`smoke:runtime-parity`；`smoke-claude-hook-parity.ts` | `skills.activate` 不再把高危工具直接带进 activation toolNames |
| Fix 4：style anti-bypass hint | `styleOrchestrator.ts` `buildHint()` | 已完成 | `smoke:style-orchestrator`；`smoke:opmode-writing-boundaries` 场景 5 | 不改 phase 解释器，只补 hint 合同 |
| Fix 5：proposal 文案与真实 applyPolicy 对齐 | `runFactory.ts` system prompt 输出约束 | 已完成 | `build` | Desktop 真相保持不变，仅同步 Gateway 文案 |

## 13. 验证记录

- 已通过：
  - `npm -w @ohmycrab/gateway run build`
  - `npm -w @ohmycrab/gateway run smoke:opmode-writing-boundaries`
  - `npm -w @ohmycrab/gateway run smoke:style-orchestrator`
  - `npm -w @ohmycrab/gateway run smoke:runtime-parity`
  - `npm exec -w @ohmycrab/gateway tsx scripts/smoke-claude-hook-parity.ts`
- 新增验证脚本：
  - `apps/gateway/scripts/smoke-opmode-writing-boundaries.ts`
  - 覆盖点：
    - `HIGH_RISK_TOOL_NAME_SET` 包含 `code.exec`
    - portable activation / `skills.activate` 不再泄露高危工具
    - assistant/creative 写作任务的 runtime 高危暴露决策
    - style anti-bypass hint
    - `GatewayRuntime` creative deny 与 `skill_activation` 非显式作用域 deny

## 14. 偏差说明与残留风险

- 本轮没有直接修改 `apps/desktop/src/agent/toolRegistry.ts`。
  - 原因：`doc.previewDiff / write / edit` 的真实 applyPolicy 已经正确，问题在 Gateway prompt 口径不一致。
- 本轮没有直接修改 `packages/agent-core/src/workflowPhaseInterpreter.ts`。
  - 原因：phase tool 交集本身没坏，真正缺的是 runtime 高危旁路收口和 style hint 明确化。
- 本轮没有解决“纯文本长稿直接输出绕过 workflow”。
  - 该问题仍由 `fix-style-workflow-bypass-and-fileop-nag-v1` / `fix-style-imitate-contract-runtime-convergence-v1` 主线继续收口。
- 显式 portable high-risk grant 的“真实允许路径”本轮没有做 desktop 端到端 smoke。
  - 当前已验证：
    - helper/exposure 逻辑正确
    - `skills.activate` 不泄露高危
    - `skill_activation` 假作用域在 creative 下仍被 runtime deny
  - 未验证：
    - 显式 `/portable-skill ...` + desktop tool wait/permission 完整链路
- `SubAgentExecutionBridge` 仍会继承 `portableSkillContext`。
  - 当前保持现状，视为“同一 skill 执行域内的继承”；若后续发现 grant 外溢到普通子任务，再单独补一条 scoped inheritance spec。
