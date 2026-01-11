import { AgentPane } from "./components/AgentPane";
import { DockPanel } from "./components/DockPanel";
import { EditorPane } from "./components/EditorPane";
import { Explorer } from "./components/Explorer";
import { AccountFooter } from "./components/AccountFooter";
import { useEffect, useRef } from "react";
import { useLayoutStore } from "./state/layoutStore";

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
      }
  >(null);

  const leftWidth = useLayoutStore((s) => s.leftWidth);
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const dockHeight = useLayoutStore((s) => s.dockHeight);
  const setLeftWidth = useLayoutStore((s) => s.setLeftWidth);
  const setRightWidth = useLayoutStore((s) => s.setRightWidth);
  const setDockHeight = useLayoutStore((s) => s.setDockHeight);

  const gutter = 6;
  const leftMin = 200;
  const rightMin = 420;
  const centerMin = 420;
  const dockMin = 160;
  const editorMin = 220;

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

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
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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
    };
    document.body.style.cursor = kind === "dock" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  };

  const appCols = `${leftWidth}px ${gutter}px 1fr ${gutter}px ${rightWidth}px`;
  const centerRows = `1fr ${gutter}px ${dockHeight}px`;

  return (
    <div className="app" ref={appRef} style={{ gridTemplateColumns: appCols }}>
      <aside className="sidebar" style={{ gridColumn: 1 }}>
        <div className="sidebarMain">
          <div className="sectionTitle">EXPLORER</div>
          <Explorer />
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
  );
}


