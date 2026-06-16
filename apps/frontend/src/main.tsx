import React, { type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Login } from "./pages/Login.js";
import { Signup } from "./pages/Signup.js";
import { Admin } from "./pages/Admin.js";
import { AppShell } from "./layout/AppShell.js";
import { Overview } from "./pages/Overview.js";
import { Stats } from "./pages/Stats.js";
import { Subscription } from "./pages/Subscription.js";
import { Playground } from "./pages/Playground.js";
import { ApiKeys } from "./pages/ApiKeys.js";
import { Account } from "./pages/Account.js";
import { Docs } from "./pages/Docs.js";
import { getSessionToken } from "./api.js";
import "./styles.css";

/** Gate a route on the presence of a session token (pages re-validate on mount). */
function RequireAuth({ children }: { children: ReactElement }): ReactElement {
  return getSessionToken() ? children : <Navigate to="/login" replace />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Login is the entry point. Logged-in users skip straight to the app. */}
        <Route path="/" element={<Navigate to={getSessionToken() ? "/overview" : "/login"} replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />

        {/* Authed app — persistent sidebar shell with nested pages. */}
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/overview" element={<Overview />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/subscription" element={<Subscription />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/keys" element={<ApiKeys />} />
          <Route path="/account" element={<Account />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/admin" element={<Admin />} />
        </Route>

        {/* Back-compat redirects for old routes. */}
        <Route path="/dashboard" element={<Navigate to="/overview" replace />} />
        <Route path="/scrape" element={<Navigate to="/playground" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
