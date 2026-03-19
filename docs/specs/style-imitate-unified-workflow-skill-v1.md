# Style Imitate Unified Workflow Skill v1

状态：已实施 | 优先级：P0 | 日期：2026-03-19

Supersedes：
- `docs/specs/feat-style-imitate-v3-skill-v1.md`
- `docs/specs/workflow-skills-runtime-v0.2-orchestrated-style-imitate.md`
- `docs/specs/fix-v3-pipeline-cross-run-breakage-v1.md`

保留参考但不再作为并行真相：
- `docs/specs/style-imitate-v2-clean.md`
- `docs/specs/workflow-skills-runtime-v0.1.md`
- `docs/specs/skill-contract-openclaw-parity-v0.1.md`

---

## 0. 目标

把 `style_imitate` 收敛为唯一的内置 Workflow Skill 真相：

1. **保留老 V3 的全流程强约束**：选库/等用户/风格检索/定调骨架/写作/lint.copy/lint.style/终稿落盘，一个都不能丢。
2. **放弃旧双轨语义**：不再保留 `style_imitate_v3`、`kind: pipeline`、`PipelineExecutor` 作为并行实现真相。
3. **统一到当前新格式**：以 `SKILL.md + workflow runtime + thread waiting state + run audit` 为唯一执行合同。
4. **严格 fail-close**：Skill 一旦激活，就不能 `kb.search` 一下直接纯文本交付，更不能跳过两个 lint。

一句话：**流程保留老 V3，载体统一到新的 Workflow Skill。**

---

## 1. 单一真相

从本文生效起，风格仿写只有一个官方定义：

- Skill id：`style_imitate`
- Skill kind：`workflow`
- 声明载体：`apps/desktop/electron/bundled-skills/style_imitate/SKILL.md`
- 执行范式：`agent self-driven + runtime orchestrated gates`

明确废弃：

- `style_imitate_v3` 作为独立 skill id
- `kind: pipeline`
- “V3 管线”和“当前 workflow skill”并存的解释方式
- “老 pipeline 只是兜底、当前 skill 只是提示”的双轨说法

后续无论实现细节怎么演进，都必须满足：

1. `SKILL.md` 描述的阶段合同是行为真相。
2. Runtime 负责激活、白名单、等待用户、续跑、审计、Done 门禁。
3. Provider 只负责每个阶段内的内容生成，不再有权跳过合同步骤。

---

## 2. 激活条件与非激活条件

### 2.1 激活条件

`style_imitate` 仅当同时满足以下条件时激活：

1. 当前任务属于 `writing | rewrite | polish`。
2. 用户显式发起风格仿写意图，或会话中已绑定 `purpose=style` 的风格库。
3. 当前运行模式允许写作工具（不是纯只读讨论）。

### 2.2 不激活条件

以下场景不得误激活：

1. 只是在讨论风格、产品、规则，没有要求产出稿件。
2. 没有风格库，也没有用户要求进入风格仿写流程。
3. 当前任务本质是 research / ops / 调试，而不是内容写作。

### 2.3 激活后的强约束

一旦激活，系统必须满足：

1. `workflowSkills` 中存在 `style_imitate` 快照。
2. `meta.skillStatus.style_imitate` 不能为 `null`。
3. `runtimeExecutionSummary.styleWorkflow` 不能缺失。
4. 本轮如果未完成 workflow，Run 不能静默 `completed`。

---

## 3. 线程状态与等待用户合同

### 3.1 等待用户是线程状态，不是提示词猜测

风格仿写流程里，“等用户”是正式阶段，不是模型随口问一句。

等待用户的事实源必须落在线程状态中，至少覆盖：

- `waitingFor.styleLibrary`
- `waitingFor.topic`
- `waitingFor.lengthOrFormat`（仅当用户需求缺关键写作约束时）

### 3.2 必须暂停的场景

以下场景必须发问后立即结束本轮，等待用户回复：

1. 有多个 style 库且用户未明确选库。
2. 用户只说“@风格仿写”或等价意图，但没有给主题。
3. 用户要求的是“仿写”，但字数/体裁缺失到无法写稿。

执行规则：

1. 只问当前最小必要问题。
2. 问完立即 `run.done`。
3. 不允许在同一轮里连续问两遍、自己替用户回答、又继续检索或写稿。

### 3.3 续跑规则

用户回答后，下一轮必须从等待点恢复，而不是重头乱跑：

1. `waitingFor.styleLibrary` 清除后，进入库确认后的下一阶段。
2. `waitingFor.topic` 清除后，直接进入风格检索阶段。
3. 新线程默认不继承旧线程的 style 选择、mainDoc、waiting 状态。

---

## 4. 标准阶段合同

`style_imitate` 统一为 7 个正式阶段；其中 Phase 0A/0B 是老 V3 里一直有、但之前经常被当前 skill 漏掉的部分。

### Phase 0A：选库

目标：确定唯一风格库。

允许工具：

- `kb.listLibraries`

规则：

1. 若只有一个 style 库，可自动选中。
2. 若多个 style 库，优先读用户消息中的库名信号。
3. 若仍不唯一，必须问用户，不得默认取第一个库。
4. 未选定库前，不得执行 `kb.search`。

Done：

- `selectedStyleLibraryId` 已确定。

### Phase 0B：补齐题面

目标：确认主题与最低写作约束。

允许动作：

- 读取用户消息
- 必要时发问并 `run.done`

规则：

1. 主题缺失时，不能先搜规则卡再等用户。
2. 仅在用户题面足够写稿时进入下一阶段。

Done：

- `topicConfirmed = true`

### Phase 1：风格检索

目标：拿到可写作的风格规则卡与样例包。

允许工具：

- `kb.search`

检索合同：

1. 默认只查已选中的 style 库。
2. 第一优先级检索 `kind=card` 或等价规则卡，不得一上来大面积捞 `paragraph`。
3. 查询词必须由三部分组成：
   - 风格标识：库名/作者名/风格名
   - 结构词：`开头钩子 / 结构骨架 / 结尾收束 / 论证路径 / 口吻`
   - 当前题面：主题/体裁/篇幅
4. 若已存在 `STYLE_SELECTOR / STYLE_DIMENSIONS`，必须优先对齐其中的 facet / searchPlan。
5. 不得只搜 `outline` 或只搜一个高频口头禅。

最小命中要求：

1. 至少有 3 张有效规则卡或等价样例。
2. 至少覆盖以下 3 类中的 2 类：
   - hook / 开头
   - outline / 结构
   - ending / 收束
3. 最终要形成 `styleEvidencePack`，而不是只保留一段自然语言总结。

Done：

- `hasStyleKbSearch = true`
- `styleEvidencePack` 已落入本轮状态

### Phase 2：定调与骨架

目标：把老 V3 的 `tone card + structure outline` 作为显式中间产物保留下来。

允许动作：

- 模型内部规划
- 结构化中间产物写入 workflow state

必须产出的两个 artifact：

1. `toneCard`
   - 立场/人设
   - 语气与节奏
   - 论证偏好
   - 禁忌表达
2. `structureOutline`
   - 开头策略
   - 段落推进
   - 收束方式
   - 必须覆盖的核心观点

规则：

1. 这两个 artifact 不必暴露给用户，但必须存在于 runtime state / audit 中。
2. 没有 `toneCard + structureOutline`，不得直接进入写稿。
3. 这里保留老 V3 的“先定调再下笔”，只是实现上不再另起一个 pipeline skill。

Done：

- `hasToneCard = true`
- `hasStructureOutline = true`

### Phase 3：写草稿

目标：产出完整候选稿。

允许工具：

- `write`
- `edit`

规则：

1. 文件名必须体现主题和体裁，不得写成系统时间戳路径。
2. 草稿必须基于 `toneCard + structureOutline + styleEvidencePack`。
3. 不得只模仿表层口头禅，必须复刻结构推进、分析镜头、价值落点。
4. 草稿写完后，状态中必须能回溯“用了哪些规则卡/结构模板”。

Done：

- `hasDraftText = true`
- `draftPath` 已确定

### Phase 4：lint.copy

目标：先过“不要贴原文”的门。

允许工具：

- `lint.copy`
- `edit`
- `write`

规则：

1. `lint.copy` 必跑。
2. 未通过时，必须按 `issues + rewritePrompt` 改稿后复检。
3. 最多 3 次。
4. 即使最终降级，也必须留下每次结果与最佳结果。
5. 不得跳过 `lint.copy` 直接去跑 `lint.style`。

Done：

- `copyLintAttempts >= 1`
- `copyLintPassed = true`，或 `copyLintDegraded = true` 且有完整审计

### Phase 5：lint.style

目标：校验“像不像这个风格”，而不是只看主题是否通顺。

允许工具：

- `lint.style`
- `edit`
- `write`

规则：

1. `lint.style` 必跑。
2. 未通过时，必须按维度问题改稿后复检。
3. 最多 3 次，并记录最佳分数与对应版本。
4. `lint.style` 的评价重点是结构、节奏、口吻、价值取向、分析镜头，不是抓单个词。
5. 只有在重试用尽后，才允许 `lintGateDegraded = true`。

Done：

- `styleLintAttempts >= 1`
- `styleLintPassed = true`，或 `lintGateDegraded = true` 且有完整审计

### Phase 6：终稿落盘

目标：以 best draft 交付终稿。

允许工具：

- `write`
- `edit`
- `run.mainDoc.update`

规则：

1. 最终写入必须来自 `bestDraft`，不能把更差的最后一版写进去。
2. `bestDraft` 选择优先级：
   - 先剔除高 copy 风险版本
   - 再取最高 style 分版本
   - 分数接近时，优先结构更稳、口头禅依赖更低者
3. 若发生降级，必须把降级原因写入审计，不得静默掩盖。

Done：

- `finalWritten = true`
- `mainDoc` / 终稿路径已更新

---

## 5. Runtime 硬门禁

Runtime 必须对 `style_imitate` 执行强门禁，不能只靠提示词。

### 5.1 阶段白名单

每一阶段只能看到该阶段工具，不得“多给一点让模型自己选”。

最低要求：

- `need_style_library`：只给 `kb.listLibraries`
- `need_style_kb`：只给 `kb.search`
- `need_draft`：只给 `write/edit`
- `need_copy_lint`：只给 `lint.copy/edit/write`
- `need_style_lint`：只给 `lint.style/edit/write`
- `completed`：才允许最终 `write/edit/run.mainDoc.update`

### 5.2 完成门禁

以下任一情况，Run 都不得标记为 `completed`：

1. `workflowSkills` 里没有 `style_imitate` 快照。
2. 只做了 `kb.search`，没有 `write`。
3. 有草稿，但没跑 `lint.copy`。
4. 跑了 `lint.copy`，没跑 `lint.style`。
5. 没有 `finalWritten`。

### 5.3 违约码

最少保留以下违约信号：

- `STYLE_LIBRARY_REQUIRED`
- `STYLE_TOPIC_REQUIRED`
- `STYLE_WORKFLOW_VIOLATION`
- `STYLE_WORKFLOW_INCOMPLETE`

其中：

1. `STYLE_LIBRARY_REQUIRED` / `STYLE_TOPIC_REQUIRED` 用于“应该等用户却没等”。
2. `STYLE_WORKFLOW_VIOLATION` 用于顺序错误。
3. `STYLE_WORKFLOW_INCOMPLETE` 用于本轮结束时闭环未完成。

---

## 6. 风格提取合同：禁止把单个口头禅当风格本体

这部分是本次必须正式写进合同的约束，避免反复出现“只看到一次宝贝，后面每篇都写宝贝”。

### 6.1 风格来源优先级

风格信号按以下优先级理解：

1. 结构骨架
2. 论证路径
3. 价值判断
4. 分析镜头
5. 语气节奏
6. 高频稳定词法
7. 单次偶发口头禅

### 6.2 口头禅规则

1. 单次高显著 token 不得自动升级为 must-have 口癖。
2. 只有在跨多条样例稳定出现、且被规则卡明确支撑时，才允许进入 `toneCard.lexicon`.
3. 对口头禅的使用上限要受控，不能每段都塞。
4. `lint.style` 的 issue 里应优先指出“结构不像/推进不像/价值落点不像”，而不是只鼓励多加口头禅。

### 6.3 KB 搜索结果的使用规则

`kb.search` 返回后，系统必须保留：

1. 命中的卡片标题
2. 卡片类型
3. 命中证据摘要
4. 被采用/未采用原因

不能只把结果压成一句“已命中 9 条规则卡”，然后让模型自由脑补。

---

## 7. 审计与可观测性

每次 `style_imitate` run 至少要能在日志或 execution report 中看到：

1. 是否激活 `style_imitate`
2. 当前 phase
3. `selectedStyleLibraryId`
4. `topicConfirmed`
5. `hasStyleKbSearch / hasToneCard / hasStructureOutline / hasDraftText`
6. `copyLintAttempts / copyLintPassed / bestCopyScore`
7. `styleLintAttempts / styleLintPassed / bestStyleScore / lintGateDegraded`
8. `bestDraftPath / finalDraftPath`
9. `waitingFor.*`

额外要求：

1. `run.start` 就要标出本次是否进入 style workflow，不能等 `run.end` 才知道。
2. 任何“因为缺库/缺题面而没启动 workflow”的情况，必须有显式 reason code，不能静默 `return {}`。

---

## 8. 对当前实现的直接改造含义

本文对应的实现收敛方向如下：

1. 保留当前 `style_imitate` 这个 skill id，删除旧 `style_imitate_v3` 分叉语义。
2. 保留老 V3 的有效中间产物：
   - `styleEvidencePack`
   - `toneCard`
   - `structureOutline`
   - `bestDraft`
3. 把这些中间产物改为 workflow state / audit 产物，而不是另起一个 PipelineExecutor。
4. `SKILL.md` 必须显式写出：
   - 等用户规则
   - Phase 0A/0B
   - `lint.copy` / `lint.style` 必跑
   - `run.done` 的暂停语义
5. Runtime 必须接住：
   - sticky skill 续跑
   - waiting 状态续跑
   - selected style library 续跑
   - workflow incomplete fail-close

---

## 9. 删除与迁移计划

### 9.1 立即删除

以下文档在本文落地后删除，避免继续双轨：

- `docs/specs/feat-style-imitate-v3-skill-v1.md`
- `docs/specs/workflow-skills-runtime-v0.2-orchestrated-style-imitate.md`
- `docs/specs/fix-v3-pipeline-cross-run-breakage-v1.md`

### 9.2 保留但降级为参考

以下文档不再单独指挥实现，只保留背景价值：

- `docs/specs/style-imitate-v2-clean.md`
- `docs/specs/workflow-skills-runtime-v0.1.md`
- `docs/specs/skill-contract-openclaw-parity-v0.1.md`

### 9.3 实施完成的定义

只有同时满足以下条件，才算本文真正落地：

1. 新 `SKILL.md` 与 runtime 行为和本文一致。
2. 线上 run 中能看到完整 workflow 快照。
3. 没有再出现“`workflowSkills=[]` 但风格仿写已经输出正文”的 run。
4. 没有再出现“未选库却默认李叔”之类的隐式库漂移。
5. 没有再出现“只搜到一次口头禅，就全篇机械复用”的风格误学。

---

## 10. DoD

冒烟通过必须至少满足：

1. `@风格仿写` 且无主题时，只提一个问题并暂停；不会继续检索或写稿。
2. 多风格库场景下，不会默认选第一个；会等待用户确认。
3. 选库+给题后，工具轨迹严格为：
   - `kb.listLibraries`（如需要）
   - `kb.search`
   - `write`
   - `lint.copy`
   - `lint.style`
   - `write/run.mainDoc.update`
4. 中途任何一轮中断后，下一轮会从等待点或缺失 phase 继续。
5. 交付稿件前，`lint.copy` 和 `lint.style` 都至少实际调用过 1 次。
6. execution report 中能看到 `toneCard` / `structureOutline` / `bestDraft` 的摘要或引用。

---

## 11. 实施标注（2026-03-19）

- `[x]` SKILL 合同已扩成 0A 选库 / 0B 题面确认 / 检索 / 定调骨架 / 草稿 / lint.copy / lint.style / 终稿落盘
- `[x]` Desktop 已增加本地 preflight：多库先问库名、缺主题先问主题，并把线程置为 `waiting_user`
- `[x]` Runtime 已补齐状态键：`hasSelectedStyleLibrary`、`topicConfirmed`、`hasStylePlan`、`copyLintSatisfied`、`styleLintSatisfied`、`finalWritten`
- `[x]` execution report / audit 已补 style workflow 摘要与 `skillStatus.style_imitate`
- `[x]` `bestDraft` 已参与终稿门禁：lint 满足后只有写入 best draft 才会置 `finalWritten=true`
- `[x]` 冒烟脚本已覆盖新增阶段：`need_style_library / need_topic / need_tone_outline / need_final_write`
