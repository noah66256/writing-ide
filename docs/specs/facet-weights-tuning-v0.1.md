# Facet 维度提权：叙事视角 + 价值观 v0.1

> **日期**：2026-02-21
> **状态**：已落地

---

## 0. 问题

仿写"神似"需要两个关键维度，但在 `speech_marketing_v1` facet pack 中被严重低估：

### 0.1 叙事视角（narrative perspective）——缺失

- `narrative_structure`（叙事结构）覆盖的是段落/章节的组织方式，不是"从什么人称/立场/角度切入"
- `viewpoint_voice`（视角/叙述声音）仅在 `novel_v1`（小说包）中存在
- 结果：口播/营销场景下完全没有独立的叙事视角维度

### 0.2 价值观（values_embedding）——权重过低

- 仅在 `ending` 阶段为 essential（stageFit=1.0）
- 其余所有阶段 stageFit=0
- 不在 `defaultFacetPlan`（5 个默认维度）中
- 结果：除收尾阶段外，价值观几乎不可能进入 mustApply

---

## 1. 改动

### 1.1 新增 facet：`narrative_perspective`

**文件**：`apps/desktop/src/kb/facets.ts`

在 `speech_marketing_v1` 中 `narrative_structure` 之后插入：

```typescript
{ id: "narrative_perspective", label: "叙事视角" },
```

总维度从 21 → 22。

**文件**：`apps/gateway/src/index.ts`

`defaultFacetIds` 数组对应位置同步插入 `"narrative_perspective"`。

### 1.2 stageFacetWeightsV1 提权

**文件**：`apps/desktop/src/agent/gatewayAgent.ts:515-564`

| 阶段 | values_embedding | narrative_perspective |
|------|------------------|----------------------|
| opening | 不在→**supportive** | 新增→**supportive** |
| outline | 不在→**supportive** | 新增→**essential** |
| ending | essential（不变） | 新增→**supportive** |
| polish | 不变 | 不变 |
| draft/unknown | 不在→**essential** | 新增→**essential** |

draft/unknown 阶段 k 从 7 → 8。

### 1.3 pickFacetIdsV1 优先列表

**文件**：`apps/desktop/src/agent/gatewayAgent.ts:851`

优先列表从 6 项扩展为 8 项，加入 `narrative_perspective` 和 `values_embedding`。

注：Codex review 指出此函数当前为死代码（无调用点），改动不影响运行时但保持了意图一致性。

### 1.4 defaultFacetPlan

**文件**：`apps/desktop/src/state/kbStore.ts:4917-4923`

从 5 项扩展为 7 项：

```typescript
{ facetId: "values_embedding", why: "价值取向/判断框架" },
{ facetId: "narrative_perspective", why: "叙事人称/立场/视角选择" },
```

### 1.5 UI/Prompt 文案同步

"21+1" → "22+1"：

- `apps/desktop/src/components/CardJobsModal.tsx`（4 处）
- `apps/gateway/src/index.ts`（1 处 prompt）
- `packages/agent-core/src/skills.ts`（2 处 prompt，改为"全部维度"避免硬编码数字）

---

## 2. Codex Review 摘要

| # | 严重度 | 发现 | 处理 |
|---|--------|------|------|
| 1 | 中 | `pickFacetIdsV1` 是死代码 | 保留改动，保持意图一致 |
| 2 | 低 | opening 的 supportive 不会生效（essential=6, k=6） | 可接受，opening 阶段本就以钩子/提问/情绪为主 |
| 3 | 低 | 多处 "21 维" 文案不一致 | 已修复 |

---

## 3. 改动文件汇总

| 文件 | 改动 |
|------|------|
| `apps/desktop/src/kb/facets.ts` | 新增 narrative_perspective facet |
| `apps/gateway/src/index.ts` | defaultFacetIds + prompt 文案 |
| `apps/desktop/src/agent/gatewayAgent.ts` | stageFacetWeightsV1 + pickFacetIdsV1 |
| `apps/desktop/src/state/kbStore.ts` | defaultFacetPlan |
| `apps/desktop/src/components/CardJobsModal.tsx` | UI 文案 21→22 |
| `packages/agent-core/src/skills.ts` | prompt 文案 |
