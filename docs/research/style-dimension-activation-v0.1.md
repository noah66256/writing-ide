## 风格维度激活与提示结构化（research v0.1）

> 状态：draft（2026-01-29）  
> 目标：解释“20+ 维度明明具备但未被激活”的根因，给出可落地的结构化提示/验证闭环方案，并记录外部资料的证据强度与局限。

---

### 0. 背景与问题

我们已有三层风格资产：  
- **声音指纹**（softRanges：句长/问句率/人称密度等）  
- **规则卡/维度卡**（21 facets）  
- **模板/卡片检索**（hook/ending/one_liner/outline/thesis）  

但在 `style_imitate` 的单篇流程里，这些维度**常被模型忽略或只部分启用**，导致“弹药箱满但打不准”的感受。

---

### 1. 搜索范围与局限

**搜索渠道**：Web + GitHub  
**关键词**（示例）：structured prompt / prompt template / style transfer / controllable generation / persona anchor / dimension coverage  

**局限**：  
- 大量结果为博客与经验贴，缺少严格对照实验。  
- 工具返回的 GitHub 结果关联度较低（仅少量可借鉴“模板化提示/分层注入”的工程思路）。  
- 没有找到直接针对“20+ 维度激活”可复用的学术级证据。

---

### 2. 有效线索（证据强度：中-低）

1) **提示模板化/变量注入**（工程实践）  
   - deer-flow 的 Prompts 文档强调**模板化 + 变量注入 + 条件渲染**（避免一次性注入全部维度）。  
   - 结论：把维度由“自然语言列表”改为“结构化变量 + 分层渲染”更可控。  

2) **人格锚点 / 场景记忆**（经验性）  
   - 多数“AI 写作真实化”经验强调**具体案例锚点**比“参数列表”更容易触发稳定模仿。  
   - 结论：可把维度转成“人格档案 + 记忆锚点 + 场景细节”，而不是纯参数表。  

3) **两阶段流程**（跨领域借鉴）  
   - GitHub 项目中常见“先提取 → 再综合”的多阶段结构（与写作无关但可借鉴）。  
   - 结论：可先做“维度覆盖检测”，再针对缺失维度定向修复。

---

### 3. 需要纠正/谨慎的点

- **采样策略（temperature/beam search）**目前没有找到可靠证据支撑“必须调整采样才能提升维度命中”。  
  → 这点只能作为假设，**不应列为优先改动项**。  
- **并发导致维度丢失**缺乏外部证据，暂不作为结论。  

---

### 4. 可复用模式（与现有系统对齐）

#### 4.1 维度分层（必须/建议/可选）
将 20+ 维度分层注入，避免“等权平铺”：
- **MUST**：必须满足（结构模板、禁用词、硬性节奏）
- **SHOULD**：强烈建议（开头套路、段落节奏）
- **MAY**：参考使用（金句库、类比库）

#### 4.2 模板化提示（条件渲染）
把 `style_imitate` 的提示词改为模板化：  
- `mustApply` 维度以“硬约束清单”形式出现  
- 低分时提升约束等级（SHOULD → MUST）

#### 4.3 维度覆盖诊断
让 lint 输出“缺失维度清单”，而不是只有总分：  
```
score: 68
missingDimensions: ["opening_design", "voice_rhythm"]
```
据此触发“定向补强”，而不是全量重写。

---

### 5. 与当前代码链路的落点

已存在的注入点：  
- `STYLE_SELECTOR(JSON)` + `STYLE_FACETS_SELECTED(Markdown)`  
- `styleContractV1.softRanges`  
- batch 模式的 `kb.search(cardTypes=hook/ending/one_liner/outline)`  

缺口：  
- `STYLE_FACETS_SELECTED` 目前是自然语言文本，**缺少优先级与硬约束标签**。  
- `softRanges` 只在 `lint.style` 使用，**生成阶段没有硬约束映射**。  
- 单篇流程没有复用批处理的“模板检索 → 定向补强”逻辑。  

---

### 6. 建议路线（按优先级）

**P0（最快）**  
- 结构化提示：把维度拆成 MUST/SHOULD/MAY，前置注入  
- 把 `styleContractV1 + selectedFacets` 转成结构化字段  

**P1（稳定提升）**  
- `lint.style` 返回“维度覆盖报告”  
- 覆盖不足时触发“定向补强”  

**P2（工程化）**  
- 模板化提示库（初稿/修订/急稿三套模板）  
- 依据评分/场景选择模板  

---

### 7. 参考链接（证据强度：中-低）

- deer-flow Prompts（模板化提示思路）：  
  https://opendeep.wiki/bytedance/deer-flow/developer-guide-backend-prompts
- 提示工程案例（经验性）：  
  https://blog.csdn.net/2502_91591115/article/details/150407168  
- AI 写作真实化经验（经验性）：  
  https://juejin.cn/post/7486460692395245578  
- 两阶段流程借鉴（弱相关）：  
  https://github.com/ZhiYi-R/LogAnalysis  


