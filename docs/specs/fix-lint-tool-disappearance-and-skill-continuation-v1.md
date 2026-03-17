# fix-lint-tool-disappearance-and-skill-continuation-v1

lint.copy / lint.style 工具从工具池永久消失 + /skill 重新唤起被误判为"继续上一轮"

状态：待实施 | 优先级：P0 | 日期：2026-03-17

## 0. 现象

### 现象 A：lint.copy / lint.style 工具从工具池中完全消失

用户 `/风格仿写闭环` 激活 `style_imitate`，选择风格库，请求写口播稿。

Agent 行为：
1. `kb.search` 检索风格样例 — 正常
2. `write` 生成候选草稿 — 正常
3. 进入 lint 阶段时，Agent 输出："两个 lint 工具本轮均不可用，降级直接交付"
4. 闭环被跳过，`lint.copy / lint.style` 从头到尾未出现在工具池中

Agent 日志中反复出现“本轮工具池持续不可用”，说明这不是 per-turn gate 的动态限制，而是 run 初始化阶段就已经把 lint 工具从候选中删除了。

### 现象 B：/skill 重新唤起默认"接着写"而非开新任务

用户完成一篇口播稿后，在新的 Run 中再次 `/风格仿写闭环`（想换风格库/换主题）。

Agent 行为：
1. 不询问新主题，直接说"我们接着上次的继续"
2. 恢复上一轮的 pending artifact 和 mainDoc 状态
3. 用户实际想要的是全新写作任务，但系统把 `/skill` 唤起当成了 workflow continuation

---

## 1. 根因分析

### 根因 1（S 级）：L2808 gate 在 selectToolSubset 之前删除 lint 工具，且 lint 不在 CORE_TOOL_NAME_SET 中

**文件**：
- `apps/gateway/src/agent/runFactory.ts:2808-2816`（styleSkillActive gate）
- `apps/gateway/src/agent/runFactory.ts:3015-3036`（selectToolSubset + ensureCoreToolsSelected）
- `apps/gateway/src/agent/coreTools.ts:3-37`（CORE_TOOL_NAME_SET 定义）
- `apps/gateway/src/agent/styleOrchestrator.ts:167-168`（addIfAllowed 静默跳过）

**机制分析**：

Desktop 侧 `/skill` 唤起的数据通路：
用户 `/风格仿写闭环` → SlashPopover 选择
→ `MentionItem{type:"skill", id:"style_imitate"}`
→ `ChatArea.handleSend: activeSkillIds = mentions.filter(m.type==="skill").map(m.id)`
→ WebSocket payload: `{ activeSkillIds: ["style_imitate"] }`
→ Gateway: `body.activeSkillIds` → `mentionedSkillIds (L2183)`

Gateway 侧调用链：

`L2183`: `mentionedSkillIds` 从 `body.activeSkillIds` 解析
`L2173`: `activateSkills()` 自动激活检测
`L2188-2214`: 合并 `/skill` 唤起但未自动激活的 Skill → `rawActiveSkills`
`L2238`: `activeSkillIds = rawActiveSkills.map(...)`

                      ↓ 问题在这里 ↓

`L2808-2816`: `styleSkillActive` 检查
  → `activeSkillIds.includes("style_imitate")` ← 需要 `style_imitate` 已在 `activeSkillIds` 中
  → 但 `activateSkills()` 的 triggers 全部要求三条规则同时满足：
     (1) `mode_in: ["agent"]`
     (2) `has_style_library: purpose=style`
     (3) `run_intent_in: ["writing", "rewrite", "polish"]`
  → 如果 (2) 或 (3) 不满足（例如 `kbSelected` 为空、或 `intent` 未识别为写作），
     `style_imitate` 不会自动激活

  → 此时 `mentionedSkillIds` 中有 `"style_imitate"`，`L2188-2214` 的合并逻辑
     会将其加入 `rawActiveSkills` → 最终进入 `activeSkillIds`
  → 但如果合并逻辑因 `conflicts/requires` 等原因跳过了该 skill，
     或在某些边界情况下 `body.activeSkillIds` 为空，则 lint 工具被删除

`L2808`: `if (!styleSkillActive)` → 删除 `lint.copy / lint.style`

                      ↓

`L3015`: `selectToolSubset()` top-K 选择 → lint 工具已不在候选中，永远不会被选中
`L3036`: `ensureCoreToolsSelected()` 兜底 → 但 `lint.copy / lint.style` 不在 `CORE_TOOL_NAME_SET` 中

                      ↓

`L3611-3618`: `computeStyleTurnCaps` → `addIfAllowed("lint.copy")`
  → `addIfAllowed` 检查 `baseAllowedToolNames.has("lint.copy")` → false（已被删除）
  → 静默跳过，lint 工具在整个 run 中永远不可用

三个子问题叠加：
1. `L2808 gate` 过早删除：在 `selectToolSubset` 之前执行，删除后无法恢复
2. `CORE_TOOL_NAME_SET` 不含 lint：`coreTools.ts:3-37` 定义了 26 个核心工具，不包含 `lint.copy / lint.style`，`ensureCoreToolsSelected` 无法兜底
3. `addIfAllowed` 静默失败：`styleOrchestrator.ts:167-168` 用 `if (args.baseAllowedToolNames.has(toolName))` 检查，lint 已被删除时不报错，直接跳过

关键洞察：`L2808 gate` 的 `styleSkillActive` 判断只看 `activeSkillIds`（`L2238` 之后的最终结果），不直接看 `mentionedSkillIds`（`L2186` 的原始输入）。如果合并逻辑因任何原因未将 skill 加入 `activeSkillIds`，lint 工具就会被永久删除。需要增加一层 `mentionedSkillIdSet` 的直接检查作为兜底。

### 根因 2（A 级）：looksLikeWorkflowContinuationPrompt 仅基于文本，不感知 /skill 唤起

**文件**：
- `apps/gateway/src/agent/runFactory.ts:1114-1125`（looksLikeWorkflowContinuationPrompt）
- `apps/gateway/src/agent/runFactory.ts:1070-1112`（shouldPreferPendingWriteResume / shouldPreferPendingWriteResumeFromTaskState）
- `apps/gateway/src/agent/runFactory.ts:1027-1052`（classifyDirectiveIntent）
- `apps/gateway/src/agent/runFactory.ts:2131-2154`（调用点）

**机制分析**：

Desktop 发送 `/skill` 唤起时，`body.activeSkillIds` 携带了 skill id，但 `prompt`
字段只包含用户输入的文本（SlashPopover 选择后 chip 被序列化移除，纯文本可能只是简短指令或空）。

当用户 `/风格仿写闭环`（无后续指令文本）时：

`L2131: shouldPreferPendingWriteResumeFromTaskState({
  taskState, userPrompt, projectDirAvailable, intent
})`
  → prompt 可能是空或极短
  → `L1081: if (!prompt) return true`  ← 空 prompt 直接走恢复路径！
  → 或 `looksLikeShortFollowUp(prompt)` → true → continuation 判断为 true
  → `shouldPreferPendingWriteResume` 返回 true → 走恢复路径

当用户 `/风格仿写闭环 帮我写一篇关于XX的口播稿` 时：

  → `prompt = "帮我写一篇关于XX的口播稿"`
  → `looksLikeFreshTask =
      !looksLikeWorkflowContinuationPrompt(prompt) &&
      prompt.length >= 16 &&
      intent.isWritingTask`
  → `looksLikeFreshTask = true` → `shouldPreferPendingWriteResume` 返回 false ← ✅ 这个场景没问题

问题场景：`/skill` 唤起时只要用户不附带足够长的指令文本，系统就把它当成 continuation。而用户用 `/skill`
重新唤起的语义应是"开始新任务"。

更深层：

`L1027: classifyDirectiveIntent(prompt)`
  → 短 prompt → `looksLikeWorkflowContinuationPrompt` → true
  → 返回 `{ kind: "continuation" }`
  → `computeIntentRouteDecisionPhase0` 基于 continuation 做路由判断

`L1155: shouldSuppressSearchDuringBrowserContinuation`
  → 也调用 `looksLikeWorkflowContinuationPrompt(prompt)`
  → 同样不感知 `/skill` 唤起

问题本质：所有 continuation/resume 判断函数只接受 `text: string` 参数，不接受 `activeSkillIds`。`/skill`
唤起信号（`body.activeSkillIds`）在这些函数中不可见。

### 根因 3（B 级）：Desktop /skill → activeSkillIds 映射可靠性待确认

**文件**：
- `apps/desktop/src/ui/components/SlashPopover.tsx:27-48`（skill 列表生成 + MentionItem 类型转换）
- `apps/desktop/src/ui/components/ChatArea.tsx:481`（activeSkillIds 提取）
- `apps/desktop/src/agent/wsTransport.ts:951`（WebSocket 发送）

已确认链路：
`SlashPopover` → `MentionItem{type:"skill", id:sk.id}`
→ `InputBar` chip 序列化 → `ChatArea.handleSend`
→ `activeSkillIds = mentions.filter(m.type==="skill").map(m.id)`
→ `wsTransport: payload.activeSkillIds`

待确认：
1. `SlashPopover` 中的 `sk.id` 是否与 Gateway 侧的 `SkillManifest.id` 一致（内置 skill 和外部 skill 分别确认）
2. 用户通过 `SlashPopover` 选择 skill 后，如果不输入额外文本直接发送，chip 是否被正确序列化为 mention → `activeSkillIds`
3. `/风格仿写闭环` 对应的 skill id 是 `"style_imitate"` 还是 `"style_imitate_v2"`（取决于哪个 enabled）

---

## 2. 影响范围

功能: `style_imitate` 闭环
影响: `lint.copy / lint.style` 在特定条件下从 run 初始化就被删除，整个 run 中不可用，闭环无法完成

功能: `style_imitate_v2` 闭环
影响: 同样受影响（v2 的 `resolveAllowedTools` 也依赖 `baseAllowedToolNames` 中存在 lint 工具）

功能: `/skill` 重新唤起
影响: 所有 workflow 类 skill 的 `/skill` 重新唤起都会被误判为 continuation，无法开始新任务

功能: `shouldSuppressSearchDuringBrowserContinuation`
影响: `/skill` 唤起时可能误触搜索抑制

---

## 3. 修复方案

### Fix 1（P0）：L2808 gate 增加 mentionedSkillIds 兜底

**文件**：`apps/gateway/src/agent/runFactory.ts`

**原理**：即使 `activateSkills()` 未自动激活 `style_imitate`（因 trigger 条件不满足），只要用户通过 `/skill`
显式唤起了 style skill（`body.activeSkillIds` 中包含对应 id），就应保留 lint 工具在工具池中。

**改动**：在 `L2808-2816` 的 `styleSkillActive` 判断中，增加 `mentionedSkillIdSet` 检查。

### Fix 2（P0）：continuation 判断函数增加 mentionedSkillIds 参数

**文件**：`apps/gateway/src/agent/runFactory.ts`

**原理**：当用户通过 `/skill` 显式唤起一个 skill 时，应视为"新任务意图"，不应被 continuation/resume
逻辑拦截。仅当 `mentionedSkillIds` 非空时改变行为；空数组和 `undefined` 直接 fall through
到原有逻辑，确保无 `/skill` 的 "继续" 等短指令不受影响。

**改动**：
1. 新增 `hasExplicitSkillMention(mentionedSkillIds?: string[])`
2. `looksLikeWorkflowContinuationPrompt(text, mentionedSkillIds?)`
3. `shouldPreferPendingWriteResume*` 增加 `mentionedSkillIds?`
4. `classifyDirectiveIntent(text, mentionedSkillIds?)`
5. `computeIntentRouteDecisionPhase0(args.mentionedSkillIds?)`
6. `shouldSuppressSearchDuringBrowserContinuation(args.mentionedSkillIds?)`
7. `mentionedSkillIds` 解析提前到路由/恢复判断之前，并把所有调用点透传

### Fix 3（P1）：Desktop /skill → activeSkillIds 映射确认

**文件**：Desktop 侧 `SlashPopover / ChatArea / wsTransport`

链路已确认：`SlashPopover` → `MentionItem{type:"skill"}` → `ChatArea: activeSkillIds` → `wsTransport: payload.activeSkillIds`

待确认项：
1. 用户 `/风格仿写闭环` 只选 skill 不输入文本直接发送时，chip 序列化是否正常（`activeSkillIds` 是否非空）
2. 内置 skill（`style_imitate`）和外部 skill（`style_imitate_v2`）的 id 是否与 `SlashPopover` 列表中的 id 一致

建议：在 Gateway 的 `prepareAgentRun` 入口（L2183 附近）加一行 debug 日志：
`console.log("[prepareAgentRun] activeSkillIds:", mentionedSkillIds);`
确认实际传入值后可移除。

---

## 4. 边界情况

### Fix 1 边界

- `mentionedSkillIds` 为空（普通 "继续" 场景）：`styleSkillRequested = false`，回退到现有 `activeSkillIds`
  + `deriveStyleGate` 判断，行为不变
- style skill 被 `conflicts/requires` 阻止激活但用户显式 `/skill` 唤起：lint 工具保留在池中
- 非 style skill 的 lint 工具：当前 `lint.copy / lint.style` 只服务于 style_imitate

### Fix 2 边界

- 写作中断后发 `"继续"`（无 `/skill`）→ 行为与修改前一致
- 自动激活（有风格库 + 写作意图，无 `/skill`）→ 行为不变
- 旧调用方不传 `mentionedSkillIds` → 完全向后兼容
- 用户 `/skill` 但确实想继续上一轮：理论上可能，但语义上更合理的是直接发"继续"

### Fix 3 边界

- 如果 Desktop 映射正确：Fix 1 / Fix 2 仍然有价值（多层防线）
- 如果 Desktop 映射有问题：Fix 1 / Fix 2 会退化为现有行为，仍需补修 Desktop

---

## 5. 架构隐患

### S 级：lint 工具不在 CORE_TOOL_NAME_SET 中

当前 `CORE_TOOL_NAME_SET` 不包含 `lint.copy / lint.style`，意味着它们没有“核心工具保护”。

建议：不直接把 lint 放进 `CORE_TOOL_NAME_SET`，但应增加 “skill pinned tools 永远保留” 的兜底机制。

### A 级：continuation 判断散落在 5+ 个函数中

建议：后续统一为一个 `ContinuationSignal` 对象，包含 `{ text, mentionedSkillIds, mentionedAgentIds, hasExplicitNewTaskMarker }` 等字段。

### B 级：selectToolSubset 的 top-K 裁剪对 Skill 依赖工具无感知

当前靠 `skillPinnedToolNames` 做了部分保护，但后续仍建议确保 skill pinned tools 在 top-K 选择后不可被裁掉。

---

## 6. 验证 checklist

### Fix 1 验证

- `/风格仿写闭环` + 风格库 + 写作请求 → `lint.copy / lint.style` 出现在工具池中
- `activateSkills` 未自动触发时，但 `body.activeSkillIds` 包含 style_imitate → lint 工具仍保留
- 非 style 场景 → `lint.copy / lint.style` 仍被正确删除

### Fix 2 验证

- 上一轮写完口播稿 → 新 Run `/风格仿写闭环 帮我写关于XX的稿子` → 不走 resume，开始新任务
- 上一轮写完口播稿 → 新 Run 输入 `"继续"`（无 `/skill`）→ 正常 resume
- 上一轮写完口播稿 → 新 Run `/风格仿写闭环`（无后续文本）→ 不走 resume，开始新任务
- 无 pending artifact 时 → `/风格仿写闭环` → 正常开始新任务
- 自动激活场景（有风格库 + 写作意图，无 `/skill`）→ 行为不变
- `shouldSuppressSearchDuringBrowserContinuation` 在 `/skill` 唤起时不触发搜索抑制
- `shouldSuppressSearchDuringBrowserContinuation` 在纯 `"继续"` 时仍正常触发

### 回归测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

文件: `apps/gateway/src/agent/runFactory.ts`
改动类型: Fix 1 + Fix 2
改动范围: `styleSkillRequested`、`mentionedSkillIds` 提前解析、continuation/resume 相关函数增加 `mentionedSkillIds?` 参数、调用点透传

文件: Desktop 侧（待定位）
改动类型: Fix 3（待确认）
改动范围: `/skill` → `activeSkillIds` 映射可靠性确认
