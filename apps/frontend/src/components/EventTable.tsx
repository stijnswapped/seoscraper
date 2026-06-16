// Recent-activity table (used on Stats + Admin). Extracted from the old Dashboard.

import type { UsageEvent } from "../api.js";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EventTable({ events }: { events: UsageEvent[] }) {
  if (events.length === 0) return <div className="empty-chart">No activity yet.</div>;
  return (
    <table className="data-table log-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Endpoint</th>
          <th>Proxy</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={i}>
            <td className="when">{fmtTime(e.ts)}</td>
            <td>
              <code>{e.endpoint.replace("/api/", "")}</code>
            </td>
            <td className="muted-cell">{e.usedProxy ?? "—"}</td>
            <td>
              <span className={`status ${e.ok ? "ok" : "bad"}`}>
                {e.ok ? "ok" : "fail"}
                {e.status ? ` · ${e.status}` : ""}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
