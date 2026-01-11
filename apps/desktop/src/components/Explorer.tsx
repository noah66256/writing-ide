import { useProjectStore } from "../state/projectStore";

function basename(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export function Explorer() {
  const files = useProjectStore((s) => s.files);
  const activePath = useProjectStore((s) => s.activePath);
  const openFilePreview = useProjectStore((s) => s.openFilePreview);
  const openFilePinned = useProjectStore((s) => s.openFilePinned);

  return (
    <div className="list">
      {files.map((f) => (
        <div
          key={f.path}
          className={`fileItem ${activePath === f.path ? "fileItemActive" : ""}`}
          onClick={() => openFilePreview(f.path)}
          onDoubleClick={() => openFilePinned(f.path)}
          title={f.path}
        >
          <span
            style={{
              color: "var(--muted)",
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


