// App shell: persistent sidebar + scrollable content with <Outlet/>. Wraps the
// authed pages in AccountProvider so the sidebar and pages share user/billing.
// On mobile the sidebar collapses to a slim top bar + off-canvas drawer.

import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AccountProvider } from "../account/AccountContext.js";
import { Sidebar } from "./Sidebar.js";
import { MenuIcon } from "../components/icons.js";

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  return (
    <AccountProvider>
      <div className={`app-shell${drawerOpen ? " drawer-open" : ""}`}>
        <div className="mobile-topbar">
          <button className="icon-btn" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <MenuIcon size={22} />
          </button>
          <div className="sidebar-brand compact">
            <span className="mark">◧</span>
            <span>SEOSCRAPE</span>
          </div>
        </div>

        {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}

        <Sidebar onNavigate={() => setDrawerOpen(false)} />

        <main className="content">
          <Outlet />
        </main>
      </div>
    </AccountProvider>
  );
}
