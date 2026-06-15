import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
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

const PERIODS = [7, 30, 90] as const;

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
  const [days, setDays] = useState<number>(30);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (d = days) => {
    const [me, k, u, e] = await Promise.all([getMe(), listApiKeys(), getUsage(d), getEvents(d, 50)]);
    setUser(me.user);
    setKeys(k.keys);
    setUsage(u.daily);
    setEvents(e.events);
  };

  useEffect(() => {
    refresh(days).catch(() => navigate("/login"));
  }, []);

  const changePeriod = (d: number) => {
    setDays(d);
    Promise.all([getUsage(d), getEvents(d, 50)])
      .then(([u, e]) => {
        setUsage(u.daily);
        setEvents(e.events);
      })
      .catch((err) => setError((err as ApiError).message ?? "Could not load usage."));
  };

  const metrics = useMemo(() => {
    const ok = usage.reduce((s, p) => s + p.ok, 0);
    const failed = usage.reduce((s, p) => s + p.failed, 0);
    const total = ok + failed;
    return { total, ok, failed, rate: total ? Math.round((ok / total) * 100) : 100 };
  }, [usage]);

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
      setNewKey(res.key);
      setKeyLabel("");
      await refresh();
    } catch (err) {
      setError((err as ApiError).message ?? "Could not create key.");
    }
  };

  const onCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard blocked — value is still selectable */
    }
  };

  const onSaveProxy = () =>
    handle(setProxy(proxyInput.trim() || null), proxyInput.trim() ? "Proxy saved." : "Proxy cleared.");
  const onSignOut = () => logout().finally(() => navigate("/login"));

  if (!user) return <div className="shell"><div className="page"><p className="muted">Loading…</p></div></div>;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="mark">◧</span> SEOSCRAPE</div>
        <nav className="topnav">
          {user.role === "admin" && <Link className="pill" to="/admin">Admin</Link>}
          <button className="pill" onClick={() => navigate("/scrape")}>Scraper</button>
          <button className="pill" onClick={onSignOut}>Sign out</button>
        </nav>
      </header>

      <main className="page">
        <div className="page-head anim">
          <h1>Overview</h1>
          <p className="muted">{user.email}</p>
        </div>

        {error && <div className="banner error anim">{error}</div>}
        {notice && <div className="banner notice anim">{notice}</div>}

        {/* Usage ------------------------------------------------------------ */}
        <section className="panel anim">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Usage</span>
              <h2>Activity</h2>
            </div>
            <div className="segmented period">
              {PERIODS.map((p) => (
                <button key={p} className={days === p ? "on" : ""} onClick={() => changePeriod(p)}>{p}d</button>
              ))}
            </div>
          </div>

          <div className="metric-row">
            <div className="metric"><b>{metrics.total}</b><span>Total scrapes</span></div>
            <div className="metric"><b>{metrics.rate}%</b><span>Success rate</span></div>
            <div className="metric"><b>{metrics.failed}</b><span>Failed</span></div>
          </div>

          {usage.length === 0 ? (
            <div className="empty-chart">No scrapes recorded yet.</div>
          ) : (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={usage} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.16} />
                      <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#eef0f4" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={fmtDay} tickLine={false} axisLine={false} dy={10} minTickGap={28} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} />
                  <Tooltip
                    cursor={{ stroke: "#d9d9e3", strokeWidth: 1 }}
                    contentStyle={{ borderRadius: 14, border: "1px solid #ececf0", boxShadow: "0 8px 30px rgba(20,20,40,0.08)", padding: "8px 12px" }}
                    labelFormatter={(d) => fmtDay(String(d))}
                  />
                  <Area type="monotone" dataKey="total" name="Scrapes" stroke="#4f46e5" strokeWidth={2.5} fill="url(#fillTotal)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Proxy ------------------------------------------------------------ */}
        <section className="panel anim">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Connection</span>
              <h2>Your proxy</h2>
            </div>
            <div className="section-head-actions">
              <span className={`chip${user.hasProxy ? " on" : ""}`}>{user.hasProxy ? "Active" : "Not set"}</span>
              <button className="btn-link accent" onClick={() => setHelpOpen(true)}>How to set up?</button>
            </div>
          </div>
          <p className="muted">
            Used for your scrapes, overriding the server default. Stored encrypted — credentials are never logged or shown back.
            Paste the Smartproxy <code>curl</code> command or just the URL.
          </p>
          <div className="row">
            <input
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

        {/* API keys --------------------------------------------------------- */}
        <section className="panel anim">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Access</span>
              <h2>API keys</h2>
            </div>
          </div>
          <p className="muted">Authenticate scrape requests with a key. A key is shown only once at creation.</p>

          {newKey && (
            <div className="banner reveal">
              <strong>Copy your new key now — it won't be shown again.</strong>
              <div className="copy-row">
                <code className="key-reveal">{newKey}</code>
                <button className="btn" onClick={() => onCopy(newKey)}>{copied ? "Copied" : "Copy"}</button>
              </div>
            </div>
          )}

          <div className="row">
            <input type="text" placeholder="Label (optional)" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} />
            <button className="btn" onClick={onCreateKey}>Create key</button>
          </div>

          <table className="data-table">
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
                      : <button className="btn-link danger" onClick={() => handle(revokeApiKey(k.id), "Key revoked.")}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Logs ------------------------------------------------------------- */}
        <section className="panel anim">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Logs</span>
              <h2>Recent activity</h2>
            </div>
          </div>
          <EventTable events={events} />
        </section>
      </main>

      <ProxyHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export function EventTable({ events }: { events: UsageEvent[] }) {
  if (events.length === 0) return <div className="empty-chart">No activity yet.</div>;
  return (
    <table className="data-table log-table">
      <thead>
        <tr><th>When</th><th>Endpoint</th><th>Proxy</th><th>Status</th></tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={i}>
            <td className="when">{fmtTime(e.ts)}</td>
            <td><code>{e.endpoint.replace("/api/", "")}</code></td>
            <td className="muted-cell">{e.usedProxy ?? "—"}</td>
            <td>
              <span className={`status ${e.ok ? "ok" : "bad"}`}>{e.ok ? "ok" : "fail"}{e.status ? ` · ${e.status}` : ""}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
