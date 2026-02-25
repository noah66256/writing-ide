import { useEffect } from "react";
import { useKbStore } from "../state/kbStore";

export function KbPane() {
  const baseDir = useKbStore((s) => s.baseDir);
  const isLoading = useKbStore((s) => s.isLoading);
  const error = useKbStore((s) => s.error);
  const lastImportAt = useKbStore((s) => s.lastImportAt);
  const pickBaseDir = useKbStore((s) => s.pickBaseDir);
  const openKbManager = useKbStore((s) => s.openKbManager);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const libraries = useKbStore((s) => s.libraries);

  // 选择/恢复 KB 目录后，自动刷新库列表
  useEffect(() => {
    if (!baseDir) return;
    void refreshLibraries().catch(() => void 0);
  }, [baseDir, refreshLibraries]);

  return (
    <div className="list">
      <div className="explorerHint" style={{ padding: "0 2px 8px" }}>
        本地知识库：在输入框 @ 提及库名即可按需检索。
      </div>

      <div style={{ display: "grid", gap: 8, padding: "0 2px 10px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btnIcon" type="button" onClick={() => void pickBaseDir()} disabled={isLoading}>
            {baseDir ? "更换 KB 目录" : "选择 KB 目录"}
          </button>
          <button className="btn btnIcon" type="button" onClick={() => openKbManager("libraries")} disabled={!baseDir}>
            库管理…
          </button>
          <button className="btn btnIcon" type="button" onClick={() => void refreshLibraries()} disabled={isLoading || !baseDir}>
            刷新库
          </button>
        </div>

        <div className="explorerRoot" title={baseDir ?? "未设置 KB 目录"}>
          {baseDir ? `KB 目录：${baseDir}` : "未设置 KB 目录（请先选择）"}
        </div>

        {lastImportAt ? <div className="explorerHint">最近导入：{new Date(lastImportAt).toLocaleString()}</div> : null}
        {error ? <div className="explorerError">KB 错误：{error}</div> : null}
        {isLoading ? <div className="explorerHint">处理中…</div> : null}
      </div>

      {baseDir ? (
        <div style={{ display: "grid", gap: 10, padding: "0 2px 10px" }}>
          {libraries.length ? (
            libraries.map((l) => (
              <div key={l.id} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", padding: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.name}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    文档 {l.docCount} 篇 · 更新 {l.updatedAt ? new Date(l.updatedAt).toLocaleString() : "-"} · 用途{" "}
                    {l.purpose === "style" ? "风格库" : l.purpose === "product" ? "产品库" : "素材库"}
                  </div>
                  {l.fingerprint ? (
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span className="ctxPill" title={`体裁/声音识别置信度：${Math.round((l.fingerprint.confidence ?? 0) * 100)}%`}>
                        像：{l.fingerprint.primaryLabel}
                      </span>
                      <span className="ctxPill" title={`体检时间：${new Date(l.fingerprint.computedAt).toLocaleString()}`}>
                        稳定：
                        {l.fingerprint.stability === "high" ? "高" : l.fingerprint.stability === "medium" ? "中" : "低"}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="explorerHint">
              还没有任何库。点击上方「库管理…」新建库。
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
