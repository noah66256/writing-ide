## Skill: style_imitate（风格仿写闭环）

> 版本：v0.1（对齐 `style-imitate-v2-clean.md` / `workflow-skills-runtime-v0.1.md`）

### 1. Skill 角色与适用场景

**ID**：`style_imitate`

**作用**：
- 在绑定了风格库（purpose=style）的前提下，负责整条“仿写/改写/润色”闭环：
  - 先从风格库里抓结构/节奏/价值观维度；
  - 再写出候选草稿；
  - 通过 copy 与 style 两轮 lint，避免复述风险、校正风格；
  - 最后再把终稿真正落盘。

**何时必须启用**：满足以下任意条件，即视为本轮需要执行 `style_imitate` 工作流：

- Context Pack 中 `KB_SELECTED_LIBRARIES(JSON)` 至少包含 1 个 `purpose="style"` 的库；
- 且本轮 RunIntent 属于写作类：`writing` / `rewrite` / `polish` / 明确口播稿、文案、长文任务；
- 或 Desktop/用户在 `ACTIVE_SKILLS(JSON)` 中显式激活了 `style_imitate`。

**何时不启用（需 suppress）**：

- 只读/分析类路由（如 web_radar / analysis_readonly / project_search 等），不做写作闭环；
- 用户明确说“只想聊聊/只要讨论/不要落盘/不写稿”，则本轮不强制执行 `style_imitate`。

### 2. Workflow：必经步骤

当 `style_imitate` 被激活时，必须按以下顺序完成闭环（不可跳过关键步骤）：

1. **风格样例检索：`kb.search`**  
   - 目标：从风格库中找到足够代表性的“写法样例/规则卡片”，用来抽取结构、节奏、价值观维度。  
   - 工具约束：
     - 只对 `purpose=style` 的库进行样例检索；
     - 优先使用结构化卡片（规则卡/写法卡），避免直接注入长原文段落；
   - RunState 标记：`hasStyleKbSearch = true`。

2. **写出候选草稿：`write`（draft）**
   - 目标：根据用户目标与风格样例，生成一版**候选草稿**，仅用于后续 lint/改写，不直接视为终稿。  
   - 约束：
     - 草稿应写入临时/草稿路径（例如 `output/draft-*.md`），避免覆盖最终交付文件；
     - 不允许在没有草稿的情况下直接写“终稿+交付文案”。  
   - RunState 标记：`hasDraftText = true`（通常由 runtime 检测最近一轮 `write` 内容长度与写作意图推导）。

3. **复述风险检查：`lint.copy`**  
   - 目标：检查候选草稿是否有明显“直接复述样例”的风险（大段连续重合、长句式照搬等）。  
   - 约束：
     - 输入：草稿文本 + 风格样例/片段摘要；
     - 输出：
       - `issues`：复述/过度相似的具体位置与类型；
       - `rewritePrompt`：建议的改写方向（更换类比、打散结构、重写结论等）。  
   - RunState 标记：
     - 若通过：`copyLintPassed = true`；
     - 若未通过：`copyLintPassed = false`，需要根据 `rewritePrompt` 改稿后可重试（最多 `lintMaxRework` 次）。

4. **风格校验：`lint.style`**  
   - 目标：校验候选草稿是否真的“长得像”目标风格，而不是只在内容层面复述或偏离。  
   - 约束：
     - 输入：草稿文本 + 风格维度（例如逻辑架构、叙事结构、语气节奏、金句/反问密度等）；
     - 输出：
       - `score`：整体风格匹配度（0–100）；
       - `issues`：在哪些维度上偏离风格（过于平铺直叙、缺少算账链条、缺少反常识开头等）；
       - `rewritePrompt`：按风格维度给出的改写建议。  
   - RunState 标记：
     - 如果 `score >= STYLE_LINT_PASS_SCORE`（当前实现为 70），视为通过：`styleLintPassed = true`；
     - 否则：`styleLintPassed = false`，需要根据 `rewritePrompt` 进行一次或多次改写后重试。

5. **根据 lint 建议改稿：`edit`（可多次）**
   - 目标：根据 `lint.copy` 与 `lint.style` 给出的 `issues + rewritePrompt`，对草稿进行结构化改写。  
   - 约束：
     - 尽量通过结构化 edits（如按段落/句子 patch）而非整篇重写，便于 diff 与用户审阅；
     - 每次改稿后可以再次跑 `lint.copy` / `lint.style`，直到通过或达到 `lintMaxRework` 上限。  
   - RunState：不会单独设置布尔标记，但会影响下一轮草稿内容与 lint 结果。

6. **终稿落盘：`write`（final）**
   - 目标：在 `copyLintPassed && styleLintPassed` 条件满足后，将最终稿写入明确的交付路径。  
   - 约束：
     - 终稿写入路径应与草稿区分（例如 `output/xxx_口播稿.md`）；
     - 终稿写入前，必须至少完成一次 `lint.copy` 与一次 `lint.style`，且都通过门槛；
     - 不允许绕过 lint 直接写终稿。  
   - RunState Done 条件：
     - `hasStyleKbSearch = true`；
     - `hasDraftText = true`；
     - `copyLintPassed = true`；
     - `styleLintPassed = true`。

### 3. 与 WorkflowSkills Runtime 的对齐

WorkflowSkills Runtime v0.1 中，对 `style_imitate` 的阶段映射如下：

- `need_style_kb`：尚未执行风格样例检索（未满足 `hasStyleKbSearch`）。
- `need_draft`：已有样例，但尚未写出草稿（未满足 `hasDraftText`）。
- `need_copy_lint`：已有草稿，但 copy lint 未通过（`copyLintPassed=false`）。
- `need_style_lint`：copy lint 通过，但 style lint 未通过（`styleLintPassed=false`）。
- `completed`：以上条件全部满足，视为闭环完成。

当 Runtime 检测到当前阶段与即将调用的工具不匹配时，会返回 `STYLE_WORKFLOW_VIOLATION`，并提示模型按

> kb.search → 草稿 draft（write）→ lint.copy → lint.style → edit → write 终稿

的顺序补齐步骤。

### 4. Prompt 侧使用约定（v0.1）

> 说明：当前版本下，`style_imitate` 的合同主要通过系统 prompt 段落与 WorkflowSkills Gate 共同约束，后续版本计划改为由 Runtime 自动编排内部工具顺序（Orchestrated Workflow，见 `workflow-skills-runtime-v0.1.md` Phase 4 展望）。

当 `ACTIVE_SKILLS(JSON)` 中包含 `style_imitate`，且 `TASK_STATE(JSON).workflowSkills["style_imitate.v1"]` 显示状态为 `in_progress` / `degraded` 时：

1. 模型必须先阅读本 SKILL 合同中的 Workflow 段，理解当前阶段缺少哪些步骤；
2. 优先按 `missingSteps` 指示顺序调用对应工具（`kb.search` / `write` / `lint.copy` / `lint.style` / `edit`）；
3. 在闭环完成前，不要直接输出“终稿完成”的口播稿/文案；
4. 只有当 `copyLintPassed && styleLintPassed` 成立时，才允许写入终稿文件并在回答中给出交付路径。

