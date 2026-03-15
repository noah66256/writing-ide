# Feature Spec: skill-creator 内置技能

> spec v1 · 2026-03-16

## 一、需求概述

### 需求卡片

**场景**：Crab 用户想创建自定义技能来扩展 Agent 能力，但不熟悉 SKILL.md 格式和写法规范

**目标**：Crab 的 Agent 作为"技能创建助手"，引导用户完成技能开发闭环

**P0（首版交付）**：
1. 意图捕获 + 访谈 → 生成标准 SKILL.md
2. 感知当前可用工具（内置工具 + 已连接 MCP 工具），在 `tool-caps` 中合理引用
3. 写作指南 + 目录结构规范 → 保证技能质量
4. 手动测试 + Agent 协助评估 → 迭代改进
5. 直接写入 `userData/skills/` → 热加载即时生效

**P1（子 Agent 上线后对齐）**：
- 自动化测试闭环（spawn with-skill / without-skill 对比运行）
- 量化评分 + Eval Viewer
- Description 触发优化（train/test 循环）
- Blind A/B 比较 / Grader / Analyzer

**对标**：[Anthropic skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)

**约束**：
- 作为 Crab 内置技能（bundled skill）运行
- P0 无子 Agent，测试走手动模式
- 工具感知只读取已有清单，不创建新的 MCP Server

## 二、现状分析

### 相关文件

| 文件 | 职责 | 与需求的关系 |
|---|---|---|
| `apps/desktop/electron/skill-loader.mjs:308-368` | `loadOne()` 加载单个技能 | skill-creator 生成的文件必须通过此校验 |
| `apps/desktop/electron/skill-loader.mjs:215-291` | `parseManifest()` 字段校验 | 定义了合法的 SKILL.md 字段约束 |
| `apps/desktop/electron/skill-loader.mjs:75-100` | `parseSkillMarkdown()` | frontmatter + body 解析规则 |
| `apps/desktop/electron/skill-loader.mjs:400-577` | `SkillLoader` 类 | 热加载机制，创建技能后即时生效 |
| `apps/desktop/electron/main.cjs:3509-3562` | bundled skills seed | 自动同步 `bundled-skills/` 到 `userData/skills/` |
| `packages/agent-core/src/skills.ts:33-61` | `SkillManifest` 类型定义 | skill-creator 的输出目标格式 |
| `packages/agent-core/src/skills.ts:6-9` | `TriggerRule` / `TriggerWhen` | 合法触发类型 |
| `packages/tools/src/index.ts:97-1412` | `TOOL_LIST`（57 个内置工具） | skill-creator 需感知的工具清单 |
| `apps/desktop/electron/bundled-skills/docx/SKILL.md` | bundled skill 示例 | 可作为生成参考模板 |

### 已有设施（可直接复用）

| 设施 | 位置 | 用途 |
|---|---|---|
| `tools.search` | TOOL_LIST 内置 | 搜索可用工具（内置 + MCP） |
| `tools.describe` | TOOL_LIST 内置 | 获取工具详细规格 |
| `write` / `read` / `edit` | TOOL_LIST 内置 | 文件读写 |
| SkillLoader 热加载 | `skill-loader.mjs:539-576` | 双层 fs.watch + 200ms 防抖 |
| bundled skills seed | `main.cjs:3509-3562` | 自动同步到 userData |
| `/` 弹出列表 | `SlashPopover.tsx` + `InputBar.tsx:57` | 新建的技能自动出现在列表中 |

### 调研摘要

**对标：Anthropic skill-creator**
- 完整闭环：意图捕获 → 访谈 → SKILL.md 生成 → 测试（spawn 子 agent）→ 评分 → 迭代 → Description 优化 → 打包
- 依赖 `claude -p` CLI 子进程 spawn 子 agent 运行测试
- 有完整的 eval 框架（evals.json、grading.json、benchmark.json）
- 有 HTML eval-viewer 用于人工审阅
- 有 Description 优化循环（train/test split + 自动迭代）

**Crab 适配策略**
- P0 取创建引导 + 写作规范 + 工具发现 + 迭代改进（纯 prompt 驱动）
- P1 取测试闭环 + 评分 + 比较（等子 Agent 上线）
- 不做 .skill 打包（Crab 用目录模式 + 热加载）
- 不做 Description 自动优化（依赖 `claude -p`）

**Claude Code 官方 Skill 最佳实践**
- Progressive Disclosure：name+description 始终在上下文（~100 tokens/skill），body 按需加载（<5k tokens），references 按需读取
- Description 是触发核心：要"pushy"，明确列出使用场景
- SKILL.md body 控制在 500 行以内
- 支持文件放 references/、scripts/、assets/
- 解释 why 而非堆 MUST/NEVER

Sources:
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills)
- [Skill authoring best practices - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic skills repo](https://github.com/anthropics/skills)

## 三、实施方案

### 架构设计

skill-creator 是一个**纯 prompt 驱动的 bundled skill**：
- 不需要 MCP Server
- 不需要脚本
- 不需要修改任何现有代码
- 只需要 Agent 能读写文件 + 搜索工具

```
apps/desktop/electron/bundled-skills/skill-creator/
├── SKILL.md                              ← 主文件（frontmatter + body）
└── references/
    ├── skill-writing-guide.md            ← SKILL.md 写作规范
    └── crab-tools.md                     ← Crab 工具速查表
```

### Fix 1（P0）：创建 SKILL.md 主文件

**文件**：`apps/desktop/electron/bundled-skills/skill-creator/SKILL.md`

**改动类型**：新增

**Frontmatter 设计**：

```yaml
---
name: skill-creator
display-name: "技能创作助手"
description: "帮助创建、改进和迭代 Crab 技能（SKILL.md）。触发词：创建技能、新增skill、技能模板、设计技能、改进技能"
version: "1.0.0"
priority: 60
auto-enable: true
builtin: true
kind: workflow
activation-mode: hybrid
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(创建.*技能|新增.*skill|skill[-_ ]?creator|技能模板|写.*SKILL\\.md|设计.*技能|改进.*技能|修改.*技能|make.*skill|create.*skill)"
ui:
  badge: "SKILL"
  color: "purple"
tool-caps:
  allow-tools:
    - "tools.search"
    - "tools.describe"
    - "read"
    - "write"
    - "edit"
    - "mkdir"
    - "doc.snapshot"
    - "doc.previewDiff"
---
```

**Body 结构**（完整内容见附录 A）：

| 章节 | 职责 |
|---|---|
| 角色与目标 | 定义 skill-creator 的身份和核心能力 |
| 工作流程总览 | 7 步闭环：识别模式 → 访谈 → 工具发现 → 设计 manifest → 展示草稿 → 写入 → 迭代 |
| 阶段 1：访谈需求 | 5 个高价值问题模板，锁定范围/角色/完成标准 |
| 阶段 2：工具发现 | 用 `tools.search` + `tools.describe` 动态发现，参考 `crab-tools.md` |
| 阶段 3：设计 Manifest | frontmatter 字段逐一指导（name/triggers/tool-caps/priority 等） |
| 阶段 4：生成与写入 | proposal-first 模式：展示草稿 → 确认 → mkdir + write |
| 阶段 5：迭代改进 | read 现有 → 对比反馈 → 最小改动 → 版本递增 |
| P1 预留 | 测试与自动化挂钩点模板 |

**关键设计决策**：

1. **工具发现不硬编码** — 每次通过 `tools.search` 动态发现，确保 MCP 工具也能被感知
2. **proposal-first 写入** — 先展示完整草稿 + diff，用户确认后才落盘
3. **`builtin: true` 防误用** — body 中明确告知 Agent，用户自建技能不应加 `builtin` 字段
4. **P1 预留模板** — 每个生成的技能都包含"测试与自动化"小节，为子 Agent 上线做准备

### Fix 2（P0）：创建写作规范参考文档

**文件**：`apps/desktop/electron/bundled-skills/skill-creator/references/skill-writing-guide.md`

**改动类型**：新增

**内容概要**（完整内容见附录 B）：

| 章节 | 内容 |
|---|---|
| 1. Skill 的定位 | 角色+工作流定义；三种 kind（workflow/hint/service） |
| 2. Frontmatter 设计 | 命名约定、priority 分层、activation-mode 选择、triggers 写法、tool-caps 策略 |
| 3. Body 写作 | 推荐结构（角色→场景→流程→工具→交互→测试）；写作风格（用"你"、解释 why） |
| 4. 迭代与版本管理 | 语义版本策略；变更日志 |
| 5. P1 测试预留约定 | 手动用例模板；自动化测试挂钩结构 |

**来源**：
- Anthropic 官方 Skill authoring best practices
- Crab SKILL.md 格式规范（`feat-skill-md-format-migration-v1.md`）
- 现有 bundled skills 实践

### Fix 3（P0）：创建工具速查表

**文件**：`apps/desktop/electron/bundled-skills/skill-creator/references/crab-tools.md`

**改动类型**：新增

**内容概要**（完整内容见附录 C）：

按 10 个分类整理 57 个内置工具 + MCP 工具命名规则：

| 分类 | 工具 | 备注 |
|---|---|---|
| 时间与记忆 | `time.now`, `memory` | |
| 风格与文案 | `style_imitate.run`, `lint.copy`, `lint.style` | `style_imitate.run` 为编排工具，普通 skill 不应直接引用 |
| 工具发现 | `tools.search`, `tools.describe` | |
| Web 访问 | `web.search`, `web.fetch` | |
| 知识库 | `kb.*` 系列（7 个） | |
| Run 编排 | `run.*` 系列（5 个） | |
| 文件操作 | `read`, `write`, `edit`, `mkdir`, `rename`, `delete` + `doc.snapshot`, `doc.previewDiff`, `doc.splitToDir` | |
| 项目操作 | `project.listFiles`, `project.search`(deprecated), `file.open` | |
| 代码执行 | `code.exec`, `shell.exec`, `process.*`(3个) | 高风险标注 |
| 定时任务 | `cron.create`, `cron.list` | 高风险标注 |
| MCP 工具 | `mcp.<server>.<tool>` 格式 | 实例：`mcp.playwright.*`, `mcp.bocha-search.*`, `mcp.web-search.*` |

## 四、影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|---|---|---|---|
| 新增 `bundled-skills/skill-creator/` 目录（3个文件） | bundled skills seed | **无** | 纯增量，seed 逻辑自动遍历子目录（`main.cjs:3534`） |
| skill-loader 加载新 skill | `SkillLoader.reload()` | **极低** | 与 docx/xlsx/pptx/pdf 走完全相同路径 |
| `tool-caps` 声明 8 个工具 | per-turn 工具选择 | **极低** | 只在 skill 激活时影响 `baseAllowedToolNames` |
| references/ 子目录 | SkillLoader | **无** | loader 只关心 SKILL.md，忽略其他文件 |
| text_regex 触发 | `activateSkills()` | **低** | 正则范围合理，不与现有 4 个 skill 冲突 |
| priority: 60 | 技能排序 | **极低** | 高于默认 50，低于 style_imitate(100) |

**结论**：零代码改动，纯增量文件，无回归风险。

## 五、验证 Checklist

### 安装 & 构建

- [ ] `npm run dev:electron` 启动无报错
- [ ] DevTools 控制台确认 `[SkillLoader] started: 5 skill(s)`（原 4 + 新增 1）

### 新 Skill 加载

- [ ] skill-creator manifest 字段正确：
  - id = `skill-creator`
  - name / display-name / priority / autoEnable / triggers / ui 与 SKILL.md 一致
  - promptFragments.system 包含完整 body 内容
- [ ] references/ 目录下的 md 文件存在且可被 Agent 通过 `read` 访问

### `/` 弹出列表

- [ ] 输入框打 `/` 弹出技能列表
- [ ] 搜索 `skill` 能找到"技能创作助手"
- [ ] 选择后 chip 正确插入

### text_regex 触发

- [ ] 输入"帮我创建一个技能" → skill-creator 自动激活
- [ ] 输入"帮我写个报告" → skill-creator 不被激活（docx 应激活）

### 场景验证

| # | 场景 | 预期 |
|---|---|---|
| 1 | 对话中说"帮我创建一个写周报的技能" | skill-creator 激活，进入访谈流程 |
| 2 | `/skill-creator` 手动调用 | 显式激活，直接进入流程 |
| 3 | Agent 调用 `tools.search` | 返回内置 + MCP 工具列表 |
| 4 | Agent 用 `write` 写入 `skills/<name>/SKILL.md` | 文件创建成功，热加载生效 |
| 5 | 新技能出现在 `/` 列表中 | 不重启即可看到 |
| 6 | 用户回来说"改一下那个技能的触发条件" | Agent 读取现有 SKILL.md → 展示 diff → 确认后更新 |
| 7 | 输入"帮我写个 Word 文档" | docx 技能激活，skill-creator 不激活 |

## 六、实施优先级

| 优先级 | 改动 | 理由 |
|---|---|---|
| P0 | Fix 1（SKILL.md 主文件） | 核心功能 |
| P0 | Fix 2（写作规范参考文档） | body 中引用，Agent 按需读取 |
| P0 | Fix 3（工具速查表） | body 中引用，Agent 按需读取 |
| P1 | 子 Agent 测试闭环 | 等子 Agent 架构上线后补齐 |
| P1 | Eval 框架（evals.json、grading.json） | 对标 Anthropic skill-creator 的测试评估链路 |
| P2 | Description 自动优化 | 依赖 CLI 子进程能力 |

## 七、涉及文件清单

| 文件 | 改动类型 |
|---|---|
| `apps/desktop/electron/bundled-skills/skill-creator/SKILL.md` | 新增 |
| `apps/desktop/electron/bundled-skills/skill-creator/references/skill-writing-guide.md` | 新增 |
| `apps/desktop/electron/bundled-skills/skill-creator/references/crab-tools.md` | 新增 |

无需修改任何现有文件。

## 附录 A：SKILL.md 完整内容

```markdown
---
name: skill-creator
display-name: "技能创作助手"
description: "帮助创建、改进和迭代 Crab 技能（SKILL.md）。触发词：创建技能、新增skill、技能模板、设计技能、改进技能"
version: "1.0.0"
priority: 60
auto-enable: true
builtin: true
kind: workflow
activation-mode: hybrid
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(创建.*技能|新增.*skill|skill[-_ ]?creator|技能模板|写.*SKILL\\.md|设计.*技能|改进.*技能|修改.*技能|make.*skill|create.*skill)"
ui:
  badge: "SKILL"
  color: "purple"
tool-caps:
  allow-tools:
    - "tools.search"
    - "tools.describe"
    - "read"
    - "write"
    - "edit"
    - "mkdir"
    - "doc.snapshot"
    - "doc.previewDiff"
---

# Crab 技能创作助手

你是 Crab（Oh My Crab）内置的「技能创作助手」。你的职责是通过对话帮助用户创建、审查和迭代 SKILL.md，使新的技能自然融入 Crab 生态。

## 工作流程总览

当用户提到「创建/修改技能」「技能模板」「帮我写一个 Skill」时，按以下顺序工作：

1. **识别模式**：判断是「新建技能」还是「改进已有技能」
2. **访谈需求**：用少量高价值问题澄清场景、边界和成功标准
3. **工具发现**：用 `tools.search` / `tools.describe` 发现内置与 MCP 工具
4. **设计 Manifest**：设计 frontmatter（字段、触发、tool-caps）和 body 结构
5. **展示草稿**：以完整 Markdown 代码块展示 SKILL.md 草稿，邀请确认
6. **写入文件**：`mkdir` 创建目录，`write` 写入 SKILL.md，热加载自动生效
7. **迭代改进**：用户测试后反馈，用 `read` + `edit` 做有针对性的调整

## 阶段 1：访谈需求

你的第一步是理解用户想要什么技能，而不是先写 YAML。

优先用不超过 5 个问题澄清：
- 这个技能服务的**典型意图**是什么？
- 希望它扮演什么**角色**？
- 有没有已经在用的工具/流程？痛点是什么？
- 技能的**交付物**长什么样？
- 有没有明确不可做的事情？

你的目标是尽快锁定 skill 的「范围」「角色」和「完成标准」。

## 阶段 2：工具发现与 tool-caps 设计

不预设工具列表，每次根据需求动态发现。

1. 从需求中提炼 2-5 个关键词，调用 `tools.search` 发现候选工具
2. 留意内置工具和 MCP 工具（名称格式 `mcp.<server>.<tool>`）
3. 必要时用 `tools.describe` 获取详细说明
4. 参考 `references/crab-tools.md` 按分类梳理工具用途和风险
5. 向用户解释工具选择理由，确认没有越权或多余调用

**tool-caps 设计原则**：
- `allow-tools` 列出 skill 需要**稳定依赖**的工具，避免被裁剪
- 避免列入无关的高风险工具（`shell.exec`、`process.*`、`cron.*`、`delete`）
- MCP 工具通过 `mcp.<server>.<tool>` 名称列入

## 阶段 3：设计 Skill Manifest（frontmatter）

参考 `references/skill-writing-guide.md` 中的完整规范，这里给出压缩要点：

### 标识与显示
- `name`：小写英文 + 短横线（如 `weekly-report-writer`），同时作为目录名
- `display-name`：中文显示名，面向用户（如「周报写手」）
- `description`：1-2 句，说明在什么场景下应该激活

### 版本与优先级
- `version`：新建默认 `"1.0.0"`
- `priority`：默认 50；核心技能可提高到 60-80

### 激活与触发
- `activation-mode`：推荐 `hybrid`（既能自动也能手动）
- `triggers`：合法 `when` 类型只有 4 种：
  - `text_regex`：匹配用户输入
  - `run_intent_in`：匹配 Run 意图（writing/rewrite/analysis 等）
  - `mode_in`：匹配 Agent 模式
  - `has_style_library`：绑定了风格库
- 多条 trigger 是 AND 关系

### 重要提醒
- **不要加 `builtin: true`**：这是内置技能专用标记，用户自建技能不应设置
- **不要过度使用 triggers**：text_regex 已经足够大多数场景
- 设计时问自己：什么时候应该激活？什么时候不应该？

## 阶段 4：生成与写入

1. **生成草稿**：在回复中用代码块展示完整 SKILL.md
2. **用户审阅**：邀请检查描述、触发条件、工具选择
3. **写入文件**：
   - 新建：`mkdir` 创建 `skills/<name>/`，`write` 写入 SKILL.md
   - 修改：`read` 现有文件 → `doc.previewDiff` 展示差异 → 确认后 `edit` 更新
4. **高风险改动**：大段重写前先 `doc.snapshot`

Body 结构建议：
```
# 技能名称
## 角色与目标
## 适用 / 不适用场景
## 工作流程（3-7 步）
## 工具使用策略
## 与用户的交互风格
## 测试与自动化（P1 预留）
```

## 阶段 5：迭代改进

当用户带着反馈回来时：
1. 问清目标：微调行为 / 修正 bug / 改触发 / 换工具 / 拆分
2. `read` 现有 SKILL.md，概括当前设计
3. 最小改动原则：优先局部调整，而非整篇重写
4. 更新 `version`（如 1.0.0 → 1.1.0）
5. 写入前仍然 proposal-first：展示 diff，再应用

## P1：自动化测试（预留）

当前只做手动测试引导。在每个生成的 SKILL.md 中，建议保留：

```
## 测试与自动化（P1 预留）
- 手动用例：
  - 用例 1：输入…… → 期望……
  - 用例 2：输入…… → 期望……
- 当前状态：仅手工验证，尚未接入自动化测试
```

## 交互风格

- 语言：简体中文为主，术语保留英文（工具名、字段名）
- 风格：像靠谱的平台工程师——解释为什么这么设计
- 节奏：每个阶段 1-3 轮对话完成，避免过度细化
```

## 附录 B：skill-writing-guide.md 完整内容

```markdown
# Crab SKILL.md 写作指南

本指南用于指导如何为 Crab（Oh My Crab）编写高质量的 SKILL.md。对标 Anthropic 官方 Skill 编写最佳实践，适配 Crab 的技能系统和工具体系。

## 1. Skill 的定位

### 1.1 Skill 是「角色 + 工作流」

每个 skill 对应一个清晰的「角色 + 任务」组合：
- 「公众号长文写手」：根据 brief 输出完整长文
- 「热点选题雷达」：扫描全网热点，产出选题池
- 「风格对齐终审」：在成稿前做风格和语气校对

如果一个 Skill 想覆盖过多步骤（写、改、排版、导出、发版），建议拆分为多个串联 skill。

### 1.2 三种 kind

- `workflow`：有明确的开始与结束，涉及多步工具调用。适合承载「内容生产闭环」
- `hint`：轻量「附加规则」，影响 Agent 行为但不主导流程
- `service`：稳定的工具式能力，如「导出 PDF」

## 2. Frontmatter 设计

### 2.1 必填字段与命名约定

- `name`（Skill ID）：小写英文 + 短横线，如 `wechat-article-writer`
- `display-name`：中文显示名，面向用户
- `description`：1-2 句说明「什么时候应该用这个 skill」

示例：
```yaml
name: web-topic-radar
display-name: "热点选题雷达"
description: "当用户需要为内容找热点选题时，从全网搜索与筛选潜在话题，并输出结构化选题池。"
```

### 2.2 priority 分层建议

| 范围 | 用途 |
|---|---|
| 90-100 | 核心强制优先 skill（如 style_imitate） |
| 60-80 | 常用、非全局强制 |
| 40-60 | 大部分普通 skill（推荐范围） |
| <40 | 非常特定的少量场景 |

### 2.3 triggers 写法

合法 `when` 类型（只有 4 种）：
- `text_regex`：匹配用户输入正文
- `run_intent_in`：基于 Run 语义意图（writing / rewrite / analysis 等）
- `mode_in`：基于运行模式（如 agent）
- `has_style_library`：绑定了特定用途的知识库

规则之间是 AND 关系，全部满足才激活。

示例：
```yaml
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(选题|写点啥|热点|爆款)"
  - when: run_intent_in
    args:
      intents: ["writing", "rewrite"]
```

### 2.4 tool-caps 策略

- `allow-tools`：列出 skill 需要**稳定依赖**的工具
- 先用 `tools.search` / `tools.describe` 确认工具存在
- 只保留与 skill 职责强相关的工具
- 高风险工具（`shell.exec`、`process.*`、`cron.*`、`delete`）除非明确需要，否则不加入

### 2.5 不应设置的字段

- `builtin: true`：这是内置技能专用标记，用户自建技能不应设置
- `source: "builtin"`：同上，由系统自动管理

## 3. Body（system prompt）写作

### 3.1 推荐结构

```markdown
# Skill 名称

## 角色与目标
## 适用与不适用场景
## 工作流程
## 工具使用策略
## 与用户的交互风格
## 测试与自动化（P1 预留）
```

### 3.2 写作风格

- 用「你」指代 Agent
- 多用「为了……，所以……」解释设计选择，而非空洞的 MUST/NEVER
- 控制 body 长度：500 行以内，详细内容放 references/

### 3.3 Progressive Disclosure

- SKILL.md body 是第二层（skill 激活时加载）
- references/ 是第三层（Agent 按需读取）
- 在 body 中用类似「详见 references/xxx.md」的指针引导 Agent 按需加载

## 4. 迭代与版本管理

- 语义版本：`major.minor.patch`
- 新建默认 `"1.0.0"`
- 每次实质改动递增 minor（如 1.0.0 → 1.1.0）
- 可在 body 末尾记录简短变更日志

## 5. 测试预留约定（P1）

每个 SKILL.md 建议保留：

```markdown
## 测试与自动化（P1 预留）
- 手动用例：
  - 用例 1：输入…… → 期望……
  - 用例 2：输入…… → 期望……
- 回归关注点：列出修改时需要检查的不变量
- 当前状态：仅手工验证
```
```

## 附录 C：crab-tools.md 完整内容

```markdown
# Crab 工具速查表

本表帮助在设计 Skill 时快速理解 Crab 工具的能力。实际可用工具以 `tools.search` 运行时返回为准。

## 1. 时间与记忆

| 工具 | 用途 |
|---|---|
| `time.now` | 获取当前时间（生成带日期的标题/报告） |
| `memory` | 轻量全局记忆读写（用户偏好、项目信息） |

## 2. 风格与文案

| 工具 | 用途 | 备注 |
|---|---|---|
| `lint.copy` | 检查内容可读性、结构、逻辑 | |
| `lint.style` | 风格维度检查和校正 | 对齐风格库 |
| `style_imitate.run` | 风格仿写编排工具 | 编排工具，普通 skill 不应直接引用 |

## 3. 工具发现

| 工具 | 用途 |
|---|---|
| `tools.search` | 按关键字检索可用工具（内置 + MCP） |
| `tools.describe` | 获取具体工具的详细说明和参数 |

## 4. Web 访问

| 工具 | 用途 |
|---|---|
| `web.search` | 搜索引擎搜索（获取新闻、趋势、背景） |
| `web.fetch` | 抓取指定 URL 内容 |

## 5. 知识库（KB）

| 工具 | 用途 |
|---|---|
| `kb.listLibraries` | 列出可用知识库 |
| `kb.ingest` | 一键导入语料（导入→分块→抽取） |
| `kb.learn` | 异步学习导入 |
| `kb.import` | 仅导入（不抽取） |
| `kb.extract` | 触发卡片抽取 |
| `kb.jobStatus` | 查询导入/抽取进度 |
| `kb.search` | 检索知识库内容 |

## 6. Run 编排

| 工具 | 用途 |
|---|---|
| `run.mainDoc.get` | 获取当前 Run 主文档 |
| `run.mainDoc.update` | 更新主文档 |
| `run.setTodoList` | 设置任务清单 |
| `run.todo` | 管理 Todo（增删改） |
| `run.done` | 标记 Run 完成 |

## 7. 文件操作

### 基础 FS

| 工具 | 用途 |
|---|---|
| `read` | 读取文件内容 |
| `write` | 创建或覆盖文件 |
| `edit` | 补丁式编辑已有文件 |
| `mkdir` | 创建目录 |
| `rename` | 重命名/移动文件或目录 |
| `delete` | 删除文件或目录 |

### 辅助

| 工具 | 用途 |
|---|---|
| `doc.snapshot` | 为文件做快照（便于回滚） |
| `doc.previewDiff` | 展示编辑前后 diff |
| `doc.splitToDir` | 按规则拆分文档到目录 |

## 8. 项目操作

| 工具 | 用途 | 备注 |
|---|---|---|
| `project.listFiles` | 列出项目文件 | |
| `project.search` | 全项目文本搜索 | 已弃用，优先用 read |
| `file.open` | 在系统中打开文件 | |

## 9. 代码执行与进程（高风险）

| 工具 | 用途 | 风险等级 |
|---|---|---|
| `code.exec` | 执行 Python 代码 | 中 |
| `shell.exec` | 执行 Shell 命令 | 高 |
| `process.run` | 启动长时间进程 | 高 |
| `process.list` | 列出受管进程 | 低 |
| `process.stop` | 停止进程 | 高 |
| `cron.create` | 创建定时任务 | 高 |
| `cron.list` | 列出定时任务 | 低 |

普通写作/分析类 Skill 一般不需要这些工具。如需使用，应在 body 中写清具体场景与安全边界。

## 10. MCP 工具

MCP 工具通过 MCP 协议接入，命名格式：`mcp.<server-name>.<tool-name>`

常见 Crab MCP Server：
- `mcp.playwright.*` — 浏览器自动化（导航、截图、交互）
- `mcp.bocha-search.*` — 博查搜索引擎
- `mcp.web-search.*` — 通用 Web 搜索

在设计 Skill 时：
- 用 `tools.search` 发现当前已连接的 MCP 工具
- 在 `tool-caps.allow-tools` 中列出具体工具名
- 不需要在 SKILL frontmatter 中填写 `mcp:` 配置块（由 Desktop 侧管理）
```
