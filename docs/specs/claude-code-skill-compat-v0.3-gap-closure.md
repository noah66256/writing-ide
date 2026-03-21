# Claude Code Skill Compatibility v0.3 Gap Closure

> 状态：P0 / P1 / P2 已实施并完成 build + smoke，hooks 仍保留 subset 边界  
> 日期：2026-03-21  
> 基线 HEAD：`5b8e1ab9596acd76b23e653f395717ec8548afb6`  
> 前置文档：
> - `docs/specs/claude-code-skill-compat-v0.2.md`
> - `docs/research/claude-code-skill-format-gap-analysis-2026-03-20.md`
> - `docs/research/claude-code-skill-native-compat-plan-2026-03-20.md`

## 实施状态（2026-03-21）

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|----------|----------|------|------|------|
| Fix 1（P0）`allowed-tools` 字符串格式兼容 | `apps/desktop/electron/skill-loader.mjs` / `splitAllowedToolsText`、`normalizeAllowedTools` | 已实现 | 临时 skill loader smoke 通过 | 保持数组格式完全兼容，支持括号内逗号 |
| Fix 2（P0）`effort / compatibility / metadata` passthrough | `packages/agent-core/src/skills.ts`、`apps/desktop/electron/skill-loader.mjs`、`apps/gateway/src/agent/serverToolRunner.ts` | 已实现 | `@ohmycrab/agent-core build`、`@ohmycrab/gateway build`、`skills.activate` smoke 通过 | 先按 string/object 透传，不做强消费 |
| Fix 3（P0）`${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` | `apps/gateway/src/agent/portableSkillCompat.ts`、`apps/gateway/src/agent/runFactory.ts`、`apps/gateway/src/agent/serverToolRunner.ts`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts`、`apps/gateway/src/agent/writingAgentRunner.ts` | 已实现 | helper smoke、`skills.activate` smoke、gateway build 通过 | 变量缺失时替换为空串；保留既有 `$0/$1/$ARGUMENTS` 语义 |
| Fix 4（P1）`!` 命令预处理 | `apps/gateway/src/agent/portableSkillCompat.ts`、`apps/gateway/src/agent/runFactory.ts`、`apps/desktop/src/agent/toolRegistry.ts` | 已实现 | `@ohmycrab/gateway build`、`@ohmycrab/desktop build`、portable helper smoke、gateway integration smoke 通过 | Desktop 本地预处理工具已接入审计链路；完整 Desktop live run 手工冒烟仍待补 |
| Fix 5（P1）真实 `context: fork` | `apps/gateway/src/agent/runFactory.ts`、`apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`、`apps/gateway/src/agent/writingAgentRunner.ts`、`apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 已实现 | `@ohmycrab/gateway build`、`@ohmycrab/desktop build`、gateway integration smoke 通过 | 主 run 已改为真实 child run 分支；clean-room 走子 run，不再回退为主 prompt 近似 fork；完整 Desktop live session smoke 待补 |
| Fix 6（P1）外部 `.claude/agents` 自定义 agent | `apps/desktop/electron/agent-loader.mjs`、`apps/desktop/electron/main.cjs`、`apps/desktop/electron/preload.cjs`、`apps/desktop/src/agent/wsTransport.ts`、`apps/gateway/src/agent/portableSkillCompat.ts`、`apps/gateway/src/agent/serverToolRunner.ts` | 已实现 | `@ohmycrab/gateway build`、`@ohmycrab/desktop build`、临时 `.claude/agents/custom-agent.md` smoke、gateway integration smoke 通过 | Desktop 会随 run.request 下发外部 agent 定义；Gateway 解析和 portable skill agent 解析已接通 |
| Fix 7（P2）hooks parity 扩展 | `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 已实现（subset） | `@ohmycrab/gateway build`、`@ohmycrab/desktop build`、hook event matrix smoke、`PermissionRequest` deny/allow smoke 通过 | 已补 `Notification` / `PermissionRequest` / `PreCompact` / `PostCompact`；不承诺 async/background hooks 与全量 compact parity |

> 说明：下文的 gap/方案章节保留了立项时的原始分析；当前是否已实现，请以本节“实施状态”和“验证记录”为准。

## 验证记录（2026-03-21）

- 代码级：
  - `npm run -w @ohmycrab/agent-core build` 通过
  - `npm run -w @ohmycrab/gateway build` 通过
  - `npm run -w @ohmycrab/desktop build` 通过
- 行为级：
  - 使用临时 `SKILL.md` 做 loader smoke，确认 `allowed-tools: Read, Bash(python -m foo,bar), Task(worker)` 与数组写法解析结果一致
  - 同一组临时 skill 通过 `skills.activate` 验证 `effort / compatibility / metadata` 会完整透传到返回体
  - helper + `skills.activate` 渲染都验证了 `${CLAUDE_SESSION_ID}`、`${CLAUDE_SKILL_DIR}` 会落成实际值
  - 使用临时项目 `.claude/agents/custom-agent.md` 验证外部 agent loader 会解析 frontmatter + body，并把 `Read, Bash(pwd), Write` 归一化成 `read/shell.exec/write`
  - helper smoke 验证 `extractPortableCommandSubstitutions` 会提取 `!`<command>``，`renderPortableSkillPromptTemplate` 会保留命令占位并正确渲染 `${CLAUDE_*}` 变量
  - hook parity smoke：
    - patched `GatewayRuntime._executePortableHookHandler` 验证 `Notification` 会在 `ProviderRuntimeCapabilities` / `KernelInputProfile` notice 上触发
    - `PermissionRequest` deny smoke 验证 `ASSISTANT_MODE_REQUIRED` 路径会发 hook，且 hook 可追加 deny message
    - `PermissionRequest` allow smoke 验证被允许的 `project.listFiles` shadow dry-run 不会额外触发 permission hook
    - compact smoke 验证工具结果 envelope 压缩路径会依次触发 `PreCompact` / `PostCompact`
  - gateway integration smoke：
    - 构造一个带 `context: fork`、`agent: custom-agent`、`!`<pwd>`` 的临时 portable skill
    - 通过 `prepareAgentRun -> executeAgentRun`，用 `portable.skill.preprocess` 的 waiter 回放本地预处理结果，再用 patched `SubAgentExecutionBridge.execute` 截获 child run
    - 确认主 run 发出 `run.execution.mode=portable_skill_fork`，child run 以 clean-room 选项启动，且拿到的 task 已包含替换后的预处理文本与外部 agent definitionOverride
- 兼容备注：
  - 当前仍沿用既有参数下标语义：`$0` 是第一个参数，`$1` 是第二个参数；本轮未改变这条旧合同
  - 当前 `Notification` 先覆盖 GatewayRuntime 内已接管的 runtime notices；未尝试把所有 `run.notice` 全量代理成 portable hook
  - 当前 `PreCompact` / `PostCompact` 先覆盖工具结果 envelope 压缩路径；未引入独立 async/background compact service
  - 当前已完成代码级闭环、loader/helper smoke、hook smoke 和 gateway integration smoke；尚未补完整 Desktop live session 手工冒烟

## 零、已有上下文索引

- 已有实现态文档：
  - `docs/specs/claude-code-skill-compat-v0.2.md`
  - 结论偏乐观，当前写法更接近“P0/P1 已无功能缺口”
- 已有研究：
  - `docs/research/claude-code-skill-format-gap-analysis-2026-03-20.md`
  - `docs/research/claude-code-skill-native-compat-plan-2026-03-20.md`
- 近期相关 commit：
  - `ee238f1 feat: add claude skill compatibility v0.1`
  - `3a7096c feat: add thread-first capability exposure`
  - 当前 HEAD：`5b8e1ab fix(gateway): tighten delete routing recovery`
- 当前代码已完成能力：
  - portable skill 目录发现与 `portableRuntime`
  - `allowed-tools` alias + specifier hard gate
  - clean-room `context: fork` 提示式隔离
  - hooks lifecycle 的基础 runtime
  - `skills.list` / `skills.activate` 动态激活
- 本轮新发现的真实剩余缺口：
  - `allowed-tools` 仍只兼容数组，不兼容官方常用的逗号分隔字符串
  - 未支持 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`、`!` 命令预处理
  - `context: fork` 仍不是官方意义上的真实 forked subagent
  - `agent:` 仍只映射内置 sub-agent，不支持 Claude 风格自定义 agent
  - hooks 事件与输入/返回语义仍是子集
  - frontmatter 仍未接 `effort`、`compatibility`、`metadata`

---

## 一、需求概述

### 需求卡片

- 场景：继续对齐 Anthropic 官方技能文档与上游仓库，盘清 Crab 还没做到的兼容点，并落下一份新的实施 spec。
- 目标：把“真正会影响 Claude Code skill 拿过来直接用”的剩余 gap 收敛成可实施方案，避免 `v0.2` 文档高估完成度。
- 对标：
  - Anthropic 官方 Claude Code skills 文档
  - Anthropic 官方 Claude Code hooks 文档
  - Anthropic `skills` 仓库
  - Agent Skills Specification
- 约束：
  - 不推翻现有 `portableRuntime + skills.list/activate + GatewayRuntime` 主线
  - 不碰无关脏文件
  - 方案必须契合当前 Desktop 本地执行 / Gateway 编排架构
- 不做什么：
  - 这轮不做 enterprise skill 分发、plugin marketplace 安装体系
  - 不承诺 Claude 内部 `Skill(...)` 原生工具 1:1 等价
  - 不承诺 hooks async/background service 与 Claude Code 完整一致

### 结论先行

`v0.2` 已经把“可发现、可显式调用、可动态激活”的主链做出来了，但对照官方最新文档后，仍有 4 个会影响“开箱即用”的真实剩余项：

1. `allowed-tools` 输入格式不完整
2. skill 正文缺少 Claude 变量/命令预处理
3. `context: fork` 不是官方意义上的真实 subagent fork
4. `agent:` 不支持外部自定义 agent

此外还有 2 类偏“规格补齐”的后续项：

1. hooks 事件、输入和返回语义仍是子集
2. frontmatter 仍缺 `effort`、`compatibility`、`metadata`

---

## 二、现状地图

### 相关文件

| 文件 | 职责 | 与本次需求关系 |
|------|------|----------------|
| `apps/desktop/electron/skill-loader.mjs` | 扫描 `SKILL.md`，解析 frontmatter，决定 scan roots 与 precedence | `allowed-tools` 格式、frontmatter 字段、scan scope、precedence 都在这里起点 |
| `packages/agent-core/src/skills.ts` | `SkillManifest` 合同定义 | 缺 `effort` / `compatibility` / `metadata` |
| `apps/gateway/src/agent/portableSkillCompat.ts` | portable skill 参数渲染、路径重写、`allowed-tools` 规则解析、agent 映射 | 缺 `${CLAUDE_*}` / `!` 预处理；`agent` 仍只映射内置 |
| `apps/gateway/src/agent/runFactory.ts` | 显式 slash skill 注入、portable fork plan、prepared messages | `context: fork` 当前仍是“主 run 提示式近似 fork” |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | runtime hooks、dynamic activation、tool gating | hooks 事件仍是子集；缺更多官方语义 |
| `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts` | 子 agent 执行桥 | 当前只支持内置 sub-agent 定义，未接外部 Claude agent |
| `apps/gateway/src/agent/serverToolRunner.ts` | `skills.list` / `skills.activate` gateway 合同 | 后续若补 `effort` / 变量上下文 / fork runtime，这里也要同步 |
| `packages/tools/src/index.ts` | tool registry | 当前已有 `skills.list` / `skills.activate`，无需另起平行机制 |

### 已有设施

- 已有 portable skill 发现链路：`~/.claude/skills`、`~/.agents/skills`、项目级 `.claude/skills` / `.agents/skills`
- 已有 scope-aware dedupe 与 active skill prompt 注入
- 已有 `skills.list` / `skills.activate` 动态激活
- 已有 clean-room 历史上下文清空
- 已有 hooks `command/http/prompt/agent` handler 骨架
- 已有 SubAgentExecutionBridge，可复用作真实 fork runtime 的底座

### 约束点

- 现有 scan roots 只来源于 `primaryRoot + projectRoots`，没有 nested ancestor / add-dir / enterprise / plugin 层，见 `apps/desktop/electron/skill-loader.mjs#buildScanRoots`，HEAD `5b8e1ab`，当前行 `142-148`
- 现有 precedence 是 `project > home > userData`，与官方 personal > project 语义冲突，见 `apps/desktop/electron/skill-loader.mjs#getScanRootPrecedence`，HEAD `5b8e1ab`，当前行 `151-168`
- 现有 `allowed-tools` 只接受数组，见 `apps/desktop/electron/skill-loader.mjs#normalizeAllowedTools`，HEAD `5b8e1ab`，当前行 `208-210`
- 现有 `context: fork` 仍在主 run 构建提示式 fork，见 `apps/gateway/src/agent/runFactory.ts#portableForkPlan`，HEAD `5b8e1ab`，当前行 `2694-2754`
- 现有 hooks 事件枚举只有 9 个，见 `apps/gateway/src/agent/runtime/GatewayRuntime.ts#PortableHookEventName`，HEAD `5b8e1ab`，当前行 `138-147`
- 现有 sub-agent 来源只有 `BUILTIN_SUB_AGENTS`，未见外部 `.claude/agents` loader，见 `apps/gateway/src/agent/portableSkillCompat.ts#resolvePortableSkillAgent`，HEAD `5b8e1ab`，当前行 `463-484`

### 最自然的扩展点

- parser / frontmatter：继续在 `skill-loader.mjs` 增量补齐
- portable 渲染语义：继续集中在 `portableSkillCompat.ts`
- 真实 fork runtime：复用 `SubAgentExecutionBridge.ts`
- hooks 扩展：继续收敛在 `GatewayRuntime.ts`

---

## 三、外部调研摘要

### 一手来源

- [Anthropic Claude Code 自定义技能文档](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- [Anthropic Claude Code Hooks 文档](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Anthropic 官方 `skills` 仓库](https://github.com/anthropics/skills)
- [Agent Skills Specification](https://agentskills.io/specification)

### 对标/上游证据

- Anthropic 官方 skills 文档：
  - skills 支持 project / personal / additional directories / nested discovery
  - frontmatter 明确包含 `allowed-tools`、`argument-hint`、`model`、`effort`、`context`、`agent`
  - skill 正文支持 `${CLAUDE_SESSION_ID}`、`${CLAUDE_SKILL_DIR}`
  - 支持 `!`<command>`` 预处理，把命令输出嵌进 prompt
  - `context: fork` 明确是“在 subagent 中运行、无会话历史”
- Anthropic 官方 hooks 文档：
  - skill-scoped hooks 是原生能力
  - 事件不仅有 `PreToolUse/PostToolUse`，还有 `Notification`、`PermissionRequest`、`PreCompact`、`SessionStart/End` 等
  - hooks 支持更完整的输入字段、返回语义与 async 模式
- Agent Skills Specification：
  - 标准层有 `compatibility`、`metadata`
  - Claude 扩展不应靠私有 manifest 字段吞掉

### 当前实现与上游差异

1. **发现层**
   - 我们已经有 `~/.claude/skills` / `.claude/skills`
   - 但没有 additional directories、nested ancestor、enterprise/plugin scope
2. **frontmatter 层**
   - 我们已接 `argumentHint/allowedTools/model/context/agent/hooks/inputSchema`
   - 但未接 `effort`、`compatibility`、`metadata`
3. **prompt/render 层**
   - 我们已接 `$ARGUMENTS[n]` / `$0..$n`
   - 但未接 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` / `!` 预处理
4. **fork / agent 层**
   - 我们做的是 clean-room 提示式 fork
   - 上游要求的是“真实 forked subagent”
   - 我们只支持内置 agent，未支持 `.claude/agents`
5. **hooks 层**
   - 我们已有 lifecycle 子集
   - 上游 hooks 事件与 permission 语义更完整

### 结论

- 推荐模式：
  - 继续沿用现有 `loader -> manifest -> portableSkillCompat -> runFactory/GatewayRuntime` 主线
  - 用增量补齐方式做 `v0.3`，不要另造第二套 skill runtime
- 放弃模式：
  - 不建议重写成“只做 prompt 注入、不做 runtime 语义”的轻方案
  - 不建议为了补 `!` 预处理，把本机命令执行偷偷搬进 Gateway 远端进程

---

## 四、方案收敛

### 推荐方案

按 3 个 phase 收口：

1. **Phase A / P0：Parser + Prompt Preprocess Parity**
   - 补 `allowed-tools` 字符串格式
   - 补 `effort` / `compatibility` / `metadata`
   - 补 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`
2. **Phase B / P1：Discovery + Fork Runtime Parity**
   - 扫描 additional roots / nested ancestor
   - precedence 调整为更接近官方 personal > project 语义
   - `context: fork` 收敛成真实 forked subagent
   - `agent:` 接上外部 Claude agent 解析
3. **Phase C / P2：Hooks Parity**
   - 扩 hooks 事件、input/output 语义
   - 评估 async/background hooks 能否在当前架构下安全落地

### 备选方案

只做 P0 parser 修补：

- 优点：改动小，风险低，能快速修一部分官方 skill
- 缺点：
  - `context: fork` 与 `agent:` 仍不是真兼容
  - hooks 文档仍然对不上
  - 用户依然会遇到“skill 被识别了，但执行语义还是和 Claude 不一样”

### 为什么推荐方案更契合当前框架

- loader、prompt render、runtime hooks、subagent bridge 都已经存在，不需要重开新系统
- `SubAgentExecutionBridge` 已能执行子 run，最适合作为真实 fork runtime 底座
- `skills.list` / `skills.activate` 已经具备模型侧动态激活能力，不需要再补一套平行的 `Skill` tool

### 连锁反应与风险

- precedence 语义调整会改变同名 skill 冲突时的 winner，可能影响现有 Crab 用户
- `!` 预处理涉及本机命令执行边界，必须走 Desktop 本地执行与审计，不可在 Gateway 偷跑
- 真实 fork runtime 会影响 thread state / waiting / activeSkills / telemetry 记账
- 外部 agent loader 会触及 sub-agent 定义合同与 UI 呈现

---

## 五、改动点清单

## Fix 1（P0）：补 `allowed-tools` 字符串格式兼容

- 文件：
  - `apps/desktop/electron/skill-loader.mjs`
- 符号：
  - `normalizeAllowedTools`
  - `buildManifestInputFromFrontmatter`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/desktop/electron/skill-loader.mjs:208-210`
  - `apps/desktop/electron/skill-loader.mjs:289-312`
- 改动原理：
  - 当前只接受数组，官方文档与大量社区 skill 直接写逗号分隔字符串
  - 需要把 string/array 统一规范化为 `string[]`
  - 解析时要支持括号里的逗号，不可简单 `split(",")`

### unified diff（草案）

```diff
*** Update File: apps/desktop/electron/skill-loader.mjs
@@
-function normalizeAllowedTools(raw) {
-  return Array.isArray(raw) ? raw.map((x) => norm(x)).filter(Boolean).slice(0, 100) : [];
-}
+function splitAllowedToolsText(text) {
+  const out = [];
+  let current = "";
+  let depth = 0;
+  for (const ch of String(text ?? "")) {
+    if (ch === "(") depth += 1;
+    if (ch === ")") depth = Math.max(0, depth - 1);
+    if (ch === "," && depth === 0) {
+      if (norm(current)) out.push(norm(current));
+      current = "";
+      continue;
+    }
+    current += ch;
+  }
+  if (norm(current)) out.push(norm(current));
+  return out;
+}
+
+function normalizeAllowedTools(raw) {
+  if (Array.isArray(raw)) return raw.map((x) => norm(x)).filter(Boolean).slice(0, 100);
+  const text = norm(raw);
+  if (!text) return [];
+  return splitAllowedToolsText(text).slice(0, 100);
+}
```

### 边界情况

- `Bash(python -m foo,bar)` 不能被错误拆成两条
- 空字符串、`null`、空数组仍应回到 `[]`
- 旧数组形式必须完全兼容

### 验证方式

- loader smoke：
  - `allowed-tools: Read, Bash(python *)`
  - `allowed-tools: [Read, Bash(python *)]`
  - 二者解析结果应完全一致

---

## Fix 2（P0）：补 `effort` / `compatibility` / `metadata` frontmatter passthrough

- 文件：
  - `packages/agent-core/src/skills.ts`
  - `apps/desktop/electron/skill-loader.mjs`
  - `apps/gateway/src/agent/serverToolRunner.ts`
- 符号：
  - `SkillManifest`
  - `parseManifest`
  - `executeSkillsActivateOnGateway`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `packages/agent-core/src/skills.ts:92-105`
  - `apps/desktop/electron/skill-loader.mjs:475-483`
  - `apps/gateway/src/agent/serverToolRunner.ts:1013-1087`
- 改动原理：
  - 这 3 个字段属于“标准/扩展协议保真”，不该被 loader 吞掉
  - 即便本轮暂不强消费，也应在 manifest 和 `skills.activate` 输出里完整保留

### unified diff（草案）

```diff
*** Update File: packages/agent-core/src/skills.ts
@@
   license?: string;
   argumentHint?: string;
+  effort?: string;
   disableModelInvocation?: boolean;
   userInvocable?: boolean;
   allowedTools?: string[];
   model?: string;
   context?: PortableSkillContextMode | string;
   agent?: string;
   hooks?: unknown;
   inputSchema?: unknown;
+  compatibility?: Record<string, unknown>;
+  metadata?: Record<string, unknown>;
   vendorMetadata?: Record<string, unknown>;
```

```diff
*** Update File: apps/desktop/electron/skill-loader.mjs
@@
+  const effort = norm(raw.effort) || undefined;
   const hooks = raw.hooks !== undefined ? raw.hooks : undefined;
   const inputSchema = raw.inputSchema !== undefined ? raw.inputSchema : undefined;
+  const compatibility = isObj(raw.compatibility) ? raw.compatibility : undefined;
+  const metadata = isObj(raw.metadata) ? raw.metadata : undefined;
@@
+    ...(effort ? { effort } : {}),
     ...(hooks !== undefined ? { hooks } : {}),
     ...(inputSchema !== undefined ? { inputSchema } : {}),
+    ...(compatibility ? { compatibility } : {}),
+    ...(metadata ? { metadata } : {}),
```

### 边界情况

- 不对 `effort` 提前做强枚举，先按 string passthrough
- `compatibility` / `metadata` 仅接受对象，避免把任意结构塞进 manifest

### 验证方式

- loader smoke：字段应进入 `SkillManifest`
- `skills.activate` smoke：返回体应能看到这几个字段

---

## Fix 3（P0）：补 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` 渲染上下文

- 文件：
  - `apps/gateway/src/agent/portableSkillCompat.ts`
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/gateway/src/agent/serverToolRunner.ts`
- 符号：
  - `renderPortableSkillPromptTemplate`
  - `buildPortableSkillActivationInstructions`
  - `executeSkillsActivateOnGateway`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/gateway/src/agent/portableSkillCompat.ts:200-227`
  - `apps/gateway/src/agent/portableSkillCompat.ts:230-246`
  - `apps/gateway/src/agent/serverToolRunner.ts:1032-1087`
  - `apps/gateway/src/agent/runFactory.ts:2727-2754`
- 改动原理：
  - 当前只支持 `$ARGUMENTS` / `$n`
  - 官方文档要求 skill 正文可直接引用 session id 与 skill 目录
  - 这属于低风险高收益的 parser/runtime 上下文补齐

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/portableSkillCompat.ts
@@
-export function renderPortableSkillPromptTemplate(text: string, args?: string) {
+export function renderPortableSkillPromptTemplate(
+  text: string,
+  args?: string,
+  runtime?: { sessionId?: string; skillDir?: string },
+) {
@@
   const rendered = raw
@@
     .replace(/\$ARGUMENTS\b/g, () => {
       usedPlaceholder = true;
       return value;
-    });
+    })
+    .replace(/\$\{CLAUDE_SESSION_ID\}/g, String(runtime?.sessionId ?? ""))
+    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, String(runtime?.skillDir ?? ""));
```

### 边界情况

- 变量值缺失时替换为空串，不应保留裸占位符
- 只支持文档明确的 Claude 变量，不引入任意环境变量插值

### 验证方式

- helper smoke：渲染后应出现 runId 和 portable skill root

---

## Fix 4（P1）：设计并接入 `!`<command>`` 本地预处理

- 文件：
  - `apps/gateway/src/agent/portableSkillCompat.ts`
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/desktop/src/agent/wsTransport.ts`
  - `apps/desktop/electron/preload.cjs` 或等价 IPC 桥
- 符号：
  - 新增 `preprocessPortableSkillCommandSubstitutions`
  - run start 前的 portable render pipeline
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/gateway/src/agent/portableSkillCompat.ts:207-246`
  - `apps/gateway/src/agent/runFactory.ts:2727-2754`
- 改动原理：
  - 官方文档支持在 skill 正文中用 `!`<command>`` 注入命令输出
  - 这不是单纯字符串替换，而是本机执行边界问题
  - 必须通过 Desktop 本地执行并审计，不能在 Gateway 偷跑

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/portableSkillCompat.ts
@@
+export type PortablePreprocessRequest = {
+  skillId: string;
+  skillDir: string;
+  sessionId: string;
+  command: string;
+};
+
+export function extractPortableCommandSubstitutions(text: string): PortablePreprocessRequest[] { ... }
```

```diff
*** Update File: apps/gateway/src/agent/runFactory.ts
@@
-  const primaryPortableRenderedPrompt = portableForkPlan
-    ? rewritePortableSkillRelativePaths(renderPortableSkillPromptTemplate(...), portableForkPlan.manifest)
-    : "";
+  const primaryPortableRenderedPrompt = portableForkPlan
+    ? await renderPortableSkillPromptWithDesktopPreprocess({
+        manifest: portableForkPlan.manifest,
+        rawArguments: portableForkPlan.invocation?.arguments,
+        runId,
+        opMode,
+      })
+    : "";
```

### 边界情况

- 仅在 Desktop 本地可执行
- 必须受 `allowed-tools` / `opMode` / 审计约束
- 命令超时、失败时需把 stderr 显式注入而不是静默吞掉

### 验证方式

- e2e smoke：
  - skill 正文含 `!`<pwd>``
  - 渲染结果应替换成当前本地目录
  - 事件流里应有可审计记录

---

## Fix 5（P1）：把 `context: fork` 从提示式近似实现改为真实 forked subagent

- 文件：
  - `apps/gateway/src/agent/runFactory.ts`
  - `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
  - `apps/gateway/src/agent/portableSkillCompat.ts`
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
- 符号：
  - `portableForkPlan`
  - `buildPortableForkUserPrompt`
  - `SubAgentExecutionBridge.execute`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/gateway/src/agent/runFactory.ts:2694-2754`
  - `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts:400-419`
- 改动原理：
  - 当前 clean-room 只是在主 run 里改 system/user prompt
  - 官方语义要求在隔离 subagent 中执行，且不带会话历史
  - 应复用现有 `SubAgentExecutionBridge`，为 portable fork 生成合成 subagent task，而不是继续留在主 run

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/runFactory.ts
@@
-  const portableForkSystemPrompt = portableForkPlan ? [...] : "";
-  const portableForkRunPrompt = portableForkPlan ? buildPortableForkUserPrompt(...) : "";
+  const portableForkTask = portableForkPlan
+    ? buildPortableForkTask({
+        runId,
+        skillId: portableForkPlan.skillId,
+        renderedPrompt: primaryPortableRenderedPrompt,
+        parsedInputState: primaryPortableInputState,
+      })
+    : null;
```

```diff
*** Update File: apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts
@@
+  async executePortableFork(task: PortableForkTask, options?: ...) {
+    // 不继承 parentCtx 的 recent dialogue / mainDoc / memories
+    // 仅继承 projectDir、allowed tools、portable skill contract
+  }
```

### 边界情况

- thread state 仍要感知 skill 已激活，但正文执行落到子 run
- 需要避免 parent run 与 child run 双重输出同一份合同
- 若 fork task 失败，要把失败显式回传主 run，而不是悄悄降级回 inline

### 验证方式

- smoke：
  - `context: fork` skill 应启动子 run，而不是只改主 run prompt
  - 子 run 不应继承父 run 的 `recentDialogue/mainDoc/L1/L2`

---

## Fix 6（P1/P2）：补 `agent:` 外部自定义 agent 解析

- 文件：
  - `apps/gateway/src/agent/portableSkillCompat.ts`
  - 新增 `apps/desktop/electron/agent-loader.mjs` 或复用现有 agent config loader
  - `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
- 符号：
  - `resolvePortableSkillAgent`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/gateway/src/agent/portableSkillCompat.ts:463-484`
- 改动原理：
  - 当前 `agent:` 只会命中 `BUILTIN_SUB_AGENTS`
  - Claude 文档允许 skill 绑定自定义 subagent
  - 需要先有一个外部 agent discovery / normalize 层，再接进 bridge

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/portableSkillCompat.ts
@@
-  const definition = BUILTIN_SUB_AGENTS.find((agent) => agent.id === alias);
+  const definition =
+    BUILTIN_SUB_AGENTS.find((agent) => agent.id === alias) ??
+    externalAgentRegistry.find((agent) => agent.id === alias || agent.name === requestedAgent);
```

### 边界情况

- 若外部 agent 不存在，应保持当前 best-effort fallback，而不是直接崩 run
- 外部 agent 的 tools / model / prompt 合同必须走统一 normalize

### 验证方式

- 在项目 `.claude/agents/` 放一个自定义 agent，被 `agent:` 命中后应正确拉起子 run

---

## Fix 7（P2）：扩 hooks 事件与 permission 语义

- 文件：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - `apps/gateway/src/agent/portableSkillCompat.ts`
- 符号：
  - `PortableHookEventName`
  - `_buildPortableHookInput`
  - `_runPortableHookEvent`
- HEAD：
  - `5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 当前行号：
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:138-147`
  - `apps/gateway/src/agent/runtime/GatewayRuntime.ts:1866-1898`
- 改动原理：
  - 当前 hooks 只覆盖 9 个事件，缺 `Notification`、`PermissionRequest`、`PreCompact` 等
  - 即便这不阻塞大多数官方 skill，也会让 hooks 文档对不上

### unified diff（草案）

```diff
*** Update File: apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@
 type PortableHookEventName =
   | "SessionStart"
   | "SessionEnd"
   | "UserPromptSubmit"
+  | "Notification"
+  | "PermissionRequest"
   | "PreToolUse"
   | "PostToolUse"
   | "PostToolUseFailure"
+  | "PreCompact"
+  | "PostCompact"
   | "Stop"
   | "SubagentStart"
   | "SubagentStop";
```

### 边界情况

- `PermissionRequest` 要和现有 Crab 硬门禁语义协调，不能制造双重决策冲突
- async hooks 若落不了地，必须明确降级，不要伪装成已支持

### 验证方式

- hook event matrix smoke
- `PermissionRequest` deny/allow smoke

### 实施回填（2026-03-21）

- 已在 `GatewayRuntime` 补齐 `PortableHookEventName` 的 `Notification`、`PermissionRequest`、`PreCompact`、`PostCompact`
- `_buildPortableHookInput` 已为新增事件补输入载荷：
  - `Notification`：`title/message/kind/detail`
  - `PermissionRequest`：`tool_name/tool_input/reason/message/decision_source/permission_request`
  - `PreCompact/PostCompact`：`tool_name/compact/tool_response`
- `PermissionRequest` 当前采用“观测现有硬门禁 + 可追加 deny 说明”的子集语义：
  - 已接到 `TOOL_NOT_ALLOWED_THIS_TURN`
  - 已接到 `PORTABLE_SKILL_HOOK_DENIED`
  - 已接到 `PORTABLE_SKILL_TOOL_POLICY_DENIED`
  - 已接到 `ASSISTANT_MODE_REQUIRED`
  - 已接到 `DELIVERY_LATCHED`
- `Notification` 当前先接到 GatewayRuntime 内显式受控的 runtime notices：
  - `ProviderRuntimeCapabilities`
  - `KernelInputProfile`
  - `MaxTurnsExceeded`
  - 各类 permission-denied notices
- `PreCompact/PostCompact` 当前先接到工具结果 `compactToolResultEnvelope(...)` 压缩点，不覆盖独立 async/background compact service

---

## 六、风险与连锁反应

### 兼容性风险

- precedence 若从 `project > home` 改为 `home > project`，会影响已有用户的同名覆盖习惯
- `!` 预处理一旦放错执行边界，会和“工具执行全在本地”原则冲突
- 真实 fork runtime 可能改变 thread waiting / run.done / todo 记账路径

### 性能风险

- nested roots / ancestor scan 若直接递归全盘，会拖慢 loader reload
- `!` 预处理与 hooks 扩展可能增加首轮延迟

### proposal-first / rollback 影响

- 这轮主要是 parser/runtime 兼容，不涉及业务数据结构迁移
- 最需要回滚预案的是 precedence 调整与 `!` 预处理

---

## 七、验证 Checklist

### 代码级验证

- `npm run -w @ohmycrab/agent-core build`
- `npm run -w @ohmycrab/gateway build`
- `npm run -w @ohmycrab/desktop build` 或等价类型检查

### 行为级验证

1. `allowed-tools` 数组 / 字符串双格式 smoke
2. `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` helper smoke
3. `!`<command>`` e2e 本地预处理 smoke
4. `context: fork` 子 run 隔离 smoke
5. 外部 `.claude/agents` 自定义 agent smoke
6. hooks event matrix smoke
7. Anthropic 官方 `skills` 仓库抽样：
   - `skill-creator`
   - `docx`
   - 至少 1 个依赖 `context: fork` / `agent:` / hooks 的 skill

### 文档对齐验证

- 落地后必须同步更新 `docs/specs/claude-code-skill-compat-v0.2.md`
- 把其中“P0/P1 已无功能缺口”的结论改成以 `v0.3` 为准的后续状态

---

## 八、回滚与兼容说明

- `allowed-tools` 格式扩展是纯增量兼容，可单独回滚
- `effort` / `compatibility` / `metadata` passthrough 是低风险增量字段，可单独回滚
- precedence 调整若引发已有用户行为变化，需支持 feature flag 或按 portable scope 单独开关
- `!` 预处理必须可整体关闭，建议单独挂开关
- 真实 fork runtime 若不稳定，应允许回退到当前 clean-room inline 模式

---

## 九、涉及文件清单

### 必改

- `apps/desktop/electron/skill-loader.mjs`
- `packages/agent-core/src/skills.ts`
- `apps/gateway/src/agent/portableSkillCompat.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`

### 大概率会改

- `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
- `apps/gateway/src/agent/serverToolRunner.ts`
- `packages/tools/src/index.ts`

### 可能新增

- `apps/desktop/electron/agent-loader.mjs`
- `apps/desktop/electron` 下的 skill preprocess IPC 桥

---

## 十、实施建议

推荐按这个顺序推进：

1. 先做 Fix 1 / Fix 2 / Fix 3
   - 成本低
   - 直接提升“官方 skill 原样导入可用率”
2. 再做 Fix 5
   - 这是当前最关键的运行时语义缺口
3. 然后做 Fix 6
   - 让 `agent:` 真正接入 Claude 风格自定义 agent
4. 最后做 Fix 4 / Fix 7
   - `!` 预处理与 hooks parity 都涉及更高风险执行边界

如果只能做一个最小闭环版本，优先级应是：

1. `allowed-tools` 字符串格式
2. `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}`
3. 真实 `context: fork`
