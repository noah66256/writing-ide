## Skill 合同化规范 v0.1（对标 OpenClaw）

> 目标：一旦某个 Skill（例如 `style_imitate`）被判定为本轮应激活，它就不再是“可选提示”，而是**必须执行完的工作流合同**。本文先约束写作闭环 `style_imitate`，后续其它 Workflow Skill 可按同一范式扩展。

### 1. 背景

当前实现中，Skill 相关信息和逻辑散落在多处：

- `SkillManifest` 只描述触发条件和少量 prompt 片段；
- 写作闭环依赖多层机制协作：
  - RunState + `analyzeStyleWorkflowBatch`（StyleGate 顺序检测）；
  - `computePerTurnAllowed` 里的四阶段工具白名单；
  - Desktop 侧的 `ACTIVE_SKILLS(JSON)` / `KB_SELECTED_LIBRARIES(JSON)` 注入；
- RunTodo 会给出“检索样例 → 草稿 → lint → 交付”的任务清单，但只是记录，不驱动工具调用。

实际运行中出现了典型问题：

- RunTodo 显示 4 步都对，但模型可以完全绕过 `kb.search`/`lint.*`，直接 `web.search + doc.write`；
- StyleWorkflow Gate 只拦“顺序错误/同回合混用”，无法拦住“干脆不调用闭环工具”的情况；
- `ACTIVE_SKILLS(JSON)` 中出现了 `style_imitate`，但从系统角度看它仍然是“软提示”，不是必须履行的合同。

对标 OpenClaw：

- System prompt 中存在明确的 `## Skills (mandatory)` 段落；
- 每个 Skill 有自己的 SKILL.md，模型被要求：
  - 在回复前扫描 `<available_skills>` 列表；
  - 如果恰好一个 Skill 适用：必须用 `read` 工具打开其 SKILL.md，并遵守其中的步骤；
- Runtime 主要负责工具能力与审计，Skill 约束主要在协议层（System Prompt + SKILL.md）。

本规范将这一范式落到 writing-ide 上，先从 `style_imitate` 开始。

### 2. Skill 分类：workflow vs hint

- **Workflow Skill**：带有明确阶段与终止条件的 Skill，例如 `style_imitate` 的“风格仿写闭环”。
- **Hint Skill**：仅影响语气/渠道/平台等提示，不绑定工具工作流，例如“写成小红书语气”。

约束：

- 只有 Workflow Skill 会绑定“必须执行”的工作流合同；
- Hint Skill 只在 prompt 层生效，不参与工具级 gate 与 RunOutcome 判定。

后续在 `SkillManifest` 上会显式区分这两类（例如增加 `kind: "workflow" | "hint"`），本规范先从行为约定开始。

### 3. System Prompt：Skills (mandatory)

在 Agent 的 system prompt 中新增一个 **Skills 段落**，语义对齐 OpenClaw：

1. 段落标题固定为“Skills（必须执行）”或等价文案。
2. 内容要求：
   - 在回复任何用户请求之前，先扫描 Context Pack 中的 `ACTIVE_SKILLS(JSON)` 列表；
   - 如果恰好一个 Skill 适用（例如本轮是写作任务且绑定了风格库，激活了 `style_imitate`）：
     - 必须按该 Skill 的工作流步骤执行，不要跳过关键步骤（例如不允许“没样例就写稿”）；
   - 如果多个 Skill 适用：选择最具体、最贴近当前任务的那个 Skill，再按其工作流执行；
   - 如果没有 Skill 明确适用：才可以按常规 Agent 流程处理，不读取任何 SKILL 文档。

Desktop 负责在 Context Pack 中注入 `ACTIVE_SKILLS(JSON)` 段落；Gateway 负责在 system prompt 中明确说明：

> “当前会话已激活的 Skills 列在 Context Pack 的 ACTIVE_SKILLS(JSON) 段落中。回复前先快速浏览，如果明显只有一个 Skill 适用于本轮任务（例如 style_imitate 用于仿写/口播稿），就按该 Skill 的工作流执行，不要跳过。”

### 4. Style_imitate 工作流合同（V1）

#### 4.1 激活条件

仅当同时满足以下条件时，`style_imitate` 才被视为 **Workflow Skill** 并激活：

1. 当前 run 为 Agent 模式（`mode = agent`）。
2. `KB_SELECTED_LIBRARIES(JSON)` 中至少存在一个 `purpose="style"` 的库（风格库）。
3. `RunIntent.isWritingTask === true`（或 MainDoc `runIntent ∈ {writing,rewrite,polish}`）。
4. 用户 prompt 中出现显式风格指令（例如 `@李叔`）时，Desktop 必须：
   - 绑定对应风格库；
   - 在 `ACTIVE_SKILLS(JSON)` 中包含 `style_imitate`。

一旦激活：

- Desktop 与 Gateway 都必须在各自的 `activeSkills` 中包含 `style_imitate`；
- `deriveStyleGate()` 中 `styleGateEnabled` / `lintGateEnabled` / `copyGateEnabled` 打开，除非用户明确要求“跳过风格检查”。

#### 4.2 阶段与 RunState

对写作闭环抽象出 5 个阶段（依赖现有 RunState 字段）：

- **S0: need_style_kb** —— 尚未针对风格库执行任何 `kb.search`；
- **S1: need_draft** —— 已完成风格样例检索（`hasStyleKbSearch=true`），但尚未产生 draft（`hasDraftText=false`）；
- **S2: need_copy_lint** —— 已有 draft，copy lint 未通过（`copyLintPassed=false`）；
- **S3: need_style_lint** —— copy lint 已通过，style lint 未通过（`styleLintPassed=false`）；
- **S4: completed** —— copy+style lint 都通过，可进行最终写入/交付。

阶段推导示意：

```ts
phase = !hasStyleKbSearch
  ? "S0"
  : !hasDraftText
    ? "S1"
    : !copyLintPassed
      ? "S2"
      : !styleLintPassed
        ? "S3"
        : "S4";
```

#### 4.3 每阶段允许的工具（硬白名单）

仅针对 `style_imitate` 激活且 `intent.isWritingTask=true` 的场景，在 `computePerTurnAllowed` 中施加阶段性白名单：

| Phase | 允许的主要工具（除 run.* / time.now 等控制工具外）              |
|-------|-------------------------------------------------------------------|
| S0    | `tools.search`, `kb.search`（kind=card，限定 style 库）          |
| S1    | `kb.search`, `doc.write`, `doc.applyEdits`                        |
| S2    | `lint.copy`                                                       |
| S3    | `lint.style`                                                      |
| S4    | `doc.write`, `doc.applyEdits`（最终交付），可选 `run.mainDoc.update` |

要求：

- 启动阶段/工具发现/web_radar 等逻辑只能在**当前阶段白名单**的交集内做子集收敛，不得向白名单外新增工具；
- 特别是：在 S0/S1 阶段，不得把 `web.search` / 浏览器类 MCP 当作 style_imitate 工具加入白名单。

#### 4.4 顺序 gate（StyleWorkflow）

复用 `analyzeStyleWorkflowBatch` 对单个 tool call 进行顺序分析，但作为 **合同级 gate**：

- 当 `style_imitate` 激活且非 dry-run 时：
  - 只要 `needStyleKb === true`，任何 `doc.write`/`doc.applyEdits` 都视为 `WRITE_BEFORE_KB`；
  - 只要 `needDraftText === true`，任何 `lint.copy`/`lint.style` 都视为 `*_BEFORE_DRAFT`；
  - 在 S2/S3 阶段，`WRITE_BEFORE_COPY_PASS` / `WRITE_BEFORE_LINT_PASS` 也作为违约处理。

违约时：

- 返回工具错误 `error="STYLE_WORKFLOW_VIOLATION"`（带上 violation 代码与提示文案）；
- 通过 `run.notice` 提示模型按“kb.search → 草稿 → lint.copy → lint.style → doc.write”的顺序重试；
- 不更新 RunState 中与该工具相关的成功统计，避免“错写一半”的中间状态。

### 5. 对 RunOutcome 的影响（预留）

短期内，RunOutcome 仍可按现有逻辑判定 `completed/failed`，但建议在 RunAudit 中增加每个 Workflow Skill 的执行状态，例如：

```ts
skillStatus: {
  "style_imitate.v1": {
    status: "not_started" | "in_progress" | "completed" | "degraded",
    missingSteps?: string[],
  },
}
```

后续可以逐步收紧：当 `style_imitate` 激活但未进入 `completed` 状态且用户没有明确要求跳过闭环时，将 RunOutcome 标记为 `style_workflow_incomplete`，并在 UI 中提示“风格闭环未完成”。

### 6. 与 M0–M2 的关系

- **M0（止血 & 可观测）**：本规范加强了 RunOutcome/RunAudit 对失败原因与 policy 执行情况的可解释性，符合 M0 目标；
- **M1（状态机 + Policy 抽象）**：style_imitate 的阶段与白名单统一交由 RunState + Policy 描述，避免散落 if 逻辑，符合 M1 的抽象方向；
- **M2（Provider/工具执行统一）**：Skill 合同只约束“调用哪些工具/顺序如何”，与具体 Provider/Endpoint 无关；只要工具名在 Gateway 抽象层保持稳定，就不会与多 Provider 重构冲突。

