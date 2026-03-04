import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { adminListMarketplaceRecords, type MarketplaceRecordViewDto } from "../api/gateway";

export function MarketplacePage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [records, setRecords] = useState<MarketplaceRecordViewDto[]>([]);
  const [source, setSource] = useState<"db" | "seeded" | "">("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "skill" | "mcp_server" | "sub_agent">("all");
  const [selectedId, setSelectedId] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const ret = await adminListMarketplaceRecords();
      const list = Array.isArray(ret.records) ? ret.records : [];
      setRecords(list);
      setSource(ret.source ?? "");
      setUpdatedAt(ret.updatedAt ?? "");
      if (list.length > 0 && !selectedId) setSelectedId(String(list[0]?.manifest?.id ?? ""));
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载市场数据失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(
    () => records.filter((x) => typeFilter === "all" || String(x?.manifest?.type ?? "") === typeFilter),
    [records, typeFilter],
  );
  const selected = filtered.find((x) => String(x?.manifest?.id ?? "") === selectedId) ?? filtered[0] ?? null;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <div className="pageTitle">市场（只读）</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            数据源：{source || "-"} · 更新时间：{updatedAt ? new Date(updatedAt).toLocaleString() : "-"}
          </div>
        </div>
        <div className="pageActions">
          <button className="btn" type="button" onClick={() => setTypeFilter("all")}>全部</button>
          <button className="btn" type="button" onClick={() => setTypeFilter("skill")}>Skill</button>
          <button className="btn" type="button" onClick={() => setTypeFilter("mcp_server")}>MCP</button>
          <button className="btn" type="button" onClick={() => setTypeFilter("sub_agent")}>Sub-Agent</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void refresh(); }}>
            {busy ? "刷新中..." : "刷新"}
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="row" style={{ alignItems: "stretch", gap: 12 }}>
        <div className="tableWrap" style={{ flex: 1, minWidth: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>版本</th>
                <th>来源</th>
                <th>发布者</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const id = String(r?.manifest?.id ?? "");
                const active = selected && String(selected?.manifest?.id ?? "") === id;
                return (
                  <tr
                    key={`${id}@${String(r?.manifest?.version ?? "")}`}
                    onClick={() => setSelectedId(id)}
                    style={{ cursor: "pointer", background: active ? "#f8fafc" : undefined }}
                  >
                    <td>
                      <div style={{ fontWeight: 700 }}>{r.manifest.name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{r.manifest.id}</div>
                    </td>
                    <td>{r.manifest.type}</td>
                    <td>{r.manifest.version}</td>
                    <td>{r.manifest.source}</td>
                    <td>{r.manifest.publisher}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">暂无数据</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="tableWrap" style={{ width: 420, maxWidth: "45vw" }}>
          <div style={{ padding: 12 }}>
            <div className="pageTitle" style={{ fontSize: 14 }}>详情</div>
            {!selected ? (
              <div className="muted" style={{ marginTop: 8 }}>请选择一条记录</div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ marginBottom: 8 }}>{selected.manifest.description}</div>
                <pre className="codeBlock" style={{ maxHeight: "70vh" }}>
                  {JSON.stringify(selected, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

