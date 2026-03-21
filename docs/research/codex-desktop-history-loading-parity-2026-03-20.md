# Codex 桌面端 / 历史加载对齐研究（2026-03-20）

## 结论

这次桌面端 OOM，**不是 gateway 侧问题**，核心还是桌面端两条 eager 链路：

1. **会话历史启动即全量 hydrate**
2. **项目打开即全量读取文件正文**

对标官方 `openai/codex` 最新公开实现后，结论很明确：

- **Codex 公开仓并没有完整桌面 GUI 源码**；`codex app` 只是拉起 / 安装桌面端的入口，不是桌面端本体实现。
- 我们能直接对标的一手实现，主要是 **`app-server + tui_app_server`**。
- 官方公开实现的关键范式不是“永远不加载完整历史”，而是：
  - **列表页 / 选择器只拿轻量 summary**
  - **只在用户明确 resume/fork 某个 thread 时，才加载该 thread 的完整 turns**
  - **输入框历史分层：持久层只存轻量 text，本地 UI session 才保完整 draft state**

所以我们下一步不该继续只做“瘦身”，而要把桌面端改成：

1. **conversation index-first hydrate**
2. **active conversation on-demand load**
3. **project tree first / file content lazy read**

这三条都可以只在 **Desktop 侧** 完成，不需要先动 gateway。

---

## 官方仓最新状态（已 fetch）

2026-03-20 本地已执行：

- `git -C third_party/openai-codex fetch origin`

结果：

- 本地参考 `HEAD`：`334164a6f714c171bb9f6440c7d3cd04ec04d295`
- 远端 `origin/main`：`ba85a580394c862af1cb16b0530f7f857cad43a6`
- 当前本地参考落后远端：`58` commits

最近和本次问题最相关的提交：

1. `334164a` — `feat(tui): restore composer history in app-server tui`
2. `78e8ee4` — `fix(tui): restore remote resume and fork history`
3. `461ba01` — `Feat/restore image generation history`
4. `2cc4ee4` — `temporarily disable private desktop until it works with elevated IPC path`

其中第 4 个是 **Windows sandbox private desktop** 的临时开关，不是我们这次 macOS / Electron / OOM 的主线。

---

## 一手事实 1：公开仓没有完整桌面端源码

官方 README 确实写了可以跑 `codex app` 获取桌面体验，但公开仓里这一层只是 launcher：

- `third_party/openai-codex/README.md`
- `third_party/openai-codex/codex-rs/cli/src/main.rs`
- `third_party/openai-codex/codex-rs/cli/src/app_cmd.rs`
- `third_party/openai-codex/codex-rs/cli/src/desktop_app/mac.rs`

公开代码显示：

- `codex app` 只是 CLI 子命令
- macOS 下会查找 `/Applications/Codex.app`
- 如果没有就从 DMG 下载并 `open -a Codex.app <workspace>`

也就是说：

- **桌面 App 本体不是开源在这个仓库里**
- 对我们有参考价值的一手实现，还是 **app-server 协议 + TUI 恢复/历史机制**

---

## 一手事实 2：Codex 的历史恢复是“轻列表 + 重详情”分层

### 2.1 列表 / 查找阶段不读 turns

公开实现里，TUI 的 session lookup / resume picker 先走：

- `thread/list`
- `thread/read(include_turns=false)`

对应代码：

- `third_party/openai-codex/codex-rs/tui_app_server/src/lib.rs`
- `third_party/openai-codex/codex-rs/tui_app_server/src/resume_picker.rs`
- `third_party/openai-codex/codex-rs/app-server/tests/suite/v2/thread_read.rs`

协议层直接规定：

- `Thread.turns` **默认是空数组**
- 只有 `thread/resume`、`thread/fork`、`thread/rollback`、`thread/read(includeTurns=true)` 才返回 turns

对应文件：

- `third_party/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

这说明官方公开协议天然就是：

- **线程列表 = 轻量元信息**
- **线程详情 = 按需加载**

这点和我们现在 `history.loadConversations` 启动时直接把完整 `conversations` 全吐给 renderer，范式完全不同。

### 2.2 选中的 thread 才恢复完整历史

当用户真正 resume / fork 某个 thread 时，Codex 会返回该 thread 的完整 `turns`，并在 TUI 侧 replay 成 transcript：

- `third_party/openai-codex/codex-rs/tui_app_server/src/app_server_session.rs`
- `third_party/openai-codex/codex-rs/tui_app_server/src/app.rs`

`78e8ee4` 这笔修复的关键点也很直白：

- 远端 app-server 其实一直有完整 `Thread`
- 问题只是 TUI 以前把历史扔掉了
- 修复方式不是改协议，而是 **保留 thread snapshot 并 replay 历史**

这说明官方范式是：

- **列表轻**
- **当前活动 thread 可以重**

所以更准确的对齐方向不是“永远不加载完整历史”，而是：

- **不要在启动时把所有会话都完整载入**
- **只让当前激活会话进入重载路径**

---

## 一手事实 3：Codex 对输入历史也做了“持久层轻 / 本地层重”分层

`docs/tui-chat-composer.md` 写得很明确：

- **Persistent history**：跨 session，按需读取，**text-only**
- **Local history**：当前 UI session，保留完整 draft state

Local history 会保留：

- raw text
- text element ranges
- local image paths
- remote image URLs
- pending paste payloads

Persistent history 则明确 **不会** 重新 hydrate 这些附件 / payload。

这条对我们很关键：官方没有把“完整 UI 草稿状态”直接当成跨 session 的持久化真相。

翻译成我们的桌面端语境就是：

- 持久层应该优先存 **index / preview / summary / 可恢复主线**
- 当前运行期的重量数据（runtime items / draft attachments / execution report）只在必要时恢复

---

## 一手事实 4：Codex 会补 thread history 的语义缺口，但不是靠全量原样塞回去

最新 `461ba01` 修的是“恢复 image generation history”：

- 在 `thread_history.rs` 里补进 `saved_path`
- 在 resumed thread replay 时把 `ImageGeneration` item 正确还原出来

这说明官方在做的是：

- **按 thread history 合同补齐缺失语义**
- **不是把所有运行时对象原封不动长期塞进 UI 持久化**

这和我们刚刚补的方向是一致的：

- `runtime items / turns / merge` 语义要保
- 但不能继续依赖“大而全的 snapshot 原样持久化 + 全量 hydrate”

---

## 对照我们当前桌面端

### 1. 会话历史：仍然是全量 hydrate

当前链路：

- `apps/desktop/src/state/conversationStore.ts`
  - `hydrateFromDisk()` 启动即 `history.loadConversations()`
- `apps/desktop/electron/main.cjs`
  - `history.loadConversations` 仍返回完整 `conversations`

虽然我们已经补了：

- `runtime items`
- `turns`
- `logs.data`
- `merge` 语义
- per-conv `loadConversationSegment`

但问题在于：

- **segment load 发生在 full hydrate 之后**
- 这意味着启动时 renderer 仍先吃一整份完整会话列表

所以现在只是 **存储侧止血**，还没真正完成 **加载侧去 eager**。

### 2. 当前 active conversation 已有半套 lazy 能力，但入口太晚

当前 `ConversationLayout` 已经优先走：

- `history.loadConversationSegment`

这说明我们已经有“按段恢复 steps”的能力。

但入口顺序还是：

1. 先 `hydrateFromDisk`
2. 再在 active conversation 上 segment restore

这和 Codex 的差异在于：

- Codex 是 **先轻量找到 thread**
- 再对单个 active thread 做详情恢复

我们现在是：

- **先把所有 conversation 都 hydrate 进来**
- 再只对 active conversation 做进一步 segment restore

### 3. 项目加载：仍然是全量读正文

`apps/desktop/src/state/projectStore.ts` 现在的 `loadProjectFromDisk()` 会：

1. `listEntries`
2. 对每个文件逐个 `readFile`
3. 把所有文件内容直接塞进 `files[]`

这条链在“大项目 + 长任务 + 文件持续变化”下也会放大内存：

- 首次打开项目直接涨
- 对话恢复时如果顺带恢复项目，会再次放大
- 和历史 hydrate 叠加后更容易撞 V8 old space

Codex 公开实现里并没有一个等价的“启动即把整个 workspace 正文全读入 UI store”的范式；公开契约更接近：

- 文件树 / 元信息先拿
- 正文按具体操作再读

---

## 直接结论：我们该抄 Codex 的哪几条

### 要抄

1. **Thread list / conversation list 只保轻量 summary**
2. **active thread / active conversation 按需读详情**
3. **持久层轻，当前 UI session 层重**
4. **缺失语义靠 history contract 补齐，不靠原样保存所有 runtime blob**

### 不要误抄

1. 不要以为官方“完全不加载当前会话完整历史”
   - 它在 resume/fork 当前 thread 时仍会吃完整 `turns`
2. 不要把 `private desktop` 提交当成这次桌面 OOM 的答案
   - 那是 Windows sandbox 细节
3. 不要把问题再甩回 gateway
   - 这次主链就是 Desktop hydrate / project load

---

## 对我们最合适的 Desktop-only 改造方案

## P0：把 `history.loadConversations` 改成 index-first

目标：

- 启动阶段只返回会话索引，不返回完整 snapshot 大对象

建议返回字段：

- `id`
- `title`
- `updatedAt`
- `projectDir`
- `preview`
- `status`
- 必要的轻量统计（如 stepCount / hasDraft / hasPending）

不要在列表接口里直接返回：

- `snapshot.items`
- `snapshot.turns`
- `snapshot.logs`
- `executionReport`
- 大型 `thread` / `collabSessions`

## P1：active conversation 改成真正按需读

启动后只在下面场景读详情：

1. 用户打开某条会话
2. 用户回到上次 active conversation
3. mini-map / “加载更多”继续向前翻页

优先级建议：

- 先复用已有 `history.loadConversationSegment`
- 再补一个 `history.readConversationSnapshot` 或等价接口
- 把 `draftSnapshot` 也拆出轻 / 重分层

## P2：项目目录只 hydrate 文件树

`projectStore.loadProjectFromDisk()` 改成：

1. 先拿 `files[]/dirs[]`
2. 文件内容按以下触发再读：
   - open tab
   - preview
   - search result click
   - AI 工具显式读取

这样能直接切断另一条明显的 eager 链。

---

## 为什么这套最适合我们，而不是照搬 Codex TUI

Codex 公开 TUI 的前提是：

- 单 active thread
- 命令行 / TUI 交互
- UI 状态面比桌面端窄

我们桌面端还有：

- 会话列表
- 导航区
- 工作区 / 项目树
- 富运行时 snapshot

所以我们要做的是 **“按 Codex 的分层原则改造”**，而不是字面照抄它的 TUI 实现。

最关键的一步不是“把当前单会话也永远不加载完整”，而是：

- **不要在启动时把所有会话都完整装进内存**

这一步做完，OOM 风险会先明显下降一个量级。

---

## 建议落地顺序

### 第一阶段（现在就该做）

1. `history.loadConversations` 改 index-only
2. sidebar / 列表只吃 index
3. active conversation 首次进入时按需拉 segment / full snapshot

### 第二阶段

1. `projectStore` 改 tree-first
2. 文件正文按 tab/preview 再读

### 第三阶段

1. 把 `draftSnapshot`、runtime sidecar、持久历史彻底拆层
2. 给每条会话建立更明确的轻索引文件 / 单会话详情文件

---

## 对本次问题的最终判断

是的，用户前面指出的那个核心点是对的：

- **即使做了很多轮瘦身，只要加载仍然是 eager，后面还是会爆**

现在我们已经把“瘦身漏项”补了一大块，但还差最后这一步：

- **把 Desktop 启动恢复改成 Codex 风格的 index-first / on-demand**

这一步是桌面端修复，不需要先改 gateway。
