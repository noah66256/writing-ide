import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useProjectStore } from "../state/projectStore";

function basename(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export function EditorPane() {
  const openPaths = useProjectStore((s) => s.openPaths);
  const activePath = useProjectStore((s) => s.activePath);
  const previewPath = useProjectStore((s) => s.previewPath);
  const setActivePath = useProjectStore((s) => s.setActivePath);
  const closeTab = useProjectStore((s) => s.closeTab);
  const updateFile = useProjectStore((s) => s.updateFile);
  const getFileByPath = useProjectStore((s) => s.getFileByPath);
  const setEditorRef = useProjectStore((s) => s.setEditorRef);

  const activeFile = getFileByPath(activePath);

  return (
    <div className="editorRoot">
      <div className="tabBar">
        {openPaths.map((p) => (
          <div
            key={p}
            className={`tab ${p === activePath ? "tabActive" : ""} ${p === previewPath ? "tabPreview" : ""}`}
            onClick={() => setActivePath(p)}
            title={p}
          >
            <span className="tabLabel">{basename(p)}</span>
            <button
              className="tabClose"
              type="button"
              aria-label={`关闭 ${basename(p)}`}
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(p);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="editorContainer">
        <Editor
          height="100%"
          language="markdown"
          theme="vs"
          value={activeFile?.content ?? ""}
          onMount={(ed: editor.IStandaloneCodeEditor) => setEditorRef(ed)}
          onChange={(value) => updateFile(activePath, value ?? "")}
          options={{
            // 关键：当拖动左右分割条 / Dock 分割条 / 窗口缩放时，Monaco 自动重新 layout，
            // 避免“编辑器输入区被 Dock/面板遮挡（其实是尺寸没刷新）”。
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: "on",
            fontSize: 14,
            padding: { top: 12, bottom: 12 },
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}


