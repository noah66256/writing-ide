# Claude Code CLI 逆向研究（2026-03-25）

## 结论先行

这次本地逆向已经可以比较确定地说明：Claude Code CLI 的核心不只是“一个 prompt + 一组工具”，而是 5 层东西一起工作。

1. 动态 system prompt 拼接层
2. 自己定义的一层 stdout 事件协议层
3. 本地持久化的 session / project / memory / todo / plan 状态层
4. hooks / skills / plugins / MCP 并列的扩展层
5. 权限模式与工具治理层

它更像一个本地 agent runtime，而不是单纯的 Anthropic API 壳。

对我们最有价值的不是“它某句 prompt 怎么写”，而是它把这些层拆开了：
- 模型负责决策
- CLI runtime 负责协议、持久化、权限、扩展注册、MCP 生命周期
- 前端/桥接层消费的是 Claude Code 自己的统一事件，而不是 provider 原生事件

这点和我们现在在做的“单核心编排 + 多端点薄适配”方向是对的，而且 Claude Code 给了更清晰的落地参照。

---

## 研究范围

本次研究只基于本机 Claude Code CLI 的一手材料：

- CLI 安装包与入口文件
- `--help` / `agents` 等命令输出
- 本地 `~/.claude` 持久化目录
- 真实 `stream-json` 运行输出
- debug 日志
- 最小工具调用实验

未做的事：
- 没有反编译成完整可读源码
- 没有抓包 provider 原始 HTTP 请求
- 没有碰认证凭据，文中一律省略敏感值

---

## 一、安装形态与包结构

### 1.1 安装形态

本机 Claude Code CLI 不是原生二进制，是 npm 安装的 JS 包。

关键路径：
- 可执行入口：`/Users/noah/.npm-global/bin/claude`
- 实际入口：`/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`
- 包信息：`/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json`

版本：
- `2.1.80`

结论：
- 这是可静态搜字符串、也可做动态运行实验的目标
- 但 `cli.js` 是压缩过的大单文件，不适合把它当普通源码仓库看

### 1.2 包目录中可见的核心资产

目录：`/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code`

可见内容：
- `cli.js`
- `README.md`
- `sdk-tools.d.ts`
- `vendor/ripgrep`
- `vendor/tree-sitter-bash`
- `vendor/audio-capture`
- `resvg.wasm`

说明：
- 它把一部分能力直接打进包里，而不是完全依赖外部环境
- ripgrep / tree-sitter 这类 vendor 资产说明它对本地代码理解和搜索是内建能力

---

## 二、CLI 能力面

### 2.1 从 `claude --help` 抽出的稳定参数面

命令：`claude --help`

确认存在的关键参数：
- `--agent`
- `--agents`
- `--tools`
- `--allowedTools` / `--disallowedTools`
- `--mcp-config`
- `--strict-mcp-config`
- `--permission-mode`
- `--system-prompt`
- `--append-system-prompt`
- `--plugin-dir`
- `--worktree`
- `--output-format`
- `--input-format`
- `--no-session-persistence`

确认存在的关键子命令：
- `agents`
- `auth`
- `doctor`
- `install`
- `mcp`
- `plugin|plugins`
- `setup-token`
- `update|upgrade`

### 2.2 权限模式

`--permission-mode` 可见值：
- `acceptEdits`
- `bypassPermissions`
- `default`
- `dontAsk`
- `plan`
- `auto`

结论：
- 权限模式不是 UI 小开关，而是 runtime 一级状态
- 这解释了为什么 session 落盘里会直接带 `permissionMode`

### 2.3 内置 agent

命令：`claude agents`

本机可见：
- `Explore`
- `general-purpose`
- `Plan`
- `statusline-setup`

说明：
- agent 是一等运行单元，不是 prompt 里的软角色扮演

---

## 三、System Prompt 不是单块，而是动态拼接

### 3.1 已确认的 prompt 段名

在 `cli.js` 里直接能搜到这些标题：
- `# Doing tasks`
- `# Using your tools`
- `# Output efficiency`
- `# Tone and style`
- `# MCP Server Instructions`

### 3.2 已确认的拼接逻辑

在压缩后的 `cli.js` 中可以看到几个关键函数：
- `HX(...)`：组装 system prompt 主体
- `Ui9(...)`：拼接 MCP server instructions
- `Qi9(...)` / `JX4(...)`：注入环境信息、模型信息
- `Ri(...)`：扫描并加载 `commands / agents / output-styles / skills / workflows`

这说明它不是单一大 prompt，而是：

1. 先拿运行环境
2. 再拿可用工具/技能/MCP/配置
3. 再按块拼成最终 system prompt

### 3.3 MCP instructions 是单独注入的

`cli.js` 中能看到：

- `Ui9(...)` 会筛选 `connected` 且带 `instructions` 的 MCP server
- 然后拼成 `# MCP Server Instructions`

结论：
- MCP 不是“只暴露工具名”
- MCP server 自带说明也会直接进入 system prompt
- 这比“只把 schema 给模型看”多了一层能力解释

对我们很有参考价值：
- 工具 schema 解决“能不能调”
- tool/server instructions 解决“什么时候该调、怎么调”
- 这两层不能混为一层

---

## 四、Claude Code 对外协议不是 provider 原生协议

### 4.1 `stream-json` 是 Claude Code 自己的一层统一事件协议

最小实验命令：

```bash
cd /tmp/claude-re && \
printf '请只使用 Bash 工具执行 "cat sample.txt"，然后用一句话告诉我读到了什么。' | \
claude -p --verbose --output-format stream-json --include-partial-messages \
  --debug-file /tmp/claude-re/cc-tool.log \
  --permission-mode bypassPermissions \
  --tools Bash \
  --allowedTools Bash
```

实验前准备：

```bash
mkdir -p /tmp/claude-re
printf 'alpha\n' > /tmp/claude-re/sample.txt
```

### 4.2 首帧 `system/init` 暴露完整能力面

首条事件里直接有：
- `cwd`
- `session_id`
- `tools`
- `mcp_servers`
- `model`
- `permissionMode`
- `slash_commands`
- `agents`
- `skills`
- `plugins`
- `claude_code_version`
- `output_style`

这非常关键。

说明 Claude Code 的上层 UI/桥接层拿到的第一件事，不是“模型说了啥”，而是：
- 当前会话在哪
- 当前能用什么
- 哪些 MCP 连上了
- 当前是啥权限模式
- 当前 agent / skill / plugin 面是什么

这是一种很强的“能力声明帧”。

### 4.3 工具调用链路已经验证

在同一轮 `stream-json` 中，能完整看到：

1. `system/init`
2. `stream_event.message_start`
3. `stream_event.content_block_start`，内容块类型是 `tool_use`
4. 一串 `input_json_delta`
5. 一条正式 assistant message，内容是 `tool_use`
6. 一条 user message，内容是 `tool_result`
7. 新一轮 assistant text
8. 最后一条 `result`

也就是：

```text
init
-> assistant(tool_use)
-> tool_result
-> assistant(读完工具结果后的自然语言)
-> result
```

这说明 Claude Code 并不是“工具一调完就结束”，而是明确把工具结果重新回灌为会话消息，再让模型继续思考并产出最终答复。

这正是我们现在反复踩到的点：
- 不能只把工具结果当副作用
- 必须把工具结果重新送回模型回合
- 否则就会停在 JSON、空对象、或卡在工具调用之后

### 4.4 `result` 是回合级总结事件

最后一条 `result` 包含：
- `subtype=success`
- `duration_ms`
- `num_turns`
- `result`
- `stop_reason`
- `session_id`
- `total_cost_usd`
- `usage`
- `modelUsage`

说明：
- Claude Code 不把“最后一条 assistant 文本”直接当成回合结束协议
- 它还有一层 runtime 自己的回合收口事件

对我们启发很大：
- `assistant message` 和 `turn result` 应该是两个层级
- UI 可以用 `turn result` 判定“这轮完成/失败/花费/停因”
- 而不是只盯着模型最后一条文本

---

## 五、本地持久化不是只有一个会话文件

### 5.1 根目录结构

Claude Code 本地状态根目录：`/Users/noah/.claude`

确认存在：
- `settings.json`
- `settings.local.json`
- `config.json`
- `CLAUDE.md`
- `history.jsonl`
- `debug/`
- `sessions/`
- `projects/`
- `plans/`
- `todos/`
- `hooks/`
- `plugins/`
- `skills/`
- `shell-snapshots/`
- `session-env/`

结论：
- 它不是轻量“只看当前上下文”的 CLI
- 是一个有本地工作记忆、配置、计划、todo、hook、plugin 生命周期的 runtime

### 5.2 真正的会话正文在 `projects/<slug>/<sessionId>.jsonl`

例如：
- `~/.claude/projects/-private-tmp-claude-re/ec8995ce-9531-4640-88aa-3b4a6cae99c4.jsonl`
- `~/.claude/projects/-private-tmp-claude-re/0fb2207d-5bec-4df0-94ce-dcd25bfb7cdf.jsonl`

实验样本里已确认会写入：
- `queue-operation`
- `user`
- `assistant`
- `tool_result`
- `last-prompt`

而且 `tool_result` 不是藏起来的副文件，而是明确写进主 session jsonl：

- `assistant(tool_use)` 之后
- 会新增一条 `user` message
- 其 `content[0].type = tool_result`
- 同时有 `toolUseResult.stdout/stderr/...` 结构化字段

这说明 session jsonl 才是主事实源。

### 5.3 `subagents/` 和 `tool-results/` 是 sidecar，不一定每轮都有

在很多 session 下能看到：
- `subagents/`
- `tool-results/`

但在刚才的最小 Bash 实验里，只看到了主 `session.jsonl`，没有生成 `tool-results/` 目录。

结论：
- `tool-results/` 不是每轮必有
- 更像某些场景下的旁路缓存或扩展产物
- 不能把它当唯一事实源

这对我们很重要：
- 主事实源必须稳定且单一
- sidecar 目录只能做增强，不能承担主链路语义

### 5.4 Project Memory 是显式文件

已确认项目级记忆文件：
- `~/.claude/projects/-Users-noah-writing-ide/memory/MEMORY.md`

这不是模型上下文里的隐性摘要，而是可读、可编辑、持久化的项目记忆。

本机样本里甚至记录了：
- 某次 runtime tool exposure 重构
- 本地装了哪些 Claude Code 增强工具
- 对应来源链接

说明：
- Claude Code 允许“项目记忆”沉淀成显式资产
- 这跟会话摘要不是一回事
- 这也解释了为什么它能在不同 session 之间保留项目级长期上下文

### 5.5 Todos 与 Plans 是独立存储

已确认：
- todos：`~/.claude/todos/*.json`
- plans：`~/.claude/plans/*.md`

样本：
- todo 文件是按 session/agent 命名的 JSON
- plan 文件是独立 Markdown 文档

说明：
- “计划”和“对话”不是一份数据
- “todo”和“对话”也不是一份数据
- 运行时有独立任务状态层

这点和我们现在在补的 todo / waiting / resume 状态机高度同向。

---

## 六、配置、Hooks、Skills 都是一等能力

### 6.1 settings 结构骨架

本机配置只抽结构，不展示敏感值。

`~/.claude/settings.json` 结构可见：
- `env`
- `permissions.allow / deny`
- `hooks.PreToolUse / PostToolUse`
- `model`
- `skipDangerousModePermissionPrompt`

`~/.claude/settings.local.json`：
- `permissions.allow`

`~/.claude/config.json`：
- `primaryApiKey`

说明：
- env / permission / hook / model 都是正式配置面
- 不是某个 prompt 内嵌逻辑

### 6.2 Hooks 是真实可执行脚本

本机可见：
- `/Users/noah/.claude/hooks/scripts/config-protection.js`
- `/Users/noah/.claude/hooks/scripts/post-edit-typecheck.js`

这说明：
- tool 前后治理不是模型自觉
- 是 runtime 可执行 hook
- 比纯 prompt 约束更硬

### 6.3 Skills 是本地 markdown 资产

本机可见：
- `/Users/noah/.claude/skills/careful/SKILL.md`
- `/Users/noah/.claude/skills/freeze/SKILL.md`
- `/Users/noah/.claude/skills/unfreeze/SKILL.md`

同时从 `cli.js` 可以确认它会扫描：
- `commands`
- `agents`
- `output-styles`
- `skills`
- `workflows`

结论：
- skill 不是“聊天里提一嘴”的软提示
- 是 runtime 会扫描、注册、启用的正式资产类型
- 而且不仅 skill，workflow / output-style / agent 也是并列资产

---

## 七、MCP 生命周期和校验比我们想象得更硬

### 7.1 debug 日志证据

调试日志：`/tmp/claude-re/cc-debug.log`

可以看到：
- 启动期加载 MCP configs
- 每个 MCP server 单独连接
- 连接超时、能力协商、transport 类型都会记录
- 结束时会主动 `SIGINT`，失败再 `SIGTERM`

例如：
- `mcc-playwright` 连接成功并声明 `hasTools`
- `codex` 连接成功并声明 `hasTools/hasPrompts/hasResources`
- `mcc-reader / mcc-search` 因返回不符合 JSON-RPC 2.0 被 Zod 校验拦下

### 7.2 它对 HTTP MCP 响应做严格 schema 校验

错误样本清楚显示：
- 期待 `jsonrpc = "2.0"`
- 期待标准 `id / method / result / error`
- 非标准字段 `code / msg / success` 会被判为 `unrecognized_keys`

结论：
- Claude Code 的 MCP 接入层不是“能通就行”
- 它会强校验协议正确性
- 所以某些服务在我们系统里“能凑合用”，在它这里会直接失败

这也给我们一个提醒：
- MCP 兼容不是只接上 transport
- 必须把协议层收严，不然不同客户端行为会分裂

---

## 八、工具搜索与权限治理不是 prompt 内的小逻辑

### 8.1 Tool Search 有显式运行条件

debug 日志里明确出现：

- 当 `ANTHROPIC_BASE_URL` 不是 Anthropic first-party host 时
- `ToolSearch:optimistic` 默认禁用
- 需要显式 `ENABLE_TOOL_SEARCH=true`

说明：
- 工具发现不是无条件开启
- 它跟 provider / proxy / transport 能力绑定
- 这是一层 runtime 策略

### 8.2 权限模式是全局上下文，不是单次 tool 选项

证据来源：
- `--permission-mode` 参数面
- `system/init.permissionMode`
- `session.jsonl` 中的 `permissionMode`
- `cli.js` 中围绕 mode 的大量逻辑

说明：
- permission mode 会影响整个回合和整个 session
- 而不是“这次点一下确认”那么简单

---

## 九、对我们最有价值的启发

### 9.1 先做统一 runtime 协议，再做端点适配

Claude Code 最值得借的，不是 prompt，而是它对外先统一协议。

建议我们坚持：
- 内部只有一种 turn 事件流
- messages / responses / openai-compatible 只是输入输出适配层
- UI 不直接理解 provider 原生事件
- UI 只理解我们自己的统一事件

### 9.2 每轮开头先发“能力声明帧”

Claude Code 的 `system/init` 很值得抄。

我们也应该在每轮开始时，把这些事实显式发出来：
- 当前 session / thread / cwd
- 当前可用工具
- 当前已连接 MCP server
- 当前 skill / subagent 面
- 当前 permission / opMode
- 当前 provider / model

这样上层就不会靠猜。

### 9.3 工具结果必须回灌为会话消息，再继续思考

这次最关键的动态证据就是这一条。

正确链路应当是：

```text
assistant(tool_call)
-> runtime 执行工具
-> tool_result 回灌为消息
-> assistant 继续思考并产出最终答复
-> turn_result 收口
```

不是：

```text
assistant(tool_call)
-> 工具执行
-> 直接结束
```

否则就会出现：
- 只回 JSON
- 回空 `{}`
- 卡在工具后面
- 不会读工具结果

### 9.4 Session / Todo / Plan / Memory 要拆开存

Claude Code 的状态拆分是对的：
- session：对话事实流
- memory：长期项目事实
- todos：可变任务清单
- plans：计划文档
- subagents/tool-results：旁路产物

这比分别往一个 conversation blob 里塞要稳得多。

### 9.5 hooks / skills / MCP 应该都是注册表里的正式公民

Claude Code 的现实做法不是“全都 prompt 注入”，而是：
- 有配置面
- 有扫描加载
- 有生命周期
- 有调试日志
- 有落盘痕迹

这意味着我们也应该避免：
- skill 只存在于 prompt 语义里
- MCP 只在某个 provider adapter 临时拼接
- hook 只靠 if/else 写死

正确方向仍然是：
- registry
- contract
- lifecycle
- eventing

### 9.6 主事实源要单一，sidecar 目录只做增强

Claude Code 里：
- `session.jsonl` 是主事实源
- `tool-results/` 不是每轮必有

我们也要避免把任何“有时会生成的旁路文件”当主语义来源。

---

## 十、对我们当前系统的直接对标建议

### A. 优先补的不是 prompt，而是 runtime 主链路

优先级建议：

1. 统一 turn 事件协议
2. 首帧 capability/init
3. tool_result 回灌再推理
4. turn_result 收口
5. session / todo / memory / plan 分层落盘
6. tool / skill / mcp / subagent registry 化

### B. 不要把“工具会不会调”只归因到模型

Claude Code 的做法已经说明：
- 工具选择问题，很多时候不是模型笨
- 而是能力声明、权限模式、可见工具面、MCP 状态、hook 约束、系统指令一起决定的

所以后面我们排查“为什么它没调工具 / 调错工具 / 把 JSON 当文本吐出来”，要优先看：
- 本轮 init 里声明了什么
- 这轮到底有没有 tool result 回灌
- turn result 有没有收口
- adapter 有没有把 provider 原生事件正确翻译到统一协议

### C. 我们未来做多端点兼容时，最好沿这个顺序

1. 单核心 runtime
2. 统一事件协议
3. 统一 tool registry
4. 统一 tool result 回灌
5. messages adapter
6. responses adapter
7. openai-compatible adapter

不要反过来先修三个 adapter。

---

## 十一、这次已经确认的证据清单

源码与包：
- `/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`
- `/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code/README.md`
- `/Users/noah/.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json`

本地状态：
- `/Users/noah/.claude/settings.json`
- `/Users/noah/.claude/settings.local.json`
- `/Users/noah/.claude/config.json`
- `/Users/noah/.claude/projects/-Users-noah-writing-ide/memory/MEMORY.md`
- `/Users/noah/.claude/todos/`
- `/Users/noah/.claude/plans/`

动态样本：
- `/tmp/claude-re/cc-debug.log`
- `/tmp/claude-re/cc-tool.log`
- `/Users/noah/.claude/projects/-private-tmp-claude-re/ec8995ce-9531-4640-88aa-3b4a6cae99c4.jsonl`
- `/Users/noah/.claude/projects/-private-tmp-claude-re/0fb2207d-5bec-4df0-94ce-dcd25bfb7cdf.jsonl`

---

## 十二、后续如果还要继续挖，建议顺序

### 12.1 静态继续挖

重点搜这些关键词：
- `TaskOutput`
- `AskUserQuestion`
- `EnterPlanMode`
- `ExitPlanMode`
- `tool_result`
- `subagent`
- `workflows`
- `output-styles`
- `session persistence`

目标：
- 把它的 plan / ask-user / subagent runtime 再拆得更清楚一点

### 12.2 动态继续挖

建议再做 3 个实验：
- `Plan` agent 最小实验
- 含 subagent 的最小实验
- 含 MCP tool 的最小实验

目标：
- 看 `parent_tool_use_id`
- 看 subagent 是否独立事件流
- 看 MCP tool 的 tool_result 是否和内建 Bash 一致

### 12.3 对标我们自己的 runtime

最推荐的下一步不是继续“看 Claude prompt”，而是直接做一篇对标文档：

建议文件：
- `docs/research/claude-code-runtime-parity-v1.md`

建议结构：
- 我们现状
- Claude Code 实际机制
- 差距
- Phase 计划
- 验收项

---

## 最后一句话总结

Claude Code 真正值得借的不是某句 system prompt，而是这套范式：

**动态能力注入 + 统一事件协议 + 工具结果回灌 + 多层本地状态持久化 + hooks/skills/MCP 一等化。**

这套东西比“换模型”“补 prompt”“修单个 tool schema”更接近根因。
