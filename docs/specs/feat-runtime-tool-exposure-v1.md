# feat-runtime-tool-exposure-v1

> Runtime 工具暴露重构：从 8 层裁剪到 L0/L1/L2 分层 + ToolSearch 按需加载，对齐 Claude Code 工具名生态。

> 状态：Phase 1-3 Done, Phase 4 Done | 优先级：P0 | 日期：2026-03-24 | HEAD：`225a5ec`
>
> **实施策略变更（Codex Review R1 反馈）**：采用策略 A——内部 contract 全用 legacy 名，PascalCase 公共名只存在于 LLM-facing 边界（`_buildAgentTools` wrapper）。TOOL_LIST 不改名。

---

## 0. 需求卡片

**场景**：Crab 的 Agent Runtime 当前用 8-10 层裁剪逻辑管理工具可见性（`computePerTurnAllowed` 400+ 行），导致：
1. 跑的半路工具消失或找到了不给用
2. 工具/MCP/Skill 渐进式暴露没有统一模型，无法优雅扩展

**目标**：参考 Claude Code 的 ToolSearch + defer_loading 机制，将 runtime 重构为简洁的三层模型。

**对标**：
- Claude Code 2.1.80（逆向 cli.js 得到的 ToolSearch/defer_loading 机制）
- Codex（本地 third_party/openai-codex，几乎不做 per-turn 过滤）

**约束**：
- 保持 creative/assistant 二态
- Skills 和 MCP 在 L1 同级
- 工具名对齐 Claude Code PascalCase 命名，为 portable skill 互通铺路
- 不新增权限系统

---

## 1. 核心设计

### 1.1 工具分层

#### L0 即时工具（完整 schema，每轮必带，15 个）

```
tools.search         工具/能力发现（ToolSearch 入口）
tools.describe       激活能力
WebSearch            联网搜索（原 web.search）
WebFetch             网页抓取（原 web.fetch）
run.mainDoc.get      主文档读取
run.mainDoc.update   主文档更新
run.todo             Todo CRUD（合并 run.setTodoList，补 action=replace）
run.done             结束信号
Read                 文件读取（原 read）
Write                文件写入（原 write）
Edit                 文件编辑（原 edit）
project.listFiles    项目文件列表
Grep                 项目内容搜索（原 project.search，恢复启用）
memory               跨会话记忆
Agent                子 Agent（原 spawn/send/resume/wait/close 5合1）
```

#### L1 能力感知（系统提示一行摘要，Skills/MCP/非核心内置同级）

所有非 L0 工具 + 所有 MCP server + 所有 Skill，每条 ~40-50 tokens。格式：

```
内置能力：
- style_imitate（深度风格仿写）/style
- corpus_ingest（语料入库）/ingest

用户自建能力：
- 小红书种草文（@XX风格）/xiaohongshu

工具服务（MCP）：
- Playwright（浏览器自动化，69个工具）
- 博查搜索（联网搜索，2个工具）

按需工具（非核心内置）：
- Bash（命令执行，助手模式）
- Glob（文件名搜索）
- kb.search（知识库检索）
- time.now（当前时间）
- delete / rename / mkdir
- ...
```

**预算**：100 条 ≈ 5,000 tokens；极端 200 条 → 降级折叠（"另有 N 个能力未列出，用 tools.search 查找"）。

#### L2 按需激活（tools.search / tools.describe / /skill_name 触发）

- LLM 想用 Playwright → `tools.search("浏览器截图")` → 返回匹配工具 schema
- 已发现/激活的工具 schema 在本会话后续轮次**持续可用**（sticky）
- **10% 上下文预算控制**：已激活工具 schema 超预算 → LRU 淡出最早激活的

### 1.2 模式门禁（唯一的减法）

- `creative` → 从 L0 + L2 中减去 HIGH_RISK（Bash、Agent、process.*、cron.* 等）
- `assistant` → 全量

### 1.3 Fallback 链（声明式）

```typescript
const FALLBACK_CHAINS: Record<string, string[]> = {
  "WebSearch":  ["mcp.bocha.bocha_web_search", "mcp.playwright.browser_navigate"],
  "WebFetch":   ["mcp.web-search.get_page_content", "mcp.playwright.browser_navigate"],
};
```

工具失败 → 返回错误 + fallback 选项 → LLM 自选。不做隐式补齐。

---

## 2. 工具重命名（对齐 Claude Code）

采用策略 A："内部 legacy + 边界 public wrapper"。

**原则**：TOOL_LIST 的 `name` 保持 legacy 名，PascalCase 公共名只在 `_buildAgentTools`（给 LLM 看的边界）映射。

| Legacy 运行时名 | → LLM 看到的公共名 | 说明 |
|-----------------|-------------------|------|
| read | Read | CC 对齐 |
| write | Write | CC 对齐 |
| edit | Edit | CC 对齐 |
| shell.exec + code.exec | Bash | _buildAgentTools 合成 wrapper，按参数路由 |
| web.search | WebSearch | CC 对齐 |
| web.fetch | WebFetch | CC 对齐 |
| project.searchPaths | Glob | CC 对齐 |
| project.search | Grep | CC 对齐 |
| spawn_agent + send/resume/wait/close | Agent | _buildAgentTools 合成 wrapper，按 action 路由 |
| Crab 特有工具 | 保持原名 | run.*/kb.*/lint.*/tools.*/memory/project.listFiles |

桥接实现位置：`GatewayRuntime.ts` 的 `normalizeToPublicToolName()` + `resolveRuntimeToolName()` + `_buildAgentTools` wrapper。

---

## 3. 废弃/合并/变更

### 3.1 废弃的工具

| 工具 | 原因 |
|------|------|
| doc.previewDiff | UI 层职责，edit 已覆盖 |
| doc.snapshot | Desktop 编辑器职责 |
| doc.splitToDir | write 多次调用替代 |
| file.open | UI 层职责 |
| skills.list | 系统提示已列 skill |
| skills.activate | tools.describe 覆盖（describe skill 时同时激活） |

### 3.2 LLM 边界合成（_buildAgentTools wrapper，不改 TOOL_LIST）

| LLM 看到的 | 内部路由 | 说明 |
|-----------|---------|------|
| Bash | shell.exec（有 command 时）或 code.exec（有 code/entryFile 时） | wrapper 按参数判定 |
| Agent | spawn_agent/send_input/resume_agent/wait_agent/close_agent | wrapper 按 action 判定 |

### 3.3 语义保留（不废弃内部定义，只改描述/modes）

| 工具 | 变更 |
|------|------|
| run.setTodoList | 保留内部定义，run.todo 补 action=replace 覆盖其语义 |

### 3.3 语义变更

| 工具 | 变更 |
|------|------|
| tools.describe | 对 skill 类型也执行激活（原来只记 recently described） |
| WebSearch | 实现层自动注入当前日期（无明确时间锚点时） |
| time.now | 降到 L1，不再是 web.search 的前置工具 |

---

## 4. computePerTurnAllowed 重构

### 4.1 当前状态：400+ 行，10 层逻辑

| 层 | 逻辑 | 处置 |
|----|------|------|
| Layer 1: Composite Task Phases | 复合任务阶段 pin | **删除** |
| Layer 2A: Sticky Tools | 跨 turn 保留已用工具 | **保留**，简化为从 ThreadCapabilityState 读 |
| Layer 2B: Expansion (failure-driven) | web 失败补 MCP | **删除**，改用声明式 Fallback |
| Layer 3: Delete-only route | 删除路由最小集 | **删除** |
| Layer 4: style_imitate orchestrator | 风格工作流裁剪 | **搬到 Skill 层** |
| Layer 5: MCP capability activation | 线程能力集 | **保留**，简化 |
| Layer 6: Browser filtering | 非浏览器任务屏蔽 browser | **删除** |
| Layer 7A-D: Boot stage | 启动阶段收敛 | **删除** |
| Layer 8: HIGH_RISK filtering | 模式门禁 | **保留** |
| Layer 9: Finalization | 兜底 CORE_TOOLS | **保留** |
| Layer 10: MCP-first binary read | 二进制读取护栏 | **删除** |

### 4.2 重构后：~50 行

```typescript
const computePerTurnAllowed = (state: RunState) => {
  const hints: string[] = [];
  const allowed = new Set(selectedAllowedToolNames);

  // 1. 合并已激活工具（sticky + discovered + thread active MCP）
  const activated = [
    ...stickyToolNames.filter(n => baseAllowedToolNames.has(n)),
    ...threadActiveMcpToolNames.filter(n => baseAllowedToolNames.has(n)),
    ...discoveredToolNames.filter(n => baseAllowedToolNames.has(n)),
  ];
  for (const name of activated) allowed.add(name);

  // 2. 模式门禁（唯一的减法）
  if (!shouldExposeRuntimeHighRiskTools) {
    for (const name of HIGH_RISK_TOOL_NAME_SET) {
      if (!portableScopedHighRiskToolNames.has(name)) allowed.delete(name);
    }
  }

  // 3. 预算检查（LRU 淡出）
  const dynamicNames = activated.filter(n => !CORE_TOOL_NAME_SET.has(n));
  const budget = Math.floor(contextWindow * 0.10);
  let spent = 0;
  const keep = new Set<string>();
  for (const name of dynamicNames.slice().reverse()) {
    const cost = estimateSchemaTokens(name);
    if (spent + cost > budget) continue;
    spent += cost;
    keep.add(name);
  }
  for (const name of dynamicNames) {
    if (!keep.has(name)) allowed.delete(name);
  }

  // 4. 兜底 CORE_TOOLS
  for (const name of CORE_TOOL_NAME_SET) {
    if (baseAllowedToolNames.has(name)) allowed.add(name);
  }

  return { allowed, hint: hints.join("\n\n") };
};
```

---

## 5. style_imitate 清理

### 当前状态

已有 bundled skill SKILL.md（`apps/desktop/electron/bundled-skills/style_imitate/SKILL.md`），frontmatter 完整（id/triggers/tool-caps/workflow phases）。

但 `runFactory.ts` 中残留 **18 处**硬编码引用。

### 处置

| 位置 | 内容 | 处置 |
|------|------|------|
| L4670-4784 | computePerTurnAllowed 中的工作流编排 | **搬到 Skill 定义层**（agent-core） |
| L1572-1595 | normalizeWorkflowCheckpoint 默认 skillId | **搬到 Skill 层** |
| L1713 | reconstructWorkflowSkills 查找 | **搬到 Skill 层** |
| L4600-4654 | PHASE_CONTRACTS_V1 | **删除**（autoRetry 跟 Skill 走） |
| L1269, 1314 | 系统提示中 skill 引用 | **保留**（框架级提示模板） |
| L1913 | intent routing 正则清理 | **保留** |
| L3069-3080 | skill suppression | **保留** |
| L3878-3881 | lint 工具 gate | **保留** |
| 其余审计/状态快照 | 审计尾部 | **保留** |

---

## 6. ThreadCapabilityState 扩展

补 `discoveredBuiltinToolNames: string[]`（max 24），用于非 L0 内置工具的 thread 级发现持久化。

新增函数 `rememberDiscoveredBuiltinTool()`。新任务时清空。

类型改动同步 `packages/shared/src/runtime/thread-turn-item.ts`。

---

## 7. 全仓改动清单

### Phase 1: 协议与元数据（P0，先改）

| 文件 | 改动 |
|------|------|
| `packages/shared/src/runtime/thread-turn-item.ts` | ThreadCapabilityState 补 discoveredBuiltinToolNames；CollabCallKind 补 Agent bridge |
| `packages/tools/src/index.ts` | TOOL_LIST 重命名/废弃/合并/新增；decodeToolName 补桥接 |
| `apps/gateway/src/agent/coreTools.ts` | CORE_TOOL_NAMES 改为新 L0 15 个；HIGH_RISK 补 Bash |

### Phase 2: Gateway 路由/运行时（P0）

| 文件 | 改动 |
|------|------|
| `apps/gateway/src/agent/serverToolRunner.ts` | normalizeServerToolName 桥接；tools.describe 激活 skill；WebSearch 注入日期；run.todo action=replace |
| `apps/gateway/src/agent/toolCatalog.ts` | inferCapabilities/inferRiskLevel 适配新名 |
| `apps/gateway/src/agent/toolRetriever.ts` | collab intent 收口为 Agent |
| `apps/gateway/src/agent/portableSkillCompat.ts` | 补齐 WebSearch/Agent alias |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | public↔legacy 桥接；_applyDynamicSkillActivation 支持 tools.describe 来源；discovered 状态扩展 |
| `apps/gateway/src/agent/runFactory.ts` | computePerTurnAllowed 精简到 ~50 行；style_imitate 残留清理；skills.activate 消费侧收口 |
| `apps/gateway/src/agent/threadCapabilityState.ts` | 补 discoveredBuiltinToolNames + rememberDiscoveredBuiltinTool |
| `apps/gateway/src/agent/writingAgentRunner.ts` | hasTodoList 判定适配 action=replace |

### Phase 3: Desktop bridge（P0）

| 文件 | 改动 |
|------|------|
| `apps/desktop/src/agent/toolRegistry.ts` | 公共名→legacy 路由；Grep 恢复 |
| `apps/desktop/src/agent/wsTransport.ts` | run.todo action=replace 映射 |
| `apps/desktop/electron/agent-loader.mjs` | alias 补齐 |
| `apps/desktop/electron/skill-loader.mjs` | alias 补齐 |
| `apps/desktop/src/ui/components/ChatArea.tsx` | Bash 终端卡片适配 |

### Phase 4: 测试/文档（P0-P2）

| 文件 | 优先级 |
|------|--------|
| 6 个 smoke 脚本 | P0 |
| CLAUDE.md | P2 |
| docs/specs/*.md | P2 |
| docs/research/*.md | P2 |

---

## 8. 影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| 工具重命名（PascalCase） | 全仓旧工具名硬编码 | 高 | public↔legacy 桥接，不硬切 |
| computePerTurnAllowed 精简 | 所有 per-turn 工具可见性 | 高 | 保留模式门禁 + CORE_TOOLS 兜底 |
| skills.activate 退场 | tools.describe 语义变更 | 中 | GatewayRuntime + runFactory 消费侧同步收口 |
| run.setTodoList 废弃 | hasTodoList/plan commitment 判定 | 中 | run.todo action=replace 补语义 + 4 处消费侧适配 |
| Bash 合并 shell.exec+code.exec | Desktop ChatArea 终端卡片 UI | 中 | ChatArea 特判适配 |
| time.now 降 L1 | "先 time.now 再 web.search"提示 | 低 | WebSearch 自动注入日期 + 去掉旧提示 |
| 废弃 4 个 doc/file 工具 | Desktop UI 引用 | 低 | 渐进移除 |

---

## 9. 验证 Checklist

### 9.1 最小可验证单元（9 个 Gateway 文件）

改完以下文件即可跑 smoke：

1. `packages/tools/src/index.ts`
2. `apps/gateway/src/agent/coreTools.ts`
3. `apps/gateway/src/agent/serverToolRunner.ts`
4. `apps/gateway/src/agent/toolCatalog.ts`
5. `apps/gateway/src/agent/toolRetriever.ts`
6. `apps/gateway/src/agent/portableSkillCompat.ts`
7. `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
8. `apps/gateway/src/agent/runFactory.ts`
9. `apps/gateway/src/agent/threadCapabilityState.ts`

### 9.2 Smoke 测试

```bash
npm run -w @ohmycrab/gateway smoke:capability-exposure
npm run -w @ohmycrab/gateway smoke:opmode-writing-boundaries
npm run -w @ohmycrab/gateway smoke:runtime-parity
```

### 9.3 场景验证

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| 助手模式发 `tools.search("浏览器")` | 返回 Playwright 能力卡片 | smoke |
| 助手模式发 `tools.describe("mcp:playwright/browser")` | 返回 concrete tools + 激活到 thread state | smoke |
| 助手模式发 `tools.describe("skill:style_imitate")` | 返回 skill 详情 + 激活合同 | smoke |
| 创作模式调 Bash | TOOL_NOT_ALLOWED（HIGH_RISK 门禁） | smoke |
| 助手模式调 Bash(command="ls") | 路由到 shell.exec | 手动 |
| 助手模式调 Bash(code="print(1)") | 路由到 code.exec | 手动 |
| 助手模式调 Agent(action="spawn") | 路由到 spawn_agent | 手动 |
| WebSearch 无时间锚点 | 自动注入 Current date | 手动 |
| WebSearch "2025年数据" | 不注入日期 | 手动 |
| run.todo action=replace | 整体替换 todo list | 手动 |
| 100+ L1 能力 | 系统提示内列出，不超 10% | 手动 |

---

## 10. 实施优先级

| 阶段 | 内容 | 估计规模 |
|------|------|---------|
| **P0-A** | 协议 + 元数据 + Gateway 路由 | 9 文件，核心改动 |
| **P0-B** | Desktop bridge | 5 文件，桥接适配 |
| **P0-C** | Smoke 测试 | 4 文件，适配新名 |
| **P1** | 协议层补充 + contextAssembler | 4 文件 |
| **P2** | 文档更新 | 8+ 文件，仅文案 |

---

## 11. Codex 协作记录

- 第一轮：coreTools.ts / TOOL_LIST / GatewayRuntime / runFactory 的 diff + 遗漏点分析
- 第二轮：toolCatalog / toolRetriever / portableSkillCompat / serverToolRunner 的 diff + 4 个追问回答
- 第三轮：消费侧收口（GatewayRuntime + runFactory skills.activate 退场）+ 全仓迁移清单 + 最终评估

Session IDs:
- Round 1: `019d1b25-4238-7863-9fdd-bdc442f0c27f`
- Round 2-3: `019d1b64-40b7-7ac3-bc02-a9196223930d`

Codex diff 原文保存于：
- `/Users/noah/.claude/projects/-Users-noah-writing-ide/a69148a5-a9f1-4277-8e0b-16676a7994fc/tool-results/toolu_015eqLBjLsEQA38UgaB5FiC2.txt`

---

## 12. 实施进度

### 策略变更记录

Codex Review Round 1 发现 4 个高优阻塞问题后，从"一步到位硬切公共名"（策略 B）改为"内部 legacy + 边界 public wrapper"（策略 A）。

**策略 A 核心原则**：
- `TOOL_LIST` 的 `name` 字段保持 legacy 名（read/write/edit/web.search 等）
- `coreTools.ts` 的集合也用 legacy 名
- PascalCase 公共名（Read/Write/Edit/WebSearch/Bash/Agent 等）只在 `_buildAgentTools` 给 LLM 看时映射
- 消费侧（状态机、门禁、记账、路由）全部继续用 legacy 名，不需要改

### 已完成（Phase 1+2 核心）

| 文件 | 改动 | 状态 |
|------|------|------|
| `coreTools.ts` | L0 从 28→15（legacy 名） | ✅ 构建通过 |
| `thread-turn-item.ts` | 补 discoveredBuiltinToolNames | ✅ 构建通过 |
| `threadCapabilityState.ts` | 补 discovered builtin 管理 | ✅ 构建通过 |
| `packages/tools/src/index.ts` | web.search 日期描述、run.todo replace、project.search 恢复 | ✅ 构建通过 |
| `GatewayRuntime.ts` | 桥接函数 + tools.describe 激活 skill + todo replace 记账 | ✅ 构建通过 |
| `portableSkillCompat.ts` | alias 补齐 WebSearch/Agent | ✅ 构建通过 |
| `toolRetriever.ts` | Agent 收口 | ✅ 构建通过 |
| `toolCatalog.ts` | 名称适配 | ✅ 构建通过 |
| `runFactory.ts` | computePerTurnAllowed 442行→60行 + TOOL_LIST import | ✅ 构建通过 |
| `serverToolRunner.ts` | WebSearch 日期注入 + run.todo replace | ✅ 构建通过 |

### 待完成

| 编号 | 内容 | 优先级 | 说明 |
|------|------|--------|------|
| ~~P0-3~~ | ~~`_buildAgentTools` public wrapper~~ | ~~P0~~ | ✅ 已完成：LLM 看到 PascalCase（Read/Write/Bash/Agent），执行时映射回 legacy |
| ~~P0-6~~ | ~~恢复最小 per-turn gate~~ | ~~P0~~ | ✅ 已完成：delete-only 路由 + style_imitate orchestratorMode |
| P1-1 | portableSkillCompat 复用 bridge | P1 | 解决单向缩水 |
| P1-3 | discoveredBuiltinToolNames 接通消费侧 | P1 | 当前有类型无行为 |
| P1-4 | 清理 dead signals | P1 | enforceMcpFirstForBinaryRead 等 |
| Phase 3 | Desktop bridge（5 文件） | P0 | toolRegistry/wsTransport/ChatArea 等 |
| Phase 4 | Smoke 测试 + 文档 | P0-P2 | 6 个 smoke 脚本 + docs |

### Codex Review 记录

| 轮次 | Session ID | 结论 |
|------|-----------|------|
| R1（方案 diff） | `019d1b25-4238-7863-9fdd-bdc442f0c27f` | 方向对，硬 rename 风险高，建议策略 A |
| R2（补丁 + 清单） | `019d1b64-40b7-7ac3-bc02-a9196223930d` | 4 文件补丁 + 全仓迁移清单 + 消费侧收口 |
| R3（代码 review） | `019d1bdc-f153-7211-8c57-089b331de1af` | 4 个阻塞问题（已按策略 A 解决 3 个） |
| R4（回退后 review） | 待 Codex 恢复后补 | — |
