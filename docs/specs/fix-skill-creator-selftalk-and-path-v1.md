# Fix Spec: skill-creator 自问自答 + 写入路径错误

> spec v1 · 2026-03-16

## 一、现象

### Bug 1：自问自答（老问题，新场景）

**症状**：使用 skill-creator 创建技能时，Agent 在生成 SKILL.md 草稿后说了类似 "确认这个结构后，我直接写入SKILL.md终稿。" 然后 **没有等用户回复**，自己继续执行了后续步骤（创建目录、写入文件）。

**复现条件**：
- 助手模式（agent mode）
- skill-creator 技能激活
- Agent 设置了 todo list（如"设计 frontmatter → 展示草稿 → 写入文件"）
- Agent 在展示草稿后发出"行动宣示"型文本（非问句，无第二人称代词）

**用户期望**：Agent 应在展示草稿后停下来等用户确认，而不是自行继续。

**严重度**：A（频繁出现，影响体验和信任感）

### Bug 2：技能写入路径错误

**症状**：skill-creator 在助手模式下创建技能，最后用 `mkdir` + `write` 落盘时，文件写到了 **用户当前打开的项目目录** 下（如 `~/projects/my-app/skills/xxx/SKILL.md`），而不是正确的 `userData/skills/xxx/SKILL.md`。导致技能不能被 SkillLoader 加载，用户需要手动移动文件。

**复现条件**：
- 助手模式 + skill-creator 激活
- 用户已打开一个项目（projectStore.rootDir 有值）
- Agent 调用 `mkdir` 创建 `skills/<name>/`，再用 `write` 写入 `skills/<name>/SKILL.md`

**用户期望**：技能文件应写入 `userData/skills/<name>/SKILL.md`，热加载自动生效。

**严重度**：B（功能性 bug，但有手动 workaround）

## 二、根因分析

### Bug 1 根因：`_detectAssistantAskingUser()` 三层检测漏判"行动宣示"模式

**根因编号**：RC-1

**位置**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1113-1161`

**触发链路**：
```
Agent 文本 "确认这个结构后，我直接写入SKILL.md终稿。"
  ↓
_getFollowUpMessages() (L1040-1084)
  ├─ pending_todo: runTodo 有未完成项 → 进入检测
  ├─ hasWaiting: false（todo 未标 blocked）
  ├─ _detectAssistantAskingUser(lastText):
  │   ├─ 层 1 tailAskPattern: ❌ 不命中（尾部以句号结尾，不是问号）
  │   ├─ 层 2 _textHasUserDirectedQuestion: ❌ 不命中
  │   │   └─ 要求 /(你|您)/ + 选择/确认类动词 → 文本用第一人称"我"，无"你/您"
  │   └─ 层 3 _textTailWaitsForUser: ❌ 不命中
  │       └─ 要求 /确认.*之后.*我再/ → 实际是"确认...后，我直接"，不含"我再"
  │   → return false（未检测到 asking user）
  ├─ done < total → 发送 pending_todo hint
  └─ Agent 收到催促，继续执行 → 自问自答
```

**本质问题**：三层检测只覆盖了"显式提问"（问号结尾）和"等待确认"（你/您 + 确认后我再……）两种模式。但 Agent 常用的 **"行动宣示"模式** ——"确认 X 后，我直接/我就 Y"——既不以问号结尾，也不包含第二人称代词，三层全部漏判。

**同类受害者**：
- "如果没问题，我就开始写代码了。"
- "等你确认后我马上执行。"
- "没有问题的话我直接落盘。"
- "确认一下格式后我开始生成。"

这些模式在 skill-creator、docx、pdf 等 workflow 类技能中普遍出现。

### Bug 2 根因：`write` 工具无法写入 `userData/skills/` 目录

**根因编号**：RC-2

**位置**：`apps/desktop/src/agent/toolRegistry.ts:521-547`

**触发链路**：
```
Agent 调用 write({ path: "skills/xxx/SKILL.md", content: "..." })
  ↓
resolveProjectPathArg("skills/xxx/SKILL.md")
  ├─ isAbsoluteLikePath → false（相对路径）
  ├─ normalizeRelPath → "skills/xxx/SKILL.md"
  └─ return { ok: true, path: "skills/xxx/SKILL.md", fromAbsolute: false }
  ↓
useProjectStore.createFile("skills/xxx/SKILL.md", content)
  └─ 写入到 projectStore.rootDir + "/skills/xxx/SKILL.md"
  └─ 实际写到了 ~/projects/my-app/skills/xxx/SKILL.md  ← 错误！
```

**本质问题**：`write` 工具的路径解析只考虑了"项目工作区内的文件"场景。`resolveProjectPathArg()` 将所有相对路径解析为项目根目录的相对路径，绝对路径则要求必须在项目根目录下（否则返回 `PATH_OUTSIDE_PROJECT`）。没有任何路径可以到达 `userData/skills/`。

**方案评估**：

| 方案 | 描述 | 优缺点 |
|------|------|--------|
| A. 注入 skillsDir 到 context pack | Agent 拿到绝对路径后直接用 write | ❌ `resolveProjectPathArg` 会拒绝项目外绝对路径 |
| B. 新增 `skill.install` 专用工具 | 独立工具，路径在 main 进程解析 | ✅ 语义清晰，不破坏 FS 沙箱 |
| C. `~skills/` 前缀 hack | write/mkdir 识别特殊前缀 | ❌ 需改多处，语义污染 |

**结论**：采用 **方案 B**——新增 `skill.install` 工具。

## 三、影响范围

### Bug 1 影响

- 所有 workflow 类技能（skill-creator、docx、pdf 等）在设置 todo list 后都可能出现自问自答
- 影响用户对 Agent 的信任感和交互节奏

### Bug 2 影响

- 仅影响 skill-creator 技能的"写入"阶段
- 技能无法热加载，需手动移动文件
- 不影响其他 `write` 工具的正常使用

## 四、修复方案

### Fix 1（P0）：扩展 `_detectAssistantAskingUser()` 覆盖"行动宣示"模式

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**位置**：`_detectAssistantAskingUser()` 方法，L1113-1130

**改动原理**：在层 1（tail 直接匹配）中新增"行动宣示"模式的正则，当 Agent 表达"确认 X 后我直接/我就 Y"类语气时，判定为 asking user。

**当前代码**（L1113-1130）：

```typescript
private _detectAssistantAskingUser(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;

    const tail = t.slice(-400);

    // 层 1：尾部短窗直接命中提问模式（扩大到 400 字符）
    const tailAskPattern =
      /[？?]\s*$|要[^。\n]{0,12}吗[？?]?|还是[^。\n]{0,16}[？?]|(?:你|您)[^。\n]{0,16}(?:偏好|更倾向|选择|打算|决定)[^。\n]{0,12}[？?]?|帮你[^。\n]{0,16}[？?]|需要[^。\n]{0,12}确认|请[^。\n]{0,16}选择|请[^。\n]{0,16}告诉我|告诉我/;
    if (tailAskPattern.test(tail)) return true;

    // 层 2+3：全文有"向用户提问/选择"的句子 + 尾部处于"等待用户决策"语气
    if (this._textHasUserDirectedQuestion(t) && this._textTailWaitsForUser(tail)) {
      return true;
    }

    return false;
  }
```

**修改后代码**：

```typescript
private _detectAssistantAskingUser(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;

    const tail = t.slice(-400);

    // 层 1：尾部短窗直接命中提问模式（扩大到 400 字符）
    const tailAskPattern =
      /[？?]\s*$|要[^。\n]{0,12}吗[？?]?|还是[^。\n]{0,16}[？?]|(?:你|您)[^。\n]{0,16}(?:偏好|更倾向|选择|打算|决定)[^。\n]{0,12}[？?]?|帮你[^。\n]{0,16}[？?]|需要[^。\n]{0,12}确认|请[^。\n]{0,16}选择|请[^。\n]{0,16}告诉我|告诉我/;
    if (tailAskPattern.test(tail)) return true;

    // 层 1.5：尾部"行动宣示"模式——Agent 表达"确认后我就/我直接 做某事"，
    // 语义上在等用户确认，但文本不含问号也不含第二人称。
    const tailActionPlanPattern =
      /(?:确认|没问题|没有问题|觉得可以|ok|OK|可以的话|没问题的话|没有异议)[^。！？\n]{0,15}(?:我就|我会|我直接|我立即|我马上|我开始|就开始|我来|就来)/;
    if (tailActionPlanPattern.test(tail)) return true;

    const tailActionPlanPattern2 =
      /(?:如果|等你?|待|一旦)[^。！？\n]{0,15}(?:确认|没问题|同意|认可)[^。！？\n]{0,15}(?:我就|我会|我直接|我立即|我马上|我开始|就开始|我来|就来)/;
    if (tailActionPlanPattern2.test(tail)) return true;

    // 层 2+3：全文有"向用户提问/选择"的句子 + 尾部处于"等待用户决策"语气
    if (this._textHasUserDirectedQuestion(t) && this._textTailWaitsForUser(tail)) {
      return true;
    }

    return false;
  }
```

**边界情况**：
- `tailActionPlanPattern` 要求先有确认类触发词，再有行动类动词，中间允许 0-15 字缓冲
- 不会误触非条件性的行动陈述（如"我直接写入文件"不含确认前提，不命中）
- "确认后我再继续"已被层 3 `_textTailWaitsForUser` 覆盖，新增模式与其互补而非重叠

### Fix 2（P0）：新增 `skill.install` 工具

涉及 4 个文件，按依赖关系排列：

#### Fix 2.1：工具元数据定义

**文件**：`packages/tools/src/index.ts`

**位置**：L1005（`mkdir` 之后、`rename` 之前）

**改动类型**：新增

**插入代码**：

```typescript
  {
    name: "skill.install",
    description:
      "将 SKILL.md 写入用户技能目录（userData/skills/<name>/SKILL.md），使其被 SkillLoader 热加载。\n" +
      "只用于安装/更新技能文件，不要用于普通文件写入。",
    args: [
      { name: "name", required: true, desc: "技能 ID（即目录名，如 weekly-report-writer）", type: "string" },
      { name: "content", required: true, desc: "SKILL.md 完整内容（含 frontmatter + body）", type: "string" },
    ],
    modes: ["agent"],
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        content: { type: "string" },
      },
      required: ["name", "content"],
      additionalProperties: true,
    },
  },
```

#### Fix 2.2：IPC 处理器

**文件**：`apps/desktop/electron/main.cjs`

**位置**：L3261（`skills.openDir` 之后）

**改动类型**：新增

**插入代码**：

```javascript
  ipcMain.handle("skills.install", async (_event, payload) => {
    if (!skillLoader) return { ok: false, error: "SKILL_LOADER_NOT_READY" };
    const { name, content } = payload ?? {};
    if (!name || typeof name !== "string") return { ok: false, error: "INVALID_NAME" };
    if (!content || typeof content !== "string") return { ok: false, error: "INVALID_CONTENT" };

    // 安全校验：name 只允许小写字母、数字、短横线
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
      return { ok: false, error: "INVALID_NAME", detail: "name must be lowercase alphanumeric with hyphens" };
    }

    const skillDir = path.join(skillLoader.rootDir, name);
    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      await fsp.mkdir(skillDir, { recursive: true });
      await fsp.writeFile(skillFile, content, "utf-8");
      return { ok: true, path: skillFile };
    } catch (e) {
      return { ok: false, error: "WRITE_FAILED", detail: e?.message };
    }
  });
```

#### Fix 2.3：Preload 桥接

**文件**：`apps/desktop/electron/preload.cjs`

**位置**：L281（`skills.openDir` 之后，`skills.onChange` 之前）

**改动类型**：新增

**插入代码**：

```javascript
    install(payload) {
      return ipcRenderer.invoke("skills.install", payload);
    },
```

#### Fix 2.4：工具执行处理器

**文件**：`apps/desktop/src/agent/toolRegistry.ts`

**位置**：在 `write` 工具处理器附近新增独立 case

**改动类型**：新增

**处理逻辑**：

```typescript
case "skill.install": {
  const name = String(args?.name ?? "").trim();
  const content = String(args?.content ?? "").trim();
  if (!name) return failToolResult({ code: "MISSING_NAME", message: "skill name is required" });
  if (!content) return failToolResult({ code: "MISSING_CONTENT", message: "skill content is required" });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return failToolResult({ code: "INVALID_NAME", message: "name must be lowercase alphanumeric with hyphens" });
  }

  const result = await window.desktop.skills.install({ name, content });
  if (!result?.ok) {
    return failToolResult({ code: result?.error ?? "INSTALL_FAILED", message: result?.detail ?? "failed to install skill" });
  }
  return { type: "text", text: `✅ 技能已安装到 ${result.path}\nSkillLoader 将自动热加载。` };
}
```

### Fix 3（P0）：更新 skill-creator SKILL.md 使用 `skill.install`

**文件**：`apps/desktop/electron/bundled-skills/skill-creator/SKILL.md`

**改动 1**：`tool-caps.allow-tools` 新增 `skill.install`

```yaml
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
    - "skill.install"
```

**改动 2**：阶段 4 "生成与写入" 中，新建技能的指引改为使用 `skill.install`

当前文本：
```
3. **写入文件**：
   - 新建：`mkdir` 创建 `skills/<name>/`，`write` 写入 SKILL.md
```

改为：
```
3. **写入文件**：
   - 新建：调用 `skill.install`（name + content），工具会自动创建目录并写入 userData/skills/<name>/SKILL.md，热加载即时生效
   - 修改：`read` 现有文件 → `doc.previewDiff` 展示差异 → 确认后 `edit` 更新
```

**改动 3**：references/crab-tools.md 中文件操作分类新增 `skill.install` 条目

## 五、影响矩阵

| 改动 | 影响范围 | 风险 | 缓解 |
|------|---------|------|------|
| Fix 1：新增两条正则 | `_detectAssistantAskingUser()` 返回值 | **低**：新增 OR 分支，不影响原有三层检测 | 正则要求先有"确认"类前提，误触率低 |
| Fix 2.1：TOOL_LIST 新增工具 | 工具列表、per-turn 选择 | **极低**：增量添加，不改现有工具 | `modes: ["agent"]` 限制仅 agent 模式可用 |
| Fix 2.2：main.cjs 新增 IPC | IPC 处理器列表 | **极低**：独立 handler，不影响现有 skills.* IPC | name 格式校验防注入 |
| Fix 2.3：preload 新增桥接 | skills API 接口 | **极低**：新增方法，不改现有方法签名 | — |
| Fix 2.4：toolRegistry 新增 case | 工具执行路由 | **极低**：独立 case，不影响 write/mkdir 等现有工具 | name 二次校验 |
| Fix 3：SKILL.md 内容更新 | skill-creator 行为 | **极低**：仅修改指引文本和 tool-caps | bundled seed 机制自动同步 |

## 六、架构隐患

### 隐患 1：`_detectAssistantAskingUser()` 依赖正则穷举（严重度 B）

三层检测本质上是用正则 pattern 穷举 Agent 的"等待用户"语气。每次发现新漏网模式就加正则，维护成本递增。

**建议（P2）**：引入轻量语义分类——对最后一条助手文本做意图分类（asking_user / continuing / completed），替代正则穷举。可利用 Agent 的 tool_use 意图（是否有待调用的工具）辅助判断。

### 隐患 2：`skill.install` 目前只支持单文件（严重度 C）

当前 `skill.install` 只写入 `SKILL.md` 主文件。如果技能需要 `references/` 子目录（如 skill-creator 自身），需要分多次调用 `write`（仍会落到项目目录）或手动操作。

**建议（P1）**：后续扩展 `skill.install` 支持 `files` 参数（数组），一次性写入多个文件到技能目录。

## 七、验证 Checklist

### Bug 1 验证

| # | 场景 | 预期 |
|---|------|------|
| 1 | Agent 说 "确认这个结构后，我直接写入SKILL.md终稿。" | `_detectAssistantAskingUser` 返回 true，不触发 pending_todo |
| 2 | Agent 说 "如果没问题，我就开始写代码了。" | 返回 true |
| 3 | Agent 说 "等你确认后我马上执行。" | 返回 true |
| 4 | Agent 说 "没有问题的话我直接落盘。" | 返回 true |
| 5 | Agent 说 "我直接写入文件。"（无确认前提） | 返回 false（不误触） |
| 6 | Agent 说 "你觉得这个方案怎么样？" | 返回 true（原有层 1 覆盖） |
| 7 | Agent 说 "任务已完成，所有文件已写入。" | 返回 false |

### Bug 2 验证

| # | 场景 | 预期 |
|---|------|------|
| 1 | Agent 调用 `skill.install({ name: "weekly-report", content: "---\nname: weekly-report\n..." })` | 文件写入 `userData/skills/weekly-report/SKILL.md` |
| 2 | SkillLoader 热加载 | DevTools 控制台显示新技能加载 |
| 3 | `/` 弹出列表 | 新技能出现在列表中 |
| 4 | `skill.install({ name: "../escape", ... })` | 返回 INVALID_NAME 错误 |
| 5 | `skill.install({ name: "UPPER", ... })` | 返回 INVALID_NAME 错误 |
| 6 | `skill.install({ name: "valid-name", content: "" })` | 返回 INVALID_CONTENT 错误 |

### 回归测试

- [ ] `npm -w @ohmycrab/gateway run test:runner-turn`（6 场景覆盖）
- [ ] 现有 write/mkdir/edit 工具不受影响
- [ ] 现有 4 个 bundled skills（docx/xlsx/pptx/pdf）加载正常
- [ ] skill-creator 自身加载正常（seed 后出现在 `/` 列表）

## 八、实施优先级

| 优先级 | 改动 | 理由 |
|--------|------|------|
| P0 | Fix 1（自问自答正则扩展） | 频繁出现，影响体验 |
| P0 | Fix 2（skill.install 工具全链路） | 功能性 bug，技能无法正确安装 |
| P0 | Fix 3（skill-creator SKILL.md 更新） | 依赖 Fix 2，配套修改 |

## 九、涉及文件清单

| 文件 | 改动类型 | 行号范围 |
|------|---------|---------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | 修改 | L1119-1127（新增两条正则） |
| `packages/tools/src/index.ts` | 新增 | L1005 附近（新增 skill.install 工具元数据） |
| `apps/desktop/electron/main.cjs` | 新增 | L3261 附近（新增 skills.install IPC handler） |
| `apps/desktop/electron/preload.cjs` | 新增 | L281 附近（新增 install 桥接方法） |
| `apps/desktop/src/agent/toolRegistry.ts` | 新增 | write handler 附近（新增 skill.install case） |
| `apps/desktop/electron/bundled-skills/skill-creator/SKILL.md` | 修改 | tool-caps + 阶段 4 写入指引 |
| `apps/desktop/electron/bundled-skills/skill-creator/references/crab-tools.md` | 修改 | 文件操作分类新增 skill.install |
