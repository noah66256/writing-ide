# Skill Override 传播断裂 + V3 管线 Payload 构建缺陷

状态：Fix 1-3 已提交（`b23a2ae`），Fix 4a 待实施 | 优先级：P0 | 日期：2026-03-18

## 0. 现象

用户在 Desktop Settings 中开启 `style_imitate_v3`（扩展 Skill）、关闭 `style_imitate`（内置 Skill）。UI 正确显示切换状态。实际运行时，Agent 走 V1 旧路径（自由工具选择，无管线，无 lint），V3 管线完全未激活。

用户尝试了所有三种激活路径，全部失败：
1. **Settings 开关**：UI 显示已开启 V3、关闭 V1，但运行时 V1 照跑
2. **`/风格仿写管线` slash 命令**：V3 虽可能被 Gateway 激活，但 Desktop 未构建 pipeline payload → 降级为普通 Agent 模式
3. **`@风格库` + 写作意图**：V1 的 `has_style_library` trigger 先自动激活 V1，V3 被 conflicts 阻止

**一句话**：四层 bug 叠加，V3 在当前代码下无论哪条路径都无法以 pipeline 模式运行。

---

## 1. 根因分析

### 四层 bug 概览

| Bug | 层 | 根因 | 效果 | 状态 |
|-----|-----|------|------|------|
| Bug 1: Override 不传播 | Desktop → Gateway WS | `skillOverrides` 未写入 WS payload | Settings 开关是假的 | **已修复** `b23a2ae` |
| Bug 2: @提及被 conflicts 阻止 | Gateway activation | `activateSkills()` 先激活 V1（autoEnable=true），V3 @提及时 conflicts 发现 V1 已激活 → 跳过 | @提及也是假的 | **已修复**（Bug 1 修复后，V1 可被 override 禁用，conflicts 不再阻止 V3） |
| Bug 3: Desktop 不构建 pipeline payload | Desktop payload | `buildStylePipelinePayload()` L213 只检查 `activeSkillIds`（来自 @mention），不识别 Settings 开关 | Gateway 收不到 `stylePipelinePayload` → 无法走 pipeline 模式 | **待修复** |
| Bug 4: 系统提示词中 skill 列表未反映 override | Desktop contextPack | `buildContextPack()` L1731 用原始 manifests 做 `activateSkills()`，不含 override | `ACTIVE_SKILLS(JSON)` 显示错误的激活状态 | **待修复**（P1） |

### 为什么修了 Bug 1-2 还是不工作

Bug 1-2 解决了 Gateway 侧的 skill 激活问题：Gateway 现在能正确激活 V3、禁用 V1。但 Gateway 的 pipeline 路由条件（`runFactory.ts:4828-4833`）要求 Desktop 同时发送 `stylePipelinePayload`：

```typescript
// runFactory.ts L4828-4833
const shouldRunStylePipeline =
  styleExecutionMode === "pipeline_v1" &&
  activeSkillIds.includes("style_imitate_v3") &&
  Boolean(stylePipelinePayload) &&           // ← Desktop 必须构建并发送
  Boolean(gates?.styleGateEnabled) &&
  Boolean(intent?.isWritingTask);
```

而 Desktop 的 `buildStylePipelinePayload()` 在第一行就判断失败：

```typescript
// gatewayAgent.ts L213
if (!activeSkillIds.includes("style_imitate_v3")) return {};
// activeSkillIds 只来自 ChatArea.tsx L970 的 @mention 提取，Settings 开关不在其中
```

Gateway 的 fail-close 设计是正确的（没有 payload 就不该跑 pipeline），问题出在 Desktop 没有构建 payload。

### 完整链路图（修复 Bug 1-2 后的当前状态）

```
Desktop                                          Gateway
────────────────────────────────────────────     ────────────────────────────────────

skillStore:
  skillOverrides = {
    style_imitate_v3: { enabled: true },
    style_imitate: { enabled: false },
  }

wsTransport.ts (Bug 1-2 已修复):
  builtinOverrides = { ... }                     ✅ 正确传递
  userSkillManifests = [{ id: "style_imitate_v3",
                          autoEnable: true }]     ✅ override 已注入

gatewayAgent.ts L2697-2703:
  buildStylePipelinePayload({
    activeSkillIds: args.activeSkillIds,  ← 只含 @mention 的 skill
  })
  L213: activeSkillIds 不含 "style_imitate_v3"   ← ❌ Bug 3
  → return {}                                     ← payload 为空

wsTransport.ts L970-971:
  styleExecutionMode: undefined                   ← 未发送
  stylePipelinePayload: undefined                 ← 未发送

─── WS run.request ────────────────────→         runFactory.ts:
                                                   activateSkills → V3 ✅ 激活
                                                   shouldRunStylePipeline:
                                                     styleExecutionMode? ❌ undefined
                                                     stylePipelinePayload? ❌ undefined
                                                   → 走普通 Agent 模式，V3 管线未执行
```

### 断裂点（完整，含已修复）

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| 1 | `wsTransport.ts` L941-948 | `externalSkills` 未应用 `skillOverrides` | ✅ 已修复 `b23a2ae` |
| 2 | `wsTransport.ts` L949-954 | WS payload 缺少 `builtinOverrides` 字段 | ✅ 已修复 `b23a2ae` |
| 3 | `runFactory.ts` L2190-2200 | 手动合并 skill，不读 `builtinOverrides` | ✅ 已修复 `b23a2ae` |
| 4 | `gatewayAgent.ts` L213 | `buildStylePipelinePayload` 只检查 `activeSkillIds`（@mention），不检查 `skillOverrides` | **待修复** |
| 5 | `gatewayAgent.ts` L1731 | `buildContextPack` 用原始 manifests 做 `activateSkills`，不含 override | **待修复** |

### 用户补充线索验证

**线索 1：`/` slash 唤起 vs `@` mention 的 UI 显示差异**

调查结论：**与 bug 无关**。`SlashPopover.tsx` L43 和 `InputBar.tsx` L337 两条路径都创建 `type: "skill"` 的 `MentionItem`，经 `createChipElement()` 后进入同一个 `mentions` 数组。数据流完全一致，UI 显示 `@` 是纯展示层问题。

**线索 2：`@风格库` + 写作意图 → 是否硬编码为 V1？**

调查结论：**不是硬编码**。`activateSkills()` 中 `has_style_library` 是通用 trigger，检查 `kbSelected` 中是否有 `purpose: style` 的库。V1 和 V3 都声明了这个 trigger。但 V1 的 `autoEnable: true` 使其先于 V3（`autoEnable: false`）自动激活。一旦 Bug 1-2 修复后 V1 被 override 禁用，V3 可以正常通过此 trigger 激活。问题回到 Bug 3：Desktop 没构建 payload。

---

## 2. 修复方案

### Fix 1-3: Desktop → Gateway Override 传播（已修复）

**提交**：`b23a2ae` — fix(skill): propagate overrides to gateway

- Fix 1：`wsTransport.ts` — 外部 Skill manifest 注入 override（L941-948）
- Fix 2：`wsTransport.ts` — 发送 `builtinOverrides` 字段（L949-954）
- Fix 3：`runFactory.ts` — 用 `mergeSkillManifests()` 替代手动合并

详细方案见原始 spec 内容，此处不再重复。

### Fix 4a: Desktop — buildStylePipelinePayload 识别 Settings 开关（P0）

**文件**: `apps/desktop/src/agent/gatewayAgent.ts`
**位置**: L213

**当前代码**:
```typescript
if (!activeSkillIds.includes("style_imitate_v3")) return {};
```

**修改后**:
```typescript
const { skillOverrides } = (await import("../state/skillStore")).useSkillStore.getState();
const v3Requested =
  activeSkillIds.includes("style_imitate_v3") ||
  skillOverrides["style_imitate_v3"]?.enabled === true;
if (!v3Requested) return {};
```

**原理**：`activeSkillIds` 只包含 @mention 的 skill。用户通过 Settings 开启 V3 时，意图记录在 `skillOverrides` 中。两个来源取 OR：@mention 或 Settings 开启，都应构建 pipeline payload。

**为什么不在 Desktop 复制 Gateway 的 `activateSkills()` 逻辑**：
1. 维护负担——两端逻辑必须永远同步
2. 性能——`activateSkills()` 含排序、conflicts 检查、trigger 求值等
3. 没有必要——用户显式开启 V3 就是最直接的意图信号，不需要再走一遍 trigger 推断

**为什么不修改 Gateway 放宽 `shouldRunStylePipeline` 条件**：
- Gateway 的 fail-close 设计是正确的：没有 payload（风格库数据、步骤素材等）就不该跑 pipeline
- Pipeline payload 中包含 Desktop 本地数据（KB 指纹、cluster rules、playbook cards），Gateway 无法自行构建
- 放宽条件会在 payload 缺失时运行 pipeline → 步骤全部失败

### Fix 4b: Desktop — buildContextPack 使用有效 manifests（P1）

**文件**: `apps/desktop/src/agent/gatewayAgent.ts`
**位置**: L1731

**当前代码**:
```typescript
const allManifests = [...listRegisteredSkills(), ...useSkillStore.getState().externalSkills];
```

**修改后**:
```typescript
const { externalSkills: extSkills, skillOverrides: overrides } = useSkillStore.getState();
const allManifests = mergeSkillManifests({
  builtinOverrides: Object.fromEntries(
    Object.entries(overrides ?? {})
      .filter(([, o]) => typeof o?.enabled === "boolean")
      .map(([id, o]) => [id, { enabled: o!.enabled }]),
  ),
  userSkills: extSkills ?? [],
});
```

**需要导入**（文件头部）:
```typescript
import { mergeSkillManifests } from "@ohmycrab/agent-core";
```

**原理**：`buildContextPack` 中的 `activateSkills()` 用于生成 `ACTIVE_SKILLS(JSON)` 系统提示词，告诉模型哪些 skill 已激活。使用原始 manifests 会导致 V1 显示为已激活（`autoEnable: true`），V3 显示为未激活——与用户实际配置矛盾。使用 `mergeSkillManifests()` 复用 override 注入逻辑。

**优先级 P1 的理由**：这个 bug 只影响系统提示词中的 skill 列表展示，不影响 Gateway 的实际激活决策和 pipeline 路由。模型看到错误的列表可能导致行为偏差，但不是 V3 管线无法运行的直接原因。

---

## 3. 数据流（全部修复后）

```
Desktop                                          Gateway
────────────────────────────────────────────     ────────────────────────────────────

skillStore:
  skillOverrides = {
    style_imitate_v3: { enabled: true },
    style_imitate: { enabled: false },
  }

gatewayAgent.ts (Fix 4a):
  buildStylePipelinePayload:
    v3Requested = true                           ← skillOverrides 识别
    → 构建完整 payload（KB 指纹、cluster、materials）
    → styleExecutionMode = "pipeline_v1"
    → stylePipelinePayload = { version, taskSpec, materialsByStep }

buildContextPack (Fix 4b):
  allManifests = mergeSkillManifests({            ← override 已注入
    builtinOverrides: { style_imitate: false, style_imitate_v3: true },
    userSkills: externalSkills,
  })
  activateSkills → V3 激活 + V1 禁用
  ACTIVE_SKILLS(JSON) 显示正确 ✅

wsTransport.ts (Fix 1+2, 已提交):
  builtinOverrides: { ... }                      ✅
  userSkillManifests: [{ autoEnable: true }]     ✅
  styleExecutionMode: "pipeline_v1"              ✅ (Fix 4a)
  stylePipelinePayload: { ... }                  ✅ (Fix 4a)

─── WS run.request ────────────────────→         runFactory.ts (Fix 3, 已提交):
                                                   mergeSkillManifests → V3 激活, V1 禁用
                                                   shouldRunStylePipeline:
                                                     styleExecutionMode = "pipeline_v1" ✅
                                                     activeSkillIds has "style_imitate_v3" ✅
                                                     stylePipelinePayload exists ✅
                                                     styleGateEnabled ✅
                                                     isWritingTask ✅
                                                   → PipelineExecutor.run() 🎉
```

---

## 4. 边界情况

| 场景 | 行为 |
|------|------|
| 用户没有任何 override（全部默认） | `v3Requested = false`（activeSkillIds 空 + override 无），不构建 payload，V1 autoEnable=true 在 Gateway 激活 → 与当前行为完全一致 |
| 用户只开 V3 不关 V1 | Desktop 构建 payload，Gateway 端 V3 priority=120 先激活 → conflicts 阻止 V1 |
| 用户只关 V1 不开 V3 | `v3Requested = false`，V1 被 override 禁用 → 无 style skill 激活 |
| 用户 /风格仿写管线 slash 命令 | `activeSkillIds` 包含 `style_imitate_v3`（从 @mention 提取），`v3Requested = true` → 构建 payload |
| 用户 @风格库 + 写作意图（未开 V3） | `v3Requested = false`，不构建 payload，V1 照常通过 trigger 激活 |
| 用户 @风格库 + 写作意图 + 开了 V3 | `v3Requested = true`，构建 payload，Gateway 端 V3 激活 → pipeline 模式 |
| 无风格库绑定（V3 开启） | `v3Requested = true`，但 `resolveImplicitStyleLibraryIds` 返回空 → L226 `if (!libraryId) return {}` → payload 为空 → Gateway fallback 为普通 Agent |
| 多风格库绑定（歧义） | `resolveImplicitStyleLibraryIds` 返回空（fail-close 设计）→ 同上 |
| 旧 Desktop + 新 Gateway | 不发 builtinOverrides，Gateway `mergeSkillManifests({})` → 与原行为一致 |
| buildContextPack 中 override 注入性能 | `mergeSkillManifests` 是纯函数、浅拷贝，manifests 数组通常 < 20 个，无性能问题 |

---

## 5. 影响范围

| 改动 | 影响范围 | 风险 |
|------|---------|------|
| Fix 1-3（已提交） | WS payload + Gateway skill 合并 | 低：已验证等价性 |
| Fix 4a: `buildStylePipelinePayload` 加 `skillOverrides` 检查 | 仅影响 V3 pipeline payload 构建的门控条件 | **极低**：纯新增 OR 分支，不改现有逻辑；`skillOverrides` 为空时 `v3Requested` 与原 `activeSkillIds.includes(...)` 等价 |
| Fix 4b: `buildContextPack` 用 `mergeSkillManifests` | 影响系统提示词中的 `ACTIVE_SKILLS(JSON)` | **低**：只改 manifest 列表来源，`activateSkills()` 逻辑不变；多了 override 注入能力 |

### Fix 4a 安全性分析

```
当前：if (!activeSkillIds.includes("style_imitate_v3")) return {};
修改后：if (!v3Requested) return {};  // v3Requested = activeSkillIds.includes(...) || skillOverrides[...].enabled

等价性：
  - 无 override 时：v3Requested = activeSkillIds.includes(...)  → 完全等价
  - 有 override 且 enabled=true：新增路径，开始构建 payload → 这正是我们要修的
  - 有 override 且 enabled=false：v3Requested = false（除非同时 @mention）→ 不构建 payload

不可能引入回归：原有的 activeSkillIds 检查完整保留，override 只是额外入口。
```

---

## 6. 架构隐患

| 隐患 | 严重度 | 说明 |
|------|--------|------|
| Desktop vs Gateway skill 激活状态不一致 | B | Desktop `buildContextPack` 和 Gateway `runFactory` 各自独立运行 `activateSkills()`，输入 manifests 可能不同。Fix 4b 对齐了 override，但两端的 `kbSelected`、`intent` 等输入仍可能有细微差异 |
| `buildStylePipelinePayload` 硬编码 skill id | A | L213 写死 `"style_imitate_v3"` 字符串。将来若有 V4 或其他 pipeline skill，需要改代码。应改为检查 manifest 的 `kind === "pipeline"` |
| Pipeline payload 构建在 Desktop 阻塞 | B | `buildStylePipelinePayload` 含 KB 指纹、卡片检索等异步操作，在 `done` promise 中同步 await。慢 KB 操作可能延迟 run 启动 |

---

## 7. 验证 checklist

### 场景验证

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| Settings 开 V3 + 关 V1 → 写作请求 | V3 激活，走 pipeline_v1 模式，8 步管线完整执行 | 检查 run.end 中 `stylePipeline.active=true` + `executionMode=pipeline_v1` |
| Settings 全默认 → 写作请求 | V1 激活，走 Agent 模式 | 检查 activeSkillIds 含 `style_imitate`，无 `stylePipelinePayload` |
| `/风格仿写管线` slash → 写作请求 | V3 激活，走 pipeline_v1 | 同上第一行 |
| @风格库 + 写作意图 + V3 未开 | V1 激活，Agent 模式 | 与当前行为一致 |
| @风格库 + 写作意图 + V3 已开 | V3 激活，pipeline 模式 | 检查 stylePipeline.active=true |
| V3 开 + V1 开 | V3 先激活（priority 120 > 100），V1 被 conflicts 阻止 | activeSkillIds 只有 `style_imitate_v3` |
| V3 开 + 无风格库 | V3 payload 构建失败（无 libraryId），降级普通 Agent | 检查无 `stylePipelinePayload` |
| 无 override + 无 @mention | V1 自动激活，Agent 模式 | 回归验证，与当前完全一致 |
| 系统提示词中 ACTIVE_SKILLS | Fix 4b 后应显示 V3 激活、V1 未激活（当 override 如此设置时） | 检查 contextPack 中的 ACTIVE_SKILLS(JSON) |

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 8. 涉及文件清单

| 文件 | 改动类型 | 改动范围 | 状态 |
|------|---------|---------|------|
| `apps/desktop/src/agent/wsTransport.ts` L941-954 | 修改 | Fix 1: override 注入; Fix 2: builtinOverrides 字段 | ✅ 已提交 `b23a2ae` |
| `apps/gateway/src/agent/runFactory.ts` L2190-2200 | 修改 | Fix 3: mergeSkillManifests 替代手动合并 | ✅ 已提交 `b23a2ae` |
| `apps/desktop/src/agent/gatewayAgent.ts` L213 | 修改 | Fix 4a: 加 skillOverrides 检查（~5 行） | **待实施** |
| `apps/desktop/src/agent/gatewayAgent.ts` L1731 | 修改 | Fix 4b: 用 mergeSkillManifests（~8 行） | **待实施** |

待实施改动量：约 13 行修改，零新增文件。
