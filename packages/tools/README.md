## packages/tools（工具元数据定义）

### 目标

**工具契约的单一来源**：提供所有工具的元数据定义（name / description / args / modes / inputSchema），供 Gateway 生成提示词与白名单、Desktop 执行工具时校验参数。

### 核心内容

- `TOOL_LIST`：所有工具的元数据数组
- `encodeToolName` / `decodeToolName`：LLM 工具名编码/解码（`.` → `_dot_`）
- `toolsPrompt()`：生成注入系统提示词的工具描述
- `toolNamesForMode()`：按模式裁剪工具白名单

### 工具分类

- `run.*`：编排工具（setTodoList / done / mainDoc）
- `agent.*`：子 Agent 委派（delegate / config）
- `doc.*`：文档读写（read / write / applyEdits / getSelection / replaceSelection）
- `kb.*`：知识库检索（search / cite）
- `lint.*`：风格/质量检查（style）
- `project.*`：项目文件操作（listFiles / docRules）
- `web.*`：联网工具（search / fetch）
- `writing.*`：批处理写作任务
- `file.*`：文件操作（open）
- `time.*`：时间工具（now）
