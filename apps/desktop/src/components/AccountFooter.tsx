import { useEffect, useState } from "react";
import { useUpdateStore } from "../state/updateStore";
import { getUpdateBaseUrl } from "../agent/updateBaseUrl";

export function AccountFooter() {
  const updateAvailable = useUpdateStore((s) => s.updateAvailable);
  const latestVersion = useUpdateStore((s) => s.latestVersion);
  const download = useUpdateStore((s) => s.download);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    void window.desktop?.app
      ?.getVersion?.()
      .then((r: any) => {
        if (r?.ok && r.version) setVersion(String(r.version));
      })
      .catch(() => void 0);
  }, []);

  return (
    <div className="accountFooter">
      <div className="accountAvatar" aria-hidden="true">
        <span>我</span>
      </div>
      <div className="accountMeta">
        <div className="accountName">
          未登录{" "}
          {updateAvailable ? (
            <span className="tag" style={{ marginLeft: 8 }}>
              有更新{latestVersion ? ` v${latestVersion}` : ""}
            </span>
          ) : null}
        </div>
        <div className="accountEmail">
          {version ? `Desktop v${version}` : "Desktop"}{" "}
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
        title="检查更新"
        onClick={() => void window.desktop?.update?.checkInteractive?.({ baseUrl: getUpdateBaseUrl() })}
      >
        设置
      </button>
    </div>
  );
}











