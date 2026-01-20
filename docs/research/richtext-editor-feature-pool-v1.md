## 富文本/Markdown 编辑器高口碑功能池调研 v1（面向写作 IDE）

> 目标：把“全网 + GitHub 高星、口碑稳定”的富文本/Markdown 编辑器能力，整理成**可复用的功能池（Feature Pool）**，并给出“适配本项目（写作 IDE）”的取舍与落地建议。
>
> 边界：本项目定位是「写作 IDE（桌面端）」——一切功能服务于写作产出与编辑体验，不做通用协作平台。

---

### 0) 结论先行（我们应该学什么）

- **优先学的不是 UI 花活，而是“写作操作系统”能力**：结构（Outline/章节重排）、历史（版本/快照/撤销）、导出（交付）、资产（图片/附件）、效率（快捷键/命令面板/模板）。
- **富文本项目一致好评的核心**，通常落在：
  - **粘贴与输入体验**（尤其从 Word/网页粘贴、IME、撤销正确性）
  - **结构化块/节点模型**（表格、列表、图片、引用等的可编辑性）
  - **插件/扩展架构**（可插拔，避免核心变臃肿）
  - **可访问性与稳定性**（键盘可达、可预测）

---

### 1) 对标样本（GitHub 高星/成熟生态）

> 说明：星数为 2026-01-19 在 GitHub 页面可见的数量级（取整展示），用于“热度/生态成熟度”的粗粒度参考。

| 项目 | GitHub | 星标（约） | 一句话定位（页面标题/描述） |
|---|---|---:|---|
| Quill | `https://github.com/slab/quill` | 46.8k | “modern WYSIWYG editor… compatibility and extensibility” |
| TipTap | `https://github.com/ueberdosis/tiptap` | 34.6k | “headless rich text editor framework…”（强扩展生态） |
| Editor.js | `https://github.com/codex-team/editor.js` | 31.4k | “block-style editor with clean JSON output” |
| Slate | `https://github.com/ianstormtaylor/slate` | 31.4k | “customizable framework for building rich text editors” |
| Lexical | `https://github.com/facebook/lexical` | 22.8k | “extensible text editor framework… reliability, accessibility and performance” |
| TOAST UI Editor | `https://github.com/nhn/tui.editor` | 17.9k | “Markdown WYSIWYG Editor. GFM Standard + Chart & UML…” |
| Outline rich-markdown-editor | `https://github.com/outline/rich-markdown-editor` | 2.9k | “React + ProseMirror… markdown editor that powers Outline” |

---

### 2) 一致好评功能池（按模块归类）

#### 2.1 输入体验（最容易“做不好就劝退”）

- **粘贴体验（Clipboard/Paste）**
  - **从网页/Word 粘贴**：尽量保留结构（标题/列表/链接/表格），同时避免脏样式污染。
  - **粘贴图片**：自动落盘为资产（或生成附件），并插入引用（Markdown 链接或占位符）。
- **自动格式化（Autoformat）**
  - 输入 `# ` 自动变标题、`- ` 变列表、`> ` 变引用、````` 变代码块等（可开关）。
- **撤销/重做的正确性（Undo/Redo correctness）**
  - “一次用户意图”尽量对应“一次 undo step”（比如粘贴是一整个 step）。
- **IME/多语言输入**
  - 中文/日文输入法组合键、候选上屏等过程中不抖动、不乱跳光标。

#### 2.2 结构化内容（写作最常用的“块”）

- **列表（含嵌套）**：Tab/Shift+Tab 缩进、Enter 拆行、Backspace 合并，行为要可预测。
- **表格**：行列增删、选区、粘贴进表格、单元格内换行等。
- **图片/附件**：插入、预览、替换、alt 文本、相对路径管理。
- **引用/Callout**：对写作（教程/说明/小说旁白）常见，交互要轻。
- **代码块**：语言选择、复制按钮、行号（可选）、导出保真。

#### 2.3 结构导航与写作工程化

- **Outline（标题树）**：点击跳转、折叠、显示当前位置。
- **章节操作**：上移/下移/升降级/拆分合并（与 Undo 强绑定）。
- **全局搜索/替换**：在长文/多文件写作里是刚需（项目级更重要）。

#### 2.4 扩展机制（避免“把一切塞进核心”）

- **插件/扩展点**：表格/图表/公式/导出器等最好是可插拔的。
- **命令系统**：把“插入标题/列表/表格/图片/引用”统一成命令（便于快捷键、命令面板、自动格式化复用）。

#### 2.5 输出与交付（写作 IDE 的终点）

- **导出 HTML/PDF/DOCX/EPUB**：先保证 HTML 干净、可控，再逐步扩展。
- **模板/主题（导出样式）**：用户希望“同一内容，多种排版模板”。

#### 2.6 质量与可靠性（口碑的底座）

- **性能**：大文档（多万行）滚动/输入不掉帧；增量解析/节流。
- **可访问性**：键盘可达、ARIA/读屏支持（Lexical 特别强调）。
- **一致性**：同一操作在不同位置行为一致（尤其列表/表格/撤销）。

---

### 3) 适配本项目的取舍（写作 IDE 视角）

#### 3.1 我们明确不做/暂不做（避免跑偏）

- **不把编辑器做成“模式大杂烩”**：过多开关/视图会让界面变乱（已移除 Typewriter/弱渲染/预览分屏）。
- **不把“多人实时协作”作为 MVP**：成本高、容易牵引产品跑向协作平台（未来可选）。

#### 3.2 我们应该优先做的“高价值、低分心”能力（建议 vNext）

- **命令面板（Command Palette）+ 命令系统**：把常用编辑动作统一收口（也为快捷键/按钮复用）。
- **模板/片段（Templates/Snippets）**：写作场景复用率极高（文章模板、章节模板、FAQ 模板等）。
- **图片粘贴/拖拽 → 资产落盘 + 引用插入**：属于“写作 IDE 必备的工程化能力”。
- **表格助手（轻量）**：哪怕不做完整 GUI 表格编辑器，也至少提供“插入表格/对齐/格式化/预览”工具。
- **项目级搜索**：优先服务“写作项目”（多文件）而不是只做单文件。

---

### 4) 验收清单（用于后续做功能时复用）

- **粘贴**：从网页粘贴一段含标题/列表/链接的内容，结构合理、不引入脏样式。
- **图片**：直接粘贴截图 → 自动写入项目资产目录 → Markdown 正确引用 → 导出 HTML 能显示。
- **撤销**：粘贴/自动格式化/章节移动都能一步撤销且不破坏结构。
- **结构**：Outline 点击跳转准确；章节上移/下移/升降级后大纲同步。
- **导出**：导出 HTML 的结构与标题层级正确；图片路径正确；样式可控。


