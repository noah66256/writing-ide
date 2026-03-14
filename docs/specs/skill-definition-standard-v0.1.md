# Skill 定义规范 v0.1

> 本文档定义了如何创建、注册和管理技能（Skill）。Skill 是对 Agent 行为的增强模块，通过条件触发自动激活。

## 1. 核心接口

```typescript
type SkillKind = "workflow" | "hint" | "service";

type SkillActivationMode = "auto" | "explicit" | "hybrid";

type SkillManifest = {
  id: string;                    // 唯一标识（如 "style_imitate"）
  name: string;                  // 显示名称（如 "风格仿写闭环"）
  description: string;           // 功能描述
  priority: number;              // 激活优先级（降序，数值越大越优先）
  stageKey: string;              // 观测阶段 key（如 "agent.skill.style_imitate"）
  autoEnable: boolean;           // 是否在条件满足时自动激活
  kind?: SkillKind;              // Skill 类型：workflow（有闭环）/hint（纯提示）/service（服务类）
  activationMode?: SkillActivationMode; // 激活模式：auto/explicit/hybrid
  triggers: TriggerRule[];       // 激活条件（所有规则 AND 组合，全部满足才激活）
  promptFragments: {
    system?: string;             // 注入 system prompt 的片段
    context?: string;            // 注入 context 的片段
  };
  policies: string[];            // 关联的 policy 列表
  toolCaps?: {
    allowTools?: string[];       // 额外允许的工具列表（只 pin，不裁剪 CORE_TOOLS）
    denyTools?: string[];        // （预留）禁用的工具列表
  };
  version?: string;              // 版本号
  conflicts?: string[];          // 互斥的 Skill ID（同时只能激活一个）
  requires?: string[];           // 依赖的 Skill ID
  source?: SkillSource;          // 来源层级
  ui: {
    badge: string;               // UI 标签文字（如 "STYLE"）
    color?: string;              // UI 标签颜色
  };
};

type TriggerRule = {
  when: TriggerType;             // 触发条件类型
  args: Record<string, unknown>; // 条件参数
};

type TriggerType =
  | "has_style_library"          // 当前 Run 绑定了风格库
  | "run_intent_in"             // 运行意图匹配
  | "mode_in"                   // 运行模式匹配
  | "text_regex";               // 用户输入正则匹配

type SkillSource = "builtin" | "standard" | "user" | "admin";

type ActiveSkill = {
  id: string;
  name: string;
  stageKey: string;
  badge: string;
  activatedBy: {
    reasonCodes: string[];       // 激活原因编码
    detail?: Record<string, unknown>;
  };
};
```

## 2. 字段说明

### 2.1 triggers（激活条件）

所有 `TriggerRule` 采用 AND 组合，全部满足才激活。每条规则：

| `when` 类型 | 参数 | 说明 |
|-------------|------|------|
| `has_style_library` | `{ purpose: "style" }` | 当前 Run 绑定了指定用途的知识库 |
| `run_intent_in` | `{ intents: ["writing", ...] }` | 运行意图匹配列表中任一值 |
| `mode_in` | `{ modes: ["agent"] }` | 运行模式匹配列表中任一值 |
| `text_regex` | `{ pattern: "热点|新闻", flags: "i" }` | 用户输入匹配正则 |

### 2.2 promptFragments

Skill 激活后自动注入 prompt 片段：
- `system`：拼接到 system prompt 尾部
- `context`：拼接到 context pack 中

### 2.3 conflicts / requires

- `conflicts`：互斥关系。如 `writing_batch` 和 `writing_multi` 互斥
- `requires`：依赖关系。被依赖的 Skill 必须同时激活

### 2.5 toolCaps（工具范围建议）

- `toolCaps.allowTools`：
  - 作用是**pin 必需工具**，即使在 `toolPolicy=deny` 或 B2 检索阶段也不被裁掉；
  - **不得用于裁剪 CORE_TOOLS**（run.mainDoc / run.todo / memory / time.now / 基础读写/检索等），这些由 gateway 的 `CORE_TOOL_NAME_SET` 统一兜底。
- `toolCaps.denyTools`：
  - 目前仅预留，不在运行时强制生效；
  - 后续如果启用，也必须保证不会把 CORE_TOOLS 剪掉。

### 2.4 source（来源层级）

三层配置合并，高优先级覆盖低优先级：

| 层级 | 来源 | 说明 |
|------|------|------|
| `builtin` | 代码内置 | 不可删除，可禁用 |
| `standard` | 标准包 | 随版本更新，可覆盖 |
| `user` | 用户自定义 | 用户通过设置页或对话添加 |
| `admin` | B 端管理员 | 管理员通过后台配置 |

## 3. 激活机制

```
用户发送消息
    ↓
activateSkills() 遍历所有 SkillManifest
    ↓
├─ 检查 autoEnable
├─ 检查 mode_in
├─ 检查 has_style_library
├─ 检查 run_intent_in
├─ 检查 text_regex
├─ 检查 conflicts（互斥排除）
└─ 按 priority 排序
    ↓
返回 ActiveSkill[] → 注入 prompt + 控制工具权限
```

## 4. 内置 Skill 列表

| ID | 名称 | 优先级 | 触发条件摘要 |
|----|------|--------|-------------|
| `style_imitate` | 风格仿写闭环 | 100 | agent 模式 + 绑定风格库 + 写作意图（workflow, activation=hybrid） |
| `web_topic_radar` | 全网热点雷达 | 110 | agent 模式 + 输入含热点/新闻关键词 |
| `writing_multi` | 小规模多篇 | 120 | 输入含 2-9 篇多篇 |
| `writing_batch` | 批量写作长跑 | 130 | 输入含 >=10 篇批量 |
| `corpus_ingest` | 语料导入与抽卡 | 90 | 输入含抽卡/学风格/导入语料 |

## 5. 示例

```typescript
const styleImitate: SkillManifest = {
  id: "style_imitate",
  name: "风格仿写闭环",
  description: "绑定风格库后自动激活：先检索风格模板，写入前 lint.style 对齐",
  priority: 100,
  stageKey: "agent.skill.style_imitate",
  autoEnable: true,
  triggers: [
    { when: "mode_in", args: { modes: ["agent"] } },
    { when: "has_style_library", args: { purpose: "style" } },
    { when: "run_intent_in", args: { intents: ["writing", "rewrite", "polish"] } },
  ],
  promptFragments: {
    system: "【Skill: style_imitate】当前已绑定风格库，写作前必须先 kb.search 检索风格模板...",
  },
  policies: ["kb_before_write", "lint_before_write"],
  toolCaps: { allowTools: ["kb.search", "lint.style"] },
  conflicts: [],
  requires: [],
  source: "builtin",
  ui: { badge: "STYLE", color: "blue" },
  version: "0.1.0",
};
```

---

## 变更记录

| 日期 | 版本 | 内容 |
|------|------|------|
| 2026-02-22 | v0.1 | 初稿：SkillManifest 接口、TriggerRule、激活机制、内置 Skill 列表 |
