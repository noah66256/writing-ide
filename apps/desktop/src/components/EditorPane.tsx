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
  const setActivePath = useProjectStore((s) => s.setActivePath);
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
            className={`tab ${p === activePath ? "tabActive" : ""}`}
            onClick={() => setActivePath(p)}
            title={p}
          >
            {basename(p)}
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


