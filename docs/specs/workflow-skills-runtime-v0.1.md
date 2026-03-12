## Workflow Skills Runtime v0.1（对标 OpenClaw / Codex）

> 目标：把 style_imitate 等带“闭环”的 Skill，从零散的 Gate/特例逻辑，收敛成一套统一的 **Workflow Skill Runtime**：
> - 任何 Provider 被判定要用某个 Workflow Skill 时，都必须按其工作流跑完闭环；
> - Runtime 负责 Gate + 审计 + RunOutcome 收口；
> - Skill 层负责“如何补闭环”和具体步骤，合同写在 SKILL.md 里。
>
> 本文先抽象 workflow skill 的通用模型，再落地当前的 `style_imitate` 三个 Phase，并说明与现有 M0/M1/M2 的关系。

---

### 0. 背景问题（为什么要做 Runtime 级收敛）

现状（2026-03-12）：

- style_imitate 已有较完整的闭环设计（kb → draft → lint.copy → lint.style → write），但实现散落在多处：
  - agent-core/runMachine.ts：`analyzeStyleWorkflowBatch`、RunState 字段（hasStyleKbSearch/hasDraftText/...）；
  - gateway/runFactory.ts：StyleWorkflowViolation、StyleWorkflowIncomplete 的部分 Gate/审计逻辑；
  - system prompt：`Skills（必须执行）` 段落 + skill 专用提示；
  - Desktop：ACTIVE_SKILLS(JSON)/KB_SELECTED_LIBRARIES(JSON) 注入。
- 已经做的 M0/M1 改造：
  - 自动拉起 gate：有风格库 + 写作意图 → `styleGateEnabled=true`（fail-close）；
  - Gate 顺序控制：没样例不许写、没 draft 不许 lint、没过 lint 不许写终稿；
  - RunOutcome 收口：风格 skill 激活但闭环未完成时，将本轮 Run 标记为 `status: failed, reason: style_workflow_incomplete`。
- 剩余缺口：
  - Runtime 层只有 style_imitate 一个特例，没有通用 workflow skill 抽象；
  - Skill 层缺乏统一的“补闭环”驱动（继续重试时模型不知道先补哪一步）；
  - SKILL.md 中的合同还没完全成为“执行真相”，只是一部分提示。

---

### 1. Workflow Skill 的抽象模型

#### 1.1 定义

- **Workflow Skill**：带有明确阶段、必经工具和 Done 条件的 Skill（例如 `style_imitate`、未来的 `deep_research`、`corpus_ingest` 等）。
- **Hint Skill**：只影响语气/平台，不绑定工具工作流（例如“写成小红书语气”）。

Workflow Skill 在 runtime 中需要具备三个要素：

1. **触发条件（match）**：什么时候必须启用该 skill（例如：有 purpose=style 的库 + 写作意图）。
2. **阶段状态（snapshot）**：从 RunState 中推导出当前阶段、缺失步骤（phase machine）。
3. **顺序 gate（analyzeBatch）**：对每次 tool call 做“是否违反工作流顺序”的判定（返回 violation code）。

对应到 Typescript：

```ts
type WorkflowSkillPhaseSnapshot = {
  id: string;               // "style_imitate"
  active: boolean;          // 是否本轮激活
  phases: string[];         // ["need_style_kb","need_draft","need_copy_lint","need_style_lint","completed"]
  currentPhase: string;     // 例如 "need_copy_lint"
  missingSteps: string[];   // ["lint.copy","lint.style"]
};

type WorkflowSkillContract = {
  id: string;  // "style_imitate"
  kind: "workflow";
  match: (ctx: RunContext) => boolean; // 触发条件
  snapshot: (state: RunState) => WorkflowSkillPhaseSnapshot;
  analyzeBatch: (args: {
    mode: AgentMode;
    intent: RunIntent;
    gates: RunGates;
    state: RunState;
    lintMaxRework: number;
    toolCalls: ParsedToolCall[];
  }) => { violation: string | null; shouldEnforce: boolean };
};
```

#### 1.2 style_imitate 的 Phase 映射

沿用 `skill-contract-openclaw-parity-v0.1.md` 中的约定：

- S0: `need_style_kb` — 还没对风格库做样例检索（`hasStyleKbSearch=false`）。
- S1: `need_draft` — 有样例 (`hasStyleKbSearch=true`)，但还没有草稿 (`hasDraftText=false`)。
- S2: `need_copy_lint` — 有草稿但 copy lint 未通过（`copyLintPassed=false`）。
- S3: `need_style_lint` — copy lint 通过但 style lint 未通过（`styleLintPassed=false`）。
- S4: `completed` — copy+style lint 都通过（可写终稿）。

`snapshot(state)` 将上述逻辑封装成一个 `WorkflowSkillPhaseSnapshot`，runFactory 在 `run.execution.report` 中直接输出 `workflowSkills: WorkflowSkillPhaseSnapshot[]`。

---

### 2. 三个 Phase 的落地计划（本仓库）

#### Phase 1：Runtime 收敛为通用 Workflow Skills Runtime（当前进行中）

目标：把现有 style_imitate 的 Gate/收口逻辑抽象成通用 runtime，不再散落在多处 if/特例中。

**Phase 1.a：抽象 WorkflowSkillContract**

- 在 `packages/agent-core` 中：
  - 定义 `WorkflowSkillContract` 与 `WorkflowSkillPhaseSnapshot` 类型；
  - 提供一个注册/导出点（例如 `getWorkflowSkillContracts()`），当前仅返回 `style_imitate` 一个实现。
- 在 `packages/agent-core/src/runMachine.ts` 中：
  - 保留现有 `analyzeStyleWorkflowBatch` 实现，但对外包装为 `style_imitate` 的 `analyzeBatch`；
  - snapshot 逻辑（hasStyleKbSearch/hasDraftText/...）封装到 `style_imitate.snapshot`。

**Phase 1.b：GatewayRuntime 集成通用 Workflow Skills**

- 在 `apps/gateway/src/agent/runFactory.ts` 的 `prepareAgentRun()` 中：
  - 根据 `mode/intent/kbSelected/ACTIVE_SKILLS(JSON)` 调用 `getWorkflowSkillContracts()` 过滤出当前 run 应激活的 workflow skills；
  - 把它们挂到 `runCtx.workflowSkills`。
- 在 `GatewayRuntime.tool_execution_end` 中：
  - 替代当前对单一 style_imitate 的调用，改为：

    ```ts
    for (const contract of runCtx.workflowSkills ?? []) {
      const batch = contract.analyzeBatch({ mode, intent, gates, state: this.runState, lintMaxRework, toolCalls });
      if (batch.violation && batch.shouldEnforce) { /* 统一 StyleWorkflowViolation 处理 */ }
    }
    ```

- 在 `_buildExecutionReport()` 中：
  - 用 `workflowSkills.map(c => c.snapshot(runState))` 生成 `workflowSkills: WorkflowSkillPhaseSnapshot[]`；
  - 废弃单一的 `styleWorkflow` 字段，改为通用结构（保留一段兼容窗口）。

**Phase 1.c：RunOutcome 收口通用化**

- 在 `executeAgentRun()` 末尾：
  - 读取 `executionReport.workflowSkills`，找出所有 `status !== "completed" 且 active=true` 的 workflow skill；
  - 若存在且用户没有显式跳过（暂不支持跳过），将本轮 Run：
    - 标记为 `status: failed`；
    - `reason: workflow_skill_incomplete`；
    - `reasonCodes` 附加 `workflow_skill_incomplete` 和 `workflow_skill_incomplete:<skillId>`；
    - 发 `run.notice` 提示缺失步骤。
- 现有的 style_imitate 专用逻辑（styleWorkflowIncomplete）收束为一个 `style_imitate` 实例，不再单独 if。

#### Phase 2：Skill 层补闭环驱动（再跑一遍，而不是只判“未完成”）

目标：当 Run 因 `workflow_skill_incomplete` 失败时，下一轮 “继续重试” 能够**按 workflow skill 的快照主动补步骤**，而不是简单重写稿子。

**Phase 2.a：TASK_STATE 中记录 workflowSkills 快照**

- Desktop 在构建 Context Pack 时，将上一轮 `run.execution.report.workflowSkills` 写入 `TASK_STATE(JSON)`：

  ```json
  {
    "workflowSkills": {
      "style_imitate.v1": {
        "status": "in_progress",
        "missingSteps": ["lint.copy", "lint.style"]
      }
    }
  }
  ```

- 新一轮 run 启动时，agent-core 解析 TASK_STATE，把 snapshot 注入给技能层 prompt（例如作为 `WORKFLOW_STATE(JSON)` 段落）。

**Phase 2.b：Skill Prompt 的“补救协议”**

- 在写作/风格相关 prompt 片段中，为 workflow skill 增加明确补救说明：

  - 当 `reasonCodes` 包含 `workflow_skill_incomplete` 时：
    - 你必须优先按 snapshot.missingSteps 补跑对应工具：
      - 如果缺 `draft` → 先调用 `doc.write` 写候选稿；
      - 如果缺 `lint.copy` → 对当前稿件调用 `lint.copy`；
      - 如果缺 `lint.style` → 对当前稿件调用 `lint.style`，并根据 issues+rewritePrompt 修稿。
    - 补跑完整闭环后，再输出最终回答，不要直接跳过工具执行。

- 对 style_imitate：在 SKILL.md 中也写清这一条，成为技能合同的一部分。

**Phase 2.c：Minimal helper（可选）**

- 在 skill 层实现一个小 helper，用于“从 snapshot 规划下一步工具调用”，供模型在文本中引用：

  ```ts
  function planStyleNextStep(sw: WorkflowSkillPhaseSnapshot): string | null {
    if (!sw.hasDraftText) return 'doc.write';
    if (!sw.copyLintPassed) return 'lint.copy';
    if (!sw.styleLintPassed) return 'lint.style';
    return null;
  }
  ```

- 在 prompt 中用自然语言描述这个决策逻辑，让模型能够稳定遵守。

#### Phase 3：SKILL.md 合同化（对标 OpenClaw）

目标：让 workflow skill 的合同**以 SKILL.md 为真相**，runtime 只做 Gate 与审计，不再在多处硬编码业务细节。

**Phase 3.a：为 workflow skill 编写 SKILL.md**

- 针对 style_imitate，在 `$CODEX_HOME/skills/style_imitate/SKILL.md` 或项目内 `skills/style_imitate/SKILL.md` 写明：
  - When to use：绑定风格库 + 写作/仿写/口播任务；
  - Workflow：
    1. kb.search(kind=card, libraryIds=style libs, cardTypes=templates/rules)；
    2. doc.write 候选稿（不写入 mainDoc）；
    3. lint.copy 检查复述风险；
    4. lint.style 校验风格对齐；
    5. 根据 lint.style 建议修稿（doc.applyEdits），必要时重跑 3–4；
    6. doc.write 终稿落盘。
  - Done 条件：copyLintPassed && styleLintPassed，并已落盘终稿。

**Phase 3.b：在 system prompt 中注入 SKILL.md 摘要**

- 类似 OpenClaw 的 `resolveSkillsPromptForRun`：
  - 为被激活的 workflow skills 加一个 `## Skill: style_imitate（mandatory workflow）` 的 prompt 段落，内容来自 SKILL.md 摘要；
  - 提示模型：当该 skill 激活时，你必须遵守其中的 Workflow 步骤，不得跳过关键工具调用。

**Phase 3.c：与现有 spec 的关系**

- 与 `skill-contract-openclaw-parity-v0.1.md`：
  - 本文是对其中「style_imitate 工作流合同」的 runtime 级落地；
  - 后续其它 workflow skill 可复用同一 WorkflowSkillRuntime。
- 与 `tool-retrieval-v0.1.md`：
  - Workflow Skills Runtime 假定必要工具（kb.search/lint.copy/lint.style/doc.write）在 Tool Retrieval 中**永远不会被裁掉**；
  - Tool Retrieval 负责保证“闭环工具总在 allowed pool 内”，WorkflowSkillRuntime 负责“如何使用它们完成闭环”。

---

### 3. 验收与冒烟 checklist

在 style_imitate 迁移到 Workflow Skills Runtime 后，最小验收用例：

1. **正常闭环（Claude/GPT/Gemini 任一 Provider）**
   - Prompt：
     - “用@某风格写一篇 1000 字口播稿，主题是 XXX（写作任务）”；
   - 预期工具轨迹：
     - `kb.search(style)` → `doc.write`（草稿） → `lint.copy` → `lint.style` → `doc.applyEdits`（修稿，可选） → `doc.write`（终稿）；
   - RunOutcome：`status=completed`，无 `workflow_skill_incomplete`。

2. **跳过 lint 的 run（模型不听话）**
   - 工具轨迹（故意引导只写草稿）：`kb.search(style)` → `doc.write`，然后直接回答；
   - 预期：
     - Gateway Runtime 不允许写终稿（会 Gate），或 RunOutcome 被标记为：
       - `status=failed`；
       - `reason=workflow_skill_incomplete`；
       - `reasonCodes` 包含 `workflow_skill_incomplete:style_imitate`；
       - SSE 中有 `StyleWorkflowIncomplete` 的 `run.notice`。

3. **继续重试（补闭环）**
   - 在 2 的基础上点击“继续重试”：
     - 新一轮 run 的 Context Pack 中包含上一轮的 workflowSkills snapshot；
     - 模型根据 snapshot 优先补 `doc.write`/`lint.copy`/`lint.style`；
     - 闭环跑完后 RunOutcome 变为 completed。

4. **其他 workflow skill 不受影响**
   - 当没有任何 workflow skill 激活（例如纯讨论/解释/只读 KB）时：
     - Workflow Skills Runtime 不介入，不产生任何额外 Gate 或 reasonCodes；
     - 行为与当前实现一致。


---

### 4. Phase 4 展望：从“LLM 驱动 + Gate”到“Runtime 编排的真正 Workflow”

> 本节不是 v0.1 的必须范围，而是基于实现过程中新暴露的问题，对下一阶段（v0.2）的方向性记录。

当前 v0.1 的 Workflow Skills Runtime，解决的是：

- 把 `style_imitate` 这类 Skill 从“散落在多处的 if/特例”收敛为：
  - **有状态的合同**（snapshot/phase/missingSteps）；
  - **统一的顺序 Gate**（`STYLE_WORKFLOW_VIOLATION` / `workflow_skill_incomplete`）；
  - **可续跑的补课机制**（TASK_STATE.workflowSkills + prompt 提示按 missingSteps 补工具）。

但它仍然是一个 **“LLM 驱动 + Runtime 守门”** 的范式：

- 工具选择与调用顺序依然由 Provider 决定；
- Runtime 只在模型“踩线”时给一刀（例如 `WRITE_BEFORE_COPY_PASS`）；
- Phase 2 通过 TASK_STATE + 提示词，引导下一轮“不要再犯同一个顺序错误”。

这跟 Dify / n8n / LangGraph 等“真正意义上的 workflow 编排器”还有一层差距：

- 在那类系统里，**步骤顺序由引擎控制**，LLM 只在节点内部产内容；
- 引擎不会把 `lint.copy` / `lint.style` / 终稿 `doc.write` 这些内部细节直接暴露给大模型；
- 因此从理论上讲，不会出现高频的 `WRITE_BEFORE_COPY_PASS`——模型拿不到乱叫这些工具的权限。

#### 4.1 我们现在的位置

综合来看，当前 v0.1 处于这样一个折中状态：

- **已完成**：
  - WorkflowSkill 抽象 + Runtime Gate + RunOutcome 收口；
  - Desktop 把 workflowSkills 快照写入 TASK_STATE，方便下一轮补课；
  - `skills/style_imitate/SKILL.md` 给出了明确的 Workflow 合同与 Done 条件。
- **尚未完成的部分**：
  - 工具调度权仍在 LLM 手里，Runtime 只是守门员；
  - `WRITE_BEFORE_COPY_PASS` 等 violation 仍然是日常可见的错误类型，而非极端兜底。

#### 4.2 v0.2 / Phase 4 的目标（Orchestrated Workflow）

下一阶段（暂称 v0.2 / Phase 4）要做的，是把 `style_imitate` 从“守门型 workflow skill”升级为“由 Runtime 主动编排的子工作流”：

1. **收回工具调度权**
   - 对写作 Agent 来说，不再直接向 Provider 暴露 `kb.search` / `lint.copy` / `lint.style` / `doc.write(终稿)` 整套工具；
   - 而是对外暴露一个更高阶的节点/子 Agent，例如 `style_imitate.run`；
   - 节点内部由 Runtime/子 Agent 按状态机顺序调用具体工具，模型只在“写草稿/改稿”这些点上补内容。

2. **Runtime 内部实现真正的节点流**
   - 结合 `WorkflowSkillPhaseSnapshot` 与 RunState：
     - 决定下一步应该执行哪一个内部步骤（样例检索 / 草稿 / lint / 改稿 / 终稿落盘）；
     - 主动生成对应的工具调用，而不是等待模型自行拼凑工具序列；
   - 对外的 Agent 循环只看到“调用 style_imitate 工作流一次”，不用关心内部 5–6 个子步骤。

3. **Gate 从“主路径依赖”降级为“安全网”**
   - 在 Orchestrated Workflow 模式下，正常路径上不会再出现“模型直接写终稿”的情况，因为该工具根本不暴露；
   - `STYLE_WORKFLOW_VIOLATION` 仍然保留，但语义从“教学提示 + 纠偏手段”降级为“极端错误/系统 Bug 时的兜底信号”。

#### 4.3 与当前 v0.1 的边界

- 本文档所描述的 v0.1 范围，仅包括：
  - WorkflowSkill 抽象与 style_imitate 的 v0.1 实现；
  - Runtime 级 Gate + RunOutcome 收口；
  - Desktop/TASK_STATE 对 workflowSkills 的回灌；
  - SKILL 合同（`skills/style_imitate/SKILL.md`）作为行为真相。
- 真正的“节点式 workflow 编排”（即上文 4.2 所述）不在 v0.1 的 DoD 内，
  - 会在单独的 v0.2 / Phase 4 规格中详细展开；
  - 包括是否用子 Agent、子图（subgraph）或专用 orchestrator 来承载 style_imitate 内部状态机。

