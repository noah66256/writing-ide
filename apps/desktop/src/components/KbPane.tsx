import { useMemo, useState } from "react";
import { useKbStore } from "../state/kbStore";
import { facetLabel } from "../kb/facets";

type KbTabKey = "card" | "paragraph" | "outline";

export function KbPane() {
  const baseDir = useKbStore((s) => s.baseDir);
  const isLoading = useKbStore((s) => s.isLoading);
  const error = useKbStore((s) => s.error);
  const lastImportAt = useKbStore((s) => s.lastImportAt);
  const query = useKbStore((s) => s.query);
  const setQuery = useKbStore((s) => s.setQuery);
  const groups = useKbStore((s) => s.groups);
  const pickBaseDir = useKbStore((s) => s.pickBaseDir);
  const search = useKbStore((s) => s.search);
  const importExternalFiles = useKbStore((s) => s.importExternalFiles);
  const openCardJobsModal = useKbStore((s) => s.openCardJobsModal);
  const enqueueCardJobs = useKbStore((s) => s.enqueueCardJobs);

  const [importMsg, setImportMsg] = useState<string>("");
  const [tab, setTab] = useState<KbTabKey>("card");

  const canPickFiles = Boolean(window.desktop?.kb?.pickFiles);
  const tabLabel = tab === "card" ? "卡片" : tab === "paragraph" ? "段落" : "大纲";
  const tabPlaceholder = tab === "card" ? "搜索卡片…" : tab === "paragraph" ? "搜索段落…" : "搜索大纲…";

  const runSearch = async (nextTab?: KbTabKey) => {
    const kind = (nextTab ?? tab) as any;
    await search(query, { kind });
  };

  const onPickFiles = async () => {
    setImportMsg("");
    const kb = window.desktop?.kb;
    if (!kb) return;
    if (!baseDir) {
      await pickBaseDir();
      if (!useKbStore.getState().baseDir) return;
    }
    const ret = await kb.pickFiles({
      title: "导入到知识库（MD / DOCX / PDF）",
      multi: true,
      filters: [
        { name: "Markdown / 文本", extensions: ["md", "mdx", "txt"] },
        { name: "Word", extensions: ["docx"] },
        { name: "PDF", extensions: ["pdf"] },
      ],
    });
    if (!ret?.ok || !ret.files?.length) return;
    const r = await importExternalFiles(ret.files);
    await enqueueCardJobs(r.docIds, { open: true, autoStart: true });
    setImportMsg(`导入完成：新增 ${r.imported}，跳过 ${r.skipped}；已加入抽卡队列 ${r.docIds.length} 篇。`);
    await runSearch();
  };

  const summary = useMemo(() => {
    const docs = groups.length;
    const hits = groups.reduce((acc, g) => acc + g.hits.length, 0);
    return { docs, hits };
  }, [groups]);

  return (
    <div className="list">
      <div className="explorerHint" style={{ padding: "0 2px 8px" }}>
        本地知识库（MVP）：离线可浏览/检索；抽卡需要联网并配置 LLM。
      </div>

      <div style={{ display: "grid", gap: 8, padding: "0 2px 10px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btnIcon" type="button" onClick={() => void pickBaseDir()} disabled={isLoading}>
            {baseDir ? "更换 KB 目录" : "选择 KB 目录"}
          </button>
          <button className="btn btnIcon" type="button" onClick={() => void onPickFiles()} disabled={isLoading || !canPickFiles}>
            导入语料（MD / DOCX / PDF）
          </button>
          <button className="btn btnIcon" type="button" onClick={openCardJobsModal} disabled={!baseDir}>
            抽卡任务…
          </button>
          <button className="btn btnIcon" type="button" onClick={() => void runSearch()} disabled={isLoading || !baseDir}>
            刷新
          </button>
        </div>

        <div className="explorerRoot" title={baseDir ?? "未设置 KB 目录"}>
          {baseDir ? `KB 目录：${baseDir}` : "未设置 KB 目录（请先选择）"}
        </div>

        <div className="dockTabs" style={{ padding: 0, borderBottom: "none" }}>
          <div
            className={`dockTab ${tab === "card" ? "dockTabActive" : ""}`}
            onClick={() => {
              const next: KbTabKey = "card";
              setTab(next);
              void runSearch(next);
            }}
          >
            卡片
          </div>
          <div
            className={`dockTab ${tab === "paragraph" ? "dockTabActive" : ""}`}
            onClick={() => {
              const next: KbTabKey = "paragraph";
              setTab(next);
              void runSearch(next);
            }}
          >
            段落
          </div>
          <div
            className={`dockTab ${tab === "outline" ? "dockTabActive" : ""}`}
            onClick={() => {
              const next: KbTabKey = "outline";
              setTab(next);
              void runSearch(next);
            }}
          >
            大纲
          </div>
        </div>

        <input
          className="treeSearch"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tabPlaceholder}
          disabled={isLoading || !baseDir}
        />

        {importMsg ? <div className="explorerHint">{importMsg}</div> : null}
        {lastImportAt ? <div className="explorerHint">最近导入：{new Date(lastImportAt).toLocaleString()}</div> : null}
        {error ? <div className="explorerError">KB 错误：{error}</div> : null}
        {isLoading ? <div className="explorerHint">处理中…</div> : null}
      </div>

      {groups.length ? (
        <div className="explorerHint" style={{ padding: "0 2px 8px" }}>
          命中：文档 {summary.docs} 篇，{tabLabel} {summary.hits} 条（按文档分组）
        </div>
      ) : null}

      {groups.length ? (
        <div style={{ display: "grid", gap: 10, padding: "0 2px 10px" }}>
          {groups.map((g) => (
            <div key={g.sourceDoc.id} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)" }}>
              <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {g.sourceDoc.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {g.sourceDoc.format} · best {Math.round(g.bestScore)}
                </div>
              </div>
              <div style={{ padding: "10px", display: "grid", gap: 8 }}>
                {g.hits.map((h) => (
                  <div key={h.artifact.id} style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {h.artifact.kind}
                      {h.artifact.kind === "card" && (h.artifact as any).title ? ` · ${(h.artifact as any).title}` : ""}
                      {h.artifact.kind === "card" && (h.artifact as any).cardType ? ` · ${(h.artifact as any).cardType}` : ""}
                      {Array.isArray(h.artifact.anchor?.headingPath) && h.artifact.anchor.headingPath.length
                        ? ` · ${h.artifact.anchor.headingPath.join(" > ")}`
                        : ""}
                      {typeof h.artifact.anchor?.paragraphIndex === "number" ? ` · 段落 ${h.artifact.anchor.paragraphIndex}` : ""}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", whiteSpace: "pre-wrap" }}>{h.snippet}</div>
                    {h.artifact.kind === "card" && Array.isArray(h.artifact.facetIds) && h.artifact.facetIds.length ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                        {h.artifact.facetIds.slice(0, 8).map((id) => (
                          <span key={id} className="ctxPill" title={id}>
                            {facetLabel(id)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : query.trim() && !isLoading ? (
        <div className="explorerHint">无匹配结果。</div>
      ) : null}
    </div>
  );
}


