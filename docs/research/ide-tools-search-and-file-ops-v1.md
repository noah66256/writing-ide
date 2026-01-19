# IDE 工具与全项目搜索（写作 IDE）研究与落地 v1

> 目标：让「写作 IDE」具备 IDE 应有的**文件操作**与**全项目搜索**能力，并让 Agent 在“能力边界清晰”的前提下真正会用这些工具（proposal-first / 可 Undo），同时避免被风格库（style gate）误伤。

## 1. 需求澄清（本项目语境）

- **必须具备（写作 IDE 的核心）**
  - **文件/目录操作**：新建目录、重命名/移动、删除（真删磁盘文件）
  - **全项目搜索**：在项目内跨文件搜索（并可跳转到路径/行）
  - **安全与可控**：高风险变更默认 **proposal-first（Keep 才 apply）**，且尽可能可 Undo
  - **能力边界**：不允许“改终端/跑命令行”；文件操作仅限项目根目录内

- **可选增强（后续）**
  - Replace in Files（跨文件批量替换，必然高风险）
  - 索引化搜索（大项目/实时搜索体验）
  - “全网搜索”（需要显式提供 `web.search` 工具与权限、审计、隐私策略；未提供工具前不得声称联网）

## 2. 范式：Tool Registry + proposal-first + Undo

我们当前已有的机制已经满足 IDE 工具的核心范式：

- **工具契约单一来源**：`packages/tools/src/index.ts`（Gateway 用于 toolsPrompt/allowlist；Desktop 用于校验提示）
- **执行位置**：
  - 读写项目文件：默认 **Desktop 执行**（真正落盘，且受限于 project root）
  - 只读、可由 sidecar 提供：可逐步迁回 **Gateway 执行**（如 `project.listFiles`/`project.docRules.get` 已支持）
- **proposal-first / Undo**：
  - Medium/High 风险工具返回 `apply()`，UI 点击 **Keep** 才真正 apply；`apply()` 返回 `undo()` 供 **Undo** 回滚

> 参考：VSCode/Cursor 通过“命令/工具注册表 + 安全边界（工作区）+ 可撤销”来完成 IDE 动作的可控执行。

## 3. 全项目搜索：三条主流路线对比（全网+GitHub 常见选型）

### 3.1 Route A：直接扫描（MVP，最小闭环）

- **做法**：遍历项目文本文件，按行做 substring/regex 匹配
- **优点**：零外部依赖、实现快、跨平台
- **缺点**：大项目会慢；实时/输入即搜体验差
- **适用**：写作项目（文件数量/体积通常可控）、先打通端到端能力

### 3.2 Route B：ripgrep（工业级全文搜索，速度与体验更好）

- **做法**：随 Desktop 打包 ripgrep 二进制（或使用 `@vscode/ripgrep`），由 Electron Main 进程 spawn 执行；结果回传 Renderer
- **优点**：极快、成熟、VSCode 生态验证；支持 regex、glob、ignore 规则
- **难点**：打包与跨平台分发（Windows/macOS/Linux）需要处理二进制随包、`asarUnpack` 等细节
- **适用**：需要接近 VSCode 的“Find in Files”性能与体验

参考：
- ripgrep：`https://github.com/BurntSushi/ripgrep`
- vscode-ripgrep：`https://github.com/microsoft/vscode-ripgrep`

### 3.3 Route C：SQLite FTS5 / 持久化索引（长远方案）

- **做法**：维护一个本地索引库（增量更新：监听文件变动），查询走 FTS5；必要时结合 trigram/缓存
- **优点**：可做到“输入即搜”、支持复杂排序/分页/历史；可做“搜索面板”体验
- **难点**：索引构建/增量维护/一致性（删除、移动、忽略规则）、数据迁移与损坏恢复
- **适用**：文件量较大、需要持续高频搜索、希望更像 IDE 的“持久索引”

参考：
- SQLite FTS5：`https://www.sqlite.org/fts5.html`

### 3.4 纯 JS 索引（FlexSearch/MiniSearch/Lunr）作为折中

- **做法**：在本地内存或持久化 JSON 建索引；适合 Markdown/小中型文本集合
- **优点**：实现/集成相对轻；不依赖外部二进制
- **缺点**：大规模与增量更新要自己处理；regex 能力有限

参考：
- FlexSearch：`https://github.com/nextapps-de/flexsearch`
- MiniSearch：`https://github.com/lucaong/minisearch`

## 4. 写作 IDE 的推荐落地（我们项目最合适）

### 4.1 v1（本轮落地）

- **文件工具（IDE 体验：立即生效 + Undo）**
  - `doc.deletePath`：删除文件/目录（真删磁盘；**立即执行**；Undo 通过快照回滚恢复）
  - `doc.renamePath`：重命名/移动（**立即执行**；Undo 通过快照回滚恢复）
  - `doc.mkdir`：创建目录（低风险可 auto_apply；Undo 回滚）
- **项目搜索**
  - `project.search`：跨项目搜索（先做扫描式实现；返回命中列表）

### 4.2 v2（性能升级）

- Desktop 引入 ripgrep（B 方案），把 `project.search` 的实现替换为 ripgrep，并支持：
  - glob include/exclude
  - caseSensitive / regex
  - 上下文行数

### 4.3 v3（索引化）

- 引入 SQLite FTS5（或 trigram 持久索引），在 Dock Panel 的 Search Tab 做“输入即搜”体验；
- 与文件监听联动增量更新索引；
- 未来可把“KB/项目/引用”的检索统一为一个 Search 面板（多域、多来源）。

## 5. 与风格库（StyleGate）冲突的关键修正

我们遇到过一个真实误伤：**绑定风格库 + 旧 todo（写作任务）+ 用户短句续跑** 会把“删文件”误判为写作，从而启用 style gate，进而禁用 `doc.deletePath`（被视为 write-like）。

本轮修正原则：
- **文件操作意图（删除/移动/重命名/建目录）不应触发写作闭环**；
- 即使 todo 看起来是写作，也不应因此把“删旧稿”强行纳入 style gate。

对应落地点：`packages/agent-core/src/runMachine.ts` 的 `deriveWriteIntent`（sticky 逻辑）与 Gateway 的 Intent Router（Phase0 识别 file-ops）。

## 6. 验证清单（你回来可直接验收）

- **工具可见性**
  - 在 Plan/Agent 模式：模型能看到 `project.search/doc.deletePath/doc.renamePath/doc.mkdir`
- **真删 + 可撤销**
  - 让 Agent 删除一个文件：应立即删除、Explorer 刷新
  - 点击 Undo：文件恢复（内容一致）
- **风格库不再劫持文件操作**
  - 绑定 style 库 + 已有写作 todo 的情况下，输入“删那 4 篇旧稿”：应允许走删除工具，不被要求先 kb.search


