import type { ListingRankChange, ListingRankSnapshot } from "../api.js";

const ARROW: Record<string, string> = {
  up: "▲",
  down: "▼",
  same: "–",
  new: "✦",
  missing: "×",
};

function deltaLabel(change: ListingRankChange | undefined): { text: string; cls: string } {
  if (!change) return { text: "–", cls: "same" };
  if (change.direction === "new") return { text: "new", cls: "new" };
  if (change.direction === "up") return { text: `+${change.delta ?? ""}`, cls: "up" };
  if (change.direction === "down") return { text: `${change.delta ?? ""}`, cls: "down" };
  return { text: "–", cls: "same" };
}

export function ListingSummary({ result }: { result: ListingRankSnapshot }) {
  const changeByKey = new Map(result.changes.map((c) => [c.productKey, c]));
  const s = result.summary;

  return (
    <div className="anim">
      <section className="card">
        <div className="card-head">
          <h2>Best-sellers</h2>
          <span className="tag">{result.sourceUsed}</span>
        </div>
        <p className="muted">
          {result.storeDomain} · {new Date(result.checkedAt).toLocaleString()}
        </p>

        <div className="stats">
          <div className="stat"><b>{s.tracked}</b><span>tracked</span></div>
          <div className="stat up"><b>{s.movedUp}</b><span>up</span></div>
          <div className="stat down"><b>{s.movedDown}</b><span>down</span></div>
          <div className="stat new"><b>{s.new}</b><span>new</span></div>
          <div className="stat"><b>{s.unchanged}</b><span>same</span></div>
          <div className="stat"><b>{s.missing}</b><span>missing</span></div>
        </div>
      </section>

      <section className="card">
        <ol className="rank-list">
          {result.items.map((item) => {
            const d = deltaLabel(changeByKey.get(item.productKey));
            return (
              <li key={item.productKey} className="rank-row">
                <span className="rank-num">{item.rank}</span>
                {item.imageUrl ? (
                  <img className="rank-thumb" src={item.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="rank-thumb placeholder" />
                )}
                <a className="rank-title" href={item.url} target="_blank" rel="noreferrer">
                  {item.title ?? item.handle ?? item.url}
                </a>
                <span className={`delta ${d.cls}`}>
                  {ARROW[d.cls] ?? ""} {d.text}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {result.warnings.length > 0 && (
        <section className="card warn">
          <h2>Notes</h2>
          <ul className="warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
