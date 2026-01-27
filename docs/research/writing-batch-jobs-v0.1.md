# 批处理写作任务（Writing Batch Jobs）v0.1（research）

## 背景：为什么“50 节课 → 250 篇文稿”现有 Run 扛不住
- **交互式单 Run**适合“单篇/少量”任务：上下文可控、门禁可解释、用户可 Keep/Undo。
- **极端批处理**（例如 50×5=250 篇）失败模式不同：会受到回合预算、阶段门禁、工具误用、流式中断、人工确认成本的共同约束。

因此需要一个范式升级：从“让 LLM 自己调度工具”变为“系统调度（队列/状态机/断点）+ LLM 只负责生成/改写”。

## v0.1 目标与非目标
### 目标
- **文件夹输入**：用户选择（或拖入）一个包含多篇课程文件的文件夹（`.md/.mdx/.txt`）。
- **批量拆分**：每节课生成 N 篇短视频稿（默认 5）。
- **风格闭环**：每篇按风格库输出，并通过 `lint.copy`、`lint.style`（失败可回炉）。
- **落盘输出**：按命名规则写入一个新的输出目录（避免污染原稿）。
- **可控执行**：支持 `pause/resume/cancel`，长任务不“像卡死”。
- **可恢复**：生成进度与失败清单落盘（jsonl），可在中断后续跑。

### 非目标（v0.1 不做）
- 真正的“拖拽文件夹到 UI 直接开跑”（v0.1 先用文件夹选择器）。
- 多机并行/分布式队列（先单机稳定）。
- “patch 编辑（只输出 diff 并自动 apply）”的全链路（属于 v0.2+）。

## 范式：队列（Work Queue）+ 状态机（State Machine）+ Checkpoint
### 为什么是它
- **Goodhart / 自我修正漂移**：让模型自己“拆解+调工具+写文件”容易在长链路里跑偏；系统队列能把每个单元约束为“只做一件事”。
- **失败隔离**：某篇失败不应阻塞其它 249 篇。
- **断点续跑**：长任务注定会遇到网络/上游波动，必须可恢复。

### 单篇（MicroTask）推荐状态机
- `plan`：为本节课生成 N 个标题/脚本方向（可缓存）
- `draft`：生成候选稿
- `lint.copy`：防复用风险（不通过则回炉）
- `lint.style`：风格对齐（不通过则回炉）
- `write`：写入输出目录
- `done/failed`

### Checkpoint（落盘）
建议输出目录内写：
- `.batch-meta/metadata.json`：批次配置（输入 dir、clipsPerLesson、styleLibraryId）
- `.batch-meta/progress.jsonl`：每篇成功记录（file、clipIndex、outPath、score、timestamp）
- `.batch-meta/failures.jsonl`：每篇失败记录（error、timestamp）
- `.batch-meta/plans/*.json`：每节课标题规划缓存（避免恢复时重复耗费 token）

## 安全边界（必须）
- **写入边界**：v0.1 默认只写 `exports/batch_xxx/**`，不覆盖原文件。
- **目录 allowlist**：输出目录必须在项目根目录下（相对路径）。
- **资源控量**：单次 LLM 输入/输出截断（避免超长导致空响应/超时）。

## 参考（用于对标范式）
- Claude Code 把随机对话变成可复现的产线（Plan/执行/差异驱动）：`https://cc.deeptoai.com/docs/zh/best-practices/claude-code-production-workflow`
- Google Docs API 的 batchUpdate 思路（事务/批量应用）：`https://developers.google.com/workspace/docs/api/how-tos/overview?hl=zh-cn`
- ProseMirror Transaction 范式（编辑操作可撤销/可组合）：`https://prosemirror-old.xheldon.com/docs/guide/`
- Wordflow（文本编辑器/高亮/结构化操作的可视化思路）：`https://opendeep.wiki/poloclub/wordflow/text-editor`

## 参考项目：Clawdbot（长时间运行 Agent 的工程启发）
> 注：GitHub 上同名很多。与“长跑 agent”最相关的是 **`moltbot/clawdbot`**（README 中明确：daemon 安装、Gateway control plane、session/queue/retry/failover）。
>
> - repo：`https://github.com/moltbot/clawdbot`
> - docs：`https://docs.clawd.bot`

### 对我们“批量长时间生成文章”的 5 个直接启发
1) **把长任务从 UI 里剥离**：Clawdbot 用 `--install-daemon` 把 Gateway 作为常驻服务跑起来，UI/CLI 只是 client。  
   - 对应我们：批处理 runner 最终应从 renderer store 迁到 **Desktop main/worker 或 Gateway 后台 worker**，避免窗口刷新/重启导致中断。

2) **控制平面（Control Plane）优先**：Clawdbot 把“session、tools、events、cron、presence”等集中在 Gateway。  
   - 对应我们：需要一个“Batch control plane”来管理 job 状态（队列、进度、失败、重试），而不是把状态隐式散在对话里。

3) **Session/Queue 模型**：Clawdbot 明确 session 概念，并提到 queue modes。  
   - 对应我们：每篇（MicroTask）都应绑定一个可恢复的 sessionId/taskId；队列推进以 taskId 为准，避免 LLM “记忆推进”。

4) **Retry/Fallback 是一等公民**：Clawdbot 文档强调 retry policy、model failover。  
   - 对应我们：长批处理要做“每篇独立 retry budget + 上游 failover + backoff”，不要共享一个全局重试预算。

5) **安全默认**：Clawdbot 对 DM 设 pairing/allowlist，强调 untrusted input。  
   - 对应我们：批处理写入必须有 **输出目录边界**（只写 exports/**），并做工具白名单（仅生成/检查/写入）。

## v0.1 在本仓库的落地
- Desktop 新增批处理 store：`apps/desktop/src/state/writingBatchStore.ts`
- Runs 面板增加入口：`apps/desktop/src/components/WritingBatchJobsPanel.tsx`（先选文件夹开跑）

## v0.2（面向 250 篇稳定跑完）的增强点
> 目标：真正做到“拖一个文件夹 → 50 节课 → 每课 5 篇 → 250 篇落盘”，并且可中断/可续跑/不重复生成。

### 1) 外部文件夹拖拽入口
- Explorer 根区域接受 OS 文件夹 drop：直接创建批处理 job 并开始运行（默认 5 篇/课、输出到 exports）。
- 文件夹内递归扫描 `.md/.mdx/.txt`，自动忽略 `node_modules/.git/dist/out/...`。

### 2) job 固化关键参数（避免长跑过程中“中途变更”）
- 固化：`clipsPerLesson/styleLibraryId/model/outputDir`
- 目的：250 篇长跑时，防止用户切换模型/库导致风格不一致。

### 3) 输出命名稳定 + 去重
- 每节课内使用 `01_标题.md` 形式，并对重复标题自动加后缀 `_2/_3`。

### 4) 跳过已存在输出（断点续跑核心）
- 再次运行同一批次时：如果目标 `.md` 已存在则直接记为 done（并写 progress.jsonl 的 `skipped:true`），避免重复消耗模型额度。

### 5) 落盘 checkpoint（job.json）
- 每次进度更新都会写：`exports/batch_xxx/.batch-meta/job.json`
- 内容包含：游标（fileIndex/clipIndex）、done/failed、最近失败摘要等。

## v0.3（硬路由 B）：把“批处理”变成 Skill + Tool（由 Agent 决定调用）
> 目标：不再依赖 Desktop Runs 面板；当用户提出“>=5篇/按文件夹/批量”时，系统自动启用 `writing_batch` skill，并在工具门禁层强制让 Agent 走 `writing.batch.*`。

### 1) Skill：writing_batch（自动识别批量意图）
- 触发：文本显式出现“批处理/文件夹/50节/250篇”等，或“>=5 篇/条”之类数量信号
- 行为：提示并强制只允许调用 `writing.batch.*`（避免模型在单次 run 里硬写 7/250 篇导致中断）

### 2) Tool：writing.batch.*（后台队列）
- `writing.batch.start`：启动后台批处理（不等待跑完，立即返回 jobId/outputDir）
- `writing.batch.status`：查询进度/游标/失败摘要
- `writing.batch.pause/resume/cancel`：控制长跑

### 3) 使用方式（面向你“我坚持用 Agent 知道用哪些工具”）
- 你只要对 Agent 说“把这个文件夹里每节课拆成 5 篇，按风格库跑完输出到新文件夹”，
  skill 会自动激活并引导/强制它调用 `writing.batch.start`。
- Agent 启动后会建议调用 `writing.batch.status` 拿到 jobId/outputDir，然后用 `run.done` 结束本次 run（批处理在后台继续）。

## 验收清单（最小闭环）
- 在一个包含 50 个 `.md` 的目录上启动批处理（每课 5 篇），能持续跑下去。
- `pause/resume/cancel` 有效，且取消后不再继续生成。
- 输出目录下生成 `.batch-meta/*` 文件，且成功/失败都能落盘记录。
- 任意单篇失败不会阻塞其它课的生成。


