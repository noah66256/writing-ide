# 终端命令 & Unified Exec 跟踪改造（对标 Codex，Phase 计划 v0.1）

> 目标：让 Crab 在「执行命令 + 看终端 + 判断任务是否完成」这一条链路上，对齐 Codex 的成熟范式：  
> - 每条命令都有结构化结果（exit/时长/输出/超时），而不是只在 audit 里埋一坨 stdout；  
> - Agent 能像“看终端”一样总结结果、给出下一步，而不是静默结束；  
> - 有可复用的“终端会话 ID”（processId），区分同一条终端线和新开的会话。

---

## 0. 当前问题小结（Crab 现状）

以「帮我在本地部署 openclaw」这轮为例：

- Gateway / Desktop 已能在助手模式下真跑命令：
  - `shell.exec`：git clone / cat README / curl 官方安装脚本；
  - `process.*` 已存在（run/list/stop），但实战中并未作为“终端会话 API”使用。
- 问题在于：
  1. **单次命令缺少结构化总结**  
     - tool.result 里有 exitCode/stdout/stderr/timeout，但只进了 audit，没被翻译成「Exit code + Duration + Output + Timeout 提示」这类人/模都能理解的总结；  
     - 超时时，只暴露 `TOOL_RESULT_TIMEOUT`，没有明确自然语言告诉模型“状态不确定，需要你提醒用户手动检查”。
  2. **没有“终端记录”写回对话**  
     - Agent 回复只是一段“安装步骤说明”，而不是「我刚跑的命令结果如下：…」，用户看不到命令执行情况；  
     - 模型也没有统一格式的“终端消息”可以引用，只能自己猜 stdout/stderr 字符串怎么解释。
  3. **缺少统一的“terminal id / 会话”概念**  
     - shell.exec 每次都是一次性调用，process.* 又没有在协议层明确当作终端会话暴露；  
     - 模型不知道哪些命令是在同一个“终端会话”里连续执行的，哪些是新开的。

对比 Codex：

- `ExecToolCallOutput` 把每次命令的 exit/duration/stdout/stderr 聚合成一个统一结构；
- `tools::format_exec_output_*` 用 Exit code + Wall time + 截断后输出的形式给模型看；
- `user_shell_command` 用 `<user_shell_command><command>...</command><result>...</result></user_shell_command>` 记录到对话历史；
- Unified Exec 用 `process_id` 管理 PTY 进程，支持 exec_command/write_stdin，天然就是“terminal id”。

本改造的目标，就是把这条链路在 Crab 里分 Phase 落下来，而不是一次性重写。

---

## 1. Phase 0 — 统一 shell.exec 结果契约（不改 UI，只改数据面）

**目标：** 对齐 Codex 的 `ExecToolCallOutput` 语义，让所有 shell.exec 调用都有统一结构，便于后续格式化与 UI 展示。

**具体动作：**

1. 在 Desktop 侧 shell.exec handler 中，保证输出结构最少包含：
   - `ok: boolean`
   - `exitCode: number | null`
   - `stdout: string`
   - `stderr: string`
   - `durationMs: number`
   - `timedOut: boolean`（非 0 exit + timeout 要区分）
2. 明确 Codex 式超时语义：
   - 将内部超时统一映射为 `timedOut = true`，`exitCode = EXEC_TIMEOUT_EXIT_CODE` （例如 130/124 一类）；
   - Gateway 收到 `timedOut=true` 时，不再仅以 `TOOL_RESULT_TIMEOUT` 口头表示，而是保留 exitCode + durationMs。
3. 收紧错误码空间：
   - 保留少量标准错误码：`TOOL_RESULT_TIMEOUT` / `SANDBOX_DENIED` / `NON_ZERO_EXIT`；
   - 其它系统错误统一落到 `GENERIC_EXEC_ERROR`，把细节放在 stderr 里。

> 交付物：  
> - Desktop shell.exec 的输出 schema 文档（tools 层）；  
> - Gateway 对 `timedOut` / `exitCode` 的映射规则；  
> - 不改 UI，只保证数据面稳定。

---

## 2. Phase 1 — shell.exec 结果总结器（“看终端”的最小版本）

**目标：** 像 Codex 的 `format_exec_output_for_model_freeform` 一样，把每次 shell.exec 的结果强制翻译成一段可读总结，喂给模型和用户。

**具体动作：**

1. 在 Gateway 增加 `formatShellExecResultForModel`（对标 Codex `format_exec_output_for_model_freeform`）：
   - 输入：Phase 0 的统一结果结构；
   - 输出文本大致为：
     - `Exit code: <n>`  
     - `Wall time: <X.Y> seconds`  
     - `Output:\n<truncated stdout/stderr/aggregated>`  
     - 若 `timedOut=true`，增加首行：`command timed out after <ms> milliseconds`。
2. 定义一个“终端记录”片段（可参考 Codex 的 `<user_shell_command>`）：
   - 简化版结构：

     ```text
     <user_shell_command>
     <command>
     cd /Users/noah/openclaw && curl ...
     </command>
     <result>
     Exit code: 0
     Duration: 12.3 seconds
     Output:
     ...
     </result>
     </user_shell_command>
     ```

   - 作为一条独立的 assistant 消息插入对话流（或附着在工具总结里），让模型能引用、用户能看见。
3. 调整 Agent 协议：
   - 在 system prompt 中明确要求：  
     - 所有高危命令执行后，必须先阅读终端记录，再用自然语言总结「是否成功 + 有无超时/沙箱问题 + 建议下一步」；  
     - 禁止在超时/错误时假装“已经完成安装”。

> 交付物：  
> - Gateway `formatShellExecResultForModel` 实现；  
> - 一个 `<user_shell_command>` 风格的终端记录辅助函数；  
> - Agent 协议更新（system prompt 增加“执行后必须总结”的约束）。

---

## 3. Phase 2 — 终端会话 ID（用 process.* 做统一“伪终端”）

**目标：** 借 Codex Unified Exec 的 `process_id` 思路，把现有 `process.run/list/stop` 正式变成“终端会话 API”，提供 Crab 版的 terminal id。

**具体动作：**

1. 明确工具分工：
   - `shell.exec`：一次性命令；适合 clone / cat / curl 等短执行；不持久保存会话。
   - `process.run`：长时间运行进程（dev server、gateway、本地服务）。返回 `processId`，充当“终端会话 ID”。
   - `process.list`：列出当前所有由 Crab 启动的会话（processId + command + status + startedAt）。
   - `process.stop`：按 processId 停止指定会话。
2. 规范 process.* 输出结构：
   - `process.run` 返回：
     - `ok / error`
     - `processId`
     - `command / cwd / startedAt`
   - `process.list` 返回：
     - `[ { processId, command, status: running|exited|error, startedAt, exitCode? } ]`
3. Agent 协议层增加推荐用法：
   - 如果用户要“开长期服务”（如 dev server / dashboard），优先使用 process.run，而不是用 shell.exec 起一个无法追踪的进程；  
   - 若需要检查服务是否还在运行，使用 process.list；
   - 结束服务用 process.stop，而不是随手再 exec 一个 kill。

> 交付物：  
> - process.* 工具返回结构文档 + 实现校验；  
> - system prompt 中对“长期服务 vs 一次性命令”的使用建议；  
> - 后续 UI 可以基于 processId 列表展示“终端会话面板”。

---

## 4. Phase 3 — UI & 交互：把终端反馈真正呈现给用户

**目标：** 在 Desktop UI 上，让用户能感知“终端正在做什么/做完了没有”，而不是只看到“正在执行命令…”。

**具体动作：**

1. Chat 气泡里展示终端总结：
   - 对每个 shell.exec / process.run 调用，在对话中插入一条“终端消息气泡”，内容可以是：
     - 标题：`终端命令：cd ... && ... [成功/失败/超时]`  
     - 展开/收起：显示/隐藏 stdout 截断内容。
2. 加一个“进程/终端会话面板”（后续 Phase 可以实现）：
   - 简单列表：`processId / 命令 / 状态 / 运行时长`；  
   - 允许用户手动 stop 某个会话。
3. 超时/错误的显式提醒：
   - 如果 `timedOut=true` 或 exitCode ≠ 0，在 UI 中加一个红色提示：
     - “命令超时/失败，状态不确定，请按提示检查”；  
     - 把 agent 的自然语言总结放在同一个气泡里。

> 交付物：  
> - ChatArea 里的终端结果展示组件；  
> - 可选的“进程面板”设计与最小实现（仅列表 + stop 按钮）。

---

## 5. Phase 4 —（可选）Unified Exec 流式终端 & 高级特性

**目标：** 在前面几 Phase 稳定后，再考虑引入 Codex 式的 Unified Exec：带 PTY、支持 write_stdin、流式输出和 Approval pipeline。

**候选方向：**

1. 在 Desktop 主进程引入 PTY 支持（node-pty/自研），实现：
   - `exec_command(processId, cmd, yield_time_ms, max_output_tokens)`；  
   - `write_stdin(processId, input, yield_time_ms, max_output_tokens)`；  
   - 返回类似 Codex `UnifiedExecResponse` 的结构（output chunk + processId + exit_code）。
2. 在 Gateway 增加 Unified Exec 工具：
   - `unified.exec_command` / `unified.write_stdin`；
   - 用 approval_policy + sandbox_permissions 控制高风险命令。
3. 在协议和 UI 上区分：
   - 单次命令（shell.exec） vs 交互式会话（unified.exec_* + process.*）；
   - 给后者配一个更像“终端窗格”的展示方式。

> 由于复杂度和风险较高，Phase 4 暂不作为近期必做；优先把 Phase 0–3 做稳，让 shell.exec/过程追踪/用户反馈先达到“Codex 80% 体验”。

---

## 6. 与既有文档的关系

- 与 `docs/specs/tools-fs-and-runtime-refactor-v0.1.md`：
  - 那篇主要解决“工具命名/分层 + 创作/助手模式下的权限边界”；  
  - 本文则进一步落在“命令结果格式 + 终端会话管理 + UI 呈现”，属于 runtime 行为层补充。
- 与 `docs/research/core-tools-exposure-refactor-2026-03-13.md`：
  - CORE_TOOLS/HIGH_RISK_TOOLS 里已经收录了 shell.exec/process.*/cron.*；  
  - 本文 Phase 0–3 不再改工具集合，只改它们的结果契约和使用方式。

后续若实际实现有偏离，应在本文追加“变更记录”，避免 spec 与代码长期漂移。 

