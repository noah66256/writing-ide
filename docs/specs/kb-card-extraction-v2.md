# KB 抽卡增强 v2（spec）

> 目标：让抽出的卡片能支撑"像同一个人写的不同东西"——核心是角度、价值观、叙事人称这些"灵魂维度"的覆盖率，而非只抽表面要素（开头/金句/结尾）。

## 1. 现状问题

### 1.1 维度覆盖不均

以"李叔"库（58 篇，776 卡）为例：

| 维度 | 卡片数 | 评价 |
|------|--------|------|
| rhetoric（修辞手法） | 215 | 过剩 |
| persuasion（说服力构建） | 214 | 过剩 |
| values_embedding（价值观植入） | 176 | 充足 |
| one_liner_crafting（金句制造） | 171 | 充足 |
| opening_design（开场设计） | 110 | 充足 |
| **narrative_perspective（叙事视角）** | **0** | **完全缺失** |
| intro（引言） | 3 | 极少 |
| topic_selection（话题选择） | 6 | 极少 |
| special_markers（特殊文本标记） | 7 | 极少 |

**根因**：LLM 抽卡提示词里 facetId 是让模型"从 22 个里选 1-3 个"，模型倾向于选高频、显性维度（rhetoric/persuasion），忽略隐性维度（narrative_perspective/topic_selection）。

### 1.2 "灵魂维度"提取缺失

当前 doc_v2 模式的 cardType 是 `hook|thesis|ending|one_liner|outline|other`——全是**文本结构位置**，没有**语义功能**维度：

- **叙事视角**：这个人习惯用第几人称？旁观者还是参与者？上帝视角还是平视？
- **价值观框架**：这个人怎么判断事物好坏？什么是他的底层逻辑？
- **话题选择倾向**：这个人倾向聊什么类型的话题？怎么切入？
- **共鸣策略**：用什么方式建立共鸣？自嘲？反差？共同体验？

这些维度是"像不像同一个人"的根源，但当前抽卡不会专门抽它们。

### 1.3 抽卡配额一刀切

所有库都用：outline(1) + hook(3) + thesis(3) + ending(3) + one_liner(12) + other(6) = 28 张/文档。

- 口播短视频（300-800字）：28张太多，大量重复
- 长文（3000字+）：28张太少，很多段落被忽略
- 纯金句集/语录：不适合 hook/thesis/ending 分类

### 1.4 单次抽卡无维度补全

一次 LLM 调用抽完所有卡。如果某个维度被漏了（如 narrative_perspective），后续没有机制发现和补全。

## 2. 设计方案

### 2.1 两阶段抽卡

```
Stage 1: 结构抽卡（现有流程，略微调整）
    ↓ 产出 hook/thesis/ending/one_liner/outline 卡
    ↓ 同时统计 facetId 覆盖情况

Stage 2: 维度补全抽卡（新增）
    ↓ 针对 Stage 1 中覆盖为 0 或极少的维度
    ↓ 用专门的提示词从原文中提取该维度的证据
    ↓ 产出 cardType=facet_evidence 的补全卡
```

### 2.2 Stage 1 改进：结构抽卡

**改进 1：自适应配额**

```typescript
function computeQuota(docCharCount: number, purpose: string) {
  if (purpose === "style") {
    if (docCharCount < 500) return { hook: 1, thesis: 1, ending: 1, one_liner: 4, outline: 0, other: 2 };
    if (docCharCount < 1500) return { hook: 2, thesis: 2, ending: 2, one_liner: 8, outline: 1, other: 4 };
    return { hook: 3, thesis: 3, ending: 3, one_liner: 12, outline: 1, other: 6 };
  }
  // material/product 库可以有不同配额
}
```

**改进 2：facetId 提示词增强**

当前提示词：
```
facetIds: string[]（必填：从以下枚举里选 1-3 个；不要编造新的）
```

改为带权重提示：
```
facetIds: string[]（必填：从以下枚举里选 1-3 个）

特别注意以下"灵魂维度"——即使段落主题是其他方面，也要检查是否隐含了这些维度：
- narrative_perspective（叙事视角）：用了什么人称？旁观者/参与者/对话？
- values_embedding（价值观植入）：有没有隐含"什么是对的/错的/重要的"判断？
- topic_selection（话题选择）：选题角度本身是不是一种风格特征？
- resonance（引人共鸣）：用了什么共鸣策略？自嘲/反差/共情？
```

**改进 3：每张卡支持多 facetId（当前已支持 1-6 个，但提示词只鼓励 1-3 个）**

允许模型为一张卡标注更多维度。一段好的开头可能同时是 `opening_design` + `narrative_perspective` + `values_embedding`。

### 2.3 Stage 2 新增：维度补全抽卡

在 Stage 1 完成后，检查库内所有维度的覆盖情况：

```typescript
function findUnderCoveredFacets(library: KbLibrary, allArtifacts: KbArtifact[]): string[] {
  const facetCounts = new Map<string, number>();
  for (const a of allArtifacts) {
    for (const fid of a.facetIds ?? []) {
      facetCounts.set(fid, (facetCounts.get(fid) ?? 0) + 1);
    }
  }
  const pack = getFacetPack(library.facetPackId);
  const threshold = Math.max(3, Math.floor(allArtifacts.length * 0.02)); // 至少 3 张或总量的 2%
  return pack.facets
    .filter(f => (facetCounts.get(f.id) ?? 0) < threshold)
    .map(f => f.id);
}
```

对每个欠缺维度，发起**专项抽卡请求**：

```
你是写作 IDE 的「维度专项抽卡器」。

目标维度：narrative_perspective（叙事视角）
维度定义：作者习惯使用的叙事人称、视角选择、立场表态方式。
  - 第一人称 vs 第三人称 vs 混合
  - 旁观者评论 vs 亲历者讲述 vs 对话式
  - 上帝视角 vs 平视 vs 仰视

请从以下段落中提取该维度的证据。每条证据包含：
1. 原文片段（quote，≤80字）
2. 该片段体现的视角特征（1句话）
3. 段落索引

输出格式：JSON 数组
[{
  "quote": "原文片段",
  "trait": "特征描述",
  "paragraphIndices": [0, 1],
  "facetIds": ["narrative_perspective"]
}]
```

产出的证据直接生成 `cardType=facet_evidence` 的卡片存入库。

### 2.4 新增 cardType：facet_evidence

| cardType | 用途 | 产出阶段 |
|----------|------|---------|
| hook | 开头钩子 | Stage 1 |
| thesis | 核心观点 | Stage 1 |
| ending | 结尾收束 | Stage 1 |
| one_liner | 金句 | Stage 1 |
| outline | 结构大纲 | Stage 1 |
| other | 其他 | Stage 1 |
| **facet_evidence** | **维度证据（专项补全）** | **Stage 2** |
| playbook_facet | 仿写手册（按维度聚合） | 手册生成 |
| style_profile | 风格档案（库级） | 手册生成 |
| cluster_rules_v1 | 簇规则 | 指纹计算 |
| final_polish_checklist | 终稿检查清单 | 手册生成 |

### 2.5 灵魂维度的特殊处理

对以下 4 个"灵魂维度"做特殊提取，因为它们不是段落级的，而是贯穿全文的：

| 维度 | 提取方式 | 输出格式 |
|------|---------|---------|
| **narrative_perspective** | 统计全文人称分布 + LLM 总结视角模式 | `{ personDistribution, viewpointPattern, evidence[] }` |
| **values_embedding** | LLM 从论点/判断句中提取价值框架 | `{ coreValues[], judgmentPatterns[], evidence[] }` |
| **topic_selection** | 统计话题关键词分布 + LLM 总结选题偏好 | `{ topicClusters[], entryAnglePatterns[], evidence[] }` |
| **resonance** | LLM 识别共鸣策略类型 | `{ strategies[], emotionalHooks[], evidence[] }` |

这些提取结果存为 `cardType=facet_evidence` 的卡片，并在手册生成时作为 `playbook_facet` 的重要素材。

### 2.6 重新抽卡（Re-extract）

对已有库支持"重新抽卡"：
- 保留原始 sourceDocs 和 paragraph artifacts
- 删除旧 card artifacts
- 用新的两阶段流程重新抽卡
- 生成 diff 报告：新增/删除/变更的卡片数量

```typescript
interface ReExtractResult {
  added: number;
  removed: number;
  facetCoverageBeforeAfter: Record<string, [number, number]>;
  newlyFilledFacets: string[]; // 之前为 0 现在有值的维度
}
```

## 3. 实现路径

### P0：提示词增强（最小改动，立即生效）

- [ ] 修改 Gateway `/api/kb/dev/extract_cards` 的 doc_v2 提示词：增加灵魂维度提示
- [ ] facetId 选择从 "1-3 个" 放宽到 "1-5 个"
- [ ] 在提示词中加入 facetId 定义说明（当前只给了 ID，模型不知道 narrative_perspective 具体指什么）

### P1：自适应配额

- [ ] 根据文档字数和库用途动态计算 cardType 配额
- [ ] 在 Desktop extractCardsForDocs 中实现

### P2：维度补全（Stage 2）

- [ ] Gateway 新增 `/api/kb/dev/extract_facet_evidence` 端点
- [ ] Desktop extractCardsForDocs 完成后检查维度覆盖
- [ ] 对欠缺维度发起专项抽卡
- [ ] 新增 `cardType=facet_evidence`

### P3：灵魂维度特殊提取

- [ ] narrative_perspective 统计 + LLM 总结
- [ ] values_embedding 价值框架提取
- [ ] topic_selection 选题偏好提取
- [ ] resonance 共鸣策略识别
- [ ] 结果存为 facet_evidence 卡片

### P4：重新抽卡

- [ ] Desktop UI 添加"重新抽卡"按钮
- [ ] 实现 re-extract 逻辑（保留 sourceDocs，重新抽卡）
- [ ] 生成 diff 报告

## 4. 影响范围

| 文件 | 改动 |
|------|------|
| `apps/gateway/src/index.ts` | extract_cards 提示词增强 + 新增 extract_facet_evidence 端点 |
| `apps/desktop/src/state/kbStore.ts` | extractCardsForDocs 配额自适应 + Stage 2 调用 + re-extract |
| `apps/desktop/src/kb/facets.ts` | 可能需要为每个 facetId 增加描述文本 |
| `packages/agent-core/src/runMachine.ts` | isStyleExampleKbSearch 可能需要识别 facet_evidence 卡 |

## 5. 验收标准

- 重新抽卡后，22 个维度中 0 覆盖的维度不超过 1 个
- narrative_perspective 维度至少有 5 张 facet_evidence 卡
- values_embedding 维度至少有 10 张卡
- lint.style 评判时 missingDimensions 能实际减少（依赖门禁修复已完成）
