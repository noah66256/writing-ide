import { useEffect, useState } from "react";
import "./App.css";
import { clearAccessToken, getAccessToken, setAccessToken, type ApiError } from "./api/client";
import { getMe } from "./api/gateway";
import { AdminLayout, type AdminPageKey } from "./components/AdminLayout";
import { AuditRunsPage } from "./pages/AuditRunsPage";
import { LlmPage } from "./pages/LlmPage";
import { LoginPage } from "./pages/LoginPage";
import { ToolsPage } from "./pages/ToolsPage";
import { UsersPage } from "./pages/UsersPage";

type Me = { id: string; email: string; role: "admin" | "user"; pointsBalance: number };

function App() {
  const [page, setPage] = useState<AdminPageKey>("users");
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = getAccessToken();
    if (!t) {
      setBooting(false);
      return;
    }
    void (async () => {
      setError("");
      try {
        const res = await getMe();
        setMe(res.user as any);
      } catch (e: any) {
        const err = e as ApiError;
        setError(`登录态失效：${err.code}`);
        clearAccessToken();
        setMe(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  if (booting) {
    return <div className="boot">加载中…</div>;
  }

  if (!getAccessToken()) {
    return (
      <div>
        {error ? <div className="error" style={{ margin: 12 }}>{error}</div> : null}
        <LoginPage
          onLoggedIn={(args) => {
            setAccessToken(args.accessToken);
            setBooting(true);
            void (async () => {
              try {
                const res = await getMe();
                setMe(res.user as any);
              } catch (e: any) {
                const err = e as ApiError;
                setError(`登录失败：${err.code}`);
                clearAccessToken();
                setMe(null);
              } finally {
                setBooting(false);
              }
            })();
          }}
        />
      </div>
    );
  }

  if (!me) {
    return <div className="boot">加载用户信息失败</div>;
  }

  if (me.role !== "admin") {
    return (
      <div className="boot">
        当前账号不是管理员：{me.email}
        <div style={{ marginTop: 12 }}>
          <button
            className="btn"
            type="button"
            onClick={() => {
              clearAccessToken();
              setMe(null);
            }}
          >
            退出登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <AdminLayout
      page={page}
      onNavigate={setPage}
      headerRight={
        <div className="meBox">
          <div className="muted">{me.email}</div>
          <div className="meMeta">
            <span className="pill pillAdmin">admin</span>
            <button
              className="btn"
              type="button"
              onClick={() => {
                clearAccessToken();
                setMe(null);
              }}
            >
              退出
            </button>
          </div>
        </div>
      }
    >
      {page === "users" ? <UsersPage /> : null}
      {page === "llm" ? <LlmPage /> : null}
      {page === "tools" ? <ToolsPage /> : null}
      {page === "audit" ? <AuditRunsPage /> : null}
    </AdminLayout>
  );
}

export default App;
