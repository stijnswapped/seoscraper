import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  createApiKey,
  getEvents,
  getMe,
  getUsage,
  listApiKeys,
  logout,
  revokeApiKey,
  setProxy,
  type AccountUser,
  type ApiError,
  type ApiKeySummary,
  type UsageDailyPoint,
  type UsageEvent,
} from "../api.js";
import { ProxyHelpModal } from "../components/ProxyHelpModal.js";

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Dashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState<AccountUser | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [usage, setUsage] = useState<UsageDailyPoint[]>([]);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const [me, k, u, e] = await Promise.all([getMe(), listApiKeys(), getUsage(30), getEvents(30, 20)]);
    setUser(me.user);
    setKeys(k.keys);
    setUsage(u.daily);
    setEvents(e.events);
  };

  useEffect(() => {
    refresh().catch(() => navigate("/login"));
  }, []);

  const handle = (p: Promise<unknown>, ok?: string) => {
    setError(null);
    setNotice(null);
    p.then(() => {
      if (ok) setNotice(ok);
      return refresh();
    }).catch((err) => setError((err as ApiError).message ?? "Action failed."));
  };

  const onCreateKey = async () => {
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const res = await createApiKey(keyLabel.trim() || undefined);
      setNewKey(res.key); // shown once
      setKeyLabel("");
      await refresh();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not create key.");
    }
  };

  const onCopyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      /* clipboard blocked — the key is still selectable */
    }
  };

  const onSaveProxy = () =>
    handle(setProxy(proxyInput.trim() || null), proxyInput.trim() ? "Proxy saved." : "Proxy cleared.");
  const onSignOut = () => logout().finally(() => navigate("/login"));

  if (!user) return <div className="dashboard"><p className="muted">Loading…</p></div>;

  return (
    <div className="dashboard">
      <header className="dash-head anim">
        <div>
          <h1>Account</h1>
          <span className="who">{user.email} · {user.role}</span>
        </div>
        <div className="dash-actions">
          {user.role === "admin" && <Link className="btn btn-ghost" to="/admin">Admin</Link>}
          <button className="btn btn-ghost" onClick={() => navigate("/")}>Scraper</button>
          <button className="btn btn-ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {error && <div className="banner error anim">{error}</div>}
      {notice && <div className="banner notice anim">{notice}</div>}

      <section className="card anim" style={{ animationDelay: "60ms" }}>
        <div className="section-head">
          <h2>Your proxy</h2>
          <div className="section-head-actions">
            <span className={`chip${user.hasProxy ? " on" : ""}`}>{user.hasProxy ? "Set" : "Not set"}</span>
            <button className="btn-link accent" onClick={() => setHelpOpen(true)}>How to set up?</button>
          </div>
        </div>
        <p className="muted">
          Used for your scrapes, overriding the server default. Stored encrypted — credentials are never logged or shown back.
          Paste the Smartproxy <code>curl</code> command or just the URL.
        </p>
        <label className="field-label" htmlFor="proxy-input">Proxy URL</label>
        <div className="row">
          <input
            id="proxy-input"
            type="text"
            placeholder="http://user:pass@host:port"
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
          />
          <button className="btn" onClick={onSaveProxy}>Save</button>
          {user.hasProxy && (
            <button className="btn btn-ghost" onClick={() => handle(setProxy(null), "Proxy cleared.")}>Clear</button>
          )}
        </div>
      </section>

      <section className="card anim" style={{ animationDelay: "120ms" }}>
        <div className="section-head">
          <h2>API keys</h2>
        </div>
        <p className="muted">Authenticate scrape requests with a key. A key is shown only once at creation.</p>

        {newKey && (
          <div className="banner reveal">
            <strong>Copy your new key now — it won't be shown again.</strong>
            <div className="copy-row">
              <code className="key-reveal">{newKey}</code>
              <button className="btn" onClick={onCopyKey}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
        )}

        <div className="row">
          <input type="text" placeholder="Label (optional)" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} />
          <button className="btn" onClick={onCreateKey}>Create key</button>
        </div>

        <table className="key-table">
          <thead>
            <tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th></th></tr>
          </thead>
          <tbody>
            {keys.length === 0 && <tr><td className="empty" colSpan={5}>No keys yet.</td></tr>}
            {keys.map((k) => (
              <tr key={k.id} className={k.revokedAt ? "revoked" : ""}>
                <td><code>{k.keyPrefix}…</code></td>
                <td>{k.label ?? "—"}</td>
                <td className="when">{fmtDay(k.createdAt)}</td>
                <td className="when">{k.lastUsedAt ? fmtDay(k.lastUsedAt) : "—"}</td>
                <td>
                  {k.revokedAt
                    ? <span className="muted">revoked</span>
                    : <button className="btn-link" onClick={() => handle(revokeApiKey(k.id), "Key revoked.")}>Revoke</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card anim" style={{ animationDelay: "180ms" }}>
        <div className="section-head">
          <h2>Usage</h2>
          <span className="muted" style={{ margin: 0 }}>last 30 days</span>
        </div>
        {usage.length === 0 ? (
          <div className="empty-chart">No scrapes recorded yet.</div>
        ) : (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
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
                <Bar dataKey="ok" name="Successful" stackId="a" fill="#16a34a" radius={[0, 0, 0, 0]} />
                <Bar dataKey="failed" name="Failed" stackId="a" fill="#dc2626" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card anim" style={{ animationDelay: "240ms" }}>
        <div className="section-head">
          <h2>Recent activity</h2>
          <span className="muted" style={{ margin: 0 }}>last 20 scrapes</span>
        </div>
        <EventTable events={events} />
      </section>

      <ProxyHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export function EventTable({ events }: { events: UsageEvent[] }) {
  if (events.length === 0) return <div className="empty-chart">No activity yet.</div>;
  return (
    <table className="key-table log-table">
      <thead>
        <tr><th>When</th><th>Endpoint</th><th>Proxy</th><th>Status</th></tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={i}>
            <td className="when">{fmtTime(e.ts)}</td>
            <td><code>{e.endpoint.replace("/api/", "")}</code></td>
            <td>{e.usedProxy ?? "—"}</td>
            <td>
              <span className={`chip ${e.ok ? "on" : "bad"}`}>{e.ok ? "ok" : "fail"}{e.status ? ` ${e.status}` : ""}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
