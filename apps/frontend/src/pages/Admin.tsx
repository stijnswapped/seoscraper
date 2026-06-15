import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  adminCreateUser,
  adminListUsers,
  adminUserEvents,
  adminUserUsage,
  getMe,
  type AdminUser,
  type ApiError,
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

  // Invite form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");

  const loadUsers = async () => setUsers((await adminListUsers()).users);

  useEffect(() => {
    getMe()
      .then((me) => {
        if (me.user.role !== "admin") {
          navigate("/dashboard");
          return;
        }
        return loadUsers();
      })
      .catch(() => navigate("/login"));
  }, []);

  useEffect(() => {
    if (!selected) return;
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

  const onInvite = async () => {
    setError(null);
    setNotice(null);
    try {
      await adminCreateUser(email.trim(), password, role);
      setNotice(`Invited ${email.trim()}.`);
      setEmail("");
      setPassword("");
      setRole("user");
      await loadUsers();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not create user.");
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
        <p className="muted">There's no open signup — create accounts here and share the credentials.</p>
        <div className="invite-grid">
          <input type="email" placeholder="email@customer.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="text" placeholder="temporary password (≥ 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn" onClick={onInvite} disabled={!email.trim() || password.length < 8}>Invite</button>
        </div>
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
