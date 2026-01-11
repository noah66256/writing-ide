import { AgentPane } from "./components/AgentPane";
import { DockPanel } from "./components/DockPanel";
import { EditorPane } from "./components/EditorPane";
import { Explorer } from "./components/Explorer";
import { AccountFooter } from "./components/AccountFooter";

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebarMain">
          <div className="sectionTitle">EXPLORER</div>
          <Explorer />
        </div>
        <AccountFooter />
      </aside>

      <div className="center">
        <div className="editorPane">
          <EditorPane />
        </div>
        <div className="dock">
          <DockPanel />
        </div>
      </div>

      <aside className="agent">
        <AgentPane />
      </aside>
    </div>
  );
}


