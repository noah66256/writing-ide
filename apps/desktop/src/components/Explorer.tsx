import { useProjectStore } from "../state/projectStore";
import { useWorkspaceStore } from "../state/workspaceStore";

function basename(p: string) {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

export function Explorer() {
  const files = useProjectStore((s) => s.files);
  const activePath = useProjectStore((s) => s.activePath);
  const openFilePreview = useProjectStore((s) => s.openFilePreview);
  const openFilePinned = useProjectStore((s) => s.openFilePinned);
  const rootDir = useProjectStore((s) => s.rootDir);
  const isLoading = useProjectStore((s) => s.isLoading);
  const error = useProjectStore((s) => s.error);

  const openProject = async () => {
    const api = window.desktop?.fs;
    if (!api) return;
    const res = await api.pickDirectory();
    if (!res.ok || !res.dir) return;
    useWorkspaceStore.getState().addRecentProjectDir(res.dir);
    await useProjectStore.getState().loadProjectFromDisk(res.dir);
  };

  return (
    <div className="list">
      <div className="explorerHeader">
        <div className="explorerRoot" title={rootDir ?? "未打开项目"}>
          {rootDir ? rootDir : "（未打开项目：当前为内存草稿）"}
        </div>
        <button className="btn btnIcon" type="button" onClick={openProject} disabled={isLoading}>
          打开
        </button>
      </div>

      {error ? <div className="explorerError">打开失败：{error}</div> : null}
      {isLoading ? <div className="explorerHint">正在加载文件…</div> : null}

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


