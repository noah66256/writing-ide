# Agent 工具误用与结束反馈异常：范式级根因研究（2026-03-04）

## 1. 结论先行

这次不是“语义理解单点问题”，也不是“单一路由 bug”，而是 **路由策略 + 工具契约 + 执行反馈协议** 三层耦合失配：

1. **主因：路由层缺少“删除类任务”的硬门禁**
- 用户意图是“删除临时文件”，但代理仍可能走 `doc.read`（尤其上下文里有“读 xlsx”的历史残留时）。
- 说明当前仅有“file_ops 大类路由”，缺少 `delete_only` 子意图的确定性策略。

2. **次因：工具契约未严格约束路径语义**
- `doc.read` 的路径约定（项目相对路径）与用户输入（绝对路径）存在隐式转换歧义。
- 这类“看起来对、运行时错”的参数错配，在多框架都属于高频问题。

3. **放大器：run 结束反馈没有把失败步骤结构化回传给用户**
- “本轮已结束，但有 N 个步骤失败”是必要兜底，但不足以指导修复。
- 用户体感上仍像“无反馈/故障”。

---

## 2. 外部范式证据（全网 + GitHub）

## A. 工具调用必须“强 schema + 严格模式”
- Anthropic 文档明确：
  - Haiku 对工具参数“可能推断缺失参数”，复杂工具建议更强模型与更清晰定义。
  - `strict` tool use 可保证工具参数符合 schema。
- OpenAI 文档明确：
  - `strict: true` 可显著提升函数调用参数可靠性；
  - 并行工具调用会影响 strict 行为，必要时应 `parallel_tool_calls=false`。

## B. 高风险工具应走 HITL 中断机制（approve/edit/reject）
- LangChain/LangGraph 人审中断范式：
  - 对 `write_file`/`execute_sql` 等高风险工具进行可恢复中断。
  - 支持 `approve` / `edit` / `reject`，并保持线程状态恢复。
- AutoGen 有同类 intervention handler，在工具执行前可拦截并要求用户许可。

## C. 工具错误必须是“模型可消费”的结构化错误
- MCP 官方建议：
  - 工具错误应放在工具结果对象中（而非协议级崩溃），让模型能据此纠错。
  - 强调输入校验、路径清洗、返回值校验、超时与日志。
- PydanticAI 的实践是：
  - 参数校验错误生成可重试提示（RetryPrompt），
  - `ModelRetry` 明确告诉模型“怎么改下一次调用”。

## D. 路径规范化是安全与正确性共同问题（GitHub 真实案例）
- MCP 生态近期安全通告（GHSA-vjqx-cfc4-9h6v / CVE-2026-27735）表明：
  - 路径未规范化/未做边界校验会直接造成越界与错误行为。
- 这和我们当前“绝对/相对路径语义不统一导致 FILE_NOT_FOUND”是同类范式问题（正确性侧）。

## E. GitHub 实战 issue：工具参数适配层常见“看似传了、底层却丢参”
- LangChain issue #34029（missing positional argument）显示：
  - 工具调用在适配层仍可能出现参数丢失/签名不匹配。
  - 证明仅靠提示词不够，必须有严格契约与执行前验证层。

---

## 3. 根因模型（分层）

## L1 路由层（Router）
- 现状：大类 `file_ops` 路由可命中，但缺少子意图约束。
- 后果：删除任务仍可能先读文件，甚至读错工具（`doc.read` 读 xlsx）。

## L2 工具契约层（Tool Contract）
- 现状：路径、文件类型、读写能力边界没有强约束到“模型无法误用”。
- 后果：绝对路径/二进制文件在文本读取工具里触发不必要失败。

## L3 执行与恢复层（Execution & Recovery）
- 现状：失败回传对用户可读，但对“下一步行动”不够具体；对模型纠错提示不够类型化。
- 后果：用户看见失败，不知道“该改参数还是换工具”。

## L4 人审层（HITL）
- 现状：已有高风险确认，但尚未形成统一“中断-编辑-恢复”策略模型。
- 后果：不同场景体验不一致，策略难扩展到更多 Agent 场景。

## L5 可观测与评估层（Obs/Eval）
- 现状：缺少“意图->工具”正确率、误调用率、重试修复率等指标闭环。
- 后果：只能靠个案修补，难以系统优化。

---

## 4. 回答你的关键问题

“这是语义理解问题还是路由问题？”

- **以路由/策略问题为主（主因）**，语义理解为辅（次因）。
- 更准确说：**策略门禁不足 + 契约不严 + 反馈协议不完整**，导致“删除任务被读文件”的系统性偏差。

---

## 5. 范式级治理方案（不靠补丁）

## Phase A：Intent Compiler（确定性子意图）
- 在 `file_ops` 下细分：`delete_only` / `rename_move` / `read_only` / `mixed_edit`。
- `delete_only` 规则：
  - 禁止 `doc.read`；
  - 先 `project.listFiles`（必要时）再 `doc.deletePath`；
  - 若目标已明确，允许直接删。

## Phase B：Tool Contract Hardening（强约束）
- 所有工具参数强 schema（严格模式）。
- 路径统一规范：`absolute -> project-relative` 显式转换，越界即 typed error。
- 文件类型门禁：文本读取工具拒绝二进制类型，并返回“建议工具”。

## Phase C：Error-as-Protocol（可恢复错误）
- 错误标准化：
  - `ERR_PATH_OUT_OF_PROJECT`
  - `ERR_BINARY_NOT_TEXT_READABLE`
  - `ERR_PARAM_SCHEMA_MISMATCH`
  - `ERR_TOOL_POLICY_DENIED`
- 每类错误附带 `next_actions`（供模型和用户都能用）。

## Phase D：HITL State Machine（统一人审状态机）
- 高风险工具统一走中断流：`approve/edit/reject`。
- 支持对话内编辑参数后恢复执行，不重新跑整轮。

## Phase E：可观测指标
- `intent_route_miss_rate`
- `wrong_tool_call_rate`（按意图分桶）
- `typed_error_recovery_rate`
- `run_end_actionable_feedback_rate`

---

## 6. 参考资料

1. Anthropic Tool Use 实现指南（模型选择、tool_choice、tool 定义最佳实践）  
https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use

2. Anthropic Tool Use 概览（strict tool use）  
https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

3. OpenAI Function Calling（strict / parallel_tool_calls / schema 要求）  
https://developers.openai.com/api/docs/guides/function-calling

4. OpenAI Structured Outputs 介绍（strict schema 收敛）  
https://openai.com/index/introducing-structured-outputs-in-the-api/

5. MCP Tools 官方概念与最佳实践（错误回传、路径清洗、工具注解）  
https://modelcontextprotocol.io/legacy/concepts/tools

6. LangChain HITL（approve/edit/reject 中断范式）  
https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop

7. AutoGen Intervention Handler（执行前人工许可）  
https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/cookbook/tool-use-with-intervention.html

8. PydanticAI Advanced Tools（ValidationError / ModelRetry / timeout-retry）  
https://ai.pydantic.dev/tools-advanced/

9. GitHub 生态安全案例：MCP Server Git 路径越界（GHSA-vjqx-cfc4-9h6v）  
https://osv.dev/vulnerability/GHSA-vjqx-cfc4-9h6v

10. GitHub 实战 issue：工具参数适配失败（LangChain #34029）  
https://github.com/langchain-ai/langchain/issues/34029

