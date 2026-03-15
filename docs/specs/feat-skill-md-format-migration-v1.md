# Feature Spec: 技能系统迁移到 SKILL.md 格式

> spec v1 · 2026-03-16

## 一、需求概述

**场景**：统一技能（Skill）系统格式，对齐 Claude Code 的 SKILL.md 标准
**目标**：
1. 全部技能改为 SKILL.md 格式（YAML frontmatter + Markdown body），废弃 skill.json + system-prompt.md + context-prompt.md 三文件模式
2. `/` 斜杠命令弹出技能列表（已实现，无需额外改动）
3. 热生效保持（fs.watch，已实现）
**约束**：不改变 Gateway 端的技能消费逻辑（SkillManifest 类型、activateSkills 函数、prompt 注入）

## 二、SKILL.md 格式规范

### 目录结构

```
skills/docx/
  ├── SKILL.md              ← 唯一必需文件（frontmatter + body）
  ├── editing.md            ← 可选附件（body 中引用）
  └── scripts/              ← 可选脚本目录
```

### YAML Frontmatter 字段

| 字段 | 必填 | 类型 | 说明 | 示例 |
|------|------|------|------|------|
| `name` | 是 | string | Skill ID，同时作为 `/` 命令名 | `docx` |
| `description` | 是 | string | 技能描述，Agent 用于判断自动激活 | `"创建、读取、编辑 .docx 文件..."` |
| `display-name` | 否 | string | 中文显示名（映射到 manifest.name） | `"Word 文档生成"` |
| `version` | 否 | string | 语义版本 | `"1.0.0"` |
| `priority` | 否 | number | 排序权重，默认 50 | `55` |
| `auto-enable` | 否 | bool | 是否默认启用，默认 true | `true` |
| `trigger` | 否 | string | 激活方式简写（Claude Code 兼容） | `manual` |
| `activation-mode` | 否 | string | 激活方式（优先于 trigger） | `explicit` / `auto` / `hybrid` |
| `kind` | 否 | string | 技能类型 | `workflow` / `hint` / `service` |
| `triggers` | 否 | array | 结构化触发规则 | 见下方 |
| `tool-caps` | 否 | object | 工具白/黑名单 | `{ allow-tools: [...] }` |
| `policies` | 否 | array | 策略标签 | `[]` |
| `conflicts` | 否 | array | 互斥技能 ID | `["xlsx"]` |
| `requires` | 否 | array | 前置依赖技能 ID | `["docx"]` |
| `mcp` | 否 | object | MCP Server 声明 | `{ transport: stdio, entry: server.mjs }` |
| `builtin` | 否 | bool | 是否内置技能 | `true` |
| `ui` | 否 | object | UI 显示 | `{ badge: "DOCX", color: "blue" }` |
| `context-prompt` | 否 | string | 指向同目录下的 context prompt 文件 | `"context-prompt.md"` |

### trigger 字段映射

| trigger 值 | 映射到 activationMode |
|-----------|---------------------|
| `manual` | `explicit` |
| `auto` / `automatic` | `auto` |
| `hybrid` | `hybrid` |

### triggers 数组 YAML 写法

```yaml
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.docx|word文档|生成.*文档)"
  - when: mode_in
    args:
      modes: ["agent"]
```

### Body（Markdown 正文）

frontmatter 之后的全部 Markdown 内容 → `promptFragments.system`

### 示例：docx 技能

```yaml
---
name: docx
display-name: "Word 文档生成"
description: "创建、读取、编辑 .docx 文件。触发词：Word、docx、文档、报告"
version: "1.0.0"
priority: 50
auto-enable: true
triggers:
  - when: text_regex
    args:
      pattern: "(?i)(\\.docx|word文档|word\\s*doc|生成.*文档)"
builtin: true
ui:
  badge: "DOCX"
  color: "blue"
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.
...
```

## 三、现状分析

### 当前格式

```
skills/docx/
  ├── skill.json          ← JSON manifest（20+ 字段）
  ├── system-prompt.md    ← 可选，覆盖 promptFragments.system
  └── context-prompt.md   ← 可选，覆盖 promptFragments.context
```

### `/` 调用已就位

- `SlashPopover.tsx`：完整的 `/` 弹出列表组件
- `InputBar.tsx:57`：`SLASH_QUERY_RE = /\/([^\s/]*)$/` 已实现
- `InputBar.tsx:371`：`insertSlash()` 函数已实现
- 无需额外 UI 改动

### Gateway 消费链路不受影响

- `SkillManifest` 类型定义（`packages/agent-core/src/skills.ts:33-61`）不变
- `activateSkills()` 函数不变
- `runFactory.ts` 中 `activeSkillIds` / `userSkillManifests` 消费逻辑不变
- skill-loader 输出的 manifest 对象格式与现有完全一致

## 四、实施方案

### 新增依赖

**文件**：`apps/desktop/package.json`

```diff
"dependencies": {
+  "yaml": "^2.6.0",
}
```

### Fix 1（P0）：skill-loader.mjs 支持 SKILL.md 解析

**文件**：`apps/desktop/electron/skill-loader.mjs`

#### 1.1 新增常量和工具函数

**位置**：L19 附近（常量区）

```diff
-const MANIFEST_FILE = "skill.json";
+const MANIFEST_FILE = "SKILL.md";
+const LEGACY_MANIFEST_FILE = "skill.json";
```

**位置**：L1（文件顶部 import 区）

```diff
+import YAML from "yaml";
```

**新增函数**（在 `finiteNum` 附近）：

```javascript
// kebab-case → camelCase 键名转换
function toCamelKey(k) {
  return String(k ?? "").replace(/-([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

// 递归转换对象键名
function normalizeKeysDeep(v) {
  if (Array.isArray(v)) return v.map((x) => normalizeKeysDeep(x));
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[toCamelKey(k)] = normalizeKeysDeep(val);
  }
  return out;
}

// 解析 SKILL.md：frontmatter + body
function parseSkillMarkdown(text, dirName) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  if (!lines.length || !/^---\s*$/.test(lines[0])) {
    return { frontmatter: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return { frontmatter: {}, body: raw };
  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  let data = {};
  if (yamlText.trim()) {
    try { data = YAML.parse(yamlText) ?? {}; } catch {
      throw new Error(`SKILL_FRONTMATTER_PARSE_ERROR:${dirName}`);
    }
  }
  return { frontmatter: isObj(data) ? data : {}, body };
}

// frontmatter → parseManifest 入参转换
function buildManifestInputFromFrontmatter(frontmatter, dirName) {
  const fm = normalizeKeysDeep(frontmatter ?? {});
  const out = { ...fm };

  // name → id，display-name → name
  const idFromName = norm(out.name);
  const id = norm(out.id) || idFromName || norm(dirName);
  if (!id) throw new Error("SKILL_ID_REQUIRED");
  out.id = id;

  const displayName = norm(out.displayName);
  const derivedName = displayName || (idFromName && idFromName !== id ? idFromName : "") || norm(out.title);
  if (derivedName) out.name = derivedName;

  // trigger → activationMode 映射
  const trigger = norm(out.trigger);
  if (trigger && !out.activationMode) {
    const t = trigger.toLowerCase();
    if (t === "manual") out.activationMode = "explicit";
    else if (t === "auto" || t === "automatic") out.activationMode = "auto";
    else if (t === "hybrid") out.activationMode = "hybrid";
  }

  const contextPrompt = norm(out.contextPrompt);
  return { raw: out, contextPrompt };
}
```

#### 1.2 改写 loadOne() 函数

**位置**：L236-266

**当前**：只读 skill.json → parseManifest → 读可选 md 文件

**改为**：优先读 SKILL.md → 解析 frontmatter + body → fallback 到 skill.json

```javascript
async function loadOne(rootDir, dirName) {
  const skillDir = path.join(rootDir, dirName);
  const skillMdPath = path.join(skillDir, MANIFEST_FILE);
  const legacyJsonPath = path.join(skillDir, LEGACY_MANIFEST_FILE);

  let manifest;
  let contextPromptRel = "";

  if (await exists(skillMdPath)) {
    // 新格式：SKILL.md
    const mdText = await fsp.readFile(skillMdPath, "utf-8");
    const { frontmatter, body } = parseSkillMarkdown(mdText, dirName);
    const { raw, contextPrompt } = buildManifestInputFromFrontmatter(frontmatter, dirName);
    manifest = parseManifest(raw, skillDir, dirName);

    const systemText = norm(body);
    if (systemText) {
      manifest.promptFragments.system = systemText;
    }
    contextPromptRel = contextPrompt;
  } else if (await exists(legacyJsonPath)) {
    // 旧格式：skill.json（向后兼容）
    const jsonText = await fsp.readFile(legacyJsonPath, "utf-8");
    let raw;
    try { raw = JSON.parse(jsonText); } catch {
      throw new Error(`SKILL_JSON_PARSE_ERROR:${dirName}`);
    }
    manifest = parseManifest(raw, skillDir, dirName);

    const sysMd = await readText(path.join(skillDir, SYSTEM_PROMPT_FILE));
    const ctxMd = await readText(path.join(skillDir, CONTEXT_PROMPT_FILE));
    if (sysMd != null) manifest.promptFragments.system = sysMd;
    if (ctxMd != null) manifest.promptFragments.context = ctxMd;
  } else {
    return null;
  }

  // SKILL.md 的 context-prompt 字段
  if (contextPromptRel) {
    try {
      const ctxPath = safeResolve(skillDir, contextPromptRel, `SKILL_CONTEXT_PROMPT_ESCAPE:${manifest.id}`);
      const ctxMd = await readText(ctxPath);
      if (ctxMd != null) manifest.promptFragments.context = ctxMd;
    } catch (e) {
      console.warn(`[SkillLoader] contextPrompt invalid: ${dirName} — ${e?.message ?? e}`);
    }
  }

  // stdio 入口文件校验（不变）
  if (manifest.mcp?.transport === "stdio") {
    const abs = safeResolve(skillDir, manifest.mcp.entry, `SKILL_MCP_ENTRY_ESCAPE:${manifest.id}`);
    if (!(await exists(abs))) throw new Error(`SKILL_MCP_ENTRY_NOT_FOUND:${manifest.id}`);
  }

  const digest = crypto.createHash("sha1").update(JSON.stringify(manifest)).digest("hex");
  const mcpConfig = buildMcpConfig(manifest, skillDir);
  return { id: manifest.id, dir: skillDir, manifest, digest, mcpConfig };
}
```

### Fix 2（P0）：main.cjs bundled skills seed 支持 SKILL.md

**文件**：`apps/desktop/electron/main.cjs`

在 bundled skills seed 逻辑中（搜索 `bundledEntries`）：
- 新增 `const YAML = require("yaml")` 和 `parseSkillFrontmatter` 辅助函数
- 版本比对从只读 `skill.json` 改为优先读 `SKILL.md` frontmatter，fallback 到 `skill.json`

详细 diff 见 Codex Round 1 输出（过长不重复）。核心变化：

```javascript
// 源目录：优先 SKILL.md，fallback skill.json
try {
  const mdText = await fsp.readFile(path.join(src, "SKILL.md"), "utf-8");
  // 从 frontmatter 提取 version + builtin
} catch {
  const srcManifest = JSON.parse(await fsp.readFile(path.join(src, "skill.json"), "utf-8"));
}

// 目标目录：同样优先 SKILL.md
// 版本 + builtin 一致则跳过，否则先删后拷
```

### Fix 3（P0）：Bundled Skills 迁移

将 4 个 bundled skill 从 `skill.json + system-prompt.md` 合并为 `SKILL.md`。

**删除文件**：
- `apps/desktop/electron/bundled-skills/docx/skill.json`
- `apps/desktop/electron/bundled-skills/docx/system-prompt.md`
- `apps/desktop/electron/bundled-skills/xlsx/skill.json`
- `apps/desktop/electron/bundled-skills/xlsx/system-prompt.md`
- `apps/desktop/electron/bundled-skills/pptx/skill.json`
- `apps/desktop/electron/bundled-skills/pptx/system-prompt.md`
- `apps/desktop/electron/bundled-skills/pdf/skill.json`
- `apps/desktop/electron/bundled-skills/pdf/system-prompt.md`

**新增文件**：
- `apps/desktop/electron/bundled-skills/docx/SKILL.md`
- `apps/desktop/electron/bundled-skills/xlsx/SKILL.md`
- `apps/desktop/electron/bundled-skills/pptx/SKILL.md`
- `apps/desktop/electron/bundled-skills/pdf/SKILL.md`

每个 SKILL.md = 原 skill.json 字段转为 YAML frontmatter + 原 system-prompt.md 内容作为 body。

**保留不变**：
- `pptx/pptxgenjs.md`、`pptx/editing.md`（附件，body 中引用）
- 各目录下的 `scripts/` 目录

### 暂不改动

| 项目 | 原因 |
|------|------|
| `style_imitate` TS 硬编码 | 避免同时改 Desktop + Gateway + Agent-core |
| MentionPopover 移除技能分组 | `@` 和 `/` 双入口暂时保持，后续独立清理 |
| Gateway 端任何代码 | SkillManifest 类型不变，skill-loader 输出格式不变 |

## 五、影响矩阵

| 改动 | 影响范围 | 风险 | 缓解措施 |
|------|---------|------|----------|
| skill-loader.mjs 新增 SKILL.md 解析 | 所有技能加载 | 低 | 保留 skill.json fallback，旧技能不受影响 |
| main.cjs seed 逻辑改版本比对 | 应用启动 | 低 | 失败时保守策略：重新复制 |
| bundled skills 删旧文件 | 4 个内置技能 | 低 | 启动时 seed 会覆盖用户目录旧版本 |
| 新增 `yaml` 依赖 | 打包体积 | 极低 | ~50KB，纯 JS |
| `normalizeKeysDeep` kebab→camelCase | trigger args key | 极低 | 当前无 kebab-case args key |

## 六、验证 Checklist

### 安装 & 构建

- [ ] `npm install`（确认 `yaml` 依赖安装成功）
- [ ] `npm run dev:electron` 启动无报错

### 新格式加载

- [ ] DevTools 控制台确认：`[SkillLoader] started: 4 skill(s)`（或更多）
- [ ] 4 个 bundled skill（docx/xlsx/pptx/pdf）manifest 字段正确：
  - id / name / priority / autoEnable / triggers / ui 与原 skill.json 一致
  - promptFragments.system 内容与原 system-prompt.md 一致

### 旧格式兼容

- [ ] 在 `userData/skills/` 下放一个仅含 `skill.json` + `system-prompt.md` 的目录
- [ ] 确认仍能正常加载

### `/` 弹出列表

- [ ] 输入框打 `/` 弹出技能列表
- [ ] 搜索 `docx` 能找到 Word 文档生成
- [ ] 选择后 chip 正确插入

### 热加载

- [ ] 在 `userData/skills/` 下新增一个 SKILL.md 格式技能目录
- [ ] 不重启应用，确认技能列表自动更新

### 场景验证

| # | 场景 | 预期 |
|---|------|------|
| 1 | 输入"帮我写个 Word 报告" | docx 技能自动激活（text_regex 匹配） |
| 2 | 输入"导出 PDF" | pdf 技能自动激活 |
| 3 | `/docx` 手动调用 | docx 技能显式激活 |
| 4 | pptx 技能加载后，body 中引用 editing.md | Agent 能读取附件 |
| 5 | 用户旧格式第三方技能（skill.json） | 正常加载，不受影响 |

## 七、实施优先级

| 优先级 | 改动 | 理由 |
|--------|------|------|
| P0 | Fix 1（skill-loader SKILL.md 解析） | 核心功能 |
| P0 | Fix 2（main.cjs seed 适配） | 确保 bundled skills 正确同步 |
| P0 | Fix 3（bundled skills 迁移） | 4 个内置技能迁移 |
| P1 | MentionPopover 移除技能分组 | 清理重叠入口，可后续独立做 |
| P2 | style_imitate 迁移为 SKILL.md | 需要同步改 Gateway，独立 spec |

## 八、涉及文件清单

| 文件 | 改动类型 | 行号范围 |
|------|---------|---------|
| `apps/desktop/package.json` | 新增依赖 | dependencies |
| `apps/desktop/electron/skill-loader.mjs` | 核心改动 | L1(import), L19(常量), L40+(新函数), L236-266(loadOne) |
| `apps/desktop/electron/main.cjs` | 适配 | bundled skills seed 段落 |
| `apps/desktop/electron/bundled-skills/docx/SKILL.md` | 新增 | 全文 |
| `apps/desktop/electron/bundled-skills/docx/skill.json` | 删除 | - |
| `apps/desktop/electron/bundled-skills/docx/system-prompt.md` | 删除 | - |
| `apps/desktop/electron/bundled-skills/xlsx/SKILL.md` | 新增 | 全文 |
| `apps/desktop/electron/bundled-skills/xlsx/skill.json` | 删除 | - |
| `apps/desktop/electron/bundled-skills/xlsx/system-prompt.md` | 删除 | - |
| `apps/desktop/electron/bundled-skills/pptx/SKILL.md` | 新增 | 全文 |
| `apps/desktop/electron/bundled-skills/pptx/skill.json` | 删除 | - |
| `apps/desktop/electron/bundled-skills/pptx/system-prompt.md` | 删除 | - |
| `apps/desktop/electron/bundled-skills/pdf/SKILL.md` | 新增 | 全文 |
| `apps/desktop/electron/bundled-skills/pdf/skill.json` | 删除 | - |
| `apps/desktop/electron/bundled-skills/pdf/system-prompt.md` | 删除 | - |

Sources:
- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills)
- [How to create custom Skills | Claude Help Center](https://support.claude.com/en/articles/12512198-how-to-create-custom-skills)
- [Agent Skills - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
