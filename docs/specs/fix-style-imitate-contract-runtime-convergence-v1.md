# Style Imitate Contract / Runtime 收口修复 v1

状态：已实施（build + smoke 已通过） | 优先级：P0 | 日期：2026-03-21
HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`

关联文档：
- `docs/specs/style-imitate-unified-workflow-skill-v1.md`
- `docs/specs/feat-workflow-state-persistence-v1.md`
- `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`
- `docs/specs/claude-code-skill-compat-v0.5-github-install-and-cli-bridge.md`
- `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`

---

## 0. 结论先行

这次不是要重做整个 Skill 系统，也不是要动 portable skill / Claude Code skill 的公共协议。

这次只做一件事：

> 把 `style_imitate` 收口成 **唯一的内置 workflow skill 真相**，关掉旧 pipeline 入口，补齐 runtime 缺口，并把大正文从 `runState / executionReport / renderer logs` 里清出去。

明确结论：

1. `style_imitate` 继续是 **builtin workflow skill**，不是普通 portable skill。
2. **不再保留 public `pipeline_v1` 入口** 作为 live path；旧入口最多保留一轮兼容解析，但不再执行。
3. `SKILL.md` 只保留 **激活条件 / 等待用户 / 阶段 Done 条件 / lint 必跑 / 最终写入门禁**。
4. 真正的执行细节下沉到 **Gateway runtime 内部 executor + `styleWorkflowConfig`**，不再依赖模型自由发挥决定是否写草稿、是否跑 lint。
5. `RunState`、`executionReport`、Desktop `logs` 里 **不再保存完整草稿正文**；只保留 phase、artifact ref、charCount、lint 摘要、final path。
6. 这不是 Desktop-only 修复；**Gateway 侧必须一起改**，否则双真相和续跑断链还会回来。

一句话：

> `style_imitate` 对外还是 workflow skill；对内改成 runtime-owned phase executor + ref-first state，既不伤 portable skill 主链，也不再让前端被大稿件慢性撑炸。

---

## 1. 已有上下文索引

### 1.1 现有 spec / research

- `docs/specs/style-imitate-unified-workflow-skill-v1.md`
  - 已明确宣告：`style_imitate` 应是唯一内置 workflow skill 真相，且“不再保留 `PipelineExecutor` 作为并行实现真相”。
- `docs/specs/feat-workflow-state-persistence-v1.md`
  - 已明确指出：workflow skill 的跨 run 断点恢复应该是 phase/state 级，而不是每次从零开始。
- `docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`
  - 已明确指出：Desktop 慢性 OOM 的关键风险是 fat runtime snapshot / items / logs，而不是单纯的 transcript。
- `docs/specs/claude-code-skill-compat-v0.5-github-install-and-cli-bridge.md`
  - 已明确 portable skill / Claude skill 的兼容边界：subset bridge、assistant-only 高风险 gate、`allowed-tools` hard runtime gates。
- `docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`
  - 已落地 Thread / Turn / Item 作为运行时事实源，适合承接 style workflow 的 phase / artifact / waiting 状态。

### 1.2 近期相关 commit

- `54104b7 refactor(skill): 统一风格仿写为内置 workflow skill`
- `abf8c5c refactor(style): migrate v3 from PipelineExecutor to agent-driven workflow`
- `f45b2f7 feat: unify style imitate workflow skill`
- `77183a4 feat: land desktop runtime hardening and portable skill support`
- `9e9800f feat: close claude skill github install and bridge parity`
- `989e827 fix(desktop): harden conversation history persistence guards`

### 1.3 当前代码面上的真实分歧

1. Desktop 已经不再自然生成 `stylePipelinePayload`：`apps/desktop/src/agent/gatewayAgent.ts:235`
2. 但 Gateway 仍接受并执行 `pipeline_v1` 请求体：`apps/gateway/src/agent/runFactory.ts:2428`、`apps/gateway/src/agent/runFactory.ts:6665`
3. Runtime 主路径内部仍有两套 style 语义：
   - 声明式 `workflow` 分支：`apps/gateway/src/agent/runFactory.ts:4504`
   - 硬编码 fallback / turn caps / follow-up：`apps/gateway/src/agent/runFactory.ts:4524`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1820`
4. `GatewayRuntime` 仍会补造 `toneCard/structureOutline` 并推断 `hasDraftText=true`：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:436`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:3818`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:4294`
5. `PipelineExecutor` 和 `RunState` 仍会把完整草稿正文塞进状态：
   - `apps/gateway/src/agent/pipelineExecutor.ts:494`
   - `packages/agent-core/src/runMachine.ts:155`
   - `packages/agent-core/src/runMachine.ts:217`
6. Desktop 仍会把 `run.execution.report` 整包写进 renderer `logs`：
   - `apps/desktop/src/agent/wsTransport.ts:1327`
   - `apps/desktop/src/state/runStore.ts:1444`

---

## 2. 需求卡片

- 场景：内置 `style_imitate` 闭环长期不稳定，常见失败是“不写草稿、跳过 lint、跨 run 断、同一能力存在双真相”，同时长文/多轮任务仍有把前端慢性撑炸的风险。
- 目标：让 `style_imitate` 稳定按“选库 → 题面 → 检索 → 定调骨架 → 草稿 → lint.copy → lint.style → 最终 write”闭环执行，并且续跑不断线、前端不再因大正文状态膨胀而失稳。
- 对标：
  - 仓库内既有 `style-imitate-unified-workflow-skill-v1` 的目标约束
  - Codex 风格的 `Thread / Turn / Item` 事实源与 lightweight persistence 范式
  - 现有 Claude / portable skill compat 文档所定义的边界
- 约束：
  - 不改 portable skill / Claude Code skill 主链语义
  - 不把风格闭环的阶段白名单泛化成所有 skill 的共享语义
  - 不再走一次性 preload 大材料 / 大 payload 的 pipeline 请求体
  - 工具执行仍保持 Desktop 本地执行，Gateway 负责编排
- 不做什么：
  - 不做整个 SkillManifest 协议改版
  - 不做完整 Claude Runtime parity
  - 不重写全部 GatewayRuntime / Tool 系统
  - 不引入新的通用 sidecar 存储协议

---

## 3. 现状地图

### 3.1 相关文件

| 文件 | 职责 | 与本次需求关系 |
|------|------|----------------|
| `apps/desktop/electron/bundled-skills/style_imitate/SKILL.md` | `style_imitate` 的外显合同 | 目前既承担阶段合同，又堆了大量执行细节，和 runtime/config 重叠 |
| `packages/agent-core/src/skills.ts` | `SkillManifest` 合同 | 已承载 `workflow` / `pipeline` / portable 字段；本次不能改坏 portable 语义 |
| `packages/agent-core/src/styleWorkflowConfig.ts` | style 执行配置 | 已有完整 step / budget / chunking 配置，但未成为唯一真相 |
| `packages/agent-core/src/styleWorkflowTypes.ts` | style artifact / payload / ref 类型 | 已定义 `ArtifactRefV1` / `StepArtifactV1`，但 live path 基本没用起来 |
| `packages/agent-core/src/runMachine.ts` | canonical `RunState` | 当前同时承载 workflow 布尔态和 legacy pipeline 大正文态 |
| `apps/gateway/src/agent/runFactory.ts` | run 预处理、active skills、per-turn tool gating、执行分流 | 当前仍保留 legacy pipeline live path 和 `styleWorkflowRequested` 旁路 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | style follow-up / waiting / state mutation / execution report | 当前会补造阶段产物、通过 heuristics 判断 waiting、输出 fat summary |
| `apps/gateway/src/agent/pipelineExecutor.ts` | 旧 pipeline 执行器 | 当前仍可被请求体显式触发，且会把大正文写进状态 |
| `apps/gateway/src/agent/portableSkillCompat.ts` | portable / Claude skill 兼容层 | 本次明确不能改这里的公共语义 |
| `apps/desktop/src/agent/wsTransport.ts` | Gateway 事件消费 | 当前会把 `run.execution.report` 整包打进 renderer log |
| `apps/desktop/src/state/runStore.ts` | live logs / turns / items | `log()` 直接持有完整 `data`，会放大 live memory |
| `apps/desktop/src/state/conversationStore.ts` | 历史 compact / 持久化 | 已有 history slimming，可复用，但不能替代 live runtime slimming |
| `apps/desktop/src/agent/gatewayAgent.ts` | 启动 run 的 renderer 入口 | 已经不再自然生成 pipeline payload，是关掉 legacy 入口的重要证据 |

### 3.2 已有设施

1. 活跃 skill 的 `workflow` 声明已经会被装配进 runtime：`apps/gateway/src/agent/runFactory.ts:2876`
2. `SkillManifest` 已经有 `pipeline?: PipelineDeclaration` 壳子，Desktop loader 也会透传：
   - `packages/agent-core/src/skills.ts:45`
   - `apps/desktop/electron/skill-loader.mjs:541`
3. `styleWorkflowTypes.ts` 已经有可复用的 artifact/ref 类型：`packages/agent-core/src/styleWorkflowTypes.ts:190`
4. Thread / Turn / Item 已是主事实源，适合承接 workflow phase + artifact ref + waiting state
5. Desktop 历史层已有 compact guardrail，可复用为 style summary 的持久化边界：`apps/desktop/src/state/conversationStore.ts:435`

### 3.3 约束点

1. 不能改 `SkillManifest` 里 portable 相关字段的全局语义：`packages/agent-core/src/skills.ts:92`
2. 不能改 `portableSkillCompat` 的 alias / hooks / fork / allowed-tools 语义：`apps/gateway/src/agent/portableSkillCompat.ts:11`、`apps/gateway/src/agent/portableSkillCompat.ts:478`
3. 不能借机放松 assistant-only 高风险 gate：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:3044`
4. 不能把 style 的阶段白名单抽成所有 skill 共用逻辑，否则会误伤 portable skill 主链

### 3.4 现状结论

#### A. 双真相仍然存在

- 公开入口层：`runFactory` 仍接受 `styleExecutionMode` / `stylePipelinePayload` 并可执行 `PipelineExecutor`：`apps/gateway/src/agent/runFactory.ts:2428`、`apps/gateway/src/agent/runFactory.ts:6665`
- 主路径内部：声明式 workflow 和硬编码 fallback 并存：`apps/gateway/src/agent/runFactory.ts:4504`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1820`
- `styleWorkflowRequested` 仍能在没有 active skill 时触发 style 语义：`apps/gateway/src/agent/runFactory.ts:3651`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:4482`

#### B. 阶段状态仍可能被 runtime“补造”

- `ensureStylePlanningArtifacts()` 会自动造 `toneCard/structureOutline` 并置 `hasStylePlan=true`：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:436`
- 任意写类工具都可能把 `hasDraftText` 置真：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:3818`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts:4294`
- 这会把“真正走完阶段”和“被 runtime 猜到大概有了”混成一件事

#### C. 大正文仍在 live state / report / logs 中流动

- `RunState` 仍直接保存 `bestStyleDraft.text` / `draftCandidatesV1[].text` / `pipelineArtifacts.*Draft`：`packages/agent-core/src/runMachine.ts:155`、`packages/agent-core/src/runMachine.ts:217`
- `PipelineExecutor` 会把完整 draft 放进状态：`apps/gateway/src/agent/pipelineExecutor.ts:494`
- Desktop 会把 `run.execution.report` 整包进 logs：`apps/desktop/src/agent/wsTransport.ts:1327`、`apps/desktop/src/state/runStore.ts:1444`

#### D. “等待用户”还没彻底变成线程事实

- runtime 内部已经开始读 thread waiting / taskState.workflow：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1910`
- 但 run 收口仍会用 `looksLikeAssistantWaitingForUserText(lastAssistantText)` 做 heuristics：`apps/gateway/src/agent/runFactory.ts:6856`

---

## 4. 调研摘要

### 4.1 证据来源

本轮不新增外网检索；本地源码、现有 spec、近期 commit 已足够支撑决策。

### 4.2 对标 / 上游范式

#### A. Codex parity（本地已落地范式）

证据：`docs/specs/codex-parity-thread-turn-item-and-collab-v0.1.md`

可借鉴：
- `Thread / Turn / Item` 作为唯一运行时事实源
- waiting / proposal / approval 由线程 / item reducer 承担，而不是 run.end 猜测
- 历史 persistence 走 lightweight path，不默认带 fat runtime payload

要规避：
- 继续让 `run.end`、heuristic、旧 sticky patch 成为第二事实源

#### B. Desktop runtime persistence guardrail（本地已落地范式）

证据：`docs/specs/desktop-runtime-item-persistence-guardrails-v0.1.md`

可借鉴：
- live runtime 可以富，但持久化必须轻
- 大内容不应作为默认历史/日志/恢复载荷反复深拷贝

要规避：
- 把 style 的完整草稿作为 `executionReport` / `log.data` / `taskState.workflow` 的常驻字段

#### C. Claude / portable skill compat 边界（本地已落地承诺）

证据：`docs/specs/claude-code-skill-compat-v0.5-github-install-and-cli-bridge.md`

可借鉴：
- portable skill 与 builtin workflow skill 必须分层处理
- 高风险工具 gate、`allowed-tools`、hooks / fork 语义应保持稳定

要规避：
- 为了修 `style_imitate` 去动 `portable`、`hooks`、`allowedTools` 的全局含义

### 4.3 结论

- 推荐模式：**builtin workflow contract + runtime-owned phase executor + ref-first state + lightweight report**
- 放弃模式：
  1. public `pipeline_v1` 请求体继续作为 style live path
  2. 继续依赖模型自由发挥决定是否写草稿、是否跑两个 lint
  3. 继续把完整草稿存在 `runState / executionReport / logs`
  4. 为了 style 修复去改 portable skill 主链协议

---

## 5. 方案收敛

### 5.1 推荐方案

#### 方案一句话

把 `style_imitate` 的外部语义固定为 **builtin workflow skill**，但把内部执行收口成 **runtime-owned style workflow executor**；执行过程中一律按 phase 推进、按需取材、artifact 用 ref 表示，不再把整份草稿塞进状态和日志。

#### 方案拆解

1. **单一激活真相**
   - runtime 只认 `activeSkillRefs/activeSkills` 中的 `style_imitate`
   - `styleWorkflowRequested` 只保留兼容解析，不再作为等价激活信号
   - 若 style library + writing intent 命中，激活必须在 skill 激活阶段完成，而不是到 runtime 再旁路补开

2. **单一执行真相**
   - `SKILL.md.workflow` 负责阶段顺序、等待用户、Done 条件
   - `styleWorkflowConfig.ts` 负责 step 顺序、context budget、lint 策略、chunking 策略、artifact kind
   - Gateway 内部 executor 负责具体 phase 执行，不再让模型“自己决定是否用工具”

3. **按需加载，不一次性 preload**
   - 不恢复 `stylePipelinePayload` 这种 Desktop 预烘焙大 payload 路径
   - Phase 1 的 style evidence 通过 `kb.search` 现取
   - 后续 phase 只消费上一步 artifact ref / 摘要，不回放整份 fat materials

4. **ref-first state**
   - `RunState` 只存：phase、booleans、artifact refs、charCount、lint summary、final path
   - 完整正文只存在：
     - live item / artifact payload
     - 最终写入文件
   - `executionReport` 只输出 summary，不输出全文

5. **thread-first resume**
   - 跨 run 续跑只持久化 phase + refs + final path + lint 摘要
   - waiting 只由 thread state 决定
   - 新任务明确切断旧 workflow patch

6. **保守兼容**
   - Gateway 保持对 legacy `styleExecutionMode/stylePipelinePayload` 的“解析兼容”，但执行时一律忽略并发 notice
   - `executionReport.styleWorkflow` 与 `skillStatus.style_imitate(.v1)` 保持 summary 兼容，不突然消失

### 5.2 备选方案（不推荐）

继续维持当前 `GatewayRuntime + model self-driven` 主路径，只补更多 hint / 更多 guard / 更多 fallback。

不推荐原因：

1. 问题根因不是“hint 不够多”，而是执行真相分裂
2. 只修 prompt / guard，仍无法从机制上保证“先草稿、后两个 lint”
3. 前端载荷风险仍在，因为 fat `runState/executionReport/logs` 不会自然消失
4. 后续仍会被 legacy pipeline 入口或 `styleWorkflowRequested` 旁路重新撕开

---

## 6. 改动点清单

### Fix 1（P0）关闭 `style_imitate` 的 legacy pipeline 公开入口

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：`agentRunBodySchema`、`executeAgentRun()`
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`2428`、`6665`
- 改动原理：
  - 当前 Gateway 仍可被显式喂进 `styleExecutionMode="pipeline_v1" + stylePipelinePayload`，这让旧 pipeline 仍是 live path。
  - 本次要把它降成“兼容解析但不执行”。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-  styleExecutionMode: z.enum(["agent_v1", "pipeline_v1"]).optional(),
-  stylePipelinePayload: z.any().optional(),
+  // legacy compat only: parsed for backward compatibility, but no longer drives live execution
+  styleExecutionMode: z.enum(["agent_v1", "pipeline_v1"]).optional(),
+  stylePipelinePayload: z.any().optional(),
@@
-  const shouldRunStylePipeline =
-    styleExecutionMode === "pipeline_v1" &&
-    activeSkillIds.includes("style_imitate") &&
-    Boolean(stylePipelinePayload) &&
-    Boolean(gates?.styleGateEnabled) &&
-    Boolean(intent?.isWritingTask);
-
-  if (shouldRunStylePipeline && stylePipelinePayload) {
-    ... PipelineExecutor.run(...)
-    return;
-  }
+  const requestedLegacyStylePipeline =
+    styleExecutionMode === "pipeline_v1" || Boolean(stylePipelinePayload);
+  if (requestedLegacyStylePipeline) {
+    writeEvent("run.notice", {
+      turn: 0,
+      kind: "warn",
+      title: "StylePipelineLegacyIgnored",
+      message: "style_imitate 已切到 builtin workflow runtime；忽略 legacy pipeline 请求。",
+    });
+  }
```

- 边界情况：
  - 旧测试 / 外部 caller 若仍发送 legacy 字段，本轮不直接 400，而是忽略并走新路径
  - 一旦观测面稳定，再删 schema 字段
- 验证方式：
  - 人工向 `/api/agent/run` 发送 `styleExecutionMode="pipeline_v1"`
  - 期望：不进入 `PipelineExecutor.run()`，而是发出 `StylePipelineLegacyIgnored` notice，并继续走 builtin workflow runtime

---

### Fix 2（P0）把 `styleWorkflowRequested` 从 runtime 旁路降为兼容输入，不再等价于 active skill

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：style 激活判断 / `computePerTurnAllowed`
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`3651`、`6216`
- 改动原理：
  - 当前 runtime 允许 `styleWorkflowRequested` 在没有 `style_imitate` active skill 时触发 style 语义，造成“Skill 是否激活”和“Runtime 是否执法”脱钩。
  - 本次要求：style 执法必须跟随 active skill，而不是旁路布尔开关。

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-  const styleToolContractActive = activeSkillIds.includes("style_imitate") ||
-    (styleWorkflowRequested && intent.isWritingTask && deriveStyleGate(...).styleGateEnabled);
+  const styleToolContractActive = activeSkillIds.includes("style_imitate");
@@
-  const styleSkillActive =
-    activeSkillIds.includes("style_imitate") ||
-    Boolean(prepared.styleWorkflowRequested && prepared.effectiveGates.styleGateEnabled && intent.isWritingTask);
+  const styleSkillActive = activeSkillIds.includes("style_imitate");
```

- 边界情况：
  - fail-close 激活仍保留在“skill 激活阶段”完成，而不是到 runtime 再补开
  - 若 Desktop 忘传显式 skill，但 Gateway 判断风格库+写作意图命中，必须在 active skill 归一阶段补进 `style_imitate`
- 验证方式：
  - 正常 `@风格库 + 写作任务`：`style_imitate` 仍自动进入 active skills
  - 只有 `styleWorkflowRequested=true`、没有 active skill：不再触发 style runtime 执法

---

### Fix 3（P0）`SKILL.md` 只保留声明式合同；step 预算与 artifact 语义只以 `styleWorkflowConfig` / `styleWorkflowTypes` 为准

- 文件：`apps/desktop/electron/bundled-skills/style_imitate/SKILL.md`
- 符号：frontmatter `workflow`、正文阶段说明
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`1`
- 文件：`packages/agent-core/src/styleWorkflowConfig.ts`
- 符号：`STYLE_WORKFLOW_PIPELINE_CONFIG_V1`
- 当前行号：`81`
- 文件：`packages/agent-core/src/styleWorkflowTypes.ts`
- 符号：`ArtifactRefV1`、`StepArtifactV1`
- 当前行号：`190`
- 改动原理：
  - 当前 `SKILL.md`、`styleWorkflowConfig`、runtime 三处都在定义阶段细节，导致 lint 次数、Done 条件和 artifact 口径不一致。
  - 本次要求：
    - `SKILL.md` 只保留“什么时候激活 / 什么时候等用户 / 哪个阶段必须完成什么 / 哪些工具合法 / 什么时候能结束”
    - `styleWorkflowConfig` 成为内部 step/budget/source-of-truth
    - `styleWorkflowTypes` 现有 artifact/ref 类型真正接通

```diff
--- a/apps/desktop/electron/bundled-skills/style_imitate/SKILL.md
+++ b/apps/desktop/electron/bundled-skills/style_imitate/SKILL.md
@@
-## Phase 2: 定调与骨架（可写入 runtime state，不需输出给用户）
-... 长段执行细节 ...
-## Phase 3: 写作
-... 长段执行细节 ...
+## Runtime Contract
+
+- 本 skill 的执行细节由 Gateway 内部 style workflow executor 驱动。
+- 本文件只定义：激活条件、等待用户、阶段顺序、lint 必跑、终稿门禁、follow-up 文案。
+- 具体 step budget、artifact schema、chunking、lint retry 次数以 `styleWorkflowConfig` / `styleWorkflowTypes` 为准。
```

```diff
--- a/packages/agent-core/src/styleWorkflowConfig.ts
+++ b/packages/agent-core/src/styleWorkflowConfig.ts
@@
 export const STYLE_WORKFLOW_PIPELINE_CONFIG_V1: PipelineConfigV1 = {
   ...
   global: {
     ...
     lint: {
       maxCopyAttempts: 3,
       maxStyleAttempts: 3,
       pickBestOnExhaust: true,
     },
+    artifactMode: "ref_first",
+    draftStorage: "item_payload_only",
   },
 }
```

- 边界情况：
  - slash 帮助文案仍可从 `SKILL.md` 读取简述
  - frontmatter `workflow` 结构保持不破坏 loader / activeWorkflowDeclarations
- 验证方式：
  - loader 正常发现并加载 `style_imitate`
  - `activeWorkflowDeclarations.get("style_imitate")` 仍存在
  - 预算 / lint 次数只从 config 读取，不再三处各写一份

---

### Fix 4（P0）RunState 改为 ref-first；完整草稿不再进入 `runState`

- 文件：`packages/agent-core/src/runMachine.ts`
- 符号：`RunState`、`createInitialRunState()`
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`155`、`201`、`217`、`220`
- 文件：`packages/agent-core/src/styleWorkflowTypes.ts`
- 符号：`ArtifactRefV1`、`StepArtifactV1`
- 当前行号：`190`
- 改动原理：
  - 现在 `bestStyleDraft.text`、`draftCandidatesV1[].text`、`pipelineArtifacts.*Draft` 都直接挂在状态里，既让 Gateway 内存更胖，也让 `executionReport/logs/history` 更容易被大正文污染。
  - 本次要求：完整正文只存在 live item / artifact payload；`RunState` 只保留 ref 和 summary。

```diff
--- a/packages/agent-core/src/runMachine.ts
+++ b/packages/agent-core/src/runMachine.ts
@@
-  bestStyleDraft: null | { score: number; highIssues: number; text: string };
-  draftCandidatesV1: DraftCandidateV1[];
+  bestStyleDraft: null | { score: number; highIssues: number; artifactId: string; charCount: number };
+  draftCandidatesV1: Array<{ artifactId: string; styleScore: number; highIssues: number; charCount: number; copy?: Record<string, unknown> | null }>;
@@
-  pipelineArtifacts: PipelineArtifactsV1 | null;
+  stepArtifactRefs: Partial<Record<StyleWorkflowStepIdV1, ArtifactRefV1>> | null;
@@
-    bestStyleDraft: null,
-    draftCandidatesV1: [],
+    bestStyleDraft: null,
+    draftCandidatesV1: [],
@@
-    pipelineArtifacts: null,
+    stepArtifactRefs: null,
```

- 边界情况：
  - `finalWritten`、`selectedStyleLibraryId`、`styleTopic`、lint 摘要仍保留在状态中，便于续跑和审计
  - 最终成稿路径仍以 `write` 结果为准，不靠 artifact ref 推导
- 验证方式：
  - 运行一次长 style 任务后，`runState` 中不再出现整段大正文
  - `executionReport.runState` 中只看到 artifactId / charCount / score / phase 摘要

---

### Fix 5（P0）GatewayRuntime 不再补造 `toneCard/structureOutline`，也不再把任意 write/edit 视为草稿完成

- 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：`ensureStylePlanningArtifacts()`、`_resolveStyleWorkflowFollowUp()`、`_isStyleWorkflowWaitingForUser()`
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`436`、`1820`、`1910`、`3818`、`4159`、`4294`
- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：`looksLikeAssistantWaitingForUserText()` 使用点
- 当前行号：`6856`
- 改动原理：
  - 当前 runtime 会“猜”出 plan/draft 已经有了，从而掩盖真正缺失的 phase；这正是“不写草稿、跳过 lint、续跑错 phase”的根源之一。
  - 本次要求：只有真正创建了对应 artifact / item，phase 才算完成；waiting 只认 thread state，不再靠 assistant 文本 heuristics。

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-function ensureStylePlanningArtifacts(runState: RunState) {
-  ... 根据 kb.search 自动补造 toneCard / structureOutline ...
-}
+// removed: style planning artifacts must come from explicit executor step output
@@
-        if (looksLikeDraftText(text)) {
-          this.runState.hasDraftText = true;
-        }
+        if (toolResultCreatesFullDocumentDraftArtifact(toolName, toolArgs, toolResult)) {
+          this.runState.hasDraftText = true;
+          this.runState.stepArtifactRefs = upsertDraftArtifactRef(...);
+        }
@@
-  const styleWorkflowWaitingForUser =
-    styleWorkflowIncomplete &&
-    failureDigest.failedCount === 0 &&
-    looksLikeAssistantWaitingForUserText(lastAssistantText);
+  const styleWorkflowWaitingForUser =
+    styleWorkflowIncomplete &&
+    failureDigest.failedCount === 0 &&
+    threadState.waitingFor === "user";
```

- 边界情况：
  - proposal-only `write/edit`、局部 patch、diff 预览，不得把 `hasDraftText` 置真
  - `run.done` 仅在 `waitingFor=user` 或 workflow `completed` 时允许自然收口
- 验证方式：
  - 故意只做 `kb.search`，不应自动出现 `toneCard/structureOutline`
  - 故意只做局部 edit，不应直接跳到 `need_copy_lint`
  - 题面缺失时，问完一次后必须进入 thread waiting，且下一轮从等待点恢复

---

### Fix 6（P0）`run.execution.report` 与 Desktop live logs 瘦身；续跑只持久化 phase + refs

- 文件：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：`_buildExecutionReport()`
- 当前 HEAD：`989e827bd7fc62201845e7daba9265a12a23f86c`
- 当前行号：`4466`
- 文件：`apps/desktop/src/agent/wsTransport.ts`
- 符号：`run.execution.report` / `run.end` 事件处理
- 当前行号：`1246`、`1326`
- 文件：`apps/desktop/src/state/runStore.ts`
- 符号：`log()`
- 当前行号：`1444`
- 文件：`apps/desktop/src/state/conversationStore.ts`
- 符号：`slimRuntimeTurnForHistory()`
- 当前行号：`435`
- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：`createInitialRunState()` 调用点、`patchThreadWorkflow()`
- 当前行号：`4303`、`5343`
- 改动原理：
  - 现在 live report 和 logs 都可能吃到 fat data；而续跑如果继续存正文，也会重新把 Desktop 慢性顶爆。
  - 本次要求：
    - `executionReport.styleWorkflow` 只保留 phase / missingSteps / artifact refs / charCount / lint 摘要 / final path
    - `wsTransport` 记录日志前先做 slim
    - thread/taskState.workflow 只存 phase + refs，不存正文

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
-          styleEvidencePack: (this.runState as any)?.styleEvidencePack ?? null,
+          styleEvidencePack: summarizeStyleEvidencePack((this.runState as any)?.styleEvidencePack),
@@
-          hasDraftText: Boolean((this.runState as any)?.hasDraftText),
+          hasDraftText: Boolean((this.runState as any)?.hasDraftText),
+          draftArtifactId: String((this.runState as any)?.stepArtifactRefs?.closure?.artifactId ?? "").trim() || null,
+          draftChars: Number((this.runState as any)?.bestStyleDraft?.charCount ?? 0) || 0,
```

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
-          if (event === "run.execution.report") {
-            log("info", "run.execution.report", data);
+          if (event === "run.execution.report") {
+            log("info", "run.execution.report", slimExecutionReportForLog(data));
             ...
           }
@@
-          if (event === "run.end") {
+          if (event === "run.end") {
             ...
+            persistStyleWorkflowResumePatch(extractStyleWorkflowResumePatch(data?.executionReport));
           }
```

- 边界情况：
  - Dev console 允许显式输出更详细调试信息，但 `runStore.logs` 与历史快照只保留 slim 版本
  - `executionReport.styleWorkflow`、`skillStatus.style_imitate` 继续存在，避免审计/UI 断裂
- 验证方式：
  - 跑一篇长文 style 任务，观察 renderer `logs`、`thread.taskState.workflow`、`executionReport`
  - 期望：无大正文、无 MB 级 report、仍能显示 phase/status/missingSteps
  - 杀进程后恢复，仍可从最近 phase 继续，不必重走全部检索和 lint

---

## 7. 风险与连锁反应

### 7.1 兼容性风险

1. 某些隐藏调用方可能还在发送 `styleExecutionMode/stylePipelinePayload`
   - 处理：第一阶段不 400，先 warn + ignore
2. 现有 audit / UI 可能依赖 `executionReport.styleWorkflow` 的旧字段
   - 处理：保留字段名，先做 summary-compatible slimming，不做一次性删除

### 7.2 性能风险

1. 如果只做 persistence slimming，不做 live log/report slimming，长任务仍可能慢性 OOM
2. 如果只移除 pipeline 入口，但仍让 `GatewayRuntime` 补造 artifact，闭环语义仍会失真

### 7.3 proposal-first 风险

1. 如果不区分“完整草稿 artifact”和“proposal / patch / partial edit”，`hasDraftText` 还会被误置真
2. 因此 style draft 的完成判定必须绑定 `coverage=full_document` 或明确的 artifact kind，而不是泛化到所有 `write/edit`

### 7.4 对 portable skill 的误伤风险

1. 若改动 `SkillManifest.portable` 相关字段语义，会伤到当前 Claude/portable skill 主链
2. 若把 style phase tool gate 泛化到所有 skill，会伤到 `allowed-tools` / hooks / fork 子链
3. 若放松 assistant-only 高风险 gate，会带来安全回归

---

## 8. 验证 checklist

### 8.1 功能闭环

- [ ] `@风格库 + 写作任务` 能稳定激活 `style_imitate`
- [ ] 多个 style 库时，只问一次库选择，并进入 thread waiting
- [ ] 主题缺失时，只问一个最小必要问题，并进入 thread waiting
- [ ] 进入正文前，必须有显式 `toneCard` / `structureOutline` artifact 或等价 ref
- [ ] 没有完整草稿时，不能直接进入 `lint.copy`
- [ ] `lint.copy` 与 `lint.style` 都必须跑；任一未通过时不能直接交付终稿
- [ ] `run.done` 只有在 waiting 或 completed 时才会自然收口

### 8.2 续跑

- [ ] 在 `need_copy_lint` 中断后，下一轮从 copy lint 继续
- [ ] 在 `need_style_lint` 中断后，下一轮从 style lint 继续
- [ ] 新任务 prompt 明确发起后，不复用旧 workflow phase/ref

### 8.3 内存 / 载荷

- [ ] `RunState` 不含完整 draft 正文
- [ ] `executionReport` 不含完整 draft 正文
- [ ] `runStore.logs` 中的 `run.execution.report` 为 slim 版本
- [ ] 历史快照 / pending snapshot 不因 style 长文显著膨胀

### 8.4 兼容性

- [ ] portable skill 的 `allowed-tools`、hooks、fork、agent bridge smoke 通过
- [ ] `skill.install` / `shell.exec` / `process.*` 的 assistant-only gate 不退化
- [ ] 直接发送 legacy `pipeline_v1` 请求体时，只收到 warn，不会真正执行旧 pipeline

---

## 9. 回滚 / 兼容说明

1. **入口兼容**
   - 第一阶段保留 `styleExecutionMode/stylePipelinePayload` 解析，但忽略执行
   - 若线上出现隐藏调用方依赖，可只恢复 warn + telemetry，不恢复旧 executor

2. **输出兼容**
   - 保持 `executionReport.styleWorkflow` 和 `skillStatus.style_imitate(.v1)` 存在
   - 只做 summary-compatible slimming，不做字段立即删除

3. **文件级回滚**
   - 若 style runtime executor 新路径出现问题，可暂时回滚到“runtime gate + strict waiting + no fat report”子集
   - 不建议回滚 legacy pipeline 公开入口；那会把双真相重新引回 live path

---

## 10. 涉及文件清单

### 必改（P0）

- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- `apps/desktop/electron/bundled-skills/style_imitate/SKILL.md`
- `packages/agent-core/src/runMachine.ts`
- `packages/agent-core/src/styleWorkflowConfig.ts`
- `packages/agent-core/src/styleWorkflowTypes.ts`
- `apps/desktop/src/agent/wsTransport.ts`
- `apps/desktop/src/state/runStore.ts`

### 联动校验

- `apps/desktop/src/agent/gatewayAgent.ts`
- `apps/desktop/src/state/conversationStore.ts`
- `apps/gateway/src/agent/pipelineExecutor.ts`
- `apps/gateway/src/agent/portableSkillCompat.ts`

### 明确不动语义

- `packages/agent-core/src/skills.ts`（portable 字段全局语义）
- `apps/gateway/src/agent/portableSkillCompat.ts`（Claude/portable compat 主链）
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts` 中 assistant-only 高风险工具 gate 的公共规则

---

## 11. 子 Agent 复核结论（摘要）

已用干净上下文子 agent 做独立复核，结论与本 spec 一致：

1. 当前确实存在双真相，而且是“公开入口 legacy pipeline + 主路径内部 workflow/fallback 双语义”两层并存
2. 最优边界是：
   - 只收口 `style_imitate`
   - 关掉旧 pipeline 入口
   - 不改 portable skill 主链
3. 额外补充的关键风险：
   - `styleWorkflowRequested` 如果不明确限缩，双真相还会回来
   - `executionReport.styleWorkflow` / `skillStatus.style_imitate` 的消费侧必须同步保兼容
   - `proposal-first` 若不与“完整草稿”区分，闭环仍会失真

---

## 12. 实施状态（2026-03-21）

### 12.1 已落地

| 项 | 状态 | 说明 |
|---|---|---|
| 单一激活真相 | 已完成 | Gateway follow-up / gate / waiting 收口为只认 active `style_imitate`，不再把 `styleWorkflowRequested` 当等价激活。 |
| legacy pipeline live path 关闭 | 已完成 | `pipeline_v1` / `stylePipelinePayload` 仅保留兼容解析与 notice，不再进入 live executor。 |
| runtime ref-first state | 已完成 | `bestDraft` / `bestStyleDraft` / `stepArtifactRefs` 改为 `artifactId + charCount` 口径，`executionReport` 改为 summary 输出。 |
| style runtime 接管 | 已完成 | 新增 `style_imitate.run` runtime 执行分支，内部串起 `kb.search → lint.copy → lint.style → write`。 |
| Desktop 发包收口 | 已完成 | renderer 默认不再预构建 `stylePipelinePayload`，只在显式 legacy 入参时透传。 |
| Desktop 日志瘦身 | 已完成 | `thread.snapshot` 与 `run.execution.report` 仅记录 slim summary，不再把整包 runtime 数据写入 logs。 |
| thread-first resume | 已完成 | `taskState.workflow.checkpoint` 可回灌到 `runState`，新任务会清掉旧 checkpoint，避免脏续跑。 |

### 12.2 实现偏差

1. 本轮没有恢复/保留 fat `toneCard` / `structureOutline` 全量 payload 持久化。
   - 当前采用的是 **轻量 checkpoint/ref**：
     - phase
     - artifact ref
     - charCount
     - lint 摘要
     - finalWrittenPath
   - 这是有意选择，用来切断 `runState / executionReport / renderer logs` 对大正文与大材料的长期持有。

2. `PipelineExecutor` 文件仍保留在仓库中。
   - 当前仅作为历史实现留档/回滚参考；
   - live path 已关闭，不再由 Desktop 默认触发，也不再作为 runtime 并行真相。

3. `buildStylePipelinePayload()` helper 仍保留在 Desktop。
   - 目的是保守兼容显式 legacy 参数；
   - 默认启动路径已不再调用它。

### 12.3 本轮验证结果

- `npm run -w @ohmycrab/gateway build`：通过
- `npm run -w @ohmycrab/desktop build`：通过
- `npm run -w @ohmycrab/gateway smoke:style-orchestrator`：通过
- `npm run -w @ohmycrab/gateway smoke:workflow-sticky`：通过

### 12.4 后续观察点

1. 继续观察真实长文 run 下：
   - `thread.snapshot` 频率
   - `logs` 长度增长
   - `executionReport.styleWorkflow` 体积
2. 若后续还出现 renderer 慢性吃内存：
   - 下一步优先查 `tool.result` / `item` payload 是否仍有大文本常驻；
   - 再考虑把 log/store 层做统一的 payload truncation guard。
