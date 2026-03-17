# 风格仿写 V3 Pipeline Skill（style_imitate_v3）

状态：待实施 | 优先级：P1 | 日期：2026-03-17
前置依赖：`feat-workflow-state-persistence-v1.md`（RunState 跨 run 持久化）

## 0. 定位

### 与 v1/v2 的关系

| 版本 | 执行模式 | 序列控制 | 包装形式 |
|------|---------|---------|---------|
| v1 `style_imitate` | Agent 自由编排 + 硬编码门控 | ~2000 行门控代码 | `skills.ts` 内置常量 |
| v2 `style_imitate_v2` | Agent 循环 + 声明式 phase gate | WorkflowPhaseInterpreter | `skills/style_imitate_v2/SKILL.md` |
| **v3 `style_imitate_v3`** | **代码驱动管线 + 每步结构化 LLM call** | **PipelineExecutor** | **`skills/style_imitate_v3/SKILL.md`** |

### 设计约束

1. **纯新增**：不动 v1/v2 的任何一行代码
2. **互斥共存**：`conflicts: ["style_imitate", "style_imitate_v2"]`，同时只有一个版本激活
3. **可插拔**：SKILL.md 放入 `skills/` 目录即可被 skill-loader 加载
4. **断点续写**：被打断的管线下次 run 从当前步继续（依赖 RunState 持久化基础设施）
5. **不动 Gateway 通用逻辑**：新增独立 executor，通过 skill id 路由

---

## 1. 为什么现有 WorkflowPhaseInterpreter 不能直接用

现有基础设施（`workflowPhaseInterpreter.ts`）为 **Agent 循环** 设计：

```
phase gate → 计算允许的工具集 → Agent 自主选择工具 → 更新 runState → 下一轮
```

V3 管线需要的是：

```
step → 代码组装 prompt → 直接 LLM call → 解析输出为 artifact → 下一步
```

| 能力 | WorkflowPhaseInterpreter | V3 需要 |
|------|-------------------------|---------|
| 序列控制 | gate 匹配（boolean 集合运算） | ✅ 可复用 gate 语法 |
| 工具白名单 | `resolveAllowedTools()` | ❌ 不需要——每步不走 Agent |
| 执行方式 | Agent 自选工具 | 代码直接 LLM call |
| 步骤输入 | Agent 自己检索 | 代码预组装（Desktop 预打包） |
| 步骤输出 | Agent 自由输出 | 结构化 artifact（JSON / text） |

**结论**：gate 语法可以复用，但执行引擎必须是新的。不改 WorkflowPhaseInterpreter，新增 PipelineExecutor。

---

## 2. SKILL.md 格式

### 文件结构

```
skills/style_imitate_v3/
  SKILL.md     ← frontmatter（激活规则 + pipeline 声明）+ body（每步 prompt 模板）
```

### Frontmatter

```yaml
---
id: style_imitate_v3
name: 风格仿写管线
description: "绑定风格库后，在写作/改写/润色意图下自动启用：8 步声明式管线（定调 → 骨架 → 开场 → 主体 → 语言风格 → 点睛 → 收束 → Lint），每步独立 LLM call。"
version: "3.0.0"
priority: 120
stageKey: agent.skill.style_imitate_v3
kind: pipeline                    # ← 新 kind，区别于 workflow/hint/service
activationMode: hybrid
autoEnable: false                 # 初期手动启用

triggers:
  - when: mode_in
    args: { modes: ["agent"] }
  - when: has_style_library
    args: { purpose: style }
  - when: run_intent_in
    args: { intents: ["writing", "rewrite", "polish"] }

conflicts: ["style_imitate", "style_imitate_v2"]

toolCaps:
  allowTools: ["write", "edit", "lint.copy", "lint.style"]

policies: ["StyleGatePolicy"]

ui:
  badge: PIPELINE
  color: purple

pipeline:
  configRef: "styleWorkflowPipelineConfigV1"   # 引用 PipelineConfigV1 默认实例
  executionMode: "pipeline_v1"                  # 路由标记

  stateKeys:
    - pipelineStepIndex               # 当前执行到第几步（0-7）
    - pipelineCompleted               # 管线是否已完成
    - hasToneCard                     # Step 0 完成
    - hasStructureOutline             # Step 1 完成
    - hasOpeningDraft                 # Step 2 完成
    - hasBodyDraft                    # Step 3 完成
    - hasStyledDraft                  # Step 4 完成
    - hasPolishedDraft                # Step 5 完成
    - hasFinalDraft                   # Step 6 完成
    - lintLoopCompleted               # Step 7 完成
    - bestStyleScore                  # lint.style 最佳分数
    - bestStyleArtifactId             # lint.style 最佳版本的 artifactId
    - bestCopyScore                   # lint.copy 最佳分数
    - bestCopyArtifactId              # lint.copy 最佳版本的 artifactId

  steps:
    - id: tone_setting
      index: 0
      gate: { allFalse: [hasToneCard] }
      executor: llm_structured       # JSON 输出（ToneCardV1）
      outputArtifact: toneCard
      hint: "管线第 0 步：定调。组装 TaskSpec + ClusterRules → LLM → 输出 ToneCard JSON。"

    - id: structure
      index: 1
      gate: { allTrue: [hasToneCard], allFalse: [hasStructureOutline] }
      executor: llm_structured       # JSON 输出（StructureOutlineV1）
      outputArtifact: structureOutline
      hint: "管线第 1 步：骨架。ToneCard + hook/outline 卡片 → LLM → 输出 StructureOutline JSON。"

    - id: opening
      index: 2
      gate: { allTrue: [hasToneCard, hasStructureOutline], allFalse: [hasOpeningDraft] }
      executor: llm_text             # 纯文本输出
      outputArtifact: openingDraft
      hint: "管线第 2 步：开场。StructureOutline + hook 卡片 → LLM → 输出开场段落文本。"

    - id: body
      index: 3
      gate: { allTrue: [hasToneCard, hasStructureOutline, hasOpeningDraft], allFalse: [hasBodyDraft] }
      executor: llm_text
      outputArtifact: bodyDraft
      hint: "管线第 3 步：主体。开场段落 + StructureOutline + 维度卡 → LLM → 输出主体段落文本。"

    - id: language_rhythm
      index: 4
      gate: { allTrue: [hasOpeningDraft, hasBodyDraft], allFalse: [hasStyledDraft] }
      executor: llm_text
      outputArtifact: styledDraft
      hint: "管线第 4 步：语言风格。全文草稿 + voice_rhythm/language_style 卡 → LLM → 输出风格化全文。"

    - id: polish
      index: 5
      gate: { allTrue: [hasStyledDraft], allFalse: [hasPolishedDraft] }
      executor: llm_text
      outputArtifact: polishedDraft
      hint: "管线第 5 步：点睛。风格化全文 + one_liner 卡 → LLM → 输出点睛后全文。"

    - id: closure
      index: 6
      gate: { allTrue: [hasPolishedDraft], allFalse: [hasFinalDraft] }
      executor: llm_text
      outputArtifact: finalDraft
      hint: "管线第 6 步：收束。点睛后全文 + ending 卡 + ToneCard.step6ClosureBrief → LLM → 输出终稿。"

    - id: lint_loop
      index: 7
      gate: { allTrue: [hasFinalDraft], allFalse: [lintLoopCompleted] }
      executor: lint_loop             # 特殊执行器：lint.copy → lint.style → 选最佳
      hint: "管线第 7 步：Lint 闭环。lint.copy（最多 3 次）→ lint.style（最多 3 次，选最高分）→ write 落盘。"

  lint:
    maxCopyAttempts: 3
    maxStyleAttempts: 3
    pickBestOnExhaust: true
---
```

### Body（系统提示词）

SKILL.md body 部分仅在管线**未激活**或**降级回 Agent 模式**时注入。管线模式下每步有独立 prompt，不使用 body。

```markdown
当 skill=style_imitate_v3 激活时：

**本 Skill 使用管线执行模式（pipeline_v1），每步由系统自动驱动 LLM call。**
**你不需要自主选择工具——系统会按 8 步顺序自动执行。**

如果管线执行失败或降级，才会回退到 Agent 模式，此时请按以下规则操作：
（以下规则与 style_imitate_v2 body 相同，此处省略——实际 SKILL.md 中完整写入）
```

---

## 3. 新增基础设施

### 3.1 SkillManifest 类型扩展

**文件**: `packages/agent-core/src/skills.ts`

```typescript
export type SkillKind = "workflow" | "hint" | "service" | "pipeline";  // 新增 pipeline

// SkillManifest 新增可选字段
export type SkillManifest = {
  // ... 现有字段不动 ...

  /** 可选：声明式 Workflow 配置（kind=workflow 使用） */
  workflow?: import("./workflowPhaseInterpreter.js").WorkflowDeclaration;

  /** 可选：Pipeline 配置（kind=pipeline 使用） */
  pipeline?: PipelineDeclaration;
};

// Pipeline 声明类型
export type PipelineStepDecl = {
  id: string;
  index: number;
  gate: import("./workflowPhaseInterpreter.js").PhaseGate;  // 复用 gate 语法
  executor: "llm_structured" | "llm_text" | "lint_loop";
  outputArtifact: string;
  hint: string;
};

export type PipelineLintConfig = {
  maxCopyAttempts: number;
  maxStyleAttempts: number;
  pickBestOnExhaust: boolean;
};

export type PipelineDeclaration = {
  configRef: string;
  executionMode: string;
  stateKeys: string[];
  steps: PipelineStepDecl[];
  lint: PipelineLintConfig;
};
```

### 3.2 skill-loader.mjs 扩展

**文件**: `apps/desktop/electron/skill-loader.mjs`

`parseManifest()` 中新增 pipeline 字段透传（与 workflow 同理）：

```javascript
// 已有（不动）：
...(isObj(raw.workflow) ? { workflow: raw.workflow } : {}),
// 新增：
...(isObj(raw.pipeline) ? { pipeline: raw.pipeline } : {}),
```

### 3.3 PipelineExecutor（核心新增）

**文件**: `apps/gateway/src/agent/pipelineExecutor.ts`（新增文件）

这是管线的核心执行引擎。**不动 GatewayRuntime 的 Agent 循环逻辑**，而是在 runFactory 层面分流。

```typescript
/**
 * PipelineExecutor — 声明式管线执行器
 *
 * 读取 PipelineDeclaration + PipelineConfigV1，按 step 顺序执行：
 * 1. matchGate() 找到当前应执行的 step
 * 2. 根据 executor 类型组装 prompt + 发 LLM call
 * 3. 解析输出为 artifact，更新 runState
 * 4. 循环直到所有 step 完成
 *
 * 不走 agentLoop —— 直接复用 Gateway 的 provider adapter 发结构化请求。
 */
export class PipelineExecutor {
  static async run(args: {
    pipeline: PipelineDeclaration;
    pipelineConfig: PipelineConfigV1;
    payload: StylePipelinePayloadV1;
    runCtx: RunContext;
    runState: RunState;
  }): Promise<PipelineRunResult> {
    // 1. 从 runState 中恢复当前进度（断点续写）
    // 2. 遍历 steps，matchGate 找到当前 step
    // 3. 根据 executor 类型分发：
    //    - llm_structured: 组装 prompt → LLM call → JSON.parse → 存 artifact
    //    - llm_text: 组装 prompt → LLM call → 存 artifact
    //    - lint_loop: 走 lint.copy/lint.style 循环（复用现有 sidecar 通道）
    // 4. 每步完成后 writeEvent("run.execution.report", { step, artifact })
    // 5. 更新 runState 对应 stateKey
    // 6. 全部完成后通过 write 工具落盘终稿
  }
}
```

### 3.4 runFactory 路由分流

**文件**: `apps/gateway/src/agent/runFactory.ts`

在现有 `GatewayRuntime.run()` 调用之前，新增 pipeline 分支。**不改现有代码，只加 if 分支**。

```typescript
// ── 现有代码（不动）──
// const runtime = new GatewayRuntime({ mode: "pi", runCtx } as any, kernel);
// const result = await runtime.run(userPrompt, images);

// ── 新增：pipeline 分支 ──
const pipelineSkill = activeSkills.find(
  (s) => skillRegistry.get(s.id)?.kind === "pipeline"
);

if (pipelineSkill) {
  const manifest = skillRegistry.get(pipelineSkill.id);
  const pipelineDecl = manifest?.pipeline;
  const payload = (runCtx as any).stylePipelinePayload;

  if (pipelineDecl && payload) {
    // 走管线执行器，不走 GatewayRuntime
    const result = await PipelineExecutor.run({
      pipeline: pipelineDecl,
      pipelineConfig: getDefaultPipelineConfig(),
      payload,
      runCtx,
      runState,
    });
    // 处理 result...
    return;
  }
  // else: pipeline payload 不完整，降级走 Agent 模式
}

// ── 现有 Agent 路径继续（不动）──
```

---

## 4. 断点续写

### 依赖

`feat-workflow-state-persistence-v1.md` 中的 RunState 跨 run 持久化机制。

### 需要持久化的 stateKey

在 `PERSISTABLE_STATE_KEYS` 白名单中新增 V3 专用的 key：

```typescript
// V3 pipeline 进度
"pipelineStepIndex",
"pipelineCompleted",
"hasToneCard",
"hasStructureOutline",
"hasOpeningDraft",
"hasBodyDraft",
"hasStyledDraft",
"hasPolishedDraft",
"hasFinalDraft",
"lintLoopCompleted",
"bestStyleScore",
"bestStyleArtifactId",
"bestCopyScore",
"bestCopyArtifactId",
```

### Artifact 持久化

每步的 artifact（ToneCard JSON、StructureOutline JSON、各段文本）需要随 runState 一起保存，否则续写时有 stateKey=true 但没有上一步的输出内容。

方案：在 `runStatePatch` 中新增 `pipelineArtifacts` 字段：

```typescript
type PipelineArtifactsV1 = {
  toneCard?: ToneCardV1 | null;
  structureOutline?: StructureOutlineV1 | null;
  openingDraft?: string | null;
  bodyDraft?: string | null;
  styledDraft?: string | null;
  polishedDraft?: string | null;
  finalDraft?: string | null;
};
```

这个字段也走 `mainDoc.workflowV1.runStatePatch.pipelineArtifacts` 通道。需要在 `PERSISTABLE_STATE_KEYS` 中加上 `"pipelineArtifacts"`。

### 续写流程

```
Run N（被打断，Step 3 完成）:
  runState = { pipelineStepIndex: 3, hasToneCard: true, hasStructureOutline: true, hasOpeningDraft: true, hasBodyDraft: true, ... }
  pipelineArtifacts = { toneCard: {...}, structureOutline: {...}, openingDraft: "...", bodyDraft: "..." }
  → 存入 mainDoc.workflowV1.runStatePatch

Run N+1:
  → Gateway merge runStatePatch 进 initialRunState
  → PipelineExecutor: matchGate 遍历 steps → Step 4 是第一个匹配的
  → Step 4 使用 pipelineArtifacts.openingDraft + pipelineArtifacts.bodyDraft 作为输入
  → 从 Step 4 继续
```

---

## 5. Desktop 侧预打包

### 已有设施复用

Desktop 已有 `buildContextPack()` 函数组装 context，新增 `buildStylePipelinePayload()` 函数（不改现有函数）。

**触发条件**：当 v3 skill 激活时（`activeSkillIds.includes("style_imitate_v3")`），Desktop 在发起 run 时调用 `buildStylePipelinePayload()` 预打包所有步骤所需的卡片材料。

**transport 字段**：在 `run.request` payload 中新增两个字段：
- `styleExecutionMode: "pipeline_v1"` — 告诉 Gateway 走管线
- `stylePipelinePayload: StylePipelinePayloadV1` — 预打包的材料

### StylePipelinePayloadV1 结构

```typescript
export type StylePipelinePayloadV1 = {
  version: "v1";
  taskSpec: TaskSpecV1;                           // 代码预组装的任务规格
  materialsByStep: Record<string, StepMaterials>; // 按步分组的卡片
  styleProfile?: StyleProfileV1 | null;           // Step 4 用的完整风格侧写
};

export type StepMaterials = {
  cards: Array<{
    id: string;
    cardType: string;
    dimension?: string;
    title: string;
    content: string;
  }>;
  playbook?: Array<{
    dimensionId: string;
    label: string;
    ruleText: string;
  }>;
};
```

---

## 6. 不动的东西（红线清单）

| 文件 | 不动的理由 |
|------|-----------|
| `packages/agent-core/src/workflowPhaseInterpreter.ts` | v2 专用，v3 不走这条路 |
| `apps/gateway/src/agent/styleOrchestrator.ts` | v1 专用 |
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` 中的 v1/v2 style 门控 | 通过 skill conflicts 互斥，v3 激活时 v1/v2 不激活 |
| `packages/agent-core/src/skills.ts` 中的 `STYLE_IMITATE_SKILL` | v1 内置常量，不动 |
| `skills/style_imitate_v2/SKILL.md` | v2 包，不动 |
| `apps/gateway/src/agent/runFactory.ts` 中的 v1/v2 分支 | 只加 v3 分支，不改现有 |

---

## 7. 迁移路径

### Phase 0：类型 + 配置

1. `packages/agent-core/src/skills.ts` — `SkillKind` 加 `"pipeline"`、`SkillManifest` 加 `pipeline?` 字段、新增 `PipelineDeclaration` 等类型
2. `packages/agent-core/src/styleWorkflowTypes.ts` — 新增文件，所有 V3 类型定义（来自 `feat-style-writing-workflow-pipeline-v1.md` 第 5 节）
3. `packages/agent-core/src/styleWorkflowConfig.ts` — 新增文件，`PipelineConfigV1` 默认实例

### Phase 1：Skill 包 + Loader

1. `skills/style_imitate_v3/SKILL.md` — 新增 skill 包
2. `apps/desktop/electron/skill-loader.mjs` — `parseManifest` 透传 `pipeline` 字段（1 行）
3. `autoEnable: false`，手动测试

### Phase 2：PipelineExecutor

1. `apps/gateway/src/agent/pipelineExecutor.ts` — 新增核心执行器
2. `apps/gateway/src/agent/runFactory.ts` — pipeline 路由分支（在现有代码前加 if）
3. 不动 GatewayRuntime

### Phase 3：Desktop 预打包

1. `apps/desktop/src/agent/gatewayAgent.ts` — 新增 `buildStylePipelinePayload()`
2. `apps/desktop/src/agent/wsTransport.ts` — `run.request` 增加 `styleExecutionMode` + `stylePipelinePayload` 字段
3. `feat-workflow-state-persistence-v1.md` 的 `PERSISTABLE_STATE_KEYS` 扩展 V3 专用 key

### Phase 4：验证 + 切换

1. 通过 skillOverrides 启用 v3：`{ style_imitate: { enabled: false }, style_imitate_v3: { enabled: true } }`
2. 手动验证：绑定风格库 → 8 步管线正常 → lint loop 择优 → write 落盘
3. 验证断点续写：Step 3 后取消 → 下次 run 从 Step 4 继续
4. 验证降级：pipeline payload 缺失 → 降级走 Agent 模式
5. 稳定后 `autoEnable: true`

---

## 8. 与 RunState 持久化的关系

| 能力 | 无持久化时 | 有持久化后 |
|------|-----------|-----------|
| 管线正常执行 | ✅ 正常，单 run 内完成 | ✅ 相同 |
| 管线被打断 | ❌ 下次从 Step 0 重来 | ✅ 从断点 step 续写 |
| lint loop 最佳分数保留 | ❌ 丢失 | ✅ 跨 run 保留 bestStyleScore |

持久化是 V3 的**增强能力**，不是前置依赖。V3 管线可以在无持久化时正常工作（单 run 内完成），持久化只是让断点续写成为可能。

**建议实施顺序**：先做 Phase 0-2（管线能跑起来），再做持久化（让断点续写生效）。

---

## 9. 验证 Checklist

### 功能验证

| 场景 | 预期 | 验证方式 |
|------|------|---------|
| v3 skill 加载 | skill-loader 正确解析 pipeline 字段 | 检查 SkillRegistry 中有 style_imitate_v3 |
| v3 激活时 v1/v2 不激活 | conflicts 互斥 | 检查 activateSkills 输出 |
| 管线正常 8 步 | Step 0→7 顺序执行，write 落盘 | 绑定风格库 + 写作请求 |
| Step 7 lint loop 择优 | 3 次中选最高分 | 检查 bestStyleScore |
| pipeline payload 缺失 | 降级走 Agent 模式 | 不传 stylePipelinePayload |
| 断点续写（有持久化时） | 从断点 step 继续 | 取消 run → 检查 runStatePatch → 重新 run |

### 回归验证

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

确认 v1/v2 测试场景全部不受影响。

---

## 10. 涉及文件清单

### 新增文件

| 文件 | 内容 |
|------|------|
| `skills/style_imitate_v3/SKILL.md` | V3 skill 包（frontmatter + body） |
| `packages/agent-core/src/styleWorkflowTypes.ts` | 所有 V3 类型定义 |
| `packages/agent-core/src/styleWorkflowConfig.ts` | PipelineConfigV1 默认实例 |
| `apps/gateway/src/agent/pipelineExecutor.ts` | 管线执行器 |

### 改动文件（仅新增逻辑，不改现有代码）

| 文件 | 改动 |
|------|------|
| `packages/agent-core/src/skills.ts` | `SkillKind` 加 `"pipeline"`、`SkillManifest` 加 `pipeline?` 字段 |
| `apps/desktop/electron/skill-loader.mjs` | `parseManifest` 透传 `pipeline` 字段（1 行） |
| `apps/gateway/src/agent/runFactory.ts` | pipeline 路由分支（if 分支，~20 行） |
| `apps/desktop/src/agent/gatewayAgent.ts` | 新增 `buildStylePipelinePayload()` |
| `apps/desktop/src/agent/wsTransport.ts` | `run.request` 增加 2 个字段 |
| `packages/agent-core/src/runMachine.ts` | `PERSISTABLE_STATE_KEYS` 扩展 V3 key |

---

## 11. 与管线 spec 的关系

本文档是 `feat-style-writing-workflow-pipeline-v1.md` 的 **Skill 包装层**。管线 spec 定义了"8 步管线做什么"，本文档定义了"如何用 SKILL.md 格式包装管线、如何融入现有 crab 基础设施"。

| 关注点 | 管线 spec | 本文档 |
|--------|----------|--------|
| 8 步的 prompt 设计 | ✅ 定义 | 引用 |
| 数据结构（TypeScript 类型） | ✅ 定义 | 引用 |
| PipelineConfigV1 默认值 | ✅ 定义 | 引用 |
| SKILL.md 格式 | — | ✅ 定义 |
| skill-loader / SkillManifest 扩展 | — | ✅ 定义 |
| PipelineExecutor 架构 | — | ✅ 定义 |
| 断点续写机制 | — | ✅ 定义 |
| Gateway 路由分流 | 提及 | ✅ 详细定义 |
| Desktop 预打包 | 提及 | ✅ 详细定义 |
