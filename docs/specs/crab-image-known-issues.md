# Crab Image 已知问题清单

> 记录 crab-image MCP 集成过程中发现的 bug，供后续修复。

---

## 1. edit_image 无法解析 `target: "last"`（已修复）

**现象**：`generate_image` 成功后，同一 session 内调用 `edit_image({ target: "last" })` 报"未解析到可编辑的目标图片"。

**根因**：`applyCrabImageToolResultToThread` 通过 `rt.setThread()` 写入 `imageSession`，但下一次 `buildCrabImageToolArgs` 通过 `rt.getThread()` 读不回来——`runStore.thread.imageSession` 在 run 内断链。

**修复**：在 `wsTransport.ts` 加 `_imageArtifactCache` 进程级热缓存。`applyCrabImageToolResultToThread` 写热缓存，`resolveImageToken` 在 imageSession 找不到时 fallback 到热缓存。

**状态**：已修复并验证。

---

## 2. 模型自言自语（self-talk）

**现象**：用户说"帮我看看为什么这样子"后，模型不调用任何工具，自己连续输出多段分析文字，且中间穿插了"先看看刚才那张图"→ 尝试 Playwright 打开 file: URL → 失败 → 继续自说自话。

**期望**：模型应该直接看图（如果模型支持视觉）或调用 edit_image，而不是尝试用浏览器打开本地文件。

**相关文件**：
- `apps/gateway/src/agent/runFactory.ts` — 系统提示词
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts` — 自言自语检测

**优先级**：P2（不影响核心功能，但影响体验）

---

## 3. 前端重新拉起后老 session 图片不显示

**现象**：Electron 重启后，之前 session 的对话历史中图片不显示（只有 markdown link 或空白）。

**根因推测**：
1. 图片 artifact 路径用的是绝对路径或 `file-ref:` 协议，重启后 renderer 可能无法加载
2. `transcript` 中的图片 part 可能在持久化时丢失
3. `conversations.v1.json` 可能没有持久化 image content block

**相关文件**：
- `apps/desktop/src/agent/transcript.ts`
- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/src/ui/components/ChatArea.tsx`

**优先级**：P1

---

## 4. Playwright 尝试打开 `file:` URL 被阻止

**现象**：模型试图用 `browser_navigate` 打开 `file:///Users/noah/...` 本地文件路径，被 Playwright 的安全策略阻止。

**期望**：模型不应该用 Playwright 打开本地文件。如果需要查看生成的图片，应该通过 imageSession 引用或告知用户直接点击 artifact 链接。

**修复建议**：在系统提示词中明确禁止用 Playwright 打开 `file:` 协议。

**优先级**：P2

---

## 5. "画个 X" 不触发 image_generate 能力匹配（已修复）

**现象**：用户说"画个 macbook air"时，`selectMcpServerSubset` 不选 crab-image server。

**修复**：`toolCatalog.ts` 的 `image_generate` 正则扩展为 `/(生图|生[成个一].*图|画[个张一]|画图|出图|...)/i`，覆盖"画个"、"画一张"、"帮我画"、"给我画"等自然表达。`image_edit` 也扩展了"改一下图"、"把图改"等表达。

**状态**：已修复并验证。

---

## 6. `dev.sh` 默认走远程 gateway（已修复）

**现象**：`dev.sh` 启动本地 gateway 但 Vite proxy 默认指向远程 `120.26.6.147:8000`，本地 gateway 空转。

**修复**：`dev.sh` 加 `VITE_GATEWAY_URL=http://localhost:8000`。

**状态**：已修复。

---

## 6. Gateway dist 未及时编译（已修复）

**现象**：修改 `GatewayRuntime.ts` 源码后，`dist/` 产物没有重新编译，gateway 通过 `tsx` 直接跑源码时不受影响，但部署到服务器时会用旧 dist。

**修复**：每次改动后必须 `npm -w @ohmycrab/gateway run build`。`dev.sh` 用 `tsx` 直接跑源码，不受影响。

**状态**：已修复。
