import { useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { requestEmailCode, verifyEmailCode } from "../api/gateway";

export function LoginPage(props: { onLoggedIn: (args: { accessToken: string }) => void }) {
  const [email, setEmail] = useState("");
  const [requestId, setRequestId] = useState<string>("");
  const [devCode, setDevCode] = useState<string>("");
  const [expiresInSeconds, setExpiresInSeconds] = useState<number>(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const canRequest = useMemo(() => /\S+@\S+\.\S+/.test(email.trim()) && !busy, [email, busy]);
  const canVerify = useMemo(() => requestId && /^\d{6}$/.test(code.trim()) && !busy, [requestId, code, busy]);

  const onRequest = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await requestEmailCode(email.trim());
      setRequestId(res.requestId);
      setExpiresInSeconds(res.expiresInSeconds);
      setDevCode(res.devCode ? String(res.devCode) : "");
    } catch (e: any) {
      const err = e as ApiError;
      setError(`获取验证码失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await verifyEmailCode({ email: email.trim(), requestId, code: code.trim() });
      props.onLoggedIn({ accessToken: res.accessToken });
    } catch (e: any) {
      const err = e as ApiError;
      setError(`登录失败：${err.code}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginPage">
      <div className="loginCard">
        <div className="loginTitle">写作 IDE · 管理后台</div>
        <div className="loginSub">邮箱验证码登录（开发期）</div>

        <label className="field">
          <div className="label">邮箱</div>
          <input
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
          />
        </label>

        <div className="row">
          <button className="btn" type="button" disabled={!canRequest} onClick={onRequest}>
            获取验证码
          </button>
          <div className="muted">
            {requestId ? (
              <>
                requestId: <code>{requestId}</code>（{expiresInSeconds}s）
              </>
            ) : (
              "先获取验证码"
            )}
          </div>
        </div>

        {devCode ? (
          <div className="hint">
            devCode：<code style={{ fontWeight: 700 }}>{devCode}</code>
          </div>
        ) : null}

        <label className="field">
          <div className="label">验证码（6位数字）</div>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
          />
        </label>

        <button className="btn primary" type="button" disabled={!canVerify} onClick={onVerify}>
          登录
        </button>

        {error ? <div className="error">{error}</div> : null}
      </div>
    </div>
  );
}


