import { useEffect, useState } from "react";
import {
  adminListBackups,
  adminCreateBackup,
  adminRestoreBackup,
  type BackupEntry,
} from "../api/gateway";
import { getAccessToken, getApiBase, type ApiError } from "../api/client";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "刚刚";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export function SystemPage() {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await adminListBackups();
      setBackups(res.backups ?? []);
      setError("");
    } catch (e) {
      setError(`加载备份列表失败：${(e as ApiError).code}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreateBackup = async () => {
    setError("");
    setMsg("");
    setBusy(true);
    try {
      const res = await adminCreateBackup("手动备份");
      setMsg(`备份已创建：${res.backup.name}`);
      await refresh();
    } catch (e) {
      setError(`创建备份失败：${(e as ApiError).code}`);
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (name: string) => {
    setError("");
    setMsg("");
    setConfirmRestore(null);
    setBusy(true);
    try {
      const res = await adminRestoreBackup(name);
      setMsg(
        `恢复成功！用户 ${res.userCount} 个，流水 ${res.txCount} 条。恢复前已自动备份为 ${res.preRestoreBackup}`,
      );
      await refresh();
    } catch (e) {
      setError(`恢复失败：${(e as ApiError).code}`);
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async (name: string) => {
    const base = getApiBase();
    const url = `${base}/api/admin/backup/download/${encodeURIComponent(name)}`;
    const token = getAccessToken();
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setError(`下载失败：${(e as Error).message}`);
    }
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 4px" }}>数据备份</h2>
      <p className="muted" style={{ margin: "0 0 16px" }}>
        管理 Gateway 数据库快照。服务端 crontab 每 6 小时自动备份一次（保留 14 天），此处可手动创建/恢复/下载。
      </p>

      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {msg ? (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            borderRadius: 8,
            background: "#ecfdf5",
            color: "#047857",
            fontSize: 13,
          }}
        >
          {msg}
        </div>
      ) : null}

      <div style={{ marginBottom: 16 }}>
        <button className="btn primary" type="button" disabled={busy} onClick={onCreateBackup}>
          {busy ? "处理中…" : "立即备份"}
        </button>
      </div>

      {/* 恢复确认 */}
      {confirmRestore ? (
        <div
          style={{
            marginBottom: 16,
            padding: "12px 16px",
            borderRadius: 10,
            background: "#fef9c3",
            border: "1px solid #fbbf24",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>确认恢复？</div>
          <div style={{ fontSize: 13, color: "#78350f", marginBottom: 8 }}>
            将从 <code>{confirmRestore}</code> 恢复数据库。当前数据会先自动备份。
          </div>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={() => void onRestore(confirmRestore)}
            style={{ marginRight: 8 }}
          >
            确认恢复
          </button>
          <button className="btn" type="button" onClick={() => setConfirmRestore(null)}>
            取消
          </button>
        </div>
      ) : null}

      <div className="tableWrap">
        <table className="table">
          <thead>
            <tr>
              <th>备份文件</th>
              <th>用户数</th>
              <th>流水数</th>
              <th>大小</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {backups.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "#94a3b8", padding: 24 }}>
                  暂无备份
                </td>
              </tr>
            ) : (
              backups.map((b) => (
                <tr key={b.name}>
                  <td>
                    <code style={{ fontSize: 12 }}>{b.name}</code>
                  </td>
                  <td>
                    {b.userCount >= 0 ? (
                      <span className={b.userCount > 0 ? "tagGreen" : "tagRed"} style={{ display: "inline-block" }}>
                        {b.userCount}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{b.txCount >= 0 ? b.txCount : <span className="muted">—</span>}</td>
                  <td>{fmtSize(b.size)}</td>
                  <td title={b.createdAt}>{fmtTimeAgo(b.createdAt)}</td>
                  <td>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmRestore(b.name)}
                      style={{ marginRight: 6, fontSize: 12 }}
                    >
                      恢复
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void onDownload(b.name)}
                      style={{ fontSize: 12 }}
                    >
                      下载
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        最多保留 50 份应用内备份。服务端外部备份位于 <code>/www/backup/gateway-db/</code>（crontab 管理）。
      </p>
    </div>
  );
}
