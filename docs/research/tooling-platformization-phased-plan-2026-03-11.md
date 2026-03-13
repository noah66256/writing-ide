# 工具/Skill/MCP 平台化分 Phase 路线（面向创业者/企业）

> TIP（2026-03-13）：Phase2 中提到的“profile/policy pipeline”在 Crab 中已具体落地为：  
> - gateway 层显式维护 `CORE_TOOLS` / `HIGH_RISK_TOOLS` 集合；  
> - 通过 opMode（创作/助手）控制基础工具与高危工具的暴露，而不是再引入一套独立的 profile 维度；  
> - Tool Retrieval/B2 仅在 MCP/插件工具空间内做检索/扩展，基础工具集合不再参与裁剪。  
> 更细节的实现与取舍见 `docs/research/core-tools-exposure-refactor-2026-03-13.md`，本文的 Phase 拆解依然作为整体路线参考。

> 目标：让「对话驱动的 AI 内容团队」在工具规模变大（几十→几百→上千）时仍然 **稳定交付、可控可审计、可配置扩展**。
>
> 核心问题：不能再把“工具是否可用”赌在每轮 LLM 的一次意图判断或 topK 检索上；需要把能力治理做成平台底座。

---


## 进度快照（2026-03-11）

> 重要：本文的 Phase2 指「Profiles + Policy Pipeline（平台治理核心）」。
> 我们代码里最近落地并验证通过的“Phase2”是另一条线：**文件交付契约（Delivery Contract）**。
> 两条线都成立，但不要混用编号。

已落地（交付链路止血线，直接对应线上回放问题）：
- Phase0：Deliverability 不变量 + 基础自愈（避免交付工具被裁掉）
- Phase1：工具发现层 `tools.search/tools.describe`
- Phase2：文件交付契约（禁止口头交付；`run.done` 不可绕过；文本收口前强制落盘）

参考：`docs/research/deepresearch-intent-routing-tool-discovery-and-file-delivery-contract-2026-03-11.md`

## 0. 术语对齐（我们系统里三类东西的定位）

### Tool（内置工具）
- 单一来源：`packages/tools/src/index.ts` 的 `TOOL_LIST`
- 特点：我们自己定义 schema/描述/风险等级，Gateway/Desktop 都能理解

### MCP Tool（外部工具）
- 来源：Desktop 作为 MCP client 连接外部 server（Playwright、Word/Excel、第三方 SaaS…）
- 特点：数量可能爆炸，随安装/租户/环境变化；schema 质量不稳定（需要 sanitize/normalize）

### Skill（能力包/应用）
- 定位：更像“平台里的 App/插件”，而不是单个工具。
- 能力：
  - 注入提示词片段（promptFragments）
  - 约束/放开工具（toolCaps allow/deny）
  - 可选声明一个 MCP Server（skill 自带工具集）
- 代码入口：`packages/agent-core/src/skills.ts`

> 一句话：**Tool/MCP Tool 是“原子能力”，Skill 是“组合能力/产品化能力”。**

---

## 1. 终局应对齐的范式：OpenClaw（profile/policy 管道） + Codex（稳定可见 + 风险 gate）

### 为什么不是“每轮 topK 选工具”做到底
- 工具越多，越容易出现“低相关但必需工具被裁掉”的断链（典型：交付写入工具）。
- 平台化必然引入：租户隔离、角色权限、合规策略、插件市场、可审计。
- 这些都更适合 **配置化 + 可解释的策略管道**，而不是纯检索。

### 终局两条铁律
1) **能力可见稳定**：模型至少知道“有哪些能力存在”（避免幻想/绕路）。
2) **高风险可执行受控**：写入/执行/网络/外部系统调用，用审批、沙箱、策略 gate，而不是靠“藏工具”。

---

## 2. 分 Phase 路线图

> 每个 Phase 都有：目标、关键机制、落地最小集（MVP）、验收标准。

### Phase 0（现在～1 周）：止血与稳定交付（Fix the Chain）

**目标**：先把线上最痛的“断链/退化对话”打掉。

**关键机制**（你之前认可的四段里，落地优先级最高的是 deliverability + self-heal）：
- Base 保底：无论 route/检索如何，至少暴露最小自救工具（读/状态/notice）。
- Deliverability 不变量：只要用户要求产出文件/报告/diff，写入/交付工具不得被裁掉。
- Failure self-heal：出现 `TOOL_NOT_FOUND` / `INVALID_ARTIFACT_PATH` / schema 错误时，触发“扩大到 base+delivery/回退路径”的自愈，而不是继续胡扯。

**MVP**
- Gateway：在 tool selection 结果上做 **强制并集**（delivery 工具组）。
- Gateway：错误分类与自愈事件（至少把 TOOL_NOT_FOUND 当成系统 bug 处理）。

**验收**
- “打开新页面→采集→写总结 md”这类复合任务，不再出现“没有 doc.write/不能写文件”的退化。

---

### Phase 1（1～3 周）：工具发现层（Tool Discovery Layer）

**目标**：工具多了以后，不把“全量工具说明”塞进 prompt；改成“先发现、再调用”。

**关键机制**
- 引入内置工具：`tools.search(query, filters)` / `tools.describe(name)`。
  - `tools.search` 返回：候选工具名、摘要、必填参数、风险等级、所属 group。
  - 模型先用 `tools.search` 自选，再调用工具。

**MVP**
- Gateway 基于 `TOOL_LIST + MCP catalog` 做搜索（可 BM25/embedding/混合）。
- 对 MCP schema 做 sanitize/normalize（避免“工具可见但不可用”）。

**验收**
- MCP 工具从 50 增长到 500 时，prompt 体积不会线性爆炸。
- 模型能在对话中“像人一样查菜单”，而不是靠记忆瞎猜工具名。

---

### Phase 2（3～6 周）：Profiles + Policy Pipeline（平台治理核心）

**目标**：面向企业/团队/租户的可配置治理：谁能用哪些工具、哪些 MCP、哪些 Skill。

**关键机制**（对齐 OpenClaw）
- 工具 profile：`minimal / writing / web / ops / admin / full`（只是示例）
- 多来源 policy 合并管道（allow/deny）：
  - global → tenant/org → workspace/project → agent → skill → provider/channel
- 防误配保底：
  - allowlist 写错/只写 plugin 时，不允许把 core 工具剥光（等价于 OpenClaw 的 stripPluginOnlyAllowlist 思想）

**MVP**
- Gateway 增加 tool policy schema（可热更新），并在 audit 中记录“每轮 toolset 由哪些策略决定”。
- Desktop UI：配置/展示当前 profile + allow/deny + 本轮工具摘要。

**验收**
- 运营同学能用配置开关完成：禁用某类高风险 MCP、给某团队开白名单、给某 agent 开额外工具。
- 审计能回答：某次写入/外呼是谁允许的，依据哪条策略。

---

### Phase 3（6～10 周）：Workflow Router（路由到工作流，而不是路由到 tool list）

**目标**：把“复合任务”做成第一公民：采集→整理→交付，而不是一轮里混着来。

**关键机制**
- Router 输出结构化 workflow：`collect / transform / deliver`（或你定义的更多 stage）
- 每个 stage 绑定工具组（但仍受 Phase2 policy 约束）
- stage 粘性：进入 deliver 阶段后，交付工具在后续 N 轮不再被裁掉

**MVP**
- 先只把“deliverability 不变量”提升为 workflow 级约束（更自然）。

**验收**
- 长任务不会因为中间某轮裁工具导致“最后写不出来”。

---

### Phase 4（10～16 周）：Skill/应用市场化（Apps Marketplace）

**目标**：Skill 变成“平台内应用”，支持安装/版本/签名/计费/权限。

**关键机制**
- Skill manifest 版本化 + 签名（防供应链）
- Skill 自带 MCP server 的生命周期管理（启动/健康检查/权限）
- 权限请求：Skill 第一次使用高风险能力要显式授权（对齐 Codex 的 approval/gate 思想）

**验收**
- 你能把“投放分析/小红书运营/文档处理/选题”做成可装可卸的 Skill 包。

---

### Phase 5（企业级）：RBAC + 数据边界 + 合规审计（Enterprise Hardening）

**目标**：公司场景“可控可审”。

**关键机制**
- RBAC 到工具/Skill/MCP server 级别
- 数据外发策略（哪些工具会外发，外发到哪里）
- 审计报表与告警（异常工具调用、异常外发、异常写入）

---

## 3. 我们当前系统与 Phase 的映射（现状对齐）

- 工具元数据：`packages/tools` 已有（很好，继续单一来源）
- Gateway 已有 tool catalog：内置 + MCP 合并，`apps/gateway/src/agent/toolCatalog.ts`
- 目前仍有“每轮裁剪”路径：`apps/gateway/src/agent/toolRetriever.ts`
- Skill 框架已具备：promptFragments + toolCaps + 可选 MCP 声明（`packages/agent-core/src/skills.ts`）

缺口主要在：
- 工具发现层（Phase1）
- profile/policy pipeline（Phase2）
- workflow router（Phase3）

---

## 4. 推荐的落地顺序（最小闭环优先）

1) Phase0：先把 deliverability 不变量 + self-heal 做扎实（立即止血）
2) Phase1：做 tools.search/tools.describe（解决“工具太多塞不进 prompt”）
3) Phase2：上 profile/policy pipeline（平台治理）
4) Phase3：路由到 workflow/stage（复合任务稳态）
