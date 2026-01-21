import { useEffect, useMemo, useState } from "react";
import { getGatewayBaseUrl } from "../agent/gatewayUrl";
import { useAuthStore } from "../state/authStore";

export function LoginModal(props: { open: boolean; onClose: () => void }) {
  const open = props.open;
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);

  const requestPhoneCode = useAuthStore((s) => s.requestPhoneCode);
  const verifyPhoneCode = useAuthStore((s) => s.verifyPhoneCode);
  const requestEmailCode = useAuthStore((s) => s.requestEmailCode);
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode);

  const [tab, setTab] = useState<"phone" | "email">("phone");

  const [phone, setPhone] = useState("");
  const [phoneReqId, setPhoneReqId] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneDevCode, setPhoneDevCode] = useState("");

  const [email, setEmail] = useState("");
  const [emailReqId, setEmailReqId] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailDevCode, setEmailDevCode] = useState("");

  const [cooldown, setCooldown] = useState(0);

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
    setCooldown(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (cooldown <= 0) return;
    const id = window.setInterval(() => setCooldown((x) => Math.max(0, x - 1)), 1000);
    return () => window.clearInterval(id);
  }, [open, cooldown]);

  const gateway = useMemo(() => getGatewayBaseUrl() || "(dev proxy: /api)", []);

  if (!open) return null;

  return (
    <div className="modalMask" role="dialog" aria-modal="true" onMouseDown={() => props.onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div className="modalTitle">登录</div>
          <button className="btn" type="button" onClick={() => props.onClose()}>
            关闭
          </button>
        </div>

        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Gateway：{gateway}
        </div>

        {error ? (
          <div className="error" style={{ marginTop: 10 }}>
            {error}
          </div>
        ) : null}

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
                      try {
                        const r = await requestPhoneCode({ phoneNumber: phone.trim(), countryCode: "86" });
                        setPhoneReqId(String(r.requestId ?? ""));
                        setPhoneDevCode(String(r.devCode ?? ""));
                        setCooldown(60);
                      } catch {
                        // error 已写入 store.error
                      }
                    })();
                  }}
                >
                  {busy ? "发送中…" : cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
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
                      try {
                        await verifyPhoneCode({ phoneNumber: phone.trim(), countryCode: "86", requestId: phoneReqId, code: phoneCode.trim() });
                        props.onClose();
                      } catch {
                        // error 已写入 store.error
                      }
                    })();
                  }}
                >
                  {busy ? "登录中…" : "登录"}
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
                      try {
                        const r = await requestEmailCode(email.trim());
                        setEmailReqId(String(r.requestId ?? ""));
                        setEmailDevCode(String(r.devCode ?? ""));
                        setCooldown(60);
                      } catch {
                        // error 已写入 store.error
                      }
                    })();
                  }}
                >
                  {busy ? "发送中…" : cooldown > 0 ? `重发(${cooldown}s)` : "发送验证码"}
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
                      try {
                        await verifyEmailCode({ email: email.trim(), requestId: emailReqId, code: emailCode.trim() });
                        props.onClose();
                      } catch {
                        // error 已写入 store.error
                      }
                    })();
                  }}
                >
                  {busy ? "登录中…" : "登录"}
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
      </div>
    </div>
  );
}


