# 工具面重构：FS + Runtime + 模式 v0.1

> 目标：在保持 Crab 现有 KB / Style / Run 优势的前提下，对齐 OpenClaw / Codex 的工具范式：
> - 文件工具少而强：统一成 `read/write/edit/...`，减少 `doc.*` 噪音；
> - 新增 runtime 能力：`shell` / `process` / `cron` 等“助手级”工具；
> - 通过「创作模式 / 助手模式」双态，把权限边界和风险做显式化。

---

## Phase 0：现状快照（对齐对象）

### 0.1 Crab 现状

- FS / 文档工具：
  - `doc.read` / `doc.write` / `doc.applyEdits` / `doc.mkdir` / `doc.renamePath` / `doc.deletePath`
  - 编辑器相关：`doc.getSelection` / `doc.replaceSelection`（三栏 VSCode 范式遗留）
  - 辅助：`doc.snapshot` / `doc.previewDiff`
- 运行工具：
  - `code.exec`：主要做 Python 代码执行，用于 Office/PDF 解析等场景（本身不等于 shell）。
- 业务工具：
  - KB：`kb.*`
  - Style：`lint.copy` / `lint.style`
  - Run：`run.todo.*` / `run.mainDoc.*` / `run.done`
  - Web：`web.search` / `web.fetch` + Playwright MCP

特点：
- 在「写作闭环 / 风格模仿」上比 OpenClaw 强很多（有 Skill + Gate + RunState）。
- 但缺少类似 OpenClaw 的通用 `shell/cron/process` 工具，不具备“真正助手级”的本机操作能力。
- FS 工具有一堆 `doc.*` 前缀和细粒度变体，增加了 LLM 工具选择复杂度。

### 0.2 对标 OpenClaw / Codex

- OpenClaw：
  - FS：`read/write/edit/apply_patch` 为主，少量工具覆盖 80% 读写；
  - Runtime：`exec/process/cron` 等工具让 Agent 能真正管理本机任务；
  - system prompt 明确 workspace/sandbox 语义。
- Codex：
  - Shell 能力默认在「项目 sandbox」内运行，支持扩权；
  - 有“助手级”模式，可以帮用户装软件/改配置，但前提是确认 + 审计。

本 spec 的目标就是在 Crab 里补齐这些能力，并做成两种模式：

- **创作模式（Creative）**：默认、安全，完全覆盖“内容团队”场景；
- **助手模式（Assistant）**：显式开启、红色告警，允许本机操作，但仍受 proposal-first 与高危拦截约束。

---

## Phase 1：FS 工具收敛（doc.* → read/write/edit/...）

### 1.1 重命名与合并

将现有文件相关工具收敛为一小组语义清晰的工具，降低 LLM 负担：

- `doc.read`      → `read`   （读取文本/文件，支持 path）
- `doc.write`     → `write`  （创建/覆盖文件）
- `doc.applyEdits`→ `edit`   （对既有文件做 patch 级修改）
- `doc.mkdir`     → `mkdir`  （创建目录）
- `doc.renamePath`→ `rename` （重命名文件/目录）
- `doc.deletePath`→ `delete` （删除文件/目录）

保留但后续可重命名为 `fs.*`：

- `doc.snapshot`   （快照，供 Undo / 审计用）
- `doc.previewDiff`（展示 diff，配合 proposal-first）

直接移除的编辑器选区工具：

- `doc.getSelection`
- `doc.replaceSelection`

理由：UI 已经不再是三栏 VSCode 范式，选区概念在当前产品里不再是主入口；保留只会增加工具面复杂度。

### 1.2 行为约束（创作 / 助手模式一致）

无论模式如何，FS 工具都必须遵守：

- **proposal-first 写入**：
  - 高风险写入（大文件、批量删除、重命名目录）必须先通过 `edit` + diff 预览，让用户确认后再 apply；
  - Desktop 保持 Undo 能力，对每次写入存一份 snapshot。  
- **工作目录限制**：
  - 即便在助手模式，`read/write/edit/mkdir/rename/delete` 默认只作用于当前 workspace 根目录及子目录；
  - 如果未来允许跨目录访问，也必须有额外确认与白名单（例如仅允许访��� `$HOME/.ohmycrab`）。

### 1.3 实施步骤

1. 在 `packages/tools/src/index.ts` 中：
   - 新增 `read/write/edit/mkdir/rename/delete` ToolMeta；
   - 将旧的 `doc.*` 工具标记为 deprecated 或直接删除（本地破坏性改动阶段可以直接删）；
   - 保留 `doc.snapshot` / `doc.previewDiff`，后续再统一归类为 `fs.*`。
2. 在 Gateway：
   - 更新 `serverToolRunner` / `GatewayRuntime` / `writingAgentRunner` 中的工具白名单与写入审计逻辑；
   - 所有基于字符串匹配 `doc.` 的逻辑改成匹配新的工具名集合（例如 `isContentWriteTool(name)`）。
3. 在 Desktop：
   - 更新 `toolRegistry` 中的工具实现注册，从 `doc.read` 等改为新名字；
   - 调整 `HIGH_RISK_FILE_OP_TOOL_NAMES` 等列表，指向 `write/edit/delete/rename`；
   - 去掉 selection 相关 UI/逻辑（如有）。

验收：本地走一遍标准写稿闭环（style_imitate），确保所有涉及文件读写的地方正常工作。

---

## Phase 2：新增 Runtime 工具（shell / process / cron）

### 2.1 设计原则

- **职责分离**：
  - `code.exec` 仍用于 Python 等“算法型”执行（如 Office/PDF 解析），不扩展为 shell；
  - 新增单独的 `shell.exec` 做真正的命令执行；
  - `process.*` 只管理由 Crab 自己拉起的子进程，不暴露系统全部进程；
  - `cron.*` 作为本地自动化/定时任务的薄封装。
- **默认高风险**：
  - 这些工具在 ToolMeta 上统一标记 `riskLevel: "high"`；
  - Gateway & Desktop 必须在执行前做模式 + 提案 + 二次确认。

### 2.2 新工具草案

1) `shell.exec`

- 作用：在本机执行命令，主要用于：
  - 运行项目脚本（`npm test` / `pytest` 等）；
  - 安装/更新依赖（在助手模式下，经用户确认）；
  - 调用外部 CLI 工具（如 `git`）。
- 建议参数：
  - `command: string`（必填）
  - `args?: string[]`
  - `timeoutMs?: number`
  - `cwd?: string`（默认当前 workspace 根目录）
- 安全约束：
  - 创作模式：一律禁用（调用即返回“需要助手模式”错误）；
  - 助手模式：
    - 限定默认 `cwd = workspaceRoot`；
    - 对明显危险命令（如 `rm -rf /`、修改 ~/.ssh、清空系统目录等）直接拒绝；
    - 对安装类命令（`apt/brew/pip/npm install -g` 等）弹二次确认。

2) `process.run` / `process.list` / `process.stop`

- 作用：管理由 Agent 启动的长跑任务（如本地 dev server、长时间数据处理脚本）。
- 约束：
  - 只能列出 & 停止**自己启动的**子进程（通过本地 ProcessManager 记录）；
  - 不暴露系统全量进程列表。

3) `cron.create` / `cron.list`（可选 `cron.delete`）

- 作用：为本地项目创建简单的定时任务，例如：
  - “每天 9 点跑一次单测”；
  - “每周一生成一份项目健康报告”；
- 实现：
  - 作为 Codex automation 的 thin wrapper，底层用现有 automations 机制；
  - 遵守 automation 的 RRULE 约束（只用 WEEKLY / HOURLY 等有限子集）。

### 2.3 实施步骤

1. 在 `packages/tools/src/index.ts` 中定义以上 ToolMeta，并标记 `riskLevel: "high"`；
2. 在 Desktop（Electron 主进程）实现对应执行逻辑：
   - `shell.exec` 使用 `child_process.spawn` / `exec`，控制 cwd/timeout；
   - `process.*` 用一个进程表记录子进程信息；
   - `cron.*` 调用 Codex automations API 或直接写 automation.toml。
3. 在 Gateway 里：
   - 将这些工具纳入工具目录，但在 `computePerTurnAllowed` 里默认禁止（除非助手模式）；
   - 对于 high-risk 工具统一走“提案 → 用户确认 → 真执行”的路径。

验收：本地在助手模式下，通过对话让 Agent 帮忙跑一次测试脚本（如 `npm test`），并可列出/停止该进程。

### 2.4 与 OpenClaw / Clawdbot 的对齐说明

参考 `docs/research/writing-batch-jobs-v0.1.md` 中对 **Clawdbot** 的分析：  
- Clawdbot / OpenClaw 把 `session、tools、events、cron、presence` 等统一收敛到 **Gateway 控制平面**；  
- 桌面/CLI 只是 client，所有定时任务调度都由常驻的 daemon 完成（`--install-daemon`）。  
- Cron job 存储在 Gateway 主机的 `~/.openclaw/cron/jobs.json` 下，本质上是“按操作系统用户”隔离的本地仓库；  
- Job 记录里还支持 `agentId` 等绑定，用于“同一 Gateway 进程内，不同 Agent/账号的任务隔离”——等价于我们未来的 `ownerUserId + agentId` 维度。  

本仓库 v0.1 的取舍是：

- 在工具语义上保持对齐：  
  - `cron.create/cron.list` 都是对“本地 automation + RRULE” 的薄封装，使用简单 RRULE 子集（`MINUTELY/HOURLY/WEEKLY`），方便将来迁移到 Gateway 控制平面；  
  - Automation 元数据落盘到 `<userData>/automations/<id>/automation.toml`，结构上预留了 `status/cwds/source` 等字段，方便后续由 Gateway 接管。  
- 在调度实现上先求稳：  
  - v0.1 scheduler 放在 **Desktop Electron main** 中，以“每分钟 tick + 读 automation.toml + 决定是否起一个新 run”的方式模拟 Gateway cron；  
  - 真正的“起 run”依然通过 Gateway（例如新增 `/api/automations/run` 或复用现有 runFactory），Desktop 只负责计算“什么时候起这一枪”；  
  - Desktop 关闭时不调度任务，这一限制在文档中明确标记为 v0.1 行为，不冒充系统级常驻服务。  
- 多用户视角上，对齐 OpenClaw 的做法是：  
  - **当前 v0.1（本地版）**：每套 Desktop 数据目录（`app.getPath("userData")`）天然对应“这一台机器上的某个 OS 用户”，`<userData>/automations/**` 等价于 OpenClaw 的 `~/.openclaw/cron/`——已经是“按 OS 用户隔离”的；  
  - **Gateway（线上版）**：Gateway 自身已经是多账号架构（B 端和个人账号复用同一 Gateway，只是 auth/租户不同），后续把 cron/automations 接到 Gateway 时，应在持久层记录中增加 `ownerUserId`（以及可选 `agentId`），调度 tick 时按 `ownerUserId` 维度筛选 job 再起 run，这样就可以在一个 Gateway 进程里为多个“应用内账号”分别跑各自的 cron。  

Roadmap（对齐 OpenClaw 的方向）：

- v0.2+ 以后，如果需要“App 关闭也能跑 cron”（例如定时拉取竞品、推送报告），会把：  
  - automation 元数据同步/迁移到 Gateway 持久层（SQLite 表 + automation.toml/JSON），并为每条记录补充 `ownerUserId`（以及可选 `agentId`）；  
  - scheduler 挪到 Gateway 常驻进程，在已有多账号 Gateway 上按 `ownerUserId` 做逻辑隔离，由 Gateway 主动起 run；  
  - Desktop 仅作为“配置/可视化面板”，负责触发 `cron.create/cron.list` 等工具，底层语义与 v0.1 保持兼容。  

这样可以做到：**工具契约一次设计，对齐 OpenClaw；实现路径先从 Desktop main 起步，再逐步向 Gateway 控制平面收敛**。

---

## Phase 3：创作模式 vs 助手模式（权限模型）

### 3.1 模式语义

- **创作模式（Creative，默认）**
  - 定位：安全的“一个人的内容团队”模式；
  - 权限：
    - 允许 KB / Style / Run / Web / FS（`read/write/edit/...`）；
    - 禁止所有 runtime 高危工具：`shell.exec` / `process.*` / `cron.*`；
    - 如有必要，可允许少量“白名单命令”（例如只跑测试）——但推荐一开始先完全禁用 shell。  
  - 工作目录：完全限制在 workspace 内；
  - UI：常规顶部状态，无额外警示。

- **助手模式（Assistant，显式开启）**
  - 定位：对标 Codex 的“真正助手级”模式，可帮用户装软件、改配置、整理本机文件；
  - 权限：
    - 所有创作模式能力；
    - 额外开放 runtime 高危工具：`shell.exec` / `process.*` / `cron.*`；
  - 约束：
    - 仍然遵守 proposal-first；
    - 极端危险操作（如系统盘删除、SSH/密钥修改等）一律拒绝，不因助手模式开放；
  - UI：顶部标签永久红底+感叹号，例如「助手模式！」，悬停提示“已授权本机操作，请谨慎使用”。

### 3.2 模式在架构中的落点

- Desktop：
  - 在全局 state 里增加 `mode: "creative" | "assistant"`；
  - 模式切换入口：
    - 从原“探索/创作”改成“创作/助手”二选一；
    - 切到助手模式时弹确认对话框，说明权限差异与风险；
  - 每条工具调用前，Desktop 可根据 `mode` 再做一层客户端过滤（避免无意义请求到 Gateway）。

- Gateway / Runtime：
  - 在 runContext 中携带 `mode`，并写进 system prompt：
    - 创作模式：
      > “当前为创作模式，只能在项目 workspace 内读写文件，禁止执行 shell 命令或安装软件。”
    - 助手模式：
      > “当前为助手模式，可以在用户本机执行命令，但所有高风险操作必须先解释风险并征求确认。”
  - `computePerTurnAllowed`：
    - 如果 `mode === "creative"`：直接将 `shell.exec` / `process.*` / `cron.*` 从 allowed 列表中剔除；
    - 如果 `mode === "assistant"`：允许这些工具进入 allowed 集合，但标记为高风险，强制 proposal-first。

### 3.3 交互与安全细节

- 模式粒度：
  - UI 体现为全局模式，但每个 run 记录自己的 `mode`，便于审计（日志里能看到“这个 run 在助手模式下执行”）。
- 高风险二次确认：
  - 即便在助手模式下，对以下操作仍需弹出确认：
    - 安装/卸载系统级软件；
    - 删除大量文件或重要目录；
    - 修改影响全局配置的文件（如 shell 配置、Git 全局配置等）。
- 提示策略：
  - 当 Agent 在创作模式下尝试调用 `shell.exec` 等工具时，Gateway 返回一个结构化错误，提示模型转而向用户解释：“需要开启助手模式才能执行这类操作”。

验收：在 UI 中切换到助手模式后，通过 Agent 正常执行一次 `shell.exec`；切回创作模式后再尝试，工具调用被拒绝并给出明确提示。

---

## Phase 4：文档 & AGENTS 接入

- 本文件 `docs/specs/tools-fs-and-runtime-refactor-v0.1.md` 作为工具面重构的主规格说明；
- 在仓库根 `AGENTS.md` 中增加一条索引：
  - 在“工具协议 / 工具面”相关段落下，增加指向本文件的链接说明；
  - 简要说明：
    - FS 工具已经收敛为 `read/write/edit/...`；
    - 新增 runtime 工具（shell/process/cron）和「创作/助手模式」权限模型；
    - 默认创作模式安全，助手模式需显式开启且 UI 红色告警。

### 4.1 当前实现状态小结（2026-03-12）

为方便后续迭代，这里补一份与规范对照的“已完成 / 占位”摘要：

- **已完成**
  - FS 工具已统一为 `read/write/edit/mkdir/rename/delete`，并按 proposal-first 走快照 / diff 机制；
  - 新增 `shell.exec`：
    - Desktop Electron 使用 `spawn` 实现，限定 `cwd = workspaceRoot`；
    - Gateway 在 `computePerTurnAllowed` 中根据 `opMode`（创作/助手）裁剪可见性；
    - Runtime 额外硬拦截明显危险命令（如 `rm -rf /` / `rm -rf ~` / `rm -rf *`）；
  - 「创作/助手模式」：
    - Desktop 有显式模式切换 UI（创作/助手），助手模式有确认弹窗与红色告警；
    - Gateway 在 `runCtx.opMode` 与 per-turn allowlist 中生效，对 runtime 高危工具做二级 gate。

- **仍为占位 / TODO**
  - `cron.create` / `cron.list`：
    - Desktop 侧已接入本地 automations 目录：在 Electron main 中以 `<userData>/automations/<id>/automation.toml` 形式读写；
    - Gateway 已在工具门禁中按 `opMode` 把 cron 视为高危 runtime 工具，仅在助手模式下开放；
    - 目前只负责“创建/枚举定时任务元数据”（name/prompt/rrule/cwds/status），尚未实现真正的调度器 / run 触发（由后续 scheduler 接管）。
  - `shell.exec` 安装类命令的提示策略：
    - 当前策略：只要进入助手模式，`brew` / `winget` / `npm` / `pip` 等包管理器命令一律视为允许（仍为 high risk），不再额外引入“更黑一档”的模式；
    - 仍需补充：给 Agent 更清晰的 system 提示，鼓励在执行安装/升级类命令前，用自然语言向用户说明即将执行的命令与影响，再由用户确认（不强制二次弹窗）。

上述 TODO 不影响现有写作 / KB / style_imitate 闭环，但在真正放开“助手级”能力前，需要按本 spec 的 Phase 2 继续补齐。
