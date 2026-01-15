import type { ReactNode } from "react";

export type AdminPageKey = "users" | "llm";

export function AdminLayout(props: {
  page: AdminPageKey;
  onNavigate: (page: AdminPageKey) => void;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const NavItem = (p: { id: AdminPageKey; label: string }) => (
    <button
      type="button"
      className={`navItem ${props.page === p.id ? "navItemActive" : ""}`}
      onClick={() => props.onNavigate(p.id)}
    >
      {p.label}
    </button>
  );

  return (
    <div className="layout">
      <aside className="sidenav">
        <div className="brand">写作 IDE</div>
        <div className="nav">
          <NavItem id="users" label="用户管理" />
          <NavItem id="llm" label="LLM 管理" />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbarTitle">管理后台</div>
          <div className="topbarRight">{props.headerRight}</div>
        </header>
        <div className="content">{props.children}</div>
      </div>
    </div>
  );
}


