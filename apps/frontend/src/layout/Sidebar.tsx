// Persistent left sidebar: brand, primary nav, "Upgrade" promo card, and a
// bottom account menu. On mobile it becomes an off-canvas drawer (open state +
// onClose are owned by AppShell).

import { NavLink, useNavigate } from "react-router-dom";
import { logout } from "../api.js";
import { useAccount } from "../account/AccountContext.js";
import {
  HomeIcon,
  ChartIcon,
  CardIcon,
  BoltIcon,
  KeyIcon,
  GearIcon,
  BookIcon,
  ShieldIcon,
  type IconProps,
} from "../components/icons.js";
import type { ComponentType } from "react";

interface NavEntry {
  to: string;
  label: string;
  Icon: ComponentType<IconProps>;
  adminOnly?: boolean;
}

const NAV: NavEntry[] = [
  { to: "/overview", label: "Overview", Icon: HomeIcon },
  { to: "/stats", label: "Stats", Icon: ChartIcon },
  { to: "/playground", label: "Playground", Icon: BoltIcon },
  { to: "/subscription", label: "Subscription", Icon: CardIcon },
  { to: "/keys", label: "API keys", Icon: KeyIcon },
  { to: "/account", label: "Account", Icon: GearIcon },
  { to: "/docs", label: "Docs", Icon: BookIcon },
  { to: "/admin", label: "Admin", Icon: ShieldIcon, adminOnly: true },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { user, billing } = useAccount();
  const planName = billing?.effectivePlan.name ?? "Free";
  const isPaid = billing && billing.effectivePlan.code !== "free";

  const onSignOut = () => logout().finally(() => navigate("/login"));

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="mark">◧</span>
        <span>SEOSCRAPE</span>
      </div>

      <nav className="sidebar-nav">
        {NAV.filter((n) => !n.adminOnly || user.role === "admin").map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            onClick={onNavigate}
          >
            <Icon size={19} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        {!isPaid && (
          <div className="sidebar-promo">
            <strong>Go further with a plan</strong>
            <p>Higher rolling limits and priority scraping.</p>
            <NavLink to="/subscription" className="promo-link" onClick={onNavigate}>
              Upgrade →
            </NavLink>
          </div>
        )}

        <div className="sidebar-account">
          <div className="account-id">
            <span className="account-avatar">{user.email.slice(0, 1).toUpperCase()}</span>
            <div className="account-meta">
              <span className="account-email" title={user.email}>
                {user.email}
              </span>
              <span className="account-plan">{planName} plan</span>
            </div>
          </div>
          <button className="btn-link" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
