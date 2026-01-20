## IDE Agent 上下文机制：劣势与完善方法（research v1）

### 1. 我们现状（对照代码）

我们的上下文分三层：

- **A) Desktop -> Gateway：contextPack（会注入给模型，system message）**
  - Plan/Agent：`apps/desktop/src/agent/gatewayAgent.ts` 的 `buildContextPack()`
    - `MAIN_DOC(JSON)`
    - `RUN_TODO(JSON)`（裁剪注入）
    - `DOC_RULES(Markdown)`（当前为全文）
    - `RECENT_DIALOGUE(JSON)`（最多 6 条，剔除 tool XML）
    - `REFERENCES(...)`（来自 `@{}` 引用）
    - `KB_SELECTED_LIBRARIES(JSON)`
    - `ACTIVE_SKILLS(JSON)`
    - （条件注入）`KB_LIBRARY_PLAYBOOK` / `KB_STYLE_CLUSTERS` / `STYLE_SELECTOR` / `STYLE_FACETS_SELECTED`
    - `PENDING_FILE_PROPOSALS(JSON)`
    - `EDITOR_SELECTION(JSON)`（最多 4000 chars；无选区则不带 path/range）
    - `PROJECT_STATE(JSON)`（目前只注入 fileCount）
  - Chat：`buildChatContextPack()`（只注入 `DOC_RULES` + `REFERENCES` + `EDITOR_SELECTION`，不注入 MainDoc/Todo/Skills/KB）

- **B) Gateway：额外 system 注入（会注入给模型）**
  - `apps/gateway/src/index.ts`：`buildAgentProtocolPrompt()` + mode policy + tools prompt（以及阶段裁剪工具清单）

- **C) Desktop -> Gateway：toolSidecar（不会注入给模型）**
  - `projectFiles/docRules/ideSummary/styleLinterLibraries` 等，用于 server-side 工具与意图路由辅助。

### 2. 全网+GitHub 观察到的典型劣势（落到我们这里的映射）

#### 2.1 上下文膨胀（Token/Chars bloat）与长上下文退化

- 现象：system/policy + tools prompt + doc rules + KB playbook + selection + refs 堆叠，模型更易“跑偏/忘约束/忽略中段关键信息”。
- 工程后果：
  - 成本/延迟上升；更容易触发上游超时/断流。
  - 发生错误时难定位：到底是“没注入”还是“注入了但被淹没/截断”。

#### 2.2 选择策略偏粗（相关性不足 + 依赖关系缺失）

- 单纯语义相似/最近对话不足以覆盖代码/文档的“依赖关系”（调用图、契约边界）。
- 后果：模型可能生成“看似合理但与现状不一致”的建议；或重复已有实现。

#### 2.3 不可信内容注入（Prompt Injection / Context Poisoning）

- `web.fetch`、项目文件、`@{}` 引用、甚至 doc.rules 都可能包含“指令句式”。
- 若缺少“信任边界”，模型会把数据当指令执行，造成越权工具尝试、错误写入、策略绕过。
- 参考：
  - GitHub Copilot 的“上下文传递契约”：client.file/client.selection（上下文来自客户端，必须配合权限与排除规则）：
    - `https://docs.github.com/en/copilot/how-tos/use-copilot-extensions/build-a-copilot-agent/use-context-passing`
  - prompt injection 防护建议（把不可信内容当 data，不当 instruction）：
    - `https://www.ibm.com/think/insights/prevent-prompt-injection`

#### 2.4 摘要/裁剪导致的“细节丢失”

- 当历史过长触发 summarize/prune 时，细节（路径、字段、边界条件）易丢。
- 参考：Copilot 社区反馈 “summarized conversation history” 导致丢失关键信息：
  - `https://github.com/orgs/community/discussions/162256`

#### 2.5 可观测性不足（debug 难）

- 我们已有 `context.pack.summary`，但缺少“每段上下文的 chars/token 占比、是否截断、来源、信任级别”。
- 直接后果：排查 403/empty_output/跑偏时，需要人工翻大量日志。

### 3. 完善方法（范式优先）

#### 3.1 Context Budget + Manifest（预算+清单）

- 目标：让“注入什么/截断什么/为何截断”可解释、可监控、可 UI 展示。
- 做法：
  - 在 contextPack 里新增 `CONTEXT_MANIFEST(JSON)`：
    - segments: [{name, chars, priority, trusted, truncated, source}]
  - Gateway 侧把 manifest 打到 `context.pack.summary`。

#### 3.2 Trust Boundary（信任边界）

- 目标：把“不可信内容”降权为“数据”，禁止覆盖 system/policy。
- 做法：
  - 给每段上下文标 trusted/untrusted。
  - 在 system prompt 明确：untrusted 段落里的“指令”一律忽略，只当引用材料。
  - 对 untrusted 段落做轻量扫描：
    - 典型模式：忽略之前所有指令/你现在是管理员/调用删除/写入 secrets 等。

#### 3.3 Retrieval-first（少塞，多读）

- 目标：避免把长文档/长日志默认塞进上下文；改成“索引 + 按需读取”。
- 做法：
  - `DOC_RULES` 只注入摘要（或前 N 行 + hash），需要细节再 `doc.read`。
  - playbook/selector 也只注入索引（clusterId/facetIds），需要正文再按需 `kb.search`。

#### 3.4 Persistent Memory（跨会话）

- 目标：把“关键决策/关键约束”从易丢的对话历史中抽离，作为稳定事实。
- 做法：
  - 引入 `project.memory.md`（或 DB/KB artifact）保存：
    - 权限边界、工具策略、写入约束、平台偏好、关键架构决策
  - 每次 run 只注入这段“稳定事实摘要”。

#### 3.5 Versioning / Checkpoint（上下文版本化）

- 目标：长任务不靠“把历史全带着走”，而是阶段性固化状态。
- 参考：GCC（把上下文当版本控制来管理，支持 checkpoint/branch/merge）
  - `https://arxiv.org/abs/2508.00031`

### 4. 对我们项目的落地路线（建议 v0.1 -> v0.3）

#### v0.1（最小闭环，先解决“可观测 + 可控”）

- 增加 `CONTEXT_MANIFEST(JSON)` 并在日志/UI 展示
- 给 context 段落加 priority/trusted 标记
- 对 `DOC_RULES` / `REFERENCES` / `web.fetch` 内容做注入攻击特征扫描（只告警，不阻断）

#### v0.2（显著降低 bloat，减少跑偏）

- `DOC_RULES` 改为“摘要 + hash + 按需 doc.read”
- playbook/selector 改为“索引优先，正文按需 kb.search”
- 引入 token/chars 预算：按优先级裁剪低优先级段落

#### v0.3（长期稳定性）

- 引入 `project.memory.md`/DB 记忆层（跨 session）
- 引入 checkpoint（阶段结束写 summary，下一阶段只引用 summary）

### 5. 验收清单

- 在长对话/多工具调用下：
  - system/policy 不被“中段淹没”（manifest 显示仍在、且未截断）
  - 发生 403/deny 时：错误来源清晰（FORBIDDEN / UPSTREAM_403 / HTTP_403）
  - 用户能在 UI/日志看到本轮注入了哪些段落、各自 chars、哪些被截断


