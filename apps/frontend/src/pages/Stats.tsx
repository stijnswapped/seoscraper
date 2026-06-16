// Usage analytics: period toggle, headline metrics, area chart, recent activity.

import { useEffect, useMemo, useState } from "react";
import { getEvents, getUsage, type ApiError, type UsageDailyPoint, type UsageEvent } from "../api.js";
import { PageHeader } from "../layout/PageHeader.js";
import { UsageChart } from "../components/UsageChart.js";
import { EventTable } from "../components/EventTable.js";

const PERIODS = [7, 30, 90] as const;

export function Stats() {
  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsageDailyPoint[]>([]);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = (d: number) => {
    Promise.all([getUsage(d), getEvents(d, 50)])
      .then(([u, e]) => {
        setUsage(u.daily);
        setEvents(e.events);
      })
      .catch((err) => setError((err as ApiError).message ?? "Could not load usage."));
  };

  useEffect(() => load(days), []);

  const changePeriod = (d: number) => {
    setDays(d);
    load(d);
  };

  const metrics = useMemo(() => {
    const ok = usage.reduce((s, p) => s + p.ok, 0);
    const failed = usage.reduce((s, p) => s + p.failed, 0);
    const total = ok + failed;
    return { total, ok, failed, rate: total ? Math.round((ok / total) * 100) : 100 };
  }, [usage]);

  return (
    <>
      <PageHeader
        title="Stats"
        subtitle="Your scraping activity over time."
        actions={
          <div className="segmented period">
            {PERIODS.map((p) => (
              <button key={p} className={days === p ? "on" : ""} onClick={() => changePeriod(p)}>
                {p}d
              </button>
            ))}
          </div>
        }
      />

      {error && <div className="banner error anim">{error}</div>}

      <div className="metric-row anim">
        <div className="metric">
          <b>{metrics.total.toLocaleString()}</b>
          <span>Total scrapes</span>
        </div>
        <div className="metric">
          <b>{metrics.rate}%</b>
          <span>Success rate</span>
        </div>
        <div className="metric">
          <b>{metrics.failed.toLocaleString()}</b>
          <span>Failed</span>
        </div>
      </div>

      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Usage</span>
            <h2>Scrapes per day</h2>
          </div>
        </div>
        <UsageChart data={usage} />
      </section>

      <section className="panel anim">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Logs</span>
            <h2>Recent activity</h2>
          </div>
        </div>
        <EventTable events={events} />
      </section>
    </>
  );
}
