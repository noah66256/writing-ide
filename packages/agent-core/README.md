## packages/agent-core（Agent 执行内核）

### 目标

提供 Agent 运行的核心抽象，供 Gateway 和 Desktop 复用：

- **RunState + Policy**：最小状态机与策略函数（意图路由、预算拆分、proposal 判定等）
- **Skills 框架**：标准化能力包的注册、触发规则匹配、激活判定
- **Sub-Agent 定义**：子 Agent 的标准接口（systemPrompt、工具白名单、budget）

### 主要模块

- `runMachine.ts`：RunState + Policy 纯函数（结构化意图 runIntent、预算拆分、autoRetry/styleGate/proposal 判定）
- `skills.ts`：Skill 注册与激活框架（TriggerRule 匹配、`SKILL_MANIFESTS` 内置能力包）
- `subAgent.ts`：内置子 Agent 定义（copywriter / topic_planner / seo_specialist）+ 自定义 Agent 支持

### 导出

- `AgentMode`、`RunState`、`SkillManifest`、`SubAgentDefinition`、`ParsedToolCall` 等类型
- `evaluateSkillTriggers()`、`analyzeAutoRetryText()` 等策略函数
