# 我们当前 Skill 格式 vs Claude Code 标准 Skill 格式

> 日期：2026-03-20
> 目的：先把我们仓库当前的 Skill 真实实现梳理清楚，再对照 Claude Code / Agent Skills 的一手格式与调用机制，明确差异点，避免后续“看起来像 SKILL.md，实际语义完全不同”。

## 1. 结论先行

当前仓库已经采用了 `SKILL.md` 这个外壳，但**运行时语义并不是 Claude Code 原生 Skill 语义**，而是我们自己的一套：

1. **我们是“平台侧预激活”**。
   Gateway 在模型调用前先 `mergeSkillManifests()` + `activateSkills()`，由规则、KB 绑定、`skillRefs` 提及等信号决定哪些 skill 激活，再把激活 skill 的 prompt 注入系统提示词。

2. **Claude Code 是“模型侧按 description 自主决策是否读取 Skill”**。
   标准 Agent Skills / Claude Code 的核心是：平时只暴露 `name + description`，模型判断当前任务是否值得调用 skill；只有在触发时才加载完整 `SKILL.md` 与附属资源。

3. **我们当前 frontmatter 是 manifest 驱动**，字段大量偏“编排/门禁/工作流”。
   例如 `priority`、`auto-enable`、`activation-mode`、`triggers`、`tool-caps`、`workflow`、`pipeline`、`ui`、`mcp`。这套字段不是 Claude Code 标准字段。

4. **Claude Code 的标准 frontmatter 更轻**，但有一批 Claude 扩展字段。
   最基础标准只要求 `name`、`description`。Claude Code 在此之上扩展了 `allowed-tools`、`input-schema`、`argument-hint`、`disable-model-invocation`、`user-invocable`、`agent`、`context`、`hooks`、`model` 等。

5. **工具命名体系完全不同**。
   Claude Code 用的是实际工具名，如 `Bash`、`Read`、`Edit`、`Write`、`Glob`、`Grep`、`WebFetch`。
   我们用的是自定义平台工具 ID，如 `kb.search`、`project.listFiles`、`write`、`edit`、`lint.copy`、`run.done`、`spawn_agent`。

一句话总结：**我们现在更像“Skill Manifest + Workflow Contract + Tool Gating”系统；Claude Code 更像“动态按需加载的任务知识包”系统。**

## 2. 本次对照用的一手来源

### 2.1 我们仓库本地实现

- `apps/desktop/electron/skill-loader.mjs`
- `packages/agent-core/src/skills.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/desktop/src/ui/components/SlashPopover.tsx`
- `apps/desktop/src/ui/components/ChatArea.tsx`
- `docs/specs/skill-definition-standard-v0.1.md`
- `docs/specs/feat-skill-md-format-migration-v1.md`
- `apps/desktop/electron/bundled-skills/docx/SKILL.md`
- `apps/desktop/electron/bundled-skills/style_imitate/SKILL.md`

### 2.2 Claude Code / Agent Skills 一手来源

- Claude Code Skills 文档：<https://docs.claude.com/en/docs/claude-code/skills>
- Claude Code Settings / permissions 文档：<https://docs.claude.com/en/docs/claude-code/settings>
- Anthropic 官方技能仓库：<https://github.com/anthropics/skills>
- Agent Skills 标准：<https://agentskills.io/specification>

## 3. 我们当前 Skill 的真实形态

### 3.1 文件格式：`SKILL.md` 只是入口，最终会被解析成 `SkillManifest`

当前 Desktop 主进程用 `skill-loader.mjs` 扫描 skill 目录，解析 `SKILL.md` 的 YAML frontmatter + Markdown body，然后转成内部 `SkillManifest`。

关键点：

- 文件名固定是 `SKILL.md`
- 仍兼容旧格式 `skill.json + system-prompt.md + context-prompt.md`
- body 会被放进 `manifest.promptFragments.system`
- `context-prompt` 会额外装载到 `manifest.promptFragments.context`
- frontmatter 中 kebab-case 会被转成 camelCase 再进入 `parseManifest()`

也就是说，我们不是“原样保留 Claude Skill 文本”，而是**先转译为平台 manifest，再由 Gateway 消费**。

### 3.2 当前支持的核心 frontmatter 字段

从 `skill-loader.mjs` + `packages/agent-core/src/skills.ts` 看，当前真正生效的是这些字段：

- 标识/展示：
  - `id`
  - `name`
  - `display-name`
  - `description`
  - `version`
  - `ui.badge`
  - `ui.color`
- 激活与排序：
  - `priority`
  - `auto-enable`
  - `trigger`
  - `activation-mode`
  - `triggers`
  - `conflicts`
  - `requires`
- 能力与执行：
  - `kind`
  - `tool-caps`
  - `policies`
  - `workflow`
  - `pipeline`
  - `mcp`
  - `builtin`
- prompt 注入：
  - body -> `promptFragments.system`
  - `context-prompt` -> `promptFragments.context`

这已经明显超出 Claude Code 标准 skill 的最小前端格式，属于我们自定义的运行时合同。

### 3.3 当前的触发逻辑：不是模型自己挑 skill，而是平台先判定

当前 skill 激活发生在 Gateway 的 `runFactory.ts`：

1. Desktop 把显式技能提及转成 `skillRefs`
2. Gateway 解析 `skillRefs`，得到 `explicitSkillIds`
3. Gateway 合并 builtin skill + external skill manifest
4. 调用 `activateSkills()`
5. `activateSkills()` 按 `priority` 排序，检查：
   - `autoEnable`
   - `explicitSkillIds`
   - `triggers`
   - `conflicts`
   - `requires`
6. 激活后的 skill 再参与：
   - system prompt 注入
   - stageKey 选择
   - toolCaps pin 工具
   - workflow declaration / phase gate

结论：**skill 是否被激活，是平台规则判定，不是模型根据 description 自主决定。**

### 3.4 当前的显式调用逻辑：`/` 不是 Claude 式 slash command，而是“插入 skill mention”

UI 层的 `/` 逻辑在 `SlashPopover.tsx` 和 `ChatArea.tsx`：

- `/` 弹的是已注册 skill 列表
- 选中后插入的是一个 `MentionItem(type="skill")`
- 发送时被收集成 `mentionedSkillIds`
- 再转成 `skillRefs`
- Gateway 侧把这些 skill 视为显式激活信号

所以我们当前的 `/风格仿写` 本质上更像：

- “在消息里插一个结构化 skill mention”

而不是 Claude Code 原生的：

- “执行一个有参数语义的 slash skill 命令”

### 3.5 当前工具字段的语义：`tool-caps.allow-tools` 是内部工具 pin，不是 Claude 的 `allowed-tools`

我们现在 skill 里的工具字段是：

```yaml
tool-caps:
  allow-tools:
    - kb.search
    - lint.style
    - write
```

它在 Gateway 里的语义是：

- 把 skill 所需工具 pin 进 allowed tool set
- 即便 route/toolPolicy 比较收紧，也尽量别把这些工具裁掉
- `denyTools` 目前只是预留，没有强执行

这更像“**工具检索/暴露层的保底白名单**”，不是 Claude Code 权限系统里的 per-tool permission rule。

## 4. Claude Code 标准 Skill 的真实形态

## 4.1 标准分两层：Agent Skills 通用标准 + Claude Code 扩展

从 Anthropic 官方仓库和 Agent Skills 标准看，可以把“Claude Code 的 skill 格式”拆成两层：

1. **Agent Skills 通用标准**
   - 一个 skill 是一个目录
   - 目录中必须有 `SKILL.md`
   - 最小 frontmatter 只要求：
     - `name`
     - `description`
   - Markdown body 写任务知识、步骤、示例、注意事项

2. **Claude Code 的产品扩展**
   在 `SKILL.md` frontmatter 上加了一批 Claude 自己的字段，用来控制调用方式、参数、工具、subagent、hook 等。

### 4.2 Claude Code 的目录与发现机制

Claude Code 文档明确区分三类 skill：

- User skills：`~/.claude/skills/`
- Project skills：`.claude/skills/`
- Plugin / marketplace skills：通过 plugin 安装

并且支持：

- 嵌套目录自动发现
- 从额外目录导入 skill

这和我们当前不一样：

- 我们内置 skill 在 `apps/desktop/electron/bundled-skills/`
- 外部 skill 在 `<userData>/skills/`
- loader 只扫描根目录下一层子文件夹，不是 Claude 那种标准 user/project/plugin 多作用域结构

### 4.3 Claude Code 的调用逻辑：默认是模型自主调用

Claude Code 的核心机制是：

1. 模型先看到可用 skill 的 `name + description`
2. 模型判断当前任务是否值得读取 skill
3. 需要时再加载完整 `SKILL.md`
4. 需要更多材料时，再读 `references/`、跑 `scripts/`、读附属文件

也就是典型的 **dynamic context / progressive disclosure**。

这点和我们的差异非常大：

- Claude：**先给模型看 skill index，再由模型决定是否读 skill**
- 我们：**平台先激活 skill，再把结果告诉模型**

### 4.4 Claude Code 的显式调用逻辑：slash command 是一等能力

Claude Code 支持 skill 显式调用，并支持关闭模型自动调用：

- `disable-model-invocation: true`
  - skill 只能显式调用
- `user-invocable: false`
  - skill 不能由用户直接调，只能被其他流程/模型内部用

Claude Code 还支持 slash command 风格的 skill 调用，并支持参数占位：

- `$ARGUMENTS`
- `argument-hint`
- `input-schema`

这意味着 Claude Code skill 可以像真正的“命令”一样被调起。

我们当前没有这层能力：

- 没有 `input-schema`
- 没有 `$ARGUMENTS`
- 没有 `argument-hint`
- `/` 只是 mention 入口，不是参数化命令入口

### 4.5 Claude Code skill 的工具控制：用 `allowed-tools`

Claude Code skills 文档里支持：

- `allowed-tools`

它对应 Claude Code 的真实工具/权限体系，与 settings 文档中的 permission rule 语法一致，工具名示例包括：

- `Bash`
- `Read`
- `Edit`
- `Write`
- `WebFetch`

并且支持像：

- `Bash(npm test *)`
- `Bash(gh issue view *)`

这种带 specifier 的精细授权语法。

这与我们的差别在于：

- Claude Code：`allowed-tools` 绑定的是**实际可执行工具名 + 权限语法**
- 我们：`tool-caps.allow-tools` 绑定的是**平台内部工具 ID**

两者不只是名字不同，**权限模型也不同**。

### 4.6 Claude Code skill 可直接声明 subagent / context 策略

Claude Code skills 文档支持：

- `agent`
  - 指定让哪个 subagent 来跑这个 skill
- `context`
  - 例如 `fork`
  - 控制 skill 在 subagent 中拿到什么上下文

而我们当前：

- skill 本身不声明 subagent 执行策略
- 子 agent 定义独立存在于 `packages/agent-core/src/subAgent.ts`
- `SubAgentDefinition.skills` 甚至已经标注为 deprecated

换句话说，**Claude Code 把“skill -> agent”的绑定做进了 skill frontmatter；我们没有。**

### 4.7 Claude Code 还有一些我们没接的扩展字段

在 Claude Code 官方 skill 体系里还能看到这些方向：

- `hooks`
- `model`
- `compatibility`
- `license`

其中：

- `license` 在 Anthropic 官方 skills 仓库里大量使用
- `hooks` / `model` 是 Claude Code 文档明确支持的扩展能力

我们当前 loader 对这些字段没有正式消费逻辑；即便前端写了，大多也只是被忽略。

## 5. 逐项对比

| 维度 | 我们当前实现 | Claude Code 标准 | 差异判断 |
|---|---|---|---|
| Skill 最小文件 | `SKILL.md` | `SKILL.md` | 外壳一致 |
| 最小必填 frontmatter | 实际上至少要能落到 `id/name/description` | 标准只要求 `name/description` | 我们更重、更 manifest 化 |
| Skill 目录发现 | bundled-skills + `<userData>/skills`，单层扫描 | `~/.claude/skills`、`.claude/skills`、plugin，多作用域且可嵌套 | 不兼容 |
| 自动触发 | 规则/KB/intent/mention 预判 | 模型读 description 自主决定 | 核心语义不同 |
| 显式调用 | `/` 选 skill mention，转 `skillRefs` | slash command / explicit invoke / `$ARGUMENTS` | 不兼容 |
| 参数化 skill | 无 | `input-schema`、`argument-hint`、`$ARGUMENTS` | 缺失 |
| 子 agent 绑定 | skill 不声明 | `agent`、`context` 可声明 | 缺失 |
| 工具权限字段 | `tool-caps.allow-tools` | `allowed-tools` | 名字像，语义不同 |
| 工具命名 | `kb.search` / `lint.copy` / `run.done` / `write` | `Read` / `Edit` / `Write` / `Bash` / `WebFetch` | 完全不同 |
| 工作流合同 | `workflow` / `pipeline` 一等字段 | 标准 skill 本身不内建我们这种 workflow schema | 我们是强扩展 |
| Skill 自带 MCP | `mcp` 字段 | Claude Code skill 标准前台不是这套字段 | 我们是平台扩展 |
| 上下文注入 | `promptFragments.system/context` | 触发后加载 skill body，按需读资源 | 我们更像预编译 prompt |

## 6. 工具命名差异：最容易误判的一层

这个问题单独拎出来，因为它最容易造成“格式看着兼容，实际一跑全错”。

### 6.1 Claude Code 的工具名

Claude Code skills / settings 文档能直接看到的工具命名是：

- `Bash`
- `Read`
- `Edit`
- `Write`
- `WebFetch`

并且权限规则写法是：

- `Tool`
- `Tool(specifier)`

例如：

- `Bash(npm run *)`
- `Read(./.env)`
- `WebFetch(domain:example.com)`

### 6.2 我们当前 skill 中出现的工具名

当前仓库 skill 和 tool registry 使用的是平台内部工具 ID，例如：

- `kb.search`
- `kb.listLibraries`
- `project.listFiles`
- `write`
- `edit`
- `lint.copy`
- `lint.style`
- `run.done`
- `run.mainDoc.update`
- `spawn_agent`

### 6.3 这意味着什么

即使我们把 frontmatter 字段名强行改成 Claude Code 的：

```yaml
allowed-tools:
  - Read
  - Edit
```

也**不能直接在我们平台里生效**，因为：

1. 我们的工具注册表不是这套名字
2. 我们的 tool routing / policy / approval 也不是 Claude Code 那套 permission engine
3. 像 `kb.search`、`lint.style`、`run.done` 这类内容团队专用工具，在 Claude Code 标准里根本没有对应原生工具名

所以如果后面要做“Claude 风格兼容层”，必须明确一件事：

- 是做**格式兼容**
- 还是做**运行时语义兼容**

这两件事不是一个工作量。

## 7. 例子：我们的 `docx` skill 和 Anthropic 官方 `docx` skill 的差别

Anthropic 官方 `docx` skill（`anthropics/skills/skills/docx/SKILL.md`）frontmatter 很轻：

- `name`
- `description`
- `license`

我们当前的 `apps/desktop/electron/bundled-skills/docx/SKILL.md` 则额外加了：

- `display-name`
- `version`
- `priority`
- `auto-enable`
- `builtin`
- `triggers`
- `ui`

这说明我们现在做的不是“直接兼容 Anthropic 官方 skill”，而是：

- **拿 Anthropic 的 skill 内容做素材**
- **再包一层我们自己的运行时 manifest 元数据**

这条判断对后续迁移很重要。

## 8. 例子：我们的 `style_imitate` 是典型“超出 Claude 标准 skill”的能力

`style_imitate` 的 frontmatter 中有大量 Claude Code 标准里没有的内容：

- `stage-key`
- `kind: workflow`
- `activation-mode`
- `tool-caps`
- `workflow.state-keys`
- `workflow.phases`
- `workflow.exclusions`
- `workflow.follow-up`

这本质上已经不是“skill 说明书”，而是：

- 一个编排器可执行的 workflow contract

所以如果以后要对齐 Claude Code：

- `style_imitate` 不太可能直接映射成 Claude 原生 skill
- 更现实的做法是：
  - 保留我们的 workflow schema
  - 在外层再做 Claude 风格 frontmatter 兼容

## 9. 我对当前差异的判断

### 9.1 哪些是“表层不兼容”

这些可以通过 loader / adapter 相对低成本兼容：

- 目录约定
- `name/description` 最小格式
- `allowed-tools` -> 我们内部 `toolCaps.allowTools` 的映射
- `disable-model-invocation` / `user-invocable` 的显式开关
- `input-schema` / `argument-hint` / `$ARGUMENTS` 的解析

### 9.2 哪些是“语义层不兼容”

这些不是改几个字段名能解决的：

- 模型自主发现 vs 平台预激活
- Claude 的 progressive disclosure / dynamic context
- Claude 的工具权限模型
- Claude 的 `agent/context` skill-subagent 协同
- 我们的 workflow/pipeline/schema 驱动 skill

### 9.3 最准确的定位

当前我们更接近：

- **“借用 Claude 的 SKILL.md 文件壳 + 我们自己的 SkillManifest 运行时”**

而不是：

- **“Claude Code skill 原生兼容实现”**

## 10. 如果后面要对齐 Claude Code，建议分两层做

### 10.1 第一层：文件格式兼容层

目标：让 Claude 风格的 skill 可以被我们读进来。

建议支持：

- 标准最小字段：
  - `name`
  - `description`
- Claude 扩展字段：
  - `allowed-tools`
  - `disable-model-invocation`
  - `user-invocable`
  - `input-schema`
  - `argument-hint`
  - `agent`
  - `context`
  - `hooks`
  - `model`

这一层主要改 loader / schema。

### 10.2 第二层：运行时语义兼容层

目标：让我们的 skill 调用行为更接近 Claude Code。

需要改的不是 loader，而是：

- skill discovery / availability 注入方式
- model-driven invoke 机制
- explicit invoke 语义
- 参数传递
- subagent 绑定
- tool permission / approval 映射

这一层才是大头。

## 11. 最后一句判断

如果只是问“我们现在的 skill 文件长得像不像 Claude Code”：

- **像，外壳像。**

如果问“我们现在的 skill 运行方式是不是 Claude Code 那套”：

- **不是，核心调用链完全不是。**

