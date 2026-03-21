# fix-style-workflow-bypass-and-fileop-nag-v1

> style_imitate 闭环被纯文本输出绕过 + FILE_OP_PERMISSION_DENIED 催促循环

> 状态：待实施 | 优先级：P0 | 日期：2026-03-16

## 0. 现象

### 现象 A：仿写不像（lint.copy / lint.style 被完全跳过）

用户 `@风格仿写闭环` 激活 style_imitate，选择李叔风格库，请求写一篇 1000 字口播稿。

Agent 行为：
1. kb.search × 4 次（检索风格样例、破题钩子、结尾收束、核心概念）— 正常
2. Agent 输出 "样例足够了，直接起稿"
3. **直接在聊天文本中输出 820 字完整口播稿** — 跳过了 lint.copy 和 lint.style
4. 尝试 write 工具保存文件 → 触发现象 B

结果：风格校验闭环（kb.search → draft → lint.copy → lint.style → write）被完全绕过。输出的稿件虽有李叔的口语标志（"宝贝"、"记好了"），但结构模仿、节奏指纹、人称密度等维度未经风格卡片校验，实际效果"不像"。

### 现象 B：写入权限弹窗未点 → Agent 反复催促

Agent 调用 write 工具 → Desktop 弹出确认框 → 用户未点击 → 180s 超时自动 deny → Agent 收到 `FILE_OP_PERMISSION_DENIED`。

然后 Agent 反复输出：
1. "系统弹出了确认框但被拒绝了。请再试一次"
2. "系统显示写入权限被拒绝了两次。请检查一下..."
3. "看起来授权弹框一直在被拒绝。稿子内容是完整的，你可以直接复制..."

共 3 次催促 + 3 次重新调用 write，全部 deny。用户只是没来得及点，但 Agent 误判为"需要修复"。

---

## 1. 根因分析

### 根因 1（S 级）：Workflow 验证仅存在于工具调用层，对文本输出无约束

**文件**：
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:~2108`（`assistant_text` 处理）
- `apps/gateway/src/agent/styleOrchestrator.ts:151-210`（`computeStyleTurnCaps`）
- `packages/agent-core/src/runMachine.ts:728-801`（`analyzeStyleWorkflowBatch`）

**机制分析**：

三层防线全部对纯文本输出无效：

| 防线 | 作用范围 | 对文本输出 |
|------|---------|-----------|
| `computeStyleTurnCaps` | 控制每轮可用工具白名单 | ❌ 不约束文本输出 |
| `analyzeStyleWorkflowBatch` | 在 tool_execution_end 时检查工具顺序 | ❌ 无工具调用则不触发 |
| Hint 提示词 "只调用 write 生成候选稿" | 软约束 | ❌ 模型可无视 |

而 `looksLikeDraftText`（`runMachine.ts:544-556`）在收到长文本时标记 `hasDraftText=true`，**只标记状态不做验证**。结果：

```
模型输出 820 字文本 → looksLikeDraftText = true → hasDraftText = true
→ phase 跳到 need_copy_lint → 但 run 已结束
→ lint.copy / lint.style 从未被调用
```

### 根因 2（A 级）：_getFollowUpMessages 的 v1 闭环提示过于笼统

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:~1045-1070`

当前 followUp 逻辑在 `styleCompleted === false` 时注入一条通用提示："按 kb.search → draft → lint.copy → lint.style → write 顺序执行"。

问题：**不区分当前处于哪个 phase**。模型已经输出了草稿（hasDraftText=true），但提示仍说"先 kb.search 再 draft"——与实际状态脱节，模型无法理解应该做什么。

### 根因 3（A 级）：FILE_OP_PERMISSION_DENIED 与普通工具失败走同一条 failureDigest 路径

**文件**：
- `apps/desktop/src/agent/toolRegistry.ts:4305-4316`（返回 `FILE_OP_PERMISSION_DENIED + nextActions`）
- `apps/gateway/src/agent/runtime/GatewayRuntime.ts:~889-968`（`_collectSoftGuidanceMessages`）

**调用链**：

```
Desktop: write → ensureHighRiskFileOpPermission()
  → requestInlineFileOpConfirm(180_000)
  → 用户没点 → 180s 超时 → settle("deny")
  → 返回 { code: "FILE_OP_PERMISSION_DENIED",
           nextActions: ["如需继续，请重新发起..."] }
         ↓
Gateway: failureDigest.failedCount++
  → _collectSoftGuidanceMessages()
  → pushHint("刚刚有工具执行失败...建议下一步：如需继续...") ← 含 nextActions
  → 模型理解为"可以重试" → 再调 write → 循环 3 次
```

三个子问题：
1. Desktop 的 `nextActions: ["如需继续，请重新发起该文件操作并选择'允许'"]` 被 Soft Guidance 原样转述给模型
2. 无法区分"用户未交互（超时）"和"用户显式拒绝"
3. `FILE_OP_PERMISSION_DENIED` 不应触发 `tool_failure_repair` 机制（这不是工具参数错误）

---

## 2. 影响范围

| 功能 | 影响 |
|------|------|
| style_imitate 闭环 | lint.copy + lint.style 可被纯文本输出绕过，风格校验形同虚设 |
| 所有 write/delete 工具 | 权限弹窗未点 → Agent 催促循环（3 次重试 + 啰嗦解释） |
| style_imitate_v2（未激活） | 同样受根因 1 影响（v2 的 WorkflowPhaseInterpreter 也不控制文本输出） |

---

## 3. 修复方案

### Fix 1（P0）：_getFollowUpMessages 按 phase 精确推进

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**原理**：当 style_imitate 闭环未完成时，不再注入笼统的"按顺序执行"提示，而是计算当前 phase，注入精确的下一步指令。这样当模型输出了纯文本草稿（hasDraftText=true），followUp 会明确说"请调用 lint.copy"，强制闭环继续。

**改动**：在 `_getFollowUpMessages` 的 v1 分支（`!styleCompleted` 块内），计算 `currentPhase` 并生成 phase-specific 的 followUp 文本：

```typescript
const currentPhase =
  !st.hasStyleKbSearch ? "need_style_kb"
  : !st.hasDraftText ? "need_draft"
  : !st.copyLintPassed ? "need_copy_lint"
  : !styleLintAccepted ? "need_style_lint"
  : "completed";

const followUpText =
  currentPhase === "need_style_kb"
    ? "当前已启用 style_imitate，但风格样例检索还没完成。\n请先调用 kb.search，从 purpose=style 的风格库检索模板/规则卡；不要先写草稿，也不要直接交付终稿。"
  : currentPhase === "need_draft"
    ? "当前已启用 style_imitate，风格样例已具备。\n请先调用 write 生成候选稿；不要直接把聊天文本当成终稿交付。"
  : currentPhase === "need_copy_lint"
    ? "你已经产出了候选稿，现在必须进入复述风险检查。\n请先调用 lint.copy 对候选稿做复述风险审计；在 copy lint 通过前，不要继续终稿写入。"
    : "copy lint 已通过，现在必须进入风格校验。\n请先调用 lint.style 检查结构、节奏和语气；在 style lint 通过前，不要继续终稿写入。";
```

**效果**：
- 模型输出 820 字文本 → `hasDraftText=true` → phase = `need_copy_lint`
- followUp 说 "你已经产出了候选稿，请先调用 lint.copy"
- 模型被引导进入 lint 阶段，闭环继续

### Fix 2（P0）：Desktop 区分 timeout / deny，不返回 nextActions

**文件**：
- `apps/desktop/src/state/inlineFileOpConfirm.ts`
- `apps/desktop/src/agent/toolRegistry.ts`

**改动 2a**：`FileOpConfirmChoice` 新增 `"timeout"` 类型。超时自动 settle 改为 `"timeout"` 而非 `"deny"`。

**改动 2b**：`ensureHighRiskFileOpPermission` 返回结构化结果 `{ allowed, reason }` 而非 boolean。根据 `reason` 返回不同错误码：

| 场景 | 错误码 | message | nextActions |
|------|--------|---------|-------------|
| 超时未点 | `FILE_OP_PERMISSION_TIMEOUT` | "等待用户确认高风险文件操作超时，本轮已暂停该文件操作。" | **无** |
| 显式拒绝 | `FILE_OP_PERMISSION_DENIED` | "用户拒绝了本次高风险文件操作授权。" | **无** |

### Fix 3（P0）：Gateway Soft Guidance 屏蔽文件权限错误

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`（`_collectSoftGuidanceMessages`）

**改动**：在 `_collectSoftGuidanceMessages` 中，对最新失败工具的 errorCode 做判断：

| 错误码 | Soft Guidance 行为 |
|--------|-------------------|
| `FILE_OP_PERMISSION_TIMEOUT` | 仅首次（consecutive===1）注入一句："写入操作等待用户确认超时，已暂停。你可以告知用户此次文件操作需要手动确认；在用户明确允许前，不要重复发起同一文件操作。" |
| `FILE_OP_PERMISSION_DENIED` | 完全跳过 soft guidance |
| 其他错误码 | 保持现有 tool_failure_repair 逻辑不变 |

---

## 4. 边界情况

### Fix 1 边界
- **非 style_imitate 场景**：followUp 逻辑变更只在 v1 style 分支内，不影响其他场景
- **v2 style_imitate**：v2 使用 `resolveFollowUp()` 独立分支，不受此变更影响
- **模型持续无视 followUp**：worst case 与当前一致（lint 被跳过），但 followUp 更精确，模型遵从概率更高
- **hasDraftText 被文本输出标记后的状态一致性**：computeStyleTurnCaps 根据 hasDraftText 允许 lint.copy 工具，状态机一致

### Fix 2/3 边界
- **用户 3 分钟内没点但后来点了**：timeout 后 Desktop 的 pending 已被 clear，无法追溯。但 agent 不会再催，用户可重新发起
- **用户快速多次 deny**：每次都是 `FILE_OP_PERMISSION_DENIED`，soft guidance 完全跳过，agent 不会重试
- **其他工具的 failureDigest**：不受影响，只有 `FILE_OP_PERMISSION_*` 两个 code 被特殊处理

---

## 5. 架构隐患

### S 级：Workflow 无法控制模型文本输出

这是 `style_imitate` 闭环的结构性缺陷。当前所有 workflow 约束（白名单、violation 检查、followUp）都只作用于**工具调用**。模型可以通过纯文本输出绕过任何 workflow 阶段。

Fix 1 是**缓解**而非根治：通过更精确的 followUp 引导模型回到闭环，但模型仍然可以无视 followUp。

**根治方向**（后续迭代）：
- 方案 A：在 pi-agent-core 层，当 workflow skill 激活时，拦截超过阈值（如 200 字）的 assistant_text 输出，强制转为 `write` 工具调用
- 方案 B：v0.2 orchestrated workflow（已有设计文档），将步骤顺序收回到 Runtime 状态机，模型只在节点内产内容
- 方案 C：style_imitate 使用子 Agent 执行（内部多轮，外层只看到一个高阶工具调用）

### A 级：Desktop ↔ Gateway 错误码语义不统一

当前 Desktop 返回的工具错误码（`FILE_OP_PERMISSION_DENIED`、`NO_PROJECT`、`NO_LIBRARY_SELECTED` 等）没有统一分类。Gateway 的 failureDigest 对所有失败一视同仁。

建议后续建立错误码分类：
- `USER_INTERACTION_*`：需要用户交互，不应自动重试
- `TOOL_CONFIG_*`：工具配置/前置条件问题，可能需要用户配合
- `TOOL_EXEC_*`：工具执行错误，可以尝试修复参数重试

---

## 6. 验证 checklist

### Fix 1 验证
- [ ] `@风格仿写闭环` + 风格库 + 写作请求 → agent 做 kb.search → 如果模型输出文本草稿 → followUp 推到 lint.copy → lint.copy 执行 → lint.style 执行 → 闭环完成
- [ ] 非 style_imitate 场景（普通写作）不受影响
- [ ] v2 style_imitate 的 followUp 逻辑不受影响

### Fix 2/3 验证
- [ ] 写入操作弹窗 → 不点确认 → 超时 → agent 输出一次"等待确认超时"提示 → 不再催促
- [ ] 写入操作弹窗 → 点"拒绝" → agent 不催促，接受拒绝结果
- [ ] 写入操作弹窗 → 点"允许" → 正常写入（回归测试）
- [ ] 写入操作弹窗 → 点"始终允许" → 后续写入不再弹窗（回归测试）
- [ ] 普通工具失败（非文件权限）→ tool_failure_repair 机制正常触发（回归测试）

### 回归测试
```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

| 文件 | 改动类型 | 改动范围 |
|------|---------|---------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | Fix 1 + Fix 3 | `_getFollowUpMessages` v1 分支 + `_collectSoftGuidanceMessages` |
| `apps/desktop/src/state/inlineFileOpConfirm.ts` | Fix 2 | `FileOpConfirmChoice` 类型 + timeout settle |
| `apps/desktop/src/agent/toolRegistry.ts` | Fix 2 | `ensureHighRiskFileOpPermission` 返回类型 + 错误码 |
