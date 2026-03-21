# Claude Code Skill Hooks Live Validation 2026-03-21

## 已跑验证

- `npm run -w @ohmycrab/gateway build`
  - 结果：通过
- `npm run -w @ohmycrab/desktop build`
  - 结果：通过
- `npx tsx apps/gateway/scripts/smoke-claude-hook-parity.ts`
  - 结果：通过
  - 覆盖点：
    - `PermissionRequest -> allow + updatedInput`
    - `PermissionRequest unresolved -> approval_waiting`
    - `Notification` matcher / `run.notice` -> `Notification` hook
    - `dialogue_summary` 真实 compact 元数据注入 `PreCompact / PostCompact`
    - `SessionStart.source=compact`
    - `Stop decision=block -> follow-up continuation`
    - `SubagentStop decision=block -> follow-up continuation`

## 当前结论

- `command` hook 已稳定走 Desktop 本地执行桥，不再由 Gateway 直接执行 shell。
- `PermissionRequest` 已能返回 `allow`，也能把未决请求桥接到 `approval_waiting`。
- `dialogue_summary compact` 已可被 portable hook 观测，但实现方式不是“run 中途逆向 WS 回调”，而是“Desktop 在 `run.request` 前完成 compact，并把 compact 元数据带进同一启动轮”。
- `Stop / SubagentStop` 的 `decision=block` 已真正进入续跑链路，不再只是记录日志；当前通过 follow-up continuation 实现，并带 3 次 guard 防止 hook 死循环。

## 最小样本矩阵

| 样本 | 覆盖点 | 验证方式 | 结果 |
|------|--------|----------|------|
| 最小 `UserPromptSubmit + SessionStart` sample | immediate context / `source=compact` | `smoke-claude-hook-parity.ts` | 通过 |
| 最小 `PermissionRequest unresolved` sample | `approval_waiting` | `smoke-claude-hook-parity.ts` | 通过 |
| 最小 `Notification` sample | `run.notice` -> `Notification` hook | `smoke-claude-hook-parity.ts` | 通过 |
| 最小 `Stop block` sample | natural stop -> continue | `smoke-claude-hook-parity.ts` | 通过 |
| 最小 `SubagentStop block` sample | subagent stop -> parent continue | `smoke-claude-hook-parity.ts` | 通过 |
| 最小 `PreCompact/PostCompact` sample | `dialogue_summary compact_summary` | `smoke-claude-hook-parity.ts` | 通过 |

## 仍待人工桌面态补跑

- 这一段不是“代码未完成”，而是“真实 UI / 交互体感还没人工点过”。
- 在真实 Desktop 会话里确认 `approval_waiting` 的 UI 提示文案与用户体感是否顺畅。
- 在真实 Desktop 会话里确认 `Stop block` / `SubagentStop block` 时，线程不会误显示为已完成，且继续轮的提示文案符合预期。
- 在真实含长对话线程里确认 `context.summary.roll` 后，hook 侧拿到的 `compact_summary` 与实际写回 store 的摘要一致。
- 对照 1 个真实 Claude Code hook sample，再做一次手工开箱验证。
