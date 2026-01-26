## KB 通用库处理：统一 Ingest + Cite（v0.1 开工文档）

### 0. 背景与现状（基于当前代码）

当前“库处理”已在 Desktop 本地实现了一个可用的 KB 子系统，核心落盘为 `kb.v1.json`，并包含：

- **库（Library）**：`libraries[]`，带 `purpose: material|style|product`，用于默认策略分流。
- **源文档（SourceDoc）**：`sourceDocs[]`，入库按 `importedFrom + entryIndex` upsert，并以 `contentHash` 做同源去重。
- **派生片段（Artifact）**：`artifacts[]`，统一为 `kind: paragraph|outline|card`，支持向量缓存 `embeddings[embeddingModel]`。
- **库体检快照（Fingerprint）**：`fingerprints[]`，用于“像什么/稳不稳/怎么修”、`clustersV1`、`facetPlan` 等。

当前关键实现集中在：

- `apps/desktop/src/state/kbStore.ts`
  - `importProjectFiles()` / `importExternalFiles()`：入库 + 去重 + `buildArtifacts()` + 断点续传落盘
  - `searchForAgent()`：词法召回 → 向量重排/兜底 → recent fallback；embedding 缓存回写
  - `extractCardsForDocs()` / playbook 相关：抽卡与生成“库级仿写手册”
- `apps/desktop/src/agent/toolRegistry.ts`
  - `kb.search` 工具对 Agent 暴露；当前默认只返回 `snippet`（不返回全文 content）
- `apps/gateway/src/agent/serverToolRunner.ts`
  - 已有 `web.fetch` 形态的抓取能力（HTML 提取 + `sha256(contentHash)`），但尚未落到 Desktop 本地 KB 的 ingest

### 1. 本期目标（v0.1）

把“写作 KB”扩展成“通用资料库/通用库处理”时，优先补齐两块能力：

- **G1 统一 Ingest**：把“项目文件导入/外部文件导入/URL 导入”收敛到一个统一的 ingest pipeline（同一套去重/切分/落盘/产物化）。
- **G2 Cite/证据回链**：在不增加 prompt token 的前提下，提供精确可审计的“引用/取证据段”接口（`kb.cite` 或 `kb.readSpan`）。

目标结果：

- Desktop 侧能把 URL 内容（通过 Gateway 抓取）入到本地 KB，形成 `sourceDoc + artifacts`。
- Agent 侧能先 `kb.search` 得到候选（轻量），再用 `kb.cite` 拉取**指定证据段**（带定位与 quote），用于写作引用/事实核对/风格对齐。

### 2. 非目标（v0.1 不做）

- **NG1 云端 KB 服务化**：仍保持本地 KB（Desktop）为主；Gateway 仅用于联网抓取/embeddings 代理（已有）。
- **NG2 跨库/跨来源全局去重**：暂不做“不同来源但内容相同”的全局去重（仍按同库同源去重为主）。
- **NG3 全格式解析升级**：PDF/DOCX 的解析仍沿用现状（`desktop.kb.extractTextFromFile`）；不在本期重构解析链。
- **NG4 UI 大改**：本期以工具与数据链路为主，UI 仅做必要入口与提示（可选）。

### 3. 设计原则（必须遵守）

- **P1 可回滚/可恢复**：入库过程必须幂等或“可重复执行不产生脏重复”；失败不应破坏 `kb.v1.json`（现状已通过每 entry 落盘与容错 JSON 实现）。
- **P2 结果可追溯**：引用必须能回链到 `sourceDocId + anchor`，并携带短 `quote` 供 UI/审计展示。
- **P3 token 预算受控**：默认检索只回 `snippet`；全文/证据段必须通过 cite 精确拉取（控量 + 截断）。
- **P4 复用现有结构**：尽量不破坏现有 `KbDb` schema 与既有逻辑（避免迁移成本）。

### 4. 统一 Ingest 的目标形态

#### 4.1 统一入口：`kb.ingestText(...)`

在 Desktop 的 `kbStore` 内新增一个“统一 ingest 内核函数”，由三种来源复用：

- 项目文件导入：`importProjectFiles(paths[])` → 读取内容 → `ingestText(...)`
- 外部文件导入：`importExternalFiles(absPaths[])` → extractText → `ingestText(...)`
- URL 导入：`importUrls(urls[])`（新增）→ Gateway 抓取 → `ingestText(...)`

建议的内部函数签名（仅示意，按 TS 实现）：

```ts
type IngestSource =
  | { kind: "project"; relPath: string; entryIndex?: number }
  | { kind: "file"; absPath: string; entryIndex?: number }
  | { kind: "url"; url: string; fetchedAt?: string; finalUrl?: string };

async function ingestText(args: {
  libId: string;
  source: IngestSource;
  format: "md" | "mdx" | "txt" | "unknown";
  titleHint?: string;
  text: string;
  contentHash: string; // v0.1：沿用现有策略（文本 entry 用 fnv1a32；URL 用 sha256）
  nowIso: string;
}): Promise<{ docId: string; imported: boolean; skippedReason?: string }>;
```

行为要求：

- **去重粒度**：同库内按 `(source.kind + source.* + entryIndex)` 找 existing doc；若 `contentHash` 相同则 skip，并返回 `docId`（沿用现状逻辑）。
- **更新策略**：若同源同 entry 但 hash 不同 → 视为更新，重建 artifacts，并更新 `updatedAt`。
- **产物化**：调用现有 `buildArtifacts({ format, sourceDocId, text })` 生成 `paragraph/outline`。
- **断点续传**：每处理一个 entry 就 `saveDb`（沿用现状）。

#### 4.2 `contentHash` 策略（v0.1）

现状：

- 本地文本 entry 使用 `fnv1a32Hex(entryText)`（32-bit）。
- Gateway 网页抓取使用 `sha256(extractedText)`。

v0.1 选择：

- **保持兼容**：不强推迁移；继续允许 `contentHash` 为任意字符串。
- **URL 导入直接使用 sha256**：从 Gateway 返回的 `contentHash` 直接落盘到 `KbSourceDoc.contentHash`。

备注（v0.2 候选）：

- 可在 Desktop 统一改为 `sha256(normalizedText)` 以降低碰撞概率，并对旧数据不迁移（仅新入库使用），但需要实现 hash 计算（Node crypto / 浏览器 SubtleCrypto / preload）。

### 5. URL 导入（新增能力）

#### 5.1 总体流程

- Desktop 侧新增入口 `kb.importUrls(urls[])`（UI 可后置，先工具/内部 API）。
- Desktop 调用 Gateway 抓取：
  - 复用现有 `web.fetch`（或新增一个更窄的 `kb.fetchUrlForIngest`，但 v0.1 优先复用）。
  - Gateway 返回 `title/extractedText(or extractedMarkdown)/contentHash/fetchedAt/finalUrl/contentType`。
- Desktop 对返回内容做 `normalizeText`，必要时 `splitIntoEntries`（允许一个网页拆成多 entry：例如按 `---` 或标题块）。
- 每个 entry 走 `ingestText(...)`，`importedFrom.kind="url"`，并把 url 信息写进 `importedFrom`（或扩展新字段）。

#### 5.2 数据结构变更（最小）

现状 `ImportedFrom`：

- `{ kind: "project"; relPath; entryIndex? }`
- `{ kind: "file"; absPath; entryIndex? }`

v0.1 建议扩展：

```ts
export type ImportedFrom =
  | { kind: "project"; relPath: string; entryIndex?: number }
  | { kind: "file"; absPath: string; entryIndex?: number }
  | { kind: "url"; url: string; finalUrl?: string; fetchedAt?: string; entryIndex?: number };
```

注意：

- `entryIndex` 允许 URL 拆分多 entry（与现有 splitIntoEntries 对齐）。
- 若不想动类型，也可先用 `kind:"file"` 存 url（不推荐，会污染语义/后续审计）。

#### 5.3 去重语义

v0.1 仍按“同库同源同 entry”去重：

- 同一 url（或 finalUrl）同 entryIndex，且 hash 未变 → skip。
- hash 变 → 更新该 doc 并重建 artifacts。

（可选增强）：

- 对 url 进行 canonicalize（去掉 UTM、统一 trailing slash），以降低“同内容不同 url”重复；v0.1 可不做或只做轻量。

### 6. Cite/证据回链（新增能力）

#### 6.1 为什么需要 cite？

现状 `kb.search` 默认不返回全文 content（控 token），这非常正确；但写作/事实核对/引用时需要：

- **精确证据段**（例如某个 paragraph 的原文）
- **定位信息**（`sourceDoc`、`paragraphIndex`、`headingPath`）
- **短 quote**（<=200 字，供 UI 预览与审计）

因此需要 `kb.cite`/`kb.readSpan` 这种“窄而精确”的接口。

#### 6.2 工具设计（v0.1）

新增 Desktop 工具（`apps/desktop/src/agent/toolRegistry.ts`）：

- `kb.cite`

建议入参：

```ts
type CiteRequest = {
  libraryId?: string; // 可选；若不给，则从 artifact.sourceDocId 找 doc 再得 libraryId
  sourceDocId: string;
  anchor:
    | { kind: "paragraph"; paragraphIndex: number }
    | { kind: "headingPath"; headingPath: string[] }
    | { kind: "artifactId"; artifactId: string };
  maxChars?: number; // 默认 800~1200
  quoteMaxChars?: number; // 默认 200
};
```

返回：

```ts
type CiteResult = {
  ok: true;
  ref: {
    v: 1;
    libraryId: string;
    sourceDocId: string;
    importedFrom?: ImportedFrom;
    segmentId: string; // v0.1 可先填 artifactId 或 paragraphIndex 标识（见下）
    paragraphIndexStart: number | null;
    headingPath?: string[];
    quote: string; // <=200
  };
  content: string; // 截断后的证据段正文（<=maxChars）
  title?: string;
};
```

#### 6.3 `segmentId` 与定位策略（v0.1）

你们当前已有 `KbTextSpanRefV1.segmentId`，但没有看到“segment 切分实体”的硬落盘结构（segments 主要出现在 fingerprint 快照里）。

v0.1 方案（最小可用）：

- 若 cite 是按 `artifactId`：`segmentId = artifactId`
- 若 cite 是按 `paragraphIndex`：`segmentId = <sourceDocId>:p:<paragraphIndex>`
- `paragraphIndexStart`：
  - paragraph cite：填 `paragraphIndex`
  - headingPath cite：填 `null`（或找到该 heading 下第一段再填）

后续（v0.2）可升级为“真实 segmentId”（与 fingerprint 的 perSegment 打通）。

#### 6.4 `kb.search` 与 `kb.cite` 的配合方式

推荐的 Agent 使用范式（写作/事实）：

- 先 `kb.search` 拿 groups/hits（只含 snippet + anchor）
- 对选中的 hit 再调用 `kb.cite({ sourceDocId, anchor: {kind:"artifactId", artifactId} })`
- 最终在输出里引用 `ref`（可渲染为脚注/引用块）

### 7. 代码改造拆解（按文件/模块）

#### 7.1 Desktop：`apps/desktop/src/state/kbStore.ts`

新增/重构点：

- **T1 抽出 `ingestText()` 内核**
  - 复用 `importProjectFiles` 与 `importExternalFiles` 的共通逻辑
  - 统一：normalize → splitIntoEntries → 去重 → upsert doc → rebuild artifacts → saveDb
- **T2 新增 `importUrls(urls[])`**
  - 调 Gateway 抓取（复用已有 gatewayUrl/authHeader 模式）
  - 支持批量、失败不阻塞整体（统计 `skippedByReason/errors`）
  - 每 entry 落盘一次（延续断点续传）
- **T3 新增 `citeForAgent()` 内部方法**
  - 输入 `sourceDocId + anchor`，输出 `ref + content`
  - 做 `maxChars` 截断与 `quote` 截断

需要注意的边界：

- URL 抓取结果可能为空/非 HTML（Gateway 会标记 `extractedBy=not_html`），仍允许入库，但 format 可能为 `txt/unknown`。
- `facetIds` 过滤逻辑：现状对 paragraph/outline 不硬过滤（避免段落检索永远为空）；cite 也不应依赖 facet。

#### 7.2 Desktop：`apps/desktop/src/agent/toolRegistry.ts`

新增工具：

- **T4 新增 `kb.cite` 工具**
  - `riskLevel: low`
  - `applyPolicy: proposal`
  - `reversible: false`
  - 仅返回结构化结果，不写入

（可选）新增工具：

- `kb.importUrls`：如果你希望 Agent 也能触发“联网导入入库”（通常是 medium/high 风险：网络+写入）
  - v0.1 建议先不对 Agent 暴露（避免误触大量入库与费用/合规问题）

#### 7.3 Gateway：`apps/gateway/src/agent/serverToolRunner.ts`

v0.1 优先复用现有抓取能力：

- 如果当前已有对 Desktop 暴露的 `web.fetch`（或同等 endpoint），Desktop 可直接调用。
- 若没有合适的 endpoint，新增一个更窄的 endpoint（建议）：
  - `POST /api/kb/dev/fetch_url_for_ingest`
  - 入参：`{ url, timeoutMs?, maxChars? }`
  - 出参：`{ ok, url, finalUrl, title, extractedText, contentHash(sha256), fetchedAt, contentType, extractedBy }`

说明：

- 这个 endpoint 与 `web-search-v0.1.md` 的“可验证字段（url/fetchedAt/contentHash/extractedBy）”保持一致。

### 8. UI/交互（v0.1 最小）

v0.1 UI 只做必要入口（按你们产品节奏可选）：

- **KB 管理窗**新增一个“导入 URL”按钮：
  - 支持粘贴多行 URL
  - 显示导入结果：imported/skipped/errors（最多显示 N 条 sample）
- 或者先不做 UI，只保留内部函数 + 后续再接 UI。

### 9. 兼容性与迁移策略

- **不做强迁移**：`kb.v1.json` 继续兼容旧结构；新字段（如 `ImportedFrom.kind="url"`）按“可选字段”加入。
- **写坏 JSON 的容错**：延续现状 `loadDb` 的 bad-json 兜底策略，避免“库损坏导致不可用”。
- **向量缓存**：仍按 `KbArtifact.embeddings[model]` 存；URL 导入生成的 artifacts 也遵循同一缓存逻辑。

### 10. 风险点与对策

- **R1 URL 内容体量大**：对抓取结果做 `maxChars` 限制（Gateway 已有），Desktop 侧 entry 再控单 entry 的最大字符，避免 artifacts 爆炸。
- **R2 网页结构噪声**：v0.1 先接受“粗提取”；后续可升级 Readability/更强正文抽取，但不影响 ingest/cite 的接口。
- **R3 合规/版权**：v0.1 默认仅用户主动导入；审计字段（url/fetchedAt/contentHash）完整落盘，便于追溯。
- **R4 去重碰撞（fnv1a32）**：v0.1 不改；若后续遇到真实碰撞，再统一迁移到 sha256（增量策略即可）。

### 11. 测试计划（开工可执行）

#### 11.1 单元/脚本（建议优先）

- **S1 DB 读写回归**：参考 `scripts/regress-kb-m1.mjs / m2.mjs`，新增一个 `regress-kb-ingest-url.mjs`：
  - 输入：一个临时 kb.v1.json
  - 执行：模拟 URL 导入（可 mock Gateway 返回）
  - 断言：sourceDocs/artifacts 增长符合预期；重复导入不重复增长；更新导入会重建 artifacts

#### 11.2 手工回归（最小路径）

- **M1 导入 URL（单条/多条）**
- **M2 重复导入同 URL**：应显示 skipped duplicate
- **M3 URL 内容更新**：改 Gateway mock 返回 hash，导入后应更新 `updatedAt` 并重建 artifacts
- **M4 kb.search 能搜到 URL 导入的 paragraph/outline**
- **M5 kb.cite 能按 artifactId 拉到原文段，且 quote 截断正确**

### 12. 里程碑与交付物（建议 2 个小迭代）

#### Milestone A：统一 ingest 内核（不含 URL/cite）

- [ ] 抽 `ingestText` 并让 `importProjectFiles/importExternalFiles` 走同一内核
- [ ] 回归：现有导入与抽卡流程不回归

#### Milestone B：URL 导入 + cite

- [ ] Gateway 抓取接口复用/补齐
- [ ] Desktop 新增 `importUrls`
- [ ] Desktop 新增 `kb.cite` 工具 + `citeForAgent`
- [ ] 回归：kb.search→kb.cite 的写作引用闭环跑通

### 13. 需要你在开工前给的两个决策（不需要现在答，写在文档里便于对齐）

- **D1 URL 导入的 split 规则**：网页是否允许拆成多个 entry？如果拆，按什么规则（`---`、H2 分段、长度阈值）？
- **D2 URL canonicalize 策略**：是否要去掉 UTM 等参数（影响“同内容不同 url”的重复率）？

