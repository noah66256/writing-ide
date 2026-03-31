# feat: 绘图多图上下文 + B喂法 role 系统 + imageSize 修复

> spec 版本：v1 | 状态：待实施 | 优先级：P0 全量

---

## 需求概述

### 需求卡片

**场景**：用户上传多张图片（如图A=人物、图B=衣服），要求"给图A穿上图B衣服，其余严格不动"
**目标**：
1. 系统能识别当前轮所有上传图片（图1/图2/.../图N），而不是只取最后一张
2. 每张参考图有明确的语义角色（identity/outfit/scene 等），模型知道哪张是人哪张是衣服
3. 参考图上限明确（≤12张），输出尺寸可控（imageSize: 1K/2K/4K）
4. 向后兼容：不传 roles 时退化为匿名参考图（现有行为）

**对标**：`packages/skills-vectorengine/src/index.ts`（ai-manju，同一供应商同一端点，B喂法 + role 系统已验证）
**约束**：不改变 Gateway 侧逻辑；不改变工具外部接口签名（schema 只增不删）

---

## 现状分析

### 相关文件

| 文件 | 职责 | 改动性质 |
|------|------|---------|
| `apps/desktop/electron/mcp-servers/crab-image.mjs` | Gemini 请求构建、工具注册 | 主要改动（B喂法、imageSize、上限） |
| `apps/desktop/src/agent/wsTransport.ts` | Desktop 端工具参数构建 | 主要改动（多图枚举、roles 透传） |

### 现有缺陷（精确定位）

| # | 缺陷 | 精确位置 | 现象 |
|---|------|---------|------|
| 1 | 只取最后一张用户图 | `wsTransport.ts:236–247` | 上传4张只注入第4张 |
| 2 | 参考图无语义标签 | `crab-image.mjs:226–227` | 模型猜哪张是人哪张是衣服 |
| 3 | 缺 `imageSize` 参数 | `crab-image.mjs:244–247` | 输出尺寸不可控 |
| 4 | `responseModalities` 含 TEXT | `crab-image.mjs:245` | 纯图生成场景干扰输出判断 |
| 5 | 无参考图数量上限 | `buildCrabImageToolArgs` 调用处 | 超14张行为未定义 |
| 6 | `referenceCount` 算法不准 | `crab-image.mjs:229–234`（B喂法后） | B喂法插入文本后每张图被算成2个 part |

### 已有设施（可复用，不重造）

- `resolveImageToken`：已支持 `artifact:id` / `last_user_image` / data URL / 绝对路径
- `ThreadImageSessionV1.recentArtifacts`：已记录最近24张生成图路径
- `chooseProviderTier`：已有 `referenceCount >= 2` → pro 升档逻辑（修复 referenceCount 后自动受益）

---

## 调研摘要

**对标：ai-manju `VectorEngineGeminiKeyframeSkill`（`packages/skills-vectorengine/src/index.ts`）**

| 维度 | ai-manju 做法 | 我们现有 | 差距 |
|------|-------------|---------|------|
| 参考图传递 | `referenceImagePaths: string[]`，最多12张 | `referenceImages: string[]`，无上限 | 缺上限 |
| 语义角色 | `referenceImageRoles: string[]`，B喂法文本标注 | 无 | 缺整套 |
| B喂法格式 | `{text: "Image{i} role={r}：{指令性描述}"}` + `{inlineData}` | 只有 `{inlineData}` | 缺文本标注 |
| imageSize | `"1K"\|"2K"\|"4K"`，按长边推算，写入 `imageConfig` | 缺失 | 缺 |
| responseModalities | `["IMAGE"]` | `["TEXT", "IMAGE"]` | 多余 TEXT |
| 端点 | `api.vectorengine.ai/v1beta/models/{model}:generateContent` | 同 | 一致 ✓ |

**结论**：B喂法 + role 系统在同一供应商已验证有效，直接移植。

---

## 实施方案

### 改动 A（P0）：`wsTransport.ts` — 新增 `findAllUserImagesInCurrentTurn`

**文件**：`apps/desktop/src/agent/wsTransport.ts`
**位置**：L234（`findLatestUserImageSource` 定义处）
**原理**：把"取最后一张图"改为"取当前轮最后一个含图 user step 的全部图片"，旧函数保留作兼容 shim

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@ -234,15 +234,26 @@ function normalizeThreadImageSession(session: unknown): ThreadImageSessionV1 | n
   };
 }

-function findLatestUserImageSource(rt: ReturnType<typeof createRunTarget>): { kind: "data"; dataUrl: string } | null {
+function findAllUserImagesInCurrentTurn(rt: ReturnType<typeof createRunTarget>): Array<{ kind: "data"; dataUrl: string }> {
   const steps = Array.isArray(rt.getSteps?.()) ? rt.getSteps() : [];
   for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
     const step = steps[stepIndex] as any;
     if (!step || step.type !== "user" || !Array.isArray(step.images) || step.images.length === 0) continue;
-    for (let imageIndex = step.images.length - 1; imageIndex >= 0; imageIndex -= 1) {
-      const image = step.images[imageIndex];
-      const mediaType = String(image?.mediaType ?? "").trim() || "image/png";
-      const data = String(image?.data ?? "").trim();
-      if (!data) continue;
-      return { kind: "data", dataUrl: `data:${mediaType};base64,${data}` };
-    }
+    const images = step.images
+      .map((image: any) => {
+        const mediaType = String(image?.mediaType ?? "").trim() || "image/png";
+        const data = String(image?.data ?? "").trim();
+        if (!data) return null;
+        return { kind: "data" as const, dataUrl: `data:${mediaType};base64,${data}` };
+      })
+      .filter(Boolean) as Array<{ kind: "data"; dataUrl: string }>;
+    if (images.length > 0) return images;
   }
+  return [];
+}
+
+function findLatestUserImageSource(rt: ReturnType<typeof createRunTarget>): { kind: "data"; dataUrl: string } | null {
+  const images = findAllUserImagesInCurrentTurn(rt);
+  return images.length > 0 ? images[images.length - 1] ?? null : null;
 }
```

**边界情况**：
- 用户未上传图片 → 返回 `[]`，不影响后续逻辑
- 只有旧轮有图、当前轮无图 → 返回 `[]`（正确：不跨轮污染）
- 旧调用方 `findLatestUserImageSource` 行为不变（shim 取最后一张）

---

### 改动 B（P0）：`wsTransport.ts` — `buildCrabImageToolArgs` 多图注入 + roles 透传

**文件**：`apps/desktop/src/agent/wsTransport.ts`
**位置**：L319（`buildCrabImageToolArgs` 内 `rawReferenceImages` 处理段）
**原理**：referenceImages 为空时注入当前轮全部图（≤12）；rawArgs 中的 referenceImageRoles 透传到 nextArgs

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@ -319,13 +319,21 @@ function buildCrabImageToolArgs(args: {
   const rawReferenceImages = Array.isArray(args.rawArgs?.referenceImages)
     ? (args.rawArgs.referenceImages as unknown[])
     : [];
+  const rawReferenceImageRoles = Array.isArray(args.rawArgs?.referenceImageRoles)
+    ? (args.rawArgs.referenceImageRoles as unknown[]).map((item) => String(item ?? "").trim()).filter(Boolean)
+    : [];
+  if (Array.isArray(args.rawArgs?.referenceImageRoles)) {
+    if (rawReferenceImageRoles.length > 0) nextArgs.referenceImageRoles = rawReferenceImageRoles;
+    else delete nextArgs.referenceImageRoles;
+  }
   const resolvedReferenceImages = rawReferenceImages
     .map((item) => resolveImageToken({ token: item, rt: args.rt, imageSession }))
     .filter(Boolean);

   if (args.toolName === "mcp.crab-image.generate_image") {
-    if (resolvedReferenceImages.length === 0) {
-      const userImage = findLatestUserImageSource(args.rt);
-      if (userImage) resolvedReferenceImages.push(userImage);
-    }
+    if (resolvedReferenceImages.length === 0) {
+      const userImages = findAllUserImagesInCurrentTurn(args.rt).slice(0, 12);
+      if (userImages.length > 0) resolvedReferenceImages.push(...userImages);
+    }
     const useThreadHistory = Boolean((args.rawArgs as any)?.useThreadHistory);
     if (useThreadHistory && resolvedReferenceImages.length === 0) {
```

**边界情况**：
- 模型已显式传 `referenceImages` → 不触发自动注入（`resolvedReferenceImages.length > 0`）
- 模型传了空 `referenceImageRoles: []` → `delete nextArgs.referenceImageRoles`，不下传脏值
- `edit_image` 分支不受影响（条件判断 `toolName === generate_image`）

---

### 改动 C（P0）：`crab-image.mjs` — schema 扩展

**文件**：`apps/desktop/electron/mcp-servers/crab-image.mjs`
**位置**：L307（`generateImageInputSchema` 定义处）
**原理**：新增两个可选字段，向后兼容（`.passthrough()` 已覆盖未知字段）

```diff
--- a/apps/desktop/electron/mcp-servers/crab-image.mjs
+++ b/apps/desktop/electron/mcp-servers/crab-image.mjs
@@ -307,9 +307,11 @@ const generateImageInputSchema = z.object({
   prompt: z.string().describe("图片生成提示词"),
   aspectRatio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]).optional().describe("画面比例"),
+  size: z.string().optional().describe('输出尺寸，格式 "WxH"，如 "2048x2048"，默认 2048x2048'),
   quality: z.enum(["auto", "fast", "high"]).optional().describe("质量档位"),
   useThreadHistory: z.boolean().optional().describe("是否优先继承当前线程图片历史"),
   referenceImages: z.array(z.string()).optional().describe("参考图引用，如 last_generated / last_user_image / artifact:<id>"),
+  referenceImageRoles: z.array(z.string()).optional().describe("与 referenceImages 对齐的角色标签，如 identity / outfit / scene / scene_plate / outfit_plate 等"),
 }).passthrough();
```

---

### 改动 D（P0）：`crab-image.mjs` — B喂法 + describeRole

**文件**：`apps/desktop/electron/mcp-servers/crab-image.mjs`
**位置**：L140（`sourceToPart` 之后）
**原理**：新增 `describeRole` 函数（使用指令性描述，参照 ai-manju 风格）；修改 `normalizeResolvedImages` 使其返回 `(text|inlineData)[]` 交错 parts

> **注意**：`describeRole` 的描述必须用**指令性**语气（"以此图为准，禁止..."），而非描述性语气，才能有效约束 Gemini。这是 ai-manju 验证过的关键。

```diff
--- a/apps/desktop/electron/mcp-servers/crab-image.mjs
+++ b/apps/desktop/electron/mcp-servers/crab-image.mjs
@@ -140,35 +140,89 @@ async function sourceToPart(source) {
   return null;
 }

+function normalizeReferenceImageRole(value) {
+  return String(value ?? "").trim().toLowerCase() || "reference";
+}
+
+function describeRole(role) {
+  const r = normalizeReferenceImageRole(role);
+  if (r === "identity_plate")
+    return "身份底板锁：人物结构/轮廓/比例/视角严格以此图为准；锁定发型与体态，不要重构成别的人；禁止左右翻转/禁止镜像。";
+  if (r === "identity" || r.startsWith("identity_"))
+    return "身份锁：必须是同一人物（脸型/五官比例/肤色/年龄感一致）。";
+  if (r === "outfit_plate")
+    return "服装底板锁：服装结构/版型/材质质感/配色以此图为准；不要随意换款式或加外套；禁止把服装换成别的款式。";
+  if (r === "outfit" || r.startsWith("outfit_"))
+    return "服装锁：衣服款式/材质/配色以此图为准，只允许调整穿着角度，不得换成其他服装。";
+  if (r === "scene_plate")
+    return "场景底板锁（极强）：背景空间几何/透视/机位/楼梯走向/墙面分色/灯具位置严格以此图为准；禁止新增/删除/移动任何背景元素；禁止左右翻转。";
+  if (r === "scene" || r.startsWith("scene_"))
+    return "场景锁：背景结构/透视/机位方向以此图为准；不要发散成别的地点；不要新增路人；不要左右翻转。";
+  if (r === "hand_prop" || r.startsWith("hand_prop_"))
+    return "手持道具锁：该道具必须出现在对应角色手中，不得消失/不得互换/不得被别人拿走。";
+  if (r === "set_prop" || r.startsWith("set_prop_"))
+    return "场景道具锁：桌面/锚点道具必须出现且位置一致。";
+  if (r === "layout_guide")
+    return "构图引导（仅约束，不可见）：生成时按此图构图放置元素，但最终成片严禁出现线框/示意图残留。";
+  if (r === "prop" || r.startsWith("prop_"))
+    return "道具锁：该道具必须出现且外观一致。";
+  return "通用参考图：用于补充风格/材质/构图等信息。";
+}
+
 async function normalizeResolvedImages(args) {
+  const rawRoles = Array.isArray(args?.referenceImageRoles) ? args.referenceImageRoles : [];
   const resolvedRefs = Array.isArray(args?.resolvedReferenceImages) ? args.resolvedReferenceImages : [];
-  const out = [];
-  for (const item of resolvedRefs) {
-    const part = await sourceToPart(item);
-    if (part) out.push(part);
-  }
-  if (out.length > 0) return out;
-
-  const rawRefs = Array.isArray(args?.referenceImages) ? args.referenceImages : [];
-  for (const ref of rawRefs) {
-    const value = trim(ref);
-    if (!value) continue;
-    if (isAbsolutePathLike(value)) {
-      out.push({ inlineData: await fileToInlineData(value) });
-      continue;
-    }
-    const parsed = parseDataUrl(value);
-    if (parsed) out.push({ inlineData: parsed });
+  const collected = [];
+
+  const push = (part, role) => { if (part) collected.push({ part, role: normalizeReferenceImageRole(role) }); };
+
+  for (let i = 0; i < resolvedRefs.length; i++) {
+    push(await sourceToPart(resolvedRefs[i]), rawRoles[i]);
   }
-  return out;
+
+  if (collected.length === 0) {
+    const rawRefs = Array.isArray(args?.referenceImages) ? args.referenceImages : [];
+    for (let i = 0; i < rawRefs.length; i++) {
+      const value = trim(rawRefs[i]);
+      if (!value) continue;
+      if (isAbsolutePathLike(value)) { push({ inlineData: await fileToInlineData(value) }, rawRoles[i]); continue; }
+      const parsed = parseDataUrl(value);
+      if (parsed) push({ inlineData: parsed }, rawRoles[i]);
+    }
+  }
+
+  if (collected.length > 12) {
+    console.error(`[crab-image] referenceImages truncated: received=${collected.length}, kept=12`);
+  }
+
+  // B喂法：每张参考图前插入角色说明文本
+  return collected.slice(0, 12).flatMap(({ part, role }, index) => [
+    { text: `Image${index + 1} role=${role}：${describeRole(role)}` },
+    part,
+  ]);
 }
```

**关键连锁**：`normalizeResolvedImages` 返回类型从 `{inlineData}[]` 变为 `({text}|{inlineData})[]`。调用方 `requestParts = [...referenceParts, { text: prompt }]`（L226）**不需要修改**，因为 Gemini parts 本来就是混合数组。但 `referenceCount` 的计算必须同步修复（见改动 E）。

---

### 改动 E（P0）：`crab-image.mjs` — imageSize + responseModalities + referenceCount 修复

**文件**：`apps/desktop/electron/mcp-servers/crab-image.mjs`
**位置**：L177（`normalizeTargetImage` 之后）及 L223（`geminiGenerateImage` 内部）

```diff
--- a/apps/desktop/electron/mcp-servers/crab-image.mjs
+++ b/apps/desktop/electron/mcp-servers/crab-image.mjs
@@ -177,6 +177,20 @@ async function normalizeTargetImage(args) {
   return parsed ? { inlineData: parsed } : null;
 }

+function parseSizeToWH(value) {
+  const raw = trim(value) || "2048x2048";
+  const match = raw.match(/^(\d{2,5})\s*[xX]\s*(\d{2,5})$/);
+  if (!match) return { width: 2048, height: 2048 };
+  const w = Number(match[1]); const h = Number(match[2]);
+  return (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) ? { width: w, height: h } : { width: 2048, height: 2048 };
+}
+
+function pickGeminiImageSizeByLongEdge(width, height) {
+  const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
+  if (longEdge > 2816) return "4K";
+  if (longEdge > 1408) return "2K";
+  return "1K";
+}
+
 function collectTextParts(response) {
```

```diff
@@ -223,15 +237,23 @@ async function geminiGenerateImage(args) {

   const referenceParts = await normalizeResolvedImages(args);
+  // B喂法后 referenceParts 是 text+inlineData 交错数组，只统计 inlineData 数量
+  const referenceImageCount = referenceParts.filter(
+    (p) => p && typeof p === "object" && "inlineData" in p
+  ).length;
   const requestParts = [...referenceParts, { text: prompt }];
   const aspectRatio = normalizeAspectRatio(args.aspectRatio);
+  const { width, height } = parseSizeToWH(args.size);
+  const imageSize = pickGeminiImageSizeByLongEdge(width, height);
   const tier = chooseProviderTier({
     quality: args.quality,
     defaultTier: config.defaultTier,
     prompt,
-    referenceCount: referenceParts.length,
+    referenceCount: referenceImageCount,
   });
   const modelName = resolveModelName(config, tier);
   const url = buildGenerateContentUrl(config.baseUrl, modelName, config.apiKey);
   const body = {
     contents: [{ role: "user", parts: requestParts }],
     generationConfig: {
-      responseModalities: ["TEXT", "IMAGE"],
-      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
+      responseModalities: ["IMAGE"],
+      imageConfig: {
+        imageSize,
+        ...(aspectRatio ? { aspectRatio } : {}),
+      },
     },
   };
```

```diff
@@ -266,7 +288,12 @@ async function geminiGenerateImage(args) {
     if (images.length === 0) throw new Error("Gemini 未返回图片结果");
-    const textParts = collectTextParts(parsed);
+    // responseModalities=["IMAGE"] 时模型不输出 TEXT，guard 防止空 parts 报错
+    const hasText = Array.isArray(parsed?.candidates) && parsed.candidates.some(
+      (c) => Array.isArray(c?.content?.parts) && c.content.parts.some((p) => trim(p?.text))
+    );
+    const textParts = hasText ? collectTextParts(parsed) : [];
```

```diff
@@ -280,8 +307,8 @@ async function geminiGenerateImage(args) {
     const summary = [
-      `Crab Image 已完成${referenceParts.length > 0 ? "图像生成/编辑" : "图像生成"}`,
+      `Crab Image 已完成${referenceImageCount > 0 ? "图像生成/编辑" : "图像生成"}`,
       `模型：${modelName}`,
       aspectRatio ? `比例：${aspectRatio}` : "",
-      referenceParts.length > 0 ? `参考图：${referenceParts.length} 张` : "",
+      referenceImageCount > 0 ? `参考图：${referenceImageCount} 张` : "",
       textParts[0] ? `说明：${textParts[0]}` : "",
     ].filter(Boolean).join("\n");
```

**imageSize 阈值说明**（对齐 ai-manju 实测值）：

| longEdge | imageSize |
|----------|-----------|
| ≤ 1408 | "1K" |
| 1409–2816 | "2K" |
| > 2816 | "4K" |

---

## 新增函数/类型汇总

### `wsTransport.ts`

```typescript
function findAllUserImagesInCurrentTurn(
  rt: ReturnType<typeof createRunTarget>
): Array<{ kind: "data"; dataUrl: string }>
// 返回当前轮（最后一个含图片的 user step）的所有图片，跨轮不取
```

### `crab-image.mjs`

```javascript
function normalizeReferenceImageRole(value: string): string
// 标准化 role 字符串（lowercase + fallback "reference"）

function describeRole(role: string): string
// 将 role 映射为指令性中文描述，供 B喂法注入

function parseSizeToWH(value: string): { width: number; height: number }
// 解析 "WxH" 格式字符串，容错返回 2048x2048

function pickGeminiImageSizeByLongEdge(width: number, height: number): "1K" | "2K" | "4K"
// 按长边选择 imageSize 档位（对齐 ai-manju 实测阈值）
```

---

## 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| A: findAllUserImagesInCurrentTurn | `wsTransport.ts` 内部 | 低：shim 保持旧函数签名 | 旧调用方不受影响 |
| B: 多图注入 | `generate_image` 自动注入路径 | 低：条件门控 `resolvedReferenceImages.length === 0` | 显式传 referenceImages 时不触发 |
| C: schema 扩展 | `generate_image` schema | 无：只增字段，`passthrough()` 已覆盖 | — |
| D: B喂法 | `normalizeResolvedImages` 返回类型变化 | 中：调用方 `referenceParts.length` 需同步改 | 改动 E 的 `referenceImageCount` 修复 |
| D: B喂法 | `edit_image` 无 roles 时 | 低：默认 "reference" role，描述兜底 | 可接受，edit_image 语义不同 |
| E: responseModalities | 移除 TEXT | 低：guard 保护 `collectTextParts` | `hasText` 检查后才调用 |
| E: imageConfig 常驻 | 原来无 aspectRatio 时不传 imageConfig | 低：`imageSize` 始终有效值 | 不影响 API 接受度 |
| E: referenceCount 修复 | `chooseProviderTier` 输入变化 | 无：更准确，pro 升档条件不变 | — |

### 不受影响的现有功能

- `edit_image` 工具：handler 逻辑不变，只是 `geminiGenerateImage` 内部改了 imageConfig
- `resolveImageToken`：完全不改
- `ThreadImageSessionV1` 结构：完全不改
- `applyCrabImageToolResultToThread`：完全不改
- Gateway 侧：完全不改

---

## 已知局限（P1，本次不做）

1. **`edit_image` 不支持显式 roles**：`editImageInputSchema` 和 handler 未加 `size`/`referenceImageRoles`。如需"edit_image 指定衣服 role"，后续补加
2. **跨轮图片引用**：`findAllUserImagesInCurrentTurn` 只取当前轮，用户需要引用上一轮上传的图时，仍需用 `artifact:id` token 手动指定
3. **roles 数量与 referenceImages 数量不一致时**：多余的 role 被忽略，少于图片数的图使用默认 "reference" role（容错，无报错）

---

## 验证 Checklist

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

### 场景验证表

| 场景 | 操作 | 预期 |
|------|------|------|
| 单图生成（无参考图） | 只写 prompt，不上传图 | `imageSize="1K"/"2K"` 按默认，无参考图 |
| 单图参考（无 roles） | 上传1张图 + prompt | 自动注入1张，role="reference"，B喂法文本出现在 request |
| 双图参考（有 roles） | 上传2张图，model 传 `referenceImageRoles:["identity_plate","outfit_plate"]` | Gemini request parts 为：`{text:Image1 role=identity_plate:...}` `{inlineData}` `{text:Image2 role=outfit_plate:...}` `{inlineData}` `{text:prompt}` |
| 超过12张 | 上传13张 | console.error 警告，实际只发12张 |
| 不传 size | 默认 | `imageSize="1K"`（2048x2048 长边2048 > 1408，→ "2K"）|
| 传 `size:"4096x4096"` | 显式传 | `imageSize="4K"` |
| edit_image | 传 target + editPrompt | 不受影响，正常工作 |
| responseModalities | 生成后检查返回 | summary 不含 "说明：" 字段（TEXT 未返回时 textParts=[]） |

### 边界检查项

- [ ] `referenceImageRoles` 为 `[]` 时：`delete nextArgs.referenceImageRoles`，不下传空数组
- [ ] `referenceImages` 和 `referenceImageRoles` 长度不一致时：短的 role 用默认 "reference" 补位
- [ ] `size` 格式非法（如 "large"）时：`parseSizeToWH` 容错返回 2048x2048
- [ ] `referenceParts` 为空时：`referenceImageCount=0`，`chooseProviderTier` 走 flash 逻辑

---

## 实施优先级

| 顺序 | 改动 | 理由 |
|------|------|------|
| 1 | C（schema 扩展） | 无风险，先铺字段 |
| 2 | D（B喂法 + describeRole） | 核心，依赖 C |
| 3 | E（imageSize + referenceCount 修复） | 必须跟 D 一起，否则 referenceCount 算错 |
| 4 | A（findAllUserImagesInCurrentTurn） | Desktop 端改动，独立 |
| 5 | B（多图注入 + roles 透传） | 依赖 A |

## 涉及文件清单

| 文件 | 改动行号范围 | 改动性质 |
|------|------------|---------|
| `apps/desktop/electron/mcp-servers/crab-image.mjs` | L140–175（新增 describeRole + 重写 normalizeResolvedImages） | 核心逻辑 |
| `apps/desktop/electron/mcp-servers/crab-image.mjs` | L177–195（新增 parseSizeToWH + pickGeminiImageSizeByLongEdge） | 新增工具函数 |
| `apps/desktop/electron/mcp-servers/crab-image.mjs` | L223–320（geminiGenerateImage 内 referenceCount、body、guard） | 修复 |
| `apps/desktop/electron/mcp-servers/crab-image.mjs` | L307–313（generateImageInputSchema 扩展） | schema |
| `apps/desktop/src/agent/wsTransport.ts` | L234–259（新增 findAllUserImagesInCurrentTurn + shim） | 新增函数 |
| `apps/desktop/src/agent/wsTransport.ts` | L319–338（buildCrabImageToolArgs 多图注入 + roles 透传） | 逻辑修改 |
