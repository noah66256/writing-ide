## KB Manager V2（更像原文）方案草案

### 0. 目标与原则
- **北极星**：更像原文（用户指定的锚点原文/口味）。
- **优先级**：LLM 易读取 > 不容易丢上下文 > 可检索/可验证 > 用户可改口/可控 > 自动化。
- **默认写法作用域**：`设为默认写法/默认选簇` **仅对当前库生效**；不做跨库自动匹配；同库内允许按题材/话题自动推荐写法并默认选定（用户可改口覆盖）。
- **性能原则**：segment/cluster/规则产出只在“库体检/更新体检”时计算并落盘；写作 Run 只读快照，不做重计算。
- **不做**：
  - 不做通用工作流平台（所有能力围绕“写作产出与编辑体验”）。
  - 不强制每次跑完 21 维度。
  - 不把“风格对齐”做成不可解释的黑箱分数门禁（可以有提示/可选强度，但要可审计）。

### 1. 现状盘点（v1）

#### 1.1 入口与对象
- **KB 目录（baseDir）**：选择/更换。
- **库（Library）**：新建/重命名/用途（素材/风格/产品）/FacetPack/删除到回收站/恢复/彻底清空。
- **当前库（currentLibrary）**：影响导入/抽卡/检索范围（未选库会阻塞导入）。
- **关联到右侧（kbAttached）**：多选；影响 Context Pack 注入与技能闸门识别。
- **导入**：Explorer 右键导入 `.md/.mdx/.txt` → 导入完成后入队抽卡任务（默认不自动开始）。
- **抽卡任务队列**：开始/暂停/继续/取消/重试失败/清理已完成；显示进度与 ETA。
- **生成风格册任务**：入队后执行（计为 StyleProfile(1)+Facets(N) 的总进度口径）。
- **库体检（fingerprint）**：stats/topNgrams/genre/stability 的快照；支持对比最近两次。
- **库内浏览**：卡片列表（按 cardType/query 过滤）。

#### 1.2 当前“风格册”的注入/使用方式
- **注入方式**：`KB_LIBRARY_PLAYBOOK(Markdown)` 注入 Context Pack（存在总长度截断上限，模型阅读依赖自觉）。
- **skill 侧**：`style_imitate` 目前主要做“门禁闭环”（先 kb.search / lint.style / 再写入），不保证“先对齐总口味契约”。
- **补充（已落地）**：写作类任务且 `style_imitate` 激活时，Context Pack 还会注入：
  - `KB_STYLE_CLUSTERS(JSON)`：写法候选摘要（含 recommended/default）
  - `STYLE_SELECTOR(JSON)`：本次自动选簇 + 自动选 21 卡（TopK）结果（含 stage/why/trace）
  - `STYLE_FACETS_SELECTED(Markdown)`：本次入选维度卡正文（来自 playbook_facet），用于约束生成模型“只执行入选卡”

#### 1.3 已暴露问题（与“更像原文”直接相关）
- **单一口径**：同一库可能混多种写法/题材，单一 baseline 容易把方向带偏。
- **总口味不稳**：缺少“最先读、最不易丢、可验证”的 styleContract；21 维度容易被 LLM 自由发挥或选错模板。
- **语料单位不清**：一篇文件可能包含多条稿；若不分割，会造成统计/检索/抽卡/体检都失真。
- **缺少 anchors**：用户无法明确告诉系统“哪几条/哪几段是我认可的原文口味代表作”。

### 2. V2：为了更像原文的核心改造（已敲定，必须落地）
- **先定大规则（写法大类/选簇）→ 再用 21 维度**。
- **Agent 必须先给 2–3 个“写法候选”**（含证据句），默认自动选择推荐写法并继续；用户可随时改口切换。
- **引入 anchors（黄金样本）**：用户可选“数据好/口味对”的段落作为锚点，用于选簇/生成规则/检索推荐。
- **扶正“总口味契约 styleContract（那个 1）”**：
  - 结构化（JSON）
  - 注入位置靠前（Main Doc）
  - 短、硬、带证据、带检查项（可验证/可检索）
- **21 维度要收束**：每张维度卡要更像“规则卡/模板卡”，不能让模型散文化发挥。
- **`final_polish checklist` 定位**：更像“验收清单/人工 QA”，可作为 lint 规则来源，但不等于黑箱风格门禁。

### 3. 分割（segment）/分簇（cluster）/规则产出（cluster rules）

#### 3.1 segment：语料单位（地基）
- **定义**：从源文档切出来的“稿件单元/段落块”，一篇文件可有多个 segment。
- **切分信号（优先）**：
  - Markdown 标题、分隔线
  - `标题:` / `文案:` 标记（常见拼稿）
  - 超长兜底切分（避免单段过大）
- **segment 必备字段**：
  - segmentId
  - sourceDoc（id/path/title）
  - paragraphIndexStart（或范围）
  - text
- **UI 展示（默认）**：`文件名 + 段落预览（前 ~120 字） + 字数 + 段落范围`；点击可展开全文与回链定位。
- **生成时机**：仅在 KB Manager 的 `库体检/更新体检` 时生成/刷新；写作 Run 内不做分割与统计（避免影响性能/费用）。

#### 3.2 cluster：写法大类（建议默认 k=3）
- **目标**：把库里“不同写法的大类”拆开，否则单一 baseline 会把方向带偏。
- **默认**：k=3（容纳：原文口味大类 / 另一类口味 / 离群爽文或其他题材）。
- **降级**：样本不足时 k=2 或不分簇（并提示“库混杂/样本不足”）。
- **特征（确定性统计，轻量且稳定）**：avgSentenceLen、shortSentenceRate、questionRatePer100Sentences、exclaimRatePer100Sentences、particlePer1kChars、digitPer1kChars、firstPersonPer1kChars、secondPersonPer1kChars（默认固定，可扩展）。
- **算法**：默认 k=3，使用轻量 k-means（固定随机种子）或层次聚类；输出每簇 stats 均值/方差 + 代表 segments。
- **缓存/过期**：结果随 fingerprint 快照落盘（沿用本地 `kb.v1.json` 的 fingerprint 快照思路，每库保留最近 5 次）；当库内容变化（docCount/contentHash/updatedAt）时标记“体检过期”，用户点“更新体检”才重算。
- **簇命名**：默认 `写法A/写法B/写法C`（可编辑并持久化到库配置）。
- **clusterId（主键）**：推荐固定格式 `cluster_0/cluster_1/cluster_2`（0-based；稳定于该次 fingerprint 快照；展示用 label 可改名但不作主键）。
- **默认推荐规则（无 anchors 时）**：优先选择 `stability` 更高的簇；若相同，再按覆盖率（segments/doc 覆盖）打分；仍相同则取 clusterId 最小者。

#### 3.3 cluster rules：每簇必须产出的“大规则卡”
每个簇至少输出：
- **id**：clusterId（主键；见 3.2；展示用 label 可编辑）
- **label**：人能懂的写法名（可编辑）
- **why/适用场景**：这类写法适合什么题
- **evidence**：3–5 个代表样例（含引用句，可追溯）
- **softRanges（可验证区间）**：句长/问句率/语气词密度/数字密度等（范围而不是单点）
- **facetPlan**：本簇默认优先使用的维度子集 + 推荐检索 query（避免自由发挥）
- **anchors**：本簇已采纳的黄金样本引用（segmentId + source + quote + where）。
- **checks（可机检）**：从 anchors 归纳的可验证检查项（mustContainAny / avoidAny / ratioRange 等），供提示与审计。
- **queries（检索推荐）**：围绕本簇的 n-gram/主题词给出推荐 kb.search query 模板（供 Agent 两段式检索使用）。

#### 3.4 anchors：用户手工校准（必须支持）
- **粒度（默认）**：按 segment 选（更准）；UI 展示为 `文件名 + 段落预览`，可展开查看全文与回链定位。
- **默认推荐数量**：每簇推荐 5 段 anchors；高级模式可扩到 8 段并允许手动增删。
- **选择约束（默认）**：同一 sourceDoc 最多 2 段；每次变更可撤销/回滚。
- **用途**：
  - 选簇：锚点属于哪个簇，就默认选哪个簇写作（更像原文）
  - 产规则：cluster rules 的证据优先来自 anchors
  - 检索：优先围绕 anchors 的高频 n-gram/主题词推荐 query

#### 3.5 库体检页（子簇/写法候选）UI：零学习成本（默认只给结论）
- **页面只回答三件事**：像什么 / 稳不稳 / 怎么修（高级细节默认折叠）。
- **写法候选（2–3 张簇卡）**：每张卡默认展示：
  - label（可编辑，默认写法A/B/C）
  - 推荐标记（Recommended）
  - stability/覆盖率（segments 覆盖、doc 覆盖）
  - why（适用场景一句话）
  - evidence（3–5 条引用句，带回链）
  - softRanges 摘要（仅展示 3–5 个最关键指标）
- **卡片动作**：
  - `设为默认写法（仅本库）`
  - `采纳 anchors（默认 5 段）`（可展开调整；高级模式可到 8 段）
  - `展开细节`（显示完整指标、n-gram、离群段）
- **三步闭环（写法选择→规则生成→可用）**：
  - Step 1：更新体检 → 生成 segments + clusters + 推荐 anchors
  - Step 2：用户设默认写法 + 采纳 anchors（可微调）
  - Step 3：生成/刷新该簇的 cluster rules，并给出 styleContract 预览（可复制/可回滚）

### 4. 写作时（Agent/Skill）如何使用：先大规则，再 21 维度

#### 4.0 写法选择优先级（必须一致）
- 用户在对话中显式指定写法/簇 > Main Doc 已锁定 > **库默认写法（仅该库）** > 体检推荐（无 anchors 时按 stability 优先）。

#### 4.0.1 Selector v1（已落地）：运行态产物（Context Pack）
> 目标：把“选簇/选卡”的结果结构化注入，保证换生成模型也能稳定消费（生成模型只负责写，不负责选）。
- `KB_STYLE_CLUSTERS(JSON)`：候选簇摘要（含 recommendedClusterId/defaultClusterId/关键指标）。
- `STYLE_SELECTOR(JSON)`：本次选择结果（v=2），包含：
  - `selectedClusterId`
  - `stage`（opening/outline/draft/ending/polish）
  - `selectedFacetIds` + `selectedFacets[]`（TopK 4–8；每张含 why/kbQueries/score）
  - `why[]/trace{}`（可观测/可审计）
- `STYLE_FACETS_SELECTED(Markdown)`：把入选维度卡正文注入（来自 playbook_facet），用于约束生成模型“只执行入选卡”。

#### 4.1 Agent 推荐写法（可改口）
- 输出 2–3 个候选：每个候选都带（label + 适用场景 + 证据句 + 默认 facetPlan）
- 用户一句话切换：“用 XX 写法” → 立即切换选簇与 facetPlan

#### 4.2 styleContract（那个 1）：放进 Main Doc 的结构化契约（短、硬、可检索可验证）
- **写入位置**：Main Doc 顶部（每轮必注入，最不易丢）
- **长度预算**：建议控制在 1–2 屏（例如 <= 1500–2500 中文字符），禁止塞长段素材；证据用“引用+回链”。
- **字段建议**：
  - selectedCluster（必须包含 id；label 可编辑但不作主键）
  - hardRules（<=8 条；must/avoid/templates/evidence/checks）
  - facetPlan（该簇默认维度子集；本次 stage 的 TopK 子集由 `STYLE_SELECTOR(JSON).selectedFacetIds` 提供）
  - anchors（引用到哪些黄金样本）
  - softRanges（用于提示跑偏，不做黑箱门禁）

示例（草案）：
```json
{
  "styleContractV1": {
    "libraryId": "kb_lib_xxx",
    "selectedCluster": { "id": "cluster_a", "label": "写法A" },
    "anchors": [
      { "segmentId": "seg_001", "source": "直男财经.md#P15", "quote": "不是A，也不是B，而是C。" }
    ],
    "hardRules": [
      {
        "id": "R1_hook",
        "must": ["开头三段：钩子→结论→战场坐标"],
        "avoid": ["新闻通稿口吻连续堆“此外/同时/综上”"],
        "templates": ["X第一，不是A，也不是B，而是C。为什么？咱们从…拆。"],
        "checks": [{ "type": "mustContainAny", "tokens": ["不是", "也不是", "为什么"] }]
      }
    ],
    "facetPlan": [
      { "facetId": "opening_design", "why": "本簇标志性开门锤", "kbQueries": ["不是A也不是B 而是C"] }
    ],
    "softRanges": { "digitPer1kChars": [15, 35], "questionRatePer100Sentences": [25, 55] }
  }
}
```

#### 4.3 21 维度列表（speech_marketing_v1）
> V2 方向：逐步把每张维度卡升级为“规则卡/模板卡”，结构建议：must/avoid/templates/evidence/queries/checks；同一维度允许多模板，但模板选择权归属“选簇+facetPlan”，不让模型临场自由发挥。
- intro / opening_design / narrative_structure / language_style / one_liner_crafting
- topic_selection / resonance / logic_framework / reader_interaction / emotion_mobilization
- question_design / scene_building / rhetoric / voice_rhythm / persuasion
- values_embedding / structure_patterns / psychology_principles / special_markers / viral_patterns / ai_clone_strategy

### 5. KB Manager V2：信息架构与流程（重做方向）

#### 5.1 保留的能力（v1 已有，v2 必须覆盖）
- 选择 KB 目录
- 库 CRUD + 回收站
- 当前库选择 + 关联到右侧
- 导入（含 pendingImport）
- 抽卡队列（开始/暂停/继续/取消/重试/清理）
- 生成风格册任务（21+1）
- 库体检（fingerprint）+ 对比
- 库内卡片浏览

#### 5.2 新增/增强（为“更像原文”服务）
- 语料分割（segment）可视化：样本段列表、段落范围、长度分布
- 分簇（k=3）展示与命名：每簇 label、代表样例、软指标范围
- anchors 管理：选择/取消、从文件→段落的二次确认
- 写法候选预览：这库能写成哪几种“直男财经写法”，并允许设默认
- facetPlan 编辑：每簇默认用哪些维度（可改）

### 6. 实施顺序（建议里程碑）
- M0：把本方案落盘，作为接下来重做依据
- M1：把 segment/anchors 作为一等公民落地（先可视化、可选择）
- M2：在体检里生成 cluster rules（k=3），并在库管理页展示/可改名
- M3：Agent 写作前输出写法候选（可改口），并把 selectedStyle 写入 Main Doc
- M4：把 21 维度卡改成“规则卡”结构（逐步迭代，不要求一次做完）
- M5：弱化风格门禁：风格校验从“卡脖子”转为“提示/可跳过/可审计”；合规 lint 独立出来

### 7. 开放问题（后续逐项定）
- 题材自动匹配（同库不同题材自动推荐/切写法）是否要做：**要做（Selector v1）**；但不做跨库匹配。
- k>3 的更细子簇与“人机共训 anchors→规则”的迭代策略：后续增强。

### 8. 字段与口径约定（v0，消除二义性）

#### 8.1 统计指标口径（用于 fingerprint / cluster / softRanges）
以下口径应与当前实现保持一致（`apps/desktop/src/state/kbStore.ts#computeTextFingerprintStats`）：
- **切句规则**：按 `[\n。！？!?]+` 分割，trim 后计入句子；空句丢弃。
- **avgSentenceLen**：句子平均长度（字符数）。
- **shortSentenceRate**：短句占比（句长 <= 12 的比例），取值 0~1。
- **questionRatePer100Sentences**：每 100 句中的“疑问句”数量。疑问句判定：句内包含 `?`/`？` 或命中 `(吗|呢|为什么|怎么|何以|问题来了)`。
- **exclaimRatePer100Sentences**：每 100 句中的“感叹句”数量。感叹句判定：句内包含 `!`/`！`。
- **firstPersonPer1kChars**：每 1000 字符中的第一人称字符数（`我|咱|咱们|我们`）。
- **secondPersonPer1kChars**：每 1000 字符中的第二人称字符数（`你|你们`）。
- **particlePer1kChars**：每 1000 字符中的语气词字符数（`啊|呢|吧|呀|哎|诶|呐`）。
- **digitPer1kChars**：每 1000 字符中的阿拉伯数字字符数（`\d`）。

#### 8.2 `softRanges` 结构（区间必须可解释/可复现）
- **类型**：`Record<StatKey, [min, max]>`，闭区间；min/max 为 number。
- **单位**：
  - `*Per100Sentences`：数量（0~100+）
  - `*Per1kChars`：数量（0~1000+）
  - `shortSentenceRate`：比例（0~1）
  - `avgSentenceLen`：字符数

#### 8.3 anchors/evidence 的“可回链引用”结构（必须能跳回原文）
统一引用结构 `TextSpanRefV1`（推荐 JSON 形态）：
```json
{
  "libraryId": "kb_lib_xxx",
  "sourceDocId": "kb_doc_xxx",
  "importedFrom": { "kind": "project", "relPath": "直男财经.md", "entryIndex": 0 },
  "segmentId": "kb_doc_xxx#seg0",
  "paragraphIndexStart": 13,
  "headingPath": ["一","二"],
  "quote": "不是A，也不是B，而是C。"
}
```
- **paragraphIndexStart**：0-based；与 KB paragraph artifact 的 `anchor.paragraphIndex` 同口径。
- **segmentId**：若是 segment 级引用必须填；格式推荐 `${sourceDocId}#seg{n}`（0-based）。
- **quote**：建议 <= 200 字，用于 UI 预览与审计；正文仍以回链读取为准。

#### 8.4 `checks` 的语义（避免“同一条规则两边算出来不一样”）
`checks` 为数组，元素 `StyleCheckV1`：
- `{"type":"mustContainAny","tokens":["问题来了","为什么"]}`：在 **normalizeTextForStats**（仅换行归一）后的全文中做**子串包含**匹配；命中任一 token 即通过。
- `{"type":"avoidAny","tokens":["综上","此外"]}`：同上；命中任一 token 即判定违反（用于提示）。
- `{"type":"ratioRange","metric":"questionRatePer100Sentences","min":25,"max":55}`：基于 8.1 的统计口径计算并判断是否落在区间内（用于提示/审计，不做黑箱门禁）。

#### 8.5 `facetPlan` 的最小结构（避免 kbQuery/kbQueries 混用）
统一为：
```json
{ "facetId": "opening_design", "why": "本簇标志性开门锤", "kbQueries": ["不是A也不是B 而是C"] }
```
- `kbQueries`：0~3 条建议 query；由 Agent 结合“两段式检索”策略使用。

### 9. UI 文本线框（v0，先不画图，保证可实现）

#### 9.1 入口与整体结构（对齐现有 UI）
- **入口**：左侧 `KB` 面板 → 按钮 `库管理…` → 打开弹窗 `知识库管理`。
- **弹窗顶栏**：
  - 标题：`知识库管理`
  - 顶层 Tab：`库（libraries） / 抽卡任务（jobs） / 回收站（trash）`
  - 关闭：右上角关闭；`Esc` 关闭（优先关内层 prompt）。
  - 拖拽：标题栏可拖动；双击标题栏回到居中（现有行为）。

#### 9.2 顶层 Tab：库（libraries）
默认分两段：**库列表** + **库详情抽屉（可收起）**

##### 9.2.1 库列表（默认视图）
- **顶部工具条**：`新建库` / `刷新` / `当前库：xxx（pill）`
- **每个库条目**（卡片/行）默认展示：
  - 名称（粗体）
  - 元信息：文档数 / 更新时间 / FacetPack 标签 / 用途（素材库/风格库/产品库）
  - 体检徽章（若有）：`像：xxx`、`稳定：高/中/低`
  - id（小字）
- **每个库条目可操作**（保持“一个屏就能搞定”，不跳转）：
  - 用途下拉：素材库/风格库/产品库
  - `库体检`（打开该库详情 → 二级 Tab=库体检）
  - `看卡片`（打开该库详情 → 二级 Tab=卡片预览）
  - `设为当前`（再次点可取消）
  - `关联到右侧`（多选；已关联高亮）
  - `重命名` / `删除（进回收站）`

##### 9.2.2 库详情（viewLibId 展开区域）
- **二级 Tab**：`库体检` / `卡片预览`（对齐现有实现）
- 右上角 `收起`：折叠库详情，回到纯列表

#### 9.3 二级 Tab：库体检（health，V2 强化区）
目标：默认只给结论 + 一键操作；高级细节折叠。

##### 9.3.1 顶部按钮条
- **更新体检（一次性产出）**：生成/刷新 `segments + clusters + fingerprint + 推荐 anchors`（只写本地 KB；不改原文）。
- **生成/更新：风格手册（推荐）**：入队异步任务（提示去 jobs Tab 点 ▶ 执行）。
- **对比：上次 vs 这次**：展示关键指标 diff（高级视图）。
- **高级开关**：`我懂点，展开细节` / `收起细节`

##### 9.3.2 默认三卡（现有范式沿用）
- **像什么（最重要）**：主标签 + 置信度 + why
- **稳不稳（风格一致性）**：high/medium/low + note + 离群提示
- **怎么修（只给按钮）**：明确下一步入口（生成手册/补语料/分库等）

##### 9.3.3 写法候选（子簇）——仅风格库展示
仅当 `library.purpose=style` 且已存在体检快照时显示；否则提示“把用途设为风格库后可用”。

- **展示形式**：2–3 张 `写法卡（cluster card）`（默认展开；不需要用户先理解“聚类”）
- **每张写法卡默认字段**：
  - `label`：可编辑（默认 写法A/B/C）
  - `clusterId`：小字（`cluster_0/1/2`）
  - `Recommended` 标记（规则见 9.3.4）
  - `稳定性/覆盖率`：pill（覆盖率以 segments 为主）
  - `evidence`：3–5 条引用句（点击可回链跳转到原文位置）
  - `softRanges 摘要`：只展示 3–5 个关键指标（其余在高级展开）
- **每张写法卡按钮**：
  - `设为默认写法（仅本库）`（成功后该卡出现 “默认” 徽章）
  - `采纳 anchors（默认 5 段）`（进入 anchors 选择弹层）
  - `预览 styleContract`（只读预览，提供复制按钮；写作时 Main Doc 注入用）
  - `展开细节`（高级：完整 softRanges/stats/top n-grams/离群段）

##### 9.3.4 推荐规则（对齐已确认策略）
- **若该写法已采纳 anchors**：优先推荐该写法（Recommended）
- **若无任何 anchors**：按 `stability` 优先推荐；若相同按覆盖率；仍相同按 clusterId 最小
- UI 提示：Recommended 旁提供 tooltip：“无 anchors 时按稳定性优先；采纳 anchors 后推荐会更准确”

##### 9.3.5 anchors 选择弹层（采纳 anchors）
- **标题**：`采纳 anchors（写法A）` + 计数器（已选/上限、同文档上限提示）
- **默认列表**：系统推荐 5 段（checkbox 勾选），每条展示：
  - `文件名（relPath） + paragraphIndexStart + 段落预览（前~120字）`
  - 点击展开：全文预览 + “跳转原文”
- **约束（默认硬约束）**：
  - 推荐目标：5 段；高级模式可到 8 段
  - 同一 sourceDoc 最多 2 段（超出则禁选并提示原因）
- **高级模式**：
  - `从全部段落里挑…`：打开 segment picker（可搜索/按 cluster 过滤/按长度过滤）
- **确认语义**：
  - `确认采纳`：写入该库配置/快照（本地），并立刻刷新 cluster rules（或标记“待刷新”）
  - `取消`：不写入
  - 采纳成功后 toast：`已采纳 anchors（可撤销）`（提供 10s Undo）

##### 9.3.6 segments 列表（高级视图）
高级模式下展示，用于“看混杂/手工挑 anchors”：
- 过滤：cluster / 文档 / 长度区间 / 是否已是 anchor
- 列表项：`文件名 + 段落预览 + 字数 + cluster`，右侧按钮：`加为 anchor` / `移除 anchor` / `跳转原文`

#### 9.4 二级 Tab：卡片预览（cards）
- 维持现有：按 cardType/query 过滤、列表展示、可快速查看来源。
- V2 可选增强（不作为 M1 阻塞）：在卡片旁展示“来自哪个写法/cluster（若已体检）”。

#### 9.5 顶层 Tab：抽卡任务（jobs）
- 维持现有：抽卡队列/风格手册队列、进度条、ETA、▶/⏸/■、重试失败、清理完成。

#### 9.6 顶层 Tab：回收站（trash）
- 维持现有：恢复/彻底删除/清空回收站。


