# 上下文架构路线图（P0-P3）

> 面向：写作 IDE（桌面端 + 本地 Gateway）
>
> 目标：把“规则、能力边界、任务主线、记忆、材料”从巨大 `contextPack` 大字符串里解耦出来，形成可预算、可观测、可演进的上下文架构。

---

## 背景问题

当前 Desktop 会把大量信息拼成 `contextPack: string` 传给 Gateway。随着 KB / 风格库 / 参考材料 / 多层记忆增长，模型在 system 中“先看到什么”变得不稳定：

- 工具边界（尤其 MCP 能力）会被大量材料和记忆淹没，模型变“傻”，无法稳定知道自己能干什么。
- 任务主线（MAIN_DOC / TASK_STATE / TODO）可能被挤压，导致跑偏。
- 记忆（L1/L2）会线性膨胀，token 成本和噪声随时间恶化。
- 调试困难：只有一个大包，很难回答“到底哪些上下文进模型了、被裁掉了什么”。

---

## P0：先止血，1 天内可落地

### 目标
- 不再让大 `contextPack` 淹没工具边界与任务主线。
- 先用最小改动在 Gateway 侧“重组注入顺序 + 降权材料”。

### 核心改动
1) **新增 Context Assembler（Gateway 侧）**
- Gateway 不再把 `body.contextPack` 整包直塞 system。
- 改为：解析 → 分段 → 按槽位重组 → 多条 system 注入。

2) **新增“能力目录块”常驻 system**
- 内置工具家族摘要（按前缀分组）
- MCP servers + MCP 能力家族摘要（浏览器/文档/表格等）
- 明确“若工具清单存在专用 MCP，优先使用，不要退回伪流程”

3) **KB/STYLE/REFERENCES 进入 materials 槽（降权 + 裁剪）**
- 这些只作为参考材料，不允许覆盖 system policy / capability / taskState。

### 验收
- 每次 run 的 `run.notice` 能看到 `core/task/memory/materials` 各槽 chars。
- system prompt 明显变短（至少不再出现整包 contextPack）。
- 即使 KB/style 很多，模型仍稳定知道 `Playwright/Word/Excel` 是否可用。

### 当前实现状态（截至 2026-03-10）
- ✅ 已落地（本地 Gateway），并在本地审计中验证通过。

---

## P1：四槽分层，形成真正上下文架构

### 目标
把“规则、任务、记忆、材料”彻底解耦成四槽，并建立预算/优先级/降级策略。

### 四槽定义
- `coreRules`：固定 system 规则 + capability summary（常驻）
- `taskState`：`MAIN_DOC` / `RUN_TODO` / `TASK_STATE` / `PENDING_ARTIFACTS` / `EDITOR_SELECTION`
- `memoryRecall`：L1/L2 锚点常驻 + 按需召回
- `materials`：KB/style/references/外部引用（永远最后、永远可裁剪）

### 核心改动
1) **每槽单独预算与降级策略**
- `taskState` 永远先保。
- `materials` 永远最后裁。
- `memoryRecall` 不允许无限膨胀：短记忆全文注入；长记忆改“锚点 + query-driven”。

2) **可观测性**
- 每次运行记录：每槽 chars + 保留/裁掉了哪些 segments。
- context manifest 不再只做统计，而是参与 selector/budget（后续增强点）。

3) **写入可信度分层（防幻觉污染）**
- 记忆提取 ops 中要求标注 `source=user|assistant|consensus`。
- `assistant` 来源默认不自动落盘（或降权到需要确认）。

4) **子 Agent 记忆注入按角色模板化**
- copywriter / topic_planner / seo_specialist 各自只看必要 section。

### 验收
- `materials` 再大也不会挤掉 `MAIN_DOC` 和能力边界。
- 审计可回答“本轮哪些 segment 被裁剪”。
- memory.extract 的 assistant 来源不会自动污染长期记忆。

### 当前实现状态（截至 2026-03-10）
- ✅ 已落地（本地 Gateway）：四槽注入、长记忆锚点召回、来源可信度分层、子 Agent 角色模板。
- ⏳ 待增强：把 context manifest 变成 selector/budget 的强驱动信号（目前主要用于记录与调试）。

---

## P2：记忆下沉到 Gateway（锚点常驻 + 按需召回）

### 目标
三层记忆不再由 Desktop 先拼好“最终注入内容”，而由 Gateway 统一选择，保证不同客户端一致。

### 核心改动
- Gateway 侧实现 `memoryRecall` 模块：
  - 常驻锚点：
    - L1：`用户画像`、`决策偏好`
    - L2：`项目决策`（可选加 `重要约定`）
  - query-driven：`跨项目进展 / 项目概况 / 重要约定 / 当前进展`
- transcript recall 默认关闭，不把旧会话当长期记忆。

### 验收
- Desktop 不再决定 L1/L2 最终注入内容。
- 同一用户输入，在不同客户端上记忆召回结果一致。
- 记忆不会和任务状态抢预算。

---

## P3：协议升级，彻底摆脱“大字符串 contextPack”

### 目标
不再靠正则从 `contextPack` 里抠 `MAIN_DOC`、`RUN_TODO`、`L1`、`L2`。

### 核心改动
- 请求体从：
  - `contextPack: string`
- 升级为：
  - `contextSegments: Array<{ id, name, kind, priority, trusted, content, meta }>`
  - `contextManifest`
- Gateway 直接基于结构化 segment 做 selector/budget，不再 `parseXxxFromContextPack()`。
- 旧 `contextPack` 保留一段时间做兼容 fallback。

### 验收
- `parseMainDocFromContextPack` 这类函数进入兼容层，不再是主流程。
- selector 可按 `segment id / kind / source / trust` 精确裁剪。
- 后续加新上下文类型时不再改一堆正则。

---

## 建议执行顺序
- 先做 `P0`：马上止血
- 再做 `P1`：架构立住
- 再做 `P2`：记忆成为系统能力
- 最后做 `P3`：技术债一次清掉
