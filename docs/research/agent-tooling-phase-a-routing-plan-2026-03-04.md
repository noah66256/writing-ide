# Phase A 执行方案：Intent 路由层改造（先路由，不改业务写入逻辑）

关联研究：`docs/research/agent-tooling-root-cause-2026-03-04.md`

## 1. 目标与边界

## 目标（P0）
1. 用户是“删除类任务”时，首轮不再误调 `doc.read`。  
2. 路由输出对模型是确定性的：删除类任务优先走 `doc.deletePath`（必要时先 `project.listFiles`）。  
3. run 结束反馈可操作：至少包含失败步骤名 + 原因摘要。

## 不做（本 Phase 不做）
1. 不改 MCP 执行层。  
2. 不重构全部工具 schema。  
3. 不改 proposal-first 核心机制。

---

## 2. 当前代码定位（可直接改）

1. 路由注册表：`apps/gateway/src/agent/runFactory.ts`  
2. 意图判定函数：`looksLikeFileOpsIntent` / `computeIntentRouteDecisionPhase0`  
3. 工具调用协议提示：`buildAgentProtocolPrompt`（为 delete-only 增强工具顺序约束）  
4. 运行结束事件：`apps/desktop/src/agent/wsTransport.ts`（补失败摘要文本）

---

## 3. 设计：Intent Compiler V1.1

## 新增 route（子意图）
在 `ROUTE_REGISTRY_V1` 增加：

1. `file_delete_only`
- intentType: `task_execution`
- todoPolicy: `required`
- toolPolicy: `allow_tools`
- nextAction: `enter_workflow`
- desc: 删除/清理类任务（优先删除闭环，禁止无意义读取）

2. `file_ops_other`
- 保留当前 `file_ops` 语义（重命名/移动/mkdir 等）

## 新增判定函数
在 `runFactory.ts` 新增：

1. `looksLikeDeleteOnlyIntent(text: string): boolean`
- 命中词：`删除|删掉|移除|清理|清空|rm|del`
- 排除词：`读|读取|查看|解析|提取|总结|分析`
- 目标提示：路径、`@{}`、`~$`、`.~`、文件后缀等

2. `extractDeleteTargetsHint(text: string)`
- 只做轻量解析：提取路径 token、前缀模式（如 `~$` / `.~`）、目录关键词
- 用于给模型注入“先 list 再 delete”的明确上下文，不做真实删除逻辑

## 路由优先级调整（关键）
`computeIntentRouteDecisionPhase0` 顺序改为：

1. Chat / OK-only / visibility（保持）  
2. `delete_only`（新）  
3. project_search  
4. file_ops_other  
5. 其它默认

说明：把 `delete_only` 提前，避免被“调试/讨论/搜索”规则误吃掉。

---

## 4. 工具策略约束（Prompt 层）

在 `buildAgentProtocolPrompt` 增加 delete-only 规则片段（由 routeId 注入）：

1. 若 `routeId=file_delete_only`：
- 首选工具序列：`project.listFiles`（必要时） -> `doc.deletePath` -> `run.done`
- 禁止先调 `doc.read`（除非用户明确要求“先查看内容再删”）
- 对绝对路径删除：直接尝试删除，不做读取探测

2. 当删除失败时：
- 立即反馈失败路径与错误码
- 不允许用 `run.done` 掩盖失败（必须先给失败说明）

---

## 5. 结束反馈改造（Desktop）

当前已有兜底“失败 N 项”，Phase A 要求提升为：

1. 输出前 3 个失败步骤摘要：
- 工具名
- error
- 关键输入（path）

2. 若是 `FILE_NOT_FOUND` 且任务是删除：
- 自动补一句“你要的是删除，不需要先读；请确认目标路径或先列文件后批量删除”。

---

## 6. 验收用例（必须全过）

## Case A：删除临时文件（你的真实场景）
输入：`把桌面里 ~ 开头临时文件都删了`  
预期：
1. routeId = `file_delete_only`
2. 首轮不出现 `doc.read`
3. 走 `project.listFiles` + `doc.deletePath`（可批量）
4. 结束时给出“成功/失败清单”

## Case B：删除单文件（绝对路径）
输入：`删除 /Users/noah/Desktop/25-01-02案例4(1).xlsx`  
预期：
1. 不调用 `doc.read`
2. 直接删或先确认后删
3. 失败时返回具体路径和错误

## Case C：确实要先读再删
输入：`先读下这个文档内容，确认后再删`  
预期：
1. 可调用 `doc.read`（文本文件）或对应 MCP
2. 不误触 delete-only 硬门禁

## Case D：讨论态
输入：`为什么之前会删失败`  
预期：
1. routeId = `discussion`
2. 不触发删除工具

---

## 7. 可观测埋点（P0 必加）

1. `intent.route.phase0`
- fields: `routeId`, `confidence`, `reason`, `derivedFrom`, `promptHash`

2. `intent.delete_only.guard`
- fields: `blockedToolName`, `reason`

3. `run.end.failure_digest`
- fields: `failedCount`, `failedTools[]`（裁剪）

---

## 8. 交付拆分（最小闭环）

## Task 1（P0）
- 新增 `delete_only` route + 优先级调整  
- 完成 4 个验收用例中的 A/B

## Task 2（P0）
- Prompt 注入 delete-only 工具序列约束  
- 跑 A/B/C

## Task 3（P0）
- run.end 失败摘要增强  
- 跑 A/B + 结束反馈检查

---

## 9. 风险与回滚

## 风险
1. delete-only 规则误伤“先读后删”任务。  
2. 关键词规则对口语化输入覆盖不足。

## 回滚
1. 用 feature flag：`ROUTER_DELETE_ONLY_V1=true/false`。  
2. 若误伤，单独关闭 `delete_only` 分支，保留其余改造。

