# Writing IDE UI 重设计方案 v0.1

> **日期**：2026-02-21
> **状态**：Phase 0–4 已完成
> **目标**：从"编程 IDE 五栏布局"转向"对话为中心的极简 Agent 界面"

---

## 0. 设计哲学

**一句话**：打开就是对话，一切在对话里发生。

**三个原则**：
1. **对话即工作台** — 用户的主要操作入口是对话框，不是菜单/面板/侧边栏
2. **渐进式复杂度** — 首屏极简（只有对话），复杂功能按需展开（拖入文件、@技能、右侧面板）
3. **本地感** — macOS 原生毛玻璃、traffic lights、无边框窗口，不像"网页套壳"

**对标产品**：Qoder（整体布局）、Claude Desktop（Artifacts 面板）、ChatGPT（Canvas 编辑）

---

## 1. 布局架构

### 1.1 现状 vs 新设计

```
【现状：IDE 五栏】                    【新设计：对话为中心】
┌────┬──────────┬──────┐            ┌─────┬───────────────────────┐
│    │          │      │            │     │                       │
│ Ex │  Editor  │Agent │            │ Nav │    Conversation       │
│ pl │          │ Pane │            │     │                       │
│ or │──────────│      │            │     │                       │
│ er │   Dock   │      │            │     │    ┌─────────────┐    │
│    │          │      │            │     │    │  Input Bar   │    │
└────┴──────────┴──────┘            └─────┴────┴─────────────┴────┘
 200px  flex     420px               56px        flex
```

### 1.2 新布局详细定义

**左侧导航栏（56px 固定宽度）**
- 顶部：新对话按钮（+）
- 中部：对话历史列表（只显示图标+标题缩写，hover 展开 tooltip）
- 底部：用户头像/设置入口
- 可折叠为纯图标模式（默认）或展开为 240px 宽侧边栏（显示完整标题）

**主区域（flex 自适应）**
- 默认：全宽对话流（消息居中，最大宽度 720px，类似 Claude Desktop）
- 触发时：左右分屏（对话 + 工作面板），如用户要求编辑文档/查看知识库/预览 HTML

**工作面板（按需出现，右侧或浮层）**
- 文档编辑（Monaco Editor）
- 知识库浏览
- 工具执行详情
- 风格分析报告
- 触发方式：Agent 输出复杂内容时自动展开，或用户点击消息中的"在面板中打开"

### 1.3 响应式断点

| 窗口宽度 | 布局 |
|----------|------|
| < 640px  | 纯对话（导航栏隐藏，汉堡菜单） |
| 640-1024px | 图标导航 + 全宽对话 |
| 1024-1440px | 图标导航 + 对话 + 可选工作面板 |
| > 1440px | 展开导航 + 对话 + 工作面板 |

---

## 2. 技术栈选型

### 2.1 组件库：shadcn/ui

**理由**：
- 零运行时开销（代码复制到项目，完全可控）
- Radix UI 无障碍基础 + Tailwind CSS 原子化样式
- 已成为 AI 桌面应用事实标准（Claude Desktop、CodePilot 均基于 Radix+Tailwind）
- 已有成熟 [electron-shadcn](https://github.com/LuanRoger/electron-shadcn) 模板
- 内置 Command 组件（基于 cmdk）天然支持 @ 提及下拉

**迁移策略**：
- 引入 Tailwind CSS 4 + shadcn CLI
- 逐步替换 app.css 中的自定义组件为 shadcn 组件
- 保留 CSS 变量体系（shadcn 本身也基于 CSS 变量）

### 2.2 图标库：Lucide Icons（主）+ Phosphor Icons（补充）

**理由**：
- Lucide 是 shadcn/ui 默认图标库，风格统一，tree-shaking 最佳
- Phosphor 提供 6 种粗细变体（thin/light/regular/bold/fill/duotone），适合空状态插图和视觉层级
- 替换现有 `Icons.tsx` 的 18 个自定义 SVG

**图标映射**（现有 → 新）：
| 现有 | Lucide 对应 |
|------|------------|
| IconAt | AtSign |
| IconGlobe | Globe |
| IconImage | Image |
| IconMic | Mic / MicOff |
| IconSend | SendHorizontal |
| IconStop | Square |
| IconCopy | Copy |
| IconChevronDown | ChevronDown |
| IconFolderOpen | FolderOpen |
| IconFilePlus | FilePlus |

### 2.3 动画库：Motion（Framer Motion）

**用途**：
- 消息进入/退出动画（`AnimatePresence`）
- 按钮状态切换（Mic ↔ Send ↔ Stop 的 morph 动画）
- 侧边栏展开/折叠
- 工具卡片状态过渡（running → success/failed）
- 拖拽交互反馈

### 2.4 Markdown 渲染：Streamdown

**理由**：
- Vercel 出品，专为 AI 流式输出设计
- 直接替代 react-markdown，处理不完整 Markdown 块
- 内置 Shiki 语法高亮
- tree-shakeable 插件

---

## 3. 欢迎页 / 空状态

```
┌──────────────────────────────────────┐
│                                      │
│         [品牌 Logo / 吉祥物]          │
│                                      │
│         写作，从对话开始              │
│     AI 写作助手：风格仿写、全网调研、  │
│     语料分析、批量创作                │
│                                      │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│   │ 📝 写作   │ │ 🔍 调研   │ │ 📚 学风格 │  │
│   │ 给我写... │ │ 搜索热点..│ │ 分析这段..│  │
│   └──────────┘ └──────────┘ └──────────┘  │
│                                      │
│  ○ "帮我写一篇关于AI趋势的文章"       │
│  ○ "搜索今天科技圈热点"               │
│  ○ "学习这段文字的风格并仿写"          │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ 描述任务，@ 可调用技能...      │    │
│  │                              │    │
│  │ 📎 选择工作目录  🔗  [🎤/➤]  │    │
│  └──────────────────────────────┘    │
│                                      │
└──────────────────────────────────────┘
```

设计要点：
- 3 个能力卡片（写作/调研/学风格）— 对应产品核心场景
- 3 条建议 Prompt（可点击直接发送）
- 底部输入框始终可见

---

## 4. 输入栏设计

### 4.1 布局结构

```
┌──────────────────────────────────────────────┐
│ [描述任务，@ 可调用技能...]                     │
│                                              │
│ ┌────────┐ ┌──┐ ┌──┐ ┌──┐        ┌────────┐ │
│ │📁 工作目录│ │📎│ │🖼│ │@│        │ 🎤/➤/⏹ │ │
│ └────────┘ └──┘ └──┘ └──┘        └────────┘ │
└──────────────────────────────────────────────┘
```

### 4.2 左侧工具按钮

| 按钮 | 功能 | 说明 |
|------|------|------|
| 📁 工作目录 | 选择/切换工作目录 | 显示当前目录名，点击切换 |
| 📎 附件 | 拖入或选择文件 | 支持文档/图片/音频 |
| 🖼 图片 | 粘贴或选择图片 | 截图粘贴也走这里 |
| @ 提及 | 触发技能/文件/知识库选择 | 也可直接在输入框输入 @ 触发 |

### 4.3 右侧发送按钮（三态切换）

```
状态 A：输入框为空 && 非运行中  →  🎤 麦克风（语音输入）
状态 B：输入框有内容           →  ➤ 发送
状态 C：运行中 && 输入框为空   →  ⏹ 停止
状态 D：运行中 && 输入框有内容  →  ➤ 发送（中断当前运行并发送新消息）
```

过渡动画：icon scale(0.85) + opacity(0) → scale(1) + opacity(1)，150ms ease-out

### 4.4 @ 提及浮层

输入 `@` 后在光标上方弹出搜索浮层（cmdk / shadcn Command 组件）：

```
┌──────────────────────┐
│ 🔍 搜索技能/文件/库...  │
│ ─────────────────── │
│ 技能                 │
│   ✍ 写作             │
│   🔍 全网调研         │
│   📚 学风格/抽卡      │
│   📦 批量写作         │
│ ─────────────────── │
│ 知识库               │
│   📖 [已绑定库名1]    │
│   📖 [已绑定库名2]    │
│ ─────────────────── │
│ 文件                 │
│   📄 README.md       │
│   📁 docs/           │
└──────────────────────┘
```

- 键盘导航：↑↓ 移动高亮，Enter 选中，Esc 关闭
- 选中后在输入框中渲染为可删除的 chip 标签
- chip 颜色按类型区分：技能=紫色、知识库=蓝色、文件=灰色

### 4.5 拖拽区域

文件从 Finder/Explorer 拖入对话区域时：

```
拖入中：
┌──────────────────────────────────────┐
│                                      │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │                                │  │
│  │     📄 拖放文件到此处            │  │
│  │                                │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                                      │
└──────────────────────────────────────┘

拖入后（输入框上方显示附件预览条）：
┌──────────────────────────────────────┐
│ ┌──────────┐ ┌──────────┐           │
│ │📄 report.md│ │📄 data.csv│  +2 more │
│ │   12.3KB  ×│ │   4.1KB  ×│           │
│ └──────────┘ └──────────┘           │
│ [描述任务...]                         │
└──────────────────────────────────────┘
```

---

## 5. 对话消息设计

### 5.1 消息样式

**不使用传统气泡**，采用 Claude Desktop 风格的平铺式排版：

```
[用户头像]  你                              14:32
帮我用这段文字的风格写一篇关于AI趋势的文章
📄 style_sample.md

─────────────────────────────────────────

[AI 头像]  助手                             14:32

  ⟳ 正在分析风格样本...                     0:03

  ✓ kb.search — 命中 8 张卡片              [展开]
  ⟳ 正在写作...                            0:12

  ## AI 趋势：从工具到伙伴

  当我们谈论人工智能的时候，大多数人想到的
  还是那个会聊天的机器人。但 2026 年发生的
  变化，远比这深刻得多...

  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
  ✓ lint.style — 82/100                   [展开]
  [📄 在面板中打开]  [📋 复制]  [💾 保存到文件]
```

### 5.2 工具调用卡片

**紧凑模式**（默认）：

```
✓ kb.search — 命中 8 张卡片，3 篇文档          [∨]
```

**展开模式**（点击后）：

```
✓ kb.search                                    [∧]
├─ 命中 8 张卡片（hook:2, one_liner:3, thesis:2, ending:1）
├─ 来源：风格库「公众号爆款」
└─ 耗时 1.2s
```

**运行中**：

```
⟳ web.search — 正在搜索 "AI 2026 趋势"...      0:03
```

**失败**：

```
✗ web.fetch — 请求超时                     [重试] [∨]
```

### 5.3 Agent 任务进度（Todo Timeline）

```
┌─ 任务进度 ─────────────────────────────┐
│ ✓ 分析风格样本                    0:03  │
│ ✓ 检索知识库卡片                  0:02  │
│ ● 写作初稿中...                   0:15  │
│ ○ 风格审计（lint.style）                │
│ ○ 润色修改                              │
└─────────────────────────────────────────┘
```

左侧竖线连接各步骤，形成 timeline 效果。

---

## 6. 工作面板（右侧/浮层）

当 Agent 产出复杂内容时，自动或手动展开右侧面板：

### 6.1 触发条件

| 场景 | 面板内容 | 触发方式 |
|------|----------|----------|
| Agent 写完长文 | 文档预览 + 编辑器 | 自动展开 / 点击"在面板中打开" |
| 风格审计完成 | lint.style 评分 + 维度明细 | 自动展开 |
| 知识库浏览 | 卡片列表 + 搜索 | 点击知识库链接 |
| HTML/图表预览 | 实时渲染 | 自动展开 |

### 6.2 面板交互

- 宽度可拖拽调整（默认 480px，最小 360px）
- 顶部 Tab 切换不同内容（文档/审计/知识库）
- 关闭按钮回到全宽对话

---

## 7. 颜色系统

### 7.1 Light Theme（默认）

```css
--bg:         #fafafa       /* 页面背景 */
--surface:    #ffffff       /* 卡片/面板背景 */
--border:     #e8e8ec       /* 边框 */
--text:       #1a1a2e       /* 主文字 */
--text-muted: #6b7280       /* 次要文字 */
--accent:     #6366f1       /* 主题色（靛蓝偏紫，区别于编程 IDE 蓝） */
--accent-soft: #eef2ff      /* 主题色浅底 */
--success:    #22c55e       /* 成功 */
--warning:    #f59e0b       /* 警告 */
--error:      #ef4444       /* 错误 */
```

### 7.2 Dark Theme

```css
--bg:         #0f0f14       /* 不用纯黑，用深灰偏蓝 */
--surface:    #1a1a24       /* 卡片背景 */
--border:     #2a2a3a       /* 边框 */
--text:       #e4e4ed       /* 主文字（不用纯白） */
--text-muted: #8b8b9e       /* 次要文字 */
--accent:     #818cf8       /* 主题色（稍亮） */
--accent-soft: #1e1b4b      /* 主题色深底 */
```

### 7.3 品牌色选择

推荐 **靛蓝偏紫（Indigo）**：
- 区别于编程 IDE 的工程蓝（VS Code #007ACC、Cursor）
- 传达创意/写作氛围
- 与 Qoder 的绿色、Claude 的紫色、ChatGPT 的绿色形成差异化

---

## 8. macOS 原生感

### 8.1 窗口配置

```typescript
// main.ts
new BrowserWindow({
  titleBarStyle: 'hiddenInset',
  vibrancy: 'sidebar',
  visualEffectState: 'active',
  trafficLightPosition: { x: 16, y: 18 },
  transparent: true,
  minWidth: 640,
  minHeight: 480,
});
```

### 8.2 标题栏区域

```css
.titlebar {
  -webkit-app-region: drag;
  height: 52px;
  padding-left: 76px;  /* traffic lights 空间 */
}
.titlebar button, .titlebar input {
  -webkit-app-region: no-drag;
}
```

### 8.3 侧边栏毛玻璃

左侧导航栏使用 `vibrancy: 'sidebar'`，主内容区保持实色背景。

---

## 9. 设置页面

采用 Qoder 风格的 Modal 弹窗（不是独立页面）：

```
┌─ 设置 ──────────────────────────────────┐
│                                          │
│  偏好设置           │  主题              │
│  快捷键             │  ○ 浅色 ● 深色 ○ 跟随系统 │
│  ─────────          │                    │
│  技能               │  语言              │
│  MCP 服务           │  简体中文 ▾        │
│  ─────────          │                    │
│  模型               │  字体大小          │
│  知识库             │  ────●──── 14px    │
│  ─────────          │                    │
│  关于               │                    │
│                     │                    │
└─────────────────────┴────────────────────┘
```

---

## 10. 语音输入方案

### 10.1 录音采集

- Web `MediaRecorder` API 采集 PCM/WAV
- 录音 UI：输入框整体替换为录音波形 + 时长 + "取消"/"完成"按钮

### 10.2 语音识别

双模式策略：
- **在线优先**：讯飞实时语音 WebSocket API（大陆可用，中文准确率高）
- **离线兜底**：whisper.cpp via Electron main 进程（通过 IPC 调用）

### 10.3 录音交互流程

```
[🎤] → 点击 → 输入框变为录音模式
┌──────────────────────────────────────┐
│  🔴 ▁▃▅▇▅▃▁▃▅▇▅▃  0:03            │
│  [✕ 取消]              [✓ 完成发送]  │
└──────────────────────────────────────┘
完成后 → 文字填入输入框（用户可编辑后再发送）
```

---

## 11. 迁移策略

### Phase 0：基础设施（不动现有功能）

1. 引入 Tailwind CSS 4（与现有 app.css 共存）
2. 引入 shadcn CLI + 初始化组件目录
3. 引入 Lucide Icons + Motion
4. 配置 macOS 原生窗口（hiddenInset + vibrancy）

### Phase 1：新建对话壳（并行开发）

1. 新建 `ConversationView` 组件（新布局：导航栏 + 对话区）
2. 输入栏重构（shadcn Input + @ 提及 + 三态发送按钮）
3. 消息列表重构（平铺式排版 + 流式渲染）
4. 欢迎页
5. 通过 feature flag 切换新旧 UI

### Phase 2：功能迁移

1. 工具卡片迁移（紧凑模式 + 展开模式）
2. 工作面板（右侧 Monaco Editor + 知识库浏览）
3. 设置 Modal
4. 文件拖拽交互
5. 深色模式

### Phase 3：新功能

1. @ 提及浮层（技能/知识库/文件）
2. 语音输入
3. 附件预览卡片
4. Todo Timeline 可视化

### Phase 4：清理

1. 移除旧 IDE 布局代码
2. 移除 app.css 中已被 Tailwind 替代的样式
3. 移除 Icons.tsx（全部替换为 Lucide）

---

## 12. 关键依赖清单

| 依赖 | 用途 | 安装命令 |
|------|------|----------|
| tailwindcss@4 | 原子化 CSS | `npm i -D tailwindcss @tailwindcss/vite` |
| shadcn | 组件库 CLI | `npx shadcn@latest init` |
| lucide-react | 图标 | `npm i lucide-react` |
| @phosphor-icons/react | 补充图标 | `npm i @phosphor-icons/react` |
| motion | 动画 | `npm i motion` |
| streamdown | AI 流式 Markdown | `npm i streamdown` |
| cmdk | 命令面板 | shadcn Command 组件内含 |
| react-dropzone | 文件拖放 | `npm i react-dropzone` |

---

## 13. 参考产品索引

| 产品 | 参考维度 |
|------|----------|
| **Qoder** | 整体布局、欢迎页、输入栏、设置页 |
| **Claude Desktop** | 消息排版风格、Artifacts 面板、@ 文件引用 |
| **ChatGPT Canvas** | 右侧编辑面板、highlight-to-edit |
| **Kimi** | 去气泡化设计、工作台面板 |
| **Cursor** | @ 提及浮层、工具调用 timeline |
| **微信** | 语音/发送按钮切换 |

---

## 14. 实际完成记录（2026-02-21）

### Phase 0 ✅
- Tailwind CSS 4 + `@tailwindcss/vite` plugin
- shadcn/ui 手动集成（`clsx` + `tailwind-merge` + `class-variance-authority`）
- `src/lib/utils.ts`（`cn()` utility）
- `src/styles/globals.css`：完整设计系统（颜色/字体/圆角/阴影/动画 + dark mode）
- Lucide Icons + Motion
- macOS 原生窗口（`hiddenInset` + `vibrancy` + `trafficLightPosition`）
- path alias `@/` → `src/`

### Phase 1 ✅
- `src/ui/layouts/ConversationLayout.tsx`：主布局（56px Nav + flex 对话区 + titlebar drag）
- `src/ui/components/NavSidebar.tsx`：可展开导航栏（新对话/历史对话列表/删除/设置）
- `src/ui/components/ChatArea.tsx`：对话区（消息列表 + 欢迎页切换 + 贴底排列）
- `src/ui/components/InputBar.tsx`：输入栏（三态按钮 Mic/Send/Stop + @ 触发 + 拖拽 + 附件）
- `src/ui/components/WelcomePage.tsx`：欢迎页（品牌文字 + 3 能力卡片 + 3 建议 prompt）

### Phase 2 ✅
- `startGatewayRun` 集成到 ChatArea（含 auth/model 检查）
- 对话自动保存草稿到 `conversationStore`
- NavSidebar 对话归档/加载/删除/高亮

### Phase 3 ✅
- `src/ui/components/MentionPopover.tsx`：@ 浮层（技能 4 项 + KB 动态列表 + 键盘导航）
- 文件拖拽到输入栏（dragover 高亮 + 文件预览 chips）
- mention chip 标签（按类型着色：技能=紫、KB=蓝、文件=灰）
- `react-markdown` + `remark-gfm` 渲染助手消息
- `.markdown-body` 完整样式（标题/列表/代码块/引用/表格/链接）

### Phase 4 ✅
- `App.tsx` 清理：移除旧 IDE 五栏布局代码、feature flag
- 保留 Electron 集成 hooks（项目加载/菜单/更新/文件监听）

### 文件清单

| 路径 | 说明 |
|------|------|
| `src/styles/globals.css` | 设计系统 + markdown 样式 |
| `src/lib/utils.ts` | `cn()` utility |
| `src/ui/layouts/ConversationLayout.tsx` | 主布局 |
| `src/ui/components/NavSidebar.tsx` | 侧栏导航 |
| `src/ui/components/ChatArea.tsx` | 对话区（消息 + agent run） |
| `src/ui/components/InputBar.tsx` | 输入栏（@ + 拖拽 + 三态按钮） |
| `src/ui/components/WelcomePage.tsx` | 欢迎页 |
| `src/ui/components/MentionPopover.tsx` | @ 浮层 |
| `src/App.tsx` | 入口（清理后） |

### 待后续迭代

- 语音输入（Mic 按钮目前无实际功能）
- 右侧工作面板（文档预览/编辑、lint 评分面板）
- 设置 Modal
- Todo Timeline 可视化
- 旧 `app.css` 完全移除（当前仍共存）
- 旧组件清理（AgentPane 等仍在代码库中，未被入口引用）
