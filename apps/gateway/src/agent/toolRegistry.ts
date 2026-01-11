export type ToolMeta = {
  name: string;
  description: string;
  args: Array<{ name: string; required?: boolean; desc: string }>;
};

// Gateway 侧先维护“可调用工具清单”（用于提示词 + allowlist 审计）。
// 执行仍由 Desktop 客户端完成，并通过 tool_result 回传。
export const TOOL_LIST: ToolMeta[] = [
  {
    name: "run.mainDoc.get",
    description: "读取本次 Run 的 Main Doc（主文档/主线）。",
    args: [],
  },
  {
    name: "run.mainDoc.update",
    description: "更新本次 Run 的 Main Doc（主线）。输入 patch(JSON)。",
    args: [{ name: "patch", required: true, desc: "JSON 对象：MainDoc 的增量 patch" }],
  },
  {
    name: "project.listFiles",
    description: "列出当前项目文件列表（path）。",
    args: [],
  },
  {
    name: "project.docRules.get",
    description: "读取项目级 Doc Rules（doc.rules.md）。",
    args: [],
  },
  {
    name: "doc.read",
    description: "读取文件内容（path）。",
    args: [{ name: "path", required: true, desc: "文件路径（如 drafts/draft.md）" }],
  },
  {
    name: "doc.commitSnapshot",
    description: "创建一个项目快照（用于回滚/Undo）。",
    args: [{ name: "label", required: false, desc: "快照备注（可选）" }],
  },
  {
    name: "doc.listSnapshots",
    description: "列出当前项目的快照列表（只读）。",
    args: [],
  },
  {
    name: "doc.restoreSnapshot",
    description: "恢复到指定快照（proposal-first：Keep 才会真正恢复；Undo 可回滚）。",
    args: [{ name: "snapshotId", required: true, desc: "快照 ID（doc.commitSnapshot 的返回）" }],
  },
  {
    name: "doc.previewDiff",
    description: "生成 diff 预览（无副作用）。可传 newContent 或 edits。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "newContent", required: false, desc: "新内容全文（JSON 字符串）" },
      { name: "edits", required: false, desc: "JSON 数组：TextEdit[]" },
    ],
  },
  {
    name: "doc.write",
    description: "写入文件（path, content）。新建可自动落盘；覆盖会走提案确认（Keep）。",
    args: [
      { name: "path", required: true, desc: "文件路径" },
      { name: "content", required: true, desc: "文件全文内容" },
    ],
  },
  {
    name: "doc.getSelection",
    description: "获取编辑器当前选区内容。",
    args: [],
  },
  {
    name: "doc.replaceSelection",
    description: "替换当前选区为 text（可 Undo）。",
    args: [{ name: "text", required: true, desc: "替换后的文本" }],
  },
  {
    name: "doc.applyEdits",
    description: "对指定文件应用一组 TextEdit（默认提案，Keep 才 apply）。",
    args: [
      { name: "path", required: false, desc: "文件路径（默认 activePath）" },
      { name: "edits", required: true, desc: "JSON 数组：TextEdit[]" },
    ],
  },
];

export const TOOL_NAMES = new Set(TOOL_LIST.map((t) => t.name));

export function toolsPrompt() {
  return TOOL_LIST.map((t) => {
    const args = t.args.length
      ? t.args.map((a) => `- ${a.required ? "(必填) " : ""}${a.name}: ${a.desc}`).join("\n")
      : "- （无参数）";
    return `工具：${t.name}\n说明：${t.description}\n参数：\n${args}\n`;
  }).join("\n");
}


