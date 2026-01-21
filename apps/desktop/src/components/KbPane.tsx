import { useEffect, useMemo, useState } from "react";
import { useKbStore } from "../state/kbStore";
import { useRunStore } from "../state/runStore";

export function KbPane() {
  const baseDir = useKbStore((s) => s.baseDir);
  const isLoading = useKbStore((s) => s.isLoading);
  const error = useKbStore((s) => s.error);
  const lastImportAt = useKbStore((s) => s.lastImportAt);
  const pickBaseDir = useKbStore((s) => s.pickBaseDir);
  const openKbManager = useKbStore((s) => s.openKbManager);
  const refreshLibraries = useKbStore((s) => s.refreshLibraries);
  const libraries = useKbStore((s) => s.libraries);
  const currentLibraryId = useKbStore((s) => s.currentLibraryId);
  const setCurrentLibrary = useKbStore((s) => s.setCurrentLibrary);

  const attached = useRunStore((s) => s.kbAttachedLibraryIds ?? []);
  const toggleAttached = async (id: string) => {
    // 确保库元信息（purpose/facetPack 等）已加载，否则 Context Pack 里可能只有 {id,name:id} 导致 Gateway 闸门无法识别风格库
    await refreshLibraries().catch(() => void 0);
    const libId = String(id ?? "").trim();
    if (!libId) return;

    // 用 getState 确保拿到 refresh 后的最新元信息
    const libs = useKbStore.getState().libraries ?? [];
    const libById = new Map(libs.map((l: any) => [String(l.id ?? "").trim(), l]));
    const isStyle = String(libById.get(libId)?.purpose ?? "") === "style";

    const cur = (useRunStore.getState().kbAttachedLibraryIds ?? []).map((x: any) => String(x ?? "").trim()).filter(Boolean);
    const has = cur.includes(libId);
    if (has) {
      useRunStore.getState().setKbAttachedLibraries(cur.filter((x: string) => x !== libId));
      return;
    }

    if (isStyle) {
      // 风格库：单选（切换风格库时自动替换旧风格库，避免多风格混用导致“乱写/不稳定”）
      const styleIds = new Set(
        libs
          .filter((l: any) => String(l?.purpose ?? "") === "style")
          .map((l: any) => String(l.id ?? "").trim())
          .filter(Boolean),
      );
      const keep = cur.filter((x: string) => !styleIds.has(x));
      useRunStore.getState().setKbAttachedLibraries([...keep, libId]);
      return;
    }

    // 素材/产品库：允许多选
    useRunStore.getState().setKbAttachedLibraries([...cur, libId]);
  };

  const [msg, setMsg] = useState<string>("");
  const currentName = useMemo(() => libraries.find((l) => l.id === currentLibraryId)?.name ?? "", [libraries, currentLibraryId]);
  const attachedNames = useMemo(() => {
    const map = new Map(libraries.map((l) => [l.id, l.name]));
    return (attached ?? []).map((id: string) => map.get(id) ?? id).filter(Boolean);
  }, [attached, libraries]);

  // 选择/恢复 KB 目录后，自动刷新库列表（避免必须手动点“刷新库”）
  useEffect(() => {
    if (!baseDir) return;
    void refreshLibraries().catch(() => void 0);
  }, [baseDir, refreshLibraries]);

  return (
    <div className="list">
      <div className="explorerHint" style={{ padding: "0 2px 8px" }}>
        本地知识库：左侧只管理“库”，写作时把库关联到右侧 Agent（需要引用时再检索）。
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

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="ctxPill">
            当前库：{currentLibraryId ? currentName || currentLibraryId : "（未选择）"}
          </span>
          <span className="ctxPill" title={attachedNames.join("、") || ""}>
            右侧已关联：{(attached ?? []).length || 0} 个库
          </span>
        </div>

        {msg ? <div className="explorerHint">{msg}</div> : null}
        {lastImportAt ? <div className="explorerHint">最近导入：{new Date(lastImportAt).toLocaleString()}</div> : null}
        {error ? <div className="explorerError">KB 错误：{error}</div> : null}
        {isLoading ? <div className="explorerHint">处理中…</div> : null}
      </div>

      {baseDir ? (
        <div style={{ display: "grid", gap: 10, padding: "0 2px 10px" }}>
          {libraries.length ? (
            libraries.map((l) => {
              const isCur = l.id === currentLibraryId;
              const isAttached = (attached ?? []).includes(l.id);
              return (
                <div key={l.id} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)", padding: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
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
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <button
                        className={`btn btnIcon ${isCur ? "btnPrimary" : ""}`}
                        type="button"
                        onClick={() => {
                          setCurrentLibrary(isCur ? null : l.id);
                          setMsg(isCur ? "已取消当前库选择：导入/抽卡前需要重新选择库。" : "");
                        }}
                        disabled={isLoading}
                      >
                        {isCur ? "当前库" : "设为当前"}
                      </button>
                      <button
                        className={`btn btnIcon ${isAttached ? "btnPrimary" : ""}`}
                        type="button"
                        onClick={() => void toggleAttached(l.id)}
                        disabled={isLoading}
                        title="关联到右侧 Agent（素材/产品库可多选；风格库默认单选，会替换已有风格库）"
                      >
                        {isAttached ? "已关联" : "关联到右侧"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="explorerHint">
              还没有任何库。点击上方「库管理…」新建库，并选择为当前库后才能导入语料/抽卡。
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}


