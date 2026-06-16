// Animated circular usage meter. The ring stroke draws in on mount and shifts
// tone (ok → warn → danger) as the rolling window fills.

import { useEffect, useState } from "react";

const R = 52;
const C = 2 * Math.PI * R;

export function UsageRing({
  label,
  hint,
  used,
  limit,
  percent,
}: {
  label: string;
  hint: string;
  used: number;
  limit: number | null;
  percent: number | null;
}) {
  const unlimited = limit === null;
  const pct = unlimited ? 100 : Math.min(100, percent ?? 0);
  const [draw, setDraw] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDraw(pct), 120);
    return () => clearTimeout(t);
  }, [pct]);

  const tone = unlimited ? "ok" : pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
  const offset = C - (draw / 100) * C;

  return (
    <div className="usage-ring">
      <div className="ring-wrap">
        <svg viewBox="0 0 120 120" className="ring-svg" aria-hidden="true">
          <circle className="ring-track" cx="60" cy="60" r={R} />
          <circle
            className={`ring-fill ${tone}`}
            cx="60"
            cy="60"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={offset}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="ring-center">
          <b>{unlimited ? "∞" : `${pct}%`}</b>
          <small>used</small>
        </div>
      </div>
      <div className="ring-meta">
        <span className="ring-label">{label}</span>
        <span className="ring-detail">
          {used.toLocaleString()} / {unlimited ? "∞" : limit.toLocaleString()} units
        </span>
        <span className="ring-hint">{hint}</span>
      </div>
    </div>
  );
}
