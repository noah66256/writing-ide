# 仿写（style_imitate）工业化 v0.1：目录先挑 + 分阶段执行 + 只给规则不给原文

> 目标：把仿写从“临场发挥”改成“可控流程”：先给 **目录/选项** 让模型选，再按选项注入 **规则卡**，最后通过 lint 门禁与 IDE 的 patch 机制落地修改。

## 背景与问题
- **问题1：贴风格库原文**：当 `KB_LIBRARY_PLAYBOOK(Markdown)`/长段 quote 直接注入上下文时，模型很容易把它当素材池拼进正文。
- **问题2：21 维度难以同时执行**：全量注入导致噪音高、选择不可控、流程不可复盘。
- **问题3：检索慢且不稳定**：过度依赖 `kb.search` 多轮，成本/延迟上升且命中质量波动大。

## 适用范围（严格）
- **仅在满足以下条件时启用本规范**
  - activeSkillIds 包含 `style_imitate`
  - runIntent ∈ { writing, rewrite, polish }（写作类）
  - KB_SELECTED_LIBRARIES 存在 purpose=style 的库
- 其它非仿写任务不强制本流程。

## 核心策略（v0.1）
### A) 只给规则不给原文（Anti-Regurgitation by Design）
- 默认不注入 `KB_LIBRARY_PLAYBOOK(Markdown)` 的全文。
- 改为注入 **STYLE_CATALOG(JSON)**：
  - 21 维度目录（facetId/label）
  - 每维度 3–5 个“子套路选项”（结构化：signals/do/dont），**不含原文句子**
  - 指纹仅给 softRanges/统计目标，不给 evidence quote

### B) 目录先挑（Selection First）
模型在正式写作前必须先做一次选择：
- 输出并写入 `mainDoc.stylePlanV1`（通过 `run.mainDoc.update`）：
  - MUST/SHOULD/MAY 三档
  - TopK：**MUST=6, SHOULD=6, MAY=4**
  - 每个维度选择 1 个 option（来自目录中的 optionId）

### C) 分阶段执行（Stage Contract）
对 `style_imitate` 固定阶段顺序（可在未来版本配置化）：
1. **S0 立场/价值观（thesis-first）**
2. **S1 结构（outline-first）**
3. **S2 开头/结尾（hook/ending after outline）**
4. **S3 起草正文（draft）**
5. **S4 防贴原文（lint.copy gate，若启用）**
6. **S5 风格对齐（lint.style gate/safe）**
7. **S6 长度门禁（LengthGate）**
8. **S7 写入/应用 edits（proposal-first）**

## 数据结构（草案）
### 1) STYLE_CATALOG(JSON)
```json
{
  "v": 1,
  "libraryId": "kb_lib_xxx",
  "facetPackId": "speech_marketing_v1",
  "topK": { "must": 6, "should": 6, "may": 4 },
  "facets": [
    {
      "facetId": "values_embedding",
      "label": "价值观植入",
      "options": [
        {
          "optionId": "values_embedding:o1",
          "label": "否定表象→定义本质",
          "signals": ["需要“判词/立场”开篇", "需要给读者一个评价框架"],
          "do": ["先给结论句", "用一段类比把框架钉住"],
          "dont": ["不要引用原文句子", "不要堆抽象形容词"]
        }
      ]
    }
  ],
  "softRanges": { "avgSentenceLen": [22, 34] }
}
```

### 2) mainDoc.stylePlanV1（由模型写入）
```json
{
  "v": 1,
  "libraryId": "kb_lib_xxx",
  "facetPackId": "speech_marketing_v1",
  "topK": { "must": 6, "should": 6, "may": 4 },
  "selected": {
    "must": [{ "facetId": "values_embedding", "optionId": "values_embedding:o1" }],
    "should": [],
    "may": []
  },
  "stages": {
    "s0": { "done": false },
    "s1": { "done": false }
  },
  "updatedAt": "2026-01-30T00:00:00.000Z"
}
```

## 执行门禁（Gateway）
新增 phase（仅 style_imitate）：
- `style_need_catalog_pick`
  - **允许工具**：`run.mainDoc.update` / `run.mainDoc.get` / `run.todo.*` / `run.setTodoList`
  - **禁止工具**：`kb.search` / `lint.*` / `doc.*`
  - **AutoRetry（2A）**：若未写入 `mainDoc.stylePlanV1` 则自动重试（最多 2 次），并通过 `run.notice` 提示“正在自动重试：需要先完成目录选择”。

## 规则卡注入（Desktop Context Pack）
- 目录选择完成后，再注入：
  - `STYLE_DIMENSIONS(JSON)`（MUST/SHOULD/MAY）
  - `STYLE_FACETS_SELECTED(Markdown)`：只注入 **被选中的维度卡正文**，并对正文做脱敏（去掉长 quote/证据段）。
- 不再默认注入整本 `KB_LIBRARY_PLAYBOOK(Markdown)`。

## 与 lint 的关系
- `lint.style` 负责：
  - 风格偏差问题清单
  - 维度覆盖报告：missing/covered/expected（对 MUST 做硬门禁）
  - patch 模式：输出 edits（由 Desktop 生成 diff + Keep/Undo）
- `lint.copy` 负责：
  - 防贴原文（可配置 gate/observe；v0.1 建议保持 safe/gate 可选）

## 用户体感（2A 自动重试）
- 运行中不刷屏系统气泡；通过 ActivityBar 显示：`系统：正在选择维度目录（自动重试 1/2）…`
- 如仍失败，Run 结束并提示“需要人工介入/换模型/继续”。

## 验收标准（Checklist）
- [ ] 仿写任务开始时，模型先写入 `mainDoc.stylePlanV1`（目录先挑）
- [ ] 不再注入风格库原文/长 quote（只给规则）
- [ ] 阶段顺序稳定：S0→S1→S2→S3→S5→S7（门禁能阻止乱序）
- [ ] `lint.style` 能给 coverage 报告；MUST 缺失触发回炉
- [ ] Desktop patch/Keep/Undo 能把 lint.style 的 edits 应用到草稿/文件

## 回滚方案
- 开关：仅对 `style_imitate` 生效；可在 Gateway 侧通过 feature flag 关闭 `style_need_catalog_pick` 并恢复旧流程（仍需保留安全的“只给规则”策略）。


