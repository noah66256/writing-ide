export type AgentMode = "plan" | "agent" | "chat";

export type ToolMeta = {
  name: string;
  description: string;
  args: Array<{ name: string; required?: boolean; desc: string }>;
  modes?: AgentMode[];
};

// Gateway 侧先维护“可调用工具清单”（用于提示词 + allowlist 审计）。
// 执行仍由 Desktop 客户端完成，并通过 tool_result 回传。
export const TOOL_LIST: ToolMeta[] = [
  {
    name: "kb.search",
    description:
      "在本地知识库中检索（按库过滤、按 source_doc 分组返回）。\n" +
      "【仿写检索 skill（强烈建议）】当用户要求“按某库风格仿写/改写”时：先用 kb.search 拉 3–8 条可抄的原文样例（优先 kind=paragraph / outline），再写稿；写作中遇到具体段落（开头/转折/结尾/金句）再补一次 kb.search。\n" +
      "【查询建议】\n" +
      "- 结构：kind=outline，query=“这篇文章的结构/分段/节奏/五环结构/结论先行”\n" +
      "- 口吻/句式：kind=paragraph，query=“直男财经 口吻/金句/反差破题/转折句式/收尾 CTA”\n" +
      "- 维度：传 facetIds（来自 FacetPack，例如 opening_design/logic_framework/ending 等）缩小检索范围。\n" +
      "【提示】如未关联库，会报错 NO_LIBRARY_SELECTED；请先在右侧把库关联上。",
    args: [
      { name: "query", required: true, desc: "搜索关键词/问题" },
      { name: "kind", required: false, desc: '可选：artifact kind（"card"|"outline"|"paragraph"），默认 "card"' },
      { name: "libraryIds", required: false, desc: "可选：库 ID 数组；不传则默认使用右侧已关联库" },
      { name: "facetIds", required: false, desc: "可选：outlineFacet id 数组（多选）" },
      { name: "perDocTopN", required: false, desc: "每篇文档最多返回多少条命中（默认 3）" },
      { name: "topDocs", required: false, desc: "最多返回多少篇文档（默认 12）" },
    ],
    modes: ["plan", "agent"],
  },
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
    modes: ["plan", "agent"],
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。输入 patch(JSON)。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch" }],
    modes: ["plan", "agent"],
  },
  {
    name: "run.setTodoList",
    description: "设置本次 Run 的 Todo List（用于进度追踪与防跑偏）。",
    args: [{ name: "items", required: true, desc: 'JSON 数组：TodoItem[]（{ id?, text, status?, note? }）' }],
    modes: ["plan", "agent"],
  },
  {
    name: "run.updateTodo",
    description: "更新某一条 Todo 的状态/备注（用于记录进度）。",
    args: [
      { name: "id", required: true, desc: "Todo ID（来自 run.setTodoList 的返回）" },
      { name: "patch", required: true, desc: "JSON 对象：{ status?, note?, text? }" },
    ],
    modes: ["plan", "agent"],
  },
  {
    name: "project.listFiles",
    description: "列出当前项目文件列表（path）。",
    args: [],
    modes: ["plan", "agent"],
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。",
    args: [],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.read",
    description: "读取文件内容（path）。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）" }],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.commitSnapshot",
    description: "创建一个项目快照（用于回滚/Undo）。",
    args: [{ name: "label", required: false, desc: "快照备注（可选）" }],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.listSnapshots",
    description: "列出当前项目的快照列表（只读）。",
    args: [],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.restoreSnapshot",
    description: "恢复到指定快照（proposal-first：Keep 才会真正恢复；Undo 可回滚）。",
    args: [{ name: "snapshotId", required: true, desc: "快照 ID（doc.commitSnapshot 的返回）" }],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.previewDiff",
    description: "生成 diff 预览（无副作用）。可传 newContent 或 edits。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "newContent", required: false, desc: "新内容全文（JSON 字符串）" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]" },
    ],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.write",
    description: "写入文件（path, content）。新建可自动落盘；覆盖会走提案确认（Keep）。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "content", required: true, desc: "文件全文内容" },
    ],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.splitToDir",
    description:
      "将一个大文档按“标题/文案(正文)”块分割成多篇，并写入目标文件夹（proposal-first：Keep 才会真正写入；Undo 可回滚）。",
    args: [
      { name: "path", required: true, desc: "源文件路径（如 直男财经.md）" },
      { name: "targetDir", required: true, desc: "目标目录（如 直男财经/）" },
    ],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选区内容。",
    args: [],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.replaceSelection",
    description: "替换当前选区为 text（可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本" }],
    modes: ["plan", "agent"],
  },
  {
    name: "doc.applyEdits",
    description: "对指定文件应用一组 TextEdit（默认提案，Keep 才 apply）。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath）" },
      { name: "edits", required: true, desc: "JSON 数组：TextEdit[]" },
    ],
    modes: ["plan", "agent"],
  },
];

export function getToolsForMode(mode: AgentMode) {
  return TOOL_LIST.filter((t) => (t.modes?.length ? t.modes.includes(mode) : true));
}

export function toolsPrompt(mode: AgentMode) {
  const list = getToolsForMode(mode);
  if (!list.length) return "（当前模式不允许调用工具）\n";
  return list.map((t) => {
    const args = t.args.length
      ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n")
      : "- （无参数）";
    return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
  }).join("\n");
}

export function toolNamesForMode(mode: AgentMode) {
  return new Set(getToolsForMode(mode).map((t) => t.name));
}


