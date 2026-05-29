import type { ProgressEvent } from "../api.js";

interface Props {
  events: ProgressEvent[];
}

export function ProgressPanel({ events }: Props) {
  const latest = events.at(-1);
  const withCount = [...events].reverse().find((e) => e.current && e.total);
  const pct =
    withCount?.current && withCount.total
      ? Math.round((withCount.current / withCount.total) * 100)
      : null;

  return (
    <section className="card progress anim">
      <div className="card-head">
        <h2>
          <span className="spinner" /> Working
        </h2>
        {latest && <span className="tag">{latest.phase}</span>}
      </div>
      <p className="muted">{latest?.message ?? "Starting…"}</p>
      {pct !== null && withCount && (
        <div className="bar" aria-label="progress">
          <div className="bar-fill" style={{ width: `${pct}%` }} />
          <span>{withCount.current}/{withCount.total}</span>
        </div>
      )}
    </section>
  );
}
