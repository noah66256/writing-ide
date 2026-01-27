## 风格闭环“越改越飘”范式复盘与修复方案 v1（research）

> 状态：v1（已落地到 Gateway：回炉携带 base draft + BEST_DRAFT 优先 + 风格库优先系统规则）  
> 目标读者：实现/维护 style_imitate 闭环的人  
> 关联：`apps/gateway/src/index.ts`（CopyLintPolicy / LintPolicy / bestDraft）、`doc.rules.md`（项目规则）、`docs/specs/style-imitate-v2-clean.md`

### 1. 问题现象（Symptoms）
- 同一篇稿子在 `lint.copy` / `lint.style` 多轮回炉后：越来越“中性/模板化/不像风格库”，甚至结构与节奏被洗掉。
- 用户观感：**越改越差**，越对齐越不对齐。

### 2. 根因（Root Causes）
#### 2.1 缺少“基准输入”（Base Draft Missing）导致的累积漂移
当前回炉机制会提示模型“回炉改写上一版候选稿”，但上一版全文往往只存在于上一次工具调用的 `arg text`（或临时生成的正文）里：
- 回炉时若上下文里只有 `tool_result.topOverlaps` / `rewritePrompt`，没有“上一版候选稿全文”，模型会被迫**凭记忆补全文本**，这会天然引入“重写/补写”，从而漂移累积。

#### 2.2 指标驱动的 Goodhart 风险（优化分数≠优化风格）
`lint.style` 给出 `similarityScore` 和 `rewritePrompt`。当模型把“过闸门/提分”当唯一目标，容易把风格特征做成“安全平均值”而不是“像原文的独特节奏”。

#### 2.3 `doc.rules.md` 与风格库潜在冲突
`doc.rules.md` 是项目级强注入（p0, trusted）。若它包含“更严肃/更克制”等规则，会与口播类风格库的表达方式冲突，导致闭环改写被拉向“规整化”。

### 3. 方案 v1（已落地）
#### 3.1 A：回炉强制携带 base draft（局部修订，不准凭记忆重写）
- 在 `lint.copy` 未通过触发回炉时：把 `call.args.text` 作为【上一版候选稿】附在 system message 中（截断控量）。
- 在 `lint.style` 未通过触发回炉时：把 `call.args.text` 作为【当前被 lint 的候选稿】附在 system message 中（截断控量）。
- 明确约束：**只做局部修改**（优先改 overlaps / issues 的 3–5 点），避免整篇推倒重写。

#### 3.2 B：回炉“防退化”（BEST_DRAFT 优先）
- 运行态持续维护 `bestDraft/bestStyleDraft`（多目标：styleScore + copyRisk）。
- 当本轮 `lint.style` 失败且分数显著低于历史最佳（Δ>=3）时：
  - 强提示“以 BEST_DRAFT 为底稿回炉”
  - system message 直接附上 `BEST_DRAFT`（截断控量）

#### 3.3 系统级规则：绑定风格库时“风格库优先”
在 Gateway 的 system prompt 中追加硬规则：
- 当 `KB_SELECTED_LIBRARIES` 中存在 `purpose=style`，最终口吻/节奏以风格库为第一优先；
- `DOC_RULES` 与风格库冲突时默认以风格库为准（除非用户明确要求遵守 `DOC_RULES`）。

### 4. 验收（How to Verify）
- **用同一篇稿子连续回炉 3 次**：
  - 不应出现“凭空补写/结构大改/语气变中性”的明显漂移
  - 若发生，应能在日志里看到每轮回炉都携带了【上一版候选稿】/【BEST_DRAFT】用于约束
- **故意制造退化**（把稿子改得很不像）：
  - `lint.style` 失败回炉应提示“Δ>=3 以 BEST_DRAFT 为底稿”

### 5. 回滚（Rollback）
- 该变更只影响 Gateway 侧回炉 system message 与 system prompt 文案：
  - 可通过 git revert 单次提交回滚
  - 不涉及数据迁移与持久化格式变更


