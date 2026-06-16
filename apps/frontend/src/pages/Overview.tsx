// Overview / home: onboarding checklist, headline usage metric + chart, quick links.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getUsage, listApiKeys, type UsageDailyPoint } from "../api.js";
import { useAccount } from "../account/AccountContext.js";
import { PageHeader } from "../layout/PageHeader.js";
import { UsageChart } from "../components/UsageChart.js";
import { CheckIcon, ArrowUpRightIcon } from "../components/icons.js";

export function Overview() {
  const { user, billing } = useAccount();
  const [usage, setUsage] = useState<UsageDailyPoint[]>([]);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    getUsage(30)
      .then((u) => setUsage(u.daily))
      .catch(() => {});
    listApiKeys()
      .then((k) => setHasKey(k.keys.some((key) => !key.revokedAt)))
      .catch(() => {});
  }, []);

  const total = useMemo(() => usage.reduce((s, p) => s + p.total, 0), [usage]);
  const ranScrape = total > 0;
  const onPaidPlan = !!billing && billing.effectivePlan.code !== "free";

  const steps = [
    { label: "Create your account", done: true },
    { label: "Set up a proxy connection", done: !!user.hasProxy, to: "/account" },
    { label: "Create an API key", done: hasKey, to: "/keys" },
    { label: "Run your first scrape", done: ranScrape, to: "/playground" },
    { label: "Choose a plan", done: onPaidPlan, to: "/subscription" },
  ];
  const completed = steps.filter((s) => s.done).length;
  const pct = Math.round((completed / steps.length) * 100);
  const allDone = completed === steps.length;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            {user.email}
            {billing && <span className="plan-inline"> · {billing.effectivePlan.name} plan</span>}
          </>
        }
      />

      {!allDone && (
        <section className="panel onboard anim">
          <div className="onboard-head">
            <div>
              <span className="eyebrow">Getting started</span>
              <h2>Finish setting up your account</h2>
              <p className="muted">Complete these steps to get the most out of SEOSCRAPE.</p>
            </div>
            <div className="onboard-progress">
              <b>
                {completed} <span>/ {steps.length}</span>
              </b>
              <small>{pct}% complete</small>
            </div>
          </div>
          <div className="meter-track onboard-bar">
            <div className="meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <ul className="onboard-steps">
            {steps.map((s) => (
              <li key={s.label} className={s.done ? "done" : ""}>
                <span className="step-check">{s.done && <CheckIcon size={13} />}</span>
                {s.to && !s.done ? <Link to={s.to}>{s.label}</Link> : <span>{s.label}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="metric-row anim">
        <div className="metric">
          <b>{total.toLocaleString()}</b>
          <span>Scrapes · last 30 days</span>
        </div>
        <div className="metric">
          <b>{billing ? billing.usage.last7d.toLocaleString() : "—"}</b>
          <span>Units used · last 7 days</span>
        </div>
        <div className="metric">
          <b>{billing ? billing.topupBalance.toLocaleString() : "—"}</b>
          <span>Top-up credits</span>
        </div>
      </div>

      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Activity</span>
            <h2>Scrapes this month</h2>
          </div>
          <Link className="btn-link accent" to="/stats">
            View stats →
          </Link>
        </div>
        <UsageChart data={usage} height={240} />
      </section>

      <div className="quick-grid anim">
        <Link to="/playground" className="quick-card">
          <span>Playground</span>
          <p className="muted">Scrape a product page or track best-sellers.</p>
          <ArrowUpRightIcon size={18} />
        </Link>
        <Link to="/subscription" className="quick-card">
          <span>Subscription</span>
          <p className="muted">Manage your plan and top-up credits.</p>
          <ArrowUpRightIcon size={18} />
        </Link>
        <Link to="/docs" className="quick-card">
          <span>Docs</span>
          <p className="muted">Getting started guide and API reference.</p>
          <ArrowUpRightIcon size={18} />
        </Link>
      </div>
    </>
  );
}
