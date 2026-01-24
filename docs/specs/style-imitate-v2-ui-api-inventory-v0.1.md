## 仿写（style_imitate）V2 开工前整理：现有 UI 与接口清单（v0.1）

> 状态：draft（2026-01-24）  
> 目的：在做 V2（segments/clusters/anchors/rules/contract）之前，先把**现有 KB Manager 的 UI 入口**与**Desktop↔Gateway 的接口/数据结构**盘清楚，避免“删了重写”与“改到一半才发现入口散落/接口不一致”。  
> 原则：**不建议把“库管理/抽卡 UI”整套删掉重写**；优先“保留入口与交互习惯”，用 **核心逻辑替换 + 分步扩展**把它迁移到 V2。

---

### 0. 现状结论（给开工用）

- **保留**：`当前库`、`右侧已关联库（绑定库）`、Explorer 右键 `导入到知识库（并抽卡）`、抽卡/手册任务队列（▶/⏸/■）。  
- **现有 UI 已经具备 V2 雏形**：库体检（fingerprint）、segments 级统计、clustersV1、anchors（黄金样本）选择/清理、簇改名/默认簇等都已在 `kbStore` 类型里预留或部分实现。  
- **V2 的“新语料处理逻辑”不等于“推翻 UI”**：更像是把“库体检/抽卡/手册生成”的产物升级为 V2 的可审计产物（segments/clusters/anchors/rules/contract），并把这些产物在现有 UI 上“显式化”。

---

### 1) Desktop 现有 UI 入口清单（写作 IDE 内）

#### 1.1 左侧 KB 面板：库列表/当前库/绑定库

- **文件**：`apps/desktop/src/components/KbPane.tsx`
- **用户能做什么**
  - 选择/更换 KB 目录（本地库根目录）
  - 打开 `库管理…`（KB Manager 弹窗）
  - 刷新库列表
  - 对每个库：设为 `当前库`（影响导入/抽卡目标库）、`关联到右侧`（影响 Agent Run 检索/风格库）
- **关键策略（会影响 V2）**
  - **风格库（purpose=style）默认单选绑定**：切换风格库会替换旧风格库，避免多风格混用导致“乱写/不稳定”。

#### 1.2 KB Manager 弹窗：库管理 + 抽卡队列 + 库体检/anchors/clusters

- **文件**：`apps/desktop/src/components/CardJobsModal.tsx`
- **形态**
  - Tabs：`libraries | jobs | trash`
  - 同一弹窗内聚合：库管理（新建/改名/用途/FacetPack）、抽卡任务队列、风格手册任务队列、库内卡片浏览、库体检（fingerprint）、anchors 与簇配置等
- **为什么建议保留**
  - 它已经是“KB 的控制台”：V2 需要的产物（segments/clusters/anchors/rules）最适合继续放在这里，而不是另起一套全新 UI。

#### 1.3 Explorer 右键：导入到知识库（并抽卡）

- **文件**：`apps/desktop/src/components/Explorer.tsx`
- **入口**
  - 文件/文件夹右键菜单：`导入到知识库（并抽卡）`
- **流程（高层）**
  - 过滤支持格式（`.md/.mdx/.txt`）
  - 若未设置 KB 目录：引导去 KB 面板先选择
  - 若未选择当前库：打开 `库管理` 并提示用户先选库（同时暂存 pendingImport）
  - 导入成功后：把 docIds 加入抽卡队列并打开 KB Manager 的 `jobs` 页（默认 **不自动开始**，需用户点 ▶）

#### 1.4 右侧 Agent 面板入口：快速打开库管理

- **文件**：`apps/desktop/src/components/AgentPane.tsx`
- **入口**：点击 `KB N库` 相关控件会 `openKbManager("libraries")`

---

### 2) Desktop 本地数据模型（KB Store）与关键动作

#### 2.1 本地存储形态（核心事实）

- **文件**：`apps/desktop/src/state/kbStore.ts`
- **本地 DB**：以 JSON 形式落盘（由 `baseDir + ownerKey` 决定位置/命名），包含：
  - `libraries`：库元信息（purpose / facetPackId）
  - `sourceDocs`：导入后的源文档（按库归属、带 contentHash 去重）
  - `artifacts`：paragraph/outline/card（含向量缓存 `embeddings[model]`）
  - `fingerprints`：库体检快照（包含 perDoc/perSegment、clustersV1 等）
  - `libraryPrefs`：库级偏好（风格库 anchorsV1、默认簇、簇改名等）

#### 2.2 关键类型（接口/迁移会用到）

- `KbLibrary`：`purpose: material|style|product`，`facetPackId`
- `KbArtifact`：`kind: paragraph|outline|card`，`cardType`（hook/thesis/ending/one_liner/outline/other 等），`anchor`（paragraphIndex/headingPath），`embeddings`（向量缓存）
- `KbLibraryFingerprintSnapshot`：库体检快照，包含 `corpus` / `stats` / `topNgrams` / `perDoc` / `perSegment?` / `clustersV1?`
- `KbTextSpanRefV1`：回链引用（libraryId/sourceDocId/segmentId/段落范围/headingPath/短 quote）
- 任务队列：
  - `KbCardJob`：抽卡任务（按 doc）
  - `KbPlaybookJob`：风格手册任务（按 library）

#### 2.3 关键动作（UI → Store → Gateway）

| 用户动作 | Desktop 侧入口 | Store 动作（方向） | Gateway 依赖 |
|---|---|---|---|
| 右键导入并入队 | `Explorer.tsx` | `importProjectPaths()` → `enqueueCardJobs()` | 抽卡执行阶段需要 `/api/kb/dev/extract_cards` |
| ▶ 开始抽卡/手册任务 | `CardJobsModal.tsx` | `startCardJobs()`（统一 runner） | `/api/kb/dev/extract_cards`、`/api/kb/dev/build_library_playbook` |
| 库体检（像什么/稳不稳） | `CardJobsModal.tsx` | `computeLibraryFingerprint()` | `/api/kb/dev/classify_genre`（开集体裁/声音） |
| anchors（黄金样本）采纳/清理 | `CardJobsModal.tsx` | `saveLibraryStyleAnchorsFromSegments()` / `clearLibraryStyleAnchors()` | 无（本地 prefs） |
| 风格对齐检查 | Agent 工具 | `lint.style` tool（Desktop 发起） | `/api/kb/dev/lint_style` |

---

### 3) Agent 工具接口清单（和 V2 强相关）

#### 3.1 `kb.search`（本地检索 + 可选向量重排/兜底）

- **定义**：`apps/desktop/src/agent/toolRegistry.ts`（tool name：`kb.search`）
- **实现**：`apps/desktop/src/state/kbStore.ts` 的 `searchForAgent()`
- **关键点**
  - 默认在“右侧已关联库”里搜（用户可显式传 `libraryIds`）
  - 先词法召回，再可选向量重排；词法 0 命中时有向量兜底召回
  - embedding 来自 Gateway：`POST /api/llm/embeddings`（需要登录态 `Authorization`）
  - 向量结果会缓存到本地 `KbArtifact.embeddings[embeddingModel]`

#### 3.2 `lint.style`（风格 Linter）

- **定义**：`apps/desktop/src/agent/toolRegistry.ts`（tool name：`lint.style`）
- **行为**
  - Desktop 侧收集：候选稿文本 + draft stats +（从风格库 sidecar 里拿）stats/topNgrams/samples
  - 发往 Gateway：`POST /api/kb/dev/lint_style`
  - 返回：`similarityScore / issues / rewritePrompt`（并附 `copyRisk` 观察字段给前端/审计用）

---

### 4) Gateway 接口清单（KB dev + embeddings）

> 注：KB 的“重计算/耗时模型调用”目前主要在 Gateway（计费/模型配置/重试/超时等集中治理）；本地 KB 负责落库与断点续传。

#### 4.1 `POST /api/kb/dev/extract_cards`（抽卡）

- **输入（要点）**
  - `paragraphs: [{ index, text, headingPath? }]`
  - `mode?: "generic" | "doc_v2"`
  - `facetIds?: string[]`（不传会走默认 facet 列表）
- **输出（要点）**
  - `{ ok: true, cards: Card[] }`（可带 `billing`）
  - cards 内至少包含 `content`、`paragraphIndices[]`，并尽量带 `facetIds[]`；`doc_v2` 模式会输出 `cardType`

#### 4.2 `POST /api/kb/dev/build_library_playbook`（库级风格手册）

- **输入（要点）**
  - `facetIds: string[]`
  - `docs: [{ id,title, items:[{ cardType, content, paragraphIndices, facetIds? }] }]`
  - `mode?: "lite"|"full"`，`part?: "full"|"facets"`
- **输出（要点）**
  - `{ ok: true, styleProfile, playbookFacets }`（可带 `billing`）

#### 4.3 `POST /api/kb/dev/classify_genre`（库体检：开集体裁/声音）

- **输入（要点）**：`stats?` + `samples[]`（带 docId/paragraphIndex/text）
- **输出（要点）**：`primary` + `candidates[]`（含置信度/why/可选证据）

#### 4.4 `POST /api/kb/dev/lint_style`（风格 Linter）

- **输入（要点）**
  - `draft: { text, chars?, sentences?, stats? }`
  - `libraries: [{ corpus?, stats?, topNgrams?, samples? }]`（由 Desktop 侧拼装 sidecar）
- **输出（要点）**
  - `similarityScore`、`issues[]`（带 draft/reference 证据）、`rewritePrompt`

#### 4.5 `POST /api/llm/embeddings`（向量）

- **用途**：`kb.search` 的向量重排/兜底召回
- **输出**：OpenAI-compatible `data[].embedding[]`（Desktop 会读取并缓存到本地 artifacts）

---

### 5) V2 对照：现有结构能复用什么？要新增什么？

#### 5.1 现有结构 ≈ V2 产物（可复用/可升级）

- **segments**
  - 现状：`KbLibraryFingerprintSnapshot.perSegment?` + `KbTextSpanRefV1.segmentId`
  - V2：把 segments 从“体检快照里的统计对象”升级为“可回链、可作为 anchors 的候选单元”
- **clusters（k=2~3）**
  - 现状：`KbLibraryFingerprintSnapshot.clustersV1?`（包含 evidence、anchors、facetPlan、queries 等字段）
  - V2：把 clusters 从“可选字段”升级为“风格库必备产物”，并让 `styleContractV1` 明确绑定某个 cluster
- **anchors**
  - 现状：`libraryPrefs.style.anchorsV1` + UI 里 anchors 选择器
  - V2：anchors 继续保留，但强化两点：1) 每簇 5–8 条；2) 每条可审计回链（quote+定位）
- **cluster rules / styleContractV1**
  - 现状：playbook（style_profile + playbook_facet cards）承担了一部分“规则卡”职责
  - V2：需要把“写法规则”从 playbook 中拆出为 cluster rules（must/avoid/templates/checks/queries），并生成短硬 `styleContractV1` 注入 Main Doc

#### 5.2 UI 迁移建议（不删重写，按“核心替换”）

- **保留入口不动**：`KbPane`（当前库/绑定库） + `CardJobsModal`（控制台） + Explorer 右键导入
- **把 V2 的新产物放进现有弹窗**
  - `libraries` 页：新增/强化“语料处理状态”（segments/clusters/anchors/rules/contract 的生成时间与覆盖率）
  - `jobs` 页：沿用队列控制，但让任务类型更明确（导入/抽卡/体检/聚类/anchors/rules/contract）
  - `health`（库体检）视图：把“稳定性/离群/证据覆盖率”作为 V2 的验收指标面板

---

### 6) 开工前需要“冻结”的接口边界（避免边做边改）

建议先冻结 3 条边界，再开写代码：

1) **库选择/绑定语义不变**：`currentLibraryId`（导入/抽卡目标库）与 `kbAttachedLibraryIds`（写作检索/风格库）继续存在。  
2) **Job runner 仍是单入口**：`startCardJobs()` 继续作为统一队列执行器，V2 新任务只是在此处增加 jobType 分支。  
3) **Gateway 仍只做“重计算 + 计费 + 模型治理”**：Desktop 负责落库与断点续传；Gateway 不直接写 Desktop 的本地 KB。

