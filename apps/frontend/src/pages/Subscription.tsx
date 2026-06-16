// Subscription & billing: usage meters, premium plan cards, top-up packs, portal.

import { useState } from "react";
import {
  createBillingCheckout,
  createBillingPortal,
  type ApiError,
  type BillingPlan,
} from "../api.js";
import { useAccount } from "../account/AccountContext.js";
import { PageHeader } from "../layout/PageHeader.js";
import { UsageMeter } from "../components/UsageMeter.js";
import { CheckIcon } from "../components/icons.js";

// The plan we visually feature as "most popular".
const FEATURED: BillingPlan["code"] = "pro";

function planFeatures(plan: BillingPlan): string[] {
  const f: string[] = [
    plan.limit5h === null ? "Unlimited units / 5h" : `${plan.limit5h.toLocaleString()} units / 5h`,
    plan.limit7d === null ? "Unlimited units / 7d" : `${plan.limit7d.toLocaleString()} units / 7d`,
    "Encrypted custom proxy",
    "API access",
  ];
  if (plan.code !== "free") f.push("Buy top-up credits");
  return f;
}

export function Subscription() {
  const { billing } = useAccount();
  const [error, setError] = useState<string | null>(null);

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
    try {
      const res = await createBillingCheckout(kind, code);
      window.location.assign(res.url);
    } catch (err) {
      setError((err as ApiError).message ?? "Could not start checkout.");
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
  const nearLimit =
    Math.max(billing.usage.percent5h ?? 0, billing.usage.percent7d ?? 0) >= 80 && currentCode !== "unlimited";

  return (
    <>
      <PageHeader
        title="Subscription"
        subtitle={
          <>
            You are on the <b className="plan-inline">{billing.effectivePlan.name}</b> plan
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

      {/* Current usage --------------------------------------------------- */}
      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Current period</span>
            <h2>Your usage</h2>
          </div>
        </div>
        <div className="billing-grid">
          <UsageMeter
            label="Last 5 hours"
            used={billing.usage.last5h}
            limit={billing.usage.limit5h}
            percent={billing.usage.percent5h}
          />
          <UsageMeter
            label="Last 7 days"
            used={billing.usage.last7d}
            limit={billing.usage.limit7d}
            percent={billing.usage.percent7d}
          />
          <div className="usage-meter credit-meter">
            <span>Top-up credits</span>
            <b>{billing.topupBalance.toLocaleString()}</b>
            <small>extra units available</small>
          </div>
        </div>
        {nearLimit && (
          <div className="banner warn" style={{ marginTop: 16 }}>
            You are close to your rolling usage limit. Upgrade or add credits before the next larger run.
          </div>
        )}
      </section>

      {/* Plans ----------------------------------------------------------- */}
      <div className="section-title anim">
        <h2>Plans</h2>
        <p className="muted">Higher rolling limits as you grow. Change or cancel anytime.</p>
      </div>

      <div className="plan-grid anim">
        {billing.plans.map((plan) => {
          const isCurrent = currentCode === plan.code;
          const isFeatured = plan.code === FEATURED;
          return (
            <div
              key={plan.code}
              className={`plan-card${isCurrent ? " current" : ""}${isFeatured ? " featured" : ""}`}
            >
              {isFeatured && <span className="plan-badge">Most popular</span>}
              {isCurrent && <span className="plan-badge current-badge">Current</span>}
              <span className="eyebrow">{plan.name}</span>
              <div className="plan-price">
                <span className="amount">€{plan.priceEur}</span>
                <span className="per">/mo</span>
              </div>
              <p className="plan-desc">{plan.description}</p>
              <ul className="plan-features">
                {planFeatures(plan).map((feat) => (
                  <li key={feat} className="feature-row">
                    <CheckIcon size={16} />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
              <button
                className={`btn plan-cta${isFeatured && !isCurrent ? "" : " btn-ghost"}`}
                disabled={plan.code === "free" || isCurrent}
                onClick={() => onCheckout("subscription", plan.code)}
              >
                {isCurrent ? "Current plan" : plan.code === "free" ? "Included" : "Upgrade"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Top-ups --------------------------------------------------------- */}
      <div className="section-title anim">
        <h2>Top-up credits</h2>
        <p className="muted">One-time packs of extra units that never expire. Used after your plan allowance.</p>
      </div>

      <div className="topup-grid anim">
        {billing.topups.map((topup) => (
          <button key={topup.code} className="topup-card" onClick={() => onCheckout("topup", topup.code)}>
            <b>{topup.units.toLocaleString()}</b>
            <span>units</span>
            <span className="topup-price">€{topup.priceEur}</span>
          </button>
        ))}
      </div>
    </>
  );
}
