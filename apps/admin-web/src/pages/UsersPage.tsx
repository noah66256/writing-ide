import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import {
  adminCreateUser,
  adminListUsers,
  adminListUserTransactions,
  adminRechargeUserPoints,
  adminSetUserBillingGroup,
  adminSetUserRole,
  type PointsTransactionDto,
  type UserDto,
  type UserRole,
} from "../api/gateway";

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function UsersPage() {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [createEmail, setCreateEmail] = useState("");
  const [createPhone, setCreatePhone] = useState("");
  const [createPoints, setCreatePoints] = useState("0");

  const [drawerUser, setDrawerUser] = useState<UserDto | null>(null);
  const [txs, setTxs] = useState<PointsTransactionDto[]>([]);
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState("");

  const refresh = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await adminListUsers();
      setUsers(res.users ?? []);
    } catch (e: any) {
      const err = e as ApiError;
      setError(`加载用户失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreateUser = async () => {
    const email = createEmail.trim();
    const phone = createPhone.trim();
    const pointsBalance = Math.max(0, Math.floor(Number(createPoints) || 0));
    if (!email && !phone) {
      alert("请填写 email 或 phone（至少一个）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await adminCreateUser({ email: email || undefined, phone: phone || undefined, pointsBalance });
      setCreateEmail("");
      setCreatePhone("");
      setCreatePoints("0");
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`创建用户失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return users;
    return users.filter((u) => {
      const email = String(u.email ?? "").toLowerCase();
      const phone = String((u as any).phone ?? "").toLowerCase();
      const id = String(u.id ?? "").toLowerCase();
      return email.includes(kw) || phone.includes(kw) || id.includes(kw);
    });
  }, [users, q]);

  const onToggleRole = async (u: UserDto) => {
    const next: UserRole = u.role === "admin" ? "user" : "admin";
    const label = String(u.phone ?? u.email ?? u.id);
    if (!confirm(`确认把 ${label} 的角色改为 ${next}？`)) return;
    setBusy(true);
    setError("");
    try {
      await adminSetUserRole({ userId: u.id, role: next });
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`改角色失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const onSetBillingGroup = async (u: UserDto) => {
    const cur = String((u as any).billingGroup ?? "").trim();
    const nextRaw = prompt("设置计费分组（留空=normal）", cur || "normal");
    if (nextRaw === null) return;
    const next = nextRaw.trim() || "normal";
    setBusy(true);
    setError("");
    try {
      await adminSetUserBillingGroup({ userId: u.id, billingGroup: next });
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`设置分组失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const onRecharge = async (u: UserDto) => {
    const pointsRaw = prompt("充值积分（正整数）", "1000");
    if (!pointsRaw) return;
    const points = Number(pointsRaw);
    if (!Number.isFinite(points) || points <= 0) {
      alert("积分必须是正数");
      return;
    }
    const reason = prompt("备注（可选）", "admin_recharge") ?? undefined;
    setBusy(true);
    setError("");
    try {
      await adminRechargeUserPoints({ userId: u.id, points: Math.floor(points), reason: reason?.trim() || undefined });
      await refresh();
    } catch (e: any) {
      const err = e as ApiError;
      setError(`充值失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const openTransactions = async (u: UserDto) => {
    setDrawerUser(u);
    setTxs([]);
    setTxError("");
    setTxBusy(true);
    try {
      const res = await adminListUserTransactions({ userId: u.id });
      setTxs(res.transactions ?? []);
    } catch (e: any) {
      const err = e as ApiError;
      setTxError(`加载流水失败：${err.code}`);
    } finally {
      setTxBusy(false);
    }
  };

  return (
    <div className="usersPage">
      <div className="pageHeader">
        <div className="pageTitle">用户管理</div>
        <div className="pageActions">
          <input className="input" placeholder="搜索 phone / email / id" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>创建用户（自救入口）</div>
        <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
          如果这里显示“暂无数据”，通常是用户库被重置/新环境还没有用户登录过。你可以先在这里创建用户，再用“充值”给积分。
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            placeholder="email（可选）"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            style={{ minWidth: 220 }}
            disabled={busy}
          />
          <input
            className="input"
            placeholder="phone（可选，数字即可）"
            value={createPhone}
            onChange={(e) => setCreatePhone(e.target.value)}
            style={{ minWidth: 180 }}
            disabled={busy}
          />
          <input
            className="input"
            placeholder="初始积分（默认0）"
            value={createPoints}
            onChange={(e) => setCreatePoints(e.target.value)}
            style={{ width: 160 }}
            disabled={busy}
          />
          <button className="btn" type="button" onClick={() => void onCreateUser()} disabled={busy}>
            创建
          </button>
        </div>
      </div>

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>分组</th>
              <th>积分</th>
              <th>创建时间</th>
              <th style={{ width: 240 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{u.phone ?? u.email ?? "（无）"}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {u.email ? `email: ${u.email}` : "email: （未绑定）"} · {u.phone ? `phone: ${u.phone}` : "phone: （未绑定）"} · {u.id}
                  </div>
                </td>
                <td>
                  <span className={`pill ${u.role === "admin" ? "pillAdmin" : "pillUser"}`}>{u.role}</span>
                </td>
                <td className="muted">{String((u as any).billingGroup ?? "normal")}</td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{u.pointsBalance ?? 0}</td>
                <td className="muted">{fmtTime(u.createdAt)}</td>
                <td>
                  <div className="row">
                    <button className="btn" type="button" disabled={busy} onClick={() => void openTransactions(u)}>
                      流水
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(u.id).catch(() => void 0);
                      }}
                    >
                      复制ID
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => void onSetBillingGroup(u)}>
                      分组
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => void onRecharge(u)}>
                      充值
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => void onToggleRole(u)}>
                      改角色
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filtered.length ? (
              <tr>
                <td colSpan={6} className="muted" style={{ padding: 16 }}>
                  {busy ? "加载中…" : "暂无数据"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {drawerUser ? (
        <div className="drawerMask" onClick={() => setDrawerUser(null)} role="presentation">
          <div className="drawer" onClick={(e) => e.stopPropagation()} role="presentation">
            <div className="drawerHeader">
              <div style={{ fontWeight: 700 }}>积分流水</div>
              <button className="btn" type="button" onClick={() => setDrawerUser(null)}>
                关闭
              </button>
            </div>

            <div className="muted" style={{ marginBottom: 8 }}>
              {drawerUser.phone ?? drawerUser.email ?? "（无）"} · {drawerUser.id}
            </div>

            {txError ? <div className="error">{txError}</div> : null}

            <div className="txList">
              {txBusy ? (
                <div className="muted">加载中…</div>
              ) : txs.length ? (
                txs.map((t) => (
                  <div key={t.id} className="txItem">
                    <div className="txTop">
                      <div className="txType">{t.type}</div>
                      <div className={`txDelta ${t.delta < 0 ? "txNeg" : "txPos"}`}>{t.delta}</div>
                    </div>
                    <div className="txMeta muted">
                      {fmtTime(t.createdAt)}
                      {t.reason ? ` · ${t.reason}` : ""}
                    </div>
                    {t.meta !== undefined ? (
                      <details style={{ marginTop: 8 }}>
                        <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                          meta
                        </summary>
                        <pre className="codeBlock" style={{ marginTop: 8 }}>
                          {JSON.stringify(t.meta ?? null, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="muted">暂无流水</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


