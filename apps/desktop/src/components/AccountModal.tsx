import { useEffect, useMemo, useState } from "react";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { useAuthStore } from "../state/authStore";

function normalizeGatewayUrlOrEmpty(raw: string) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/\s+/g, "");
  s = s.replace(/^http:\/(?!\/)/i, "http://").replace(/^https:\/(?!\/)/i, "https://");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/g, "");
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function AccountModal(props: { open: boolean; onClose: () => void; onOpenLogin?: () => void }) {
  const open = props.open;
  const user = useAuthStore((s) => s.user);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const logout = useAuthStore((s) => s.logout);
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const refreshPoints = useAuthStore((s) => s.refreshPoints);
  const listTransactions = useAuthStore((s) => s.listTransactions);

  const [gatewayOverride, setGatewayOverride] = useState("");

  const [txOpen, setTxOpen] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [txs, setTxs] = useState<any[]>([]);

  useEffect(() => {
    if (!open) return;
    setTxOpen(false);
    setTxs([]);
    setTxBusy(false);

    try {
      setGatewayOverride(String(window.localStorage.getItem("writing-ide.gatewayUrl") ?? ""));
    } catch {
      setGatewayOverride("");
    }

    void refreshMe().catch(() => void 0);
    void refreshPoints().catch(() => void 0);
  }, [open, refreshMe, refreshPoints]);

  useEffect(() => {
    if (!open) return;
  }, [open]);

  const gateway = useMemo(() => getGatewayBaseUrl() || "(dev proxy: /api)", []);

  if (!open) return null;

  const onSaveGatewayOverride = () => {
    const v = normalizeGatewayUrlOrEmpty(gatewayOverride);
    try {
      if (!v) window.localStorage.removeItem("writing-ide.gatewayUrl");
      else window.localStorage.setItem("writing-ide.gatewayUrl", v);
    } catch {
      // ignore
    }
    // 关闭再开，确保所有模块读取到最新值（kbStore/gatewayAgent 等）
    props.onClose();
    window.setTimeout(() => window.location.reload(), 50);
  };

  const loadTx = async () => {
    setTxBusy(true);
    try {
      const list = await listTransactions();
      setTxs(list);
    } finally {
      setTxBusy(false);
    }
  };

  return (
    <div className="modalMask" role="dialog" aria-modal="true" onMouseDown={() => props.onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div className="modalTitle">账户 / 登录 / 积分</div>
          <button className="btn" type="button" onClick={() => props.onClose()}>
            关闭
          </button>
        </div>

        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Gateway：{gateway}
        </div>

        {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>连接设置</div>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input className="input" value={gatewayOverride} onChange={(e) => setGatewayOverride(e.target.value)} placeholder="覆盖 Gateway URL（留空=默认）" style={{ flex: 1 }} />
            <button className="btn" type="button" onClick={onSaveGatewayOverride}>
              保存并重载
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            说明：写入 localStorage `writing-ide.gatewayUrl`，用于切换到你的自部署 Gateway。
          </div>
        </div>

        {!user ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>当前账号</div>
            <div className="muted" style={{ marginTop: 6 }}>
              当前未登录。请点击左下角头像/“未登录”打开登录窗口。
            </div>
            {typeof props.onOpenLogin === "function" ? (
              <button
                className="btn primary"
                type="button"
                style={{ marginTop: 12 }}
                onClick={() => {
                  props.onClose();
                  props.onOpenLogin?.();
                }}
              >
                去登录
              </button>
            ) : null}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>当前账号</div>
            <div className="modelFieldsGrid" style={{ gridTemplateColumns: "repeat(2, minmax(240px, 1fr))" }}>
              <label className="field">
                <div className="label">手机号</div>
                <div style={{ fontWeight: 700 }}>{user.phone ?? "（未绑定）"}</div>
              </label>
              <label className="field">
                <div className="label">邮箱（保留位置）</div>
                <div style={{ fontWeight: 700 }}>{user.email ?? "（未绑定）"}</div>
              </label>
              <label className="field">
                <div className="label">积分余额</div>
                <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{user.pointsBalance ?? 0}</div>
              </label>
              <label className="field">
                <div className="label">角色</div>
                <div style={{ fontWeight: 700 }}>{user.role}</div>
              </label>
              <label className="field">
                <div className="label">User ID</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {user.id}
                </div>
              </label>
            </div>

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => void refreshPoints()} disabled={busy}>
                刷新积分
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setTxOpen((x) => !x);
                  if (!txOpen) void loadTx();
                }}
                disabled={busy}
              >
                {txOpen ? "收起流水" : "查看流水"}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  logout();
                  props.onClose();
                }}
              >
                退出登录
              </button>
            </div>

            {txOpen ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>积分流水</div>
                {txBusy ? (
                  <div className="muted">加载中…</div>
                ) : txs.length ? (
                  <div className="refList" style={{ maxHeight: 280 }}>
                    {txs.map((t) => (
                      <div key={String(t.id)} className="refItem" style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>
                            {String(t.type ?? "")}{" "}
                            <span style={{ fontVariantNumeric: "tabular-nums", color: Number(t.delta) < 0 ? "rgba(220,38,38,.95)" : "rgba(22,163,74,.95)" }}>
                              {Number(t.delta) < 0 ? "" : "+"}
                              {Number(t.delta) || 0}
                            </span>
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {fmtTime(String(t.createdAt ?? ""))}
                            {t.reason ? ` · ${String(t.reason)}` : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted">暂无流水</div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}


