import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  adminCreateInvite,
  adminListInvites,
  adminListUsers,
  adminRevokeInvite,
  adminUpdateUserBilling,
  adminUserEvents,
  adminUserUsage,
  getMe,
  type AdminUser,
  type ApiError,
  type Invite,
  type UsageDailyPoint,
  type UsageEvent,
} from "../api.js";
import { EventTable } from "./Dashboard.js";

const PERIODS = [7, 30, 90] as const;
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function Admin() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsageDailyPoint[]>([]);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualPlan, setManualPlan] = useState<"free" | "starter" | "pro" | "scale" | "unlimited" | "">("");
  const [manualReason, setManualReason] = useState("");
  const [manualExpiresAt, setManualExpiresAt] = useState("");
  const [creditAdjust, setCreditAdjust] = useState("");

  // Invite form
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"user" | "admin">("user");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadAccounts = async () => {
    const [u, inv] = await Promise.all([adminListUsers(), adminListInvites()]);
    setUsers(u.users);
    setInvites(inv.invites);
  };

  useEffect(() => {
    getMe()
      .then((me) => {
        if (me.user.role !== "admin") {
          navigate("/dashboard");
          return;
        }
        return loadAccounts();
      })
      .catch(() => navigate("/login"));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setManualPlan(selected.manualUnlimited ? "unlimited" : (selected.manualPlanCode as typeof manualPlan) ?? "");
    setManualReason("");
    setManualExpiresAt("");
    setCreditAdjust("");
    setError(null);
    Promise.all([adminUserUsage(selected.id, days), adminUserEvents(selected.id, days, 100)])
      .then(([u, e]) => {
        setUsage(u.daily);
        setEvents(e.events);
      })
      .catch((err) => setError((err as ApiError).message ?? "Could not load usage."));
  }, [selected, days]);

  const totals = useMemo(() => {
    const ok = usage.reduce((s, d) => s + d.ok, 0);
    const failed = usage.reduce((s, d) => s + d.failed, 0);
    return { ok, failed, total: ok + failed };
  }, [usage]);

  const onCreateInvite = async () => {
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const res = await adminCreateInvite(inviteEmail.trim() || null, inviteRole);
      setGeneratedLink(`${window.location.origin}/signup?token=${res.token}`);
      setInviteEmail("");
      setInviteRole("user");
      await loadAccounts();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not create invite.");
    }
  };

  const onCopyLink = async () => {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      setCopied(true);
    } catch {
      /* clipboard blocked — the link is still selectable */
    }
  };

  const onRevokeInvite = (id: string) => {
    setError(null);
    setNotice(null);
    adminRevokeInvite(id)
      .then(() => {
        setNotice("Invite revoked.");
        return loadAccounts();
      })
      .catch((err) => setError((err as ApiError).message ?? "Could not revoke invite."));
  };

  const onSaveBilling = async () => {
    if (!selected) return;
    setError(null);
    setNotice(null);
    try {
      await adminUpdateUserBilling(selected.id, {
        manualPlanCode: manualPlan ? manualPlan : null,
        manualUnlimited: manualPlan === "unlimited",
        manualReason: manualReason.trim() || null,
        manualExpiresAt: manualExpiresAt ? new Date(manualExpiresAt).toISOString() : null,
        addCredits: creditAdjust.trim() ? Number(creditAdjust) : undefined,
      });
      setNotice("Billing access updated.");
      await loadAccounts();
      setCreditAdjust("");
    } catch (err) {
      setError((err as ApiError).message ?? "Could not update billing access.");
    }
  };

  return (
    <div className="dashboard">
      <header className="dash-head anim">
        <div>
          <h1>Admin</h1>
          <span className="who">Manage accounts &amp; review usage</span>
        </div>
        <div className="dash-actions">
          <Link className="btn btn-ghost" to="/dashboard">Dashboard</Link>
        </div>
      </header>

      {error && <div className="banner error anim">{error}</div>}
      {notice && <div className="banner notice anim">{notice}</div>}

      <section className="card anim" style={{ animationDelay: "60ms" }}>
        <div className="section-head"><h2>Invite a user</h2></div>
        <p className="muted">
          Generate a one-time signup link and send it to the person — they set their own password. The link works once
          and stops working after an account is created. Email is optional (leave blank to let them choose their own).
        </p>

        {generatedLink && (
          <div className="banner reveal">
            <strong>Copy this link and send it — it's shown only once.</strong>
            <div className="copy-row">
              <code className="key-reveal">{generatedLink}</code>
              <button className="btn" onClick={onCopyLink}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
        )}

        <div className="invite-grid invite-grid--link">
          <input type="email" placeholder="email@customer.com (optional)" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "user" | "admin")}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn" onClick={onCreateInvite}>Create invite link</button>
        </div>

        {invites.length > 0 && (
          <table className="key-table">
            <thead>
              <tr><th>Email</th><th>Role</th><th>Created</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {invites.map((inv) => (
                <tr key={inv.id} className={inv.status !== "pending" ? "revoked" : ""}>
                  <td>{inv.email ?? <span className="muted">any</span>}</td>
                  <td>{inv.role}</td>
                  <td className="when">{fmtDay(inv.createdAt)}</td>
                  <td>
                    <span className={`chip ${inv.status === "pending" ? "on" : inv.status === "used" ? "" : "bad"}`}>{inv.status}</span>
                  </td>
                  <td>
                    {inv.status === "pending"
                      ? <button className="btn-link" onClick={() => onRevokeInvite(inv.id)}>Revoke</button>
                      : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card anim" style={{ animationDelay: "120ms" }}>
        <div className="section-head"><h2>Users</h2><span className="muted" style={{ margin: 0 }}>{users.length}</span></div>
        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id}>
              <button className={`user-row${selected?.id === u.id ? " sel" : ""}`} onClick={() => setSelected(u)}>
                <span className="user-email">{u.email}</span>
                <span className="user-meta">
                  {u.role === "admin" && <span className="chip">admin</span>}
                  {u.hasProxy && <span className="chip on">proxy</span>}
                  <span className={`chip ${u.manualUnlimited || u.planCode !== "free" ? "on" : ""}`}>
                    {u.manualUnlimited ? "unlimited" : u.manualPlanCode ?? u.planCode}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section className="card anim">
          <div className="section-head">
            <h2>{selected.email}</h2>
            <div className="segmented period">
              {PERIODS.map((p) => (
                <button key={p} className={days === p ? "on" : ""} onClick={() => setDays(p)}>{p}d</button>
              ))}
            </div>
          </div>

          <div className="stats">
            <div className="stat"><b>{totals.total}</b><span>Total</span></div>
            <div className="stat ok"><b>{totals.ok}</b><span>Successful</span></div>
            <div className="stat down"><b>{totals.failed}</b><span>Failed</span></div>
          </div>

          <div className="admin-billing-box">
            <div className="section-head">
              <h3>Billing override</h3>
              <span className="muted">
                Current: {selected.manualUnlimited ? "manual unlimited" : selected.manualPlanCode ? `manual ${selected.manualPlanCode}` : `${selected.planCode} (${selected.billingStatus})`}
              </span>
            </div>
            <div className="billing-admin-grid">
              <label className="field">
                <span>Manual plan</span>
                <select value={manualPlan} onChange={(e) => setManualPlan(e.target.value as typeof manualPlan)}>
                  <option value="">No override</option>
                  <option value="free">Free</option>
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="scale">Scale</option>
                  <option value="unlimited">Unlimited</option>
                </select>
              </label>
              <label className="field">
                <span>Expires</span>
                <input type="datetime-local" value={manualExpiresAt} onChange={(e) => setManualExpiresAt(e.target.value)} />
              </label>
              <label className="field">
                <span>Add credits</span>
                <input type="number" value={creditAdjust} onChange={(e) => setCreditAdjust(e.target.value)} placeholder="e.g. 500" />
              </label>
              <label className="field billing-reason">
                <span>Reason</span>
                <input type="text" value={manualReason} onChange={(e) => setManualReason(e.target.value)} placeholder="beta, partner, support credit" />
              </label>
              <button className="btn" onClick={onSaveBilling}>Save billing access</button>
            </div>
          </div>

          {usage.length === 0 ? (
            <div className="empty-chart">No usage in this period.</div>
          ) : (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={usage} barCategoryGap="28%">
                  <CartesianGrid stroke="#ececf0" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={fmtDay} tickLine={false} axisLine={{ stroke: "#ececf0" }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                  <Tooltip
                    cursor={{ fill: "rgba(79,70,229,0.06)" }}
                    contentStyle={{ borderRadius: 12, border: "1px solid #ececf0", boxShadow: "0 8px 30px rgba(20,20,40,0.08)" }}
                    labelFormatter={(d) => fmtDay(String(d))}
                  />
                  <Legend iconType="circle" iconSize={9} />
                  <Bar dataKey="ok" name="Successful" stackId="a" fill="#16a34a" />
                  <Bar dataKey="failed" name="Failed" stackId="a" fill="#dc2626" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <h3 style={{ marginTop: 18 }}>Logs</h3>
          <EventTable events={events} />
        </section>
      )}
    </div>
  );
}
