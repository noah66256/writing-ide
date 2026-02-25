# Sub-agent 架构审查与改进方案 v0.2

> **状态**：completed（2026-02-23，代码审查通过）
> **前置**：[sub-agent-architecture-v0.1](sub-agent-architecture-v0.1.md)
> **目的**：基于 v0.1 实现后的代码审查 + 业界调研，诊断当前 sub-agent 架构的 8 个关键问题，提出改进方案。

---

## 一、当前架构诊断摘要

v0.1 已落地的核心能力：`SubAgentDefinition` 接口、`agent.delegate` 工具、`WritingAgentRunner` 复用、SSE agentId 路由、Desktop 并行气泡。

**审查发现 8 个问题（A-H）**，按严重程度排序：

| 编号 | 问题 | 严重度 | 类型 |
|------|------|--------|------|
| **B** | 子 agent 拿不到上下文（KB/style clusters/contextPack） | 🔴 致命 | 代码缺陷 |
| **H** | 循环模式不是严格 ReAct，需明确定义 | 🟡 认知 | 架构认知 |
| **A** | `subAgent.skills` 定义了但从未激活 | 🟠 高 | 代码缺陷 |
| **C** | 并行 sub-agent 读写同一文件无锁机制 | 🟠 高 | 架构缺失 |
| **D** | 主 agent 并行调用能力确认 | 🟢 已实现 | 确认 |
| **E** | 需对齐业界 multi-agent 实现方案 | 🟡 中 | 调研 |
| **F** | Friday 运行时无法读取 MCP/skills/sub-agent 文档 | 🟡 中 | 能力缺失 |
| **G** | Desktop 流式输出显示工具名，对用户不友好 | 🟡 中 | UX |

---

## 二、业界 Multi-Agent 方案对比

### 2.1 框架横评

| 框架 | 上下文隔离 | 并行执行 | 共享状态 | 冲突防护 | 沙箱 |
|------|-----------|---------|---------|---------|------|
| **Anthropic Agent SDK** | 完全隔离，仅返回精炼摘要 | 原生支持（Task 工具并行） | 无内置共享，靠 artifact 传递 | 无内置锁；同文件操作建议串行 | 无内置沙箱 |
| **OpenAI Agents SDK** | Handoff 切换上下文；Sessions 持久化 | 支持并行 tool_use | Sessions 维护工作上下文 | Guardrails 输入/输出校验 | 无内置沙箱 |
| **LangGraph** | Reducer schema + Swarm 私有字段 | ✅ Superstep 并行（最成熟） | 集中式 reducer 状态 | **Superstep：独立副本 + 确定性合并 + 原子失败** | 无内置沙箱 |
| **Google ADK** | 子 agent 共享 session.state | ParallelAgent 原生并行 | Shared Session State + output_key 分区 | 约定各 agent 写不同 key，无锁 | 无内置沙箱 |
| **MetaGPT** | 全局消息池 + 角色订阅过滤 | 支持并行（独立角色并行推理） | 全局 Shared Message Pool（发布-订阅） | 结构化输出减少歧义；无文件锁 | 无内置沙箱 |
| **AutoGen** | GroupChat 全员共享消息历史（无隔离） | 支持（GroupChatManager 调度） | 全员共享 message history | FSM 约束转换；无文件锁 | ✅ Docker 默认开启 |
| **CrewAI** | 三层记忆：短期/长期/实体 | 支持并行 task execution | 共享长期记忆 + 实体记忆 | Process 模式（sequential/hierarchical） | 无内置沙箱 |
| **Dagger Container Use** | 每 agent 独立容器 + Git worktree | 原生并行（隔离容器） | Git 合并 | Git merge conflict resolution | ✅ 容器级沙箱 |

### 2.2 关键结论

1. **上下文隔离是共识**：Anthropic 和 MetaGPT 都强调子 agent 不应拿到全量上下文，只接收与任务相关的精炼输入。
2. **并行安全靠约定而非锁**：绝大多数框架（Anthropic、Google ADK、MetaGPT）都不内置文件锁，而是通过架构设计避免冲突——各 agent 写入不同的 key/文件/artifact。
3. **LangGraph 的 Superstep 模型最成熟**：借鉴 Google Pregel，并行节点获得状态的独立副本运行，完成后以确定性顺序合并更新，整个 superstep 原子性失败——无数据竞争。
4. **沙箱不是必需的**：只有代码执行场景（AutoGen Docker、Dagger Container Use）才需要进程级沙箱。内容写作场景中，工具权限白名单 + 编排器审核已足够。
5. **风格闭环应在编排器侧**：Anthropic 明确建议"评估结果而非过程"，即编排器负责审核质量，子 agent 只管执行。
6. **没有框架内置文件锁定**：文件级并发控制在所有框架中都是空白。Dagger Container Use 通过 Git worktree 提供了最优雅的文件隔离方案，但它是独立工具而非框架内置能力。

### 2.3 沙箱：我们需不需要？

**结论：当前阶段不需要进程级沙箱。**

理由：

| 考虑 | 说明 |
|------|------|
| 子 agent 不执行任意代码 | 我们的子 agent 只调用预定义工具（kb.search、doc.write、lint.style），不执行 `bash.exec` 或用户提供的代码 |
| 工具权限白名单已有 | `subAllowedToolNames` 限制子 agent 可用工具集 |
| 编排器审核 | 负责人在子 agent 返回后审核，不会直接透传 |
| 预算硬限制 | `maxTurns` / `maxToolCalls` / `timeoutMs` 防止失控 |
| 成本不匹配 | 容器/MicroVM 沙箱引入 200ms+ 启动延迟和运维复杂度，对内容写作场景 ROI 极低 |

**何时需要沙箱**：未来如果引入 `bash.exec`、`code.run` 等任意代码执行工具，则需要进程级沙箱（推荐 gVisor 或 E2B）。

### 2.4 沙箱隔离技术对比（2025-2026 行业趋势）

| 技术 | 隔离强度 | 性能开销 | 代表方案 |
|------|----------|----------|----------|
| **MicroVM** | 最强（独立内核） | 较高（<200ms 启动） | Firecracker, E2B, Daytona(<90ms) |
| **gVisor** | 强（用户空间内核） | 10-20% | Google Cloud Agent Sandbox |
| **硬化容器** | 中（共享内核） | 最低 | Docker + seccomp/AppArmor |
| **Git Worktree** | 文件系统级 | 几乎为零 | Dagger Container Use |

### 2.5 并行冲突防护机制总结

| 机制 | 描述 | 适用场景 |
|------|------|----------|
| **独立 Key 写入** | Google ADK：每个 agent 写入唯一 state key | 结果独立的并行任务（**我们当前采用**） |
| **Superstep 合并** | LangGraph：并行节点操作独立副本，完成后确定性合并 | 状态图编排 |
| **Pub-Sub 过滤** | MetaGPT：全局消息池 + 角色订阅过滤 | 松耦合协作 |
| **Git Worktree** | Dagger：完全独立的文件系统工作目录 | 代码生成 / 文件修改类任务 |
| **串行化轮次** | agent 按固定顺序逐一执行 | 简单但牺牲并行性 |
| **乐观并发控制** | 无锁操作，版本号检测冲突，冲突时失败重试 | 冲突率低的场景 |

---

## 三、逐项诊断与方案

### A. Skill 复用策略

#### 诊断

当前 `SubAgentDefinition.skills` 字段定义了子 agent 可用的技能（如 `copywriter.skills = ["style_imitate"]`），但：
- `subCtx.activeSkills = []` — 从未读取 `subAgent.skills`
- 子 agent 的 systemPrompt 中没有注入 skill 的 `promptFragments`
- v0.1 spec 中设计了 `buildSubAgentRunContext()` 应该激活 skills，但代码未实现

#### 方案：删除 `subAgent.skills`，skill 逻辑留在编排器

**理由**：
- Anthropic 建议"评估结果而非过程"——风格闭环由负责人执行 lint.style 审核
- skill 本质是 prompt 增强 + 工具门禁，这是编排器的职责
- 子 agent 保持简单：拿到任务、用工具干活、返回结果

**改动**：
1. `SubAgentDefinition` 中保留 `skills` 字段但标注为 `deprecated`（兼容现有配置）
2. `_executeSubAgent()` 中不再尝试激活 skills
3. 风格闭环逻辑：负责人委派文案写手 → 写手返回稿件 → 负责人自己跑 `lint.style` → 不通过则重新委派并附上修改意见

### B. 子 agent 上下文传递

#### 诊断

子 agent 的 system prompt 只有 10-30 行简短描述，完全缺失：
- KB_SELECTED_LIBRARIES（已选知识库 ID）
- KB_STYLE_CLUSTERS（风格聚类样例）
- KB_LIBRARY_PLAYBOOK（库使用指南）
- REFERENCES（用户引用的外部资源）
- RECENT_DIALOGUE（对话历史）

#### 方案：编排器通过 inputArtifacts 传递精简上下文

**不应该做的**：把整个 contextPack 塞给子 agent（违反上下文隔离原则）。

**应该做的**：

1. **负责人 prompt 中明确要求**：委派时在 `inputArtifacts` 中传递必要上下文
   ```
   指派时通过 inputArtifacts 传递上下文：
   - 风格库 ID 和目标风格描述
   - 相关的 KB 搜索结果摘要
   - mainDoc 中的目标/约束
   - 用户的具体要求原文
   ```

2. **Gateway 自动注入关键上下文**：在 `_executeSubAgent()` 中，将以下信息追加到子 agent 的初始消息中：
   ```typescript
   // 自动注入到 taskMessage 末尾
   const contextHint = buildSubAgentContextHint({
     styleLibIds: this.ctx.styleLibIds,
     mainDocGoal: this.ctx.mainDoc?.goal,
     kbSelectedIds: this.ctx.gates.styleLibIdSet,
   });
   ```

3. **子 agent 自行调用 kb.search**：子 agent 有 `kb.search` 工具权限，知道风格库 ID 后可以主动搜索。当前 `kb.search` 在 Gateway 侧路由到 Desktop 执行，不受上下文限制。

### C. 并行安全与文件冲突

#### 诊断

当前 `agent.delegate` 通过 `Promise.all()` 并行执行多个子 agent。如果两个子 agent 同时调用 `doc.write` 写同一文件，会产生竞争条件。

#### 方案：架构约定 + 软锁

**原则**：参照 Google ADK 的做法——各 agent 写入不同 key，由编排器聚合。

**实施**：

1. **架构约定**（零代码改动）：
   - 文案写手产出 artifact（临时文件或内存中的文本块），不直接写入用户文件
   - 只有负责人审核通过后才执行最终 `doc.write`
   - 这已经在 v0.1 spec 第十节"质量保障"中设计了

2. **子 agent `doc.write` 重定向**（可选，Phase 2）：
   - 子 agent 调用 `doc.write` 时，自动重定向到临时 artifact 存储
   - 返回给负责人的 artifact 中包含写入内容
   - 负责人审核后调用真正的 `doc.write`

3. **当前阶段够用**：我们的子 agent 场景中，文案写手写稿、SEO 做分析、选题做调研——本身就是不同任务，不会写同一文件。

### D. 主 agent 并行调用能力

#### 确认：✅ 已实现

`agent.delegate` 调用走 `Promise.all()` 并行执行。常规工具调用走 `for` 循环顺序执行。结果按原始顺序排序后返回 LLM。

代码位置：`writingAgentRunner.ts:413-478`

### E. 与业界方案对齐

#### 当前位置

我们的架构最接近 **Anthropic Agent SDK 的 Orchestrator-Worker 模式**：
- 负责人 = Orchestrator
- 子 agent = Worker
- `agent.delegate` ≈ Agent SDK 的 `Task` 工具
- `inputArtifacts` ≈ Agent SDK 的上下文传递
- 预算限制 ≈ Agent SDK 的 budget

#### 需要对齐的差距

| 差距 | Anthropic 做法 | 我们当前 | 改进 |
|------|---------------|---------|------|
| 子 agent 仅返回精炼摘要 | ✅ 设计原则 | ⚠️ 子 agent 全量输出可见 | 子 agent 的 SSE 事件可选择性隐藏中间过程 |
| 子 agent model 独立配置 | ✅ `model: "sonnet"` | ❌ 继承父 agent model | 使用 `subAgent.model` 字段 |
| 教会编排器如何委派 | ✅ prompt 详细描述 | ✅ 已在 prompt 中添加指派策略 | 已完成 |

### F. Friday 运行时文档可达性

#### 诊断

Friday 无法读取 `docs/specs/` 下的规范文档。如果用户要求 Friday "创建一个新的子 agent"或"配置一个 MCP server"，Friday 不知道标准格式。

#### 方案：不嵌入文档，通过 project.readFile 按需读取

**理由**：
- 文档总量数万字，嵌入 system prompt 浪费 token
- 用户很少要求 Friday 配置子 agent（这是设置页 UI 的事）
- 如果确实需要，Friday 可以通过 `project.listFiles` + `doc.read` 按需读取

**改动**：在负责人 prompt 中添加一句提示：
```
如果用户要求你创建或配置子 agent、MCP Server 或 Skill，
先用 project.listFiles 查看 docs/specs/ 目录下的规范文档，
再用 doc.read 读取相关 spec 作为参考。
```

### G. Desktop 流式输出 UX

#### 诊断

当前 Desktop 显示工具调用的原始名称（`kb.search`、`lint.style`），对普通用户不友好。

#### 方案：自然语言 loading + 黑箱化

**映射规则**：

| 事件/工具 | 当前显示 | 改为 |
|-----------|---------|------|
| `run.setTodoList` | "run.setTodoList" | "制定计划中…" |
| `agent.delegate` | "agent.delegate" | "委派 {agentName} 中…" |
| 子 agent 运行中 | 显示子 agent 的每个工具调用 | "{agentName} 工作中…" |
| 子 agent 完成 | "subagent.done" | "审核结果中…" |
| `run.mainDoc.update` | "run.mainDoc.update" | "更新工作台…" |
| `kb.search` | "kb.search" | "查阅资料中…" |
| `lint.style` | "lint.style" | "风格检查中…" |
| `doc.write` | "doc.write" | "写入文件中…" |
| `web.search` | "web.search" | "搜索中…" |

**实现位置**：`apps/desktop/src/agent/gatewayAgent.ts` 中的 `humanizeToolActivity()` 函数（第 234 行）。

**子 agent 中间过程隐藏**：`gatewayAgent.ts:2689-2693`，当 `tool.call` 事件携带 `agentId` 时，直接 `continue` 跳过不创建 ToolBlock，只显示 `{agentName} 正在处理…` 的整体 loading 状态。

⚠️ **遗留小瑕疵**：`agent.delegate` 的 activity 显示使用的是 `agentId`（如 `"copywriter"`）而非中文 `agentName`（如 `"文案写手"`），因为 tool 调用的 args 只含 `agentId`。需要在 `humanizeToolActivity` 中从 `BUILTIN_SUB_AGENTS` 查找 name 来改善显示。

### H. Agentic Loop 模式确认

#### 诊断

我们的 agent 循环**不是严格的 ReAct**。

| 维度 | 严格 ReAct | 我们的实现 |
|------|-----------|-----------|
| 单步循环 | 思考→行动→观察→重复 | 思考→多个行动→多个观察→重复 |
| 并行工具调用 | ❌ 不支持 | ✅ 支持（`agent.delegate` 并行，常规顺序） |
| 官方名称 | ReAct | **Agentic Loop** |

Anthropic 官方将此模式称为 **Agentic Loop**（gather context → take action → verify results → repeat），明确区别于学术意义上的 ReAct。

**我们的具体模式**：
```
while (turn < maxTurns) {
  // 1. LLM 推理：可能返回 text + 多个 tool_use 块
  response = streamAnthropicMessages(system, messages, tools)

  // 2. 分拣工具调用
  delegateCalls = response.tool_uses.filter(t => t.name === "agent.delegate")
  regularCalls  = response.tool_uses.filter(t => t.name !== "agent.delegate")

  // 3. 并行执行委派，顺序执行常规工具
  await Promise.all(delegateCalls.map(exec))
  for (call of regularCalls) await exec(call)

  // 4. 排序合并结果，作为下一轮 user message 返回给 LLM
  messages.push(orderedResults)

  // 5. 如果无工具调用（stop_reason=end_turn），循环结束
}
```

---

## 四、已修复项（本次 session）

| 项目 | 修复内容 | 文件 | 行号 |
|------|---------|------|------|
| `run.mainDoc.get` 返回 null | Gateway 维护 `ctx.mainDoc` 可变状态，`run.mainDoc.update` 时 `Object.assign` 合并 patch，`run.mainDoc.get` 返回真实内容 | `serverToolRunner.ts`, `writingAgentRunner.ts`, `index.ts` | `serverToolRunner.ts:476-485` |
| Friday 角色定位 | prompt 从"直接干活"改为"拆解→指派→审核→交付"；新增指派策略（第 4 条）；mainDoc 改名"任务工作台" | `index.ts:buildAgentProtocolPrompt()` | `index.ts:1278-1284` |
| **B: 子 agent 上下文注入** | `buildSubAgentContextHint()` 自动将风格库 ID、mainDoc 目标/约束追加到 taskMessage | `writingAgentRunner.ts` | `writingAgentRunner.ts:140-183, 858-865` |
| **子 agent model 独立配置** | 读取 `subAgent.model` 和 `fallbackModels`，调用 `resolveSubAgentModel` 回调，不再硬继承父 agent | `writingAgentRunner.ts` | `writingAgentRunner.ts:746-762` |
| **A: subAgent.skills 标注 deprecated** | `skills` 字段加 `@deprecated` JSDoc，`subCtx.activeSkills = []` 不再激活，风格闭环由负责人执行 | `packages/agent-core/src/subAgent.ts` | `subAgent.ts:28-33` |
| **G: 自然语言 loading** | `humanizeToolActivity()` 映射全部工具名为中文 activity；`subagent.start` 时显示 `{agentName} 正在处理…`；子 agent 的 `tool.call` 事件携带 `agentId` 时直接 skip，不创建 ToolBlock | `apps/desktop/src/agent/gatewayAgent.ts` | `gatewayAgent.ts:234-264, 2689-2693` |
| **C: 子 agent doc.write 重定向** | 子 agent（`this.ctx.agentId` 存在时）调用 `doc.write`/`doc.applyEdits` 被拦截，内容暂存为 artifact（含 `redirected: true` 标记），等待负责人审核后决定是否写入 | `writingAgentRunner.ts` | `writingAgentRunner.ts:639-663` |
| **F: 负责人 prompt 配置自助** | 在 `buildAgentProtocolPrompt()` agent 模式下新增第 6) 条指引：遇到"创建子 agent/MCP/Skill"需求时，先读 `docs/specs/` 规范文档 | `apps/gateway/src/index.ts` | `index.ts:1284` |

---

## 五、后续改进优先级

> 以下所有项目均已完成代码实现（截至 2026-02-23）。

### P0（阻塞正常使用）✅ 全部完成

- [x] `run.mainDoc.get` 返回 null → 已修复
- [x] Friday 角色定位 prompt → 已修复
- [x] **B: 子 agent 上下文注入** — 在 `_executeSubAgent()` 中自动追加风格库 ID 和 mainDoc 目标到 taskMessage
- [x] **子 agent model 使用** — 读取 `subAgent.model` 和 `fallbackModels`，不再硬继承父 agent

### P1（影响体验）✅ 全部完成

- [x] **G: Desktop 自然语言 loading** — `humanizeToolActivity()` 映射 + 子 agent 中间过程隐藏
- [x] **A: 清理 subAgent.skills** — 标注 deprecated，风格闭环由负责人执行

### P2（架构完善）✅ 全部完成

- [x] **C: 子 agent doc.write 重定向到 artifact** — 防止并行写入冲突
- [x] **F: 负责人 prompt 中添加文档读取提示** — 支持自助配置（gateway 侧，用户不可见）

---

## 六、遗留小问题

以下问题不影响功能，但可在后续迭代中改进：

| 编号 | 问题 | 严重度 | 当前状态 | 建议修复方式 |
|------|------|--------|---------|------------|
| G-1 | `agent.delegate` activity 显示 agentId（`copywriter`）而非中文 agentName（`文案写手`） | 🟢 低 | 遗留 | 在 `humanizeToolActivity` 中从 `BUILTIN_SUB_AGENTS` 查找 name |
| E-1 | 子 agent 全量输出（中间推理）对主 agent 可见，而非精炼摘要 | 🟡 中 | 遗留 | 在 `_executeSubAgent` 返回前提炼 artifact，隐藏中间 tool 调用细节 |

---

## 六、参考来源

### Anthropic
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Building a C Compiler with 16 agents](https://www.anthropic.com/engineering/building-c-compiler)

### OpenAI
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [Tracing](https://openai.github.io/openai-agents-python/tracing/)

### Google
- [ADK Multi-Agent Systems](https://google.github.io/adk-docs/agents/multi-agents/)
- [Parallel Agents](https://google.github.io/adk-docs/agents/workflow-agents/parallel-agents/)
- [State Management](https://google.github.io/adk-docs/sessions/state/)

### MetaGPT
- [MetaGPT: Meta Programming for Multi-Agent Collaborative Framework](https://arxiv.org/html/2308.00352v6)

### AutoGen (Microsoft)
- [Conversation Patterns](https://microsoft.github.io/autogen/0.2/docs/tutorial/conversation-patterns/)
- [Selector Group Chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- [Docker Code Execution](https://microsoft.github.io/autogen/0.2/blog/2024/01/23/Code-execution-in-docker/)

### LangGraph
- [Multi-Agent Orchestration Guide 2025](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [Building LangGraph: Designing an Agent Runtime from First Principles](https://blog.langchain.com/building-langgraph/)
- [Parallel Nodes & Superstep Model](https://medium.com/@gmurro/parallel-nodes-in-langgraph-managing-concurrent-branches-with-the-deferred-execution-d7e94d03ef78)

### CrewAI
- [CrewAI Framework 2025 Review](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform)
- [Hierarchical AI Agents: Delegation Guide](https://activewizards.com/blog/hierarchical-ai-agents-a-guide-to-crewai-delegation)

### 沙箱与隔离
- [How to sandbox AI agents (Northflank)](https://northflank.com/blog/how-to-sandbox-ai-agents)
- [NVIDIA Security Guidance for Sandboxing](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk)
- [Container Use (Dagger)](https://www.infoq.com/news/2025/08/container-use/)
- [Google Cloud Agent Sandbox (Kubernetes)](https://www.infoq.com/news/2025/12/agent-sandbox-kubernetes/)
- [OVADARE Conflict Resolution](https://docs.ovadare.com/introduction)

### 文件锁与并发
- [Distributed Locking (Martin Kleppmann)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [VS Code Strict Mode for WorkspaceEdit](https://github.com/microsoft/vscode/issues/279589)

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-23 | v0.2 | 架构审查：8 项问题诊断 + 业界 8 框架横评 + 沙箱评估 + 改进方案 |
| 2026-02-23 | v0.2.1 | 执行进度更新：P0/P1/P2 全部完成；补充各修复项的代码位置（文件 + 行号）；添加遗留小问题清单（G-1 agentId 显示、E-1 摘要精炼）；文档状态更新为 completed |
