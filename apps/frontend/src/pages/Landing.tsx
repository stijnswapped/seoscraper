// Public landing page (logged-out root). Minimal: one promise, one $5 early-access
// CTA, a note that Starter is free to try at launch. Anonymous Polar checkout.

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createEarlyAccessCheckout, getEarlyAccessCount, type ApiError } from "../api.js";
import { CheckIcon } from "../components/icons.js";

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
    <div className="landing">
      <header className="landing-top">
        <div className="sidebar-brand compact">
          <span className="mark">◧</span>
          <span>SEOSCRAPE</span>
        </div>
        <Link className="btn-link accent" to="/login">
          Sign in
        </Link>
      </header>

      <main className="landing-main">
        {justBought && (
          <div className="banner notice anim" style={{ marginBottom: 24 }}>
            You're in! 🎉 We sent a receipt to your email — we'll send your invite the moment we launch.
          </div>
        )}

        <span className="landing-eyebrow anim">✦ Early access</span>
        <h1 className="landing-headline anim">
          Track your competitors' best-sellers, before they know it.
        </h1>
        <p className="landing-sub anim">
          SEOSCRAPE captures any Shopify store's best-selling rank order and shows you what's moving up,
          day over day. Pull product SEO and images too — from a clean dashboard or one API call.
        </p>

        <div className="early-card anim">
          <div className="early-price">
            <span className="early-amount">$5</span>
            <span className="early-once">once</span>
          </div>
          <p className="early-tag">Lock in early access</p>
          <ul className="plan-features">
            <li className="feature-row"><CheckIcon size={16} /><span>Get in before public launch</span></li>
            <li className="feature-row"><CheckIcon size={16} /><span>Try the Starter plan free on release</span></li>
            <li className="feature-row"><CheckIcon size={16} /><span>Shape the roadmap as a founding user</span></li>
          </ul>
          <button className="btn early-cta" onClick={onBuy} disabled={busy}>
            {busy ? "Starting checkout…" : "Get early access → $5"}
          </button>
          {error && <p className="early-error">{error}</p>}
          <p className="early-fine">
            One-time payment, no subscription. {count && count > 0 ? `${count} already joined.` : "Be one of the first."}
          </p>
        </div>
      </main>

      <footer className="landing-foot">
        <span>© {new Date().getFullYear()} SEOSCRAPE</span>
        <Link to="/login">Sign in</Link>
      </footer>
    </div>
  );
}
