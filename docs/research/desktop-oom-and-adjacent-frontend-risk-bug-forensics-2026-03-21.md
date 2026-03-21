# Bug Forensics Brief

## 1. Bug Card

- 用户反馈原话：
  - “桌面崩了帮我看下”
  - “它是我选了项目，然后在跑任务的过程中崩的”
  - “这只是桌面端的修复吧，不用 gateway 侧”
  - “但问题是加载方式，它不应该一次性加载吧，否则用到后面还是爆啊”
  - “不仅是 electron/oom 问题，还有潜在的后面前端会不会撑炸的隐患一起帮我找出来”
- 现象：
  - 选中项目、任务运行过程中，Electron Desktop 进程退出。
  - 一轮日志是 macOS `.ips` 的 `CrBrowserMain` 主线程 `SIGABRT` / `abort() called`。
  - 另一轮日志已经明确出现 `Ineffective mark-compacts near heap limit` 与 `JavaScript heap out of memory`。
- 影响：
  - 当前运行中断，桌面端退出。
  - 启动恢复 / 会话切换 / 项目刷新都存在继续把前端撑炸的风险。
- 触发条件：
  - 重历史会话存在。
  - 打开项目后开始跑任务，尤其是带 `read` / 文件写入 / `fs.watch` 高频事件的任务。
  - 窗口退后台可能会放大旧的 Electron/macOS 背景问题，但不是本轮首因。
- 当前复现状态：
  - **未在本轮重新完整跑 GUI 复现**，但已通过用户日志、本机历史数据、代码路径、相关 commit、独立子 agent 复核形成高置信根因链。

## 2. Evidence Ledger

### 2.1 用户反馈 / 日志

- 来源：用户提供的 crash report 与终端日志。
- 事实：
  - 2026-03-20 的 `.ips` 指向 `CrBrowserMain`、`SIGABRT`、`abort() called`，且 `Process Role: Background`。
  - 后续 dev 运行时日志明确出现：
    - `Mark-Compact (reduce) 2051.2 ... last resort`
    - `OOM error in V8: Ineffective mark-compacts near heap limit`
    - `Allocation failed - JavaScript heap out of memory`
- 支持判断：
  - 这不是单纯“renderer 白屏”，而是 **主进程/renderer 共同受大对象加载压力影响** 的桌面端内存问题。
  - 从“背景崩溃”到“明确 OOM”，说明 **即使 Electron 版本已变更，应用层的重载入链路仍然成立**。

### 2.2 本机历史数据目录实查

- 来源：`~/Library/Application Support/OhMyCrab/ohmycrab-data`
- 事实：
  - 整个目录约 `226MB`。
  - `conversations.v1.json` 约 `11MB`。
  - `conversations/` 下 `12` 个 per-conv 文件合计约 `7.42MB`，其中最大单会话文件约 `4.0MB`。
  - 根目录存在 `42` 个 `conversations*.tmp`，合计约 `194.54MB`。
  - `apps/desktop/electron/main.cjs:106` 定义 `HISTORY_TMP_FILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000`，但本机目录中仍保留了远超 3 天的历史 tmp，说明 cleanup **并不可靠生效**。
- 支持判断：
  - 启动时不仅主历史文件重，**tmp 残留本身就足以把恢复路径放大成第二份历史仓库**。
  - `v2 per-conv` 其实已经比 `v1 + tmp` 轻得多，说明问题不只在“存”，更在“读”和“恢复顺序”。

### 2.3 最大单会话内容拆解

- 来源：`~/Library/Application Support/OhMyCrab/ohmycrab-data/conversations/conv_conv_1773995680583_c783730cbed02.json`
- 事实：
  - 文件大小约 `3.995MB`。
  - `steps=112`、`items=244`、`turns=5`、`logs=103`。
  - 分段体积：
    - `steps` 约 `403KB`
    - `logs` 约 `215KB`
    - `turns` 约 `30KB`
    - `items` 约 `3.56MB`
  - 最大 item 全是 `type=toolCall` 的 `read` 结果，单条约 `116KB~118KB`。
  - 同一份大 `result.content` 存在成对 item，例如：
    - `item_tool_...`
    - `t_...`
  - 成对 item 的 `result.content` 长度一致，说明存在 **shadow/runtime 双份保留**。
- 支持判断：
  - 当前最大头不是 `steps`，而是 `snapshot.items`。
  - `read` 工具把大段正文直接塞进 runtime item，是历史膨胀的主来源之一。

### 2.4 会话历史加载链

- 来源：代码
  - `apps/desktop/src/state/conversationStore.ts:619`
  - `apps/desktop/src/state/conversationStore.ts:806`
  - `apps/desktop/electron/main.cjs:1065`
  - `apps/desktop/electron/main.cjs:1122`
  - `apps/desktop/electron/main.cjs:3009`
  - `apps/desktop/electron/main.cjs:3086`
  - `apps/desktop/src/ui/layouts/ConversationLayout.tsx:91`
- 事实：
  - `buildCurrentSnapshot()` 仍会对 `thread / turns / items / collabSessions` 做 `JSON.parse(JSON.stringify(...))` 深拷贝。
  - `hydrateFromDisk()` 启动即 `api.loadConversations()`。
  - 主进程 `history.loadConversations` 会读取主文件/备份/legacy，并额外扫描 `conversations.v1.json.*.tmp` 候选。
  - `ConversationLayout` 虽然已经支持 `history.loadConversationSegment`，但这是 **full hydrate 之后** 的补充恢复，不是替代。
- 支持判断：
  - 之前做过的瘦身、`runtime items / turns / merge` 修补，是 **存储侧止血**；当前致命问题仍然是 **启动即全量 hydrate 所有会话**。
  - `segment restore` 的能力已经有了，但入口时机太晚。

### 2.5 高频 whole-snapshot 保存链

- 来源：代码
  - `apps/desktop/src/ui/components/ChatArea.tsx:1075`
  - `apps/desktop/src/ui/components/ChatArea.tsx:1115`
  - `apps/desktop/src/ui/components/InputBar.tsx:903`
  - `apps/desktop/src/ui/components/NavSidebar.tsx:215`
  - `apps/desktop/src/agent/runTarget.ts:292`
  - `apps/desktop/src/state/conversationStore.ts:752`
- 事实：
  - `ChatArea` 每 2 秒自动保存一次草稿/当前会话。
  - `InputBar`、`NavSidebar`、`runTarget` 等路径也会调用 `buildCurrentSnapshot()` 与 `updateConversation()`。
  - `history.saveConversations` 之后还会继续最佳努力写 `v2 index + per-conv`。
- 支持判断：
  - 当前不是只在“退出时”写盘，而是 **运行中反复深拷贝 + JSON 序列化**。
  - 这会把本来就很重的 `items/turns/thread` 变成持续型内存压力，而不是单次峰值。

### 2.6 项目打开 / 刷新链

- 来源：代码
  - `apps/desktop/src/App.tsx:52`
  - `apps/desktop/src/App.tsx:73`
  - `apps/desktop/src/state/projectStore.ts:243`
  - `apps/desktop/src/state/projectStore.ts:363`
  - `apps/desktop/src/state/projectStore.ts:455`
  - `apps/desktop/electron/main.cjs:2716`
  - `apps/desktop/electron/main.cjs:2745`
- 事实：
  - 启动时会自动恢复上次打开的项目。
  - `loadProjectFromDisk()` 会先列出文本文件，再逐个 `readFile`，把所有正文塞进 `projectStore.files`。
  - `ensureLoaded(path)` 已存在，说明单文件懒读基础能力早就有。
  - 但 `fs.watch` 到来后，`App.tsx` 直接触发 `refreshFromDisk("fs.watch")`。
  - `refreshFromDisk()` 会重新 `listEntries()`，并对全部磁盘文本文件再执行一轮 `readFile`。
- 支持判断：
  - 选项目不是“只加载树”，而是 **整项目正文一次性加载**。
  - 任务运行时文件变化越多，越会不断触发 **整项目全文重读**。

### 2.7 项目索引链

- 来源：代码
  - `apps/desktop/src/state/projectIndexStore.ts:79`
  - `apps/desktop/electron/main.cjs:2745`
- 事实：
  - `projectIndexStore.buildIndex()` 会做一次 `listAllEntries` 全仓库扫描。
  - 这条链主要存元数据，不直接把正文塞进 store。
- 支持判断：
  - 它不是这次 OOM 的主因，但属于同类 eager 全量处理，容易与历史/项目正文链叠加。

### 2.8 相关 commit / 历史修复

- 来源：`git log` / `git show`
- 关键 commit：
  - `c0b5c6d` `fix(desktop): dedupe projected runtime steps`
  - `703176a` `fix(desktop): stabilize active runtime strips`
  - `003a2e2` `feat: cut over codex-style thread runtime`
  - `569f18f` `fix(desktop): improve conversation restore and history display`
  - `56a7800` `fix(desktop): make conversation autosave robust under streaming and ctrl-c`
  - `b3111cb` `fix(desktop): harden conversation hydrate & autosave`
  - `ba98459` `feat(project): local disk project open/read/write + recent projects`
  - `99f4534` `feat: land phase1 project indexing summaries`
- 支持判断：
  - 最近几轮已经明显在修“恢复语义”和“runtime strip”，**不适合直接粗暴回退**。
  - 项目全文 eager load 是更早的设计引入，不是最近两天新增。

### 2.9 外部源码 / 官方文档 / 上游 issue

- 本地一手参考仓：
  - `third_party/openai-codex/codex-rs/app-server/README.md`
  - `third_party/openai-codex/codex-rs/tui_app_server/src/lib.rs`
  - `third_party/openai-codex/docs/tui-chat-composer.md`
- 结论：
  - Codex 公开实现是 **`thread/list` / `thread/read(includeTurns=false)` 先拿轻列表**；
  - 只有 `thread/read(includeTurns=true)` / `thread/resume` / `thread/fork` 才拿完整历史；
  - 输入历史也明确区分 **persistent text-only** 与 **local full state**。
- 官方文档 / issue：
  - Electron 性能文档把“Loading and running code too soon”与“Blocking the main process”列为典型陷阱，并强调先测量、再优化：
    - <https://www.electronjs.org/docs/latest/tutorial/performance>
  - Electron release schedule 显示 2026-03-21 时支持中的稳定主线是 `39/40/41/42/43`，`34` 已 EOL：
    - <https://releases.electronjs.org/schedule>
  - Electron 官方确实存在 macOS 26 相关 issue：
    - <https://github.com/electron/electron/issues/48311>
    - <https://github.com/electron/electron/pull/48376>
    - <https://github.com/electron/electron/issues/50247>
- 支持判断：
  - **旧 Electron/macOS 背景问题是真实存在的外部噪音**，但当前仓库已是 `Electron 41.0.3`，且 OOM 在应用层数据链上证据更强，因此它只能作为次级风险，不再是本轮首因。

## 3. Repro Matrix

### 3.1 路径 A：重历史启动 / 恢复

- 步骤：
  1. 用户已有重历史目录（大 `conversations.v1.json` + 大量 `.tmp`）。
  2. 启动 Desktop。
  3. `hydrateFromDisk()` 调用 `history.loadConversations()`。
  4. 主进程解析主文件/备份/legacy/tmp，renderer 再对完整会话做 repair/slim。
- 预期：
  - 启动只拿会话列表，详情按需恢复。
- 实际：
  - 启动就吞完整会话和修复逻辑，当前活动会话的 segment restore 发生得太晚。
- 影响变量：
  - 历史会话数量
  - 单会话 `items` 大小
  - tmp 文件数量和体积

### 3.2 路径 B：选项目后跑任务

- 步骤：
  1. 选择项目或自动恢复上次项目。
  2. `loadProjectFromDisk()` 逐个把文本文件全文读入 store。
  3. 任务运行中产生文件变化，`fs.watch` 触发 `refreshFromDisk("fs.watch")`。
  4. 整项目正文再次重读。
- 预期：
  - 先展示项目树，正文按打开文件懒读；`fs.watch` 只刷新受影响路径。
- 实际：
  - 打开项目与运行任务期间都走全量文本正文读取。
- 影响变量：
  - 文件数
  - 文本文件总字节数
  - 任务写文件频率

### 3.3 路径 C：运行中自动保存 / 会话更新

- 步骤：
  1. 运行产生新的 steps/items/turns。
  2. `ChatArea` 2 秒轮询保存。
  3. `buildCurrentSnapshot()` 深拷贝 runtime 大对象。
  4. `updateConversation()` / `saveConversations()` / `saveConversationsV2()` 连续序列化。
- 预期：
  - 只增量持久化必要信息，或至少只对 active conversation 做局部更新。
- 实际：
  - whole-snapshot clone + merge + save 被频繁触发。
- 影响变量：
  - `read` 工具结果大小
  - runtime item 数量
  - 当前对话是否为 heavy conversation

### 3.4 变量判断

- 与问题强相关：
  - 重历史
  - 重项目
  - `read` 结果体积
  - `fs.watch` 高频事件
- 当前无证据证明是首因：
  - `gateway`
  - 系统代理 `7897`
  - 国内镜像直连
- 推断：
  - 代理/镜像会影响请求延迟、重试和返回内容规模，但**不能解释本地历史全量 hydrate 与项目全文全读**；最多是放大器，不是第一原因。

## 4. Hypotheses

### 假设 A：Desktop eager history + eager project load + whole-snapshot clone 是首因

- 置信度：**高**
- 支持证据：
  - 明确 OOM 日志已到 V8 old space 上限。
  - 本机历史目录、tmp 体积、最大会话拆解都指向 `items/read result.content`。
  - 代码路径明确存在：
    - 启动全量 hydrate
    - 项目全文 eager load
    - `fs.watch` 全量 reread
    - 2 秒 whole-snapshot autosave
- 反证：
  - 本轮未做 GUI 级逐步 profiler 回放。
- 结论：
  - **当前最可能根因。**

### 假设 B：Electron/macOS 背景 IPC / 主线程问题是首因

- 置信度：**中低**
- 支持证据：
  - 早期 `.ips` 的确落在 `CrBrowserMain` 背景线程形态。
  - Electron 官方存在 macOS 26 相关问题与后台 `webContents.send` 崩溃 issue。
- 反证：
  - 当前仓库 Electron 已升级到 `41.0.3`。
  - 后续日志已经是直接的 heap OOM。
  - 同类崩溃跨版本仍出现，更像应用层内存模型未修。
- 结论：
  - **次级风险，不是当前首因。**

### 假设 C：Gateway / 代理 / 镜像导致前端崩溃

- 置信度：**低**
- 支持证据：
  - 任务内容和返回规模可能因远端响应不同而放大。
- 反证：
  - 当前最重链路都在本地 Desktop：
    - 历史恢复
    - 项目全文读取
    - 本地 autosave
    - 本地 tmp 残留扫描
- 结论：
  - **不是本轮 root cause。**

### 已排除方向

- “只是 renderer 白屏”
- “只升级 Electron 就够”
- “只动 gateway 即可解决”

## 5. Root Cause

## 5.1 已确认根因

**根因不是单点，而是两条 Desktop eager 链互相放大：**

1. **会话历史把运行态大对象当成持久化真相，并在启动/保存/切会话时全量处理。**
2. **项目打开与 `fs.watch` 刷新都按整项目正文处理，而不是 tree-first / file-lazy。**

两条链叠在一起后，任务一跑起来就会同时抬高：

- renderer 内存
- 主进程 JSON parse / serialize 压力
- IPC 传输负担
- UI 渲染负担

最终把进程推到 V8 heap limit 附近。

## 5.2 调用链 / 状态链 / 数据链

### 历史链

1. `ChatArea` / `InputBar` / `NavSidebar` / `runTarget` 持续调用 `buildCurrentSnapshot()`
2. `buildCurrentSnapshot()` 深拷贝 `thread / turns / items / collabSessions`
3. `items` 中包含大 `read.result.content`
4. `history.saveConversations()` 保存 v1 主文件
5. 随后最佳努力再写 `v2 index + per-conv`
6. 下次启动 `history.loadConversations()` 重新解析主文件/备份/legacy/tmp
7. renderer `hydrateFromDisk()` 再对所有会话 repair/slim
8. `ConversationLayout` 最后才对 active conversation 走 segment restore

### 项目链

1. 启动或用户操作触发 `loadProjectFromDisk(rootDir)`
2. `project.listEntries` 列出文本文件
3. `loadProjectFromDisk` 对每个文件 `readFile`
4. 任务运行期间产生文件变化
5. `fs.watch` -> `App.tsx` -> `refreshFromDisk("fs.watch")`
6. `refreshFromDisk()` 再次逐个 `readFile`

### 为什么之前会漏掉

- 最近几轮修复重点放在：
  - runtime 语义补齐
  - restore 不丢历史
  - autosave 更稳
- 这些修复多数都成立，但它们保住的是“**恢复正确性**”，不是“**加载顺序**”。
- 所以现在出现的是典型结构性问题：
  - **保存侧已经瘦了一些**
  - **加载侧仍然是 eager**
  - 结果是用到后面还是会爆

## 6. Adjacent Risks

### 风险 1：启动时扫描并解析一堆 history tmp 候选

- 触发条件：历史目录存在大量 `conversations*.tmp`
- 同类原因：同样属于“大 JSON 启动即全量处理”
- 当前证据：
  - 本机 `42` 个 tmp，约 `194.54MB`
  - `history.loadConversations` 仍会扫描并 parse tmp
- 可能影响：
  - 即使 active conversation 并不大，启动/恢复也可能单独 OOM
- 建议：
  - **本次顺手修**

### 风险 2：启动时同时恢复 active conversation 与上次项目

- 触发条件：存在 lastProjectDir，且 active conversation 很重
- 同类原因：两个 eager load 在启动瞬间 fan-in
- 当前证据：
  - `App.tsx` 启动即 `loadProjectFromDisk(last)`
  - `conversationStore` 启动即 hydrate 全历史
- 可能影响：
  - “刚打开就卡/崩”，甚至还没开始新任务就顶到高水位
- 建议：
  - **本次顺手修**

### 风险 3：whole-snapshot clone/save 的高频热路径

- 触发条件：长任务、流式输出、UI 交互、自动保存
- 同类原因：反复处理同一份大 runtime snapshot
- 当前证据：
  - `ChatArea` 2 秒自动保存
  - `InputBar` / `NavSidebar` / `runTarget` 都会重建 snapshot
- 可能影响：
  - 不一定非要启动时；用到后面一样会爆
- 建议：
  - **本次至少先削峰；更深的增量持久化可后续单开**

### 风险 4：ChatArea 全量投影 + 全量渲染行构建

- 触发条件：长对话、steps/items 持续增长
- 同类原因：无窗口化、全量投影、全量 `map`
- 当前证据：
  - `getProjectedStepsFromRuntime(...)`
  - `buildRenderRows(renderSteps)`
  - 多处 `steps.map(...)`
- 可能影响：
  - 即使历史加载收口后，超长活动会话仍可能在 renderer 侧卡顿或高内存
- 建议：
  - **后续单开，但要在本次 brief 中明确挂账**

### 风险 5：项目索引全仓扫描与正文全读叠加

- 触发条件：大仓库、频繁 `fs.watch`
- 同类原因：都是 eager 全量处理，只是一个读元数据、一个读正文
- 当前证据：
  - `projectIndexStore.buildIndex()` -> `listAllEntries`
  - `refreshFromDisk()` -> 全文件 `readFile`
- 可能影响：
  - 大项目中即使正文懒读了，索引全扫仍可能让交互抖动
- 建议：
  - **后续单开；本次优先先砍正文全读**

## 7. Repair Options

### 方案 A（推荐）：Desktop-only 保守收口，先改加载顺序，再控运行态体积

- 范围：
  - 只动 Desktop
  - 不先动 gateway
  - 尽量复用现有 `v2 index + per-conv + segment restore`
- 核心动作：
  1. 历史改成 `index-first + active on-demand`
  2. 项目改成 `tree-first + file-lazy + path-based refresh`
  3. 暂停 happy path 对 tmp 的全量扫描；tmp recovery 只在主历史缺失/明显截断时触发
  4. 限制 `read` 大结果进入长期 runtime/history 的方式（truncate / pointer / 去重）
  5. 削减 whole-snapshot clone/save 的频率与范围
- 为什么契合当前系统：
  - 已有 `conversations.index.v2.json`
  - 已有 `conv_<id>.json`
  - 已有 `loadConversationSegment`
  - 已有 `ensureLoaded(path)`
- 新问题风险：
  - 活动会话恢复不完整
  - runtime item / proposal / undo 语义缺失
- 回滚点：
  - IPC 新接口保留旧接口旁路
  - 历史切换可通过 feature flag 或 fallback 恢复旧路径

### 方案 B（备选）：继续做止血，不改大范式

- 内容：
  - 更激进地瘦身 `snapshot.items`
  - 启动前清理 tmp
  - 降低 autosave 频率
  - 临时提高 V8 heap 上限做诊断
- 优点：
  - 改动面小
- 缺点：
  - 根因没切断
  - 数据继续增长后仍会复发
- 结论：
  - 只适合作为临时救火，不适合作为主修复方案

### 不推荐方案

- 只升级 Electron
- 只动 gateway
- 只靠系统代理/镜像切换
- 只加 `--max-old-space-size`

这些方案都不能解决“Desktop 自己一次性加载太多”的根因。

## 8. Patch Brief

### 8.1 建议改动文件

- `apps/desktop/electron/main.cjs`
- `apps/desktop/electron/preload.cjs`
- `apps/desktop/src/state/conversationStore.ts`
- `apps/desktop/src/ui/layouts/ConversationLayout.tsx`
- `apps/desktop/src/state/projectStore.ts`
- `apps/desktop/src/App.tsx`

### 8.2 建议改动模块 / 符号

- 历史：
  - 新增 `history.loadConversationIndex`
  - 新增 `history.readConversationSnapshot`
  - 保留 `history.loadConversationSegment`
  - `hydrateFromDisk()` 改为 index-only
- 项目：
  - `loadProjectFromDisk()` 改为只加载树 + 文件占位
  - `ensureLoaded(path)` 负责首次正文读取
  - `refreshFromDisk()` 改为 path-based / incremental
- 运行态：
  - `buildCurrentSnapshot()` 不再无差别深拷贝所有大对象
  - `read` 工具结果与 runtime item 去重 / 限流 / 截断

### 8.3 需要保持不变的旧行为

- `runtime items / turns / merge` 的已有修复语义
- active conversation 的恢复正确性
- `draftSnapshotOwnerId`
- `pending conversations` 的防数据丢失兜底
- dirty 文件的“本地优先，不被外部修改覆盖”
- proposal / undo / waiting-user 状态恢复

### 8.4 最小 diff 草案

1. `main.cjs`
   - 启动优先读 `conversations.index.v2.json`
   - 正常路径不再 parse 全部 `tmp`
   - 只在显式 recovery 分支下读 tmp / bak
2. `conversationStore.ts`
   - 启动只 hydrate 轻量 metadata
   - 激活对话时才读 snapshot + segment
3. `projectStore.ts`
   - 初次打开项目只放 `{ path, loaded:false }`
   - 打开 tab / 预览时调用 `ensureLoaded`
4. `App.tsx`
   - `fs.watch` 只刷新受影响路径，不再全量 `refreshFromDisk`
5. 运行态
   - 给 `read.result.content`、runtime item 总数、重复 item 保留策略加硬上限

### 8.5 重点 review 的高风险点

- `main.cjs` 与 `conversationStore.ts` 当前工作区已有未提交改动，patch 必须基于现状重放，不能覆盖 WIP。
- index-only hydrate 后，未加载会话不能被错误写回空 snapshot。
- 项目懒读后，外部删除/重命名/dirty 冲突的 UX 要继续成立。

## 9. Validation & Handoff

### 9.1 最小验证清单

1. 启动带重历史的 Desktop，首页只出现轻量会话列表，不再在启动阶段高峰 OOM。
2. 进入某个 heavy conversation 时，只加载该会话详情，其他会话保持轻量。
3. 恢复 active conversation 后，`runtime items / turns / proposal / waiting-user` 语义不丢。
4. 打开大项目时，项目树先出来；未打开文件不读取正文。
5. 任务运行期间产生 `fs.watch` 事件时，不再整项目全文重读。
6. `read` 大结果不会再被双份长期保留到足以把历史撑爆。
7. 历史 tmp cleanup 不会误删最新有效文件，且超过阈值的旧 tmp 能被可靠清走。

### 9.2 回归风险

- 恢复内容不完整
- 恢复错会话
- active conversation 首屏内容过少
- dirty 文件与外部修改冲突处理退化

### 9.3 未解问题

- `read` 工具的长正文，最终应该存“截断内容”还是“artifact pointer”，这需要和后续 spec 一起定合同。
- ChatArea 的窗口化 / 虚拟列表是否本期要一起做，建议先不并入 P0。

### 9.4 给 `$spec-writer` 的输入摘要

- 目标：
  - 解决 Desktop 侧会话恢复与项目加载导致的 OOM / 崩溃
- 范围：
  - 只做 Desktop
  - 历史 index-first
  - active conversation on-demand
  - 项目 tree-first + file-lazy
- 不做什么：
  - 不先动 gateway
  - 不顺手重写整个 runtime 合同
  - 不把 ChatArea 全量虚拟化并入 P0
- 现状关键点：
  - `runtime items / turns / merge` 语义修复必须保留
  - `loadConversationSegment` 与 `ensureLoaded(path)` 已存在，可直接复用
  - 当前真正的缺口是 **加载顺序**
- 相邻隐患与边界：
  - tmp 扫描、whole-snapshot clone/save、ChatArea 全量渲染、projectIndex 全扫
  - 本期先切 eager 主链，其他风险明确挂账
- 推荐方案：
  - 采用 `docs/specs/desktop-history-index-first-loading-v0.1.md` 的历史收口方向，并补上项目 lazy load 的对应 P0
- 风险：
  - 恢复语义回归高于实现复杂度风险
- 验证：
  - 以上 `9.1 最小验证清单`
