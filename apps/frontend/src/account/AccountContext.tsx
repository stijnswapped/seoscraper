// Shared account data for the logged-in shell. Loads the current user and
// billing overview once, then exposes them (plus a `reload`) to every page via
// `useAccount()`. Page-specific data (usage, events, keys) is still fetched by
// the individual pages.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { getBilling, getMe, type AccountUser, type BillingOverview } from "../api.js";

interface AccountValue {
  user: AccountUser;
  billing: BillingOverview | null;
  reload: () => Promise<void>;
}

const AccountCtx = createContext<AccountValue | null>(null);

export function useAccount(): AccountValue {
  const ctx = useContext(AccountCtx);
  if (!ctx) throw new Error("useAccount must be used within <AccountProvider>");
  return ctx;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = async () => {
    const [me, b] = await Promise.all([getMe(), getBilling().catch(() => null)]);
    setUser(me.user);
    if (b) setBilling(b.billing);
  };

  useEffect(() => {
    reload().catch(() => {
      setFailed(true);
      navigate("/login", { replace: true });
    });
  }, []);

  if (failed) return null;
  if (!user) {
    return (
      <div className="shell-loading">
        <span className="spinner" />
      </div>
    );
  }

  return <AccountCtx.Provider value={{ user, billing, reload }}>{children}</AccountCtx.Provider>;
}
