# Skill: bug_retrospective（深度 Bug 复盘）

> 状态：草案 | 日期：2026-03-14

## 定位

系统性的 bug 根因分析流程。从文档上下文和 commit 历史出发，经过多轮代码考古和 Codex 协作分析，最终输出一份可执行的修复 spec 文档。

**终点是文档，不是代码。** spec 文档写完后交给 Codex 执行实施。

## 来源：memory 工具 bug 实战复盘

这个 skill 提炼自 memory 工具不可用的修复过程。该 bug 表面上是一个错误（memory 不能用），实际是三层独立问题叠加：

| 层 | 错误码 | 根因 | commit |
|----|--------|------|--------|
| 1 | TOOL_NOT_ALLOWED | style orchestrator 路径漏放 memory | 93f5240 |
| 2 | TOOL_NOT_ALLOWED | boot 阶段硬编码白名单排除核心工具 | a5448da |
| 3 | UNKNOWN_TOOL | GatewayRuntime 缺少合并工具名展开 | b0034c0 |

修一层才能暴露下一层。这个 skill 就是把这种"剥洋葱"式的排查过程标准化。

---

## 工作流阶段

### Phase 0: 项目文档索引

**目的**：建立当前上下文，避免重复调查已知问题或重走已有方案。

**动作**：
1. 扫描近 10 天修改过的文档（`docs/specs/`、`docs/research/`）
2. 按相关度筛选，读取与 bug 相关的 spec / research 文档
3. 输出一份简要索引：

```
近期相关文档：
- docs/specs/fix-conversation-data-loss-v1.md（对话数据丢失，已修复）
- docs/research/core-tools-exposure-refactor-2026-03-13.md（核心工具暴露重构）
- docs/specs/workflow-skills-runtime-v0.2-...md（style_imitate 编排）
→ 与当前 bug 直接相关：core-tools-exposure-refactor
```

**关键**：
- 默认只看近 10 天，避免信息过载
- 优先 specs > research > 其他
- 文档中的"架构隐患清单"往往直接包含当前 bug 的线索

### Phase 1: Commit 回顾

**目的**：了解近期改动的上下文，找到可能引入 bug 的 commit 或遗漏的迁移。

**动作**：
1. `git log --oneline -20`：最近 20 条 commit 摘要
2. 按关键词过滤与 bug 报告相关的 commit（文件名、模块名、工具名）
3. 对嫌疑 commit 做 `git show --stat` + 关键文件 diff
4. 输出：

```
嫌疑 commit：
- 93f5240 fix: allow memory tool in style orchestrator
  → 只修了 styleOrchestrator.ts，未触及 runFactory.ts 的 boot 逻辑
- 8883794 feat: orchestrated style_imitate workflow
  → 引入了 GatewayRuntime 新路径，可能遗漏旧版逻辑
```

**关键**：
- 不只看"最近一次改了什么"，而是看"迁移/重构时可能漏了什么"
- 特别关注 feat commit（新功能/重构）对旧路径的影响

### Phase 2: 症状收集

**目的**：把用户报告转化为精确的技术线索。

**动作**：
1. 记录错误信息原文（error code、完整 message）
2. 明确复现条件（什么路由、什么模式、什么操作顺序）
3. 区分用户期望 vs 实际行为
4. 检查服务器日志（确认部署版本、有无相关错误日志）

**产物**：

```
症状卡片：
- 错误码：UNKNOWN_TOOL
- 错误源：Desktop toolRegistry.ts:4236
- 复现条件：任意 agent run 中调用 memory 工具
- 用户期望：memory 工具正常读写记忆
- 实际行为：返回"未知工具：memory"
- 服务器版本：a5448da（per-turn gating 修复已部署）
```

### Phase 3: 代码考古

**目的**：从错误码反向追踪到所有相关代码路径。

**动作**：
1. 从错误码出发，grep 找到错误产生位置
2. 向上追踪调用链：谁调用了这个函数？参数从哪来？
3. 画出完整路径图，标记每条分支的触发条件
4. 对比不同代码路径（旧版 vs 新版、路由 A vs 路由 B）

**产物**：

```
调用链：
LLM 调用 "memory"
  → pi-agent-core AgentTool.execute
  → GatewayRuntime._executeAgentTool(toolCallId, "memory", {action:"read",...})
  → decideServerToolExecution → executedBy: "desktop"
  → _waitForDesktopToolResult(toolCallId, "memory", args)  ← 没有展开！
  → Desktop toolRegistry.executeToolCall({toolName: "memory"})
  → getTool("memory") → undefined（只有 memory.read / memory.update）
  → UNKNOWN_TOOL

对比旧版：
  → writingAgentRunner.expandMergedToolName("memory", {action:"read"}) → "memory.read"
  → _waitForDesktopToolResult(toolCallId, "memory.read", {level:"global"})
  → Desktop getTool("memory.read") → 找到 → 正常执行
```

**关键**：
- 不要只追一条路径，要穷举所有分支
- 标注"安全/有问题"：有些路径不受 bug 影响，标清楚避免误修

### Phase 4: 根因定位（Codex 协作）

**目的**：通过 Claude 描述 + Codex 分析，确认根因并发现同类问题。

**动作**：
1. Claude 写问题描述（症状、调用链、嫌疑代码、初步判断）
2. 发给 Codex（sandbox=read-only），要求：
   - 确认/反驳根因分析
   - 检查是否有遗漏的代码路径
   - 列出同类受害者（同样模式下还有哪些地方会出问题）
   - 评估架构隐患（这个问题是个例还是系统性的）
3. 多轮讨论，每轮聚焦一个维度
4. 区分"直接原因"和"系统性风险"，分级标注

**产物**：根因分析（带分级）

```
根因分级：
S1（核心功能断裂）：boot 集排除 10 个核心工具
S2（核心功能断裂）：合并工具名未展开导致 UNKNOWN_TOOL
A1（特定场景）：MCP 工具首轮被 boot 剪掉
B1（可维护性）：三套核心工具常量不同步
```

### Phase 5: 修复方案文档

**目的**：输出可执行的 spec 文档，作为实施的唯一依据。

**动作**：
1. 每个根因对应一个独立 Fix，标注优先级（P0/P1/P2）
2. 每个 Fix 包含：
   - 修改文件和具体位置（行号）
   - 修改原理（一句话说清为什么这样改）
   - diff patch（Codex sandbox=read-only 输出）
   - 边界情况说明
3. 影响范围和受影响工具列表
4. 验证 checklist（回归场景 + 测试命令）
5. 涉及文件清单

**产物**：`docs/specs/fix-{bug-name}-v1.md`

文档写完，流程结束。后续实施交给 Codex。

---

## 核心原则

1. **先读后查** —— 先看已有文档和 commit 历史，很多线索已经在里面了
2. **错误码是入口不是答案** —— 相同表象可能是不同层的问题叠加
3. **穷举路径而非猜测** —— 画出所有分支，逐条标注安全/有问题
4. **修一层暴露一层** —— 预期多轮验证，每轮记录"修了什么、暴露了什么"
5. **同类受害者分析** —— 发现一个被剪的工具就顺带查所有同类
6. **双引擎互补** —— Claude 描述问题（全局视角），Codex 深度分析（代码细节）
7. **文档是终点** —— spec 写完就交棒，不在分析阶段写代码

---

## Manifest 草案

```typescript
{
  id: "bug_retrospective",
  name: "深度 Bug 复盘",
  kind: "workflow",
  activationMode: "explicit",
  triggers: [],
  phases: [
    "doc_index",
    "commit_review",
    "symptom_collection",
    "code_archaeology",
    "root_cause_analysis",
    "fix_spec_document"
  ],
  doneCondition: "spec 文档已写入 docs/specs/ 并包含完整的 Fix 列表和验证 checklist",
  requiredTools: ["memory"],
  codexCollaboration: true
}
```

---

## 项目文档索引策略

### 扫描范围

```bash
# 近 10 天修改过的文档
find docs/ -name "*.md" -mtime -10 | sort

# 补充：CLAUDE.md（项目架构根规则，始终读取）
# 补充：dev-handbook（开发约定）
```

### 优先级

| 优先级 | 来源 | 原因 |
|--------|------|------|
| 1 | `CLAUDE.md` | 架构分层和核心原则 |
| 2 | `docs/specs/` 近 10 天 | 已有的修复方案和架构决策 |
| 3 | `docs/research/` 近 10 天 | 深度分析和隐患清单 |
| 4 | `docs/dev-handbook-v1.md` | 开发约定和测试命令 |

### 关联匹配

按 bug 报告中的关键词（工具名、模块名、错误码）与文档标题/内容做匹配，只读取相关文档，不全量阅读。
