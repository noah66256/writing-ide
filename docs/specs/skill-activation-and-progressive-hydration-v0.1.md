# Skill Activation and Progressive Hydration v0.1

> 状态：draft  
> 日期：2026-03-22  
> 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`  
> 目标：把 skill 的**候选暴露 / 自动激活 / 详情注入 / allowed-tools / per-turn 工具面**彻底拆层，修掉“误激活一个不相干 skill 就把整轮工具面锁死”的机制缺陷，并保证未来 skill 数量持续增长后仍稳定。  
> 依赖文档：  
> - `docs/specs/thread-first-progressive-capability-exposure-v0.1.md`  
> - `docs/specs/workflow-skills-runtime-v0.1.md`  
> - `docs/specs/skill-contract-openclaw-parity-v0.1.md`  
> - `docs/specs/claude-code-skill-compat-v0.1.md`  
> - `docs/research/core-tools-exposure-refactor-2026-03-13.md`

---

## 一、结论先行

本轮推荐收敛为一个 **5 层 skill 生命周期**：

1. **Catalog（目录）**：所有已安装 skill 只以轻量卡片进入 capability index。  
2. **Candidate（候选）**：基于 prompt / thread state / search 选出少量“可能相关”的 skill 卡片，但**不算激活**。  
3. **Activation（激活）**：只有显式提及，或命中**确定性的本项目 trigger** 且通过最小集裁决时，skill 才进入 `activeSkills`。  
4. **Hydration（详情注入）**：只有被真正选中的 skill，才把 prompt 片段 / SKILL.md 摘要 / workflow 合同注入本轮上下文。  
5. **Runtime Scope（运行时作用域）**：`allowed-tools` 只约束**显式 portable invocation 的执行域**，不再拿来裁整个 run 的全局工具池。

这意味着：

- **Workflow skill**（如 `style_imitate`）继续保留“自动激活 + 合同强执行”，但要走**最小集裁决**，不能多个一起盲激活。  
- **Portable / Claude skill** 默认一律走 **explicit-only**；除非它同时满足“本项目显式 triggers + 有效 trigger + `activationMode` 允许 + 非 `disable-model-invocation`”。  
- **`allowed-tools` 不再是 run 级硬白名单**；它改成 invocation-scope overlay，最多只影响“显式 portable skill 的主执行域 / fork 子 agent”，不能误伤其它 skill 和基础工具。  
- **无效 trigger / 空 regex 必须 fail-close**；不能再出现“pattern 丢了，所以 text_regex 当通过”。  
- **随着 skill 变多，摘要层不再按字母顺序截前 6 个**；而是基于现有 capability search 做 relevance 排序，只把和本轮 prompt 最相关的 skill cards 放进上下文。

一句话：

> 我们要对齐的不是“更多自动触发”，而是 **轻量暴露 → 最小选择 → 按需注入 → 局部约束**。

---

## 二、已有上下文索引

### 2.1 已有 spec / research

- `docs/specs/thread-first-progressive-capability-exposure-v0.1.md`
  - 已经把 **inactive skills** 收敛为 capability cards，并给出 `search/describe -> hydrate -> sticky` 的 thread-first 范式。
- `docs/specs/workflow-skills-runtime-v0.1.md`
  - 已经定义 workflow skill 的 runtime 合同，重点是 `style_imitate` 的闭环执行。
- `docs/specs/skill-contract-openclaw-parity-v0.1.md`
  - 已经强调“激活后必须执行 workflow 合同”，但没有解决“谁该激活 / 多个 skill 怎么裁 / allowed-tools 作用域”。
- `docs/specs/claude-code-skill-compat-v0.1.md`
  - 已明确提出 portable skill 应走“安全显式模式”，但当前实现没有彻底遵守。
- `docs/research/core-tools-exposure-refactor-2026-03-13.md`
  - 已确定 `CORE_TOOLS` / `HIGH_RISK_TOOLS` / opMode 边界，说明 run 级工具裁剪不能误伤基础交付工具。

### 2.2 近期相关提交

- `8776f69 fix(agent): preserve lint tools for explicit skill runs`
- `3a7096c feat: add thread-first capability exposure`
- `77183a4 feat: land desktop runtime hardening and portable skill support`
- `ee238f1 feat: add claude skill compatibility v0.1`
- `9e9800f feat: close claude skill github install and bridge parity`
- `fafaf4f fix(style): converge style imitate runtime contract`

### 2.3 本次问题的直接证据

真实会话日志中，同一轮出现了：

- `activeSkillIds=["style_imitate", "micro-drama-writer", "skill-creator"]`
- `selectedToolNames=["write","edit","read","project.search","project.searchPaths","shell.exec","web.fetch","spawn_agent"]`
- `turn0EffectiveAllowedCount=4`
- `baselineCount=8`
- `gatedCount=4`

日志文件：

- `/Users/noah/Library/Application Support/OhMyCrab/ohmycrab-data/conversations/conv_conv_1773302247097_e43a1db447234.json`

这证明当前 bug 不是“没激活目标 skill”，而是：

> **误激活了不相干 portable skills，然后把它们的 `allowed-tools` 当成了全局硬门禁。**

---

## 三、需求卡片

- 场景：用户在桌面端自然语言执行任务时，容易命中不相干 skills；skill 一多，这种误命中会越来越频繁，并把本轮工具池裁坏。
- 目标：
  - 修正 skill 的暴露 / 候选 / 激活 / 详情注入 / `allowed-tools` 语义边界；
  - 对齐 Codex / Claude Code 的“轻量暴露 + 按需注入 + 最小集选择”；
  - 保证未来 skill 数量持续增长时，桌面端仍不因为误激活而崩。
- 对标：
  - OpenAI Codex skills
  - Anthropic Claude Code skills / slash commands
- 约束：
  - 保留现有 workflow skill（尤其 `style_imitate`）合同；
  - 不把所有逻辑都堆成 gateway 特例；
  - 兼容现有 portable / Claude skill 目录；
  - 不改变“Desktop 执行工具、Gateway 编排”的产品边界。
- 不做什么：
  - 不在本轮实现完整 Claude runtime parity；
  - 不重写全部 skill 格式；
  - 不让模型基于 description 自由自动激活任意 portable skill；
  - 不直接写实现代码。

---

## 四、现状地图

### 4.1 相关文件

| 文件 | 职责 | 与本次需求关系 |
|------|------|----------------|
| `packages/agent-core/src/skills.ts` | trigger 匹配、`activateSkills()` | 当前 `text_regex` 空 pattern 会直接通过；auto 激活缺少“最小集裁决” |
| `apps/desktop/electron/skill-loader.mjs` | frontmatter -> `SkillManifest` | 当前只保留 `trigger.args`，会丢 Claude 风格 shorthand；portable `autoEnable` 仍可能被错误打开 |
| `apps/gateway/src/agent/runFactory.ts` | run 准备、工具池、context、审计 | 当前把 portable `allowed-tools` 升格成 run 级 hard gate |
| `apps/gateway/src/agent/portableSkillCompat.ts` | `allowed-tools` 解析、notice | 当前直接宣称“Crab uses hard runtime gates while these skills are active” |
| `apps/gateway/src/agent/capabilityIndex.ts` | skill cards 构造、capability search | 已有 card/search 基础，但默认 alpha 排序，不适合 skill 数量增长 |
| `apps/gateway/src/agent/contextAssembler.ts` | capability summary 注入上下文 | 当前只取前 6 个 skill cards，且不是按 relevance 选 |
| `apps/gateway/src/agent/threadCapabilityState.ts` | thread active/sticky skill state | 已有 `activeSkillIds<=6 / stickySkillIds<=6`，但当前没有把“候选 / 激活 / hydrated”拆开 |

### 4.2 当前调用链

#### A. 激活链

- `packages/agent-core/src/skills.ts:284`
  - `activateSkills()` 会遍历 manifest，根据 `autoEnable` / `explicitSkillIds` / triggers 决定激活。
- `packages/agent-core/src/skills.ts:195`
  - `text_regex` 若 pattern 缺失，当前返回 `ok=true`。
- `apps/desktop/electron/skill-loader.mjs:443`
  - `autoEnable` 当前对 portable skill 仍可能被 frontmatter 直接打开。
- `apps/desktop/electron/skill-loader.mjs:451`
  - `triggers` 只保留 `r.args`，不会把 `pattern` 这类 shorthand 字段归一化到 `args`。

#### B. 工具面链

- `apps/gateway/src/agent/runFactory.ts:3092`
  - 当前会把所有 active portable skill 汇总进 `parsePortableAllowedToolPolicy()`
- `apps/gateway/src/agent/portableSkillCompat.ts:478`
  - 解析所有 portable skill 的 `allowed-tools`
- `apps/gateway/src/agent/runFactory.ts:3843`
  - 对 `baseAllowedToolNames` 做全局 hard prune
- `apps/gateway/src/agent/runFactory.ts:4263`
  - 对 `selectedAllowedToolNames` 再做一遍全局 hard prune

#### C. 能力暴露链

- `apps/gateway/src/agent/capabilityIndex.ts:327`
  - 已经能为**未激活** skill 构造 `SkillCard`
- `apps/gateway/src/agent/contextAssembler.ts:469`
  - 已能把 skill cards 摘要注入 prompt
- `apps/gateway/src/agent/contextAssembler.ts:477`
  - 但当前只截 `installed.slice(0, 6)`，无法随 skill 数量增长而保持相关性
- `apps/gateway/src/agent/threadCapabilityState.ts:5`
  - 线程 active/sticky 已有 LRU 上限，适合继续复用

### 4.3 最自然的扩展点

- 已有 `SkillCard + searchCapabilityCards + threadCapabilityState`，说明“卡片目录 -> relevance 排序 -> hydrate/activate”的骨架已经具备；
- 现有 workflow runtime 已能承接“激活后必须执行”的部分；
- 最大缺口不在“怎么执行 skill”，而在：
  1. **谁算 candidate**
  2. **谁算 active**
  3. **谁才允许 hydrate**
  4. **`allowed-tools` 到底约束哪一层**

### 4.4 不能轻易动的约束点

- `style_imitate` 的 workflow 合同不能被削弱成“建议”
- `CORE_TOOLS` 与 delivery invariants 不能再被 skill 语义误裁
- `thread-first progressive capability exposure` 已落地，新的 spec 必须站在它之上，而不是推翻

---

## 五、外部调研摘要

### 5.1 Codex（本地源码 + 官方文档）

#### 证据

- `third_party/openai-codex/codex-rs/core/src/skills/render.rs:22`
  - Codex 把 skills 作为“目录 + 使用说明”渲染进 prompt，并明确要求：**多个 skill 适用时选择 minimal set**。
- `third_party/openai-codex/codex-rs/core/src/skills/injection.rs:24`
  - `build_skill_injections(mentioned_skills, ...)` 只对 **mentioned skills** 读取 `SKILL.md` 正文。
- `third_party/openai-codex/codex-rs/core/tests/suite/skills.rs:37`
  - 测试验证显式 `$demo` / `UserInput::Skill` 时，skill body 才进入请求。
- OpenAI 官方文档：
  - [Codex Skills](https://developers.openai.com/codex/skills)
  - 结论：description 常驻，full skill content 只在 invoked 时加载；还提供 `allow_implicit_invocation: false` 防止隐式调用。

#### 可借鉴

- “候选目录”和“详情注入”必须分层
- 多个 skill 命中时采用 minimal set
- 明确提供 explicit-only 开关

#### 要规避

- 不要把“skill 在目录中可见”误当成“skill 已激活”
- 不要把“激活”误扩展成“整轮工具池被该 skill 白名单接管”

### 5.2 Claude Code（官方仓样例 + 官方文档）

#### 证据

- `/tmp/anthropics-claude-code/README.md:48`
  - 公开仓重点是 plugins / commands / skills 合同与样例，不是完整 runtime 核心。
- `/tmp/anthropics-claude-code/plugins/README.md:3`
  - skill/command/plugin 都是可分享能力包。
- `/tmp/anthropics-claude-code/plugins/plugin-dev/skills/command-development/references/frontmatter-reference.md:270`
  - `disable-model-invocation: true` 被明确定义为 manual-only。
- `/tmp/anthropics-claude-code/CHANGELOG.md:1108`
  - slash commands 与 skills 已合并，但“no change in behavior”。
- `/tmp/anthropics-claude-code/CHANGELOG.md:215`
  - `allowed-tools` 与 permission rules 同处权限层，而不是“全局工具裁剪层”。
- `/tmp/anthropics-claude-code/CHANGELOG.md:427`
  - 交互工具也不能因为 skill `allowed-tools` 被静默 auto-allow，进一步说明它属于权限语义。
- `/tmp/anthropics-claude-code/CHANGELOG.md:1274`
  - `skill allowed-tools` 的修复语义是“应用到该 skill 调用出的工具”，不是“重建整轮全局工具池”。
- Anthropic 官方文档：
  - [Claude Code slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
  - 结论：description 常驻，full contents 按需加载；`disable-model-invocation` 时只允许用户手动调用。

#### 可借鉴

- `allowed-tools` 应归入 **skill invocation permissions**，不是 run-global tool pruning
- `disable-model-invocation` / `user-invocable` 是独立于 trigger 的显式边界
- slash command / skill 统一，但不意味着“所有 skill 自然语言都可自由 auto-activate”

#### 要规避

- 不要把 portable / command-like skill 和 workflow skill 混在同一个自动激活面
- 不要把 imported Claude skill 的 frontmatter 直接翻译成全局 runtime gate

### 5.3 调研结论

#### 推荐模式

- `L0 stable tools + skill cards + minimal activation + deferred hydration + invocation-scoped permissions`

#### 放弃模式

- `description/regex 命中 -> 全量 active -> SKILL.md 注入 -> allowed-tools 全局硬门禁`

---

## 六、方案收敛

### 6.1 推荐方案：Skill Lifecycle 分层 + Invocation-Scoped Permissions

#### 6.1.1 新的生命周期语义

```ts
type SkillLifecycleState =
  | "cataloged"     // 仅存在于 capability index
  | "candidate"     // 本轮可能相关，但未激活
  | "active"        // 本轮已选中，应参与执行
  | "hydrated"      // 本轮详情已注入 prompt / context
  | "scoped";       // 本轮有 invocation-specific allowed-tools / args / agent scope
```

#### 6.1.2 新的分类与边界

- **Workflow Skill**
  - 允许 auto activation
  - 允许合同级 runtime gate
  - 但必须经过**最小集裁决**，同一轮最多一个主 workflow auto winner

- **Portable Skill**
  - 默认 explicit-only
  - 只有显式 invocation，或同时满足“本项目有效 trigger + `activationMode` 允许 + 非 `disableModelInvocation`”才可进入 active
  - `allowed-tools` 只在 **scoped invocation** 中生效

- **Hint / Service Skill**
  - 默认不再因为 description / 空 regex 直接 auto-active
  - 可继续作为 candidate cards 被 `search/describe`
  - 如需自动化，必须走明确且有效的本项目 triggers

#### 6.1.3 激活仲裁（最小集）

激活顺序改为：

1. **显式 skill invocation**（用户 slash / skill ref）优先
2. **workflow auto candidates**
   - 只允许单一 deterministic winner 自动进入 active
   - 若多个同级别 workflow 同时命中且无法稳定裁决，则全部降为 candidate
3. **portable / hint / service auto candidates**
   - 不再默认并入 active
   - 除非其为显式 invocation，或被已选中的 workflow `requires`

建议不变量：

- `MAX_AUTO_WORKFLOW_SKILLS_PER_RUN = 1`
- `MAX_HYDRATED_SKILLS_PER_RUN = 2`（典型为 `1 workflow + 1 explicit portable`）
- 其它相关 skill 仅保留为 candidate / card

#### 6.1.4 Hydration 规则

- `ACTIVE_SKILLS(JSON)` 只包含 `active` / `hydrated` skills
- capability summary 只暴露 `candidate` cards
- 只有被选中的 skill 才允许：
  - 注入 `promptFragments.system`
  - 注入 workflow summary / SKILL.md 摘要
  - 影响 thread active/sticky skill state

#### 6.1.5 `allowed-tools` 新语义

新的边界：

- `allowed-tools` = **invocation-scoped permission overlay**
- 不再等于 `portableHardAllowedToolNames`
- 不再直接 prune `baseAllowedToolNames` / `selectedAllowedToolNames`

作用域仅限：

1. 用户显式调用的 portable skill 主执行域
2. 该 portable skill 派生的 fork/sub-agent 执行域

不再影响：

- 全局 `CORE_TOOLS`
- 其它已激活 workflow skill 的必要工具
- 未显式进入该 portable skill 的普通 run

#### 6.1.6 规模化策略

- skill 数量变多后，context summary 不能再用 alpha 前 6 个
- 应直接复用现有 `searchCapabilityCards()` 做 relevance 排序
- thread sticky / active 继续使用现有上限：
  - `activeSkillIds <= 6`
  - `stickySkillIds <= 6`
- 但 sticky 只记录：
  - 显式调用过的 skill
  - 或真正 `hydrated` 过的 skill
  - **candidate 不进 sticky**

### 6.2 可行备选：保留全局 hard gate，只补白名单豁免

做法：

- 保留 `portableHardAllowedToolNames`
- 仅给 `CORE_TOOLS` / workflow-required tools / selected fallback tools 加豁免
- 再修 regex / trigger parser bug

优点：

- 改动小
- 安全感表面更强

缺点：

- 仍然把“误激活”放大成“整轮工具面扭曲”
- skill 变多后冲突和豁免会指数膨胀
- 仍偏离 Codex / Claude 的“最小集 + 按需注入”范式

结论：

> 不推荐。它只是在现有耦合结构上打补丁，无法从机制上解决“skill 越多越危险”。

---

## 七、详细设计

### 7.1 触发与激活：fail-close + 最小集

#### 规则

1. `text_regex` 必须拿到非空 pattern；否则视为 invalid，不得 auto-pass  
2. loader 需兼容两种 trigger 形态：
   - 标准：`{ when, args: { pattern } }`
   - shorthand：`{ when, pattern }`
3. portable skill 的 `autoEnable` 新规则：
   - `portable && !hasValidTriggers` -> 强制 `autoEnable=false`
   - `disableModelInvocation=true` -> 强制 `autoEnable=false`
4. `activateSkills()` 新增“最小集裁决”，不能多个 auto candidates 全入 `active`

### 7.2 Candidate / Active / Hydrated 分离

#### 新概念

```ts
type SkillSelectionResult = {
  candidateSkillIds: string[];
  activeSkillIds: string[];
  hydratedSkillIds: string[];
  explicitPortableInvocationSkillIds: string[];
};
```

#### 约束

- `candidateSkillIds` 仅用于 capability summary / tools.search / tools.describe
- `activeSkillIds` 用于 workflow、stageKey、审计、thread active state
- `hydratedSkillIds` 才允许把详情注入 prompt
- `explicitPortableInvocationSkillIds` 才允许带 invocation-scoped `allowed-tools`

### 7.3 Invocation-Scoped `allowed-tools`

#### 新语义

```ts
type PortableInvocationScope = {
  skillId: string;
  contextMode: "inline" | "fork";
  allowedToolNames: Set<string>;
  rawAllowedTools: string[];
  agent?: string;
  arguments?: string;
};
```

#### 执行规则

- `inline`：
  - 只把 `allowedToolNames` 当作该 portable skill 的**推荐/许可执行集**
  - 不再从全局工具池删其它工具
- `fork`：
  - 子 agent / 子 run 可按 `CORE_TOOLS ∪ allowedToolNames ∪ required follow-up tools` 收窄
  - 但收窄发生在**该 fork 内部**，不反向污染父 run

### 7.4 能力摘要与搜索排序

现有基础可直接复用：

- `searchCapabilityCards()` 已具备 BM25 + capability boost
- `SkillCard.searchText` 已包含：
  - `skillId`
  - `title`
  - `description`
  - `activationMode`
  - `allowedTools`
  - `triggers`

本轮只需把“摘要展示”从 alphabetic 前 6 改成：

```ts
summaryCards = searchCapabilityCards({
  query: userPrompt,
  cards: skillCards,
  limit: 6,
});
```

若 `query` 为空：

- 优先最近 `recentlyDescribedIds`
- 再优先 `stickySkillIds`
- 最后回退 alpha

### 7.5 与现有 workflow runtime 的关系

- `style_imitate` 继续保持 workflow skill 地位
- 它的闭环 gate 不变
- 本 spec 只补它之前的“谁应激活 / 谁应 hydrate / 谁能裁工具面”
- 其它 workflow skill 后续按同一 activation boundary 接入

---

## 八、改动点清单（带 HEAD / 行号 / unified diff）

> 说明：以下 diff 是实施草案，目标是固定机制边界，不要求逐字符与最终实现完全一致；但所有结论都绑定当前 HEAD 与当前行号。

### Change 1 / P0：Trigger fail-close + 最小集仲裁

- 文件：`packages/agent-core/src/skills.ts`
- 符号：`matchTrigger()` / `activateSkills()`
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：
  - `matchTrigger(text_regex)`：`195`
  - `activateSkills()`：`284`

#### 改动原理

- 修复空 regex 误通过
- 为后续 run/gateway 引入 `candidate/active` 最小集裁决入口

#### unified diff

```diff
--- a/packages/agent-core/src/skills.ts
+++ b/packages/agent-core/src/skills.ts
@@
-  if (when === "text_regex") {
-    const pattern = normStr(a?.pattern);
-    if (!pattern) return { ok: true, reasonCodes: ["trigger:text_regex:empty"], detail: {} };
+  if (when === "text_regex") {
+    const pattern = normStr(a?.pattern);
+    if (!pattern) {
+      return { ok: false, reasonCodes: ["trigger:text_regex:missing_pattern"], detail: {} };
+    }
@@
-export function activateSkills(args: {
+export function activateSkills(args: {
@@
-}): ActiveSkill[] {
+}): {
+  candidateSkills: ActiveSkill[];
+  activeSkills: ActiveSkill[];
+} {
@@
-  const out: Array<{ m: SkillManifest; s: ActiveSkill }> = [];
+  const candidates: Array<{ m: SkillManifest; s: ActiveSkill; explicit: boolean }> = [];
@@
-    activeSkillIds.add(skillId);
-    for (const cid of conflicts) blockedByConflict.add(cid);
-    out.push({
+    candidates.push({
       m,
       s: {
@@
-  return out.map((x) => x.s);
+  const active = selectMinimalSkillSet(candidates);
+  return {
+    candidateSkills: candidates.map((x) => x.s),
+    activeSkills: active.map((x) => x.s),
+  };
 }
```

#### 边界情况

- 老 skill 使用 `text_regex` 但 pattern 缺失：不再自动激活，只会保留为目录卡片
- 同一轮多个 workflow 同时命中：若无稳定 winner，则全部降为 candidate

#### 验证方式

- `micro-drama-writer` 在 pattern 缺失时不应自动激活
- `style_imitate` 命中时仍能成为唯一 workflow winner

---

### Change 2 / P0：Loader 归一化 shorthand triggers，并收紧 portable autoEnable

- 文件：`apps/desktop/electron/skill-loader.mjs`
- 符号：`normalizeSkillManifestFromFrontmatter`（manifest 归一化逻辑）
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：
  - `portable / autoEnable`：`440`
  - `triggers map`：`451`

#### 改动原理

- 兼容 Claude / 用户 skill 常见 shorthand
- 阻止 imported portable skill 因 `auto-enable: true` 且无有效 trigger 而自动激活

#### unified diff

```diff
--- a/apps/desktop/electron/skill-loader.mjs
+++ b/apps/desktop/electron/skill-loader.mjs
@@
-  const hasStructuredTriggers = Array.isArray(raw.triggers) && raw.triggers.length > 0;
+  const normalizedTriggers = Array.isArray(raw.triggers)
+    ? raw.triggers.map((r) => normalizeTriggerShorthand(r))
+    : [];
+  const hasValidTriggers = normalizedTriggers.length > 0;
@@
-  const autoEnable = typeof raw.autoEnable === "boolean"
-    ? (disableModelInvocation ? false : raw.autoEnable)
-    : (hasStructuredTriggers ? true : portable ? false : true);
+  const autoEnable = typeof raw.autoEnable === "boolean"
+    ? (disableModelInvocation ? false : (portable ? raw.autoEnable && hasValidTriggers : raw.autoEnable))
+    : (hasValidTriggers ? true : portable ? false : true);
@@
-  const triggers = Array.isArray(raw.triggers)
-    ? raw.triggers.map((r, i) => {
+  const triggers = normalizedTriggers
+    ? normalizedTriggers.map((r, i) => {
         if (!isObj(r)) throw new Error(`SKILL_TRIGGER_INVALID:${id}:${i}`);
         const when = norm(r.when);
         if (!VALID_TRIGGER_WHEN.has(when)) throw new Error(`SKILL_TRIGGER_WHEN_INVALID:${id}:${i}`);
-        return { when, args: isObj(r.args) ? r.args : {} };
+        return { when, args: isObj(r.args) ? r.args : {} };
       })
     : [];
```

#### 边界情况

- 原生本项目 skill 若已用标准 `args`，行为不变
- imported portable skill 即使写了 `auto-enable: true`，但没有有效 trigger，也只保留 explicit-only

#### 验证方式

- `skill-creator` 不应再因 `auto-enable: true` 且无 triggers 而自动激活
- `micro-drama-writer` 的 shorthand `pattern` 能正确落入 `args.pattern`

---

### Change 3 / P0：`allowed-tools` 改为 invocation-scoped overlay，移除 run-global hard gate

- 文件：`apps/gateway/src/agent/portableSkillCompat.ts`
- 符号：`parsePortableAllowedToolPolicy()` / `buildPortableAllowedToolPolicyNotice()`
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：`478`

#### 改动原理

- 现状把 portable skill 的 `allowed-tools` 升格为“这些 skills active 时的 hard runtime gate”
- 新语义改为“显式 portable invocation 的 permission overlay”

#### unified diff

```diff
--- a/apps/gateway/src/agent/portableSkillCompat.ts
+++ b/apps/gateway/src/agent/portableSkillCompat.ts
@@
-export function parsePortableAllowedToolPolicy(manifests: SkillManifest[]): PortableAllowedToolPolicy | null {
+export function parsePortableAllowedToolPolicy(manifests: SkillManifest[]): PortableAllowedToolPolicy | null {
@@
-  return {
+  return {
     activeSkillIds: Array.from(new Set(activeSkillIds.filter(Boolean))),
     allowedToolNames,
     rules,
@@
-export function buildPortableAllowedToolPolicyNotice(policy: PortableAllowedToolPolicy | null | undefined) {
+export function buildPortableAllowedToolPolicyNotice(policy: PortableAllowedToolPolicy | null | undefined) {
   if (!policy) return "";
-  const lines = ["Portable skill allowed-tools guardrails (Crab uses hard runtime gates while these skills are active):"];
+  const lines = ["Portable skill allowed-tools overlay (only applies inside explicit portable skill execution scope):"];
```

#### 边界情况

- 没有显式 portable invocation 时，`allowed-tools` 只参与 capability card / audit，不改全局工具池
- 显式 portable invocation 存在时，仍可把其工具映射出来供执行域使用

#### 验证方式

- 普通写作场景误激活 `skill-creator` 时，不应再把工具池裁成 8 个
- `/skill-creator ...` 这类显式调用，仍能拿到它声明的工具 overlay

---

### Change 4 / P0：RunFactory 拆分 candidate / active / hydrated / scoped sets，并删除全局 hard prune

- 文件：`apps/gateway/src/agent/runFactory.ts`
- 符号：
  - `prepareAgentRun` skill 选择逻辑
  - `baseAllowedToolNames` / `selectedAllowedToolNames` 收口逻辑
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：
  - active portable policy：`3092`
  - baseAllowed hard prune：`3843`
  - selectedAllowed hard prune：`4263`
  - SkillPolicy 审计：`6471`

#### 改动原理

- 把“skill 是候选”和“skill 已激活”拆开
- 把 `portableHardAllowedToolNames` 从 run-global 语义降级为 scoped invocation 语义

#### unified diff

```diff
--- a/apps/gateway/src/agent/runFactory.ts
+++ b/apps/gateway/src/agent/runFactory.ts
@@
-  const activePortableManifests = activeSkillIds
+  const activePortableManifests = hydratedSkillIds
     .map((id) => skillManifestById.get(id) as any)
     .filter((manifest: any) => manifest?.portable);
@@
-  const portableHardAllowedToolNames =
-    portableAllowedToolPolicy?.allowedToolNames && portableAllowedToolPolicy.allowedToolNames.size
-      ? portableAllowedToolPolicy.allowedToolNames
-      : null;
+  const invocationScopedPortableAllowedToolNames =
+    explicitPortableInvocationSkillIds.length > 0 && portableAllowedToolPolicy?.allowedToolNames?.size
+      ? portableAllowedToolPolicy.allowedToolNames
+      : null;
@@
-  if (portableHardAllowedToolNames?.size) {
-    for (const name of Array.from(baseAllowedToolNames)) {
-      if (!portableHardAllowedToolNames.has(name)) {
-        baseAllowedToolNames.delete(name);
-      }
-    }
-  }
+  // portable allowed-tools no longer prune the global baseline tool pool
@@
-  if (portableHardAllowedToolNames?.size) {
-    for (const name of Array.from(selectedAllowedToolNames)) {
-      if (!portableHardAllowedToolNames.has(name)) {
-        selectedAllowedToolNames.delete(name);
-      }
-    }
-  }
+  // invocation-scoped portable overlays are enforced only inside explicit portable execution scope
@@
-    detail: {
-      stageKey: stageKeyForRun,
-      activeSkillIds,
-      activeSkills,
+    detail: {
+      stageKey: stageKeyForRun,
+      candidateSkillIds,
+      activeSkillIds,
+      hydratedSkillIds,
+      explicitPortableInvocationSkillIds,
+      activeSkills,
```

#### 边界情况

- 单个显式 portable skill 作为主任务时，后续仍可在 scoped 执行域里收窄工具
- 非显式 portable skill 即使被识别为 candidate，也不应污染全局工具池

#### 验证方式

- 真实复现语句下：
  - `style_imitate` active
  - `skill-creator` candidate-only 或 explicit-only
  - `kb.search / time.now / run.todo / project.listFiles` 不再被误裁

---

### Change 5 / P1：Skill cards 摘要改为 relevance 排序，不再 alpha 前 6

- 文件：`apps/gateway/src/agent/capabilityIndex.ts`
- 符号：`buildSkillCards()` / `searchCapabilityCards()`
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：
  - `buildSkillCards()`：`327`
  - `searchCapabilityCards()`：`500`

- 文件：`apps/gateway/src/agent/contextAssembler.ts`
- 符号：`buildSkillCapabilitySummary()`
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：`469`

#### 改动原理

- skill 数量增长后，摘要层必须按 prompt relevance 展示，否则 relevant skill 永远进不了上下文

#### unified diff

```diff
--- a/apps/gateway/src/agent/contextAssembler.ts
+++ b/apps/gateway/src/agent/contextAssembler.ts
@@
-  if (installed.length > 0) {
+  const rankedInstalled = args.userPrompt
+    ? searchCapabilityCards({ query: args.userPrompt, cards: installed, limit: 6 }).map((x) => x.card as SkillCard)
+    : installed.slice(0, 6);
+  if (rankedInstalled.length > 0) {
     lines.push("- 可按需激活的 Skills（未激活）：");
-    lines.push(...renderSkillCapabilityCardLines(installed.slice(0, 6)));
+    lines.push(...renderSkillCapabilityCardLines(rankedInstalled));
   }
```

#### 边界情况

- prompt 为空时，仍可回退到 sticky/recently-described/alpha
- 已激活 skill 不应再次出现在 inactive summary

#### 验证方式

- 安装 50+ skills 后，输入“按李叔风格写口播稿”，摘要里应优先出现 `style_imitate` 一类相关 cards，而不是按字母顺序的前 6 个

---

### Change 6 / P1：线程状态只粘住 explicit / hydrated skills，不把 candidate 当 active

- 文件：`apps/gateway/src/agent/threadCapabilityState.ts`
- 符号：`activateSkillCapability()`
- 当前 HEAD：`fafaf4f1d3c73b3fa2a664633cbf2ec263de822f`
- 当前行号：`125`

#### 改动原理

- thread-first sticky 应服务于“我已经决定要用这个 skill”，不能把“只是这轮看上去相关”的 candidate 也变成下一轮 sticky active

#### unified diff

```diff
--- a/apps/gateway/src/agent/threadCapabilityState.ts
+++ b/apps/gateway/src/agent/threadCapabilityState.ts
@@
-export function activateSkillCapability(args: {
+export function activateSkillCapability(args: {
   state: ThreadCapabilityState | null | undefined;
   skillId: string;
+  mode?: "explicit" | "hydrated";
 }): ThreadCapabilityState {
@@
-  return {
+  if (args.mode !== "explicit" && args.mode !== "hydrated") return base;
+  return {
```

#### 边界情况

- `tools.describe(skill:...)` 只做 candidate/describe 时，不写 active/sticky
- 真正 explicit invoke / hydrated workflow skill 时，才进入 sticky

#### 验证方式

- 在 unrelated 下一轮对话中，不应因为上一轮只是“描述过 skill 卡片”就自动继承 active skill

---

## 九、风险与连锁反应

### 9.1 连锁反应

1. `claude-code-skill-compat-v0.1.md` 中关于 `allowed-tools` 的 run-global 生效表述需要被本 spec 覆盖
2. `portableSkillCompat` 的 notice 文案和部分 smoke 预期要同步更新
3. `activateSkills()` 返回值变化会影响 `runFactory` 调用点
4. `threadCapabilityState` 的 write 路径要避免把 candidate 误写进 active/sticky

### 9.2 性能风险

1. 摘要 relevance 排序若每轮都对全部 skills 做 BM25，skill 数量极大时会增 CPU
   - 缓解：复用现有 tokenize / bm25，并限制 summary ranking 只做 top 6
2. 若 hydration 数量不设上限，仍可能导致 prompt 膨胀
   - 缓解：`MAX_HYDRATED_SKILLS_PER_RUN = 2`

### 9.3 兼容性风险

1. 某些历史用户 skill 依赖“空 regex 误通过”
   - 这类行为应视为 bug，不兼容保持
2. 某些 imported Claude skill 可能依赖 `auto-enable: true`
   - 若没有本项目有效 triggers，应视为 explicit-only，这是有意收紧

### 9.4 proposal-first / rollback 影响

- 本 spec 不直接改变 proposal-first 写入语义
- 风险主要在 skill 激活边界与工具面
- 可通过 feature flag 分阶段灰度：
  - `SKILL_MINIMAL_ACTIVATION_V1`
  - `PORTABLE_ALLOWED_TOOLS_SCOPE_V1`
  - `SKILL_CARD_RELEVANCE_SUMMARY_V1`

---

## 十、验证 checklist

### 10.1 功能验收

- [ ] 输入“用@李叔风格写篇口播稿，主题是 AI 会不会替代人类”
  - 仅 `style_imitate` 成为 workflow active
  - `skill-creator` 不进入 active
  - `kb.search / run.todo / time.now / project.listFiles` 仍可见

- [ ] `micro-drama-writer` 使用 shorthand `pattern`
  - pattern 被正确归一化
  - 只在文本真正命中时成为 candidate/active

- [ ] imported Claude portable skill 只有 `auto-enable: true`、无有效 triggers
  - 不自动激活
  - 仍能通过 slash / explicit invocation 调用

- [ ] `/skill-creator ...` 显式调用
  - 可拿到它声明的 tools overlay
  - 但不会把本轮其它 core tools 从全局池里删掉

- [ ] 多个 workflow 同时命中
  - 若无 deterministic winner，则全部降为 candidate
  - 不得出现多个 workflow 同时 auto-active

### 10.2 规模化验收

- [ ] 安装 50+ skills 后，capability summary 仍只展示与当前 prompt 最相关的 top 6
- [ ] `tools.search` 仍能搜到其它未进摘要的 skills
- [ ] `tools.describe(skill:...)` 后，只有真正 explicit/hydrated 的 skill 进入 thread sticky

### 10.3 观测验收

- [ ] `SkillPolicy` 审计日志带出：
  - `candidateSkillIds`
  - `activeSkillIds`
  - `hydratedSkillIds`
  - `explicitPortableInvocationSkillIds`
- [ ] 能明确区分：
  - “skill 只是相关候选”
  - “skill 已激活”
  - “skill 已注入详情”
  - “portable overlay 正在哪个 execution scope 生效”

---

## 十一、回滚与兼容说明

- 若上线后发现 imported skill 自动化能力收得过紧：
  - 仅回退 `SKILL_MINIMAL_ACTIVATION_V1`
  - 不回退 `text_regex fail-close`
  - 不回退 `allowed-tools scope` 去重新引入 run-global hard gate

- 若 relevance summary 导致摘要不稳定：
  - 可单独关闭 `SKILL_CARD_RELEVANCE_SUMMARY_V1`
  - 回退到 sticky/recently-described/alpha fallback

- 不建议回滚到“portable skill active -> hard prune global tool pool”
  - 这会直接把当前已知 bug 路径重新打开

---

## 十二、明确不做什么

1. 不在本轮实现完整 Claude 私有 runtime 复制
2. 不让所有 hint/service skill 都自动激活
3. 不把 `allowed-tools` 扩展成全局 top-level tool policy
4. 不重写 `style_imitate` workflow 本身
5. 不把 candidate cards 直接写入 `ACTIVE_SKILLS(JSON)`

---

## 十三、涉及文件清单

- `packages/agent-core/src/skills.ts`
- `apps/desktop/electron/skill-loader.mjs`
- `apps/gateway/src/agent/portableSkillCompat.ts`
- `apps/gateway/src/agent/runFactory.ts`
- `apps/gateway/src/agent/capabilityIndex.ts`
- `apps/gateway/src/agent/contextAssembler.ts`
- `apps/gateway/src/agent/threadCapabilityState.ts`

---

## 十四、与旧文档的关系

- `docs/specs/thread-first-progressive-capability-exposure-v0.1.md`
  - 保持有效；本 spec 补的是 **skill 从 capability card 进入 active/hydrated/runtime scope 的边界**。
- `docs/specs/workflow-skills-runtime-v0.1.md`
  - 保持有效；本 spec 不改 workflow 合同，只改激活与 tool gating 边界。
- `docs/specs/claude-code-skill-compat-v0.1.md`
  - 其中“portable skill 安全显式模式”的方向保持有效；
  - 但关于 `allowed-tools` 的 run-global 生效理解，以本 spec 为准。

