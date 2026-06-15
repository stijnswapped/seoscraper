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
  testProxy,
  trackListing,
  createProgressSource,
  type AccountUser,
  type ApiError,
  type ApiKeySummary,
  type UsageDailyPoint,
  type UsageEvent,
  type ProgressEvent,
  type ListingRankSnapshot,
} from "../api.js";
import { ProxyHelpModal } from "../components/ProxyHelpModal.js";
import { ProgressPanel } from "../components/ProgressPanel.js";
import { ListingSummary } from "../components/ListingSummary.js";

const PERIODS = [7, 30, 90] as const;

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function newRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  // Proxy test states
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{
    working: boolean;
    rotates: boolean;
    ips: string[];
    uniqueIps: string[];
    errors: string[];
  } | null>(null);

  // Tracker test states
  const [testUrlInput, setTestUrlInput] = useState("");
  const [testingTrack, setTestingTrack] = useState(false);
  const [trackProgress, setTrackProgress] = useState<ProgressEvent[]>([]);
  const [trackResult, setTrackResult] = useState<ListingRankSnapshot | null>(null);

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

  const onTestProxy = async () => {
    setTestingProxy(true);
    setProxyTestResult(null);
    setError(null);
    setNotice(null);
    try {
      const p = proxyInput.trim() || null;
      const res = await testProxy(p);
      setProxyTestResult(res);
      if (res.working) {
        setNotice(res.rotates ? "Proxy test succeeded: Connection works and rotates exit IPs!" : "Proxy test succeeded: Connection works (static IP).");
      } else {
        setError("Proxy test failed: Connection could not be established.");
      }
    } catch (err) {
      setError((err as ApiError).message ?? "Proxy test failed.");
    } finally {
      setTestingProxy(false);
    }
  };

  const onRunTestTrack = async () => {
    if (!testUrlInput.trim() || testingTrack) return;
    setTestingTrack(true);
    setTrackProgress([]);
    setTrackResult(null);
    setError(null);
    setNotice(null);

    const runId = newRunId();
    const source = createProgressSource(runId);
    
    source.onmessage = (event) => {
      const p = JSON.parse(event.data) as ProgressEvent;
      setTrackProgress((cur) => [...cur, p]);
      if (p.phase === "complete" || p.phase === "failed") {
        source.close();
      }
    };
    source.onerror = () => {
      source.close();
    };

    try {
      const res = await trackListing(testUrlInput.trim(), { runId, enrich: false, maxPages: 1, maxProducts: 10 });
      source.close();
      if (res.success) {
        setTrackResult(res.result);
        setNotice("Test rank tracking completed successfully.");
      } else {
        setError(res.error.message ?? "Test rank tracking failed.");
      }
    } catch (err) {
      source.close();
      setError((err as Error).message ?? "Test rank tracking failed.");
    } finally {
      setTestingTrack(false);
    }
  };

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
            <button className="btn btn-ghost" onClick={onTestProxy} disabled={testingProxy}>
              {testingProxy ? "Testing..." : "Test Connection"}
            </button>
            {user.hasProxy && (
              <button className="btn btn-ghost" onClick={() => handle(setProxy(null), "Proxy cleared.")}>Clear</button>
            )}
          </div>

          {testingProxy && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }} className="muted anim">
              <span className="spinner" />
              <span>Testing proxy connection (making 3 attempts to check rotation)...</span>
            </div>
          )}

          {proxyTestResult && (
            <div style={{ marginTop: 16, padding: 16, borderRadius: 16, border: "1px solid var(--line)", background: "#fcfcfe" }} className="anim">
              <h3 style={{ margin: "0 0 10px", fontSize: "0.95rem", display: "flex", alignItems: "center", gap: 8 }}>
                {proxyTestResult.working ? (
                  <>
                    <span style={{ color: "var(--ok)", fontWeight: 700 }}>✅ Working</span>
                    <span className={`tag ${proxyTestResult.rotates ? "ok" : ""}`} style={{ fontSize: "0.7rem" }}>
                      {proxyTestResult.rotates ? "🔄 Rotates IP" : "📌 Static IP"}
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--down)", fontWeight: 700 }}>❌ Failed</span>
                )}
              </h3>
              
              {proxyTestResult.working && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Detected Exit IPs ({proxyTestResult.uniqueIps.length} unique):
                  </span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {proxyTestResult.ips.map((ip, idx) => (
                      <span key={idx} className="pill" style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>
                        Attempt {idx + 1}: <b>{ip}</b>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {proxyTestResult.errors.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <span style={{ fontSize: "0.74rem", fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Connection Attempts Log:
                  </span>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--down)", fontSize: "0.82rem", lineHeight: 1.5 }}>
                    {proxyTestResult.errors.map((err, idx) => (
                      <li key={idx} style={{ margin: "2px 0" }}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Best-Sellers Tracker Test ---------------------------------------- */}
        <section className="panel anim">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Testing</span>
              <h2>Best-sellers tracker test</h2>
            </div>
            <div className="section-head-actions">
              <span className="chip">Authenticated Test</span>
            </div>
          </div>
          <p className="muted">
            Run a test best-seller rank tracking request. Uses your session credentials and active proxy.
            This test is limited to the first page (max 10 products) for speed.
          </p>
          <div className="row">
            <input
              type="url"
              placeholder="https://yourshop.com/collections/all?sort_by=best-selling"
              value={testUrlInput}
              onChange={(e) => setTestUrlInput(e.target.value)}
            />
            <button className="btn" onClick={onRunTestTrack} disabled={testingTrack}>
              {testingTrack ? "Running Test..." : "Run Test Track →"}
            </button>
          </div>

          {testingTrack && trackProgress.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <ProgressPanel events={trackProgress} />
            </div>
          )}

          {trackResult && (
            <div style={{ marginTop: 16, maxHeight: 420, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 16, padding: "8px 16px" }} className="anim">
              <ListingSummary result={trackResult} />
            </div>
          )}
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
