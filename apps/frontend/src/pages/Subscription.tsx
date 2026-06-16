// Subscription & billing: animated usage rings, premium plan cards with a limits
// highlight + capability list, and value-explained top-up packs.

import { useState } from "react";
import {
  createBillingCheckout,
  createBillingPortal,
  type ApiError,
  type BillingPlan,
  type TopupPack,
} from "../api.js";
import { useAccount } from "../account/AccountContext.js";
import { PageHeader } from "../layout/PageHeader.js";
import { UsageRing } from "../components/UsageRing.js";
import { CheckIcon } from "../components/icons.js";

// Visual order + the plan we feature as "most popular".
const ORDER: BillingPlan["code"][] = ["free", "starter", "pro", "scale", "unlimited"];
const FEATURED: BillingPlan["code"] = "pro";

// Roughly 50 product pages per unit on a best-seller track (see estimateListingUnits).
const UNITS_PER_TRACK = 3;

function capabilities(plan: BillingPlan): string[] {
  return [
    "Best-seller rank tracking",
    "Product + SEO scraping",
    "Downloadable product images",
    "Encrypted custom proxy",
    "Full API access & keys",
    ...(plan.code === "free" ? [] : ["Buy top-up credits anytime"]),
  ];
}

export function Subscription() {
  const { billing } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  if (!billing) {
    return (
      <>
        <PageHeader title="Subscription" />
        <div className="empty-chart">Billing is not available right now.</div>
      </>
    );
  }

  const onCheckout = async (kind: "subscription" | "topup", code: string) => {
    setError(null);
    setPending(code);
    try {
      const res = await createBillingCheckout(kind, code);
      window.location.assign(res.url);
    } catch (err) {
      setError((err as ApiError).message ?? "Could not start checkout.");
      setPending(null);
    }
  };

  const onPortal = async () => {
    setError(null);
    try {
      const res = await createBillingPortal();
      window.location.assign(res.url);
    } catch (err) {
      setError((err as ApiError).message ?? "Could not open billing portal.");
    }
  };

  const currentCode = billing.effectivePlan.code;
  const currentIdx = ORDER.indexOf(currentCode);
  const nearLimit =
    Math.max(billing.usage.percent5h ?? 0, billing.usage.percent7d ?? 0) >= 80 && currentCode !== "unlimited";

  // Best €/unit pack gets a "Best value" flag.
  const bestValueCode = billing.topups.reduce<TopupPack | null>((best, t) => {
    if (!best) return t;
    return t.priceEur / t.units < best.priceEur / best.units ? t : best;
  }, null)?.code;

  return (
    <>
      <PageHeader
        title="Subscription"
        subtitle={
          <>
            You're on the <b className="plan-inline">{billing.effectivePlan.name}</b> plan
            {billing.entitlement?.manualUnlimited ? " · manual unlimited" : ""}.
          </>
        }
        actions={
          billing.entitlement?.polarCustomerId ? (
            <button className="btn btn-ghost" onClick={onPortal}>
              Manage billing
            </button>
          ) : undefined
        }
      />

      {error && <div className="banner error anim">{error}</div>}

      {/* Usage ----------------------------------------------------------- */}
      <section className="panel usage-panel anim" style={{ animationDelay: "20ms" }}>
        <div className="panel-head">
          <div>
            <span className="eyebrow">This period</span>
            <h2>Your usage</h2>
          </div>
          <span className="usage-note">Rolling windows — they free up continuously, no monthly reset.</span>
        </div>

        <div className="usage-rings">
          <UsageRing
            label="Last 5 hours"
            hint={billing.usage.limit5h === null ? "Unlimited" : `${Math.max(0, billing.usage.limit5h - billing.usage.last5h).toLocaleString()} units left`}
            used={billing.usage.last5h}
            limit={billing.usage.limit5h}
            percent={billing.usage.percent5h}
          />
          <UsageRing
            label="Last 7 days"
            hint={billing.usage.limit7d === null ? "Unlimited" : `${Math.max(0, billing.usage.limit7d - billing.usage.last7d).toLocaleString()} units left`}
            used={billing.usage.last7d}
            limit={billing.usage.limit7d}
            percent={billing.usage.percent7d}
          />
          <div className="credit-tile">
            <span className="credit-label">Top-up credits</span>
            <b className="credit-value">{billing.topupBalance.toLocaleString()}</b>
            <span className="credit-sub">extra units — used automatically once your plan allowance runs out</span>
          </div>
        </div>

        {nearLimit && (
          <div className="banner warn usage-warn">
            You're close to your rolling limit. Upgrade your plan or add top-up credits before your next larger run.
          </div>
        )}
      </section>

      {/* Plans ----------------------------------------------------------- */}
      <div className="section-title anim">
        <h2>Plans</h2>
        <p className="muted">
          Pick the rolling limits that fit your volume. <b>1 unit ≈ one product page</b> — a full 150-product
          best-seller track is ≈ {UNITS_PER_TRACK} units. Change or cancel anytime.
        </p>
      </div>

      <div className="plan-grid anim">
        {billing.plans.map((plan, i) => {
          const isCurrent = currentCode === plan.code;
          const isFeatured = plan.code === FEATURED;
          const idx = ORDER.indexOf(plan.code);
          const cta = isCurrent
            ? "Current plan"
            : plan.code === "free"
            ? "Free forever"
            : idx > currentIdx
            ? `Upgrade to ${plan.name}`
            : `Switch to ${plan.name}`;
          return (
            <div
              key={plan.code}
              className={`plan-card${isCurrent ? " current" : ""}${isFeatured ? " featured" : ""}`}
              style={{ animationDelay: `${i * 70}ms` }}
            >
              {isFeatured && <span className="plan-ribbon">Most popular</span>}

              <div className="plan-top">
                <span className="plan-name">{plan.name}</span>
                {isCurrent && <span className="plan-current-pill">Current</span>}
              </div>

              <div className="plan-price">
                <span className="amount">€{plan.priceEur}</span>
                <span className="per">/mo</span>
              </div>
              <p className="plan-desc">{plan.description}</p>

              <div className="plan-limits">
                <div className="plan-limit">
                  <b>{plan.limit5h === null ? "∞" : plan.limit5h.toLocaleString()}</b>
                  <span>units / 5 hours</span>
                </div>
                <div className="plan-limit">
                  <b>{plan.limit7d === null ? "∞" : plan.limit7d.toLocaleString()}</b>
                  <span>units / 7 days</span>
                </div>
              </div>

              <ul className="plan-features">
                {capabilities(plan).map((feat) => (
                  <li key={feat} className="feature-row">
                    <CheckIcon size={15} />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>

              <button
                className={`btn plan-cta${isFeatured && !isCurrent ? "" : " btn-ghost"}`}
                disabled={plan.code === "free" || isCurrent || pending !== null}
                onClick={() => onCheckout("subscription", plan.code)}
              >
                {pending === plan.code ? "Starting…" : cta}
              </button>
            </div>
          );
        })}
      </div>

      {/* Top-ups --------------------------------------------------------- */}
      <div className="section-title anim">
        <h2>Top-up credits</h2>
        <p className="muted">
          Need more before your rolling limit frees up? Buy a pack of credits — they <b>never expire</b> and kick in
          automatically once your plan allowance is used.
        </p>
      </div>

      <div className="topup-grid anim">
        {billing.topups.map((topup, i) => {
          const tracks = Math.max(1, Math.round(topup.units / UNITS_PER_TRACK));
          const isBest = topup.code === bestValueCode;
          return (
            <div key={topup.code} className={`topup-card${isBest ? " best" : ""}`} style={{ animationDelay: `${i * 70}ms` }}>
              {isBest && <span className="topup-badge">Best value</span>}
              <div className="topup-units">
                <b>{topup.units.toLocaleString()}</b>
                <span>units</span>
              </div>
              <p className="topup-explain">≈ {tracks.toLocaleString()} full best-seller tracks</p>
              <div className="topup-foot">
                <span className="topup-price">€{topup.priceEur}</span>
                <button
                  className="btn btn-ghost topup-cta"
                  disabled={pending !== null}
                  onClick={() => onCheckout("topup", topup.code)}
                >
                  {pending === topup.code ? "Starting…" : "Buy"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
