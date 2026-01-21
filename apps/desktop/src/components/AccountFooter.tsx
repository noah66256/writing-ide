import { useEffect, useState } from "react";
import { useUpdateStore } from "../state/updateStore";
import { useAuthStore } from "../state/authStore";
import { AccountModal } from "./AccountModal";
import { LoginModal } from "./LoginModal";

export function AccountFooter() {
  const updateAvailable = useUpdateStore((s) => s.updateAvailable);
  const latestVersion = useUpdateStore((s) => s.latestVersion);
  const download = useUpdateStore((s) => s.download);
  const [version, setVersion] = useState<string>("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    void window.desktop?.app
      ?.getVersion?.()
      .then((r: any) => {
        if (r?.ok && r.version) setVersion(String(r.version));
      })
      .catch(() => void 0);
  }, []);

  useEffect(() => {
    // 启动时：若已保存 token，则自动拉取 /api/me（失败会清空 token）
    void useAuthStore.getState().init().catch(() => void 0);
  }, []);

  return (
    <>
    <div className="accountFooter">
      <div
        className="accountAvatar"
        role="button"
        tabIndex={0}
        title={user ? "账户" : "登录"}
        onClick={() => (user ? setAccountOpen(true) : setLoginOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") (user ? setAccountOpen(true) : setLoginOpen(true));
        }}
      >
        <span>我</span>
      </div>
      <div
        className="accountMeta"
        role="button"
        tabIndex={0}
        title={user ? "账户" : "登录"}
        onClick={() => (user ? setAccountOpen(true) : setLoginOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") (user ? setAccountOpen(true) : setLoginOpen(true));
        }}
      >
        <div className="accountName">
          {user ? (user.phone ?? user.email ?? "已登录") : "未登录"}{" "}
          {updateAvailable ? (
            <span className="tag" style={{ marginLeft: 8 }}>
              有更新{latestVersion ? ` v${latestVersion}` : ""}
            </span>
          ) : null}
        </div>
        <div className="accountEmail">
          {user ? (
            <>
              积分 {user.pointsBalance ?? 0}
              <span style={{ marginLeft: 8, color: "var(--muted)" }}>{version ? `Desktop v${version}` : "Desktop"}</span>
            </>
          ) : (
            <>
              {version ? `Desktop v${version}` : "Desktop"}
              {accessToken ? <span style={{ marginLeft: 8, color: "var(--muted)" }}>（登录态异常，点设置重登）</span> : null}
            </>
          )}{" "}
          {download?.running ? (
            <span style={{ marginLeft: 8, color: "var(--muted)" }}>
              下载中…{download.total > 0 ? `${Math.floor((download.transferred / download.total) * 100)}%` : ""}
            </span>
          ) : null}
        </div>
      </div>
      <button
        className="btn btnIcon"
        type="button"
        title="账户/设置"
        onClick={() => setAccountOpen(true)}
      >
        设置
      </button>
    </div>
    <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
    <AccountModal
      open={accountOpen}
      onClose={() => setAccountOpen(false)}
      onOpenLogin={() => {
        setAccountOpen(false);
        setLoginOpen(true);
      }}
    />
    </>
  );
}











