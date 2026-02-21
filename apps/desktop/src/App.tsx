import { DialogHost } from "./components/DialogHost";
import { ConversationLayout } from "./ui/layouts/ConversationLayout";
import { useEffect } from "react";
import { useProjectStore } from "./state/projectStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useUpdateStore } from "./state/updateStore";
import { getUpdateBaseUrl } from "./agent/updateBaseUrl";
import "./state/themeStore"; // side-effect: apply theme on load

export default function App() {
  const setUpdateCheckResult = useUpdateStore((s) => s.setCheckResult);
  const setDownload = useUpdateStore((s) => s.setDownload);

  // 启动时：尝试恢复上次打开的项目
  useEffect(() => {
    const last = useWorkspaceStore.getState().lastProjectDir;
    if (!last) return;
    void useProjectStore.getState().loadProjectFromDisk(last);
  }, []);

  // 最近项目：同步到主进程（用于动态菜单）
  const recentProjectDirs = useWorkspaceStore((s) => s.recentProjectDirs);
  useEffect(() => {
    void window.desktop?.workspace?.setRecentProjects?.(recentProjectDirs);
  }, [recentProjectDirs]);

  // 文件监听：主进程 fs watch -> renderer 刷新
  useEffect(() => {
    const off = window.desktop?.fs?.onFsEvent?.((payload: any) => {
      const rootDir = String(payload?.rootDir ?? "");
      const cur = useProjectStore.getState().rootDir;
      if (!rootDir || !cur || rootDir !== cur) return;
      void useProjectStore.getState().refreshFromDisk("fs.watch");
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // 菜单动作（Electron → renderer）
  useEffect(() => {
    const off = window.desktop?.onMenuAction?.((payload: any) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "help.checkUpdates") {
        const api = window.desktop?.update;
        if (!api) return;
        void api.checkInteractive({ baseUrl: getUpdateBaseUrl() });
        return;
      }
      if (payload.type === "file.openProject") {
        const api = window.desktop?.fs;
        if (!api) return;
        void (async () => {
          const res = await api.pickDirectory();
          if (!res.ok || !res.dir) return;
          useWorkspaceStore.getState().addRecentProjectDir(res.dir);
          await useProjectStore.getState().loadProjectFromDisk(res.dir);
        })();
        return;
      }
      if (payload.type === "file.openRecent") {
        const dir = String(payload.dir ?? "");
        if (!dir) return;
        void (async () => {
          useWorkspaceStore.getState().addRecentProjectDir(dir);
          await useProjectStore.getState().loadProjectFromDisk(dir);
        })();
        return;
      }
      if (payload.type === "workspace.clearRecent") {
        useWorkspaceStore.getState().clearRecent();
        void window.desktop?.workspace?.clearRecentProjects?.();
        return;
      }
      if (payload.type === "file.save") {
        void useProjectStore.getState().saveActiveNow();
        return;
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // Update（v0.1）：启动 + 每 6 小时 silent check
  useEffect(() => {
    const api = window.desktop?.update;
    if (!api) return;
    const run = async () => {
      const r = await api.check({ baseUrl: getUpdateBaseUrl() }).catch((e) => ({ ok: false, error: String(e?.message ?? e) } as any));
      if (!r?.ok) return setUpdateCheckResult({ updateAvailable: false, latestVersion: "", error: r?.error ?? "CHECK_FAILED" });
      setUpdateCheckResult({ updateAvailable: Boolean(r.updateAvailable), latestVersion: String(r.latestVersion ?? ""), error: "" });
    };
    const t0 = window.setTimeout(() => void run(), 8000);
    const id = window.setInterval(() => void run(), 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(id);
    };
  }, [setUpdateCheckResult]);

  // Update download events（进度）
  useEffect(() => {
    const off = window.desktop?.update?.onEvent?.((evt: any) => {
      const t = String(evt?.type ?? "");
      if (t === "download.start") {
        setDownload({ running: true, transferred: 0, total: 0 });
        return;
      }
      if (t === "download.progress") {
        const transferred = Number(evt?.transferred ?? 0) || 0;
        const total = Number(evt?.total ?? 0) || 0;
        setDownload({ running: true, transferred, total });
        return;
      }
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, [setDownload]);

  return (
    <>
      <ConversationLayout />
      <DialogHost />
    </>
  );
}
