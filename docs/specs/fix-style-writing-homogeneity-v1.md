# 风格仿写首稿同质化——风格信号表示失真 + Agent 执行引导不足

状态：待实施 | 优先级：P0 | 日期：2026-03-17

## 0. 现象

用户 `/风格仿写闭环` 激活 `style_imitate`，选择风格库，请求写 1000 字口播稿。

Agent 行为：
1. kb.search 两次（一次话题、一次技巧），返回片段
2. write 一次性产出完整草稿
3. 草稿有表面标记（"宝贝"、"记好了"等口头禅），但缺少深层结构模仿

用户评价：
- "太死板了，好像定死了就那些"——输出模式固化
- "风格库其实太多维度了，它不会选"——维度选择失效
- "写出来同质性太多了"——多次写作产出趋同
- "如何在第一步就写得像，但不是抄"——核心诉求

产出文本分析：
- ✅ 有表面标记：口头禅、问号、破折号
- ❌ 缺少深层结构：节奏指纹（短长句交替）、叙事弧线、破题技巧、情感曲线
- ❌ 读起来像"AI 通稿 + 几个口头禅点缀"，不像特定作者的写法

---

## 1. 根因分析

### 系统级根因：风格信号在每一步被过度压缩（S 级）

链路中每一步都在丢失真实风格信息：

```
原始风格库（完整文章） → 规则卡提取（playbook job）
  → sanitizeRuleTextV1 删除 >=40 字自然句 ← 最有价值的句式范例被删
  → STYLE_FACETS_SELECTED 只剩骨架清单
  → kb.search 返回 160 字 snippet ← 信息不足以理解写法模式
  → Agent 只能模仿"表面标签"
```

模型第一步需要的不是更多 quote，而是：
- **做什么**：例如"先反常识下判断，再接生活场景，再抛二连问"
- **怎么说**：例如"短-短-长句节奏；第二人称；转折词密度高；结尾回扣价值判断"
- **不能怎么说**：例如"不要照抄原句；不要堆口头禅；不要只有表面问号和破折号"

但目前 Agent 拿到的是 `Facet Label + SoftRanges + 骨架清单 + 160 字 snippet`。

### 根因 1（S 级）：sanitizeRuleTextV1 过滤过严——最有价值的执行句被删除

文件：`apps/desktop/src/agent/gatewayAgent.ts:1585-1601`

```typescript
if (!/^[-*#\d]/.test(t) && t.length >= 40 && !/[:：=｜|]/.test(t)) continue;
```

- 任何 >=40 字且不以列表/标题标记开头的行都被删除
- 风格规则卡中最有价值的"句式范例"、"口语化表达范例"、"典型节奏短句"、"转折动作描述"往往就是 40-80 字的自然语句
- 同一个 sanitize 函数同时服务于 STYLE_CATALOG（需要保守）和 STYLE_FACETS_SELECTED（需要宽松），两个目标相反

### 根因 2（A 级）：skill prompt 未要求 Agent 将规则卡转化为执行动作

文件：`packages/agent-core/src/skills.ts:201-220`

现有 skill prompt 的问题：
1. 规则 #3 说"对每张入选 facet 结合 kbQueries 用 kb.search 拉样例/证据再落笔"——暗示 Agent 必须先检索才能写，但 STYLE_FACETS_SELECTED 已经注入了规则卡全文
2. 没有要求 Agent"首稿前先静默提炼每个 MUST facet 的执行要点"
3. 没有区分"规则卡（已在 context 中）"和"话题样例（需要检索）"的职责
4. 没有禁止"只模仿表层标记"
5. 没有引导使用 kb.cite 获取更完整证据

### 根因 3（A 级）：kb.search 只返回 160 字 snippet，Agent 无完整规则卡内容

文件：
- `apps/desktop/src/state/kbStore.ts:5861/5925`（snippet 截断）
- `apps/desktop/src/agent/toolRegistry.ts:1678`（注释"不返回全文 content"）

kb.search 返回给 Agent 的只有 160 字 snippet，不含全文。注释说"避免 token 爆炸；需要全文由 read / kb 引用机制后续完善"。

但关键在于：首稿的风格信息主要来自 buildContextPack 注入的 STYLE_FACETS_SELECTED，而不是运行时 kb.search。所以这个问题对首稿质量的影响低于根因 1 和 2。

### 根因 4（B 级）：kbQueries 生成过于泛化

文件：`apps/desktop/src/agent/gatewayAgent.ts:699-704`

```typescript
const base = q0 ? `${q0} ${x.label}`.trim() : x.label;
// base = "AI替代人类 声音节奏" → 太泛，无法精确命中风格库中的节奏模式
```

kbQueries 是 `{话题简述} + {维度中文标签}` 的简单拼接，在风格库中无法精确命中维度相关的具体样例。系统明明有结构化检索能力（facetIds/cardTypes），但 selector 没把它转成结构化 search plan。

### 根因 5（B 级）：cluster selector 偏向稳定簇，放大同质化

文件：`apps/desktop/src/agent/gatewayAgent.ts:746-775`

```typescript
// 1) anchors 优先（更像原文）
if (maxAnchors > 0) {
  // 直接按 anchors 数量 > stability > coverage > segmentCount 排序
  // topicFit 完全不参与
}
```

当有 anchors 时，topicFit 完全不参与 cluster 选择。系统长期黏在"主簇/默认簇"，不同话题下产出的写法趋同。

### 根因 6（B 级）：draft 阶段 essential facets 固定 7 个，维度选择多样性低

文件：`apps/desktop/src/agent/gatewayAgent.ts:554-558`

draft 阶段 essential = 7 个（logic_framework, narrative_structure, narrative_perspective, persuasion, voice_rhythm, emotion_mobilization, values_embedding），k=8。强制纳入 essential 后只剩 1 个名额给 topicFit 决定。导致"21 维很多，但每轮总是那几张"。

---

## 2. 影响范围

功能: style_imitate 闭环
影响: 首稿质量同质化——表面标记多但深层风格模仿不足
────────────────────────────────────────
功能: style_imitate_v2 闭环
影响: 同样受影响（共用 buildContextPack 和 skill prompt）
────────────────────────────────────────
功能: STYLE_FACETS_SELECTED 注入
影响: sanitize 过严导致最有价值的执行句被删除
────────────────────────────────────────
功能: cluster/facet 选择
影响: 同一用户多次写作产出趋同

---

## 3. 修复方案

### Fix 1（P0）：拆分 sanitize 函数——执行态保留写法动作句

文件：`apps/desktop/src/agent/gatewayAgent.ts`

原理：`sanitizeRuleTextV1` 拆为两个函数：
- `sanitizeRuleTextForCatalogV1`：保守，继续给 extractFacetOptionsV1 用（原有逻辑不变）
- `sanitizeRuleTextForExecutionV1`：宽松，给 STYLE_FACETS_SELECTED 用

`sanitizeRuleTextForExecutionV1` 核心规则：
- 保留：标题、bullet、编号行、含 `:` `=` `|` 的规则句
- 保留：20-110 字的自然句，如果满足其一：
  - 所在 section 标题含写法信号词（写法/句式/表达/节奏/口语/语气/开头/开场/结尾/收束/转折/互动/金句/提问/场景/结构/推进/钩子/声音/叙事/视角/逻辑/说服）
  - 或句子本身含写法动作信号（你/我们/其实/但是/反而/先…再/不是…而是/短句/长句/停顿/排比/递进/回扣等）
- 每张 facet card 最多保留 3 条自然句（控量，避免变成喂原文）
- 删除：引用块、"证据/原文/摘录"标记行、长引号整句、超长段
- 新增 `hintTitle` 参数：用 facet card 的 title 作为初始 section，解决无标题卡的 section 信号缺失

改动点：
1. L1585-1601：原 `sanitizeRuleTextV1` 重命名为 `sanitizeRuleTextForCatalogV1`
2. L1601 后新增 `sanitizeRuleTextForExecutionV1`
3. L1605：`extractFacetOptionsV1` 改用 `sanitizeRuleTextForCatalogV1`
4. L1768：STYLE_FACETS_SELECTED 改用 `sanitizeRuleTextForExecutionV1(content, title)`

### Fix 2（P0）：增强 skill prompt——规则卡角色定义 + 逐维落地 + 反表层模仿

文件：`packages/agent-core/src/skills.ts`

改动点（在 STYLE_IMITATE_SKILL.promptFragments.system 中）：

1. **规则 #2**：`mustApply.facetIds` 增强——"每个 facet 的核心写法都要在正文中至少体现一次"
2. **规则 #3**：明确"STYLE_FACETS_SELECTED 是执行规则卡全文，首稿前先静默提炼每个 MUST facet 的执行要点，不要向用户单独列清单"
3. **规则 #4 第一段**：明确"若 Context Pack 已给 STYLE_FACETS_SELECTED，则直接依规则卡开写；kb.search 主要用于补当前话题下的样例"
4. **规则 #5**：增加 kb.cite 引导——"若 kb.search 返回的 snippet 不足以判断具体表达方式，可用 kb.cite 拉局部证据"
5. **规则 #6 新增子规则**：反表层模仿——"不要只模仿表层标记（问号、破折号、短句、口头禅）；必须复刻段落推进、转折、视角、论证路径与声音节奏"

### Fix 3（P1）：kbQueries 结构化 + kb.search card 返回增强

文件：
- `apps/desktop/src/agent/gatewayAgent.ts`（kbQueries 生成）
- `apps/desktop/src/agent/toolRegistry.ts`（kb.search 返回格式）
- `apps/desktop/src/state/kbStore.ts`（snippet 长度）

改动：
1. kbQueries 从纯文本拼接改为结构化 searchPlan：`{ facetId, queries, facetIds:[fid], cardTypes, priority }`
2. kb.search 对 `kind=card` 返回 contentPreview（400-800 字），不限于 160 字 snippet
3. skill prompt 中增加对 searchPlan 的引导

### Fix 4（P2）：cluster 选择加入 topicFit + facet 多样性增强

文件：`apps/desktop/src/agent/gatewayAgent.ts`

改动：
1. `pickClusterSelectorV1` L746-775：anchors 优先逻辑改为加权评分，topicFit 始终参与
2. `stageFacetWeightsV1` draft 阶段：essential 从 7 个减少到 4 个核心结构维度，k 保持 8，让剩余 4 个名额由 topicFit 和 cluster facetPlan 决定
3. 可选：加入"近 N 次已使用 cluster 降权"，打破模式坍缩

---

## 4. 边界情况

### Fix 1 边界

- sanitizeRuleTextForExecutionV1 的自然句保留有上限（每 card 3 条），防止规则卡变成原文注入
- 无 section heading 的卡片：通过 hintTitle 参数（传入 facet card title）初始化 currentSection，确保 sectionSignalRe 能匹配
- 短于 20 字或长于 110 字的自然句不保留——太短无信息，太长像原文段落
- STYLE_CATALOG 的 extractFacetOptionsV1 不受影响（继续用 ForCatalog 保守版本）

### Fix 2 边界

- 新 prompt 不改变 Agent 的工具调用能力，只改变指引
- kb.cite 不在 STYLE_IMITATE_SKILL.toolCaps.allowTools 中——但它是通用工具，不需要 pin
- "逐维落地"是 prompt 要求而非硬 gate——不会阻断 write 调用

### Fix 3 边界（P1）

- contentPreview 加长后 token 消耗增加——需设上限（单次 kb.search 总 preview 字数 < 4000）
- 结构化 searchPlan 向后兼容——Agent 仍可自行构造 query

### Fix 4 边界（P2）

- essential 减少后可能遗漏关键结构维度——保留 narrative_structure + logic_framework 作为硬核必选
- topicFit 加权可能在话题文本不足时退化——此时回退到现有 stability 排序

---

## 5. 架构隐患

### S 级：sanitize 职责错位——同一函数不应服务两个相反目标

当前 `sanitizeRuleTextV1` 同时服务于"目录提取"（需保守）和"执行注入"（需宽松）。Fix 1 拆分后问题消除，但后续如果新增其他消费方，需要明确选择哪个 sanitizer。

### A 级：Agent 对 STYLE_FACETS_SELECTED 的利用率完全取决于 prompt

没有运行时机制验证 Agent 是否真正"逐维落地"了。Fix 2 通过 prompt 引导，但效果依赖模型能力。长期可考虑在 lint.style 中增加"维度覆盖率"评分维度。

### B 级：kb.search snippet 长度是全局硬编码

160 字 snippet 对所有 kind（card/paragraph/outline）一视同仁。card 类通常较短（500-1500 字），preview 可以更长；paragraph 类可能很长，需要保守。应按 kind 差异化。

---

## 6. 验证 checklist

### Fix 1 验证

- 修改前：STYLE_FACETS_SELECTED 中无自然句（只有标题+bullet+编号项）
- 修改后：STYLE_FACETS_SELECTED 中每张 facet card 保留 0-3 条写法动作句/节奏句
- 声音节奏维度的规则卡：含"短句+长句"类节奏描述句 → 修改后保留
- STYLE_CATALOG 的 extractFacetOptionsV1 产出与修改前一致（不受影响）
- 含明显原文引号的句子仍被删除

### Fix 2 验证

- Agent 首稿前不再输出"已选用写法X"等说明
- Agent 写作体现多维度写法（不只是口头禅）
- Agent 在 kb.search 不足时使用 kb.cite 补证据
- Agent 不输出逐条播报式状态

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

文件: `apps/desktop/src/agent/gatewayAgent.ts`
改动类型: Fix 1 + Fix 3 + Fix 4
改动范围: sanitize 函数拆分 + STYLE_FACETS_SELECTED 调用点 + kbQueries 结构化 + cluster 选择加权
────────────────────────────────────────
文件: `packages/agent-core/src/skills.ts`
改动类型: Fix 2
改动范围: STYLE_IMITATE_SKILL.promptFragments.system 规则增强
────────────────────────────────────────
文件: `apps/desktop/src/agent/toolRegistry.ts`
改动类型: Fix 3
改动范围: kb.search 返回 card contentPreview
────────────────────────────────────────
文件: `apps/desktop/src/state/kbStore.ts`
改动类型: Fix 3
改动范围: searchForAgent snippet 按 kind 差异化

---

以上是第四轮 bug 复盘的完整 spec。核心发现：风格仿写同质化不是检索次数不够的问题，而是**风格信号在表示层被过度压缩**——sanitize 删除了最有价值的写法动作句，prompt 没有要求 Agent 将规则卡转化为执行动作。Fix 1（拆分 sanitize）+ Fix 2（增强 prompt）是最小改动最大效果的组合。
