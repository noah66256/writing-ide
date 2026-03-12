## Workflow Skills Runtime v0.2：Orchestrated Style Imitate（草案）

> 目标：在 v0.1 的基础上，把 `style_imitate` 从“LLM 驱动 + Runtime 守门”的 Workflow Skill，升级为由 Runtime 主动编排的 **Orchestrated Workflow**：
> - 对 LLM 暴露一个/少数高阶节点（如 `style_imitate.run` 或子 Agent），隐藏内部步骤顺序；
> - Workflow 的阶段/顺序由 Runtime/子 Agent 的状态机控制，而不是由 Provider 自由调用工具；
> - `STYLE_WORKFLOW_VIOLATION` 从“常见教学错误”降级为“极端兜底信号”。
>
> 范围：仅覆盖 `style_imitate` 这一条闭环，作为 Workflow Skills Runtime v0.2 的首个 Orchestrated 示例；后续其它 workflow skill（如 deep_research、corpus_ingest）可复用同一范式。

---

### 0. 背景：v0.1 的边界与痛点

v0.1（见 `workflow-skills-runtime-v0.1.md`）已经完成：

- 抽象出通用 `WorkflowSkillContract` / `WorkflowSkillPhaseSnapshot`；
- 将 `style_imitate` 的闭环状态（need_style_kb → need_draft → need_copy_lint → need_style_lint → completed）统一收口到 Runtime；
- 在 GatewayRuntime 中拦截顺序错误（`STYLE_WORKFLOW_VIOLATION`），RunOutcome 以 `workflow_skill_incomplete` 收口；
- Desktop 将 `workflowSkills` 快照写入 `TASK_STATE(JSON)`，下一轮运行时可按 missingSteps 补课；
- `skills/style_imitate/SKILL.md` 成为行为真相（合同）：定义了触发条件、完整 Workflow、Done 条件。

但 v0.1 仍然是一个 **“LLM 驱动 + Runtime 守门”的范式**：

- LLM 直接看到 `kb.search` / `lint.copy` / `lint.style` / `doc.write` 等工具；
- 工具调用顺序仍然由 Provider 自主决定；
- Runtime 只能在模型“踩线”时给一刀（例如 `WRITE_BEFORE_COPY_PASS`），并提示“按 kb.search → draft → lint.copy → lint.style → doc.write 的顺序重试”；
- `STYLE_WORKFLOW_VIOLATION` 是高频现象，而不是罕见兜底。

这与 Dify / n8n / LangGraph 等“真正 workflow 引擎”的差距在于：后者 **把“步骤顺序”收回到引擎**，LLM 只在节点内部产内容。

本草案就是为 v0.2 定义这层升级：**把 style_imitate 做成由 Runtime 编排的 Orchestrated Workflow**。

---

### 1. 设计目标与非目标

**1.1 设计目标**

- G1：把 `style_imitate` 的内部步骤顺序，从 LLM 决策收回到 Runtime/子 Agent 的状态机。
- G2：对上层 Agent/Provider 暴露一个/少数高阶入口（如 `style_imitate.run` 或 `agent.delegate(style_copywriter)`），隐藏内部工具细节。
- G3：兼容现有 v0.1 的状态记录与审计：phase-snapshot / RunOutcome / StyleWorkflowViolation 继续可用。
- G4：保持多 Provider 一致行为（Claude/GPT/Gemini），不依赖某个模型的“听话程度”。
- G5：为未来其它 workflow skill（deep_research / corpus_ingest 等）提供可复用的 Orchestrated Workflow 模板。

**1.2 非目标（v0.2 不做的事）**

- 不在 v0.2 中一次性改造所有 workflow skill，只聚焦 `style_imitate`；
- 不要求完全移除 `STYLE_WORKFLOW_VIOLATION`，仅降低其为罕见兜底；
- 不改变 Desktop 侧 Skill 管理与 UI 结构（只在 Runtime/Agent 层做改动）。

---

### 2. 概念模型：Orchestrated Workflow Skill

#### 2.1 定义

在 v0.2 中，`style_imitate` 升级为 **Orchestrated Workflow Skill**：

- 对 Agent Loop 暴露为单个高阶节点：
  - 形式 A：一个高阶工具，例如 `style_imitate.run`；
  - 形式 B：一个子 Agent，例如 `style_copywriter`，通过 `agent.delegate` 调用；
- 节点内部的步骤（kb.search → draft → lint.copy → lint.style → applyEdits → final doc.write）:
  - 由 Runtime/子 Agent 的状态机控制；
  - 可以在内部多轮调用 LLM，但不再由外层 Provider 选择工具顺序；
- 外层 Agent 只关心“调用/不调用 style_imitate”，“输入/输出是什么”，而不关心中间工具轨迹。

#### 2.2 状态机与 SKILL 合同的关系

- `skills/style_imitate/SKILL.md` 是行为真相：
  - 触发条件：何时必须启用 style_imitate；
  - Workflow：六步链（kb.search → draft doc.write → lint.copy → lint.style → doc.applyEdits → final doc.write）；
  - Done 条件：`hasStyleKbSearch && hasDraftText && copyLintPassed && styleLintPassed`。
- Orchestrated Workflow 的状态机直接基于此合同：

  ```text
  S0 need_style_kb  → S1 need_draft → S2 need_copy_lint → S3 need_style_lint → S4 completed
  ```

- v0.2 要求：
  - 状态机的推进逻辑由 Runtime/子 Agent 实现，而不是提示模型“请按上述顺序调用工具”；
  - `WorkflowSkillPhaseSnapshot` 仍然可从状态机推导，供审计与 Desktop 展示使用。

---

### 3. 总体架构方案（Two-Tier Orchestrator）

> 这里给出一套推荐方案，后续实现阶段可以在此基础上细化/调整。

#### 3.1 上层：Writing Agent 与 style_imitate 的交互

- 上层 Writing Agent（GatewayRuntime 驱动的主 Agent Loop）不再直接暴露 `lint.copy` / `lint.style` 等内部工具；
- 当满足 style_imitate 的触发条件时：
  - Context Pack 中的 `ACTIVE_SKILLS(JSON)` 继续标记 `style_imitate`；
  - 但工具列表只暴露一个高阶入口，例如：
    - `style_imitate.run`（工具）；或
    - `agent.delegate` 指向子 Agent `style_copywriter`。
- 写作任务时，主 Agent 只需要决定：
  - 是否调用 style_imitate；
  - 传入什么指令（主题/长度/平台/受众等）；
  - 对输出结果做什么（例如再总结、再拆分成多版等）。

#### 3.2 下层：Orchestrator 内部的步骤编排

- Orchestrator 可以实现为：
  - 方案 A：GatewayRuntime 内部的一段专用 state machine + 工具调用逻辑；
  - 方案 B：一个“mini Agent Loop”（子 Agent），但其工具集只包含 style_imitate 的内部工具，且由 Orchestrator 控制阶段推进。

推荐路线：

- 短期（v0.2）：采用方案 A——在 Gateway 侧实现 `runOrchestratedStyleImitate()`：
  - 输入：
    - 写作任务描述（主题/字数/平台等）；
    - 风格库上下文（KB_SELECTED_LIBRARIES / STYLE_SELECTOR 等）；
  - 实现：
    - 内部按 SKILL 合同与状态机顺序依次调用：
      1. kb.search（style 样例检索）
      2. doc.write（草稿）
      3. lint.copy
      4. lint.style
      5. doc.applyEdits（0-N 次）
      6. doc.write（终稿）
    - 每一步需要 LLM 时，使用同一 Provider 调 `messages/responses` 接口，但不暴露给外层 Agent；
    - 关键状态（hasStyleKbSearch / hasDraftText / copyLintPassed / styleLintPassed）实时更新 RunState。
  - 输出：
    - 最终稿路径 + 文本摘要；
    - WorkflowSkills Snapshot（供 Desktop 展示）。

- 中长期（v0.3+）：视需要将 Orchestrator 抽象为可复用组件，用于 deep_research / corpus_ingest 等其它 workflow skill。

---

### 4. 关键设计细节

#### 4.1 工具暴露与隔离

- 在 Orchestrated 模式下：
  - 主 Agent 所见工具集：
    - 通用工具：web.search / web.fetch / kb.search（非 style）/ doc.read 等；
    - 写作交付工具：doc.write（最终交付文件）、少量通用编辑工具；
    - style_imitate 高阶入口：`style_imitate.run` 或子 Agent；
  - Orchestrator 内部工具集：
    - kb.search（仅限 purpose=style 库）；
    - doc.write（草稿路径）；
    - lint.copy / lint.style；
    - doc.applyEdits；
  - 内部工具对主 Agent/Provider 不直接可见。

- 优点：
  - 避免主 Agent 误用 lint 工具（例如在非风格场景里乱调）；
  - 避免 Provider 把 lint 工具当成“普通工具”随意排列顺序。

#### 4.2 Orchestrator 与 WorkflowSkills Runtime 的关系

- WorkflowSkills Runtime v0.1 的 Gate 逻辑仍然保留，但作用变为：
  - 监控 Orchestrator 内部步骤是否按合同执行；
  - 作为极端情况（逻辑 bug/异常）的兜底检测；
- 正常情况下：
  - Orchestrator 自己不会发出违反 SKILL 合同的工具顺序；
  - 因此 `WRITE_BEFORE_COPY_PASS` 等 violation 应该变得极少，主要用于防御未预期的 bug。

#### 4.3 错误处理与降级

- 若内部某一步骤失败（例如 lint.style 多次未通过）：
  - Orchestrator 可以：
    - 明确返回“lint 未通过 + 建议用户是否接受当前版本”给主 Agent；
    - 或在一定重试次数后，允许输出“质量较低”的版本，并在 RunOutcome 中附加 reasonCode。  
- 若 Provider 短暂不可用或返回异常：
  - Orchestrator 负责记录到 RunState 与 failureDigest；
  - RunOutcome 由主 Agent 统一收口（保持与现有 error handling 一致）。

#### 4.4 多 Provider 一致性

- Orchestrator 必须：
  - 对 Claude/GPT/Gemini 等使用相同的步骤序列；
  - 不依赖“某个模型更听话”来保证顺序正确；
- 若某个 Provider 在 lint.style 表现不稳定，可通过：
  - 针对 Provider 的 score 阈值/重试策略微调；
  - 但不得改变整体 Workflow 顺序或跳过关键步骤。

---

### 5. 集成点与落地计划（建议）

> 本节给出一个推荐的落地顺序，方便后续 Phase 拆分实现。

1. **Phase A：定义 Orchestrator 接口**  
   - 在 Gateway 层定义 `runOrchestratedStyleImitate(args)`：
     - 输入：写作任务描述 + 风格库上下文；
     - 输出：终稿路径 + 摘要 + workflowSkills snapshot；
   - 内部暂时可以调用现有 Agent Loop/工具链，先以“包装层”形式存在。

2. **Phase B：调整工具暴露**  
   - 修改写作场景下的 Tool List：
     - 对主 Agent 隐藏 lint.copy / lint.style / 草稿 doc.write / doc.applyEdits；
     - 增加一个高阶工具 `style_imitate.run`；
   - 在 Agent system prompt 中，指导模型：
     - 当写作任务且绑定风格库时，用 `style_imitate.run` 完成风格闭环；
     - 终稿可由 Orchestrator 写入文件，也可以由主 Agent 再次加工。

3. **Phase C：将内部步骤迁移到 Orchestrator 状态机**  
   - 步骤化迁移：
     1. 先把 kb.search(style) 收到 Orchestrator 内；
     2. 再把草稿 doc.write 收进去；
     3. 最后迁移 lint.copy / lint.style / doc.applyEdits；
   - 每一步迁移后，保持现有 WorkflowSkills Gate 和 RunOutcome 行为不变。

4. **Phase D：回收多余 Gate & 提示**  
   - 当 Orchestrator 工作稳定、Lint 可靠性提升后：
     - 可以逐步弱化“提示模型按 missingSteps 补课”的系统 prompt 文案；
     - 保留 WorkflowSkills Gate 仅用于兜底（防 bug），而不作为日常教学机制。

5. **Phase E：模板化其它 Workflow Skill**  
   - 在 style_imitate 基础上，抽象出通用 Orchestrated Workflow 模板；
   - 为 deep_research / corpus_ingest 等设计各自的 SKILL 合同 + 状态机；
   - 逐步迁移到统一的 Workflow Skills Runtime v0.2 范式。

---

### 6. DoD（v0.2 层面的“完成”定义）

1. 写作类任务 + 绑定风格库时：主 Agent 只看到一个高阶入口（工具或子 Agent），不再直接看到 lint.copy / lint.style。  
2. style_imitate 的内部步骤顺序由 Orchestrator 状态机控制，正常路径下不会触发 `WRITE_BEFORE_COPY_PASS` 等顺序错误。  
3. WorkflowSkills snapshot 仍然可用，Desktop 能正确展示 style_imitate 的阶段与 missingSteps（主要用作调试/审计）。  
4. Claude/GPT/Gemini 在相同输入下，style_imitate 的工具轨迹（在日志中）表现为相同的阶段顺序，只在内容细节与重试次数上有差异。  
5. 现有 v0.1 behavior 不被破坏：
   - 未启用 style_imitate 的任务，不受 Orchestrator 引入的任何额外约束；
   - 旧的 StyleWorkflowViolation 报警仍然可以在异常情况下触发，用于调试。  



### 7. 当前实现状态（2026-03-12）

> 说明：本节描述当前代码仓库中已落地的部分，与上文的理想 DoD 对照，便于后续继续演进。

- Style Workflow Runtime v0.1 已完全落地：style_imitate 作为 workflow skill，snapshot/phase/missingSteps 与 Gate 逻辑均在 Runtime 统一维护，Desktop 通过 TASK_STATE(JSON).workflowSkills 续跑补课。

- v0.2 目前采用的是“轻量 Orchestrator”方案：通过 `computeStyleTurnCaps()` 在 Gateway 侧按阶段（need_style_kb / need_draft / need_copy_lint / need_style_lint / completed）收敛**每回合可见的风格工具集合**，并在 runFactory 中注入 hint，引导 Provider 按 kb → draft → lint.copy → lint.style → doc.write 的顺序执行。

- 对于写作类任务 + 绑定风格库的场景：
  - 在 Pi Agent Runtime 下，style_imitate 会自动拉起，且 per-turn allowlist 只在当前阶段暴露必要的 kb/lint/doc.write 工具；
  - 旧的 StyleWorkflowViolation 仍作为兜底 Gate 保留，但在正常路径中显著降频（多数顺序错误会在工具白名单阶段被消掉）。

- 尚未实现的部分（保留为后续 v0.3+ 升级方向）：
  - 还没有对外暴露独立的高阶工具 `style_imitate.run`（当前依然由主 Agent 直接调用 kb.search / lint.copy / lint.style / doc.write，只是经过 per-turn orchestrator 收敛顺序）；
  - 尚未在 Gateway 内部实现“完全由 Orchestrator 驱动、无需 Provider 自选工具”的子 Agent 版本，runOrchestratedStyleImitate 仍预留为演进挂钩。

- 因此可以理解为：目前代码状态已经覆盖了本文第 5 节中 Phase A/B/C 的“Runtime 收敛 + per-turn Orchestrator + 冒烟验证”部分，而 DoD 中关于 `style_imitate.run` 高阶入口与完整子 Agent Orchestrator 的部分，会在后续版本中继续推进。
