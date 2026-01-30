## lint.style patch 模式（v0.1）

目标：把“风格回炉”从 **全文重写**升级为 **局部 edits（类似 VSCode/Cursor 的 patch）**，让改动可预览、可 Keep/Undo、尽量不破坏已写好的段落。

### 现状（v0.0）
- `lint.style` 返回 `issues + rewritePrompt`
- 回炉主要依赖模型“再生成一遍正文”（容易越改越飘、引入无关段落、破坏好段落）

### 方案（v0.1）

#### 1) lint.style 输出新增 `edits`（TextEdit[]）
- 由 Gateway 的 `/api/kb/dev/lint_style` 请求上游模型**尽量**给出 `edits`
- `edits` 为可选字段，失败/缺失时仍可退回旧的 `rewritePrompt` 回炉

TextEdit 结构（与 Monaco/VSCode 类似）：

```json
{
  "startLineNumber": 12,
  "startColumn": 1,
  "endLineNumber": 14,
  "endColumn": 9999,
  "text": "替换后的文本\n"
}
```

约束：
- 尽量局部（按自然段/几行），避免单条 edit 覆盖全文
- edits 不重叠，最多 12 条
- column 允许用 1..9999（客户端会裁剪到行尾）

#### 2) Desktop 侧：把 lint.style 的 edits 显示成统一 diff，并支持 Keep/Undo
- 当收到 `lint.style` tool_result 且 `output.edits` 存在：
  - Desktop 计算 `after = applyTextEdits(before, edits)`
  - Desktop 生成 unified diff（红删绿增），注入到 `output.preview.diffUnified`
  - 给该 ToolBlock 动态挂载 `apply()`：Keep 时应用修改（写入文件），并用 snapshot 支持 Undo 回滚
- 同一份 ToolBlock 既在右侧 Steps 中显示，也在 Dock 的 **Problems** Tab 中显示（同组件，不做两套 UI）

### 验收 checklist
- 在 Plan/Agent 模式对某个已打开的文档执行 `lint.style(path=当前文件)`（或由 Agent 自动触发）
- ToolBlock 展示：
  - diff：旧内容红色、 新内容绿色
  - Keep：应用 edits 到文件
  - Undo：回滚到应用前
- DockPanel → Problems：
  - 出现相同的 `lint.style` ToolBlock（与右侧一致）

### 回滚方案
- 如果 patch 模式不稳定：
  - `lint.style` 仍保留 `rewritePrompt`
  - 客户端若 `edits` 缺失/非法则不生成 preview/apply，退回“仅展示 lint 结果”的行为


