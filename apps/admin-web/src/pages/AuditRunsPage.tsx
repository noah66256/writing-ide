import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { adminGetAuditRun, adminListAuditRuns, type RunAuditDto, type RunAuditKind, type RunAuditListItemDto } from "../api/gateway";

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtShortId(id: string) {
  const s = String(id ?? "");
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function AuditRunsPage() {
  const [runs, setRuns] = useState<RunAuditListItemDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [kind, setKind] = useState<RunAuditKind | "all">("all");
  const [qUser, setQUser] = useState("");
  const [top, setTop] = useState(120);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunAuditDto | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await adminListAuditRuns({
        top,
        ...(kind !== "all" ? { kind } : {}),
        ...(qUser.trim() ? { userId: qUser.trim() } : {}),
      });
      setRuns(res.runs ?? []);
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载审计失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError("");
    setDetailBusy(true);
    try {
      const res = await adminGetAuditRun({ runId: id });
      setDetail(res.run);
    } catch (e: any) {
      const err = e as ApiError;
      setDetailError(`加载详情失败：${err.code}`);
    } finally {
      setDetailBusy(false);
    }
  };

  const filtered = useMemo(() => {
    return runs;
  }, [runs]);

  return (
    <div className="usersPage">
      <div className="pageHeader">
        <div className="pageTitle">Run 审计</div>
        <div className="pageActions" style={{ gap: 8 }}>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as any)} style={{ width: 140 }}>
            <option value="all">全部</option>
            <option value="agent.run">agent.run</option>
            <option value="llm.chat">llm.chat</option>
          </select>
          <input
            className="input"
            placeholder="userId 过滤（可选）"
            value={qUser}
            onChange={(e) => setQUser(e.target.value)}
            style={{ width: 220 }}
          />
          <input
            className="input"
            placeholder="top"
            value={String(top)}
            onChange={(e) => setTop(Math.max(1, Math.min(500, Number(e.target.value) || 120)))}
            style={{ width: 80 }}
          />
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>时间</th>
              <th style={{ width: 110 }}>kind</th>
              <th style={{ width: 80 }}>mode</th>
              <th style={{ width: 120 }}>model</th>
              <th>userId</th>
              <th style={{ width: 140 }}>end</th>
              <th style={{ width: 110 }}>charged</th>
              <th style={{ width: 100 }}>events</th>
              <th style={{ width: 120 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={selectedId === r.id ? { background: "rgba(59, 130, 246, 0.08)" } : undefined}>
                <td className="muted">{fmtTime(r.startedAt)}</td>
                <td>
                  <span className={`pill ${r.kind === "agent.run" ? "pillAdmin" : "pillUser"}`}>{r.kind}</span>
                </td>
                <td className="muted">{r.mode}</td>
                <td className="muted">{r.model ?? "-"}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.userId ?? "-"}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.endReason ?? "-"}
                </td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.chargedPoints ?? 0}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{(r as any).eventCount ?? 0}</td>
                <td>
                  <div className="row">
                    <button className="btn" type="button" onClick={() => void openDetail(r.id)} disabled={detailBusy}>
                      详情
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(r.id).catch(() => void 0);
                      }}
                    >
                      复制ID
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 16 }}>
                  {busy ? "加载中…" : "暂无数据"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedId ? (
        <div className="drawerMask" onClick={() => setSelectedId(null)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 700 }}>Run 详情</div>
              <div className="row" style={{ gap: 8 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {fmtShortId(selectedId)}
                </div>
                <button className="btn" type="button" onClick={() => setSelectedId(null)}>
                  关闭
                </button>
              </div>
            </div>

            {detailError ? <div className="error">{detailError}</div> : null}
            {detailBusy ? <div className="muted">加载中…</div> : null}

            {detail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {detail.kind} · {detail.mode} · {detail.model ?? "-"} · {detail.endpoint ?? "-"}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="pill pillUser">reason: {detail.endReason ?? "-"}</span>
                  <span className="pill pillUser">charged: {detail.chargedPoints ?? 0}</span>
                  <span className="pill pillUser">events: {detail.events?.length ?? 0}</span>
                </div>

                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>events（JSON）</div>
                  <pre className="codeBlock">{JSON.stringify(detail.events ?? [], null, 2)}</pre>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}


