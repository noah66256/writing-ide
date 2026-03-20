# Claude Code Skill 原生兼容改造方案

> 日期：2026-03-20
> 目标：尽量做到 Claude Code / Agent Skills 生态里的 skill 拿到我们这里“不改内容即可运行”，至少对标准 skill 与大多数自定义 Claude Code skill 达到高兼容。

## 1. 先说结论

要做到“Claude Code skill 拿过来不用改直接就能用”，**不能只改 `skill-loader`**，而要同时补齐 6 层兼容：

1. **Skill 发现层兼容**
2. **SKILL.md frontmatter 兼容**
3. **触发/调用语义兼容**
4. **工具名与权限模型兼容**
5. **资源加载与动态上下文兼容**
6. **Claude 子 agent / fork 运行时兼容**

如果只做第 1、2 层，你能“读进来”；  
做到第 3、4 层，才算“多数 Claude Code 自定义 skill 能跑”；  
做到第 5、6 层，才接近“Anthropic 官方 skill 仓库大部分可直接用”。

但有一个边界必须先讲清楚：

- **Agent Skills 标准 skill**：可以做高兼容，目标是“基本无改动即用”
- **Claude Code 自定义 skill**：可以做大部分兼容
- **Anthropic bundled skills / 内建 skill**：只能做“高相似兼容”，很难做到 100% 原生等价，因为它们依赖 Claude Code 自己的原生工具、权限语义、agent 类型和执行环境

## 2. 为什么现在还做不到

### 2.1 当前系统是“平台先激活 skill”

现状：

- Desktop 把 skill 加载成内部 `SkillManifest`
- Gateway 在 run 前先 `activateSkills()`
- skill 激活后再注入 prompt / tool pin / workflow gate

对应代码：

- `apps/desktop/electron/skill-loader.mjs`
- `packages/agent-core/src/skills.ts`
- `apps/gateway/src/agent/runFactory.ts`

而 Claude Code 的标准行为是：

- 启动时只把所有 skill 的 `name + description` 暴露给模型
- 模型觉得相关时才调用 skill
- 触发后才加载完整 `SKILL.md`

这意味着我们缺的是：

- 一个 **Skill index / Skill activation tool**
- 一个 **渐进加载（progressive disclosure）运行时**

### 2.2 当前 `/skill` 不是 Claude 的 slash skill

我们现在 `/` 只是：

- 选 skill
- 插入 mention
- 发送后变成 `skillRefs`

Claude Code 的 `/skill-name args...` 是真正的一等调用语义，支持：

- 仅用户可调
- 仅模型可调
- 参数替换 `$ARGUMENTS`
- autocomplete hint

这意味着我们要补：

- slash parser
- 参数传递
- “手动调”和“模型调”的独立门控

### 2.3 工具名和权限模型不是一套

Claude Code 常见工具名：

- `Read`
- `Write`
- `Edit`
- `Grep`
- `Glob`
- `Bash`
- `WebFetch`

我们内部工具名：

- `read`
- `write`
- `edit`
- `project.search`
- `project.searchPaths`
- `project.listFiles`
- `code.exec`
- `web.fetch`
- `kb.search`
- `run.done`

所以 `allowed-tools: Read, Grep, Glob` 拿到我们这里，当前没有直接语义。

### 2.4 Claude Code skill 有一些我们没接的 frontmatter / 运行时能力

Claude Code 官方文档明确有这些字段：

- `argument-hint`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `model`
- `context: fork`
- `agent`
- `hooks`

我们当前真正支持的是我们自己的：

- `priority`
- `auto-enable`
- `triggers`
- `activation-mode`
- `tool-caps`
- `workflow`
- `pipeline`
- `mcp`

所以当前不是“缺几个字段”，而是**协议和执行模型都有偏差**。

## 3. 真正要做的兼容层

## 3.1 第一层：目录与发现兼容

目标：Claude/Agent Skills 生态里的 skill 放到常见位置后，我们能自动发现。

### 必须新增

扫描目录从现在的：

- `<userData>/skills`

扩展为：

- `~/.claude/skills`
- `.claude/skills`
- 祖先目录中的嵌套 `.claude/skills`
- `~/.agents/skills`
- `.agents/skills`
- 用户配置的附加目录
- Marketplace / plugin skill 安装目录

### 额外建议

按优先级合并：

- enterprise > personal > project > nested-project > plugin > local-userdata

同时保留我们自己的 `<userData>/skills`，作为“本产品私有安装目录”。

### 主要改动点

- `apps/desktop/electron/skill-loader.mjs`
- skill loader IPC / watch 机制

## 3.2 第二层：SKILL.md 解析兼容

目标：Claude Code / Agent Skills skill 原样 frontmatter 不报错、不丢关键信息。

### 必须支持的标准字段

- `name`
- `description`
- `license`

### 必须支持的 Claude Code 扩展字段

- `argument-hint`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `model`
- `context`
- `agent`
- `hooks`

### 处理原则

1. **标准字段原样保留**
2. **Claude 扩展字段原样保留**
3. **我们自己的 manifest 字段降级为可选扩展**
4. 不认识的字段进入 `extensions` / `vendorMetadata`，不要直接丢弃

### 建议的内部结构

把当前 `SkillManifest` 拆成两层：

#### A. `PortableSkillManifest`

对齐 Agent Skills / Claude Code：

- `name`
- `description`
- `license`
- `argumentHint`
- `disableModelInvocation`
- `userInvocable`
- `allowedTools`
- `model`
- `context`
- `agent`
- `hooks`
- `vendorMetadata`

#### B. `RuntimeSkillManifest`

我们自己的运行时增强：

- `id`
- `priority`
- `autoEnable`
- `activationMode`
- `triggers`
- `toolCaps`
- `workflow`
- `pipeline`
- `mcp`
- `ui`

也就是：

- **先保真解析便携 skill**
- **再按我们平台需要编译成 runtime manifest**

### 主要改动点

- `apps/desktop/electron/skill-loader.mjs`
- `packages/agent-core/src/skills.ts`

## 3.3 第三层：触发与调用语义兼容

目标：支持 Claude Code 那种“默认模型自主调用 + `/skill args` 显式调用 + 可禁自动调用”。

### 必须新增的行为

#### A. 默认模式：模型自主触发

要补一个 Skill 发现机制：

- run 开始时只给模型一份精简 skill index
- 每条 skill 只提供：
  - `name`
  - `description`
  - 是否可用户调用
  - 是否可模型调用
  - 参数 hint

然后让模型自己决定是否调用某个 skill。

这在实现上有两种方案：

1. **显式 `Skill` 工具**
   - 类似 Claude Code，模型先调 `Skill(name, args)`，再由运行时加载 skill
2. **隐式 selector**
   - 在编排器里做一层 model-assisted selection，但从行为上模拟 Claude 的 Skill tool

要做到“Claude skill 原样可用”，推荐直接上 **显式 `Skill` 工具**。

#### B. `/skill-name args...` 显式调用

当前 `/` UI 需要从“mention”升级为“skill command”：

- 输入 `/fix-issue 123`
- 解析 skill name = `fix-issue`
- args = `123`
- 运行时显式 invoke 该 skill

#### C. 支持 `disable-model-invocation`

语义要和 Claude Code 保持一致：

- `disable-model-invocation: true`
  - 模型不能自动调用
  - skill description 不进入模型的可用 skill 列表
  - 用户仍可 `/skill-name`

#### D. 支持 `user-invocable`

- `user-invocable: false`
  - 不显示在 `/` 菜单
  - 但模型仍可在后台自动调

### 主要改动点

- `apps/desktop/src/ui/components/SlashPopover.tsx`
- `apps/desktop/src/ui/components/InputBar.tsx`
- `apps/desktop/src/ui/components/ChatArea.tsx`
- `apps/gateway/src/agent/runFactory.ts`
- 新增 `Skill` 调用协议

## 3.4 第四层：工具名和权限语义兼容

目标：Claude skill 里的 `allowed-tools` 和脚本文案里的工具名，在我们平台能映射到真实能力。

### 必须做一个 Claude Tool Alias 层

建议建立一张映射表：

| Claude Code | 我们内部 |
|---|---|
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Glob` | `project.searchPaths` 或新增真正 `glob` 工具 |
| `Grep` | `project.search` 或新增真正 `grep` 工具 |
| `WebFetch` | `web.fetch` |
| `Bash` | `code.exec` / 新增 `shell.exec` Claude-compatible alias |
| `Task` / `Skill` 相关 | `spawn_agent` / 新增专门 skill activation tool |

### 但这里有一个关键决策

要不要只做“别名映射”，还是直接补一套 Claude 风格工具面？

我的建议是：

#### 对用户透明层

补一层 Claude 兼容工具名：

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `Bash`
- `WebFetch`
- `Skill`

#### 对内部执行层

再转到我们自己的：

- `read`
- `write`
- `edit`
- `project.searchPaths`
- `project.search`
- `code.exec` / `shell.exec`
- `web.fetch`

这样 Claude skill 内容和 `allowed-tools` 才能原样跑。

### 权限语义也要兼容

Claude Code 的 `allowed-tools` 不是“推荐工具”，而是“skill 激活期间可直接使用这些工具，无需逐次审批”。

所以我们不能再简单复用当前：

- `toolCaps.allowTools = pin tools`

而要增加一层：

- skill-scoped permission envelope

即：

- skill 激活时，允许工具集合 = 基础权限 ∩ skill allowed-tools 映射 + 必要保底工具

### 主要改动点

- `packages/tools/src/index.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/contextAssembler.ts`
- tool routing / permission 模块

## 3.5 第五层：资源加载、相对路径与动态上下文兼容

目标：Claude skill 里的相对文件引用、`scripts/`、`references/`、动态上下文语法能直接工作。

### A. 相对路径语义

Claude / Agent Skills 约定：

- skill 根目录是当前工作目录参考点
- `scripts/foo.py`
- `references/REFERENCE.md`
- `[FORMS.md](FORMS.md)`

这些都要从 skill root 解析。

我们当前只有“skill loader 读 body + 读 context-prompt”这种静态解析，不够。

需要新增：

- skill root runtime context
- skill-relative file resolver
- 打开/读取资源文件的 helper

### B. Progressive disclosure

Claude 的典型行为：

1. 先只加载 `name + description`
2. skill 触发后才加载 `SKILL.md`
3. 需要时才加载 `references/` / `assets/`

我们要接近这个行为，至少要做：

- 不再把所有 skill body 预先编进系统 prompt
- 激活 skill 时动态注入 body
- body 里引用的资源按需读取

### C. `!` 预处理命令

Claude Code 支持：

```md
- PR diff: !`gh pr diff`
```

这不是模型自己执行，而是运行时先替换成命令输出。

要兼容这个能力，需要在 skill activation 时增加一个预处理步骤：

1. 扫描 `!`command`` 占位
2. 用 skill-scoped allowed tools / shell permission 执行
3. 把 stdout 注入渲染后的 skill prompt

### D. `$ARGUMENTS` 替换

至少要支持：

- `$ARGUMENTS`
- `$ARGUMENTS[0]`
- `$1`

### 主要改动点

- 新增 skill renderer / skill runtime resolver
- `apps/gateway/src/agent/runFactory.ts`
- 可能新增 `packages/agent-core/src/skillRuntime.ts`

## 3.6 第六层：Claude `context: fork` / `agent` 兼容

目标：Claude Code 里那些指定 fork subagent 的 skill 能直接运行。

### 必须做的事

#### A. 支持 `context: fork`

语义：

- skill 不在主上下文 inline 跑
- 而是 fork 一个隔离上下文
- skill body 作为 subagent 的任务 prompt

#### B. 支持 `agent`

Claude Code 示例里常见：

- `agent: Explore`

我们当前没有 Claude 同名 agent profiles，所以要加一层映射：

| Claude agent | 我们建议 |
|---|---|
| `Explore` | 新增 `explorer` / 只读代码研究 agent |
| `Plan` | 新增 `planner` |
| `Implement` / 近似 | 现有 worker / copywriter 这类执行 agent |

注意：这不是把字符串接上就行，而是要补：

- 工具集
- 默认模型
- 权限边界
- 输出契约

#### C. skill 作为 subagent task prompt

Claude 的 `context: fork` 语义里：

- skill body 本身就是任务 prompt
- 不是“加载 skill 当参考资料”

这和我们当前把 skill 当 prompt fragment 的方式不同，需要单独实现。

### 主要改动点

- `packages/agent-core/src/subAgent.ts`
- collab / spawn_agent runtime
- 新增 Claude-compatible agent profiles

## 4. 哪些 Anthropic skill 能原样兼容，哪些不能

## 4.1 能做到高兼容的

### A. 纯知识/规范型 skill

例如：

- coding conventions
- brand guidelines
- API conventions

条件：

- 只靠 `description + body + references/`
- 不依赖 Claude 特定工具语法

这类 skill 做完前 3 层基本就能跑。

### B. 文档/脚本型 skill

例如 Anthropic 官方 repo 里的：

- `docx`
- `pdf`
- `pptx`
- `xlsx`
- `frontend-design`

条件：

- 我们补齐相对路径、scripts、allowed-tools、arguments

这类 skill 做完前 5 层，能达到较高兼容。

## 4.2 只能做近似兼容的

### A. 依赖 Claude 原生 agent 类型的

例如：

- `context: fork`
- `agent: Explore`

需要我们自己造等价 agent profile。

### B. 依赖 Claude 原生权限语义或内建能力的

例如：

- `allowed-tools: Bash(gh *)`
- built-in command / bundled skill 的特殊行为

需要我们补 permission parser + shell alias + maybe git/gh wrappers。

### C. Anthropic bundled skills

像 `/batch` 这种技能，本质上依赖 Claude Code 自己的：

- worktree orchestration
- PR / git 流程
- 并行 agent 团队执行模型

这类不能靠“skill 兼容层”自动获得，需要产品级 runtime 对齐。

## 5. 我建议的实施顺序

## Phase 1：先做到“Agent Skills 标准兼容”

目标：

- `~/.claude/skills` / `.claude/skills` / `.agents/skills` 可发现
- 原生 `name/description/license` 可解析
- skill body + references + scripts 相对路径可用
- `$ARGUMENTS` 可替换
- `/skill args` 可显式调用

这一步完成后，大多数“轻 skill”就能直接跑。

## Phase 2：补 Claude Code frontmatter 兼容

目标：

- `argument-hint`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `model`
- `context`
- `agent`
- `hooks`

这一步完成后，大多数 Claude Code 自定义 skill 可以无改动使用。

## Phase 3：补工具别名和权限语义

目标：

- 新增 Claude tool aliases
- `allowed-tools` 真正生效
- Skill tool / invocation permission 生效

这是“看着兼容”变成“真能跑”的关键一步。

## Phase 4：补 `context: fork` 与 Claude agent profiles

目标：

- `context: fork` skill 可跑
- `agent: Explore/Plan/...` 有等价 profile

这一步完成后，Anthropic repo 里相当一部分 skill 才能真正直用。

## Phase 5：补 `!` 动态上下文预处理和 bundled skill 特殊能力

目标：

- `!`command`` 预渲染
- shell / gh / git 场景更像 Claude Code
- 评估是否需要兼容 Anthropic bundled skills 的专项 runtime

## 6. 落到代码层，最值得先改哪些文件

### 第一批一定会动的

- `apps/desktop/electron/skill-loader.mjs`
- `packages/agent-core/src/skills.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/desktop/src/ui/components/SlashPopover.tsx`
- `apps/desktop/src/ui/components/InputBar.tsx`
- `apps/desktop/src/ui/components/ChatArea.tsx`

### 大概率需要新增/重构的模块

- `packages/agent-core/src/portableSkillManifest.ts`
- `packages/agent-core/src/skillRuntime.ts`
- `packages/agent-core/src/claudeSkillCompat.ts`
- `packages/tools/src/claudeToolAliases.ts`

### 后续会影响的

- `packages/agent-core/src/subAgent.ts`
- permission / tool routing 模块
- marketplace / plugin skill 安装逻辑

## 7. 我建议你怎么定目标

如果你要的是真正可交付、风险可控的目标，我建议不要一上来喊“100% Claude Code parity”，而是拆成三个产品口径：

### 目标 A：Portable Skill Compatible

支持：

- Agent Skills 标准
- 大多数纯知识型 / 脚本型 skill

这是最稳的第一步。

### 目标 B：Claude Code Custom Skill Compatible

支持：

- Claude Code frontmatter
- `/skill args`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `context: fork`
- `agent`

这一步已经很有产品价值。

### 目标 C：Anthropic Bundled Skill Parity

支持：

- `/batch` 这类 Anthropic 官方复杂 skill

这其实是单独的大项目，不建议和前两步绑死。

## 8. 我对这件事的最终判断

如果你的目标是：

- “社区里大多数 Claude Code 自定义 skill 目录直接拷进来就能用”

那是**可以做的**，但必须把 skill 从“prompt fragment manifest”升级成“可发现、可激活、可渲染、可隔离执行的运行时对象”。

如果你的目标是：

- “Anthropic 官方所有 skill，包括 bundled skills，也都完全原生一样”

那就不是 skill loader 改造，而是 **Claude Code runtime parity** 项目。

## 9. 推荐的下一步

最值得先做的不是直接写实现，而是先产一份 **兼容契约 spec**，明确：

1. 我们支持哪些 Claude 字段
2. 字段如何映射到内部 runtime
3. 哪些是完全兼容
4. 哪些是 best-effort
5. 哪些暂不支持

然后按 Phase 1 -> 2 -> 3 做，不然会很容易在 loader、UI、Gateway 三头同时返工。

