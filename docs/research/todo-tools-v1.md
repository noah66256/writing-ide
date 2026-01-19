## Todo 工具大搜（2026）与我们 Run Todo 的改造方向（研究 v1）

### 结论先行（对我们最重要的 3 点）
- **我们现在的 Todo 是“Agent Run 的进度锚点”**，不是通用任务管理软件；要学主流，但别做成 Asana/Notion 那套“重协作平台”。
- **主流工具的差异，不在“字段有多全”，而在“录入摩擦低 + 视图聚焦 + 快捷操作 + 批量/自动化”**。
- 对我们而言，v0.2 的关键是两件事：  
  - **LLM 侧更好用**：不要反复 `setTodoList` 覆盖；要支持 **bulk/upsert**，并让 “更新某条 todo” 不再依赖模型死记 id。  
  - **用户侧更好用**：Dock 面板里的 Todo 不能只是 markdown 展示，应可 **点击改状态/筛选/快速新增**（写作场景足够）。

---

### 0) 我们现状（仓内实现扫描）
当前 Run Todo 链路大概是：
- **数据结构**：`TodoItem { id, text, status, note? }`（status：todo/in_progress/done/blocked/skipped）
- **工具**：`run.setTodoList`（整表替换）+ `run.updateTodo`（单条 patch）
- **上下文注入**：`RUN_TODO(JSON)` 直接把完整数组注入 Context Pack
- **UI**：Dock Panel 的 Runs 页把 todo 渲染成 markdown checkbox（只区分 done vs 非 done，且不可交互）

主要问题（“不好用”的根因）：
- **交互弱**：Todo 在 UI 里只是文本，不能点、不能改状态、不能筛选；阻塞/进行中也不可见。
- **工具契约不够 LLM-friendly**：只有“整表 set / 单条 update”两种操作；模型经常：
  - 重复 set 覆盖掉进度
  - update 忘传 id/patch（导致 Gateway 需要做参数补救）
- **上下文太“肥”**：RUN_TODO 直接注入全量，任务一多会挤占上下文；而模型真正需要的通常是 “未完成 + 当前阻塞原因”。

---

### 1) 主流 Todo 工具：我们该学什么（按类别）

#### 1.1 个人 Todo（Todoist / TickTick / Things / OmniFocus / Microsoft To Do）
共性做得好的点：
- **快速录入（capture）**：Quick Add、快捷键、自然语言解析日期/周期（降低摩擦）
- **聚焦视图**：Today / Upcoming / Overdue / Inbox（让用户“开始做”，而不是“看着很焦虑”）
- **状态与优先级可视化**：进行中/阻塞/完成有明显呈现；一眼看懂下一步
- **批量/自动化**：批量改状态、批量移动；重复任务/模板减少重复劳动

我们要避免的误区：
- 不做复杂的提醒/日历/习惯追踪（那会把产品拖进“生产力工具”赛道，且与写作产出关联弱）

#### 1.2 团队任务（Linear / Jira / Asana / Trello）
可借鉴但要克制：
- **状态机 + 工作流**（Linear/Jira）：状态流清晰、事件日志可追溯
- **看板视图**（Trello）：拖拽迁移状态直觉强

不建议在写作 IDE 里照搬：
- 指派、依赖、里程碑、复杂权限——这些会把我们推向协作平台，偏离定位

#### 1.3 笔记/知识库型 Todo（Notion / Obsidian Tasks）
对我们写作场景更贴近的点：
- **任务与文档强绑定**：在 Markdown 里就地写任务、就地完成；或任务能链接到文档位置
- **查询/过滤视图**：在大量任务里快速找 “未完成/阻塞/今天要做”

我们适合做的版本：
- Todo 仍然以 **Run 级**为核心（不做全局 GTD），但允许：
  - 一键复制为 Markdown checklist（便于写进文档/主文档）
  - 后续扩展为“项目级 checklist”（v0.3+）

---

### 2) 对我们最合适的落地（v0.2 推荐）

#### 2.1 数据结构（保持短小，防上下文膨胀）
- 继续使用 `id/text/status/note`，并对 `text/note` 做长度限制
- Context Pack 注入：**默认只注入未完成 + 少量最近完成**（避免 token 浪费）

#### 2.2 工具契约（LLM 友好）
新增（保留旧工具兼容）：
- `run.todo.upsertMany`：批量 upsert（新增/更新都走一个入口，减少反复 set 覆盖）
- `run.todo.update`：扁平参数（id 可选；支持按文本匹配兜底），让模型不再频繁漏 patch
- `run.todo.remove`/`run.todo.clear`：让模型能“清理无用 todo”，减少长期膨胀

#### 2.3 UI（写作 IDE 版本的 Todo）
Dock Panel 的 Runs 页 Todo 区改为可交互：
- 状态一眼可见（todo/in_progress/blocked/done/skipped）
- 支持 **点击切换状态**（至少：done ↔ todo、以及一键置 in_progress）
- 支持 **筛选**（未完成/阻塞/已完成）
- 支持 **快速新增**（用户可手动补 todo，不完全依赖模型）

---

### 3) 风险与边界
- **不做**：提醒/日历/习惯/跨 Run 全局 GTD（会偏离写作 IDE）
- **不做**：团队协作的指派/权限/评论（B 端另有审计与配置，Todo 仍服务写作闭环）
- **必须做**：上下文体积控制（RUN_TODO 不可无限增长）

---

### 4) 后续（v0.3+）
- Todo 与文档锚点绑定（点击 todo 跳到对应段落/文件）
- 项目级 checklist（跨 Run 复用），并与 KB/引用工作流联动



