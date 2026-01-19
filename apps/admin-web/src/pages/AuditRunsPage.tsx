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
  const [q, setQ] = useState("");
  const [top, setTop] = useState(120);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunAuditDto | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [eventType, setEventType] = useState<string>("all");
  const [eventQ, setEventQ] = useState<string>("");

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
    const kw = q.trim().toLowerCase();
    if (!kw) return runs;
    return runs.filter((r) => {
      const id = String(r.id ?? "").toLowerCase();
      const userId = String(r.userId ?? "").toLowerCase();
      const model = String(r.model ?? "").toLowerCase();
      const endReason = String(r.endReason ?? "").toLowerCase();
      const codes = Array.isArray(r.endReasonCodes) ? r.endReasonCodes.join(" ").toLowerCase() : "";
      return id.includes(kw) || userId.includes(kw) || model.includes(kw) || endReason.includes(kw) || codes.includes(kw);
    });
  }, [runs, q]);

  const detailEvents = useMemo(() => {
    const events = detail?.events ?? [];
    let arr = events;
    if (eventType !== "all") arr = arr.filter((e) => String(e?.event ?? "") === eventType);
    const kw = eventQ.trim().toLowerCase();
    if (!kw) return arr;
    return arr.filter((e) => {
      const hay = `${String(e.event ?? "")} ${JSON.stringify(e.data ?? null)}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [detail, eventType, eventQ]);

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
            placeholder="runId / model / endReason 过滤"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220 }}
          />
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
              <th style={{ width: 180 }}>tools/policy</th>
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
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.eventCount ?? 0}</td>
                <td className="muted" style={{ fontSize: 12, lineHeight: 1.35 }}>
                  <div>
                    tool {r.toolCallCount ?? 0}/{r.toolResultCount ?? 0} · policy {r.policyDecisionCount ?? 0}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span className={`tag ${r.errorCount ? "tagRed" : ""}`}>err {r.errorCount ?? 0}</span>
                    <span className="tag">web {r.webToolCount ?? 0}</span>
                  </div>
                </td>
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
                <td colSpan={10} className="muted" style={{ padding: 16 }}>
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
                  {detail.usage ? (
                    <span className="pill pillUser">
                      tokens: {detail.usage.promptTokens}+{detail.usage.completionTokens}
                    </span>
                  ) : null}
                </div>

                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>events（过滤后 JSON）</div>
                  <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                    <select className="input" value={eventType} onChange={(e) => setEventType(e.target.value)} style={{ width: 180 }}>
                      <option value="all">全部</option>
                      <option value="policy.decision">policy.decision</option>
                      <option value="tool.call">tool.call</option>
                      <option value="tool.result">tool.result</option>
                      <option value="error">error</option>
                      <option value="assistant.delta">assistant.delta</option>
                      <option value="assistant.done">assistant.done</option>
                      <option value="run.start">run.start</option>
                      <option value="run.end">run.end</option>
                    </select>
                    <input className="input" value={eventQ} onChange={(e) => setEventQ(e.target.value)} placeholder="搜索（event/data）" />
                    <button
                      className="btn"
                      type="button"
                      onClick={() => navigator.clipboard.writeText(JSON.stringify(detailEvents ?? [], null, 2)).catch(() => void 0)}
                    >
                      复制
                    </button>
                  </div>
                  <pre className="codeBlock">{JSON.stringify(detailEvents ?? [], null, 2)}</pre>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}


