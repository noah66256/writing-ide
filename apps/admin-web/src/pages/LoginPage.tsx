import { useMemo, useState } from "react";
import type { ApiError } from "../api/client";
import { adminLogin } from "../api/gateway";

export function LoginPage(props: { onLoggedIn: (args: { accessToken: string }) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const canLogin = useMemo(() => Boolean(username.trim() && password.trim()) && !busy, [username, password, busy]);

  const onLogin = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await adminLogin({ username: username.trim(), password });
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
        <div className="loginSub">管理员账号登录</div>

        <label className="field">
          <div className="label">账号</div>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
            autoComplete="username"
          />
        </label>

        <label className="field">
          <div className="label">密码</div>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </label>

        <button className="btn primary" type="button" disabled={!canLogin} onClick={onLogin}>
          登录
        </button>

        {error ? <div className="error">{error}</div> : null}
      </div>
    </div>
  );
}


