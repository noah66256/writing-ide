# feat: 工具结果图片 Vision 注入 + 用户可见截图

> 终点是 spec 文档，不写代码。实施交给 Codex。

---

## 需求卡片

**场景 1 — 模型看图**：Agent 用 Playwright 截图/crab-image 生图后，模型 context 中只有文本路径，无法"看到"图片像素内容。用户要求"对比两张图"时模型纯靠想象。

**场景 2 — 用户看截图**：Playwright 截了登录二维码/验证码，用户在聊天区看不到，只能看到"已截图"文字。

**场景 3 — 缓存**：Playwright 截图在 `.playwright-mcp/` 临时目录，但 `mcp-manager.mjs` 已有 `_persistInlineMediaArtifacts()` 持久化到 `userData/mcp-artifacts/`，**此问题已部分解决**，只需确保后续链路能吃上。

**目标**：
- 工具结果中的图片作为 vision content block 传给 LLM
- Playwright 截图、crab-image 生成图实时发到前端聊天区
- 控制 token 预算：最近 K=3 个 tool_result 保留图片，更早降级为文本描述

**对标**：Claude Code — tool_result 原生支持 image content block（已确认 Anthropic API 支持）

---

## 现状地图

### 当前图片流转

| 路径 | 来源 | 模型看到？ | 用户看到？ |
|------|------|-----------|-----------|
| 用户上传 | InputBar | 能（`images` → `ImageContent[]`） | 能 |
| Playwright 截图 | MCP → 磁盘 | 不能（tool_result 强制转文本） | 能（ToolBlock） |
| crab-image 生成 | MCP → 磁盘 | 不能（只存 imageSession） | 能（ToolBlock） |

### 关键文件

| 文件 | 行号 | 职责 |
|------|------|------|
| `apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts:49` | `CanonicalToolResultItem` | **需加 images 字段** |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts:4114-4134` | `_convertToLlm()` tool_result | **核心改动：支持 image content** |
| `apps/gateway/src/agent/types.ts:25` | `ToolResultPayload` | **需加 images 字段**（Desktop→Gateway 传输） |
| `apps/gateway/src/llm/anthropicMessages.ts:33-38` | `ContentBlockToolResult` | **类型加 image block** |
| `apps/desktop/src/agent/wsTransport.ts:1859` | MCP tool result 处理 | **需读图转 base64 附加到 payload** |
| `apps/desktop/electron/main.cjs` | Electron 主进程 | **需加 IPC: readImageVisionPayload** |
| `apps/desktop/electron/preload.cjs` | preload bridge | **暴露 IPC** |

### 已有设施

- `_persistInlineMediaArtifacts()`（mcp-manager.mjs L1967-2010）：MCP result inline image → 磁盘
- `_imageArtifactCache`（wsTransport.ts）：进程级热缓存
- `nativeImage`（Electron）：图片 resize/压缩
- `ImageContent` 类型（pi-agent-core）：`{ type: "image", data: string, mimeType: string }`
- Anthropic API 原生支持 tool_result 中 image content block

---

## 实施方案

### P0-1: 新增共享类型 `ToolResultImagePayload`

**文件**：`packages/shared/src/runtime/toolResultImage.ts`（新文件）+ `packages/shared/src/index.ts`

```typescript
export type ToolResultImagePayload = {
  mediaType: string;  // "image/png" | "image/jpeg"
  data: string;       // base64
  name?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
};
```

从 `packages/shared/src/index.ts` 导出。

---

### P0-2: Desktop Electron IPC — 图片读取+压缩

**文件**：`apps/desktop/electron/main.cjs`

新增 `encodeImageForVision(absPath, options)` 函数：
- 用 `nativeImage.createFromPath()` 加载
- resize 到 maxEdge=1568（Anthropic 推荐的最大边长）
- 压缩到 maxBytes=500KB（先试 PNG，超限转 JPEG 递降质量）
- 返回 `{ ok, mediaType, data, width, height, sizeBytes }`

新增 IPC handler：`readImageVisionPayload`

**文件**：`apps/desktop/electron/preload.cjs` + `apps/desktop/src/vite-env.d.ts`

暴露 `window.desktop.fs.readImageVisionPayload(absPath, opts)` 到 renderer。

---

### P0-3: Desktop wsTransport — 工具结果附加图片

**文件**：`apps/desktop/src/agent/wsTransport.ts`

新增 `collectToolResultImages()` 异步函数：
- 从 MCP tool result 的 artifacts 中提取图片 artifact
- 调用 `readImageVisionPayload` 读取+压缩
- 最多 1 张/tool_result
- 返回 `ToolResultImagePayload[]`

**调用点**：MCP 工具执行成功后（L1859 和 L1983 两处），在构造 `ToolResultPayload` 时附加 `images` 字段。

同时扩展 `shouldMirrorToolImageToTranscript()` 覆盖 Playwright 截图工具（`mcp.playwright.browser_take_screenshot`），让截图也追加到 transcript 展示给用户。

---

### P0-4: Gateway ToolResultPayload + CanonicalToolResultItem 扩展

**文件**：
- `apps/gateway/src/agent/types.ts:25` — `ToolResultPayload` 加 `images?: ToolResultImagePayload[]`
- `apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts:49` — `CanonicalToolResultItem` 加 `images?: ToolResultImagePayload[]`

**关键约束**：`images` 必须与 `output`/`envelope` 分离，不进入 `compactToolResultEnvelope()`，否则 base64 字符串会被 JSON.stringify 膨胀。

---

### P0-5: Gateway `_convertToLlm()` — tool_result 支持 image content

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

新增辅助函数：

1. `normalizeToolResultImages(images)` — 校验+清理 images 数组
2. `buildToolResultImageFallbackText(images)` — 降级为文本描述 `"[图片: name, WxH]"`
3. `buildToolResultContentParts(item, keepImages)` — 构建 `[TextContent, ImageContent?]`
4. `collectRecentToolResultImageCallIds(messages)` — 从 transcript 尾部扫描最近 K=3 个有图片的 tool_result callId

**改动 `_convertToLlm()` 的 tool_result case**（L4114-4134）：

```typescript
// Before:
content: buildTextContent(item.normalizedText || normalizeToolOutputText(item.output))

// After:
content: buildToolResultContentParts(item, recentImageCallIds.has(item.callId))
```

**Token 预算控制策略**：
- `recentImageCallIds` 在 `_convertToLlm()` 入口一次性计算
- 最近 3 个有图的 tool_result 保留 `ImageContent`
- 更早的降级为 `"[图片: screenshot.png, 1440x900]"` 文本
- 每个 tool_result 最多 1 张图

---

### P0-6: Anthropic adapter 类型闭环

**文件**：`apps/gateway/src/llm/anthropicMessages.ts`

- `ContentBlockToolResult.content` 类型扩展：加入 `ContentBlockImage`
- `buildToolResultMessage()` 函数：支持 `images` 参数，构建含 image source 的 content array

---

## 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| `CanonicalToolResultItem` 加 images | transcript 消费方 | 低：字段可选，现有消费方不受影响 | `images` 不进 envelope |
| `ToolResultPayload` 加 images | Desktop→Gateway WS 传输 | 低：字段可选 | 无图时不传 |
| `_convertToLlm()` 改 tool_result | 每轮 LLM 调用 | 中：base64 图片增加 context 大小 | K=3 上限 + 500KB 压缩 |
| `ContentBlockToolResult` 类型 | Anthropic API 请求 | 低：API 原生支持 | 只改类型定义 |
| `readImageVisionPayload` IPC | Electron 主进程 | 低：新增 IPC，不改现有 | 异常 catch 兜底 |
| Playwright 截图 → transcript | 前端聊天区 | 低：复用现有 artifact 展示 | — |

**不受影响的功能**：
- 用户上传图片流程（独立通道，不经过 tool_result）
- crab-image imageSession 管理（保持不变，额外加 vision 注入）
- MCP 工具调用/结果传输（images 字段可选，无图时行为不变）
- 上下文压缩（compactToolResultEnvelope 不碰 images）

---

## 验证 Checklist

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| Playwright 截图后模型描述截图内容 | 模型能描述图片中的文字/布局 | 截个有文字的网页，让模型读出来 |
| crab-image 生图后让模型对比参考图 | 模型能指出两张图的具体差异 | 生图后问"这张和刚才的参考有什么不同" |
| Playwright 截登录二维码 | 用户在聊天区直接看到二维码图片 | 截微信/支付宝登录页，确认聊天区有图 |
| 连续 5 次截图 | 前 2 张降级为文本，后 3 张保留 vision | 查看 LLM API 请求中的 content 结构 |
| 截图 > 1MB | 压缩后 ≤ 500KB，模型仍能看到 | 截全屏高分辨率页面 |
| 无图片的普通 MCP 工具 | 行为不变（纯文本 tool_result） | 调用 web.search 等工具 |
| OpenAI 兼容模型 | 不崩溃（可能降级为纯文本） | 切换到 OpenAI 模型测试 |

---

## 实施优先级

1. **P0**（以上 6 步）：单次 Run 内的完整链路
2. **P1**：跨 Run 续跑时，上一轮截图的 vision 注入（需要从 thread snapshot 恢复）
3. **P2**：OpenAI/Gemini 兼容适配（vision in tool_result 的 provider-specific 处理）
4. **P2**：模型能力门控（检测模型是否支持 vision input，不支持时自动降级）

---

## 涉及文件清单

| 文件 | 改动类型 |
|------|---------|
| `packages/shared/src/runtime/toolResultImage.ts` | 新增 |
| `packages/shared/src/index.ts` | 导出 |
| `apps/desktop/electron/main.cjs` | 新增 IPC |
| `apps/desktop/electron/preload.cjs` | 暴露 IPC |
| `apps/desktop/src/vite-env.d.ts` | 类型声明 |
| `apps/desktop/src/agent/wsTransport.ts` | 图片收集 + transcript 追加 |
| `apps/gateway/src/agent/types.ts` | ToolResultPayload 加字段 |
| `apps/gateway/src/agent/runtime/transcript/canonicalTranscript.ts` | CanonicalToolResultItem 加字段 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | _convertToLlm() + 辅助函数 |
| `apps/gateway/src/llm/anthropicMessages.ts` | 类型 + buildToolResultMessage |
