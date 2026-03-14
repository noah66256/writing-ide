## Skill / Workflow / MCP 分层改造阶段计划（draft v0.1）

> 范围：统一「工具 / MCP / Skill」三层的职责与触发范式，避免 skill 抢路由、挤掉基础工具；以现有 `style_imitate` 为首个 Workflow Skill 样板，对齐 OpenClaw / Claude Skills 等实践。
>
> 时间点：2026-03-14（基于当前代码状态、`workflow-skills-runtime-v0.2-orchestrated-style-imitate.md`、`tooling-platformization-phased-plan-2026-03-11.md` 等文档）。

---

### 0. 现状小结（今天的真实状态）

**三层角色**

- **Tool 层（含 MCP 工具）**
  - 单一事实源：`packages/tools`（TOOL_LIST、tool 元数据）。
  - Gateway 里通过 `tool-retrieval-v0.1` + `core-tools-exposure-refactor-2026-03-13` 控制：
    - route → `toolPolicy` → `baseAllowedToolNames`；
    - MCP 走 server-first 收敛（`mcp-hierarchical-tool-selection-v1`）。
  - Skill 的 `toolCaps.allowTools` 目前只做「pin 必需工具到 allowed set」，**不会主动删工具**。

- **Skill 层**
  - 统一定义：`packages/agent-core/src/skills.ts` + `docs/specs/skill-definition-standard-v0.1.md`。
  - 激活：
    - 自动：`autoEnable=true` + triggers（`has_style_library` / `run_intent_in` / `text_regex` 等）。
    - 半显式：body.activeSkillIds（Desktop / 用户 @skill）。
  - 作用：
    - 注入 promptFragments（system/context 段落）。
    - 提供 policies（StyleGatePolicy 等）。
    - `toolCaps` 作为「建议范围」（已有共识：不用于硬裁掉核心工具）。
  - 当前已内置的 workflow-ish skill：`style_imitate`（闭环 + WorkflowSkills Runtime）。

- **Workflow Skills Runtime 层**
  - 统一抽象：`docs/specs/workflow-skills-runtime-v0.1.md`。
  - 已落地：
    - `WorkflowSkillContract` / `WorkflowSkillPhaseSnapshot`；
    - `style_imitate` 的 snapshot / phase / missingSteps；
    - GatewayRuntime 在工具执行后跑 `analyzeStyleWorkflowBatch`，发现顺序错误 → `STYLE_WORKFLOW_VIOLATION`；
    - RunOutcome 对未完成闭环的 run 统一收口为 `workflow_skill_incomplete`；
    - Desktop 把 `workflowSkills` 写入 `TASK_STATE(JSON)`（支持续跑补课）。
  - v0.2 草案：`workflow-skills-runtime-v0.2-orchestrated-style-imitate.md`
    - 提出 Orchestrated Workflow：对上暴露 `style_imitate.run` / 子 Agent，对内用状态机管 `kb.search → draft → lint.copy → lint.style → applyEdits → final write`。
    - 当前代码已经有 `computeStyleTurnCaps` + `runOrchestratedStyleImitate()` 占位。

**痛点 & 风险**

- Skill 数量增长后：
  - 自动触发的 skill（尤其 workflow skill）有机会「抢占一轮的主语义」，间接影响工具选择。
  - 复杂 Skill（style_imitate、未来的 deep_research / corpus_ingest / writing_batch）如果依然依赖「语义自动拉起」，和 Tool/MCP 的路由会打架。
- 用户期望：
  - Tool / MCP 已经由 Intent/Route + ToolRetrieval 管控，**不要再让 Skill 这一层“再抢一次路由”**。
  - 以后 workflow 类 Skill 更偏向「显式」：要么 UI/用户点了，要么 body.activeSkillIds 指定，而不是「只要推断出写作意图就自动抢跑」。

---

### 1. 总体目标（我们要把系统推向哪里）

1. **三层职责清晰**
   - Tool/MCP：执行原语（读写 / lint / web / shell 等），只受 route + toolPolicy + ToolRetrieval 控制。
   - Skill：一组本地知识 + 提示词 +（可选）workflow 合同，**不直接删核心工具**，只做「pin / prefer / 提醒」。
   - Workflow Skills Runtime：负责「闭环纪律」和「Orchestrated Workflow」——什么时候算没跑完、下一步该补哪一环。
2. **workflow skill 显式化**
   - 轻量 skill（tone / 平台语气）可以继续语义触发；
   - 重量 workflow skill（style_imitate / future deep_research / corpus_ingest / writing_batch 等）：
     - 默认只在「显式条件」下启用（UI 勾选 / @skill / 明确写作闭环场景）。
     - 不再通过宽松 heuristic 抢占 route。
3. **基础工具永远可用**
   - 定义一组 CORE_TOOLS（run.mainDoc / run.todo / memory / time.now / 基础 reading 工具），任何阶段的 skill/toolCaps/orchestrator **都不能把它们挤掉**。
   - 未来 skill 只能在这组之上「收窄非核心执行工具」。

---

### 0.3 执行策略（vibe coding 偏好）

当前我们是「vibe coding」节奏：本地迭代成本很低、回归也快。因此：

- 只要不涉及「全栈重写 / 大规模架构迁移」，优先做**系统性、可长期复用的改造**，而不是短期止血；
- 下文原本的 Phase A + Phase B，在实际执行时视为**同一轮 Runtime 合同收口**，一口气做完；
- Orchestrated + 多 Skill 共存（原 Phase C）保留为下一轮有明确 DoD 的专项。

---

### 2. 分阶段改造计划（Phase 1 / Phase 2）

> Phase 1 = Runtime 合同 + Skill 激活收口 + SKILL.md 映射（当前一轮直接完成）；Phase 2 = Orchestrated Workflow & 多 Skill 共存。

#### Phase 1：Runtime 合同 & Skill 激活收口（当前一轮）

**目标**

- 明确「什么情况可以自动拉 workflow skill」，把危险的 implicit 触发收窄到可解释范围；
- 确认并技术上锁死一组 CORE_TOOLS，在任何 skill / orchestrator 生效时都不会被删。

**1.1 定义 CORE_TOOLS 并落地约束**

- 在 `packages/tools` 或 `core-tools-exposure-refactor-2026-03-13` 里落一个常量集合，例如：

  ```ts
  export const CORE_TOOLS = new Set([
    "run.mainDoc.get",
    "run.mainDoc.update",
    "run.setTodoList",
    "run.todo",
    "run.done",
    "time.now",
    "memory",
  ]);
  ```

- 在 Gateway 中使用此集合：
  - ToolRetrieval：`baseAllowedToolNames` 初始必含 CORE_TOOLS（只要在当前 mode 支持）。
  - Skill 层 / styleOrchestrator 层：构造 `allowedToolNames` 时，**显式把 CORE_TOOLS 并进去**。
  - 这样就不会再出现「某个 workflow skill 阶段把 memory / run.todo 挤掉」的问题。

> 现状：`computeStyleTurnCaps` 已经手动加上了 mainDoc / todo / time.now / memory，这里 Phase 1 的动作是：抽象出统一 CORE_TOOLS，并作为约束推广到未来所有 workflow skill。

**1.2 workflow skill 自动激活「收窄」策略**

- 在 `packages/agent-core/src/workflowSkills.ts` 的 `styleImitateWorkflowContract.match` 中：
  - 当前：`gateEnabled = gates.styleGateEnabled && intent.isWritingTask` 或 activeSkillIds 包含 `style_imitate`。
  - Phase 1 策略：
    - 保留 activeSkillIds 显式启用分支；
    - 对 gate 分支增加一层「明确写作任务」的收窄（`intent.isWritingTask` 已经做了第一层，但可以结合 `style-skill-gating-v1` 中的 regex/route 判定，排除 research-only 场景）。
  - 目标：**只有「明确写稿 / 仿写 / 润色」且存在 style 库时才自动 gate**，避免“查一下全网和 GitHub”这类请求被误判。

- 在 `packages/agent-core/src/skills.ts` 的 `STYLE_IMITATE_SKILL`：
  - 保持 `autoEnable=true` + triggers（mode_in + has_style_library + run_intent_in）不变；
  - 通过上面的 WorkflowSkills.match 收紧，保证「自动激活 skill ≠ 强制进入 workflow gate」。

**1.3 skill 不再影响工具「上限」，只负责 pin**

- 已有行为（需要在文档和代码里明确成合同）：
  - `toolCaps.allowTools`：在 `runFactory.prepareAgentRun` 中，只负责把工具「加入 baseAllowedToolNames」；
  - Skill **不负责删工具**，也不负责调高 toolPolicy（权限边界仍由 route/toolPolicy 控制）。
- Phase 1 行动：
  - 在 `docs/specs/skill-definition-standard-v0.1.md` 补一条「行为合同」：toolCaps 仅用于 pin / 兜底，不得用于裁剪 CORE_TOOLS。
  - 在 `dev-handbook` 和相关 spec 里同步这条约束。

**Phase 1 完成标准**

- 任意写作 run 中：
  - 即使 style_imitate 激活，CORE_TOOLS 始终在本轮 allowed 工具列表中。
  - 「纯研究/检索」类输入不会再触发 style workflow gate（但可以保留 style skill 的轻提示）。
- Skill 数量增加时，只要不改 WorkflowSkills.match / toolCaps，即保持上述性质。

#### Phase 1 扩展：Skill 合同化 & 显式化激活（与上同轮完成）

**目标**

- 把「哪些 skill 可以自动激活 / 哪些必须显式」变成**一等配置**；
- 让 SKILL.md 成为 skill 行为的真相源（对齐 OpenClaw / Claude Skills），而不是完全靠 TS 里硬编码。

**1.x Skill 类型划分与 Manifest 扩展**

- 在 `SkillManifest` 上增加轻量字段（保持向后兼容）：

  ```ts
  type SkillKind = "workflow" | "hint" | "service";
  type SkillActivationMode = "auto" | "explicit" | "hybrid";

  type SkillManifest = {
    // ...
    kind?: SkillKind;              // 默认为 "hint"
    activationMode?: SkillActivationMode; // 默认 "auto"
  };
  ```

- 对现有内置 skill 归类：
  - `style_imitate` → kind="workflow", activationMode="hybrid"（自动 + 显式都可，受 WorkflowSkills.match 进一步收紧）。
  - `web_topic_radar` / `writing_multi` / `writing_batch` / `corpus_ingest` 等：
    - 短期可以保留 activationMode="auto"，但在 B 阶段会逐个审视是否需要改为 "explicit"。

**1.x SKILL.md → Manifest 的映射**

- 对齐 OpenClaw / Claude Skills 范式：
  - 每个 skill 目录下有 `SKILL.md`，包含：
    - frontmatter：id / name / description / kind / activationMode / requiresTools / requiresMcpServers 等；
    - 正文：**正/反例提示词 + Workflow 合同**。
- Desktop 已有 `electron/skill-loader.mjs` 解析 skills 目录：
  - Phase B 的目标是：**Gateway 端 `SkillManifest` 也可以从 SKILL.md（或 Admin 配置）拼出来**，而不是只靠硬编码。
  - 初期只对 `style_imitate` + 少量关键 skill 做这件事，保持可控。

**1.x 激活策略显式化**

- 在 `activateSkills()` 中：
  - 轻量 `hint` skill：可以继续 `activationMode="auto"` + triggers（text_regex / run_intent）。
  - `workflow` skill：
    - 若 activationMode="explicit"：**仅在 body.activeSkillIds / UI 勾选 / @skill 时激活**；
    - 若 activationMode="hybrid"：
      - 自动激活仍需满足严格的 match 条件（Phase A 中已经收紧）；
      - 显式激活（mentionedSkillIds）永远有效，但不越权 toolPolicy。

**Phase 1 整体完成标准**

- Skill 行为主要由 SKILL.md + Manifest 控制，代码中只保留少量 glue 逻辑；
- 每个 workflow skill 至少具备：
  - 触发条件（When to use）；
  - Workflow 步骤 & Done 条件；
  - activationMode（auto / explicit / hybrid）；
- 新增 skill 时，默认不会自动抢占 route，除非在 frontmatter 里明确声明且通过 review。

---

#### Phase 2：Orchestrated Workflow & 多 Skill 共存（下一轮）

**目标**

- 把「闭环步骤顺序」真正收回到 Runtime / 子 Agent；
- 让多个 workflow skill 在同一线程内**可共存**，而不是互相抢主导权。

**2.1 完成 style_imitate 的 Orchestrated 实现**

- 按 `workflow-skills-runtime-v0.2-orchestrated-style-imitate.md`：
  - 在 Gateway 层实现 `runOrchestratedStyleImitate(args)`：
    - 对上暴露为一个高阶工具 `style_imitate.run` 或一个子 Agent；
    - 对内按状态机控制工具序列（kb.search → draft → lint.copy → lint.style → applyEdits → final write）。
  - WorkflowSkills Runtime 继续负责：
    - snapshot / phase / missingSteps；
    - 作为「兜底校验」而不是每轮都打断模型。

**2.2 Workflow skill 与其它 skill 的共存策略**

- 引入简单的「技能优先级 + 角色」约束（已有 priority 字段可以复用）：
  - workflow skill 只控制自己的子流程，不去修改其它 skill 的 toolCaps；
  - 其它 skill（如 web_topic_radar / writing_batch）通过 conflicts / requires 表达与 workflow skill 的关系（互斥或串联）。
- 示例：
  - `corpus_ingest` 激活时 suppress style_imitate（已经在 spec 里有类似设想）；
  - `deep_research` 完成后，用户明确要求写稿 → 再显式启用 `style_imitate`。

**2.3 MCP / Sub-Agent 一体化**

- 对齐 `mcp-fat-server-profile-and-codex-parity-v1`：
  - workflow skill 需要 MCP 工具（如 Lark MCP）时，在 SKILL.md frontmatter 声明 `requiresMcpServers`；
  - Gateway 负责在 prepare 阶段确保相应 MCP server 已连接，toolRetrieval 中优先这些 server 的工具。
- 对齐 `sub-agent-architecture-v0.1`：
  - workflow skill 内部可以通过子 Agent 编排（如 `style_copywriter`），但对外仍然是一个「高阶节点」。

**Phase 2 完成标准**

- style_imitate：
  - 对上层 Agent 暴露为一个高阶入口（工具或子 Agent），外层不再直接操作 lint.style / lint.copy；
  - 在多个 Provider（Claude/GPT/Gemini）下，工具轨迹表现为同样的阶段顺序，仅内容不同。
- 其它 workflow skill（至少 1–2 个）基于同一模板实现，能够与 style_imitate 共存或串联。

---

### 3. 与外部范式的对齐关系（OpenClaw / Claude / Lark MCP）

- **OpenClaw**
  - Skills = 本地目录 + SKILL.md（frontmatter + 正/反例 + 工作流说明）。
  - 运行时按 Manifest/前置信息加载 skill，**skill 本身不等价于工具**，而是「如何编排工具」。
  - 我们在 Phase B/C 中做的，是把现有 TS Manifest + SKILL.md 对齐到类似范式。

- **Claude Skills**
  - 强调「技能 = 对某一类任务的 SOP」，可调用工具 / MCP，但自身不过度控制工具列表；
  - 激活方式更偏显式（配置 / UI 选择），而不是大量模糊语义路由。
  - Phase B 中的 activationMode / 显式触发，是朝这个方向靠拢。

- **Lark OpenAPI MCP**
  - 本身只是 MCP Server（`npx @larksuiteoapi/lark-mcp mcp ...`），**属于 Tool 层**；
  - 通过 Desktop MCP manager 暴露工具，再进入 Gateway 的 ToolRetrieval。
  - Skill 层对它的使用，应当通过 SKILL.md 的「requiresMcpServers + Workflow 合同」来约束，而不是把 MCP server 视为 skill 本身。

---

### 4. 建议的落地顺序（给实施用）

1. **这一轮完成 Phase 1（Runtime 合同 + Skill 收口）**
   - 抽象 CORE_TOOLS，推广到所有 per-turn allowed 计算路径；
   - 收紧 `style_imitate` 的 WorkflowSkills.match，使其自动激活仅发生在「明确写作 + 有风格库」场景；
   - 在 skill definition/spec 文档中写死「toolCaps 只 pin 不删 CORE_TOOLS」；
   - 给 SkillManifest 增加 kind / activationMode 字段；
   - 从 `skills/style_imitate/SKILL.md` 开始，把合同信息落到 frontmatter，并在 Gateway 端消费。
2. **下一轮单独推进 Phase 2（Orchestrated + 多 Skill 共存）**
   - 先把 style_imitate 真正 Orchestrated 化；
   - 再挑一条新 workflow skill（比如 deep_research）用同一套 Runtime 模板做出来。

> 本文档只是阶段计划草案。每个 Phase 的具体实现细节，需要继续在对应 spec（workflow-skills-runtime / tool-retrieval / sub-agent-architecture）中落升级版 v0.x，并在实现前先跑一轮「proposal-first」评审。
