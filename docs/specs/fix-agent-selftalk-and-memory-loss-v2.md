# 修复 Agent 自言自语（v2）+ 跨 Run 记忆丢失

> 状态：待实施 | 优先级：P0 | 日期：2026-03-15

## 0. 现象

### 现象 A：自言自语（pending_todo 仍触发）

用户让 Agent 帮忙查 ICP 备案所需材料。Agent 使用 Playwright 导航备案控制台（失败后多次重试），最终输出完整 ICP 备案材料清单。文本**中部**有问句："先确认一下：个人备案还是企业备案？"，但文本**结尾**是声明句："你现在域名实名是已经通过了，ServerHold解除后可以先把DNS解析配好，然后去做ICP备案。"

**然后在没有用户输入的情况下**，Agent 又追加了一段回复，重复总结材料清单内容。

Fix 3（commit `83685bd`）已部署在服务器（版本 `d406c3a`），但未能阻止此次自言自语。

### 现象 B：记忆丢失（跨 Run 事实遗忘）

同一会话中，Agent 在 Run N 通过 Playwright 查询域名状态后明确报告："**ServerHold已解除！域名状态显示正常**"。但在 Run N+2 中，Agent 声称："**ohmycrab.top 现在还是ServerHold状态**"——与之前的确认完全矛盾。

用户原话："它的记忆好像不行，我们现在是L3记忆机制，但很容易没几步就忘事"

---

## 1. 根因分析

### 1.1 主根因 A：`askingUserPattern` 的 `slice(-200)` 扫描窗口太小

**文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts:1070-1075`

```typescript
const lastText = this._getLastAssistantText();
const askingUserPattern =
  /[？?]\s*$|要.*吗[？?]?|还是.*[？?]|你.*偏好|帮你.*[？?]|需要.*确认|请.*选择|告诉我/;
if (lastText && askingUserPattern.test(lastText.slice(-200))) {
  return [];
}
```

Fix 3 只检查 `lastText` 的**最后 200 字符**。在本次场景中：

- 文本总长约 2000+ 字符
- 问句"先确认一下：个人备案还是企业备案？"出现在 ~800 字符处
- 最后 200 字符是纯声明句
- `askingUserPattern` 未命中 → `pending_todo` 正常触发 → 自言自语

**不能简单扩大扫描范围**：如果全文扫描，会误匹配文中引用的问句（如 FAQ 列表、举例中的问号），导致合理的 `pending_todo` 催促被误抑制。

### 1.2 主根因 B：RECENT_DIALOGUE 双层截断导致跨 Run 关键事实丢失

**文件**：
- `apps/desktop/src/agent/gatewayAgent.ts:1282-1300`（第一层截断）
- `apps/gateway/src/agent/contextAssembler.ts:385-437`（第二层截断）

**第一层截断**（Desktop 端）：

```typescript
// gatewayAgent.ts:1294-1295
const u = clip(one.user, 800);
const a = clip(one.assistant, 800);
```

每条 user/assistant 消息截至 **800 字符**。Agent 通过 Playwright 检查域名状态的回复通常包含：页面快照文本 + 状态分析 + 结论，总长度轻松超过 800 字符。关键事实"ServerHold已解除"可能出现在 800 字符之后被截断。

**第二层截断**（Gateway 端）：

```typescript
// contextAssembler.ts:414-415
const maxMsgs = clampInt(Math.floor(budget / 420), MIN_RECENT_DIALOGUE_MSGS, MAX_RECENT_DIALOGUE_MSGS);
```

Gateway 根据 budget 计算保留消息数，从尾部向前选择。被第一层截断过的消息，在第二层可能被进一步丢弃。

**叠加效应**：Desktop 截断到 800 字 → Gateway 再截断到 budget 容量 → 早期 Run 的关键事实（"ServerHold已解除"）完全丢失 → 模型退回训练知识填充。

### 1.3 次根因：摘要与最近对话的"时间空洞"

**文件**：`apps/desktop/src/agent/gatewayAgent.ts:982-988`（`computeDialogueCompactionConfig`）

滚动摘要的触发和最近对话的窗口之间可能存在时间空洞：

- `DIALOGUE_SUMMARY` 覆盖到 turn N（由 `dialogueSummaryTurnCursorByMode` 控制）
- `RECENT_DIALOGUE` 从 `completeTurns.slice(-rawKeepTurns)` 取，起点可能是 turn N+3
- Turn N+1 和 N+2 既不在摘要中也不在最近对话中 → 信息完全丢失

**触发条件**：会话快速进行多轮工具调用，但未触发滚动摘要（因为 `estimateDialogueTokens < compactTriggerTokens`），随后新轮次挤掉 `rawKeepTurns` 窗口内的早期轮次。

### 1.4 核心瓶颈：`MAX_RUNTIME_CONTEXT_CHARS = 32,000` 硬上限锁死 L3 预算

**文件**：`apps/gateway/src/agent/contextAssembler.ts:117`

```typescript
const MAX_RUNTIME_CONTEXT_CHARS = 32_000;
```

L3 运行上下文（DIALOGUE_SUMMARY + RECENT_DIALOGUE）的总预算被硬锁在 32,000 字符。

**实际效果（200K token 模型，如 claude-sonnet-4-6）**：

```
effectiveInputBudgetChars = 200,000 × 4 × 0.8 = 640,000 chars
runtimeContextBudgetChars = min(32,000, 640,000 - ~5,000) = 32,000 chars
→ summaryBudget = floor(32K × 0.45) = 14,400 → clamped to 12,000
→ recentBudget = 32K - 12K = 20,000
→ maxMsgs = floor(20K / 420) = 47
→ itemChars = floor(20K / 47) - 80 = 345 chars per message ← !!!
```

每条消息只分到 **345 字符**，比 Desktop 端 800 字符的预截断还小。即使 Desktop 端把 800 改成 1600 或 8000，Gateway 端的 32K 硬上限最终仍会把每条消息压缩到 ~345 字符。

### 1.5 竞品对比：我们的 L3 预算是 OpenClaw/Codex 的 1/12

| 维度 | OpenClaw | Codex | 我们（当前） |
|------|----------|-------|------------|
| 200K 模型对话预算 | **~100K tokens**（50% context） | **~190K tokens**（95% effective） | **~8K tokens**（4% context） |
| per-message 截断 | **无**（按总预算动态） | **10K tokens/条** | 345 chars ≈ 86 tokens |
| 长消息策略 | head 1500 + tail 1500 soft trim | 50% head + 50% tail 中段截断 | 头部截断到 800 chars |
| 预算计算 | `maxHistoryShare = 0.5` × contextWindow | `effective_context_window_percent = 95` | `min(32K, effectiveBudget)` 硬锁 |

**关键差距**：

- OpenClaw 给对话历史 50% 的上下文窗口 → 200K 模型有 ~100K tokens 对话预算
- Codex 给 95% 有效窗口用于对话 → 200K 模型有 ~190K tokens
- 我们给 L3 总共 32K 字符 ≈ **8K tokens**，其中 RECENT_DIALOGUE 只有 20K 字符 ≈ **5K tokens**
- **我们的对话预算是 OpenClaw 的 1/12，Codex 的 1/24**

即使扣除我们有独立的 L1（记忆）和 L2（任务状态）层，L3 的 8K tokens 对于保留跨 Run 关键事实仍然严重不足。

### 1.6 隐患：`MAX_RECENT_DIALOGUE_ITEM_CHARS = 900` 与 Desktop 端 800 不协调

**文件**：`apps/gateway/src/agent/contextAssembler.ts:122`

Gateway 端 `MAX_RECENT_DIALOGUE_ITEM_CHARS = 900`，而 Desktop 端截断到 800。即使两个上限都提高到 1600，受 32K 总预算限制，实际 per-message 只能分到 ~345 字符（见 1.4 分析），1600 的上限形同虚设。

---

## 2. 影响范围

### 2.1 Bug A：自言自语

| 场景 | Fix 3 能拦截？ | 原因 |
|------|---------------|------|
| 短文本结尾有问号 | ✅ | 问号在最后 200 字符内 |
| 长文本中部有问句，结尾声明句 | ❌ | 问句超出 200 字符窗口 |
| 长文本先列材料再问选择 | ❌ | 问句在中部，结尾是总结 |
| 长文本中有 FAQ 引用问句 | N/A（应放行） | 引用不是真正提问 |

### 2.2 Bug B：记忆丢失

| 场景 | 关键事实保留？ | 原因 |
|------|---------------|------|
| 工具结果 < 800 字符 | ✅ | 不被第一层截断 |
| 工具结果 > 800 字符，结论在尾部 | ❌ | 被 clip(800) 截断 |
| 5+ 轮工具调用后的早期轮次 | ❌ | 被 rawKeepTurns 挤出 |
| 摘要已覆盖但关键事实未被 LLM 摘要保留 | ❌ | 摘要质量依赖 LLM |

---

## 3. 修复方案

### Fix 1（P0）：增强 `pending_todo` 提问检测——中段问句 + 尾部等待模式联合检测

**原理**：将单一的"末尾 200 字符正则"升级为三层检测：
1. 末尾短窗检测（扩大到 400 字符）
2. 全文"向用户提问"检测（保守正则，要求第二人称 + 选择/确认动词，排除引用句式）
3. 尾部"等待用户决定"语气检测
当 (1) 命中，或 (2)+(3) 同时命中时，视为 Agent 在等用户回复，不触发 `pending_todo`。

**修改文件**：`apps/gateway/src/agent/runtime/GatewayRuntime.ts`

**修改内容**：

```diff
--- a/apps/gateway/src/agent/runtime/GatewayRuntime.ts
+++ b/apps/gateway/src/agent/runtime/GatewayRuntime.ts
@@ L1068-1075（pending_todo 提问检测）
     // 检测最后一条 assistant 文本是否在向用户提问/确认。
     // 如果 Agent 已经抛出选择题或确认请求，应等用户回复，而不是继续被 pending_todo 催促。
     const lastText = this._getLastAssistantText();
-    const askingUserPattern =
-      /[？?]\s*$|要.*吗[？?]?|还是.*[？?]|你.*偏好|帮你.*[？?]|需要.*确认|请.*选择|告诉我/;
-    if (lastText && askingUserPattern.test(lastText.slice(-200))) {
-      return [];
+    if (lastText && this._detectAssistantAskingUser(lastText)) {
+      return [];
     }

@@ L1109 后新增
+  /**
+   * 检测 Agent 最后一条文本是否在向用户提问/等待用户做决定。
+   * 三层检测，避免"长文本中部有问句但尾部声明句"导致漏判。
+   */
+  private _detectAssistantAskingUser(text: string): boolean {
+    const t = String(text ?? "").trim();
+    if (!t) return false;
+
+    const tail = t.slice(-400);
+
+    // 层 1：尾部短窗直接命中提问模式（扩大到 400 字符）
+    const tailAskPattern =
+      /[？?]\s*$|要[^。\n]{0,12}吗[？?]?|还是[^。\n]{0,16}[？?]|(?:你|您)[^。\n]{0,16}(?:偏好|更倾向|选择|打算|决定)[^。\n]{0,12}[？?]?|帮你[^。\n]{0,16}[？?]|需要[^。\n]{0,12}确认|请[^。\n]{0,16}选择|请[^。\n]{0,16}告诉我|告诉我/;
+    if (tailAskPattern.test(tail)) return true;
+
+    // 层 2+3：全文有"向用户提问/选择"的句子 + 尾部处于"等待用户决策"语气
+    if (this._textHasUserDirectedQuestion(t) && this._textTailWaitsForUser(tail)) {
+      return true;
+    }
+
+    return false;
+  }
+
+  /**
+   * 检测文本中是否包含向用户直接提问/请求选择的句子。
+   * 要求含第二人称（你/您）且有选择/确认类动词，排除引用/举例句式。
+   */
+  private _textHasUserDirectedQuestion(text: string): boolean {
+    // 按句号/感叹号/问号分句
+    const sentences = text.split(/(?<=[。！？!?\n])/);
+    for (const raw of sentences) {
+      const s = raw.trim();
+      if (!s || s.length < 4) continue;
+      // 排除引用/举例/说明类前缀
+      if (/^(?:例如|比如|举例|常见问题|用户(?:通常|可能)会问|注意|备注|提示)/.test(s)) continue;
+      // 要求第二人称 + 选择/确认类动词
+      if (/(你|您)/.test(s) && /(选择|确认|决定|告诉我|告知|偏好|倾向|需要.*吗|要.*吗|还是)/.test(s)) {
+        return true;
+      }
+    }
+    return false;
+  }
+
+  /**
+   * 检测尾部文本是否处于"等待用户做决定"的语气。
+   * 用于与 _textHasUserDirectedQuestion 配合——
+   * 当全文曾问过问题且尾部在等待用户回应时，判定为 asking user。
+   */
+  private _textTailWaitsForUser(tail: string): boolean {
+    const t = String(tail ?? "").trim();
+    if (!t) return false;
+    const pattern =
+      /(?:你|您)(?:告诉我|选|决定|确认|回复)|(?:选好|确认|决定)(?:之后|后)(?:我再|再)|(?:以上|上面)(?:是|为).{0,20}(?:方案|选项|材料|清单)|先.*(?:确认|决定)|(?:个人|企业).*(?:备案|选择)/;
+    return pattern.test(t);
+  }
```

**设计原则**：
- 层 1 保持向后兼容，仅扩大窗口（200 → 400）并增强正则
- 层 2+3 联合检测覆盖"中部问句 + 尾部等待"的场景
- `_textHasUserDirectedQuestion` 要求第二人称 + 选择动词，排除引用句式，避免误匹配
- `_textTailWaitsForUser` 检测"选好后我再帮你"/"以上是材料清单"等等待模式

### Fix 2（P0）：L3 预算从硬上限改为按上下文窗口比例分配（参考 OpenClaw/Codex 架构）

**原理**：当前 `MAX_RUNTIME_CONTEXT_CHARS = 32,000` 硬上限是记忆丢失的**核心瓶颈**。无论怎么调 Desktop 预截断和 Gateway per-message 上限，32K 总预算决定了每条消息最多只能分到 ~345 字符。直接对标 OpenClaw（50% context → history）的预算策略，将 L3 预算从固定值改为 effective input budget 的 **50%**。Desktop 端同步放宽预截断，不做瓶颈。出问题再往回调。

#### Fix 2a：Gateway 端 `MAX_RUNTIME_CONTEXT_CHARS` 改为动态比例分配

**修改文件**：`apps/gateway/src/agent/contextAssembler.ts`

```diff
--- a/apps/gateway/src/agent/contextAssembler.ts
+++ b/apps/gateway/src/agent/contextAssembler.ts
@@ L115-122（常量定义区域）
 // L3(runtime context) hard caps：防止大窗口模型无限塞历史导致成本爆炸
 const MIN_RUNTIME_CONTEXT_CHARS = 1800;
-const MAX_RUNTIME_CONTEXT_CHARS = 32_000;
+// 旧硬上限 32K 导致 200K 模型只有 ~8K tokens 对话预算（4% context window）。
+// 直接对标 OpenClaw（maxHistoryShare=0.5），给 L3 50% 的 effective input budget。
+const RUNTIME_CONTEXT_BUDGET_SHARE = 0.50;
+const HARD_MAX_RUNTIME_CONTEXT_CHARS = 400_000; // ~100K tokens 硬上限（对齐 OpenClaw 200K 模型的分配量）
+const LEGACY_MAX_RUNTIME_CONTEXT_CHARS = 32_000; // 无上下文窗口信息时的兜底值

 const MIN_RECENT_DIALOGUE_MSGS = 4;
 const MAX_RECENT_DIALOGUE_MSGS = 60;
 const DEFAULT_RECENT_DIALOGUE_ITEM_CHARS = 280;
-const MAX_RECENT_DIALOGUE_ITEM_CHARS = 900;
+// 旧 900 硬上限在大预算下是瓶颈。
+// 提高到 12000，让预算系统自然控制 per-message 分配。
+const MAX_RECENT_DIALOGUE_ITEM_CHARS = 12_000;

@@ L746-749（buildAssembledContext 中 runtimeContextBudgetChars 计算）
-  const runtimeContextBudgetChars =
-    effectiveInputBudgetChars !== null
-      ? Math.max(0, Math.min(MAX_RUNTIME_CONTEXT_CHARS, effectiveInputBudgetChars - usedBeforeL3))
-      : null;
+  const runtimeContextBudgetChars =
+    effectiveInputBudgetChars !== null
+      ? Math.max(
+          MIN_RUNTIME_CONTEXT_CHARS,
+          Math.min(
+            HARD_MAX_RUNTIME_CONTEXT_CHARS,
+            Math.floor(effectiveInputBudgetChars * RUNTIME_CONTEXT_BUDGET_SHARE),
+            effectiveInputBudgetChars - usedBeforeL3,
+          ),
+        )
+      : null;
```

**预算对照表**：

| 上下文窗口 | effectiveInput (chars) | L3 预算 (chars) | ≈ tokens | 占比 | **旧值** |
|-----------|----------------------|----------------|----------|------|---------|
| 50K | 160,000 | 80,000 | ~20,000 | 40% | 32,000 |
| 100K | 320,000 | 160,000 | ~40,000 | 40% | 32,000 |
| 200K | 640,000 | 320,000 | ~80,000 | 40% | 32,000 |
| 1M | 3,200,000 | 400,000 (cap) | ~100,000 | 10% | 32,000 |

> 注：实际占上下文窗口比例 = effectiveInput × 50% / (contextWindow × 4) = 0.8 × 50% = 40%

200K 模型的 RECENT_DIALOGUE 效果（假设 summaryBudget 占 35%）：
- summaryBudget = clamp(320K × 0.35, 1200, 60_000) = **60,000 chars**
- recentBudget = 320K - 60K = **260,000 chars**
- maxMsgs = floor(260K / 420) = 619 → capped at 60
- 取 25 条消息：260K / 25 = **~10,400 chars per message**
- 旧值：345 chars per message → **提升 30 倍**

**同步调整 summary/recent 分割比例**：

```diff
@@ L617-618（buildRuntimeContextMessage 中 summaryBudget/recentBudget 计算）
-  const summaryBudget = budget ? clampInt(Math.floor(budget * 0.45), 1200, 12_000) : 1200;
-  const recentBudget = budget ? Math.max(1200, budget - summaryBudget) : 1600;
+  // 预算增大后调整比例：summary 35% / recent 65%（旧 45/55）
+  // summary 上限从 12K 提到 60K，适配大预算
+  const summaryBudget = budget ? clampInt(Math.floor(budget * 0.35), 1200, 60_000) : 1200;
+  const recentBudget = budget ? Math.max(1200, budget - summaryBudget) : 1600;
```

#### Fix 2b：Desktop 端 per-message 预截断从 800 改为按模型动态分配

**修改文件**：`apps/desktop/src/agent/gatewayAgent.ts`

**原理**：Desktop 端的 `clip(800)` 是 Gateway 预算系统之前的预过滤器。在 Gateway 预算给到 50% 后，Desktop 必须同步放宽，否则 Gateway 有预算也拿不到完整数据。Desktop 预截断的定位是**粗过滤**（防止单条消息过大导致 WS 传输问题），不应做精细预算控制。

```diff
--- a/apps/desktop/src/agent/gatewayAgent.ts
+++ b/apps/desktop/src/agent/gatewayAgent.ts
@@ L1282-1300（buildRecentDialogueJsonFromTurns）
-function buildRecentDialogueJsonFromTurns(turns: DialogueTurn[], maxTurns: number) {
+function buildRecentDialogueJsonFromTurns(turns: DialogueTurn[], maxTurns: number, contextWindowTokens?: number | null) {
   const t = Array.isArray(turns) ? turns : [];
   const n = Number.isFinite(Number(maxTurns)) ? Math.max(0, Math.floor(Number(maxTurns))) : 0;
   if (n <= 0) return "";
   const recentTurns = t.slice(-n);
+  // Desktop 端粗过滤：按上下文窗口动态调整 per-message 上限。
+  // 定位是防止 WS 传输过大，精细预算由 Gateway compactRecentDialogue 控制。
+  // 公式：effectiveBudget * 1.5% per message，范围 800-12000
+  const ctx = Number(contextWindowTokens) || DEFAULT_CONTEXT_WINDOW_TOKENS;
+  const effectiveBudgetChars = ctx * 4 * 0.8;
+  const itemClipLimit = Math.max(800, Math.min(12_000, Math.floor(effectiveBudgetChars * 0.015)));
   const clip = (s: string, max: number) => {
     const v = String(s ?? "").trim();
     if (!v) return "";
     return v.length > max ? v.slice(0, max).trimEnd() + "…" : v;
   };
   const msgs: Array<{ role: "user" | "assistant"; text: string }> = [];
   for (const one of recentTurns) {
-    const u = clip(one.user, 800);
-    const a = clip(one.assistant, 800);
+    const u = clip(one.user, itemClipLimit);
+    const a = clip(one.assistant, itemClipLimit);
     if (u) msgs.push({ role: "user", text: u });
     if (a) msgs.push({ role: "assistant", text: a });
   }
   return msgs.length ? `RECENT_DIALOGUE(JSON):\n${JSON.stringify(msgs, null, 2)}\n\n` : "";
 }

@@ L1392-1397（agent 模式调用处）
   const recentDialogue = (() => {
     if (freshWritingBoundary) return undefined;
     const turnsAll = buildDialogueTurnsFromSteps(useRunStore.getState().steps ?? [], { includeToolSummaries: true });
     const completeTurns = turnsAll.filter((t) => String(t.user ?? "").trim() && String(t.assistant ?? "").trim());
-    return buildRecentDialogueJsonFromTurns(completeTurns, computeDialogueCompactionConfig(preferModelId).rawKeepTurns);
+    const cfg = computeDialogueCompactionConfig(preferModelId);
+    return buildRecentDialogueJsonFromTurns(completeTurns, cfg.rawKeepTurns, cfg.contextWindowTokens);
   })();
```

**同步修改**：所有 `buildRecentDialogueJsonFromTurns` 的其他调用处也传入 `contextWindowTokens`（chat 模式调用处同理）。

**Desktop per-message 预截断对照**：

| 上下文窗口 | effectiveBudget (chars) | per-message 上限 | **旧值** |
|-----------|------------------------|-----------------|---------|
| 50K | 160,000 | 2,400 | 800 |
| 100K | 320,000 | 4,800 | 800 |
| 200K | 640,000 | 9,600 | 800 |
| 1M | 3,200,000 | 12,000 (cap) | 800 |

#### 全链路效果对比（200K 模型）

| 环节 | 旧值 | 新值 | 提升 |
|------|------|------|------|
| Desktop per-message 预截断 | 800 chars | 9,600 chars | **12×** |
| Gateway L3 总预算 | 32,000 chars | 320,000 chars | **10×** |
| Gateway summary 预算 | 12,000 chars | 60,000 chars | **5×** |
| Gateway recent 预算 | 20,000 chars | 260,000 chars | **13×** |
| Gateway per-message 实际分配 | ~345 chars | ~10,400 chars | **30×** |
| Gateway MAX_RECENT_DIALOGUE_ITEM_CHARS | 900 | 12,000 | **13×** |
| 总 L3 token 预算 | ~8K tokens | ~80K tokens | **10×** |
| 占上下文窗口比例 | 4% | 40% | — |

**与竞品对比**：

| 产品 | 200K 模型对话预算 | 占比 |
|------|-----------------|------|
| OpenClaw | ~100K tokens | 50% |
| Codex | ~190K tokens | 95% |
| **我们（新）** | **~80K tokens** | **40%** |
| 我们（旧） | ~8K tokens | 4% |

直接对标 OpenClaw 的 50% 策略。实际占比 ~40%（因为 effective ratio 0.8），与 OpenClaw 同一量级。

**设计原则**：
- 直接对标 OpenClaw 的 50% 策略，不做保守猜测，出问题再往回调
- 硬上限 400K chars（~100K tokens）匹配 OpenClaw 200K 模型的实际分配量
- Desktop 端定位为粗过滤器（防 WS 传输过大），不做精细预算控制
- Gateway `compactRecentDialogue` 的预算机制自动平衡消息数和单条长度

---

## 4. 不采用的方案

### 方案 A：全文扫描问号来判断 Agent 是否在提问

**不采用原因**：长文本中常包含引用/FAQ/举例中的问号，全文扫描会误匹配。三层检测（短窗 + 全文保守 + 尾部语气联合）是更精准的折中。

### 方案 B：将 RECENT_DIALOGUE 截断完全去掉

**不采用原因**：无截断的 RECENT_DIALOGUE 在长会话中可能产生 100K+ 字符的原文，直接塞入 system prompt 会挤压工具定义和用户消息空间。Desktop 端仍需粗过滤，Gateway 端仍需预算控制。

### 方案 C：引入结构化 LATEST_FACTS 段

**不采用原因（本次不做）**：需要工具层改造（Playwright 结果结构化提取），改动范围大。中长期方向正确，但本次先用 Fix 2（预算比例化）解决最紧迫的问题。作为后续增强记录在架构隐患中。

### 方案 D：只提高 Desktop per-message 到 1600，保持 Gateway 32K 总预算

**不采用原因**：这是 v2 初版方案，用户反馈"1600还是小的离谱了"。源码分析证实：**真正的瓶颈是 `MAX_RUNTIME_CONTEXT_CHARS = 32,000`**——即使 Desktop 提高到 1600，Gateway 的 32K 总预算下每条消息实际只分到 ~345 字符，1600 形同虚设。必须同时提高总预算。

---

## 5. 架构隐患清单

### S 级（导致核心功能断裂）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | `MAX_RUNTIME_CONTEXT_CHARS = 32,000` 硬上限锁死 L3 预算，200K 模型只有 4% 上下文用于对话历史 | `contextAssembler.ts:117` | 模型在多轮会话中丢失之前确认的事实，跨 Run 记忆严重退化 |
| S2 | RECENT_DIALOGUE 双层截断（Desktop 800 + Gateway 900→345）叠加 | `gatewayAgent.ts:1294` + `contextAssembler.ts:122` | 即使总预算放开，Desktop 预截断仍会先丢信息 |

### A 级（特定场景影响可靠性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| A1 | `pending_todo` 提问检测只看最后 200 字符 | `GatewayRuntime.ts:1073` | 长文本中部问句被漏判，导致自言自语 |
| A2 | 滚动摘要 cursor 与 RECENT_DIALOGUE 窗口可能存在时间空洞 | `gatewayAgent.ts:2281-2344` | 既不在摘要中也不在最近对话中的轮次信息丢失 |
| A3 | 摘要质量依赖 LLM，关键事实可能未被保留 | `/api/agent/context/summary` | "ServerHold已解除"等决策结果可能被摘要忽略 |

### B 级（影响可维护性）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| B1 | 三处"等待用户"检测逻辑各自维护（waitingPattern / askingUserPattern / workflowV1.status） | 多处 | 改一处漏另外两处 |
| B2 | `_getLastAssistantText` 只取最后一条，不考虑多段连续助手文本 | `GatewayRuntime.ts:1103-1109` | 如果 Agent 输出被分成多段（tool call 之间的文本），只看最后一段 |
| B3 | L3 预算参数分散在 Desktop（per-message clip）和 Gateway（总预算/summary比例/per-message上限）两端 | 两个文件 | 改一端容易忘另一端，已发生（Desktop 800 vs Gateway 900 不协调） |

### C 级（中长期架构演进风险）

| # | 问题 | 影响 |
|---|------|------|
| C1 | 关键事实只靠对话文本保留，无结构化事实层 | 域名状态/审批结果等应挂在 TASK_STATE 上 |
| C2 | `thread-waiting-user-state-v0.1.md` 设计已有但未实施 | 结构化等待状态能从根本上解决 pending_todo 误触发 |
| C3 | L3 预算 50% 可能在超长会话中导致其他槽位（tools/materials）被挤压 | 需监控实际 context 使用量，必要时动态调低 RUNTIME_CONTEXT_BUDGET_SHARE |
| C4 | Desktop 端 head-only 截断（取前 N 字符）丢失尾部信息 | OpenClaw 用 head+tail 策略，Codex 用 50% head + 50% tail 中段截断，应考虑类似策略 |

---

## 6. 验证 Checklist

### 场景 1：长文本中部问句不再自言自语

- [ ] Agent 输出 1000+ 字符的长文本，中部有"请确认个人还是企业备案？"，结尾是声明句
- [ ] 验证 `_detectAssistantAskingUser` 返回 true（层 2+3 联合命中）
- [ ] 验证不追加第二段回复

### 场景 2：短文本尾部问句仍正常拦截

- [ ] Agent 输出以"？"结尾的短文本 → 不追加回复（与 Fix 3 行为一致）

### 场景 3：非提问长文本仍被 pending_todo 催促

- [ ] Agent 输出长文本，全文无问句，有未完成 todo → `pending_todo` 正常触发
- [ ] 验证 `_textHasUserDirectedQuestion` 返回 false

### 场景 4：L3 预算比例化生效

- [ ] 使用 200K token 模型（claude-sonnet-4-6），确认 `runtimeContextBudgetChars` ≈ 320,000（而非旧值 32,000）
- [ ] 确认 `recentBudget` ≈ 260,000（而非旧值 20,000）
- [ ] 日志中 `recentDialogueMsgsRetained` > 0 且 `recentDialogueBudgetChars` > 200,000

### 场景 5：跨 Run 关键事实保留

- [ ] Agent 在 Run N 确认某事实（如"ServerHold已解除"），Run N+2 中 RECENT_DIALOGUE 仍包含该信息
- [ ] 或该信息已进入 DIALOGUE_SUMMARY
- [ ] 验证 Agent 在后续 Run 中不会矛盾（不会说"还是ServerHold状态"）

### 场景 6：Desktop per-message 预截断放宽

- [ ] 使用 200K 模型，Desktop 端 per-message 预截断上限应为 9,600 chars（而非 800）
- [ ] Assistant 回复含 5000 字符的工具结果 → RECENT_DIALOGUE 中保留完整内容

### 场景 7：小窗口模型不膨胀

- [ ] 使用 50K token 模型，`runtimeContextBudgetChars` ≈ 80,000
- [ ] per-message 预截断上限为 2,400 chars
- [ ] 总 L3 消耗受预算系统自然控制

### 已有测试

```bash
npm -w @ohmycrab/gateway run test:runner-turn
```

---

## 7. 涉及文件清单

| 文件 | Fix | 改动类型 |
|------|-----|---------|
| `apps/gateway/src/agent/runtime/GatewayRuntime.ts` | Fix 1 | 三层提问检测替代单一 200 字符正则 |
| `apps/gateway/src/agent/contextAssembler.ts` | Fix 2a | L3 预算从 32K 硬上限改为 50% 比例分配（对标 OpenClaw）；`MAX_RECENT_DIALOGUE_ITEM_CHARS` 从 900 提到 12000；summary/recent 比例从 45/55 调为 35/65；summary 上限从 12K 提到 60K |
| `apps/desktop/src/agent/gatewayAgent.ts` | Fix 2b | per-message 预截断从 800 改为按模型动态 800-12000 |

---

## 8. Codex 讨论记录摘要

本方案经过 Codex 深度分析（threadId: `019cef48-f992-7e20-97d7-5bba44f1350b`）和 OpenClaw/Codex 源码对比研究。

**Codex 确认了两个 bug 的根因**：
- Bug A：`askingUserPattern.test(lastText.slice(-200))` 扫描窗口过小，对长文本场景失效
- Bug B：Desktop 800 字符截断 + Gateway 900 字符截断 = 双层丢失关键事实

**v2 初版方案**（800→1600 per-message）被用户否决："1600还是小的离谱了"。

**OpenClaw/Codex 源码分析发现的关键差距**：
- OpenClaw：`maxHistoryShare = 0.5`，200K 模型给对话 ~100K tokens，无 per-message 固定截断
- Codex：`effective_context_window_percent = 95`，200K 模型给 ~190K tokens，per-tool 10K tokens
- 我们：`MAX_RUNTIME_CONTEXT_CHARS = 32,000` 硬锁，200K 模型只有 ~8K tokens（4% context）
- 差距 12-24 倍，根因不是 per-message 上限太小，而是**总预算硬上限太低**

**v2 修订版方案（本文档）**：
- 自言自语：三层检测不变（已验证有效）
- 记忆丢失：从"提高 per-message 上限"升级为"L3 预算比例化分配"，直接对标 OpenClaw
  - `MAX_RUNTIME_CONTEXT_CHARS 32K` → `RUNTIME_CONTEXT_BUDGET_SHARE = 0.50`（50% of effective budget，对标 OpenClaw）
  - 200K 模型：L3 总预算 32K → 320K chars（~80K tokens），per-message 345 → ~10,400 chars
  - Desktop 预截断 800 → 9600 chars（粗过滤定位）
  - Gateway `MAX_RECENT_DIALOGUE_ITEM_CHARS` 900 → 12000（让预算系统自然控制）
  - 策略：先激进给到 50%，出问题再往回调

