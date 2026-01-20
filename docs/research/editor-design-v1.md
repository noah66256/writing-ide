## Desktop 编辑器设计调研 v1（写作 IDE：中间编辑区不止 Markdown 显示器）

> 面向本项目：`apps/desktop` 桌面端写作 IDE（左文件树 / 中编辑器 / 右 Agent / 中下 Dock Panel）。
>
> 目标：给“中间编辑器”一个可复用的**范式**与**路线图**，从“仅渲染 Markdown”升级为真正的“写作产出与编辑体验”核心。

---

### 0) 背景与问题

当前“中间编辑器”如果只是 Markdown 渲染器/阅读器，只能覆盖“看稿”。写作 IDE 的核心生产力来自：
- **结构化写作**：章节/大纲/重排/重构（长文与项目写作的关键）
- **所见即所得的反馈**：预览/排版/导出（写作结果可控）
- **写作过程的操作系统**：导航/搜索/版本/审阅/快捷键（降低写作摩擦）

---

### 1) 对标对象（相近但不完全对标）

> 我们不追求 1:1 复刻任何单品，而是抽象它们“编辑器范式”与“能力模块”。

- **Source-first（VS Code Markdown）**：源文本编辑稳定、插件丰富、工程化能力强（预览可选/不常驻）
- **In-place Preview / Live Preview（Obsidian）**：在同一编辑面里“边写边像成稿”，兼顾 Markdown 可迁移性（实现难度高）
- **WYSIWYG Markdown（Typora / MarkText）**：语法“消融”，写作最沉浸，但 round-trip 风险高
- **结构化写作工作台（Scrivener）**：章节/卡片/编译导出/资料库，长篇项目写作很强
- **学术写作（Zettlr）**：引用/导出（Pandoc）、项目与文献管理对我们“长文/论文/报告”很有参考价值

参考链接（官方/开源）：
- Obsidian Live Preview：`https://help.obsidian.md/Editing+and+formatting/Live+Preview`
- MarkText：`https://github.com/marktext/marktext`
- Muya（MarkText editor engine）：`https://github.com/marktext/muya`
- Zettlr：`https://github.com/Zettlr/Zettlr`
- Scrivener：`https://www.literatureandlatte.com/scrivener/overview`
- CodeMirror 6（Markdown）：`https://codemirror.net/`（`@codemirror/lang-markdown`）
- 资料集合（便于扩展对标）：`https://github.com/mundimark/awesome-markdown-editors`

---

### 2) 编辑器范式（四选一/组合）与取舍

#### 范式 A：Source-first（推荐 v1 的底座）
- **定义**：中间是 Markdown 源码编辑器（Markdown 为唯一真源）；预览**不常驻**，以“导出/单独预览/可选视图”方式存在。
- **优点**：实现成本低、稳定性高；搜索/替换/多光标/快捷键天然强；Markdown 落盘最一致。
- **缺点**：写作流容易被语法符号打断；“写”和“成稿观感”割裂。
- **对我们**：既有 Monaco 选型下，这是 v1 最稳最小闭环；并且符合“界面不要太多 pane/模式”的共识。

#### 范式 B：In-place Preview / Live Preview（备选，不作为近期目标）
- **定义**：同一编辑面中，Markdown 标记“半隐藏/半渲染”，视觉更接近成稿，但仍落盘 Markdown。
- **优点**：写作体验好；可在不放弃 Markdown 的前提下提升沉浸感。
- **难点**：光标/选区映射；表格/列表/引用等边界；大文档性能；与结构化操作（移动章节）协调。
- **对我们**：已确认不做“弱渲染/淡化标记”等视觉模式；若未来要追求“所写即所见”，应优先评估**更系统的编辑内核/方案**，而不是在 Monaco 上堆装饰效果。

#### 范式 C：WYSIWYG Markdown（谨慎：可选模式）
- **定义**：像 Typora 一样“看起来就是成稿”，用户几乎感知不到 Markdown 语法。
- **优点**：最沉浸；非技术写作者上手最舒服。
- **风险**：Markdown round-trip 容易出坑（空行、列表、表格、引用、脚注、混合块）；扩展语法一致性难保。
- **对我们**：不建议 v1 押宝；可作为 v3 的可选模式/高级模式。

#### 范式 D：结构化写作工作台（贯穿：从 v1 就做）
- **定义**：编辑器不仅编辑“一个文件”，更编辑“一个写作项目”（章节树/卡片/编译导出/资料库）。
- **价值**：这是“写作 IDE”最核心差异化；比 WYSIWYG 更优先。
- **对我们**：v1 先做轻量版本（大纲树/章节重排/拆分合并）；逐步 Scrivener 化（卡片视图/编译导出）。

---

### 3) 能力矩阵（写作 IDE 中间编辑器应具备什么）

#### 3.1 v1 必做（从“显示器”升级为“写作 IDE”）
- **编辑**：Markdown 源码编辑（Monaco），支持快捷键/多光标/搜索替换/Tab 补全（对齐产品定位）
- **大纲**：基于标题层级生成 Outline（Dock Panel 或右侧抽屉），支持点击跳转、折叠
- **结构化重构（关键）**：
  - 章节折叠/展开（按 heading range）
  - 章节移动（上移/下移）、提升/降级标题层级
  - 抽取章节为新文件、合并章节（后续与文件树/undo 对齐）
- **可撤销**：
  - 文本编辑：Editor undo/redo
  - 结构操作：必须提供 Undo（对齐“写作体验”，避免误操作毁稿）
- **写作体验**：尽量少开关、少模式；用“合理默认排版 + 清晰状态栏 + 快捷键/命令”提升效率

> 已确认（本项目决策）：**不做** Typewriter Mode（打字模式）与“弱渲染/淡化标记”这类视觉模式；也**不做**预览分屏（避免界面变乱）。

#### 3.2 v2 增强（把“写作流”做顺）
- **写作效率**：命令面板（Command Palette）+ 统一命令系统（插入标题/列表/引用/代码块/图片等）
- **模板/片段**：文章模板、章节模板、常用片段（Snippets）
- **资产与粘贴**：粘贴/拖拽图片 → 资产落盘 → 自动插入引用（写作工程化的刚需）
- **交付链路（运营/营销写作高频）**：复制为目标平台富文本（小红书/公众号/知乎/飞书预设，带 `text/plain` 兜底）；且**不改变文件真源/不影响 Agent**
- **结构与排版工具**：表格助手（先轻量）、代码块增强、导出样式模板（CSS）
- **项目级能力**：项目内搜索（优先多文件/长文写作），跨文档跳转

> 参考：富文本/Markdown 编辑器“高口碑功能池”见 `docs/research/richtext-editor-feature-pool-v1.md`。

#### 3.3 v3 差异化（出版与协作）
- **出版级导出**：PDF/DOCX/EPUB 模板、分页预览、封面/目录/脚注/引用
- **审阅模式**：评论/批注/建议采纳（track changes）、版本对比
- **AI/Agent 融合**：在编辑器内“以 diff 形式呈现建议 → 一键应用/撤销”，避免 AI 直接重写污染正文

---

### 4) 我们项目的落地建议（v1 实现拆解）

> 目标：不引入重型“富文本/块编辑器”框架，优先把“结构化写作 + 导航 + History/导出 + Undo”做闭环。

#### 4.1 组件划分（建议）
- **`EditorSurface`（Monaco）**：负责源文本编辑（唯一真源）
- **`OutlinePanel`**：从源文本解析 heading，生成树；点击即定位编辑器
- **`DocOps`（结构操作）**：对源文本做可撤销的结构变换（move/promote/demote/extract/merge）
- **`History`**：
  - 普通输入：走 Monaco undo
  - 结构操作：走我们自己的可撤销命令栈（command pattern），并可回灌到 Monaco（或独立）
- **`Exporter`**：导出 HTML/PDF/DOCX（先保证 HTML 干净、可控）
- **`AssetManager`**：图片/附件的落盘与引用（粘贴/拖拽 → 资产 → 插入引用）
- **`Commands`**：统一命令系统（快捷键/命令面板/按钮复用）

#### 4.2 数据模型（建议）
- **DocumentModel**：`text` + `headings[]`（level/title/lineStart/lineEnd/hash）
- **Operation**：`apply(text)->text` + `invert(textBefore)->inverseOp`（满足 Undo）
- **Index**：全文索引 + headings 索引（支持项目搜索/跳转）

#### 4.3 验收清单（v1）
- 打开一个包含多级标题的 Markdown：大纲能正确折叠/跳转
- 章节上移/下移、升/降级标题后：
  - 文本结构正确
  - 大纲同步更新
  - 可以 Undo 恢复到操作前
- 快照/历史：能创建快照、查看 diff、从快照恢复
- 导出：导出 HTML 后结构与标题层级正确（图片引用路径正确）
- 大文档（>50k 行）编辑不卡死（允许预览降级：节流/延迟渲染）

#### 4.4 回滚方案（v1）
- 大纲/结构操作/历史都以 feature flag 控制（可快速关闭）
- 一旦出现“结构操作误伤正文”的风险：立即只保留只读大纲与预览，禁用结构操作入口

---

### 5) 关键风险与坑位（提前规避）

- **粘贴与输入法**：富文本/Markdown 的最大“体验坑位”之一（尤其从网页/Word 粘贴、中文输入法），需要专门的回归样例集
- **结构操作的正确性**：移动章节/升降级标题需要处理代码块/引用块内的 `#` 等干扰，必须用解析器而非正则堆 if
- **性能**：预览渲染要节流；大纲解析要增量；避免每次 keystroke 全文 parse
- **一致性**：源文本是唯一真源，预览与大纲永远从源文本派生，不反向写入


