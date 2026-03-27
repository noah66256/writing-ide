# Crab Image 已知问题清单

> 记录 crab-image MCP 集成过程中发现的 bug，供后续修复。

---

## 1. edit_image 无法解析 `target: "last"`（已修复）

**状态**：已修复并验证（`_imageArtifactCache` 热缓存）。

---

## 2. 模型自言自语（self-talk）（待验证）

**现象**：模型不调用工具，自己连续输出多段分析文字，尝试 Playwright 打开 file: URL。

**当前状态**：删除 intent router 后可能已缓解（不再因 routeId=discussion 禁用工具）。需要复现验证。

**优先级**：P2

---

## 3. 重启后老 session 图片不显示（部分修复）

**现象**：Electron 重启后，之前 session 的图片不显示。

**已修复**：`mergeSnapshotForHistory` 已加 `thread` 保留，`flushDraftSnapshotNow` 在图片生成后立即持久化。

**可能残留**：图片用 `file-ref:` 协议，renderer 可能无法加载。需要验证重启后图片是否可见。

**优先级**：P1

---

## 4. Playwright 尝试打开 `file:` URL 被阻止（未修）

**现象**：模型用 `browser_navigate` 打开本地文件路径，被安全策略阻止。

**修复建议**：在 system prompt 中明确禁止用 Playwright 打开 `file:` 协议。

**优先级**：P2

---

## 5. "画个 X" 不触发 image_generate 能力匹配（已修复）

**状态**：已修复并验证（正则扩展）。

---

## 6. Gateway dist 未及时编译（已修复）

**状态**：已修复。`dev.sh` 用 tsx 直接跑源码不受影响。

---

## 7. @文件引用图片 / 拖入文件时走 read 而非视觉输入（未修，待设计）

**现象**：
1. 用户通过 `@文件名.jpg` 引用图片时，系统走 `read` 工具读取文件，模型无法"看到"图片内容，也无法将其作为 crab-image 的参考图
2. 用户拖动文件（图片/文档）进对话框时，文件不被识别——既不作为视觉输入，也不作为 @引用

**期望**：
- @图片文件 / 拖入图片时应同时提供两种能力：视觉输入（让模型看到）+ 文件路径（注入 crab-image 参考图）
- 拖入非图片文件（.md / .txt / .docx）时应自动转为 @引用或内联内容

**设计方向**：
- 检测 @引用 / 拖入文件的 MIME type，`image/*` 自动注入为 vision input + crab-image referenceImages
- 非图片文件自动转为 @引用（读取内容注入上下文）
- 需要区分"看图"vs"读文件属性"——可能默认同时提供两种能力

**影响范围**：
- `apps/desktop/src/agent/wsTransport.ts` — buildCrabImageToolArgs 增强
- `apps/desktop/src/agent/runTarget.ts` — @引用的图片路径提取
- `apps/desktop/src/ui/components/ChatArea.tsx` 或 InputBar — 拖拽文件识别

**优先级**：P2（需 UX 设计讨论后实现）

---

## 8. 聊天上下文导致画图被降级（已修复）

**根因**：intent router 把画图判成 analysis_readonly。

**修复**：intent router 已整体删除，routeId 固定为 task_execution。已验证聊天后画图正常。

**状态**：已修复。

---

## 9. Session 串台（已修复）

**根因**：`loadConversationSnapshot(id, { includeSteps: false })` 导致旧 steps 残留。

**修复**：改为 `includeSteps: true`。

**状态**：已修复。

---

## 10. dev.sh 默认走远程 gateway（已修复）

**状态**：已修复（加 `VITE_GATEWAY_URL=http://localhost:8000`）。
