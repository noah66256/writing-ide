## 仿写（style_imitate）长期方案：更像原文，但更不贴原文（spec v0.1）

> 状态：draft（2026-01-23）  
> 范围：仅讨论“风格仿写/改写/润色”链路（`style_imitate` skill）在未来 1–3 个月的演进方案、落地点、风险与回滚。  
> 入口复盘（为什么要做）：`docs/research/style-imitate-paradigm-review-v1.md`

---

### 0. 北极星与不变量（必须同时满足）

#### 0.1 北极星
- **更像原文**：像某个风格库的“选定写法”（cluster/anchors/selected facets）。
- **更不贴原文**：避免“逐句改写/近似复述/长片段复用”（无论来源是用户原文还是风格库样例）。
- **更可控**：可解释、可审计、可回炉、可降级（不卡死）。

#### 0.2 不变量（不允许被方案破坏）
- 仍遵守“写作 IDE”定位（见 `plan.md` / `.cursorrules`）。
- `style_imitate` 只在 **写作类意图** 且存在 **purpose=style** 库时启用（现状已具备）。
- 写入仍遵守 proposal-first（中高风险）。
- 工具协议仍为 Schema + XML 独占消息（现状已具备）。

---

### 1. 目标架构（End State）

把“像”拆成**模板/规则驱动**，把“不贴”拆成**确定性检测 + 闸门**。核心思想：

- **写作样例默认只来自模板/规则卡（card/template）**，而不是原文段落；
- 原文段落只作为**证据位**（anchors/小窗口），并被 **anti-copy 检测覆盖**；
- `lint.style` 负责“像不像”；新增 `lint.copy`（或并入 `lint.style` 的 `copyRisk`）负责“不贴”。

---

### 2. 长期状态机（把“后验修补”升级为“前置阶段化”）

现状 Gateway 已有 `style_need_kb → style_need_lint → style_can_write`（见 `apps/gateway/src/index.ts`）。长期建议演进为：

```
style_need_templates   // 只能 kb.search(kind=card/template)，拿“模板/规则/结构骨架”
  -> style_need_draft  // 生成候选稿（纯文本，不写入）
  -> style_need_copy   // 运行 lint.copy（anti-regurgitation）
  -> style_need_style  // 运行 lint.style（style fidelity）
  -> style_can_write   // 允许写入类 doc.*
```

关键：`style_need_copy` 与 `style_need_style` 是正交闸门；两者都必须通过（或显式降级）才进入写入阶段。

---

### 3. 数据与产物（KB V2 对齐 + 模板仓库）

对齐 `kb-manager-v2-spec.md` 的 V2 方向（segment/cluster/anchors/cluster rules/styleContract），补齐一个“模板仓库”的长期产物层：

#### 3.1 必备产物（V2 必做）
- **segments**：语料单位（地基）
- **clustersV1**：写法候选（k=2~3）
- **anchors**：黄金样本（segment 级引用，可回链）
- **cluster rules**：每簇“大规则卡”（evidence/softRanges/facetPlan/checks/queries）
- **styleContractV1**：短硬契约（Main Doc 注入，1–2 屏）

#### 3.2 新增产物（长期：模板仓库）
把“写作时能学到的东西”从“句子段落”改为“模板”：

- **sentence templates**：句式模板（例如“不是A也不是B，而是C。为什么？…”，保留槽位）
- **paragraph templates**：段落结构模板（句群关系/节奏点/转折位置）

实现建议：先把模板作为 `kind=card` 的新 `cardType` 落盘（最小改动），例如：
- `cardTypes: ["sentence_template", "paragraph_template"]`

---

### 4. 工具与门禁：新增 `lint.copy`（长期核心）

#### 4.1 目标
可机检地识别“明显贴原文/近似复述”，并提供“可执行的回炉提示”。

#### 4.2 输入（建议）
- `text`：候选稿全文
- `sources[]`：要对比的参考文本集合（每项包含 `id/kind/text/quoteMeta`）
  - kind 示例：`user_input` / `kb_style_example` / `kb_anchor` / `kb_source_doc_excerpt`
- `config?`：阈值/规范化策略（可缺省）

#### 4.3 输出（建议）
- `riskLevel: "low"|"medium"|"high"`
- `metrics`：
  - `maxLcsChars`
  - `maxChar5gramJaccard`
  - `topOverlaps[]`（span + sourceId + matchedText）
- `rewriteAdvice`：结构化建议（例如：必须重排段落/改句式/改衔接/改类比）

#### 4.4 算法口径（v0.1 建议）
中文优先采用确定性、低成本的口径（先压“明显贴”）：
- normalize：统一空白/标点（不做同义词扩展，避免误伤扩大）
- **char 5-gram Jaccard**（整体相似）
- **最长公共连续片段长度（字符）**（连续复用最危险）

阈值不在 spec 里拍死：必须用真实样本集校准；但需要提供可配置 env/ToolConfig：
- `COPY_LINT_MAX_LCS_CHARS`
- `COPY_LINT_MAX_CHAR5GRAM_JACCARD`
- `COPY_LINT_MODE=hint|safe|gate`（对齐 lint.style 的模式语义）

---

### 5. 落地点清单（改哪里、怎么串起来）

> 下面是“长期方案”落到代码的预期位置（不要求一次做完，按里程碑推进）。

#### 5.1 Gateway（编排/门禁/审计）
- `apps/gateway/src/index.ts`
  - 在 style gate 的阶段机里引入 `style_need_copy`（或把 copy-check 合并到 `style_need_lint` 的子阶段）
  - 新增/复用 policy：`CopyGatePolicy`（或扩展现有 `LintPolicy`）
  - 在 `runAudits` 与 `policy.decision` 记录 copy 风险指标（可观测/可回归）

#### 5.2 Tools 契约（单一来源）
- `packages/tools/src/index.ts`
  - 新增 `lint.copy` 工具定义（inputSchema/outputSchema/examples/riskLevel）
  - 或扩展 `lint.style` 的输出 schema：增加 `copyRisk`（但长期更建议拆成独立工具，避免语义混淆）

#### 5.3 Desktop（工具执行与 Problems UI）
- `apps/desktop/src/agent/toolRegistry.ts`
  - 增加 `lint.copy` 本地执行（若依赖本地 KB 文本）；或走 Gateway server-tool（更利于审计/计费）
- `apps/desktop/src/components/*`（Problems/ToolBlock）
  - 在 Problems 面板展示 `lint.copy` 的 overlap spans（支持一键生成回炉提案）

#### 5.4 KB Manager V2（产物与模板仓库）
- `apps/desktop/src/state/kbStore.ts`（与 `kb-manager-v2-spec.md` 对齐的实现入口）
  - segment/cluster/anchors 管理
  - cluster rules 生成与持久化
  - 模板抽取任务（可先确定性规则，后续可选 LLM 增强）

---

### 6. 风险审计（会怎么坏、怎么兜底）

#### 6.1 误伤风险（false positive）
- **常用短语/固定搭配**：可能被判为 overlap
  - **兜底**：阈值采用“连续长片段”为主（LCS），短片段只提示不 gate；允许 `allowPhrases[]` 白名单（短语级）
- **专有名词/人名/产品名/数字**：复用是合理的
  - **兜底**：normalize 时保留，但判定时对“仅数字/仅实体”的 span 降权；输出中标注 overlap 类型

#### 6.2 性能风险（长文/多 sources）
- 直接做全量 LCS 可能 O(n^2)
  - **兜底**：先用 5-gram overlap 找候选窗口，再在窗口内求 LCS；对 sources 总字数做预算上限

#### 6.3 行为漂移风险（门禁变多导致卡死）
- 新增 copy gate 可能让流程更“难通过”
  - **兜底**：提供 `COPY_LINT_MODE=hint|safe|gate`，并对齐现有 lint 的 safe 降级（保留 best draft + 放行写入）

#### 6.4 上下文膨胀风险（模板/证据塞太多）
- 模板仓库若直接注入，会加剧贴原文倾向
  - **兜底**：坚持 retrieval-first：上下文只注入“索引/contract/selector”，模板正文按需 kb.search 拉取并控量

---

### 7. 里程碑（建议顺序）

#### M1（1 周）：把“不贴”变成可观测
- 新增 `lint.copy`（hint 模式默认开启）
- runAudits/policy.decision 记录 copy metrics（先观测、先不 gate）

#### M2（2–3 周）：把“不贴”变成闸门（可降级）
- copy gate 接入 style_imitate 状态机（safe/gate 可选）
- bestDraft 选择改为多目标（style + copy）

#### M3（1–2 月）：模板仓库 + V2 anchors/cluster rules 扶正
- anchors/cluster rules 的 UI/产物完备（对齐 `kb-manager-v2-spec.md`）
- sentence/paragraph templates 作为 cardTypes 可检索、可引用、可控量

---

### 8. 验收清单（最小回归）
- 绑定风格库做 research（全网/GitHub 大搜）：不应被风格闭环抢跑（已有基础，回归保护）
- 绑定风格库写作：必须走 templates → copy → style → write（或明确降级）
- 构造“明显贴原文”的候选：`lint.copy` 必须给出 high + overlap spans，并触发回炉提示/闸门

