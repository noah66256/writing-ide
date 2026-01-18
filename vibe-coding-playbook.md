## Vibe Coding Playbook（面向“非专业但有逻辑”的开发者）v0.1

> 目标：把“我大概想要……”的模糊需求，稳定收敛成可执行计划、可审阅 diff、可验证结果。

### 0) 2 分钟复用（丢进任意新工程就能用）
- 复制本仓库的模板文件：[`AGENTS.template.md`](AGENTS.template.md)
- 放到你新工程根目录并重命名为 `AGENTS.md`，先把“填空区”补齐（项目目标/验收/约束/常用命令）
- 如果你用 Cursor：可以只保留 `AGENTS.md`（或让 `.cursorrules` 与 `AGENTS.md` 内容一致）
- 建议同时建 2 个落盘文件：`plan.md`（导航索引）+ `debug.md`（常见坑）

### 1) 什么是 vibe coding（以及它的坑）
- 定义：在编程中，vibe coding 是一种 AI 辅助软件开发方式，开发者通过对话描述任务，由大模型产出/修改代码（参考 [Wikipedia: Vibe coding](https://en.wikipedia.org/wiki/Vibe_coding)）。
- 常见坑：
  - 需求没说清 → AI 只能“猜”，越改越偏
  - 没验收标准 → 做完也不知道对不对
  - 上下文不稳定（它看不到/你以为它看到了）→ 反复返工

### 2) 方法论工具箱（按“把模糊变清晰”的顺序）
#### 2.1 先把“上下文”固定下来：记忆文件/规则文件
- 用 `AGENTS.md`（或 Cursor 的规则文件）把“项目结构/常用命令/约束/坑位”钉死，避免每轮重讲（参考 [AGENTS.md](https://agents.md/)；以及 [Awesome AI Coding Techniques](https://github.com/inmve/awesome-ai-coding-techniques) 的 “Set Up Memory Files”）。
- 在本仓库的对应物：`plan.md`（导航索引）、`.cursorrules`（工程 SOP）、`debug.md`（常见坑沉淀）。

#### 2.2 Plan-first：先要计划/风险/验证点，再允许改代码
- 让 AI 先列：步骤、会改哪些文件、风险、快速验证点；并明确“我确认前不要实现”（参考 GitHub Docs 的提示设计原则：[GitHub Copilot 对话助手的提示设计](https://docs.github.com/zh/copilot/concepts/prompting/prompt-engineering)）。

#### 2.3 Spec-driven development：用 Markdown 规格驱动（而不是直接写代码）
- 把规格写进 `*.md`，AI 负责把规格“编译”为代码；跑起来不对就改规格再生成（参考 GitHub Blog：[Spec-driven development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-using-markdown-as-a-programming-language-when-building-with-ai/)）。

#### 2.4 Example-first：示例/测试就是需求
- 给 2–3 个正例 + 1–2 个反例；必要时“先写单测再实现”，示例天然去歧义（参考 GitHub Docs 同上）。

#### 2.5 拆任务（小步可验证切片）
- 把“大而糊”拆成“小而可验收”的步骤逐个推进（参考 GitHub Docs 同上：将复杂任务分解成更简单的任务）。

#### 2.6 避免歧义：明确 target/action/permission
- 不要问“这个/现在呢”，要明确：
  - **target**：哪个文件/哪个选区/哪个模块
  - **action**：解释/修复/实现/改写/对比
  - **permission**：是否允许改文件/是否允许跑命令/是否允许联网

#### 2.7 Timebox：先定愿意花多久，而不是估算要多久
- Shape Up 的 Appetite：先定“愿意花多少时间”，再让范围可伸缩（参考 [Shape Up](https://basecamp.com/shapeup) glossary：Appetite）。

#### 2.8 选“无聊但稳定”的方案 + 多方案比较
- 优先成熟稳定库/范式，AI 更容易生成可靠代码；让 AI 同时给 2–3 个方案和取舍再拍板（参考 [Awesome AI Coding Techniques](https://github.com/inmve/awesome-ai-coding-techniques)）。

### 3) 可复制模板
#### 3.1 需求卡（一次性发给 Agent）

```md
【一句话目标】…
【用户/场景】…
【成功标准（验收）】…
【约束】（环境/版本/不能动什么/必须兼容什么）…
【不做】（明确排除项）…
【现状/上下文】（相关文件/截图/日志/链接）…
【风险/回滚】（怎么回退/可接受的临时方案）…
```

#### 3.2 Bug 报告卡

```md
【复现步骤】…
【预期】…
【实际】…
【日志/截图】…
【影响范围】…
```

#### 3.3 “现在呢/这个呢”的安全补全

```md
我刚刚做了：<变更>
我现在想让你判断：<问题>
你可以使用的上下文：<当前文件/选区/日志>
如果你看不到，请告诉我需要我提供什么（比如 @文件 / 贴日志 / 允许读取）。
```

### 4) References（可追溯来源）
- [Wikipedia: Vibe coding](https://en.wikipedia.org/wiki/Vibe_coding)
- [GitHub Docs: GitHub Copilot 对话助手的提示设计](https://docs.github.com/zh/copilot/concepts/prompting/prompt-engineering)
- [GitHub Blog: Spec-driven development](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-using-markdown-as-a-programming-language-when-building-with-ai/)
- [Awesome AI Coding Techniques（社区实践清单）](https://github.com/inmve/awesome-ai-coding-techniques)
- [AGENTS.md（agent 记忆文件标准）](https://agents.md/)
- [Shape Up（Appetite 等概念）](https://basecamp.com/shapeup)

