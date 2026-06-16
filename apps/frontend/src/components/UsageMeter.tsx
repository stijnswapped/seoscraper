// Rolling usage meter (used on Subscription + Overview). Extracted from the old
// Dashboard so multiple pages can share it.

export function UsageMeter({
  label,
  used,
  limit,
  percent,
}: {
  label: string;
  used: number;
  limit: number | null;
  percent: number | null;
}) {
  const displayLimit = limit === null ? "∞" : limit.toLocaleString();
  const pct = percent ?? 0;
  return (
    <div className="usage-meter">
      <div className="meter-head">
        <span>{label}</span>
        <b>
          {used.toLocaleString()} / {displayLimit}
        </b>
      </div>
      <div className="meter-track" aria-label={`${label}: ${used} of ${displayLimit} units used`}>
        <div className="meter-fill" style={{ width: limit === null ? "100%" : `${pct}%` }} />
      </div>
      <small>{limit === null ? "Unlimited" : `${Math.max(0, limit - used).toLocaleString()} units left`}</small>
    </div>
  );
}
