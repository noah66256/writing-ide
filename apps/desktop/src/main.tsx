import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "./app.css";
import "./monaco/setupMonaco";

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // 关键：避免“白屏无信息”，把首个致命渲染错误打到 console，终端也能看到。
    // eslint-disable-next-line no-console
    console.error("[renderer] fatal_render_error", { error, info });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const msg = (() => {
      const e: any = this.state.error as any;
      return String(e?.stack ?? e?.message ?? e ?? "unknown error");
    })();
    return (
      <div style={{ padding: 16, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>桌面端渲染崩溃（不再白屏）</div>
        <div style={{ marginTop: 8, color: "#666", fontSize: 12 }}>
          请把下面这段报错（含 stack）发我，我会继续把根因修掉。
        </div>
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{msg}</pre>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);









