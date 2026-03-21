# Electron 桌面端 macOS 后台崩溃排查（2026-03-20）

## 背景

- 现象：dev 模式桌面端在 **选择项目** 后、**任务运行过程中** 崩溃。
- 崩溃报告：`/Users/noah/Library/Logs/DiagnosticReports/Electron-2026-03-20-165539.ips`
- 进程：`Electron 34.5.8`
- 线程：`CrBrowserMain`
- 关键信号：`SIGABRT`
- 关键栈：`node::OnFatalError -> node::PromiseRejectCallback -> v8::String::NewFromUtf8 -> fontations_ffi`

## 本地事实

### 1. 不是普通 renderer 白屏

- 崩溃发生在主进程主线程，不是常见的 `render-process-gone` 白屏类问题。
- `.ips` 只有 `abort() called`，没有直接出现 `JavaScript heap out of memory` / `Allocation failed`。

### 2. 触发链和“项目已选中、任务在跑”高度一致

- 打开项目会启动：
  - 项目文件监听：`apps/desktop/electron/main.cjs`
  - 项目刷新：`apps/desktop/src/state/projectStore.ts`
  - 项目索引全量扫描：`apps/desktop/src/state/projectIndexStore.ts`
- 任务运行时又会持续产出文件、刷新状态，因此 `fs.watch -> project.fsEvent -> renderer` 是高频链路。

### 3. 当前 Electron 版本过旧且已脱离支持线

- 当前仓库 pin：`apps/desktop/package.json` 中是 `electron: 34.5.8`
- 2026-03-20 当天官方 npm dist-tag：
  - `34-x-y: 34.5.8`
  - `39-x-y: 39.8.3`
  - `40-x-y: 40.8.3`
  - `41-x-y/latest: 41.0.3`

### 4. 第二轮新证据：已经出现明确 V8 OOM

- 后续复现时，控制台不再只是 `abort() called`，而是明确出现：
  - `OOM error in V8: Ineffective mark-compacts near heap limit`
  - `Allocation failed - JavaScript heap out of memory`
- 本机历史目录实查：
  - `~/Library/Application Support/OhMyCrab/ohmycrab-data` 约 `227M`
  - `conversations.v1.json` 约 `11M`
  - 目录下存在大量历史遗留 `conversations*.tmp`
- 对最大单条对话拆解：
  - 对话总大小约 `4.19M`
  - 其中 `snapshot.items` 单独约 `3.55M`
  - 最大项是 `toolCall` item，单条约 `116KB ~ 118KB`
  - 主要膨胀字段是 `result.content`
  - `read` 工具把整段课程原文带进了历史快照
  - 且同一工具调用存在两类 item（本地 shadow item + runtime item），进一步放大体积

## 一手来源

### Electron 官方支持计划

- 官方支持时间线：<https://releases.electronjs.org/schedule>
- 截至 2026-03-20，支持中的稳定分支是 `39 / 40 / 41`，`34` 已不在支持线内。

### Electron 官方 macOS Tahoe 兼容修复

- issue：<https://github.com/electron/electron/issues/48311>
- PR：<https://github.com/electron/electron/pull/48376>
- 结论：Electron 官方明确承认 macOS 26（Tahoe）需要兼容修复，且修复回补到较新的受支持分支。

### Electron 官方后台/IPC 崩溃问题

- issue：<https://github.com/electron/electron/issues/50247>
- 现象：窗口在后台时，向 renderer `webContents.send` 可能触发异常崩溃，而不是正常抛 JS 错。
- 这与本次“进程 role 为 Background + 主线程 V8/string 相关 abort”形态接近，但不能直接视为同一个 bug。

## 判断

### 高概率判断

- 这次不是单一根因，更像 **两条问题叠加**：
  1. **Electron 34.x 在 macOS 26 上的后台主进程/IPC/字符串桥接类崩溃**
  2. **桌面端历史快照持续膨胀，最终主进程命中 V8 old space OOM**
- “选项目 + 跑任务”只是把这两条链同时放大了：
  - 一边放大 `fs.watch` / 状态推送
  - 一边放大 `read` / tool runtime item / 历史落盘

### 当前优先级下调

- 原生文件选择对话框：仍可留作候选，但根据“选完项目后、任务运行过程中才崩”，优先级已经明显低于上面两条主链。

## 方案收敛

### 方案 A：只升级 Electron

- 优点：能吃到官方对 macOS 26 的修复。
- 缺点：如果根因是后台发送链路，单纯升级不够稳。

### 方案 B：只在本地加 try/catch

- 优点：改动小。
- 缺点：如果崩点发生在 `webContents.send` 更底层，普通 try/catch 不一定兜得住。

### 采用方案

- **两者一起做**
  0. 先把历史快照体积压下来，避免 IPC/JSON 序列化继续放大
  1. 升级到支持中的稳定版 Electron
  2. 给主进程加统一 `safeSend` 护栏
  3. 对 `project.fsEvent` / `mcp.statusChange` 这类低优先级推送在 macOS 后台时做延迟发送
  4. 落盘 breadcrumb，便于下次对照崩前动作
  5. 清理过期 `conversations*.tmp`

## 本次实现落点

- 主进程统一发送护栏：`apps/desktop/electron/main.cjs`
- 项目监听/索引 breadcrumb：`apps/desktop/electron/main.cjs`
- 版本升级：`apps/desktop/package.json` + 根 `package-lock.json`
- 历史快照瘦身：`apps/desktop/src/state/conversationStore.ts`
- 历史保存日志/旧 tmp 清理：`apps/desktop/electron/main.cjs`
- 排障沉淀：`debug.md`

## 验证建议

1. 打开桌面端，选择一个项目。
2. 启动会写文件的任务。
3. 让窗口退到后台几分钟。
4. 检查是否仍会崩溃。
5. 若仍崩溃，优先查看：
   - `~/Library/Logs/DiagnosticReports/*.ips`
   - `~/Library/Application Support/OhMyCrab/logs/desktop-main-events.jsonl`
