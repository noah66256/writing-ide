import { useEffect, useMemo, useState } from "react";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { useAuthStore } from "../state/authStore";

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function AccountModal(props: { open: boolean; onClose: () => void }) {
  const open = props.open;
  const user = useAuthStore((s) => s.user);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const logout = useAuthStore((s) => s.logout);
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const refreshPoints = useAuthStore((s) => s.refreshPoints);
  const requestPhoneCode = useAuthStore((s) => s.requestPhoneCode);
  const verifyPhoneCode = useAuthStore((s) => s.verifyPhoneCode);
  const requestEmailCode = useAuthStore((s) => s.requestEmailCode);
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode);
  const listTransactions = useAuthStore((s) => s.listTransactions);

  const [tab, setTab] = useState<"phone" | "email">( "phone" );
  const [gatewayOverride, setGatewayOverride] = useState("");

  const [phone, setPhone] = useState("");
  const [phoneReqId, setPhoneReqId] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneDevCode, setPhoneDevCode] = useState("");

  const [email, setEmail] = useState("");
  const [emailReqId, setEmailReqId] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailDevCode, setEmailDevCode] = useState("");

  const [cooldown, setCooldown] = useState(0);

  const [txOpen, setTxOpen] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [txs, setTxs] = useState<any[]>([]);

  useEffect(() => {
    if (!open) return;
    setTab("phone");
    setPhone("");
    setPhoneReqId("");
    setPhoneCode("");
    setPhoneDevCode("");
    setEmail("");
    setEmailReqId("");
    setEmailCode("");
    setEmailDevCode("");
    setTxOpen(false);
    setTxs([]);
    setTxBusy(false);
    setCooldown(0);

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
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((x) => Math.max(0, x - 1)), 1000);
    return () => window.clearInterval(id);
  }, [open, cooldown]);

  const gateway = useMemo(() => getGatewayBaseUrl() || "(dev proxy: /api)", []);

  if (!open) return null;

  const onSaveGatewayOverride = () => {
    const v = gatewayOverride.trim().replace(/\/+$/g, "");
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
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" type="button" onClick={() => setTab("phone")} disabled={tab === "phone"}>
                手机验证码
              </button>
              <button className="btn" type="button" onClick={() => setTab("email")} disabled={tab === "email"}>
                邮箱验证码（保留）
              </button>
            </div>

            {tab === "phone" ? (
              <div style={{ marginTop: 12 }}>
                <div className="modalDesc">输入手机号获取验证码（国内默认 86）。</div>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="手机号" style={{ flex: 1 }} />
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || cooldown > 0 || !phone.trim()}
                    onClick={() => {
                      void (async () => {
                        const r = await requestPhoneCode({ phoneNumber: phone.trim(), countryCode: "86" });
                        setPhoneReqId(String(r.requestId ?? ""));
                        setPhoneDevCode(String(r.devCode ?? ""));
                        setCooldown(60);
                      })();
                    }}
                  >
                    {cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
                  </button>
                </div>

                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input className="input" value={phoneCode} onChange={(e) => setPhoneCode(e.target.value)} placeholder="验证码" style={{ flex: 1 }} />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !phoneReqId || !phoneCode.trim()}
                    onClick={() => {
                      void (async () => {
                        await verifyPhoneCode({ phoneNumber: phone.trim(), countryCode: "86", requestId: phoneReqId, code: phoneCode.trim() });
                        props.onClose();
                      })();
                    }}
                  >
                    登录
                  </button>
                </div>

                {phoneDevCode ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    devCode: {phoneDevCode}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <div className="modalDesc">邮箱验证码登录（开发期 devCode 会返回；生产需要接入邮件服务）。</div>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱" style={{ flex: 1 }} />
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || cooldown > 0 || !email.trim()}
                    onClick={() => {
                      void (async () => {
                        const r = await requestEmailCode(email.trim());
                        setEmailReqId(String(r.requestId ?? ""));
                        setEmailDevCode(String(r.devCode ?? ""));
                        setCooldown(60);
                      })();
                    }}
                  >
                    {cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
                  </button>
                </div>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <input className="input" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} placeholder="验证码" style={{ flex: 1 }} />
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !emailReqId || !emailCode.trim()}
                    onClick={() => {
                      void (async () => {
                        await verifyEmailCode({ email: email.trim(), requestId: emailReqId, code: emailCode.trim() });
                        props.onClose();
                      })();
                    }}
                  >
                    登录
                  </button>
                </div>
                {emailDevCode ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    devCode: {emailDevCode}
                  </div>
                ) : null}
              </div>
            )}
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


