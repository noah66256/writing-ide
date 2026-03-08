# Deep Research Skill 上架方案（Marketplace + Built-in PDF）

## 目标

把一个“深度研究”能力以 **Marketplace Skill** 的形式上架到应用市场，但不依赖外部 Gemini Deep Research CLI，而是完全复用我们当前体系：

- 当前 Agent LLM / provider 适配层
- `web.search`
- `web.fetch`
- 可用的 Browser / Playwright MCP
- `code.exec`（仅 Python fallback）
- `doc.write`

同时补一个 **built-in `pdf` skill**，用于：

- PDF 相关请求的能力提示与流程约束
- 研究任务最终导出为 `.pdf` 时的稳定交付链

## 外部方案对标结论

### 1) `sanjay3290/ai-skills` 的 `deep-research`

可参考其“多步 research loop + 最终长报告”的产品形态，但不能沿用其实现方式：

- 原方案依赖 Gemini Deep Research API / CLI
- 我们要复用自己的 Agent、自己的工具和 provider 适配层
- 因此应保留“能力范式”，重写“执行内核”

### 2) `anthropics/skills` 的 `pdf`

只能做 **能力边界对标**，不能直接搬运内容：

- 该 skill 标注为 proprietary
- 许可证明确限制复制、派生和分发
- 所以我们只能基于其任务边界，写一份自己的 `pdf` built-in skill

## 目标形态

### A. Built-in Skill：`pdf`

放在：`apps/desktop/electron/bundled-skills/pdf/`

职责：

- 用户提到 PDF / `.pdf` / 扫描件 / 合并拆分 / 导出 PDF 时自动激活
- 给 Agent 明确“何时可读、何时可导、何时必须承认限制”的规则
- 在“最终交付为 PDF”场景里，优先走：
  1. 先生成 Markdown 母版
  2. 再用 `code.exec(runtime=python)` 导出 PDF

### B. Marketplace Skill：`official.deep-research-skill`

放在：`apps/gateway/src/marketplaceCatalog.ts`

职责：

- 面向用户售卖/安装“深度研究”能力
- 安装后落地成普通 skill 包
- 执行时不调外部 Deep Research API，而是由当前 Agent 自己完成 research loop

## Deep Research 的运行时约束

### 核心原则

1. **不用外部 CLI / vendor agent**
2. **必须走证据链**：不能只基于 search snippet 回答
3. **默认先 Markdown，明确要求 PDF 再导出 PDF**
4. **Browser 只在必要时介入**：JS 渲染、分页、登录态、截图型证据

### 标准 research loop

1. 把用户请求收敛成 `research brief`
   - 目标
   - 范围
   - 时间窗
   - 交付格式
2. 若涉及时效，先调用 `time.now`
3. 先 `web.search` 发散找线索
4. 再 `web.fetch` 抓正文证据
5. 若正文抓不到、页面需交互或有复杂表格，再用 Browser MCP
6. 至少形成一轮“搜 → 读 → 收敛 → 补搜”
7. 输出结构化报告
8. 若用户明确要求 PDF，再进入 PDF 导出链

### 最终报告结构

- Executive Summary
- Key Findings
- Evidence Log（标题 / URL / 日期 / 备注）
- Risks & Unknowns
- Recommendations / Next Actions

## 为什么不做成 MCP / App-Server

这版先不做新的 server：

- 需求本质是“复用现有工具 + 现有模型”的复合 skill
- 新 server 会引入新的状态、协议与热更新成本
- 当前 Marketplace 已支持 `skill` 包安装，闭环最短

后续若 research 任务需要：

- 更长上下文缓存
- 跨轮 research session 恢复
- 统一 citation store
- 大规模来源抓取编排

再升级成 `app-server` 更合理。

## 验收标准

1. 设置页 Skills 中能看到 built-in `pdf`
2. Marketplace 中能看到 `Deep Research`
3. 安装 `Deep Research` 后会落地为 skill 包
4. 该 skill 的提示词明确要求使用：
   - `web.search`
   - `web.fetch`
   - Browser MCP（按需）
   - 当前 Agent LLM 自主循环
5. 请求“输出 PDF”时，技能提示会引导走：
   - `doc.write` 先产出 Markdown
   - `code.exec` 再导出 PDF

## 本次实现边界

### 做

- 新增 built-in `pdf` skill
- 新增 Marketplace `Deep Research` skill
- 文档化许可证约束与运行时策略

### 不做

- 不接外部 Gemini Deep Research API
- 不直接搬运 Anthropic `pdf` 原文
- 不新增新的 MCP / app-server / 后端长任务调度
- 不做“自动把 Browser MCP 绑定为强依赖”

## 验证策略

- `@ohmycrab/gateway` build 通过
- `@ohmycrab/desktop` build 通过
- 静态检查：
  - `apps/desktop/electron/bundled-skills/pdf/skill.json` 可解析
  - marketplace catalog 中存在 `official.deep-research-skill`
