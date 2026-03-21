# Claude Code Skill Compatibility v0.2

> 状态：已被 `docs/specs/claude-code-skill-compat-v0.3-gap-closure.md` 取代；当前实现状态以 `v0.3` 为准  
> 日期：2026-03-21  
> 基线 HEAD：`5b8e1ab9596acd76b23e653f395717ec8548afb6`  
> 目标：在 `v0.1` 已上线的基础上，把兼容目标从“可发现、可加载、可显式调用”推进到“Anthropic 官方 `skills` 仓库中的大多数标准 skill 可以不改内容直接在 Crab 中使用”。

## 一、需求概述

### 需求卡片

- 场景：把 Anthropic / Claude Code skill 目录直接放进 Crab，希望尽量不用改内容即可使用。
- 目标：盘清现在已经实现了哪些兼容层、还差多少关键能力，并落一份后续实施 spec。
- 对标：Anthropic 官方 skills 仓库、Claude Code / Agent Skills 标准语义。
- 约束：这轮以 `v0.2` 兼容闭环为准，先把阻塞手动调用开箱即用的关键切片补到代码；文档必须同步回填，避免 spec 与实现脱节。
- 不做什么：这版仍不承诺完整 Claude Runtime parity；尤其不承诺 hook `prompt/agent` handler 与 Claude 原生子 agent 100% 等价，也不做执行时自动切换 portable skill cwd 的完整 runtime。

### 当前进度结论

结论：`v0.2` 最初定义的 3 个主阻塞点已经全部补齐；后续真实剩余 gap 与实施进度，请以 `v0.3` 顶部“实施状态/验证记录”为准。

1. **skill 根路径与相对资源解析**
   已补 `portableRuntime.skillDir / manifestPath / scanRoot`，active portable skill 的 `scripts/`、`references/`、`assets/` 会被重写成绝对路径，并追加 `Portable skill root` notice。
2. **Claude 风格参数合同**
   已补 `$ARGUMENTS[n]`、`$0..$n`、无占位符时自动追加参数块。
3. **portable runtime 合同消费**
   已补 `allowed-tools` specifier 级 hard gate、clean-room `context: fork`、`agent` 到内置 sub-agent 的映射、`model` 覆盖、`inputSchema` best-effort 解析，以及 hooks lifecycle runtime。
4. **模型自主 skill 激活**
   已补 `skills.list` / `skills.activate`，模型现在可以先发现 portable skill，再把 skill 合同动态加载进当前 run。

`v0.2` 这里保留的是当时的阶段性判断；后续 `P1/P2` 的真实缺口与收敛情况已经在 `v0.3` 里重新标定。

- `hooks` 的 `command/http` 已原生执行，但 `prompt/agent` 仍是 best-effort JSON runner，不是完整 Claude 子 agent runtime
- 相对资源路径仍是 prompt 级重写，不是执行时自动切换 cwd
- 还没做 Desktop UI -> Gateway turn 的端到端手工验证，以及官方 skills 仓库的大样本扫测

换句话说，`v0.2` 已达到“Anthropic 官方标准 skill 大多数可直接手动调用、模型也能在 run 内动态激活”的目标；但与 Claude Code 原生 runtime 仍不是 1:1。

---

## 二、现状分析

### 2.1 已实现兼容面

| 能力 | 当前状态 | 代码/证据 |
|---|---|---|
| 扫描 `~/.claude/skills` | 已完成 | `apps/desktop/electron/skill-loader.mjs:142-148` |
| 扫描 `~/.agents/skills` | 已完成 | `apps/desktop/electron/skill-loader.mjs:142-148` |
| 扫描项目级 `.claude/skills` / `.agents/skills` | 已完成（已超出 v0.1 文档原文） | `apps/desktop/electron/skill-loader.mjs:135-148`, `681-689` |
| 解析 `name / description / license` | 已完成 | `apps/desktop/electron/skill-loader.mjs:373-377`, `439-447` |
| 解析 `argumentHint / disableModelInvocation / userInvocable / allowedTools / model / context / agent / hooks / inputSchema` | 已完成（保真解析） | `apps/desktop/electron/skill-loader.mjs:439-472`, `packages/agent-core/src/skills.ts:86-98` |
| portable skill 默认 `autoEnable=false` | 已完成 | `apps/desktop/electron/skill-loader.mjs:379-385` |
| `/skill-name args...` 显式调用 | 已完成 | `apps/desktop/src/ui/components/InputBar.tsx:212-229` |
| `skillInvocations` 透传到 Gateway | 已完成 | `apps/desktop/src/agent/wsTransport.ts:904-920`, `apps/gateway/src/agent/runFactory.ts:429-439`, `2475-2484` |
| Claude 风格参数替换（`$ARGUMENTS[n]` / `$0..$n` / fallback append） | 已完成 | `apps/gateway/src/agent/runFactory.ts`, `apps/gateway/src/agent/portableSkillCompat.ts` |
| `allowed-tools` 别名映射 + specifier 级 runtime gate | 已完成 | `apps/desktop/electron/skill-loader.mjs:31-40`, `apps/gateway/src/agent/portableSkillCompat.ts`, `apps/gateway/src/agent/runtime/GatewayRuntime.ts` |
| scope-aware precedence | 已完成 | `apps/desktop/electron/skill-loader.mjs:151-183`, `693-725` |
| `context: fork / agent / model / inputSchema / hooks` 运行时消费 | 已完成（clean-room fork + hooks lifecycle） | `apps/gateway/src/agent/runFactory.ts`, `apps/gateway/src/agent/runtime/GatewayRuntime.ts`, `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`, `apps/gateway/src/agent/writingAgentRunner.ts` |
| `skills.list` / `skills.activate` 模型自主激活 | 已完成 | `packages/tools/src/index.ts`, `apps/gateway/src/agent/coreTools.ts`, `apps/gateway/src/agent/serverToolRunner.ts`, `apps/gateway/src/agent/runtime/GatewayRuntime.ts` |
| capability card / context summary 暴露 portable metadata | 已完成 | `apps/gateway/src/agent/capabilityIndex.ts:315-408`, `apps/gateway/src/agent/contextAssembler.ts:506-525` |

### 2.2 原始阻塞项与当前结果

以下 3 项是 `v0.2` 最初启动时的主阻塞点；现在都已补齐，保留这里是为了说明“为什么要做这些改动”。

#### 阻塞项 A：relative resource path 无法运行

Anthropic 官方 skill 不是只靠 frontmatter；正文和资源目录本身就是运行时的一部分。

例如官方 `docx` skill 直接写：

- `python scripts/office/soffice.py --headless --convert-to docx document.doc`
- `python scripts/accept_changes.py input.docx output.docx`
- `python scripts/comment.py unpacked/ 0 "Comment text"`

而我们当前：

1. Desktop `SkillLoader` 只把 body 文本塞进 `manifest.promptFragments.system`
   - `apps/desktop/electron/skill-loader.mjs:502-513`
2. 发送给 Gateway 的只有 manifest，没有 skill 根目录
   - `apps/desktop/src/agent/wsTransport.ts:866-874`
3. Gateway 直接把 body 注入 `Active Skills` 片段
   - `apps/gateway/src/agent/runFactory.ts:2635-2646`

当前结果：

- `portableRuntime` 已把 skill 根目录带到 Gateway
- active portable skill 的相对 `scripts/...` / `references/...` / `assets/...` 已在注入时重写为绝对路径
- 仍保留一个残留风险：这是 prompt 级兼容，不是执行时自动切换 cwd 的完整 runtime

#### 阻塞项 B：参数合同还不是 Claude 语义

当前参数渲染逻辑：

- 仅替换 `$ARGUMENTS`
- 仅把 `$1` 当作整段参数文本的别名

代码：

- `apps/gateway/src/agent/runFactory.ts:457-464`

但 Claude / Agent Skills 生态的常见用法至少还包括：

- `$ARGUMENTS[0]`
- `$0`, `$1`, `$2` 等位置参数
- 当 skill body 中没有显式占位符时，显式调用参数自动追加到技能正文末尾

当前结果：

- 已补 `$ARGUMENTS[n]`、`$0..$n`
- 若 skill body 未显式写占位符，会自动在末尾追加 `[Skill Invocation Arguments]`
- 与旧实现相比，`$1` 不再表示“整段参数”，而是 zero-based positional token

#### 阻塞项 C：portable skill 仍缺少 runtime metadata

当前 `SkillManifest` 已经有 portable 兼容字段，但没有 runtime 级元信息：

- skill 根目录
- `SKILL.md` 文件路径
- 当前从哪个 root 扫描进来

代码证据：

- `packages/agent-core/src/skills.ts:59-104`
- `apps/desktop/electron/skill-loader.mjs:494-553`
- `apps/gateway/src/agent/runFactory.ts:2526-2536`, `5757-5767`

当前结果：

- loader 已注入 `portableRuntime`
- dedupe 已按 scope-aware precedence 做 project > user scope > Crab 私有目录
- runtime 已可基于 portable metadata 构建 clean-room fork、tool gate 与动态激活合同

### 2.3 哪些“看起来像没做”，但不是这版剩余缺口

| 项目 | 当前状态 | 判断 |
|---|---|---|
| `allowed-tools` specifier 级权限 | 已完成（Crab 硬门禁） | 解析 `Bash/Read/Write/Edit/WebFetch/Glob/Grep/Task`，并在 runtime 执行时强校验 specifier |
| `context: fork` | 已完成（clean-room fork） | 主 run 会主动清空上一轮对话、mainDoc、Todo、线程能力粘性、L1/L2 与摘要，只保留本轮输入、当前项目访问与 skill 合同 |
| `agent` profile | 已完成（映射内部 sub-agent） | `Explore/Plan -> topic_planner`，`Implement/worker/writer -> copywriter` 等 |
| `hooks` | 已完成（runtime lifecycle） | `UserPromptSubmit / SessionStart / PreToolUse / PostToolUse / PostToolUseFailure / Stop / SessionEnd / SubagentStart / SubagentStop` 已接入；其中 `command/http` 完整，`prompt/agent` 为 best-effort |
| `model` | 已完成 | 显式 portable skill 可覆盖本轮 model 选择；sub-agent bridge 也消费 `model` |
| `inputSchema` 运行时消费 | 已完成（best-effort） | 支持 JSON object / 单字段字符串兜底，并把解析结果注入 skill 上下文 |
| 模型自主 `Skill` tool / `skills/list` 动态激活 | 已完成 | 模型可先 `skills.list` 再 `skills.activate`；runtime 会更新 `activeSkills / portableSkillContext / allowedToolNames` 并注入 follow-up hint |

---

## 三、外部对照结论

### 3.1 Anthropic 官方 skills 仓库的真实特点

对官方仓库 `anthropics/skills` 的快速审计结果：

1. 大多数 skill 仍是标准 `SKILL.md + scripts/ + references/ + assets/` 结构
2. 官方 skill 更依赖**正文中的相对路径约定**，而不是复杂 frontmatter
3. 官方仓库里的标准 skill 基本没有使用我们当前已保真但未消费的那批高级字段

这说明 v0.2 的重心不该放在“再加几个 frontmatter 字段”，而应该放在：

- **skill root / resource runtime**
- **parameter contract**
- **更接近原生的 active skill prompt 渲染**

### 3.2 Agent Skills / Codex 的一手范式

一手资料的共同点是：

1. skill 的核心是 **progressive disclosure**
   - 元数据常驻
   - `SKILL.md` 激活时载入
   - `scripts/ / references/ / assets/` 按需读取
2. skill runtime 需要知道 skill 的**真实路径与 scope**
3. skills 是一等能力索引，而不是“只有 prompt 文本，没有路径语义”

当前 Crab 与这套范式的真实差距，不在“有没有 `SKILL.md`”，而在“有没有把 skill 目录当成一等运行时对象”。

---

## 四、实施方案

## Fix 1（已实现）：给 portable skill 增加 runtime metadata，并补齐默认 explicit 语义

### 目标

让每个外部 portable skill 在进入 Gateway 前，都带上最小运行时元信息：

- `skillDir`
- `manifestPath`
- `scanRoot`

同时把 portable skill 的默认 `activationMode` 补齐为 `"explicit"`，与 `v0.1` 文档字面一致。

### 修改文件

- `packages/agent-core/src/skills.ts`
  - 当前位置：`SkillManifest` 定义 `59-104`
- `apps/desktop/electron/skill-loader.mjs`
  - 当前位置：`parseManifest()` `367-476`
  - 当前位置：`loadOne()` `494-553`

### 改动原理

保留当前 manifest 体系不动，只在外部 portable skill 上补一层 runtime metadata，避免为 v0.2 额外引入 envelope 协议。

### 统一 diff 草案

```diff
*** Update File: packages/agent-core/src/skills.ts
@@
 export type PortableSkillContextMode = "inline" | "fork";
+export type PortableSkillRuntimeMeta = {
+  skillDir?: string;
+  manifestPath?: string;
+  scanRoot?: string;
+};
@@
   hooks?: unknown;
   inputSchema?: unknown;
   vendorMetadata?: Record<string, unknown>;
   portable?: boolean;
+  portableRuntime?: PortableSkillRuntimeMeta;
   /** 可选：声明式 Workflow 配置（phases / exclusions / followUp） */
   workflow?: import("./workflowPhaseInterpreter.js").WorkflowDeclaration;
```

```diff
*** Update File: apps/desktop/electron/skill-loader.mjs
@@
-  const activationMode = norm(raw.activationMode) || undefined;
+  const activationModeRaw = norm(raw.activationMode) || undefined;
+  const activationMode = activationModeRaw || (portable ? "explicit" : undefined);
@@
   if (manifest.mcp?.transport === "stdio") {
     const abs = safeResolve(skillDir, manifest.mcp.entry, `SKILL_MCP_ENTRY_ESCAPE:${manifest.id}`);
     if (!(await exists(abs))) throw new Error(`SKILL_MCP_ENTRY_NOT_FOUND:${manifest.id}`);
   }
+
+  if (manifest.portable) {
+    manifest.portableRuntime = {
+      skillDir,
+      manifestPath: await exists(skillMdPath) ? skillMdPath : legacyJsonPath,
+      scanRoot: rootDir,
+    };
+  }
 
   const digest = crypto.createHash("sha1").update(JSON.stringify(manifest)).digest("hex");
```

### 边界情况

- 只给 `portable=true` 的 skill 补 metadata，不污染内置 workflow skill
- `activationMode="explicit"` 只是把现有行为显式化；`autoEnable=false` 已经在运行时生效
- `manifestPath` 与 `skillDir` 为本机绝对路径，只应在 active portable skill 上向模型暴露，不应在“全部 skill 列表”中普遍泄露

---

## Fix 2（已实现）：为 active portable skill 注入 skill root，并把常见相对资源路径重写成绝对路径

### 目标

让官方 Anthropic skill 正文中的：

- `scripts/...`
- `references/...`
- `assets/...`
- Markdown 相对链接

在 Crab 中被激活后能直接指向真实文件，而不是要求模型自己猜 skill 根目录。

### 修改文件

- `apps/gateway/src/agent/runFactory.ts`
  - 当前参数渲染：`441-464`
  - 当前 active skill 注入：`2635-2646`

### 改动原理

在 active portable skill 注入阶段做最小兼容：

1. 先渲染参数占位
2. 再将 `scripts/`、`references/`、`assets/` 这类相对资源路径重写为基于 `portableRuntime.skillDir` 的绝对路径
3. 最后追加一段简短 `Portable skill root` 提示

这样既不要求重写 loader，也不要求一次性做完整的 `Skill` tool / progressive disclosure runtime。

### 统一 diff 草案

```diff
*** Update File: apps/gateway/src/agent/runFactory.ts
@@
-import { randomUUID } from "node:crypto";
+import path from "node:path";
+import { randomUUID } from "node:crypto";
@@
 function renderSkillPromptTemplate(text: string, args?: string) {
   const raw = String(text ?? "");
   const value = String(args ?? "");
   if (!raw) return "";
   return raw
     .replace(/\$ARGUMENTS/g, value)
     .replace(/\$1\b/g, value);
 }
+
+function rewritePortableSkillRelativePaths(text: string, manifest: any) {
+  const skillDir = String(manifest?.portableRuntime?.skillDir ?? "").trim();
+  if (!skillDir || !text) return text;
+  const absolutize = (rel: string) => path.resolve(skillDir, rel);
+  return String(text)
+    .replace(/\]\(((?:scripts|references|assets)\/[^)\s]+)\)/g, (_m, rel) => `](${absolutize(rel)})`)
+    .replace(/(^|[\s`'"])((?:scripts|references|assets)\/[^\s`'")]+)/gm, (_m, prefix, rel) => `${prefix}${absolutize(rel)}`);
+}
+
+function buildPortableSkillResourceNotice(manifest: any) {
+  const skillDir = String(manifest?.portableRuntime?.skillDir ?? "").trim();
+  if (!(manifest?.portable && skillDir)) return "";
+  return [
+    `Portable skill root: ${skillDir}`,
+    "Resolve all relative scripts/, references/, and assets/ paths in this skill from the directory above.",
+  ].join("\n");
+}
@@
       const frags = activeSkillIds
         .map((id: string) => {
           const m: any = skillManifestById.get(id);
-          const rendered = renderSkillPromptTemplate(String(m?.promptFragments?.system ?? "").trim(), invocationBySkillId.get(id)?.arguments);
+          const rendered = rewritePortableSkillRelativePaths(
+            renderSkillPromptTemplate(String(m?.promptFragments?.system ?? "").trim(), invocationBySkillId.get(id)?.arguments),
+            m,
+          );
           const aliasNotice = buildSkillToolAliasNotice(m);
-          return [aliasNotice, rendered].filter(Boolean).join("\n\n").trim();
+          const resourceNotice = buildPortableSkillResourceNotice(m);
+          return [aliasNotice, resourceNotice, rendered].filter(Boolean).join("\n\n").trim();
         })
         .filter(Boolean);
```

### 边界情况

- 只处理相对 `scripts/`、`references/`、`assets/` 前缀，不碰 URL、绝对路径、项目文件路径
- 只在 active portable skill 上做，不改变普通 workflow skill 的 prompt
- 这是 prompt 级兼容，不是“切换工作目录”语义；如果后续引入更原生 runtime，可再下沉成真正的资源解析器

---

## Fix 3（已实现）：把 slash 参数合同补到 Claude 习惯用法

### 目标

从“基础参数替换”提升到“Claude 风格参数替换”：

- 支持 `$ARGUMENTS[n]`
- 支持 `$0`, `$1`, `$2`...
- 当 skill body 中没有显式占位符时，把参数自动追加到正文末尾

### 修改文件

- `apps/gateway/src/agent/runFactory.ts`
  - 当前位置：`renderSkillPromptTemplate()` `457-464`

### 改动原理

不改 slash parser，不改 transport 协议，只增强 prompt renderer。

当前 Desktop 已经能把 `/skill-name args...` 分成：

- `skillInvocations[i].arguments`
- `promptOverride=args`

代码：

- `apps/desktop/src/ui/components/InputBar.tsx:212-229`
- `apps/desktop/src/ui/components/ChatArea.tsx:1208-1210`

因此这部分实现集中在 Gateway 侧 renderer；Desktop slash parser 与 transport 协议本身无需改动。

### 统一 diff 草案

```diff
*** Update File: apps/gateway/src/agent/runFactory.ts
@@
+function splitSkillInvocationArgs(raw: string): string[] {
+  const text = String(raw ?? "").trim();
+  if (!text) return [];
+  const matches = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
+  return matches.map((token) => token.replace(/^["']|["']$/g, ""));
+}
+
 function renderSkillPromptTemplate(text: string, args?: string) {
   const raw = String(text ?? "");
-  const value = String(args ?? "");
+  const value = String(args ?? "").trim();
   if (!raw) return "";
-  return raw
-    .replace(/\$ARGUMENTS/g, value)
-    .replace(/\$1\b/g, value);
+  const tokens = splitSkillInvocationArgs(value);
+  let usedPlaceholder = false;
+  const rendered = raw
+    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, idx) => {
+      usedPlaceholder = true;
+      return tokens[Number(idx)] ?? "";
+    })
+    .replace(/\$(\d)\b/g, (_m, idx) => {
+      usedPlaceholder = true;
+      return tokens[Number(idx)] ?? "";
+    })
+    .replace(/\$ARGUMENTS\b/g, () => {
+      usedPlaceholder = true;
+      return value;
+    });
+  if (!value || usedPlaceholder) return rendered;
+  return `${rendered}\n\n[Skill Invocation Arguments]\n${value}`.trim();
 }
```

### 边界情况

- 仅做轻量 shell-like 分词，不追求完全等价 shell parser
- 若 skill 作者已显式写占位符，则不再自动追加参数，避免重复
- 保留当前 `$ARGUMENTS` 兼容性，不破坏已上线 skill

---

## Fix 4（已实现）：把 root/scope 优先级语义收清楚，避免重复 id 冲突时保留错误来源

### 当前问题

当前去重规则是“按 scanRoots 顺序，先扫到先保留”：

- `apps/desktop/electron/skill-loader.mjs:631-660`

而当前 scanRoots 顺序是：

1. `<userData>/skills`
2. `~/.claude/skills`
3. `~/.agents/skills`
4. 项目级 `.claude/skills`
5. 项目级 `.agents/skills`

这意味着项目级 skill 在重复 id 时反而优先级最低，不符合“repo/local override broader scope”的直觉。

### 实际实现

- project skill > user scope > crab private install
- 同 scope 内再按 scan root 稳定排序

### 当前结果

- 已在 loader 去重阶段引入 precedence 比较，而不是只靠 `scanRoots` 顺序
- 同 id 重复时会保留更高 scope 的 skill，并把被覆盖项写入 error 列表用于诊断

---

## Fix 5（已实现）：把 `allowed-tools`、`context: fork`、`agent/hooks/model/inputSchema` 运行时消费补齐

### 5A：`allowed-tools` 真正权限语义

当前实现：

- 新增 `apps/gateway/src/agent/portableSkillCompat.ts` 统一解析 `allowed-tools`
- 支持 `Bash/Read/Write/Edit/WebFetch/Glob/Grep/Task`
- 在 `GatewayRuntime` 执行前做 specifier 级硬门禁，不匹配时直接返回 `PORTABLE_SKILL_TOOL_POLICY_DENIED`
- 对 `Bash(...)` 这类被明确白名单的高危命令，允许绕过 Crab 创作模式下默认的高危工具剪裁

### 5B：`context: fork` / `agent` / `model` / `inputSchema`

当前实现：

- `context: fork`
  - 主 run 会构建 clean-room `system + userPrompt`
  - 会主动清空 `contextPack/contextSegments/mainDoc/runTodo/taskState/pendingArtifacts/recentDialogue/L1/L2/summary/kbSelected/threadCapabilityState`
  - skill body 不再只是普通 active fragment，而会变成本轮主任务的一部分
- `agent`
  - `Explore/Plan/research` 映射到 `topic_planner`
  - `Implement/worker/writer` 映射到 `copywriter`
- `model`
  - 若用户本轮未显式指定 model，则 portable skill 的 `model` 可覆盖本轮模型选择
  - sub-agent bridge 也会优先消费 portable / tool args 给出的 `model`
- `inputSchema`
  - 支持 JSON object 直接解析
  - 单字段 object schema 时，纯字符串会兜底映射到唯一字段
  - 解析结果会注入 `[Parsed Skill Input]`

### 5C：`hooks`

当前实现：

- `hooks` 已被显式暴露到 active skill 上下文
- runtime 已接入 `UserPromptSubmit / SessionStart / PreToolUse / PostToolUse / PostToolUseFailure / Stop / SessionEnd / SubagentStart / SubagentStop`
- `command` / `http` handler 会真实执行；`PreToolUse` 可更新参数或直接阻断工具
- `prompt` / `agent` handler 当前通过 provider 单次 JSON 调用做 best-effort 执行，不是完整多轮子 agent runtime

### 5D：模型自主 `skills.list` / `skills.activate`

当前实现：

- 新增 `skills.list` / `skills.activate` 为 core tool，可被模型直接调用
- `skills.list` 返回可模型激活的 portable / builtin skill 卡片
- `skills.activate` 返回 skill 合同、`contextMode/modelOverride/inputState/toolNames/allowedToolPolicy`
- `GatewayRuntime` 在 `skills.activate` 成功后会动态更新：
  - `activeSkills`
  - `activeWorkflowDeclarations`
  - `allowedToolNames`
  - `portableSkillContext`
  - follow-up runtime hint
- `runFactory` 的 thread capability state 也会把 `skills.activate` 视为 skill 激活事件，维持线程态一致

---

## 五、影响矩阵

| 改动 | 当前状态 | 影响范围 | 风险 | 缓解 |
|---|---|---|---|---|
| `portableRuntime` metadata + portable 默认 `activationMode="explicit"` | 已实现 | Desktop loader / Gateway manifest 透传 | 低 | 仅给 `portable=true` 的外部 skill 补增量字段；不影响 builtin workflow skill |
| scope-aware precedence | 已实现 | Desktop skill 扫描、去重、覆盖语义 | 低到中 | 同 id 重复时改为 project `.claude/.agents` > user `~/.claude/.agents` > Crab 私有目录，并保留诊断信息 |
| active portable skill 路径重写 + root notice | 已实现 | active skill prompt / assembled context | 中 | 仅对 active portable skill 生效，只改写 `scripts/`、`references/`、`assets/` 前缀，不碰 URL 和绝对路径 |
| slash 参数合同补全 | 已实现 | 所有显式 `/skill-name args...` 调用 | 低 | 保留 `$ARGUMENTS` 兼容，并在无占位符时才追加参数块 |
| `allowed-tools` specifier 级 runtime gate | 已实现 | Gateway 工具执行、创作模式高危工具放行逻辑 | 中到高 | 先做 Claude alias 解析，再在 runtime 执行前硬校验；不匹配时显式返回 `PORTABLE_SKILL_TOOL_POLICY_DENIED` |
| clean-room `context: fork / agent / model / inputSchema / hooks` 运行时消费 | 已实现 | `prepareAgentRun()`、`GatewayRuntime`、sub-agent bridge、`RunContext` | 中到高 | `command/http` hook 已原生执行；`prompt/agent` 明确标注为 best-effort，不伪装成 Claude 1:1 |
| `skills.list` / `skills.activate` 动态激活 | 已实现 | tool registry、Gateway server tool、runtime 状态机、thread capability state | 中 | 走 gateway tool，成功后动态更新 `activeSkills / allowedToolNames / portableSkillContext`，并注入 follow-up hint |

---

## 六、验证 Checklist

### 6.1 已完成回归验证

| 检查项 | 当前状态 | 证据 |
|---|---|---|
| 现有 portable skill 仍可被 loader 识别并进入 slash/capability 链路 | 已验证 | loader smoke；`SkillLoader.reload()` 可识别临时 mock skill 与官方 `docx` / `skill-creator` |
| `/skill-name args...` 仍会解析成 `skillInvocations` 并进入 Gateway renderer | 已验证 | `prepareAgentRun()` smoke；参数合同 helper smoke |
| clean-room `context: fork` 不泄漏历史上下文 | 已验证 | `prepareAgentRun()` smoke；prepared messages 含 clean-room notice，且不含注入的 `SHOULD_NOT_LEAK` sentinel |
| `portableRuntime` / `allowed-tools` / `context: fork` / `agent` / `model` / `inputSchema` / `hooks` 已进入 prepared contract | 已验证 | `prepareAgentRun()` smoke |
| `allowed-tools` deny-path 会在 runtime 明确阻断违规工具 | 已验证 | `GatewayRuntime._executeAgentTool()` smoke 返回 `PORTABLE_SKILL_TOOL_POLICY_DENIED` |
| `hooks` lifecycle 的 `PreToolUse` deny-path 生效 | 已验证 | `GatewayRuntime._executeAgentTool()` smoke 返回 `PORTABLE_SKILL_HOOK_DENIED` |
| `skills.activate` 会在当前 run 动态生效 | 已验证 | `GatewayRuntime._executeAgentTool(\"skills.activate\")` smoke 后，`activeSkills / portableSkillContext / allowedToolNames` 均已更新 |
| 非 portable builtin workflow skill 未因 manifest 增量字段出现编译级回归 | 已验证 | `npm run -w @ohmycrab/agent-core build`、`npm run -w @ohmycrab/gateway build` |

### 6.2 Anthropic 官方 skills 场景验证

| 场景 | 当前状态 | 证据 |
|---|---|---|
| 把 `anthropics/skills/skills/docx` 放到 `~/.claude/skills/docx` | 已验证 | loader smoke 可发现并识别为 portable skill |
| `/docx` 激活后正文中的 `scripts/office/soffice.py` / `scripts/accept_changes.py` | 已验证 | active fragment smoke 中已被重写为绝对路径 |
| `/skill-creator Add a new skill for triaging flaky CI` | 已验证 | helper smoke 验证 `$ARGUMENTS` / `$0` / `$1` / `$ARGUMENTS[0]` 可消费参数 |
| skill body 未写任何占位符，但用户 slash 传参 | 已验证 | helper smoke 会自动追加 `[Skill Invocation Arguments]` |
| 官方 skill 的 `references/...` / `assets/...` 相对资源 | 已验证 | `skill-creator` smoke 中已被重写为绝对路径 |
| project `.claude/skills` 覆盖 user scope 同名 skill | 已验证 | precedence smoke；winner 为 project 版本 |

### 6.3 仍建议补的验证

| 检查项 | 当前状态 | 说明 |
|---|---|---|
| Desktop UI 到 Gateway turn 的端到端手工验证 | 尚未补跑 | 当前已做 loader / prepare / runtime smoke，但未走完整对话 UI |
| 官方 skills 仓库更大样本扫测 | 尚未补跑 | 当前重点验证了 `docx` 与 `skill-creator` 两个代表性 skill |
| `hooks.prompt` / `hooks.agent` 与 Claude 原生语义对照 | 尚未补跑 | 当前这两类 handler 已接入，但仍是 best-effort，不是完整 Claude 子 agent runtime |

---

## 七、实施状态与后续优先级

### 已完成切片

1. `portableRuntime` metadata、portable 默认 explicit 语义、active portable skill 路径重写、slash 参数合同补全
2. scope-aware precedence 与重复 skill id 的覆盖规则
3. `allowed-tools` specifier 级 runtime gate，以及 clean-room `context: fork / agent / model / inputSchema / hooks` 运行时消费
4. `skills.list` / `skills.activate` tool 合同、gateway 执行与 run 内动态激活

### 剩余真正后续项

1. `hooks.prompt` / `hooks.agent` 收敛成真正带工具、可多轮、可控上下文的子 agent/runtime
2. 把 prompt 级路径重写下沉成真正的 portable skill cwd / 资源解析 runtime
3. Desktop UI -> Gateway turn 端到端验证，以及 Anthropic 官方 skills 仓库更大样本扫测

---

## 八、回滚与兼容说明

- loader 层回滚：移除 `portableRuntime` 字段回填、portable 默认 explicit 语义，以及 `shouldPreferLoadedSkill()` 覆盖规则后，行为会退回旧的 scan-order 去重与最小 metadata 模式
- runtime 层回滚：关闭 `rewritePortableSkillRelativePaths()`、`buildPortableSkillResourceNotice()`、增强版 `renderSkillPromptTemplate()`、`portableSkillContext` 注入，以及 `portableSkillCompat.ts` / `GatewayRuntime` 的 hard gate / hook lifecycle / dynamic activation 后，行为会退回“只做显式注入、无 runtime contract 消费”的旧兼容层
- 协议兼容：这版不改 Desktop slash 输入协议，也不改 `run.request` 主 schema；新增状态主要落在 manifest 增量字段与 `RunContext.portableSkillContext`
- 数据兼容：不涉及持久化结构迁移，也不引入数据库变更
- 内容兼容：大多数 Anthropic 官方标准 skill 可以不改内容直接手动调用；唯一需要额外注意的是旧 Crab skill 若依赖 `$1 = 整段参数`，现在应显式改写为 `$ARGUMENTS`

---

## 九、涉及文件清单

### 已修改文件

- `packages/agent-core/src/skills.ts`
  - `PortableSkillRuntimeMeta` 与 `SkillManifest.portableRuntime`
- `apps/desktop/electron/skill-loader.mjs`
  - portable frontmatter/runtime 解析、runtime metadata 回填、scope-aware precedence
- `packages/tools/src/index.ts`
  - 新增 `skills.list` / `skills.activate`
- `apps/gateway/src/agent/coreTools.ts`
  - 把 `skills.list` / `skills.activate` 收进 `CORE_TOOL_NAMES`
- `apps/gateway/src/agent/runFactory.ts`
  - alias notice / 参数渲染 / 路径重写 helper
  - clean-room `context: fork`
  - `skills.activate` 对 thread capability state 的更新
- `apps/gateway/src/agent/serverToolRunner.ts`
  - `skills.list` / `skills.activate` gateway 执行与返回合同
- `apps/gateway/src/agent/portableSkillCompat.ts`
  - `allowed-tools` 解析、`agent` 映射、`inputSchema` / `hooks` / activation helper
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts`
  - runtime hard gate
  - hook lifecycle
  - dynamic skill activation
- `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts`
  - sub-agent 继承 `portableSkillContext`
- `apps/gateway/src/agent/writingAgentRunner.ts`
  - `RunContext.portableSkillContext` 类型

### 证据 / 现状参考

- `apps/desktop/src/ui/components/InputBar.tsx`
  - slash 解析：`212-229`
- `apps/desktop/src/ui/components/ChatArea.tsx`
  - `promptOverride` 接管：`1208-1210`
  - Gateway run 发起：`1300-1305`
- `apps/desktop/src/agent/wsTransport.ts`
  - `userSkillManifests` 发送：`866-874`
  - `run.request` 透传：`904-920`
- `packages/agent-core/src/skills.ts`
  - 激活逻辑：`298-335`
- `docs/specs/claude-code-skill-compat-v0.1.md`
- `docs/research/claude-code-skill-format-gap-analysis-2026-03-20.md`
- `docs/research/claude-code-skill-native-compat-plan-2026-03-20.md`

---

## 十、附：本版判断标准

当满足以下条件时，可认为 `v0.2` 达标：

1. 把 Anthropic 官方标准 skill 目录复制到 `~/.claude/skills/` 后，Crab 能直接发现
2. 用户可以通过 `/skill-name ...` 显式调用它
3. skill 正文中的相对 `scripts/` / `references/` 路径在 active prompt 中可直接落到真实文件
4. 模型可以通过 `skills.list` / `skills.activate` 在 run 内动态发现并激活 skill
5. clean-room `context: fork` 不泄漏历史上下文
6. `PreToolUse` hook 可以真实阻断工具
7. 不把“完整 Claude Runtime parity”伪装成已完成

当前达成度判断：

- 以上 1 / 2 / 3 / 4 / 5 / 6 / 7 已达成
- “不要求改 skill 内容来适配 Crab 的本地路径结构”当前已达到手动调用层面的实用兼容，但仍受限于 prompt 级路径兼容，而非完整原生 runtime
- 当前真实残留主要是保真度与验证深度，而不是功能缺口

---

## 十一、实施卡片（2026-03-21）

- spec：`docs/specs/claude-code-skill-compat-v0.2.md`
- 目标：把 Claude Code portable skill 兼容层推进到“绝大多数手动调用 skill 可直接跑”的级别
- 范围：本轮围绕 `scope-aware precedence`、`allowed-tools` specifier 级 runtime gate、clean-room `context: fork / agent / model / inputSchema / hooks` 消费，以及 `skills.list / skills.activate` 动态激活完成补齐
- 不做什么：不做 Claude 1:1 parity；尤其不承诺 `hooks.prompt/agent` 与 Claude 原生子 agent 完全等价，也不做执行时自动切换 portable skill cwd
- 当前 HEAD：`5b8e1ab9596acd76b23e653f395717ec8548afb6`
- 主要风险：旧有依赖 `$1=整段参数` 的 skill 现在需要改用 `$ARGUMENTS`；这次按 spec 切到 zero-based positional 语义

## 十二、实施状态

| Spec 条目 | 文件/符号 | 状态 | 验证 | 备注 |
|---|---|---|---|---|
| Fix 1：`portableRuntime` metadata 贯通 | `packages/agent-core/src/skills.ts:59-105` | 已完成 | `npm run -w @ohmycrab/agent-core build` | 新增 `PortableSkillRuntimeMeta` 与 `SkillManifest.portableRuntime` |
| Fix 1：portable 默认 `activationMode="explicit"` | `apps/desktop/electron/skill-loader.mjs:438-439` | 已完成 | loader smoke | 仅对 portable skill 默认回填；显式配置仍优先 |
| Fix 1：loader 补 `skillDir / manifestPath / scanRoot` | `apps/desktop/electron/skill-loader.mjs:495-559` | 已完成 | loader smoke | 只对 `manifest.portable === true` 注入 runtime metadata |
| Fix 2：active portable skill 路径重写 + root notice | `apps/gateway/src/agent/runFactory.ts:488-505`, `apps/gateway/src/agent/runFactory.ts:2676-2686` | 已完成 | helper smoke + `npm run -w @ohmycrab/gateway build` | 仅重写 `scripts/`、`references/`、`assets/` 前缀；只在 active portable skill 生效 |
| Fix 3：slash 参数合同补齐 | `apps/gateway/src/agent/runFactory.ts:458-486` | 已完成 | helper smoke + `npm run -w @ohmycrab/gateway build` | 支持 `$ARGUMENTS[n]`、`$0..$n`、无占位符时尾部追加参数块 |
| Fix 4：scope-aware precedence | `apps/desktop/electron/skill-loader.mjs` | 已完成 | loader smoke | 重复 skill id 按 project `.claude/.agents` > user `~/.claude/.agents` > Crab 私有安装目录 去重 |
| Fix 5A：`allowed-tools` specifier 级 runtime gate | `apps/gateway/src/agent/portableSkillCompat.ts`, `apps/gateway/src/agent/runtime/GatewayRuntime.ts`, `apps/gateway/src/agent/runFactory.ts` | 已完成 | runtime deny smoke + prepare smoke + `npm run -w @ohmycrab/gateway build` | Crab 采用硬门禁近似 Claude 权限语义，并支持高危 runtime 工具的 skill 级放行 |
| Fix 5B：clean-room `context: fork / agent / model / inputSchema` 消费 | `apps/gateway/src/agent/runFactory.ts`, `apps/gateway/src/agent/runtime/SubAgentExecutionBridge.ts` | 已完成 | clean-room prepare smoke + `npm run -w @ohmycrab/gateway build` | `context: fork` 会清空历史上下文；`agent` 映射内部 sub-agent；`model` 覆盖本轮模型；`inputSchema` best-effort 解析 |
| Fix 5C：`hooks` lifecycle runtime | `apps/gateway/src/agent/runtime/GatewayRuntime.ts`, `apps/gateway/src/agent/portableSkillCompat.ts` | 已完成 | hook deny smoke + `npm run -w @ohmycrab/gateway build` | `command/http` 已原生执行；`prompt/agent` 为 best-effort |
| Fix 6：`skills.list` / `skills.activate` 动态激活 | `packages/tools/src/index.ts`, `apps/gateway/src/agent/coreTools.ts`, `apps/gateway/src/agent/serverToolRunner.ts`, `apps/gateway/src/agent/runtime/GatewayRuntime.ts`, `apps/gateway/src/agent/runFactory.ts` | 已完成 | `skills.activate` smoke + `npm run -w @ohmycrab/gateway build` | 当前 run 可动态更新 `activeSkills / portableSkillContext / allowedToolNames`，thread capability state 也会同步 |

## 十三、验证记录

- 代码级验证：
  - `npm run -w @ohmycrab/agent-core build`
  - `npm run -w @ohmycrab/gateway build`
- 行为级验证：
  - 临时构造一个 portable `SKILL.md`，通过 `SkillLoader.reload()` 验证 `portableRuntime.skillDir / manifestPath / scanRoot` 与默认 `activationMode="explicit"` 已生效
  - 从 `apps/gateway/src/agent/runFactory.ts` 直接抽取 `splitSkillInvocationArgs / renderSkillPromptTemplate / rewritePortableSkillRelativePaths / buildPortableSkillResourceNotice` 做 smoke，验证：
    - `$ARGUMENTS[1]`、`$0`、`$1`、`$2` 正常渲染
    - 无占位符时自动追加 `[Skill Invocation Arguments]`
    - `scripts/`、`references/`、`assets/` 被重写为 portable skill 根目录下的绝对路径
    - `Portable skill root` notice 正常输出
  - Anthropic 官方 `skills` 仓库 smoke：
    - 仓库版本：`anthropics/skills@b0cbd3df1533b396d281a6886d5132f623393a9c`
    - 将官方 `docx` 与 `skill-creator` 复制到临时 `userData/skills/` 后，通过 `SkillLoader.reload()` 验证二者均被识别为 portable skill，且 `portableRuntime.skillDir / manifestPath / scanRoot` 与默认 `activationMode="explicit"` 正常
    - 对 `docx` 验证 active fragment 中的 `scripts/office/soffice.py`、`scripts/accept_changes.py` 已被重写为绝对路径
    - 对 `skill-creator` 验证 active fragment 中的 `references/schemas.md`、`assets/eval_review.html` 已被重写为绝对路径，且在无显式占位符时会自动追加 `[Skill Invocation Arguments]`
  - 扩展 smoke：
    - 用临时 `project/.claude/skills/dup-skill` 覆盖 `userData/skills/dup-skill`，验证 scope-aware precedence 已按 project > userData 生效
    - 通过 `prepareAgentRun()` 验证 clean-room `context: fork` 已生效：prepared messages 含 clean-room notice，且不泄漏注入的 `MAIN_DOC/RUN_TODO/RECENT_DIALOGUE/TASK_STATE/PENDING_ARTIFACTS/L1/L2/DIALOGUE_SUMMARY` sentinel
    - 通过 `prepareAgentRun()` 验证 portable skill 的 `model/context/agent/inputSchema/hooks` 已进入本轮 prepared contract，且 `allowed-tools` 会把最终工具池收敛到 `read/shell.exec/spawn_agent/write`
    - 通过 `GatewayRuntime._executeAgentTool()` deny-path smoke 验证不匹配的 `Bash(...)` 调用会在 runtime 返回 `PORTABLE_SKILL_TOOL_POLICY_DENIED`
    - 通过 `GatewayRuntime._executeAgentTool("read")` + `PreToolUse` command hook smoke 验证 runtime 会返回 `PORTABLE_SKILL_HOOK_DENIED`
    - 通过 `GatewayRuntime._executeAgentTool("skills.activate")` smoke 验证 runtime 会更新 `activeSkills / portableSkillContext.activeSkillIds / allowedToolNames`，并注入 follow-up hint

## 十四、偏差说明与残留风险

- 这次按 spec 把 `$1` 从旧实现里的“整段参数别名”切到了 zero-based positional 语义；若现存 skill 依赖旧行为，需要改成 `$ARGUMENTS`
- `allowed-tools` 在 Crab 中被实现为“active portable skill 的硬 runtime 门禁”，而不是 Claude 那种“permission + approval”双层模型；这是为了在没有逐次审批 UI 的前提下尽量保真兼容
- `hooks.prompt` / `hooks.agent` 当前通过 provider 单次 JSON 调用做 best-effort 执行，不是完整多轮、带工具、带独立上下文的 Claude 原生子 agent runtime
- 当前路径重写仍是 prompt 级兼容，不是“执行时自动切到 skill 根目录”的完整 runtime；如果 skill 依赖更复杂的相对路径或动态 cwd，后续仍要下沉成真正的 runtime 资源解析
- `skills.activate` 的 `modelOverride` 若发生在 provider run 已启动之后，会从下一次 run 开始稳定生效；当前 run 只会注入 runtime hint
- 已做 Anthropic 官方仓库 skill 的 loader + prepare/runtime smoke，但还没做完整 UI / Gateway turn 级别的端到端手工接入验证，也还没做官方仓库大样本扫测
