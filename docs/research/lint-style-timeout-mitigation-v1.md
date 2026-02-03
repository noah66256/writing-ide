## lint.style 老超时：快失败 + 自动切换模型 + prompt 控量（research v1）

### 背景（现象）
线上 `lint.style` 偶发/频繁出现：
- `degradedReason=LINT_UPSTREAM_TIMEOUT`（常见 60s 触发 abort）
- `summary=上游输出不稳定，已生成兜底结果`

会导致：
- 风格闸门 `style_need_style` 反复回炉，用户感觉“卡住/很慢/像没在工作”
- 线上排障时用 admin 账号冒烟，发现“备用模型切换不起作用”，误判为“fallback 失效”

### 关键结论（机制层）
1) **长等待不是价值**：lint 工具属于“校验/对齐”，更适合“快失败 + 自动切换备选”。
2) **admin 也必须参与 fallback**：否则线上排障（多为 admin）永远固定在主模型，无法观察 fallback 是否生效。
3) **prompt 体积直接决定延迟/超时概率**：JSON pretty-print、过多 samples/topNgrams、过长 draftLines、超长 draft 都会显著增加首 token 与整体耗时。

### 落地策略（v1）
- **默认上游超时**：30s（快失败），仍可通过 `LLM_LINTER_UPSTREAM_TIMEOUT_MS` 覆盖（且不会超过 stage timeout）。
- **模型自动切换**：按 `aiConfig.stage=lint.style.modelIds` 列表依次尝试（主 + 2 备），admin 也生效。
- **prompt 控量**：
  - `draftLines` 限制行数与单行最大长度
  - `draft.text` 超长时只传“头 + 尾”，并保留 `(truncated,totalLen=...)` 标识
  - `samples/topNgrams` 只取少量头部
  - JSON 取消 pretty-print（减少 token 与网络传输体积）

### 回滚方式
1) 若需要回到“慢但更完整”：设置 `LLM_LINTER_UPSTREAM_TIMEOUT_MS=60000`（或更高，但不超过 stage timeout）。
2) 若发现控量影响质检准确性：提高 `draftLines` 上限/`draftTextForPrompt` 上限（或恢复全量 draft）。
3) 若某个备用模型质量不佳：在 B 端移除 `lint.style` 的 `modelIds` 备选项。


