# Crab 基础工具暴露改造开工文档（2026-03-13）

> 主题：把“21 个基础工具”从零散 if/else 收拢成一个可治理的核心目录，并对齐 OpenClaw/Codex 的成熟范式。

## 0. 背景与现状问题

当前 Crab 的工具体系已经有几块比较成熟的基石：

- 单一来源工具定义：`packages/tools/src/index.ts`
- Tool Retrieval v0.1：`docs/specs/tool-retrieval-v0.1.md`
- 对标 Codex / OpenClaw 的调研：  
  - `docs/research/codex-openclaw-intent-routing-and-tool-exposure-benchmark-2026-03-11.md`  
  - `docs/research/mcp-hierarchical-tool-selection-v1.md`  
  - `docs/research/tooling-platformization-phased-plan-2026-03-11.md`

但在 gateway 实际落地上，依然存在几类问题：

1. **基础工具暴露是“散装 if/else”而不是“表驱动”**
   - 不同 opMode（创作/助手）下开放哪些工具，常常散落在 `runFactory` / `toolCatalog` 等处的条件判断里；
   - 一旦场景多起来（风控、特权模式、Skill 内部调度），很难从“全局视角”看清楚：**这个模式下，Agent 到底有哪些基础能力**。

2. **builtin 与 MCP/插件工具在裁剪时混在一起**
   - 尽管 Tool Retrieval 里有“coreAlwaysOn”这个概念，但在具体实现里，builtin 工具和 MCP 工具经常被扔到同一个 top-K 上做裁剪；
   - 结果就是：某些回合里，像 `web.search` / `read` / `write` 这种“交付级基础工具”有时会从 allowed set 里消失——这和 Codex/OpenClaw 的经验是相反的。

3. **IDE 时代遗留工具（例：project.search）已经与现范式不符**
   - `project.search` 这类工具，原本是三栏 IDE 范式里的“项目内搜索入口”；
   - 现在 Crab 是“纯对话范式 + L2 动态索引”——在这种语境下，它既不符合 UX，也容易干扰当前的工具路由（模型会误以为“本仓库搜索只能靠它”）。

## 1. 目标：收拢为“核心工具目录 + opMode 映射”

本轮改造的目标，不是再叠一层复杂度，而是用一套结构把已有的散装逻辑收拢起来：

1. **建立一个轻量的“核心工具目录”**
   - 在 gateway 层（而不是 `packages/tools`）增加一个 `CORE_TOOLS` 视图：
     - 每个工具只关心三个标签：`sectionId`、`riskLevel`（沿用现有）和 `opModeProfile`；
     - section 粗分为：`fs` / `web` / `kb` / `runtime` / `run` / `memory`。

2. **用 opMode（创作 / 助手）替代额外的 profile 维度**
   - 不额外引入 OpenClaw 那一整套 `minimal/coding/messaging/full`；
   - 而是把它压缩映射到我们已有的 opMode 上：
     - 创作模式 ≈ 安全/创作 profile：不开高危工具，只暴露写作/检索/知识库/基础文件操作；
     - 助手模式 ≈ 全功能 profile：在创作模式基础上，打开 shell/cron/process 等高危能力。

3. **在 Tool Retrieval v0.1 的 B2 阶段明确 coreAlwaysOn 的组成**
   - 把“哪些工具永远在”从自然语言描述，收拢为一个显式常量集合：
     - `CORE_TOOLS`：21 个基础工具；
     - 其中一部分标记为“交付不变量”（例如 `write` / `doc.previewDiff` / `doc.snapshot` / `run.*`），在任意 agent 模式下都必须存在；
   - Tool Retrieval/B2 以后只对 MCP/插件工具做检索/扩展，**不再对 CORE_TOOLS 做裁剪**。

## 2. 与 OpenClaw / Codex 的对齐与取舍

参考对照仓库：

- OpenClaw：`/Users/noah/Crab/openclaw/src/agents/tool-catalog.ts`  
  - 有完整的 `CORE_TOOL_SECTION_ORDER` + `CORE_TOOL_DEFINITIONS` + `ToolProfileId`；
  - 再通过 `tool-policy-pipeline` 把 profile/global/agent/group policy 串起来，并用 `stripPluginOnlyAllowlist` 兜底核心工具。
- Codex：`third_party/openai-codex`  
  - 自身更强调的是 config/allowlist/approval_policy 与 sandbox 的联动；
  - 工具调用作为事件类型（`command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `todo_list`）出现在 SDK 中。

本轮 Crab 的改动选择：

- **继承 OpenClaw 的：**
  - “核心工具有一个稳定的目录视图”这一点；
  - “核心工具与 MCP/插件工具在策略上分层”的思路。

- **继承 Codex 的：**
  - 高危工具（shell/cron/process）的 approval_policy 与 sandbox 敏感度；
  - 把“工具 = 能力 + config/allowlist + approval_policy”作为治理边界。

- **刻意不照搬的：**
  - 不引入 OpenClaw 那样完整的 profile 矩阵，只保留 opMode（创作/助手）这个更贴近 UX 的开关；
  - 不在 Crab 里重建 Codex 的全套执行/沙箱机制，只在网关边界对接已有的 sandbox/router。

## 3. 拟议的核心工具分层（草案）

> 仅作为本轮代码改动的“意图草案”，实际落地以 gateway 实现为准。

### 3.1 CORE_TOOLS（基础工具全集）

按当前工具定义（约 21 个基础工具）划分 section，大致是：

- `fs`：`read` / `write` / `edit` / `doc.previewDiff` / `doc.snapshot` / `mkdir` / `rename` / `delete` / `project.listFiles` / `file.open` / `doc.splitToDir`
- `web`：`web.search` / `web.fetch`
- `kb`：`kb.listLibraries` / `kb.search`
- `runtime`：`time.now`
- `run`：`run.mainDoc.get` / `run.mainDoc.update` / `run.setTodoList` / `run.todo` / `run.done`
- `memory`：`memory`

> 注：`project.search` 相关能力已经在逻辑上退场，本轮会正式标记为 deprecated，不再参与 CORE_TOOLS。

### 3.2 HIGH_RISK_TOOLS（高危工具集合）

高危工具（仅在助手模式可见）：

- 执行类：`shell.exec` / `code.exec`
- 进程类：`process.*`
- 定时类：`cron.*`
- 以及未来可能新增的“跨设备/系统级操作”工具

这些工具在 opMode = creative 时完全不暴露，在 opMode = assistant 时随 CORE_TOOLS 一起暴露。

### 3.3 opMode → allowed tools 映射

统一收敛为一个网关层函数（伪代码示意）：

```ts
function getAllowedToolsForOpMode(opMode: "creative" | "assistant"): string[] {
  const core = CORE_TOOLS; // 不参与检索裁剪

  if (opMode === "creative") {
    return core.filter((id) => !HIGH_RISK_TOOLS.includes(id));
  }

  // assistant 模式：core + 高危
  return [...core, ...HIGH_RISK_TOOLS];
}
```

Tool Retrieval/B2 的 effectiveAllowed 计算则变为：

```ts
effectiveAllowed =
  getAllowedToolsForOpMode(opMode)
  ∪ stickyToolsFromThread
  ∪ discoveredMcpOrSkillTools; // 仅在 MCP/Skill 空间内做检索/扩展
```

## 4. 对既有文档的“推翻/收敛”点说明

本轮改动对以下文档的影响（需在各文档加 TIP 标明）：

1. `docs/specs/tool-retrieval-v0.1.md`
   - 其中关于 coreAlwaysOn 的描述，升级为：  
     - 核心工具集合由 `CORE_TOOLS` 常量显式定义；  
     - B2 阶段不再对 CORE_TOOLS 做裁剪，只在 MCP/插件工具空间内做检索/扩展。

2. `docs/research/codex-openclaw-intent-routing-and-tool-exposure-benchmark-2026-03-11.md`
   - 文中对 OpenClaw profile 矩阵的讨论继续有效，但在 Crab 里不再按 minimal/coding/messaging/full 原样分层；  
   - 取而代之的是：以 opMode（创作/助手）作为唯一对外暴露的权限开关，内部 profile 仅作为实现细节。

3. `docs/research/tooling-platformization-phased-plan-2026-03-11.md`
   - Phase2 里提到的“profile/policy pipeline”在 Crab 里落地为：  
     - 核心工具目录 + opMode → allowed tools 映射；  
     - MCP/插件治理继续沿用 Tool Retrieval + policy pipeline，不额外增加新维度。

4. `docs/research/mcp-hierarchical-tool-selection-v1.md`
   - 其中关于“系统工具 + MCP Server + Tool 三层选择”的方向不变；  
   - 但系统工具集合以后以 `CORE_TOOLS` 为准，不再允许被单独裁剪/隐藏。

## 5. 下一步实施计划（针对代��）

> 本节用于后续 diff 对照，不在此列出具体实现细节。

1. **新增 gateway 层核心工具视图**
   - 在 `apps/gateway/src/agent/` 下增加一个轻量的 core tool catalog 模块，记录：
     - sectionId / riskLevel / opModeProfile；
     - `getAllowedToolsForOpMode` 辅助函数。

2. **收拢 opMode 相关 if/else**
   - 替换 runFactory / toolCatalog 中散落的 opMode → 工具白名单逻辑，全部通过 `getAllowedToolsForOpMode` 获取基础工具集合；
   - 保留现有高危工具 gate（assistant 模式要求），但实现迁移到 HIGH_RISK_TOOLS 集合上。

3. **调整 Tool Retrieval B2 行为**
   - 在 effectiveAllowed 计算中，将 CORE_TOOLS 作为不变量 union 进去；  
   - 检索/扩展仅在 MCP/插件工具空间中进行，避免基础工具参与 top-K 竞争。

4. **正式标记并清理 project.search**
   - 在工具定义中明确标记为 deprecated，modes 设为空（仅保留历史兼容）；  
   - 清理 gateway 内部仍然依赖 project.search 的路径，改为 L2 记忆索引 + `read` 等组合。

本文件作为本轮“基础工具暴露改造”的开工记录，后续如有设计偏离，应在此文件中追加变更说明。 

