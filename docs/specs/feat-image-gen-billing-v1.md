# feat: crab-image 图片生成按次+按分辨率计费

> 终点是 spec 文档，不写代码。

---

## 需求卡片

**场景**：用户通过 crab-image MCP 工具生成/编辑图片，需要按次+按分辨率扣积分
**目标**：生图成功自动扣费，admin 后台可配置价格，两个模型注册到 DB
**价格档位**（元/次）：512→0.662、1K→0.993、2K→0.993、4K→1.773
**约束**：Gateway 侧扣费；不破坏现有 token 计费；crab-image 返回不含分辨率，需从参数推断

---

## 现状分析

### 计费链路

- token 计费：`chargeUserForLlmUsage()` → `calculateCostCny()` → `adjustUserPoints()`
- 按次计费先例：web.search 的 `billPointsPerSearch`（直接扣固定积分，不走 token 体系）
- `adjustUserPoints(userId, delta, type, reason)` 是通用扣费函数，可直接复用

### 图片分辨率的判定

- crab-image 的 `generate_image` 返回**不含** width/height（只有 base64 data）
- **但 Gateway 能拿到工具调用参数**：`toolCallSnapshots` 中有 `snap.args`，包含 `aspectRatio`
- crab-image 默认输出分辨率约 1024px 短边（Gemini 图片模型的默认行为）
- 没有显式 `resolution` / `size` 参数，所以**按固定档位计费最合理**——默认 1K

### 分辨率 → 档位映射策略

由于 crab-image 不支持指定输出分辨率（Gemini 图片模型固定输出约 1K），**v1 直接按 1K 档固定计费**，不做分辨率推断。

后续如果 crab-image 支持分辨率参数，再扩展到多档位。

---

## 实施方案

### P0-1: DB 层——AiModel 加图片计费字段

**文件**：`apps/gateway/src/db.ts`

在 `AiModel` 类型（L157）新增：

```typescript
/** 图片生成按次计费：积分/次（null=不按次计费） */
imageGenBillPointsPerCall?: number | null;
```

**设计决策**：
- 不用 `imageGenPricing` 嵌套对象（过度设计），v1 只有一个固定单价
- 字段名仿照 `billPointsPerSearch` 的命名风格
- 积分单位（不是元），和 web.search 一致，admin 直接填积分数
- 换算：1K 档 ¥0.993 × 1000积分/元 ≈ 993 积分/次

---

### P0-2: billing.ts——新增图片计费函数

**文件**：`apps/gateway/src/billing.ts`

新增函数（不改现有 token 函数）：

```typescript
/**
 * 计算图片生成应扣积分
 * v1: 固定按次，直接返回 imageGenBillPointsPerCall
 */
export function calculateImageGenPoints(args: {
  billPointsPerCall: number;
}): number {
  return Math.max(0, Math.ceil(args.billPointsPerCall));
}
```

---

### P0-3: Gateway 扣费触发点——tool_execution_end

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

在 `tool_execution_end`（L3884）处理 crab-image 成功结果时扣费。

**触发条件**：
1. 工具名匹配 `mcp.crab-image.generate_image` 或 `mcp.crab-image.edit_image`
2. `result.ok === true`
3. 模型配置了 `imageGenBillPointsPerCall > 0`

**扣费流程**：
```
tool_execution_end + crab-image + ok
  → 查找图片模型配置（根据 crab-image MCP server 使用的 Gemini 模型）
  → 读取 imageGenBillPointsPerCall
  → 调用 adjustUserPoints(userId, -points, "consume", "image_gen:{toolName}")
  → 累加到 audit.chargedPoints
```

**关键问题：怎么找到图片模型配置？**

crab-image MCP server 内部使用的模型（如 `gemini-3-pro-image-preview`）在 DB 中有独立记录。扣费时需要知道用的是哪个模型。

方案：从 `toolCallSnapshots` 的 `snap.args` 中读取 `model` 参数（crab-image 的 generate_image 接受 `model` 参数），然后查 DB。

如果 args 中没有 model，fallback 到 `gemini-3-pro-image-preview`（默认模型）。

---

### P0-4: Gateway index.ts——新增 chargeUserForImageGen 函数

**文件**：`apps/gateway/src/index.ts`

仿照 `chargeUserForLlmUsage()`，新增：

```typescript
async function chargeUserForImageGen(args: {
  userId: string;
  modelId: string;         // 图片模型 ID（如 gemini-3-pro-image-preview）
  toolName: string;        // generate_image / edit_image
  source: string;          // "run:{runId}"
}): Promise<{ ok: boolean; chargedPoints?: number }> {
  const pricing = await getModelPricing(args.modelId);
  const billPoints = pricing?.imageGenBillPointsPerCall;
  if (!billPoints || billPoints <= 0) return { ok: true, chargedPoints: 0 };

  const result = await adjustUserPoints(args.userId, -billPoints, "consume",
    `image_gen:${args.toolName}:${args.modelId}`);
  return { ok: true, chargedPoints: billPoints };
}
```

需要把这个函数暴露给 GatewayRuntime（通过 RunContext 或 fastify 实例注入）。

---

### P0-5: Admin API——新增/更新模型 schema 加 imageGenBillPointsPerCall

**文件**：`apps/gateway/src/index.ts`

- `POST /api/ai-config/models`（L3417）：schema 加 `imageGenBillPointsPerCall: z.number().min(0).nullable().optional()`
- `PUT /api/ai-config/models/:id`（L3471）：同上

---

### P0-6: Admin UI——LlmPage 加图片价格输入

**文件**：`apps/admin-web/src/pages/LlmPage.tsx`

- 新增模型表单：加 `imageGenBillPointsPerCall` 输入框（"图片生成扣积分/次"）
- 编辑模型表单：同上
- 模型列表：如果 `imageGenBillPointsPerCall > 0`，显示 tag "图片: {n}积分/次"

---

### P0-7: 注册两个生图模型

通过 admin API 注册（或直接 seed）：

| 字段 | gemini-3-pro-image-preview | gemini-3.1-flash-image-preview |
|------|---------------------------|-------------------------------|
| model | gemini-3-pro-image-preview | gemini-3.1-flash-image-preview |
| providerId | gemini | gemini |
| baseURL | （复用现有 Gemini 模型的） | 同左 |
| endpoint | （复用） | 同左 |
| apiKey | （复用现有 Gemini 的 Key） | 同左 |
| priceInCnyPer1M | 0 | 0 |
| priceOutCnyPer1M | 0 | 0 |
| imageGenBillPointsPerCall | 993 | 993 |
| isEnabled | true | true |
| description | Gemini 图片生成 Pro | Gemini 图片生成 Flash |

---

## 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| AiModel 加可选字段 | DB 读写 | 低：字段可选，null 时不影响 | 旧记录 null 不扣费 |
| tool_execution_end 加扣费 | 每次 crab-image 调用 | 中：扣费失败不应阻塞工具结果 | try-catch 包裹，失败只记日志 |
| chargeUserForImageGen | 新函数 | 低：独立于 token 计费 | 不改 chargeUserForLlmUsage |
| Admin schema 加字段 | API 请求 | 低：可选字段 | — |
| LlmPage UI | admin 前端 | 低：加输入框 | — |

---

## 验证 Checklist

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| generate_image 成功 | 扣 993 积分 | 查积分流水 |
| edit_image 成功 | 扣 993 积分 | 查积分流水 |
| generate_image 失败（429） | 不扣费 | 查积分不变 |
| 模型未配 imageGenBillPointsPerCall | 不扣费 | — |
| 用户积分不足 | 图片仍生成（v1 不阻断），积分变负 | 后续版本加预检 |
| admin 设置价格 | DB 中 imageGenBillPointsPerCall 正确存储 | admin 页面刷新确认 |

---

## 实施优先级

1. **P0**（必须）：DB 字段 + billing 函数 + Gateway 扣费 + Admin API/UI
2. **P1**（后续）：多分辨率档位（等 crab-image 支持分辨率参数后）
3. **P2**（后续）：积分不足时阻断生图（需要 pre-check 机制）

---

## 涉及文件清单

| 文件 | 改动类型 |
|------|---------|
| `apps/gateway/src/db.ts` | AiModel 加字段 |
| `apps/gateway/src/billing.ts` | 新增 calculateImageGenPoints |
| `apps/gateway/src/index.ts` | chargeUserForImageGen + admin API schema |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | tool_execution_end 扣费触发 |
| `apps/gateway/src/aiConfig.ts` | getModelPricing 返回新字段 |
| `apps/admin-web/src/api/gateway.ts` | 类型加字段 |
| `apps/admin-web/src/pages/LlmPage.tsx` | UI 加输入框 |
