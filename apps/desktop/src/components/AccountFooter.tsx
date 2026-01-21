import { useEffect, useState } from "react";
import { useUpdateStore } from "../state/updateStore";
import { useAuthStore } from "../state/authStore";
import { AccountModal } from "./AccountModal";

export function AccountFooter() {
  const updateAvailable = useUpdateStore((s) => s.updateAvailable);
  const latestVersion = useUpdateStore((s) => s.latestVersion);
  const download = useUpdateStore((s) => s.download);
  const [version, setVersion] = useState<string>("");
  const [open, setOpen] = useState(false);

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
      <div className="accountAvatar" aria-hidden="true">
        <span>我</span>
      </div>
      <div className="accountMeta">
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
        onClick={() => setOpen(true)}
      >
        设置
      </button>
    </div>
    <AccountModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}











