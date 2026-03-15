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
