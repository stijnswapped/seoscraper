import React, { type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { App } from "./App.js";
import { Login } from "./pages/Login.js";
import { Signup } from "./pages/Signup.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Admin } from "./pages/Admin.js";
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
        {/* Login is the entry point. Logged-in users skip straight to the dashboard. */}
        <Route path="/" element={<Navigate to={getSessionToken() ? "/dashboard" : "/login"} replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
        <Route path="/scrape" element={<RequireAuth><App /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
