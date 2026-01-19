## doc.write 新写/覆盖策略（research v1）

### 背景与问题
近期多次出现“连续两次新写，却覆盖第一次产物”的问题。根因是写入工具缺少“文件存在时的明确策略”，导致模型与系统对“新写/覆盖”的理解不一致。

目标：
- 默认不覆盖已有文件，避免数据丢失。
- 用户明确说“覆盖/替换/更新”时才允许覆盖。
- 允许模型提供更合适的新文件名（而不是单纯 _2）。

### 全网 + GitHub 检索（简述）
检索关键词（全网）：
- `LLM tool calling overwrite file if exists`
- `safe write file if exists rename`
- `doc.write overwrite protection proposal`

检索关键词（GitHub）：
- `if exists overwrite rename file write`
- `safe write file tool calling`
- `overwrite guard --force cli`

结论（共性实践）：
- 默认安全：未显式授权时，多数工具选择“新建/改名”或“提示确认”，而不是直接覆盖。
- 强制覆盖：覆盖需要明确意图（如 `--force` / `overwrite=true` / `ifExists=overwrite`）。
- 明确命名：对生成内容，建议使用“主题 + 日期/版本号”命名，减少重复冲突。

参考（API 级别/通用实践）：
- Node.js `fs.existsSync` / `fs.promises.access` 用于“路径存在性判断”。
  - https://nodejs.org/api/fs.html#fsexistssyncpath
  - https://nodejs.org/api/fs.html#fspromisesaccesspath-mode

> 说明：当前未检索到“LLM 工具写入”领域的统一规范，以上为通用工程实践的共性抽象。

### 方案对比（简化）
| 策略 | 行为 | 适用场景 | 风险 |
|---|---|---|---|
| rename（默认） | 自动改名新建 | 新写、素材盘点、报告生成 | 可能产生多个近似文件 |
| overwrite | 覆盖原文件（proposal-first） | 用户明确要求覆盖/更新 | 误判会丢失资料 |
| error | 直接报错 | 自动化流程不希望产生多文件 | 增加阻塞 |

### 推荐落地（适配本项目）
1) `doc.write` / `doc.previewDiff` 增加 `ifExists` 参数（默认 rename）。  
2) Gateway 在“明确覆盖意图”时自动补 `ifExists=overwrite`。  
3) 支持 `suggestedName`，让模型起更合适的新文件名。  
4) Desktop 在 rename 模式下自动生成不冲突的新路径，并在结果里标注 `renamedFrom`。  

### 常见坑位
- 仅凭“引用 @{}”判断覆盖意图会误伤（引用可能是改写/大纲/参考）。
- 路径规范化（`./`、`\`）与大小写问题可能导致“误判不存在”。
- 提案态/未 Keep 的文件也应参与“已存在判定”，避免再次覆盖。

### 验收要点
- 连续两次“新写”不覆盖旧文件；第二次自动改名并提示来源。
- 用户明确“覆盖/替换/更新”时，走覆盖提案（Keep 才生效）。
- 结果输出中能看到 `renamedFrom` 与 `ifExists` 记录。

