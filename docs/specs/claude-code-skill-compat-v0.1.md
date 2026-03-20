# Claude Code Skill Compatibility v0.1

> 状态：draft
> 日期：2026-03-20
> 目标：让 Claude Code / Agent Skills 生态中的 skill 目录在 writing-ide 中“尽量无需修改即可使用”，先完成可发现、可加载、可显式调用、可映射工具权限的最小闭环。

## 1. 背景

当前仓库已经采用 `SKILL.md` 文件壳，但 skill 的真实运行时仍是本项目自定义的 `SkillManifest + activateSkills() + toolCaps + workflow` 体系。

Claude Code / Agent Skills 的核心范式不同：

1. Skill 是便携目录，至少包含 `SKILL.md`
2. 平时只暴露 `name + description`
3. 由模型自主决定是否调用 skill，或由用户显式 `/skill-name`
4. skill 触发后再加载 body / references / scripts

本规范定义一套兼容层，把这两套机制桥接起来。

## 2. 范围

### 2.1 v0.1 目标

v0.1 必须完成：

1. 发现常见 Claude / Agent Skills 目录
2. 无损解析 `SKILL.md` 中的 Claude / Agent Skills frontmatter
3. 让 portable skill 默认进入“安全显式模式”，避免误自动激活
4. 支持用户输入 `/skill-name args...` 显式调用
5. 支持 `$ARGUMENTS` / `$1` 等基本参数替换
6. 支持 `allowed-tools` 到内部工具名的基础映射
7. 在 skill prompt 中注入 Claude tool alias 说明，降低模型误调工具名概率

### 2.2 v0.1 非目标

v0.1 不要求完成：

1. Claude Code 等价的模型自主 skill 选择器
2. `context: fork` 的完整原生语义
3. `agent: Explore` 等 Claude agent profile 的完整对齐
4. `!``command``` 预渲染
5. Anthropic bundled skills 的完全等价执行

这些放到后续版本。

## 3. 兼容等级

定义三档兼容目标：

### L1: Portable Skill Compatible

适用于：

- Agent Skills 标准 skill
- 纯知识型 / 规范型 skill
- 多数只依赖 `SKILL.md + references + scripts` 的 skill

要求：

- 原目录可发现
- frontmatter 可解析
- `/skill-name args...` 可显式调用

### L2: Claude Code Custom Skill Compatible

适用于：

- 使用 Claude Code 自定义 frontmatter 的 skill

要求：

- 支持 `argument-hint`
- 支持 `disable-model-invocation`
- 支持 `user-invocable`
- 支持 `allowed-tools`
- 支持基础参数注入

### L3: Claude Runtime Parity

适用于：

- Anthropic bundled skills
- 依赖原生 agent / fork / permissions / shell grammar 的复杂 skill

不在 v0.1 范围内。

## 4. 发现规则

## 4.1 扫描目录

Desktop `SkillLoader` 需要扫描以下目录：

1. `<userData>/skills`
2. `~/.claude/skills`
3. `~/.agents/skills`

后续版本再加入：

- 项目级 `.claude/skills`
- 项目级 `.agents/skills`
- 嵌套祖先目录扫描
- plugin / marketplace roots

## 4.2 优先级

当同一 skill id 在多个 root 重名时，按如下优先级保留第一个：

1. `<userData>/skills`
2. `~/.claude/skills`
3. `~/.agents/skills`

## 5. 数据模型

## 5.1 PortableSkillManifest

新增“便携 skill”视角，字段如下：

```ts
type PortableSkillManifest = {
  name: string;
  description: string;
  license?: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  model?: string;
  context?: string;
  agent?: string;
  hooks?: unknown;
  inputSchema?: unknown;
  vendorMetadata?: Record<string, unknown>;
};
```

## 5.2 RuntimeSkillManifest

现有 `SkillManifest` 继续保留，新增下列兼容字段：

```ts
type SkillManifest = {
  // existing fields...
  license?: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  model?: string;
  context?: string;
  agent?: string;
  hooks?: unknown;
  inputSchema?: unknown;
  vendorMetadata?: Record<string, unknown>;
  portable?: boolean;
};
```

### 5.2.1 portable 判定

满足以下任一条件时，skill 视为 portable skill：

1. 含 Claude / Agent Skills 特有字段：
   - `allowed-tools`
   - `argument-hint`
   - `disable-model-invocation`
   - `user-invocable`
   - `input-schema`
   - `context`
   - `agent`
   - `hooks`
2. 没有我们自己的运行时字段：
   - `triggers`
   - `workflow`
   - `pipeline`
   - `tool-caps`

## 6. 自动激活安全规则

这是 v0.1 的强约束。

### 6.1 背景问题

当前 `activateSkills()` 逻辑里，如果 skill：

- `autoEnable=true`
- `triggers=[]`

则它会被视为“条件满足”，导致所有仅含 `name + description` 的 Claude skill 在每轮自动激活。

### 6.2 v0.1 规则

portable skill 在未显式声明本项目触发规则前，默认：

- `autoEnable=false`
- `activationMode="explicit"`

例外：

1. frontmatter 明确写了本项目兼容字段：
   - `auto-enable`
   - `activation-mode`
   - `triggers`
2. 后续版本引入模型自主 `Skill` 选择器后，再支持自动调用

## 7. 显式调用协议

## 7.1 用户协议

输入框支持：

```text
/skill-name args...
```

解析规则：

1. 仅在消息起始位置解析
2. `skill-name` 匹配 skill `id` 或 `name`
3. 剩余文本作为 `arguments`

结果：

- skill 被视为显式激活
- `arguments` 不直接拼入普通 prompt，而作为 skill invocation 参数单独传递

## 7.2 Desktop -> Gateway 传输字段

在 `run.request.payload` 中新增：

```ts
skillInvocations?: Array<{
  id: string;
  arguments?: string;
  source?: "slash";
}>;
```

规则：

1. `skillRefs` 仍表示“显式激活 skill”
2. `skillInvocations` 表示“显式激活 + 带参数调用”
3. `skillInvocations.id` 必须与 `skillRefs.id` 对齐

## 8. 参数替换规则

当 skill 被显式调用且存在 `arguments` 时：

1. 渲染 `promptFragments.system` / skill body 前，先做参数替换
2. v0.1 支持以下占位符：

```text
$ARGUMENTS
$1
```

替换语义：

- `$ARGUMENTS` -> 整段参数文本
- `$1` -> 与 `$ARGUMENTS` 相同（v0.1 先不支持分词位置参数）

未传参数时替换为空串。

## 9. 工具兼容

## 9.1 Claude Tool Alias -> Internal Tool 映射

v0.1 采用 best-effort 映射：

| Claude Code | writing-ide |
|---|---|
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Glob` | `project.searchPaths` |
| `Grep` | `project.search` |
| `Bash` | `shell.exec` |
| `WebFetch` | `web.fetch` |
| `Task` | `spawn_agent` |

说明：

1. 若 `allowed-tools` 含 specifier，例如 `Bash(npm test *)`，v0.1 仅提取基础工具名 `Bash`
2. specifier 级权限约束暂不实现
3. 无法映射的工具先原样保留在 `allowedTools`，但不进入内部 `toolCaps.allowTools`

## 9.2 `allowed-tools` 生效方式

v0.1 先做基础兼容：

1. 将映射结果写入 `toolCaps.allowTools`
2. 原始值保留在 `allowedTools`
3. skill 渲染时附加兼容提示：

```text
Claude Code tool aliases in this environment:
Read -> read
Write -> write
Edit -> edit
Glob -> project.searchPaths
Grep -> project.search
Bash -> shell.exec
WebFetch -> web.fetch
Task -> spawn_agent
```

完整的 skill-scoped permission envelope 留到后续版本。

## 10. `user-invocable` / `disable-model-invocation`

## 10.1 `user-invocable`

规则：

- `user-invocable: false`
  - Slash 列表中隐藏
  - 用户输入 `/skill-name` 时视为不可调用

默认值：

- `true`

## 10.2 `disable-model-invocation`

v0.1 规则：

- `disable-model-invocation: true`
  - portable skill 不参与自动激活
  - 只能通过显式 `/skill-name` 调用

默认值：

- `portable skill`：等价于 `true`，因为 v0.1 尚未实现模型自主 skill 选择器
- `本项目 native skill`：沿用现有 `autoEnable + triggers`

## 11. UI 规则

### 11.1 Slash 列表

Slash 列表展示：

- command label: `/{id}`
- description
- `argumentHint`（如果有）

选择 skill 后，插入：

```text
/{id} 
```

而不是 mention chip。

### 11.2 Mention 兼容

现有 mention chip skill 保留，用于本项目 native skill 的显式激活。

两套机制共存：

1. `@skill` / slash chip：现有机制
2. `/skill-name args`：Claude-compatible 显式调用

## 12. 实施拆分

## Phase 1

1. 发现目录兼容
2. portable frontmatter 解析
3. 安全 explicit-only 规则

DoD：

- `~/.claude/skills/<name>/SKILL.md` 能显示在技能列表里
- 不会自动激活所有 portable skill

## Phase 2

1. `/skill-name args` 显式调用
2. `skillInvocations` 传输
3. `$ARGUMENTS` 渲染

DoD：

- 输入 `/docx 写一份周报` 能触发 `docx` skill，正文 prompt 为“写一份周报”，skill body 中 `$ARGUMENTS` 被替换

## Phase 3

1. `allowed-tools` 基础映射
2. alias 提示注入
3. `user-invocable` 生效

DoD：

- Claude portable skill 中的 `allowed-tools` 能映射为内部 `toolCaps.allowTools`
- `user-invocable: false` 不出现在 slash 列表

## 13. 验证清单

1. 在 `~/.claude/skills/test-skill/SKILL.md` 放入最小 portable skill：
   - `name`
   - `description`
   - body
   应能被列出，但不应自动激活
2. 输入 `/test-skill hello`
   - 应显式激活该 skill
   - `$ARGUMENTS` 应被替换为 `hello`
3. `allowed-tools: [Read, Bash]`
   - 应映射为 `read`, `shell.exec`
4. `user-invocable: false`
   - slash 列表中隐藏

