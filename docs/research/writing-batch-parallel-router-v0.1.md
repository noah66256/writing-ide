# 批处理写作：并行路由（A 方案）与调度器 v0.1（research）

## 背景
当前批处理写作（`writing.batch.*`）的执行是“按输入文件串行”。当输入文件很多（例如几十节课/几十篇拆分稿）时，整体耗时长；但盲目 `Promise.all` 并发会带来：

- **上游限流**：LLM / Gateway 更容易返回 `429/503`，失败率上升。
- **共享写入踩踏**：`.batch-meta/progress.jsonl`、`.batch-meta/failures.jsonl`、`.batch-meta/job.json` 等共享文件在并发写入时可能乱序/丢行/写坏。
- **依赖关系混乱**：长文拆分→生成→合并（map-reduce）里，reduce（合并/写入最终稿）必须串行。

本方案目标：**求稳**地把“能并行的部分并起来”，同时把“必须串行的依赖边界”写清楚，避免质量与可恢复性变差。

> 注：本仓库环境内置 `web_search` 工具近期出现过“关键词被错误导向到 Windows 代理话题”的异常返回，因此此文以业内通用范式为主（worker pool / semaphore / 指数退避+抖动 / 写入互斥锁 / map-reduce 依赖边界），并以本项目代码落地为准。

---

## A 路由：并行粒度与规则

### 1) 可并行（Map）
- **不同输入文件（不同课/不同稿）之间**：互不共享“已用开头/金句”状态 ⇒ **可并行**。
- **同一文件内的“生成正文→lint.copy→lint.style”**：为了稳定与“避重复”效果 ⇒ **仍保持串行**（同课 5 篇串行）。

### 2) 必须串行（Reduce / Write）
- **长文拆分（split）**：是后续 map 的前置依赖 ⇒ 串行。
- **合并（merge/reduce）**：多个 chunk 合为一篇 ⇒ 串行（或加锁并严格有序）。
- **写同一目标文件/覆盖同一路径**：必须串行或加锁。

---

## 调度器（Scheduler）v0.1：文件级 Worker Pool

### 核心策略
- **文件级 worker pool**：并发度 `filesConcurrency`（默认 2，建议 1–4）。
- **每个 worker 处理“一个输入文件”**：在该文件内按 clip 顺序生成（保持避重复逻辑稳定）。
- **并发度上限**：通过 `filesConcurrency` 控制，避免上游 429。

### 配置项（v0.1）
- `filesConcurrency`：文件级并行度（默认 2，范围 1–4）。

---

## 可靠性：429/503 退避重试

### 为什么需要
并发后上游更容易触发限流/临时故障（`HTTP_429` / `HTTP_503` / `HTTP_502`）。重试必须：
- **指数退避**（exponential backoff）
- **抖动**（jitter，避免“齐刷刷一起重试”）
- **可中断**（pause/cancel 时立即停止等待）

### v0.1 建议（实现侧）
- `maxAttempts=4`
- `baseMs=800`，每次乘 2，并加随机抖动（`0~250ms`）
- 仅对 retryable 错误重试（429/502/503/504）

---

## 可恢复性：断点续跑原则

### 不依赖游标（fileIndex/clipIndex）
并发下单一游标不再可靠。v0.1 采用“**从 0 扫一遍 + 跳过已存在输出文件**”的恢复策略：
- 如果输出文件已存在 ⇒ 视为已完成，跳过并计入 done。
- 计划（plan titles）落到 `.batch-meta/plans/*.json`，保证二次运行标题稳定、输出路径稳定。

---

## 共享写入互斥锁（必须做）
并发时下列文件是共享资源，必须串行化写入：
- `.batch-meta/progress.jsonl`
- `.batch-meta/failures.jsonl`
- `.batch-meta/job.json`

v0.1 的实现方式：在同一进程内做一个 **async mutex（按路径 key）**，让 append/write 形成队列，避免并发写入踩踏。

---

## 观测建议（v0.1）
- `progress.jsonl` 每行一个事件：`{ at, file, clipIndex, outPath, ok, score?, skipped? }`
- `failures.jsonl` 每行一个失败：`{ at, file, clipIndex, ok:false, error }`
- `job.json` 保存最新快照（用于 UI 展示与恢复）

---

## 落地位置（代码）
- Desktop：`apps/desktop/src/state/writingBatchStore.ts`
  - worker pool（文件级并行）
  - 共享写入加锁
  - 429/503 退避重试
  - planKey 唯一化（避免不同文件标题一样时覆盖 plan）
- Desktop Tool：`apps/desktop/src/agent/toolRegistry.ts`
  - `writing.batch.start` 增加可选参数 `filesConcurrency`

---

## GitHub 对标：并发/限流/分组串行（keyed queue）

> 这类库的共同点：把“并发上限、速率限制、按 key 串行”等调度约束从业务里抽成可测的调度层，避免工程里散落 `Promise.all` 造成 429/踩踏。

- **p-queue（★4.1k）**：`https://github.com/sindresorhus/p-queue`
  - Promise 队列 + `concurrency`，很适合表达“文件级 worker pool = `filesConcurrency`”（map 并行，上限可控）。
- **p-limit（★2.7k）**：`https://github.com/sindresorhus/p-limit`
  - 极简并发 limiter；适合把 `processOneFile` 这类任务做并发 map，并确保上限稳定。
- **Bottleneck（★2.0k）**：`https://github.com/SGrondin/bottleneck`
  - `Group.key(str)` 会把同 key 的任务路由到同一个 limiter（天然“同 key 串行、跨 key 并行”）。
  - 对我们：把 key 设为 `inputFileRelPath`（或 lessonId）能更明确表达“同一课 clips 串行，不同课并行”。
- **BullMQ（★8.3k）**：`https://github.com/taskforcesh/bullmq`
  - Redis 持久化队列；如果未来把 batch runner 从 renderer store 迁到后台 worker/daemon，可用它承载持久队列、重试与可观测性。

### 对“多篇路由”的直接启发

- **A 路由（现有实现）**：worker pool / semaphore 范式即可（当前 `writingBatchStore.ts` 的 `nextFi + workers` 就是同一范式）。
- **B 路由（单次 Run 的小批量多篇，例如 2–9 篇）**：同样建议用“microtask map + 并发上限 + microtask 内串行 phase”，并禁止“先合并再 split”的捷径，避免回到你看到的“一大坨再分割”。
  - microtask（单篇）phase 示例：`kb.search(模板)` → `draft` → `kb.search(punchline/ending)` → `lint.style` → `doc.write`


