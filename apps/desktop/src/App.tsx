import { AgentPane } from "./components/AgentPane";
import { DockPanel } from "./components/DockPanel";
import { EditorPane } from "./components/EditorPane";
import { Explorer } from "./components/Explorer";
import { KbPane } from "./components/KbPane";
import { MaterialsPane } from "./components/MaterialsPane";
import { AccountFooter } from "./components/AccountFooter";
import { CardJobsModal } from "./components/CardJobsModal";
import { DialogHost } from "./components/DialogHost";
import { useEffect, useRef, type ReactNode } from "react";
import { useLayoutStore } from "./state/layoutStore";
import { useUiStore, type DockTabKey } from "./state/uiStore";
import { useProjectStore } from "./state/projectStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useUpdateStore } from "./state/updateStore";
import { getUpdateBaseUrl } from "./agent/updateBaseUrl";

function isDockTabKey(t: string): t is DockTabKey {
  return t === "outline" || t === "graph" || t === "problems" || t === "runs" || t === "logs";
}

function SidebarSection(props: { title: string; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="sidebarSection">
      <div
        className="sidebarSectionHeader"
        role="button"
        tabIndex={0}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggle();
          }
        }}
      >
        <span className="sidebarSectionCaret">{props.collapsed ? "▸" : "▾"}</span>
        <span className="sidebarSectionTitle">{props.title}</span>
      </div>
      <div className={`sidebarSectionBody ${props.collapsed ? "sidebarSectionBodyCollapsed" : ""}`}>{props.children}</div>
    </section>
  );
}

export default function App() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<
    | null
    | {
        kind: "left" | "right" | "dock";
        startX: number;
        startY: number;
        startLeft: number;
        startRight: number;
        startDock: number;
        pointerId: number;
        el: HTMLElement;
      }
  >(null);

  const leftWidth = useLayoutStore((s) => s.leftWidth);
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const dockHeight = useLayoutStore((s) => s.dockHeight);
  const setLeftWidth = useLayoutStore((s) => s.setLeftWidth);
  const setRightWidth = useLayoutStore((s) => s.setRightWidth);
  const setDockHeight = useLayoutStore((s) => s.setDockHeight);
  const explorerCollapsed = useLayoutStore((s) => s.explorerCollapsed);
  const kbCollapsed = useLayoutStore((s) => s.kbCollapsed);
  const materialsCollapsed = useLayoutStore((s) => s.materialsCollapsed);
  const toggleSectionCollapsed = useLayoutStore((s) => s.toggleSectionCollapsed);
  const openSection = useLayoutStore((s) => s.openSection);
  const setDockTab = useUiStore((s) => s.setDockTab);
  const setUpdateCheckResult = useUpdateStore((s) => s.setCheckResult);
  const setDownload = useUpdateStore((s) => s.setDownload);

  const gutter = 6;
  const leftMin = 200;
  const rightMin = 420;
  const centerMin = 420;
  const dockMin = 160;
  const editorMin = 220;

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

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
      // 批量事件：统一走一次 refresh（内部会做 dirty 冲突保护）
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

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const root = appRef.current;
      if (!d || !root) return;

      const rect = root.getBoundingClientRect();

      if (d.kind === "left") {
        const maxLeft = rect.width - gutter * 2 - rightWidth - centerMin;
        const next = clamp(d.startLeft + (e.clientX - d.startX), leftMin, Math.max(leftMin, maxLeft));
        setLeftWidth(next);
      }

      if (d.kind === "right") {
        const maxRight = rect.width - gutter * 2 - leftWidth - centerMin;
        const next = clamp(d.startRight - (e.clientX - d.startX), rightMin, Math.max(rightMin, maxRight));
        setRightWidth(next);
      }

      if (d.kind === "dock") {
        const maxDock = rect.height - gutter - editorMin;
        const next = clamp(d.startDock - (e.clientY - d.startY), dockMin, Math.max(dockMin, maxDock));
        setDockHeight(next);
      }
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      try {
        d.el?.releasePointerCapture?.(d.pointerId);
      } catch {
        // ignore
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const onVisibility = () => {
      // 极端情况：窗口失焦/切后台时 pointerup/pointercancel 可能丢失，导致 capture 残留挡住交互
      if (document.hidden) onUp();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // 当 capture 被系统/浏览器强制释放时（不一定触发 up/cancel），仍需清理状态
    window.addEventListener("lostpointercapture", onUp as any);
    window.addEventListener("blur", onUp);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("lostpointercapture", onUp as any);
      window.removeEventListener("blur", onUp);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    gutter,
    leftMin,
    rightMin,
    centerMin,
    dockMin,
    editorMin,
    leftWidth,
    rightWidth,
    setDockHeight,
    setLeftWidth,
    setRightWidth,
  ]);

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
      if (payload.type === "dock.tab") {
        const tab = String(payload.tab ?? "");
        if (isDockTabKey(tab)) setDockTab(tab);
        return;
      }
      if (payload.type === "sidebar.openSection") {
        const section = String(payload.section ?? "").trim();
        if (section === "explorer") openSection("explorer");
        if (section === "kb") openSection("kb");
        if (section === "materials") openSection("materials");
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
  }, [setDockTab]);

  // Update（v0.1）：启动 + 每 6 小时 silent check（只更新标记，不下载）
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

  const startDrag = (kind: "left" | "right" | "dock") => (e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: leftWidth,
      startRight: rightWidth,
      startDock: dockHeight,
      pointerId: e.pointerId,
      el: target,
    };
    document.body.style.cursor = kind === "dock" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  };

  const appCols = `${leftWidth}px ${gutter}px 1fr ${gutter}px ${rightWidth}px`;
  const centerRows = `1fr ${gutter}px ${dockHeight}px`;

  return (
    <>
      <div className="app" ref={appRef} style={{ gridTemplateColumns: appCols }}>
        <aside className="sidebar" style={{ gridColumn: 1 }}>
          <div className="sidebarMain">
            <SidebarSection
              title="EXPLORER"
              collapsed={explorerCollapsed}
              onToggle={() => toggleSectionCollapsed("explorer")}
            >
              <Explorer />
            </SidebarSection>
            <SidebarSection title="KB" collapsed={kbCollapsed} onToggle={() => toggleSectionCollapsed("kb")}>
              <KbPane />
            </SidebarSection>
            <SidebarSection
              title="MATERIALS"
              collapsed={materialsCollapsed}
              onToggle={() => toggleSectionCollapsed("materials")}
            >
              <MaterialsPane />
            </SidebarSection>
          </div>
          <AccountFooter />
        </aside>

        <div className="splitter splitterCol" style={{ gridColumn: 2 }} onPointerDown={startDrag("left")} />

        <div className="center" style={{ gridColumn: 3, gridTemplateRows: centerRows }}>
          <div className="editorPane" style={{ gridRow: 1 }}>
            <EditorPane />
          </div>
          <div className="splitter splitterRow" style={{ gridRow: 2 }} onPointerDown={startDrag("dock")} />
          <div className="dock" style={{ gridRow: 3 }}>
            <DockPanel />
          </div>
        </div>

        <div className="splitter splitterCol" style={{ gridColumn: 4 }} onPointerDown={startDrag("right")} />

        <aside className="agent" style={{ gridColumn: 5 }}>
          <AgentPane />
        </aside>
      </div>
      <CardJobsModal />
      <DialogHost />
    </>
  );
}


