# 模型上下文窗口（contextWindowTokens）配置

目标：在 **B 端 AI 配置**里为每个模型提供一个可选的“上下文窗口 tokens（MaxTokens）”字段，使后续的：

- L3（运行上下文）预算能按“当前所选模型”的真实上下文容量动态伸缩（例如 80%）
- 自动 compact/滚动摘要触发阈值不再写死，而是跟随模型变化

> 说明：这里的 `contextWindowTokens` 指 **模型输入上下文窗口上限**（prompt + 历史 + 工具注入的总容量）。
> 它 **不是** stage 里的 `maxTokens`（那通常是单次输出/生成 token 上限）。

---

## 字段定义

在 `AiModel` 上新增字段：

- `contextWindowTokens: number | null`

语义：

- `null`：未知/不配置，由运行时使用默认值或 provider registry 推导
- `> 0`：显式指定该模型的上下文窗口 token 上限（例如 128000 / 200000 / 272000）

推荐取值（经验值，按供应商公开信息/实测为准）：

- 32k：`32768`
- 128k：`131072`
- 200k：`200000`
- 256k：`262144`
- 272k：`272000`

---

## B 端 UI 约定

在 `AI 模型管理` 的每个模型卡片中增加一项输入框：

- label：`上下文窗口（MaxTokens）`
- placeholder：`200000`
- 允许为空（表示 `null`）

并在“新建模型”弹窗中也提供同字段（可选）。

---

## 后续预算策略（为 L3 高预算 + 自动 compact 预留）

当该字段可用后，L3 预算可按如下计算（示意）：

- `contextWindow = contextWindowTokens ?? fallbackContextWindow`
- `effectiveInputBudget = floor(contextWindow * 0.8)`（保留 20% 给 system/tool overhead + 输出空间）
- 预算分配建议：
  - `coreRules`：固定上限（能力目录常驻，不可被挤掉）
  - `taskState`：固定上限（MAIN_DOC/TASK_STATE/PROJECT_MAP 等执行态真相源）
  - `memory`：固定上限（L1/L2 锚点 + 少量召回）
  - `L3(context)`：吃掉剩余预算（最大化利用大窗口）
  - `materials`：最后裁剪

验收口径（未来实现 L3 动态预算后）：

- run 审计能看到“本轮模型 contextWindow/effectiveBudget 与各槽预算/使用量”
- 大窗口模型（例如 200k）下 L3 注入明显增大，但 coreRules/taskState 不被挤掉

