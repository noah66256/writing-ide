# Desktop 对话 Transcript 顺序与富媒体消息容器 v0.1

> 日期：2026-03-22
> 状态：Implemented（代码已落地，静态验证通过；手工 UI 冒烟待补）
> 目标：恢复对话区 turn 级 loading 文案；把消息展示顺序收敛成单事实源；将“文本气泡”升级为“富媒体消息容器”，支持图片、JSON、音频、视频等消息体。

## 0. 已有上下文索引

本规范直接建立在以下历史文档与提交之上，避免重复造轮子：

- 文档：
  - `docs/research/streaming-checkpoints-codex-parity-v1.md`
  - `docs/research/todo-and-streaming-ux-codex-parity-v1.md`
  - `docs/specs/inputbar-active-runtime-strips-v1.md`
  - `docs/research/codex-desktop-history-loading-parity-2026-03-20.md`
  - `docs/research/electron-chat-history-loss-codex-parity-2026-03-19.md`
- 提交：
  - `5da1b55 fix(ui): revert injected progress bubbles and settle todos`
  - `703176a fix(desktop): stabilize active runtime strips`
  - `c0b5c6d fix(desktop): dedupe projected runtime steps`

结论先行：

1. “思考中”不是偶发消失，而是旧 `activity` 展示链路在 `703176a` 后被有意收掉了。
2. 当前顺序问题不是单个 sort bug，而是 `steps[] + runtime items + activity` 三套展示语义并存。
3. 现在的助手消息模型仍然是 `text: string` 中心结构，图片靠 Markdown 内嵌，天然不适合扩展成稳定的富媒体消息容器。

说明：

1. 本轮按当前协作约束只先落 spec，不启用额外子 Agent 复核。
2. 若进入实施前 review，可单独再做一轮“只审 transcript / 排序 / 富媒体合同”的干净复核。

## 1. 需求卡片

- 场景：Desktop 端主对话区的流式消息展示、历史恢复与多模态消息承载。
- 目标：
  - 恢复类似“思考中/正在整理结果”的 turn 级 loading 文案。
  - 消息严格按用户提交顺序与运行时事件顺序展示，避免工具日志跑到用户 query 前面。
  - 把对话区升级为“富媒体消息容器”，支持图片、JSON 块、音频、视频等，不把它做成编辑器。
- 对标：
  - `third_party/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`
  - `third_party/openai-codex/codex-rs/tui_app_server/src/chatwidget.rs`
  - `third_party/openai-codex/docs/tui-chat-composer.md`
- 约束：
  - 先落 spec，不在本规范里直接改代码。
  - 保持“打开就是对话”的产品范式，不引入独立富文本编辑器。
  - 不能和既有 `ActiveRuntimeStrips`（shell / 子 Agent 状态条）语义打架。
- 不做什么：
  - 不做完整所见即所得编辑器。
  - 不在本期强制要求 Gateway 立刻改成全新的富媒体协议。
  - 不持久化二进制大文件本体到历史记录，只持久化元数据/引用。

## 2. 现状地图

### 2.1 相关文件

| 文件 | 职责 | 与本需求关系 |
|------|------|------------|
| `apps/desktop/src/ui/components/ChatArea.tsx` | 主对话区渲染、Markdown 图片、Step 分发 | 当前 UI 仍以 `Step` 为中心；loading 回退与图片闪烁都在这里 |
| `apps/desktop/src/agent/threadProjection.ts` | `steps[]` 与 `items[]` 的投影合并 | 当前顺序不稳的核心合并层 |
| `apps/desktop/src/agent/wsTransport.ts` | SSE / WS 事件消费，写入 `activity`、assistant delta、tool 卡片 | 当前“有 activity 但 UI 不吃”“工具/助手插入顺序分散”的根源 |
| `apps/desktop/src/state/runStore.ts` | `Step`、`activity`、运行态 store | 现在的数据模型只适合文本消息，不适合富媒体 part |
| `apps/desktop/src/state/conversationStore.ts` | `buildCurrentSnapshot()` 历史持久化 | 目前历史快照仍基于 `projectedSteps` |
| `docs/specs/inputbar-active-runtime-strips-v1.md` | 输入框上方运行态 strip 规范 | 明确写过“不再单独显示 activity 文案”，本规范需要部分覆盖 |
| `third_party/openai-codex/.../ThreadItem.ts` | Codex 结构化线程 item 合同 | 提供“消息/工具/图像/压缩”等结构化 item 范式 |
| `third_party/openai-codex/.../chatwidget.rs` | Codex item 渲染主循环 | 提供“单 item 流驱动 UI”的一手实现参考 |

### 2.2 已有设施

1. 用户消息已支持图片附件，但仅限 `UserStep.images` 缩略图。
2. 助手消息支持 Markdown 图片，但渲染链路仍然是“整段 markdown 重算”。
3. 运行态已有 `activity`、`todoList`、`ActiveRuntimeStrips`、`items[]`、`steps[]`。
4. 历史恢复已有 `thread / turns / items / collabSessions`，并非完全没有结构化运行时数据。

### 2.3 关键现状证据

1. `apps/desktop/src/agent/wsTransport.ts` 在当前 `HEAD=79f18d1ac7e043997d969fe1b10713bdd18e10bf` 里仍持续写入 `activity`：
   - `setActivity("正在构建上下文…")`：`wsTransport.ts:319-320`
   - `emitProgressCheckpoint -> setActivity(label)`：`wsTransport.ts:374-385`
   - `assistant.start -> setActivity("正在生成…")`：`wsTransport.ts:1418-1436`
   - `tool.call -> setActivity(humanizeToolActivity(...))`：`wsTransport.ts:1477-1594`
2. 但 renderer 侧主聊天区已经不消费 `activity`；仓库搜索只剩：
   - `NavSidebar.tsx` 读取 `runEntry.buffer?.activity?.text`
   - `app.css` 里保留 `.activityBar/.activityText` 老样式
3. `ChatArea.tsx` 当前只在“空文本 streaming 助手气泡”里临时显示 loading：
   - `AssistantMessage`：`ChatArea.tsx:1975-1979`
4. `AssistantMessage` 直接隐藏 `variant === "progress"`：
   - `ChatArea.tsx:1957`
5. 当前展示顺序依赖 `getProjectedStepsFromRuntime(...)`：
   - `ChatArea.tsx:1109-1118`
   - `threadProjection.ts:234-309`
   - 它的策略是“保留 existing steps、覆盖同 id、把缺失 projected item append 到尾部”，不是单一 transcript。
6. 图片闪烁的直接嫌疑点在 `MarkdownImage`：
   - 每次 `resolved` 变化都会先 `setResolvedSrc("")` / `setIsLoading(true)`：`ChatArea.tsx:970-1034`

### 2.4 当前约束点

1. `docs/specs/inputbar-active-runtime-strips-v1.md:257-264` 明确要求：
   - 不再在输入框上方单独显示 `activity` 文案。
   - 避免 strip、思考中、工具卡三重重复。
2. `conversationStore.buildCurrentSnapshot()` 仍把 `projectedSteps` 当历史展示事实源：
   - `conversationStore.ts:662-703`
3. `runStore` 当前消息模型是：
   - `AssistantStep.text: string`
   - `variant?: "default" | "progress"`
   - 没有 `parts[]`

## 3. 一手对照调研摘要

### 3.1 Codex 的可借鉴点

1. `third_party/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts:23-61, 61-98`
   - 线程 item 是结构化 union，而不是把所有东西塞进一段 Markdown。
   - 其中已原生覆盖：
     - `userMessage`
     - `agentMessage`
     - `plan`
     - `reasoning`
     - `commandExecution`
     - `fileChange`
     - `mcpToolCall`
     - `collabAgentToolCall`
     - `webSearch`
     - `imageView`
     - `imageGeneration`
     - `contextCompaction`
2. `third_party/openai-codex/codex-rs/tui_app_server/src/chatwidget.rs:5458-5755`
   - UI 主循环按 `ThreadItem` 类型分发，而不是同时合并多套事实源。
   - 同一个 item 流既覆盖 live，也覆盖 replay。
3. `third_party/openai-codex/docs/tui-chat-composer.md:56-66`
   - 持久层 history 与本地 richer state 可以分层。
   - 持久层可保持轻量、兼容；本地会话可保 richer attachments / placeholders。

### 3.2 本项目不应照抄的点

1. 不需要照搬 Codex TUI 的所有 item 类型。
2. 不需要在本期引入完整 app-server 协议升级。
3. 不需要把输入框做成富文本编辑器；这里只讨论“消息容器”。

### 3.3 结论

推荐模式：

1. 对话区引入单一 `TranscriptEntry[]` 事实源。
2. `TranscriptEntry` 的消息体使用 `MessagePart[]`，而不是只靠 `text: string`。
3. `activity` 不再直接渲染成独立输入区文案，而是收敛为 turn 内部的 `status` item。
4. 历史持久化采用“轻量 transcript 元数据 + 本地 richer 媒体状态”分层。

放弃模式：

1. 不再继续靠 `getProjectedStepsFromRuntime()` 在渲染层临时拼装顺序。
2. 不再依赖“空 streaming assistant bubble”兜底显示 loading。
3. 不再把图片/JSON/音频/视频长期塞进 Markdown 字符串里硬解析。

## 4. 推荐方案

### 4.1 总体原则

1. `ChatArea` 只消费一套有序 transcript。
2. loading / progress / tool / assistant / rich media 都成为 transcript 的一部分，顺序由同一 order key 决定。
3. `ActiveRuntimeStrips` 继续只承载“后台常驻资源”：
   - shell
   - 子 Agent
4. 对话区内的 loading 只表达“这一轮正在思考/整理/生成什么”，不重复承担 shell / 子 Agent 生命周期展示。

### 4.2 新的数据合同

建议引入两层结构：

```ts
type MediaSource =
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string }
  | { kind: "data"; dataUrl: string };

type MessagePart =
  | { type: "markdown"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "image"; id: string; source: MediaSource; alt?: string; caption?: string }
  | { type: "json"; id: string; value: unknown; raw?: string; collapsed?: boolean }
  | { type: "audio"; id: string; source: MediaSource; mimeType?: string; durationMs?: number }
  | { type: "video"; id: string; source: MediaSource; poster?: MediaSource; mimeType?: string }
  | { type: "file"; id: string; path: string; label: string; mimeType?: string };

type TranscriptOrderKey = {
  turnSeq: number;
  itemSeq: number;
  subSeq: number;
};

type TranscriptEntry =
  | {
      kind: "user_message";
      id: string;
      turnId: string;
      order: TranscriptOrderKey;
      parts: MessagePart[];
    }
  | {
      kind: "assistant_message";
      id: string;
      turnId: string;
      order: TranscriptOrderKey;
      author: "main" | "subagent";
      agentId?: string;
      agentName?: string;
      parts: MessagePart[];
      streaming?: boolean;
      quickActions?: AssistantStep["quickActions"];
    }
  | {
      kind: "tool_call";
      id: string;
      turnId: string;
      order: TranscriptOrderKey;
      toolName: string;
      status: "running" | "success" | "failed" | "undone";
      input?: unknown;
      output?: unknown;
      agentId?: string;
    }
  | {
      kind: "status";
      id: string;
      turnId: string;
      order: TranscriptOrderKey;
      phase: "context" | "planning" | "tool" | "synthesis" | "answer";
      text: string;
      ephemeral: boolean;
    };
```

### 4.3 顺序合同

顺序不再依赖 `createdAt + array append + merge existing steps`，而改为显式 order key：

1. 用户一提交，就同步创建该 turn 的 `turnSeq` 和 `user_message(order.itemSeq=0)`。
2. 本 turn 之后所有 live 事件都拿同一个 `turnSeq`。
3. `itemSeq` 由 transport 单调递增分配，而不是由渲染层二次猜测。
4. 同一 item 的 update 只能 patch 原条目，不能重新插入。
5. replay/history 恢复时：
   - 优先用持久化的 transcript order；
   - 无 transcript 时，退回 `turns[].items[]` 的数组顺序；
   - 再退回旧 `steps[]`。

直接收益：

1. 工具日志不会再跑到触发它的用户 query 前面。
2. `status` 文案与 assistant/tool 输出属于同一 turn，自然按序排布。
3. live 与 replay 使用同一渲染合同，不再是“两套排序，两套心智模型”。

### 4.4 loading / progress 收敛规则

本规范明确覆盖 `docs/specs/inputbar-active-runtime-strips-v1.md:257-259` 中“activity 不再直接显示”的旧约束，但只覆盖主对话区，不恢复输入框上方独立 activity 行。

新规则：

1. `runStore.activity` 退化为 transport 内部控制态，不再作为 UI 事实源。
2. 对话区改为显示 turn-scoped `status` item，例如：
   - `正在构建上下文…`
   - `正在搜索资料…`
   - `正在整理结果…`
   - `正在生成回答…`
3. `status` item 插在：
   - 当前用户消息之后
   - 第一条 tool / assistant item 之前
4. 若已有可见 tool / assistant item，则：
   - 只允许更新同一个 `status` item 文案
   - 不重复生成新的“思考中”气泡
5. turn 完成后：
   - 若该 turn 已有可见 tool / assistant 内容，`status` item 自动折叠隐藏
   - 若该 turn 没产出正文但发生了等待/审批，可转成等待态文案并保留

### 4.5 富媒体消息容器规则

1. 消息容器不是编辑器：
   - 只读
   - 可复制
   - 可预览
   - 可展开/折叠
2. 消息体以 `parts[]` 渲染：
   - `markdown/text`：正文
   - `image`：图片卡片
   - `json`：结构化 JSON 块，默认折叠长对象
   - `audio`：原生音频播放器
   - `video`：原生视频播放器
   - `file`：文件引用卡片
3. 当前协议兼容策略：
   - 现有 `UserStep.images` 先映射成 `image parts`
   - 现有 assistant markdown 先映射成单个 `markdown part`
   - fenced code block 中语言为 `json` 的内容，可在渲染期升级为 `json part`
   - 后续如果 Gateway 原生产出 `parts[]`，Desktop 直接透传

### 4.6 图片闪烁修复原则

`MarkdownImage` 不应在每次父级 markdown 重算时先清空 `resolvedSrc`。

建议规则：

1. `image` part 必须拥有稳定 `part.id`。
2. 资源解析缓存从“路径缓存”升级为“`part.id + source signature` 缓存”。
3. 仅当 source signature 真的变化时才重载图片。
4. 在新资源未 ready 前，保留旧图，不先闪回 placeholder。

## 5. 备选方案

### 5.1 备选：继续沿用 `Step[]`，只做补丁

做法：

1. 在 `ChatArea` 重新消费 `activity`，补一行 loading。
2. 在 `threadProjection.ts` 继续修排序。
3. 在 `AssistantMessage` 里给 Markdown 增加更多渲染器。

优点：

1. 改动面小。
2. 短期能较快看到“思考中”回来。

不推荐原因：

1. 顺序问题仍然是渲染层拼装，后面还会反复出错。
2. 富媒体仍是“文本中心”，扩展成本越来越高。
3. 图片闪烁、历史恢复、live/replay 一致性都不会从根上解决。

## 6. 实施分期

### Phase A：Transcript 单事实源 + turn loading

目标：

1. 先解决 loading 消失与顺序错乱。
2. 不要求 Gateway 立刻升级消息协议。

交付：

1. `TranscriptEntry[]` + order key
2. turn-scoped `status` item
3. `ChatArea` 改读 transcript
4. `conversationStore` 开始持久化轻量 transcript

### Phase B：Rich Message Parts

目标：

1. 把用户/助手消息都迁到 `parts[]`
2. 稳定支持 image / json / audio / video

交付：

1. `MessagePartRenderer`
2. 图片不闪烁
3. JSON 块可折叠 / 复制
4. 音视频原生播放器容器

### Phase C：协议对齐与历史收敛

目标：

1. live / replay / resume 用同一 transcript item 合同
2. 旧 `steps[]` 逐步退出主展示链路

交付：

1. snapshot 优先写 transcript
2. 旧会话迁移与 fallback
3. 兼容 `thread.items/turns` 恢复

## 7. 改动点清单（带 HEAD / 行号 / diff 草案）

> 当前 HEAD：`79f18d1ac7e043997d969fe1b10713bdd18e10bf`

### 7.1 [P0] 引入单一 Transcript 合同

- 文件：
  - `apps/desktop/src/state/runStore.ts`
  - 新文件：`apps/desktop/src/agent/transcript.ts`
- 符号：
  - `AssistantStep` / `Step`
  - 新增 `MessagePart` / `TranscriptEntry` / `TranscriptOrderKey`
- 当前行号：
  - `runStore.ts:54-128`
  - `runStore.ts:1160-1195`
- 改动原理：
  - 现有 `AssistantStep.text: string` 与 `variant: progress` 无法承载富媒体与稳定状态项。
  - 需要在 store 层先建立结构化 transcript 合同，UI 才能停止临时猜测。
- 边界情况：
  - 旧代码仍依赖 `steps[]`
  - 子 Agent 消息与主 Agent 消息要共享一套消息合同，但保留 `author/agentId`
- 验证方式：
  - 新 run 提交后立即生成 `user_message`
  - tool / assistant patch 只更新原 item，不新增乱序副本
- unified diff 草案：

```diff
--- a/apps/desktop/src/state/runStore.ts
+++ b/apps/desktop/src/state/runStore.ts
@@
-export type AssistantStep = {
-  id: string;
-  type: "assistant";
-  text: string;
-  streaming?: boolean;
-  hidden?: boolean;
-  variant?: "default" | "progress";
-  ...
-};
+export type MessagePart =
+  | { type: "markdown"; id: string; text: string }
+  | { type: "text"; id: string; text: string }
+  | { type: "image"; id: string; source: MediaSource; alt?: string; caption?: string }
+  | { type: "json"; id: string; value: unknown; raw?: string; collapsed?: boolean }
+  | { type: "audio"; id: string; source: MediaSource; mimeType?: string; durationMs?: number }
+  | { type: "video"; id: string; source: MediaSource; poster?: MediaSource; mimeType?: string }
+  | { type: "file"; id: string; path: string; label: string; mimeType?: string };
+
+export type TranscriptEntry = ...;
@@
+  transcript: TranscriptEntry[];
+  activeTurnSeq: number;
+  nextTranscriptItemSeq: number;
+  appendTranscriptEntry: (entry: TranscriptEntry) => void;
+  patchTranscriptEntry: (id: string, patch: Partial<TranscriptEntry>) => void;
```

### 7.2 [P0] `wsTransport` 改为写 transcript item，而不是分散写 `activity + step + tool`

- 文件：`apps/desktop/src/agent/wsTransport.ts`
- 符号：
  - `setActivity`
  - `emitProgressCheckpoint`
  - `assistant.start / assistant.delta / assistant.done`
  - `tool.call`
- 当前行号：
  - `wsTransport.ts:319-320`
  - `wsTransport.ts:374-385`
  - `wsTransport.ts:1418-1475`
  - `wsTransport.ts:1477-1594`
- 改动原理：
  - transport 必须成为 order key 的唯一分配者。
  - loading/status 需要和 tool/assistant 属于同一 item 流。
- 边界情况：
  - 子 Agent bubble 与主助手消息都要吃同一套顺序分配器
  - `tool.call` 很早到达时，也不能插到 user message 前面
- 验证方式：
  - 压测：提交 query 后立即触发 `tool.call`
  - 对话区第一条永远是该 query 的 user message
- unified diff 草案：

```diff
--- a/apps/desktop/src/agent/wsTransport.ts
+++ b/apps/desktop/src/agent/wsTransport.ts
@@
-  setActivity("正在构建上下文…", { resetTimer: true });
+  startTurnStatus({ phase: "context", text: "正在构建上下文…" });
@@
-  const emitProgressCheckpoint = (phase: string, text: string, opts?: { force?: boolean }) => {
-    ...
-    setActivity(label, { resetTimer: true });
-  };
+  const emitProgressCheckpoint = (phase: TranscriptStatusPhase, text: string, opts?: { force?: boolean }) => {
+    ...
+    upsertTurnStatus({ phase, text });
+  };
@@
-  setActivity("正在生成…");
-  appendAssistantDelta(ensureAssistant(), delta);
+  ensureAssistantTranscriptEntry({ author: "main" });
+  patchTurnStatus({ phase: "answer", text: "正在生成回答…" });
+  appendAssistantPartText(currentAssistantTranscriptId, delta);
@@
-  setActivity(humanizeToolActivity(name, parsedArgsPreview), { resetTimer: true });
-  const stepId = addTool({ ... });
+  upsertTurnStatus({ phase: "tool", text: humanizeToolActivity(name, parsedArgsPreview) });
+  const itemId = upsertToolTranscriptEntry({ ... });
```

### 7.3 [P0] `threadProjection` 退出主展示链路，改为 transcript normalize 层

- 文件：
  - `apps/desktop/src/agent/threadProjection.ts`
  - 新文件：`apps/desktop/src/agent/normalizeTranscript.ts`
- 符号：
  - `projectRuntimeItemsToSteps`
  - `getProjectedStepsFromRuntime`
- 当前行号：`threadProjection.ts:234-314`
- 改动原理：
  - 目前逻辑是“先信 steps，再 append items”，无法保证顺序与 replay/live 一致。
  - 需要改成“由 transcript normalize 层产出最终展示数组”，渲染层不再 merge。
- 边界情况：
  - 历史旧会话只有 `steps[]` 时仍要能显示
  - 新旧快照混跑时，优先 transcript，次级 fallback 到 `turns/items`，最后才是 `steps`
- 验证方式：
  - 打开老会话、新会话、进行中会话，顺序都一致
- unified diff 草案：

```diff
--- a/apps/desktop/src/agent/threadProjection.ts
+++ b/apps/desktop/src/agent/threadProjection.ts
@@
-export function getProjectedStepsFromRuntime(args?: RuntimeStateLike): Step[] {
-  return projectRuntimeItemsToSteps(args);
-}
+export function buildTranscriptFromRuntime(args?: RuntimeStateLike): TranscriptEntry[] {
+  // priority:
+  // 1. persisted transcript
+  // 2. thread/turn items
+  // 3. legacy steps fallback
+}
```

### 7.4 [P0] `ChatArea` 改为渲染 transcript rows，并恢复 turn 级 loading

- 文件：`apps/desktop/src/ui/components/ChatArea.tsx`
- 符号：
  - `ChatArea`
  - `StepRenderer`
  - `AssistantMessage`
  - `MarkdownImage`
- 当前行号：
  - `ChatArea.tsx:1109-1127`
  - `ChatArea.tsx:1832-1857`
  - `ChatArea.tsx:1920-2040`
  - `ChatArea.tsx:965-1066`
- 改动原理：
  - 主聊天区需要直接消费 `TranscriptEntry[]`。
  - loading 不能再依赖“空 assistant bubble”。
  - 图片需要稳定 part key，避免闪烁。
- 边界情况：
  - tool 卡片仍需保留 proposal-first / undo / 审计能力
  - 现有 quickActions 不能丢
  - 用户图片、助手图片、音视频块要共用容器样式，但不是编辑器
- 验证方式：
  - 有/无 tool call 的两种 run 都能看到 loading
  - assistant markdown 中图片不闪
  - JSON/audio/video 在窄屏不会把 layout 挤坏
- unified diff 草案：

```diff
--- a/apps/desktop/src/ui/components/ChatArea.tsx
+++ b/apps/desktop/src/ui/components/ChatArea.tsx
@@
-  const renderSteps = useMemo(
-    () => getProjectedStepsFromRuntime({ steps, items, activeItemIds, collabSessions }),
-    [steps, items, activeItemIds, collabSessions],
-  );
-  const renderRows = useMemo(() => buildRenderRows(renderSteps), [renderSteps]);
+  const transcript = useMemo(
+    () => buildTranscriptFromRuntime({ transcriptStore, steps, items, activeItemIds, collabSessions, turns, thread }),
+    [transcriptStore, steps, items, activeItemIds, collabSessions, turns, thread],
+  );
+  const renderRows = useMemo(() => buildTranscriptRows(transcript), [transcript]);
@@
-function StepRenderer({ step, ... }) { ... }
+function TranscriptRenderer({ entry, ... }) { ... }
@@
-  if (step.hidden || step.variant === "progress") return null;
+  if (entry.kind === "status") return <TurnStatusRow entry={entry} />;
@@
-  const [resolvedSrc, setResolvedSrc] = useState<string>("");
+  const [resolvedSrc, setResolvedSrc] = useState<string>(initialCachedSrc);
@@
-  setResolvedSrc("");
-  setIsLoading(Boolean(resolved));
+  if (sourceSignatureChanged) {
+    setIsLoading(true);
+  }
```

### 7.5 [P1] `conversationStore` 改为优先持久化轻量 transcript，而非仅持久化 projected steps

- 文件：`apps/desktop/src/state/conversationStore.ts`
- 符号：`buildCurrentSnapshot`
- 当前行号：`conversationStore.ts:662-703`
- 改动原理：
  - 如果持久层继续只认 `projectedSteps`，那么 live 修好了、reload 后仍可能错乱。
  - 需要持久化轻量 transcript 元数据，但不写入大体积媒体本体。
- 边界情况：
  - 旧会话兼容
  - 本地图片只保存 `path` / `name` / `mimeType`
  - data URL 不应直接灌进历史快照
- 验证方式：
  - 长会话重启后，user/tool/assistant 顺序与关闭前一致
  - 本地图片仍可重新解析显示
- unified diff 草案：

```diff
--- a/apps/desktop/src/state/conversationStore.ts
+++ b/apps/desktop/src/state/conversationStore.ts
@@
-  const projectedSteps = getProjectedStepsFromRuntime({
-    steps: s.steps ?? [],
-    items: ((s as any).items ?? []) as RuntimeItemRecord[],
-    activeItemIds: ((s as any).activeItemIds ?? []) as string[],
-    collabSessions: normalizedCollabSessions as RuntimeCollabSessionRecord[],
-  });
+  const transcript = buildTranscriptFromRuntime({
+    transcriptStore: s.transcript ?? [],
+    steps: s.steps ?? [],
+    items: ((s as any).items ?? []) as RuntimeItemRecord[],
+    activeItemIds: ((s as any).activeItemIds ?? []) as string[],
+    collabSessions: normalizedCollabSessions as RuntimeCollabSessionRecord[],
+    turns: ((s as any).turns ?? []) as RuntimeTurnRecord[],
+    thread: (s.thread ?? null) as RuntimeThreadRecord | null,
+  });
@@
-    steps: projectedSteps as any,
+    transcript: slimTranscriptForHistory(transcript) as any,
+    steps: deriveLegacyStepsFromTranscript(transcript) as any,
```

### 7.6 [P1] 文档收敛：明确本规范覆盖旧 `activity` 约束

- 文件：`docs/specs/inputbar-active-runtime-strips-v1.md`
- 符号：`10. 与现有 UI 的收敛`
- 当前行号：`inputbar-active-runtime-strips-v1.md:253-264`
- 改动原理：
  - 旧 spec 的结论是“不要再显示 activity 文案”。
  - 新需求是“恢复 loading 文案，但放到对话区 turn 里，不回到 InputBar 独立文本行”。
- 验证方式：
  - 文档不再互相冲突
- unified diff 草案：

```diff
--- a/docs/specs/inputbar-active-runtime-strips-v1.md
+++ b/docs/specs/inputbar-active-runtime-strips-v1.md
@@
-2. `InputBar.tsx` 不再在编辑器上方单独显示 `activity` 文案
-3. `runStore.activity` 继续保留给 stop 按钮、消息流和后续状态整合使用，但不再直接渲染成独立文本行
+2. `InputBar.tsx` 仍不在编辑器上方单独显示 `activity` 文案
+3. turn 级 loading 改由 `ChatArea` 的 transcript `status` item 承载，详见
+   `docs/specs/desktop-chat-transcript-ordering-and-rich-media-v0.1.md`
```

## 8. 风险与连锁反应

### 8.1 连锁反应

1. `ChatArea`、`conversationStore`、`wsTransport`、`runStore` 会一起动，不能只修单点。
2. 历史快照结构会新增 transcript 字段，需要兼容旧会话。
3. tool / proposal-first / undo UI 不能在迁移 transcript 时被弱化。

### 8.2 性能风险

1. 若 transcript normalize 每次 render 全量重算，长会话会再次放大卡顿。
2. 富媒体 part 若直接持有大 data URL，会加重内存压力。

应对：

1. order key 在 transport 写入时确定，renderer 尽量只做轻量 map。
2. transcript 历史持久化只存轻量元数据。
3. 图片/音视频资源走懒加载和缓存。

### 8.3 兼容性风险

1. 旧会话没有 transcript 字段。
2. 旧 skill / tool 仍可能只产出纯文本 assistant message。

应对：

1. 读取优先级：`transcript > turns/items > legacy steps`
2. 纯文本继续映射成单个 `markdown/text part`

## 9. 验证 Checklist

### 9.1 loading / 顺序

1. 用户发送 query 后 150ms 内，对话区出现 turn 级 loading 文案。
2. 即便第一条运行时事件是 `tool.call`，该 tool 行也不能出现在用户消息前。
3. 有多个工具调用时，展示顺序与 transport 分配的 `itemSeq` 一致。
4. turn 完成后，没有正文的临时 loading 会自动收起，不残留幽灵气泡。

### 9.2 富媒体

1. 用户图片与助手图片都能稳定显示。
2. assistant streaming 过程中，已显示图片不闪回 placeholder。
3. JSON 块支持折叠 / 展开 / 复制。
4. 音频和视频能在消息容器里播放，不溢出布局。

### 9.3 历史 / 恢复

1. 重启 Desktop 后，最近会话的消息顺序不变。
2. 老会话无 transcript 字段时，仍能正常显示。
3. 历史压缩后，只保留对话内容与必要媒体引用，不把工具审计内容重新渲染进正文。

### 9.4 不重复展示

1. `ActiveRuntimeStrips` 继续只显示 shell / 子 Agent。
2. 对话区 loading 不与输入区 strip 重复。
3. 不再出现“思考中 + progress bubble + tool card”三重重复。

## 10. 回滚与兼容说明

1. Phase A 落地时建议双写：
   - 新：`transcript`
   - 旧：`steps`
2. `ChatArea` 优先读 `transcript`，必要时可快速切回 `steps`。
3. 若富媒体 part 渲染出现回归，可保留 `markdown/text part` 回退路径，不影响基础对话。

## 11. 最终决策

这次不建议再做“把思考中补回来”的最小修法。

应该一次性把以下三件事绑在一起做：

1. `activity` 收敛为 turn-scoped `status` transcript item。
2. `steps + items` 投影改成单一 transcript 事实源。
3. 消息渲染从 `text: string` 升级到 `parts[]`，为图片、JSON、音频、视频留出正式接口。

否则：

1. loading 还会再次丢。
2. 顺序问题还会反复出现。
3. 富媒体能力会继续被 Markdown 文本结构卡死。

## 12. 实施状态

### 12.1 已落地范围

本规范对应实现已落地到以下文件：

1. `apps/desktop/src/agent/transcript.ts`
   - 新增 transcript 合同与基础 helper：
   - `TranscriptEntry`
   - `TranscriptMessagePart`
   - `status/tool_call/user_message/assistant_message`
   - merge / resequence / status upsert / legacy step 映射
2. `apps/desktop/src/state/runStore.ts`
   - `steps` 继续保留兼容，同时新增 `transcript` 作为主聊天 UI 事实源
   - `addUser/addAssistant/addTool/patch*/finish*/setActivity/loadSnapshot/prependSteps` 全量双写 transcript
   - turn 级 loading 改由 transcript `status` item 承载
3. `apps/desktop/src/agent/runTarget.ts`
   - 后台 run buffer 新增 transcript 镜像
   - `activity` 更新会同步写入/移除 transcript `status`
   - snapshot flush 时合并回历史 transcript，避免前后台切换后顺序漂移
4. `apps/desktop/src/state/conversationStore.ts`
   - `RunSnapshot` 新增 `transcript`
   - 历史快照构建优先持久化 transcript
   - 老会话无 transcript 时，可由 legacy `steps` 自动修复回填
5. `apps/desktop/src/ui/components/ChatArea.tsx`
   - 主消息区改为渲染 transcript rows，而不是 `steps + runtime items + activity` 三套混排
   - 恢复 turn 级 loading 文案
   - 新增富媒体消息容器：
   - markdown / text
   - image
   - json（折叠/展开/复制）
   - audio / video
   - file
6. `apps/desktop/src/ui/components/NavSidebar.tsx`
   - 会话快照和分段加载逻辑同步吃 transcript，避免切会话后再次全量灌入或顺序错乱
7. `apps/desktop/src/state/runRegistry.ts`
   - 后台 run buffer 新增 transcript，确保后台运行态与主对话区共享同一展示合同

### 12.2 验证结果

已完成验证：

1. `npx tsc -p apps/desktop/tsconfig.json --noEmit`
   - 通过
2. `npm run -w @ohmycrab/desktop build`
   - 通过
3. `npm run -w @ohmycrab/desktop smoke:history`
   - 通过
   - 历史迁移与会话持久化未被 transcript 双写方案破坏

### 12.3 当前偏差与说明

1. 目前已完成代码级与脚本级验证，但还未补手工 UI 冒烟
   - 待确认项主要是：
   - turn 级 loading 的观感
   - 工具日志在真实流式会话中的顺序
   - 图片/音视频在桌面端实际渲染观感
2. transcript 目前仍与 legacy `steps` 双写
   - 这是有意保留的兼容层，不是遗漏
   - 后续若要彻底移除 `steps`，应另开专门收敛 spec，而不是在本轮顺手拔掉
