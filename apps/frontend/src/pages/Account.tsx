// Account settings: profile (email, role, sign out) + proxy configuration & test.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { logout, setProxy, testProxy, type ApiError } from "../api.js";
import { useAccount } from "../account/AccountContext.js";
import { PageHeader } from "../layout/PageHeader.js";
import { ProxyHelpModal } from "../components/ProxyHelpModal.js";

export function Account() {
  const navigate = useNavigate();
  const { user, reload } = useAccount();

  const [proxyInput, setProxyInput] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{
    working: boolean;
    rotates: boolean;
    ips: string[];
    uniqueIps: string[];
    errors: string[];
  } | null>(null);

  const onSignOut = () => logout().finally(() => navigate("/login"));

  const runProxyAction = (p: Promise<unknown>, ok: string) => {
    setError(null);
    setNotice(null);
    p.then(() => {
      setNotice(ok);
      return reload();
    }).catch((err) => setError((err as ApiError).message ?? "Action failed."));
  };

  const onSaveProxy = () =>
    runProxyAction(setProxy(proxyInput.trim() || null), proxyInput.trim() ? "Proxy saved." : "Proxy cleared.");

  const onTestProxy = async () => {
    setTestingProxy(true);
    setProxyTestResult(null);
    setError(null);
    setNotice(null);
    try {
      const res = await testProxy(proxyInput.trim() || null);
      setProxyTestResult(res);
      if (res.working) {
        setNotice(
          res.rotates
            ? "Proxy test succeeded: connection works and rotates exit IPs."
            : "Proxy test succeeded: connection works (static IP).",
        );
      } else {
        setError("Proxy test failed: connection could not be established.");
      }
    } catch (err) {
      setError((err as ApiError).message ?? "Proxy test failed.");
    } finally {
      setTestingProxy(false);
    }
  };

  return (
    <>
      <PageHeader title="Account" subtitle="Your profile and scraping connection." />

      {error && <div className="banner error anim">{error}</div>}
      {notice && <div className="banner notice anim">{notice}</div>}

      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Profile</span>
            <h2>{user.email}</h2>
          </div>
          <div className="section-head-actions">
            <span className="chip">{user.role}</span>
            <button className="btn btn-ghost" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </section>

      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Connection</span>
            <h2>Your proxy</h2>
          </div>
          <div className="section-head-actions">
            <span className={`chip${user.hasProxy ? " on" : ""}`}>{user.hasProxy ? "Active" : "Not set"}</span>
            <button className="btn-link accent" onClick={() => setHelpOpen(true)}>
              How to set up?
            </button>
          </div>
        </div>
        <p className="muted">
          Used for your scrapes, overriding the server default. Stored encrypted, credentials are never logged or shown
          back. Paste the Smartproxy <code>curl</code> command or just the URL.
        </p>
        <div className="row">
          <input
            type="text"
            placeholder="http://user:pass@host:port"
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
          />
          <button className="btn" onClick={onSaveProxy}>
            Save
          </button>
          <button className="btn btn-ghost" onClick={onTestProxy} disabled={testingProxy}>
            {testingProxy ? "Testing…" : "Test connection"}
          </button>
          {user.hasProxy && (
            <button className="btn btn-ghost" onClick={() => runProxyAction(setProxy(null), "Proxy cleared.")}>
              Clear
            </button>
          )}
        </div>

        {testingProxy && (
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }} className="muted anim">
            <span className="spinner" />
            <span>Testing proxy connection (3 attempts to check rotation)…</span>
          </div>
        )}

        {proxyTestResult && (
          <div className="proxy-result anim">
            <h3>
              {proxyTestResult.working ? (
                <>
                  <span style={{ color: "var(--ok)", fontWeight: 700 }}>✅ Working</span>
                  <span className={`tag ${proxyTestResult.rotates ? "ok" : ""}`}>
                    {proxyTestResult.rotates ? "🔄 Rotates IP" : "📌 Static IP"}
                  </span>
                </>
              ) : (
                <span style={{ color: "var(--down)", fontWeight: 700 }}>❌ Failed</span>
              )}
            </h3>

            {proxyTestResult.working && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="proxy-result-label">
                  Detected exit IPs ({proxyTestResult.uniqueIps.length} unique):
                </span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {proxyTestResult.ips.map((ip, idx) => (
                    <span key={idx} className="pill" style={{ fontFamily: "monospace" }}>
                      Attempt {idx + 1}: <b>{ip}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {proxyTestResult.errors.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <span className="proxy-result-label">Connection attempts log:</span>
                <ul className="proxy-error-list">
                  {proxyTestResult.errors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <ProxyHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
