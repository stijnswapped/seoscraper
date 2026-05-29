import type { ProgressEvent } from "../api.js";

interface Props {
  events: ProgressEvent[];
}

export function ProgressPanel({ events }: Props) {
  const latest = events.at(-1);
  const progressEvent = [...events].reverse().find((event) => event.current && event.total);
  const percentage = progressEvent?.current && progressEvent.total
    ? Math.round((progressEvent.current / progressEvent.total) * 100)
    : null;

  return (
    <div className="progress-card card">
      <h2>
        Live Progress
        {latest && <span className="badge">{latest.phase}</span>}
      </h2>
      {latest && <p className="progress-current">{latest.message}</p>}
      {percentage !== null && progressEvent && (
        <div className="progress-meter" aria-label="Collection progress">
          <div className="progress-meter-bar" style={{ width: `${percentage}%` }} />
          <span>{progressEvent.current}/{progressEvent.total}</span>
        </div>
      )}
      <ol className="progress-list">
        {events.slice(-10).map((event, index) => (
          <li key={`${event.timestamp}-${index}`}>
            <span className="progress-time">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
            <span className="progress-message">{event.message}</span>
            {event.url && <span className="progress-url">{event.url}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
