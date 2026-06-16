// Public landing page (logged-out root). Minimal, conversion-focused: one promise,
// one $5 early-access CTA, a tasteful product mock, and trust microcopy.
// Anonymous Polar checkout.

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createEarlyAccessCheckout, getEarlyAccessCount, type ApiError } from "../api.js";
import { ChartIcon, BoltIcon, KeyIcon } from "../components/icons.js";

const MOVERS = [
  { rank: 1, name: "Linen Wrap Dress", delta: "▲ 4", dir: "up" },
  { rank: 2, name: "Oversized Hoodie", delta: "▼ 1", dir: "down" },
  { rank: 3, name: "Everyday Leather Tote", delta: "▲ 2", dir: "up" },
  { rank: 4, name: "Merino Wool Runner", delta: "NEW", dir: "new" },
  { rank: 5, name: "Ribbed Tank, Sand", delta: "▲ 1", dir: "up" },
] as const;

const FEATURES = [
  { Icon: ChartIcon, title: "Daily rank tracking", body: "Best-seller order for any store, with day-over-day movers." },
  { Icon: BoltIcon, title: "SEO + images", body: "Pull product metadata and downloadable images on demand." },
  { Icon: KeyIcon, title: "One API call", body: "Automate the whole thing from your own stack." },
] as const;

export function Landing() {
  const [params] = useSearchParams();
  const justBought = params.get("early") === "success";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    getEarlyAccessCount().then((c) => setCount(c)).catch(() => {});
  }, []);

  const onBuy = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createEarlyAccessCheckout();
      window.location.assign(res.url);
    } catch (err) {
      setError((err as ApiError).message ?? "Could not start checkout. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="lp">
      <header className="lp-top">
        <div className="sidebar-brand compact">
          <span className="mark">◧</span>
          <span>SEOSCRAPE</span>
        </div>
        <Link className="lp-signin" to="/login">Sign in</Link>
      </header>

      <main className="lp-main">
        {justBought && (
          <div className="banner notice anim lp-banner">
            You're in. 🎉 We sent a receipt to your email, your invite lands the moment we launch.
          </div>
        )}

        <span className="lp-eyebrow anim">✦ Early access · founding members</span>
        <h1 className="lp-headline anim">Track your competitors' best-sellers, before they know it.</h1>
        <p className="lp-sub anim">
          See exactly what's selling for any Shopify store, ranked and refreshed daily, with the movers that
          matter. Pull product SEO and images too, from a clean dashboard or a single API call.
        </p>

        <div className="lp-cta anim">
          <button className="btn lp-join" onClick={onBuy} disabled={busy}>
            {busy ? "Starting checkout…" : "Join early access, $5"}
          </button>
          <p className="lp-trust">
            One-time payment · No subscription · Secure checkout
            {count && count > 0 ? <> · <b>{count}</b> joined</> : null}
          </p>
          {error && <p className="lp-error">{error}</p>}
        </div>

        {/* Product mock — credibility without clutter */}
        <div className="lp-mock anim" aria-hidden="true">
          <div className="lp-mock-head">
            <span>Best-sellers · today</span>
            <span className="lp-live"><i /> live</span>
          </div>
          <ul className="lp-rows">
            {MOVERS.map((m) => (
              <li key={m.rank} className="lp-row">
                <span className="lp-rank">{m.rank}</span>
                <span className="lp-thumb" />
                <span className="lp-name">{m.name}</span>
                <span className={`delta ${m.dir}`}>{m.delta}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="lp-features anim">
          {FEATURES.map(({ Icon, title, body }) => (
            <div key={title} className="lp-feature">
              <span className="lp-feature-icon"><Icon size={18} /></span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>

        <p className="lp-foot-note anim">
          Founding members get the Starter plan free to try at release. Cancel anytime, no strings.
        </p>
      </main>

      <footer className="lp-bottom">
        <span>© {new Date().getFullYear()} SEOSCRAPE</span>
        <Link to="/login">Sign in</Link>
      </footer>
    </div>
  );
}
