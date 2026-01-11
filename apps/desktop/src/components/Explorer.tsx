import { useProjectStore } from "../state/projectStore";

function basename(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export function Explorer() {
  const files = useProjectStore((s) => s.files);
  const activePath = useProjectStore((s) => s.activePath);
  const openFile = useProjectStore((s) => s.openFile);

  return (
    <div className="list">
      {files.map((f) => (
        <div
          key={f.path}
          className={`fileItem ${activePath === f.path ? "fileItemActive" : ""}`}
          onClick={() => openFile(f.path)}
          title={f.path}
        >
          <span
            style={{
              color: "#9aa3b2",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
              width: 22,
            }}
          >
            MD
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {basename(f.path)}
          </span>
        </div>
      ))}
    </div>
  );
}


